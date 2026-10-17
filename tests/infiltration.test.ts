import { afterEach, describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step, type Match } from '../src/sim/sim';
import { speedOf } from '../src/sim/movement';
import { infiltrationReports, inRear, reportInfiltrators, updateInfiltration } from '../src/sim/infiltration';
import { picketGap, picketPoints, picketSlots, reactionGroup, segmentsByProximity } from '../src/sim/pickets';
import { holdsLine, INFILTRATION_AB, segmentsCross, updateZoc, type ZocContact } from '../src/sim/zoc';
import type { Front, Unit } from '../src/sim/types';
import { dist, headingTo, type V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** 3.0 sparse fronts (V30_SPEC §11): zone of control, line crossings, pickets, reaction group, rear screen and hunts. */
function setup(seconds: number): Match {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
  for (let i = 0; i < seconds * match.world.tickHz; i++) {
    step(match);
    match.world.fx.length = 0;
  }
  return match;
}

/** A passable point at least `clear` m from every unit and capital (nothing else interferes there). */
function emptySpot(world: World, clear = 700): V2 {
  const nav = world.nav(false, 35);
  for (let x = 300; x < world.terrain.width - 300; x += 100) {
    for (let z = 300; z < world.terrain.depth - 300; z += 100) {
      const p = { x, z };
      if (!nav.passable(p)) continue;
      if (world.factions.some((f) => dist(world.hqPos(f.id), p) < clear)) continue;
      if (world.aliveUnits.some((u) => dist(u.pos, p) < clear)) continue;
      // The neighbourhood must be passable too (the scenarios place units up to ±150 m around it).
      if ([[150, 0], [-150, 0], [0, 150], [0, -150]].every(([dx, dz]) => nav.passable({ x: x + dx, z: z + dz }))) return p;
    }
  }
  throw new Error('no empty spot');
}

function spawn(world: World, owner: number, id: string, p: V2, frontId?: number): Unit {
  const f = world.factions[owner];
  const at = world.nav(false, 35).nearestPassable(p, 30) ?? p;
  const u = world.spawnUnit(owner, id, at, frontId ?? f.fronts[0].id);
  u.behavior = 'advance';
  return u;
}

/** An intruder: a unit on a manual order (it holds no line of its own). */
function intruder(world: World, owner: number, p: V2): Unit {
  const u = spawn(world, owner, 'infantry', p);
  u.manual = { type: 'hold', pos: { ...u.pos } };
  return u;
}

const at = (p: V2, dx: number, dz: number): V2 => ({ x: p.x + dx, z: p.z + dz });

afterEach(() => {
  INFILTRATION_AB.on = true;
});

describe('zone of control (zoc.ts)', () => {
  it('slows an enemy within zoc_m of a line unit to half speed, reveals it, and leaves one farther out alone', () => {
    const { world } = setup(3);
    const r = world.data.rules.infiltration;
    const p = emptySpot(world);
    const h = spawn(world, 0, 'infantry', p);
    const m = intruder(world, 1, at(p, 120, 0));
    const far = intruder(world, 1, at(p, r.zoc_m + 120, 0));
    expect(holdsLine(h)).toBe(true);
    expect(holdsLine(m)).toBe(false);
    world.spatial.rebuild(world.aliveUnits);
    const before = speedOf(world, m, 0);
    const out: ZocContact[] = [];
    updateZoc(world, out);
    expect(m.zocUntil).toBeGreaterThan(world.time);
    expect(far.zocUntil).toBe(0);
    expect(speedOf(world, m, 0)).toBeCloseTo(before * r.zoc_speed_mul, 6);
    expect(world.visibleTo[0].has(m.id)).toBe(true);
    expect(out.some((c) => c.holder === h && c.intruder === m && !c.crossed)).toBe(true);
  });

  it('is off with the lab switch', () => {
    const match = setup(3);
    const { world } = match;
    const p = emptySpot(world);
    spawn(world, 0, 'infantry', p);
    const m = intruder(world, 1, at(p, 100, 0));
    world.spatial.rebuild(world.aliveUnits);
    INFILTRATION_AB.on = false;
    updateInfiltration(world, match.front);
    expect(m.zocUntil).toBe(0);
  });

  it('counts crossing the segment between two line units closer than contact_gap_m as a line crossing', () => {
    const { world } = setup(3);
    const p = emptySpot(world);
    spawn(world, 0, 'infantry', at(p, 0, -100));
    spawn(world, 0, 'infantry', at(p, 0, 100));
    const m = intruder(world, 1, at(p, -60, 0));
    const out: ZocContact[] = [];
    world.spatial.rebuild(world.aliveUnits);
    updateZoc(world, out);
    expect(out.some((c) => c.intruder === m && !c.crossed)).toBe(true);
    m.pos = at(p, 60, 0);
    world.spatial.rebuild(world.aliveUnits);
    updateZoc(world, out);
    expect(out.some((c) => c.intruder === m && c.crossed)).toBe(true);
    expect(segmentsCross(at(p, -1, 0), at(p, 1, 0), at(p, 0, -1), at(p, 0, 1))).toBe(true);
  });

  it('a gap wider than contact_gap_m is no line (no crossing)', () => {
    const { world } = setup(3);
    const p = emptySpot(world);
    spawn(world, 0, 'infantry', at(p, 0, -140));
    spawn(world, 0, 'infantry', at(p, 0, 140));
    const m = intruder(world, 1, at(p, -40, -40));
    const out: ZocContact[] = [];
    world.spatial.rebuild(world.aliveUnits);
    updateZoc(world, out);
    m.pos = at(p, 40, -40);
    world.spatial.rebuild(world.aliveUnits);
    updateZoc(world, out);
    expect(out.some((c) => c.intruder === m)).toBe(true);
    expect(out.some((c) => c.intruder === m && c.crossed)).toBe(false);
  });
});

/** A 1 km stretch of front line through `p`, square to the capital bearing, as angle-ordered 16 m cells. */
function stretch(world: World, s: Front, p: V2): V2[] {
  const hq = world.hqPos(0);
  const along = headingTo(hq, p) + Math.PI / 2;
  const seg: V2[] = [];
  for (let d = -500; d <= 500; d += 16) seg.push({ x: p.x + Math.cos(along) * d, z: p.z + Math.sin(along) * d });
  s.segment = seg;
  s.line = null;
  s.mode = 'hold';
  s.op = 'frontal';
  s.opPhase = '';
  s.reason = 'reason.holdFront';
  return seg;
}

/** 20 rifle squads and 4 motorized squads of front `s` bunched in the middle of the stretch. */
function bunch(world: World, s: Front, p: V2): { liners: Unit[]; slots: Record<number, V2> } {
  const liners: Unit[] = [];
  const slots: Record<number, V2> = {};
  for (let i = 0; i < 24; i++) {
    const u = spawn(world, 0, i < 20 ? 'infantry' : 'motor_inf', at(p, (i % 6) * 10 - 25, Math.floor(i / 6) * 10 - 15), s.id);
    liners.push(u);
    slots[u.id] = { ...u.pos };
  }
  return { liners, slots };
}

describe('pickets and the reaction group (pickets.ts)', () => {
  it('spreads spare infantry so no stretch of the line is more than half a picket gap from a slot', () => {
    const { world } = setup(3);
    const r = world.data.rules.infiltration;
    const f = world.factions[0];
    const s = f.fronts[0];
    const p = emptySpot(world, 900);
    const seg = stretch(world, s, p);
    s.tier = 0;
    const { liners, slots } = bunch(world, s, p);
    const out = picketSlots(world, f, s, liners, slots, seg, liners.length);
    expect(out).not.toBe(slots);
    const group = new Set(reactionGroup(s));
    const line = liners.filter((u) => !group.has(u.id)).map((u) => out[u.id]);
    const worst = Math.max(...seg.map((c) => Math.min(...line.map((q) => dist(c, q)))));
    expect(worst).toBeLessThanOrEqual(picketGap(r, 0) / 2 + r.picket_lean_m + 30);
    const moved = liners.filter((u) => !group.has(u.id) && dist(out[u.id], slots[u.id]) > 1).length;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(Math.floor(20 * r.picket_max_share));
    // Picket points never further apart than the gap (by tier).
    const pts = picketPoints(seg, picketGap(r, 3));
    for (let i = 1; i < pts.length; i++) expect(dist(pts[i - 1], pts[i])).toBeLessThanOrEqual(picketGap(r, 3) + 16);
    expect(picketGap(r, 3)).toBeLessThan(picketGap(r, 0));
  });

  it('keeps a motorized reaction group of reaction_share behind the middle of the line', () => {
    const { world } = setup(3);
    const r = world.data.rules.infiltration;
    const f = world.factions[0];
    const s = f.fronts[0];
    const p = emptySpot(world, 900);
    const seg = stretch(world, s, p);
    const { liners, slots } = bunch(world, s, p);
    const out = picketSlots(world, f, s, liners, slots, seg, liners.length);
    const group = reactionGroup(s);
    expect(group.length).toBe(Math.min(r.reaction_max_units, Math.round(24 * r.reaction_share)));
    const hq = world.hqPos(0);
    const mid = seg[Math.floor(seg.length / 2)];
    for (const id of group) {
      expect(world.units.get(id)!.def.id).toBe('motor_inf');
      expect(Math.abs(dist(out[id], mid) - r.reaction_back_m)).toBeLessThan(60);
      expect(dist(out[id], hq)).toBeLessThan(dist(mid, hq));
    }
    // A pushing front keeps its tanks and motorized troops with the attack.
    s.mode = 'push';
    picketSlots(world, f, s, liners, slots, seg, liners.length);
    expect(reactionGroup(s).length).toBe(0);
  });

  it('assigns each front the stretch of front cells nearest its own line', () => {
    const { world } = setup(3);
    const f = world.factions[0];
    expect(f.fronts.length).toBeGreaterThan(1);
    const [a, b] = f.fronts;
    a.front = { x: 1000, z: 1000 };
    b.front = { x: 3000, z: 1000 };
    for (const s of f.fronts.slice(2)) s.front = { x: 2000, z: 3500 };
    const cells = [{ x: 1100, z: 1000 }, { x: 2900, z: 1000 }, { x: 1200, z: 1100 }];
    const segs = segmentsByProximity(world, f, cells)!;
    expect(segs[0]).toEqual([cells[0], cells[2]]);
    expect(segs[1]).toEqual([cells[1]]);
  });

  it('sends the reaction group at an intruder that crosses the line', () => {
    const match = setup(3);
    const { world } = match;
    const f = world.factions[0];
    const s = f.fronts[0];
    const p = emptySpot(world, 900);
    const seg = stretch(world, s, p);
    const { liners, slots } = bunch(world, s, p);
    picketSlots(world, f, s, liners, slots, seg, liners.length);
    const group = reactionGroup(s).map((id) => world.units.get(id)!);
    expect(group.length).toBeGreaterThan(0);
    const q = at(p, 0, 400);
    spawn(world, 0, 'infantry', at(q, 0, -100), s.id);
    spawn(world, 0, 'infantry', at(q, 0, 100), s.id);
    const m = intruder(world, 1, at(q, -60, 0));
    world.spatial.rebuild(world.aliveUnits);
    updateInfiltration(world, match.front);
    m.pos = at(q, 60, 0);
    world.spatial.rebuild(world.aliveUnits);
    updateInfiltration(world, match.front);
    expect(infiltrationReports(f).some((rep) => rep.crossed)).toBe(true);
    for (const u of group) expect(u.opRole).toBe('hunt');
    const before = Math.min(...group.map((u) => dist(u.pos, m.pos)));
    for (let i = 0; i < 15 * world.tickHz; i++) step(match);
    const alive = group.filter((u) => u.hp > 0);
    expect(m.hp <= 0 || Math.min(...alive.map((u) => dist(u.pos, m.pos))) < before - 20).toBe(true);
  });
});

describe('rear screen and hunt (infiltration.ts)', () => {
  /** Own ground 450–800 m from faction 0's capital, away from the map edge. */
  function ownRearSpot(match: Match): V2 {
    const world = match.world;
    const hq = world.hqPos(0);
    const nav = world.nav(false, 35);
    for (let d = 450; d <= 800; d += 50) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const p = { x: hq.x + Math.cos(a) * d, z: hq.z + Math.sin(a) * d };
        if (world.terrain.inBounds(p.x, p.z) && nav.passable(p) && inRear(world, match.front, world.factions[0], p)) return p;
      }
    }
    throw new Error('no own rear ground');
  }

  it('reports infiltrators in its rear, logs the alert, screens the nearest places and hunts them', () => {
    const match = setup(60);
    const { world } = match;
    const r = world.data.rules.infiltration;
    const f = world.factions[0];
    const p = ownRearSpot(match);
    const home = headingTo(p, world.hqPos(0));
    const squads = [0, 1, 2, 3].map((i) => intruder(world, 1, at(p, Math.cos(home) * i * 12, Math.sin(home) * i * 12)));
    expect(squads.every((u) => inRear(world, match.front, f, u.pos))).toBe(true);
    world.spatial.rebuild(world.aliveUnits);
    reportInfiltrators(world, match.front);
    const rep = infiltrationReports(f).find((x) => x.noted);
    expect(rep).toBeDefined();
    expect(rep!.value).toBeGreaterThanOrEqual(r.report_min_value);
    expect(squads.every((u) => rep!.ids.includes(u.id))).toBe(true);
    const log = world.log.find((l) => l.key === 'log.infiltrator' && l.faction === 0);
    expect(log?.severity).toBe('alert');
    expect(typeof log?.params.x).toBe('number');
    const mine = world.aliveUnits.filter((u) => u.owner === 0);
    const hunters = mine.filter((u) => u.opRole === 'hunt');
    const screens = mine.filter((u) => u.opRole === 'screen');
    expect(hunters.length).toBeGreaterThan(0);
    expect(screens.length).toBeGreaterThan(0);
    expect(screens.every((u) => u.def.kind === 'infantry')).toBe(true);
    const combat = mine.filter((u) => !u.fixed && u.def.id !== 'supply_truck' && u.def.id !== 'commander').length;
    expect(hunters.length + screens.length).toBeLessThanOrEqual(Math.floor(combat * r.response_max_share));
    // Hunters close in on the infiltrators.
    const before = Math.min(...hunters.map((u) => dist(u.pos, p)));
    for (let i = 0; i < 20 * world.tickHz; i++) step(match);
    const still = hunters.filter((u) => u.hp > 0 && u.opRole === 'hunt');
    expect(still.length).toBeGreaterThan(0);
    expect(Math.min(...still.map((u) => dist(u.pos, p)))).toBeLessThan(before);
  });

  it('ignores enemies at the line (not in the rear) and its own units', () => {
    const match = setup(60);
    const { world } = match;
    const f = world.factions[0];
    const p = ownRearSpot(match);
    intruder(world, 0, p);
    world.spatial.rebuild(world.aliveUnits);
    reportInfiltrators(world, match.front);
    expect(infiltrationReports(f).length).toBe(0);
    const enemyHq = world.hqPos(1);
    expect(inRear(world, match.front, f, enemyHq)).toBe(false);
  });
});
