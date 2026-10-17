import type { InfiltrationRules } from '../data/infiltrationRules';
import { isCommander } from './formulas';
import { hostileMask } from './spatial';
import type { Unit } from './types';
import type { V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 zone of control (docs/V30_SPEC.md §11, WP-E). A front's line units (`holdsLine`) control the
 * ground around them: an enemy within `infiltration.zoc_m` of one moves at `zoc_speed_mul`, is
 * revealed to that faction (it is in contact, fog or not) and is reported as a contact; moving across
 * the segment between two own line units closer than `contact_gap_m` is a *line crossing*.
 *
 * Cost: one owner-masked `findOwner` per unit every 0.5 s (cells without a hostile owner are skipped
 * without scanning), plus one small neighbour query per contact for the crossing test — no
 * O(units²) or O(units × fronts) loop. Runs right after the visibility pass (sim.ts).
 */

/** Lab switch (A/B): zone of control, pickets, rear screen and hunts on / off (rules `infiltration.enabled` is the default). */
export const INFILTRATION_AB = { on: true, zoc: true, engage: true, rear: true, pickets: true, segments: true };

export const infilRules = (world: World): InfiltrationRules => world.data.rules.infiltration;
export const infilOn = (world: World): boolean => INFILTRATION_AB.on && infilRules(world).enabled;

/** Units that never hold a line (no zone of control): convoys, guns firing from the rear, commanders. */
const NO_ZOC = new Set(['supply_truck', 'howitzer', 'mortar', 'commander']);

/** A line combat unit of a front: line role, on foot or in its vehicle, not on a manual order or a detachment. */
export function holdsLine(u: Unit): boolean {
  return u.hp > 0 && !u.fixed && u.opRole === 'line' && !u.manual && !u.spearhead && !u.routing && !u.mounted
    && u.behavior === 'advance' && u.primary !== null && !NO_ZOC.has(u.def.id) && !isCommander(u.def)
    // Review MEDIUM 4: riders aboard a train are hidden and hold no ground.
    && u.rail?.stage !== 'aboard';
}

/** One zone-of-control hit: `intruder` is within zoc_m of `holder`; `crossed` = it crossed a line segment since the last pass. */
export interface ZocContact {
  readonly holder: Unit;
  readonly intruder: Unit;
  readonly crossed: boolean;
}

/** Position of every unit at the previous pass (for the crossing test), by unit id. */
interface ZocState { readonly last: Map<number, { x: number; z: number; t: number }>; sweepAt: number }
const states = new WeakMap<World, ZocState>();

function stateOf(world: World): ZocState {
  let st = states.get(world);
  if (!st) {
    st = { last: new Map(), sweepAt: world.time + SWEEP_S };
    states.set(world, st);
  }
  return st;
}

/** Stale previous positions (dead units) are dropped this often. */
const SWEEP_S = 30;
/** A unit must have moved this far since the last pass for a crossing test. */
const MIN_STEP_M = 1;

/** Speed factor for `u` (movement.speedOf): zoc_speed_mul inside an enemy zone of control. */
export const zocMul = (world: World, u: Unit): number => (u.zocUntil > world.time ? infilRules(world).zoc_speed_mul : 1);

/** Does segment p→q cross segment a→b (proper intersection)? */
export function segmentsCross(p: V2, q: V2, a: V2, b: V2): boolean {
  const d1 = orient(a, b, p);
  const d2 = orient(a, b, q);
  const d3 = orient(p, q, a);
  const d4 = orient(p, q, b);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

const orient = (a: V2, b: V2, c: V2): number => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

const SC_NEAR: Unit[] = [];

/** Did `intruder` cross the segment between `h` and another own line unit within contact_gap_m on its way from `from`? */
function crossedLine(world: World, r: InfiltrationRules, h: Unit, from: V2, to: V2): boolean {
  for (const n of world.spatial.queryOwners(h.pos.x, h.pos.z, r.contact_gap_m, 1 << h.owner, SC_NEAR)) {
    if (n === h || !holdsLine(n)) continue;
    if (segmentsCross(from, to, h.pos, n.pos)) return true;
  }
  return false;
}

/** Reveal `u` to faction `f` (it is in contact with f's line): visible set and memory, as a sighting. */
function reveal(world: World, f: number, u: Unit): void {
  const vis = world.visibleTo[f];
  if (!vis || vis.has(u.id)) return;
  vis.add(u.id);
  world.lastSeen[f]?.set(u.id, { tick: world.tick, pos: { ...u.pos } });
}

/**
 * Zone-of-control pass (every 0.5 s): sets `zocUntil` on every unit inside an enemy zone of control,
 * reveals it, and fills `out` with the contacts (holder, intruder, crossed). Deterministic: units in
 * `world.aliveUnits` order, the nearest-cell-first `findOwner` result.
 */
export function updateZoc(world: World, out: ZocContact[]): void {
  out.length = 0;
  const r = infilRules(world);
  const st = stateOf(world);
  const now = world.time;
  const until = now + r.zoc_hold_s;
  const masks = world.factions.map((f) => hostileMask(world, f.id));
  for (const m of world.aliveUnits) {
    if (m.hp <= 0 || m.fixed || isCommander(m.def) || m.behavior === 'evacuate') continue;
    const prev = st.last.get(m.id);
    const h = world.spatial.findOwner(m.pos.x, m.pos.z, r.zoc_m, masks[m.owner] ?? 0, holdsLine);
    if (h && world.isHostile(h.owner, m.owner)) {
      m.zocUntil = until;
      reveal(world, h.owner, m);
      const moved = !!prev && Math.abs(prev.x - m.pos.x) + Math.abs(prev.z - m.pos.z) > MIN_STEP_M;
      out.push({ holder: h, intruder: m, crossed: moved && !!prev && crossedLine(world, r, h, prev, m.pos) });
    }
    if (prev) {
      prev.x = m.pos.x;
      prev.z = m.pos.z;
      prev.t = now;
    } else st.last.set(m.id, { x: m.pos.x, z: m.pos.z, t: now });
  }
  if (now >= st.sweepAt) {
    st.sweepAt = now + SWEEP_S;
    for (const [id, p] of st.last) if (now - p.t > SWEEP_S) st.last.delete(id);
  }
}
