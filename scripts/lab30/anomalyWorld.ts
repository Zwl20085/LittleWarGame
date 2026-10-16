// Read-only world helpers for the anomaly probe (inlined, so a probe of a frozen source tree does
// not depend on that tree's module internals).
import type { LogisticsRules } from '../../src/data/types';
import type { Place, Unit } from '../../src/sim/types';
import type { V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';

export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);

export const centroid = (us: readonly Unit[]): V2 => ({
  x: us.reduce((a, u) => a + u.pos.x, 0) / Math.max(1, us.length),
  z: us.reduce((a, u) => a + u.pos.z, 0) / Math.max(1, us.length),
});

export const isTruck = (u: Unit): boolean => u.def.id === 'supply_truck';
const TANKS = new Set(['light_tank', 'medium_tank', 'heavy_tank']);
export const isTankUnit = (u: Unit): boolean => TANKS.has(u.def.id) && !u.fixed;

/** Armed, mobile fighting unit (draws ammunition): not a truck, commander or strongpoint. */
export const isCombat = (u: Unit): boolean => u.hp > 0 && !u.fixed && u.primary !== null && !isTruck(u) && u.def.id !== 'commander';

export function placeOwnerOf(w: World, p: Place): number {
  if (p.capitalOf >= 0) return w.factions[p.capitalOf]?.alive ? p.capitalOf : -1;
  return w.objectives[p.objIdx]?.owner ?? -1;
}

export const placeContestedOf = (w: World, p: Place): boolean => p.objIdx >= 0 && !!w.objectives[p.objIdx]?.contested;

export const logi = (w: World): LogisticsRules | undefined => w.data.rules.logistics;

export const drawRadiusOf = (w: World, p: Place): number => logi(w)?.draw_radius_m[p.kind] ?? 130;

/** Nearest own, uncontested place to `at` (any stock), with its distance. */
export function nearestOwnPlace(w: World, f: number, at: V2): { place: Place; d: number } | null {
  let best: { place: Place; d: number } | null = null;
  for (const p of w.places) {
    if (placeOwnerOf(w, p) !== f || placeContestedOf(w, p)) continue;
    const d = dist(p.pos, at);
    if (!best || d < best.d) best = { place: p, d };
  }
  return best;
}

/** Most common value (ties: first seen). */
export function mode<T>(xs: readonly T[]): T | undefined {
  const c = new Map<T, number>();
  let best: T | undefined;
  let bn = 0;
  for (const x of xs) {
    const n = (c.get(x) ?? 0) + 1;
    c.set(x, n);
    if (n > bn) {
      bn = n;
      best = x;
    }
  }
  return best;
}
