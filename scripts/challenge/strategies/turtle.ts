// turtle — every front fortifies a line ~400 m out toward its wing's objective; engineers / MG /
// AT heavy production; after 25 min all fronts attack the weakest neighbour's capital.
import type { Strategy } from '../types';
import { setMix } from '../worldq';
import { allOnCapital, holdRing, rememberAxes, weakestNeighbour } from './common';

const BREAKOUT_S = 25 * 60;

export const turtle: Strategy = {
  id: 'turtle',
  summary: 'fortify a ring ~400 m out (engineers / MG / AT mix); after 25 min all fronts attack the weakest neighbour capital',
  setup(ctx) {
    setMix(ctx, { infantry: 25, engineer: 18, mg: 18, at_gun: 18, mortar: 8, medium_tank: 4 }, { engineer: 10, mg: 12, at_gun: 12, mortar: 6 });
    rememberAxes(ctx);
    holdRing(ctx, 'fortify', 400);
  },
  tick(ctx) {
    const t = ctx.world.time;
    if (t < BREAKOUT_S) return;
    if (Math.floor(t - BREAKOUT_S) % 60 !== 0) return;
    if (t === BREAKOUT_S) setMix(ctx, { infantry: 35, medium_tank: 15, heavy_tank: 6, at_gun: 8, mortar: 6, engineer: 4 }, { medium_tank: 20, heavy_tank: 8 });
    const target = (ctx.state.target as number | undefined) ?? weakestNeighbour(ctx);
    const alive = target !== undefined && ctx.world.factions[target].alive ? target : weakestNeighbour(ctx);
    if (alive === undefined) return;
    ctx.state.target = alive;
    allOnCapital(ctx, alive);
  },
};
