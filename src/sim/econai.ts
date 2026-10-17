import type { EconKind } from '../data/types';
import { buildCost, buildingsAt, canBuild, econCounts, econRules, freeEconSlot, startBuilding } from './econ';
import { enemyDistance } from './frontai';
import { populationCap, populationOf } from './production';
import { placeEfficiency, placeOwner, placeContested } from './settlements';
import type { Faction, Place } from './types';
import { refund } from './economy';
import { investWeight, profileOf } from './doctrines';
import { setInvestStyle, thinkZones } from './econZoneAi';
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

/**
 * 2.2 wave 2 (V22_SPEC §5): investment vs army. Appetite 0 … ~1.5 = territory wealth (held places
 * vs the mean of the living factions) × safety (our army vs the strongest known hostile army);
 * 0 while an attack on the capital is coming (homeThreat.alert) or the directive is Defend / Contract. It scales the share of
 * income set aside, the sites built at once and the cash reserve kept for the army.
 */
export const APPETITE = {
  richLo: 0.5,
  richHi: 1.6,
  /** Army ratio (ours ÷ strongest known hostile): no safety at safeLo, full at safeHi. */
  safeLo: 0.5,
  safeHi: 1.0,
  /** Safety floor of the appetite (a weak but unthreatened side still invests a little). */
  safeFloor: 0.5,
  /** Scale so a faction of average wealth and safety invests about the wave-1 share. */
  scale: 1.25,
  /** Extra safe distance from hostile ground when unsafe (m). */
  unsafeDistance: 300,
} as const;

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export function investAppetite(world: World, f: Faction): { appetite: number; safe: number } {
  if (f.command.homeThreat.alert || f.directive.kind === 'defend' || f.directive.kind === 'contract') return { appetite: 0, safe: 0 };
  const held = new Map<number, number>();
  for (const o of world.objectives) if (o.owner >= 0 && o.kind !== 'point') held.set(o.owner, (held.get(o.owner) ?? 0) + (o.kind === 'city' ? 3 : o.kind === 'town' ? 2 : 1));
  const alive = world.factions.filter((x) => x.alive);
  const mean = alive.reduce((a, x) => a + (held.get(x.id) ?? 0), 0) / Math.max(1, alive.length);
  const rich = clamp((held.get(f.id) ?? 0) / Math.max(1, mean), APPETITE.richLo, APPETITE.richHi);
  let mine = 0;
  const theirs = new Map<number, number>();
  for (const u of world.aliveUnits) {
    if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || u.def.id === 'commander') continue;
    const v = u.def.costP + u.def.costM;
    if (u.owner === f.id) mine += v;
    else if (world.isHostile(f.id, u.owner) && world.knows(f.id, u)) theirs.set(u.owner, (theirs.get(u.owner) ?? 0) + v);
  }
  const top = Math.max(0, ...theirs.values());
  const ratio = top > 0 ? mine / top : 2;
  const safe = clamp((ratio - APPETITE.safeLo) / (APPETITE.safeHi - APPETITE.safeLo), 0, 1);
  return { appetite: APPETITE.scale * rich * (APPETITE.safeFloor + (1 - APPETITE.safeFloor) * safe), safe };
}

const appetites = new WeakMap<Faction, number>();
export const lastAppetite = (f: Faction): number => appetites.get(f) ?? 1;

/** Safe owned place with a free slot (ruins first), nearest the capital. */
function investPlace(world: World, f: Faction, safeDistance: number = ECON_AI.safeDistance): Place | null {
  let best: Place | null = null;
  let bs = Infinity;
  const hq = world.hqPos(f.id);
  for (const p of world.places) {
    if (p.capitalOf >= 0 || p.slotPos.length === 0 || placeOwner(world, p) !== f.id || placeContested(world, p)) continue;
    if (freeEconSlot(world, p) < 0 || enemyDistance(world, f.id, p.pos) < safeDistance) continue;
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
/** Return the money set aside for the next building to the stock (threat, or the steward switched off). */
export function releaseFund(world: World, f: Faction): void {
  const fund = f.econFund;
  if (fund.p > 0 || fund.m > 0) refund(f, fund.p, fund.m, world.data.rules);
  fund.p = 0;
  fund.m = 0;
  fund.active = false;
}

export function thinkInvestment(world: World, f: Faction): void {
  if (!econRules(world) || !f.autoInvest || !f.alive) return;
  const fund = f.econFund;
  const { appetite: base, safe } = investAppetite(world, f);
  const weight = investWeight(world, f); // 3.0: the doctrine's invest share (doctrines.ts)
  const appetite = base * weight;
  if (profileOf(world, f)) setInvestStyle(f, weight); // zones: the doctrine is the investment style
  appetites.set(f, appetite);
  // 3.0: economic zones (econZoneAi.ts) — rebuild, raise or found one per think.
  thinkZones(world, f, base, safe);
  // Threatened: the money set aside goes back to the army.
  if (appetite <= 0) releaseFund(world, f);
  const maxSites = appetite >= 1.1 ? ECON_AI.maxSites + 1 : appetite >= 0.5 ? ECON_AI.maxSites : appetite > 0 ? 1 : 0;
  const p = econCounts(world, f.id).sites >= maxSites ? null : investPlace(world, f, ECON_AI.safeDistance + APPETITE.unsafeDistance * (1 - safe));
  fund.active = p !== null;
  if (!p) return;
  const kind = investKind(world, f, p);
  const cost = buildCost(world, p, kind, freeEconSlot(world, p));
  const pop = populationOf(world, f);
  const full = (pop.present + pop.reserved) / Math.max(1, populationCap(world, f)) >= ECON_AI.fullArmy;
  const fromFund = fund.p + 1e-9 >= cost.p && fund.m + 1e-9 >= cost.m;
  const keep = 1 / Math.max(0.5, appetite);
  const reserveP = full ? 0 : ECON_AI.reserveP * keep;
  const reserveM = full ? 0 : ECON_AI.reserveM * keep;
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
  if (!r || !f.autoInvest || !f.alive || !fund.active) return;
  let capP = 0;
  let capM = 0;
  for (const b of Object.values(r.buildings)) {
    capP = Math.max(capP, b.cost_p);
    capM = Math.max(capM, b.cost_m);
  }
  const share = ECON_AI.share * Math.min(1.5, lastAppetite(f));
  const dp = Math.min(Math.max(0, capP - fund.p), Math.max(0, f.incomeP) * share / 60, f.p);
  const dm = Math.min(Math.max(0, capM - fund.m), Math.max(0, f.incomeM) * share / 60, f.m);
  f.p -= dp;
  f.m -= dm;
  fund.p += dp;
  fund.m += dm;
}
