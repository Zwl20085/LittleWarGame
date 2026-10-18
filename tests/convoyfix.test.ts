import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { thinkConvoyTruck } from '../src/sim/convoy';
import { rearmDuty } from '../src/sim/settlements';
import type { Unit } from '../src/sim/types';
import { dist, type V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** 3.0 fix for the ammo-starved tank herd (docs/DEBUG_LAB.md). */
const data = loadGameData();
const L = data.rules.logistics!;

function setup(): World {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
  m.world.tick = 120 * m.world.tickHz;
  return m.world;
}

/** Passable spot ≥ `clear` m from every unit and ≥ `stockClear` m from every place. */
function spot(w: World, clear: number, stockClear: number): V2 {
  const nav = w.nav(true, 22);
  for (let x = 150; x < w.terrain.width - 150; x += 40) {
    for (let z = 150; z < w.terrain.depth - 150; z += 40) {
      const p = { x, z };
      if (nav.passable(p) && w.aliveUnits.every((u) => dist(u.pos, p) > clear) && w.places.every((q) => dist(q.pos, p) > stockClear) && dist(p, w.hqPos(0)) > 400) return p;
    }
  }
  throw new Error('no spot');
}

const front = (w: World): number => w.factions[0].fronts[0].id;
const noMove = (): void => undefined;
const quiet = (u: Unit): Unit => { u.lastFiredAt = -1e9; return u; };

describe('3.0 convoy fix: tanks short of ammunition get resupplied', () => {
  it('a tank that cannot fire one shell starts rearming even above rearm_below', () => {
    const w = setup();
    const t = quiet(w.spawnUnit(0, 'heavy_tank', spot(w, 300, 0), front(w)));
    // 3.0.2 (tank guns cost a tenth): give the test tank a dearer shell so one shot still exceeds rearm_below.
    const shell = L.rearm_below * 2;
    t.primary = { ...t.primary!, ammoCost: shell };
    t.ammo = (L.rearm_below + shell) / 2;
    w.spatial.rebuild(w.aliveUnits);
    rearmDuty(w, t, noMove, noMove, false);
    expect(t.rearming).toBe(true);
  });

  it('a loaded truck on its way stops and hands over where it meets a unit short of ammunition', () => {
    const w = setup();
    const at = spot(w, 400, (L.truck_handover_radius_m ?? 80) + 320);
    const truck = w.spawnUnit(0, 'supply_truck', at, front(w));
    truck.truckState = 'out';
    truck.cargo = 20;
    truck.truckDest = { x: at.x + 600, z: at.z };
    const u = quiet(w.spawnUnit(0, 'infantry', { x: at.x + 30, z: at.z }, front(w)));
    u.ammo = 0.1;
    w.spatial.rebuild(w.aliveUnits);
    thinkConvoyTruck(w, truck);
    expect(truck.truckState).toBe('unload');
  });

  it('a threatened loaded truck falls back toward home and still hands over, instead of driving to the depot full', () => {
    const w = setup();
    const at = spot(w, 400, 0);
    const truck = w.spawnUnit(0, 'supply_truck', at, front(w));
    truck.truckState = 'out';
    truck.cargo = 20;
    truck.truckDest = { ...at };
    w.spawnUnit(1, 'infantry', { x: at.x + 60, z: at.z }, w.factions[1].fronts[0].id);
    w.spatial.rebuild(w.aliveUnits);
    const before = dist(at, w.hqPos(0));
    thinkConvoyTruck(w, truck);
    expect(truck.truckState).toBe('out');
    expect(dist(truck.truckDest!, w.hqPos(0))).toBeLessThan(before - 100);
  });

  it('a rearming unit with no stock in reach walks to a loaded convoy on its way instead', () => {
    const w = setup();
    const at = spot(w, 500, 0);
    for (const p of w.places) p.stock = 0;
    const u = quiet(w.spawnUnit(0, 'medium_tank', at, front(w)));
    u.ammo = 0;
    const truck = w.spawnUnit(0, 'supply_truck', { x: at.x, z: at.z + 450 }, front(w));
    truck.truckState = 'out';
    truck.cargo = 20;
    w.spatial.rebuild(w.aliveUnits);
    let dest: V2 | null = null;
    expect(rearmDuty(w, u, (_w, _u, d) => { dest = d; }, noMove, false)).toBe(true);
    expect(dest).not.toBeNull();
    expect(dist(dest!, truck.pos)).toBeLessThan(1);
  });
});
