// feint: a loud offensive on one axis (the nearest enemy's nearest settlement), then after 3 min the
// real strike on another (the second nearest enemy's capital, a different bearing). Armour-heavy mix.
// Directive only: the front commanders do the rest, like a human supreme HQ.
import { dist } from '../../../src/sim/vec';
import type { Strategy } from '../types';
import { directive, enemiesByDistance, isCapital, setMix } from '../worldq';
import { allOnCapital } from './common';

const MIX = { infantry: 25, motor_inf: 10, light_tank: 10, medium_tank: 26, heavy_tank: 10, at_gun: 5, mortar: 5 };
const CAPS = { medium_tank: 30, heavy_tank: 14, light_tank: 14 };
const FEINT_AT_S = 420;
const FEINT_FOR_S = 180;
const CHECK_S = 60;

export const feint: Strategy = {
  id: 'feint',
  summary: 'loud offensive on the nearest enemy settlement from 7 min; after 3 min the real strike on the second nearest enemy capital',
  setup(ctx) {
    setMix(ctx, MIX, CAPS);
  },
  tick(ctx) {
    const w = ctx.world;
    if (Math.floor(w.time) % CHECK_S !== 0) return;
    const enemies = enemiesByDistance(w, ctx.me);
    if (!enemies.length) return;
    if (w.time < FEINT_AT_S) { directive(ctx, 'advance'); return; }
    const feinted = enemies[0];
    const strikeOn = enemies[1] ?? enemies[0];
    if (w.time >= FEINT_AT_S + FEINT_FOR_S) { allOnCapital(ctx, strikeOn); return; }
    const home = w.hqPos(ctx.me);
    let axis = w.hqPos(feinted);
    let bd = Infinity;
    for (const o of w.objectives) {
      if (o.owner !== feinted || (o.kind !== 'village' && o.kind !== 'town') || isCapital(w, o)) continue;
      const d = dist(home, o.pos);
      if (d < bd) { bd = d; axis = o.pos; }
    }
    directive(ctx, 'offensive', axis);
  },
};
