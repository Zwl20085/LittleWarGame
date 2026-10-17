// econ_war: raid every enemy economic building (workshops / zones) and supply convoy with motorised
// groups; the rest of the army defends. Every 30 s each raiding group of ~6 gets the nearest unclaimed
// target (greedy), attack-moves onto it and is re-tasked once the target is ruined / dead.
import type { V2 } from '../../../src/sim/vec';
import { dist } from '../../../src/sim/vec';
import type { Strategy, StrategyCtx } from '../types';
import { directive, setMix } from '../worldq';
import { centroid, groupIds, MOTORIZED, pick, setGroup } from './squad';

const MIX = { motor_inf: 30, light_tank: 26, recon: 14, infantry: 10, medium_tank: 4 };
const CAPS = { motor_inf: 30, light_tank: 24, recon: 12 };
const GROUP_SIZE = 6;
const MAX_GROUPS = 5;
const FIRST_RAID_S = 420;
const RETASK_S = 30;
const CAPITAL_AVOID_M = 450;

interface Target { readonly p: V2; readonly key: string }

function targets(ctx: StrategyCtx): Target[] {
  const w = ctx.world;
  const out: Target[] = [];
  for (const e of w.econ) {
    if (e.ruined || e.owner < 0 || e.owner === ctx.me || !w.isHostile(ctx.me, e.owner) || e.progress <= 0) continue;
    if (dist(e.pos, w.hqPos(e.owner)) < CAPITAL_AVOID_M) continue;
    out.push({ p: e.pos, key: `e${e.id}` });
  }
  for (const u of w.units.values()) {
    if (u.hp <= 0 || u.owner === ctx.me || !w.isHostile(ctx.me, u.owner) || u.def.id !== 'supply_truck') continue;
    out.push({ p: u.pos, key: `t${u.id}` });
  }
  return out;
}

export const econWar: Strategy = {
  id: 'econ_war',
  summary: 'motorised raid groups hunt every enemy economic building and convoy; the rest of the army defends',
  setup(ctx) {
    setMix(ctx, MIX, CAPS);
  },
  tick(ctx) {
    const w = ctx.world;
    directive(ctx, 'defend');
    if (w.time < FIRST_RAID_S || Math.floor(w.time) % RETASK_S !== 0) return;
    const free = new Set<number>();
    const raiders = pick(ctx, MOTORIZED, w.hqPos(ctx.me));
    raiders.forEach((u) => free.add(u.id));
    const tg = targets(ctx);
    if (!tg.length) return;
    const taken = new Set<string>();
    const nGroups = Math.min(MAX_GROUPS, Math.floor(raiders.length / GROUP_SIZE));
    for (let g = 0; g < nGroups; g++) {
      const name = `raid${g}`;
      let ids = groupIds(ctx, name);
      const keyNow = ctx.state[`${name}:key`] as string | undefined;
      const still = keyNow !== undefined && tg.some((t) => t.key === keyNow) && !taken.has(keyNow);
      if (ids.length < GROUP_SIZE / 2 || !still) {
        const members = raiders.filter((u) => !isInOtherGroup(ctx, u.id, name)).slice(0, GROUP_SIZE);
        ids = members.map((u) => u.id);
        setGroup(ctx, name, ids);
        const c = centroid(ctx, ids) ?? w.hqPos(ctx.me);
        const best = tg.filter((t) => !taken.has(t.key)).sort((a, b) => dist(a.p, c) - dist(b.p, c))[0];
        if (!best || !ids.length) continue;
        ctx.state[`${name}:key`] = best.key;
        taken.add(best.key);
        ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...best.p } });
      } else if (keyNow) taken.add(keyNow);
    }
  },
};

function isInOtherGroup(ctx: StrategyCtx, id: number, except: string): boolean {
  for (let g = 0; g < MAX_GROUPS; g++) {
    const name = `raid${g}`;
    if (name !== except && groupIds(ctx, name).includes(id)) return true;
  }
  return false;
}
