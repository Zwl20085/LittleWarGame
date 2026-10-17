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
import type { V2 } from '../src/sim/vec';
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
