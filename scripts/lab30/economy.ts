// 3.0 `economy` lab suite (V30_SPEC §7, WP-F): economic zones in real AI wars (4-FFA, 45 min).
//
//  default — every faction invests with its own style (INVEST_STYLE by personality): income
//            curves and zone counts / levels every 5 min.
//  army    — nobody builds zones (style 0 for all): the pure-army reference.
//  zones   — faction 0 invests as a `builder` (INVEST_STYLE.builder), the others build no zones.
//  Paired by seed, faction 0's strength (army value + stock) in `zones` minus `army` is the
//  zones-vs-pure-army verdict: acceptance = behind at 20 min, ahead at 45 min.
//
//   npx tsx scripts/lab30/economy.ts [--seeds 7,11,13] [--minutes 45] [--jobs 4]
import { INVEST_STYLE, setInvestStyle } from '../../src/sim/econZoneAi';
import { zoneCounts, zoneIncome } from '../../src/sim/econZones';
import { createMatch, step } from '../../src/sim/sim';
import { arg, childTask, fanOut, labData, reply, writeReport } from './fgkit';

type Variant = 'default' | 'army' | 'zones';
interface Task { variant: Variant; seed: number; minutes: number }
interface Sample {
  t: number;
  /** Per faction: income P+M per minute, zone income (P+M), zones, levels, army value, stock, alive. */
  income: number[];
  zoneIncome: number[];
  zones: number[];
  levels: number[];
  army: number[];
  stock: number[];
  alive: boolean[];
  ruins: number;
}
interface Result { variant: Variant; seed: number; samples: Sample[]; eliminated: number }

function run(t: Task): Result {
  const data = labData();
  const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: t.seed, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  if (t.variant !== 'default') for (const f of w.factions) setInvestStyle(f, t.variant === 'zones' && f.id === 0 ? INVEST_STYLE.builder : 0);
  const samples: Sample[] = [];
  const sample = (): void => {
    const army = w.factions.map(() => 0);
    for (const u of w.aliveUnits) if (u.hp > 0 && !u.fixed && u.def.id !== 'commander') army[u.owner] += (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);
    samples.push({
      t: Math.round(w.time / 60),
      income: w.factions.map((f) => Math.round(f.incomeP + f.incomeM)),
      zoneIncome: w.factions.map((f) => { const z = zoneIncome(w, f.id); return Math.round(z.p + z.m); }),
      zones: w.factions.map((f) => zoneCounts(w, f.id).zones),
      levels: w.factions.map((f) => zoneCounts(w, f.id).levels),
      army: army.map(Math.round),
      stock: w.factions.map((f) => Math.round(f.p + f.m)),
      alive: w.factions.map((f) => f.alive),
      ruins: w.econZones.filter((z) => z.ruined).length,
    });
  };
  for (let s = 1; s <= t.minutes * 60; s++) {
    for (let i = 0; i < w.tickHz && !w.result; i++) {
      step(m);
      w.fx.length = 0;
    }
    if (s % 300 === 0) sample();
  }
  return { variant: t.variant, seed: t.seed, samples, eliminated: w.factions.filter((f) => !f.alive).length };
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main(): Promise<void> {
  const seeds = arg('seeds', '7,11,13').split(',').map(Number);
  const minutes = Number(arg('minutes', '45'));
  const jobs = Number(arg('jobs', '4'));
  const tasks: Task[] = [];
  for (const variant of ['default', 'army', 'zones'] as const) for (const seed of seeds) tasks.push({ variant, seed, minutes });
  const res = await fanOut<Task, Result>('scripts/lab30/economy.ts', tasks, jobs);
  const L: string[] = ['# lab30 economy', '', `Generated ${new Date().toISOString()} — seeds ${seeds.join(',')}, ${minutes} min, 4-FFA.`, ''];
  const times = res[0]?.samples.map((s) => s.t) ?? [];
  L.push('## Default styles: income (P+M / min, all factions) and zones (count / total levels / ruins), mean over seeds', '', `| min | ${times.join(' | ')} |`, `|---|${times.map(() => '---:').join('|')}|`);
  const def = res.filter((r) => r.variant === 'default');
  const at = (r: Result, t: number): Sample | undefined => r.samples.find((s) => s.t === t);
  const row = (label: string, f: (s: Sample) => number): void => { L.push(`| ${label} | ${times.map((t) => Math.round(mean(def.map((r) => at(r, t)).filter((s): s is Sample => !!s).map(f)))).join(' | ')} |`); };
  row('income, sum', (s) => s.income.reduce((a, b, i) => a + (s.alive[i] ? b : 0), 0));
  row('zone income, sum', (s) => s.zoneIncome.reduce((a, b) => a + b, 0));
  row('zones', (s) => s.zones.reduce((a, b) => a + b, 0));
  row('zone levels', (s) => s.levels.reduce((a, b) => a + b, 0));
  row('ruined zones', (s) => s.ruins);
  L.push('', '## Zones vs pure army — faction 0 (builder style vs no zones), paired by seed', '', '| seed | min | army: strength (army + stock) | zones: strength | zones − army | zones: zones / levels | zones: zone income | zones: total income | army: total income |', '|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  const verdict: { t: number; d: number[] }[] = [20, 45].map((t) => ({ t, d: [] }));
  for (const seed of seeds) {
    const a = res.find((r) => r.variant === 'army' && r.seed === seed);
    const z = res.find((r) => r.variant === 'zones' && r.seed === seed);
    if (!a || !z) continue;
    for (const t of [10, 20, 30, 45]) {
      const sa = at(a, t);
      const sz = at(z, t);
      if (!sa || !sz) continue;
      const strA = sa.army[0] + sa.stock[0];
      const strZ = sz.army[0] + sz.stock[0];
      verdict.find((v) => v.t === t)?.d.push(strZ - strA);
      L.push(`| ${seed} | ${t} | ${strA}${sa.alive[0] ? '' : ' (out)'} | ${strZ}${sz.alive[0] ? '' : ' (out)'} | ${strZ - strA} | ${sz.zones[0]} / ${sz.levels[0]} | ${sz.zoneIncome[0]} | ${sz.income[0]} | ${sa.income[0]} |`);
    }
  }
  L.push('', '| min | mean (zones − army) strength | seeds ahead |', '|---:|---:|---:|');
  for (const v of verdict) L.push(`| ${v.t} | ${Math.round(mean(v.d))} | ${v.d.filter((x) => x > 0).length}/${v.d.length} |`);
  L.push('', `Eliminations (sum over seeds): default ${def.reduce((s, r) => s + r.eliminated, 0)}, army ${res.filter((r) => r.variant === 'army').reduce((s, r) => s + r.eliminated, 0)}, zones ${res.filter((r) => r.variant === 'zones').reduce((s, r) => s + r.eliminated, 0)}.`, '');
  const md = L.join('\n');
  console.log(md);
  console.log(`report: ${writeReport('economy', md, res)}.md`);
}

const task = childTask<Task>();
if (task) reply(run(task));
else void main();
