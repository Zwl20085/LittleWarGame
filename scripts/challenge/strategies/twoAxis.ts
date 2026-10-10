// two_axis — a general offensive whose axis alternates every 90 s between the two nearest
// neighbours' nearest towns (village if it has no town left, its capital when nothing else is left):
// the main effort switches between two axes while the other fronts attack their own objectives.
import type { Objective } from '../../../src/sim/types';
import { dist, type V2 } from '../../../src/sim/vec';
import type { Strategy, StrategyCtx } from '../types';
import { directive, enemiesByDistance, isCapital, setMix } from '../worldq';

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

export const twoAxis: Strategy = {
  id: 'two_axis',
  summary: 'general offensive; the axis alternates every 90 s between the two nearest neighbours\' nearest towns',
  setup(ctx) {
    setMix(ctx, { infantry: 35, mg: 6, motor_inf: 6, at_gun: 8, mortar: 6, light_tank: 8, medium_tank: 12, heavy_tank: 3, engineer: 3 });
  },
  tick(ctx) {
    const w = ctx.world;
    if (Math.floor(w.time) % 90 !== 0) return;
    const enemies = enemiesByDistance(w, ctx.me).slice(0, 2);
    if (enemies.length === 0) return;
    const turn = Math.floor(w.time / 90) % enemies.length;
    const e = enemies[turn];
    const next = nextPlaceOf(ctx, e, w.hqPos(ctx.me));
    if (next.capital) ctx.markAttack(e);
    directive(ctx, 'offensive', next.pos);
  },
};
