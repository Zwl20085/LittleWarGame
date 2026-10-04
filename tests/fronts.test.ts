import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { CommandBus } from '../src/sim/commands';
import { thinkHighCommand } from '../src/sim/command';
import { frontById, counterStrikes } from '../src/sim/frontref';
import { createFront, dissolveFront, frontForOrder, FRONT_OPS, reassignStale, transferable } from '../src/sim/frontops';
import { frontUnits, issueFrontOrder, leaderless, thinkFronts, upkeepCommander } from '../src/sim/fronts';
import { pickFront } from '../src/sim/production';
import { HOME } from '../src/sim/homeguard';
import { isCommander } from '../src/sim/formulas';
import type { Faction, Front, FrontOrder, Unit, Zone } from '../src/sim/types';
import { garrisonsZone } from '../src/sim/theatre';
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
    // 2.1: the strongpoints are pillboxes now (fortplans / sim.createMatch) — level them too.
    for (const w of world.forts) if (w.owner === raider.id && dist(w.pos, rhq) < 400) w.hp = 0;
    // (2.1: its capital buildings count in the forecast defence too.)
    for (const w of world.forts) if (w.owner === raider.id && dist(w.pos, rhq) < 400) w.hp = 0;
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

/** Distance from `p` to segment a–b, and its signed offset across the line (+ = away from `home`). */
function lineOffset(p: V2, a: V2, b: V2, home: V2): { d: number; ahead: number } {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2));
  const q = { x: a.x + vx * t, z: a.z + vz * t };
  const n = { x: -vz / Math.sqrt(l2), z: vx / Math.sqrt(l2) };
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const away = (mid.x - home.x) * n.x + (mid.z - home.z) * n.z >= 0 ? 1 : -1;
  return { d: dist(p, q), ahead: ((p.x - q.x) * n.x + (p.z - q.z) * n.z) * away };
}

/** Roles a binding order forbids (detachments and manoeuvre parties). */
const DETACHED = new Set(['occupy', 'raid', 'rearguard']);
const isDetached = (u: Unit, f: number): boolean => DETACHED.has(u.opRole) || (u.opRole === 'garrison' && u.opObjective !== `hq:${f}`);

/** Combat line troops of a front (no commander, trucks, guns, recon, engineers on works, capital guards). */
function lineTroops(world: World, f: number, frontId: number): Unit[] {
  return frontUnits(world, f, frontId).filter((u) => !isCommander(u.def) && !['supply_truck', 'howitzer', 'mortar', 'recon', 'engineer'].includes(u.def.id)
    && !(u.opRole === 'garrison' && u.opObjective === `hq:${f}`));
}

describe('fronts 2.1: binding orders, more fronts, zone garrisons', () => {
  it('binds an attack order: the front marches on the objective and lends no detachments', () => {
    const match = setup(90, false);
    const { world } = match;
    const f = world.factions[0];
    const s = f.fronts[0];
    // A place we do not hold, ≥ 600 m from the front's troops.
    const c0 = lineTroops(world, 0, s.id);
    const mid = { x: c0.reduce((a, u) => a + u.pos.x, 0) / c0.length, z: c0.reduce((a, u) => a + u.pos.z, 0) / c0.length };
    const obj = world.objectives.filter((o) => o.owner !== 0 && dist(o.pos, mid) > 600).sort((a, b) => dist(a.pos, mid) - dist(b.pos, mid))[0];
    expect(obj).toBeDefined();
    const bus = new CommandBus();
    bus.issue(match, 0, { type: 'frontOrder', frontId: s.id, kind: 'attack', a: obj.pos });
    bus.flush(match);
    expect(s.order.manual).toBe(true);
    const before = new Map(lineTroops(world, 0, s.id).map((u) => [u.id, dist(u.pos, obj.pos)]));
    let detached = 0;
    for (let t = 0; t < 180; t++) {
      run(match, 1);
      detached += frontUnits(world, 0, s.id).filter((u) => isDetached(u, 0)).length;
      if (t === 19) {
        // Within 20 s the front's destinations lead toward the objective.
        const troops = lineTroops(world, 0, s.id).filter((u) => before.has(u.id) && u.dest && !u.routing);
        expect(troops.length).toBeGreaterThan(0);
        const closer = troops.filter((u) => dist(u.dest!, obj.pos) < before.get(u.id)! - 50).length;
        expect(closer / troops.length).toBeGreaterThan(0.6);
        expect(s.reason).not.toBe('reason.outmatched');
      }
    }
    expect(detached).toBe(0);
    expect(s.order.kind).toBe('attack');
    expect(dist(s.targetPos, obj.pos)).toBeLessThan(1);
  }, 120_000);

  it('binds a defend order: every line unit holds the ordered line, nobody pushes past it', () => {
    const match = setup(90, false);
    const { world } = match;
    const f = world.factions[0];
    const s = f.fronts[0];
    const hq = world.hqPos(0);
    const p = world.nav(false, 35).nearestPassable({ x: hq.x + (s.front.x - hq.x) * 0.5, z: hq.z + (s.front.z - hq.z) * 0.5 }, 60)!;
    const bus = new CommandBus();
    bus.issue(match, 0, { type: 'frontOrder', frontId: s.id, kind: 'defend', a: p });
    bus.flush(match);
    expect(s.posture).toBe('hold');
    const line = s.line!;
    let loose = 0;
    for (let t = 0; t < 180; t++) {
      run(match, 1);
      loose += frontUnits(world, 0, s.id).filter((u) => u.spearhead !== null || isDetached(u, 0) || u.opRole === 'maneuver' || u.opRole === 'siege' || u.opRole === 'infiltrate').length;
    }
    expect(loose).toBe(0);
    expect(s.reason.startsWith('reason.order.') || s.reason === 'reason.homeDefence').toBe(true);
    const troops = lineTroops(world, 0, s.id).filter((u) => !u.routing && !u.manual && u.behavior === 'advance' && u.fortId === null);
    expect(troops.length).toBeGreaterThan(3);
    const off = troops.map((u) => lineOffset(u.pos, line.a, line.b, hq));
    expect(off.filter((o) => o.d <= 80).length / off.length).toBeGreaterThan(0.9);
    expect(off.every((o) => o.ahead <= 80)).toBe(true);
  }, 120_000);

  it('a new manual order ends a recall of that front; a recall keeps the order and line and restores the objective', () => {
    const { world } = setup(60);
    const f = world.factions[1];
    const s = f.fronts[0];
    const hq = world.hqPos(1);
    const p = world.nav(false, 35).nearestPassable({ x: hq.x + (s.front.x - hq.x) * 0.5, z: hq.z + (s.front.z - hq.z) * 0.5 }, 60)!;
    issueFrontOrder(world, f, s, order(world, 'defend', p));
    const line = s.line!;
    const target = { ...s.targetPos };
    const ht = f.command.homeThreat;
    ht.recall = [s.id];
    thinkFronts(world, f);
    expect(s.reason).toBe('reason.homeDefence');
    expect(s.order.kind).toBe('defend');
    expect(s.line).toBe(line);
    ht.recall = [];
    thinkFronts(world, f);
    expect(s.reason).toBe('reason.order.defend');
    expect(dist(s.targetPos, target)).toBeLessThan(1);
    expect(s.line).toBe(line);
    // A fresh order while recalled: it leaves the recall at once.
    ht.recall = [s.id];
    thinkFronts(world, f);
    issueFrontOrder(world, f, s, order(world, 'attack', world.hqPos(2)));
    expect(ht.recall).not.toContain(s.id);
  });

  it('allows 8 fronts, plans fronts without units, and opens a player front with newFront', () => {
    const match = setup(60, false);
    const { world } = match;
    const ai = world.factions[1];
    ai.p = 1e6;
    const max = world.data.rules.command.fronts_max;
    expect(max).toBe(8);
    const objs = world.objectives.filter((o) => o.owner !== ai.id);
    let k = 0;
    while (ai.fronts.length < max) expect(createFront(world, ai, objs[k++ % objs.length], 0)).not.toBeNull();
    expect(createFront(world, ai, objs[0], 0)).toBeNull();
    // Fronts with no troops (only a commander) plan without errors.
    thinkFronts(world, ai);
    ai.command.nextAt = 0;
    thinkHighCommand(world, ai);
    expect(frontIdsValid(world)).toBe(true);
    // Player: newFront appoints a commander, adopts nearby free troops and holds the point.
    const f = world.factions[0];
    f.p = 10_000;
    const s0 = f.fronts[0];
    const own = lineTroops(world, 0, s0.id).filter(transferable);
    expect(own.length).toBeGreaterThan(0);
    const at = world.nav(false, 35).nearestPassable(own[0].pos, 30)!;
    const bus = new CommandBus();
    bus.issue(match, 0, { type: 'newFront', a: at });
    bus.flush(match);
    const s = f.fronts[f.fronts.length - 1];
    expect(s.id).not.toBe(s0.id);
    expect(world.unitAlive(s.commanderId)?.frontId).toBe(s.id);
    expect(s.order).toMatchObject({ kind: 'defend', manual: true });
    expect(s.posture).toBe('hold');
    expect(frontUnits(world, 0, s.id).filter((u) => !isCommander(u.def)).length).toBeGreaterThan(0);
    run(match, 4);
    const line = s.line!;
    const slots = Object.values(s.slots);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.filter((q) => lineOffset(q, line.a, line.b, world.hqPos(0)).d < 80).length / slots.length).toBeGreaterThan(0.8);
  }, 60_000);

  it('opens a garrison front for a finished fortified zone nobody holds', () => {
    const match = setup(60);
    const { world } = match;
    const f = world.factions[1];
    f.p = 1e6;
    const hq = world.hqPos(1);
    const ex = world.cityOf(1).exit;
    const dir = headingTo(hq, ex);
    const c = world.nav(false, 35).nearestPassable({ x: hq.x + Math.cos(dir) * 500, z: hq.z + Math.sin(dir) * 500 }, 80)!;
    const along = dir + Math.PI / 2;
    const a = { x: c.x + Math.cos(along) * 120, z: c.z + Math.sin(along) * 120 };
    const b = { x: c.x - Math.cos(along) * 120, z: c.z - Math.sin(along) * 120 };
    const zone: Zone = { id: f.zoneSeq++, a, b, frontId: null, createdAt: world.time, cancelled: false };
    f.zones = [...f.zones, zone];
    world.forts.push({ id: world.newId(), owner: 1, kind: 'pillbox', pos: { ...c }, facing: dir, hp: 2000, maxHp: 2000, progress: 1, occupant: null, capacity: 1, occupants: [] });
    let s: Front | undefined;
    for (let t = 0; t < 120 && !s; t += 5) {
      run(match, 5);
      s = f.fronts.find((x) => garrisonsZone(x));
    }
    expect(s).toBeDefined();
    expect(zone.frontId).toBe(s!.id);
    expect(s!.order).toMatchObject({ kind: 'defend', manual: true });
    expect(dist(s!.line!.a, a) + dist(s!.line!.b, b)).toBeLessThan(1);
    expect(world.unitAlive(s!.commanderId)).toBeTruthy();
    expect(frontUnits(world, 1, s!.id).filter((u) => !isCommander(u.def)).length).toBeGreaterThan(0);
    // Later passes do not open another front for the same zone.
    run(match, 60);
    expect(f.fronts.filter((x) => garrisonsZone(x)).length).toBe(1);
  }, 60_000);
});
