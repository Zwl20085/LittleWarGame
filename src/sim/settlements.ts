import { econLots } from './econLots';
import type { LogisticsRules } from '../data/types';
import { allocateSupply } from './supply';
import type { Faction, Place, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 settlement logistics (V22_SPEC §3): every owned capital / city / town holds a supply stock
 * with a cap. Logistics L fill the stocks (capital first-hand, towns lose part with distance);
 * convoys load from them (convoy.ts); units near a stock draw from it at a gradual rate, less
 * each in a crowd; a captured place loses its stock. Places are also the production sites (§4).
 */

/** Fallback when a rule set has no `logistics` section (old test rule sets). */
const DEFAULTS: LogisticsRules = {
  ammo_cost_multiplier: 1,
  stock_cap_k: { capital: 60, city: 30, town: 16 },
  initial_stock_ratio: 0.6,
  draw_radius_m: { capital: 260, city: 170, town: 130 },
  rearm_per_second: 0.025,
  crowd_free: 6,
  crowd_penalty: 0.15,
  place_handover_per_second_k: 0.6,
  convoy_area_cell_m: 200,
  convoy_area_cap_per_second_k: 1.2,
  rearm_below: 0.12,
  rearm_until: 0.6,
  truck_seek_radius_m: 450,
  stock_seek_radius_m: 2200,
  contested_refund_seconds: 20,
};

export const logisticsRules = (world: World): LogisticsRules => world.data.rules.logistics ?? DEFAULTS;
export const armyScale = (world: World): number => world.data.rules.proposed_defaults.army_scale ?? 1;

/** Crowding: share of the full rate each of `n` units drawing at one point receives. */
export function crowdEfficiency(l: LogisticsRules, n: number): number {
  return 1 / (1 + l.crowd_penalty * Math.max(0, n - l.crowd_free));
}

/** Build the place list: one per capital (at its exit) and per town / city objective. */
export function initPlaces(world: World): void {
  world.places.length = 0;
  for (const f of world.factions) {
    world.places.push({ id: `cap:${f.id}`, kind: 'capital', pos: { ...world.cityOf(f.id).exit }, objIdx: -1, capitalOf: f.id, slotPos: [], stock: 0, lastOwner: f.id, contestedSince: -1 });
  }
  const slots = world.data.rules.econ?.slots ?? {};
  const nav = world.nav(false, 35);
  world.objectives.forEach((o, i) => {
    if (o.kind !== 'town' && o.kind !== 'city') return;
    const n = slots[o.kind] ?? 0;
    // Deterministic lots on free ground at the settlement edge (econLots.ts); the old ring point
    // (nudged onto passable ground) is the fallback when no clear lot is found.
    const a0 = ((i * 2654435761) >>> 0) % 628 / 100;
    const ring = (k: number): V2 => {
      const a = a0 + (k * 2 * Math.PI) / Math.max(1, n);
      const r = Math.max(24, o.radius * 0.8);
      const p = { x: o.pos.x + Math.cos(a) * r, z: o.pos.z + Math.sin(a) * r };
      return nav.nearestPassable(p, 30) ?? p;
    };
    const town = world.terrain.def.towns.reduce<{ r: number; d: number }>((best, tw) => {
      const d = Math.hypot(tw.x - o.pos.x, tw.z - o.pos.z);
      return d < best.d ? { r: tw.r, d } : best;
    }, { r: o.radius, d: Infinity });
    const townR = town.d < 60 ? town.r : o.radius;
    const passable = (p: V2): boolean => {
      const q = nav.nearestPassable(p, 4);
      return q !== null && Math.hypot(q.x - p.x, q.z - p.z) < 4.5;
    };
    const slotPos = econLots(world.terrain, o.pos, townR, n, a0, passable, ring);
    world.places.push({ id: o.id, kind: o.kind, pos: { ...o.pos }, objIdx: i, capitalOf: -1, slotPos, stock: 0, lastOwner: o.owner, contestedSince: -1 });
  });
}

/** Starting stocks once the starting territory is assigned. */
export function seedStocks(world: World): void {
  const l = logisticsRules(world);
  for (const p of world.places) {
    p.lastOwner = placeOwner(world, p);
    if (p.lastOwner >= 0) p.stock = stockCap(world, p) * l.initial_stock_ratio;
  }
  for (const f of world.factions) f.depot = totalStock(world, f.id);
}

export function placeById(world: World, id: string): Place | undefined {
  for (const p of world.places) if (p.id === id) return p;
  return undefined;
}

export function placeOwner(world: World, p: Place): number {
  if (p.capitalOf >= 0) return world.factions[p.capitalOf]?.alive ? p.capitalOf : -1;
  return world.objectives[p.objIdx]?.owner ?? -1;
}

export function placeContested(world: World, p: Place): boolean {
  return p.objIdx >= 0 && !!world.objectives[p.objIdx]?.contested;
}

/** Owned by `f` and not contested (production and stock work). */
export function placeUsable(world: World, p: Place, f: number): boolean {
  return placeOwner(world, p) === f && !placeContested(world, p);
}

/** Stock cap: by kind × army scale, plus every working depot building on the place (econ.ts). */
export function stockCap(world: World, p: Place): number {
  const k = armyScale(world);
  let cap = logisticsRules(world).stock_cap_k[p.kind] * k;
  const depot = world.data.rules.econ?.buildings.depot;
  if (depot?.stock_cap_k) {
    for (const b of world.econ) if (b.placeId === p.id && b.kind === 'depot' && !b.ruined && b.progress >= 1) cap += depot.stock_cap_k * k * (b.hp / b.maxHp);
  }
  return cap;
}

export function drawRadius(world: World, p: Place): number {
  return logisticsRules(world).draw_radius_m[p.kind];
}

export function totalStock(world: World, f: number): number {
  let s = 0;
  for (const p of world.places) if (placeOwner(world, p) === f) s += p.stock;
  return s;
}

/** Fraction of logistics that reaches a place (falls with distance from the capital). */
export function placeEfficiency(world: World, p: Place, f: number): number {
  if (p.capitalOf >= 0) return 1;
  const terr = world.data.rules.territory;
  const falloff = terr?.depot_efficiency_falloff_m ?? 2600;
  const minEff = terr?.depot_min_efficiency ?? 0.35;
  return Math.max(minEff, 1 - dist(p.pos, world.hqPos(f)) / falloff);
}

/**
 * Once per second: ownership changes (stock lost), contest timers, filling the stocks from
 * logistics L (proportional to room × efficiency, only places connected to our ground), and the
 * flat fill of depot buildings. `connected(f, pos)` = the sim's inSupply test.
 */
export function stockSecond(world: World, connected: (f: number, p: V2) => boolean): void {
  for (const p of world.places) {
    const owner = placeOwner(world, p);
    if (owner !== p.lastOwner) {
      p.stock = 0; // a captured town's stock is lost (burned or carried off)
      p.lastOwner = owner;
    }
    if (placeContested(world, p)) {
      if (p.contestedSince < 0) p.contestedSince = world.time;
    } else p.contestedSince = -1;
  }
  const depot = world.data.rules.econ?.buildings.depot;
  const k = armyScale(world);
  for (const f of world.factions) {
    if (!f.alive) continue;
    const mine: Place[] = [];
    for (const p of world.places) if (placeOwner(world, p) === f.id && !placeContested(world, p) && (p.capitalOf >= 0 || connected(f.id, p.pos))) mine.push(p);
    const caps = mine.map((p) => stockCap(world, p));
    const room = mine.map((p, i) => Math.max(0, caps[i] - p.stock));
    const eff = mine.map((p) => placeEfficiency(world, p, f.id));
    // Capital weighted ×2: the faction's own depot is fed first-hand.
    const pri = mine.map((p, i) => eff[i] * (p.capitalOf >= 0 ? 2 : 1));
    // Wave 2: each place refills at most burst × its share of the flow (a pipeline, not a tap that
    // pours everything into the one drained town); what it cannot take is not delivered elsewhere.
    const burst = logisticsRules(world).place_fill_burst;
    const capSum = caps.reduce((a, c) => a + c, 0) || 1;
    const need = room.map((r, i) => (burst ? Math.min(r, (burst * f.logistics * caps[i]) / (60 * capSum)) : r) / eff[i]);
    const alloc = allocateSupply(need, pri, f.logistics / 60);
    mine.forEach((p, i) => {
      p.stock = Math.min(caps[i], p.stock + alloc[i] * eff[i]);
      if (depot?.fill_per_min_k) {
        for (const b of world.econ) {
          if (b.placeId === p.id && b.kind === 'depot' && !b.ruined && b.progress >= 1) p.stock = Math.min(caps[i], p.stock + (depot.fill_per_min_k * k * (b.hp / b.maxHp)) / 60);
        }
      }
    });
    f.depot = totalStock(world, f.id);
  }
}

/**
 * Logistics demand for the economy steward (economy.stewardStep compares it with L). Wave 2: when
 * `steward_stock_target` is set, the demand follows the stocks — L plus twice the share of the
 * target fill that is missing (0 shortfall = no call for more L); else the 2.1 rule (`fallback`).
 */
export function logisticsDemand(world: World, f: Faction, logistics: number, fallback: number): number {
  const target = logisticsRules(world).steward_stock_target;
  if (target === undefined) return fallback;
  let want = 0;
  let short = 0;
  for (const p of world.places) {
    if (placeOwner(world, p) !== f.id) continue;
    const t = stockCap(world, p) * target;
    want += t;
    short += Math.max(0, t - p.stock);
  }
  return logistics * (1 + (2 * short) / Math.max(1, want));
}

/** Can this unit take ammunition from stocks / trucks (armed, mobile, not a truck)? */
export function drawsAmmo(u: Unit): boolean {
  return u.hp > 0 && !u.fixed && u.primary !== null && u.def.id !== 'supply_truck';
}

const SC_DRAW: Unit[] = [];
const SC_NEEDY: Unit[] = [];

/**
 * Once per second: units near an own stock draw from it — a gradual rate (rearm_per_second of a
 * full load), cut by crowding, and capped per place per second. Units in range are marked
 * supplied (lastSuppliedAt) even when full.
 */
export function drawSecond(world: World): void {
  const l = logisticsRules(world);
  const k = armyScale(world);
  for (const p of world.places) {
    const owner = placeOwner(world, p);
    if (owner < 0) continue;
    const r = drawRadius(world, p);
    const near = world.spatial.query(p.pos.x, p.pos.z, r, SC_DRAW);
    SC_NEEDY.length = 0;
    const core = coreRadius(world, p);
    for (const u of near) {
      if (u.owner !== owner || !drawsAmmo(u) || dist(u.pos, p.pos) > r) continue;
      // In contact: only the defenders inside the settlement draw (no rearming while fighting at its edge).
      if (inContact(world, u) && dist(u.pos, p.pos) > core) continue;
      if (p.stock > 0.5) u.lastSuppliedAt = world.time;
      if (u.ammo < 0.999) SC_NEEDY.push(u);
    }
    if (SC_NEEDY.length === 0 || p.stock <= 0) continue;
    SC_NEEDY.sort((a, b) => a.ammo - b.ammo || a.id - b.id);
    const eff = crowdEfficiency(l, SC_NEEDY.length);
    let budget = Math.min(p.stock, l.place_handover_per_second_k * k);
    for (const u of SC_NEEDY) {
      if (budget <= 1e-9) break;
      const give = Math.min((1 - u.ammo) * u.def.supplyDemand, l.rearm_per_second * eff * u.def.supplyDemand, budget);
      u.ammo = Math.min(1, u.ammo + give / u.def.supplyDemand);
      budget -= give;
      p.stock -= give;
    }
  }
}

/** Fired within logistics.draw_contact_seconds (false when the rule is off). */
export function inContact(world: World, u: Unit): boolean {
  const s = logisticsRules(world).draw_contact_seconds;
  return s !== undefined && world.time - u.lastFiredAt < s;
}

/** Core of a place: its settlement radius × draw_core_ratio (capital: half the draw radius). */
function coreRadius(world: World, p: Place): number {
  const ratio = logisticsRules(world).draw_core_ratio ?? 1;
  const o = p.objIdx >= 0 ? world.objectives[p.objIdx] : undefined;
  return o ? o.radius * ratio : drawRadius(world, p) * 0.5;
}

/** Nearest own place with stock (≥ need) within `maxD` of `from`, else null. */
export function nearestStock(world: World, f: number, from: V2, need: number, maxD: number): Place | null {
  let best: Place | null = null;
  let bd = maxD;
  for (const p of world.places) {
    if (p.stock < need || placeOwner(world, p) !== f || placeContested(world, p)) continue;
    const d = dist(p.pos, from);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** Nearest own truck carrying cargo within r (handing over or able to), else null. */
function truckNear(world: World, u: Unit, r: number): Unit | null {
  let best: Unit | null = null;
  let bd = r;
  for (const t of world.spatial.query(u.pos.x, u.pos.z, r)) {
    if (t.owner !== u.owner || t.def.id !== 'supply_truck' || t.hp <= 0 || t.cargo < 2) continue;
    if (t.truckState !== 'unload' && t.truckState !== 'out') continue;
    const d = dist(t.pos, u.pos);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/**
 * Behaviour hook (V22_SPEC §3.4): a unit (fresh from production with no ammunition, or run dry)
 * goes to the nearest truck or stock and waits there until rearmed. Returns true while it does.
 * Units in works, garrisons and commanders draw where they stand.
 */
export function rearmDuty(world: World, u: Unit, moveTo: (w: World, u: Unit, d: V2) => void, stop: (u: Unit) => void, commander: boolean): boolean {
  if (!drawsAmmo(u) || commander || u.fortId !== null || u.opRole === 'garrison') {
    u.rearming = false;
    return false;
  }
  const l = logisticsRules(world);
  if (!u.rearming) {
    if (u.ammo >= l.rearm_below || world.time < u.rearmAt) return false;
    // In a fight with a few rounds left: keep shooting until nearly dry.
    if (u.targetId !== null && u.ammo > 0.03) return false;
    u.rearming = true;
  }
  if (u.ammo >= l.rearm_until) {
    u.rearming = false;
    return false;
  }
  const need = (l.rearm_until - u.ammo) * u.def.supplyDemand;
  const truck = truckNear(world, u, l.truck_seek_radius_m);
  const place = truck ? null : nearestStock(world, u.owner, u.pos, need, l.stock_seek_radius_m);
  if (!truck && !place) {
    // Nothing to draw from: fight with what is left, look again later.
    u.rearming = false;
    u.rearmAt = world.time + 15;
    return false;
  }
  const at = truck ? truck.pos : place!.pos;
  const arrive = truck ? Math.min(90, (l.truck_handover_radius_m ?? 190) * 0.7) : Math.min(drawRadius(world, place!) * 0.6, 120);
  if (dist(u.pos, at) > arrive) moveTo(world, u, at);
  else stop(u);
  u.status = 'status.rearming';
  return true;
}

/** Stock summary per faction for tools / soak lines: total stock and share of total cap. */
export function stockSummary(world: World, f: Faction): { stock: number; cap: number; places: number } {
  let stock = 0;
  let cap = 0;
  let places = 0;
  for (const p of world.places) {
    if (placeOwner(world, p) !== f.id) continue;
    stock += p.stock;
    cap += stockCap(world, p);
    places++;
  }
  return { stock, cap, places };
}
