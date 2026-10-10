import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { CommandBus } from '../src/sim/commands';
import { convoySecond } from '../src/sim/convoy';
import { advanceProduction, scheduleProduction } from '../src/sim/production';
import { crowdEfficiency, drawSecond, logisticsRules, placeById, placeOwner, stockCap, stockSecond } from '../src/sim/settlements';
import type { Place, Unit } from '../src/sim/types';
import { dist } from '../src/sim/vec';
import type { World } from '../src/sim/world';

const data = loadGameData();

/** A quiet 2-faction match (AI not stepped: the systems are called directly). */
function makeWorld(): { m: ReturnType<typeof createMatch>; w: World } {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 21, difficulty: 'normal', playerSlot: 0, spectate: false });
  m.world.spatial.rebuild(m.world.aliveUnits);
  return { m, w: m.world };
}

const ownTown = (w: World, f: number): Place => w.places.find((p) => p.kind === 'town' && placeOwner(w, p) === f) ?? w.places.find((p) => p.kind !== 'capital' && placeOwner(w, p) === f)!;

/** Spawn `n` infantry around a point with the given ammo (front 0). */
function squads(w: World, f: number, at: { x: number; z: number }, n: number, ammo: number): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < n; i++) {
    const u = w.spawnUnit(f, 'infantry', { x: at.x + (i % 5) * 4, z: at.z + Math.floor(i / 5) * 4 }, w.factions[f].fronts[0]?.id ?? 0);
    u.ammo = ammo;
    out.push(u);
  }
  w.spatial.rebuild(w.aliveUnits);
  return out;
}

describe('2.2 logistics: settlement stocks', () => {
  it('weapons carry 40 % of the 2.1 load (ammo cost × 2.5, one lever)', () => {
    expect(logisticsRules({ data } as World).ammo_cost_multiplier).toBe(2.5);
    expect(data.weapons.get('rifle')!.ammoCost).toBeCloseTo(0.01 * 2.5, 9);
  });

  it('every capital, city and town is a place; owned ones start with stock below the cap', () => {
    const { w } = makeWorld();
    expect(w.places.filter((p) => p.kind === 'capital').length).toBe(2);
    expect(w.places.some((p) => p.kind === 'town' || p.kind === 'city')).toBe(true);
    for (const p of w.places) {
      if (placeOwner(w, p) >= 0) expect(p.stock).toBeGreaterThan(0);
      expect(p.stock).toBeLessThanOrEqual(stockCap(w, p) + 1e-6);
    }
  });

  it('logistics fill stocks up to their cap and never beyond; a captured place loses its stock', () => {
    const { w } = makeWorld();
    for (const f of w.factions) f.logistics = 1e6; // flood: caps must hold
    for (let i = 0; i < 5; i++) stockSecond(w, () => true);
    for (const p of w.places) if (placeOwner(w, p) >= 0) expect(p.stock).toBeCloseTo(stockCap(w, p), 6);
    const town = ownTown(w, 0);
    expect(town.stock).toBeGreaterThan(0);
    w.objectives[town.objIdx].owner = 1;
    stockSecond(w, () => false);
    expect(town.stock).toBe(0);
  });

  it('rearming is gradual (a rate, not a top-up) and units near a stock count as supplied', () => {
    const { w } = makeWorld();
    const cap = placeById(w, 'cap:0')!;
    cap.stock = 1e4;
    const [u] = squads(w, 0, cap.pos, 1, 0);
    const rate = logisticsRules(w).rearm_per_second;
    drawSecond(w);
    expect(u.ammo).toBeCloseTo(rate, 6);
    for (let i = 0; i < 4; i++) drawSecond(w);
    expect(u.ammo).toBeCloseTo(rate * 5, 6);
    expect(u.ammo).toBeLessThan(0.5);
    expect(u.lastSuppliedAt).toBe(w.time);
  });

  it('crowding cuts each unit\'s share at one stock', () => {
    const { w } = makeWorld();
    const l = logisticsRules(w);
    expect(crowdEfficiency(l, l.crowd_free)).toBe(1);
    expect(crowdEfficiency(l, l.crowd_free + 10)).toBeLessThan(0.5);
    const cap = placeById(w, 'cap:0')!;
    cap.stock = 1e4;
    const crowd = squads(w, 0, cap.pos, 24, 0);
    drawSecond(w);
    const each = Math.max(...crowd.map((u) => u.ammo));
    expect(each).toBeLessThan(l.rearm_per_second * 0.7);
  });

  it('convoy hand-over: gradual per unit and capped per area (two trucks in one spot do not stack)', () => {
    const { w } = makeWorld();
    const f = w.factions[0];
    // An empty field far from every place, inside the map.
    const at = { x: w.terrain.width / 2, z: w.terrain.depth / 2 };
    const nav = w.nav(true, 22);
    const spot = nav.nearestPassable(at, 200) ?? at;
    for (const p of w.places) p.stock = 0;
    const trucks = [0, 1].map((k) => {
      const t = w.spawnUnit(0, 'supply_truck', { x: spot.x + k * 6, z: spot.z }, f.fronts[0].id);
      t.truckState = 'unload';
      t.cargo = 40;
      return t;
    });
    const units = squads(w, 0, { x: spot.x + 20, z: spot.z + 20 }, 30, 0);
    const before = trucks.reduce((a, t) => a + t.cargo, 0);
    convoySecond(w, f);
    const handed = before - trucks.reduce((a, t) => a + t.cargo, 0);
    const k = w.data.rules.proposed_defaults.army_scale ?? 1;
    expect(handed).toBeLessThanOrEqual(logisticsRules(w).convoy_area_cap_per_second_k * k + 1e-6);
    expect(Math.max(...units.map((u) => u.ammo))).toBeLessThanOrEqual(logisticsRules(w).rearm_per_second + 1e-9);
  });
});

describe('2.2 production: per-place queues', () => {
  it('a unit queued at a chosen town is built there and rolls out there with no ammunition', () => {
    const { m, w } = makeWorld();
    const f = w.factions[0];
    f.p = 5000;
    f.m = 5000;
    const town = ownTown(w, 0);
    const bus = new CommandBus();
    bus.issue(m, 0, { type: 'queueUnit', unitId: 'infantry', frontId: -1, placeId: town.id });
    bus.flush(m);
    scheduleProduction(w, f);
    const o = f.orders.find((x) => x.manual && x.unitId === 'infantry');
    expect(o?.placeId).toBe(town.id);
    const known = new Set(w.units.keys());
    o!.remaining = 0;
    advanceProduction(w, f, 1);
    const fresh = [...w.units.values()].filter((u) => !known.has(u.id) && u.def.id === 'infantry');
    expect(fresh.length).toBe(1);
    expect(dist(fresh[0].pos, town.pos)).toBeLessThan(60);
    expect(fresh[0].ammo).toBe(0);
  });

  it('a queue only takes units its place can build (a town has barracks only)', () => {
    const { m, w } = makeWorld();
    const town = w.places.find((p) => p.kind === 'town' && placeOwner(w, p) === 0);
    if (!town) return;
    const bus = new CommandBus();
    let out: unknown = null;
    bus.onResult = (_e, r) => (out = r);
    bus.issue(m, 0, { type: 'queueUnit', unitId: 'medium_tank', frontId: -1, placeId: town.id });
    bus.flush(m);
    expect(out).toEqual({ ok: false, reason: 'NO_SLOT' });
  });

  it('a lost place stops its queue and refunds at the cancel ratio', () => {
    const { w } = makeWorld();
    const f = w.factions[0];
    f.p = 5000;
    f.m = 5000;
    const town = ownTown(w, 0);
    f.manualQueue = [{ unitId: 'infantry', frontId: -1, placeId: town.id }];
    scheduleProduction(w, f);
    const o = f.orders.find((x) => x.placeId === town.id)!;
    expect(o).toBeTruthy();
    const p0 = f.p;
    w.objectives[town.objIdx].owner = 1;
    advanceProduction(w, f, 1);
    expect(f.orders.some((x) => x.id === o.id)).toBe(false);
    expect(f.p - p0).toBeCloseTo(o.costP * w.data.rules.economy.cancel_started_refund_ratio, 6);
  });

  it('the auto scheduler spreads orders over places (each order sits on a place with that facility)', () => {
    const { m, w } = makeWorld();
    for (let i = 0; i < 20 * 20; i++) step(m);
    for (const f of w.factions) {
      for (const o of f.orders) {
        const p = placeById(w, o.placeId)!;
        expect(placeOwner(w, p)).toBe(f.id);
        if (p.kind === 'town') expect(o.facility).toBe('barracks');
      }
    }
  });
});
