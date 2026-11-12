import { moveTo, stop } from './movement';
import { frontById } from './frontref';
import { safeRear } from './frontai';
import { hostileMask } from './spatial';
import type { Faction, Front, Place, Unit } from './types';
import { crowdEfficiency, drawsAmmo, inContact, logisticsRules, armyScale, nearestStock, placeById, placeContested, placeOwner, rearmRate } from './settlements';
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
function bestStock(world: World, u: Unit, target: V2): Place {
  const f = u.owner;
  // Stay at the current depot while loading if it still has stock to give.
  if (u.truckState === 'load') {
    const cur = nearestOwnPlace(world, f, u.pos, CONVOY.depotRadius);
    if (cur && cur.stock >= 1) return cur;
  }
  const need = Math.max(2, truckCap(world, f) - u.cargo);
  let best: Place | null = null;
  let bs = Infinity;
  for (const p of world.places) {
    if (placeOwner(world, p) !== f || placeContested(world, p)) continue;
    const score = dist(p.pos, u.pos) * 0.7 + dist(p.pos, target) * 0.5 + (p.stock < need ? 900 : 0) + (p.stock < 2 ? 3000 : 0);
    if (score < bs) {
      bs = score;
      best = p;
    }
  }
  return best ?? placeById(world, `cap:${f}`)!;
}

/** Group most in need of ammunition, discounted by trucks already heading there or unloading there, and weighted by distance. */
function pickDestination(world: World, f: Faction, trucks: Unit[], u: Unit): { front: Front; pos: V2 } | null {
  let best: { front: Front; pos: V2 } | null = null;
  let bestScore = 0;
  const needs = frontNeeds(world, f);
  for (const s of f.fronts) {
    const need = needs.get(s.id) ?? 0;
    const active = trucks.filter((t) => t.hp > 0 && t.id !== u.id && (t.truckState === 'out' || (t.truckState === 'unload' && t.cargo > 2)) && t.frontId === s.id).length;
    const dFactor = 1 + dist(u.pos, s.front) / 1400;
    const score = (need + 1.5) / ((1 + active * 1.5) * dFactor);
    if (score > bestScore) {
      bestScore = score;
      const safe = supplyPoint(world, f, s, u);
      best = { front: s, pos: world.nav(true, 22).nearestPassable(safe, 60) ?? safe };
    }
  }
  return bestScore > 0.25 ? best : null;
}

interface NeedCache { tick: number; byFaction: Map<number, number>[]; needy: Map<number, { x: number; z: number; n: number }>[] }
const needCache = new WeakMap<World, NeedCache>();
/** Ammunition need per faction/front (and where its needy front-line units are), recomputed at most once per second. */
function needs(world: World): NeedCache {
  let c = needCache.get(world);
  if (!c || world.tick - c.tick >= world.tickHz) {
    // By front id (ids are stable but not indices: fronts are created and dissolved, theatre.ts).
    const byFaction = world.factions.map(() => new Map<number, number>());
    const needy = world.factions.map(() => new Map<number, { x: number; z: number; n: number }>());
    const below = logisticsRules(world).truck_meet_below ?? 0;
    for (const u of world.aliveUnits) {
      if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck') continue;
      if (dist(u.pos, world.hqPos(u.owner)) < world.data.rules.supply.city_local_radius_m) continue;
      // Units already standing at an own settlement stock draw from that stock, not from front convoys.
      if (nearestStock(world, u.owner, u.pos, 1, 240) !== null) continue;
      const arr = byFaction[u.owner];
      if (arr) arr.set(u.frontId, (arr.get(u.frontId) ?? 0) + ammoNeed(u) + 0.05 * u.def.supplyDemand); // upkeep so idle groups get visits
      if (below > 0 && u.primary && (u.rearming || u.ammo < below)) {
        const fac = world.factions[u.owner];
        const s = fac ? frontById(fac, u.frontId) : undefined;
        // Only average needy units reasonably near the front so rear stragglers do not pull the supply point away.
        if (s && dist(u.pos, s.front) > 600) continue;
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
 * blended moderately toward needy units near the front and spread laterally per truck so convoys
 * don't stack on one cell or chase jumping centroids across the map.
 */
function supplyPoint(world: World, f: Faction, s: Front, u?: Unit): V2 {
  const home = world.hqPos(f.id);
  const d = dist(home, s.front);
  const t = d > 0 ? Math.max(0, (d - CONVOY.standoff) / d) : 0;
  let p: V2 = { x: home.x + (s.front.x - home.x) * t, z: home.z + (s.front.z - home.z) * t };
  const e = needs(world).needy[f.id]?.get(s.id);
  if (e && e.n > 0) {
    const nx = e.x / e.n;
    const nz = e.z / e.n;
    const dx = nx - p.x;
    const dz = nz - p.z;
    const nd = Math.hypot(dx, dz);
    const step = Math.min(220, nd * 0.5);
    if (nd > 1) p = { x: p.x + (dx / nd) * step, z: p.z + (dz / nd) * step };
  }
  if (u && d > 1) {
    const ux = (s.front.x - home.x) / d;
    const uz = (s.front.z - home.z) / d;
    const lat = ((u.id % 5) - 2) * 55;
    p = { x: p.x - uz * lat, z: p.z + ux * lat };
  }
  return safeRear(world, f.id, p, home, 170);
}

/** Ring offset around a depot so loading/waiting trucks don't park directly on top of the production spawn exit. */
function depotSpot(world: World, u: Unit, depot: V2): V2 {
  const a = ((u.id * 137) % 360) * (Math.PI / 180);
  const r = 52 + (u.id % 3) * 16;
  const p = { x: depot.x + Math.cos(a) * r, z: depot.z + Math.sin(a) * r };
  return world.navFor(u).nearestPassable(p, 45) ?? depot;
}

function knownThreatNear(world: World, u: Unit, r: number): boolean {
  return world.spatial.findOwner(u.pos.x, u.pos.z, r, hostileMask(world, u.owner), (o) => o.hp > 0 && o.primary !== null && world.knows(u.owner, o)) !== null;
}

/** Truck behaviour (called from the unit executor). */
export function thinkConvoyTruck(world: World, u: Unit): void {
  const f = world.factions[u.owner];
  // Reload at the stock best placed for this truck's group (capital or a held town/city).
  const group = frontById(f, u.frontId);
  const stockAt = bestStock(world, u, group ? group.front : world.hqPos(u.owner));
  const depot = stockAt.pos;
  const trucks = trucksOf(world, u.owner);
  const fallingBack = (FALLBACK_UNTIL.get(u) ?? -1) > world.time;
  // Threatened away from home: abort and run back (the enemy is hunting the supply line).
  // 3.0: with cargo, only fall back out of reach and hand over there (fallBack).
  if ((u.truckState === 'out' || u.truckState === 'unload') && knownThreatNear(world, u, CONVOY.fleeRadius)) {
    if (!fallingBack) {
      if (!fallBack(world, u)) u.truckState = 'return';
      if (world.time - (THREAT_NOTED.get(u) ?? -1e9) > 15) {
        THREAT_NOTED.set(u, world.time);
        world.note(u.owner, 'log.convoyThreat', {}, 'warn');
      }
    }
    if (u.truckState === 'out' && u.truckDest) {
      moveTo(world, u, u.truckDest);
      u.status = 'status.convoyOut';
      return;
    }
  }
  switch (u.truckState) {
    case 'load': {
      if (dist(u.pos, depot) > CONVOY.depotRadius) {
        moveTo(world, u, depotSpot(world, u, depot));
        u.status = 'status.toDepot';
        return;
      }
      if (dist(u.pos, depot) < 34) moveTo(world, u, depotSpot(world, u, depot));
      else stop(u);
      u.status = 'status.loading';
      if (u.cargo >= truckCap(world, u.owner) * 0.95 || (u.cargo > truckCap(world, u.owner) * 0.4 && stockAt.stock < 1)) {
        const dest = pickDestination(world, f, trucks, u);
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
      // 3.0: units that ran short meet the truck on its way — it stops and hands over there (never while retreating from threat).
      if (!fallingBack && !knownThreatNear(world, u, CONVOY.fleeRadius + 30) && meetsNeedy(world, u)) {
        u.truckState = 'unload';
        u.truckIdleSince = world.time;
        stop(u);
        return;
      }
      if (s && (HELD_BACK.get(u) ?? -1) < world.time) {
        const safe = supplyPoint(world, f, s, u);
        if (dist(safe, u.truckDest) > 180) u.truckDest = world.navFor(u).nearestPassable(safe, 60) ?? safe;
      }
      moveTo(world, u, u.truckDest);
      u.status = 'status.convoyOut';
      if (dist(u.pos, u.truckDest) < 35 || (u.pathFailed && dist(u.pos, u.truckDest) < 120)) {
        u.truckState = 'unload';
        u.truckIdleSince = world.time;
        FALLBACK_UNTIL.delete(u);
      }
      if (u.pathFailed && dist(u.pos, u.truckDest) >= 120) u.truckState = 'return';
      return;
    }
    case 'unload': {
      stop(u);
      u.status = 'status.unloading';
      if (u.cargo < 0.5) {
        u.truckState = 'return';
        return;
      }
      const idle = world.time - u.truckIdleSince;
      const hasCargo = u.cargo >= truckCap(world, u.owner) * 0.35;
      // Stopped mid-route for a passer-by or the front pushed ahead: resume advancing once nobody draws for 5 s.
      if (hasCargo && idle > 5 && (HELD_BACK.get(u) ?? -1) < world.time) {
        const s = frontById(f, u.frontId);
        const safe = s ? supplyPoint(world, f, s, u) : null;
        if (safe && dist(u.pos, safe) > 95) {
          u.truckDest = world.navFor(u).nearestPassable(safe, 60) ?? safe;
          u.truckState = 'out';
          return;
        }
      }
      if (idle > (logisticsRules(world).truck_unload_wait_s ?? 12)) {
        if (hasCargo) {
          const dest = pickDestination(world, f, trucks, u);
          if (dest && dist(u.pos, dest.pos) > 95) {
            u.truckState = 'out';
            u.truckDest = dest.pos;
            u.frontId = dest.front.id;
          } else {
            // Already stationed at the best front supply point with cargo: hold position here rather than driving back full.
            u.truckIdleSince = world.time;
          }
        } else {
          u.truckState = 'return';
        }
      }
      return;
    }
    case 'return':
    default:
      moveTo(world, u, depotSpot(world, u, depot));
      u.status = 'status.convoyBack';
      if (dist(u.pos, depot) < CONVOY.depotRadius * 0.85) u.truckState = 'load';
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
const FALLBACK_UNTIL = new WeakMap<Unit, number>();
const THREAT_NOTED = new WeakMap<Unit, number>();
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
  FALLBACK_UNTIL.set(u, world.time + 12);
  return true;
}

/** Units this close to an own stock draw from it; a truck does not stop for them there. */
const MEET_STOCK_CLEAR_M = 300;

/** An own unit below truck_meet_below (out of contact) within hand-over reach of this loaded truck, away from any stock. */
function meetsNeedy(world: World, u: Unit): boolean {
  const below = logisticsRules(world).truck_meet_below ?? 0;
  if (below <= 0 || u.cargo < 2) return false;
  if (nearestStock(world, u.owner, u.pos, 1, MEET_STOCK_CLEAR_M) !== null) return false;
  const r = truckReach(world);
  return world.spatial.findOwner(u.pos.x, u.pos.z, r, 1 << u.owner, (o) => (o.rearming || o.ammo < below) && drawsAmmo(o) && !inContact(world, o)) !== null;
}

const truckCache = new WeakMap<World, { tick: number; byFaction: Unit[][] }>();
/** Living trucks per faction, rebuilt at most once per second. */
function trucksOf(world: World, f: number): Unit[] {
  let c = truckCache.get(world);
  if (!c || world.tick - c.tick >= world.tickHz) {
    const byFaction: Unit[][] = world.factions.map(() => []);
    for (const t of world.aliveUnits) if (t.def.id === 'supply_truck' && t.hp > 0) byFaction[t.owner].push(t);
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
      const cap = truckCap(world, f.id);
      const loadRate = Math.max(CONVOY.loadPerSecond, cap * 0.45);
      const take = Math.min(loadRate, cap - t.cargo, at.stock);
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
        const give = Math.min(need, rearmRate(l, u) * eff * u.def.supplyDemand, budget);
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
  let demand = 0;
  for (const u of world.unitsOf(f.id)) {
    if (u.hp <= 0) continue;
    u.supplied = u.fixed || u.def.id === 'supply_truck' || world.time - u.lastSuppliedAt < CONVOY.suppliedMemorySeconds;
    u.supplyRatio = u.supplied ? 1 : 0;
    if (!u.fixed) demand += u.def.supplyDemand;
  }
  f.supplyDemand = demand;
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
