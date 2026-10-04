import { FRONTLINE } from './config';
import { hostileMask } from './spatial';
import { defensivePosition } from './terrainai';
import { EAGER } from './strategyai';
import type { Front, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Battle-line geometry for the front commander (fronts.planFront): ordered lines on the ground,
 * the active stretch of a front segment, slot ordering and the massed block. Pure helpers.
 */

const lerpV = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

/** An ordered line sampled every `cell` metres (same shape as a front segment). */
export function lineCells(line: { a: V2; b: V2 }, cell: number): V2[] {
  const n = Math.max(1, Math.round(dist(line.a, line.b) / cell));
  const out: V2[] = [];
  for (let k = 0; k <= n; k++) out.push(lerpV(line.a, line.b, k / n));
  return out;
}

/** Ordered lines on the ground (2.0 front commander tactics). */
export const LINE_ORDER = {
  /** Each sample of a defend / fortify / fall-back line moves to the best defensive spot (high ground, cover, a river ahead) within this radius… */
  snapM: 40,
  /** …sampled every this many metres (one terrain search per sample, cached per line). */
  sampleM: 32,
  /** Slots stand this far behind the snapped line (the 1.x hold line stood 35 m back from the contact line). */
  leanM: 8,
} as const;

const snapped = new WeakMap<Front, { key: string; cells: V2[] }>();

/**
 * Defend / fortify / fall back: the ordered line snapped to terrain — every `sampleM` the best
 * defensive position (terrainai.defensivePosition: crest, cover, river ahead, own bank) within
 * `snapM`, then resampled at the front-cell spacing. Computed once per line (cached).
 */
export function terrainLine(world: World, s: Front, line: { a: V2; b: V2 }, facing: number): V2[] {
  const key = `${Math.round(line.a.x)},${Math.round(line.a.z)},${Math.round(line.b.x)},${Math.round(line.b.z)}`;
  const c = snapped.get(s);
  if (c && c.key === key) return c.cells;
  const n = Math.max(1, Math.round(dist(line.a, line.b) / LINE_ORDER.sampleM));
  const knots: V2[] = [];
  for (let k = 0; k <= n; k++) {
    const p = lerpV(line.a, line.b, k / n);
    const threat = { x: p.x + Math.cos(facing) * 150, z: p.z + Math.sin(facing) * 150 };
    knots.push(defensivePosition(world, p, threat, LINE_ORDER.snapM).pos);
  }
  const cells: V2[] = [];
  for (let k = 0; k < knots.length - 1; k++) {
    const part = lineCells({ a: knots[k], b: knots[k + 1] }, FRONTLINE.cell);
    cells.push(...(k === 0 ? part : part.slice(1)));
  }
  const out = cells.length > 0 ? cells : knots;
  snapped.set(s, { key, cells: out });
  return out;
}

/** The ordered attack line moved so its centre is `centre` (it advances with the front point). */
export function lineThrough(line: { a: V2; b: V2 }, centre: V2): V2[] {
  const dx = centre.x - (line.a.x + line.b.x) / 2;
  const dz = centre.z - (line.a.z + line.b.z) / 2;
  return lineCells({ a: { x: line.a.x + dx, z: line.a.z + dz }, b: { x: line.b.x + dx, z: line.b.z + dz } }, FRONTLINE.cell);
}

/**
 * Round 2: the part of a front segment that faces known enemies (sampled ~16 points, one spatial
 * query each). Lab: 72 % of line units stood > 300 m from any enemy, spread along quiet front.
 */
export function activeSegment(world: World, f: number, seg: V2[]): V2[] {
  if (seg.length < 8) return seg;
  const step = Math.max(1, Math.floor(seg.length / 16));
  const mask = hostileMask(world, f);
  const hot: boolean[] = [];
  let any = false;
  for (let k = 0; k < seg.length; k += step) {
    let h = false;
    for (const u of world.spatial.queryOwners(seg[k].x, seg[k].z, EAGER.activeRadius, mask)) {
      if (u.hp > 0 && world.knows(f, u)) { h = true; break; }
    }
    hot.push(h);
    any ||= h;
  }
  return any ? seg.filter((_, i) => hot[Math.floor(i / step)]) : seg;
}

/** Units sorted by the nearest (sampled) cell index of an angle-ordered segment (monotone slot matching). */
export function orderAlong(units: Unit[], seg: V2[]): Unit[] {
  const step = Math.max(1, Math.ceil(seg.length / 64));
  const key = new Map<number, number>();
  for (const u of units) {
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < seg.length; k += step) {
      const d = (seg[k].x - u.pos.x) ** 2 + (seg[k].z - u.pos.z) ** 2;
      if (d < bd) { bd = d; bi = k; }
    }
    key.set(u.id, bi);
  }
  return [...units].sort((a, b) => (key.get(a.id) ?? 0) - (key.get(b.id) ?? 0) || a.id - b.id);
}

/** Stable mass membership by id hash (no per-think re-sorting, so slots don't churn). */
export function inMass(u: Unit, share: number): boolean {
  return ((Math.imul(u.id, 2654435761) >>> 0) % 1000) < share * 1000;
}

/** Compact block on `centre` facing `facing`, spaced so the crowding shell penalty doesn't trigger. */
export function massSlot(centre: V2, facing: number, i: number, n: number, rank: number, spacing: number): V2 {
  const perRow = Math.max(4, Math.min(16, Math.ceil(Math.sqrt(n * 4))));
  const row = Math.floor(i / perRow);
  const cols = Math.min(perRow, n - row * perRow);
  const col = (i % perRow) - (cols - 1) / 2 + (row % 2 === 1 ? 0.5 : 0);
  const back = (row + Math.max(0, rank)) * (spacing + 5);
  const fx = Math.cos(facing);
  const fz = Math.sin(facing);
  return { x: centre.x - fx * back - fz * col * spacing, z: centre.z - fz * back + fx * col * spacing };
}
