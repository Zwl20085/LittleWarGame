// shadow_strike (V23_SPEC §1.1): a small detachment (4-10 squads, optionally a couple of light tanks)
// routes through ground the defender cannot currently see (its units' vision, planned at launch)
// and appears at the capital's defence ring. Run it in fog and in open information mode.
// The main army advances as usual; a new detachment is sent every time the last one is gone.
import { directive, enemiesByDistance, setMix } from '../worldq';
import type { Strategy } from '../types';
import { aliveCount, launchDetachment, squadsNearHome } from './detachment';
import { FOOT } from './squad';

const MIX = { infantry: 30, recon: 10, motor_inf: 18, light_tank: 12, medium_tank: 12, mg: 6, at_gun: 6, mortar: 6 };
const FIRST_LAUNCH_S = 600;
const RELAUNCH_COOLDOWN_S = 240;
const MIN_SQUADS = 4;
const MAX_SQUADS = 10;
const MAX_LIGHT_TANKS = 2;

export const shadowStrike: Strategy = {
  id: 'shadow_strike',
  summary: '4-10 squads (+2 light tanks) routed through ground the defender cannot see, appearing at the capital ring; relaunched when lost',
  setup(ctx) {
    setMix(ctx, MIX);
  },
  tick(ctx) {
    const w = ctx.world;
    directive(ctx, 'advance');
    if (w.time < FIRST_LAUNCH_S || aliveCount(ctx, 'shadow') > 0) return;
    if (w.time < ((ctx.state.nextAt as number | undefined) ?? 0)) return;
    const target = enemiesByDistance(w, ctx.me)[0];
    if (target === undefined) return;
    const foot = squadsNearHome(ctx, FOOT, MAX_SQUADS, new Set());
    if (foot.length < MIN_SQUADS) return;
    const tanks = squadsNearHome(ctx, ['light_tank'], MAX_LIGHT_TANKS, new Set());
    const r = launchDetachment(ctx, 'shadow', [...foot, ...tanks], target, [target]);
    ctx.state.nextAt = w.time + RELAUNCH_COOLDOWN_S;
    ctx.state.launches = ((ctx.state.launches as number | undefined) ?? 0) + 1;
    if (r) ctx.state.lastSeenShare = r.seenShare;
  },
};
