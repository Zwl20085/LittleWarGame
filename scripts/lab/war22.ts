// 2.2 war lab (strategy wave 2): armour clusters, economic raids / investment, supply tightness.
//
//   npx tsx scripts/lab/war22.ts --seeds 7,11,13 --minutes 30 [--jobs 6] [--src src] [--data docs/data] [--label x]
//
// Each seed runs in its own child process; the sim is imported from --src so a frozen copy of the
// tree (the "before") can be measured with the same probe. Writes media/stats/war22-<label>.json
// and prints the summary tables (docs/BALANCE_LAB.md, 2.2 strategy round).
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GameData } from '../../src/data/types';
import type { World } from '../../src/sim/world';
import { createWarProbe, warSecond, warSummary } from './war22probe';

interface Spec { seed: number; minutes: number; src: string; data: string }
type Sum = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function runSeed(spec: Spec): Promise<Sum> {
  const imp = (rel: string): Promise<Record<string, unknown>> => import(pathToFileURL(resolve(spec.src, rel)).href) as Promise<Record<string, unknown>>;
  const loader = await imp('data/loader.ts');
  const sim = await imp('sim/sim.ts');
  const build = loader.buildGameData as (u: string, w: string, r: string) => GameData;
  const createMatch = sim.createMatch as (d: GameData, c: Record<string, unknown>) => { world: World };
  const step = sim.step as (m: { world: World }) => void;
  const rd = (f: string): string => readFileSync(resolve(spec.data, f), 'utf8');
  const data = build(rd('units.csv'), rd('weapons.csv'), rd('rules.json'));
  const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: spec.seed, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  const probe = createWarProbe(w);
  const ticks = spec.minutes * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    step(m);
    w.fx.length = 0;
    if (w.tick % w.tickHz === 0) warSecond(w, probe);
  }
  return { seed: spec.seed, ...warSummary(w, probe) };
}

function child(spec: Spec): Promise<Sum> {
  return new Promise((res, rej) => {
    const c = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let done = false;
    c.on('message', (msg: { ok: boolean; r?: Sum; err?: string }) => { done = true; if (msg.ok && msg.r) res(msg.r); else rej(new Error(msg.err)); });
    c.on('exit', (code) => { if (!done) rej(new Error(`seed ${spec.seed} exited ${code}`)); });
    c.send(spec);
  });
}

const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(0)} %` : '-');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '-');
const sum = (rs: Sum[], k: string): number => rs.reduce((a, r) => a + (r[k] as number), 0);

function report(rs: Sum[], label: string): string {
  const L: string[] = [`## war22 ${label} — seeds ${rs.map((r) => r.seed).join(',')}`, ''];
  // Armour
  const eps = rs.flatMap((r) => r.episodes as { tanks: boolean; led: boolean; ok: boolean }[]);
  const withT = eps.filter((e) => e.tanks);
  const led = eps.filter((e) => e.led);
  const noT = eps.filter((e) => !e.tanks);
  L.push('| armour | value |', '|---|---:|');
  L.push(`| mean tank cluster size while attacking (tank-weighted, ${80} m link) | ${f2(sum(rs, 'clusterSum') / Math.max(1, sum(rs, 'clusterN')))} |`);
  L.push(`| … while firing | ${f2(sum(rs, 'engagedClusterSum') / Math.max(1, sum(rs, 'engagedClusterN')))} |`);
  L.push(`| attacking tank-samples in a group of ≥ 3 | ${pct(sum(rs, 'attackTankInGroup3'), sum(rs, 'attackTankSamples'))} |`);
  L.push(`| tank losses | ${sum(rs, 'tankDeaths')} |`);
  L.push(`| tank losses while alone (no friendly tank ≤ 80 m) | ${pct(sum(rs, 'tankDeathsAlone'), sum(rs, 'tankDeaths'))} |`);
  L.push(`| … alone and no infantry ≤ 60 m | ${pct(sum(rs, 'tankDeathsAloneNoFoot'), sum(rs, 'tankDeaths'))} |`);
  L.push(`| attack episodes with tanks: taken | ${withT.filter((e) => e.ok).length}/${withT.length} (${pct(withT.filter((e) => e.ok).length, withT.length)}) |`);
  L.push(`| tank-led episodes: taken | ${led.filter((e) => e.ok).length}/${led.length} (${pct(led.filter((e) => e.ok).length, led.length)}) |`);
  L.push(`| episodes without tanks: taken | ${noT.filter((e) => e.ok).length}/${noT.length} (${pct(noT.filter((e) => e.ok).length, noT.length)}) |`);
  // Economy war
  const des = rs.flatMap((r) => r.econDestroyed as { by: number; victim: number; raid: boolean }[]);
  const inv = rs.reduce((a, r) => a + (r.invested as number[]).reduce((x, y) => x + y, 0), 0);
  const spent = rs.reduce((a, r) => a + (r.spent as number[]).reduce((x, y) => x + y, 0), 0);
  const eInc = rs.reduce((a, r) => a + (r.econIncomeSum as number[]).reduce((x, y) => x + y, 0), 0);
  const inc = rs.reduce((a, r) => a + (r.incomeSum as number[]).reduce((x, y) => x + y, 0), 0);
  L.push('', '| economy war | value |', '|---|---:|');
  L.push(`| economic buildings destroyed (all) | ${des.length} |`);
  L.push(`| … by raid / infiltration parties | ${des.filter((d) => d.raid).length} |`);
  const per = [0, 1, 2, 3].map((fi) => `F${fi} ${des.filter((d) => d.raid && d.by === fi).length}/${des.filter((d) => d.victim === fi).length}`).join(' · ');
  L.push(`| raid kills by side / buildings lost by side | ${per} |`);
  L.push(`| economic-raid squads sent / lost (value lost) | ${sum(rs, 'econRaidUnits') || 0} / ${sum(rs, 'econRaidDeaths') || 0} (${Math.round(sum(rs, 'econRaidValueLost') || 0)}) |`);
  L.push(`| all raid units (convoy + economic) sent / lost | ${sum(rs, 'raidUnits')} / ${sum(rs, 'raidDeaths')} (${pct(sum(rs, 'raidDeaths'), sum(rs, 'raidUnits'))}) |`);
  L.push(`| raid value lost / sent | ${Math.round(sum(rs, 'raidValueLost'))} / ${Math.round(sum(rs, 'raidValueSent'))} |`);
  L.push(`| investment share (econ P+M ÷ all P+M spent) | ${pct(inv, spent)} |`);
  L.push(`| econ income share of all income | ${pct(eInc, inc)} |`);
  L.push(`| payback (econ output earned ÷ invested) | ${f2(eInc / Math.max(1, inv))} |`);
  L.push(`| working buildings at end (sum) | ${rs.reduce((a, r) => a + (r.econBuilt as number[]).reduce((x, y) => x + y, 0), 0)} |`);
  // Supply
  type S = { t: number; stockRatio: number; frontStockRatio: number; frontPlaces: number; lowMain: number; mainN: number; lowFight: number; fightN: number; rearm: number; logi: number; allocL: number; lowPush?: number; pushN?: number; truckLoss60?: number };
  const ss = rs.flatMap((r) => r.supply as S[]).filter((s) => s.t >= 300);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const fr = ss.filter((s) => s.frontStockRatio >= 0);
  L.push('', '| supply (after 5 min, per faction-sample every 30 s) | value |', '|---|---:|');
  L.push(`| stock ÷ cap, all places | ${f2(mean(ss.map((s) => s.stockRatio)))} |`);
  L.push(`| stock ÷ cap, front places (hostile ≤ 700 m) | ${f2(mean(fr.map((s) => s.frontStockRatio)))} |`);
  L.push(`| samples with front stocks < 50 % | ${pct(fr.filter((s) => s.frontStockRatio < 0.5).length, fr.length)} |`);
  L.push(`| main-effort units below 0.3 ammo | ${pct(ss.reduce((a, s) => a + s.lowMain, 0), ss.reduce((a, s) => a + s.mainN, 0))} |`);
  L.push(`| main effort in a push (front mode push/breakthrough) below 0.3 ammo | ${pct(ss.reduce((a, s) => a + (s.lowPush ?? 0), 0), ss.reduce((a, s) => a + (s.pushN ?? 0), 0))} |`);
  const lost = ss.filter((s) => (s.truckLoss60 ?? 0) > 0);
  const kept = ss.filter((s) => (s.truckLoss60 ?? 0) === 0);
  L.push(`| … main effort below 0.3 after a truck loss (≤ 90 s) / otherwise | ${pct(lost.reduce((a, s) => a + s.lowMain, 0), lost.reduce((a, s) => a + s.mainN, 0))} / ${pct(kept.reduce((a, s) => a + s.lowMain, 0), kept.reduce((a, s) => a + s.mainN, 0))} |`);
  L.push(`| supply trucks lost | ${rs.reduce((a, r) => a + ((r.truckDeaths as number[] | undefined) ?? []).reduce((x, y) => x + y, 0), 0)} |`);
  L.push(`| firing units below 0.3 ammo | ${pct(ss.reduce((a, s) => a + s.lowFight, 0), ss.reduce((a, s) => a + s.fightN, 0))} |`);
  L.push(`| units walking to rearm | ${pct(mean(ss.map((s) => s.rearm)), 1)} |`);
  L.push(`| logistics L per min (mean) / L share | ${Math.round(mean(ss.map((s) => s.logi)))} / ${f2(mean(ss.map((s) => s.allocL)))} |`);
  // Time series (every 5 min, pooled)
  L.push('', 'min | stock | front stock | main low-ammo | firing low-ammo | rearming', '---|---:|---:|---:|---:|---:');
  for (let t = 300; t <= Math.max(...rs.map((r) => r.time as number)); t += 300) {
    const at = rs.flatMap((r) => r.supply as S[]).filter((s) => Math.abs(s.t - t) < 1);
    if (!at.length) continue;
    const fa = at.filter((s) => s.frontStockRatio >= 0);
    L.push(`${t / 60} | ${f2(mean(at.map((s) => s.stockRatio)))} | ${f2(mean(fa.map((s) => s.frontStockRatio)))} | ${pct(at.reduce((a, s) => a + s.lowMain, 0), at.reduce((a, s) => a + s.mainN, 0))} | ${pct(at.reduce((a, s) => a + s.lowFight, 0), at.reduce((a, s) => a + s.fightN, 0))} | ${pct(mean(at.map((s) => s.rearm)), 1)}`);
  }
  // War progress
  L.push('', '| war | value |', '|---|---:|');
  L.push(`| captures (all places, owner changes) | ${sum(rs, 'captures')} |`);
  L.push(`| results | ${rs.map((r) => (r.result ? `s${r.seed}: F${r.result.winners.join('+')} @${(r.result.minute as number).toFixed(0)}m` : `s${r.seed}: open ${(r.alive as boolean[]).filter(Boolean).length} alive, held ${(r.held as number[]).join('/')}`)).join(' · ')} |`);
  return L.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--worker') {
    process.on('message', (spec: Spec) => {
      runSeed(spec).then((r) => process.send?.({ ok: true, r }, () => process.exit(0)))
        .catch((e: unknown) => process.send?.({ ok: false, err: e instanceof Error ? e.stack : String(e) }, () => process.exit(1)));
    });
    return;
  }
  const opt = (k: string, d: string): string => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const seeds = opt('seeds', '7,11,13').split(',').map(Number);
  const minutes = Number(opt('minutes', '30'));
  const src = resolve(opt('src', 'src'));
  const data = resolve(opt('data', 'docs/data'));
  const label = opt('label', 'run');
  const jobs = Number(opt('jobs', '6'));
  const t0 = performance.now();
  const specs = seeds.map((seed) => ({ seed, minutes, src, data }));
  const out: Sum[] = new Array(specs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, specs.length) }, async () => {
    while (next < specs.length) { const i = next++; out[i] = await child(specs[i]); console.log(`  seed ${specs[i].seed} done (${((performance.now() - t0) / 1000).toFixed(0)} s)`); }
  }));
  mkdirSync('media/stats', { recursive: true });
  writeFileSync(`media/stats/war22-${label}.json`, JSON.stringify(out));
  const md = report(out, label);
  writeFileSync(`media/stats/war22-${label}.md`, md);
  console.log(md);
}

void main();
