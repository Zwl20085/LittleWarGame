import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { CommandBus } from '../src/sim/commands';
import { buildCost, damageEconAt, econIncome, econSecond, startBuilding } from '../src/sim/econ';
import { placeOwner, stockCap } from '../src/sim/settlements';
import type { EconBuilding, Place } from '../src/sim/types';
import type { World } from '../src/sim/world';

const data = loadGameData();

function makeWorld(): { m: ReturnType<typeof createMatch>; w: World } {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 21, difficulty: 'normal', playerSlot: 0, spectate: false });
  m.world.spatial.rebuild(m.world.aliveUnits);
  return { m, w: m.world };
}

const ownSite = (w: World, f: number): Place => w.places.find((p) => p.slotPos.length > 0 && placeOwner(w, p) === f)!;

function finish(w: World, b: EconBuilding): void {
  const secs = w.data.rules.econ!.buildings[b.kind].build_seconds;
  for (let i = 0; i < secs + 1; i++) econSecond(w);
}

describe('2.2 economic buildings', () => {
  it('base settlement income is halved and economic buildings earn on top', () => {
    const terr = data.rules.territory!;
    expect(terr.income_m_per_min.town).toBeCloseTo(9, 6);
    expect(terr.income_p_per_min.city).toBeCloseTo(11.25, 6);
    expect(data.rules.econ!.slots.town).toBe(2);
    expect(data.rules.econ!.slots.city).toBe(3);
  });

  it('build command: paid up front, slots by kind, construction takes time, then it pays', () => {
    const { m, w } = makeWorld();
    const f = w.factions[0];
    f.p = 2000;
    f.m = 2000;
    const site = ownSite(w, 0);
    const bus = new CommandBus();
    bus.issue(m, 0, { type: 'buildEcon', placeId: site.id, kind: 'factory' });
    bus.flush(m);
    const b = w.econ.find((x) => x.placeId === site.id)!;
    expect(b).toBeTruthy();
    expect(f.m).toBeCloseTo(2000 - data.rules.econ!.buildings.factory.cost_m, 6);
    expect(econIncome(w, 0, () => true).m).toBe(0);
    econSecond(w);
    expect(b.progress).toBeGreaterThan(0);
    expect(b.progress).toBeLessThan(1);
    finish(w, b);
    expect(b.progress).toBe(1);
    expect(econIncome(w, 0, () => true).m).toBeGreaterThan(0);
    // Slots by kind: fill them, then the next one is refused.
    for (let i = 1; i < site.slotPos.length; i++) expect(typeof startBuilding(w, f, site.id, 'recruit')).not.toBe('string');
    expect(startBuilding(w, f, site.id, 'recruit')).toBe('NO_SLOT');
  });

  it('a depot raises the local stock cap', () => {
    const { w } = makeWorld();
    const f = w.factions[0];
    f.p = 2000;
    f.m = 2000;
    const site = ownSite(w, 0);
    const cap0 = stockCap(w, site);
    const b = startBuilding(w, f, site.id, 'depot') as EconBuilding;
    finish(w, b);
    expect(stockCap(w, site)).toBeGreaterThan(cap0);
  });

  it('shellfire destroys a building into a ruin, which is rebuilt cheaper', () => {
    const { w } = makeWorld();
    const f = w.factions[0];
    f.p = 2000;
    f.m = 2000;
    const site = ownSite(w, 0);
    const b = startBuilding(w, f, site.id, 'factory') as EconBuilding;
    finish(w, b);
    for (let i = 0; i < 100 && !b.ruined; i++) damageEconAt(w, { x: b.pos.x, y: 0, z: b.pos.z }, 8, 300);
    expect(b.ruined).toBe(true);
    expect(b.hp).toBe(0);
    expect(econIncome(w, 0, () => true).m).toBe(0);
    const full = data.rules.econ!.buildings.factory;
    const c = buildCost(w, site, 'factory', b.slot);
    expect(c.m).toBeLessThan(full.cost_m);
    const r = startBuilding(w, f, site.id, 'factory') as EconBuilding;
    expect(r.slot).toBe(b.slot);
    expect(w.econ.filter((x) => x.placeId === site.id && x.slot === b.slot).length).toBe(1);
  });

  it('infantry raiders demolish an enemy building they stand next to; capture keeps it, damaged', () => {
    const { w } = makeWorld();
    const f = w.factions[0];
    f.p = 4000;
    f.m = 4000;
    const site = ownSite(w, 0);
    const b = startBuilding(w, f, site.id, 'recruit') as EconBuilding;
    const b2 = startBuilding(w, f, site.id, 'factory') as EconBuilding;
    finish(w, b);
    const raider = w.spawnUnit(1, 'engineer', { x: b.pos.x + 3, z: b.pos.z }, w.factions[1].fronts[0].id);
    raider.opRole = 'raid';
    w.spatial.rebuild(w.aliveUnits);
    const hp0 = b.hp;
    econSecond(w);
    expect(b.hp).toBeLessThan(hp0);
    raider.hp = 0;
    w.removeDead();
    w.spatial.rebuild(w.aliveUnits);
    // Capture: the buildings change hands and keep at most captured_hp_ratio of their HP.
    w.objectives[site.objIdx].owner = 1;
    econSecond(w);
    expect(b.owner).toBe(1);
    expect(b2.owner).toBe(1);
    expect(b.ruined).toBe(false);
    expect(b.hp).toBeLessThanOrEqual(b.maxHp * data.rules.econ!.captured_hp_ratio + 1e-6);
    expect(econIncome(w, 1, () => true).p).toBeGreaterThan(0);
  });
});
