import * as THREE from 'three';

/**
 * Trench earthworks as a swept, terrain-draped cross-section along the (zig-zag) trench line:
 * spoil bank (parados) behind, dark dug channel, timber-faced fire step and a sloping parapet
 * toward the enemy. Mitred at the traverse corners, capped at both ends (the far cap is the
 * working face while the trench is being dug). Output is flat-shaded, vertex-coloured triangles.
 */

/** Cross-section exaggeration so the works hold their own next to the oversized soldiers. */
export const TRENCH_X = 1.35;

const C = {
  bank: new THREE.Color('#857150'),
  bankTop: new THREE.Color('#8c7752'),
  cutBack: new THREE.Color('#58483a'),
  floor: new THREE.Color('#342b20'),
  revet: new THREE.Color('#5f4d38'),
  lip: new THREE.Color('#9a8460'),
  glacis: new THREE.Color('#8f7a55'),
  face: new THREE.Color('#6b5940'),
  /** Caved-in channel of a wrecked trench: spoil slumped back into the cut. */
  slumped: new THREE.Color('#6e5c42'),
};

/** Surface profile, rear toe → front toe: [lateral (toward enemy), height, colour of the next facet]. */
const PROFILE: readonly [number, number, THREE.Color][] = [
  [-5.2, -0.35, C.bank],
  [-3.0, 0.7, C.bankTop],
  [-1.7, 0.55, C.cutBack],
  [-1.3, 0.06, C.floor],
  [1.3, 0.06, C.revet],
  [1.4, 1.05, C.lip],
  [2.1, 1.25, C.glacis],
  [3.6, 0.95, C.glacis],
  [6.2, -0.35, C.glacis],
];

/** Lateral offset and crest height (pre-exaggeration) of the parapet sandbag row. */
export const CREST = { lat: 1.75, y: 1.18 } as const;
/** Fire-step (front) wall lateral offset. */
export const FIRE_STEP = 1.32;

const X = TRENCH_X;
const prof = PROFILE.map(([l, y, c]) => [l * X, y > 0 ? y * X : y, c] as const);
const capTris = THREE.ShapeUtils.triangulateShape(prof.map(([l, y]) => new THREE.Vector2(l, y)), []);

export interface SweepArrays {
  readonly pos: Float32Array;
  readonly nor: Float32Array;
  readonly col: Float32Array;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c2 = new THREE.Vector3();

class Tris {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];

  /** One flat-shaded triangle; flipped if needed so its normal points along `up` side. */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color, out: THREE.Vector3): void {
    _n.subVectors(b, a).cross(_c.subVectors(c, a));
    let p = b;
    let q = c;
    if (_n.dot(out) < 0) {
      _n.negate();
      p = c;
      q = b;
    }
    _n.normalize();
    for (const v of [a, p, q]) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.col.push(col.r, col.g, col.b);
    }
  }
}

/**
 * Sweep the profile along `path` (flat x,z pairs, ≥ 2 points). `side` = +1 when the enemy lies
 * on the path's left ((-dz, dx)), −1 otherwise. `flatten` < 1 for a slighted / shelled-out work.
 */
export function sweepTrench(path: readonly number[], side: number, heightAt: (x: number, z: number) => number, flatten: number): SweepArrays {
  const n = path.length / 2;
  const np = prof.length;
  if (n < 2) return { pos: new Float32Array(0), nor: new Float32Array(0), col: new Float32Array(0) };
  const ring: THREE.Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const x = path[i * 2];
    const z = path[i * 2 + 1];
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    // Mitred normal: average of the adjacent segment normals, stretched by 1/cos(half-turn).
    const n0 = segNormal(path, i0 === i ? i : i0, i0 === i ? i1 : i);
    const n1 = segNormal(path, i1 === i ? i0 : i, i1 === i ? i : i1);
    let mx = n0[0] + n1[0];
    let mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const stretch = 1 / Math.max(0.65, mx * n0[0] + mz * n0[1]);
    mx *= stretch * side;
    mz *= stretch * side;
    const r: THREE.Vector3[] = [];
    for (const [l, y] of prof) {
      const px = x + mx * l;
      const pz = z + mz * l;
      r.push(new THREE.Vector3(px, heightAt(px, pz) + (y > 0 ? y * flatten : y), pz));
    }
    ring.push(r);
  }
  const t = new Tris();
  const out = new THREE.Vector3();
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j + 1 < np; j++) {
      const a = ring[i][j];
      const b = ring[i + 1][j];
      const c = ring[i + 1][j + 1];
      const d = ring[i][j + 1];
      // Facets face up / away from the section's interior.
      const [, y0] = prof[j];
      const [, y1] = prof[j + 1];
      const dl = prof[j + 1][0] - prof[j][0];
      const dy = y1 - y0;
      // Outward normal of the 2D facet (lateral, up) = (-dy, dl) for a left-to-right profile.
      const ax = (ring[i][np - 1].x - ring[i][0].x);
      const az = (ring[i][np - 1].z - ring[i][0].z);
      const al = Math.hypot(ax, az) || 1;
      out.set((-dy * ax) / al, dl, (-dy * az) / al);
      const fc = flatten < 1 && (prof[j][2] === C.floor || prof[j][2] === C.revet || prof[j][2] === C.cutBack) ? C.slumped : prof[j][2];
      t.tri(a, b, c, fc, out);
      t.tri(a, c, d, fc, out);
    }
  }
  // End caps (cut earth faces).
  for (const i of [0, n - 1]) {
    const o = i === 0 ? 1 : n - 2;
    out.set(ring[i][0].x - ring[o][0].x, 0, ring[i][0].z - ring[o][0].z);
    for (const [p, q, r] of capTris) t.tri(_a.copy(ring[i][p]), _b.copy(ring[i][q]), _c2.copy(ring[i][r]), C.face, out);
  }
  return { pos: new Float32Array(t.pos), nor: new Float32Array(t.nor), col: new Float32Array(t.col) };
}


function segNormal(path: readonly number[], i: number, j: number): [number, number] {
  const dx = path[j * 2] - path[i * 2];
  const dz = path[j * 2 + 1] - path[i * 2 + 1];
  const l = Math.hypot(dx, dz) || 1;
  return [-dz / l, dx / l];
}
