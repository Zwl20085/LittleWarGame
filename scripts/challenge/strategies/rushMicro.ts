// rush_micro — the literal "select everything and attack the capital": same mix as `rush`, but from
// `rushAt` every 60 s every combat unit gets a unit-level `attackMove` on the nearest enemy capital
// (CommandBus `unitOrder`), bypassing the front commanders. No front orders at all.
import type { Strategy } from '../types';
import { combatUnit, enemiesByDistance, setMix } from '../worldq';
import { RUSH_CAPS, RUSH_MIX } from './rush';

export const rushMicro: Strategy = {
  id: 'rush_micro',
  summary: 'rush mix; from rushAt every 60 s all combat units attack-move on the nearest enemy capital (unit micro, no front orders)',
  setup(ctx) {
    setMix(ctx, RUSH_MIX, RUSH_CAPS);
  },
  tick(ctx) {
    const w = ctx.world;
    if (w.time < ctx.params.rushAt || Math.floor(w.time - ctx.params.rushAt) % 60 !== 0) return;
    const target = enemiesByDistance(w, ctx.me)[0];
    if (target === undefined) return;
    ctx.markAttack(target);
    const ids: number[] = [];
    for (const u of w.units.values()) if (u.owner === ctx.me && combatUnit(u) && !u.routing) ids.push(u.id);
    if (ids.length > 0) ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: { ...w.hqPos(target) } });
  },
};
