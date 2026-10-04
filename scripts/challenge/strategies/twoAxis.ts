// two_axis — two fronts each attack a different neighbour's nearest town (village if it has no
// town left, its capital when nothing else is left), the third front defends home; every 90 s the
// attacking fronts re-target the next place of their neighbour (captured ones drop out).
import type { Objective } from '../../../src/sim/types';
import { angleDiff, dist, headingTo, type V2 } from '../../../src/sim/vec';
import type { Strategy, StrategyCtx } from '../types';
import { enemiesByDistance, frontCentre, frontIds, isCapital, order, setMix, towards } from '../worldq';
import { axisOf, rememberAxes } from './common';

/** The neighbour's nearest town / city to `from` (villages at 1.5× distance), else its capital. */
export function nextPlaceOf(ctx: StrategyCtx, enemy: number, from: V2): { pos: V2; capital: boolean } {
  const w = ctx.world;
  let best: Objective | null = null;
  let bd = Infinity;
  for (const o of w.objectives) {
    if (o.owner !== enemy || o.kind === 'point' || isCapital(w, o)) continue;
    const d = dist(from, o.pos) * (o.kind === 'village' ? 1.5 : 1);
    if (d < bd) { bd = d; best = o; }
  }
  return best ? { pos: best.pos, capital: false } : { pos: w.hqPos(enemy), capital: true };
}

/** Assign each enemy to the front whose initial axis points closest to that enemy's capital. */
function assign(ctx: StrategyCtx, enemies: number[], fronts: number[]): Map<number, number> {
  const hq = ctx.world.hqPos(ctx.me);
  const out = new Map<number, number>();
  const free = [...fronts];
  for (const e of enemies) {
    const bearing = headingTo(hq, ctx.world.hqPos(e));
    free.sort((a, b) => Math.abs(angleDiff(bearing, headingTo(hq, axisOf(ctx, a)))) - Math.abs(angleDiff(bearing, headingTo(hq, axisOf(ctx, b)))) || a - b);
    const f = free.shift();
    if (f !== undefined) out.set(f, e);
  }
  return out;
}

export const twoAxis: Strategy = {
  id: 'two_axis',
  summary: 'two fronts attack two neighbours\' nearest towns (re-target every 90 s), the third defends home',
  setup(ctx) {
    setMix(ctx, { infantry: 35, mg: 6, motor_inf: 6, at_gun: 8, mortar: 6, light_tank: 8, medium_tank: 12, heavy_tank: 3, engineer: 3 });
    rememberAxes(ctx);
  },
  tick(ctx) {
    const w = ctx.world;
    if (Math.floor(w.time) % 90 !== 0) return;
    const fronts = frontIds(ctx);
    const enemies = enemiesByDistance(w, ctx.me).slice(0, 2);
    const plan = assign(ctx, enemies, fronts);
    for (const id of fronts) {
      const e = plan.get(id);
      if (e === undefined) {
        order(ctx, id, 'defend', towards(w.hqPos(ctx.me), axisOf(ctx, id), 350));
        continue;
      }
      const next = nextPlaceOf(ctx, e, frontCentre(w, ctx.me, id));
      if (next.capital) ctx.markAttack(e);
      order(ctx, id, 'attack', next.pos);
    }
  },
};
