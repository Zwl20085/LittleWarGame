import type { EconKind } from '../data/types';
import { buildCost, buildingsAt, canBuild, econCounts, econRules, freeEconSlot, startBuilding } from './econ';
import { enemyDistance } from './frontai';
import { populationCap, populationOf } from './production';
import { placeEfficiency, placeOwner, placeContested } from './settlements';
import type { Faction, Place } from './types';
import { dist } from './vec';
import type { World } from './world';

/**
 * Wave-1 AI investment policy (V22_SPEC §5; the full investment / raid logic is wave 2): the AI
 * supreme HQ puts surplus P/M into economic buildings in safe towns so the halved settlement
 * income does not cripple it. Army first: it invests only with a reserve left after the cost, and
 * more readily when its army is near the population cap.
 */
export const ECON_AI = {
  /** Stock kept back after paying for a building. */
  reserveP: 120,
  reserveM: 220,
  /** Army fullness (present + reserved ÷ cap) above which the HQ invests even on a thin reserve. */
  fullArmy: 0.85,
  /** A place this close to hostile ground is not safe to invest in (m). */
  safeDistance: 450,
  /** Share of income set aside for investment while a safe slot is free. */
  share: 0.2,
  /** Sites under construction at once. */
  maxSites: 2,
  /** Target mix (factories : recruitment offices : depots). */
  mix: { factory: 3, recruit: 2, depot: 1 } as Record<EconKind, number>,
} as const;

/** Safe owned place with a free slot (ruins first), nearest the capital. */
function investPlace(world: World, f: Faction): Place | null {
  let best: Place | null = null;
  let bs = Infinity;
  const hq = world.hqPos(f.id);
  for (const p of world.places) {
    if (p.capitalOf >= 0 || p.slotPos.length === 0 || placeOwner(world, p) !== f.id || placeContested(world, p)) continue;
    if (freeEconSlot(world, p) < 0 || enemyDistance(world, f.id, p.pos) < ECON_AI.safeDistance) continue;
    const ruin = buildingsAt(world, p.id).some((b) => b.ruined);
    const score = dist(p.pos, hq) - (ruin ? 600 : 0) - (p.kind === 'city' ? 200 : 0);
    if (score < bs) {
      bs = score;
      best = p;
    }
  }
  return best;
}

/** Kind most behind the target mix; depots only where the stock is far from the capital. */
function investKind(world: World, f: Faction, p: Place): EconKind {
  const c = econCounts(world, f.id);
  const ruin = buildingsAt(world, p.id).find((b) => b.ruined);
  if (ruin) return ruin.kind;
  const kinds: EconKind[] = ['factory', 'recruit'];
  const hasDepot = buildingsAt(world, p.id).some((b) => b.kind === 'depot');
  if (!hasDepot && placeEfficiency(world, p, f.id) < 0.75) kinds.push('depot');
  // The scarcer stock decides: munitions piling up while manpower runs dry → recruitment offices.
  const tilt = f.m > f.p * 1.5 + 100 ? { factory: 0.6, recruit: -0.6 } : f.p > f.m * 1.5 + 100 ? { factory: -0.6, recruit: 0.6 } : { factory: 0, recruit: 0 };
  const want = (k: EconKind): number => (c[k] + 1) / ECON_AI.mix[k] + (k === 'depot' ? 0 : tilt[k]);
  return kinds.reduce((a, b) => (want(b) < want(a) ? b : a));
}

/**
 * Called from the AI city planner (cityai.thinkCity): at most one building per think. Paid from
 * the investment fund (fundSecond) or, with a full army or a fat reserve, straight from stock.
 */
export function thinkInvestment(world: World, f: Faction): void {
  if (!econRules(world) || f.isPlayer || !f.alive) return;
  const fund = f.econFund;
  const p = econCounts(world, f.id).sites >= ECON_AI.maxSites ? null : investPlace(world, f);
  fund.active = p !== null;
  if (!p) return;
  const kind = investKind(world, f, p);
  const cost = buildCost(world, p, kind, freeEconSlot(world, p));
  const pop = populationOf(world, f);
  const full = (pop.present + pop.reserved) / Math.max(1, populationCap(world, f)) >= ECON_AI.fullArmy;
  const fromFund = fund.p + 1e-9 >= cost.p && fund.m + 1e-9 >= cost.m;
  const reserveP = full ? 0 : ECON_AI.reserveP;
  const reserveM = full ? 0 : ECON_AI.reserveM;
  if (!fromFund && (f.p < cost.p + reserveP || f.m < cost.m + reserveM)) return;
  if (fromFund) {
    // Release the fund into the stock for the atomic spend; what is left over stays set aside.
    f.p += fund.p;
    f.m += fund.m;
    fund.p = 0;
    fund.m = 0;
  }
  if (canBuild(world, f, p, kind) === null) {
    const b = startBuilding(world, f, p.id, kind);
    if (typeof b !== 'string') f.econInvested += cost.p + cost.m;
  }
}

/**
 * Once per second (AI): while a safe slot is waiting, set `share` of income aside for it, up to
 * the dearest building's cost (economy vs army as a measured trade-off: econInvested).
 */
export function fundSecond(world: World, f: Faction): void {
  const r = econRules(world);
  const fund = f.econFund;
  if (!r || f.isPlayer || !f.alive || !fund.active) return;
  let capP = 0;
  let capM = 0;
  for (const b of Object.values(r.buildings)) {
    capP = Math.max(capP, b.cost_p);
    capM = Math.max(capM, b.cost_m);
  }
  const dp = Math.min(Math.max(0, capP - fund.p), Math.max(0, f.incomeP) * ECON_AI.share / 60, f.p);
  const dm = Math.min(Math.max(0, capM - fund.m), Math.max(0, f.incomeM) * ECON_AI.share / 60, f.m);
  f.p -= dp;
  f.m -= dm;
  fund.p += dp;
  fund.m += dm;
}
