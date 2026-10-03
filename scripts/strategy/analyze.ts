// Strategy-lab analysis: pure functions from per-seed battle logs to Markdown tables.
import type { BattleSample, CaptureRecord, DirectiveRecord, EngagementRecord, OpRecord } from '../../src/sim/events';

export interface RunData {
  seed: number;
  baseline: boolean;
  minutes: number;
  wallS: number;
  result: { winners: number[]; reason: string; t: number } | null;
  factions: { id: number; personality: string; alive: boolean; held: number; value: number; lost: number; built: number }[];
  objectives: number;
  log: {
    ops: OpRecord[];
    directives: DirectiveRecord[];
    engagements: EngagementRecord[];
    captures: CaptureRecord[];
    samples: BattleSample[];
    skirmishes: number;
  };
}

const pct = (a: number, b: number): string => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : '-');
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '-');
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function table(head: string[], rows: (string | number)[][]): string {
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

/** Op joined with the engagements fought at its target while it ran. */
interface OpX {
  op: OpRecord;
  seed: number;
  dur: number;
  won: boolean;
  enemyLoss: number;
  ownLoss: number;
}

function joinOps(runs: RunData[]): OpX[] {
  const out: OpX[] = [];
  for (const r of runs) {
    for (const op of r.log.ops) {
      if (op.outcome === 'open') continue; // censored by the end of the run
      let enemyLoss = 0;
      let ownLoss = op.loss;
      for (const e of r.log.engagements) {
        if (e.area !== op.area || e.t1 < op.t0 || e.t0 > op.t1) continue;
        for (const [k, s] of Object.entries(e.sides)) if (Number(k) !== op.f) enemyLoss += s.loss;
        ownLoss = Math.max(ownLoss, e.sides[op.f]?.loss ?? 0);
      }
      out.push({ op, seed: r.seed, dur: op.t1 - op.t0, won: op.outcome === 'won', enemyLoss, ownLoss });
    }
  }
  return out;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k) ?? [];
    arr.push(x);
    m.set(k, arr);
  }
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function opRow(name: string, xs: OpX[]): (string | number)[] {
  const won = xs.filter((x) => x.won).length;
  const el = xs.reduce((a, x) => a + x.enemyLoss, 0);
  const ol = xs.reduce((a, x) => a + x.ownLoss, 0);
  const mins = xs.reduce((a, x) => a + x.dur, 0) / 60;
  return [name, xs.length, won, pct(won, xs.length), f1(mean(xs.map((x) => x.dur))), mins > 0 ? f2(won / mins) : '-', ol > 0 ? f2(el / ol) : '-', f1(mean(xs.map((x) => Math.min(x.op.ratio, 50))))];
}

const OP_HEAD = ['group', 'ops', 'won', 'success', 'mean dur (s)', 'captures / group-min', 'loss ratio (enemy/own)', 'mean force ratio (capped 50)'];

export function ratioBucket(op: OpRecord): string {
  if (op.theirs < 50) return '0 unopposed';
  const r = op.ratio;
  return r < 0.5 ? '1 <0.5' : r < 1 ? '2 0.5–1' : r < 2 ? '3 1–2' : r < 4 ? '4 2–4' : '5 ≥4';
}

function opsSection(xs: OpX[]): string[] {
  const out: string[] = [];
  out.push('### Operations by kind × doctrine', '', table(OP_HEAD, [...groupBy(xs, (x) => `${x.op.op} · ${x.op.doctrine}`)].map(([k, v]) => opRow(k, v))), '');
  out.push('### Operations by kind', '', table(OP_HEAD, [...groupBy(xs, (x) => x.op.op)].map(([k, v]) => opRow(k, v))), '');
  out.push('### Success by force ratio at launch (group value ÷ known enemy value within 260 m of the target)', '',
    table(OP_HEAD, [...groupBy(xs, (x) => ratioBucket(x.op))].map(([k, v]) => opRow(k.slice(2), v))), '');
  out.push('### Success by force ratio × op kind', '',
    table(OP_HEAD, [...groupBy(xs, (x) => `${ratioBucket(x.op)} · ${x.op.op}`)].map(([k, v]) => opRow(k.slice(2), v))), '');
  out.push('### Success by terrain context (river / pass crossing on the way, town assault, open ground)', '',
    table(OP_HEAD, [...groupBy(xs, (x) => x.op.terrain)].map(([k, v]) => opRow(k, v))), '');
  out.push('### Success by target kind', '', table(OP_HEAD, [...groupBy(xs, (x) => `${x.op.targetKind}${x.op.targetOwner < 0 ? ' (neutral)' : ' (held)'}`)].map(([k, v]) => opRow(k, v))), '');
  // Wasted ops: outcomes.
  const outcomes = groupBy(xs, (x) => x.op.outcome);
  out.push('### Op outcomes (wasted = noForce / unreachable / timeout / spent)', '',
    table(['outcome', 'ops', 'share', 'mean dur (s)', 'mean own loss'], [...outcomes].map(([k, v]) => [k, v.length, pct(v.length, xs.length), f1(mean(v.map((x) => x.dur))), f1(mean(v.map((x) => x.ownLoss)))])), '');
  const byKindOutcome = groupBy(xs, (x) => x.op.op);
  const kinds = [...new Set(xs.map((x) => x.op.outcome))].sort();
  out.push('### Outcome mix per op kind', '', table(['op', ...kinds], [...byKindOutcome].map(([k, v]) => [k, ...kinds.map((o) => v.filter((x) => x.op.outcome === o).length)])), '');
  return out;
}

function engagementSection(runs: RunData[]): string[] {
  const all = runs.flatMap((r) => r.log.engagements);
  const sk = runs.reduce((a, r) => a + r.log.skirmishes, 0);
  const rows = [...groupBy(all, (e) => `${e.kind} · ${e.outcome}`)].map(([k, v]) => {
    const loss = v.map((e) => Object.values(e.sides).reduce((a, s) => a + s.loss, 0));
    const killed = v.map((e) => Object.values(e.sides).reduce((a, s) => a + s.killed, 0));
    return [k, v.length, f1(mean(v.map((e) => e.t1 - e.t0))), f1(mean(loss)), f1(mean(killed)), f1(mean(v.map((e) => Object.keys(e.sides).length)))];
  });
  const out = ['### Engagements', '', `${all.length} engagements stored, ${sk} skirmishes (< 60 HP) dropped.`, '',
    table(['kind · outcome', 'n', 'mean dur (s)', 'mean value lost', 'mean units killed', 'sides'], rows), ''];
  // Attacker vs holder peak ratio vs outcome (settlements with a holder).
  const sett = all.filter((e) => e.kind === 'settlement' && e.holder >= 0);
  const bucket = (e: EngagementRecord): string => {
    const hold = e.sides[e.holder]?.peak ?? 0;
    const att = Math.max(0, ...Object.entries(e.sides).filter(([k]) => Number(k) !== e.holder).map(([, s]) => s.peak));
    const r = att / (hold + 1);
    return r < 0.5 ? '1 <0.5' : r < 1 ? '2 0.5–1' : r < 2 ? '3 1–2' : r < 4 ? '4 2–4' : '5 ≥4';
  };
  out.push('### Held settlements attacked: peak attacker ÷ holder value vs result', '',
    table(['ratio', 'n', 'captured', 'repulsed', 'stalemate', 'mean dur (s)'], [...groupBy(sett, bucket)].map(([k, v]) => [k.slice(2), v.length, pct(v.filter((e) => e.outcome === 'captured').length, v.length), pct(v.filter((e) => e.outcome === 'repulsed').length, v.length), pct(v.filter((e) => e.outcome === 'stalemate').length, v.length), f1(mean(v.map((e) => e.t1 - e.t0)))])), '');
  return out;
}

function directiveSection(runs: RunData[]): string[] {
  const all = runs.flatMap((r) => r.log.directives);
  const rows = [...groupBy(all, (d) => d.kind)].map(([k, v]) => {
    const res = (x: string): number => v.filter((d) => d.result === x).length;
    const ttc = v.filter((d) => d.result === 'captured').map((d) => d.resolvedAt - d.t);
    return [k, v.length, f1(mean(v.map((d) => d.n))), pct(res('captured'), v.length), pct(res('held'), v.length), pct(res('lost'), v.length), pct(res('expired'), v.length), f1(mean(ttc))];
  });
  return ['### High-command directives (follow-through)', '', table(['kind', 'issued', 'mean units', 'captured', 'held', 'lost', 'expired', 'mean time to capture (s)'], rows), ''];
}

function factionSection(runs: RunData[], xs: OpX[]): string[] {
  const out: string[] = [];
  const rows: (string | number)[][] = [];
  const byP = new Map<string, { seeds: number; wins: number; held: number; value: number; lost: number; caps: number; ops: number; won: number; stuck: number[]; idle: number[]; fight: number[]; hold: number[] }>();
  for (const r of runs) {
    const lead = leaderOf(r);
    for (const f of r.factions) {
      const a = byP.get(f.personality) ?? { seeds: 0, wins: 0, held: 0, value: 0, lost: 0, caps: 0, ops: 0, won: 0, stuck: [], idle: [], fight: [], hold: [] };
      a.seeds++;
      if (lead.includes(f.id)) a.wins += 1 / lead.length;
      a.held += f.held;
      a.value += f.value;
      a.lost += f.lost;
      a.caps += r.log.captures.filter((c) => c.to === f.id).length;
      const mine = xs.filter((x) => x.seed === r.seed && x.op.f === f.id);
      a.ops += mine.length;
      a.won += mine.filter((x) => x.won).length;
      for (const s of r.log.samples) {
        const fs = s.f[f.id];
        if (!fs || fs.units === 0) continue;
        a.stuck.push(fs.stuck / fs.units);
        a.idle.push(fs.idle / fs.units);
        a.fight.push(fs.fighting / fs.units);
        const secs = Object.values(fs.modes).reduce((x, y) => x + y, 0) || 1;
        a.hold.push((fs.modes.hold ?? 0) / secs);
      }
      byP.set(f.personality, a);
    }
  }
  for (const [p, a] of [...byP.entries()].sort()) {
    rows.push([p, a.seeds, f1(a.wins), pct(a.wins, a.seeds), f1(a.held / a.seeds), f1(a.value / a.seeds), f1(a.lost / a.seeds), a.caps, a.lost > 0 ? f1((a.caps / a.lost) * 100) : '-', a.ops > 0 ? f2(a.caps / a.ops) : '-', pct(mean(a.stuck), 1), pct(mean(a.idle), 1), pct(mean(a.fight), 1), pct(mean(a.hold), 1)]);
  }
  out.push('### Doctrines (faction personality): standing at the end, capture efficiency, stuck / idle time', '',
    'Leader = match winner, else most settlements held, then army value. stuck = has a path but moved < 3 m in 10 s while not fighting; idle = line unit not moving and not fighting; hold = share of army-group time in hold mode.', '',
    table(['doctrine', 'matches', 'leads', 'lead rate', 'held at end', 'army value', 'units lost', 'captures', 'captures / 100 lost', 'captures / op', 'stuck', 'idle', 'fighting', 'hold mode'], rows), '');
  // Why the groups wait.
  const reasons = new Map<string, number>();
  let n = 0;
  for (const r of runs) for (const s of r.log.samples) for (const fs of s.f) for (const [k, v] of Object.entries(fs.reasons)) { reasons.set(k, (reasons.get(k) ?? 0) + v); n += v; }
  out.push('### Army-group reasons (share of group-samples)', '', table(['reason', 'share'], [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, pct(v, n)])), '');
  return out;
}

/** Winner, else most settlements held, then army value. */
export function leaderOf(r: RunData): number[] {
  if (r.result && r.result.winners.length) return r.result.winners;
  const alive = r.factions.filter((f) => f.alive);
  alive.sort((a, b) => b.held - a.held || b.value - a.value);
  return alive.length ? [alive[0].id] : [];
}

function runsSection(runs: RunData[]): string[] {
  return ['### Runs', '', table(['seed', 'minutes', 'result', 'held per faction (personality)', 'captures', 'ops', 'engagements'], runs.map((r) => [
    r.seed, f1(r.minutes), r.result ? `${r.result.reason} → ${r.result.winners.join(',')} @ ${(r.result.t / 60).toFixed(1)} min` : 'running',
    r.factions.map((f) => `${f.id}:${f.personality} ${f.held}${f.alive ? '' : '†'}`).join(', '), r.log.captures.length, r.log.ops.length, r.log.engagements.length,
  ])), ''];
}

export function analyze(runs: RunData[]): string {
  const xs = joinOps(runs);
  return [...runsSection(runs), ...opsSection(xs), ...engagementSection(runs), ...directiveSection(runs), ...factionSection(runs, xs)].join('\n');
}

/** Headline metrics for the before/after table. */
export function headline(runs: RunData[]): Record<string, number> {
  const xs = joinOps(runs);
  const caps = runs.reduce((a, r) => a + r.log.captures.length, 0);
  const lost = runs.reduce((a, r) => a + r.factions.reduce((s, f) => s + f.lost, 0), 0);
  const wasted = xs.filter((x) => ['noForce', 'unreachable', 'timeout', 'spent', 'abort'].includes(x.op.outcome)).length;
  const el = xs.reduce((a, x) => a + x.enemyLoss, 0);
  const ol = xs.reduce((a, x) => a + x.ownLoss, 0);
  const occ = runs.flatMap((r) => r.log.directives).filter((d) => d.kind === 'occupy');
  const samples = runs.flatMap((r) => r.log.samples.flatMap((s) => s.f)).filter((s) => s.units > 0);
  const leads = new Map<string, number>();
  for (const r of runs) for (const id of leaderOf(r)) {
    const p = r.factions[id]?.personality ?? '?';
    leads.set(p, (leads.get(p) ?? 0) + 1 / leaderOf(r).length);
  }
  return {
    'ops (closed)': xs.length,
    'op success rate %': xs.length ? (xs.filter((x) => x.won).length / xs.length) * 100 : 0,
    'op captures per group-min': xs.reduce((a, x) => a + x.dur, 0) > 0 ? xs.filter((x) => x.won).length / (xs.reduce((a, x) => a + x.dur, 0) / 60) : 0,
    'value lost in failed ops (k)': xs.filter((x) => ['timeout', 'spent'].includes(x.op.outcome)).reduce((a, x) => a + x.ownLoss, 0) / 1000 / runs.length,
    'wasted ops %': xs.length ? (wasted / xs.length) * 100 : 0,
    'op loss ratio (enemy/own)': ol > 0 ? el / ol : 0,
    'captures per match': caps / runs.length,
    'captures per 100 units lost': lost > 0 ? (caps / lost) * 100 : 0,
    'units lost per match': lost / runs.length,
    'occupy directives → captured %': occ.length ? (occ.filter((d) => d.result === 'captured').length / occ.length) * 100 : 0,
    'stuck share %': mean(samples.map((s) => s.stuck / s.units)) * 100,
    'idle share %': mean(samples.map((s) => s.idle / s.units)) * 100,
    'fighting share %': mean(samples.map((s) => s.fighting / s.units)) * 100,
    'max doctrine lead rate %': runs.length ? (Math.max(0, ...leads.values()) / runs.length) * 100 : 0,
    'eliminations per match': runs.reduce((a, r) => a + r.factions.filter((f) => !f.alive).length, 0) / runs.length,
  };
}

export function compareTable(before: RunData[], after: RunData[]): string {
  const a = headline(before);
  const b = headline(after);
  return table(['metric', 'baseline', 'adaptive', 'Δ'], Object.keys(a).map((k) => [k, f1(a[k]), f1(b[k]), f1(b[k] - a[k])]));
}
