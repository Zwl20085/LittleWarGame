import { perch, sightLine } from './buildings';
import { TERRAIN_COMBAT as TC, BUILDING } from './config';
import { Ground } from './terrain';
import type { Unit } from './types';
import type { V2 } from './vec';
import type { World } from './world';

/**
 * Terrain rules for fighting (BALANCE_SPEC §7.1): high ground, crest defilade, forest
 * concealment, exposed crossings and observation posts. All are point queries on the ground
 * grid / building raster, evaluated on shots, target scans and the 0.5 s visibility pass.
 */

const footOrCrew = (u: Unit): boolean => u.def.kind !== 'vehicle';

/** Ground under a unit is forest. */
export function inForest(world: World, u: Unit): boolean {
  return world.terrain.groundAt(u.pos.x, u.pos.z) === Ground.Forest;
}

/**
 * A unit sitting in forest that has not fired for `revealAfterFiringS` is only spotted /
 * engaged from within `forestConcealM` (60 m foot, 110 m vehicles).
 */
export function forestConcealed(world: World, from: V2, t: Unit): boolean {
  if (world.time - t.lastFiredAt <= TC.revealAfterFiringS) return false;
  const r = footOrCrew(t) ? TC.forestConcealM.foot : TC.forestConcealM.vehicle;
  const dx = t.pos.x - from.x;
  const dz = t.pos.z - from.z;
  if (dx * dx + dz * dz <= r * r) return false;
  return inForest(world, t);
}

/**
 * Terrain multiplier on direct-fire hit probability: downhill ×1.1 / uphill ×.92 for ≥ 8 m
 * height difference, crest defilade ×.75 when the uphill target's low ray is masked, vehicles
 * firing out of forest ×.8. One extra LOS ray only for uphill shots.
 */
export function shotTerrainMul(world: World, u: Unit, t: Unit, muzzleY: number): number {
  let m = 1;
  const dy = u.y - t.y;
  if (dy >= TC.highGroundM) m *= TC.downhillHitMul;
  else if (dy <= -TC.highGroundM) {
    m *= TC.uphillHitMul;
    if (!world.terrain.los(u.pos.x, muzzleY, u.pos.z, t.pos.x, t.y + 0.4, t.pos.z, 1e9, 1e9, false)) m *= TC.crestHitMul;
  }
  if (u.def.kind === 'vehicle' && inForest(world, u)) m *= TC.vehicleInForestHitMul;
  return m;
}

/** Infantry/crew on a ford or bridge deck cannot go to ground: suppression multiplier. */
export function exposureSuppressionMul(world: World, u: Unit): number {
  if (!footOrCrew(u)) return 1;
  const t = world.terrain;
  const g = t.groundAt(u.pos.x, u.pos.z);
  if (g === Ground.Ford) return TC.crossingSuppressionMul;
  if (g !== Ground.Road) return 1;
  const i = Math.round(u.pos.x / t.cell);
  const j = Math.round(u.pos.z / t.cell);
  const k = j * t.nx + i;
  return k >= 0 && k < t.waterSurface.length && !Number.isNaN(t.waterSurface[k]) ? TC.crossingSuppressionMul : 1;
}

/** Observer for the visibility pass (reused scratch: read before the next call). */
export interface Observer { r: number; x: number; y: number; z: number; perched: boolean }
const obs: Observer = { r: 0, x: 0, y: 0, z: 0, perched: false };

/** Vision radius and eye point: height bonus (+3 %/10 m above 10 m, ≤ +15 %) and tower/church perches (×1.3). */
export function observerOf(world: World, u: Unit): Observer {
  const elev = Math.min(TC.visionMaxBonus, Math.max(0, (u.y - 10) / 10) * TC.visionPer10M);
  const b = perch(world, u);
  obs.perched = b !== null;
  if (b) {
    obs.r = u.def.vision * Math.max(1 + elev, BUILDING.perchVisionMul);
    obs.x = b.x;
    obs.z = b.z;
    obs.y = world.terrain.heightAt(b.x, b.z) + Math.min(b.h, BUILDING.perchEyeMaxM) + 1;
  } else {
    obs.r = u.def.vision * (1 + elev);
    obs.x = u.pos.x;
    obs.z = u.pos.z;
    obs.y = u.y + 1.8;
  }
  return obs;
}

/** Can observer `u` (described by `o` from observerOf) see `t`? Concealment first, then LOS. */
export function canSpot(world: World, u: Unit, o: Observer, t: Unit): boolean {
  if (forestConcealed(world, u.pos, t)) return false;
  if (o.perched) return world.terrain.los(o.x, o.y, o.z, t.pos.x, t.y + 1.2, t.pos.z);
  return sightLine(world, u, 1.8, t, 1.2);
}

/** A friendly observer on high ground (≥ 8 m above the target) or on a tower sees `t`: tighter artillery fall. */
export function hasHighObserver(world: World, f: number, t: Unit): boolean {
  for (const o of world.spatial.query(t.pos.x, t.pos.z, TC.highObserverRange)) {
    if (o.owner !== f || o.hp <= 0 || o.routing) continue;
    const high = o.y - t.y >= TC.highGroundM;
    if (!high && o.cover !== 3) continue;
    const ob = observerOf(world, o);
    if (!high && !ob.perched) continue;
    const dx = o.pos.x - t.pos.x;
    const dz = o.pos.z - t.pos.z;
    if (dx * dx + dz * dz > ob.r * ob.r) continue;
    if (world.terrain.los(ob.x, ob.y, ob.z, t.pos.x, t.y + 1, t.pos.z)) return true;
  }
  return false;
}
