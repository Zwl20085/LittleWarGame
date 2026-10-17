// Challenge lab: read-only world queries and command helpers shared by the strategies.
// The challenger is omniscient (open info mode): strategies may read any world state.
import type { DirectiveKind, Objective, Unit } from '../../src/sim/types';
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

/**
 * 2.2: the supreme HQ's one universal directive (setDirective) — the strategies' only operational
 * command. Not re-sent while the same directive (kind, axis within 30 m, line) already stands.
 */
export function directive(ctx: StrategyCtx, kind: DirectiveKind, axis?: V2, line?: { a: V2; b: V2 }): void {
  const cur = faction(ctx).directive;
  const near = (p: V2 | null | undefined, q: V2 | null | undefined): boolean => (!p && !q) || (!!p && !!q && dist(p, q) < 30);
  if (cur.manual && cur.kind === kind && near(cur.axis, axis) && near(cur.line?.a, line?.a) && near(cur.line?.b, line?.b)) return;
  ctx.issue({ type: 'setDirective', kind, ...(axis ? { axis: { ...axis } } : {}), ...(line ? { line: { a: { ...line.a }, b: { ...line.b } } } : {}) });
}

/** A line of `len` m centred `r` m out from `from` toward `to`, square to that bearing (a fortify line). */
export function lineAcross(from: V2, to: V2, r: number, len: number): { a: V2; b: V2 } {
  const c = towards(from, to, r);
  const l = Math.max(1e-6, dist(from, to));
  const nx = -(to.z - from.z) / l;
  const nz = (to.x - from.x) / l;
  return { a: { x: c.x + nx * len / 2, z: c.z + nz * len / 2 }, b: { x: c.x - nx * len / 2, z: c.z - nz * len / 2 } };
}

/**
 * Production mix through setWeight / setCap: every unit not listed gets weight 0 (supply trucks
 * keep a small share so the army stays supplied unless listed). Caps are raised for listed units.
 */
export function setMix(ctx: StrategyCtx, weights: Record<string, number>, caps: Record<string, number> = {}): void {
  const w = ctx.world;
  for (const [id, u] of w.data.units) {
    // Only producible units take weights (setWeight refuses the train and the commander).
    if (id === w.data.rules.command.commander_unit || !u.producible) continue;
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
