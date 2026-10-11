import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';

/** Value for vertices far from any road (metres). */
export const ROAD_FAR = 40;
const BUCKET = 64;
const REACH = 14;

/**
 * Per grid-node distance (m) to the nearest road centreline, so the terrain shader can draw a
 * crisp carriageway with darker verges and wheel ruts at any zoom (the sim's 16 m road band is
 * only a soft worn tint). Unsigned on purpose: a signed field flips between close parallel roads
 * and paints phantom strips. Far nodes get ROAD_FAR.
 */
export function roadDistanceField(t: Terrain): Float32Array {
  const nx = t.nx;
  const nz = t.nz;
  const out = new Float32Array(nx * nz).fill(ROAD_FAR);
  const segs: number[] = [];
  for (const road of t.def.roads) {
    for (let s = 0; s < road.length - 1; s++) segs.push(road[s].x, road[s].z, road[s + 1].x, road[s + 1].z);
  }
  if (segs.length === 0) return out;
  // Bucket segments by the cells their (padded) bounding box covers.
  const bx = Math.ceil(t.width / BUCKET) + 1;
  const bz = Math.ceil(t.depth / BUCKET) + 1;
  const buckets: number[][] = Array.from({ length: bx * bz }, () => []);
  for (let k = 0; k < segs.length; k += 4) {
    const x0 = Math.max(0, Math.floor((Math.min(segs[k], segs[k + 2]) - REACH) / BUCKET));
    const x1 = Math.min(bx - 1, Math.floor((Math.max(segs[k], segs[k + 2]) + REACH) / BUCKET));
    const z0 = Math.max(0, Math.floor((Math.min(segs[k + 1], segs[k + 3]) - REACH) / BUCKET));
    const z1 = Math.min(bz - 1, Math.floor((Math.max(segs[k + 1], segs[k + 3]) + REACH) / BUCKET));
    for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) buckets[j * bx + i].push(k);
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * t.cell;
      const z = j * t.cell;
      const list = buckets[Math.min(bz - 1, Math.floor(z / BUCKET)) * bx + Math.min(bx - 1, Math.floor(x / BUCKET))];
      let best = ROAD_FAR;
      for (const k of list) {
        const ax = segs[k];
        const az = segs[k + 1];
        const dx = segs[k + 2] - ax;
        const dz = segs[k + 3] - az;
        const l2 = dx * dx + dz * dz;
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
        const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
        if (d < best) {
          best = d;
        }
      }
      out[j * nx + i] = best;
    }
  }
  return out;
}

/** Road distance texture: metres per texel and the encoding scale (byte = metres × scale). */
export interface RoadTexture {
  readonly texture: THREE.DataTexture;
  readonly scale: number;
}

/** Byte value per metre of distance (0.16 m steps up to ROAD_FAR). */
const ROAD_TEX_SCALE = 255 / ROAD_FAR;
/** Largest texture side (texels); the texel grows on very large maps. */
const ROAD_TEX_MAX = 2048;

/**
 * The same unsigned road distance at ~2 m per texel, sampled per fragment (2.2). Interpolating
 * the 4 m vertex field across terrain triangles bent the carriageway edges and wheel ruts into a
 * zig-zag wherever a road ran diagonally to the grid; a bilinear texture at half the spacing is
 * straight to within a few centimetres. Built by stamping each segment's padded bounding box
 * (only texels near roads are visited).
 */
export function roadDistanceTexture(t: Terrain): RoadTexture {
  const texel = Math.max(2, Math.max(t.width, t.depth) / ROAD_TEX_MAX);
  const w = Math.ceil(t.width / texel) + 1;
  const h = Math.ceil(t.depth / texel) + 1;
  const dist = new Float32Array(w * h).fill(ROAD_FAR);
  for (const road of t.def.roads) {
    for (let s = 0; s < road.length - 1; s++) {
      const ax = road[s].x;
      const az = road[s].z;
      const dx = road[s + 1].x - ax;
      const dz = road[s + 1].z - az;
      const l2 = dx * dx + dz * dz;
      const i0 = Math.max(0, Math.floor((Math.min(ax, ax + dx) - ROAD_FAR) / texel));
      const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, ax + dx) + ROAD_FAR) / texel));
      const j0 = Math.max(0, Math.floor((Math.min(az, az + dz) - ROAD_FAR) / texel));
      const j1 = Math.min(h - 1, Math.ceil((Math.max(az, az + dz) + ROAD_FAR) / texel));
      for (let j = j0; j <= j1; j++) {
        const z = j * texel;
        for (let i = i0; i <= i1; i++) {
          const x = i * texel;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
          const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
          const k = j * w + i;
          if (d < dist[k]) dist[k] = d;
        }
      }
    }
  }
  const bytes = new Uint8Array(w * h);
  for (let k = 0; k < bytes.length; k++) bytes[k] = Math.min(255, Math.round(dist[k] * ROAD_TEX_SCALE));
  const texture = new THREE.DataTexture(bytes, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  // Texel centres sit on the grid nodes: the shader maps world (x, z) → ((x/texel + 0.5)/w, …).
  texture.userData = { texel, w, h };
  return { texture, scale: ROAD_TEX_SCALE };
}
