// Challenge lab: one match in this process — the challenger is driven by a scripted strategy
// through CommandBus (issue + flush every tick, exactly like the UI / sim worker), the other
// factions are the normal AI. Deterministic per seed: strategies read world state only.
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { applyOverrides, envOverrides } from '../lab/overrides';
import type { GameData } from '../../src/data/types';
import { CommandBus, type Command } from '../../src/sim/commands';
import { createMatch, step } from '../../src/sim/sim';
import { ROUND7_AB } from '../../src/sim/homeguard';
import { INFILTRATION_AB } from '../../src/sim/zoc';

// A/B: INFIL_OFF=1 switches the 3.0 zone of control / pickets / rear screen off in this process.
if (process.env.INFIL_OFF) INFILTRATION_AB.on = false;
import { DOCTRINE_AB } from '../../src/sim/doctrines';

// A/B: R7_OFF=hqPoint,eta,assault,counter (or "all"); R7_ON=alarm turns the rejected narrow-alarm recall gate on turns round-7 AI fixes off in this process (docs/CHALLENGE_LAB.md).
const r7off = (process.env.R7_OFF ?? '').split(',').filter(Boolean);
for (const k of Object.keys(ROUND7_AB) as (keyof typeof ROUND7_AB)[]) if (r7off.includes(k) || r7off.includes('all')) ROUND7_AB[k] = false;
for (const k of (process.env.R7_ON ?? '').split(',').filter(Boolean)) if (k in ROUND7_AB) ROUND7_AB[k as keyof typeof ROUND7_AB] = true;
// A/B: DOCTRINES=0 runs the AI without its 3.0 doctrines (doctrines.ts).
if (process.env.DOCTRINES === '0') DOCTRINE_AB.on = false;
import { createExpCollector } from './expLog';
import { createSampler } from './metrics';
import { strategyById } from './strategies';
import type { ChallengeParams, ChallengeReport, StrategyCtx } from './types';

export interface ChallengeOptions {
  readonly strategy: string;
  readonly seed: number;
  readonly minutes: number;
  readonly challenger?: number;
  readonly params?: Partial<ChallengeParams>;
  readonly mapId?: 'generated';
  /** 'fog': the AI factions only know what they see (the challenger stays omniscient: it reads the world). */
  readonly infoMode?: 'open' | 'fog';
  readonly mapSize?: 'medium' | 'large';
  readonly data?: GameData;
}

export const DEFAULT_PARAMS: ChallengeParams = { rushAt: 300, variant: '' };

export function loadDataFromDisk(): GameData {
  // LAB_SET env: rules / csv overrides for tuning A/B runs.
  const t = applyOverrides({ units: readFileSync('docs/data/units.csv', 'utf8'), weapons: readFileSync('docs/data/weapons.csv', 'utf8'), rules: readFileSync('docs/data/rules.json', 'utf8') }, envOverrides());
  return buildGameData(t.units, t.weapons, t.rules);
}

export function runChallengeMatch(opt: ChallengeOptions): ChallengeReport {
  const me = opt.challenger ?? 0;
  const params: ChallengeParams = { ...DEFAULT_PARAMS, ...opt.params };
  const strategy = strategyById(opt.strategy);
  const match = createMatch(opt.data ?? loadDataFromDisk(), {
    mapId: opt.mapId ?? 'generated', mapSize: opt.mapSize ?? 'medium', factions: 4, infoMode: opt.infoMode ?? 'open', seed: opt.seed, difficulty: 'normal', playerSlot: me, spectate: !!strategy.aiOnly,
  });
  const w = match.world;
  if (!strategy.aiOnly && !w.factions[me]?.isPlayer) throw new Error(`challenger slot ${me} is not a player faction`);
  const bus = new CommandBus();
  let issued = 0;
  const failed: Record<string, number> = {};
  bus.onResult = (env, out) => {
    if (out.ok) return;
    const k = `${env.cmd.type}:${out.reason}`;
    failed[k] = (failed[k] ?? 0) + 1;
  };
  let attackS = -1;
  let attackTarget = -1;
  const ctx: StrategyCtx = {
    match, world: w, me, params, state: {},
    issue(cmd: Command) {
      issued++;
      bus.issue(match, me, cmd);
    },
    markAttack(target: number) {
      if (attackS >= 0) return;
      attackS = Math.round(w.time);
      attackTarget = target;
    },
  };
  const sampler = createSampler(w, me);
  const exp = createExpCollector(w);
  const t0 = performance.now();
  strategy.setup(ctx);
  const ticks = Math.round(opt.minutes * 60 * w.tickHz);
  for (let i = 0; i < ticks && !w.result; i++) {
    if (w.tick % w.tickHz === 0) {
      if (!strategy.aiOnly && w.factions[me].alive) strategy.tick(ctx);
      sampler.second(attackS);
      exp.second();
    }
    bus.flush(match);
    step(match);
    w.fx.length = 0;
    sampler.afterTick();
  }
  const nearestAi = sampler.ai.reduce((a, b) => (b.capitalDistM < a.capitalDistM ? b : a)).id;
  const lostOf = (f: number): number => Object.values(w.stats.byType[f] ?? {}).reduce((a, r) => a + r.lost, 0);
  const builtOf = (f: number): number => Object.values(w.stats.byType[f] ?? {}).reduce((a, r) => a + r.built, 0);
  // Counter-attacks also show up as ops on `hq:<me>` in the battle log (fronts may have retargeted since).
  for (const a of sampler.ai) {
    a.unitsLost = lostOf(a.id);
    const op = w.battle.ops.find((o) => o.f === a.id && o.target === `hq:${me}`);
    if (op && (a.counterAttackS < 0 || op.t0 < a.counterAttackS)) a.counterAttackS = Math.round(op.t0);
  }
  const own = sampler.falls.find((x) => x.capital === me);
  return {
    strategy: strategy.id, infoMode: opt.infoMode ?? 'open', mapSize: opt.mapSize ?? 'medium', variant: params.variant, experience: exp.finish(!!w.result), r7off: r7off.join(','), seed: opt.seed, challenger: me, minutes: Math.round((w.time / 60) * 10) / 10,
    wallS: Math.round((performance.now() - t0) / 100) / 10,
    attackS, attackTarget, nearestAi,
    captures: sampler.falls.filter((x) => x.by === me),
    ownLostS: own?.t ?? -1, ownLostTo: own?.by ?? -1,
    allFalls: sampler.falls, ai: sampler.ai,
    challengerUnitsLost: lostOf(me), challengerUnitsBuilt: builtOf(me),
    held: sampler.held,
    result: w.result ? { winners: [...w.result.winners], reason: w.result.reason, t: Math.round(w.result.tick / w.tickHz) } : null,
    commandsIssued: issued, commandsFailed: failed,
    // 3.0: the challenger's fronts' answers to its directives (compliance.ts; declines / obeyed / forced).
    responses: w.battle.responses.filter((x) => x.f === me).map((x) => ({ result: x.result, t: Math.round(x.t), delay: x.delay, distM: x.distM, reason: x.reason })),
    captureSeconds: w.data.rules.victory.command_capture_seconds, captureRadiusM: w.data.rules.victory.command_radius_m,
  };
}
