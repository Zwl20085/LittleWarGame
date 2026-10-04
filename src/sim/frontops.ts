import { appointCommander, frontUnits, nearestFront, newFront } from './fronts';
import { frontById } from './frontref';
import { resetOperation } from './doctrine';
import { isCommander } from './formulas';
import type { Faction, Front, Objective, Unit } from './types';
import { angleDiff, DEG, dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * Front structure (2.0, docs/COMMAND_V2.md): creating, dissolving and merging fronts, shared by
 * the AI supreme HQ (theatre.ts) and the player's far orders (`frontForOrder`). Ids stay stable
 * (`f.frontSeq`); `f.fronts` is replaced, never spliced, so a snapshot taken mid-think is intact.
 */
export const FRONT_OPS = {
  /** A player order whose point is farther than this from every front's line opens a new front. */
  newFrontM: 900,
  /** A new front takes free line troops nearest its objective first, but every donor front keeps at least this share of its own. */
  donorKeep: 0.5,
} as const;

/** Units a front may hand over: line troops that are not on a task (no commanders, trucks, guns in action). */
export function transferable(u: Unit): boolean {
  return u.hp > 0 && !u.fixed && !isCommander(u.def) && u.def.id !== 'supply_truck' && u.opRole === 'line'
    && !u.spearhead && !u.manual && !u.routing && (u.behavior === 'advance' || u.behavior === 'rally');
}

/**
 * Open a new front aimed at `target` (AI: a new axis; player: an order far from every front).
 * Its commander is appointed at once for `commander_unit` P (no front without a commander), and it
 * takes `want` free line troops nearest the target from the other fronts (each donor keeps
 * `donorKeep` of its free troops). Returns null at `fronts_max` or when P cannot pay the commander.
 */
export function createFront(world: World, f: Faction, target: Objective, want: number): Front | null {
  const rules = world.data.rules.command;
  if (f.fronts.length >= rules.fronts_max) return null;
  const def = world.data.units.get(rules.commander_unit);
  if (def && f.p < def.costP) return null;
  if (def) f.p -= def.costP;
  const n = f.fronts.length + 1;
  const s = newFront(world, f, target, 0, 1 / n);
  for (const x of f.fronts) x.share *= (n - 1) / n;
  f.fronts = [...f.fronts, s];
  appointCommander(world, f, s);
  transferUnits(world, f, s, target.pos, want);
  assignWings(world, f);
  world.note(f.id, 'log.frontOpened', { point: s.name }, 'info');
  return s;
}

/** Move up to `want` free line troops nearest `at` from the other fronts to `s`. */
function transferUnits(world: World, f: Faction, s: Front, at: V2, want: number): void {
  if (want <= 0) return;
  const free = new Map<number, number>();
  const pool: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.frontId === s.id || !transferable(u)) continue;
    free.set(u.frontId, (free.get(u.frontId) ?? 0) + 1);
    pool.push(u);
  }
  pool.sort((a, b) => dist(a.pos, at) - dist(b.pos, at) || a.id - b.id);
  const left = new Map(free);
  let moved = 0;
  for (const u of pool) {
    if (moved >= want) break;
    const keep = Math.ceil((free.get(u.frontId) ?? 0) * FRONT_OPS.donorKeep);
    const l = left.get(u.frontId) ?? 0;
    if (l <= keep) continue;
    left.set(u.frontId, l - 1);
    u.frontId = s.id;
    u.behavior = 'advance';
    moved++;
  }
}

/**
 * Dissolve front `s` into front `into`: its units (trucks included) join `into`, an operation
 * under way is reset, recall / main-effort references move over, and its commander either takes
 * over a leaderless `into` or is recalled to the supreme HQ (leaves the field).
 */
export function dissolveFront(world: World, f: Faction, s: Front, into: Front): void {
  if (s === into || !f.fronts.includes(s)) return;
  const units = frontUnits(world, f.id, s.id);
  if (s.opPhase !== '') resetOperation(s, units, world);
  for (const u of units) {
    if (isCommander(u.def)) continue;
    u.frontId = into.id;
  }
  const cmd = world.unitAlive(s.commanderId);
  if (cmd) {
    if (!world.unitAlive(into.commanderId)) {
      cmd.frontId = into.id;
      into.commanderId = cmd.id;
      into.commanderLostAt = -1;
    } else {
      // Recalled to the supreme HQ: leaves the field without a death (no loss, no log).
      cmd.behavior = 'evacuate';
      cmd.evacuateAt = world.time;
    }
  }
  const ht = f.command.homeThreat;
  if (ht.recall.includes(s.id)) {
    ht.recall = ht.recall.filter((id) => id !== s.id);
    const { [s.id]: _gone, ...rest } = ht.recallAt;
    ht.recallAt = rest;
  }
  if (f.mainFront === s.id) f.mainFront = into.id;
  f.fronts = f.fronts.filter((x) => x !== s);
  into.share += s.share;
  assignWings(world, f);
  world.note(f.id, 'log.frontMerged', { point: s.name, into: into.name }, 'info');
}

/**
 * Wings for pincers (doctrine.planPincer): the outermost fronts by bearing from the capital
 * (left = -1, right = +1), the rest centre. Left alone while a pincer is under way.
 */
export function assignWings(world: World, f: Faction): void {
  if (f.fronts.some((s) => s.op === 'pincer' && s.opPhase !== '')) return;
  const city = world.cityOf(f.id);
  const fwd = city.forwardDeg * DEG;
  const sorted = [...f.fronts].sort((a, b) => angleDiff(fwd, headingTo(city.hq, a.targetPos)) - angleDiff(fwd, headingTo(city.hq, b.targetPos)) || a.id - b.id);
  sorted.forEach((s, i) => {
    s.wing = sorted.length === 1 ? 0 : i === 0 ? -1 : i === sorted.length - 1 ? 1 : 0;
  });
}

/** Distance from `p` to a front's battle line (its ordered line, else its front point / objective). */
export function frontDistance(s: Front, p: V2): number {
  if (!s.line) return Math.min(dist(p, s.front), dist(p, s.targetPos));
  const { a, b } = s.line;
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

/**
 * The front a player order without a front goes to: the nearest one, or — when the order is
 * farther than `newFrontM` from every front's line and the faction has fewer than `fronts_max`
 * fronts — a new front for it (named after the nearest settlement, with its share of the troops).
 */
export function frontForOrder(world: World, f: Faction, p: V2): Front | undefined {
  const near = nearestFront(f, p);
  if (near && frontDistance(near, p) <= FRONT_OPS.newFrontM) return near;
  if (f.fronts.length >= world.data.rules.command.fronts_max) return near;
  let obj: Objective | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    const d = dist(o.pos, p);
    if (d < bd) { bd = d; obj = o; }
  }
  if (!obj) return near;
  let free = 0;
  for (const u of world.units.values()) if (u.owner === f.id && transferable(u)) free++;
  return createFront(world, f, obj, Math.floor(free / (f.fronts.length + 1))) ?? near;
}

/** Units whose front no longer exists (dissolved; a production order for it) join the nearest front. */
export function reassignStale(world: World, f: Faction): void {
  if (f.fronts.length === 0) return;
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || frontById(f, u.frontId)) continue;
    if (isCommander(u.def)) {
      u.behavior = 'evacuate';
      u.evacuateAt = world.time;
      continue;
    }
    let best = f.fronts[0];
    for (const s of f.fronts) if (dist(u.pos, s.front) < dist(u.pos, best.front)) best = s;
    u.frontId = best.id;
  }
}

/** Troops within this of a point join a front the player opens there (2.1 `newFront`). */
const NEW_FRONT_ADOPT_M = 350;

/**
 * 2.1: the player opens a front at a point (a garrison front for a fortified zone, a second axis …).
 * Named after the nearest settlement; free troops within NEW_FRONT_ADOPT_M of the point join it.
 */
export function createFrontAt(world: World, f: Faction, p: V2): Front | null {
  let obj: Objective | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    const d = dist(o.pos, p);
    if (d < bd) { bd = d; obj = o; }
  }
  if (!obj) return null;
  let near = 0;
  for (const u of world.units.values()) if (u.owner === f.id && transferable(u) && dist(u.pos, p) < NEW_FRONT_ADOPT_M) near++;
  const s = createFront(world, f, obj, near);
  if (s) {
    s.targetPos = { ...p };
    s.front = { ...p };
    s.order = { kind: 'defend', a: { ...p }, b: null, issuedAt: world.time, manual: true };
  }
  return s;
}

/** 2.1: the player disbands a front; its troops and zone bindings go to the nearest other front. */
export function disbandFront(world: World, f: Faction, s: Front): boolean {
  if (f.fronts.length <= 1) return false;
  let into: Front | null = null;
  let bd = Infinity;
  for (const x of f.fronts) {
    if (x === s) continue;
    const d = dist(x.front, s.front);
    if (d < bd) { bd = d; into = x; }
  }
  if (!into) return false;
  for (const z of f.zones) if (z.frontId === s.id) z.frontId = into.id;
  dissolveFront(world, f, s, into);
  return true;
}
