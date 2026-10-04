// raid — mechanised mix (motorised infantry, light tanks, recon); every 60 s each front attacks
// the least defended enemy village / town far from its owner's capital, nearest first.
import { dist } from '../../../src/sim/vec';
import type { Strategy } from '../types';
import { frontCentre, frontIds, hostileNear, isCapital, order, setMix } from '../worldq';

const FAR_FROM_CAPITAL_M = 900;
const UNDEFENDED = 150;

export const raid: Strategy = {
  id: 'raid',
  summary: 'mechanised mix; every 60 s each front attacks the least defended enemy village / town far from its capital',
  setup(ctx) {
    setMix(ctx, { motor_inf: 30, light_tank: 25, recon: 12, infantry: 12, medium_tank: 6 }, { motor_inf: 24, light_tank: 20, recon: 8 });
  },
  tick(ctx) {
    const w = ctx.world;
    if (Math.floor(w.time) % 60 !== 0) return;
    const taken = new Set<string>();
    for (const id of frontIds(ctx)) {
      const from = frontCentre(w, ctx.me, id);
      let best: { id: string; pos: { x: number; z: number } } | null = null;
      let bs = Infinity;
      for (const o of w.objectives) {
        if (o.owner < 0 || o.owner === ctx.me || !w.isHostile(ctx.me, o.owner) || taken.has(o.id)) continue;
        if ((o.kind !== 'village' && o.kind !== 'town') || isCapital(w, o)) continue;
        if (dist(o.pos, w.hqPos(o.owner)) < FAR_FROM_CAPITAL_M) continue;
        const def = hostileNear(w, ctx.me, o.pos, 300);
        // Undefended places first, then by defence; distance breaks ties (1 point per 10 m).
        const score = (def <= UNDEFENDED ? 0 : 1e5 + def * 20) + dist(from, o.pos) / 10;
        if (score < bs) { bs = score; best = { id: o.id, pos: o.pos }; }
      }
      if (!best) continue;
      taken.add(best.id);
      order(ctx, id, 'attack', best.pos);
    }
  },
};
