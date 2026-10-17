import type { CapitalDefenceRules } from '../data/types';
import { assignBuilders, freeHand } from './fortplans';
import { bindOccupant, enemyNear, placeStructure, STRUCT } from './structures';
import type { Faction, Fort, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 absolute defence perimeter (绝对国防圈, V23 §1.3 / V30 §8) and the capital observation ring.
 *
 * Perimeter: a free, permanent ring of `strongpoints` bunker-hard strongpoints (structures.ts kind
 * `strongpoint`, `permanent`) at `radius_m` around every capital, each holding a fixed MG crew
 * (fires its own MG through the slits; the concrete takes most of every hit and small arms cannot
 * break it, so it must be stormed by armour or heavy guns), plus a fixed artillery position
 * behind the capital. Engineers repair it (worksTiers.tierStep; jobs here); a dead crew is
 * replaced after `crew_respawn_seconds` while its strongpoint stands and no enemy is close. The
 * home guard may man the second slot. Flag: `capital_defence.enabled`.
 *
 * Observation ring: in fog mode every capital sees all hostiles within `observation.radius_m`
 * (sim.updateVisibility), so a shadow strike is seen before it reaches the ring. Flag:
 * `capital_defence.observation.enabled`.
 */
export const defenceRules = (world: World): CapitalDefenceRules | null => world.data.rules.capital_defence ?? null;
const perimeterOn = (world: World): CapitalDefenceRules | null => {
  const r = defenceRules(world);
  return r && r.enabled ? r : null;
};

interface Post {
  readonly owner: number;
  /** Strongpoint id (−1 = the artillery position, which stands in the open). */
  readonly fortId: number;
  readonly unitId: string;
  readonly pos: V2;
  readonly facingDeg: number;
  crewId: number;
  deadSince: number;
}

const posts = new WeakMap<World, Post[]>();
export const perimeterPosts = (world: World): readonly Post[] => posts.get(world) ?? [];

/** Strongpoints of a faction's perimeter (standing or broken). */
export function perimeterOf(world: World, owner: number): Fort[] {
  return world.forts.filter((w) => w.permanent && w.owner === owner && w.kind === 'strongpoint');
}

function spawnCrew(world: World, f: Faction, p: Post): void {
  const u = world.spawnUnit(f.id, p.unitId, p.pos, f.mainFront, { fixed: true, facingDeg: p.facingDeg });
  p.crewId = u.id;
  p.deadSince = -1;
  if (p.fortId >= 0) {
    const fort = world.fortById(p.fortId);
    if (fort) bindOccupant(world, u, fort);
  }
}

/** createMatch: lay every capital's perimeter and artillery position (flag off: nothing). */
export function initCapitalDefence(world: World): void {
  const r = perimeterOn(world);
  if (!r) return;
  const list: Post[] = [];
  for (const f of world.factions) {
    const hq = world.hqPos(f.id);
    const exit = world.cityOf(f.id).exit;
    const bearing = Math.atan2(exit.z - hq.z, exit.x - hq.x);
    for (let i = 0; i < r.strongpoints; i++) {
      const a = bearing + (i * 2 * Math.PI) / r.strongpoints;
      const at = { x: hq.x + Math.cos(a) * r.radius_m, z: hq.z + Math.sin(a) * r.radius_m };
      const fort = placeStructure(world, f.id, 'strongpoint', at, a, 48);
      if (!fort) continue;
      fort.permanent = true;
      const p: Post = { owner: f.id, fortId: fort.id, unitId: r.crew_unit, pos: { ...fort.pos }, facingDeg: (a * 180) / Math.PI, crewId: -1, deadSince: -1 };
      spawnCrew(world, f, p);
      list.push(p);
    }
    const back = { x: hq.x - Math.cos(bearing) * r.artillery_back_m, z: hq.z - Math.sin(bearing) * r.artillery_back_m };
    const nav = world.nav(false, 35);
    const pos = nav.nearestPassable(back, 40) ?? hq;
    const art: Post = { owner: f.id, fortId: -1, unitId: r.artillery_unit, pos: { ...pos }, facingDeg: (bearing * 180) / Math.PI, crewId: -1, deadSince: -1 };
    spawnCrew(world, f, art);
    list.push(art);
  }
  posts.set(world, list);
}

/** Once per second: replace dead crews, re-seat crews in repaired strongpoints. */
export function capitalDefenceSecond(world: World): void {
  const r = perimeterOn(world);
  const list = posts.get(world);
  if (!r || !list) return;
  for (const p of list) {
    const f = world.factions[p.owner];
    if (!f?.alive) continue;
    const fort = p.fortId >= 0 ? world.fortById(p.fortId) : undefined;
    const crew = world.unitAlive(p.crewId);
    if (crew) {
      // Thrown out by a collapse: back in once the concrete is repaired.
      if (fort && crew.fortId === null && fort.hp >= fort.maxHp * r.crew_min_hp_ratio) bindOccupant(world, crew, fort);
      continue;
    }
    if (p.deadSince < 0) p.deadSince = world.time;
    if (world.time - p.deadSince < r.crew_respawn_seconds) continue;
    if (p.fortId >= 0 && (!fort || fort.hp < fort.maxHp * r.crew_min_hp_ratio)) continue;
    if (enemyNear(world, p.owner, p.pos, r.quiet_m)) continue;
    spawnCrew(world, f, p);
  }
}

/** Per HQ think (fortplans.planStructures): engineers repair damaged strongpoints when the enemy is not on them. */
export function planPerimeterRepair(world: World, f: Faction): void {
  if (!perimeterOn(world) || !f.alive) return;
  for (const site of perimeterOf(world, f.id)) {
    if (site.hp >= site.maxHp || enemyNear(world, f.id, site.pos, STRUCT.noBuildEnemyM)) continue;
    assignBuilders(world, [site], () => {
      const out: Unit[] = [];
      for (const u of world.units.values()) if (u.owner === f.id && u.def.id === 'engineer' && freeHand(f, u) && dist(u.pos, site.pos) < 1500) out.push(u);
      return out.sort((a, b) => dist(a.pos, site.pos) - dist(b.pos, site.pos) || a.id - b.id);
    });
  }
}

/** Damaged strongpoints waiting for engineers (fortplans.requestEngineers). */
export const perimeterSitesWaiting = (world: World, f: Faction): number => (perimeterOn(world) ? perimeterOf(world, f.id).filter((w) => w.hp < w.maxHp * 0.8).length : 0);

/** Observation ring radius (m) in force for this match (0 = off: open mode or flag off). */
export function observationRadius(world: World): number {
  const r = defenceRules(world);
  if (!r || !r.observation.enabled || world.config.infoMode !== 'fog') return 0;
  return r.observation.radius_m;
}

const SC: Unit[] = [];

/** sim.updateVisibility: the capital of `f` sees every hostile within the ring. */
export function observeCapital(world: World, f: number, vis: Set<number>): void {
  const R = observationRadius(world);
  if (R <= 0) return;
  const hq = world.hqPos(f);
  for (const t of world.spatial.query(hq.x, hq.z, R, SC)) {
    if (t.hp > 0 && world.isHostile(f, t.owner)) vis.add(t.id);
  }
}
