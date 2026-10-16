// Challenge lab: routing through ground the defender cannot currently see (shadow_strike, backdoor)
// and the widest flank around a defended road (armour_raid). Reads the world only; the result is a
// list of waypoints the strategy issues as queued `move` orders.
import type { Unit } from '../../src/sim/types';
import { dist, type V2 } from '../../src/sim/vec';
import type { NavGrid } from '../../src/sim/nav';
import type { World } from '../../src/sim/world';
import { combatUnit } from './worldq';

const CELL_M = 50;
const SEEN_PENALTY = 8;
const OBSERVATION_R = 180;
/** Margin on a unit's vision radius: we treat ground this close to the edge as seen. */
const VISION_MARGIN = 1.1;
const WAYPOINT_EVERY = 5;
const BEARINGS = 24;

export type SeenFn = (p: V2) => boolean;

/** Ground currently observed by any of the `observers` (their vision radius, ignoring line of sight: conservative). */
export function seenBy(w: World, observers: readonly number[]): SeenFn {
  const eyes: { p: V2; r: number }[] = [];
  for (const u of w.units.values()) {
    if (u.hp <= 0 || !observers.includes(u.owner) || u.def.id === 'commander') continue;
    eyes.push({ p: u.pos, r: u.def.vision * VISION_MARGIN });
  }
  for (const o of w.objectives) if (o.type === 'observation' && observers.includes(o.owner)) eyes.push({ p: o.pos, r: OBSERVATION_R });
  return (p) => eyes.some((e) => dist(e.p, p) <= e.r);
}

export interface Route {
  /** Intermediate waypoints (queue as moves), then `staging` (last), then the capital. */
  readonly waypoints: V2[];
  readonly staging: V2;
  /** Share of the path's cells that lie on seen ground (0 = fully in the shadow). */
  readonly seenShare: number;
  readonly found: boolean;
}

const key = (i: number, j: number): number => j * 100000 + i;

/** A* on a coarse grid: ground a unit can cross, seen cells cost (1 + SEEN_PENALTY) times as much. */
function search(nav: NavGrid, w: World, a: V2, goals: Set<number>, seen: SeenFn): { path: V2[]; seenCells: number } | null {
  const nx = Math.floor(w.terrain.width / CELL_M);
  const nz = Math.floor(w.terrain.depth / CELL_M);
  const at = (i: number, j: number): V2 => ({ x: (i + 0.5) * CELL_M, z: (j + 0.5) * CELL_M });
  const ok = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < nz && nav.passable(at(i, j));
  const si = Math.min(nx - 1, Math.max(0, Math.floor(a.x / CELL_M)));
  const sj = Math.min(nz - 1, Math.max(0, Math.floor(a.z / CELL_M)));
  const g = new Map<number, number>([[key(si, sj), 0]]);
  const from = new Map<number, number>();
  const open: { k: number; i: number; j: number; f: number }[] = [{ k: key(si, sj), i: si, j: sj, f: 0 }];
  const seenCache = new Map<number, boolean>();
  const isSeen = (i: number, j: number): boolean => {
    const k = key(i, j);
    let v = seenCache.get(k);
    if (v === undefined) { v = seen(at(i, j)); seenCache.set(k, v); }
    return v;
  };
  while (open.length) {
    let bi = 0;
    for (let q = 1; q < open.length; q++) if (open[q].f < open[bi].f) bi = q;
    const cur = open.splice(bi, 1)[0];
    if (goals.has(cur.k)) {
      const path: V2[] = [];
      let seenCells = 0;
      for (let k: number | undefined = cur.k; k !== undefined; k = from.get(k)) {
        const i = k % 100000;
        const j = Math.floor(k / 100000);
        path.push(at(i, j));
        if (isSeen(i, j)) seenCells++;
      }
      return { path: path.reverse(), seenCells };
    }
    const gc = g.get(cur.k) ?? 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ni = cur.i + di;
        const nj = cur.j + dj;
        if (!ok(ni, nj) || (di && dj && (!ok(cur.i + di, cur.j) || !ok(cur.i, cur.j + dj)))) continue;
        const nk = key(ni, nj);
        const step = CELL_M * (di && dj ? 1.414 : 1) * (isSeen(ni, nj) ? 1 + SEEN_PENALTY : 1);
        const ng = gc + step;
        if (ng >= (g.get(nk) ?? Infinity)) continue;
        g.set(nk, ng);
        from.set(nk, cur.k);
        open.push({ k: nk, i: ni, j: nj, f: ng });
      }
    }
  }
  return null;
}

/**
 * The shadow route from `from` to a staging point `ringM` out from `target` that the observers
 * cannot currently see: candidate staging points on a bearing circle around the target, the one
 * with the cheapest unseen path wins. Falls back to the least-seen candidate (found = false when
 * nothing is reachable).
 */
export function shadowRoute(w: World, sample: Unit, from: V2, target: V2, seen: SeenFn, ringM: number): Route {
  const nav = w.navFor(sample);
  const goals = new Map<number, V2>();
  for (let b = 0; b < BEARINGS; b++) {
    const th = (b / BEARINGS) * Math.PI * 2;
    const p = { x: target.x + Math.cos(th) * ringM, z: target.z + Math.sin(th) * ringM };
    if (!w.terrain.inBounds(p.x, p.z) || !nav.passable(p) || seen(p)) continue;
    goals.set(key(Math.floor(p.x / CELL_M), Math.floor(p.z / CELL_M)), p);
  }
  const res = goals.size ? search(nav, w, from, new Set(goals.keys()), seen) : null;
  if (!res) return { waypoints: [], staging: ringPoint(from, target, ringM), seenShare: 1, found: false };
  const end = res.path[res.path.length - 1];
  const wp = res.path.filter((_, i) => i % WAYPOINT_EVERY === WAYPOINT_EVERY - 1 && i < res.path.length - 2);
  return { waypoints: wp, staging: end, seenShare: res.seenCells / Math.max(1, res.path.length), found: true };
}

export const ringPoint = (from: V2, target: V2, ringM: number): V2 => {
  const l = Math.max(1e-6, dist(from, target));
  return { x: target.x + ((from.x - target.x) / l) * ringM, z: target.z + ((from.z - target.z) / l) * ringM };
};

/**
 * Widest flank: a waypoint half-way to `target`, `lateral` m off the straight line on the side
 * where `weight(p)` (hostile value near the point) is smaller; null when neither side is passable.
 */
export function flankWaypoint(w: World, sample: Unit, from: V2, target: V2, lateral: number, weight: (p: V2) => number): V2 | null {
  const nav = w.navFor(sample);
  const l = Math.max(1e-6, dist(from, target));
  const nx = -(target.z - from.z) / l;
  const nz = (target.x - from.x) / l;
  const mid = { x: (from.x + target.x) / 2, z: (from.z + target.z) / 2 };
  const cands: V2[] = [];
  for (const side of [1, -1]) {
    for (let k = 0; k < 6; k++) {
      const d = lateral * (1 - k * 0.12);
      const p = { x: mid.x + nx * d * side, z: mid.z + nz * d * side };
      if (w.terrain.inBounds(p.x, p.z) && nav.passable(p)) { cands.push(p); break; }
    }
  }
  if (!cands.length) return null;
  return cands.reduce((a, b) => (weight(b) < weight(a) ? b : a));
}

/** Own combat unit of a kind, for sampling a nav grid. */
export function sampleUnit(w: World, me: number, kinds: readonly string[]): Unit | null {
  for (const u of w.units.values()) if (u.owner === me && combatUnit(u) && kinds.includes(u.def.id)) return u;
  return null;
}
