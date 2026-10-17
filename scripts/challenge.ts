// Challenge lab (user: "build a mechanism to test if the AI could handle different strategies; in
// some game I just let all units attack the capital, then it wins"). One faction — the challenger —
// is played by a scripted supreme-HQ strategy through the public command API (CommandBus), the
// other three are the normal AI. The report says whether the AI survives each strategy and how it
// defended (alarm, recall, works, garrison, counter-attack). See docs/CHALLENGE_LAB.md.
//
// Usage: npx tsx scripts/challenge.ts --strategy rush --seeds 7,11,13 --minutes 40 --jobs 6
//        [--all]                every strategy (rush at --rushAt)
//        [--suite diversity]    every old + 3.0 strategy with its variants (armour_raid x4, shadow_strike open + fog, ai_only ...)
//        [--experience]         also write the player-experience report (media/stats/lab30/experience-<ts>.{md,json})
//        [--experience-out f]   also write that JSON to f (the committed baseline docs/lab/base-2.2.1-experience.json)
//        [--variant a,b]        strategy variants (armour_raid: 15-direct,15-flank,25-direct,25-flank)
//        [--map-size large]     medium (default) or large generated map
//        [--challenger 0]       challenger slot
//        [--rushAt 300]         rush / rush_micro launch time in seconds; a list (180,300,600) runs one variant each
//        [--fog]                fog-of-war information for the AI factions (the challenger stays omniscient)
// Output: media/stats/challenge-<timestamp>.md (+ raw JSON per match in media/stats/challenge-runs/).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { experienceJson, experienceMarkdown, evaluate, summarise } from './challenge/experienceReport';
import { aggregate, label, markdown, summaryTable, type Row } from './challenge/report';
import { STRATEGIES, SUITE_VARIANTS } from './challenge/strategies';
import type { ChallengeReport } from './challenge/types';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name: string): boolean => args.includes(`--${name}`);
const nums = (s: string): number[] => s.split(',').map(Number).filter((n) => Number.isFinite(n));

const seeds = nums(opt('seeds', '7,11,13'));
const minutes = Number(opt('minutes', '40'));
const challenger = Number(opt('challenger', '0'));
const rushAts = nums(opt('rushAt', '300'));
const jobs = Math.max(1, Number(opt('jobs', '6')));
const suite = opt('suite', '');
const mapSize = opt('map-size', 'medium') as 'medium' | 'large';
const variantOpt = opt('variant', '').split(',').filter(Boolean);
const fogAll = flag('fog');
const experience = flag('experience') || flag('experience-out');
const runDir = 'media/stats/challenge-runs';
const r7off = process.env.R7_OFF ?? '';
const isRush = (s: string): boolean => s === 'rush' || s === 'rush_micro';
const hasVariants = (s: string): boolean => s in SUITE_VARIANTS;

if (!seeds.length || !(minutes > 0) || !rushAts.length || !(challenger >= 0 && challenger <= 3) || !['medium', 'large'].includes(mapSize) || (suite && suite !== 'diversity')) {
  throw new Error('usage: --strategy rush|--all|--suite diversity --seeds 7,11,13 --minutes 40 [--jobs 6] [--challenger 0] [--rushAt 300] [--variant v] [--map-size medium|large] [--experience]');
}

interface Task { readonly strategy: string; readonly seed: number; readonly rushAt: number; readonly variant: string; readonly fog: boolean }

const runFile = (t: Task): string => `${runDir}/${t.strategy}${isRush(t.strategy) ? `-${t.rushAt}` : ''}${t.variant ? `-${t.variant}` : ''}${t.fog ? '-fog' : ''}${mapSize === 'large' ? '-large' : ''}${r7off ? `-r7off_${r7off.replace(/,/g, '+')}` : ''}-c${challenger}-${t.seed}-${minutes}m.json`;

async function runOne(t: Task): Promise<void> {
  const { runChallengeMatch } = await import('./challenge/match');
  const r = runChallengeMatch({ strategy: t.strategy, seed: t.seed, minutes, challenger, params: { rushAt: t.rushAt, variant: t.variant }, infoMode: t.fog ? 'fog' : 'open', mapSize });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runFile(t), JSON.stringify(r));
}

const tag = (t: Task): string => `${t.strategy}${isRush(t.strategy) ? `@${t.rushAt}s` : ''}${t.variant ? `:${t.variant}` : ''}${t.fog ? ' fog' : ''}`;

function child(t: Task): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = ['tsx', 'scripts/challenge.ts', '--run', t.strategy, String(t.seed), String(t.rushAt), '--minutes', String(minutes), '--challenger', String(challenger), '--map-size', mapSize];
    if (t.variant) a.push('--run-variant', t.variant);
    if (t.fog) a.push('--fog');
    const p = spawn('npx', a, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${tag(t)} seed ${t.seed} exited with ${code}`))));
  });
}

async function runAll(tasks: Task[]): Promise<Row[]> {
  let next = 0;
  const failures: string[] = [];
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const t = tasks[next++];
      const t0 = performance.now();
      try {
        await child(t);
        console.log(`  ${tag(t)} seed ${t.seed} done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      } catch (e: unknown) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  if (failures.length) console.error(`failed matches:\n  ${failures.join('\n  ')}`);
  const rows: Row[] = [];
  for (const t of tasks) {
    try {
      const r = JSON.parse(readFileSync(runFile(t), 'utf8')) as ChallengeReport;
      rows.push({ label: label(r, t.rushAt), r });
    } catch {
      console.error(`no result for ${tag(t)} seed ${t.seed}`);
    }
  }
  return rows;
}

/** Scenario list: (strategy, rushAt, variant, fog) without seeds. */
function scenarios(): Omit<Task, 'seed'>[] {
  if (suite === 'diversity') {
    return STRATEGIES.flatMap((s) => {
      if (isRush(s.id)) return rushAts.map((rushAt) => ({ strategy: s.id, rushAt, variant: '', fog: fogAll }));
      if (hasVariants(s.id)) return (variantOpt.length ? variantOpt : SUITE_VARIANTS[s.id]).map((variant) => ({ strategy: s.id, rushAt: rushAts[0], variant, fog: fogAll }));
      if (s.id === 'shadow_strike' && !fogAll) return [false, true].map((fog) => ({ strategy: s.id, rushAt: rushAts[0], variant: '', fog }));
      return [{ strategy: s.id, rushAt: rushAts[0], variant: '', fog: fogAll }];
    });
  }
  const ids = flag('all') ? STRATEGIES.map((s) => s.id) : opt('strategy', 'rush').split(',');
  return ids.flatMap((s) => (isRush(s) ? rushAts : [rushAts[0]]).flatMap((rushAt) => (hasVariants(s) && variantOpt.length ? variantOpt : ['']).map((variant) => ({ strategy: s, rushAt, variant, fog: fogAll }))));
}

async function main(): Promise<void> {
  const runIdx = args.indexOf('--run');
  if (runIdx >= 0) {
    await runOne({ strategy: args[runIdx + 1], seed: Number(args[runIdx + 2]), rushAt: Number(args[runIdx + 3]), variant: opt('run-variant', ''), fog: fogAll });
    return;
  }
  const tasks: Task[] = scenarios().flatMap((sc) => seeds.map((seed) => ({ ...sc, seed })));
  const t0 = performance.now();
  console.log(`challenge lab: ${[...new Set(tasks.map((t) => t.strategy))].join(', ')} x seeds ${seeds.join(',')} x ${minutes} min, ${mapSize} map, challenger slot ${challenger}${fogAll ? ', fog' : ''}${r7off ? `, R7_OFF=${r7off}` : ''}, ${tasks.length} matches, ${jobs} jobs`);
  const rows = await runAll(tasks);
  if (!rows.length) throw new Error('no match finished');
  const cmd = `npx tsx scripts/challenge.ts ${args.join(' ')}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  mkdirSync('media/stats', { recursive: true });
  const file = `media/stats/challenge-${ts}.md`;
  writeFileSync(file, markdown(rows, cmd));
  console.log(`\n${summaryTable(aggregate(rows))}`);
  console.log(`\nreport written to ${file}`);
  if (experience) writeExperience(rows, cmd, ts);
  console.log(`total wall time ${((performance.now() - t0) / 60000).toFixed(1)} min`);
}

function writeExperience(rows: Row[], cmd: string, ts: string): void {
  mkdirSync('media/stats/lab30', { recursive: true });
  const base = `media/stats/lab30/experience-${ts}`;
  writeFileSync(`${base}.md`, experienceMarkdown(rows, cmd));
  const json = JSON.stringify(experienceJson(rows, cmd), null, 1);
  writeFileSync(`${base}.json`, json);
  const out = opt('experience-out', '');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
  for (const s of summarise(evaluate(rows))) console.log(`  ${s.label}: score ${s.score} ${s.verdict}, capitals taken by challenger ${s.challengerCaptures}, cheap-win flags ${s.cheapFlags}, min warning ${Number.isFinite(s.minWarnS) ? `${s.minWarnS.toFixed(0)} s` : '-'}`);
  console.log(`experience report written to ${base}.md / .json${out ? `, baseline ${out}` : ''}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
