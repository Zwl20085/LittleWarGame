// doctrine_builder / doctrine_blitz / doctrine_attrition / doctrine_maneuver (V30_SPEC §1, §12): the
// four 3.0 AI doctrines played by the challenger through the command API only. Production mix and
// caps come from the doctrine profile (rules.json `doctrines.profiles`, personality × production);
// every 5 s the doctrine's directive (sim/doctrineai.doctrineChoice: defence thresholds, the late /
// strike / battle offensive) is issued with setDirective when it changes; attrition also sends small
// raiding parties (unit orders) at the nearest enemy convoy or economic building, like econ_war.
import { personalityWeights } from '../../../src/sim/cityai';
import { doctrineChoice } from '../../../src/sim/doctrineai';
import { profileById, type DoctrineId } from '../../../src/sim/doctrines';
import { dist, type V2 } from '../../../src/sim/vec';
import type { Strategy, StrategyCtx } from '../types';
import { directive, setMix } from '../worldq';
import { centroid, groupIds, pick, setGroup } from './squad';

const THINK_S = 5;
/** attrition: raiding party size, cadence and the capital stand-off (m). */
const RAID_SIZE = 4;
const RAID_EVERY_S = 90;
const RAID_FIRST_S = 300;
const CAPITAL_AVOID_M = 450;
const RAIDERS: readonly string[] = ['recon', 'motor_inf', 'infantry'];

function mix(ctx: StrategyCtx, id: DoctrineId): void {
  const w = ctx.world;
  const p = profileById(w, id);
  if (!p) return;
  const base = personalityWeights(w, p.personality);
  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(base)) weights[k] = Math.round(v * (p.production[k] ?? 1) * 10) / 10;
  const caps: Record<string, number> = {};
  for (const [k, v] of Object.entries(w.data.rules.proposed_defaults.production_unit_caps)) caps[k] = Math.max(0, Math.round(v * (p.caps[k] ?? 1)));
  setMix(ctx, weights, caps);
}

/** Nearest enemy supply truck or economic building outside the capitals' stand-off. */
function raidTarget(ctx: StrategyCtx, from: V2): V2 | null {
  const w = ctx.world;
  let best: V2 | null = null;
  let bd = Infinity;
  const consider = (p: V2, owner: number): void => {
    if (owner < 0 || owner === ctx.me || !w.isHostile(ctx.me, owner) || dist(p, w.hqPos(owner)) < CAPITAL_AVOID_M) return;
    const d = dist(p, from);
    if (d < bd) { bd = d; best = p; }
  };
  for (const e of w.econ) if (!e.ruined && e.progress > 0) consider(e.pos, e.owner);
  for (const u of w.aliveUnits) if (u.hp > 0 && u.def.id === 'supply_truck') consider(u.pos, u.owner);
  return best;
}

function raid(ctx: StrategyCtx): void {
  const w = ctx.world;
  if (w.time < RAID_FIRST_S || Math.floor(w.time) % RAID_EVERY_S !== 0) return;
  let ids = groupIds(ctx, 'raid');
  if (ids.length < RAID_SIZE / 2) {
    ids = pick(ctx, RAIDERS, w.hqPos(ctx.me)).filter((u) => u.hp > u.def.maxHp * 0.7).slice(-RAID_SIZE).map((u) => u.id);
    setGroup(ctx, 'raid', ids);
  }
  const from = centroid(ctx, ids);
  const t = from ? raidTarget(ctx, from) : null;
  if (t && ids.length) ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...t } });
}

function make(id: DoctrineId, summary: string): Strategy {
  return {
    id: `doctrine_${id}`,
    summary,
    setup(ctx) { mix(ctx, id); },
    tick(ctx) {
      const w = ctx.world;
      if (id === 'attrition') raid(ctx);
      if (Math.floor(w.time) % THINK_S !== 0) return;
      const p = profileById(w, id);
      const f = w.factions[ctx.me];
      if (!p || !f.alive) return;
      const c = doctrineChoice(w, f, p);
      if (c.kind === 'offensive' && c.axis) {
        const target = w.factions.find((e) => e.alive && e.id !== ctx.me && dist(w.hqPos(e.id), c.axis!) < 1);
        if (target) ctx.markAttack(target.id);
      }
      directive(ctx, c.kind, c.axis ?? undefined);
    },
  };
}

export const doctrineBuilder = make('builder', 'doctrine builder: invest / occupy mix, defend or contract when outmatched, a late offensive on the weakest near capital');
export const doctrineBlitz = make('blitz', 'doctrine blitz: armour + motorized mix, one deep offensive on a capital at the force ratio, re-arm and retry');
export const doctrineAttrition = make('attrition', 'doctrine attrition: guns / works mix, fortify when outmatched, raiding parties on convoys and economic buildings');
export const doctrineManeuver = make('maneuver', 'doctrine maneuver: mobile main body, offensive on an isolated enemy front at 1.5:1');
