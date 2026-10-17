import type { EconZoneLevelDef, EconZoneRules } from '../data/types';
import { demolisher, econRules } from './econ';
import { trySpend } from './economy';
import { enemyDistance } from './frontai';
import { freeHand } from './fortplans';
import { moveTo, stop } from './movement';
import { ringSupported } from './capitalDefence';
import { armyScale, placeOwner } from './settlements';
import { assignJob, enemyNear, jobOf, STRUCT } from './structures';
import { Ground } from './terrain';
import type { Faction, Unit, V3 } from './types';
import { dist, type V2 } from './vec';
import { segDist } from './works';
import type { World } from './world';

/**
 * 3.0 engineer-built economic zones (经济区, V30 §7). A zone is built by an engineer job anywhere
 * on own or neutral ground away from towns and other zones; further jobs (and cost) raise it to
 * level 2 and 3. Its output (P and M per minute) scales with the level and its HP and is halved
 * without a road link to an own town. Like the 2.2 economic buildings it is shelled, demolished
 * by raiders / engineers / attack-moving troops (econ.demolisher), left as a ruin that can be
 * rebuilt, and changes hands with the ground under it. Numbers: rules.json `econ_zones`.
 */
export interface EconZone {
  readonly id: number;
  /** Render kind (structureKinds registry): `ezone1`..`ezone3` for the level shown / being built. */
  kind: string;
  readonly pos: V2;
  readonly facing: number;
  owner: number;
  /** Working level (0 while the first job is under way). */
  level: number;
  /** Level the current job builds (== level when idle). */
  target: number;
  hp: number;
  maxHp: number;
  /** Progress of the current job (1 = idle / working). */
  progress: number;
  ruined: boolean;
  /** Road link to an own town at the last check (output ×1, else × unlinked_output). */
  linked: boolean;
}

export const ZONES = {
  /** Engineers work within this of the zone's centre. */
  workRadiusM: 16,
  /** …standing this far from it (between the sheds). */
  standM: 10,
  /** Engineers are called from this far (farther ones would walk for many minutes; the HQ queues new ones instead). */
  poolR: 1000,
  /** Road links are re-checked this often (s). */
  linkEveryS: 10,
  /**
   * Labour: engineers build at full rate; riflemen of quiet line / capital-garrison squads within
   * `rifleR` help at `rifleRate` (as they dig trenches, fortplans.canDig) — the HQ's engineers are
   * mostly far off at the fronts, and a walk of a kilometre or more took them 6–10 min (lab).
   */
  rifleR: 700,
  rifleRate: 0.5,
  rifles: 2,
  /** Footprint (m) a blast must reach. */
  footprintM: 14,
} as const;

export const zoneRules = (world: World): EconZoneRules | null => {
  const z = world.data.rules.econ_zones;
  return z && z.enabled ? z : null;
};

const levelDef = (r: EconZoneRules, level: number): EconZoneLevelDef => r.levels[Math.max(0, Math.min(r.levels.length - 1, level - 1))];

export type ZoneFail = 'NO_RULES' | 'OUT_OF_BOUNDS' | 'BAD_GROUND' | 'NEAR_TOWN' | 'NEAR_ZONE' | 'HOSTILE' | 'LIMIT' | 'MAX_LEVEL' | 'BUSY' | 'NOT_OWNER' | 'INSUFFICIENT_P' | 'INSUFFICIENT_M';

export const zonesOf = (world: World, owner: number): EconZone[] => world.econZones.filter((z) => z.owner === owner);
export const zoneById = (world: World, id: number): EconZone | undefined => world.econZones.find((z) => z.id === id);

/** Clearance a zone keeps from a settlement (villages: a little; towns / cities: `min_town_distance_m` past the edge). */
export const townClearance = (r: EconZoneRules, o: { kind: string; radius: number }): number =>
  o.radius + (o.kind === 'village' ? r.min_village_distance_m : r.min_town_distance_m);

/** Why `f` cannot start a zone at `p` (null = it can, money aside). */
export function zoneSiteFail(world: World, f: Faction, p: V2): ZoneFail | null {
  const r = zoneRules(world);
  if (!r) return 'NO_RULES';
  const t = world.terrain;
  if (!t.inBounds(p.x, p.z) || !t.inBounds(p.x + 20, p.z + 20) || !t.inBounds(p.x - 20, p.z - 20)) return 'OUT_OF_BOUNDS';
  const g = t.groundAt(p.x, p.z);
  if (g === Ground.Water || g === Ground.Ford || g === Ground.Town || t.buildingH(p.x, p.z) > 0 || t.slopeAt(p.x, p.z) > STRUCT.maxSiteSlopeDeg) return 'BAD_GROUND';
  if (!world.nav(false, 35).walkableXZ(p.x, p.z)) return 'BAD_GROUND';
  for (const o of world.objectives) if (o.kind !== 'point' && dist(o.pos, p) < townClearance(r, o)) return 'NEAR_TOWN';
  for (const fx of world.factions) if (dist(world.hqPos(fx.id), p) < r.min_town_distance_m + 100) return 'NEAR_TOWN';
  for (const z of world.econZones) if (dist(z.pos, p) < r.min_zone_distance_m) return 'NEAR_ZONE';
  for (const w of world.forts) {
    if (w.hp <= 0) continue;
    const d = w.start && w.end ? segDist(p, w.start, w.end) : dist(p, w.pos);
    if (d < ZONES.footprintM) return 'BAD_GROUND';
  }
  // No ground picture yet (first seconds): nothing is known to be safe.
  if (!world.frontInfo[f.id] || enemyDistance(world, f.id, p) < r.min_enemy_distance_m) return 'HOSTILE';
  if (zonesOf(world, f.id).length >= r.max_per_faction) return 'LIMIT';
  return null;
}

function pay(f: Faction, p: number, m: number): ZoneFail | null {
  const res = trySpend(f, p, m);
  return res.ok ? null : res.reason === 'INSUFFICIENT_P' ? 'INSUFFICIENT_P' : 'INSUFFICIENT_M';
}

/** Pay for and lay out a level-1 zone at `p` (engineers build it). */
export function startZone(world: World, f: Faction, p: V2): EconZone | ZoneFail {
  const fail = zoneSiteFail(world, f, p);
  if (fail) return fail;
  const r = zoneRules(world)!;
  const d = levelDef(r, 1);
  const paid = pay(f, d.cost_p, d.cost_m);
  if (paid) return paid;
  const hq = world.hqPos(f.id);
  const z: EconZone = {
    id: world.newId(), kind: 'ezone1', pos: { ...p }, facing: Math.atan2(hq.z - p.z, hq.x - p.x), owner: f.id,
    level: 0, target: 1, hp: d.max_hp * 0.25, maxHp: d.max_hp, progress: 0, ruined: false, linked: false,
  };
  z.linked = roadLinked(world, z);
  world.econZones.push(z);
  f.econInvested += d.cost_p + d.cost_m;
  world.note(f.id, 'log.zoneStarted', {}, 'info');
  return z;
}

/** Cost of the next job on a zone: level-up, or the rebuild of a ruin. Null when none is possible. */
export function zoneJobCost(world: World, z: EconZone): { p: number; m: number } | null {
  const r = zoneRules(world);
  if (!r || z.progress < 1) return null;
  if (z.ruined) {
    const d = levelDef(r, Math.max(1, z.level));
    return { p: Math.round(d.cost_p * r.rebuild_cost_ratio), m: Math.round(d.cost_m * r.rebuild_cost_ratio) };
  }
  if (z.level >= r.levels.length) return null;
  const d = levelDef(r, z.level + 1);
  return { p: d.cost_p, m: d.cost_m };
}

/** Pay for the next level (or the rebuild of a ruin); engineers do the work. */
export function upgradeZone(world: World, f: Faction, z: EconZone): ZoneFail | null {
  const r = zoneRules(world);
  if (!r) return 'NO_RULES';
  if (z.owner !== f.id) return 'NOT_OWNER';
  if (z.progress < 1) return 'BUSY';
  const c = zoneJobCost(world, z);
  if (!c) return 'MAX_LEVEL';
  const paid = pay(f, c.p, c.m);
  if (paid) return paid;
  f.econInvested += c.p + c.m;
  if (z.ruined) {
    z.ruined = false;
    z.target = Math.max(1, z.level);
    z.level = 0;
    z.maxHp = levelDef(r, z.target).max_hp;
    z.hp = z.maxHp * 0.25;
  } else z.target = z.level + 1;
  z.kind = `ezone${z.target}`;
  z.progress = 0;
  return null;
}

/** Engineer step on a zone job (structures.structureDuty). True while busy. */
export function zoneStep(world: World, u: Unit, id: number): boolean {
  const z = zoneById(world, id);
  const r = zoneRules(world);
  if (!z || !r || !zoneWorker(u) || z.ruined || z.progress >= 1 || z.owner !== u.owner) return false;
  if (enemyNear(world, u.owner, z.pos, STRUCT.noBuildEnemyM)) return false;
  const stand = { x: z.pos.x - Math.cos(z.facing) * ZONES.standM, z: z.pos.z - Math.sin(z.facing) * ZONES.standM };
  if (dist(u.pos, z.pos) > ZONES.workRadiusM) {
    if (u.pathFailed && u.dest && dist(u.dest, stand) < 20) return false;
    moveTo(world, u, stand);
  } else {
    stop(u);
    if (u.moraleState === 'normal') workZone(world, r, z, u.def.id === 'engineer' ? 1 : ZONES.rifleRate);
  }
  u.status = 'status.buildingZone';
  return true;
}

function workZone(world: World, r: EconZoneRules, z: EconZone, rate: number): void {
  const d = levelDef(r, z.target);
  const step = (0.4 * rate) / d.work_seconds;
  z.progress = Math.min(1, z.progress + step);
  if (z.level === 0) z.hp = Math.min(z.maxHp, z.hp + z.maxHp * 0.75 * step);
  if (z.progress < 1) return;
  const ratio = z.level === 0 ? 1 : z.hp / Math.max(1, z.maxHp);
  z.level = z.target;
  z.maxHp = d.max_hp;
  z.hp = Math.max(z.hp, z.maxHp * ratio);
  world.note(z.owner, 'log.zoneBuilt', { level: z.level }, 'info');
}

/** Output per minute (P, M) of a zone: level × HP × road link; 0 while unbuilt / ruined. */
export function zoneOutput(world: World, z: EconZone): { p: number; m: number } {
  const r = zoneRules(world);
  if (!r || z.ruined || z.level < 1 || z.hp <= 0) return { p: 0, m: 0 };
  const d = levelDef(r, z.level);
  const k = armyScale(world) * (world.data.rules.proposed_defaults.army_scale_income_factor ?? 1) * (z.hp / z.maxHp) * (z.linked ? 1 : r.unlinked_output);
  return { p: d.p_per_min_k * k, m: d.m_per_min_k * k };
}

/** Zone income of faction f (per minute). */
export function zoneIncome(world: World, f: number): { p: number; m: number } {
  let p = 0;
  let m = 0;
  if (!world.econZones.some((z) => z.owner === f)) return { p, m };
  // A beaten side's zones pay little (capitalDefence.ringSupported: keeps wars endable).
  const k = ringSupported(world, f) ? 1 : zoneRules(world)?.beaten_output ?? 1;
  for (const z of world.econZones) {
    if (z.owner !== f) continue;
    const o = zoneOutput(world, z);
    p += o.p * k;
    m += o.m * k;
  }
  return { p, m };
}

// ---------------------------------------------------------------- road link

/**
 * SEAM (WP-D roads): when `world.roadnet` (src/sim/roadnet.ts) lands and offers
 * `linkedToOwnTown(owner, p)`, it decides. Until then: the zone is within `road_link_m` of a
 * map road (MapDef.roads polylines, which run between settlements) that passes an own town /
 * city / capital.
 */
interface RoadLinkProvider { linkedToOwnTown(owner: number, p: V2): boolean }

const roadsNear = new WeakMap<EconZone, number[]>();

export function roadLinked(world: World, z: EconZone): boolean {
  let near = roadsNear.get(z);
  if (!near) roadsNear.set(z, (near = nearRoads(world, z.pos)));
  return linkedAt(world, z.owner, z.pos, near);
}

function nearRoads(world: World, p: V2): number[] {
  const r = zoneRules(world);
  const roads = world.terrain.def.roads;
  const near: number[] = [];
  if (!r) return near;
  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    for (let k = 0; k + 1 < road.length; k++) {
      if (segDist(p, road[k], road[k + 1]) <= r.road_link_m) {
        near.push(i);
        break;
      }
    }
  }
  return near;
}

/** Would a zone of `owner` at `p` be road-linked to an own town now? */
export function linkedAt(world: World, owner: number, p: V2, near: readonly number[] = nearRoads(world, p)): boolean {
  const rn = (world as unknown as { roadnet?: Partial<RoadLinkProvider> }).roadnet;
  if (rn && typeof rn.linkedToOwnTown === 'function') return rn.linkedToOwnTown(owner, p);
  const roads = world.terrain.def.roads;
  // Walk the road graph (polylines meeting at junctions / villages) up to ROAD_HOPS roads out.
  const graph = roadGraph(world);
  const seen = new Set<number>(near);
  let frontier = [...near];
  for (let hop = 0; hop <= ROAD_HOPS && frontier.length > 0; hop++) {
    for (const i of frontier) if (roadReachesOwnPlace(world, roads[i], owner)) return true;
    const next: number[] = [];
    for (const i of frontier) for (const j of graph[i]) if (!seen.has(j)) { seen.add(j); next.push(j); }
    frontier = next;
  }
  return false;
}

/** Roads followed beyond the zone's own (fallback road graph). */
const ROAD_HOPS = 3;
/** Two polylines meet when an end of one is this close to the other. */
const JUNCTION_M = 40;

function roadReachesOwnPlace(world: World, road: readonly V2[], owner: number): boolean {
  for (const p of world.places) {
    if (placeOwner(world, p) !== owner) continue;
    const reach = (p.objIdx >= 0 ? world.objectives[p.objIdx].radius : 140) + 80;
    if (road.some((v) => dist(v, p.pos) <= reach)) return true;
  }
  return false;
}

const graphs = new WeakMap<World, number[][]>();

/** Adjacency of the map's road polylines (computed once per world). */
function roadGraph(world: World): number[][] {
  let g = graphs.get(world);
  if (g) return g;
  const roads = world.terrain.def.roads;
  g = roads.map(() => []);
  const touches = (a: readonly V2[], b: readonly V2[]): boolean => {
    for (const e of [a[0], a[a.length - 1]]) for (let k = 0; k + 1 < b.length; k++) if (segDist(e, b[k], b[k + 1]) <= JUNCTION_M) return true;
    return false;
  };
  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      if (roads[i].length < 2 || roads[j].length < 2) continue;
      if (touches(roads[i], roads[j]) || touches(roads[j], roads[i])) {
        g[i].push(j);
        g[j].push(i);
      }
    }
  }
  graphs.set(world, g);
  return g;
}

/** Distance from p to the nearest map road (AI site search). */
export function roadDistance(world: World, p: V2): number {
  let best = Infinity;
  for (const road of world.terrain.def.roads) for (let k = 0; k + 1 < road.length; k++) best = Math.min(best, segDist(p, road[k], road[k + 1]));
  return best;
}

// ---------------------------------------------------------------- per second: capture, demolition, links

const SC: Unit[] = [];

/** Once per second (sim.economySecond): zones change hands with the ground, are demolished, re-check their road link. */
export function econZonesSecond(world: World, ownerAt: (p: V2) => number): void {
  const r = zoneRules(world);
  if (!r || world.econZones.length === 0) return;
  const er = econRules(world);
  const relink = Math.round(world.time) % ZONES.linkEveryS === 0;
  for (const z of world.econZones) {
    const o = ownerAt(z.pos);
    if (o >= 0 && o !== z.owner) {
      if (!z.ruined && z.owner >= 0) {
        z.hp = Math.min(z.hp, z.maxHp * r.captured_hp_ratio);
        world.note(o, 'log.zoneCaptured', {}, 'info');
        world.note(z.owner, 'log.zoneLost', {}, 'warn');
      }
      z.owner = o;
      z.linked = !z.ruined && roadLinked(world, z);
    } else if (relink) z.linked = !z.ruined && roadLinked(world, z);
    if (z.ruined || !er) continue;
    let dmg = 0;
    for (const u of world.spatial.query(z.pos.x, z.pos.z, er.demolish_radius_m, SC)) {
      if (!world.isHostile(u.owner, z.owner) || !demolisher(u) || dist(u.pos, z.pos) > er.demolish_radius_m) continue;
      const rate = u.def.id === 'engineer' ? er.demolish_hp_per_second.engineer : u.def.kind === 'vehicle' ? er.demolish_hp_per_second.vehicle : er.demolish_hp_per_second.infantry;
      dmg += rate * (u.hp / u.def.maxHp);
    }
    if (dmg > 0) damageZone(world, z, dmg);
  }
}

export function damageZone(world: World, z: EconZone, dmg: number): void {
  if (z.ruined || dmg <= 0) return;
  z.hp -= dmg;
  if (z.hp > 0) return;
  z.hp = 0;
  z.ruined = true;
  z.progress = 1;
  z.target = Math.max(1, z.level);
  z.kind = `ezone${z.target}`;
  world.emit({ t: 'explosion', pos: { x: z.pos.x, y: world.terrain.heightAt(z.pos.x, z.pos.z), z: z.pos.z }, radius: 12, kind: 'he' });
  if (z.owner >= 0) world.note(z.owner, 'log.zoneRuined', {}, 'warn');
}

/** Shellfire on zones (econ.damageEconAt). */
export function damageZonesAt(world: World, at: V3, radius: number, damage: number): void {
  for (const z of world.econZones) {
    if (z.ruined) continue;
    const d = Math.hypot(z.pos.x - at.x, z.pos.z - at.z) - ZONES.footprintM;
    if (d > radius) continue;
    damageZone(world, z, damage * (d <= 0 ? 1 : Math.max(0, 1 - d / radius)));
  }
}

// ---------------------------------------------------------------- engineers (per HQ think, fortplans.planStructures)

/** Zone jobs of `f` waiting for engineers. */
export const zoneSitesWaiting = (world: World, f: Faction): number => world.econZones.filter((z) => z.owner === f.id && !z.ruined && z.progress < 1).length;

const zoneWorker = (u: Unit): boolean => u.def.id === 'engineer' || u.def.id === 'infantry';

/** Keep `builders` free engineers (and `rifles` nearby riflemen) on every open zone job of `f`, nearest first. */
export function planZoneJobs(world: World, f: Faction): void {
  const r = zoneRules(world);
  if (!r || !f.alive) return;
  for (const z of world.econZones) {
    if (z.owner !== f.id || z.ruined || z.progress >= 1 || enemyNear(world, f.id, z.pos, STRUCT.noBuildEnemyM)) continue;
    const eng: Unit[] = [];
    const rif: Unit[] = [];
    for (const u of world.units.values()) {
      if (u.owner !== f.id || !freeHand(f, u)) continue;
      const d = dist(u.pos, z.pos);
      if (u.def.id === 'engineer' && d < ZONES.poolR) eng.push(u);
      else if (u.def.id === 'infantry' && d < ZONES.rifleR && quietLine(f, u)) rif.push(u);
    }
    staff(world, z, eng, r.builders);
    staff(world, z, rif, ZONES.rifles);
  }
}

/** A rifle squad of a front that is not attacking, or of the capital garrison. */
function quietLine(f: Faction, u: Unit): boolean {
  if (u.opRole === 'garrison') return true;
  const s = f.fronts.find((x) => x.id === u.frontId);
  return !!s && s.posture !== 'assault' && s.opPhase === '';
}

/** Renew the units already on `z` and fill up to `want` from `cands` (nearest first). */
function staff(world: World, z: EconZone, cands: Unit[], want: number): void {
  cands.sort((a, b) => dist(a.pos, z.pos) - dist(b.pos, z.pos) || a.id - b.id);
  let have = 0;
  for (const u of cands) {
    if (jobOf(world, u) === z.id) {
      assignJob(world, u, z);
      have++;
    }
  }
  for (const u of cands) {
    if (have >= want) break;
    if (jobOf(world, u) !== null) continue;
    assignJob(world, u, z);
    have++;
  }
}

/** Counts for UI / soak / labs. */
export function zoneCounts(world: World, f: number): { zones: number; levels: number; sites: number; ruins: number; linked: number } {
  const out = { zones: 0, levels: 0, sites: 0, ruins: 0, linked: 0 };
  for (const z of world.econZones) {
    if (z.owner !== f) continue;
    out.zones++;
    if (z.ruined) out.ruins++;
    else if (z.level < 1) out.sites++;
    else {
      out.levels += z.level;
      if (z.linked) out.linked++;
    }
  }
  return out;
}
