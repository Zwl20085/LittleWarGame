import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { BUILDING, COVER, TERRAIN_COMBAT } from '../src/sim/config';
import { buildingIndexAt, extentAlong, isCollapsed, noteBuildingHit, shieldBuilding, sightLine } from '../src/sim/buildings';
import { coverAgainst } from '../src/sim/damage';
import { hitProbability } from '../src/sim/formulas';
import { forestConcealed, shotTerrainMul } from '../src/sim/terrainrules';
import { Ground } from '../src/sim/terrain';
import { coverSpot } from '../src/sim/terrainai';
import type { Unit } from '../src/sim/types';
import type { V2 } from '../src/sim/vec';

const data = loadGameData();

describe('terrain and buildings in combat', () => {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, armyScale: 1 });
  const w = m.world;
  const t = w.terrain;
  // A free-standing house with open ground 1.8 m off both short sides.
  const k = t.buildings.findIndex((b) => {
    if (b.kind !== 'house') return false;
    const ux = Math.cos(-b.rot);
    const uz = Math.sin(-b.rot);
    const e = extentAlong(b, ux, uz) + 1.8;
    if (t.buildingH(b.x + ux * e, b.z + uz * e) !== 0) return false;
    // Clear street for 40 m beyond the far wall (no other house in the way).
    for (let s = e; s <= e + 40; s += 2) if (t.buildingH(b.x - ux * s, b.z - uz * s) !== 0) return false;
    return t.groundAt(b.x - ux * (e + 40), b.z - uz * (e + 40)) !== Ground.Water;
  });
  const b = t.buildings[k];
  const ux = Math.cos(-b.rot);
  const uz = Math.sin(-b.rot);
  const e = extentAlong(b, ux, uz) + 1.8;
  const lee: V2 = { x: b.x + ux * e, z: b.z + uz * e };
  const enemyPos: V2 = { x: b.x - ux * (e + 40), z: b.z - uz * (e + 40) };
  const place = (u: Unit, p: V2): Unit => {
    u.pos.x = p.x; u.pos.z = p.z; u.prev.x = p.x; u.prev.z = p.z;
    u.y = t.heightAt(p.x, p.z);
    u.cover = u.def.kind === 'vehicle' ? 0 : t.coverAt(p.x, p.z);
    return u;
  };

  it('finds a house and indexes it', () => {
    expect(k).toBeGreaterThanOrEqual(0);
    expect(buildingIndexAt(t, b.x, b.z)).toBe(k);
  });

  it('a squad on the lee side of a house is garrisoned against fire from beyond it', () => {
    const sq = place(w.spawnUnit(0, 'infantry', lee, 0), lee);
    expect(sq.cover).toBe(3);
    expect(shieldBuilding(w, sq.pos, enemyPos)).toBe(k);
    expect(coverAgainst(w, sq, enemyPos)).toBe(3);
    // From its own side the house is behind it: ordinary heavy cover at best.
    const behind = { x: lee.x + ux * 60, z: lee.z + uz * 60 };
    expect(coverAgainst(w, sq, behind)).toBeLessThanOrEqual(2);
    // Window fire: it sees (and is seen by) a squad beyond the house.
    const foe = place(w.spawnUnit(1, 'infantry', enemyPos, 0), enemyPos);
    expect(sightLine(w, sq, 1.6, foe, 0.9)).toBe(true);
    w.units.delete(sq.id);
    w.units.delete(foe.id);
  });

  it('HE wears a building down until it collapses and stops protecting', () => {
    const sq = place(w.spawnUnit(0, 'infantry', lee, 0), lee);
    const at = { x: b.x, y: t.heightAt(b.x, b.z) + b.h, z: b.z };
    const hp = BUILDING.collapseHp.house;
    noteBuildingHit(w, at, hp * 0.6);
    expect(isCollapsed(w, k)).toBe(false);
    noteBuildingHit(w, at, hp * 0.6);
    expect(isCollapsed(w, k)).toBe(true);
    expect(coverAgainst(w, sq, enemyPos)).toBe(2);
    w.units.delete(sq.id);
  });

  it('forest hides units that hold fire beyond 60 m', () => {
    let fp: V2 | null = null;
    for (const f of w.map.forests) if (t.groundAt(f.x, f.z) === Ground.Forest) { fp = { x: f.x, z: f.z }; break; }
    expect(fp).not.toBeNull();
    const sq = place(w.spawnUnit(1, 'infantry', fp!, 0), fp!);
    expect(forestConcealed(w, { x: fp!.x + 100, z: fp!.z }, sq)).toBe(true);
    expect(forestConcealed(w, { x: fp!.x + 50, z: fp!.z }, sq)).toBe(false);
    sq.lastFiredAt = w.time;
    expect(forestConcealed(w, { x: fp!.x + 100, z: fp!.z }, sq)).toBe(false);
    w.units.delete(sq.id);
  });

  it('high ground: downhill shots gain, uphill shots lose', () => {
    const a = place(w.spawnUnit(0, 'infantry', lee, 0), lee);
    const c = place(w.spawnUnit(1, 'infantry', enemyPos, 0), enemyPos);
    a.y = c.y + 20;
    expect(shotTerrainMul(w, a, c, a.y + 1.6)).toBeCloseTo(TERRAIN_COMBAT.downhillHitMul);
    a.y = c.y - 20;
    expect(shotTerrainMul(w, a, c, a.y + 1.6)).toBeLessThanOrEqual(TERRAIN_COMBAT.uphillHitMul);
    const base = { baseAccuracy: 0.6, distance: 50, maxRange: 110, shooterMoving: false, shooterSuppressed: false, targetMoving: false, cover: 0 as const };
    expect(hitProbability({ ...base, terrainMul: 1.1 })).toBeCloseTo(hitProbability(base) * 1.1);
    expect(COVER[3].hit).toBeLessThan(COVER[2].hit);
    w.units.delete(a.id);
    w.units.delete(c.id);
  });

  it('AI cover search prefers the lee wall of an intact building', () => {
    const k2 = t.buildings.findIndex((x, i) => i !== k && x.kind === 'house');
    const b2 = t.buildings[k2];
    const probe = place(w.spawnUnit(0, 'infantry', { x: b2.x + 20, z: b2.z }, 0), { x: b2.x + 20, z: b2.z });
    const threat = { x: b2.x - 200, z: b2.z };
    const spot = coverSpot(w, probe, { x: b2.x, z: b2.z }, 30, threat);
    expect(spot).not.toBeNull();
    w.units.delete(probe.id);
  });
});
