/**
 * 3.0 lab — directive compliance (docs/V30_SPEC.md §6, WP-C). Two suites:
 *
 *   spam    — the challenge strategies that spam orders (`rush`, `two_axis`, `human_like`) play the
 *             PLAYER side with compliance on vs off (COMPLIANCE_AB): the player side's survival and
 *             outcome, the AI's survival, declines and forced orders.
 *   recall  — home recall: 4-FFA, the player side runs on `advance` until `--recallAt` (15 min), then
 *             a `defend` with its own capital as axis; time until the first front (centroid > 600 m out
 *             at the order) reaches 600 m of the capital, and the order fronts move in (by distance).
 *
 *   npx tsx scripts/lab30/directive.ts [--seeds 7,11,13] [--minutes 40] [--jobs 6] [--suite spam,recall] [--recallAt 900]
 *
 * Output: media/stats/lab30/directive-<ts>.{md,json}. (Local runner; fold into scripts/lab30/common.ts when that lands.)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const nums = (s: string): number[] => s.split(',').map(Number).filter((n) => Number.isFinite(n));
const seeds = nums(opt('seeds', '7,11,13'));
const minutes = Number(opt('minutes', '40'));
const jobs = Math.max(1, Number(opt('jobs', '6')));
const suites = opt('suite', 'spam,recall').split(',');
const recallAt = Number(opt('recallAt', '900'));
const STRATS = ['rush', 'two_axis', 'human_like'];
const runDir = 'media/stats/lab30/directive-runs';

interface SpamRow { kind: 'spam'; strategy: string; seed: number; compliance: boolean; playerLostS: number; result: string; aiSurvived: number; aiCount: number; captures: number; declined: number; obeyed: number; forced: number; commands: number }
interface RecallRow { kind: 'recall'; seed: number; compliance: boolean; firstArriveS: number; fronts: { id: number; distM: number; moveS: number }[]; declinedNear: number }
type Row = SpamRow | RecallRow;

const file = (k: string, seed: number, on: boolean): string => `${runDir}/${k}-${seed}-${on ? 'on' : 'off'}-${minutes}m.json`;

async function runSpam(strategy: string, seed: number, on: boolean): Promise<SpamRow> {
  const { COMPLIANCE_AB } = await import('../../src/sim/compliance');
  COMPLIANCE_AB.on = on;
  const { runChallengeMatch } = await import('../challenge/match');
  // The challenger is the player faction: its directives go through the compliance model.
  const r = runChallengeMatch({ strategy, seed, minutes, challenger: 0 });
  const raw = r;
  return {
    kind: 'spam', strategy, seed, compliance: on, playerLostS: r.ownLostS, result: r.result ? `${r.result.reason}@${Math.round(r.result.t / 60)}m→${r.result.winners.join(',')}` : 'open',
    aiSurvived: r.ai.filter((a) => a.lostS < 0).length, aiCount: r.ai.length, captures: r.captures.length,
    declined: raw.responses?.filter((x) => x.result === 'declined').length ?? 0,
    obeyed: raw.responses?.filter((x) => x.result === 'obeyed').length ?? 0,
    forced: raw.responses?.filter((x) => x.result === 'forced').length ?? 0,
    commands: r.commandsIssued,
  };
}

async function runRecall(seed: number, on: boolean): Promise<RecallRow> {
  const { COMPLIANCE_AB } = await import('../../src/sim/compliance');
  COMPLIANCE_AB.on = on;
  const { loadDataFromDisk } = await import('../challenge/match');
  const { createMatch, step } = await import('../../src/sim/sim');
  const { CommandBus } = await import('../../src/sim/commands');
  const { frontGroups } = await import('../../src/sim/fronts');
  const { centroid, combatOf } = await import('../../src/sim/theatreq');
  const { dist } = await import('../../src/sim/vec');
  const m = createMatch(loadDataFromDisk(), { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: false });
  const w = m.world;
  const bus = new CommandBus();
  const hq = w.hqPos(0);
  const f = w.factions[0];
  while (w.time < recallAt && !w.result) { bus.flush(m); step(m); w.fx.length = 0; }
  const posOf = (): Map<number, number> => {
    const g = frontGroups(w, f);
    return new Map(f.fronts.map((s) => [s.id, dist(centroid(combatOf(g.get(s.id) ?? []), s.front), hq)]));
  };
  const start = posOf();
  bus.issue(m, 0, { type: 'setDirective', kind: 'defend', axis: { ...hq } });
  const t0 = w.time;
  const moveS = new Map<number, number>();
  const orderAt = new Map(f.fronts.map((s) => [s.id, `${s.order.kind}|${s.order.issuedAt}`]));
  let firstArriveS = -1;
  while (w.time < t0 + 300 && !w.result) {
    bus.flush(m);
    step(m);
    w.fx.length = 0;
    for (const s of f.fronts) if (!moveS.has(s.id) && orderAt.get(s.id) !== `${s.order.kind}|${s.order.issuedAt}` && s.order.issuedAt >= t0) moveS.set(s.id, Math.round(w.time - t0));
    if (firstArriveS < 0 && w.tick % w.tickHz === 0) {
      const now = posOf();
      for (const [id, d0] of start) if (d0 > 600 && (now.get(id) ?? Infinity) <= 600) firstArriveS = Math.round(w.time - t0);
    }
  }
  const declinedNear = w.battle.responses.filter((r) => r.f === 0 && r.result === 'declined' && r.distM <= w.data.rules.command.home_recall_m).length;
  return { kind: 'recall', seed, compliance: on, firstArriveS, declinedNear, fronts: [...start].map(([id, d]) => ({ id, distM: Math.round(d), moveS: moveS.get(id) ?? -1 })).sort((a, b) => a.distM - b.distM) };
}

/** Child process: one match, written to the run directory. */
async function runChild(): Promise<boolean> {
  const i = args.indexOf('--run');
  if (i < 0) return false;
  const [kind, seed, on] = [args[i + 1], Number(args[i + 2]), args[i + 3] === 'on'];
  const row = kind === 'recall' ? await runRecall(seed, on) : await runSpam(kind, seed, on);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(file(kind, seed, on), JSON.stringify(row));
  return true;
}

function child(kind: string, seed: number, on: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = ['tsx', 'scripts/lab30/directive.ts', '--run', kind, String(seed), on ? 'on' : 'off', '--minutes', String(minutes), '--recallAt', String(recallAt)];
    const p = spawn('npx', a, { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${kind} ${seed} ${on} exited ${code}`))));
  });
}

const mmss = (s: number): string => (s < 0 ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

async function main(): Promise<void> {
  if (await runChild()) return;
  const tasks: { kind: string; seed: number; on: boolean }[] = [];
  for (const on of [true, false]) {
    if (suites.includes('spam')) for (const s of STRATS) for (const seed of seeds) tasks.push({ kind: s, seed, on });
    if (suites.includes('recall')) for (const seed of seeds) tasks.push({ kind: 'recall', seed, on });
  }
  console.log(`directive lab: ${tasks.length} matches, ${jobs} jobs`);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      const t0 = performance.now();
      try {
        await child(t.kind, t.seed, t.on);
        console.log(`  ${t.kind} seed ${t.seed} compliance ${t.on ? 'on' : 'off'} done in ${Math.round((performance.now() - t0) / 1000)} s`);
      } catch (e: unknown) {
        console.error(e instanceof Error ? e.message : String(e));
      }
    }
  }));
  const rows: Row[] = [];
  for (const t of tasks) {
    try { rows.push(JSON.parse(readFileSync(file(t.kind, t.seed, t.on), 'utf8')) as Row); } catch { console.error(`no result ${t.kind} ${t.seed}`); }
  }
  const md: string[] = [`# Directive compliance lab — seeds ${seeds.join(',')}, ${minutes} min`, ''];
  const spam = rows.filter((r): r is SpamRow => r.kind === 'spam');
  if (spam.length) {
    md.push('## Order-spamming strategies as the player side', '', '| strategy | compliance | player capital kept | player outcome (per seed) | AI survival | captures by player | declines | obeyed | forced |', '|---|---|---|---|---|---|---|---|---|');
    for (const s of STRATS) {
      for (const on of [true, false]) {
        const x = spam.filter((r) => r.strategy === s && r.compliance === on);
        if (!x.length) continue;
        const ai = x.reduce((a, r) => a + r.aiSurvived, 0);
        const aiN = x.reduce((a, r) => a + r.aiCount, 0);
        md.push(`| ${s} | ${on ? 'on' : 'off'} | ${x.filter((r) => r.playerLostS < 0).length}/${x.length} | ${x.map((r) => (r.playerLostS < 0 ? `held (${r.result})` : `lost ${mmss(r.playerLostS)}`)).join('; ')} | ${Math.round((100 * ai) / Math.max(1, aiN))} % | ${x.reduce((a, r) => a + r.captures, 0)} | ${x.reduce((a, r) => a + r.declined, 0)} | ${x.reduce((a, r) => a + r.obeyed, 0)} | ${x.reduce((a, r) => a + r.forced, 0)} |`);
      }
    }
    md.push('');
  }
  const recall = rows.filter((r): r is RecallRow => r.kind === 'recall');
  if (recall.length) {
    md.push(`## Home recall (defend on the own capital at ${mmss(recallAt)})`, '', '| seed | compliance | first front at the capital | fronts: distance → seconds until it moved | declines within home_recall_m |', '|---|---|---|---|---|');
    for (const r of recall) md.push(`| ${r.seed} | ${r.compliance ? 'on' : 'off'} | ${r.firstArriveS < 0 ? '—' : `${r.firstArriveS} s`} | ${r.fronts.map((x) => `${x.distM} m → ${x.moveS < 0 ? '—' : `${x.moveS} s`}`).join(', ')} | ${r.declinedNear} |`);
    md.push('');
  }
  mkdirSync('media/stats/lab30', { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeFileSync(`media/stats/lab30/directive-${ts}.md`, md.join('\n'));
  writeFileSync(`media/stats/lab30/directive-${ts}.json`, JSON.stringify(rows));
  console.log(md.join('\n'));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
