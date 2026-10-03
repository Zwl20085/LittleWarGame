// Strategy lab (user request: battle events, strategy choice, analysis → better AI).
// Runs headless AI matches with the battle-event log (src/sim/events.ts) and writes a Markdown
// report of how the AI's decisions turned out: ops by kind × doctrine, success by force ratio
// and terrain, capture efficiency, directive follow-through, wasted ops, stuck/idle time.
//
// Usage: npx tsx scripts/strategy.ts --seeds 7,11,13 --minutes 20 [--map generated] [--jobs 3]
//        [--baseline]   run with the adaptive strategy layer off (src/sim/strategyai.ts), for A/B
//        [--compare]    run both variants on the same seeds and add a before/after table
//        [--ab home]    with --baseline/--compare: the "baseline" side turns only the round-3 home
//                       defence off (STRATEGY_AI.homeDefence) instead of the whole adaptive layer
//        [--ab storm]   …or only the round-4 siege-and-storm / crew deployment (STRATEGY_AI.storm)
//        [--no-rotate]  keep the default personality per slot (by default the 4 doctrines are
//                       rotated across the map slots by seed index, so slot luck ≠ doctrine strength)
// Output: media/stats/strategy-<timestamp>.md (+ raw per-seed JSON in media/stats/strategy-runs/).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { analyze, compareTable, type RunData } from './strategy/analyze';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const seeds = opt('seeds', '7,11,13').split(',').map(Number).filter((n) => Number.isFinite(n));
const minutes = Number(opt('minutes', '20'));
const mapId = opt('map', 'generated');
const jobs = Math.max(1, Number(opt('jobs', String(Math.min(4, seeds.length)))));
const runDir = 'media/stats/strategy-runs';

if (!seeds.length || !(minutes > 0)) throw new Error('usage: --seeds 7,11,13 --minutes 20');

/** One match in this process (child mode): run, finalise the log, dump JSON. */
const DOCTRINES = ['balanced', 'armor', 'infantry', 'mechanized'] as const;
const rotate = !flag('no-rotate');
const ab = opt('ab', 'adaptive');
const runFile = (seed: number, baseline: boolean): string => `${runDir}/${ab === 'adaptive' ? '' : `${ab}-`}${baseline ? 'base' : 'adaptive'}-${mapId}-${seed}.json`;

async function runOne(seed: number, baseline: boolean): Promise<void> {
  const { buildGameData } = await import('../src/data/loader');
  const { createMatch, step } = await import('../src/sim/sim');
  const { finalizeBattleLog, battleRecords } = await import('../src/sim/events');
  const { STRATEGY_AI } = await import('../src/sim/strategyai');
  const { homeSampler } = await import('./strategy/home');
  if (ab === 'home') STRATEGY_AI.homeDefence = !baseline;
  else if (ab === 'storm') STRATEGY_AI.storm = !baseline;
  else STRATEGY_AI.adaptive = !baseline;
  const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
  const k = rotate ? Math.max(0, seeds.indexOf(seed)) % DOCTRINES.length : 0;
  const personalities = DOCTRINES.map((_, i) => DOCTRINES[(i + k) % DOCTRINES.length]);
  const match = createMatch(data, { mapId: mapId as 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true, personalities });
  const w = match.world;
  const t0 = performance.now();
  const home = homeSampler(w);
  for (let i = 0; i < minutes * 60 * w.tickHz && !w.result; i++) {
    step(match);
    w.fx.length = 0;
    if (i % w.tickHz === 0) home.sample();
  }
  finalizeBattleLog(w);
  const lostByFaction = w.stats.byType.map((tbl) => Object.values(tbl).reduce((a, r) => a + r.lost, 0));
  const out: RunData = {
    seed, baseline, minutes: w.time / 60, wallS: (performance.now() - t0) / 1000,
    result: w.result ? { winners: [...w.result.winners], reason: w.result.reason, t: w.result.tick / w.tickHz } : null,
    factions: w.factions.map((f) => ({
      id: f.id, personality: f.personality, alive: f.alive,
      held: w.objectives.filter((o) => o.owner === f.id).length,
      value: Math.round([...w.units.values()].filter((u) => u.owner === f.id && u.hp > 0 && !u.fixed).reduce((a, u) => a + (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp), 0)),
      lost: lostByFaction[f.id] ?? 0,
      built: Object.values(w.stats.byType[f.id] ?? {}).reduce((a, r) => a + r.built, 0),
    })),
    objectives: w.objectives.length,
    log: battleRecords(w.battle),
    home: home.result(),
  };
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runFile(seed, baseline), JSON.stringify(out));
}

function child(seed: number, baseline: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = ['tsx', 'scripts/strategy.ts', '--run', String(seed), '--seeds', seeds.join(','), '--minutes', String(minutes), '--map', mapId];
    if (baseline) a.push('--baseline');
    if (ab !== 'adaptive') a.push('--ab', ab);
    if (!rotate) a.push('--no-rotate');
    const p = spawn('npx', a, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed ${seed}${baseline ? ' (baseline)' : ''} exited with ${code}`))));
  });
}

async function runAll(variants: boolean[]): Promise<Map<boolean, RunData[]>> {
  const tasks = variants.flatMap((b) => seeds.map((s) => ({ s, b })));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const t = tasks[next++];
      const t0 = performance.now();
      await child(t.s, t.b);
      console.log(`  seed ${t.s}${t.b ? ' baseline' : ''} done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  const out = new Map<boolean, RunData[]>();
  for (const b of variants) {
    out.set(b, seeds.map((s) => JSON.parse(readFileSync(runFile(s, b), 'utf8')) as RunData));
  }
  return out;
}

async function main(): Promise<void> {
  const runIdx = args.indexOf('--run');
  if (runIdx >= 0) {
    await runOne(Number(args[runIdx + 1]), flag('baseline'));
    return;
  }
  const compare = flag('compare');
  const variants = compare ? [true, false] : [flag('baseline')];
  console.log(`strategy lab: seeds ${seeds.join(',')} × ${minutes} min on ${mapId}, ${jobs} jobs${compare ? ', baseline vs adaptive' : ''}`);
  const runs = await runAll(variants);
  const parts: string[] = [];
  const title = `# Strategy lab — ${mapId}, seeds ${seeds.join(', ')}, ${minutes} min`;
  parts.push(title, '', `Generated ${new Date().toISOString()} by \`npx tsx scripts/strategy.ts ${args.join(' ')}\`.`, '');
  if (compare) parts.push('## Before / after (baseline → adaptive)', '', compareTable(runs.get(true)!, runs.get(false)!), '');
  for (const b of variants) {
    parts.push(`## ${b ? 'Baseline (adaptive layer off)' : 'Adaptive strategy layer on'}`, '', analyze(runs.get(b)!), '');
  }
  const md = parts.join('\n');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  mkdirSync('media/stats', { recursive: true });
  const file = `media/stats/strategy-${ts}.md`;
  writeFileSync(file, md);
  console.log(md);
  console.log(`\nreport written to ${file}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
