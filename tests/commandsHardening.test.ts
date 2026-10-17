import { beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { CommandBus, type Command, type CommandOutcome } from '../src/sim/commands';
import { createMatch, type Match } from '../src/sim/sim';
import { roadSegmentOk } from '../src/sim/transportjobs';
import type { V2 } from '../src/sim/vec';

const data = loadGameData();
let match: Match;
let bus: CommandBus;

const run = (cmd: Command, actor = 0): CommandOutcome => {
  let out: CommandOutcome = { ok: true };
  bus.onResult = (_e, o) => { out = o; };
  bus.issue(match, actor, cmd);
  bus.flush(match);
  return out;
};
const bad = (cmd: unknown, reason = 'BAD_VALUE'): void => {
  expect(run(cmd as Command)).toEqual({ ok: false, reason });
};

beforeAll(() => {
  match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
  bus = new CommandBus();
}, 120_000);

describe('WP-SEC: command validation (L10-L12)', () => {
  it('unitOrder validates ids, order and position', () => {
    const w = match.world;
    const mine = w.aliveUnits.filter((u) => u.owner === 0 && !u.fixed).slice(0, 3).map((u) => u.id);
    expect(mine.length).toBeGreaterThan(0);
    const pos = { x: w.terrain.width / 2, z: w.terrain.depth / 2 };
    expect(run({ type: 'unitOrder', unitIds: mine, order: 'move', pos })).toEqual({ ok: true });
    bad({ type: 'unitOrder', unitIds: 'abc', order: 'move', pos });
    bad({ type: 'unitOrder', unitIds: { length: 1, 0: 1 }, order: 'move', pos });
    bad({ type: 'unitOrder', unitIds: [1.5], order: 'move', pos });
    bad({ type: 'unitOrder', unitIds: [NaN], order: 'move', pos });
    bad({ type: 'unitOrder', unitIds: Array.from({ length: 65 }, (_, i) => i), order: 'move', pos });
    bad({ type: 'unitOrder', unitIds: mine, order: 'selfDestruct', pos });
    bad({ type: 'unitOrder', unitIds: mine, order: 'move', pos: { x: NaN, z: 0 } });
    bad({ type: 'unitOrder', unitIds: mine, order: 'move', pos: { x: 'a', z: 0 } });
    bad({ type: 'unitOrder', unitIds: mine, order: 'move', pos, queue: 'yes' });
    bad({ type: 'unitOrder', unitIds: mine, order: 'move', pos: { x: -1e9, z: 0 } }, 'OUT_OF_BOUNDS');
    expect(run({ type: 'unitOrder', unitIds: Array.from({ length: 64 }, () => 999999), order: 'hold' })).toEqual({ ok: false, reason: 'NOT_OWNER' });
  });

  it('focus validates ids and target', () => {
    bad({ type: 'focus', unitIds: 7, targetId: 1 });
    bad({ type: 'focus', unitIds: [1], targetId: 'x' });
    bad({ type: 'focus', unitIds: [1], targetId: 1.5 });
    bad({ type: 'focus', unitIds: Array.from({ length: 65 }, (_, i) => i), targetId: 1 });
  });

  it('setAlloc needs a finite 3-tuple', () => {
    const f = match.world.factions[0];
    expect(run({ type: 'setAlloc', alloc: [1, 1, 2] }).ok).toBe(true);
    expect(f.alloc[2]).toBeCloseTo(0.5, 9);
    bad({ type: 'setAlloc', alloc: [1, 1] });
    bad({ type: 'setAlloc', alloc: [1, 1, 1, 1] });
    bad({ type: 'setAlloc', alloc: 'abc' });
    bad({ type: 'setAlloc', alloc: ['1', 1, 1] });
    bad({ type: 'setAlloc', alloc: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE] }); // finite terms, infinite sum
    bad({ type: 'setAlloc', alloc: [0, 0, 0] });
    bad({ type: 'setAlloc', alloc: [NaN, 1, 1] });
  });

  it('setCap / togglePause need a known unit id', () => {
    const f = match.world.factions[0];
    const id = [...data.units.keys()][0];
    expect(run({ type: 'setCap', unitId: id, cap: 3 }).ok).toBe(true);
    expect(run({ type: 'togglePause', unitId: id }).ok).toBe(true);
    bad({ type: 'setCap', unitId: '__proto__', cap: 3 });
    bad({ type: 'setCap', unitId: 'nope', cap: 3 });
    bad({ type: 'togglePause', unitId: 'nope' });
    expect(Object.keys(f.caps)).not.toContain('nope');
    expect(Object.keys(f.paused)).not.toContain('nope');
  });

  it('setAuto / setAutoInvest / setLock.locked need booleans', () => {
    expect(run({ type: 'setAuto', on: false }).ok).toBe(true);
    expect(run({ type: 'setAutoInvest', on: true }).ok).toBe(true);
    expect(run({ type: 'setLock', index: 1, locked: true }).ok).toBe(true);
    bad({ type: 'setAuto', on: 'false' });
    bad({ type: 'setAuto', on: 1 });
    bad({ type: 'setAutoInvest', on: undefined });
    bad({ type: 'setAutoInvest', on: 'yes' });
    bad({ type: 'setLock', index: 1, locked: 'true' });
    bad({ type: 'setLock', index: 1, locked: 0 });
    bad({ type: 'setLock', index: 5, locked: true });
    expect(match.world.factions[0].autoEconomy).toBe(false);
  });

  it('bad rail indices are BAD_VALUE or STALE_TARGET, not TRANSPORT_OFF', () => {
    bad({ type: 'repairRail', lineId: -1 });
    bad({ type: 'repairRail', lineId: 'x' });
    bad({ type: 'repairRail', lineId: 123456 }, 'STALE_TARGET');
    bad({ type: 'extendRail', stationIdx: -1, to: 0 });
    bad({ type: 'extendRail', stationIdx: 0, to: NaN });
    bad({ type: 'extendRail', stationIdx: 99999, to: 0 }, 'STALE_TARGET');
    bad({ type: 'extendRail', stationIdx: 0, to: 99999 }, 'STALE_TARGET');
  });
});

describe('WP-SEC: engineer jobs are not stackable (M4)', () => {
  it('buildRoad returns JOB_BUSY for an overlapping in-flight road job', () => {
    const w = match.world;
    const hq = w.hqPos(0);
    w.factions[0].m = 1e6;
    let a: V2 | null = null;
    let b: V2 | null = null;
    for (let k = 0; k < 64 && !a; k++) {
      const ang = (k / 64) * Math.PI * 2;
      const p = { x: hq.x + Math.cos(ang) * 600, z: hq.z + Math.sin(ang) * 600 };
      const q = { x: p.x + Math.cos(ang + 1.9) * 200, z: p.z + Math.sin(ang + 1.9) * 200 };
      if (roadSegmentOk(w, p, q).ok) { a = p; b = q; }
    }
    expect(a).not.toBeNull();
    const jobs = w.transport!.jobs.length;
    expect(run({ type: 'buildRoad', a: a!, b: b! })).toEqual({ ok: true });
    expect(w.transport!.jobs.length).toBe(jobs + 1);
    // Same segment, reversed, and a start point 20 m from an endpoint: both overlap.
    expect(run({ type: 'buildRoad', a: b!, b: a! })).toEqual({ ok: false, reason: 'JOB_BUSY' });
    const nudged = { x: a!.x + 20, z: a!.z };
    expect(run({ type: 'buildRoad', a: nudged, b: b! })).toEqual({ ok: false, reason: 'JOB_BUSY' });
    expect(w.transport!.jobs.length).toBe(jobs + 1);
  });

  it('extendRail returns JOB_BUSY for the same objective or the same station', () => {
    const w = match.world;
    const st = w.transport!;
    const f0 = w.factions[0];
    f0.m = 1e6;
    f0.p = 1e6;
    const station = st.stations.find((s) => s.placeIdx === -1 - f0.cityIdx);
    expect(station).toBeTruthy();
    const towns = w.objectives
      .map((o, i) => ({ o, i }))
      .filter(({ o, i }) => (o.kind === 'town' || o.kind === 'city') && !st.stations.some((s) => s.placeIdx === i))
      .sort((p, q) => Math.hypot(p.o.pos.x - station!.pos.x, p.o.pos.z - station!.pos.z) - Math.hypot(q.o.pos.x - station!.pos.x, q.o.pos.z - station!.pos.z));
    expect(towns.length).toBeGreaterThan(1);
    const [t1, t2] = towns;
    t1.o.owner = 0;
    t2.o.owner = 0;
    const first = run({ type: 'extendRail', stationIdx: station!.id, to: t1.i });
    if (!first.ok) {
      // Out of range in this seed: the refusal must be a structured, non-busy one and the guard is moot.
      expect(first.reason).not.toBe('JOB_BUSY');
      return;
    }
    expect(run({ type: 'extendRail', stationIdx: station!.id, to: t1.i })).toEqual({ ok: false, reason: 'JOB_BUSY' });
    expect(run({ type: 'extendRail', stationIdx: station!.id, to: t2.i })).toEqual({ ok: false, reason: 'JOB_BUSY' });
  });
});
