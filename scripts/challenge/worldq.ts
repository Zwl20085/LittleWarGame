// Challenge lab: read-only world queries and command helpers shared by the strategies.
// The challenger is omniscient (open info mode): strategies may read any world state.
import type { OrderKind, Objective, Unit } from '../../src/sim/types';
import { dist, type V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import { faction, type StrategyCtx } from './types';

export const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);

/** Combat units: alive, not a fixed strongpoint, not a truck, not a front commander. */
export const combatUnit = (u: Unit): boolean => u.hp > 0 && !u.fixed && u.def.id !== 'supply_truck' && u.def.id !== 'commander';

export function armyValue(world: World, f: number): number {
  let v = 0;
  for (const u of world.units.values()) if (u.owner === f && combatUnit(u)) v += valueOf(u);
  return v;
}

/** Value of `owner`'s combat units within r of p. */
export function valueNear(world: World, owner: number, p: V2, r: number): number {
  let v = 0;
  for (const u of world.units.values()) if (u.owner === owner && combatUnit(u) && dist(u.pos, p) <= r) v += valueOf(u);
  return v;
}

/** Value of every faction hostile to `me` within r of p (fixed strongpoints included: they defend). */
export function hostileNear(world: World, me: number, p: V2, r: number): number {
  let v = 0;
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.owner === me || !world.isHostile(me, u.owner) || u.def.id === 'supply_truck') continue;
    if (dist(u.pos, p) <= r) v += u.fixed ? 200 : valueOf(u);
  }
  return v;
}

/** Alive hostile factions, nearest capital first (ties by id). */
export function enemiesByDistance(world: World, me: number): number[] {
  const hq = world.hqPos(me);
  return world.factions
    .filter((f) => f.alive && f.id !== me && world.isHostile(me, f.id))
    .map((f) => ({ id: f.id, d: dist(hq, world.hqPos(f.id)) }))
    .sort((a, b) => a.d - b.d || a.id - b.id)
    .map((x) => x.id);
}

export const towards = (a: V2, b: V2, d: number): V2 => {
  const l = dist(a, b);
  if (l < 1e-6) return { ...a };
  const k = Math.min(1, d / l);
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
};

/** Mean position of a front's combat units (its front point when it has none). */
export function frontCentre(world: World, me: number, frontId: number): V2 {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const u of world.units.values()) {
    if (u.owner !== me || u.frontId !== frontId || !combatUnit(u)) continue;
    x += u.pos.x;
    z += u.pos.z;
    n++;
  }
  if (n > 0) return { x: x / n, z: z / n };
  const s = world.factions[me].fronts.find((fr) => fr.id === frontId);
  return s ? { ...s.front } : world.hqPos(me);
}

export const isSettlement = (o: Objective): boolean => o.kind === 'village' || o.kind === 'town' || o.kind === 'city';

/** Is `o` the capital city of some faction? (capitals are attacked via their HQ position.) */
export function isCapital(world: World, o: Objective): boolean {
  return world.factions.some((f) => dist(world.hqPos(f.id), o.pos) < Math.max(60, o.radius));
}

/** The challenger's front ids, in a stable order. */
export const frontIds = (ctx: StrategyCtx): number[] => faction(ctx).fronts.map((s) => s.id).sort((a, b) => a - b);

export function order(ctx: StrategyCtx, frontId: number, kind: OrderKind, a: V2, b?: V2): void {
  ctx.issue(b ? { type: 'frontOrder', frontId, kind, a: { ...a }, b: { ...b } } : { type: 'frontOrder', frontId, kind, a: { ...a } });
}

export function orderAll(ctx: StrategyCtx, kind: OrderKind, a: V2): void {
  for (const id of frontIds(ctx)) order(ctx, id, kind, a);
}

/**
 * Production mix through setWeight / setCap: every unit not listed gets weight 0 (supply trucks
 * keep a small share so the army stays supplied unless listed). Caps are raised for listed units.
 */
export function setMix(ctx: StrategyCtx, weights: Record<string, number>, caps: Record<string, number> = {}): void {
  const w = ctx.world;
  for (const id of w.data.units.keys()) {
    if (id === w.data.rules.command.commander_unit) continue;
    const def = id === 'supply_truck' ? 1 : 0;
    ctx.issue({ type: 'setWeight', unitId: id, weight: weights[id] ?? def });
  }
  for (const [id, cap] of Object.entries(caps)) ctx.issue({ type: 'setCap', unitId: id, cap });
}

/** Seconds since the strategy last stamped `key` (Infinity if never), and stamp helper. */
export function due(ctx: StrategyCtx, key: string, everyS: number): boolean {
  const last = ctx.state[key];
  if (typeof last === 'number' && ctx.world.time - last < everyS) return false;
  ctx.state[key] = ctx.world.time;
  return true;
}
