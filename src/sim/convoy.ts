import { moveTo, stop } from './movement';
import { frontById } from './frontref';
import { safeRear } from './frontai';
import type { Faction, Front, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

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

/** Cargo needed to top a unit up to full ammunition. */
export const ammoNeed = (u: Unit): number => (1 - u.ammo) * u.def.supplyDemand;

function depotOf(world: World, f: number): V2 {
  return world.cityOf(f).exit;
}

export interface Depot {
  readonly pos: V2;
  /** Fraction of drawn ammunition that actually arrives (falls with distance from the capital). */
  readonly eff: number;
}

const depotCache = new WeakMap<World, { tick: number; byFaction: Depot[][] }>();
/**
 * Supply depots (user request): the capital plus every held, uncontested town or city. Each
 * draws on the faction's logistics pool; efficiency decreases with distance from the capital.
 * Recomputed at most once per second.
 */
export function depotsOf(world: World, f: number): Depot[] {
  let c = depotCache.get(world);
  if (!c || world.tick - c.tick >= world.tickHz) {
    const terr = world.data.rules.territory;
    const falloff = terr?.depot_efficiency_falloff_m ?? 2600;
    const minEff = terr?.depot_min_efficiency ?? 0.35;
    const byFaction: Depot[][] = world.factions.map((fac) => {
      const hq = world.hqPos(fac.id);
      const list: Depot[] = [{ pos: world.cityOf(fac.id).exit, eff: 1 }];
      for (const o of world.objectives) {
        if (o.owner !== fac.id || o.contested || (o.kind !== 'town' && o.kind !== 'city')) continue;
        list.push({ pos: o.pos, eff: Math.max(minEff, 1 - dist(o.pos, hq) / falloff) });
      }
      return list;
    });
    c = { tick: world.tick, byFaction };
    depotCache.set(world, c);
  }
  return c.byFaction[f];
}

/** Depot best placed to serve `target`: short drive, discounted by low efficiency. */
function bestDepot(world: World, f: number, target: V2): Depot {
  let best: Depot | null = null;
  let bs = Infinity;
  for (const d of depotsOf(world, f)) {
    const score = dist(d.pos, target) + (1 - d.eff) * 900;
    if (score < bs) {
      bs = score;
      best = d;
    }
  }
  return best ?? { pos: depotOf(world, f), eff: 1 };
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
      const home = world.hqPos(f.id);
      const d = dist(home, s.front);
      const t = d > 0 ? Math.max(0, (d - CONVOY.standoff) / d) : 0;
      const p = { x: home.x + (s.front.x - home.x) * t, z: home.z + (s.front.z - home.z) * t };
      const safe = safeRear(world, f.id, p, home, 170);
      best = { front: s, pos: world.nav(true, 22).nearestPassable(safe, 60) ?? safe };
    }
  }
  return bestNeed > 2 ? best : null;
}

const needCache = new WeakMap<World, { tick: number; byFaction: Map<number, number>[] }>();
/** Ammunition need per faction/front, recomputed at most once per second. */
function frontNeeds(world: World, f: Faction): Map<number, number> {
  let c = needCache.get(world);
  if (!c || world.tick - c.tick >= world.tickHz) {
    // By front id (ids are stable but not indices: fronts are created and dissolved, theatre.ts).
    const byFaction = world.factions.map(() => new Map<number, number>());
    for (const u of world.units.values()) {
      if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck') continue;
      if (dist(u.pos, world.hqPos(u.owner)) < world.data.rules.supply.city_local_radius_m) continue;
      const arr = byFaction[u.owner];
      if (arr) arr.set(u.frontId, (arr.get(u.frontId) ?? 0) + ammoNeed(u) + 0.05 * u.def.supplyDemand); // upkeep so idle groups get visits
    }
    c = { tick: world.tick, byFaction };
    needCache.set(world, c);
  }
  return c.byFaction[f.id];
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
  // Reload at the depot best placed for this truck's group (capital or a held town/city).
  const group = frontById(f, u.frontId);
  const depot = bestDepot(world, u.owner, group ? group.front : world.hqPos(u.owner)).pos;
  const trucks = trucksOf(world, u.owner);
  // Threatened away from home: abort and run back (the enemy is hunting the supply line).
  if ((u.truckState === 'out' || u.truckState === 'unload') && knownThreatNear(world, u, CONVOY.fleeRadius)) {
    u.truckState = 'return';
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
      if (u.cargo >= CONVOY.capacity * 0.95 || (u.cargo > CONVOY.capacity * 0.4 && f.depot < 1)) {
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
      if (s) {
        const home = world.hqPos(u.owner);
        const d = dist(home, s.front);
        const t = d > 0 ? Math.max(0, (d - CONVOY.standoff) / d) : 0;
        const p = { x: home.x + (s.front.x - home.x) * t, z: home.z + (s.front.z - home.z) * t };
        const safe = safeRear(world, u.owner, p, home, 170);
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
      if (u.cargo < 0.5 || world.time - u.truckIdleSince > 12) u.truckState = 'return';
      return;
    case 'return':
    default:
      moveTo(world, u, depot);
      u.status = 'status.convoyBack';
      if (dist(u.pos, depot) < CONVOY.depotRadius * 0.8) u.truckState = 'load';
  }
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

/** Once per second: depot production, loading and hand-over of ammunition. */
export function convoySecond(world: World, f: Faction): void {
  const cap = f.logistics * 2;
  f.depot = Math.min(cap, f.depot + f.logistics / 60);
  const depots = depotsOf(world, f.id);
  for (const t of trucksOf(world, f.id)) {
    const at = t.truckState === 'load' ? depots.find((d) => dist(t.pos, d.pos) <= CONVOY.depotRadius) : undefined;
    if (at) {
      // Distant depots lose part of what they draw from the pool (longer lines of communication).
      const take = Math.min(CONVOY.loadPerSecond, CONVOY.capacity - t.cargo, f.depot * at.eff);
      t.cargo += take;
      f.depot -= take / at.eff;
    } else if (t.truckState === 'unload' && t.cargo > 0) {
      // Hand over to the neediest units around the truck.
      const near = world.spatial.query(t.pos.x, t.pos.z, CONVOY.handoverRadius)
        .filter((u) => u.owner === f.id && u.hp > 0 && !u.fixed && u.id !== t.id && u.def.id !== 'supply_truck')
        .sort((a, b) => a.ammo - b.ammo);
      let budget = Math.min(CONVOY.unloadPerSecond, t.cargo);
      let gave = false;
      for (const u of near) {
        u.lastSuppliedAt = world.time;
        const need = ammoNeed(u);
        if (need <= 0 || budget <= 0) continue;
        const give = Math.min(need, budget);
        u.ammo = Math.min(1, u.ammo + give / u.def.supplyDemand);
        budget -= give;
        t.cargo -= give;
        gave = true;
      }
      if (gave) t.truckIdleSince = world.time;
    }
  }
  // Supply status for every unit: inside the city zone or recently reached by a convoy.
  const hq = world.hqPos(f.id);
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0) continue;
    const home = dist(u.pos, hq) <= world.data.rules.supply.city_local_radius_m;
    u.supplied = u.fixed || home || u.def.id === 'supply_truck' || world.time - u.lastSuppliedAt < CONVOY.suppliedMemorySeconds;
    u.supplyRatio = u.supplied ? 1 : 0;
  }
  f.supplyDemand = [...world.units.values()].reduce((a, u) => a + (u.owner === f.id && u.hp > 0 && !u.fixed ? u.def.supplyDemand : 0), 0);
}
