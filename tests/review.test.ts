import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadGameData } from '../src/data';
import { buildGameData } from '../src/data/loader';
import type { GameData } from '../src/data/types';
import { CommandBus, type Command, type CommandOutcome } from '../src/sim/commands';
import { freeHand } from '../src/sim/fortplans';
import { normalizedWeights } from '../src/sim/production';
import { createMatch, type Match } from '../src/sim/sim';
import { assignJob, dropJob } from '../src/sim/structures';
import { applyTransport, packTransport, TRAIN_STRIDE } from '../src/sim/transportsnap';
import type { EconZone } from '../src/sim/econZones';
import { fogFiltered, pointSeen } from '../src/sim/fogview';
import { makeSnapshot, type SnapshotCursor } from '../src/sim/snapshot';
import type { Train } from '../src/sim/transportstate';
import { completeJob, jobFront, needRoadLinks, roadSegmentOk, startRoadJob, thinkTransport, transportSecond } from '../src/sim/transportjobs';
import type { TransportJob } from '../src/sim/transportstate';
import type { ManualTask } from '../src/sim/types';
import { selectTarget } from '../src/sim/combat';
import { rearDeep, rearDepth } from '../src/sim/infiltration';
import { picketGap, picketSlots } from '../src/sim/pickets';
import { holdsLine } from '../src/sim/zoc';
import { dist, headingTo, type V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** Code-review fixes (WP-REV): one regression test per finding where a unit test is feasible. */

const data = loadGameData();
/** A manual order that takes a unit out of the automation. */
const HOLD: ManualTask = { type: 'hold', pos: { x: 0, z: 0 } };

/** A clear road stretch near faction f's capital (open ground, buildable). */
function roadSite(w: World, f: number): [V2, V2] {
  const hq = w.hqPos(f);
  for (let k = 0; k < 64; k++) {
    const ang = (k / 64) * Math.PI * 2;
    const p = { x: hq.x + Math.cos(ang) * 500, z: hq.z + Math.sin(ang) * 500 };
    const q = { x: p.x + Math.cos(ang + 1.3) * 250, z: p.z + Math.sin(ang + 1.3) * 250 };
    if (roadSegmentOk(w, p, q).ok) return [p, q];
  }
  throw new Error('no road site');
}

/** Advance the clock by whole seconds, running the once-a-second transport pass. */
function seconds(w: World, n: number): void {
  for (let s = 0; s < n; s++) {
    w.tick += w.tickHz;
    transportSecond(w);
  }
}

describe('review HIGH 1 / MED 7: engineer transport jobs', () => {
  let match: Match;
  beforeAll(() => {
    match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
  }, 120_000);

  it('one owner per engineer: a works builder is not taken for a road, a road worker is not a free hand', () => {
    const w = match.world;
    const f = w.factions[2];
    const [a, b] = roadSite(w, 2);
    f.m = 1e5;
    // The starting engineers are kept out of it (manual) so the test controls who is free.
    for (const u of w.units.values()) if (u.owner === 2 && u.def.id === 'engineer') u.manual = HOLD;
    const builder = w.spawnUnit(2, 'engineer', a, 0);
    assignJob(w, builder, { id: 987654 });
    const res = startRoadJob(w, 2, a, b);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    transportSecond(w);
    expect(res.job.worker).toBe(-1);
    const spare = w.spawnUnit(2, 'engineer', { x: a.x + 5, z: a.z }, 0);
    expect(freeHand(f, spare, w)).toBe(true);
    transportSecond(w);
    expect(res.job.worker).toBe(spare.id);
    expect(freeHand(f, spare, w)).toBe(false);
    dropJob(builder);
    builder.manual = HOLD;
  });

  it('a worker on a manual order for > 60 s is released and the job reassigned', () => {
    const w = match.world;
    const job = w.transport!.jobs.find((j) => j.owner === 2) as TransportJob;
    const first = w.units.get(job.worker)!;
    const other = w.spawnUnit(2, 'engineer', jobFront(job), 0);
    first.manual = HOLD;
    seconds(w, 30);
    expect(job.worker).toBe(first.id);
    seconds(w, 35);
    expect(job.worker).toBe(other.id);
    expect(w.log.some((e) => e.key === 'log.transportWorkerLost')).toBe(true);
  });

  it('a job dropped stale before any work is refunded and logged', () => {
    const w = match.world;
    const f = w.factions[3];
    const [a, b] = roadSite(w, 3);
    const start = w.data.rules.economy.cap_m;
    f.m = start;
    const res = startRoadJob(w, 3, a, b);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(f.m).toBeLessThan(start);
    w.tick += w.tickHz * 1000;
    transportSecond(w);
    expect(w.transport!.jobs.includes(res.job)).toBe(false);
    expect(f.m).toBeCloseTo(start, 3);
    expect(w.log.some((e) => e.key === 'log.transportJobDropped')).toBe(true);
  });
});

describe('review MED 12: pickets drop the vacated slot from coverage', () => {
  it('a point covered only by the squad that just left is filled by another picket', () => {
    const match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
    const w = match.world;
    const f = w.factions[0];
    const s = f.fronts[0];
    const r = w.data.rules.infiltration;
    const half = picketGap(r, 0) / 2;
    const nav = w.nav(false, 35);
    const hq = w.hqPos(0);
    // A spot well away from the capital with passable ground along the line on both sides.
    let p: V2 | null = null;
    let dir = { x: 1, z: 0 };
    for (let x = 400; x < w.terrain.width - 400 && !p; x += 100) for (let z = 400; z < w.terrain.depth - 400 && !p; z += 100) {
      const q = { x, z };
      if (dist(q, hq) < 900) continue;
      const along = headingTo(hq, q) + Math.PI / 2;
      const d = { x: Math.cos(along), z: Math.sin(along) };
      const ok = [-120, 0, 100, 600].every((k) => nav.passable({ x: q.x + d.x * k, z: q.z + d.z * k }));
      if (ok) { p = q; dir = d; }
    }
    expect(p).not.toBeNull();
    const pt = (k: number): V2 => ({ x: p!.x + dir.x * k, z: p!.z + dir.z * k });
    // Line far end first, then the near point (0.8 half-gap from the cluster's front squad).
    const far = pt(600);
    const near = pt(0.8 * half);
    const seg = [far, near];
    s.segment = seg;
    s.line = null;
    s.mode = 'hold';
    s.op = 'frontal';
    s.opPhase = '';
    s.tier = 0;
    // One squad at 0 and four at −0.9 half-gap: all redundant; the front one goes to the far point.
    const liners = [0, -0.9, -0.9, -0.9, -0.9].map((k) => w.spawnUnit(0, 'infantry', pt(k * half), s.id));
    const slots: Record<number, V2> = {};
    for (const u of liners) slots[u.id] = { ...u.pos };
    const out = picketSlots(w, f, s, liners, slots, seg, liners.length);
    const finals = liners.map((u) => out[u.id]);
    expect(Math.min(...finals.map((q) => dist(q, far)))).toBeLessThanOrEqual(half);
    expect(Math.min(...finals.map((q) => dist(q, near)))).toBeLessThanOrEqual(half);
  }, 120_000);
});

describe('review MED 4: train riders hold no line and are not targets', () => {
  it('holdsLine and selectTarget skip a unit aboard a train', () => {
    const match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
    const w = match.world;
    const nav = w.nav(false, 35);
    const p = nav.nearestPassable({ x: w.terrain.width / 2, z: w.terrain.depth / 2 }, 400)!;
    const shooter = w.spawnUnit(0, 'infantry', p, w.factions[0].fronts[0].id);
    const rider = w.spawnUnit(1, 'infantry', nav.nearestPassable({ x: p.x + 60, z: p.z }, 30) ?? { x: p.x + 60, z: p.z }, w.factions[1].fronts[0].id);
    rider.behavior = 'advance';
    expect(holdsLine(rider)).toBe(true);
    w.spatial.rebuild(w.aliveUnits);
    selectTarget(w, shooter, null);
    expect(shooter.targetId).toBe(rider.id);
    rider.rail = { stage: 'aboard', from: -1, to: -1, dest: { ...rider.pos }, trainId: -1, since: 0 };
    expect(holdsLine(rider)).toBe(false);
    shooter.targetSince = -1e9;
    selectTarget(w, shooter, null);
    expect(shooter.targetId).toBeNull();
  }, 120_000);
});

describe('review MED 6: AI road links try every candidate and remember failures', () => {
  it('a link that fails is skipped for 5 min and the next candidate is laid', () => {
    const match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
    const w = match.world;
    const st = w.transport!;
    const hq = w.hqPos(1);
    const sites: V2[] = [];
    for (let rad = 300; rad <= 900 && sites.length < 2; rad += 50) for (let k = 0; k < 64 && sites.length < 2; k++) {
      const ang = (k / 64) * Math.PI * 2;
      const q = { x: hq.x + Math.cos(ang) * rad, z: hq.z + Math.sin(ang) * rad };
      if (sites.some((s) => dist(s, q) < 400)) continue;
      if (!st.roads.nodes.every((n) => dist(n.pos, q) > 170) || !st.roads.nearestNode(q, 550)) continue;
      const want = needRoadLinks(w, 1, [q])[0];
      if (want && roadSegmentOk(w, want.from, want.to).ok) sites.push(q);
    }
    expect(sites).toHaveLength(2);
    const wants = needRoadLinks(w, 1, sites);
    expect(wants).toHaveLength(2);
    // Another faction's job already covers the first link: starting it fails (BUSY).
    w.factions[2].m = 1e5;
    const blocker = startRoadJob(w, 2, wants[0].from, wants[0].to);
    expect(blocker.ok).toBe(true);
    const f = w.factions[1];
    f.m = 1e5;
    w.spawnUnit(1, 'engineer', hq, 0);
    w.tick += w.tickHz * 10;
    thinkTransport(w, f, sites);
    const mine = st.jobs.filter((j) => j.owner === 1);
    expect(mine).toHaveLength(1);
    expect(dist(mine[0].b, wants[1].to)).toBeLessThan(1);
    // Both jobs gone: the failed site is still skipped on the next think.
    st.jobs.length = 0;
    w.tick += w.tickHz * 120;
    thinkTransport(w, f, sites);
    const again = st.jobs.filter((j) => j.owner === 1);
    expect(again).toHaveLength(1);
    expect(dist(again[0].b, wants[1].to)).toBeLessThan(1);
  }, 120_000);
});

describe('review MED 8: loader validates transport / econ_zones / capital_defence', () => {
  const unitsCsv = readFileSync('docs/data/units.csv', 'utf8');
  const weaponsCsv = readFileSync('docs/data/weapons.csv', 'utf8');
  const base = JSON.parse(readFileSync('docs/data/rules.json', 'utf8')) as Record<string, Record<string, unknown>>;
  const load = (patch: (r: Record<string, Record<string, unknown>>) => void): GameData => {
    const r = structuredClone(base);
    patch(r);
    return buildGameData(unitsCsv, weaponsCsv, JSON.stringify(r));
  };
  type Obj = Record<string, unknown>;

  it('accepts the shipped rules', () => {
    expect(() => load(() => undefined)).not.toThrow();
  });

  it('fails with the key name on bad transport values', () => {
    expect(() => load((r) => { (r.transport.class_of as Obj).train = 'hover'; })).toThrow(/transport\.class_of\.train/);
    expect(() => load((r) => { (r.transport.class_of as Obj).nobody = 'wheeled'; })).toThrow(/transport\.class_of\.nobody/);
    expect(() => load((r) => { (r.transport.off_road as Obj).boat = 0.5; })).toThrow(/transport\.off_road\.boat/);
    expect(() => load((r) => { delete (r.transport.off_road as Obj).towed; })).toThrow(/transport\.off_road\.towed/);
    expect(() => load((r) => { (r.transport.rail as Obj).capacity = 0; })).toThrow(/transport\.rail\.capacity/);
    expect(() => load((r) => { ((r.transport.rail as Obj).repair as Obj).work_seconds = -1; })).toThrow(/transport\.rail\.repair\.work_seconds/);
  });

  it('fails with the key name on bad econ_zones / capital_defence values', () => {
    expect(() => load((r) => { ((r.econ_zones.levels as Obj[])[1]).m_per_min_k = 'x'; })).toThrow(/econ_zones\.levels\[1\]\.m_per_min_k/);
    expect(() => load((r) => { ((r.econ_zones.levels as Obj[])[0]).p_per_min_k = -2; })).toThrow(/econ_zones\.levels\[0\]\.p_per_min_k/);
    expect(() => load((r) => { r.econ_zones.road_link_m = 0; })).toThrow(/econ_zones\.road_link_m/);
    expect(() => load((r) => { r.econ_zones.max_per_faction = 1.5; })).toThrow(/econ_zones\.max_per_faction/);
    expect(() => load((r) => { r.econ_zones.beaten_output = 2; })).toThrow(/econ_zones\.beaten_output/);
    expect(() => load((r) => { r.capital_defence.crew_respawn_seconds = 0; })).toThrow(/capital_defence\.crew_respawn_seconds/);
    expect(() => load((r) => { r.capital_defence.quiet_m = -5; })).toThrow(/capital_defence\.quiet_m/);
  });
});

describe('review MED 10: cached anchor grid gives the exact rear-depth answer', () => {
  it('rearDeep matches rearDepth >= depth everywhere, also after a settlement changes hands', () => {
    const match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'fog', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true });
    const w = match.world;
    const depth = w.data.rules.infiltration.report_depth_m;
    const check = (): void => {
      for (let x = 13; x < w.terrain.width; x += 37) for (let z = 7; z < w.terrain.depth; z += 41) {
        const p = { x, z };
        for (const f of w.factions) expect(rearDeep(w, f.id, p, depth)).toBe(rearDepth(w, f, p) >= depth);
      }
    };
    check();
    const o = w.objectives.find((x) => x.owner === 1)!;
    o.owner = 2;
    // Owners are checked once per tick (they only change between the sim's passes).
    w.tick += 1;
    check();
  }, 120_000);
});

describe('review MED 5: engineer roads and their bridges reach the main-thread mirror', () => {
  it('applyTransport paints the road, lays the bridge and joins the road graph like the worker', () => {
    const opts = { mapId: 'generated', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true } as const;
    const worker = createMatch(data, opts).world;
    const mirror = createMatch(data, opts).world;
    // A road across a short water gap (a bridge), else any buildable road.
    let seg: [V2, V2] | null = null;
    let bridged = false;
    for (let x = 300; x < worker.terrain.width - 300 && !bridged; x += 60) for (let z = 300; z < worker.terrain.depth - 300 && !bridged; z += 60) {
      for (let k = 0; k < 4 && !bridged; k++) {
        const a = { x, z };
        const b = { x: x + Math.cos((k * Math.PI) / 4) * 220, z: z + Math.sin((k * Math.PI) / 4) * 220 };
        const chk = roadSegmentOk(worker, a, b);
        if (!chk.ok) continue;
        if (!seg) seg = [a, b];
        if (chk.gaps.length > 0) { seg = [a, b]; bridged = true; }
      }
    }
    expect(seg).not.toBeNull();
    const [a, b] = seg!;
    worker.factions[0].m = 1e5;
    const res = startRoadJob(worker, 0, a, b);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    completeJob(worker, res.job);
    const cursor = { lastLog: null, frontVersion: -1, viewVersion: -1, statusIndex: new Map(), statusSent: 0, sent: 0, defIndex: null, transportVersion: -1 };
    const edges = mirror.transport!.roads.edges.length;
    const bridges = mirror.terrain.bridges.length;
    applyTransport(mirror, packTransport(worker, cursor)!);
    expect(Array.from(mirror.terrain.ground)).toEqual(Array.from(worker.terrain.ground));
    expect(mirror.terrain.bridges.length).toBe(worker.terrain.bridges.length);
    if (bridged) expect(mirror.terrain.bridges.length).toBeGreaterThan(bridges);
    expect(mirror.transport!.roads.edges.length).toBe(worker.transport!.roads.edges.length);
    expect(mirror.transport!.roads.edges.length).toBeGreaterThan(edges);
  }, 180_000);
});

describe('review HIGH 2: zones and trains respect the observer\'s fog', () => {
  const cursor = (): SnapshotCursor => ({ lastLog: null, frontVersion: -1, viewVersion: -1, statusIndex: new Map(), statusSent: 0, sent: 0, defIndex: null, transportVersion: -1 });

  it('an enemy zone is hidden until seen, then shown as last seen; enemy trains only in sight, without their load', () => {
    const match = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'fog', seed: 7, difficulty: 'normal', playerSlot: 0 });
    const w = match.world;
    expect(fogFiltered(w, 0)).toBe(true);
    // Far from everything of faction 0: the capital of faction 2.
    const far = w.hqPos(2);
    expect(pointSeen(w, 0, far)).toBe(false);
    const zone: EconZone = { id: 990001, kind: 'ezone1', pos: { ...far }, facing: 0, owner: 2, level: 1, target: 1, hp: 100, maxHp: 100, progress: 1, ruined: false, linked: true };
    w.econZones.push(zone);
    const cur = cursor();
    expect(makeSnapshot(match, cur, 0).econZones.some((z) => z.id === zone.id)).toBe(false);
    // A train of faction 2 there, loaded: not sent.
    const train = { id: 77, owner: 2, from: 0, to: 0, path: [], cum: [], len: 0, lines: [], state: 'running', s: 0, pos: { ...far }, prev: { ...far }, heading: 0, riders: [1, 2, 3], timer: 0 } as Train;
    w.transport!.trains.push(train);
    expect(makeSnapshot(match, cur, 0).transport!.trains.length / TRAIN_STRIDE).toBe(0);
    // A scout of faction 0 next to it: zone and train visible, the train's riders not.
    const scout = w.spawnUnit(0, 'infantry', { x: far.x + 20, z: far.z }, w.factions[0].fronts[0].id);
    const seen = makeSnapshot(match, cur, 0);
    expect(seen.econZones.find((z) => z.id === zone.id)?.level).toBe(1);
    const tr = seen.transport!.trains;
    expect(tr.length).toBe(TRAIN_STRIDE);
    expect(tr[7]).toBe(0);
    // The scout leaves; the zone is upgraded out of sight: the player still sees level 1.
    scout.hp = 0;
    w.aliveUnits.splice(w.aliveUnits.indexOf(scout), 1);
    zone.level = 3;
    const later = makeSnapshot(match, cur, 0);
    expect(later.econZones.find((z) => z.id === zone.id)?.level).toBe(1);
    expect(later.transport!.trains.length).toBe(0);
    // Open mode / spectators: everything.
    const spec = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'fog', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true });
    expect(fogFiltered(spec.world, 0)).toBe(false);
  }, 180_000);
});

describe('review MED 11: the main thread knows the open engineer jobs', () => {
  it('packTransport sends kind / line for every job and the worker only for the observer\'s own', () => {
    const opts = { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true } as const;
    const worker = createMatch(data, opts).world;
    const mirror = createMatch(data, opts).world;
    const st = worker.transport!;
    st.jobs.push(
      { id: 1, owner: 0, kind: 'rail', a: { x: 0, z: 0 }, b: { x: 1, z: 1 }, lineId: 3, fromStation: -1, toPlace: -1, workSeconds: 10, progress: 0, workedAt: 0, worker: 42, startedAt: 0 },
      { id: 2, owner: 1, kind: 'road', a: { x: 0, z: 0 }, b: { x: 1, z: 1 }, lineId: -1, fromStation: -1, toPlace: -1, workSeconds: 10, progress: 0, workedAt: 0, worker: 43, startedAt: 0 },
    );
    const cur = { lastLog: null, frontVersion: -1, viewVersion: -1, statusIndex: new Map(), statusSent: 0, sent: 0, defIndex: null, transportVersion: -1 };
    const snap = packTransport(worker, cur, 0)!;
    expect(snap.jobs).toEqual([
      { owner: 0, kind: 'rail', lineId: 3, worker: 42 },
      { owner: 1, kind: 'road', lineId: -1, worker: -1 },
    ]);
    applyTransport(mirror, snap);
    expect(mirror.transport!.jobView).toEqual(snap.jobs);
  }, 180_000);
});

/** Issue one command as `actor` and return its outcome. */
function runCommand(match: Match, actor: number, cmd: Command): CommandOutcome {
  const bus = new CommandBus();
  let out: CommandOutcome = { ok: true };
  bus.onResult = (_e, o) => { out = o; };
  bus.issue(match, actor, cmd);
  bus.flush(match);
  return out;
}

describe('review HIGH 3: production settings only for producible units', () => {
  it('setWeight / setCap / togglePause refuse the train and the commander; normalizedWeights ignores them', () => {
    const match = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0 });
    const w = match.world;
    const commander = w.data.rules.command.commander_unit;
    for (const id of ['train', commander]) {
      expect(runCommand(match, 0, { type: 'setWeight', unitId: id, weight: 5 })).toEqual({ ok: false, reason: 'BAD_VALUE' });
      expect(runCommand(match, 0, { type: 'setCap', unitId: id, cap: 3 })).toEqual({ ok: false, reason: 'BAD_VALUE' });
      expect(runCommand(match, 0, { type: 'togglePause', unitId: id })).toEqual({ ok: false, reason: 'BAD_VALUE' });
    }
    expect(runCommand(match, 0, { type: 'setWeight', unitId: 'infantry', weight: 2 })).toEqual({ ok: true });
    // A stale weight (old save / preset) on the train never takes a share.
    const f = w.factions[0];
    f.weights = { ...f.weights, train: 100 };
    const shares = normalizedWeights(w, f);
    expect(shares.has('train')).toBe(false);
    expect([...shares.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
  }, 120_000);
});
