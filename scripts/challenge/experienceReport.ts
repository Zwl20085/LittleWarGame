// Challenge lab: the player-experience report (markdown + JSON) per scenario, from the per-match
// ExperienceLogs. One summary score per scenario with explicit pass/fail bands (experience.ts).
import { BANDS, evaluateMatch, median, verdictOf, type Band, type MatchExperience, type Scored } from './experience';
import type { Row } from './report';

const fmt = (x: number, d = 0): string => (Number.isFinite(x) ? x.toFixed(d) : '-');
const mmss = (s: number): string => (!Number.isFinite(s) || s < 0 ? '-' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(0)} %` : '-');
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export interface MatchEval { readonly row: Row; readonly ev: MatchExperience }

export interface ScenarioSummary {
  readonly label: string;
  readonly n: number;
  readonly score: number;
  readonly verdict: 'PASS' | 'WARN' | 'FAIL';
  readonly aiSurvival: number;
  /** Capitals taken by the challenger (all matches) and capitals fallen to anyone. */
  readonly challengerCaptures: number;
  readonly capitalFalls: number;
  /** Warning seconds of the capital losses (min / median), and how many were never seen. */
  readonly minWarnS: number;
  readonly medianWarnS: number;
  readonly neverSeen: number;
  readonly cheapFlags: number;
  readonly dominatedShare: number;
  readonly leadChanges: number;
  readonly giniAt30: number;
  readonly firstContactS: number;
  readonly firstCapitalLostS: number;
  readonly eliminationsPerHour: number;
  readonly undecided: number;
  readonly idleShare: number;
  readonly stuckShare: number;
  readonly starvedShare: number;
  readonly scored: Scored[];
}

export function evaluate(rows: Row[]): MatchEval[] {
  return rows.flatMap((row) => (row.r.experience ? [{ row, ev: evaluateMatch(row.r.experience) }] : []));
}

export function summarise(evals: MatchEval[]): ScenarioSummary[] {
  const labels = [...new Set(evals.map((e) => e.row.label))];
  return labels.map((label) => {
    const es = evals.filter((e) => e.row.label === label);
    const rs = es.map((e) => e.row.r);
    const lossWarn = es.flatMap((e) => e.ev.warn.filter((x) => x.tookCapital));
    const warnVals = lossWarn.map((x) => (x.seen ? x.warnS : 0));
    // Mean of the matches' band values per metric, re-banded: one verdict per scenario.
    const names = es[0].ev.scored.map((s) => s.name);
    const scored: Scored[] = names.map((name, i) => {
      const vals = es.map((e) => e.ev.scored[i].value).filter((v) => Number.isFinite(v));
      const bands = es.map((e) => e.ev.scored[i].band);
      const worst: Band = bands.includes('fail') && bands.filter((b) => b === 'fail').length * 2 >= bands.length ? 'fail' : bands.includes('fail') || bands.includes('warn') ? 'warn' : 'pass';
      return { name, value: mean(vals), band: worst, weight: es[0].ev.scored[i].weight };
    });
    const score = Math.round(mean(es.map((e) => e.ev.score)));
    return {
      label, n: es.length, score, verdict: verdictOf(score),
      aiSurvival: rs.filter((r) => r.captures.length === 0).length / rs.length,
      challengerCaptures: rs.reduce((a, r) => a + r.captures.length, 0),
      capitalFalls: es.reduce((a, e) => a + e.row.r.experience!.falls.length, 0),
      minWarnS: warnVals.length ? Math.min(...warnVals) : NaN, medianWarnS: median(warnVals),
      neverSeen: lossWarn.filter((x) => !x.seen).length,
      cheapFlags: es.reduce((a, e) => a + e.ev.cheap.filter((c) => c.flagged).length, 0),
      dominatedShare: mean(es.map((e) => e.ev.oneSided.dominatedShare)), leadChanges: mean(es.map((e) => e.ev.oneSided.leadChanges)),
      giniAt30: mean(es.map((e) => e.ev.oneSided.gini[1]?.g ?? NaN).filter(Number.isFinite)),
      firstContactS: mean(es.map((e) => e.ev.pacing.firstContactS).filter((x) => x >= 0)),
      firstCapitalLostS: mean(es.map((e) => e.ev.pacing.firstCapitalLostS).filter((x) => x >= 0)),
      eliminationsPerHour: mean(es.map((e) => e.ev.pacing.eliminationsPerHour)),
      undecided: es.filter((e) => e.ev.pacing.undecided).length,
      idleShare: mean(es.map((e) => e.ev.health.idleShare)), stuckShare: mean(es.map((e) => e.ev.health.stuckShare)), starvedShare: mean(es.map((e) => e.ev.health.starvedShare)),
      scored,
    };
  });
}

function summaryTable(ss: ScenarioSummary[]): string {
  const head = '| scenario | n | score | verdict | AI survival | capitals taken by challenger | capital falls (all) | warning s (min / median) | never seen | cheap-win flags | dominated (> 70 %) | lead changes | territory Gini 30 min | first contact | first capital lost | elim / h | undecided | idle far | stuck | starved |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const lines = ss.map((s) => `| ${s.label} | ${s.n} | ${s.score} | ${s.verdict} | ${pct(s.aiSurvival)} | ${s.challengerCaptures} | ${s.capitalFalls} | ${fmt(s.minWarnS)} / ${fmt(s.medianWarnS)} | ${s.neverSeen} | ${s.cheapFlags} | ${pct(s.dominatedShare)} | ${fmt(s.leadChanges, 1)} | ${fmt(s.giniAt30, 2)} | ${mmss(s.firstContactS)} | ${mmss(s.firstCapitalLostS)} | ${fmt(s.eliminationsPerHour, 1)} | ${s.undecided}/${s.n} | ${pct(s.idleShare)} | ${pct(s.stuckShare)} | ${pct(s.starvedShare)} |`);
  return [head, sep, ...lines].join('\n');
}

function fallsTable(evals: MatchEval[]): string {
  const lines: string[] = [];
  for (const { row, ev } of evals) {
    const r = row.r;
    for (const c of ev.cheap) {
      const w = ev.warn.find((x) => x.defender === c.capital && x.attacker === c.by);
      lines.push(`| ${row.label} | ${r.seed} | F${c.by} took F${c.capital}${c.by === r.challenger ? ' (challenger)' : ''} | ${mmss(c.t)} | ${pct(c.shareOfArmy)} | ${fmt(c.defenderOver, 1)}x | ${w ? (w.seen ? fmt(w.warnS) : 'never seen') : '-'} | ${w ? fmt(w.reactionS) : '-'} | ${w ? fmt(w.defenderArrivalS) : '-'} | ${c.flagged ? `CHEAP: ${c.reasons.join('; ')}` : 'ok'} |`);
    }
  }
  const head = '| scenario | seed | capital fall | t | force / attacker army | defender army / force | warning s (sighting to ring) | reaction s (to alarm) | defenders in strength s | cheap-win |';
  return lines.length ? [head, '|---|---|---|---|---|---|---|---|---|---|', ...lines].join('\n') : 'No capital fell in any match.';
}

function bandsText(): string {
  const b = BANDS;
  return [
    `- dominated share of time (a side > 70 % of total army value): pass <= ${pct(b.dominatedShare.pass)}, warn <= ${pct(b.dominatedShare.warn)} (weight 2)`,
    `- territory Gini at 30 min: pass <= ${b.giniAt30.pass}, warn <= ${b.giniAt30.warn} (weight 1)`,
    '- cheap-win capital losses (force < 20 % of the attacker army, or defender army >= 3x the force): any = fail (weight 3)',
    `- warning time before a capital loss (first sighting to ring, never seen = 0): pass >= ${b.warnS.pass} s, warn >= ${b.warnS.warn} s (weight 3)`,
    `- first contact: pass ${b.firstContactS.passFrom}-${b.firstContactS.passTo} s, warn up to ${b.firstContactS.warnTo} s, < ${b.firstContactS.low} s fail (weight 1)`,
    `- first capital lost: pass >= ${b.firstCapitalLostS.pass} s, warn >= ${b.firstCapitalLostS.warn} s (weight 2)`,
    `- eliminations per hour: pass <= ${b.eliminationsPerHour.pass}, warn <= ${b.eliminationsPerHour.warn} (weight 1)`,
    `- idle far from any front: pass <= ${pct(b.idleShare.pass)}, warn <= ${pct(b.idleShare.warn)}; stuck: pass <= ${pct(b.stuckShare.pass)}, warn <= ${pct(b.stuckShare.warn)}; supply-starved: pass <= ${pct(b.starvedShare.pass)}, warn <= ${pct(b.starvedShare.warn)} (weight 1 each)`,
    '- score = weighted share of passes (warn counts half), 0-100: PASS >= 75, WARN >= 50, else FAIL',
  ].join('\n');
}

function matchTable(evals: MatchEval[]): string {
  const head = '| scenario | seed | score | verdict | dominated | lead changes | comeback deficit | Gini 15 / 30 / 45 | first contact | first town lost | first capital lost | result |';
  const lines = evals.map(({ row, ev }) => `| ${row.label} | ${row.r.seed} | ${ev.score} | ${ev.verdict} | ${pct(ev.oneSided.dominatedShare)} | ${ev.oneSided.leadChanges} | ${pct(ev.oneSided.largestComeback)} | ${ev.oneSided.gini.map((g) => fmt(g.g, 2)).join(' / ')} | ${mmss(ev.pacing.firstContactS)} | ${mmss(row.r.experience!.firstTownLostS)} | ${mmss(ev.pacing.firstCapitalLostS)} | ${ev.pacing.undecided ? `undecided @${row.r.minutes} min` : 'decided'} |`);
  return [head, '|---|---|---|---|---|---|---|---|---|---|---|---|', ...lines].join('\n');
}

export function experienceMarkdown(rows: Row[], cmdLine: string): string {
  const evals = evaluate(rows);
  const ss = summarise(evals);
  const seeds = [...new Set(rows.map((x) => x.r.seed))].join(', ');
  return [
    `# Player-experience report (seeds ${seeds})`, '',
    `Generated ${new Date().toISOString()} by \`${cmdLine}\`. Definitions: docs/CHALLENGE_LAB.md. Time series are sampled every 30 s (army value, held objectives); sightings and arrivals every second.`, '',
    '## One summary per scenario', '', summaryTable(ss), '',
    '## Capital falls: cheap-win index and warning time', '', fallsTable(evals), '',
    '## Per match', '', matchTable(evals), '',
    '## Bands', '', bandsText(), '',
  ].join('\n');
}

export function experienceJson(rows: Row[], cmdLine: string): object {
  const evals = evaluate(rows);
  return {
    generated: new Date().toISOString(), command: cmdLine, bands: BANDS,
    scenarios: summarise(evals),
    matches: evals.map(({ row, ev }) => ({
      scenario: row.label, seed: row.r.seed, minutes: row.r.minutes, mapSize: row.r.mapSize ?? 'medium', infoMode: row.r.infoMode ?? 'open',
      score: ev.score, verdict: ev.verdict, oneSided: ev.oneSided, cheap: ev.cheap, warnings: ev.warn, pacing: ev.pacing, health: ev.health,
      challengerCaptures: row.r.captures, ownLostS: row.r.ownLostS, wallS: row.r.wallS,
    })),
  };
}
