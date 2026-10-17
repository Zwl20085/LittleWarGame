import { moveTo, stop } from './movement';
import { frontById } from './frontref';
import { safeRear } from './frontai';
import type { Faction, Front, Place, Unit } from './types';
import { crowdEfficiency, drawsAmmo, inContact, logisticsRules, armyScale, nearestStock, placeById, placeContested, placeOwner } from './settlements';
import { dist, type V2 } from './vec';
import type { World } from './world';
import { truckCapacityMul } from './upgradestats';

/**
 * Physical supply convoys (user decision 2026-10-02, replaces the abstract relay network):
 * trucks load ammunition at the city depot (rate = logistics L), drive the road network to a
 * supply point behind a battle group, hand ammunition to units around them, then drive back.
 * The resulting truck chains can be protected, raided and cut.
 */
export const CONVOY = {
  capacity: 40, // cargo units: refilling 1.0 ammo of a unit costs its supply_demand
  loadPerSecond: 12,
  unloadPerSecond: 8,
  handoverRadius: 190,
  depotRadius: 140,
  standoff: 110, // supply point distance behind the battle line
  fleeRadius: 130,
  suppliedMemorySeconds: 90,
} as const;

/** 2.2 supply round: truck cargo and hand-over rate from rules.json logistics (defaults: CONVOY). */
/** 3.0: the truck-capacity upgrade enlarges a faction's loads (upgradestats.ts). */
const truckCap = (world: World, f = -1): number => (logisticsRules(world).truck_capacity ?? 40) * (f >= 0 ? truckCapacityMul(world, f) : 1);
const truckUnload = (world: World): number => logisticsRules(world).truck_unload_per_second ?? 8;
const truckReach = (world: World): number => logisticsRules(world).truck_handover_radius_m ?? CONVOY.handoverRadius;

/** Cargo needed to top a unit up to full ammunition. */
export const ammoNeed = (u: Unit): number => (1 - u.ammo) * u.def.supplyDemand;

/**
 * 2.2: trucks load from the settlement stocks (settlements.ts). The best stock for a truck is a
 * short drive from its group, with enough in it to fill the truck; the capital is the fallback.
 */
function bestStock(world: World, f: number, target: V2): Place {
  let best: Place | null = null;
  let bs = Infinity;
  for (const p of world.places) {
    if (placeOwner(world, p) !== f || placeContested(world, p)) continue;
    const score = dist(p.pos, target) + (p.stock < truckCap(world, f) ? 900 : 0) + (p.stock < 2 ? 3000 : 0);
    if (score < bs) {
      bs = score;
      best = p;
    }
  }
  return best ?? placeById(world, `cap:${f}`)!;
}

/** Group most in need of ammunition, discounted by trucks already heading there. */
function pickDestination(world: World, f: Faction, trucks: Unit[]): { front: Front; pos: V2 } | null {
  let best: { front: Front; pos: V2 } | null = null;
  let bestNeed = 0;
  const needs = frontNeeds(world, f);
  for (const s of f.fronts) {
    const need = needs.get(s.id) ?? 0;
    const enRoute = trucks.filter((t) => t.hp > 0 && t.truckState === 'out' && t.frontId === s.id).length;
    const score = need / (1 + enRoute * 1.5);
    if (score > bestNeed) {
      bestNeed = score;
      const safe = supplyPoint(world, f, s);
      best = { front: s, pos: world.nav(true, 22).nearestPassable(safe, 60) ?? safe };
    }
  }
  return bestNeed > 2 ? best : null;
}

interface NeedCache { tick: number; byFaction: Map<number, number>[]; needy: Map<number, { x: number; z: number; n: number }>[] }
const needCache = new WeakMap<World, NeedCache>();
/** Ammunition need per faction/front (and where its needy units are), recomputed at most once per second. */
function needs(world: World): NeedCache {
  let c = needCache.get(world);
  if (!c || world.tick - c.tick >= world.tickHz) {
    // By front id (ids are stable but not indices: fronts are created and dissolved, theatre.ts).
    const byFaction = world.factions.map(() => new Map<number, number>());
    const needy = world.factions.map(() => new Map<number, { x: number; z: number; n: number }>());
    const below = logisticsRules(world).truck_meet_below ?? 0;
    for (const u of world.units.values()) {
      if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck') continue;
      if (dist(u.pos, world.hqPos(u.owner)) < world.data.rules.supply.city_local_radius_m) continue;
      const arr = byFaction[u.owner];
      if (arr) arr.set(u.frontId, (arr.get(u.frontId) ?? 0) + ammoNeed(u) + 0.05 * u.def.supplyDemand); // upkeep so idle groups get visits
      if (below > 0 && u.primary && (u.rearming || u.ammo < below)) {
        const m = needy[u.owner];
        const e = m?.get(u.frontId);
        if (e) { e.x += u.pos.x; e.z += u.pos.z; e.n++; } else m?.set(u.frontId, { x: u.pos.x, z: u.pos.z, n: 1 });
      }
    }
    c = { tick: world.tick, byFaction, needy };
    needCache.set(world, c);
  }
  return c;
}
const frontNeeds = (world: World, f: Faction): Map<number, number> => needs(world).byFaction[f.id];

/**
 * Where a truck of front `s` hands over: CONVOY.standoff behind the line centre on the way home —
 * 3.0: or, when the front has units short of ammunition, at their centre (the tank block or a
 * detachment rearming away from the line centre was never reached) — pulled back off hostile ground.
 */
function supplyPoint(world: World, f: Faction, s: Front): V2 {
  const home = world.hqPos(f.id);
  const e = needs(world).needy[f.id]?.get(s.id);
  let p: V2;
  if (e && e.n > 0) p = { x: e.x / e.n, z: e.z / e.n };
  else {
    const d = dist(home, s.front);
    const t = d > 0 ? Math.max(0, (d - CONVOY.standoff) / d) : 0;
    p = { x: home.x + (s.front.x - home.x) * t, z: home.z + (s.front.z - home.z) * t };
  }
  return safeRear(world, f.id, p, home, 170);
}

function knownThreatNear(world: World, u: Unit, r: number): boolean {
  for (const o of world.spatial.query(u.pos.x, u.pos.z, r)) {
    if (o.hp > 0 && world.isHostile(u.owner, o.owner) && world.knows(u.owner, o) && o.primary) return true;
  }
  return false;
}

/** Truck behaviour (called from the unit executor). */
export function thinkConvoyTruck(world: World, u: Unit): void {
  const f = world.factions[u.owner];
  // Reload at the stock best placed for this truck's group (capital or a held town/city).
  const group = frontById(f, u.frontId);
  const stockAt = bestStock(world, u.owner, group ? group.front : world.hqPos(u.owner));
  const depot = stockAt.pos;
  const trucks = trucksOf(world, u.owner);
  // Threatened away from home: abort and run back (the enemy is hunting the supply line).
  // 3.0: with cargo, only fall back out of reach and hand over there (fallBack).
  if ((u.truckState === 'out' || u.truckState === 'unload') && knownThreatNear(world, u, CONVOY.fleeRadius)) {
    if (!fallBack(world, u)) u.truckState = 'return';
    world.note(u.owner, 'log.convoyThreat', {}, 'warn');
  }
  switch (u.truckState) {
    case 'load': {
      if (dist(u.pos, depot) > CONVOY.depotRadius) {
        moveTo(world, u, depot);
        u.status = 'status.toDepot';
        return;
      }
      stop(u);
      u.status = 'status.loading';
      if (u.cargo >= truckCap(world, u.owner) * 0.95 || (u.cargo > truckCap(world, u.owner) * 0.4 && stockAt.stock < 1)) {
        const dest = pickDestination(world, f, trucks);
        if (dest) {
          u.truckState = 'out';
          u.truckDest = dest.pos;
          u.frontId = dest.front.id;
        }
      }
      return;
    }
    case 'out': {
      if (!u.truckDest) {
        u.truckState = 'return';
        return;
      }
      // Keep following the group's line as it moves.
      const s = frontById(f, u.frontId);
      // 3.0: units that ran short meet the truck on its way — it stops and hands over there.
      if (meetsNeedy(world, u)) {
        u.truckState = 'unload';
        u.truckIdleSince = world.time;
        stop(u);
        return;
      }
      if (s && (HELD_BACK.get(u) ?? -1) < world.time) {
        const safe = supplyPoint(world, f, s);
        if (dist(safe, u.truckDest) > 60) u.truckDest = world.navFor(u).nearestPassable(safe, 60) ?? safe;
      }
      moveTo(world, u, u.truckDest);
      u.status = 'status.convoyOut';
      if (dist(u.pos, u.truckDest) < 30 || (u.pathFailed && dist(u.pos, u.truckDest) < 120)) {
        u.truckState = 'unload';
        u.truckIdleSince = world.time;
      }
      if (u.pathFailed && dist(u.pos, u.truckDest) >= 120) u.truckState = 'return';
      return;
    }
    case 'unload':
      stop(u);
      u.status = 'status.unloading';
      if (u.cargo < 0.5 || world.time - u.truckIdleSince > (logisticsRules(world).truck_unload_wait_s ?? 12)) u.truckState = 'return';
      return;
    case 'return':
    default:
      moveTo(world, u, depot);
      u.status = 'status.convoyBack';
      if (dist(u.pos, depot) < CONVOY.depotRadius * 0.8) u.truckState = 'load';
  }
}

/**
 * 3.0 fix for the ammo-starved tank herd (docs/DEBUG_LAB.md): the supply point sits CONVOY.standoff
 * (110 m) behind the line but a truck flees from any enemy within fleeRadius (130 m), so trucks
 * near a moving front turned back fully loaded, reloaded nothing and drove out again — and the tank
 * block (the group furthest forward) chased them and never drew. A threatened truck with cargo now
 * pulls back `truck_fallback_m` toward home and hands over there (held for HOLD_S, not re-aimed at
 * the line); units walking to it can reach it.
 */
const HELD_BACK = new WeakMap<Unit, number>();
const HOLD_S = 60;

function fallBack(world: World, u: Unit): boolean {
  const back = logisticsRules(world).truck_fallback_m ?? 0;
  if (back <= 0 || u.cargo < 2) return false;
  const home = world.hqPos(u.owner);
  const d = dist(u.pos, home);
  if (d < back) return false;
  const t = back / d;
  const p = { x: u.pos.x + (home.x - u.pos.x) * t, z: u.pos.z + (home.z - u.pos.z) * t };
  u.truckDest = world.navFor(u).nearestPassable(p, 60) ?? p;
  u.truckState = 'out';
  HELD_BACK.set(u, world.time + HOLD_S);
  return true;
}

const SC_MEET: Unit[] = [];
/** Units this close to an own stock draw from it; a truck does not stop for them there. */
const MEET_STOCK_CLEAR_M = 300;

/** An own unit below truck_meet_below (out of contact) within hand-over reach of this loaded truck, away from any stock. */
function meetsNeedy(world: World, u: Unit): boolean {
  const below = logisticsRules(world).truck_meet_below ?? 0;
  if (below <= 0 || u.cargo < 2) return false;
  const r = truckReach(world);
  let found = false;
  for (const o of world.spatial.query(u.pos.x, u.pos.z, r, SC_MEET)) {
    if (o.owner === u.owner && o.ammo < below && drawsAmmo(o) && !inContact(world, o) && dist(o.pos, u.pos) <= r) {
      found = true;
      break;
    }
  }
  return found && nearestStock(world, u.owner, u.pos, 1, MEET_STOCK_CLEAR_M) === null;
}

const truckCache = new WeakMap<World, { tick: number; byFaction: Unit[][] }>();
/** Living trucks per faction, rebuilt at most once per second. */
function trucksOf(world: World, f: number): Unit[] {
  let c = truckCache.get(world);
  if (!c || world.tick - c.tick >= world.tickHz) {
    const byFaction: Unit[][] = world.factions.map(() => []);
    for (const t of world.units.values()) if (t.def.id === 'supply_truck' && t.hp > 0) byFaction[t.owner].push(t);
    c = { tick: world.tick, byFaction };
    truckCache.set(world, c);
  }
  // The list is rebuilt every second; callers skip dead trucks themselves.
  return c.byFaction[f];
}

/** Area-cap cell key for a position (per-second convoy hand-over budget per cell). */
const cellKey = (p: V2, cell: number): number => Math.floor(p.x / cell) * 4096 + Math.floor(p.z / cell);
const SC_HAND: Unit[] = [];

/**
 * Once per second: loading at settlement stocks and gradual hand-over of ammunition. Hand-over is
 * the same rate as at a stock (rearm_per_second × crowding) and all trucks in one area share a
 * per-second cap, so a crowd of trucks in one spot does not stack (V22_SPEC §3.2, §3.5).
 */
export function convoySecond(world: World, f: Faction): void {
  const l = logisticsRules(world);
  const areaCap = l.convoy_area_cap_per_second_k * armyScale(world);
  const areaUsed = new Map<number, number>();
  for (const t of trucksOf(world, f.id)) {
    if (t.hp <= 0) continue;
    if (t.truckState === 'load') {
      const at = nearestOwnPlace(world, f.id, t.pos, CONVOY.depotRadius);
      if (!at) continue;
      const take = Math.min(CONVOY.loadPerSecond, truckCap(world, f.id) - t.cargo, at.stock);
      if (take > 0) {
        t.cargo += take;
        at.stock -= take;
      }
    } else if (t.truckState === 'unload' && t.cargo > 0) {
      const key = cellKey(t.pos, l.convoy_area_cell_m);
      const used = areaUsed.get(key) ?? 0;
      const near = world.spatial.query(t.pos.x, t.pos.z, truckReach(world), SC_HAND)
        .filter((u) => u.owner === f.id && drawsAmmo(u) && dist(u.pos, t.pos) <= truckReach(world))
        .sort((a, b) => a.ammo - b.ammo || a.id - b.id);
      const needy = near.filter((u) => u.ammo < 0.999 && !inContact(world, u)).length;
      const eff = crowdEfficiency(l, needy);
      let budget = Math.min(truckUnload(world), t.cargo, Math.max(0, areaCap - used));
      let gave = false;
      for (const u of near) {
        // 2.2 supply round: a unit in a firefight takes nothing from the truck (it must pull back to rearm).
        if (inContact(world, u)) continue;
        u.lastSuppliedAt = world.time;
        const need = ammoNeed(u);
        if (need <= 0 || budget <= 1e-9) continue;
        const give = Math.min(need, l.rearm_per_second * eff * u.def.supplyDemand, budget);
        u.ammo = Math.min(1, u.ammo + give / u.def.supplyDemand);
        budget -= give;
        t.cargo -= give;
        areaUsed.set(key, (areaUsed.get(key) ?? 0) + give);
        gave = true;
      }
      if (gave) t.truckIdleSince = world.time;
    }
  }
  // Supply status: reached by a stock (settlements.drawSecond) or a convoy recently.
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0) continue;
    u.supplied = u.fixed || u.def.id === 'supply_truck' || world.time - u.lastSuppliedAt < CONVOY.suppliedMemorySeconds;
    u.supplyRatio = u.supplied ? 1 : 0;
  }
  f.supplyDemand = [...world.units.values()].reduce((a, u) => a + (u.owner === f.id && u.hp > 0 && !u.fixed ? u.def.supplyDemand : 0), 0);
}

/** Own, uncontested place within r of p (truck loading), else null. */
function nearestOwnPlace(world: World, f: number, p: V2, r: number): Place | null {
  let best: Place | null = null;
  let bd = r;
  for (const q of world.places) {
    if (placeOwner(world, q) !== f || placeContested(world, q)) continue;
    const d = dist(q.pos, p);
    if (d <= bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}
