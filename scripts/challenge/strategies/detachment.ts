// A detachment that slips to an enemy capital through ground its owner cannot see (shadow_strike,
// backdoor): select squads, plan the shadow route against the chosen observers, send them.
import type { Unit } from '../../../src/sim/types';
import { shadowRoute, seenBy } from '../route';
import type { StrategyCtx } from '../types';
import { groupIds, pick, sendRoute, setGroup } from './squad';

/** Ring the detachment stages at before the final attack-move: just outside the capital's direct fire. */
export const SHADOW_RING_M = 650;

export interface Launch {
  readonly ids: number[];
  readonly seenShare: number;
  readonly found: boolean;
}

/**
 * Send `squads` along a shadow route to `target`'s capital, unseen by `observers`, then attack-move
 * from the staging point. Stores them as group `name`. Returns null when `squads` is empty.
 */
export function launchDetachment(ctx: StrategyCtx, name: string, squads: Unit[], target: number, observers: readonly number[]): Launch | null {
  if (!squads.length) return null;
  const w = ctx.world;
  const from = squads[0].pos;
  const hq = w.hqPos(target);
  const route = shadowRoute(w, squads.find((u) => u.def.kind === 'vehicle') ?? squads[0], from, hq, seenBy(w, observers), SHADOW_RING_M);
  const ids = squads.map((u) => u.id);
  setGroup(ctx, name, ids);
  ctx.markAttack(target);
  sendRoute(ctx, ids, [...route.waypoints, route.staging], hq);
  return { ids, seenShare: route.seenShare, found: route.found };
}

/** Squads of `kinds` nearest home that no other group has claimed, at most `max`. */
export function squadsNearHome(ctx: StrategyCtx, kinds: readonly string[], max: number, exclude: Set<number>): Unit[] {
  return pick(ctx, kinds, ctx.world.hqPos(ctx.me), exclude).slice(0, max);
}

export const aliveCount = (ctx: StrategyCtx, name: string): number => groupIds(ctx, name).length;
