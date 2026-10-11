// Shared building blocks for the challenge strategies (2.2: one universal directive, no per-front orders).
import type { StrategyCtx } from '../types';
import { armyValue, directive, enemiesByDistance, lineAcross, towards } from '../worldq';

/** Fortified line across the approach from the nearest enemy capital, `r` m out from home (300 m long). */
export function homeLine(ctx: StrategyCtx, r: number): { a: { x: number; z: number }; b: { x: number; z: number } } | null {
  const e = enemiesByDistance(ctx.world, ctx.me)[0];
  if (e === undefined) return null;
  return lineAcross(ctx.world.hqPos(ctx.me), ctx.world.hqPos(e), r, 300);
}

/**
 * Hold near home: `fortify` draws a line `r` m out across the nearest enemy's approach (a permanent
 * fortified zone; every other front fortifies its own line); `defend` names that place as the axis.
 */
export function holdRing(ctx: StrategyCtx, kind: 'fortify' | 'defend', r: number): void {
  const e = enemiesByDistance(ctx.world, ctx.me)[0];
  const hq = ctx.world.hqPos(ctx.me);
  if (kind === 'fortify') {
    const line = homeLine(ctx, r);
    directive(ctx, 'fortify', undefined, line ?? undefined);
  } else directive(ctx, 'defend', e !== undefined ? towards(hq, ctx.world.hqPos(e), r) : undefined);
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

/** General offensive with `target`'s capital as the axis (the main effort and every front near it go for it). */
export function allOnCapital(ctx: StrategyCtx, target: number): void {
  ctx.markAttack(target);
  directive(ctx, 'offensive', ctx.world.hqPos(target));
}
