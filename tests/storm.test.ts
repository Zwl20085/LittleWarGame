import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { bombardPoint, capitalDefence, STORM, stormMass } from '../src/sim/storm';
import { navPost } from '../src/sim/crewai';
import { dist } from '../src/sim/vec';

/** Round 4: the attacker's forecast of a capital's defence and the bombard / post helpers. */
describe('capital siege-and-storm helpers (storm.ts, crewai.ts)', () => {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
  for (let i = 0; i < 20 * match.world.tickHz; i++) {
    step(match);
    match.world.fx.length = 0;
  }
  const world = match.world;

  it('counts the garrison and finished works of the capital', () => {
    const before = capitalDefence(world, 1, 0);
    expect(before).toBeGreaterThan(0);
    const hq = world.hqPos(0);
    world.forts.push({ id: world.newId(), owner: 0, kind: 'trench', pos: { x: hq.x + 100, z: hq.z }, facing: 0, start: { x: hq.x + 100, z: hq.z - 20 }, end: { x: hq.x + 100, z: hq.z + 20 }, length: 40, hp: 2600, maxHp: 2600, progress: 1, occupant: null });
    expect(capitalDefence(world, 1, 0)).toBeCloseTo(before + STORM.trenchValue, 5);
    expect(stormMass(world, 0, hq)).toBeGreaterThan(0);
  });

  it('deploys guns within range of the defenders, on the attacker side', () => {
    const hq = world.hqPos(0);
    const home = world.cityOf(1).exit;
    const p = bombardPoint(world, 1, hq, home, 330, 0.8);
    // Within range of the defenders' mass (itself within defenceR of the capital).
    expect(dist(p, hq)).toBeLessThan(330 * 0.8 + STORM.defenceR);
    expect(dist(p, home)).toBeLessThan(dist(hq, home));
  });

  it('picks guard / crew posts on the unit\'s own nav grid', () => {
    const gun = [...world.units.values()].find((u) => u.owner === 0 && u.def.kind === 'crew' && !u.fixed);
    if (!gun) return;
    const p = navPost(world, gun, world.hqPos(0));
    expect(world.navFor(gun).nearestPassable(p, 1)).not.toBeNull();
  });
});
