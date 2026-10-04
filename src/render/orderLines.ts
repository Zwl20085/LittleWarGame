import * as THREE from 'three';
import type { Faction, Front, OrderKind } from '../sim/types';
import type { V2 } from '../sim/vec';
import type { World } from '../sim/world';
import type { ScreenOverlay } from './screenOverlay';

/**
 * Supreme-HQ standing orders drawn on the map (2.0): one draped, hand-inked mark per front —
 *   attack   — red-orange arrow from the front to the objective (a line: chevrons toward the enemy)
 *   defend   — solid ivory line with ticks on the enemy side
 *   fortify  — brass line with small crenels (castle ticks) on the enemy side
 *   fallBack — dashed steel-blue line and a dashed arrow from the front back to it
 * The faction colour runs underneath as a wider edge. All fronts share one merged mesh (one draw
 * call) rebuilt only when an order / line changes; a second small mesh previews the order being
 * placed (click / drag) by the player. Widths are metres scaled up at far zoom (uScale).
 */

export const ORDER_COLOR: Record<OrderKind, string> = {
  auto: '#d8cfb8', attack: '#e0662e', defend: '#f1e6c8', fortify: '#d9a640', fallBack: '#8fb4d8',
};

/** Same default as the sim: a point order becomes a line ±240 m through it, square to the capital bearing. */
const POINT_LINE_HALF_M = 240;
/** Body width (m) of a player's order line; spectators see every faction thinner. */
const WIDTH = 9;
const SPECTATOR_K = 0.6;
const LIFT = 3.5;
const STEP = 8;
const MIN_PX = 9;
const REBUILD_MIN_MS = 300;

/** What an order looks like on the map (flat x,z), shared by the 3D mesh and the minimap. */
export interface OrderShape {
  readonly kind: OrderKind;
  readonly line: { a: V2; b: V2 } | null;
  /** attack: front → objective; fallBack: front → its new line (null when already there). */
  readonly arrow: { from: V2; to: V2 } | null;
  /** Unit normal of the line toward the enemy (away from the own capital). */
  readonly enemy: V2;
  /** Label anchor (line centre or objective). */
  readonly anchor: V2;
}

/**
 * Shape of an order. `line` is the sim's derived line when known; otherwise it is derived here
 * the same way the sim does (preview before the command lands).
 */
export function orderShape(kind: OrderKind, a: V2, b: V2 | null, line: { a: V2; b: V2 } | null, from: V2 | null, home: V2): OrderShape | null {
  if (kind === 'auto') return null;
  let ln = line;
  if (!ln && b) ln = { a, b };
  if (!ln && kind !== 'attack') {
    const along = Math.atan2(a.z - home.z, a.x - home.x) + Math.PI / 2;
    const dx = Math.cos(along) * POINT_LINE_HALF_M;
    const dz = Math.sin(along) * POINT_LINE_HALF_M;
    ln = { a: { x: a.x - dx, z: a.z - dz }, b: { x: a.x + dx, z: a.z + dz } };
  }
  const anchor = ln ? { x: (ln.a.x + ln.b.x) / 2, z: (ln.a.z + ln.b.z) / 2 } : a;
  let enemy = { x: anchor.x - home.x, z: anchor.z - home.z };
  if (ln) {
    const tx = ln.b.x - ln.a.x;
    const tz = ln.b.z - ln.a.z;
    const l = Math.hypot(tx, tz) || 1;
    const n = { x: -tz / l, z: tx / l };
    enemy = n.x * enemy.x + n.z * enemy.z >= 0 ? n : { x: -n.x, z: -n.z };
  } else {
    const l = Math.hypot(enemy.x, enemy.z) || 1;
    enemy = { x: enemy.x / l, z: enemy.z / l };
  }
  let arrow: OrderShape['arrow'] = null;
  if (from && kind === 'attack' && !ln && Math.hypot(a.x - from.x, a.z - from.z) > 40) arrow = { from, to: a };
  if (from && kind === 'fallBack' && ln) {
    const to = closestOnSegment(from, ln.a, ln.b);
    if (Math.hypot(to.x - from.x, to.z - from.z) > 60) arrow = { from, to };
  }
  return { kind, line: ln, arrow, enemy, anchor };
}

/** Standing order of a front as drawn. */
export function frontOrderShape(w: World, f: Faction, s: Front): OrderShape | null {
  return orderShape(s.order.kind, s.order.a, s.order.b, s.line, s.front, w.hqPos(f.id));
}

const VERT = /* glsl */ `
attribute vec2 aOff;
attribute vec3 aCol;
attribute vec2 aDash;
uniform float uScale;
varying vec3 vCol;
varying vec2 vDash;
void main() {
  vCol = aCol;
  vDash = aDash;
  vec3 p = position + vec3(aOff.x, 0.0, aOff.y) * uScale;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_Position.z -= 0.008 * gl_Position.w;
}`;

const FRAG = /* glsl */ `
uniform float uAlpha;
uniform float uScale;
varying vec3 vCol;
varying vec2 vDash;
void main() {
  // vDash.x = distance along (m), vDash.y = 1 for dashed strokes.
  if (vDash.y > 0.5 && fract(vDash.x / (20.0 * uScale)) > 0.56) discard;
  float ink = 0.9 + 0.1 * sin(vDash.x * 0.07) * sin(vDash.x * 0.021 + 1.3);
  gl_FragColor = vec4(vCol * ink, uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

class Buf {
  readonly pos: number[] = [];
  readonly off: number[] = [];
  readonly col: number[] = [];
  readonly dash: number[] = [];
  readonly idx: number[] = [];

  constructor(private readonly heightAt: (x: number, z: number) => number) {}

  private vert(p: V2, ox: number, oz: number, c: THREE.Color, u: number, dashed: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, this.heightAt(p.x, p.z) + LIFT, p.z);
    this.off.push(ox, oz);
    this.col.push(c.r, c.g, c.b);
    this.dash.push(u, dashed);
    return i;
  }

  /** A stroke of half-width `hw` (m) along an evenly sampled polyline. */
  strip(pts: V2[], hw: number, c: THREE.Color, dashed: boolean): void {
    let u = 0;
    let prev = -1;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) u += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / l;
      const nz = (b.x - a.x) / l;
      const v = this.vert(pts[i], nx * hw, nz * hw, c, u, dashed ? 1 : 0);
      this.vert(pts[i], -nx * hw, -nz * hw, c, u, dashed ? 1 : 0);
      if (prev >= 0) this.idx.push(prev, v, prev + 1, prev + 1, v, v + 1);
      prev = v;
    }
  }

  /** Convex polygon anchored at `p`, vertices given as metre offsets (scaled with zoom). */
  poly(p: V2, offs: [number, number][], c: THREE.Color): void {
    const base = this.pos.length / 3;
    for (const [ox, oz] of offs) this.vert(p, ox, oz, c, 0, 0);
    for (let k = 1; k + 1 < offs.length; k++) this.idx.push(base, base + k, base + k + 1);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aOff', new THREE.Float32BufferAttribute(this.off, 2));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aDash', new THREE.Float32BufferAttribute(this.dash, 2));
    g.setIndex(this.idx);
    return g;
  }
}

function sample(a: V2, b: V2): V2[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / STEP));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n }));
}

function closestOnSegment(p: V2, a: V2, b: V2): V2 {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return { x: a.x + vx * t, z: a.z + vz * t };
}

const INK = new THREE.Color('#1f231e');

/** Draw one order shape into a buffer. `k` scales widths (spectator / main effort). */
function drawShape(b: Buf, sh: OrderShape, faction: THREE.Color, k: number): void {
  const col = new THREE.Color(ORDER_COLOR[sh.kind]);
  const w = WIDTH * k;
  const en = sh.enemy;
  if (sh.arrow) arrowShape(b, sh.arrow.from, sh.arrow.to, w * (sh.kind === 'attack' ? 1.1 : 0.7), col, faction, sh.kind === 'fallBack');
  const ln = sh.line;
  if (!ln && sh.kind === 'attack' && !sh.arrow) {
    // Already on the objective: four arrow-heads closing in on it.
    for (let q = 0; q < 4; q++) {
      const ang = (q * Math.PI) / 2 + Math.PI / 4;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      b.poly(sh.anchor, head(-dx, -dz, -w * 4.4, -w * 1.6, w * 1.2 + 1.5 * k), INK);
      b.poly(sh.anchor, head(-dx, -dz, -w * 4.2, -w * 1.9, w), col);
    }
  }
  if (!ln) return;
  const pts = sample(ln.a, ln.b);
  const len = Math.hypot(ln.b.x - ln.a.x, ln.b.z - ln.a.z) || 1;
  const tx = (ln.b.x - ln.a.x) / len;
  const tz = (ln.b.z - ln.a.z) / len;
  // Faction-coloured edge, ink core outline, order-coloured body.
  b.strip(pts, w * 0.5 + 2.6 * k, faction, false);
  b.strip(pts, w * 0.5 + 1.1 * k, INK, sh.kind === 'fallBack');
  b.strip(pts, w * 0.5, col, sh.kind === 'fallBack');
  // End caps: short bars square to the line.
  for (const p of [ln.a, ln.b]) b.poly(p, rect(tx, tz, en.x, en.z, -w * 1.1, w * 1.1, -w * 0.25, w * 0.25), INK);
  const marks = (spacing: number, fn: (p: V2) => void): void => {
    const n = Math.max(1, Math.floor(len / spacing));
    for (let i = 0; i < n; i++) {
      const s = ((i + 0.5) / n) * len;
      fn({ x: ln.a.x + tx * s, z: ln.a.z + tz * s });
    }
  };
  if (sh.kind === 'defend') {
    marks(26 * k, (p) => b.poly(p, rect(en.x, en.z, tx, tz, w * 0.4, w * 1.7, -w * 0.18, w * 0.18), col));
  } else if (sh.kind === 'fortify') {
    marks(24 * k, (p) => {
      b.poly(p, rect(en.x, en.z, tx, tz, w * 0.4, w * 1.45, -w * 0.5, w * 0.5), INK);
      b.poly(p, rect(en.x, en.z, tx, tz, w * 0.4, w * 1.3, -w * 0.38, w * 0.38), col);
    });
  } else if (sh.kind === 'attack') {
    // Chevrons pushing across the line toward the enemy.
    const n = Math.max(1, Math.min(5, Math.round(len / 140)));
    for (let i = 0; i < n; i++) {
      const s = ((i + 0.5) / n) * len;
      const p = { x: ln.a.x + tx * s, z: ln.a.z + tz * s };
      b.poly(p, head(en.x, en.z, w * 0.6, w * 3.4, w * 1.5 + 1.5 * k), INK);
      b.poly(p, head(en.x, en.z, w * 0.9, w * 3.0, w * 1.3), col);
    }
  }
}

/** Arrow shaft (from → to) and a barbed head ending at `to`. */
function arrowShape(b: Buf, from: V2, to: V2, w: number, col: THREE.Color, faction: THREE.Color, dashed: boolean): void {
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  if (len < 1) return;
  const dx = (to.x - from.x) / len;
  const dz = (to.z - from.z) / len;
  // The head scales with zoom from the shaft end, so leave room for it.
  const headLen = Math.min(len * 0.45, w * 3.2);
  const baseP = { x: to.x - dx * headLen, z: to.z - dz * headLen };
  const pts = sample(from, baseP);
  b.strip(pts, w * 0.5 + 2.2, faction, false);
  b.strip(pts, w * 0.5 + 0.9, INK, dashed);
  b.strip(pts, w * 0.5, col, dashed);
  b.poly(baseP, head(dx, dz, 0, headLen + 2, w * 1.5 + 2), INK);
  b.poly(baseP, head(dx, dz, 0.8, headLen, w * 1.3), col);
}

/** Rectangle offsets: `u` axis from u0..u1, `v` axis from v0..v1. */
function rect(ux: number, uz: number, vx: number, vz: number, u0: number, u1: number, v0: number, v1: number): [number, number][] {
  return [
    [ux * u0 + vx * v0, uz * u0 + vz * v0], [ux * u1 + vx * v0, uz * u1 + vz * v0],
    [ux * u1 + vx * v1, uz * u1 + vz * v1], [ux * u0 + vx * v1, uz * u0 + vz * v1],
  ];
}

/** Arrow-head triangle along (dx,dz): base at `back`, tip at `tip`, half-width `half`. */
function head(dx: number, dz: number, back: number, tip: number, half: number): [number, number][] {
  const nx = -dz;
  const nz = dx;
  return [[dx * back + nx * half, dz * back + nz * half], [dx * tip, dz * tip], [dx * back - nx * half, dz * back - nz * half]];
}

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}

export interface OrderPreview {
  readonly kind: OrderKind;
  readonly a: V2;
  readonly b: V2 | null;
  readonly from: V2 | null;
  readonly home: V2;
  readonly color: string;
}

export class OrderLines {
  readonly group = new THREE.Group();
  private readonly standing: THREE.Mesh;
  private readonly preview: THREE.Mesh;
  private readonly uniforms = { uAlpha: { value: 0.95 }, uScale: { value: 1 } };
  private readonly previewUniforms = { uAlpha: { value: 0.78 }, uScale: { value: 1 } };
  private sig = NaN;
  private rebuiltAt = -1e9;
  private previewSig = '';
  /** Display name of a front for the map stamp (set by the HUD; null = no labels). */
  label: ((faction: number, frontId: number) => string) | null = null;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    const mk = (u: object, order: number): THREE.Mesh => {
      const mat = new THREE.ShaderMaterial({ uniforms: u as Record<string, THREE.IUniform>, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      m.frustumCulled = false;
      m.renderOrder = order;
      return m;
    };
    this.standing = mk(this.uniforms, 5);
    this.preview = mk(this.previewUniforms, 6);
    this.preview.visible = false;
    this.group.add(this.standing, this.preview);
  }

  /** Per frame: rebuild on change (throttled) and keep a minimum on-screen width. */
  sync(w: World, playerId: number, spectator: boolean, visible: boolean, ppm: number): void {
    // Never thinner than MIN_PX on screen; down among the troops it slims to a pencil line.
    const scale = Math.min(4, Math.max(0.45, MIN_PX / (WIDTH * Math.max(0.02, ppm))));
    this.uniforms.uScale.value = scale;
    this.previewUniforms.uScale.value = scale;
    // Slightly softer once the camera is down among the troops.
    this.uniforms.uAlpha.value = ppm > 3 ? 0.72 : 0.95;
    this.standing.visible = visible;
    if (!visible) return;
    let h = mix(2166136261, spectator ? 7 : playerId + 11);
    for (const f of w.factions) {
      if ((!spectator && f.id !== playerId) || !f.alive) continue;
      h = mix(h, f.mainFront + 101);
      for (const s of f.fronts) {
        const o = s.order;
        if (o.kind === 'auto') continue;
        h = mix(mix(h, f.id * 64 + s.id), o.kind.length * 31 + Math.round(o.issuedAt));
        h = mix(mix(h, Math.round(o.a.x)), Math.round(o.a.z));
        if (o.b) h = mix(mix(h, Math.round(o.b.x)), Math.round(o.b.z));
        if (s.line) h = mix(mix(mix(mix(h, Math.round(s.line.a.x)), Math.round(s.line.a.z)), Math.round(s.line.b.x)), Math.round(s.line.b.z));
        // Arrow tails follow the front, coarsely.
        if (o.kind === 'attack' || o.kind === 'fallBack') h = mix(mix(h, Math.round(s.front.x / 25)), Math.round(s.front.z / 25));
      }
    }
    if (h === this.sig) return;
    const now = performance.now();
    if (now - this.rebuiltAt < REBUILD_MIN_MS && Number.isFinite(this.sig)) return;
    this.rebuiltAt = now;
    this.sig = h;
    const b = new Buf(this.heightAt);
    for (const f of w.factions) {
      if ((!spectator && f.id !== playerId) || !f.alive) continue;
      const fc = new THREE.Color(f.color);
      for (const s of f.fronts) {
        const sh = frontOrderShape(w, f, s);
        if (sh) drawShape(b, sh, fc, spectator ? SPECTATOR_K : s.id === f.mainFront ? 1.2 : 1);
      }
    }
    this.standing.geometry.dispose();
    this.standing.geometry = b.geometry();
  }

  /** Order being placed (null clears). Cheap: rebuilt only when the rounded input changes. */
  setPreview(p: OrderPreview | null): void {
    if (!p) {
      this.preview.visible = false;
      this.previewSig = '';
      return;
    }
    const r = (v: V2 | null): string => (v ? `${Math.round(v.x)},${Math.round(v.z)}` : '-');
    const sig = `${p.kind}|${r(p.a)}|${r(p.b)}|${r(p.from)}|${p.color}`;
    this.preview.visible = true;
    if (sig === this.previewSig) return;
    this.previewSig = sig;
    const b = new Buf(this.heightAt);
    const sh = orderShape(p.kind, p.a, p.b, null, p.from, p.home);
    if (sh) drawShape(b, sh, new THREE.Color(p.color), 1);
    else b.poly(p.a, rect(1, 0, 0, 1, -6, 6, -6, 6), new THREE.Color(ORDER_COLOR.auto));
    this.preview.geometry.dispose();
    this.preview.geometry = b.geometry();
  }

  /** Stamp each of the player's order lines with its front name (2D overlay). */
  drawLabels(o: ScreenOverlay, w: World, playerId: number, spectator: boolean, visible: boolean): void {
    if (!visible || spectator || !this.label) return;
    const f = w.factions[playerId];
    if (!f?.alive) return;
    const g = o.ctx;
    const P = { x: 0, y: 0 };
    g.font = `700 ${12}px "Big Shoulders Stencil Display", "Oswald", "Microsoft YaHei", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const s of f.fronts) {
      const sh = frontOrderShape(w, f, s);
      if (!sh) continue;
      const p = sh.anchor;
      if (!o.project(p.x, this.heightAt(p.x, p.z) + 6, p.z, P) || !o.onScreen(P)) continue;
      const text = this.label(f.id, s.id);
      const tw = g.measureText(text).width + 12;
      const y = P.y + 16;
      g.save();
      g.translate(P.x, y);
      g.rotate(-0.04);
      g.fillStyle = 'rgba(244, 236, 217, 0.88)';
      g.fillRect(-tw / 2, -9, tw, 18);
      g.strokeStyle = ORDER_COLOR[s.order.kind] === ORDER_COLOR.defend ? '#4b5945' : ORDER_COLOR[s.order.kind];
      g.lineWidth = 2;
      g.strokeRect(-tw / 2 + 1, -8, tw - 2, 16);
      g.fillStyle = '#272c27';
      g.fillText(text, 0, 1);
      g.restore();
    }
  }

  dispose(): void {
    for (const m of [this.standing, this.preview]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}
