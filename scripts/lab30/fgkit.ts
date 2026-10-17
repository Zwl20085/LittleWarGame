// Tiny shared runner for the WP-F/G lab30 suites (defence.ts, economy.ts): data with `--set`
// overrides, a mulberry RNG, child-process fan-out and a Markdown writer. Kept local so it does
// not collide with scripts/lab30/common.ts (WP-I) — the lead may fold it in on merge.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import type { GameData } from '../../src/data/types';
import { applyOverrides, parseOverride, type DataText } from '../lab/overrides';

export const OUT_DIR = 'media/stats/lab30';

const BASE: DataText = {
  units: readFileSync('docs/data/units.csv', 'utf8'),
  weapons: readFileSync('docs/data/weapons.csv', 'utf8'),
  rules: readFileSync('docs/data/rules.json', 'utf8'),
};

/** Game data with `path=value` overrides (scripts/lab/overrides.ts syntax). */
export function labData(overrides: readonly string[] = []): GameData {
  const t = applyOverrides(BASE, overrides.map(parseOverride));
  return buildGameData(t.units, t.weapons, t.rules);
}

export function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run `tasks` in up to `jobs` child processes of `script` (each child gets its task in LAB_TASK and
 * prints one JSON line prefixed `@@`). Returns the parsed results in task order.
 */
export async function fanOut<T, R>(script: string, tasks: readonly T[], jobs: number): Promise<R[]> {
  const out: R[] = new Array(tasks.length);
  let next = 0;
  const runOne = (i: number): Promise<void> => new Promise((res, rej) => {
    // npx tsx (node 18 cannot --import tsx here); the task travels in the environment.
    const child = spawn('npx', ['tsx', script], { shell: true, env: { ...process.env, LAB_TASK: JSON.stringify(tasks[i]) }, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => { buf += d.toString(); });
    child.on('exit', (code) => {
      const line = buf.split('\n').find((l) => l.startsWith('@@'));
      if (code !== 0 || !line) return rej(new Error(`task ${i} failed (exit ${code}): ${buf.slice(-400)}`));
      out[i] = JSON.parse(line.slice(2)) as R;
      res();
    });
  });
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await runOne(next++);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, tasks.length)) }, worker));
  return out;
}

/** Child side of fanOut: the task passed by the parent, or null when running as the parent. */
export function childTask<T>(): T | null {
  const t = process.env.LAB_TASK;
  return t ? (JSON.parse(t) as T) : null;
}

export function reply<R>(r: R): void {
  process.stdout.write(`@@${JSON.stringify(r)}\n`);
}

export function writeReport(name: string, md: string, json: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${OUT_DIR}/${name}-${stamp}`;
  writeFileSync(`${base}.md`, md);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  return base;
}
