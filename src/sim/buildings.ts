import { BUILDING } from './config';
import type { Building, Terrain } from './terrain';
import type { Unit, V3 } from './types';
import type { V2 } from './vec';
import type { World } from './world';

/**
 * Buildings in combat (user: "for 地形、建筑 try to involve more"). Squads hugging a wall on the
 * side away from the enemy are garrisoned: heavy cover from that side, they fire (and are seen)
 * through the windows, towers/churches are observation posts, and HE wears buildings down
 * until they collapse. Map generation and the occupancy raster are never changed here.
 */

/** Raster cells at least this tall are real buildings (sealed courtyards are 3 m walls). */
const MIN_BUILDING_H = 4;
const BUCKET = 32;

interface BuildingIndex {
  readonly nx: number;
  readonly nz: number;
  readonly cells: number[][];
}

const indexCache = new WeakMap<Terrain, BuildingIndex>();

/** 32 m bucket grid of building indices (built once per terrain, ≈5 600 buildings). */
function index(t: Terrain): BuildingIndex {
  let idx = indexCache.get(t);
  if (idx) return idx;
  const nx = Math.ceil(t.width / BUCKET) + 1;
  const nz = Math.ceil(t.depth / BUCKET) + 1;
  const cells: number[][] = Array.from({ length: nx * nz }, () => []);
  t.buildings.forEach((b, k) => {
    const r = Math.hypot(b.w, b.d) / 2 + 2;
    const i0 = Math.max(0, Math.floor((b.x - r) / BUCKET));
    const i1 = Math.min(nx - 1, Math.floor((b.x + r) / BUCKET));
    const j0 = Math.max(0, Math.floor((b.z - r) / BUCKET));
    const j1 = Math.min(nz - 1, Math.floor((b.z + r) / BUCKET));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * nx + i].push(k);
  });
  idx = { nx, nz, cells };
  indexCache.set(t, idx);
  return idx;
}

/** Same rotation convention as Terrain.rasterizeBuildings; `pad` covers the 2 m raster rounding. */
function contains(b: Building, x: number, z: number, pad: number): boolean {
  const dx = x - b.x;
  const dz = z - b.z;
  const cs = Math.cos(b.rot);
  const sn = Math.sin(b.rot);
  return Math.abs(dx * cs - dz * sn) <= b.w / 2 + pad && Math.abs(dx * sn + dz * cs) <= b.d / 2 + pad;
}

/** Index of the building whose footprint holds (x, z), or -1. */
export function buildingIndexAt(t: Terrain, x: number, z: number, pad = 1.5): number {
  const idx = index(t);
  const i = Math.floor(x / BUCKET);
  const j = Math.floor(z / BUCKET);
  if (!(i >= 0 && j >= 0 && i < idx.nx && j < idx.nz)) return -1;
  for (const k of idx.cells[j * idx.nx + i]) if (contains(t.buildings[k], x, z, pad)) return k;
  return -1;
}

/** Buildings whose bucket overlaps the square of half-size r around p (may repeat across buckets). */
export function buildingsNear(t: Terrain, p: V2, r: number, out: number[] = []): number[] {
  out.length = 0;
  const idx = index(t);
  const i0 = Math.max(0, Math.floor((p.x - r) / BUCKET));
  const i1 = Math.min(idx.nx - 1, Math.floor((p.x + r) / BUCKET));
  const j0 = Math.max(0, Math.floor((p.z - r) / BUCKET));
  const j1 = Math.min(idx.nz - 1, Math.floor((p.z + r) / BUCKET));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (const k of idx.cells[j * idx.nx + i]) out.push(k);
  return out;
}

/** Half-extent of a building's footprint along unit direction (dx, dz). */
export function extentAlong(b: Building, dx: number, dz: number): number {
  const cs = Math.cos(b.rot);
  const sn = Math.sin(b.rot);
  return Math.abs(dx * cs - dz * sn) * (b.w / 2) + Math.abs(dx * sn + dz * cs) * (b.d / 2);
}

// --- "next to a wall" (terrain cover 3) ------------------------------------------------

const wallMaskCache = new WeakMap<Terrain, Uint8Array>();
/** Raster-centre distance; with 2 m cells this is "the wall is within about 3 m". */
const WALL_MASK_M = 4.2;

/**
 * On the 2 m building raster: 1 where a real building cell (≥ 4 m) lies within 3 m. Built once
 * per terrain (≈3 MB on the largest map) so nearWall is a single lookup on every move.
 */
let lastMaskT: Terrain | null = null;
let lastMask: Uint8Array = new Uint8Array(0);

function wallMask(t: Terrain): Uint8Array {
  if (t === lastMaskT) return lastMask; // hot path: one terrain per match
  let m = wallMaskCache.get(t);
  if (m) {
    lastMaskT = t;
    lastMask = m;
    return m;
  }
  const nx = t.bnx;
  const nz = t.bnz;
  m = new Uint8Array(nx * nz);
  const R = Math.ceil(WALL_MASK_M / t.bcell);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (t.bldH[j * nx + i] < MIN_BUILDING_H) continue;
      for (let dj = -R; dj <= R; dj++) {
        const b = j + dj;
        if (b < 0 || b >= nz) continue;
        for (let di = -R; di <= R; di++) {
          const a = i + di;
          if (a >= 0 && a < nx && (di * di + dj * dj) * t.bcell * t.bcell <= WALL_MASK_M * WALL_MASK_M) m[b * nx + a] = 1;
        }
      }
    }
  }
  wallMaskCache.set(t, m);
  lastMaskT = t;
  lastMask = m;
  return m;
}

/** A building wall (raster ≥ 4 m) within ≈3 m of (x, z): one lookup in a precomputed mask. */
export function nearWall(t: Terrain, x: number, z: number): boolean {
  const i = Math.round(x / t.bcell);
  const j = Math.round(z / t.bcell);
  if (!(i >= 0 && j >= 0 && i < t.bnx && j < t.bnz)) return false;
  return wallMask(t)[j * t.bnx + i] === 1;
}

// --- damage / collapse -------------------------------------------------------------------

interface Ledger {
  readonly hp: Map<number, number>;
  readonly collapsed: Set<number>;
}
const ledgers = new WeakMap<World, Ledger>();

function ledger(world: World): Ledger {
  let l = ledgers.get(world);
  if (!l) {
    l = { hp: new Map(), collapsed: new Set() };
    ledgers.set(world, l);
  }
  return l;
}

export function isCollapsed(world: World, k: number): boolean {
  return ledgers.get(world)?.collapsed.has(k) ?? false;
}

export function collapsedCount(world: World): number {
  return ledgers.get(world)?.collapsed.size ?? 0;
}

/** HE burst at `at`: a shell bursting on/against a building wears it down; at the threshold it collapses. */
export function noteBuildingHit(world: World, at: V3, damage: number): void {
  if (damage <= 0) return;
  const t = world.terrain;
  if (t.buildingH(at.x, at.z) < MIN_BUILDING_H && t.buildingH(at.x, at.z + 2) < MIN_BUILDING_H && t.buildingH(at.x + 2, at.z) < MIN_BUILDING_H
    && t.buildingH(at.x, at.z - 2) < MIN_BUILDING_H && t.buildingH(at.x - 2, at.z) < MIN_BUILDING_H) return;
  const k = buildingIndexAt(t, at.x, at.z, 2.5);
  if (k < 0) return;
  const l = ledger(world);
  if (l.collapsed.has(k)) return;
  const prev = l.hp.get(k);
  if (prev === undefined && l.hp.size >= BUILDING.maxTracked) return; // bounded; deterministic
  const b = t.buildings[k];
  const total = (prev ?? 0) + damage;
  if (total < (BUILDING.collapseHp[b.kind] ?? 1500)) {
    l.hp.set(k, total);
    return;
  }
  l.hp.delete(k);
  l.collapsed.add(k);
  const y = t.heightAt(b.x, b.z);
  world.emit({ t: 'explosion', pos: { x: b.x, y: y + Math.min(b.h, 12) * 0.5, z: b.z }, radius: Math.min(16, 6 + Math.max(b.w, b.d) * 0.5), kind: 'he' });
}

// --- garrison, windows and perches -------------------------------------------------------

/**
 * Index of an intact building between `p` and `toward` within BUILDING.adjacentM of p (the wall
 * a garrisoned squad shelters behind), or -1. Two raster samples; index lookup only on a hit.
 */
export function shieldBuilding(world: World, p: V2, toward: V2): number {
  const dx = toward.x - p.x;
  const dz = toward.z - p.z;
  const L = Math.hypot(dx, dz);
  if (L < 1) return -1;
  const t = world.terrain;
  let s = 1.5;
  if (t.buildingH(p.x + (dx / L) * s, p.z + (dz / L) * s) < MIN_BUILDING_H) {
    s = BUILDING.adjacentM;
    if (t.buildingH(p.x + (dx / L) * s, p.z + (dz / L) * s) < MIN_BUILDING_H) return -1;
  }
  const k = buildingIndexAt(t, p.x + (dx / L) * s, p.z + (dz / L) * s);
  return k >= 0 && !isCollapsed(world, k) ? k : -1;
}

/** Foot units next to a wall (terrain cover 3 = building adjacency) can use buildings. */
const canGarrison = (u: Unit): boolean => u.def.kind !== 'vehicle' && u.cover === 3;

/**
 * Window point: a garrisoned squad looks / fires (and is seen) from the far wall of the building
 * that shields it from `toward`, `windowRiseM` above the street. Null when not garrisoned.
 */
export function windowPoint(world: World, u: Unit, toward: V2, eye: number, out: V3): V3 | null {
  if (!canGarrison(u)) return null;
  const k = shieldBuilding(world, u.pos, toward);
  if (k < 0) return null;
  const t = world.terrain;
  const dx = toward.x - u.pos.x;
  const dz = toward.z - u.pos.z;
  const L = Math.hypot(dx, dz);
  let inside = false;
  for (let s = 1.5; s <= BUILDING.windowDepthM + BUILDING.adjacentM; s += 1.5) {
    const x = u.pos.x + (dx / L) * s;
    const z = u.pos.z + (dz / L) * s;
    if (t.buildingH(x, z) > 0) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    out.x = x;
    out.z = z;
    out.y = t.heightAt(x, z) + BUILDING.windowRiseM + eye;
    return out;
  }
  return null;
}

const scratchA: V3 = { x: 0, y: 0, z: 0 };
const scratchB: V3 = { x: 0, y: 0, z: 0 };

/** LOS between two units with eye heights; garrisoned ends use their window point. */
export function sightLine(world: World, a: Unit, aEye: number, b: Unit, bH: number): boolean {
  const wa = windowPoint(world, a, b.pos, aEye, scratchA);
  const wb = windowPoint(world, b, a.pos, bH, scratchB);
  const ax = wa ? wa.x : a.pos.x;
  const ay = wa ? wa.y : a.y + aEye;
  const az = wa ? wa.z : a.pos.z;
  const bx = wb ? wb.x : b.pos.x;
  const by = wb ? wb.y : b.y + bH;
  const bz = wb ? wb.z : b.pos.z;
  return world.terrain.los(ax, ay, az, bx, by, bz);
}

/** Tower or church within adjacentM of a foot unit (intact): an observation post, else null. */
export function perch(world: World, u: Unit): Building | null {
  if (!canGarrison(u)) return null;
  const t = world.terrain;
  const r = BUILDING.adjacentM;
  for (let a = 0; a < 8; a++) {
    const x = u.pos.x + Math.cos((a * Math.PI) / 4) * r;
    const z = u.pos.z + Math.sin((a * Math.PI) / 4) * r;
    if (t.buildingH(x, z) < 12) continue; // towers ≥ 22 m, churches 14 m
    const k = buildingIndexAt(t, x, z);
    if (k < 0 || isCollapsed(world, k)) continue;
    const b = t.buildings[k];
    if (b.kind === 'tower' || b.kind === 'church') return b;
  }
  return null;
}
