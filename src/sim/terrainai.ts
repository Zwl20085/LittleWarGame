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
 * Defensive position near `around` facing a threat from `threat`: rewards height over the
 * approach, cover (town/forest), and a river between us and the enemy; never in water.
 */
export function defensivePosition(world: World, around: V2, threat: V2, radius = 220): { pos: V2; score: number; river: boolean; height: number } {
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
      if (g === Ground.Water || t.slopeAt(p.x, p.z) > 25) continue;
      const h = t.heightAt(p.x, p.z);
      const ahead = { x: p.x + ux * 140, z: p.z + uz * 140 };
      const hAhead = t.heightAt(ahead.x, ahead.z);
      const river = crossesWater(world, p, ahead);
      const cover = t.coverAt(p.x, p.z);
      // Do not drift far from the place we are defending, and stay on our side.
      const forward = ox * ux + oz * uz;
      // Never pick ground that needs a river crossing from where we stand (wrong bank).
      if (crossesWater(world, around, p)) continue;
      const score = Math.min(25, h - hAhead) * 0.06 + cover * 0.35 + (river ? 1.2 : 0) - Math.hypot(ox, oz) / radius * 0.5 - Math.max(0, forward) / radius * 0.6;
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
 * Battle-line slot: units of a sector form ranks perpendicular to the axis of advance
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
    case 'infantry': case 'engineer': case 'light_tank': case 'medium_tank': case 'heavy_tank': return 0;
    case 'recon': return -1;
    case 'at_gun': case 'mg': return 1;
    default: return 3;
  }
}
