import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { moveTo, reachableDest, updateMovement } from '../src/sim/movement';
import { Ground } from '../src/sim/terrain';
import type { Unit } from '../src/sim/types';
import { dist, type V2 } from '../src/sim/vec';

/**
 * 2.2 pathing round (45-min soak stuck / unreachable anomalies): destinations validated against
 * the unit's own nav class, no spawn or goal inside a house, detour loops on steep banks, and
 * units boxed into a closed yard between two houses.
 */
describe('pathing: reachable destinations and stuck loops (seed 7 map)', () => {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
  const world = match.world;
  const t = world.terrain;

  /** Walk one unit on its own (no AI, no other units moving) for `seconds`. */
  function walk(u: Unit, dest: V2, seconds: number): void {
    moveTo(world, u, dest, true);
    for (let i = 0; i < seconds * world.tickHz; i++) {
      world.tick++;
      if (u.path.length === 0 && u.dest && dist(u.pos, u.dest) > 6 && i % world.tickHz === 0) moveTo(world, u, u.dest);
      updateMovement(world, u);
    }
  }

  it('never returns a point inside a house as the nearest passable point', () => {
    const nav = world.nav(false, 35);
    let checked = 0;
    for (const b of t.buildings.slice(0, 400)) {
      const q = nav.nearestPassable({ x: b.x, z: b.z }, 40);
      if (!q) continue;
      checked++;
      expect(t.buildingH(q.x, q.z)).toBe(0);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('labels regions consistently with the router', () => {
    const nav = world.nav(true, 22);
    const a = nav.nearestPassable(world.cityOf(0).exit, 40)!;
    const b = nav.nearestPassable(world.cityOf(1).exit, 40)!;
    expect(nav.regionAt(a)).toBeGreaterThan(0);
    if (nav.regionAt(a) === nav.regionAt(b)) expect(nav.connected(a, b)).toBe(true);
    // A water cell is in no region; a goal there snaps to the unit's own ground.
    let water: V2 | null = null;
    for (let z = 100; z < t.depth - 100 && !water; z += 16) for (let x = 100; x < t.width - 100 && !water; x += 16) if (t.groundAt(x, z) === Ground.Water && t.groundAt(x + 24, z) !== Ground.Water) water = { x, z };
    expect(water).not.toBeNull();
    expect(nav.regionAt(water!)).toBe(0);
    const truck = world.spawnUnit(0, 'supply_truck', a, world.factions[0].mainFront);
    const region = nav.regionFrom(truck.pos);
    const snapped = nav.reachableNear(water!, region, 48);
    if (snapped) {
      expect(nav.regionAt(snapped)).toBe(region);
      expect(dist(snapped, water!)).toBeLessThanOrEqual(48);
    }
    truck.hp = 0;
  });

  it('moves goals in another pocket onto the unit\'s connected ground', () => {
    const gun = world.spawnUnit(0, 'mortar', world.cityOf(0).exit, world.factions[0].mainFront);
    const nav = world.navFor(gun);
    const region = nav.regionFrom(gun.pos);
    // Any blocked cell near the exit: the destination must come back on the gun's region.
    for (let r = 40; r < 600; r += 24) {
      for (let a = 0; a < 16; a++) {
        const p = { x: gun.pos.x + Math.cos(a * 0.39) * r, z: gun.pos.z + Math.sin(a * 0.39) * r };
        if (!t.inBounds(p.x, p.z) || nav.regionAt(p) === region) continue;
        const d = reachableDest(world, gun, p);
        if (d !== p) expect(nav.regionAt(d)).toBe(region);
      }
    }
    gun.hp = 0;
  });

  it('walks out of a closed yard between two houses (seed 7 town, 1567,3099)', () => {
    const u = world.spawnUnit(0, 'infantry', { x: 1569, z: 3099 }, world.factions[0].mainFront);
    expect(t.buildingH(u.pos.x, u.pos.z)).toBe(0);
    const start = { ...u.pos };
    walk(u, { x: 1421, z: 2931 }, 90);
    expect(dist(u.pos, start)).toBeGreaterThan(40);
    u.hp = 0;
  });

  it('walks out of a yard on an open 8 m cell (seed 7, 2107,3247)', () => {
    const u = world.spawnUnit(0, 'infantry', { x: 2107, z: 3247 }, world.factions[0].mainFront);
    const start = { ...u.pos };
    walk(u, { x: 1550, z: 3184 }, 90);
    expect(dist(u.pos, start)).toBeGreaterThan(40);
    u.hp = 0;
  });

  it('turns round at a detour corner without drifting back into the wall (seed 7, 3118,2020)', () => {
    // The state the 2.2 soak caught: a detour corner north of the unit, then a leg south that
    // clips the corner of the house east of it by a few decimetres.
    const u = world.spawnUnit(0, 'infantry', { x: 3118.2, z: 2019.5 }, world.factions[0].mainFront);
    u.dest = { x: 3197, z: 1989 };
    u.path = [{ x: 3118, z: 2026 }, { x: 3120, z: 2008 }, { x: 3176, z: 2000 }, { x: 3192, z: 2000 }, { x: 3197, z: 1989 }];
    u.pathIdx = 0;
    u.heading = Math.PI / 2; // walking north, to the detour corner
    const start = { ...u.pos };
    for (let i = 0; i < 40 * world.tickHz; i++) {
      world.tick++;
      updateMovement(world, u);
    }
    expect(u.path.length).toBeLessThan(10);
    expect(dist(u.pos, start)).toBeGreaterThan(30);
    u.hp = 0;
  });

  it('finishes a detour round a steep bank instead of looping on it (seed 7, 2276,2215)', () => {
    const u = world.spawnUnit(0, 'infantry', { x: 2276, z: 2215.1 }, world.factions[0].mainFront);
    const start = { ...u.pos };
    walk(u, { x: 1881, z: 2548 }, 90);
    expect(u.path.length).toBeLessThan(60);
    expect(dist(u.pos, start)).toBeGreaterThan(60);
    u.hp = 0;
  });
});

describe('pathing: terrain islands (seed 11 map)', () => {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
  const world = match.world;

  it('closes a one-cell island joined only across a corner (supply trucks jammed in it)', () => {
    const nav = world.nav(true, 22);
    expect(nav.regionAt({ x: 608, z: 2104 })).toBe(0);
    expect(nav.walkableXZ(608, 2104)).toBe(false);
    // Its neighbour on the main ground stays open.
    expect(nav.regionAt({ x: 600, z: 2112 })).toBeGreaterThan(0);
  });

  it('routes a short hop across a stream the long way round instead of failing (mortar 50 m from its post)', () => {
    const u = world.spawnUnit(0, 'mortar', { x: 2206, z: 2833 }, world.factions[0].mainFront);
    moveTo(world, u, { x: 2239, z: 2871 }, true);
    expect(u.pathFailed).toBe(false);
    expect(u.path.length).toBeGreaterThan(0);
    const end = u.path[u.path.length - 1];
    expect(dist(end, { x: 2239, z: 2871 })).toBeLessThan(10);
    u.hp = 0;
  });

  it('gets a truck standing in the closed cell back onto open ground', () => {
    const u = world.spawnUnit(0, 'supply_truck', { x: 610, z: 2102 }, world.factions[0].mainFront);
    moveTo(world, u, { x: 441, z: 1476 }, true);
    const start = { ...u.pos };
    for (let i = 0; i < 40 * world.tickHz; i++) {
      world.tick++;
      if (u.path.length === 0 && u.dest && i % world.tickHz === 0) moveTo(world, u, u.dest);
      updateMovement(world, u);
    }
    expect(dist(u.pos, start)).toBeGreaterThan(60);
    u.hp = 0;
  });
});
