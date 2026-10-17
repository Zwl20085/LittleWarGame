import { beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import type { TransportRules } from '../src/data/types';
import { moveTo, updateMovement } from '../src/sim/movement';
import { railRoute, railSecond, railTick } from '../src/sim/rail';
import { RoadNet } from '../src/sim/roadnet';
import { CommandBus, type CommandOutcome, type Command } from '../src/sim/commands';
import { createMatch, type Match } from '../src/sim/sim';
import { Ground } from '../src/sim/terrain';
import { groundMul, moveClassOf, transportRules } from '../src/sim/transport';
import { completeJob, needRoadLinks, roadSegmentOk, startRailRepair, startRoadJob, thinkTransport, transportSecond } from '../src/sim/transportjobs';
import type { Unit } from '../src/sim/types';
import { dist, type V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

const data = loadGameData();
const T = transportRules(data.rules) as TransportRules;

describe('3.0 transport: road graph', () => {
  it('finds crossings, T-junctions and road ends with edge lengths', () => {
    // A cross (two roads crossing at 500,500) and a spur ending on the horizontal road at 800,500.
    const roads: V2[][] = [
      [{ x: 0, z: 500 }, { x: 1000, z: 500 }],
      [{ x: 500, z: 0 }, { x: 500, z: 1000 }],
      [{ x: 800, z: 900 }, { x: 800, z: 505 }],
    ];
    const net = RoadNet.build(roads);
    const centre = net.nearestNode({ x: 500, z: 500 }, 5)!;
    expect(centre.kind).toBe('junction');
    expect(centre.edges.length).toBe(4);
    const tee = net.nearestNode({ x: 800, z: 500 }, 10)!;
    expect(tee.edges.length).toBe(3);
    expect(net.junctions().length).toBe(2);
    const west = net.nearestNode({ x: 0, z: 500 }, 1)!;
    const east = net.nearestNode({ x: 1000, z: 500 }, 1)!;
    expect(net.roadDistance(west.id, east.id)).toBeCloseTo(1000, 0);
    const total = net.edges.reduce((s, e) => s + e.len, 0);
    expect(total).toBeCloseTo(1000 + 1000 + 395, -1);
    // An engineer road joins a far point to the net.
    const far = { x: 1300, z: 500 };
    net.addSegment({ x: 1000, z: 500 }, far);
    expect(net.roadDistance(west.id, net.nearestNode(far, 1)!.id)).toBeCloseTo(1300, 0);
    expect(new Set(net.components()).size).toBe(1);
  });
});

describe('3.0 transport: off-road multipliers', () => {
  it('moves every class at on_road on roads and town streets, slower off road, stacked with terrain', () => {
    expect(T.enabled).toBe(true);
    for (const cls of ['tracked', 'wheeled', 'infantry', 'towed'] as const) {
      expect(groundMul(T, Ground.Road, cls)).toBe(T.on_road);
      expect(groundMul(T, Ground.Open, cls)).toBe(T.off_road[cls]);
    }
    expect(T.off_road).toEqual({ tracked: 0.6, wheeled: 0.55, infantry: 0.75, towed: 0.5 });
    // Forest stacks the 2.2 forest factor with the off-road factor.
    expect(groundMul(T, Ground.Forest, 'tracked')).toBeCloseTo(0.55 * 0.6);
    expect(groundMul(T, Ground.Forest, 'infantry')).toBeCloseTo(0.85 * 0.75);
    expect(moveClassOf(T, data.units.get('medium_tank')!)).toBe('tracked');
    expect(moveClassOf(T, data.units.get('supply_truck')!)).toBe('wheeled');
    expect(moveClassOf(T, data.units.get('infantry')!)).toBe('infantry');
    expect(moveClassOf(T, data.units.get('at_gun')!)).toBe('towed');
    expect(moveClassOf(T, data.units.get('mg')!)).toBe('infantry');
    // Switched off: the 2.2 table (roads 1.05 foot / 1.35 vehicles, open 1).
    expect(groundMul(null, Ground.Road, 'tracked')).toBe(1.35);
    expect(groundMul(null, Ground.Road, 'infantry')).toBe(1.05);
    expect(groundMul(null, Ground.Open, 'wheeled')).toBe(1);
  });
});

/** The longest generated line between two settlements (not touching a capital), or the longest line. */
function pickLine(w: World): number {
  const st = w.transport!;
  const lines = [...st.lines].sort((a, b) => b.len - a.len || a.id - b.id);
  return (lines.find((l) => st.stations[l.a].placeIdx >= 0 && st.stations[l.b].placeIdx >= 0 && l.len > 700) ?? lines[0]).id;
}

/** Hold both stations of a line for faction f (and refresh rail state at a check tick). */
function holdLine(w: World, lineId: number, f: number): void {
  const st = w.transport!;
  const line = st.lines[lineId];
  for (const sid of [line.a, line.b]) {
    const pi = st.stations[sid].placeIdx;
    if (pi >= 0) w.objectives[pi].owner = f;
  }
  w.tick = Math.ceil(w.tick / 40 + 1) * 40;
  railSecond(w, null);
}

/** Ride scenario without the AI: three squads at one station ordered to the other end of a line. */
function ride(match: Match): { boarded: number; end: V2[]; trains: number } {
  const w = match.world;
  const id = pickLine(w);
  holdLine(w, id, 0);
  const st = w.transport!;
  const line = st.lines[id];
  const from = st.stations[line.a].pos;
  const to = st.stations[line.b].pos;
  const squads: Unit[] = [0, 1, 2].map((k) => w.spawnUnit(0, 'infantry', w.nav(false, 35).nearestPassable({ x: from.x + k * 6, z: from.z }, 40) ?? from, 0));
  for (const u of squads) moveTo(w, u, to, true);
  const boarded = new Set<number>();
  let trains = 0;
  for (let t = 0; t < 20 * 240; t++) {
    for (const u of squads) updateMovement(w, u);
    railTick(w);
    trains = Math.max(trains, st.trains.length);
    for (const u of squads) if (u.rail?.stage === 'aboard') boarded.add(u.id);
    w.tick++;
    if (w.tick % 20 === 0) railSecond(w, null);
  }
  return { boarded: boarded.size, end: squads.map((u) => ({ ...u.pos })), trains };
}

describe('3.0 transport: railways and engineer jobs', () => {
  let match: Match;
  beforeAll(() => {
    match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
  }, 120_000);

  it('generates stations and lines, and a line runs trains only while one faction holds all of it; a lost station cuts it', () => {
    const w = match.world;
    const st = w.transport!;
    expect(st.stations.length).toBeGreaterThanOrEqual(w.factions.length * 2);
    expect(st.lines.length).toBeGreaterThanOrEqual(w.factions.length);
    // Every capital has a station with a line.
    for (const f of w.factions) expect(st.stations.some((s) => s.placeIdx === -1 - f.cityIdx && s.lines.length > 0)).toBe(true);
    const id = pickLine(w);
    holdLine(w, id, 1);
    const line = st.lines[id];
    expect(line.owner).toBe(1);
    expect(railRoute(w, 1, line.a, line.b)?.lines).toEqual([id]);
    expect(railRoute(w, 2, line.a, line.b)).toBeNull();
    // An enemy takes one station: cut, and it stays cut after the holder takes it back.
    const pa = st.stations[line.a].placeIdx;
    const pb = st.stations[line.b].placeIdx;
    const lost = pb >= 0 ? pb : pa;
    w.objectives[lost].owner = 2;
    w.tick += 40;
    railSecond(w, null);
    expect(line.cut).toBe(true);
    expect(line.owner).toBe(-1);
    w.objectives[lost].owner = 1;
    w.tick += 40;
    railSecond(w, null);
    expect(line.owner).toBe(-1);
    // Engineers rebuild the track (the job costs P/M; give the faction the means).
    w.factions[1].p = 1e5;
    w.factions[1].m = 1e5;
    const job = startRailRepair(w, 1, id);
    expect(job.ok).toBe(true);
    if (job.ok) completeJob(w, job.job);
    w.tick += 40;
    railSecond(w, null);
    expect(line.cut).toBe(false);
    expect(line.owner).toBe(1);
  });

  it('lays an engineer road: paints Ground.Road, refreshes navigation and joins the road graph', () => {
    const w = match.world;
    const st = w.transport!;
    // Find a clear 300 m stretch of open ground near faction 0's capital.
    const hq = w.hqPos(0);
    let a: V2 | null = null;
    let b: V2 | null = null;
    for (let k = 0; k < 64 && !a; k++) {
      const ang = (k / 64) * Math.PI * 2;
      const p = { x: hq.x + Math.cos(ang) * 450, z: hq.z + Math.sin(ang) * 450 };
      const q = { x: p.x + Math.cos(ang + 1.3) * 300, z: p.z + Math.sin(ang + 1.3) * 300 };
      const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
      if (roadSegmentOk(w, p, q).ok && w.terrain.groundAt(mid.x, mid.z) === Ground.Open) { a = p; b = q; }
    }
    expect(a).not.toBeNull();
    const mid = { x: (a!.x + b!.x) / 2, z: (a!.z + b!.z) / 2 };
    const nav = w.nav(true, 15);
    const k = Math.round(mid.z / nav.cell) * nav.nx + Math.round(mid.x / nav.cell);
    const before = nav.cost[k];
    w.factions[0].m = 1e5;
    const edges = st.roads.edges.length;
    const job = startRoadJob(w, 0, a!, b!);
    expect(job.ok).toBe(true);
    if (!job.ok) return;
    // An engineer is assigned by the once-a-second transport pass.
    w.spawnUnit(0, 'engineer', a!, 0);
    transportSecond(w);
    expect(job.job.worker).toBeGreaterThan(0);
    completeJob(w, job.job);
    expect(w.terrain.groundAt(mid.x, mid.z)).toBe(Ground.Road);
    expect(nav.cost[k]).toBeGreaterThan(0);
    expect(nav.cost[k]).toBeLessThan(before);
    expect(st.roads.edges.length).toBe(edges + 1);
    expect(st.builtRoads.length).toBe(1);
    expect(st.jobs.length).toBe(0);
    // Generated roads reach every settlement from the capital: nothing to link at the start.
    expect(needRoadLinks(w, 0)).toEqual([]);
  });

  it('extraSites (unlinked zones) become a road job from the capital net', () => {
    const w = match.world;
    const st = w.transport!;
    const hq = w.hqPos(1);
    let site: V2 | null = null;
    for (let rad = 300; rad <= 900 && !site; rad += 50) for (let k = 0; k < 64 && !site; k++) {
      const ang = (k / 64) * Math.PI * 2;
      const q = { x: hq.x + Math.cos(ang) * rad, z: hq.z + Math.sin(ang) * rad };
      if (st.roads.nodes.every((n) => dist(n.pos, q) > 170) && st.roads.nearestNode(q, 550)) site = q;
    }
    expect(site).not.toBeNull();
    expect(needRoadLinks(w, 1)).toEqual([]);
    const want = needRoadLinks(w, 1, [site!]);
    expect(want).toHaveLength(1);
    expect(want[0].objIdx).toBe(-1);
    expect(dist(want[0].to, site!)).toBe(0);
    // thinkTransport lays it: an engineer and a stock are needed, the AI is not the player.
    const f = w.factions[1];
    expect(f.isPlayer).toBe(false);
    f.m = 1e5;
    w.spawnUnit(1, 'engineer', hq, 0);
    const jobs = st.jobs.length;
    thinkTransport(w, f, [site!]);
    expect(st.jobs.length).toBe(jobs + 1);
    expect(st.jobs[st.jobs.length - 1].owner).toBe(1);
  });

  // Seed 7 has city–city lines longer than rail.min_trip_m (seed 11's are all short capital spurs).
  it('boards, rides and unloads deterministically', () => {
    const second = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true });
    const third = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true });
    const r1 = ride(second);
    const r2 = ride(third);
    expect(r1.boarded).toBe(3);
    expect(r1.trains).toBeGreaterThanOrEqual(1);
    const w = second.world;
    const line = w.transport!.lines[pickLine(w)];
    const to = w.transport!.stations[line.b].pos;
    for (const p of r1.end) expect(dist(p, to)).toBeLessThan(80);
    expect(r2).toEqual(r1);
    expect(w.transport!.trains.length).toBe(0);
  }, 180_000);

  it('validates the engineer commands with structured failure reasons', () => {
    const w = match.world;
    const st = w.transport!;
    const bus = new CommandBus();
    const run = (actor: number, cmd: Command): CommandOutcome => {
      let out: CommandOutcome = { ok: true };
      bus.onResult = (_e, o) => { out = o; };
      bus.issue(match, actor, cmd);
      bus.flush(match);
      return out;
    };
    const hq = w.hqPos(0);
    w.factions[0].p = 1e5;
    w.factions[0].m = 1e5;
    // Too long, out of bounds, not a number.
    expect(run(0, { type: 'buildRoad', a: hq, b: { x: hq.x + (hq.x > w.terrain.width / 2 ? -700 : 700), z: hq.z } })).toEqual({ ok: false, reason: 'TOO_LONG' });
    expect(run(0, { type: 'buildRoad', a: hq, b: { x: -50, z: -50 } })).toEqual({ ok: false, reason: 'OUT_OF_BOUNDS' });
    expect(run(0, { type: 'buildRoad', a: hq, b: { x: NaN, z: 0 } })).toEqual({ ok: false, reason: 'BAD_VALUE' });
    // Rail: unknown / whole line, and a line that is not ours.
    expect(run(0, { type: 'repairRail', lineId: 9999 })).toEqual({ ok: false, reason: 'STALE_TARGET' });
    const whole = st.lines.find((l) => !l.cut)!;
    expect(run(0, { type: 'repairRail', lineId: whole.id })).toEqual({ ok: false, reason: 'NOT_CUT' });
    expect(run(0, { type: 'repairRail', lineId: 0.5 })).toEqual({ ok: false, reason: 'BAD_VALUE' });
    // A stretch of open ground is accepted and queues a job; a broke faction is refused.
    let a: V2 | null = null;
    let b: V2 | null = null;
    for (let k = 0; k < 64 && !a; k++) {
      const ang = (k / 64) * Math.PI * 2;
      const p = { x: hq.x + Math.cos(ang) * 600, z: hq.z + Math.sin(ang) * 600 };
      const q = { x: p.x + Math.cos(ang + 1.9) * 200, z: p.z + Math.sin(ang + 1.9) * 200 };
      if (roadSegmentOk(w, p, q).ok) { a = p; b = q; }
    }
    expect(a).not.toBeNull();
    w.factions[0].m = 0;
    expect(run(0, { type: 'buildRoad', a: a!, b: b! })).toEqual({ ok: false, reason: 'INSUFFICIENT_M' });
    w.factions[0].m = 1e5;
    const jobs = st.jobs.length;
    expect(run(0, { type: 'buildRoad', a: a!, b: b! })).toEqual({ ok: true });
    expect(st.jobs.length).toBe(jobs + 1);
    expect(run(2, { type: 'extendRail', stationIdx: 0, to: 0 }).ok).toBe(false);
  });
});
