import { isCommander } from './formulas';
import { hostileMask } from './spatial';
import type { Unit } from './types';
import type { V2 } from './vec';
import type { World } from './world';

/**
 * Small value / position queries shared by the supreme HQ (theatre.ts) and the front commanders'
 * directive responses (frontresponse.ts). Leaf module: no sim-system imports, so no cycles.
 */

/** A unit's worth: (P + M) × its hp share. */
export const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);

/** Fighting units of a group: no commanders, no trucks. */
export const combatOf = (units: Unit[]): Unit[] => units.filter((u) => !isCommander(u.def) && u.def.id !== 'supply_truck');

export const sumValue = (units: Unit[]): number => units.reduce((a, u) => a + valueOf(u), 0);

export function centroid(units: Unit[], fallback: V2): V2 {
  if (units.length === 0) return fallback;
  let x = 0;
  let z = 0;
  for (const u of units) { x += u.pos.x; z += u.pos.z; }
  return { x: x / units.length, z: z / units.length };
}

/** Known hostile value within `r` of `at` (fixed weapons count at a flat 1400 hp scale). */
export function enemyNear(world: World, f: number, at: V2, r: number): number {
  let v = 0;
  for (const u of world.spatial.queryOwners(at.x, at.z, r, hostileMask(world, f))) {
    if (u.hp > 0 && world.knows(f, u) && !isCommander(u.def)) v += (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));
  }
  return v;
}

/** Distance from `p` to the segment a–b. */
export function segDist(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}
