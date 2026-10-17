import { beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { CommandBus, type Command, type CommandOutcome } from '../src/sim/commands';
import { freeHand } from '../src/sim/fortplans';
import { normalizedWeights } from '../src/sim/production';
import { createMatch, type Match } from '../src/sim/sim';
import { assignJob, dropJob } from '../src/sim/structures';
import { jobFront, roadSegmentOk, startRoadJob, transportSecond } from '../src/sim/transportjobs';
import type { TransportJob } from '../src/sim/transportstate';
import type { ManualTask } from '../src/sim/types';
import { picketGap, picketSlots } from '../src/sim/pickets';
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
