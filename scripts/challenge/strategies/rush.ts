// rush — all-in capital rush (the user's "let all units attack the capital, then it wins").
// From t = 0 the mix is infantry + tanks only; at `rushAt` every front gets `attack` on the
// nearest enemy capital (main front = the first), re-issued every 60 s; it never defends.
import type { Strategy } from '../types';
import { enemiesByDistance, frontIds, orderAll, setMix } from '../worldq';

export const RUSH_MIX = { infantry: 40, motor_inf: 8, light_tank: 12, medium_tank: 20, heavy_tank: 8 };
export const RUSH_CAPS = { infantry: 60, motor_inf: 16, light_tank: 16, medium_tank: 24, heavy_tank: 12 };

export const rush: Strategy = {
  id: 'rush',
  summary: 'infantry + tanks only; at rushAt (default 5 min) every front attacks the nearest enemy capital, re-issued every 60 s, never defends',
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
    ctx.markAttack(target);
    orderAll(ctx, 'attack', ctx.world.hqPos(target));
    const ids = frontIds(ctx);
    if (ids.length > 0) ctx.issue({ type: 'setMainFront', frontId: ids[0] });
  },
};
