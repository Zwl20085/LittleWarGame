// Challenge lab: Markdown report and console summary from per-match ChallengeReports.
import type { AiDefence, ChallengeReport } from './types';

const mmss = (s: number): string => (!Number.isFinite(s) || s < 0 ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x: number, d = 0): string => (Number.isFinite(x) ? x.toFixed(d) : '—');

export const label = (r: ChallengeReport, rushAt: number): string => (r.strategy === 'rush' ? `rush@${Math.round(rushAt / 60)}m` : r.strategy);

/** The AI faction the match is about: the capital the strategy attacked, else the nearest. */
export const targetOf = (r: ChallengeReport): AiDefence => r.ai.find((a) => a.id === (r.attackTarget >= 0 ? r.attackTarget : r.nearestAi)) ?? r.ai[0];

export interface Row { readonly label: string; readonly r: ChallengeReport }

export interface Aggregate {
  readonly label: string;
  readonly n: number;
  readonly aiSurvival: number;
  readonly ownLost: number;
  readonly attackS: number;
  readonly arrivalS: number;
  readonly alarmDelayS: number;
  readonly alarmBeforeArrival: number;
  readonly defenceRatio: number;
  readonly firstCaptureS: number;
  readonly alarmShare: number;
  readonly maxProgress: number;
  readonly verdict: string;
}

export function aggregate(rows: Row[]): Aggregate[] {
  const labels = [...new Set(rows.map((x) => x.label))];
  return labels.map((lb) => {
    const rs = rows.filter((x) => x.label === lb).map((x) => x.r);
    const survived = rs.filter((r) => r.captures.length === 0).length;
    const tg = rs.map(targetOf);
    const attack = rs.filter((r) => r.attackS >= 0);
    const delays = rs.flatMap((r) => {
      const a = targetOf(r);
      return r.attackS >= 0 && a.firstAlarmAfterAttackS >= 0 ? [a.firstAlarmAfterAttackS - r.attackS] : [];
    });
    const arrived = tg.filter((a) => a.arrivalS >= 0);
    const aiSurvival = rs.length ? survived / rs.length : NaN;
    const verdict = aiSurvival >= 1 ? 'AI holds' : aiSurvival >= 0.5 ? 'AI shaky — loses some seeds' : 'AI BEATEN — loses most seeds';
    return {
      label: lb, n: rs.length, aiSurvival,
      ownLost: rs.filter((r) => r.ownLostS >= 0).length,
      attackS: mean(attack.map((r) => r.attackS)),
      arrivalS: mean(arrived.map((a) => a.arrivalS)),
      alarmDelayS: mean(delays),
      alarmBeforeArrival: arrived.filter((a) => a.firstAlarmAfterAttackS >= 0 && a.firstAlarmAfterAttackS <= a.arrivalS).length,
      defenceRatio: mean(arrived.filter((a) => a.attackerAtArrival > 0).map((a) => a.defenceAtArrival / a.attackerAtArrival)),
      firstCaptureS: mean(rs.flatMap((r) => (r.captures.length ? [r.captures[0].t] : []))),
      alarmShare: mean(tg.map((a) => a.alarmShare)),
      maxProgress: Math.max(0, ...tg.map((a) => a.maxProgress)),
      verdict,
    };
  });
}

export function summaryTable(aggs: Aggregate[]): string {
  const head = '| strategy | n | AI survival | challenger capital lost | mean attack | mean arrival | alarm delay after attack (s) | alarm ≤ arrival | defence ÷ attacker at arrival | mean first capital taken | target alarm on (share of time) | max capture progress (s) | verdict |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = aggs.map((a) => `| ${a.label} | ${a.n} | ${fmt(a.aiSurvival * 100)} % | ${a.ownLost}/${a.n} | ${mmss(a.attackS)} | ${mmss(a.arrivalS)} | ${fmt(a.alarmDelayS)} | ${a.alarmBeforeArrival} | ${fmt(a.defenceRatio, 2)} | ${mmss(a.firstCaptureS)} | ${fmt(a.alarmShare * 100)} % | ${a.maxProgress} | ${a.verdict} |`);
  return [head, sep, ...lines].join('\n');
}

function matchTable(rows: Row[]): string {
  const head = '| strategy | seed | attack (on) | target: arrival | first alarm (any) | alarm after attack | alarm on (share, onsets) | max level | groups recalled (peak) | works at capital (peak) | defence / attacker at arrival | peak attacker ≤ 600 m | max progress (s) | garrison ≤ 250 m (eligible infantry at the HQ point) at arrival | alarm on at arrival | AI fronts on my capital (first / after attack) | challenger took | challenger capital lost | units lost me / target | result |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = rows.map(({ label: lb, r }) => {
    const a = targetOf(r);
    const counter = r.ai.filter((x) => x.counterAttackS >= 0).map((x) => `F${x.id}@${mmss(x.counterAttackS)}${x.counterAfterAttackS >= 0 ? `/${mmss(x.counterAfterAttackS)}` : ''}`).join(' ') || '—';
    const took = r.captures.map((c) => `F${c.capital}@${mmss(c.t)}`).join(' ') || '—';
    const own = r.ownLostS >= 0 ? `${mmss(r.ownLostS)} by F${r.ownLostTo}` : '—';
    const works = Object.entries(a.worksKinds).map(([k, n]) => `${k} ${n}`).join(', ');
    const res = r.result ? `${r.result.reason}: F${r.result.winners.join('/')} @${mmss(r.result.t)}` : `open @${r.minutes} min`;
    return `| ${lb} | ${r.seed} | ${mmss(r.attackS)}${r.attackTarget >= 0 ? ` (F${r.attackTarget})` : ''} | F${a.id} ${mmss(a.arrivalS)} | ${mmss(a.firstAlarmS)} | ${mmss(a.firstAlarmAfterAttackS)} | ${fmt(a.alarmShare * 100)} %, ${a.alarmOnsets} | ${a.maxLevel.toFixed(2)} | ${a.groupsRecalled} (${a.peakRecalled}) | ${a.worksPeak}${works ? ` (${works})` : ''} | ${a.arrivalS >= 0 ? `${a.defenceAtArrival} / ${a.attackerAtArrival}` : '—'} | ${a.peakAttacker}${a.peakAttackerS >= 0 ? ` @${mmss(a.peakAttackerS)}` : ''} | ${a.maxProgress} / ${r.captureSeconds} | ${a.arrivalS >= 0 ? `${a.garrisonAtArrival} (${a.holdersAtArrival} at HQ)` : '—'} | ${a.arrivalS >= 0 ? (a.alarmActiveAtArrival ? `yes (${a.recalledAtArrival} rec.)` : 'NO') : '—'} | ${counter} | ${took} | ${own} | ${r.challengerUnitsLost} / ${a.unitsLost} | ${res} |`;
  });
  return [head, sep, ...lines].join('\n');
}

function heldTable(rows: Row[]): string {
  const out: string[] = ['| strategy | seed | settlements held F0 / F1 / F2 / F3 every 5 min |', '|---|---|---|'];
  for (const { label: lb, r } of rows) {
    const s = r.held.filter((h) => h.t > 0).map((h) => `${h.t / 60}′ ${h.byFaction.join('/')}`).join(' · ');
    out.push(`| ${lb} | ${r.seed} | ${s} |`);
  }
  return out.join('\n');
}

function timeline(lb: string, r: ChallengeReport, a: AiDefence): string {
  const head = `### ${lb} seed ${r.seed} — F${a.id} (${a.personality})${a.lostS >= 0 ? `, capital lost ${mmss(a.lostS)} to F${a.lostTo}` : ''}`;
  const rows = a.trace
    .filter((p) => r.attackS < 0 || p.t >= r.attackS - 60)
    .map((p) => `| ${mmss(p.t)} | ${p.level.toFixed(2)} | ${p.on ? 'on' : '—'} | ${p.forecast} | ${p.eta} | ${p.recalled} | ${p.garrison} | ${p.works} | ${p.defence} | ${p.att600} | ${p.att1500} | ${p.home1500} | ${p.army} | ${p.myArmy} | ${p.progress} | ${p.holders} / ${p.raiders} |`);
  return [head, '', '| t | level | alarm | forecast | eta | recalled | garrison | works | defence (storm) | challenger ≤ 600 m | ≤ 1 500 m | AI home ≤ 1 500 m | AI army | challenger army | progress | HQ point holders AI / challenger |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

/** Timelines: every capital the challenger took, then the closest calls (most capture progress). */
function timelines(rows: Row[]): string {
  const lost = rows.flatMap(({ label: lb, r }) => r.ai.filter((a) => a.lostTo === r.challenger).map((a) => ({ lb, r, a })));
  const close = rows
    .flatMap(({ label: lb, r }) => r.ai.filter((a) => a.lostTo !== r.challenger && a.maxProgress > 0).map((a) => ({ lb, r, a })))
    .sort((x, y) => y.a.maxProgress - x.a.maxProgress)
    .slice(0, 2);
  const all = [...lost, ...close];
  return all.length ? all.map((x) => timeline(x.lb, x.r, x.a)).join('\n\n') : 'No AI capital fell to the challenger and none saw challenger capture progress.';
}

export function markdown(rows: Row[], cmdLine: string): string {
  const aggs = aggregate(rows);
  const fails = new Map<string, number>();
  for (const { r } of rows) for (const [k, n] of Object.entries(r.commandsFailed)) fails.set(k, (fails.get(k) ?? 0) + n);
  const seeds = [...new Set(rows.map((x) => x.r.seed))].join(', ');
  return [
    `# Challenge lab — scripted supreme HQ vs the AI (seeds ${seeds})`, '',
    `Generated ${new Date().toISOString()} by \`${cmdLine}\`. Challenger = slot ${rows[0]?.r.challenger ?? 0} (player faction, orders via CommandBus only); the other 3 factions are the normal AI. See docs/CHALLENGE_LAB.md.`, '',
    '## Summary per strategy', '',
    'AI survival = share of matches in which the challenger took **no** AI capital within the cap. Alarm delay = first `homeThreat.active` of the attacked AI after the strategy launched its capital attack. Arrival = challenger ≥ 300 value within 600 m of that capital, or capture progress.', '',
    summaryTable(aggs), '',
    '## Per match (target = the AI whose capital the strategy attacked, else the nearest AI)', '',
    matchTable(rows), '',
    '## Timelines (every 30 s from 1 min before the attack, every 5 s while the challenger is at the gates): captures, then the two closest calls', '',
    timelines(rows), '',
    '## Settlements held over time', '',
    heldTable(rows), '',
    '## Rejected commands', '',
    fails.size ? [...fails].map(([k, n]) => `- ${k}: ${n}`).join('\n') : 'none', '',
  ].join('\n');
}
