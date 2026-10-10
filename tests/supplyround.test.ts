import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { drawSecond, placeOwner } from '../src/sim/settlements';
import { convoySecond } from '../src/sim/convoy';

const data = loadGameData();

function setup() {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 21, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  const p = w.places.find((x) => x.capitalOf < 0 && placeOwner(w, x) === 0)!;
  const o = w.objectives[p.objIdx];
  p.stock = 500;
  return { w, p, o };
}

describe('2.2 supply round: rearming is a pause in the fight', () => {
  it('a unit firing at the edge of a town draws nothing; the same unit out of contact does; defenders inside draw while firing', () => {
    const { w, p, o } = setup();
    const r = data.rules.logistics!;
    const edge = w.spawnUnit(0, 'infantry', { x: p.pos.x + Math.min(r.draw_radius_m.town - 5, o.radius + 20), z: p.pos.z }, w.factions[0].fronts[0].id);
    const inside = w.spawnUnit(0, 'infantry', { x: p.pos.x + 3, z: p.pos.z }, w.factions[0].fronts[0].id);
    w.tick = 100 * w.tickHz;
    for (const u of [edge, inside]) { u.ammo = 0.1; u.lastFiredAt = w.time - 1; }
    w.spatial.rebuild(w.aliveUnits);
    drawSecond(w);
    expect(edge.ammo).toBeCloseTo(0.1, 6);
    expect(inside.ammo).toBeGreaterThan(0.1);
    edge.lastFiredAt = w.time - (r.draw_contact_seconds ?? 0) - 1;
    drawSecond(w);
    expect(edge.ammo).toBeGreaterThan(0.1);
  });

  it('a truck hands nothing to a unit in a firefight, and only within its hand-over radius', () => {
    const { w } = setup();
    const f = w.factions[0];
    const at = { x: 1500, z: 1500 };
    const truck = w.spawnUnit(0, 'supply_truck', at, f.fronts[0].id);
    truck.truckState = 'unload';
    truck.cargo = 25;
    const reach = data.rules.logistics!.truck_handover_radius_m ?? 190;
    const firing = w.spawnUnit(0, 'infantry', { x: at.x + 20, z: at.z }, f.fronts[0].id);
    const far = w.spawnUnit(0, 'infantry', { x: at.x + reach + 30, z: at.z }, f.fronts[0].id);
    const calm = w.spawnUnit(0, 'infantry', { x: at.x - 20, z: at.z }, f.fronts[0].id);
    w.tick = 100 * w.tickHz;
    for (const u of [firing, far, calm]) u.ammo = 0.1;
    firing.lastFiredAt = w.time - 1;
    w.spatial.rebuild(w.aliveUnits);
    convoySecond(w, f);
    expect(firing.ammo).toBeCloseTo(0.1, 6);
    expect(far.ammo).toBeCloseTo(0.1, 6);
    expect(calm.ammo).toBeGreaterThan(0.1);
  });
});
