import type { InfiltrationRules } from '../data/infiltrationRules';
import { picketGapMul } from './doctrines';
import { defendingHome } from './homeguard';
import type { Faction, Front, Unit } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';
import { infilOn, infilRules, INFILTRATION_AB } from './zoc';

/**
 * 3.0 pickets and reaction groups (docs/V30_SPEC.md §11, WP-E). Called at the end of a front's
 * formation pass (fronts.planFront, every front think) with the slots it computed:
 *
 * - **Pickets**: points every `picket_gap_m × picket_tier_mul[tier] × doctrine picket_gap` along the front's whole stretch
 *   of the line; a point with no slot within half a gap gets the spare infantry squad whose slot is
 *   most redundant (≥ 2 other slots within half a gap), leaning `picket_lean_m` back. At most
 *   `picket_max_share` of the front's infantry. Pickets are ordinary line slots (opRole 'line'), so
 *   they still man the line for the binding-order rules.
 * - **Reaction group**: `reaction_share` of the front's combat units (motorized infantry first, then
 *   light / medium / heavy tanks) stand `reaction_back_m` behind the middle of the stretch while the
 *   front is not pushing; infiltration.ts sends them at anything that crosses the line.
 *
 * Cost per front think: O(points × slots + candidates²) with a few dozen of each.
 */

const reaction = new WeakMap<Front, readonly number[]>();

/**
 * 3.0: each front's stretch of the faction's front line = the cells (already angle-ordered) nearest
 * its own battle line (`s.front`); fronts recalled home take none unless every front is. The 2.x split
 * by count gave front k the k-th angular share whatever the front's position (fronts are created and
 * merged in any order), so a front could be assigned a stretch on the far side of the capital and the
 * stretch in front of it stayed empty. Null when the system is off (operations.frontSegments falls back).
 */
export function segmentsByProximity(world: World, f: Faction, cells: readonly V2[]): V2[][] | null {
  if (!infilOn(world) || !INFILTRATION_AB.segments) return null;
  const home = f.fronts.map((s) => defendingHome(s));
  const all = home.every(Boolean);
  const out: V2[][] = f.fronts.map(() => []);
  for (const c of cells) {
    let best = -1;
    let bd = Infinity;
    f.fronts.forEach((s, i) => {
      if (home[i] && !all) return;
      const d = dist(c, s.front);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) out[best].push(c);
  }
  return out;
}

/** Unit ids of the front's current reaction group (empty when it has none). */
export const reactionGroup = (s: Front): readonly number[] => reaction.get(s) ?? [];

/** Reaction group preference: motorized infantry, then the tanks, lightest first. */
const REACT_RANK: Record<string, number> = { motor_inf: 0, light_tank: 1, medium_tank: 2, heavy_tank: 3 };
const PICKET_KINDS = new Set(['infantry', 'motor_inf']);

/** Gap between pickets for a front of command tier `tier`; `doctrineMul` = doctrines.picketGapMul (3.0). */
export function picketGap(r: InfiltrationRules, tier: number, doctrineMul = 1): number {
  const mul = r.picket_tier_mul[Math.min(r.picket_tier_mul.length - 1, Math.max(0, tier))] ?? 1;
  return r.picket_gap_m * mul * doctrineMul;
}

/** Length of an angle-ordered cell polyline (jumps > 3 cells are gaps between contact stretches, not line). */
export function polylineLength(seg: readonly V2[], maxStep = 48): number {
  let len = 0;
  for (let i = 1; i < seg.length; i++) {
    const d = dist(seg[i - 1], seg[i]);
    if (d <= maxStep) len += d;
  }
  return len;
}

/** Evenly spaced points (by index) along `seg` so consecutive points are about `gap` apart. */
export function picketPoints(seg: readonly V2[], gap: number): V2[] {
  if (seg.length === 0) return [];
  const len = Math.max(polylineLength(seg), dist(seg[0], seg[seg.length - 1]));
  const n = Math.max(1, Math.ceil(len / gap) + 1);
  const out: V2[] = [];
  for (let k = 0; k < n; k++) out.push(seg[Math.min(seg.length - 1, Math.round((k / Math.max(1, n - 1)) * (seg.length - 1)))]);
  return out;
}

const towardHome = (p: V2, home: V2, m: number): V2 => {
  const hd = headingTo(p, home);
  return { x: p.x + Math.cos(hd) * m, z: p.z + Math.sin(hd) * m };
};

/** The stretch pickets cover: an ordered defend line as laid out, else the front's whole segment. */
function picketLine(s: Front, seg: readonly V2[]): readonly V2[] {
  const ordered = !!s.line && s.order.kind !== 'attack';
  return ordered || s.segment.length < 2 ? seg : s.segment;
}

/** Reaction group members: the front's mobile line units, motorized first, at most reaction_share of its combat units. */
function pickReaction(r: InfiltrationRules, liners: readonly Unit[], combat: number): Unit[] {
  const mobile = liners.filter((u) => REACT_RANK[u.def.id] !== undefined).sort((a, b) => REACT_RANK[a.def.id] - REACT_RANK[b.def.id] || a.id - b.id);
  const size = Math.min(r.reaction_max_units, Math.round(combat * r.reaction_share), mobile.length);
  return size >= r.reaction_min_units ? mobile.slice(0, size) : [];
}

/**
 * Fill the gaps of the front's line with pickets and post its reaction group. Returns new slots
 * (`slots` is not changed). `combat` = the front's combat units (for the reaction share).
 */
export function picketSlots(world: World, f: Faction, s: Front, liners: readonly Unit[], slots: Record<number, V2>, seg: readonly V2[], combat = liners.length): Record<number, V2> {
  const line = picketLine(s, seg);
  if (!infilOn(world) || !INFILTRATION_AB.pickets || line.length < 2 || defendingHome(s) || (s.op === 'siege' && s.opPhase !== '')) {
    reaction.delete(s);
    return slots;
  }
  const r = infilRules(world);
  const home = world.hqPos(f.id);
  const out: Record<number, V2> = { ...slots };
  const pushing = s.mode === 'push' || s.mode === 'breakthrough';
  const group = pushing ? [] : pickReaction(r, liners, combat);
  const inGroup = new Set(group.map((u) => u.id));
  placePickets(world, r, s, liners.filter((u) => !inGroup.has(u.id)), out, line, home, picketGapMul(world, f));
  if (group.length > 0) postReaction(world, r, group, out, line, home);
  reaction.set(s, group.map((u) => u.id));
  return out;
}

/** Greedy gap filling: each uncovered picket point takes the spare squad with the most redundant slot. */
function placePickets(world: World, r: InfiltrationRules, s: Front, liners: readonly Unit[], out: Record<number, V2>, line: readonly V2[], home: V2, doctrineMul: number): void {
  const gap = picketGap(r, s.tier, doctrineMul);
  const half = gap / 2;
  const points = picketPoints(line, gap);
  // Coverage counts the slots of these units only (the reaction group leaves its line slots).
  const slotList: V2[] = [];
  for (const u of liners) if (out[u.id]) slotList.push(out[u.id]);
  const covered = (p: V2): boolean => slotList.some((q) => dist(p, q) <= half);
  const cands = liners.filter((u) => PICKET_KINDS.has(u.def.id) && out[u.id] !== undefined);
  const budget = Math.floor(cands.length * r.picket_max_share);
  if (budget <= 0) return;
  // Redundancy: other slots within half a gap of the candidate's slot (it can leave without opening a gap).
  const red = cands.map((u) => slotList.reduce((n, q) => n + (q !== out[u.id] && dist(q, out[u.id]) <= half ? 1 : 0), 0));  const used = new Set<number>();
  let placed = 0;
  for (const p of points) {
    if (placed >= budget) return;
    if (covered(p)) continue;
    let best = -1;
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i) || red[i] < 2) continue;
      if (best < 0 || red[i] > red[best] || (red[i] === red[best] && dist(out[cands[i].id], p) < dist(out[cands[best].id], p))) best = i;
    }
    if (best < 0) return;
    const u = cands[best];
    const old = out[u.id];
    for (let i = 0; i < cands.length; i++) if (i !== best && dist(out[cands[i].id], old) <= half) red[i]--;
    const want = towardHome(p, home, r.picket_lean_m);
    const at = world.navFor(u).nearestPassable(want, 40) ?? want;
    out[u.id] = at;
    slotList.push(at);
    used.add(best);
    placed++;
  }
}

/** Reaction group post: behind the middle of the stretch, spread sideways 20 m apart. */
function postReaction(world: World, r: InfiltrationRules, group: readonly Unit[], out: Record<number, V2>, line: readonly V2[], home: V2): void {
  const mid = line[Math.floor(line.length / 2)];
  const base = towardHome(mid, home, r.reaction_back_m);
  const side = headingTo(mid, home) + Math.PI / 2;
  group.forEach((u, i) => {
    const off = (i - (group.length - 1) / 2) * 20;
    const p = { x: base.x + Math.cos(side) * off, z: base.z + Math.sin(side) * off };
    out[u.id] = world.navFor(u).nearestPassable(p, 40) ?? p;
  });
}
