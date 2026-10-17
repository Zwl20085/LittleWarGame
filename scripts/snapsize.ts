// Worker → main snapshot size: runs a headless AI war, makes a snapshot every 3 ticks (≈ the
// 8× rate) and reports the structured-clone size (v8.serialize) per field, averaged per window.
//
//   SIZE=large npx tsx scripts/snapsize.ts [seconds=1200] [seed=7] [window=600]
import { readFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import { makeSnapshot, newCursor } from '../src/sim/snapshot';

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const secs = Number(process.argv[2] ?? 1200);
const seed = Number(process.argv[3] ?? 7);
const win = Number(process.argv[4] ?? 600);
const mapSize = process.env.SIZE === 'large' ? 'large' : 'medium';
const m = createMatch(data, { mapId: 'generated', mapSize, factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const cur = newCursor();
const bytes = new Map<string, number>();
let total = 0, snaps = 0, makeMs = 0, cloneMs = 0;
for (let i = 1; i <= secs * w.tickHz; i++) {
  step(m);
  if (i % 3 === 0) {
    const t0 = performance.now();
    const snap = makeSnapshot(m, cur, 0) as unknown as Record<string, unknown>;
    const t1 = performance.now();
    total += serialize(snap).length;
    cloneMs += performance.now() - t1;
    makeMs += t1 - t0;
    snaps++;
    // Per-field sizes on a sample (every 30th snapshot) to keep the run fast.
    if (snaps % 30 === 0) for (const k of Object.keys(snap)) bytes.set(k, (bytes.get(k) ?? 0) + serialize(snap[k]).length * 30);
  } else w.fx.length = 0;
  if (i % (win * w.tickHz) === 0) {
    const fields = [...bytes].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${(v / snaps / 1024).toFixed(1)}`).join(', ');
    console.log(`t=${Math.round(w.time)}s units ${w.units.size} snapshot ${(total / snaps / 1024).toFixed(1)} kB avg (make ${(makeMs / snaps).toFixed(3)} ms, serialize ${(cloneMs / snaps).toFixed(3)} ms) | kB: ${fields}`);
    total = 0; snaps = 0; makeMs = 0; cloneMs = 0; bytes.clear();
  }
}
