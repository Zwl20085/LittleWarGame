import type { Rules } from '../data/types';
import type { Faction } from './types';

export type SpendFail = 'INSUFFICIENT_P' | 'INSUFFICIENT_M';
export type SpendResult = { ok: true } | { ok: false; reason: SpendFail };

/** The single atomic spend entry point (AGENT_HANDOFF §4.2). Never lets stock go negative. */
export function trySpend(f: Faction, p: number, m: number): SpendResult {
  if (p < 0 || m < 0) throw new Error('trySpend: negative amounts are refunds; use refund()');
  if (f.p + 1e-9 < p) return { ok: false, reason: 'INSUFFICIENT_P' };
  if (f.m + 1e-9 < m) return { ok: false, reason: 'INSUFFICIENT_M' };
  f.p = Math.max(0, f.p - p);
  f.m = Math.max(0, f.m - m);
  f.spentTotalP += p;
  f.spentTotalM += m;
  return { ok: true };
}

export function refund(f: Faction, p: number, m: number, rules: Rules): void {
  f.p = Math.min(rules.economy.cap_p, f.p + p);
  f.m = Math.min(rules.economy.cap_m, f.m + m);
}

export interface EconomyRates {
  readonly pPerMin: number;
  readonly mPerMin: number;
  readonly logistics: number;
  readonly buildTimeMul: number;
}

/** BALANCE_SPEC §2.1 income formulas. */
export function economyRates(alloc: readonly [number, number, number], rules: Rules, bonusP = 0, bonusM = 0, cityShare = 1): EconomyRates {
  const e = rules.economy;
  const [xP, xI, xL] = alloc;
  return {
    pPerMin: (e.base_income_p_per_min + e.allocated_income_per_min * xP) * cityShare + bonusP,
    mPerMin: (e.base_income_m_per_min + e.allocated_income_per_min * xI) * cityShare + bonusM,
    logistics: e.logistics_base + e.logistics_per_allocation * xL,
    buildTimeMul: 1 / (e.production_efficiency_base + e.production_efficiency_per_industry * xI),
  };
}

/** Apply one second of income; overflow beyond caps is discarded. Returns true if anything overflowed. */
export function applyIncome(f: Faction, rates: EconomyRates, seconds: number, rules: Rules): boolean {
  const np = f.p + (rates.pPerMin / 60) * seconds;
  const nm = f.m + (rates.mPerMin / 60) * seconds;
  f.p = Math.min(rules.economy.cap_p, np);
  f.m = Math.min(rules.economy.cap_m, nm);
  return np > rules.economy.cap_p || nm > rules.economy.cap_m;
}

/** Map node bonus with diminishing returns and caps (§2.2). `counts` = active nodes by type. */
export function nodeBonus(manpowerNodes: number, industryNodes: number, rules: Rules): { p: number; m: number } {
  const e = rules.economy;
  const f = (k: number): number => e.node_return_factors[Math.min(k, e.node_return_factors.length - 1)];
  let p = 0;
  let m = 0;
  for (let k = 0; k < manpowerNodes; k++) p += e.node_p_per_min * f(k);
  for (let k = 0; k < industryNodes; k++) m += e.node_m_per_min * f(k);
  return { p: Math.min(p, e.node_p_bonus_cap), m: Math.min(m, e.node_m_bonus_cap) };
}

export interface StewardInput {
  readonly needP60: number;
  readonly needM60: number;
  readonly incomeP60: number;
  readonly incomeM60: number;
  readonly forecastDemand: number;
  readonly logistics: number;
  readonly now: number;
}

export interface StewardOutcome {
  readonly alloc: [number, number, number];
  readonly changed: boolean;
  readonly from: number;
  readonly to: number;
  readonly scores: [number, number, number];
}

/**
 * Resource steward (§2.3): move ≤5 pp from the lowest-score unlocked share to the
 * highest-score one, keep each ≥15 %, sum = 1, hold direction ≥15 s.
 */
export function stewardStep(f: Faction, input: StewardInput, rules: Rules): StewardOutcome {
  const e = rules.economy;
  const scores: [number, number, number] = [
    Math.max(0, (input.needP60 - f.p - input.incomeP60) / Math.max(input.needP60, 1)),
    Math.max(0, (input.needM60 - f.m - input.incomeM60) / Math.max(input.needM60, 1)),
    Math.max(0, (input.forecastDemand - input.logistics) / Math.max(input.forecastDemand, 1)),
  ];
  const unlocked = [0, 1, 2].filter((i) => !f.locks[i]);
  const none: StewardOutcome = { alloc: f.alloc, changed: false, from: -1, to: -1, scores };
  if (unlocked.length < 2) return none;
  const allZero = scores.every((s) => s === 0);
  let to: number;
  let from: number;
  if (allZero) {
    // Drift back toward the default allocation.
    const def = e.allocation_default;
    const diffs = unlocked.map((i) => def[i] - f.alloc[i]);
    const iTo = diffs.indexOf(Math.max(...diffs));
    const iFrom = diffs.indexOf(Math.min(...diffs));
    if (diffs[iTo] < 0.005) return none;
    to = unlocked[iTo];
    from = unlocked[iFrom];
  } else {
    const sorted = [...unlocked].sort((a, b) => scores[b] - scores[a] || a - b);
    to = sorted[0];
    from = sorted[sorted.length - 1];
    if (scores[to] - scores[from] < 0.05) return none;
  }
  if (to === from) return none;
  const dirKey = to * 3 + from;
  const reverse = from * 3 + to;
  const emergency = scores[2] > 0.3 && to === 2;
  if (f.stewardLastDir === reverse && input.now < f.stewardHoldUntil && !emergency) return none;
  const room = f.alloc[from] - e.auto_min_allocation;
  let step = Math.min(e.auto_max_step, room);
  if (allZero) step = Math.min(step, Math.abs(e.allocation_default[to] - f.alloc[to]));
  if (step <= 1e-6) return none;
  const next: [number, number, number] = [...f.alloc];
  next[to] += step;
  next[from] -= step;
  const sum = next[0] + next[1] + next[2];
  next[0] /= sum;
  next[1] /= sum;
  next[2] /= sum;
  f.alloc = next;
  if (f.stewardLastDir !== dirKey) f.stewardHoldUntil = input.now + e.auto_hold_seconds;
  f.stewardLastDir = dirKey;
  return { alloc: next, changed: true, from, to, scores };
}
