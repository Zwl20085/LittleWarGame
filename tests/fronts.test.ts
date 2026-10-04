import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { CommandBus } from '../src/sim/commands';
import { thinkHighCommand } from '../src/sim/command';
import { frontById, counterStrikes } from '../src/sim/frontref';
import { createFront, dissolveFront, frontForOrder, FRONT_OPS, reassignStale } from '../src/sim/frontops';
import { frontUnits, issueFrontOrder, leaderless, thinkFronts, upkeepCommander } from '../src/sim/fronts';
import { pickFront } from '../src/sim/production';
import { HOME } from '../src/sim/homeguard';
import { isCommander } from '../src/sim/formulas';
import type { Faction, FrontOrder } from '../src/sim/types';
import { dist, headingTo, type V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** 2.0 command hierarchy: dynamic fronts, order semantics, commanders, the capital's standing garrison. */
function setup(seconds: number, spectate = true): ReturnType<typeof createMatch> {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate,
  });
  run(match, seconds);
  return match;
}

function run(match: ReturnType<typeof createMatch>, seconds: number): void {
  for (let i = 0; i < seconds * match.world.tickHz; i++) {
    step(match);
    match.world.fx.length = 0;
  }
}

const order = (world: World, kind: FrontOrder['kind'], a: V2, b: V2 | null = null): FrontOrder =>
  ({ kind, a: { ...a }, b, issuedAt: world.time, manual: true });

/** Every living unit of every faction belongs to an existing front. */
function frontIdsValid(world: World): boolean {
  // (A commander recalled with its dissolved front leaves the field: behavior 'evacuate'.)
  return world.factions.every((f) => [...world.units.values()].every((u) => u.owner !== f.id || u.hp <= 0 || u.behavior === 'evacuate' || !!frontById(f, u.frontId)));
}

/** A settlement far (> newFrontM) from every front of `f`. */
function farObjective(world: World, f: Faction): V2 {
  const far = world.objectives.filter((o) => f.fronts.every((s) => dist(o.pos, s.front) > FRONT_OPS.newFrontM + 50 && dist(o.pos, s.targetPos) > FRONT_OPS.newFrontM + 50 && !s.line));
  expect(far.length).toBeGreaterThan(0);
  return far[0].pos;
}

describe('fronts (2.0 command hierarchy)', () => {
  it('creates, dissolves and keeps ids stable (no index/id mismatch)', () => {
    const { world } = setup(60);
    const f = world.factions[1];
    f.p = 10_000;
    const before = f.fronts.length;
    const seq = f.frontSeq;
    const target = world.objectives.find((o) => o.owner !== f.id)!;
    const s = createFront(world, f, target, 10)!;
    expect(s).not.toBeNull();
    expect(s.id).toBe(seq);
    expect(f.fronts.length).toBe(before + 1);
    expect(world.unitAlive(s.commanderId)?.frontId).toBe(s.id);
    expect(frontUnits(world, f.id, s.id).filter((u) => !isCommander(u.def)).length).toBeGreaterThan(0);
    expect(f.p).toBe(10_000 - world.data.units.get('commander')!.costP);
    // Dissolve a front that is NOT the last one: ids of the rest no longer match their index.
    const first = f.fronts[0];
    const into = f.fronts[1];
    const moved = frontUnits(world, f.id, first.id).filter((u) => !isCommander(u.def)).map((u) => u.id);
    dissolveFront(world, f, first, into);
    expect(frontById(f, first.id)).toBeUndefined();
    expect(f.fronts.some((x, i) => x.id !== i)).toBe(true);
    for (const id of moved) expect(world.unitAlive(id)?.frontId).toBe(into.id);
    expect(f.fronts.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 5);
    expect(frontById(f, pickFront(world, f))).toBeDefined();
    // A unit still carrying the dissolved id (e.g. a production order) joins an existing front.
    const stray = world.spawnUnit(f.id, 'infantry', world.cityOf(f.id).exit, first.id);
    reassignStale(world, f);
    expect(frontById(f, stray.frontId)).toBeDefined();
    // The front planner runs with gaps in the ids.
    thinkFronts(world, f);
    expect(frontIdsValid(world)).toBe(true);
  });

  it('applies all five order kinds', () => {
    const match = setup(60);
    const { world } = match;
    const f = world.factions[1];
    const s = f.fronts[0];
    const hq = world.hqPos(f.id);
    const mid = world.terrain.freeNear({ x: (hq.x + s.front.x) / 2, z: (hq.z + s.front.z) / 2 }, 40);
    issueFrontOrder(world, f, s, order(world, 'attack', s.targetPos));
    expect(s.line).toBeNull();
    expect(s.manualTarget).toBe(true);
    expect(s.posture).toBe('cautious');
    // Attack on an enemy capital: a city assault.
    const enemy = world.factions.find((e) => e.id !== f.id)!;
    issueFrontOrder(world, f, s, order(world, 'attack', world.hqPos(enemy.id)));
    expect(s.targetCity).toBe(enemy.id);
    issueFrontOrder(world, f, s, order(world, 'defend', mid));
    expect(s.line).not.toBeNull();
    expect(dist(s.line!.a, s.line!.b)).toBeGreaterThan(400);
    expect(s.posture).toBe('hold');
    issueFrontOrder(world, f, s, order(world, 'fortify', mid));
    expect(s.posture).toBe('fortify');
    // Front commander tactics: slots along the (terrain-snapped) ordered line.
    thinkFronts(world, f);
    const slots = Object.values(s.slots);
    expect(slots.length).toBeGreaterThan(0);
    const line = s.line!;
    const toLine = (p: V2): number => {
      const vx = line.b.x - line.a.x;
      const vz = line.b.z - line.a.z;
      const t = Math.max(0, Math.min(1, ((p.x - line.a.x) * vx + (p.z - line.a.z) * vz) / (vx * vx + vz * vz)));
      return Math.hypot(p.x - (line.a.x + vx * t), p.z - (line.a.z + vz * t));
    };
    const near = slots.filter((p) => toLine(p) < 120).length;
    expect(near / slots.length).toBeGreaterThan(0.6);
    // Fall back: spearheads dropped, and units far from the new line march to it without fighting forward.
    const tanks = frontUnits(world, f.id, s.id).filter((u) => u.def.kind === 'vehicle' && u.def.id !== 'supply_truck' && !u.manual);
    for (const u of tanks) u.spearhead = 'x';
    issueFrontOrder(world, f, s, order(world, 'fallBack', mid));
    expect(s.posture).toBe('hold');
    expect(tanks.every((u) => u.spearhead === null)).toBe(true);
    run(match, 2);
    const far = frontUnits(world, f.id, s.id).filter((u) => !isCommander(u.def) && u.def.kind === 'infantry' && !u.routing && u.behavior === 'advance' && u.opRole === 'line' && dist(u.pos, s.slots[u.id] ?? s.front) > 60);
    if (far.length > 0) expect(far.filter((u) => u.status === 'status.fallingBack').length / far.length).toBeGreaterThan(0.5);
    // Auto hands the objective back to the commander.
    issueFrontOrder(world, f, s, order(world, 'auto', mid));
    expect(s.line).toBeNull();
    expect(s.manualTarget).toBe(false);
  });

  it('replaces a lost commander after the respawn delay, for P', () => {
    const { world } = setup(30);
    const f = world.factions[2];
    const s = f.fronts[0];
    const rules = world.data.rules.command;
    const cmd = world.unitAlive(s.commanderId)!;
    cmd.hp = 0;
    upkeepCommander(world, f, s);
    expect(s.commanderId).toBeNull();
    expect(leaderless(world, s)).toBe(true);
    f.p = 5000;
    world.tick += Math.ceil((rules.commander_respawn_seconds + 1) * world.tickHz);
    upkeepCommander(world, f, s);
    expect(world.unitAlive(s.commanderId)).toBeTruthy();
    expect(f.p).toBe(5000 - world.data.units.get(rules.commander_unit)!.costP);
    expect(leaderless(world, s)).toBe(false);
  });

  it('keeps a standing capital garrison from minute 2', () => {
    const { world } = setup(140);
    const want = world.data.rules.command.capital_standing_garrison;
    for (const f of world.factions) {
      const guards = [...world.units.values()].filter((u) => u.owner === f.id && u.hp > 0 && u.opObjective === `hq:${f.id}`);
      expect(guards.length).toBeGreaterThanOrEqual(want);
      expect(guards.some((u) => u.def.kind === 'infantry')).toBe(true);
    }
  });

  it('opens a new front for a player order far from every front', () => {
    const match = setup(30, false);
    const { world } = match;
    const f = world.factions[0];
    f.p = 10_000;
    const before = f.fronts.length;
    const p = farObjective(world, f);
    const bus = new CommandBus();
    bus.issue(match, 0, { type: 'frontOrder', frontId: null, kind: 'defend', a: p });
    bus.flush(match);
    expect(f.fronts.length).toBe(before + 1);
    const s = f.fronts[f.fronts.length - 1];
    expect(s.order.kind).toBe('defend');
    expect(s.order.manual).toBe(true);
    // An order near an existing front goes to that front.
    expect(frontForOrder(world, f, s.targetPos)).toBe(s);
  });

  it('detects an all-in rush on a capital at minute 5, recalls against it and strikes the emptied capital', () => {
    const match = setup(300);
    const { world } = match;
    const victim = world.factions[0];
    const raider = world.factions.find((x) => x.alive && x.id !== 0 && world.isHostile(0, x.id))!;
    const hq = world.hqPos(0);
    const toward = headingTo(hq, world.hqPos(raider.id));
    // The raider throws its whole mobile army at our capital, 700 m out on its side.
    const army = [...world.units.values()].filter((u) => u.owner === raider.id && u.hp > 0 && !u.fixed && !isCommander(u.def) && u.def.id !== 'supply_truck');
    expect(army.length).toBeGreaterThan(20);
    army.forEach((u, i) => {
      const p = world.terrain.freeNear({ x: hq.x + Math.cos(toward) * (700 + (i % 5) * 12) + (i % 7) * 8, z: hq.z + Math.sin(toward) * (700 + (i % 5) * 12) + Math.floor(i / 7) * 8 }, 60);
      u.pos = { ...p };
      u.path = [];
      u.dest = null;
      u.opRole = 'line';
      u.spearhead = `hq:0`;
    });
    for (const s of raider.fronts) issueFrontOrder(world, raider, s, { kind: 'attack', a: { ...hq }, b: null, issuedAt: world.time, manual: true });
    // One of our fronts is out in the field, 600 m short of the raider's capital (too far to be
    // recalled in time), and the raider's capital is really empty (its fixed strongpoints are gone:
    // at minute 5 they alone outweigh any single front, see docs/STRATEGY_LAB.md round 6).
    const rhq = world.hqPos(raider.id);
    const back = headingTo(rhq, hq);
    const field = victim.fronts[victim.fronts.length - 1];
    frontUnits(world, 0, field.id).filter((u) => !isCommander(u.def) && u.def.id !== 'supply_truck').forEach((u, i) => {
      u.pos = { ...world.terrain.freeNear({ x: rhq.x + Math.cos(back) * 600 + (i % 6) * 10, z: rhq.z + Math.sin(back) * 600 + Math.floor(i / 6) * 10 }, 60) };
      u.path = [];
      u.dest = null;
    });
    field.front = { x: rhq.x + Math.cos(back) * 600, z: rhq.z + Math.sin(back) * 600 };
    for (const u of world.units.values()) if (u.owner === raider.id && (u.fixed || dist(u.pos, rhq) < 400)) u.hp = 0;
    victim.command.nextAt = 0;
    thinkHighCommand(world, victim);
    const ht = victim.command.homeThreat;
    expect(ht.aimed).toBeGreaterThanOrEqual(HOME.minThreat);
    run(match, 30);
    expect(ht.active).toBe(true);
    const guards = [...world.units.values()].filter((u) => u.owner === 0 && u.hp > 0 && u.opObjective === 'hq:0').length;
    expect(guards + ht.recall.length).toBeGreaterThan(world.data.rules.command.capital_standing_garrison);
    // The field front strikes the raider's emptied capital instead of marching home.
    let struck = victim.fronts.some((s) => counterStrikes.has(s) && s.targetCity === raider.id);
    for (let k = 0; k < 12 && !struck; k++) {
      run(match, 10);
      struck = victim.fronts.some((s) => counterStrikes.has(s) && s.targetCity === raider.id);
    }
    expect(struck).toBe(true);
    // …and the rush has not taken the capital.
    expect(victim.alive).toBe(true);
  }, 120_000);
});
