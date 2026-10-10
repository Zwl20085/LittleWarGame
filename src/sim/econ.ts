import type { EconKind, EconRules } from '../data/types';
import { trySpend } from './economy';
import { armyScale, placeById, placeContested, placeOwner } from './settlements';
import type { EconBuilding, Faction, Place, Unit, V3 } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 economic buildings (V22_SPEC §5): 工厂 factory (+M), 征兵站 recruitment office (+P),
 * 仓库 depot (+stock cap and fill, settlements.ts). Built with P/M on a town / city slot, they
 * take time, have HP, are damaged by shellfire (damage.ts → damageEconAt) and demolished by
 * raiders, engineers and attack-moving troops. A captured town keeps them, damaged; a destroyed
 * one leaves a ruin that can be rebuilt cheaper.
 */
export const ECON_KINDS: readonly EconKind[] = ['factory', 'recruit', 'depot'];

export type BuildFail = 'NO_RULES' | 'NO_PLACE' | 'NOT_OWNER' | 'CONTESTED' | 'NO_SLOT' | 'INSUFFICIENT_P' | 'INSUFFICIENT_M';

export const econRules = (world: World): EconRules | undefined => world.data.rules.econ;

export function buildingsAt(world: World, placeId: string): EconBuilding[] {
  return world.econ.filter((b) => b.placeId === placeId);
}

/** Cost to build `kind` at `slot` of `p` (a ruin on the slot is rebuilt at the rebuild ratio). */
export function buildCost(world: World, p: Place, kind: EconKind, slot: number): { p: number; m: number } {
  const r = econRules(world)!;
  const b = r.buildings[kind];
  const ruin = world.econ.some((x) => x.placeId === p.id && x.slot === slot && x.ruined);
  const mul = ruin ? r.rebuild_cost_ratio : 1;
  return { p: Math.round(b.cost_p * mul), m: Math.round(b.cost_m * mul) };
}

/** Slot to build on: the first ruin, else the first empty slot (−1 = full). */
export function freeEconSlot(world: World, p: Place): number {
  const here = buildingsAt(world, p.id);
  const ruin = here.find((b) => b.ruined);
  if (ruin) return ruin.slot;
  for (let s = 0; s < p.slotPos.length; s++) if (!here.some((b) => b.slot === s)) return s;
  return -1;
}

/** Why `f` cannot build `kind` at `p` now (null = it can). */
export function canBuild(world: World, f: Faction, p: Place | undefined, kind: EconKind): BuildFail | null {
  const r = econRules(world);
  if (!r) return 'NO_RULES';
  if (!p || p.capitalOf >= 0 || p.slotPos.length === 0) return 'NO_PLACE';
  if (placeOwner(world, p) !== f.id) return 'NOT_OWNER';
  if (placeContested(world, p)) return 'CONTESTED';
  const slot = freeEconSlot(world, p);
  if (slot < 0) return 'NO_SLOT';
  const c = buildCost(world, p, kind, slot);
  if (f.p + 1e-9 < c.p) return 'INSUFFICIENT_P';
  if (f.m + 1e-9 < c.m) return 'INSUFFICIENT_M';
  return null;
}

/** Pay and lay out a building (or rebuild a ruin). Returns the building, or the failure reason. */
export function startBuilding(world: World, f: Faction, placeId: string, kind: EconKind): EconBuilding | BuildFail {
  const p = placeById(world, placeId);
  const fail = canBuild(world, f, p, kind);
  if (fail) return fail;
  const r = econRules(world)!;
  const slot = freeEconSlot(world, p!);
  const c = buildCost(world, p!, kind, slot);
  const res = trySpend(f, c.p, c.m);
  if (!res.ok) return res.reason;
  const def = r.buildings[kind];
  const ruinIdx = world.econ.findIndex((b) => b.placeId === placeId && b.slot === slot && b.ruined);
  if (ruinIdx >= 0) world.econ.splice(ruinIdx, 1);
  const pos = p!.slotPos[slot];
  const b: EconBuilding = {
    id: world.newId(), kind, placeId, slot, pos: { ...pos }, facing: headingTo(pos, p!.pos),
    owner: f.id, hp: def.max_hp * 0.25, maxHp: def.max_hp, progress: 0, ruined: false,
  };
  world.econ.push(b);
  world.note(f.id, 'log.econStarted', { bld: kind, point: placeId }, 'info');
  return b;
}

/** Output per minute of one building (P, M): full when intact, falling with damage. */
export function buildingOutput(world: World, b: EconBuilding): { p: number; m: number } {
  const r = econRules(world);
  if (!r || b.ruined || b.progress < 1 || b.hp <= 0) return { p: 0, m: 0 };
  const def = r.buildings[b.kind];
  const k = armyScale(world) * (world.data.rules.proposed_defaults.army_scale_income_factor ?? 1);
  const h = b.hp / b.maxHp;
  return { p: def.p_per_min_k * k * h, m: def.m_per_min_k * k * h };
}

/**
 * Economic-building income of faction f (per minute). A building pays when its place is owned,
 * uncontested and connected to our ground (`connected` = the sim's inSupply test).
 */
export function econIncome(world: World, f: number, connected: (f: number, p: V2) => boolean): { p: number; m: number } {
  let p = 0;
  let m = 0;
  for (const b of world.econ) {
    if (b.owner !== f || b.ruined || b.progress < 1) continue;
    const place = placeById(world, b.placeId);
    if (!place || placeContested(world, place) || !connected(f, place.pos)) continue;
    const o = buildingOutput(world, b);
    p += o.p;
    m += o.m;
  }
  return { p, m };
}

function ruin(world: World, b: EconBuilding): void {
  b.hp = 0;
  b.ruined = true;
  world.emit({ t: 'explosion', pos: { x: b.pos.x, y: world.terrain.heightAt(b.pos.x, b.pos.z), z: b.pos.z }, radius: 10, kind: 'he' });
  if (b.owner >= 0) world.note(b.owner, 'log.econLost', { bld: b.kind, point: b.placeId }, 'warn');
}

/** Damage a building; at 0 HP it becomes a ruin. */
export function damageEcon(world: World, b: EconBuilding, dmg: number): void {
  if (b.ruined || dmg <= 0) return;
  b.hp -= dmg;
  if (b.hp <= 0) ruin(world, b);
}

/** Footprint (m) a blast must reach to touch a building. */
const FOOTPRINT = 7;

/** Shellfire: HE blast at `at` damages buildings within its radius (+ footprint). */
export function damageEconAt(world: World, at: V3, radius: number, damage: number): void {
  if (world.econ.length === 0 || radius <= 0) return;
  for (const b of world.econ) {
    if (b.ruined) continue;
    const d = Math.hypot(b.pos.x - at.x, b.pos.z - at.z) - FOOTPRINT;
    if (d > radius) continue;
    const fall = d <= 0 ? 1 : Math.max(0, 1 - d / radius);
    damageEcon(world, b, damage * fall);
  }
}

/** Is this unit demolishing enemy buildings it stands next to (raid / infiltration / attack-move / engineers)? */
function demolisher(u: Unit): boolean {
  if (u.hp <= 0 || u.fixed || u.routing || u.def.id === 'supply_truck' || u.primary === null) return false;
  if (u.opRole === 'raid' || u.opRole === 'infiltrate') return true;
  if (u.def.id === 'engineer' && u.buildTargetId === null) return true;
  return u.manual?.type === 'attackMove' || u.manual?.type === 'focus';
}

const SC_DEMO: Unit[] = [];

/**
 * Once per second: construction, capture (owner follows the place; a captured building keeps at
 * most captured_hp_ratio of its HP; an unfinished site is taken over as it stands) and demolition
 * by hostile demolishers within demolish_radius_m.
 */
export function econSecond(world: World): void {
  const r = econRules(world);
  if (!r || world.econ.length === 0) return;
  for (const b of world.econ) {
    const place = placeById(world, b.placeId);
    if (!place) continue;
    const owner = placeOwner(world, place);
    if (owner !== b.owner) {
      if (!b.ruined && owner >= 0 && b.owner >= 0) {
        b.hp = Math.min(b.hp, b.maxHp * r.captured_hp_ratio);
        world.note(owner, 'log.econCaptured', { bld: b.kind, point: b.placeId }, 'info');
      }
      b.owner = owner;
    }
    if (b.ruined) continue;
    const contested = placeContested(world, place);
    if (b.progress < 1 && owner >= 0 && !contested) {
      const def = r.buildings[b.kind];
      const step = 1 / def.build_seconds;
      b.progress = Math.min(1, b.progress + step);
      // A site rises with its HP (25 % at the footing → full when finished).
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.75 * step);
      if (b.progress >= 1) world.note(owner, 'log.econBuilt', { bld: b.kind, point: b.placeId }, 'info');
    }
    // Demolition by hostile parties standing next to the building.
    let dmg = 0;
    for (const u of world.spatial.query(b.pos.x, b.pos.z, r.demolish_radius_m, SC_DEMO)) {
      if (b.owner >= 0 && !world.isHostile(u.owner, b.owner)) continue;
      if (b.owner < 0 || !demolisher(u) || dist(u.pos, b.pos) > r.demolish_radius_m) continue;
      const rate = u.def.id === 'engineer' ? r.demolish_hp_per_second.engineer : u.def.kind === 'vehicle' ? r.demolish_hp_per_second.vehicle : r.demolish_hp_per_second.infantry;
      dmg += rate * (u.hp / u.def.maxHp);
    }
    if (dmg > 0) damageEcon(world, b, dmg);
  }
}

/** Counts of a faction's working / building / ruined economic buildings (UI, soak, AI). */
export function econCounts(world: World, f: number): Record<EconKind, number> & { sites: number; ruins: number } {
  const out = { factory: 0, recruit: 0, depot: 0, sites: 0, ruins: 0 };
  for (const b of world.econ) {
    if (b.owner !== f) continue;
    if (b.ruined) out.ruins++;
    else if (b.progress < 1) out.sites++;
    else out[b.kind]++;
  }
  return out;
}
