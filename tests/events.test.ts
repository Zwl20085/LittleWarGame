import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { areaKey, battleRecords, finalizeBattleLog } from '../src/sim/events';

function run(seconds: number): ReturnType<typeof createMatch> {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
  for (let i = 0; i < seconds * match.world.tickHz; i++) {
    step(match);
    match.world.fx.length = 0;
  }
  return match;
}

describe('battle-event log', () => {
  it('records operations, directives and captures consistently, and is reproducible', () => {
    const a = run(150);
    const w = a.world;
    const log = w.battle;
    expect(log.ops.length).toBeGreaterThan(0);
    for (const op of log.ops) {
      expect(op.f).toBeGreaterThanOrEqual(0);
      expect(op.t0).toBeLessThanOrEqual(w.time);
      if (op.outcome !== 'open') expect(op.t1).toBeGreaterThanOrEqual(op.t0);
    }
    expect(log.directives.some((d) => d.kind === 'occupy' || d.kind === 'attack')).toBe(true);
    // Every recorded capture's new owner matches the latest capture of that place.
    const last = new Map<string, number>();
    for (const c of log.captures) last.set(c.obj, c.to);
    for (const [obj, to] of last) {
      const o = w.objectives.find((x) => x.id === obj)!;
      expect(o.owner).toBe(to);
    }
    // Settlement areas map to their objective id.
    const o = w.objectives[0];
    expect(areaKey(w, o.pos)).toBe(o.id);
    finalizeBattleLog(w);
    expect(log.activeOp.size).toBe(0);
    expect(log.openEng.size).toBe(0);
    const b = run(150);
    finalizeBattleLog(b.world);
    expect(JSON.stringify(battleRecords(b.world.battle))).toBe(JSON.stringify(battleRecords(log)));
  }, 300000);
});
