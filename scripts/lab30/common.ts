// 3.0 lab runner helpers (V30_SPEC §0: every new system ships a suite in scripts/lab30/).
// Shared by every suite: argument parsing, data loading with `--set` overrides (same syntax as
// scripts/lab.ts, scripts/lab/overrides.ts), headless match creation and stepping, parallel runs
// in forked workers, and the JSON + Markdown report in media/stats/lab30/.
//
// A suite module typically does:
//   const args = parseArgs(process.argv.slice(2));
//   if (isWorker()) return workerLoop(runTask);           // child side
//   const results = await runParallel(import.meta.url, tasks, jobs);
//   writeReport('transport', json, markdown);
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameData } from '../../src/data/loader';
import type { GameData } from '../../src/data/types';
import { createMatch, step, type Match } from '../../src/sim/sim';
import type { MatchConfig } from '../../src/sim/types';
import { applyOverrides, envOverrides, parseOverride, type DataText } from '../lab/overrides';

export type Args = Record<string, string[]>;

/** `--key value` pairs (repeatable); a flag without a value reads "true". */
export function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    (out[key] ??= []).push(val);
  }
  return out;
}

export const argStr = (a: Args, k: string, d: string): string => a[k]?.[a[k].length - 1] ?? d;
export const argNum = (a: Args, k: string, d: number): number => Number(argStr(a, k, String(d)));
export const argList = (a: Args, k: string, d: string): number[] => argStr(a, k, d).split(',').map(Number);
export const argSets = (a: Args): string[] => a.set ?? [];

/** Shipped data text (docs/data). */
export function dataText(dir = 'docs/data'): DataText {
  return {
    units: readFileSync(join(dir, 'units.csv'), 'utf8'),
    weapons: readFileSync(join(dir, 'weapons.csv'), 'utf8'),
    rules: readFileSync(join(dir, 'rules.json'), 'utf8'),
  };
}

/** Game data with `--set` overrides applied (e.g. `transport.enabled=false`). */
export function loadData(sets: readonly string[] = [], dir = 'docs/data'): GameData {
  const t = applyOverrides(dataText(dir), [...envOverrides(), ...sets.map(parseOverride)]);
  return buildGameData(t.units, t.weapons, t.rules);
}

export interface LabMatchSpec {
  readonly seed: number;
  readonly factions?: number;
  readonly size?: 'medium' | 'large';
  readonly mapId?: MatchConfig['mapId'];
  /** Information mode (default open). */
  readonly infoMode?: MatchConfig['infoMode'];
}

/** Headless spectator match (open information unless `infoMode`, normal difficulty). */
export function labMatch(data: GameData, spec: LabMatchSpec): Match {
  return createMatch(data, {
    mapId: spec.mapId ?? 'generated', mapSize: spec.size ?? 'medium', factions: spec.factions ?? 4, infoMode: spec.infoMode ?? 'open',
    seed: spec.seed, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
}

export interface StepStats {
  ticks: number;
  simMs: number;
}

/**
 * Step a match for `seconds` (or until it ends), clearing the fx queue like every lab; `onSecond`
 * runs after each full game second, `stop` ends early. Returns the sim cost.
 */
export function runFor(match: Match, seconds: number, onSecond?: (sec: number) => void, stop?: () => boolean): StepStats {
  const w = match.world;
  const stats: StepStats = { ticks: 0, simMs: 0 };
  const end = w.tick + seconds * w.tickHz;
  while (w.tick < end && !w.result) {
    const t0 = performance.now();
    step(match);
    stats.simMs += performance.now() - t0;
    stats.ticks++;
    w.fx.length = 0;
    if (w.tick % w.tickHz === 0) {
      onSecond?.(w.time);
      if (stop?.()) break;
    }
  }
  return stats;
}

// ------------------------------------------------------------------ parallel runs

export const isWorker = (): boolean => process.argv.includes('--worker');

/** Child side: run each task message with `fn` and send the result back. */
export function workerLoop<T, R>(fn: (task: T) => R | Promise<R>): void {
  process.on('message', (task: T) => {
    Promise.resolve()
      .then(() => fn(task))
      .then((r) => process.send?.({ ok: true, r }, () => process.exit(0)))
      .catch((e: unknown) => process.send?.({ ok: false, e: e instanceof Error ? e.stack ?? e.message : String(e) }, () => process.exit(1)));
  });
}

/** Run tasks in forked copies of `moduleUrl` (with `--worker`), at most `jobs` at a time, results in task order. */
export async function runParallel<T, R>(moduleUrl: string, tasks: readonly T[], jobs = Math.max(1, Math.min(4, cpus().length - 1))): Promise<R[]> {
  const out: R[] = new Array(tasks.length);
  let next = 0;
  const one = (i: number): Promise<void> => new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(moduleUrl), ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.on('message', (m: { ok: boolean; r?: R; e?: string }) => {
      if (m.ok) { out[i] = m.r as R; resolve(); } else reject(new Error(m.e));
    });
    child.on('exit', (code) => { if (code !== 0 && out[i] === undefined) reject(new Error(`worker for task ${i} exited with ${code}`)); });
    child.send(tasks[i] as object);
  });
  const lanes = Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) await one(next++);
  });
  await Promise.all(lanes);
  return out;
}

// ------------------------------------------------------------------ report

/** Markdown table. */
export function mdTable(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const fmt = (v: string | number): string => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v);
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(fmt).join(' | ')} |`)].join('\n');
}

export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Write media/stats/lab30/<suite>-<timestamp>.{json,md}; returns the base path. */
export function writeReport(suite: string, json: unknown, markdown: string): string {
  const dir = 'media/stats/lab30';
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = join(dir, `${suite}-${ts}`);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  writeFileSync(`${base}.md`, markdown);
  return base;
}
