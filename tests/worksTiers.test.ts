import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { createMatch, updateVisibility } from '../src/sim/sim';
import { capitalDefenceSecond, observationRadius, perimeterOf, perimeterPosts } from '../src/sim/capitalDefence';
import { inMinefield, minefieldSecond, mineSpeedMul, startMinefield } from '../src/sim/minefields';
import { garrisonOf, startStructure, structureDef, structureSiteOk } from '../src/sim/structures';
import { needsWork, startUpgrade, tierStep } from '../src/sim/worksTiers';
import { startLine } from '../src/sim/works';
import type { Fort, Unit } from '../src/sim/types';
import type { V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** 3.0 defensive works tiers, minefields, the capital perimeter and observation ring (V30 §8). */
const data = loadGameData();

function world(d: GameData = data, infoMode: 'open' | 'fog' = 'open'): World {
  return createMatch(d, { mapId: 'generated', factions: 2, infoMode, seed: 7, difficulty: 'normal', playerSlot: 0, armyScale: 1 }).world;
}

function rich(w: World): void {
  w.factions[0].p = 9000;
  w.factions[0].m = 9000;
}

function siteNearHome(w: World): { p: V2; facing: number } {
  const hq = w.hqPos(0);
  for (let r = 100; r <= 200; r += 20) for (let a = 0; a < Math.PI * 2; a += 0.2) {
    const p = { x: hq.x + Math.cos(a) * r, z: hq.z + Math.sin(a) * r };
    if (structureSiteOk(w, p)) return { p, facing: a };
  }
  throw new Error('no site');
}

/** An engineer standing at the work steps it until it needs no more work. */
function work(w: World, fort: Fort): Unit {
  const u = w.spawnUnit(fort.owner, 'engineer', { ...fort.pos }, w.factions[fort.owner].fronts[0].id);
  for (let i = 0; i < 4000 && needsWork(fort); i++) {
    u.pos = { x: fort.pos.x - Math.cos(fort.facing) * 7.5, z: fort.pos.z - Math.sin(fort.facing) * 7.5 };
    tierStep(w, u, fort);
  }
  return u;
}

describe('works tiers', () => {
  it('a pillbox is upgraded in place to a bunker and then a fortress; its occupant keeps its seat', () => {
    const w = world();
    rich(w);
    const { p, facing } = siteNearHome(w);
    const fort = startStructure(w, w.factions[0], 'pillbox', p, facing, 0)!;
    fort.progress = 1;
    const sq = w.spawnUnit(0, 'infantry', { ...p }, w.factions[0].fronts[0].id);
    w.spatial.rebuild(w.aliveUnits);
    fort.occupants = [sq.id];
    sq.fortId = fort.id;
    expect(startUpgrade(w, w.factions[0], fort)).toBeNull();
    expect(needsWork(fort)).toBe(true);
    work(w, fort);
    expect(fort.kind).toBe('bunker');
    expect(fort.maxHp).toBe(structureDef(w, 'bunker').max_hp);
    expect(startUpgrade(w, w.factions[0], fort)).toBeNull();
    work(w, fort);
    expect(fort.kind).toBe('fortress');
    expect(fort.capacity).toBe(structureDef(w, 'fortress').capacity);
    expect(startUpgrade(w, w.factions[0], fort)).toBe('NO_UPGRADE');
    expect(garrisonOf(sq)?.def.id ?? 'fortress').toBe('fortress');
  });

  it('a trench becomes a fortified trench once (tier 1, more HP)', () => {
    const w = world();
    rich(w);
    const { p, facing } = siteNearHome(w);
    const tr = startLine(w, w.factions[0], 'trench', p, facing)!;
    tr.progress = 1;
    const hp0 = tr.maxHp;
    expect(startUpgrade(w, w.factions[0], tr)).toBeNull();
    work(w, tr);
    expect(tr.tier).toBe(1);
    expect(tr.maxHp).toBeGreaterThan(hp0);
    expect(startUpgrade(w, w.factions[0], tr)).toBe('NO_UPGRADE');
  });
});

describe('minefields', () => {
  /** A minefield of faction 0 laid in the open, and a faction-1 tank parked in it. */
  function field(): { w: World; mf: Fort; tank: Unit } {
    const w = world();
    rich(w);
    const { p, facing } = siteNearHome(w);
    const mf = startMinefield(w, w.factions[0], p, facing)!;
    mf.progress = 1;
    const tank = w.spawnUnit(1, 'medium_tank', { ...p }, w.factions[1].fronts[0].id);
    w.spatial.rebuild(w.aliveUnits);
    return { w, mf, tank };
  }

  it('slows hostile vehicles inside and blows them up by chance — the same way every run', () => {
    const runs = [field(), field()].map(({ w, mf, tank }) => {
      expect(inMinefield(w, mf, tank.pos)).toBe(true);
      const hp: number[] = [];
      for (let s = 0; s < 20; s++) {
        minefieldSecond(w);
        if (s === 0) expect(mineSpeedMul(w, tank)).toBe(w.data.rules.construction.defensive.tiers!.minefield.vehicle_speed_mul);
        hp.push(tank.hp, mf.hp);
        w.tick += w.tickHz;
      }
      return { hp, tank: tank.hp, mines: mf.hp, max: tank.def.maxHp, field: mf.maxHp };
    });
    expect(runs[0].hp).toEqual(runs[1].hp);
    expect(runs[0].tank).toBeLessThan(runs[0].max);
    expect(runs[0].mines).toBeLessThan(runs[0].field);
  });

  it('hostile engineers clear it; friendly vehicles pass untouched', () => {
    const { w, mf, tank } = field();
    tank.hp = 0;
    w.removeDead();
    const own = w.spawnUnit(0, 'medium_tank', { ...mf.pos }, w.factions[0].fronts[0].id);
    w.spawnUnit(1, 'engineer', { ...mf.pos }, w.factions[1].fronts[0].id);
    w.spatial.rebuild(w.aliveUnits);
    const hp0 = mf.hp;
    for (let s = 0; s < 10; s++) minefieldSecond(w);
    expect(mf.hp).toBeLessThan(hp0);
    expect(own.hp).toBe(own.def.maxHp);
    expect(mineSpeedMul(w, own)).toBe(1);
  });
});

describe('absolute defence perimeter and observation ring', () => {
  it('every capital gets permanent strongpoints with fixed crews and an artillery position', () => {
    const w = world();
    const r = w.data.rules.capital_defence!;
    for (const f of w.factions) {
      const ring = perimeterOf(w, f.id);
      expect(ring.length).toBeGreaterThan(0);
      expect(ring.length).toBeLessThanOrEqual(r.strongpoints);
      for (const sp of ring) expect(sp.permanent).toBe(true);
    }
    const posts = perimeterPosts(w);
    expect(posts.some((p) => p.unitId === r.artillery_unit)).toBe(true);
    for (const p of posts) expect(w.unitAlive(p.crewId)?.fixed).toBe(true);
  });

  it('engineers repair a broken strongpoint and its crew comes back', () => {
    const w = world();
    const sp = perimeterOf(w, 0)[0];
    const post = perimeterPosts(w).find((p) => p.fortId === sp.id)!;
    const crew = w.unitAlive(post.crewId)!;
    crew.hp = 0;
    w.removeDead();
    sp.hp = 0;
    expect(needsWork(sp)).toBe(true);
    work(w, sp);
    expect(sp.hp).toBe(sp.maxHp);
    w.tick += (w.data.rules.capital_defence!.crew_respawn_seconds + 2) * w.tickHz;
    capitalDefenceSecond(w);
    w.tick += (w.data.rules.capital_defence!.crew_respawn_seconds + 2) * w.tickHz;
    w.spatial.rebuild(w.aliveUnits);
    capitalDefenceSecond(w);
    const back = w.unitAlive(post.crewId);
    expect(back).toBeTruthy();
    expect(back!.fortId).toBe(sp.id);
  });

  it('switched off by its flag', () => {
    const off = { ...data, rules: { ...data.rules, capital_defence: { ...data.rules.capital_defence!, enabled: false } } };
    const w = world(off);
    expect(perimeterOf(w, 0)).toHaveLength(0);
    expect(perimeterPosts(w)).toHaveLength(0);
  });

  it('in fog the capital sees every hostile inside the observation ring (open mode: no ring)', () => {
    expect(observationRadius(world())).toBe(0);
    const w = world(data, 'fog');
    const R = observationRadius(w);
    expect(R).toBeGreaterThan(0);
    const hq = w.hqPos(0);
    // Inside the ring but behind the capital's own troops' sight, and far outside it.
    const a = Math.atan2(w.hqPos(1).z - hq.z, w.hqPos(1).x - hq.x) + Math.PI;
    const near = w.spawnUnit(1, 'recon', { x: hq.x + Math.cos(a) * R * 0.9, z: hq.z + Math.sin(a) * R * 0.9 }, w.factions[1].fronts[0].id);
    w.spatial.rebuild(w.aliveUnits);
    updateVisibility(w);
    expect(w.visibleTo[0].has(near.id)).toBe(true);
    const off = { ...data, rules: { ...data.rules, capital_defence: { ...data.rules.capital_defence!, observation: { enabled: false, radius_m: R } } } };
    const w2 = world(off, 'fog');
    const near2 = w2.spawnUnit(1, 'recon', { ...near.pos }, w2.factions[1].fronts[0].id);
    w2.spatial.rebuild(w2.aliveUnits);
    updateVisibility(w2);
    expect(w2.visibleTo[0].has(near2.id)).toBe(false);
  });
});
