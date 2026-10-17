// Behaviour fingerprint for performance work: runs a headless AI war and prints an FNV-1a hash of
// the state that matters (units, positions, hp, morale, ammo, economy, objectives, RNG seeds)
// every minute. A perf change must leave every line identical.
//
//   SIZE=large npx tsx scripts/simhash.ts [seconds=1800] [seed=7]
import { readFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const secs = Number(process.argv[2] ?? 1800);
const seed = Number(process.argv[3] ?? 7);
const mapSize = process.env.SIZE === 'large' ? 'large' : 'medium';
const m = createMatch(data, { mapId: 'generated', mapSize, factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
let h = 2166136261 >>> 0;
const mix = (v: number): void => {
  f64[0] = v;
  h = Math.imul(h ^ u32[0], 16777619) >>> 0;
  h = Math.imul(h ^ u32[1], 16777619) >>> 0;
};
let ms = 0;
for (let i = 1; i <= secs * w.tickHz; i++) {
  const t = performance.now();
  step(m);
  ms += performance.now() - t;
  w.fx.length = 0;
  if (i % (10 * w.tickHz) !== 0) continue;
  for (const u of w.units.values()) {
    mix(u.id); mix(u.pos.x); mix(u.pos.z); mix(u.hp); mix(u.morale); mix(u.ammo); mix(u.targetId ?? -1);
  }
  for (const f of w.factions) { mix(f.p); mix(f.m); mix(f.resolve); }
  for (const o of w.objectives) mix(o.owner);
  mix(w.rngAi.seed); mix(w.rngCombat.seed); mix(w.rngScatter.seed);
  if (i % (60 * w.tickHz) === 0) {
    console.log(`t=${Math.round(w.time)}s units ${w.units.size} forts ${w.forts.length} hash ${h.toString(16)} ${(ms / (60 * w.tickHz)).toFixed(2)}ms/tick`);
    ms = 0;
  }
}
