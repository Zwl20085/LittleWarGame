// rush — all-in capital rush (the user's "let all units attack the capital, then it wins").
// From t = 0 the mix is infantry + tanks only; at `rushAt` the directive is a general offensive with
// the nearest enemy capital as the axis (checked every 60 s, moved on once it falls); it never defends.
import type { Strategy } from '../types';
import { enemiesByDistance, setMix } from '../worldq';
import { allOnCapital } from './common';

export const RUSH_MIX = { infantry: 40, motor_inf: 8, light_tank: 12, medium_tank: 20, heavy_tank: 8 };
export const RUSH_CAPS = { infantry: 60, motor_inf: 16, light_tank: 16, medium_tank: 24, heavy_tank: 12 };

export const rush: Strategy = {
  id: 'rush',
  summary: 'infantry + tanks only; at rushAt (default 5 min) a general offensive on the nearest enemy capital, checked every 60 s, never defends',
  setup(ctx) {
    setMix(ctx, RUSH_MIX, RUSH_CAPS);
  },
  tick(ctx) {
    const t = ctx.world.time;
    if (t < ctx.params.rushAt) return;
    const since = t - ctx.params.rushAt;
    if (Math.floor(since) % 60 !== 0) return;
    const target = enemiesByDistance(ctx.world, ctx.me)[0];
    if (target === undefined) return;
    allOnCapital(ctx, target);
  },
};
