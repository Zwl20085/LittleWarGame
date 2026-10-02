import * as THREE from 'three';

/** Look of one class of ballistic shell (mortar bomb vs howitzer round). */
export interface TrailStyle {
  /** Ring-buffer points kept (≤ MAX_POINTS) and metres between them: trail length ≈ points × spacing. */
  readonly points: number;
  readonly spacing: number;
  /** Ribbon width at the head (m); it tapers toward the tail. */
  readonly width: number;
  readonly alpha: number;
  /** Hot colour at the head, cooling to `tail`. */
  readonly head: THREE.Color;
  readonly tail: THREE.Color;
  /** A smoke puff is shed every `smokeEvery` recorded points (see ShellTrails.onSmoke). */
  readonly smokeEvery: number;
}

const MAX_POINTS = 34;
/** Ribbons drawn at once; extra shells still fly (and smoke) but get no light trail. */
const MAX_TRAILS = 200;
/** Seconds a trail keeps glowing after its shell has landed. */
const FADE_OUT = 0.55;
/** Ribbons never get thinner than this on screen (CSS px), so arcs read when zoomed out. */
const MIN_PX = 3.5;
const VERTS = MAX_TRAILS * (MAX_POINTS + 1) * 2;

interface Trail {
  readonly pts: Float32Array;
  head: number;
  n: number;
  /** Points recorded since launch (drives smoke shedding). */
  shed: number;
  x: number;
  y: number;
  z: number;
  seen: number;
  /** Seconds since the shell vanished (0 = still flying). */
  dying: number;
  /** Descent brightening 0..1 (the "incoming" streak). */
  heat: number;
  style: TrailStyle;
}

const _side = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _col = new THREE.Color();

/** Ribbon vertex k of a trail: 0 = the live head, then recorded points newest → oldest. */
function vertexAt(t: Trail, k: number, out: THREE.Vector3): THREE.Vector3 {
  if (k === 0) return out.set(t.x, t.y, t.z);
  const o = ((t.head - (k - 1) + MAX_POINTS) % MAX_POINTS) * 3;
  return out.set(t.pts[o], t.pts[o + 1], t.pts[o + 2]);
}

/**
 * Glowing, tapering light ribbons along each ballistic shell's real flight path: a pooled ring
 * buffer of recent positions per shell, rebuilt each frame into one camera-facing additive
 * strip mesh (one draw call). Trails keep glowing briefly after impact. Nothing is allocated
 * per frame; trails are recycled through a free list.
 */
export class ShellTrails {
  readonly mesh: THREE.Mesh;
  /** Called when a trail sheds a smoke puff at (x, y, z) — Effects turns it into a particle. */
  onSmoke: ((x: number, y: number, z: number, style: TrailStyle) => void) | null = null;
  private readonly live = new Map<number, Trail>();
  private readonly pool: Trail[] = [];
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  private readonly side: THREE.BufferAttribute;
  private readonly index: THREE.BufferAttribute;
  private frame = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    const mk = (n: number): THREE.BufferAttribute => new THREE.BufferAttribute(new Float32Array(VERTS * n), n).setUsage(THREE.DynamicDrawUsage);
    this.pos = mk(3);
    this.col = mk(4);
    this.side = mk(1);
    this.index = new THREE.BufferAttribute(new Uint16Array(MAX_TRAILS * MAX_POINTS * 6), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aCol', this.col);
    g.setAttribute('aSide', this.side);
    g.setIndex(this.index);
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 aCol; attribute float aSide;
        varying vec4 vCol; varying float vSide;
        void main() {
          vCol = aCol; vSide = aSide;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vCol; varying float vSide;
        void main() {
          // Soft edge with a white-hot core down the middle of the ribbon.
          float e = 1.0 - vSide * vSide;
          float core = e * e * e * e;
          gl_FragColor = vec4(vCol.rgb * e + vec3(core * 0.3), vCol.a * e);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  begin(): void {
    this.frame++;
  }

  /** Follow shell `id` this frame; `heat` (0..1) brightens the head as it plunges. */
  track(id: number, x: number, y: number, z: number, style: TrailStyle, heat: number): void {
    let t = this.live.get(id);
    if (!t) {
      if (this.live.size >= MAX_TRAILS) return;
      t = this.pool.pop() ?? { pts: new Float32Array(MAX_POINTS * 3), head: 0, n: 0, shed: 0, x: 0, y: 0, z: 0, seen: 0, dying: 0, heat: 0, style };
      t.head = 0;
      t.n = 0;
      t.shed = 0;
      t.dying = 0;
      t.style = style;
      this.live.set(id, t);
      this.record(t, x, y, z);
    }
    t.x = x;
    t.y = y;
    t.z = z;
    t.heat = heat;
    t.seen = this.frame;
    const o = t.head * 3;
    const dx = x - t.pts[o];
    const dy = y - t.pts[o + 1];
    const dz = z - t.pts[o + 2];
    if (dx * dx + dy * dy + dz * dz > style.spacing * style.spacing) this.record(t, x, y, z);
  }

  private record(t: Trail, x: number, y: number, z: number): void {
    t.head = (t.head + 1) % MAX_POINTS;
    const o = t.head * 3;
    t.pts[o] = x;
    t.pts[o + 1] = y;
    t.pts[o + 2] = z;
    t.n = Math.min(t.style.points, t.n + 1);
    if (++t.shed % t.style.smokeEvery === 0) this.onSmoke?.(x, y, z, t.style);
  }

  /**
   * Rebuild the ribbon mesh. `view` is the camera's forward direction (orthographic: the same
   * for every point), `pxPerM` keeps ribbons at least MIN_PX wide on screen.
   */
  end(dt: number, view: THREE.Vector3, pxPerM: number): void {
    const P = this.pos.array as Float32Array;
    const C = this.col.array as Float32Array;
    const S = this.side.array as Float32Array;
    const I = this.index.array as Uint16Array;
    const minW = MIN_PX / Math.max(0.05, pxPerM);
    let nv = 0;
    let ni = 0;
    for (const [id, t] of this.live) {
      if (t.seen !== this.frame) {
        t.dying += dt;
        if (t.dying >= FADE_OUT || t.n === 0) {
          this.live.delete(id);
          this.pool.push(t);
          continue;
        }
      }
      const st = t.style;
      const life = t.dying > 0 ? 1 - t.dying / FADE_OUT : 1;
      const halfW = Math.max(st.width, minW) * 0.5;
      const count = t.n + 1;
      let sx = 0;
      let sy = 1;
      let sz = 0;
      for (let k = 0; k < count; k++) {
        vertexAt(t, k, _a);
        const x = _a.x;
        const y = _a.y;
        const z = _a.z;
        // Side vector ⟂ to both the local tangent and the view ray (camera-facing strip);
        // central differences, skipping a head that has barely left its last point.
        vertexAt(t, Math.max(0, k - 1), _b);
        vertexAt(t, Math.min(count - 1, k + 1), _c);
        _tan.subVectors(_b, _c);
        if (_tan.lengthSq() < 0.01 && k + 2 < count) _tan.subVectors(_b, vertexAt(t, k + 2, _c));
        _side.crossVectors(_tan, view);
        const len = _side.length();
        if (len > 1e-4) {
          sx = _side.x / len;
          sy = _side.y / len;
          sz = _side.z / len;
        }
        const f = k / Math.max(1, count - 1);
        const w = halfW * (1 - 0.65 * f) * (k === 0 ? 0.7 + 0.5 * t.heat : 1);
        const a = st.alpha * life * (1 - f) ** 1.1 * (k === 0 ? 1 : 0.85 + 0.3 * t.heat * (1 - f));
        _col.copy(st.head).lerp(st.tail, Math.min(1, f * 3));
        if (t.heat > 0 && f < 0.3) _col.lerp(st.head, t.heat * (1 - f / 0.3));
        for (let s = -1; s <= 1; s += 2) {
          const v3 = nv * 3;
          P[v3] = x + sx * w * s;
          P[v3 + 1] = y + sy * w * s;
          P[v3 + 2] = z + sz * w * s;
          const v4 = nv * 4;
          C[v4] = _col.r;
          C[v4 + 1] = _col.g;
          C[v4 + 2] = _col.b;
          C[v4 + 3] = a;
          S[nv] = s;
          nv++;
        }
        if (k > 0) {
          const b = nv - 4;
          I[ni++] = b; I[ni++] = b + 1; I[ni++] = b + 2;
          I[ni++] = b + 1; I[ni++] = b + 3; I[ni++] = b + 2;
        }
      }
    }
    for (const a of [this.pos, this.col, this.side]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, nv * a.itemSize);
      a.needsUpdate = true;
    }
    this.index.clearUpdateRanges();
    this.index.addUpdateRange(0, ni);
    this.index.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, ni);
  }
}
