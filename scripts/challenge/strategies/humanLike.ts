// human_like — what a decent player does: hold home when threatened, take cheap places first,
// mass, and strike the capital of a neighbour whose army is committed elsewhere.
import { dist, type V2 } from '../../../src/sim/vec';
import type { Strategy, StrategyCtx } from '../types';
import { armyValue, enemiesByDistance, frontCentre, frontIds, hostileNear, isCapital, order, setMix, towards, valueNear } from '../worldq';
import { allOnCapital } from './common';

const THINK_S = 30;
const STRIKE_FROM_S = 12 * 60;
/** Strike when their capital area holds < this share of their army … */
const COMMITTED_SHARE = 0.4;
/** … and our army is ≥ this × the capital's defence and ≥ this share of their whole army. */
const STRIKE_OVERMATCH = 2.2;
const STRIKE_ARMY_RATIO = 0.8;
/** Call the strike off when our army fell below this share of its value at launch. */
const STRIKE_ABORT = 0.5;
const PLACE_VALUE: Record<string, number> = { city: 4, town: 3, village: 1.5, point: 1 };

interface Strike { target: number; at: number; army: number }

/** Defended value of a capital: its own units within 800 m plus fixed strongpoints. */
export function capitalHold(ctx: StrategyCtx, e: number): number {
  return valueNear(ctx.world, e, ctx.world.hqPos(e), 800);
}

function homeThreat(ctx: StrategyCtx): { at: V2; value: number } | null {
  const w = ctx.world;
  const hq = w.hqPos(ctx.me);
  let v = 0;
  let x = 0;
  let z = 0;
  for (const u of w.units.values()) {
    if (u.hp <= 0 || u.fixed || !w.isHostile(ctx.me, u.owner) || u.def.id === 'supply_truck') continue;
    const d = dist(u.pos, hq);
    if (d > 900) continue;
    const k = (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);
    v += k;
    x += u.pos.x * k;
    z += u.pos.z * k;
  }
  if (v < 300 || v < 0.8 * valueNear(w, ctx.me, hq, 600)) return null;
  return { at: { x: x / v, z: z / v }, value: v };
}

function pickStrike(ctx: StrategyCtx): number | undefined {
  const w = ctx.world;
  const mine = armyValue(w, ctx.me);
  let best: number | undefined;
  let bd = Infinity;
  for (const e of enemiesByDistance(w, ctx.me).slice(0, 2)) {
    const army = armyValue(w, e);
    const hold = capitalHold(ctx, e);
    if (hold > COMMITTED_SHARE * army || mine < STRIKE_OVERMATCH * hold || mine < STRIKE_ARMY_RATIO * army) continue;
    if (hold < bd) { bd = hold; best = e; }
  }
  return best;
}

function expand(ctx: StrategyCtx, fronts: number[]): void {
  const w = ctx.world;
  const hq = w.hqPos(ctx.me);
  const taken = new Set<string>();
  for (const id of fronts) {
    const from = frontCentre(w, ctx.me, id);
    let best: V2 | null = null;
    let bk = '';
    let bs = -Infinity;
    for (const o of w.objectives) {
      if (o.owner === ctx.me || taken.has(o.id) || isCapital(w, o)) continue;
      if (o.owner >= 0 && !w.isHostile(ctx.me, o.owner)) continue;
      if (dist(o.pos, hq) > 2600) continue;
      const def = hostileNear(w, ctx.me, o.pos, 300);
      const score = (PLACE_VALUE[o.kind] ?? 1) / (1 + def / 200) / (1 + dist(from, o.pos) / 800);
      if (score > bs) { bs = score; best = o.pos; bk = o.id; }
    }
    if (!best) continue;
    taken.add(bk);
    order(ctx, id, 'attack', best);
  }
}

export const humanLike: Strategy = {
  id: 'human_like',
  summary: 'hold home when threatened, take cheap places, mass, then strike the capital of a neighbour committed elsewhere',
  setup(ctx) {
    setMix(ctx, { infantry: 30, mg: 6, at_gun: 8, mortar: 6, engineer: 3, motor_inf: 6, light_tank: 6, medium_tank: 14, heavy_tank: 4, howitzer: 2, supply_truck: 2 }, { infantry: 30, medium_tank: 10 });
  },
  tick(ctx) {
    const w = ctx.world;
    if (Math.floor(w.time) % THINK_S !== 0) return;
    let fronts = frontIds(ctx);
    // 1. Home first: the front nearest home holds the threatened approach.
    const threat = homeThreat(ctx);
    if (threat && fronts.length > 1) {
      const hq = w.hqPos(ctx.me);
      const home = [...fronts].sort((a, b) => dist(frontCentre(w, ctx.me, a), hq) - dist(frontCentre(w, ctx.me, b), hq) || a - b)[0];
      order(ctx, home, 'defend', towards(hq, threat.at, 200));
      fronts = fronts.filter((id) => id !== home);
    }
    // 2. A strike under way: keep it unless the target fell or the army bled out.
    const strike = ctx.state.strike as Strike | undefined;
    if (strike) {
      const alive = w.factions[strike.target].alive;
      if (alive && armyValue(w, ctx.me) >= STRIKE_ABORT * strike.army) {
        const hqT = w.hqPos(strike.target);
        for (const id of fronts) order(ctx, id, 'attack', hqT);
        return;
      }
      ctx.state.strike = undefined;
    }
    // 3. Mass, then strike a neighbour whose army is away from its capital.
    if (w.time >= STRIKE_FROM_S) {
      const target = pickStrike(ctx);
      if (target !== undefined) {
        ctx.state.strike = { target, at: w.time, army: armyValue(w, ctx.me) } satisfies Strike;
        allOnCapital(ctx, target);
        if (threat && fronts.length > 0) {
          // allOnCapital orders every front; put the home front back on its line.
          const all = frontIds(ctx);
          const home = all.find((id) => !fronts.includes(id));
          if (home !== undefined) order(ctx, home, 'defend', towards(w.hqPos(ctx.me), threat.at, 200));
        }
        return;
      }
    }
    // 4. Otherwise expand: cheap, valuable places near home.
    expand(ctx, fronts);
  },
};
