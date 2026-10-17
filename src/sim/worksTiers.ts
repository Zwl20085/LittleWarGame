import type { WorkUpgradeDef } from '../data/types';
import { trySpend } from './economy';
import { assignBuilders, freeHand } from './fortplans';
import { HOME } from './homeguard';
import { startMinefield, tierRules } from './minefields';
import { moveTo, stop } from './movement';
import { availableM } from './production';
import { canAfford, enemyNear, isStructure, refreshGarrison, startStructure, structureDef, structureSiteOk, STRUCT } from './structures';
import type { Faction, Fort, Unit } from './types';
import { dist, type V2 } from './vec';
import { segDist } from './works';
import type { World } from './world';

/**
 * 3.0 defensive works tiers (V30 §8, user: "little effect from defensive works"). Engineers
 * upgrade works in place — pillbox → bunker → fortress, trench → fortified trench (tier 1) — lay
 * minefields (minefields.ts) and repair the capital perimeter (capitalDefence.ts). The AI supreme
 * HQ (every faction, the player's too) plans one such job at a time per HQ think from the capital
 * line and the fortified zones, when the M can be spared. Numbers: rules.json
 * `construction.defensive.tiers`; `enabled: false` switches it all off.
 */
export const TIERS = {
  /** A job is started only with this × its cost in stock (production first). */
  spareMul: 3,
  /** Jobs open at once per faction. */
  maxOpen: 1,
  /** Engineers this far from a job are called to it. */
  poolR: 1600,
  /** Zone works: within this of the zone's line; a minefield this far in front of its centre. */
  zoneWorkM: 80,
  zoneMinesM: 45,
  /** Capital minefield: this far beyond the trench ring, on the threat bearing. */
  capitalMinesPadM: 40,
  /** Engineers work within this of the work (minefields: of its centre). */
  workRadiusM: 12,
  /** One AT emplacement per this radius (capital approach, each fortified zone). */
  atSpacingM: 200,
  /** Retry a failed plan after this (s). */
  retryS: 20,
  /** No tier job before this (the opening M goes to the army). */
  startS: 150,
} as const;

/** The upgrade rule for a work, or null. */
export function upgradeOf(world: World, fort: Fort): WorkUpgradeDef | null {
  const t = tierRules(world);
  if (!t || fort.progress < 1 || fort.hp <= 0 || fort.upgrade || fort.permanent) return null;
  const u = t.upgrades.find((x) => x.from === fort.kind) ?? null;
  // A trench is upgraded once (tier 0 → 1).
  if (u && fort.kind === 'trench' && (fort.tier ?? 0) >= 1) return null;
  return u;
}

export type UpgradeFail = 'NO_UPGRADE' | 'INSUFFICIENT_P' | 'INSUFFICIENT_M' | 'NOT_OWNER';

/** Pay for and open an in-place upgrade (engineers finish it). */
export function startUpgrade(world: World, f: Faction, fort: Fort): UpgradeFail | null {
  if (fort.owner !== f.id) return 'NOT_OWNER';
  const u = upgradeOf(world, fort);
  if (!u) return 'NO_UPGRADE';
  const res = trySpend(f, u.cost_p, u.cost_m);
  if (!res.ok) return res.reason === 'INSUFFICIENT_P' ? 'INSUFFICIENT_P' : 'INSUFFICIENT_M';
  fort.upgrade = { to: u.to as Fort['kind'], progress: 0 };
  return null;
}

/** Does this work still need an engineer (unfinished, upgrading, perimeter damaged)? */
export function needsWork(fort: Fort): boolean {
  if (fort.permanent) return fort.progress < 1 || fort.hp < fort.maxHp;
  return fort.hp > 0 && (fort.progress < 1 || !!fort.upgrade);
}

function finishUpgrade(world: World, fort: Fort): void {
  const up = fort.upgrade;
  fort.upgrade = null;
  if (!up) return;
  const rule = tierRules(world)?.upgrades.find((x) => x.from === fort.kind);
  if (fort.kind === 'trench') {
    fort.tier = (fort.tier ?? 0) + 1;
    const mul = rule?.hp_mul ?? 1;
    fort.maxHp *= mul;
    fort.hp *= mul;
  } else if (isStructure(up.to)) {
    const ratio = fort.hp / Math.max(1, fort.maxHp);
    fort.kind = up.to;
    const def = structureDef(world, up.to);
    fort.maxHp = def.max_hp;
    fort.hp = Math.max(fort.hp, def.max_hp * ratio);
    fort.capacity = def.capacity;
    refreshGarrison(world, fort);
  }
  world.note(fort.owner, 'log.workUpgraded', { kind: fort.kind }, 'info');
}

/** Engineer step on an upgrade / minefield / perimeter repair (structures.structureDuty). True while busy. */
export function tierStep(world: World, u: Unit, fort: Fort): boolean {
  if (u.def.id !== 'engineer' || !needsWork(fort)) return false;
  const at = fort.kind === 'minefield' ? fort.pos : { x: fort.pos.x - Math.cos(fort.facing) * STRUCT.rearStandM, z: fort.pos.z - Math.sin(fort.facing) * STRUCT.rearStandM };
  const near = fort.start && fort.end && fort.kind !== 'minefield' ? segDist(u.pos, fort.start, fort.end) : dist(u.pos, at);
  if (near > TIERS.workRadiusM) {
    if (u.pathFailed && u.dest && dist(u.dest, at) < 20) return false;
    moveTo(world, u, at);
  } else {
    stop(u);
    if (u.moraleState === 'normal') work(world, fort);
  }
  u.status = fort.upgrade ? 'status.upgrading' : fort.kind === 'minefield' ? 'status.layingMines' : 'status.repairing';
  return true;
}

function work(world: World, fort: Fort): void {
  const t = tierRules(world);
  if (fort.upgrade) {
    const rule = t?.upgrades.find((x) => x.from === fort.kind);
    fort.upgrade.progress = Math.min(1, fort.upgrade.progress + 0.4 / (rule?.work_seconds ?? 60));
    if (fort.upgrade.progress >= 1) finishUpgrade(world, fort);
  } else if (fort.kind === 'minefield' && fort.progress < 1) {
    fort.progress = Math.min(1, fort.progress + 0.4 / (t?.minefield.work_seconds ?? 45));
  } else if (fort.permanent) {
    const rate = world.data.rules.capital_defence?.repair_hp_per_second ?? 30;
    fort.hp = Math.min(fort.maxHp, fort.hp + rate * 0.4);
    if (fort.progress < 1 && fort.hp >= fort.maxHp) fort.progress = 1;
  }
}

// ---------------------------------------------------------------- AI planner (per HQ think)

const retryAt = new WeakMap<Faction, number>();

/** Engineers free for a tier job, nearest first. */
function pool(world: World, f: Faction, site: Fort): Unit[] {
  const out: Unit[] = [];
  for (const u of world.units.values()) if (u.owner === f.id && u.def.id === 'engineer' && freeHand(f, u, world) && dist(u.pos, site.pos) < TIERS.poolR) out.push(u);
  return out.sort((a, b) => dist(a.pos, site.pos) - dist(b.pos, site.pos) || a.id - b.id);
}

/** Open tier jobs (upgrades, minefields being laid) of `f` (perimeter repairs: capitalDefence.ts). */
export function openTierJobs(world: World, f: Faction): Fort[] {
  return world.forts.filter((w) => w.owner === f.id && !w.permanent && w.hp > 0
    && (w.upgrade || ((w.kind === 'minefield' || w.kind === 'at_emplacement') && w.progress < 1)));
}

/**
 * Supreme-HQ planner (fortplans.planStructures): keep engineers on the open jobs, and start one
 * new job when nothing else is open and the stock can spare `spareMul` × its cost: capital works
 * first (pillbox → bunker, fortified trench, a minefield on the threat bearing), then the
 * fortified zones (up to fortress, one minefield in front of each).
 */
export function planWorksTiers(world: World, f: Faction): void {
  if (!tierRules(world) || !f.alive) return;
  const open = openTierJobs(world, f);
  for (const site of open) assignBuilders(world, [site], () => pool(world, f, site));
  if (open.length >= TIERS.maxOpen || world.time < Math.max(TIERS.startS, retryAt.get(f) ?? 0)) return;
  if (!startNext(world, f)) retryAt.set(f, world.time + TIERS.retryS);
}

const affordable = (world: World, f: Faction, p: number, m: number): boolean => f.p >= p * TIERS.spareMul && availableM(world, f) >= m * TIERS.spareMul;

function tryUpgrade(world: World, f: Faction, w: Fort): boolean {
  const u = upgradeOf(world, w);
  if (!u || !affordable(world, f, u.cost_p, u.cost_m) || enemyNear(world, f.id, w.pos, STRUCT.noBuildEnemyM)) return false;
  return startUpgrade(world, f, w) === null;
}

function tryMines(world: World, f: Faction, p: V2, facing: number): boolean {
  const m = tierRules(world)!.minefield;
  if (!affordable(world, f, m.cost_p, m.cost_m) || enemyNear(world, f.id, p, STRUCT.noBuildEnemyM)) return false;
  for (const w of world.forts) if (w.kind === 'minefield' && w.hp > 0 && dist(w.pos, p) < m.length_m) return false;
  return startMinefield(world, f, p, facing) !== null;
}

/** An AT emplacement at p unless one stands within `atSpacingM`. */
function tryEmplacement(world: World, f: Faction, p: V2, facing: number): boolean {
  for (const w of world.forts) if (w.kind === 'at_emplacement' && w.owner === f.id && w.hp > 0 && dist(w.pos, p) < TIERS.atSpacingM) return false;
  if (!canAfford(world, f, 'at_emplacement', TIERS.spareMul - 1) || enemyNear(world, f.id, p, STRUCT.noBuildEnemyM)) return false;
  for (const [dx, dz] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]] as const) {
    const q = { x: p.x + dx, z: p.z + dz };
    if (structureSiteOk(world, q)) return startStructure(world, f, 'at_emplacement', q, facing, TIERS.spareMul - 1) !== null;
  }
  return false;
}

function startNext(world: World, f: Faction): boolean {
  const hq = world.hqPos(f.id);
  const zones = f.zones.filter((z) => !z.cancelled);
  const capital: Fort[] = [];
  const zoned: Fort[] = [];
  for (const w of world.forts) {
    if (w.owner !== f.id || w.hp <= 0 || w.progress < 1 || w.permanent) continue;
    if (dist(w.pos, hq) <= HOME.worksRadiusM) capital.push(w);
    else if (zones.some((z) => segDist(w.pos, z.a, z.b) <= TIERS.zoneWorkM)) zoned.push(w);
  }
  // Capital: bunkers and fortified trenches (fortresses are for the fortified zones).
  for (const w of capital) if (w.kind !== 'bunker' && tryUpgrade(world, f, w)) return true;
  // One dug-in AT position on the capital's approach (the AT guns of the home guard man it).
  {
    const ht0 = f.command.homeThreat;
    const b0 = ht0.active ? ht0.bearing : Math.atan2(world.cityOf(f.id).exit.z - hq.z, world.cityOf(f.id).exit.x - hq.x);
    if (tryEmplacement(world, f, { x: hq.x + Math.cos(b0) * (HOME.trenchR - 14), z: hq.z + Math.sin(b0) * (HOME.trenchR - 14) }, b0)) return true;
  }
  const ht = f.command.homeThreat;
  const bearing = ht.active ? ht.bearing : Math.atan2(world.cityOf(f.id).exit.z - hq.z, world.cityOf(f.id).exit.x - hq.x);
  const r = HOME.trenchR + TIERS.capitalMinesPadM;
  if (tryMines(world, f, { x: hq.x + Math.cos(bearing) * r, z: hq.z + Math.sin(bearing) * r }, bearing)) return true;
  for (const w of zoned) if (tryUpgrade(world, f, w)) return true;
  for (const z of zones) {
    const c = { x: (z.a.x + z.b.x) / 2, z: (z.a.z + z.b.z) / 2 };
    const len = Math.max(1, dist(z.a, z.b));
    let nx = -(z.b.z - z.a.z) / len;
    let nz = (z.b.x - z.a.x) / len;
    if (nx * (c.x - hq.x) + nz * (c.z - hq.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    if (tryMines(world, f, { x: c.x + nx * TIERS.zoneMinesM, z: c.z + nz * TIERS.zoneMinesM }, Math.atan2(nz, nx))) return true;
    if (tryEmplacement(world, f, { x: c.x - nx * 14, z: c.z - nz * 14 }, Math.atan2(nz, nx))) return true;
  }
  return false;
}

/** Engineers wanted for tier jobs (fortplans.requestEngineers). */
export const tierSitesWaiting = (world: World, f: Faction): number => (tierRules(world) ? openTierJobs(world, f).length : 0);

/** Cover radius (m) of a trench by tier (works.updateWorksCover). */
export function trenchCoverM(world: World, fort: Fort, base: number): number {
  if ((fort.tier ?? 0) < 1) return base;
  return tierRules(world)?.upgrades.find((x) => x.from === 'trench')?.cover_radius_m ?? base;
}

/** Observation bonus (m) for an occupant of a finished work (terrainrules.observerOf). */
export const mannedObservationM = (world: World): number => tierRules(world)?.manned.observation_bonus_m ?? 0;
export const mannedSpotting = (world: World): boolean => tierRules(world)?.manned.artillery_spotting ?? false;
