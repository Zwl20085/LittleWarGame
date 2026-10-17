import type { MoveClass, Rules, TransportRules, UnitDef } from '../data/types';
import { TERRAIN_MOVE } from './config';
import { Ground } from './terrain';

/**
 * 3.0 roads as a movement layer (V30_SPEC §10). On a road (and, by default, a town street) every
 * class moves at `on_road`; off it at `off_road[class]` (tracked 0.6, wheeled 0.4, infantry 0.75,
 * towed guns 0.5), stacked with the 2.2 forest / town / mud modifiers and the grade. The nav
 * grids use the same multipliers as travel costs, so routes funnel onto roads, junctions and
 * bridges; fords cost extra (`ford_nav_cost`). `transport.enabled = false` restores 2.2.
 */

/** The rules block, or null when the system is off (lab A/B) or absent (old rule sets). */
export function transportRules(rules: Rules): TransportRules | null {
  const t = rules.transport;
  return t && t.enabled ? t : null;
}

/** Movement class of a unit type: rules `class_of` override, else by kind. */
export function moveClassOf(t: TransportRules | null, def: UnitDef): MoveClass {
  const o = t?.class_of?.[def.id];
  if (o) return o;
  return def.kind === 'vehicle' ? 'tracked' : def.kind === 'crew' ? 'towed' : 'infantry';
}

const terrainKey = (g: Ground): keyof typeof TERRAIN_MOVE =>
  g === Ground.Road ? 'road' : g === Ground.Forest ? 'forest' : g === Ground.Town ? 'town' : g === Ground.Mud || g === Ground.Ford ? 'mud' : 'open';

/** Is this ground a road for the off-road rule (roads; town streets unless switched off)? */
export function roadLike(t: TransportRules, g: Ground): boolean {
  return g === Ground.Road || (g === Ground.Town && t.town_counts_as_road !== false);
}

/**
 * Speed multiplier of ground `g` for class `cls` (before grade). With transport off: the 2.2
 * table (`TERRAIN_MOVE[key][foot|vehicle]`, roads 1.05 / 1.35).
 */
export function groundMul(t: TransportRules | null, g: Ground, cls: MoveClass): number {
  const vehicle = cls === 'tracked' || cls === 'wheeled';
  const key = terrainKey(g);
  if (!t) return TERRAIN_MOVE[key][vehicle ? 1 : 0];
  // The terrain part relative to open ground (roads are the reference, 1).
  const terrain = key === 'road' ? 1 : TERRAIN_MOVE[key][vehicle ? 1 : 0];
  return terrain * (roadLike(t, g) ? t.on_road : t.off_road[cls]);
}

/** Nav grid class → movement class used for its travel costs (vehicle grids: tracked, foot grids: infantry). */
export const navMoveClass = (vehicle: boolean): MoveClass => (vehicle ? 'tracked' : 'infantry');

/**
 * Travel-cost factor of ground `g` on a nav grid (1 / speed multiplier), with the ford penalty.
 * `hMul` is the A* heuristic factor: the cheapest cost per metre any cell can have.
 */
export function navCostFns(rules: Rules, vehicle: boolean): { mul: (g: Ground) => number; ford: number; hMul: number } {
  const t = transportRules(rules);
  const cls = navMoveClass(vehicle);
  const ford = t?.ford_nav_cost ?? 1;
  let best = 0;
  for (const g of [Ground.Open, Ground.Road, Ground.Forest, Ground.Town, Ground.Mud]) best = Math.max(best, groundMul(t, g, cls));
  // Transport off: the 2.2 heuristic factor exactly (1 / 1.35 rounded), so old routes are unchanged.
  return { mul: (g: Ground) => groundMul(t, g, cls), ford, hMul: t ? 1 / best : 0.74 };
}
