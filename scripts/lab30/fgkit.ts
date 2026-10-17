// Shared runner pieces unique to the WP-F/G lab30 suites (defence.ts, economy.ts): the `--name value`
// reader, a mulberry RNG and the child-process fan-out (LAB_TASK / `@@` line protocol). Data loading
// and the report writer are common.ts's.
import { spawn } from 'node:child_process';
import type { GameData } from '../../src/data/types';
import { createMatch } from '../../src/sim/sim';
import { Ground } from '../../src/sim/terrain';
import { dist, type V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import { loadData, writeReport as commonWriteReport } from './common';

export const labData = (overrides: readonly string[] = []): GameData => loadData(overrides);

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

/** Argument order of the WP-F/G suites (name, markdown, json) over common.writeReport. */
export const writeReport = (name: string, md: string, json: unknown): string => commonWriteReport(name, json, md);

/** An open, gentle corridor `len` m long (no water, forest, town, buildings), at least 300 m from any capital. */
export function findSite(w: World, rand: () => number, len: number): { def: V2; dir: V2 } | null {
  const t = w.terrain;
  for (let tries = 0; tries < 4000; tries++) {
    const p = { x: 300 + rand() * (t.width - 600), z: 300 + rand() * (t.depth - 600) };
    if (w.factions.some((f) => dist(w.hqPos(f.id), p) < 350)) continue;
    const a = rand() * Math.PI * 2;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    let ok = true;
    let steep = 0;
    let n = 0;
    for (let s = -60; s <= len + 40 && ok; s += 20) {
      for (let l = -60; l <= 60 && ok; l += 20) {
        const x = p.x + dir.x * s - dir.z * l;
        const z = p.z + dir.z * s + dir.x * l;
        if (!t.inBounds(x, z)) { ok = false; break; }
        const g = t.groundAt(x, z);
        if (g === Ground.Water || g === Ground.Ford || g === Ground.Forest || g === Ground.Town || t.buildingH(x, z) !== 0) ok = false;
        n++;
        if (t.slopeAt(x, z) > 14) steep++;
      }
    }
    if (ok && steep <= n * 0.1) return { def: p, dir };
  }
  return null;
}

/** A 2-faction map with a test corridor: the seed's map, else the next few seeds' (same trial → same map). */
export function siteMatch(data: GameData, seed: number, len: number): { m: ReturnType<typeof createMatch>; site: { def: V2; dir: V2 } } | null {
  for (let k = 0; k < 6; k++) {
    const s = seed + k * 53;
    const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: s, difficulty: 'normal', playerSlot: 0, spectate: false });
    const site = findSite(m.world, mulberry(s * 977 + 13), len);
    if (site) return { m, site };
  }
  return null;
}
