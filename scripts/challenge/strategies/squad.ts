// Shared helpers for the 3.0 strategies that steer groups of units directly (unit-level orders
// through the command API, like a player box-selecting and right-clicking).
import type { Unit } from '../../../src/sim/types';
import { dist, type V2 } from '../../../src/sim/vec';
import type { StrategyCtx } from '../types';
import { combatUnit, valueOf } from '../worldq';

export const TANKS: readonly string[] = ['light_tank', 'medium_tank', 'heavy_tank'];
export const FOOT: readonly string[] = ['infantry', 'recon', 'motor_inf', 'engineer'];
/** Capturing infantry: only these can take an HQ point. */
export const CAPTURERS: readonly string[] = ['infantry', 'recon', 'motor_inf', 'engineer'];
export const MOTORIZED: readonly string[] = ['motor_inf', 'light_tank', 'recon'];

/** A named group of unit ids kept in ctx.state; dead ids are dropped on every read. */
export function groupIds(ctx: StrategyCtx, name: string): number[] {
  const cur = (ctx.state[name] as number[] | undefined) ?? [];
  const alive = cur.filter((id) => {
    const u = ctx.world.units.get(id);
    return !!u && u.hp > 0 && u.owner === ctx.me;
  });
  ctx.state[name] = alive;
  return alive;
}

export const setGroup = (ctx: StrategyCtx, name: string, ids: number[]): void => { ctx.state[name] = ids; };

/** Ids in any of the named groups (a unit belongs to one group). */
export function claimed(ctx: StrategyCtx, names: readonly string[]): Set<number> {
  const s = new Set<number>();
  for (const n of names) for (const id of groupIds(ctx, n)) s.add(id);
  return s;
}

/** Own combat units of the given kinds, nearest to `near` first, not routing and not in `exclude`. */
export function pick(ctx: StrategyCtx, kinds: readonly string[], near: V2, exclude: Set<number> = new Set()): Unit[] {
  const out: Unit[] = [];
  for (const u of ctx.world.units.values()) if (u.owner === ctx.me && combatUnit(u) && !u.routing && kinds.includes(u.def.id) && !exclude.has(u.id)) out.push(u);
  return out.sort((a, b) => dist(a.pos, near) - dist(b.pos, near) || a.id - b.id);
}

export function centroid(ctx: StrategyCtx, ids: readonly number[]): V2 | null {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const id of ids) {
    const u = ctx.world.units.get(id);
    if (!u || u.hp <= 0) continue;
    x += u.pos.x;
    z += u.pos.z;
    n++;
  }
  return n ? { x: x / n, z: z / n } : null;
}

/** Share of the group within `r` m of `p`. */
export function shareNear(ctx: StrategyCtx, ids: readonly number[], p: V2, r: number): number {
  let n = 0;
  let k = 0;
  for (const id of ids) {
    const u = ctx.world.units.get(id);
    if (!u || u.hp <= 0) continue;
    n++;
    if (dist(u.pos, p) <= r) k++;
  }
  return n ? k / n : 0;
}

export const valueOfIds = (ctx: StrategyCtx, ids: readonly number[]): number =>
  ids.reduce((a, id) => { const u = ctx.world.units.get(id); return a + (u && u.hp > 0 ? valueOf(u) : 0); }, 0);

/**
 * Queued `move`s through `points` (max 8 in the queue), the first replacing any current order.
 * The route ends with an `attackMove` on `final`, or, when `final` is null, holds at the last point.
 */
export function sendRoute(ctx: StrategyCtx, ids: number[], points: V2[], final: V2 | null): void {
  if (!ids.length) return;
  const pts = points.slice(0, 7);
  if (!pts.length) {
    if (final) ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...final } });
    return;
  }
  pts.forEach((p, i) => {
    const last = i === pts.length - 1 && !final;
    ctx.issue({ type: 'unitOrder', unitIds: ids, order: last ? 'moveHold' : 'move', pos: { ...p }, ...(i > 0 ? { queue: true } : {}) });
  });
  if (final) ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...final }, queue: true });
}

/** Total army value now (own). */
export const ownValue = (ctx: StrategyCtx): number => {
  let v = 0;
  for (const u of ctx.world.units.values()) if (u.owner === ctx.me && combatUnit(u)) v += valueOf(u);
  return v;
};
