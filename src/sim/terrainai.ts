import { buildingsNear, extentAlong, isCollapsed, shieldBuilding } from './buildings';
import type { MapFeature } from './mapdef';
import { hostileMask } from './spatial';
import { Ground } from './terrain';
import type { Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Terrain analysis for the AI (user: "AI also knows the terrain"). Everything here reads
 * the same Terrain the sim uses — high ground, cover, rivers, bridges/fords/passes.
 */

export interface Crossing {
  readonly pos: V2;
  readonly kind: 'bridge' | 'ford' | 'pass';
  readonly feature: MapFeature | null;
}

/** All chokepoints on the map (computed once per world). */
const crossingCache = new WeakMap<World, Crossing[]>();
export function crossings(world: World): Crossing[] {
  let c = crossingCache.get(world);
  // Pontoon bridges add crossings during the match: refresh when the bridge count changes.
  if (c && c.filter((x) => x.kind === 'bridge').length === world.terrain.bridges.length) return c;
  c = [];
  const feats = world.map.features ?? [];
  const named = (p: V2, kind: MapFeature['kind']): MapFeature | null => feats.find((f) => f.kind === kind && dist(f.pos, p) < 80) ?? null;
  for (const b of world.terrain.bridges) c.push({ pos: { x: b.x, z: b.z }, kind: 'bridge', feature: named(b, 'bridge') });
  for (const r of world.map.rivers) for (const f of r.fords) c.push({ pos: f, kind: 'ford', feature: named(f, 'ford') });
  for (const f of feats) if (f.kind === 'pass') c.push({ pos: f.pos, kind: 'pass', feature: f });
  crossingCache.set(world, c);
  return c;
}

/** Nearest named feature to a point (for explanations in the UI). */
export function nearestFeature(world: World, p: V2, maxDist = 400): MapFeature | null {
  let best: MapFeature | null = null;
  let bd = maxDist;
  for (const f of world.map.features ?? []) {
    const d = dist(f.pos, p) - f.radius * 0.5;
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

/** True if a straight segment crosses a river — deep water, a ford, or a bridge (sampled every 8 m). */
export function crossesWater(world: World, a: V2, b: V2): boolean {
  const n = Math.max(1, Math.ceil(dist(a, b) / 8));
  const bridges = world.terrain.bridges;
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const g = world.terrain.groundAt(x, z);
    if (g === Ground.Water || g === Ground.Ford) return true;
    for (const br of bridges) if (Math.abs(br.x - x) < 10 && Math.abs(br.z - z) < 10) return true;
  }
  return false;
}

/**
 * Terrain value of holding `p` against a threat along (ux, uz): cover, the enemy-facing edge
 * of a town or forest (cover here, field of fire ahead), a crest (ground falls away within
 * 30 m), and a penalty for bare open fields.
 */
export function holdTerrainScore(world: World, p: V2, ux: number, uz: number): number {
  const t = world.terrain;
  const cover = t.coverAt(p.x, p.z);
  const g = t.groundAt(p.x, p.z);
  const gAhead = t.groundAt(p.x + ux * 40, p.z + uz * 40);
  let s = Math.min(2, cover) * 0.35;
  if ((g === Ground.Town || cover === 3) && gAhead !== Ground.Town) s += 0.35;
  if (g === Ground.Forest && gAhead !== Ground.Forest) s += 0.3;
  if (t.heightAt(p.x, p.z) - t.heightAt(p.x + ux * 30, p.z + uz * 30) >= 3) s += 0.25;
  if (cover === 0 && g === Ground.Open) s -= 0.25;
  return s;
}

/**
 * Defensive position near `around` facing a threat from `threat`: rewards height over the
 * approach, cover and edges (holdTerrainScore), and a river between us and the enemy; never
 * in water or inside a building.
 */
type DefensiveSpot = { pos: V2; score: number; river: boolean; height: number };
/**
 * defensivePosition scans ~360 candidates × ~40 terrain samples; the line planners ask for the
 * same anchor and bearing every 2 s. Terrain is static (pontoons aside), so answers are kept for
 * DEF_TTL_S per anchor cell / bearing step / radius (2.0 profile: 1.5 % of sim CPU → ~0).
 */
const DEF_TTL_S = 20;
const DEF_CELL_M = 16;
const DEF_BEARING_STEP = 0.2;
const DEF_CACHE_MAX = 1024;
const defCache = new WeakMap<World, Map<string, { t: number; v: DefensiveSpot }>>();

export function defensivePosition(world: World, around: V2, threat: V2, radius = 220): DefensiveSpot {
  const bearing = Math.atan2(threat.z - around.z, threat.x - around.x);
  const key = `${Math.round(around.x / DEF_CELL_M)},${Math.round(around.z / DEF_CELL_M)},${Math.round(bearing / DEF_BEARING_STEP)},${radius}`;
  let cache = defCache.get(world);
  if (!cache) defCache.set(world, (cache = new Map()));
  const hit = cache.get(key);
  if (hit && world.time - hit.t < DEF_TTL_S) return hit.v;
  const v = scanDefensivePosition(world, around, threat, radius);
  if (cache.size >= DEF_CACHE_MAX) cache.clear();
  cache.set(key, { t: world.time, v });
  return v;
}

function scanDefensivePosition(world: World, around: V2, threat: V2, radius: number): DefensiveSpot {
  const t = world.terrain;
  const dx = threat.x - around.x;
  const dz = threat.z - around.z;
  const L = Math.hypot(dx, dz) || 1;
  const ux = dx / L;
  const uz = dz / L;
  let best = { pos: around, score: -Infinity, river: false, height: 0 };
  const step = 24;
  for (let ox = -radius; ox <= radius; ox += step) {
    for (let oz = -radius; oz <= radius; oz += step) {
      const p = { x: around.x + ox, z: around.z + oz };
      if (!t.inBounds(p.x, p.z) || Math.hypot(ox, oz) > radius) continue;
      const g = t.groundAt(p.x, p.z);
      if (g === Ground.Water || t.buildingH(p.x, p.z) > 0 || t.slopeAt(p.x, p.z) > 25) continue;
      const h = t.heightAt(p.x, p.z);
      const ahead = { x: p.x + ux * 140, z: p.z + uz * 140 };
      const hAhead = t.heightAt(ahead.x, ahead.z);
      const river = crossesWater(world, p, ahead);
      const cover = holdTerrainScore(world, p, ux, uz);
      // Do not drift far from the place we are defending, and stay on our side.
      const forward = ox * ux + oz * uz;
      // Never pick ground that needs a river crossing from where we stand (wrong bank).
      if (crossesWater(world, around, p)) continue;
      const score = Math.min(25, h - hAhead) * 0.06 + cover + (river ? 1.2 : 0) - Math.hypot(ox, oz) / radius * 0.5 - Math.max(0, forward) / radius * 0.6;
      if (score > best.score) best = { pos: p, score, river, height: h - hAhead };
    }
  }
  return best;
}

/**
 * Along the route from `from` to `to` (following the shared flow field for foot troops),
 * find the first river crossing; returns the crossing and a staging point before it.
 */
export function firstCrossing(world: World, from: V2, to: V2): { crossing: Crossing; staging: V2 } | null {
  const res = world.nav(false, 35).pathByField(from, to);
  if (!res.ok) return null;
  const pts = [from, ...res.points];
  const all = crossings(world).filter((c) => c.kind !== 'pass');
  let travelled = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / 10));
    for (let k = 0; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n };
      const c = all.find((x) => dist(x.pos, p) < 30);
      if (c) {
        // Staging ~120 m back along the route on our side.
        const back = Math.max(0, travelled + (dist(a, b) * k) / n - 120);
        return { crossing: c, staging: pointAlong(pts, back) };
      }
    }
    travelled += dist(a, b);
  }
  return null;
}

function pointAlong(pts: V2[], d: number): V2 {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (acc + seg >= d) {
      const t = (d - acc) / (seg || 1);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

/** Centre of mass of known hostile ground units within r of p (null if none). */
export function threatCentre(world: World, f: number, p: V2, r: number): V2 | null {
  let sx = 0;
  let sz = 0;
  let w = 0;
  for (const u of world.spatial.queryOwners(p.x, p.z, r, hostileMask(world, f))) {
    if (u.hp <= 0 || !world.isHostile(f, u.owner) || !world.knows(f, u)) continue;
    const v = u.def.costP + u.def.costM;
    sx += u.pos.x * v;
    sz += u.pos.z * v;
    w += v;
  }
  return w > 0 ? { x: sx / w, z: sz / w } : null;
}

/**
 * Battle-line slot: units of a front form ranks perpendicular to the axis of advance
 * (`facing` = direction toward the enemy). Front rank infantry/AT, tanks on the line,
 * support behind. Returns a world position for slot `index` of `count`.
 */
export function lineSlot(centre: V2, facing: number, index: number, count: number, depthRank: number): V2 {
  const perRow = Math.max(4, Math.min(32, Math.ceil(Math.sqrt(count * 6))));
  const spacing = 17;
  const row = Math.floor(index / perRow);
  const colsInRow = Math.min(perRow, count - row * perRow);
  const col = (index % perRow) - (colsInRow - 1) / 2;
  const back = (row + depthRank) * 22;
  const fx = Math.cos(facing);
  const fz = Math.sin(facing);
  // Slight stagger so ranks don't look like a parade.
  const stagger = row % 2 === 1 ? spacing * 0.5 : 0;
  return { x: centre.x - fx * back - fz * (col * spacing + stagger), z: centre.z - fz * back + fx * (col * spacing + stagger) };
}

export function unitDepthRank(u: Unit): number {
  switch (u.def.id) {
    case 'infantry': case 'motor_inf': case 'engineer': case 'light_tank': case 'medium_tank': case 'heavy_tank': return 0;
    case 'recon': return -1;
    case 'at_gun': case 'mg': return 1;
    default: return 3;
  }
}

const nearScratch: number[] = [];

/** A spot is taken when two other friendly units already stand within 5 m of it. */
function crowdedSpot(world: World, u: Unit, p: V2): boolean {
  let n = 0;
  for (const o of world.spatial.query(p.x, p.z, 5)) if (o.owner === u.owner && o.id !== u.id && o.hp > 0 && ++n >= 2) return true;
  return false;
}

/**
 * Best cover spot for a foot unit within `r` of `around` against fire from `faceFrom`
 * (used by behavior.findCover). Priority: stay if already garrisoned; else the nearest free lee
 * wall of an intact building; else `around` itself if it is in town/forest; else the best grid
 * point (10 m) by distance, with a crest falling toward the enemy worth 6 m and town 3 m.
 */
export function coverSpot(world: World, u: Unit, around: V2, r: number, faceFrom: V2): V2 | null {
  const t = world.terrain;
  if (u.def.kind === 'vehicle') return t.coverAt(around.x, around.z) > 0 ? around : null;
  if (u.cover === 3 && dist(u.pos, around) <= r && shieldBuilding(world, u.pos, faceFrom) >= 0) return u.pos;
  let best: V2 | null = null;
  let bd = Infinity;
  for (const k of buildingsNear(t, around, r, nearScratch)) {
    if (isCollapsed(world, k)) continue;
    const b = t.buildings[k];
    if (Math.abs(b.x - around.x) > r + 12 || Math.abs(b.z - around.z) > r + 12) continue;
    const dx = b.x - faceFrom.x;
    const dz = b.z - faceFrom.z;
    const L = Math.hypot(dx, dz);
    if (L < 1) continue;
    const e = extentAlong(b, dx / L, dz / L) + 1.0;
    const p = { x: b.x + (dx / L) * e, z: b.z + (dz / L) * e };
    const d = dist(p, around);
    if (d > r || d - 12 >= bd || !t.inBounds(p.x, p.z) || t.buildingH(p.x, p.z) > 0) continue;
    if (shieldBuilding(world, p, faceFrom) < 0 || crowdedSpot(world, u, p)) continue;
    bd = d - 12;
    best = p;
  }
  // A garrison spot wins outright; otherwise standing in town/forest is good enough (cheap).
  if (best) return best;
  if (t.coverAt(around.x, around.z) > 0) return around;
  const step = 10;
  const fx = faceFrom.x - around.x;
  const fz = faceFrom.z - around.z;
  const fl = Math.hypot(fx, fz) || 1;
  for (let dx = -r; dx <= r; dx += step) {
    for (let dz = -r; dz <= r; dz += step) {
      if (dx * dx + dz * dz > r * r) continue;
      const p = { x: around.x + dx, z: around.z + dz };
      const d0 = Math.hypot(dx, dz) + dist(p, faceFrom) * 0.05;
      if (d0 - 9 >= bd || !t.inBounds(p.x, p.z) || t.buildingH(p.x, p.z) > 0) continue;
      const cover = t.coverAt(p.x, p.z);
      const crest = t.heightAt(p.x, p.z) - t.heightAt(p.x + (fx / fl) * 25, p.z + (fz / fl) * 25) >= 3;
      if (cover === 0 && !crest) continue;
      const d = d0 - (crest ? 6 : 0) - (cover >= 2 ? 3 : 0);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
  }
  return best;
}
