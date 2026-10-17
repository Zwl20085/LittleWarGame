// 3.0 lab suite `upgrade` (V30_SPEC §9, docs/UPGRADES.md): unit upgrades.
//
//   npx tsx scripts/lab30/upgrade.ts [--parts value,rich,motor,engage] [--seeds 7,11,13] [--minutes 30]
//        [--items inf_guns,gun_1,...] [--rich-seeds 7,11,13,17,19,23] [--rich-minutes 60] [--trials 10] [--jobs 6] [--set path=value ...]
//
// engage — low-noise single engagements (upgradeEngage.ts): fixed armies on an open corridor, side A
//         with the item, side B without, paired with a no-item control per trial; value/cost =
//         Δ(A value left − B value left) / item cost. Combat items only (not run by default).
// value — 1v1 at equal resources, AI research off: side A is granted the item (and its
//         prerequisites) at t = 0, side B banks the same P/M into its stock (spent on units by the
//         AI). Both sides take each role (seed × side). Score for A = kill-value traded + 400 per
//         settlement held more (+20000 for a win). value/cost = 1 + (score − control) / cost, where
//         control is the same match with no item and no bank; 1.0 = worth exactly its price.
// rich  — 1v1, AI research on, one side gets 1.5× income (the lab adds +50 % of its income every
//         second): the rich side's win share and the median win time (spec: ≥ 70 %, > 30 min).
// motor — 6 rifle squads ordered from the capital to the farthest own-side settlement, with and
//         without full motorization: seconds until 4 and 6 of them are within 80 m.
// Output: media/stats/lab30/upgrade-<ts>.{json,md}.
import type { Match } from '../../src/sim/sim';
import { grantUpgrade, upgradeCost, UPGRADE_IDS, type UpgradeId } from '../../src/sim/upgrades';
import { dist, type V2 } from '../../src/sim/vec';
import { engageRows, engageTasks, runEngage, type EngageResult, type EngageTask } from './upgradeEngage';
import { argList, argNum, argSets, argStr, isWorker, labMatch, loadData, mdTable, mean, parseArgs, runFor, runParallel, workerLoop, writeReport } from './common';

type Task =
  | { kind: 'value'; seed: number; item: UpgradeId | 'control'; side: number; minutes: number; sets: string[] }
  | { kind: 'rich'; seed: number; rich: number; minutes: number; sets: string[] }
  | { kind: 'motor'; seed: number; motor: boolean; sets: string[] }
  | EngageTask;

interface ValueResult { score: number; cost: number; winner: number | null }
interface RichResult { winner: number | null; endS: number | null; upgradesRich: number; upgradesPoor: number; heldRich: number; heldPoor: number; armyRich: number; armyPoor: number }
interface MotorResult { t4: number | null; t6: number | null; routeM: number }

const WIN_BONUS = 20000;
const HELD_VALUE = 400;
const AI_OFF = 'upgrades.ai.enabled=false';

function killValue(m: Match, f: number): number {
  let v = 0;
  for (const r of Object.values(m.world.stats.byType[f] ?? {})) v += r.killValue;
  return v;
}

const held = (m: Match, f: number): number => m.world.objectives.filter((o) => o.owner === f).length;

function armyValue(m: Match, f: number): number {
  let v = 0;
  for (const u of m.world.aliveUnits) if (u.owner === f && u.hp > 0 && !u.fixed) v += u.def.costP + u.def.costM;
  return v;
}

const stdErr = (xs: readonly number[]): number => {
  if (xs.length < 2) return NaN;
  const mu = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1) / xs.length);
};

/** Item plus its prerequisites, in order. */
function chain(id: UpgradeId, items: Record<string, { requires?: readonly string[] }>): UpgradeId[] {
  const out: UpgradeId[] = [];
  const add = (x: string): void => {
    for (const q of items[x]?.requires ?? []) add(q);
    if (!out.includes(x as UpgradeId)) out.push(x as UpgradeId);
  };
  add(id);
  return out;
}

function runValue(t: Extract<Task, { kind: 'value' }>): ValueResult {
  const data = loadData([...t.sets, AI_OFF]);
  const m = labMatch(data, { seed: t.seed, factions: 2 });
  const w = m.world;
  const a = w.factions[t.side];
  const b = w.factions[1 - t.side];
  let p = 0;
  let mm = 0;
  if (t.item !== 'control') {
    for (const id of chain(t.item, data.rules.upgrades!.items)) {
      const c = upgradeCost(w, a, id);
      p += c.p;
      mm += c.m;
      grantUpgrade(w, a, id);
    }
    b.p += p;
    b.m += mm;
  }
  runFor(m, t.minutes * 60);
  const win = w.result?.winners.length === 1 ? w.result.winners[0] : null;
  const score = killValue(m, a.id) - killValue(m, b.id) + HELD_VALUE * (held(m, a.id) - held(m, b.id)) + (win === a.id ? WIN_BONUS : win === b.id ? -WIN_BONUS : 0);
  return { score, cost: p + mm, winner: win };
}

function runRich(t: Extract<Task, { kind: 'rich' }>): RichResult {
  const data = loadData(t.sets);
  const m = labMatch(data, { seed: t.seed, factions: 2 });
  const w = m.world;
  const f = w.factions[t.rich];
  const capP = data.rules.economy.cap_p;
  const capM = data.rules.economy.cap_m;
  runFor(m, t.minutes * 60, () => {
    f.p = Math.min(w.data.rules.economy.cap_p ?? capP, f.p + (f.incomeP / 60) * 0.5);
    f.m = Math.min(w.data.rules.economy.cap_m ?? capM, f.m + (f.incomeM / 60) * 0.5);
  });
  const bits = (x: number): number => { let n = 0; for (let v = x; v; v &= v - 1) n++; return n; };
  return {
    winner: w.result?.winners.length === 1 ? w.result.winners[0] : null,
    endS: w.result ? w.result.tick / w.tickHz : null,
    upgradesRich: bits(f.upgrades.owned),
    upgradesPoor: bits(w.factions[1 - t.rich].upgrades.owned),
    heldRich: held(m, t.rich),
    heldPoor: held(m, 1 - t.rich),
    armyRich: armyValue(m, t.rich),
    armyPoor: armyValue(m, 1 - t.rich),
  };
}

function runMotor(t: Extract<Task, { kind: 'motor' }>): MotorResult {
  const data = loadData([...t.sets, AI_OFF]);
  const m = labMatch(data, { seed: t.seed, factions: 2 });
  const w = m.world;
  const f = w.factions[0];
  runFor(m, 30);
  if (t.motor) grantUpgrade(w, f, 'motorization');
  const exit = w.cityOf(0).exit;
  // Farthest settlement owned by us or nobody, nearer our capital than theirs (a far front of ours).
  let dest: V2 = exit;
  let best = -1;
  for (const o of w.objectives) {
    if (o.kind === 'point' || (o.owner >= 0 && o.owner !== 0)) continue;
    const d0 = dist(o.pos, w.hqPos(0));
    if (d0 < dist(o.pos, w.hqPos(1)) * 1.1 && d0 > best) { best = d0; dest = o.pos; }
  }
  const nav = w.nav(false, 35);
  const ids: number[] = [];
  for (let k = 0; k < 6; k++) {
    const p = nav.nearestPassable({ x: exit.x + (k % 3) * 12 - 12, z: exit.z + Math.floor(k / 3) * 12 }, 60) ?? exit;
    const u = w.spawnUnit(0, 'infantry', p, f.mainFront);
    u.ammo = 1;
    u.manual = { type: 'move', dest: { x: dest.x + (k % 3) * 10 - 10, z: dest.z + Math.floor(k / 3) * 10 }, arrivedAt: null, hold: true };
    ids.push(u.id);
  }
  const t0 = w.time;
  let t4: number | null = null;
  let t6: number | null = null;
  runFor(m, 2400, () => {
    let n = 0;
    for (const id of ids) {
      const u = w.unitAlive(id);
      if (u && dist(u.pos, dest) < 80) n++;
    }
    if (n >= 4 && t4 === null) t4 = w.time - t0;
    if (n >= 6 && t6 === null) t6 = w.time - t0;
  }, () => t6 !== null);
  return { t4, t6, routeM: Math.round(dist(exit, dest)) };
}

function runTask(t: Task): ValueResult | RichResult | MotorResult | EngageResult {
  return t.kind === 'value' ? runValue(t) : t.kind === 'rich' ? runRich(t) : t.kind === 'engage' ? runEngage(t) : runMotor(t);
}

const median = (xs: readonly number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const parts = argStr(args, 'parts', 'value,rich,motor').split(',');
  const seeds = argList(args, 'seeds', '7,11,13');
  const minutes = argNum(args, 'minutes', 30);
  const items = (argStr(args, 'items', UPGRADE_IDS.join(',')).split(',')) as UpgradeId[];
  const richSeeds = argList(args, 'rich-seeds', '7,11,13,17,19,23');
  const richMinutes = argNum(args, 'rich-minutes', 60);
  const jobs = argNum(args, 'jobs', 4);
  const sets = argSets(args);
  const tasks: Task[] = [];
  if (parts.includes('value')) {
    for (const seed of seeds) for (const side of [0, 1]) for (const item of ['control', ...items] as const) tasks.push({ kind: 'value', seed, item, side, minutes, sets });
  }
  if (parts.includes('rich')) for (const seed of richSeeds) for (const rich of [0, 1]) tasks.push({ kind: 'rich', seed, rich, minutes: richMinutes, sets });
  if (parts.includes('motor')) for (const seed of seeds) for (const motor of [false, true]) tasks.push({ kind: 'motor', seed, motor, sets });
  if (parts.includes('engage')) tasks.push(...engageTasks(items, argNum(args, 'trials', 10), sets));
  const t0 = Date.now();
  const res = await runParallel<Task, ValueResult | RichResult | MotorResult | EngageResult>(import.meta.url, tasks, jobs);
  const md: string[] = [`# Lab 3.0 — upgrade (${new Date().toISOString().slice(0, 16)})`, '', `sets: ${sets.join(' ') || '(shipped rules)'} · ${Math.round((Date.now() - t0) / 1000)} s wall`, ''];
  const json: Record<string, unknown> = { tasks, res };

  if (parts.includes('value')) {
    const control = new Map<string, number>();
    tasks.forEach((t, i) => { if (t.kind === 'value' && t.item === 'control') control.set(`${t.seed}|${t.side}`, (res[i] as ValueResult).score); });
    const rows: { item: string; cost: number; ratio: number; wins: number; n: number; deltas: number[] }[] = [];
    for (const item of items) {
      const deltas: number[] = [];
      let cost = 0;
      let wins = 0;
      tasks.forEach((t, i) => {
        if (t.kind !== 'value' || t.item !== item) return;
        const r = res[i] as ValueResult;
        cost = r.cost;
        deltas.push(r.score - (control.get(`${t.seed}|${t.side}`) ?? 0));
        if (r.winner === t.side) wins++;
      });
      rows.push({ item, cost, ratio: 1 + mean(deltas) / Math.max(1, cost), wins, n: deltas.length, deltas });
    }
    const med = median(rows.map((r) => r.ratio));
    md.push('## (a) value per cost, 1v1 equal resources', '', `${seeds.join(',')} × both sides, ${minutes} min. Control score is the same seed/side with no item and no bank. Median value/cost ${med.toFixed(2)}; band 0.6–1.6 × median = ${(0.6 * med).toFixed(2)}–${(1.6 * med).toFixed(2)}.`, '');
    md.push(mdTable(['item', 'cost P+M', 'mean Δscore', '± s.e.', 'value/cost', '± s.e.', '÷ median', 'in band', 'A wins'], rows.map((r) => [r.item, r.cost, Math.round(mean(r.deltas)), Math.round(stdErr(r.deltas)), r.ratio, stdErr(r.deltas) / Math.max(1, r.cost), r.ratio / med, r.ratio >= 0.6 * med && r.ratio <= 1.6 * med ? 'yes' : 'NO', `${r.wins}/${r.n}`])), '');
    json.value = { median: med, rows };
  }
  if (parts.includes('rich')) {
    const rr = tasks.map((t, i) => [t, res[i]] as const).filter(([t]) => t.kind === 'rich') as [Extract<Task, { kind: 'rich' }>, RichResult][];
    const wins = rr.filter(([t, r]) => r.winner === t.rich);
    const times = wins.map(([, r]) => r.endS!).filter((x) => x !== null);
    md.push('## (b) rich (1.5× income) vs poor, AI research on', '', `${richSeeds.join(',')} × both sides, up to ${richMinutes} min.`, '');
    md.push(mdTable(['seed', 'rich side', 'winner', 'end (min)', 'upgrades rich', 'upgrades poor', 'held rich:poor', 'army rich:poor'], rr.map(([t, r]) => [t.seed, t.rich, r.winner ?? '—', r.endS === null ? '—' : r.endS / 60, r.upgradesRich, r.upgradesPoor, `${r.heldRich}:${r.heldPoor}`, `${r.armyRich}:${r.armyPoor}`])), '');
    const ahead = rr.filter(([t, r]) => r.winner === t.rich || (r.winner === null && r.heldRich + r.armyRich / 1000 > r.heldPoor + r.armyPoor / 1000));
    md.push(`Rich side ahead at the end (won, or more settlements + army value / 1000): ${ahead.length}/${rr.length}.`, '');
    md.push(`Rich side wins ${wins.length}/${rr.length} (${Math.round((100 * wins.length) / Math.max(1, rr.length))} %), poor side ${rr.filter(([t, r]) => r.winner !== null && r.winner !== t.rich).length}; median rich win time ${times.length ? (median(times) / 60).toFixed(1) : '—'} min.`, '');
    json.rich = { wins: wins.length, n: rr.length, medianWinS: median(times) };
  }
  if (parts.includes('motor')) {
    const mr = tasks.map((t, i) => [t, res[i]] as const).filter(([t]) => t.kind === 'motor') as [Extract<Task, { kind: 'motor' }>, MotorResult][];
    md.push('## (c) full motorization: reinforcing a far front', '', '6 rifle squads from the capital exit to the farthest own-side settlement (manual move).', '');
    md.push(mdTable(['seed', 'motorized', 'route (m)', '4 of 6 (s)', '6 of 6 (s)'], mr.map(([t, r]) => [t.seed, t.motor ? 'yes' : 'no', r.routeM, r.t4 ?? '—', r.t6 ?? '—'])), '');
    const avg = (mot: boolean): number => mean(mr.filter(([t, r]) => t.motor === mot && r.t4 !== null).map(([, r]) => r.t4!));
    md.push(`Mean time to 4 of 6: foot ${Math.round(avg(false))} s, motorized ${Math.round(avg(true))} s.`, '');
  }
  if (parts.includes('engage')) {
    const et = tasks.map((t, i) => [t, res[i]] as const).filter(([t]) => t.kind === 'engage') as [EngageTask, EngageResult][];
    const rows = engageRows(et.map(([t]) => t), et.map(([, r]) => r));
    const med = median(rows.map((r) => r.ratio));
    const ctrl = et.filter(([t, r]) => t.item === 'control' && r.ok);
    md.push('## (d) single engagements (fixed armies, paired with a no-item control)', '', `${argNum(args, 'trials', 10)} trials per item; valid controls ${ctrl.length}. Median value/cost ${med.toFixed(2)}; band 0.6–1.6 × median = ${(0.6 * med).toFixed(2)}–${(1.6 * med).toFixed(2)}. "kit uses" = attached-gun shots + AP grenades thrown (side A, all trials).`, '');
    md.push(mdTable(['item', 'scenario', 'cost P+M', 'mean Δnet', '± s.e.', 'value/cost', '÷ median', 'in band', 'kit uses', 'n'], rows.map((r) => [r.item, r.scenario, r.cost, Math.round(r.delta), Math.round(r.se), r.ratio, r.ratio / med, r.ratio >= 0.6 * med && r.ratio <= 1.6 * med ? 'yes' : 'NO', r.kit, r.n])), '');
    json.engage = { median: med, rows };
  }
  const base = writeReport('upgrade', json, md.join('\n'));
  console.log(md.join('\n'));
  console.log(`\nreport: ${base}.md`);
}

if (isWorker()) workerLoop(runTask);
else void main();
