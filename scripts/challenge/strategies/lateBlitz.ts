// late_blitz — defend / fortify near home with an armour-heavy mix until 15 min, then every
// front attacks the nearest enemy capital (main front set), re-issued every 60 s.
import type { Strategy } from '../types';
import { enemiesByDistance, setMix } from '../worldq';
import { allOnCapital, holdRing, rememberAxes } from './common';

const BLITZ_S = 15 * 60;

export const lateBlitz: Strategy = {
  id: 'late_blitz',
  summary: 'fortify ~450 m out with an armour-heavy mix until 15 min, then all fronts attack the nearest capital (setMainFront)',
  setup(ctx) {
    setMix(ctx, { infantry: 22, motor_inf: 8, light_tank: 10, medium_tank: 22, heavy_tank: 10, at_gun: 6, engineer: 4 }, { medium_tank: 24, heavy_tank: 12, light_tank: 12 });
    rememberAxes(ctx);
    holdRing(ctx, 'fortify', 450);
  },
  tick(ctx) {
    const t = ctx.world.time;
    if (t < BLITZ_S || Math.floor(t - BLITZ_S) % 60 !== 0) return;
    const target = enemiesByDistance(ctx.world, ctx.me)[0];
    if (target !== undefined) allOnCapital(ctx, target);
  },
};
