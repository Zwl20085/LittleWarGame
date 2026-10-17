// armour_raid (V23_SPEC §1.1): save up, then 20+ tanks and 10+ motorised infantry go for one enemy
// capital at 15 or 25 min. Variant `<15|25>-<direct|flank>`: straight down the road, or around the
// widest flank (a waypoint far off the road on the side with less hostile value), staging 1 000 m
// out and attacking once 70 % of the column has closed up.
import type { V2 } from '../../../src/sim/vec';
import { dist } from '../../../src/sim/vec';
import { flankWaypoint, ringPoint, sampleUnit } from '../route';
import type { Strategy, StrategyCtx } from '../types';
import { enemiesByDistance, hostileNear, setMix } from '../worldq';
import { holdRing } from './common';
import { groupIds, pick, sendRoute, setGroup, shareNear, TANKS } from './squad';

const MIX = { medium_tank: 40, heavy_tank: 18, light_tank: 8, motor_inf: 28, infantry: 4 };
const CAPS = { medium_tank: 40, heavy_tank: 24, light_tank: 16, motor_inf: 24, infantry: 20 };
const MIN_TANKS = 20;
const MIN_MOTOR = 10;
const WAIT_EXTRA_S = 300;
const STAGING_M = 1000;
const CLOSED_UP = 0.7;
const CLOSE_RADIUS_M = 350;
const STAGE_TIMEOUT_S = 420;
const REISSUE_S = 45;

interface Plan { readonly atS: number; readonly flank: boolean }

function plan(variant: string): Plan {
  const m = /^(15|25)-(direct|flank)$/.exec(variant);
  return m ? { atS: Number(m[1]) * 60, flank: m[2] === 'flank' } : { atS: 900, flank: false };
}

type Phase = 'save' | 'stage' | 'assault';

export const armourRaid: Strategy = {
  id: 'armour_raid',
  summary: 'saves up, then 20+ tanks + 10+ motorised infantry at one enemy capital at 15 / 25 min (variant: direct road or widest flank)',
  setup(ctx) {
    setMix(ctx, MIX, CAPS);
    ctx.state.phase = 'save' as Phase;
  },
  tick(ctx) {
    const p = plan(ctx.params.variant);
    const phase = ctx.state.phase as Phase;
    if (phase === 'save') return save(ctx, p);
    const ids = groupIds(ctx, 'raid');
    const target = ctx.state.target as number;
    if (!ids.length) { ctx.state.phase = 'save'; ctx.state.retryAt = ctx.world.time + 120; return; }
    if (!ctx.world.factions[target]?.alive) return retarget(ctx, ids);
    const hq = ctx.world.hqPos(target);
    if (phase === 'stage') {
      const staging = ctx.state.staging as V2;
      const waited = ctx.world.time - (ctx.state.launchedAt as number);
      if (shareNear(ctx, ids, staging, CLOSE_RADIUS_M) >= CLOSED_UP || waited > STAGE_TIMEOUT_S) {
        ctx.state.phase = 'assault' as Phase;
        ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...hq } });
        ctx.state.reissueAt = ctx.world.time + REISSUE_S;
      }
      return;
    }
    if (ctx.world.time >= (ctx.state.reissueAt as number)) {
      ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...hq } });
      ctx.state.reissueAt = ctx.world.time + REISSUE_S;
    }
  },
};

function save(ctx: StrategyCtx, p: Plan): void {
  const w = ctx.world;
  holdRing(ctx, 'defend', 350);
  if (w.time < p.atS || w.time < ((ctx.state.retryAt as number | undefined) ?? 0)) return;
  const home = w.hqPos(ctx.me);
  const tanks = pick(ctx, TANKS, home);
  const motor = pick(ctx, ['motor_inf'], home);
  const enough = tanks.length >= MIN_TANKS && motor.length >= MIN_MOTOR;
  if (!enough && w.time < p.atS + WAIT_EXTRA_S) return;
  const target = enemiesByDistance(w, ctx.me)[0];
  if (target === undefined || tanks.length + motor.length < 4) return;
  const group = [...tanks, ...motor];
  const hq = w.hqPos(target);
  let staging = ringPoint(home, hq, STAGING_M);
  const points: V2[] = [];
  if (p.flank) {
    const sample = sampleUnit(w, ctx.me, TANKS) ?? group[0];
    const fl = flankWaypoint(w, sample, home, hq, Math.max(900, dist(home, hq) * 0.5), (q) => hostileNear(w, ctx.me, q, 500));
    if (fl) { points.push(fl); staging = ringPoint(fl, hq, STAGING_M); }
  }
  points.push(staging);
  setGroup(ctx, 'raid', group.map((u) => u.id));
  ctx.state.target = target;
  ctx.state.staging = staging;
  ctx.state.launchedAt = w.time;
  ctx.state.phase = 'stage' as Phase;
  ctx.state.launchTanks = tanks.length;
  ctx.state.launchMotor = motor.length;
  ctx.markAttack(target);
  sendRoute(ctx, group.map((u) => u.id), points, null);
}

/** The capital fell: go on to the next nearest, straight at it. */
function retarget(ctx: StrategyCtx, ids: number[]): void {
  const next = enemiesByDistance(ctx.world, ctx.me)[0];
  if (next === undefined) return;
  ctx.state.target = next;
  ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...ctx.world.hqPos(next) } });
}
