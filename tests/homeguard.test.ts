import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { thinkHighCommand } from '../src/sim/command';
import { HOME } from '../src/sim/homeguard';
import { angleDiff, dist, headingTo } from '../src/sim/vec';

/** Round 3 home defence: forecast → graded recall → fortification → stand-down (docs/STRATEGY_LAB.md). */
function setup(): ReturnType<typeof createMatch> {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
  for (let i = 0; i < 60 * match.world.tickHz; i++) {
    step(match);
    match.world.fx.length = 0;
  }
  return match;
}

describe('home defence (homeguard.ts)', () => {
  it('forecasts a raid on the capital, recalls in proportion, digs in, and stands down', () => {
    const { world } = setup();
    const f = world.factions[0];
    const hq = world.hqPos(0);
    const toward = headingTo(hq, world.cityOf(0).exit);
    const at = world.terrain.freeNear({ x: hq.x + Math.cos(toward) * 380, z: hq.z + Math.sin(toward) * 380 }, 60);
    const raid = Array.from({ length: 8 }, (_, i) => world.spawnUnit(1, i < 6 ? 'infantry' : 'medium_tank', { x: at.x + (i % 4) * 6, z: at.z + Math.floor(i / 4) * 6 }, 0));
    f.p = 5000;
    // Several HQ thinks (5 s cadence), without running the sim so the raiders stay put.
    for (let k = 0; k < 4; k++) {
      f.command.nextAt = 0;
      world.tick += Math.round((HOME.calmS / 6) * world.tickHz);
      thinkHighCommand(world, f);
    }
    const ht = f.command.homeThreat;
    expect(ht.enemy).toBeGreaterThan(0);
    expect(ht.level).toBeGreaterThan(0);
    expect(ht.eta).toBeGreaterThanOrEqual(0);
    expect(Math.abs(angleDiff(ht.bearing, headingTo(hq, at)))).toBeLessThan(0.6);
    expect(ht.active).toBe(true);
    // Proportional: guards or groups committed until home strength covers the forecast × overmatch,
    // and a raid of 8 units does not pull every army group home.
    const guards = [...world.units.values()].filter((u) => u.owner === 0 && u.opRole === 'garrison' && u.opObjective === 'hq:0');
    expect(guards.length + ht.recall.length).toBeGreaterThan(0);
    expect(ht.recall.length).toBeLessThan(f.fronts.length);
    // Works on the threatened approach, within the capital's works radius.
    expect(ht.fortify).toBe(true);
    const works = world.forts.filter((w) => w.owner === 0 && (w.kind === 'trench' || w.kind === 'sandbag') && dist(w.pos, hq) < HOME.worksRadiusM);
    expect(works.length).toBeGreaterThan(0);
    for (const w of works) expect(Math.abs(angleDiff(headingTo(hq, w.pos), ht.bearing))).toBeLessThan(1.2);
    // Threat gone: after the calm period the alarm ends and recalled groups are released.
    for (const u of raid) u.hp = 0;
    for (let k = 0; k < 20; k++) {
      f.command.nextAt = 0;
      world.tick += Math.round((HOME.calmS / 3) * world.tickHz);
      thinkHighCommand(world, f);
    }
    expect(ht.active).toBe(false);
    expect(ht.recall.length).toBe(0);
  });
});
