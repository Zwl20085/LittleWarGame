// Shared building blocks for the challenge strategies.
import type { StrategyCtx } from '../types';
import { faction } from '../types';
import { armyValue, enemiesByDistance, frontIds, order, towards } from '../worldq';
import type { V2 } from '../../../src/sim/vec';

/** Remember each front's initial bearing point (its first objective) so lines stay put after orders move targetPos. */
export function rememberAxes(ctx: StrategyCtx): void {
  const axes: Record<number, V2> = {};
  for (const s of faction(ctx).fronts) axes[s.id] = { ...s.targetPos };
  ctx.state.axes = axes;
}

export function axisOf(ctx: StrategyCtx, frontId: number): V2 {
  const axes = ctx.state.axes as Record<number, V2> | undefined;
  return axes?.[frontId] ?? ctx.world.cityOf(ctx.me).exit;
}

/** Every front holds (`fortify` or `defend`) a line `r` m out from the capital toward its wing's objective. */
export function holdRing(ctx: StrategyCtx, kind: 'fortify' | 'defend', r: number): void {
  const hq = ctx.world.hqPos(ctx.me);
  for (const id of frontIds(ctx)) order(ctx, id, kind, towards(hq, axisOf(ctx, id), r));
}

/** Weakest (by army value) of the `n` nearest enemies. */
export function weakestNeighbour(ctx: StrategyCtx, n = 2): number | undefined {
  const near = enemiesByDistance(ctx.world, ctx.me).slice(0, n);
  let best: number | undefined;
  let bv = Infinity;
  for (const e of near) {
    const v = armyValue(ctx.world, e);
    if (v < bv) { bv = v; best = e; }
  }
  return best;
}

/** All fronts attack `target`'s capital; the first front is the main effort. */
export function allOnCapital(ctx: StrategyCtx, target: number): void {
  ctx.markAttack(target);
  const hq = ctx.world.hqPos(target);
  const ids = frontIds(ctx);
  for (const id of ids) order(ctx, id, 'attack', hq);
  if (ids.length > 0) ctx.issue({ type: 'setMainFront', frontId: ids[0] });
}
