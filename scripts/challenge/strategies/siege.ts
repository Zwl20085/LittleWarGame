// siege: artillery line + fortify, then grind. Howitzers / mortars / infantry / engineers / MG build a
// fortified line 45 % of the way to the nearest enemy capital; once 8 howitzers stand (or at 15 min)
// the directive becomes an offensive on that capital, which the front commanders run as a siege.
import { dist } from '../../../src/sim/vec';
import type { Strategy } from '../types';
import { directive, enemiesByDistance, lineAcross, setMix } from '../worldq';
import { allOnCapital } from './common';
import { pick } from './squad';

const MIX = { howitzer: 22, mortar: 10, infantry: 24, engineer: 10, mg: 10, at_gun: 8, medium_tank: 10, recon: 2 };
const CAPS = { howitzer: 14, mortar: 10 };
const LINE_SHARE = 0.45;
const LINE_LEN_M = 400;
const GUNS_READY = 8;
const MIN_FORTIFY_S = 360;
const MAX_FORTIFY_S = 900;
const CHECK_S = 60;

export const siege: Strategy = {
  id: 'siege',
  summary: 'artillery + works on a fortified line 45 % of the way to the nearest capital; at 8 howitzers (or 15 min) an offensive on it',
  setup(ctx) {
    setMix(ctx, MIX, CAPS);
  },
  tick(ctx) {
    const w = ctx.world;
    if (Math.floor(w.time) % CHECK_S !== 0) return;
    const target = enemiesByDistance(w, ctx.me)[0];
    if (target === undefined) return;
    const home = w.hqPos(ctx.me);
    const hq = w.hqPos(target);
    const guns = pick(ctx, ['howitzer'], home).length;
    const ready = w.time >= MAX_FORTIFY_S || (w.time >= MIN_FORTIFY_S && guns >= GUNS_READY);
    if (ctx.state.grind === true || ready) {
      ctx.state.grind = true;
      allOnCapital(ctx, target);
    } else directive(ctx, 'fortify', undefined, lineAcross(home, hq, dist(home, hq) * LINE_SHARE, LINE_LEN_M));
  },
};
