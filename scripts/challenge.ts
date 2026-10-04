// Challenge lab (user: "build a mechanism to test if the AI could handle different strategies; in
// some game I just let all units attack the capital, then it wins"). One faction — the challenger —
// is played by a scripted supreme-HQ strategy through the public command API (CommandBus), the
// other three are the normal AI. The report says whether the AI survives each strategy and how it
// defended (alarm, recall, works, garrison, counter-attack). See docs/CHALLENGE_LAB.md.
//
// Usage: npx tsx scripts/challenge.ts --strategy rush --seeds 7,11,13 --minutes 40 --jobs 6
//        [--all]                every strategy (rush at --rushAt)
//        [--challenger 0]       challenger slot
//        [--rushAt 300]         rush / rush_micro launch time in seconds; a list (180,300,600) runs one variant each
//        [--fog]                fog-of-war information for the AI factions (the challenger stays omniscient)
// Output: media/stats/challenge-<timestamp>.md (+ raw JSON per match in media/stats/challenge-runs/).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { aggregate, label, markdown, summaryTable, type Row } from './challenge/report';
import { STRATEGIES } from './challenge/strategies';
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
const strategies = flag('all') ? STRATEGIES.map((s) => s.id) : opt('strategy', 'rush').split(',');
const runDir = 'media/stats/challenge-runs';
const fog = flag('fog');
const r7off = process.env.R7_OFF ?? '';
const isRush = (s: string): boolean => s === 'rush' || s === 'rush_micro';

if (!seeds.length || !(minutes > 0) || !rushAts.length || !(challenger >= 0 && challenger <= 3)) {
  throw new Error('usage: --strategy rush|--all --seeds 7,11,13 --minutes 40 [--jobs 6] [--challenger 0] [--rushAt 300]');
}

interface Task { readonly strategy: string; readonly seed: number; readonly rushAt: number }

const runFile = (t: Task): string => `${runDir}/${t.strategy}${isRush(t.strategy) ? `-${t.rushAt}` : ''}${fog ? '-fog' : ''}${r7off ? `-r7off_${r7off.replace(/,/g, '+')}` : ''}-c${challenger}-${t.seed}-${minutes}m.json`;

async function runOne(t: Task): Promise<void> {
  const { runChallengeMatch } = await import('./challenge/match');
  const r = runChallengeMatch({ strategy: t.strategy, seed: t.seed, minutes, challenger, params: { rushAt: t.rushAt }, infoMode: fog ? 'fog' : 'open' });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runFile(t), JSON.stringify(r));
}

function child(t: Task): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = ['tsx', 'scripts/challenge.ts', '--run', t.strategy, String(t.seed), String(t.rushAt), '--minutes', String(minutes), '--challenger', String(challenger)];
    if (fog) a.push('--fog');
    const p = spawn('npx', a, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${t.strategy} seed ${t.seed} exited with ${code}`))));
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
        console.log(`  ${t.strategy}${isRush(t.strategy) ? `@${t.rushAt}s` : ''}${fog ? ' fog' : ''} seed ${t.seed} done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
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
      console.error(`no result for ${t.strategy} seed ${t.seed}`);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const runIdx = args.indexOf('--run');
  if (runIdx >= 0) {
    await runOne({ strategy: args[runIdx + 1], seed: Number(args[runIdx + 2]), rushAt: Number(args[runIdx + 3]) });
    return;
  }
  const tasks: Task[] = strategies.flatMap((s) => (isRush(s) ? rushAts : [rushAts[0]]).flatMap((rushAt) => seeds.map((seed) => ({ strategy: s, seed, rushAt }))));
  console.log(`challenge lab: ${strategies.join(', ')} × seeds ${seeds.join(',')} × ${minutes} min, challenger slot ${challenger}${fog ? ', fog' : ''}${r7off ? `, R7_OFF=${r7off}` : ''}, ${tasks.length} matches, ${jobs} jobs`);
  const rows = await runAll(tasks);
  if (!rows.length) throw new Error('no match finished');
  const md = markdown(rows, `npx tsx scripts/challenge.ts ${args.join(' ')}`);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  mkdirSync('media/stats', { recursive: true });
  const file = `media/stats/challenge-${ts}.md`;
  writeFileSync(file, md);
  console.log(`\n${summaryTable(aggregate(rows))}`);
  console.log(`\nreport written to ${file}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
