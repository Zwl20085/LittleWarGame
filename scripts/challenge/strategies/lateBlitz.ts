// late_blitz — Fortify (a line ~450 m out) with an armour-heavy mix until 15 min, then a general
// offensive on the nearest enemy capital, checked every 60 s.
import type { Strategy } from '../types';
import { enemiesByDistance, setMix } from '../worldq';
import { allOnCapital, holdRing } from './common';

const BLITZ_S = 15 * 60;

export const lateBlitz: Strategy = {
  id: 'late_blitz',
  summary: 'fortify ~450 m out with an armour-heavy mix until 15 min, then an offensive on the nearest capital',
  setup(ctx) {
    setMix(ctx, { infantry: 22, motor_inf: 8, light_tank: 10, medium_tank: 22, heavy_tank: 10, at_gun: 6, engineer: 4 }, { medium_tank: 24, heavy_tank: 12, light_tank: 12 });
    holdRing(ctx, 'fortify', 450);
  },
  tick(ctx) {
    const t = ctx.world.time;
    if (t < BLITZ_S || Math.floor(t - BLITZ_S) % 60 !== 0) return;
    const target = enemiesByDistance(ctx.world, ctx.me)[0];
    if (target !== undefined) allOnCapital(ctx, target);
  },
};
