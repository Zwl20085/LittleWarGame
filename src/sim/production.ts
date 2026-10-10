import type { UnitDef } from '../data/types';
import { economyRates, refund, trySpend } from './economy';
import type { Faction, Place, ProductionOrder, Unit } from './types';
import { placeById, placeContested, placeOwner, placeUsable } from './settlements';
import type { World } from './world';
import { dist, type V2 } from './vec';
import { recordBuilt } from './stats';
import { hostileMask } from './spatial';
import { frontById } from './frontref';
import { armourFront, isTankId } from './armour';

export type OrderBlock =
  | 'LOCKED'
  | 'CAP'
  | 'POP_FULL'
  | 'INSUFFICIENT_P'
  | 'INSUFFICIENT_M'
  | 'PROTECTED'
  | 'NO_SLOT';

/** 2.2: slots of one facility at one place (capital: all facilities; city: all; town: barracks). */
export function placeSlots(world: World, p: Place, facility: string): number {
  const terr = world.data.rules.territory;
  if (!terr) return p.capitalOf >= 0 ? (world.data.rules.economy.facilities[facility] ?? 0) : 0;
  const k = world.data.rules.proposed_defaults.army_scale ?? 1;
  const v = p.capitalOf >= 0 ? terr.capital_slots[facility] ?? 0 : terr.place_slots[p.kind]?.[facility] ?? 0;
  if (v <= 0) return 0;
  return Math.max(1, Math.round(v * k));
}

/** Production slots of a faction for a facility: the sum over its usable places (UI / lab). */
export function slotsFor(world: World, f: Faction, facility: string): number {
  let n = 0;
  for (const p of world.places) if (placeUsable(world, p, f.id)) n += placeSlots(world, p, facility);
  return Math.max(1, n);
}

/** Production places of a faction that can build `facility` (capital always; towns barracks; cities all). */
export function productionSites(world: World, f: Faction, facility: string): V2[] {
  return productionPlaces(world, f, facility).map((p) => p.pos);
}

export function productionPlaces(world: World, f: Faction, facility: string): Place[] {
  return world.places.filter((p) => placeUsable(world, p, f.id) && placeSlots(world, p, facility) > 0);
}

/** First free slot index of `facility` at place `p` (-1 = none). */
export function freePlaceSlot(world: World, f: Faction, p: Place, facility: string): number {
  const n = placeSlots(world, p, facility);
  for (let s = 0; s < n; s++) if (!f.orders.some((o) => o.placeId === p.id && o.facility === facility && o.slot === s)) return s;
  return -1;
}

const SC_THREAT: Unit[] = [];
function threatened(world: World, f: number, p: V2): boolean {
  for (const u of world.spatial.query(p.x, p.z, 250, SC_THREAT)) if (u.hp > 0 && world.isHostile(f, u.owner) && world.knows(f, u)) return true;
  return false;
}

/**
 * Auto scheduler's place for an order: a usable, unthreatened place with a free slot, nearest the
 * front that needs the unit (a place with an empty stock is a little less attractive: the new unit
 * has to rearm elsewhere). Null = no free slot anywhere.
 */
export function pickPlace(world: World, f: Faction, facility: string, frontId: number): { place: Place; slot: number } | null {
  const front = frontById(f, frontId)?.front ?? world.cityOf(f.id).exit;
  let best: { place: Place; slot: number } | null = null;
  let bd = Infinity;
  for (const p of world.places) {
    if (!placeUsable(world, p, f.id) || placeSlots(world, p, facility) <= 0) continue;
    const slot = freePlaceSlot(world, f, p, facility);
    if (slot < 0 || threatened(world, f.id, p.pos)) continue;
    const d = dist(p.pos, front) + (p.stock < 5 ? 250 : 0);
    if (d < bd) {
      bd = d;
      best = { place: p, slot };
    }
  }
  return best;
}

export function unitCount(world: World, f: Faction, unitId: string): number {
  let n = 0;
  for (const u of world.units.values()) if (u.owner === f.id && u.def.id === unitId && u.hp > 0 && !u.fixed) n++;
  for (const o of f.orders) if (o.unitId === unitId) n++;
  return n;
}

export function populationOf(world: World, f: Faction): { present: number; reserved: number } {
  let present = 0;
  // Buildings cost no population; the squads manning them keep theirs (lead decision 2.0: taking
  // garrisons off the count let a heavily fortified side over-produce).
  for (const u of world.units.values()) if (u.owner === f.id && u.hp > 0 && !u.fixed) present += u.def.population;
  let reserved = 0;
  for (const o of f.orders) reserved += world.data.units.get(o.unitId)!.population;
  return { present, reserved };
}

function unlocked(world: World, def: UnitDef): boolean {
  return world.time >= def.unlockSeconds;
}

/** Normalised spending weights over unlocked, enabled, under-cap units (§2.4). */
export function normalizedWeights(world: World, f: Faction): Map<string, number> {
  const out = new Map<string, number>();
  let sum = 0;
  for (const id of world.data.unitOrder) {
    const def = world.data.units.get(id)!;
    const w = f.weights[id] ?? 0;
    if (w <= 0 || f.paused[id] || !unlocked(world, def)) continue;
    if (unitCount(world, f, id) >= (f.caps[id] ?? Infinity)) continue;
    out.set(id, w);
    sum += w;
  }
  if (sum > 0) for (const [k, v] of out) out.set(k, v / sum);
  return out;
}

function windowSpend(world: World, f: Faction): { total: number; per: Map<string, number> } {
  const windowTicks = world.data.rules.economy.spending_window_seconds * world.tickHz;
  const since = world.tick - windowTicks;
  while (f.spent.length > 0 && f.spent[0].tick < since) f.spent.shift();
  const per = new Map<string, number>();
  let total = 0;
  for (const s of f.spent) {
    per.set(s.unitId, (per.get(s.unitId) ?? 0) + s.value);
    total += s.value;
  }
  return { total, per };
}

/** Why `unitId` cannot start right now (null = can start). Used by both scheduler and UI. */
export function canStart(world: World, f: Faction, def: UnitDef, manual: boolean, reserve = { p: 0, m: 0 }): OrderBlock | null {
  if (!unlocked(world, def)) return 'LOCKED';
  if (!manual && unitCount(world, f, def.id) >= (f.caps[def.id] ?? Infinity)) return 'CAP';
  const pop = populationOf(world, f);
  if (pop.present + pop.reserved + def.population > populationCap(world, f)) return 'POP_FULL';
  if (f.p - reserve.p + 1e-9 < def.costP) return reserve.p > 0 && f.p >= def.costP ? 'PROTECTED' : 'INSUFFICIENT_P';
  if (f.m - reserve.m + 1e-9 < def.costM) return reserve.m > 0 && f.m >= def.costM ? 'PROTECTED' : 'INSUFFICIENT_M';
  return null;
}

/** Population cap: the capital supports a share; every held settlement adds to it (territory rules). */
export function populationCap(world: World, f: Faction): number {
  const cap = world.data.rules.economy.population_cap;
  const terr = world.data.rules.territory;
  if (!terr?.pop_per_place || terr.capital_pop_share === undefined) return cap;
  const k = world.data.rules.proposed_defaults.army_scale ?? 1;
  let n = cap * terr.capital_pop_share;
  for (const o of world.objectives) if (o.owner === f.id) n += (terr.pop_per_place[o.kind] ?? 0) * k;
  // Territory-driven ceiling (1.1): the side that holds the map may field a larger army than the
  // base cap, so the last fortified capital can be overmatched instead of stalling the war.
  return Math.min(Math.round(cap * (terr.pop_cap_max_multiplier ?? 1)), Math.round(n));
}

function startOrder(world: World, f: Faction, def: UnitDef, at: { place: Place; slot: number }, manual: boolean, frontId: number): ProductionOrder | null {
  const res = trySpend(f, def.costP, def.costM);
  if (!res.ok) return null;
  const mul = economyRates(f.alloc, world.data.rules).buildTimeMul;
  const total = def.buildSeconds * mul;
  const order: ProductionOrder = {
    id: world.newId(), unitId: def.id, facility: def.facility, slot: at.slot, manual, frontId,
    remaining: total, total, costP: def.costP, costM: def.costM, blocked: false,
    spawn: { ...at.place.pos }, placeId: at.place.id,
  };
  f.orders.push(order);
  f.spent.push({ tick: world.tick, unitId: def.id, value: def.costP + def.costM });
  return order;
}

/**
 * Choose the front (id) for a new unit by reinforcement-share deficit (the supreme HQ's allocation,
 * theatre.ts). 2.2 (V22_SPEC §7): a tank goes to the main effort the directive names (armour.armourFront).
 */
export function pickFront(world: World, f: Faction, unitId?: string): number {
  if (unitId && isTankId(unitId)) {
    const main = armourFront(world, f);
    if (main >= 0) return main;
  }
  // By front id: ids are stable but not indices (fronts are created and dissolved).
  const counts = new Map<number, number>();
  const add = (id: number, n: number): void => { counts.set(id, (counts.get(id) ?? 0) + n); };
  for (const u of world.units.values()) if (u.owner === f.id && u.hp > 0 && !u.fixed) add(u.frontId, u.def.population);
  for (const o of f.orders) add(o.frontId, world.data.units.get(o.unitId)!.population);
  let total = 1;
  for (const s of f.fronts) total += counts.get(s.id) ?? 0;
  let best = f.fronts[0]?.id ?? 0;
  let bestD = -Infinity;
  for (const s of f.fronts) {
    const d = s.share - (counts.get(s.id) ?? 0) / total;
    if (d > bestD) {
      bestD = d;
      best = s.id;
    }
  }
  return best;
}

/** Scheduler: fill free slots from the manual queue first, then by spending deficit. */
export function scheduleProduction(world: World, f: Faction): void {
  if (!f.alive) return;
  const rules = world.data.rules;
  // Manual one-off orders first (they bypass caps but not population).
  for (let i = 0; i < f.manualQueue.length; i++) {
    const q = f.manualQueue[i];
    const def = world.data.units.get(q.unitId)!;
    const frontId = q.frontId >= 0 && f.fronts.some((x) => x.id === q.frontId) ? q.frontId : pickFront(world, f, q.unitId);
    let at: { place: Place; slot: number } | null = null;
    if (q.placeId) {
      // Queued at a chosen place (town panel): waits for that place's slot; dropped if the place is lost.
      const p = placeById(world, q.placeId);
      if (!p || placeOwner(world, p) !== f.id) {
        world.note(f.id, 'log.queueDropped', { unit: q.unitId, point: q.placeId }, 'warn');
        f.manualQueue.splice(i, 1);
        i--;
        continue;
      }
      const slot = placeContested(world, p) ? -1 : freePlaceSlot(world, f, p, def.facility);
      if (slot >= 0) at = { place: p, slot };
    } else at = pickPlace(world, f, def.facility, frontId);
    if (!at || canStart(world, f, def, true) !== null) continue;
    if (startOrder(world, f, def, at, true, frontId)) {
      f.manualQueue.splice(i, 1);
      i--;
    }
  }
  if (f.protectedOrder && world.time > f.protectedOrder.until) {
    world.note(f.id, 'log.protectExpired', { unit: f.protectedOrder.unitId }, 'info');
    f.protectedOrder = null;
    f.protectRetryAt = world.time + world.data.rules.economy.protected_order_seconds;
  }
  const weights = normalizedWeights(world, f);
  if (weights.size === 0) return;
  const { total, per } = windowSpend(world, f);
  const ref = rules.economy.spending_reference_value;
  const ranked = [...weights.entries()]
    .map(([id, w]) => ({ id, deficit: w * (total + ref) - (per.get(id) ?? 0) }))
    .sort((a, b) => b.deficit - a.deficit || (a.id < b.id ? -1 : 1));
  const facilitiesDone = new Set<string>();
  for (const cand of ranked) {
    const def = world.data.units.get(cand.id)!;
    if (facilitiesDone.has(def.facility)) continue;
    const front = pickFront(world, f, def.id);
    const at = pickPlace(world, f, def.facility, front);
    if (!at) continue;
    const prot = f.protectedOrder;
    const reserve = prot && prot.unitId !== def.id ? reserveFor(world, prot.unitId) : { p: 0, m: 0 };
    const block = canStart(world, f, def, false, reserve);
    if (block === null) {
      startOrder(world, f, def, at, false, front);
      if (prot?.unitId === def.id) f.protectedOrder = null;
      facilitiesDone.add(def.facility);
      continue;
    }
    if ((block === 'INSUFFICIENT_M' || block === 'INSUFFICIENT_P') && !f.protectedOrder && def.costM >= 100 && world.time >= f.protectRetryAt) {
      // Protect the most-deficient expensive order so cheap units don't starve it.
      f.protectedOrder = { unitId: def.id, until: world.time + rules.economy.protected_order_seconds };
      world.note(f.id, 'log.protect', { unit: def.id }, 'info');
    }
    if (block === 'POP_FULL') return;
  }
}

/** Munitions spendable by automatic (non-manual) consumers: stock minus the protected reserve (par. 2.4). */
export function availableM(world: World, f: Faction): number {
  return f.m - (f.protectedOrder ? reserveFor(world, f.protectedOrder.unitId).m : 0);
}

function reserveFor(world: World, unitId: string): { p: number; m: number } {
  const d = world.data.units.get(unitId)!;
  return { p: d.costP, m: d.costM };
}

/** Any live hostile combat unit (armed, not a truck) within r of the capital. */
function capitalBesieged(world: World, f: number, r: number): boolean {
  const hq = world.hqPos(f);
  return world.spatial.findOwner(hq.x, hq.z, r, hostileMask(world, f), (u) => u.hp > 0 && u.primary !== null && u.def.id !== 'supply_truck' && world.isHostile(f, u.owner)) !== null;
}

/** Advance orders; completed units spawn at the city exit (or wait if blocked). */
export function advanceProduction(world: World, f: Faction, seconds: number): void {
  const refundAfter = world.data.rules.logistics?.contested_refund_seconds ?? 20;
  for (let i = 0; i < f.orders.length; i++) {
    const o = f.orders[i];
    // 2.2: a lost place drops its queue (refunded at the cancel ratio); a contested one pauses,
    // and is refunded too once contested for long.
    const place = placeById(world, o.placeId);
    if (place && place.capitalOf < 0) {
      const lost = placeOwner(world, place) !== f.id;
      const contested = placeContested(world, place);
      if (lost || (contested && place.contestedSince >= 0 && world.time - place.contestedSince >= refundAfter)) {
        world.note(f.id, 'log.queueLost', { unit: o.unitId, point: place.id }, 'warn');
        cancelOrder(world, f, o.id);
        i--;
        continue;
      }
      if (contested) continue;
    }
    if (o.remaining > 0) {
      o.remaining -= seconds;
      continue;
    }
    const at = o.spawn ?? world.cityOf(f.id).exit;
    // A besieged capital cannot keep refilling its own capture ring with fresh units.
    const siegeR = world.data.rules.victory.siege_blocks_production_radius_m ?? 0;
    if (siegeR > 0 && dist(at, world.hqPos(f.id)) < siegeR * 1.5 && capitalBesieged(world, f.id, siegeR)) {
      if (!o.blocked) world.note(f.id, 'log.capitalBesieged', {}, 'warn');
      o.blocked = true;
      continue;
    }
    const near = world.spatial.query(at.x, at.z, 10);
    if (near.length > 6) {
      if (!o.blocked) world.note(f.id, 'log.exitBlocked', {}, 'warn');
      o.blocked = true;
      continue;
    }
    const nav = world.navFor({ def: world.data.units.get(o.unitId)! } as Unit);
    let jitter = nav.nearestPassable({ x: at.x + world.rngAi.range(-12, 12), z: at.z + world.rngAi.range(-12, 12) }, 40) ?? at;
    // A jittered point can land in a cut-off pocket next to the exit: roll out at the exit instead.
    // A forward place can be foot-only ground (a valley town behind steep slopes): a vehicle that
    // could never drive out rolls out of the capital instead.
    const exit = world.cityOf(f.id).exit;
    if (!nav.connected(jitter, exit)) {
      const atOk = nav.nearestPassable(at, 40);
      jitter = atOk && nav.connected(atOk, exit) ? atOk : (nav.nearestPassable({ x: exit.x + world.rngAi.range(-12, 12), z: exit.z + world.rngAi.range(-12, 12) }, 40) ?? exit);
    }
    // The order's front may have been dissolved while it was in production (theatre.ts).
    const u = world.spawnUnit(f.id, o.unitId, jitter, frontById(f, o.frontId) ? o.frontId : pickFront(world, f, o.unitId));
    u.behavior = 'rally';
    // 2.2: new units roll out with no ammunition and rearm at the stock / a truck first (par. 3.4).
    if (world.data.rules.logistics) u.ammo = 0;
    recordBuilt(world.stats, u);
    f.producedUnits++;
    f.orders.splice(i, 1);
    i--;
  }
}

export function cancelOrder(world: World, f: Faction, orderId: number): boolean {
  const idx = f.orders.findIndex((o) => o.id === orderId);
  if (idx < 0) return false;
  const o = f.orders[idx];
  const r = world.data.rules.economy.cancel_started_refund_ratio;
  refund(f, o.costP * r, o.costM * r, world.data.rules);
  f.spent.push({ tick: world.tick, unitId: o.unitId, value: -(o.costP + o.costM) * r });
  f.orders.splice(idx, 1);
  return true;
}
