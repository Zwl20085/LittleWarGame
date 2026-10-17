// 3.0 lab runner helpers (V30_SPEC §0, §2): match creation from a (possibly frozen) source tree,
// stepping with a per-second hook, child-process jobs and the JSON + Markdown report writer.
// Kept small and plain so other lab30 suites can reuse it.
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GameData } from '../../src/data/types';
import type { World } from '../../src/sim/world';

export const OUT_DIR = 'media/stats/lab30';

/** One headless match of a lab suite. `src` / `data` may point at a frozen tree (A/B "before"). */
export interface MatchSpec {
  readonly seed: number;
  readonly minutes: number;
  readonly mapSize: 'medium' | 'large';
  readonly factions: number;
  readonly src: string;
  readonly data: string;
  /** Extra MatchConfig fields (e.g. `doctrines`). */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface LabMatch {
  readonly world: World;
  /** One 20 Hz tick (clears the fx queue as every lab does). */
  step(): void;
}

/** `--key value` options, `--flag` switches. */
export interface LabArgs {
  str(k: string, d: string): string;
  num(k: string, d: number): number;
  nums(k: string, d: string): number[];
  has(k: string): boolean;
}

export function parseArgs(argv: readonly string[]): LabArgs {
  const at = (k: string): number => argv.indexOf(`--${k}`);
  const str = (k: string, d: string): string => (at(k) >= 0 && at(k) + 1 < argv.length ? argv[at(k) + 1] : d);
  return {
    str,
    num: (k, d) => Number(str(k, String(d))),
    nums: (k, d) => str(k, d).split(',').filter(Boolean).map(Number),
    has: (k) => at(k) >= 0,
  };
}

/** Build a match from `spec.src` (sim) and `spec.data` (csv + rules) — spectated 4-FFA style, open info. */
export async function createLabMatch(spec: MatchSpec): Promise<LabMatch> {
  const imp = (rel: string): Promise<Record<string, unknown>> => import(pathToFileURL(resolve(spec.src, rel)).href) as Promise<Record<string, unknown>>;
  const loader = await imp('data/loader.ts');
  const sim = await imp('sim/sim.ts');
  const build = loader.buildGameData as (u: string, w: string, r: string) => GameData;
  const create = sim.createMatch as (d: GameData, c: Record<string, unknown>) => { world: World };
  const stepFn = sim.step as (m: { world: World }) => void;
  const rd = (f: string): string => readFileSync(resolve(spec.data, f), 'utf8');
  const data = build(rd('units.csv'), rd('weapons.csv'), rd('rules.json'));
  const m = create(data, {
    mapId: 'generated', mapSize: spec.mapSize, factions: spec.factions, infoMode: 'open', seed: spec.seed,
    difficulty: 'normal', playerSlot: 0, spectate: true, ...(spec.config ?? {}),
  });
  return { world: m.world, step: () => { stepFn(m); m.world.fx.length = 0; } };
}

/** Run until `minutes` or a result; `onSecond` after every whole game second. */
export function runMatch(m: LabMatch, minutes: number, onSecond: (w: World) => void): void {
  const w = m.world;
  const ticks = minutes * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    m.step();
    if (w.tick % w.tickHz === 0) onSecond(w);
  }
}

/**
 * Child-process pool: the suite script calls `serveWorker(fn)` when started with `--worker`, and
 * `runJobs(scriptPath, specs, jobs)` in the parent. Results keep the order of `specs`.
 */
export function serveWorker<S, R>(fn: (spec: S) => Promise<R>): void {
  process.on('message', (spec: S) => {
    fn(spec).then((r) => process.send?.({ ok: true, r }, () => process.exit(0)))
      .catch((e: unknown) => process.send?.({ ok: false, err: e instanceof Error ? e.stack : String(e) }, () => process.exit(1)));
  });
}

function child<S, R>(script: string, spec: S): Promise<R> {
  return new Promise((res, rej) => {
    const c = fork(script, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let done = false;
    c.on('message', (msg: { ok: boolean; r?: R; err?: string }) => { done = true; if (msg.ok && msg.r !== undefined) res(msg.r); else rej(new Error(msg.err)); });
    c.on('exit', (code) => { if (!done) rej(new Error(`worker exited ${code}`)); });
    c.send(spec as object);
  });
}

export async function runJobs<S, R>(script: string, specs: readonly S[], jobs: number, label: (s: S) => string): Promise<R[]> {
  const out: R[] = new Array(specs.length);
  const t0 = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, specs.length)) }, async () => {
    while (next < specs.length) {
      const i = next++;
      out[i] = await child<S, R>(script, specs[i]);
      console.log(`  ${label(specs[i])} done (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }));
  return out;
}

/** Local timestamp for report names: 20261016-2350. */
export function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Write `<OUT_DIR>/<name>.md` and `.json`; returns the two paths. */
export function writeReport(name: string, md: string, json: unknown): { md: string; json: string } {
  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${OUT_DIR}/${name}`;
  writeFileSync(`${base}.md`, md);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 1));
  return { md: `${base}.md`, json: `${base}.json` };
}

/** Markdown table. */
export function mdTable(head: readonly string[], rows: readonly (readonly (string | number)[])[], align?: readonly ('l' | 'r')[]): string {
  const a = head.map((_, i) => (align?.[i] === 'r' ? '---:' : '---'));
  return [`| ${head.join(' | ')} |`, `|${a.join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}
