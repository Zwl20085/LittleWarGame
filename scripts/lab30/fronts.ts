/**
 * 3.0 lab — fronts (docs/V30_SPEC.md §5, WP-B). Two suites:
 *
 *   war   — 4 AI factions on a large generated map for `--minutes` (45): fronts per faction over
 *           time, mean front size (combat units per field front), front tiers (3.0), sim ms/tick.
 *   cost  — sim ms/tick with every faction forced to 4 / 8 / 16 / 24 fronts (the rules override
 *           lifts the front cap / soft max; the theatre's structure pass is switched off so the
 *           count stands), after a `--warm` (10) minute warm-up, measured over `--measure` (3) min.
 *
 *   npx tsx scripts/lab30/fronts.ts [--seeds 7,11,13] [--minutes 45] [--size large|medium]
 *        [--counts 4,8,16,24] [--warm 10] [--measure 3] [--suite war,cost] [--tag before]
 *
 * Output: media/stats/lab30/fronts-<tag>-<ts>.{md,json}. Read-only on world state in `war`.
 * (A small local runner: fold into scripts/lab30/common.ts when that lands.)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import type { GameData } from '../../src/data/types';
import { createMatch, step, type Match } from '../../src/sim/sim';
import { frontGroups } from '../../src/sim/fronts';
import { createFront } from '../../src/sim/frontops';
import { THEATRE_AB } from '../../src/sim/theatre';
import { isCommander } from '../../src/sim/formulas';
import type { Faction, Front } from '../../src/sim/types';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const nums = (s: string): number[] => s.split(',').map(Number).filter((n) => Number.isFinite(n));
const seeds = nums(opt('seeds', '7,11,13'));
const minutes = Number(opt('minutes', '45'));
const size = opt('size', 'large') as 'large' | 'medium';
const counts = nums(opt('counts', '4,8,16,24'));
const warm = Number(opt('warm', '10'));
const measure = Number(opt('measure', '3'));
const suites = opt('suite', 'war,cost').split(',');
const tag = opt('tag', 'run');

/** Rules JSON with the front cap lifted to `n` (both the 2.x `command.fronts_max` and the 3.0 `fronts.soft_max`). */
function loadData(frontCap?: number): GameData {
  const rules = JSON.parse(readFileSync('docs/data/rules.json', 'utf8')) as Record<string, Record<string, unknown>>;
  if (frontCap !== undefined) {
    if ('fronts_max' in rules.command) rules.command.fronts_max = Math.max(frontCap, 8);
    if (rules.fronts && 'soft_max' in rules.fronts) rules.fronts.soft_max = Math.max(frontCap, 8);
  }
  return buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), JSON.stringify(rules));
}

const newMatch = (data: GameData, seed: number): Match =>
  createMatch(data, { mapId: 'generated', mapSize: size, factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });

/** Combat units (no commanders / trucks) per front of `f`. */
function sizes(m: Match, f: Faction): { front: Front; n: number }[] {
  const g = frontGroups(m.world, f);
  return f.fronts.map((s) => ({ front: s, n: (g.get(s.id) ?? []).filter((u) => !isCommander(u.def) && u.def.id !== 'supply_truck').length }));
}

const tierOf = (s: Front): number => (s as Front & { tier?: number }).tier ?? -1;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;

interface Sample { seed: number; min: number; faction: number; fronts: number; sizes: number[]; tiers: number[] }
interface WarSeed { seed: number; samples: Sample[]; msPerTick: { min: number; mean: number; p99: number }[]; result: string; declines: number }

function runWar(seed: number): WarSeed {
  const m = newMatch(loadData(), seed);
  const w = m.world;
  const samples: Sample[] = [];
  const ms: { min: number; mean: number; p99: number }[] = [];
  let win: number[] = [];
  const ticks = minutes * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    const t0 = performance.now();
    step(m);
    win.push(performance.now() - t0);
    w.fx.length = 0;
    if ((i + 1) % (60 * w.tickHz) === 0) {
      const min = Math.round(w.time / 60);
      for (const f of w.factions) {
        if (!f.alive) continue;
        const z = sizes(m, f);
        samples.push({ seed, min, faction: f.id, fronts: f.fronts.length, sizes: z.map((x) => x.n), tiers: z.map((x) => tierOf(x.front)) });
      }
      if (min % 5 === 0) {
        ms.push({ min, mean: r2(mean(win)), p99: r2(pct(win, 0.99)) });
        win = [];
      }
    }
  }
  const result = w.result ? `${w.result.reason} @${Math.round(w.result.tick / w.tickHz / 60)}m → ${w.result.winners.join(',')}` : 'no result';
  const responses = (w.battle as unknown as { responses?: { result: string }[] }).responses ?? [];
  return { seed, samples, msPerTick: ms, result, declines: responses.filter((r) => r.result === 'declined').length };
}

interface CostRow { fronts: number; seed: number; reached: number[]; units: number; mean: number; p99: number }

function runCost(seed: number, n: number): CostRow {
  const m = newMatch(loadData(n), seed);
  const w = m.world;
  for (let i = 0; i < warm * 60 * w.tickHz; i++) { step(m); w.fx.length = 0; }
  const structure = THEATRE_AB.structure;
  THEATRE_AB.structure = false;
  for (const f of w.factions) {
    if (!f.alive) continue;
    f.p = Math.max(f.p, 1e6);
    // Merge down to n: the newest fronts fold into the first (dissolve keeps the units).
    let guard = 0;
    while (f.fronts.length < n && guard++ < 64) {
      const taken = new Set(f.fronts.map((s) => s.targetObjective));
      const objs = w.objectives.filter((o) => o.owner !== f.id && !taken.has(o.id));
      const o = objs[guard % Math.max(1, objs.length)] ?? w.objectives[guard % w.objectives.length];
      const free = [...w.units.values()].filter((u) => u.owner === f.id && u.hp > 0 && !u.fixed).length;
      if (!createFront(w, f, o, Math.floor(free / (f.fronts.length + 1)))) break;
    }
  }
  const reached = w.factions.map((f) => f.fronts.length);
  const win: number[] = [];
  for (let i = 0; i < measure * 60 * w.tickHz && !w.result; i++) {
    const t0 = performance.now();
    step(m);
    win.push(performance.now() - t0);
    w.fx.length = 0;
  }
  THEATRE_AB.structure = structure;
  return { fronts: n, seed, reached, units: w.aliveUnits.length, mean: r2(mean(win)), p99: r2(pct(win, 0.99)) };
}

const md: string[] = [`# Fronts lab (${tag}) — ${size} map, 4 AI, seeds ${seeds.join(',')}`, ''];
const out: { war: WarSeed[]; cost: CostRow[] } = { war: [], cost: [] };

if (suites.includes('war')) {
  for (const seed of seeds) {
    const t0 = performance.now();
    const r = runWar(seed);
    out.war.push(r);
    console.log(`war seed ${seed}: ${r.result} (${Math.round((performance.now() - t0) / 1000)} s wall)`);
  }
  const all = out.war.flatMap((r) => r.samples);
  md.push(`## Fronts per faction over time (${minutes} min)`, '', '| min | fronts / faction (mean) | min–max | mean front size | max front size | tier ≥1 share | ms/tick |', '|---|---|---|---|---|---|---|');
  for (let m = 5; m <= minutes; m += 5) {
    const s = all.filter((x) => x.min === m);
    if (!s.length) continue;
    const z = s.flatMap((x) => x.sizes);
    const tiers = s.flatMap((x) => x.tiers);
    const msv = out.war.map((r) => r.msPerTick.find((x) => x.min === m)?.mean ?? NaN).filter((x) => Number.isFinite(x));
    md.push(`| ${m} | ${r1(mean(s.map((x) => x.fronts)))} | ${Math.min(...s.map((x) => x.fronts))}–${Math.max(...s.map((x) => x.fronts))} | ${r1(mean(z))} | ${Math.max(...z)} | ${tiers.some((t) => t >= 0) ? `${Math.round(100 * tiers.filter((t) => t >= 1).length / Math.max(1, tiers.length))} %` : '—'} | ${r2(mean(msv))} |`);
  }
  const mid = all.filter((x) => x.min >= 15 && x.min <= 35);
  md.push('', '### Mid-war (15–35 min) by faction', '', '| seed | faction | fronts mean | min–max | mean size |', '|---|---|---|---|---|');
  for (const seed of seeds) {
    for (let f = 0; f < 4; f++) {
      const s = mid.filter((x) => x.seed === seed && x.faction === f);
      if (!s.length) continue;
      md.push(`| ${seed} | ${f} | ${r1(mean(s.map((x) => x.fronts)))} | ${Math.min(...s.map((x) => x.fronts))}–${Math.max(...s.map((x) => x.fronts))} | ${r1(mean(s.flatMap((x) => x.sizes)))} |`);
    }
  }
  md.push('', `Mid-war overall: **${r1(mean(mid.map((x) => x.fronts)))} fronts / faction**, mean size **${r1(mean(mid.flatMap((x) => x.sizes)))}**.`, '');
  md.push('| seed | result | directive declines |', '|---|---|---|', ...out.war.map((r) => `| ${r.seed} | ${r.result} | ${r.declines} |`), '');
}

if (suites.includes('cost')) {
  for (const n of counts) {
    for (const seed of seeds.slice(0, 1)) {
      const r = runCost(seed, n);
      out.cost.push(r);
      console.log(`cost ${n} fronts seed ${seed}: reached ${r.reached.join('/')} · ${r.units} units · ${r.mean} ms/tick (p99 ${r.p99})`);
    }
  }
  md.push(`## Sim cost by front count (seed ${seeds[0]}, after ${warm} min, ${measure} min measured)`, '', '| fronts / faction | reached | units | ms/tick mean | p99 |', '|---|---|---|---|---|');
  for (const r of out.cost) md.push(`| ${r.fronts} | ${r.reached.join('/')} | ${r.units} | ${r.mean} | ${r.p99} |`);
  md.push('');
}

mkdirSync('media/stats/lab30', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(`media/stats/lab30/fronts-${tag}-${stamp}.md`, md.join('\n'));
writeFileSync(`media/stats/lab30/fronts-${tag}-${stamp}.json`, JSON.stringify(out));
console.log(md.join('\n'));
