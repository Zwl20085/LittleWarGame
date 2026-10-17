import { garrisonsZone } from './theatre';
import { frontById } from './frontref';
import { massSlot } from './frontslots';
import { armourMainShare } from './doctrines';
import type { Faction, Front, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 armour tactics (V22_SPEC §7). Tanks fight as an armoured group (≥ minGroup tanks moving and
 * engaging together) or as the spearhead of an infantry attack (tanks lead, the foot follow
 * 30–60 m behind) — never dribbling forward one by one:
 *
 * - `armourSlots` (front planner, every front think) gives a front's line tanks one compact block:
 *   holding → an assembled reserve behind the line centre; pushing / approaching → the block first
 *   assembles behind the line (≤ assembleMaxS), then leads the infantry by leadM, paced on the foot
 *   (the block never runs further ahead than leadM of the leading infantry). Fewer than minGroup
 *   tanks with no infantry to lead stay in the reserve.
 * - `paceArmour` (spearheads and manoeuvre groups): a tank more than paceM ahead of the leading foot
 *   of its group waits for them.
 * - `armourFront` / `concentrateArmour`: new tanks join the main effort, and under an offensive
 *   (or a defence with an axis) the other fronts' free tanks go there too.
 */
export const ARMOUR = {
  minGroup: 3,
  /** Tanks within this of the block centre count as assembled. */
  assembleR: 110,
  /** Share of the front's tanks that must be assembled before the block commits … */
  assembleShare: 0.7,
  /** … or the longest an assembly waits (s). A committed block re-assembles below `breakShare`. */
  assembleMaxS: 60,
  breakShare: 0.4,
  /** The block leads the infantry by this (m). */
  leadM: 45,
  /** Holding / assembling: the block waits this far behind the line centre (m). */
  reserveBackM: 90,
  /** Infantry squads needed to lead an infantry attack with fewer than minGroup tanks. */
  supportMinFoot: 2,
  /** Spearhead / manoeuvre: a tank at most this far ahead of the group's leading foot (m). */
  paceM: 60,
  /** Block slot spacing (m). */
  spacing: 22,
  /** Under the main-effort rule, share of the faction's tanks the main front may hold under `advance`. */
  advanceMainShare: 0.6,
  /** Seconds between armour transfers to the main effort. */
  concentrateEveryS: 60,
} as const;

/** A/B switch for the lab (`ARMOUR_AB.on = false` = 2.2 wave-1 behaviour). */
export const ARMOUR_AB = { on: true };

const TANK_IDS = new Set(['light_tank', 'medium_tank', 'heavy_tank']);
export const isTank = (u: Unit): boolean => TANK_IDS.has(u.def.id) && !u.fixed;
export const isTankId = (id: string): boolean => TANK_IDS.has(id);

interface BlockState { assembleSince: number; committed: boolean }
const blocks = new WeakMap<Front, BlockState>();

const centroid = (us: readonly Unit[]): V2 => ({ x: us.reduce((a, u) => a + u.pos.x, 0) / us.length, z: us.reduce((a, u) => a + u.pos.z, 0) / us.length });
const along = (p: V2, d: number, facing: number): V2 => ({ x: p.x + Math.cos(facing) * d, z: p.z + Math.sin(facing) * d });

export interface ArmourPlan {
  /** The front's battle-line point and facing (after the planner's hysteresis). */
  readonly front: V2;
  readonly facing: number;
  /** The front attacks (push / an attack line / the approach march to its objective). */
  readonly pushing: boolean;
}

/** Where the block goes and why (pure; exported for the tests). */
export function blockGoal(tanks: readonly Unit[], foot: readonly Unit[], plan: ArmourPlan, st: BlockState, now: number): { pos: V2; mode: 'reserve' | 'assemble' | 'lead' } {
  const reserve = along(plan.front, -ARMOUR.reserveBackM, plan.facing);
  const n = tanks.length;
  if (!plan.pushing || n === 0) {
    st.committed = false;
    st.assembleSince = -1;
    return { pos: reserve, mode: 'reserve' };
  }
  const group = n >= ARMOUR.minGroup;
  if (!group && foot.length < ARMOUR.supportMinFoot) return { pos: reserve, mode: 'reserve' };
  if (group) {
    const c = centroid(tanks);
    const near = tanks.filter((u) => dist(u.pos, c) <= ARMOUR.assembleR).length / n;
    if (st.committed && near < ARMOUR.breakShare) st.committed = false;
    if (!st.committed) {
      if (st.assembleSince < 0) st.assembleSince = now;
      if (near >= ARMOUR.assembleShare || now - st.assembleSince >= ARMOUR.assembleMaxS) {
        st.committed = true;
        st.assembleSince = -1;
      } else {
        // Assemble where the block already is when it is behind the line, else behind the line.
        const ahead = (c.x - plan.front.x) * Math.cos(plan.facing) + (c.z - plan.front.z) * Math.sin(plan.facing);
        return { pos: ahead < -ARMOUR.reserveBackM * 0.5 ? c : reserve, mode: 'assemble' };
      }
    }
  }
  // Lead: leadM ahead of the leading infantry (75th percentile of progress along the facing), never past front + leadM.
  let lead: number = ARMOUR.leadM;
  if (foot.length > 0) {
    const prog = foot.map((u) => (u.pos.x - plan.front.x) * Math.cos(plan.facing) + (u.pos.z - plan.front.z) * Math.sin(plan.facing)).sort((a, b) => a - b);
    const p75 = prog[Math.min(prog.length - 1, Math.floor(prog.length * 0.75))];
    lead = Math.min(ARMOUR.leadM, p75 + ARMOUR.leadM);
  }
  return { pos: along(plan.front, lead, plan.facing), mode: 'lead' };
}

/**
 * Front planner hook: the front's line tanks (`liners`) get one compact block (overwrites their
 * line slots). `foot` = the front's line infantry (pacing).
 */
export function armourSlots(world: World, s: Front, liners: readonly Unit[], slots: Record<number, V2>, plan: ArmourPlan): void {
  if (!ARMOUR_AB.on) return;
  const tanks = liners.filter(isTank).sort((a, b) => a.id - b.id);
  if (tanks.length === 0) return;
  const foot = liners.filter((u) => u.def.kind === 'infantry');
  let st = blocks.get(s);
  if (!st) {
    st = { assembleSince: -1, committed: false };
    blocks.set(s, st);
  }
  const goal = blockGoal(tanks, foot, plan, st, world.time);
  tanks.forEach((u, i) => {
    const p = massSlot(goal.pos, plan.facing, i, tanks.length, 0, ARMOUR.spacing);
    slots[u.id] = world.navFor(u).nearestPassable(p, 40) ?? p;
  });
}

/** Block mode of a front for the UI / lab ('' = no block). */
export function armourMode(s: Front): string {
  const st = blocks.get(s);
  return !st ? '' : st.committed ? 'lead' : st.assembleSince >= 0 ? 'assemble' : 'reserve';
}

// ---------------------------------------------------------------- pacing (spearheads, manoeuvre)

interface PaceCache { tick: number; lead: Map<string, number> }
const paceCache = new WeakMap<World, PaceCache>();

/** Group key of a detachment that moves on its own (spearhead / manoeuvre), else null. */
function groupKey(u: Unit): string | null {
  if (u.spearhead) return `${u.owner}:s:${u.spearhead}`;
  if (u.opRole === 'maneuver' && u.opTarget) return `${u.owner}:m:${u.frontId}`;
  return null;
}

/** Distance to the goal of the group's leading foot (once per half second for all groups: O(units)). */
function footLead(world: World, key: string, goal: V2): number {
  let c = paceCache.get(world);
  if (!c || world.tick - c.tick >= Math.max(1, world.tickHz >> 1)) {
    c = { tick: world.tick, lead: new Map() };
    paceCache.set(world, c);
  }
  const hit = c.lead.get(key);
  if (hit !== undefined) return hit;
  let best = Infinity;
  for (const o of world.aliveUnits) {
    if (o.hp <= 0 || o.def.kind !== 'infantry' || o.routing || groupKey(o) !== key) continue;
    best = Math.min(best, dist(o.pos, goal));
  }
  c.lead.set(key, best);
  return best;
}

/**
 * Spearhead / manoeuvre tank: true when it should wait for its infantry (it is more than paceM
 * ahead of the group's leading foot; a group without foot is not held).
 */
export function paceArmour(world: World, u: Unit, goal: V2): boolean {
  if (!ARMOUR_AB.on || !isTank(u)) return false;
  const key = groupKey(u);
  if (!key) return false;
  const lead = footLead(world, key, goal);
  if (!Number.isFinite(lead)) return false;
  return dist(u.pos, goal) < lead - ARMOUR.paceM;
}

/**
 * A spearhead / manoeuvre tank whose riflemen are all gone does not drive on alone: it returns to
 * its front's armour block (true = the detachment was ended).
 */
export function orphanTank(world: World, u: Unit, goal: V2): boolean {
  if (!ARMOUR_AB.on || !isTank(u)) return false;
  const key = groupKey(u);
  if (!key || Number.isFinite(footLead(world, key, goal))) return false;
  u.spearhead = null;
  if (u.opRole === 'maneuver') u.opRole = 'line';
  u.opTarget = u.opRole === 'line' ? null : u.opTarget;
  return true;
}

// ---------------------------------------------------------------- concentration at the main effort

/** Main effort that takes the armour: offensive, or a defence / fortify with an axis (the threatened place), else under advance the main front while it holds < advanceMainShare of the tanks. */
export function armourFront(world: World, f: Faction, tankCounts?: Map<number, number>): number {
  if (!ARMOUR_AB.on) return -1;
  const main = frontById(f, f.mainFront);
  if (!main || garrisonsZone(main)) return -1;
  const k = f.directive.kind;
  if (k === 'offensive' || ((k === 'defend' || k === 'fortify') && (f.directive.axis || f.directive.line))) return main.id;
  if (k !== 'advance' || main.order.kind !== 'attack') return -1;
  const counts = tankCounts ?? countTanks(world, f);
  let all = 0;
  for (const v of counts.values()) all += v;
  // 3.0: maneuver / blitz keep more of the armour in the main body (doctrines.armourMainShare).
  return (counts.get(main.id) ?? 0) < Math.max(1, all * armourMainShare(world, f, ARMOUR.advanceMainShare)) ? main.id : -1;
}

/** Live tanks (and tank orders in production) per front id. */
export function countTanks(world: World, f: Faction): Map<number, number> {
  const out = new Map<number, number>();
  for (const u of world.aliveUnits) if (u.owner === f.id && u.hp > 0 && isTank(u)) out.set(u.frontId, (out.get(u.frontId) ?? 0) + 1);
  for (const o of f.orders) if (isTankId(o.unitId)) out.set(o.frontId, (out.get(o.frontId) ?? 0) + 1);
  return out;
}

const lastConcentrate = new WeakMap<Faction, number>();

/**
 * Once a minute under an offensive: free line tanks of the other fronts join the main effort
 * (not a zone garrison's, not one in a push of its own, not a front holding with fewer than
 * minGroup tanks' worth of infantry). Returns the number moved.
 */
export function concentrateArmour(world: World, f: Faction): number {
  if (!ARMOUR_AB.on || f.directive.kind !== 'offensive') return 0;
  const last = lastConcentrate.get(f) ?? -Infinity;
  if (world.time - last < ARMOUR.concentrateEveryS) return 0;
  lastConcentrate.set(f, world.time);
  const main = frontById(f, f.mainFront);
  if (!main || garrisonsZone(main)) return 0;
  const donors = new Set(f.fronts.filter((s) => s.id !== main.id && !garrisonsZone(s) && s.mode !== 'push' && s.mode !== 'breakthrough').map((s) => s.id));
  let n = 0;
  for (const u of world.aliveUnits) {
    if (u.owner !== f.id || u.hp <= u.def.maxHp * 0.5 || !isTank(u) || !donors.has(u.frontId)) continue;
    if (u.manual || u.spearhead || u.opRole !== 'line' || u.behavior !== 'advance') continue;
    u.frontId = main.id;
    n++;
  }
  if (n > 0) world.note(f.id, 'log.armourMassed', { n }, 'info');
  return n;
}
