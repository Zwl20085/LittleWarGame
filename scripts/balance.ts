// Numeric analysis: run headless AI matches and print the per-unit-type combat ledger,
// the attacker × victim matrix and the economy timeline (see src/sim/stats.ts).
// Usage: npx tsx scripts/balance.ts [minutes=20] [seeds=7,11] [mapId=generated]
// Writes the raw ledger to media/stats/<seed>.json (gitignored) for deeper digging.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import type { MatchStats, TypeStats } from '../src/sim/stats';

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const minutes = Number(process.argv[2] ?? 20);
const seeds = (process.argv[3] ?? '7,11').split(',').map(Number);
const mapId = (process.argv[4] ?? 'generated') as 'generated' | 'four_cities';

const pad = (v: string | number, n: number): string => String(v).padStart(n);
const k = (v: number): string => (v >= 1e4 ? `${(v / 1e3).toFixed(0)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0));

function pooled(stats: MatchStats): Record<string, TypeStats> {
  const out: Record<string, TypeStats> = {};
  for (const tbl of stats.byType) {
    for (const [type, r] of Object.entries(tbl)) {
      const o = (out[type] ??= { built: 0, lost: 0, spent: 0, shots: 0, dmgDealt: 0, dmgTaken: 0, kills: 0, killValue: 0, aliveSeconds: 0 });
      for (const key of Object.keys(r) as (keyof TypeStats)[]) o[key] += r[key];
    }
  }
  return out;
}

function printLedger(all: Record<string, TypeStats>): void {
  console.log('\n== Per unit type (all factions, all seeds) ==');
  console.log('type            built  lost  K/D   kills  dmgOut  dmgIn  dmg/min/unit  value-kill/spent  dmg/cost  share');
  const total = Object.values(all).reduce((s, r) => s + r.dmgDealt, 0) || 1;
  const rows = Object.entries(all).sort((a, b) => b[1].dmgDealt - a[1].dmgDealt);
  for (const [type, r] of rows) {
    const perMin = r.aliveSeconds > 0 ? (r.dmgDealt / (r.aliveSeconds / 60)) : 0;
    console.log(
      `${type.padEnd(15)} ${pad(r.built, 5)} ${pad(r.lost, 5)} ${pad(r.lost ? (r.kills / r.lost).toFixed(2) : '-', 5)} ${pad(r.kills, 6)} ${pad(k(r.dmgDealt), 7)} ${pad(k(r.dmgTaken), 6)}`
      + ` ${pad(perMin.toFixed(1), 12)} ${pad(r.spent ? (r.killValue / r.spent).toFixed(2) : '-', 16)} ${pad(r.spent ? (r.dmgDealt / r.spent).toFixed(2) : '-', 9)} ${pad(((r.dmgDealt / total) * 100).toFixed(1) + '%', 6)}`,
    );
  }
}

function printMatrix(matrices: MatchStats['matrix'][]): void {
  const m: Record<string, Record<string, { dmg: number; kills: number }>> = {};
  const victims = new Set<string>();
  for (const mx of matrices) {
    for (const [a, row] of Object.entries(mx)) {
      for (const [v, c] of Object.entries(row)) {
        const cell = ((m[a] ??= {})[v] ??= { dmg: 0, kills: 0 });
        cell.dmg += c.dmg;
        cell.kills += c.kills;
        victims.add(v);
      }
    }
  }
  const cols = [...victims].sort();
  console.log('\n== Kills: attacker (row) × victim (column) ==');
  console.log(''.padEnd(13) + cols.map((c) => pad(c.slice(0, 7), 8)).join(''));
  for (const a of Object.keys(m).sort()) console.log(a.padEnd(13) + cols.map((v) => pad(m[a][v]?.kills ?? 0, 8)).join(''));
  console.log('\n== Damage share by attacker against each victim type ==');
  for (const v of cols) {
    const tot = Object.values(m).reduce((s, row) => s + (row[v]?.dmg ?? 0), 0) || 1;
    const parts = Object.entries(m).map(([a, row]) => [a, (row[v]?.dmg ?? 0) / tot] as const).filter(([, s]) => s >= 0.05).sort((x, y) => y[1] - x[1]);
    console.log(`${v.padEnd(13)} ${parts.map(([a, s]) => `${a} ${(s * 100).toFixed(0)}%`).join(', ')}`);
  }
}

function printTimeline(stats: MatchStats): void {
  console.log('  t(min)  per faction: units/value  pop/cap  held  inc p|m  stock p|m  resolve  lost');
  for (const pt of stats.timeline) {
    if (Math.round(pt.t) % 300 !== 0) continue;
    const cols = pt.f.map((f) => `${f.units}/${k(f.value)} ${f.pop}/${f.popCap} h${f.held} ${f.incP}|${f.incM} ${k(f.p)}|${k(f.m)} R${f.resolve} L${f.lost}`);
    console.log(`  ${pad((pt.t / 60).toFixed(0), 5)}  ${cols.join('  ·  ')}`);
  }
}

mkdirSync('media/stats', { recursive: true });
const ledgers: MatchStats[] = [];
for (const seed of seeds) {
  const t0 = performance.now();
  const match = createMatch(data, { mapId, factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = match.world;
  for (let i = 0; i < minutes * 60 * w.tickHz && !w.result; i++) {
    step(match);
    w.fx.length = 0;
  }
  const res = w.result ? `${w.result.reason} at ${(w.result.tick / w.tickHz / 60).toFixed(1)} min` : 'running';
  console.log(`\n### seed ${seed}: ${(w.time / 60).toFixed(1)} min simulated in ${((performance.now() - t0) / 1000).toFixed(0)} s, result ${res}`);
  printTimeline(w.stats);
  ledgers.push(w.stats);
  writeFileSync(`media/stats/${mapId}-${seed}.json`, JSON.stringify(w.stats));
}
printLedger(pooled({ byType: ledgers.flatMap((l) => l.byType), matrix: {}, timeline: [] }));
printMatrix(ledgers.map((l) => l.matrix));
