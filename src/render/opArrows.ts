import * as THREE from 'three';
import type { OperationKind, Front } from '../sim/types';
import type { V2 } from '../sim/vec';
import type { World } from '../sim/world';

/**
 * Operation arrows: each army group's manoeuvre (`Front.opRoute`) drawn as a big hand-inked
 * war-map arrow draped on the terrain in the faction colour — straight and thick for a frontal
 * push, bowed for a flank, thin and dashed for infiltration, a hatched siege line (ticks toward
 * the target) for an investment. Pincers are simply two converging arrows.
 *
 * All routes live in one merged mesh (one draw call) rebuilt only when a route changes; the
 * per-frame work is a numeric signature check plus two uniforms (zoom fade, minimum screen width).
 */

const VERT = /* glsl */ `
attribute vec2 aTan;
attribute vec2 aOff;
attribute float aSide;
attribute float aU;
attribute vec3 aCol;
attribute vec3 aStyle;
uniform float uScale;
varying vec3 vCol;
varying float vSide;
varying float vU;
varying vec3 vStyle;
void main() {
  vCol = aCol;
  vSide = aSide;
  vU = aU;
  vStyle = aStyle;
  vec2 n = vec2(-aTan.y, aTan.x);
  vec2 d = (aTan * aOff.x + n * aOff.y) * uScale;
  vec3 p = position + vec3(d.x, 0.0, d.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  // Ride over low rises and tree tops instead of being chopped up by them.
  gl_Position.z -= 0.006 * gl_Position.w;
}`;

const FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vCol;
varying float vSide;
varying float vU;
varying vec3 vStyle;
void main() {
  float kind = vStyle.x;
  float head = vStyle.y;
  float plan = vStyle.z;
  float e = abs(vSide);
  // Uneven ink: density drifts along the stroke like a brush on paper.
  float ink = 0.86 + 0.14 * sin(vU * 0.061 + vSide * 1.7) * sin(vU * 0.017 + 1.3);
  float edge = smoothstep(0.64, 0.78, e);
  float fill = mix(0.6, 0.32, plan);
  float a = mix(fill, 0.92, edge);
  vec3 col = mix(vCol * 0.95, vCol * 0.42, edge);
  if (kind > 0.5 && kind < 1.5 && head < 0.5) {
    // Infiltration: dashes.
    if (fract(vU / 22.0) > 0.6) discard;
  } else if (kind > 1.5) {
    // Siege line: solid ink rule on the outside, ticks toward the target.
    bool rule = vSide < -0.45;
    bool tick = fract(vU / 9.0) < 0.32;
    if (!rule && !tick) discard;
    a = 0.92;
    col = vCol * 0.5;
  }
  gl_FragColor = vec4(col * ink, a * uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const KIND_CODE: Record<OperationKind, number> = { frontal: 0, flank: 0, pincer: 0, infiltrate: 1, siege: 2 };
/** Body width (m) per operation (player's own; spectators see all factions thinner). */
const WIDTH: Record<OperationKind, number> = { frontal: 42, flank: 30, pincer: 30, infiltrate: 13, siege: 16 };
const LIFT = 3;
const STEP = 6;
/** Arrows keep at least this many screen pixels of body width at far zoom. */
const MIN_PX = 9;
/** Minimum real time between arrow geometry rebuilds. */
const REBUILD_MIN_MS = 400;

class Buf {
  readonly pos: number[] = [];
  readonly tan: number[] = [];
  readonly off: number[] = [];
  readonly side: number[] = [];
  readonly u: number[] = [];
  readonly col: number[] = [];
  readonly style: number[] = [];
  readonly idx: number[] = [];

  vert(x: number, y: number, z: number, tx: number, tz: number, along: number, lat: number, side: number, u: number, c: THREE.Color, kind: number, head: number, plan: number): void {
    this.pos.push(x, y, z);
    this.tan.push(tx, tz);
    this.off.push(along, lat);
    this.side.push(side);
    this.u.push(u);
    this.col.push(c.r, c.g, c.b);
    this.style.push(kind, head, plan);
  }

  get count(): number {
    return this.side.length;
  }
}

export class OpArrows {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = { uAlpha: { value: 1 }, uScale: { value: 1 } };
  private sig = NaN;
  private minWidth = WIDTH.frontal;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  /** Per frame: zoom fade and minimum on-screen width. */
  update(ppm: number): void {
    // Full strength on the operational map, faint once the camera is down among the troops.
    const t = Math.min(1, Math.max(0, (ppm - 1.5) / 3));
    this.uniforms.uAlpha.value = 1 - 0.82 * t;
    this.uniforms.uScale.value = Math.min(3, Math.max(1, MIN_PX / (this.minWidth * Math.max(0.02, ppm))));
  }

  /** Rebuild when any drawn route changed (player's faction, or all factions when spectating). */
  sync(w: World, playerId: number, spectator: boolean, visible: boolean): void {
    this.mesh.visible = visible;
    if (!visible) return;
    let h = mix(2166136261, spectator ? 7 : playerId + 11);
    for (const f of w.factions) {
      if (!spectator && f.id !== playerId) continue;
      if (!f.alive) continue;
      for (const s of f.fronts) {
        const r = s.opRoute;
        if (!r || r.length < 2) continue;
        h = mix(h, f.id * 16 + s.id);
        h = mix(h, KIND_CODE[s.op] * 4 + (s.op === 'flank' ? 1 : 0) + (isPlanning(s) ? 8 : 0));
        for (const p of r) h = mix(mix(h, Math.round(p.x)), Math.round(p.z));
      }
    }
    if (h === this.sig) return;
    // Routes shift a little on every group think; rebuilding the geometry more than a few times
    // a second is wasted work the eye cannot see.
    const now = performance.now();
    if (now - this.rebuiltAt < REBUILD_MIN_MS) return;
    this.rebuiltAt = now;
    this.sig = h;
    this.rebuild(w, playerId, spectator);
  }

  private rebuiltAt = -1e9;

  private rebuild(w: World, playerId: number, spectator: boolean): void {
    const b = new Buf();
    let minW = Infinity;
    for (const f of w.factions) {
      if ((!spectator && f.id !== playerId) || !f.alive) continue;
      const col = new THREE.Color(f.color);
      for (const s of f.fronts) {
        if (!s.opRoute || s.opRoute.length < 2) continue;
        const width = WIDTH[s.op] * (spectator ? 0.65 : 1);
        minW = Math.min(minW, width);
        const pts = this.curve(s);
        if (pts.length < 2) continue;
        if (s.op === 'siege') this.siegeLine(b, pts, width, col);
        else this.arrow(b, pts, width, col, KIND_CODE[s.op], isPlanning(s) ? 1 : 0, f.id * 7 + s.id);
      }
    }
    this.minWidth = Number.isFinite(minW) ? minW : WIDTH.frontal;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('aTan', new THREE.Float32BufferAttribute(b.tan, 2));
    g.setAttribute('aOff', new THREE.Float32BufferAttribute(b.off, 2));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(b.side, 1));
    g.setAttribute('aU', new THREE.Float32BufferAttribute(b.u, 1));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(b.col, 3));
    g.setAttribute('aStyle', new THREE.Float32BufferAttribute(b.style, 3));
    g.setIndex(b.idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** The route as an evenly sampled smooth curve (flat x,z); flanks bow out if given a straight line. */
  private curve(s: Front): V2[] {
    const raw: V2[] = [];
    for (const p of s.opRoute) {
      const last = raw[raw.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 2) raw.push(p);
    }
    if (raw.length < 2) return [];
    const a = raw[0];
    const e = raw[raw.length - 1];
    const span = Math.hypot(e.x - a.x, e.z - a.z);
    if (s.op === 'flank' && raw.length === 2) {
      const side = s.wing === 1 ? -1 : 1;
      const k = 0.22 * side;
      raw.splice(1, 0, { x: (a.x + e.x) / 2 - ((e.z - a.z) / 1) * k, z: (a.z + e.z) / 2 + ((e.x - a.x) / 1) * k });
    }
    if (raw.length === 2) {
      const n = Math.max(2, Math.ceil(span / STEP));
      return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((e.x - a.x) * i) / n, z: a.z + ((e.z - a.z) * i) / n }));
    }
    const closed = s.op === 'siege' && span < 8;
    const c = new THREE.CatmullRomCurve3(raw.map((p) => new THREE.Vector3(p.x, 0, p.z)), closed, 'centripetal');
    const n = Math.max(4, Math.ceil(c.getLength() / STEP));
    return c.getSpacedPoints(n).map((p) => ({ x: p.x, z: p.z }));
  }

  /** Tapered body plus a barbed head, as one strip of cross-sections (outline on both edges). */
  private arrow(b: Buf, pts: V2[], width: number, col: THREE.Color, kind: number, plan: number, seed: number): void {
    const cum = cumulative(pts);
    const total = cum[cum.length - 1];
    const w = Math.min(width, total / 5);
    const headLen = w * 2.1;
    const headHalf = w * 1.15;
    const bodyEnd = total - headLen;
    let prev = -1;
    // Body: from tail (narrow) to head base; ink edge wobbles a little like a hand-drawn stroke.
    for (let i = 0; i < pts.length; i++) {
      if (cum[i] > bodyEnd) break;
      const [tx, tz] = tangent(pts, i);
      const u = cum[i];
      const f = u / Math.max(1, bodyEnd);
      const wob = 1 + 0.07 * Math.sin(u * 0.029 + seed) + 0.04 * Math.sin(u * 0.087 + seed * 2.1);
      const half = (w / 2) * (0.5 + 0.5 * Math.min(1, f * 1.4)) * wob;
      // The pen drifts a little off the true line, never at the tail or the head.
      const drift = w * 0.12 * Math.sin(u * 0.011 + seed * 1.7) * Math.sin(Math.PI * Math.min(1, f));
      prev = this.section(b, pts[i].x - tz * drift, pts[i].z + tx * drift, tx, tz, 0, half, u, col, kind, 0, plan, prev);
    }
    // Head: anchored at the head base, aimed at the objective; barbs taper to the tip.
    const base = pointAt(pts, cum, bodyEnd);
    const tip = pts[pts.length - 1];
    let tx = tip.x - base.x;
    let tz = tip.z - base.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    prev = this.section(b, base.x, base.z, tx, tz, 0, (w / 2) * 1.05, bodyEnd, col, kind, 1, plan, prev);
    const rows = 6;
    prev = -1;
    for (let k = 0; k <= rows; k++) {
      const a = (k / rows) * tl;
      const half = headHalf * (1 - k / rows) + 0.4;
      prev = this.section(b, base.x, base.z, tx, tz, a, half, bodyEnd + a, col, kind, 1, plan, prev);
    }
  }

  /** Two vertices across the stroke at a centreline point; joins to the previous pair. */
  private section(b: Buf, x: number, z: number, tx: number, tz: number, along: number, half: number, u: number, col: THREE.Color, kind: number, head: number, plan: number, prev: number): number {
    const y = this.heightAt(x + tx * along, z + tz * along) + LIFT;
    const i = b.count;
    b.vert(x, y, z, tx, tz, along, half, 1, u, col, kind, head, plan);
    b.vert(x, y, z, tx, tz, along, -half, -1, u, col, kind, head, plan);
    if (prev >= 0) b.idx.push(prev, i, prev + 1, prev + 1, i, i + 1);
    return i;
  }

  /** Siege works: hatched line, ticks pointing in toward the invested place. */
  private siegeLine(b: Buf, pts: V2[], width: number, col: THREE.Color): void {
    const cum = cumulative(pts);
    let cx = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p.x / pts.length;
      cz += p.z / pts.length;
    }
    let prev = -1;
    for (let i = 0; i < pts.length; i++) {
      let [tx, tz] = tangent(pts, i);
      // aSide +1 lies along (-tz, tx): make that the inner side.
      if (-tz * (cx - pts[i].x) + tx * (cz - pts[i].z) < 0) {
        tx = -tx;
        tz = -tz;
      }
      prev = this.section(b, pts[i].x, pts[i].z, tx, tz, 0, width / 2, cum[i], col, 2, 0, 0, prev);
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

/** Not yet under way: drawn paler, as a plan rather than an executing move. */
function isPlanning(s: Front): boolean {
  return s.opPhase === 'form';
}

function cumulative(pts: V2[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return out;
}

function tangent(pts: V2[], i: number): [number, number] {
  const a = pts[Math.max(0, i - 1)];
  const c = pts[Math.min(pts.length - 1, i + 1)];
  const dx = c.x - a.x;
  const dz = c.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

function pointAt(pts: V2[], cum: number[], d: number): V2 {
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= d) {
      const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
    }
  }
  return pts[pts.length - 1];
}

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}
