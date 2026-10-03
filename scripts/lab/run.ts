// Balance-lab single run: one seed, one data variant, headless, observed by the probe.
// The sim is imported dynamically from `srcRoot` so a run can target a frozen source
// snapshot (e.g. `git archive HEAD src`) while other work is in flight.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameData } from '../../src/data/types';
import type { MatchStats } from '../../src/sim/stats';
import type { World } from '../../src/sim/world';
import type { DataText } from './overrides';
import { createProbe, probeSample, probeSecond, slotOccupancy, type ProbeApi, type ProbeData } from './probe';

export interface RunSpec {
  readonly seed: number;
  readonly minutes: number;
  readonly mapId: string;
  readonly factions: number;
  readonly difficulty: string;
  readonly srcRoot: string;
  readonly data: DataText;
}

export interface RunResult {
  readonly seed: number;
  readonly simSeconds: number;
  readonly wallSeconds: number;
  readonly result: { winners: number[]; reason: string; minute: number } | null;
  readonly probe: ProbeData;
  readonly stats: MatchStats;
  /** Unit costs (P+M) for value metrics, from the variant's own data. */
  readonly unitValue: Record<string, number>;
}

export const SAMPLE_SECONDS = 30;

async function load(srcRoot: string, rel: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(resolve(srcRoot, rel)).href) as Promise<Record<string, unknown>>;
}

export async function runOne(spec: RunSpec): Promise<RunResult> {
  const loader = await load(spec.srcRoot, 'data/loader.ts');
  const sim = await load(spec.srcRoot, 'sim/sim.ts');
  const prod = await load(spec.srcRoot, 'sim/production.ts');
  const buildGameData = loader.buildGameData as (u: string, w: string, r: string) => GameData;
  const createMatch = sim.createMatch as (d: GameData, c: Record<string, unknown>) => { world: World };
  const step = sim.step as (m: { world: World }) => void;
  const api = prod as unknown as ProbeApi;

  const data = buildGameData(spec.data.units, spec.data.weapons, spec.data.rules);
  const t0 = performance.now();
  const match = createMatch(data, {
    mapId: spec.mapId, factions: spec.factions, infoMode: 'open', seed: spec.seed,
    difficulty: spec.difficulty, playerSlot: 0, spectate: true,
  });
  const w = match.world;
  const probe = createProbe(w);
  const owners = new Map<string, number>(w.objectives.map((o) => [o.id, o.owner]));
  const busy = w.factions.map(() => 0);
  let busyN = 0;
  const ticks = spec.minutes * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    step(match);
    w.fx.length = 0;
    if (w.tick % w.tickHz !== 0) continue;
    probeSecond(w, probe, api, owners);
    for (const f of w.factions) busy[f.id] += f.alive ? slotOccupancy(w, f, api) : 0;
    busyN++;
    if (w.tick % (SAMPLE_SECONDS * w.tickHz) === 0) {
      probeSample(w, probe, api, busy.map((b) => b / Math.max(1, busyN)));
      busy.fill(0);
      busyN = 0;
    }
  }
  const unitValue: Record<string, number> = {};
  for (const [id, d] of data.units) unitValue[id] = d.costP + d.costM;
  return {
    seed: spec.seed,
    simSeconds: w.time,
    wallSeconds: (performance.now() - t0) / 1000,
    result: w.result ? { winners: [...w.result.winners], reason: w.result.reason, minute: w.result.tick / w.tickHz / 60 } : null,
    probe,
    stats: w.stats,
    unitValue,
  };
}
