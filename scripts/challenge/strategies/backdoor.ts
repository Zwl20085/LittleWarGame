// backdoor (V23_SPEC §1.1, 偷家): the main army pins the front with a loud offensive on the nearest
// enemy settlement while a detachment of at most 15 % of the army's value goes for the capital of
// the same enemy through ground none of the hostile factions can see. The cheap-win probe.
import { dist } from '../../../src/sim/vec';
import type { Strategy, StrategyCtx } from '../types';
import { combatUnit, directive, enemiesByDistance, isCapital, setMix, valueOf } from '../worldq';
import { aliveCount, launchDetachment } from './detachment';
import { CAPTURERS, ownValue, pick } from './squad';

const MIX = { infantry: 35, motor_inf: 15, medium_tank: 16, light_tank: 8, mg: 5, at_gun: 8, mortar: 5, recon: 4 };
const FIRST_LAUNCH_S = 600;
const RELAUNCH_COOLDOWN_S = 180;
const MAX_SHARE = 0.15;
const MIN_SQUADS = 2;
const PIN_CHECK_S = 60;

/** The enemy's non-capital settlement nearest to our capital (the loud axis), else its capital. */
function pinAxis(ctx: StrategyCtx, enemy: number): { x: number; z: number } {
  const w = ctx.world;
  const home = w.hqPos(ctx.me);
  let best = w.hqPos(enemy);
  let bd = Infinity;
  for (const o of w.objectives) {
    if (o.owner !== enemy || (o.kind !== 'village' && o.kind !== 'town') || isCapital(w, o)) continue;
    const d = dist(home, o.pos);
    if (d < bd) { bd = d; best = o.pos; }
  }
  return best;
}

export const backdoor: Strategy = {
  id: 'backdoor',
  summary: 'main army pins the front (offensive on the nearest settlement); <= 15 % of the army value slips unseen to the capital',
  setup(ctx) {
    setMix(ctx, MIX);
  },
  tick(ctx) {
    const w = ctx.world;
    const target = enemiesByDistance(w, ctx.me)[0];
    if (target === undefined) return;
    if (Math.floor(w.time) % PIN_CHECK_S === 0) directive(ctx, 'offensive', pinAxis(ctx, target));
    if (w.time < FIRST_LAUNCH_S || aliveCount(ctx, 'backdoor') > 0) return;
    if (w.time < ((ctx.state.nextAt as number | undefined) ?? 0)) return;
    const budget = MAX_SHARE * ownValue(ctx);
    const squads = [];
    let spent = 0;
    for (const u of pick(ctx, CAPTURERS, w.hqPos(ctx.me))) {
      if (!combatUnit(u) || spent + valueOf(u) > budget) continue;
      squads.push(u);
      spent += valueOf(u);
    }
    if (squads.length < MIN_SQUADS) return;
    const hostile = w.factions.filter((f) => f.alive && f.id !== ctx.me && w.isHostile(ctx.me, f.id)).map((f) => f.id);
    launchDetachment(ctx, 'backdoor', squads, target, hostile);
    ctx.state.nextAt = w.time + RELAUNCH_COOLDOWN_S;
    ctx.state.lastShare = spent / Math.max(1, ownValue(ctx));
  },
};
