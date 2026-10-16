// Player-experience metrics (V23_SPEC §1.2, V30_SPEC §12): pure functions over logged time series.
// The collector (expLog.ts) fills `ExperienceLog` from a running world; nothing here touches the sim.

/** One sample every 30 s: army value, territory (held objectives) and alive flag per faction. */
export interface ExpSample {
  readonly t: number;
  readonly army: number[];
  readonly terr: number[];
  readonly alive: boolean[];
}

/** Engagement health, sampled every 30 s over all combat units of all factions. */
export interface HealthSample {
  readonly t: number;
  readonly units: number;
  readonly idleFar: number;
  readonly stuck: number;
  readonly starved: number;
}

/** A capital that fell: the capturing force and both armies one second before it fell. */
export interface FallRecord {
  readonly capital: number;
  /** Capturing faction (-1 = unknown). */
  readonly by: number;
  readonly t: number;
  /** Capturer's combat value within the ring of the capital. */
  readonly force: number;
  readonly attArmy: number;
  readonly defArmy: number;
}

/** The first time an attacker's force stood at a defender's defence ring. */
export interface ArrivalRecord {
  readonly attacker: number;
  readonly defender: number;
  readonly t: number;
  /** Attacker value within the ring at arrival. */
  readonly force: number;
  readonly attArmy: number;
  /** Earliest time the defender saw any unit of this force (-1 = never seen). */
  readonly firstSightS: number;
  /** First defender alarm at or after the sighting (-1 = none); filled in at the end of the match. */
  alarmS: number;
  /** First time defender value in the ring >= half the force (-1 = never); filled in at the end. */
  defenderArrivalS: number;
}

export interface ExperienceLog {
  readonly samples: ExpSample[];
  readonly health: HealthSample[];
  readonly falls: FallRecord[];
  readonly arrivals: ArrivalRecord[];
  /** First time any faction saw a hostile unit (-1 = never), first non-capital settlement taken, minutes simulated. */
  readonly firstContactS: number;
  readonly firstTownLostS: number;
  readonly minutes: number;
  readonly decided: boolean;
}

export const DOMINANCE_SHARE = 0.7;
export const CHEAP_SHARE = 0.2;
export const CHEAP_OUTNUMBER = 3;
export const GINI_TIMES_S = [900, 1800, 2700];

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Gini coefficient of non-negative shares (0 = equal, towards 1 = one holds everything). */
export function gini(xs: readonly number[]): number {
  const n = xs.length;
  const total = sum(xs);
  if (n === 0 || total <= 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  let acc = 0;
  s.forEach((x, i) => { acc += (2 * (i + 1) - n - 1) * x; });
  return acc / (n * total);
}

export interface OneSided {
  /** Share of samples (2+ sides alive, army > 0) in which one side held > 70 % of the total army value. */
  readonly dominatedShare: number;
  readonly leadChanges: number;
  /** Largest deficit (leader's army minus own, over total army) of a side that later became the leader. */
  readonly largestComeback: number;
  /** Territory Gini at 15 / 30 / 45 min (NaN when the log is shorter). */
  readonly gini: { t: number; g: number }[];
}

const LEAD_HYSTERESIS = 1.1;

export function oneSidedness(samples: readonly ExpSample[]): OneSided {
  let contested = 0;
  let dominated = 0;
  let leader = -1;
  let leadChanges = 0;
  for (const s of samples) {
    const total = sum(s.army);
    if (total <= 0 || s.alive.filter(Boolean).length < 2) continue;
    contested++;
    if (Math.max(...s.army) / total > DOMINANCE_SHARE) dominated++;
    const top = s.army.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
    if (leader < 0) leader = top;
    else if (top !== leader && s.army[top] > LEAD_HYSTERESIS * s.army[leader]) { leader = top; leadChanges++; }
  }
  let comeback = 0;
  samples.forEach((s, i) => {
    const total = sum(s.army);
    if (total <= 0) return;
    for (let f = 0; f < s.army.length; f++) {
      const others = Math.max(...s.army.filter((_, k) => k !== f));
      const deficit = (others - s.army[f]) / total;
      if (deficit <= comeback) continue;
      for (let j = i + 1; j < samples.length; j++) {
        const o = Math.max(...samples[j].army.filter((_, k) => k !== f));
        if (samples[j].army[f] > o && samples[j].army[f] > 0) { comeback = deficit; break; }
      }
    }
  });
  const g = GINI_TIMES_S.map((t) => {
    const s = samples.find((x) => Math.abs(x.t - t) <= 15);
    return { t, g: s ? gini(s.terr) : NaN };
  });
  return { dominatedShare: contested ? dominated / contested : 0, leadChanges, largestComeback: comeback, gini: g };
}

export interface CheapWin {
  readonly capital: number;
  readonly by: number;
  readonly t: number;
  /** Attacking force over the attacker's army value. */
  readonly shareOfArmy: number;
  /** Defender army over attacking force (cost vs the defender's army). */
  readonly defenderOver: number;
  readonly flagged: boolean;
  readonly reasons: string[];
}

export function cheapWins(falls: readonly FallRecord[]): CheapWin[] {
  return falls.filter((f) => f.by >= 0).map((f) => {
    const shareOfArmy = f.attArmy > 0 ? f.force / f.attArmy : 1;
    const defenderOver = f.defArmy / Math.max(1, f.force);
    const reasons: string[] = [];
    if (shareOfArmy < CHEAP_SHARE) reasons.push(`force is only ${(shareOfArmy * 100).toFixed(0)} % of the attacker's army`);
    if (defenderOver >= CHEAP_OUTNUMBER) reasons.push(`defender army ${defenderOver.toFixed(1)}x the force`);
    return { capital: f.capital, by: f.by, t: f.t, shareOfArmy, defenderOver, flagged: reasons.length > 0, reasons };
  });
}

export interface Warning {
  readonly attacker: number;
  readonly defender: number;
  readonly arrivalS: number;
  readonly seen: boolean;
  /** First sighting to arrival at the ring (s), NaN when never seen. */
  readonly warnS: number;
  /** First sighting to defender alarm (s), NaN when none. */
  readonly reactionS: number;
  /** First sighting to defenders in strength at the ring (s), NaN when never. */
  readonly defenderArrivalS: number;
  readonly tookCapital: boolean;
}

export function warnings(arrivals: readonly ArrivalRecord[], falls: readonly FallRecord[]): Warning[] {
  return arrivals.map((a) => {
    const seen = a.firstSightS >= 0;
    const rel = (t: number): number => (seen && t >= 0 ? Math.max(0, t - a.firstSightS) : NaN);
    return {
      attacker: a.attacker, defender: a.defender, arrivalS: a.t, seen,
      warnS: seen ? Math.max(0, a.t - a.firstSightS) : NaN,
      reactionS: rel(a.alarmS), defenderArrivalS: rel(a.defenderArrivalS),
      tookCapital: falls.some((f) => f.capital === a.defender && f.by === a.attacker),
    };
  });
}

export interface Pacing {
  readonly firstContactS: number;
  readonly firstTownLostS: number;
  readonly firstCapitalLostS: number;
  readonly eliminationsPerHour: number;
  readonly undecided: boolean;
}

export function pacing(log: Pick<ExperienceLog, 'firstContactS' | 'firstTownLostS' | 'falls' | 'minutes' | 'decided'>): Pacing {
  const firstCap = log.falls.length ? Math.min(...log.falls.map((f) => f.t)) : -1;
  return {
    firstContactS: log.firstContactS, firstTownLostS: log.firstTownLostS, firstCapitalLostS: firstCap,
    eliminationsPerHour: log.minutes > 0 ? (log.falls.length / log.minutes) * 60 : 0, undecided: !log.decided,
  };
}

export interface Health { readonly idleShare: number; readonly stuckShare: number; readonly starvedShare: number }

export function engagementHealth(h: readonly HealthSample[]): Health {
  const units = sum(h.map((x) => x.units));
  if (units <= 0) return { idleShare: 0, stuckShare: 0, starvedShare: 0 };
  return { idleShare: sum(h.map((x) => x.idleFar)) / units, stuckShare: sum(h.map((x) => x.stuck)) / units, starvedShare: sum(h.map((x) => x.starved)) / units };
}

/* ---------- bands and the one summary score per match ---------- */

export type Band = 'pass' | 'warn' | 'fail';

/** value <= pass -> pass, <= warn -> warn, else fail (lower is better). NaN counts as pass (nothing measured). */
export function bandLow(v: number, pass: number, warn: number): Band {
  if (!Number.isFinite(v) || v <= pass) return 'pass';
  return v <= warn ? 'warn' : 'fail';
}
/** value >= pass -> pass, >= warn -> warn, else fail (higher is better). NaN counts as pass. */
export function bandHigh(v: number, pass: number, warn: number): Band {
  if (!Number.isFinite(v) || v >= pass) return 'pass';
  return v >= warn ? 'warn' : 'fail';
}

/** The explicit pass / warn limits of every scored metric (docs/CHALLENGE_LAB.md). */
export const BANDS = {
  dominatedShare: { pass: 0.4, warn: 0.6 },
  giniAt30: { pass: 0.45, warn: 0.6 },
  warnS: { pass: 90, warn: 45 },
  firstContactS: { low: 120, passFrom: 180, passTo: 900, warnTo: 1500 },
  firstCapitalLostS: { pass: 900, warn: 600 },
  eliminationsPerHour: { pass: 3, warn: 5 },
  idleShare: { pass: 0.15, warn: 0.3 },
  stuckShare: { pass: 0.03, warn: 0.08 },
  starvedShare: { pass: 0.25, warn: 0.45 },
} as const;

export interface Scored { readonly name: string; readonly value: number; readonly band: Band; readonly weight: number }

export interface MatchExperience {
  readonly oneSided: OneSided;
  readonly cheap: CheapWin[];
  readonly warn: Warning[];
  readonly pacing: Pacing;
  readonly health: Health;
  readonly scored: Scored[];
  /** 0 to 100: weighted share of passes (warn = half). */
  readonly score: number;
  readonly verdict: 'PASS' | 'WARN' | 'FAIL';
}

export const BAND_POINTS: Record<Band, number> = { pass: 1, warn: 0.5, fail: 0 };
export const VERDICT_BANDS = { pass: 75, warn: 50 } as const;

export function verdictOf(score: number): 'PASS' | 'WARN' | 'FAIL' {
  return score >= VERDICT_BANDS.pass ? 'PASS' : score >= VERDICT_BANDS.warn ? 'WARN' : 'FAIL';
}

export function scoreBands(scored: readonly Scored[]): number {
  const w = sum(scored.map((s) => s.weight));
  return w > 0 ? Math.round((sum(scored.map((s) => s.weight * BAND_POINTS[s.band])) / w) * 100) : 100;
}

function contactBand(s: number): Band {
  const b = BANDS.firstContactS;
  if (!(s >= 0)) return 'warn';
  if (s < b.low) return 'fail';
  if (s >= b.passFrom && s <= b.passTo) return 'pass';
  return s <= b.warnTo ? 'warn' : 'fail';
}

export function evaluateMatch(log: ExperienceLog): MatchExperience {
  const oneSided = oneSidedness(log.samples);
  const cheap = cheapWins(log.falls);
  const warn = warnings(log.arrivals, log.falls);
  const pace = pacing(log);
  const health = engagementHealth(log.health);
  const lossWarn = warn.filter((x) => x.tookCapital);
  const worstWarn = lossWarn.length ? Math.min(...lossWarn.map((x) => (x.seen ? x.warnS : 0))) : NaN;
  const g30 = oneSided.gini[1]?.g ?? NaN;
  const scored: Scored[] = [
    { name: 'dominated share of time (> 70 % army)', value: oneSided.dominatedShare, band: bandLow(oneSided.dominatedShare, BANDS.dominatedShare.pass, BANDS.dominatedShare.warn), weight: 2 },
    { name: 'territory Gini at 30 min', value: g30, band: bandLow(g30, BANDS.giniAt30.pass, BANDS.giniAt30.warn), weight: 1 },
    { name: 'cheap-win capital losses', value: cheap.filter((c) => c.flagged).length, band: cheap.some((c) => c.flagged) ? 'fail' : 'pass', weight: 3 },
    { name: 'warning time before a capital loss (s)', value: worstWarn, band: bandHigh(worstWarn, BANDS.warnS.pass, BANDS.warnS.warn), weight: 3 },
    { name: 'first contact (s)', value: pace.firstContactS, band: contactBand(pace.firstContactS), weight: 1 },
    { name: 'first capital lost (s)', value: pace.firstCapitalLostS, band: pace.firstCapitalLostS < 0 ? 'pass' : bandHigh(pace.firstCapitalLostS, BANDS.firstCapitalLostS.pass, BANDS.firstCapitalLostS.warn), weight: 2 },
    { name: 'eliminations per hour', value: pace.eliminationsPerHour, band: bandLow(pace.eliminationsPerHour, BANDS.eliminationsPerHour.pass, BANDS.eliminationsPerHour.warn), weight: 1 },
    { name: 'idle far from any front', value: health.idleShare, band: bandLow(health.idleShare, BANDS.idleShare.pass, BANDS.idleShare.warn), weight: 1 },
    { name: 'stuck', value: health.stuckShare, band: bandLow(health.stuckShare, BANDS.stuckShare.pass, BANDS.stuckShare.warn), weight: 1 },
    { name: 'supply-starved', value: health.starvedShare, band: bandLow(health.starvedShare, BANDS.starvedShare.pass, BANDS.starvedShare.warn), weight: 1 },
  ];
  const score = scoreBands(scored);
  return { oneSided, cheap, warn, pacing: pace, health, scored, score, verdict: verdictOf(score) };
}
