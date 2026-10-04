import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { coverAgainst } from '../src/sim/damage';
import { populationOf } from '../src/sim/production';
import { HOME } from '../src/sim/homeguard';
import { Ground } from '../src/sim/terrain';
import {
  absorbHit, buildStep, damageStructure, garrisonBlind, garrisonOf, garrisonRaise, placeStructure, STRUCT, startStructure,
  structureDef, structureSiteOk, updateStructureGarrison, weaponOf, zoneSlots,
} from '../src/sim/structures';
import { planStructures } from '../src/sim/fortplans';
import { issueFrontOrder } from '../src/sim/fronts';
import type { Fort, FrontOrder, Unit } from '../src/sim/types';
import { dist, headingTo, type V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** 2.0 defensive buildings (structures.ts, fortplans.ts): construction, garrison, cover, capital line. */
const data = loadGameData();

function smallWorld(): World {
  return createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, armyScale: 1 }).world;
}

/** A buildable site 100–200 m from faction 0's capital, facing away from it. */
function siteNearHome(w: World): { p: V2; facing: number } {
  const hq = w.hqPos(0);
  for (let r = 100; r <= 200; r += 20) {
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      const p = { x: hq.x + Math.cos(a) * r, z: hq.z + Math.sin(a) * r };
      if (structureSiteOk(w, p)) return { p, facing: a };
    }
  }
  throw new Error('no site');
}

/** Run the garrison check on its staggered tick for this unit. */
function garrisonCheck(w: World, u: Unit): void {
  w.tick += (STRUCT.garrisonCheckPhase - ((w.tick + u.id) % STRUCT.garrisonCheckTicks) + STRUCT.garrisonCheckTicks) % STRUCT.garrisonCheckTicks;
  updateStructureGarrison(w, u);
}

function place(w: World, u: Unit, p: V2): void {
  u.pos.x = p.x; u.pos.z = p.z; u.prev.x = p.x; u.prev.z = p.z;
  u.y = w.terrain.heightAt(p.x, p.z);
  u.moving = false;
}

function finishedPillbox(w: World): Fort {
  const f = w.factions[0];
  f.p = 5000;
  f.m = 5000;
  const { p, facing } = siteNearHome(w);
  const fort = startStructure(w, f, 'pillbox', p, facing, 0)!;
  fort.progress = 1;
  return fort;
}

describe('defensive buildings (structures.ts)', () => {
  it('construction is paid up front and progresses only with engineers at the site', () => {
    const w = smallWorld();
    const f = w.factions[0];
    f.p = 1000;
    f.m = 1000;
    const def = structureDef(w, 'pillbox');
    const { p, facing } = siteNearHome(w);
    const fort = startStructure(w, f, 'pillbox', p, facing, 0);
    expect(fort).not.toBeNull();
    expect(f.p).toBeCloseTo(1000 - def.cost_p);
    expect(f.m).toBeCloseTo(1000 - def.cost_m);
    expect(fort!.progress).toBe(0);
    expect(fort!.hp).toBe(def.max_hp);
    // Riflemen cannot build a pillbox.
    const rifle = w.spawnUnit(0, 'infantry', p, 0);
    expect(buildStep(w, rifle, fort!)).toBe(false);
    const eng = w.spawnUnit(0, 'engineer', p, 0);
    place(w, eng, { x: p.x - Math.cos(facing) * STRUCT.rearStandM, z: p.z - Math.sin(facing) * STRUCT.rearStandM });
    for (let i = 0; i < 10; i++) buildStep(w, eng, fort!);
    expect(fort!.progress).toBeCloseTo(10 * 0.4 / def.work_seconds);
    for (let i = 0; i < Math.ceil(def.work_seconds / 0.4); i++) buildStep(w, eng, fort!);
    expect(fort!.progress).toBe(1);
    expect(w.log.some((l) => l.key === 'log.pillboxBuilt' && l.faction === 0)).toBe(true);
    // Pacing: a second start right away is refused.
    expect(startStructure(w, f, 'bunker', { x: p.x + 40, z: p.z }, facing, 0)).toBeNull();
  });

  it('refuses sites on water and on buildings, and unaffordable ones', () => {
    const w = smallWorld();
    const t = w.terrain;
    let water: V2 | null = null;
    let house: V2 | null = null;
    for (let x = 20; x < t.width - 20 && (!water || !house); x += 7) {
      for (let z = 20; z < t.depth - 20 && (!water || !house); z += 7) {
        if (!water && t.groundAt(x, z) === Ground.Water) water = { x, z };
        if (!house && t.buildingH(x, z) > 0) house = { x, z };
      }
    }
    const f = w.factions[0];
    f.p = 5000;
    f.m = 5000;
    // (2.1: the capitals' strongpoint pillboxes stand from the start.)
    const before = w.forts.filter((x) => x.kind === 'pillbox').length;
    expect(house).not.toBeNull();
    expect(structureSiteOk(w, house!)).toBe(false);
    expect(startStructure(w, f, 'pillbox', house!, 0, 0)).toBeNull();
    if (water) {
      expect(structureSiteOk(w, water)).toBe(false);
      expect(startStructure(w, f, 'pillbox', water, 0, 0)).toBeNull();
    }
    f.m = 10;
    expect(startStructure(w, f, 'pillbox', siteNearHome(w).p, 0, 0)).toBeNull();
    expect(w.forts.filter((x) => x.kind === 'pillbox').length).toBe(before);
  });

  it('a squad enters a finished pillbox, gets cover / the MG / height, keeps its population, and is thrown out when it collapses', () => {
    const w = smallWorld();
    const fort = finishedPillbox(w);
    const f = w.factions[0];
    const u = w.spawnUnit(0, 'infantry', fort.pos, 0);
    place(w, u, { x: fort.pos.x + 2, z: fort.pos.z });
    const popBefore = populationOf(w, f).present;
    garrisonCheck(w, u);
    expect(u.fortId).toBe(fort.id);
    expect(fort.occupants).toEqual([u.id]);
    expect(garrisonOf(u)).not.toBeNull();
    // Buildings cost no population; the garrisoned squad keeps its own (lead decision).
    expect(populationOf(w, f).present).toBe(popBefore);
    // Built-in MG instead of rifles, raised muzzle, all-round cover 3, blind rear arc.
    expect(weaponOf(u)?.id).toBe('pillbox_mg');
    expect(garrisonRaise(u)).toBeGreaterThan(0);
    const front = { x: fort.pos.x + Math.cos(fort.facing) * 100, z: fort.pos.z + Math.sin(fort.facing) * 100 };
    const rear = { x: fort.pos.x - Math.cos(fort.facing) * 100, z: fort.pos.z - Math.sin(fort.facing) * 100 };
    expect(coverAgainst(w, u, front)).toBe(3);
    expect(coverAgainst(w, u, rear)).toBe(3);
    expect(coverAgainst(w, u, null)).toBe(3);
    expect(garrisonBlind(u, front)).toBe(false);
    expect(garrisonBlind(u, rear)).toBe(true);
    // Capacity 1: a second squad stays outside.
    const v = w.spawnUnit(0, 'infantry', fort.pos, 0);
    place(w, v, { x: fort.pos.x - 2, z: fort.pos.z });
    garrisonCheck(w, v);
    expect(v.fortId).toBeNull();
    // Direct hits: small arms are stopped by the concrete, guns damage it.
    const hp0 = fort.hp;
    expect(absorbHit(w, u, 100, 8, 1)).toBeCloseTo(100 * (1 - data.rules.construction.defensive.garrison.absorb_share));
    expect(fort.hp).toBe(hp0);
    absorbHit(w, u, 400, 140, 1);
    // 2.0 attack-side round: the concrete takes the tempo multiplier like units do.
    expect(fort.hp).toBeCloseTo(hp0 - 400 * data.rules.construction.defensive.garrison.absorb_share * (data.rules.proposed_defaults.tempo_damage_multiplier ?? 1), 5);
    // Collapse: thrown out, suppressed and hurt.
    const hp = u.hp;
    damageStructure(w, fort, fort.hp + 1, 1);
    expect(fort.hp).toBe(0);
    expect(u.fortId).toBeNull();
    expect(fort.occupants).toEqual([]);
    expect(u.suppression).toBeGreaterThan(0);
    expect(u.hp).toBeLessThan(hp);
    expect(weaponOf(u)?.id).toBe('rifle');
  });

  it('an occupant that walks away leaves; vehicles never enter', () => {
    const w = smallWorld();
    const fort = finishedPillbox(w);
    const u = w.spawnUnit(0, 'infantry', fort.pos, 0);
    place(w, u, fort.pos);
    garrisonCheck(w, u);
    expect(u.fortId).toBe(fort.id);
    place(w, u, { x: fort.pos.x + 30, z: fort.pos.z });
    garrisonCheck(w, u);
    expect(u.fortId).toBeNull();
    expect(fort.occupants).toEqual([]);
    const tank = w.spawnUnit(0, 'medium_tank', fort.pos, 0);
    place(w, tank, fort.pos);
    garrisonCheck(w, tank);
    expect(tank.fortId).toBeNull();
  });

  for (const seed of [7, 11]) {
    it(`every faction has its capital line (trench + pillbox sites) by minute 3 (seed ${seed})`, () => {
      const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
      const w = m.world;
      for (let i = 0; i < 180 * w.tickHz; i++) {
        step(m);
        w.fx.length = 0;
      }
      for (const f of w.factions) {
        if (!f.alive) continue;
        const hq = w.hqPos(f.id);
        const near = w.forts.filter((x) => x.owner === f.id && x.hp > 0 && dist(x.pos, hq) < HOME.worksRadiusM);
        expect(near.some((x) => x.kind === 'pillbox'), `faction ${f.id} pillbox`).toBe(true);
        expect(near.some((x) => x.kind === 'trench'), `faction ${f.id} trench`).toBe(true);
        // On the exit side of the capital (the line faces away from it).
        for (const x of near.filter((y) => y.kind === 'pillbox')) {
          const out = headingTo(hq, x.pos);
          expect(Math.cos(out - x.facing)).toBeGreaterThan(0.5);
        }
      }
    }, 120_000);
  }
});


/** 2.1 permanent works: zones outlive orders, cheaper and stronger buildings, capitals start fortified, works are manned. */
describe('permanent works (2.1)', () => {
  const fortify = (w: World, a: V2, b: V2): FrontOrder => ({ kind: 'fortify', a: { ...a }, b: { ...b }, issuedAt: w.time, manual: true });

  /** A straight `len` m line of buildable ground `r` m out from faction 0's capital, square to the bearing. */
  function lineOut(w: World, r: number, len: number): { a: V2; b: V2 } {
    const hq = w.hqPos(0);
    for (let a = 0; a < Math.PI * 2; a += 0.15) {
      const c = { x: hq.x + Math.cos(a) * r, z: hq.z + Math.sin(a) * r };
      const along = a + Math.PI / 2;
      const p = { x: c.x - (Math.cos(along) * len) / 2, z: c.z - (Math.sin(along) * len) / 2 };
      const q = { x: c.x + (Math.cos(along) * len) / 2, z: c.z + (Math.sin(along) * len) / 2 };
      if ([0, 0.1, 0.5, 0.9, 1].every((t) => structureSiteOk(w, { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }))) return { a: p, b: q };
    }
    throw new Error('no line');
  }

  it('capitals start with finished pillboxes at their strongpoints and the starting engineers in the field', () => {
    const w = smallWorld();
    for (const f of w.factions) {
      const city = w.cityOf(f.id);
      const hq = w.hqPos(f.id);
      const pills = w.forts.filter((x) => x.owner === f.id && x.kind === 'pillbox' && x.progress >= 1 && dist(x.pos, hq) < 250);
      const fixed = [...w.units.values()].filter((u) => u.owner === f.id && u.fixed);
      // Every strongpoint is a pillbox (or, with no buildable ground near it, the old fixed MG).
      expect(pills.length + fixed.length).toBe(city.strongpoints.length);
      expect(pills.length).toBeGreaterThan(0);
      const eng = [...w.units.values()].filter((u) => u.owner === f.id && u.def.id === 'engineer');
      // Scaled by army_scale at match creation, at least 1 (sim.createMatch).
      expect(eng.length).toBe(Math.max(1, Math.round(w.data.rules.economy.initial_units.engineer)));
    }
  });

  it("pillbox: dedicated MG, cheaper and tougher; bunker: firing slits boost the occupants' own weapons", () => {
    const w = smallWorld();
    const pill = structureDef(w, 'pillbox');
    const bunker = structureDef(w, 'bunker');
    const mg = w.data.weapons.get('pillbox_mg')!;
    expect(pill.weapon).toBe('pillbox_mg');
    expect([mg.range, mg.damage, mg.interval, mg.suppression]).toEqual([200, 90, 1, 24]);
    expect([pill.cost_p, pill.cost_m, pill.work_seconds, pill.max_hp]).toEqual([6, 50, 60, 2750]);
    expect([bunker.cost_p, bunker.cost_m, bunker.work_seconds, bunker.max_hp]).toEqual([12, 100, 100, 5625]);
    const { p, facing } = siteNearHome(w);
    const fort = placeStructure(w, 0, 'bunker', p, facing)!;
    expect(fort.progress).toBe(1);
    const u = w.spawnUnit(0, 'infantry', fort.pos, 0);
    place(w, u, fort.pos);
    garrisonCheck(w, u);
    expect(u.fortId).toBe(fort.id);
    const own = u.primary!;
    const fired = weaponOf(u)!;
    expect(fired.id).toBe(own.id);
    expect(fired.damage).toBeCloseTo(own.damage * bunker.fire_mul!.damage);
    expect(fired.range).toBeCloseTo(own.range * bunker.fire_mul!.range);
    // The unit's own weapon is untouched.
    expect(w.data.weapons.get(own.id)!.damage).toBe(own.damage);
  });

  it('a zone outlives the order that created it: a second Fortify order adds a zone, both are built; a cancelled one stops', () => {
    const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, armyScale: 1 });
    const w = m.world;
    const f = w.factions[0];
    const s = f.fronts[0];
    const z1 = lineOut(w, 360, 160);
    const z2 = lineOut(w, 560, 160);
    const rich = (): void => { f.p = Math.max(f.p, 2000); f.m = Math.max(f.m, 2000); };
    issueFrontOrder(w, f, s, fortify(w, z1.a, z1.b));
    for (let i = 0; i < 60 * w.tickHz; i++) { rich(); step(m); w.fx.length = 0; }
    issueFrontOrder(w, f, s, fortify(w, z2.a, z2.b));
    expect(f.zones.length).toBe(2);
    expect(f.zones.every((z) => !z.cancelled)).toBe(true);
    for (let i = 0; i < 120 * w.tickHz; i++) { rich(); step(m); w.fx.length = 0; }
    const sitesOf = (a: V2, b: V2): Fort[] => w.forts.filter((x) => x.owner === 0 && x.hp > 0 && segD(x.pos, a, b) < 40);
    expect(sitesOf(z1.a, z1.b).length, 'first zone keeps building after the second order').toBeGreaterThan(0);
    expect(sitesOf(z2.a, z2.b).length, 'second zone').toBeGreaterThan(0);
    // Cancel the first: no new sites there, what stands stays.
    const n1 = sitesOf(z1.a, z1.b).length;
    f.zones[0].cancelled = true;
    for (let i = 0; i < 60 * w.tickHz; i++) { rich(); step(m); w.fx.length = 0; }
    expect(sitesOf(z1.a, z1.b).length).toBeLessThanOrEqual(n1);
    expect(sitesOf(z1.a, z1.b).length).toBeGreaterThan(0);
  }, 120_000);

  it('a holding front mans every pillbox / bunker of its finished zone within 90 s', () => {
    const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, armyScale: 1 });
    const w = m.world;
    const f = w.factions[0];
    const s = f.fronts[0];
    const { a, b } = lineOut(w, 450, 200);
    issueFrontOrder(w, f, s, fortify(w, a, b));
    const zone = f.zones[f.zones.length - 1];
    const at = (t: number): V2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    const hq = w.hqPos(0);
    const facing = headingTo(hq, at(0.5));
    const works = [placeStructure(w, 0, 'pillbox', at(0.1), facing), placeStructure(w, 0, 'pillbox', at(0.9), facing), placeStructure(w, 0, 'bunker', at(0.5), facing)];
    expect(works.every((x) => x !== null)).toBe(true);
    const slots = zoneSlots(w, f, zone).filter((x) => x.kind === 'pillbox' || x.kind === 'bunker');
    expect(slots.length).toBe(4);
    const back = (t: number): V2 => w.terrain.freeNear({ x: at(t).x + (hq.x - at(t).x) * 0.15, z: at(t).z + (hq.z - at(t).z) * 0.15 }, 30);
    for (let k = 0; k < 8; k++) w.spawnUnit(0, 'infantry', back(k / 7), s.id).behavior = 'advance';
    let manned = 0;
    for (let i = 0; i < 90 * w.tickHz && manned < 4; i++) {
      step(m);
      w.fx.length = 0;
      manned = works.reduce((n, x) => n + (x!.occupants?.length ?? 0), 0);
    }
    expect(manned).toBe(4);
    expect(zoneSlots(w, f, zone).filter((x) => x.taken).length).toBe(4);
  }, 120_000);

  it("the supreme HQ queues engineers for waiting works — the player's too — unless the engineer line is paused", () => {
    const w = smallWorld();
    w.tick = 30 * w.tickHz;
    const f = w.factions[0];
    expect(f.isPlayer).toBe(true);
    for (const u of w.units.values()) if (u.owner === 0 && u.def.id === 'engineer') u.hp = 0;
    f.paused = { ...f.paused, engineer: true };
    planStructures(w, f);
    expect(f.manualQueue.some((q) => q.unitId === 'engineer')).toBe(false);
    f.paused = { ...f.paused, engineer: false };
    planStructures(w, f);
    expect(f.manualQueue.filter((q) => q.unitId === 'engineer').length).toBeGreaterThan(0);
    expect(w.log.some((l) => l.key === 'log.engineersRequested' && l.faction === 0)).toBe(true);
  });
});

function segD(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}
