import { Ground, type Terrain } from './terrain';
import type { V2 } from './vec';

/**
 * 2.2 economic-building lots (render agent, wave 2). The first slots were a fixed ring at 80 % of
 * the settlement radius, which put factories and depots on top of terraced houses and streets.
 * A lot is now searched for on the town's edge: a clear footprint (no building raster, no
 * water / ford, gentle slope, passable), off the carriageway but close to a road, and apart from
 * the other lots. Pure geometry on the static terrain — deterministic for a map.
 */
export const LOTS = {
  /** Radius (m) around the lot centre that must be free of buildings / water (largest model ≈ 9.5). */
  clearM: 12,
  /** Raster step (m) for the clearance test. */
  sampleM: 2,
  /** Lot centre at least this far from any road centre line (8 m painted half-width + footprint). */
  roadMinM: 18,
  /** Lots farther than this from a road are penalised (they should front a road). */
  roadNearM: 32,
  /** Search band: from this share of the town radius out to radius + outerM. */
  innerK: 0.85,
  outerM: 40,
  /** Preferred distance beyond the town radius (just outside the last houses). */
  preferOutM: 6,
  /** Minimum spacing between two lots of a place. */
  gapM: 30,
  maxSlopeDeg: 10,
} as const;

function roadDistance(t: Terrain, x: number, z: number): number {
  let best = Infinity;
  for (const road of t.def.roads) {
    for (let s = 0; s < road.length - 1; s++) {
      const ax = road[s].x;
      const az = road[s].z;
      const dx = road[s + 1].x - ax;
      const dz = road[s + 1].z - az;
      const l2 = dx * dx + dz * dz;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
      if (d < best) best = d;
    }
  }
  return best;
}

function clearLot(t: Terrain, x: number, z: number): boolean {
  const r = LOTS.clearM;
  if (!t.inBounds(x - r - 20, z - r - 20) || !t.inBounds(x + r + 20, z + r + 20)) return false;
  for (let dz = -r; dz <= r; dz += LOTS.sampleM) {
    for (let dx = -r; dx <= r; dx += LOTS.sampleM) {
      if (dx * dx + dz * dz > r * r) continue;
      const px = x + dx;
      const pz = z + dz;
      if (t.buildingH(px, pz) > 0) return false;
      const g = t.groundAt(px, pz);
      if (g === Ground.Water || g === Ground.Ford) return false;
    }
  }
  return t.slopeAt(x, z) <= LOTS.maxSlopeDeg;
}

/**
 * Up to `n` lots for a settlement at `c` with layout radius `townR`; `passable` says whether the
 * sim's nav grid accepts a point. Falls back to `fallback(k)` for slots no lot was found for.
 */
export function econLots(t: Terrain, c: V2, townR: number, n: number, angle0: number, passable: (p: V2) => boolean, fallback: (k: number) => V2): V2[] {
  if (n <= 0) return [];
  const cands: { p: V2; score: number }[] = [];
  const r0 = townR * LOTS.innerK;
  const r1 = townR + LOTS.outerM;
  for (let r = r0; r <= r1; r += 6) {
    const steps = Math.max(12, Math.round((2 * Math.PI * r) / 14));
    for (let k = 0; k < steps; k++) {
      const a = angle0 + (k * 2 * Math.PI) / steps;
      const p = { x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r };
      const dRoad = roadDistance(t, p.x, p.z);
      if (dRoad < LOTS.roadMinM) continue;
      if (!clearLot(t, p.x, p.z) || !passable(p)) continue;
      const score = Math.abs(r - (townR + LOTS.preferOutM)) * 0.5 + Math.max(0, dRoad - LOTS.roadNearM) * 1.5 + k * 1e-6;
      cands.push({ p, score });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  const out: V2[] = [];
  for (const c2 of cands) {
    if (out.length >= n) break;
    if (out.some((o) => Math.hypot(o.x - c2.p.x, o.z - c2.p.z) < LOTS.gapM)) continue;
    out.push(c2.p);
  }
  for (let k = out.length; k < n; k++) out.push(fallback(k));
  return out;
}
