import type { UpgradeRules } from '../data/upgradeRules';
import { refund, trySpend } from './economy';
import type { Faction, Personality, UpgradeState } from './types';
import { refitNow, UPG, upgradeBit, upgradeRules, UPGRADE_IDS, type UpgradeId } from './upgradestats';
import type { World } from './world';

/**
 * 3.0 unit upgrades — the tree, purchases and the research timer (V30_SPEC §9, docs/UPGRADES.md).
 * The supreme HQ pays P/M up front; the item is researched at the capital (one at a time) and then
 * applies through the stat layer (upgradestats.ts). Prices rise: every owned item makes the next one
 * `escalation` dearer, and tiers I–III are priced up in rules.json. The AI buys from a priority
 * table (`upgradePriority`) when its stock is above a reserve and its income is not falling.
 */

export { UPGRADE_IDS, type UpgradeId } from './upgradestats';

export const newUpgradeState = (): UpgradeState => ({ owned: 0, research: null, aiAt: 0, incomeSamples: [], want: null, fundP: 0, fundM: 0 });

/** Cost scale: rules prices are per army_scale × army_scale_income_factor = 1 (like income). */
function costScale(world: World): number {
  const d = world.data.rules.proposed_defaults;
  return (d.army_scale ?? 1) * (d.army_scale_income_factor ?? 1);
}

const owns = (s: UpgradeState, id: string): boolean => (s.owned & upgradeBit(id)) !== 0;

function ownedCount(s: UpgradeState): number {
  let n = 0;
  for (let v = s.owned; v; v &= v - 1) n++;
  return n;
}

/** Price of `id` for faction `f` now (rising with every item owned). */
export function upgradeCost(world: World, f: Faction, id: UpgradeId): { p: number; m: number } {
  const r = upgradeRules(world);
  const it = r?.items[id];
  if (!r || !it) return { p: Infinity, m: Infinity };
  const k = costScale(world) * (1 + r.escalation * ownedCount(f.upgrades));
  return { p: Math.round(it.p_k * k), m: Math.round(it.m_k * k) };
}

export const researchSeconds = (r: UpgradeRules, id: UpgradeId): number => r.items[id]?.seconds ?? 0;

export type ResearchFail = 'DISABLED' | 'BAD_VALUE' | 'OWNED' | 'BUSY' | 'LOCKED' | 'INSUFFICIENT_P' | 'INSUFFICIENT_M';

/** Why `id` cannot be started now, or null. */
export function researchBlock(world: World, f: Faction, id: string): ResearchFail | null {
  const r = upgradeRules(world);
  if (!r) return 'DISABLED';
  if (!(UPGRADE_IDS as readonly string[]).includes(id) || !r.items[id]) return 'BAD_VALUE';
  const s = f.upgrades;
  if (owns(s, id)) return 'OWNED';
  if (s.research) return 'BUSY';
  if ((r.items[id].requires ?? []).some((q) => !owns(s, q))) return 'LOCKED';
  const c = upgradeCost(world, f, id as UpgradeId);
  if (f.p + 1e-9 < c.p) return 'INSUFFICIENT_P';
  if (f.m + 1e-9 < c.m) return 'INSUFFICIENT_M';
  return null;
}

/** Pay for `id` and start researching it at the capital. */
export function startResearch(world: World, f: Faction, id: string): ResearchFail | null {
  const block = researchBlock(world, f, id);
  if (block) return block;
  const r = upgradeRules(world)!;
  const c = upgradeCost(world, f, id as UpgradeId);
  const paid = trySpend(f, c.p, c.m);
  if (!paid.ok) return paid.reason;
  f.upgrades.research = { id, startedAt: world.time, endsAt: world.time + researchSeconds(r, id as UpgradeId), p: c.p, m: c.m };
  world.note(f.id, 'log.upgradeStarted', { upg: id }, 'info');
  return null;
}

/** Stop the research under way; `cancel_refund_ratio` of the price comes back. */
export function cancelResearch(world: World, f: Faction): boolean {
  const res = f.upgrades.research;
  const r = upgradeRules(world);
  if (!res || !r) return false;
  refund(f, res.p * r.cancel_refund_ratio, res.m * r.cancel_refund_ratio, world.data.rules);
  f.upgrades.research = null;
  return true;
}

/** Research progress 0 … 1 (UI). */
export function researchProgress(world: World, f: Faction): number {
  const res = f.upgrades?.research;
  if (!res) return 0;
  const span = Math.max(1e-6, res.endsAt - res.startedAt);
  return Math.min(1, Math.max(0, (world.time - res.startedAt) / span));
}

/** Mark `id` owned and push the field items to every unit (also used by labs and tests). */
export function grantUpgrade(world: World, f: Faction, id: UpgradeId): void {
  const bit = UPG[id];
  if ((f.upgrades.owned & bit) !== 0) return;
  f.upgrades.owned |= bit;
  refitNow(world, f.id, bit);
}

/** Once per game second per faction (sim.economySecond): the research timer, then the AI buyer. */
export function upgradeSecond(world: World, f: Faction): void {
  const r = upgradeRules(world);
  if (!r || !f.alive) return;
  const res = f.upgrades.research;
  if (res && world.time >= res.endsAt) {
    f.upgrades.research = null;
    grantUpgrade(world, f, res.id as UpgradeId);
    world.note(f.id, 'log.upgradeDone', { upg: res.id }, 'info');
  }
  if (!f.isPlayer) aiBuy(world, f, r);
}

// ------------------------------------------------------------------ AI

/**
 * Purchase order by doctrine (WP-A fills doctrine-specific rows; unknown ids fall back to the
 * personality row, then `default`). Items missing from a row are never bought by the AI.
 */
export const UPGRADE_PRIORITY: Record<string, readonly UpgradeId[]> = {
  default: ['staff', 'ap_grenades', 'gun_1', 'armour_1', 'truck_capacity', 'inf_guns', 'arty_range', 'eng_speed', 'motorization', 'gun_2', 'armour_2', 'gun_3', 'armour_3'],
  armor: ['gun_1', 'armour_1', 'gun_2', 'armour_2', 'staff', 'truck_capacity', 'gun_3', 'armour_3', 'ap_grenades', 'motorization', 'inf_guns', 'arty_range', 'eng_speed'],
  infantry: ['inf_guns', 'ap_grenades', 'staff', 'eng_speed', 'truck_capacity', 'motorization', 'arty_range', 'gun_1', 'armour_1', 'gun_2', 'armour_2', 'gun_3', 'armour_3'],
  mechanized: ['motorization', 'truck_capacity', 'staff', 'gun_1', 'armour_1', 'ap_grenades', 'inf_guns', 'gun_2', 'armour_2', 'arty_range', 'eng_speed', 'gun_3', 'armour_3'],
  artillery: ['arty_range', 'inf_guns', 'staff', 'truck_capacity', 'ap_grenades', 'eng_speed', 'gun_1', 'armour_1', 'motorization', 'gun_2', 'armour_2', 'gun_3', 'armour_3'],
};

/** Priority table for a doctrine (WP-A) or personality; the default order otherwise. */
export function upgradePriority(doctrineId?: string, personality?: Personality): readonly UpgradeId[] {
  return (doctrineId !== undefined ? UPGRADE_PRIORITY[doctrineId] : undefined)
    ?? (personality !== undefined ? UPGRADE_PRIORITY[personality] : undefined)
    ?? UPGRADE_PRIORITY.default;
}

/** Next item the AI wants: first in its table not owned with its prerequisites met. */
export function nextWanted(f: Faction, r: UpgradeRules): UpgradeId | null {
  for (const id of upgradePriority(doctrineKey(f), f.personality)) {
    if (owns(f.upgrades, id) || !r.items[id]) continue;
    if ((r.items[id].requires ?? []).every((q) => owns(f.upgrades, q))) return id;
  }
  return null;
}

/** WP-A seam: `Faction.doctrine` as an id string or a profile with an `id`. */
function doctrineKey(f: Faction): string | undefined {
  const d = (f as { doctrine?: unknown }).doctrine;
  if (typeof d === 'string') return d;
  const id = (d as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}

/** Income not falling: the newest sample ≥ (1 − trend_drop) × the oldest in the window. */
export function incomeSteady(s: UpgradeState, dropShare: number): boolean {
  const xs = s.incomeSamples;
  if (xs.length < 2) return true;
  return xs[xs.length - 1] >= xs[0] * (1 - dropShare);
}

/** Return the AI's upgrade fund to the stock (threat, falling income, nothing left to buy). */
export function releaseUpgradeFund(f: Faction): void {
  const s = f.upgrades;
  f.p += s.fundP;
  f.m += s.fundM;
  s.fundP = 0;
  s.fundM = 0;
}

/** Every think_seconds: income trend sample, eligibility and the item to save for. */
function aiThink(world: World, f: Faction, r: UpgradeRules): void {
  const ai = r.ai;
  const s = f.upgrades;
  s.aiAt = world.time + ai.think_seconds;
  s.incomeSamples.push(f.incomeP + f.incomeM);
  const keep = Math.max(2, Math.round(ai.trend_window_s / ai.think_seconds));
  if (s.incomeSamples.length > keep) s.incomeSamples.splice(0, s.incomeSamples.length - keep);
  const k = costScale(world);
  const eligible = !s.research && world.time >= ai.start_s && !f.command.homeThreat.alert
    && f.incomeP + f.incomeM >= ai.income_floor_k * k && incomeSteady(s, ai.trend_drop);
  s.want = eligible ? nextWanted(f, r) : null;
  if (!s.want && !s.research) releaseUpgradeFund(f);
}

/**
 * AI buyer (once per second): army first — it saves `fund_share` of its income toward the wanted
 * item (the stock alone rarely tops a reserve: production spends it) and starts the research when
 * the fund, plus any stock above the reserve, covers the price.
 */
function aiBuy(world: World, f: Faction, r: UpgradeRules): void {
  const ai = r.ai;
  const s = f.upgrades;
  if (!ai.enabled) return;
  if (world.time >= s.aiAt) aiThink(world, f, r);
  if (!s.want || s.research) return;
  const c = upgradeCost(world, f, s.want as UpgradeId);
  const dp = Math.min(Math.max(0, c.p - s.fundP), f.p, (f.incomeP / 60) * ai.fund_share);
  const dm = Math.min(Math.max(0, c.m - s.fundM), f.m, (f.incomeM / 60) * ai.fund_share);
  f.p -= dp;
  f.m -= dm;
  s.fundP += dp;
  s.fundM += dm;
  const k = costScale(world);
  const needP = Math.max(0, c.p - s.fundP);
  const needM = Math.max(0, c.m - s.fundM);
  if ((needP > 0 && f.p - needP < ai.reserve_p_k * k) || (needM > 0 && f.m - needM < ai.reserve_m_k * k)) return;
  const id = s.want;
  releaseUpgradeFund(f);
  if (startResearch(world, f, id) === null) s.want = null;
}
