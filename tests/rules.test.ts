import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { buildGameData } from '../src/data/loader';
import { arcClear, arcPoint, solveArc } from '../src/sim/ballistics';
import { economyRates, nodeBonus, stewardStep, trySpend } from '../src/sim/economy';
import { armorFacing, blastFalloff, firepowerScale, hitProbability, penetrationProbability } from '../src/sim/formulas';
import { allocateSupply } from '../src/sim/supply';
import { createMatch } from '../src/sim/sim';
import type { Faction } from '../src/sim/types';
import { DEG } from '../src/sim/vec';

const data = loadGameData();
const rules = data.rules;

function faction(over: Partial<Faction> = {}): Faction {
  const m = createMatch(data, { mapId: 'greystone_pinecreek', factions: 2, infoMode: 'open', seed: 1, difficulty: 'normal', playerSlot: 0, armyScale: 1 });
  return { ...m.world.factions[0], ...over };
}

describe('data loading (AGENT_HANDOFF §2)', () => {
  it('loads all 13 units (incl. motorized rifles and the front commander) and 12 weapons with valid references', () => {
    expect(data.units.size).toBe(13);
    expect(data.weapons.size).toBe(12);
  });
  it('reports the offending field when a value is missing', () => {
    const units = 'id,label_zh,kind,facility,cost_p,cost_m,population,supply_demand,build_seconds,unlock_seconds,max_hp,member_count,speed_mps,vision_m,primary_weapon,secondary_weapon,armor_front,armor_side,armor_rear,max_slope_deg,hull_turn_degps,turret_turn_degps,setup_seconds,pack_seconds\nx,X,infantry,barracks,,1,1,1,1,0,10,1,1,1,,,0,0,0,1,1,0,0,0';
    const weapons = 'id,label_zh,fire_mode,range_m,min_range_m,interval_seconds,damage,penetration,accuracy,blast_radius_m,suppression,can_fire_moving,ammo_cost,muzzle_speed_mps,min_elevation_deg,max_elevation_deg\n';
    expect(() => buildGameData(units, weapons + 'w,W,hitscan,1,0,1,1,1,1,0,0,true,0,0,0,0', JSON.stringify(rules))).toThrow(/cost_p/);
  });
  it('rejects unknown weapon references', () => {
    const units = 'id,label_zh,kind,facility,cost_p,cost_m,population,supply_demand,build_seconds,unlock_seconds,max_hp,member_count,speed_mps,vision_m,primary_weapon,secondary_weapon,armor_front,armor_side,armor_rear,max_slope_deg,hull_turn_degps,turret_turn_degps,setup_seconds,pack_seconds\nx,X,infantry,barracks,1,1,1,1,1,0,10,1,1,1,nope,,0,0,0,1,1,0,0,0';
    const weapons = 'id,label_zh,fire_mode,range_m,min_range_m,interval_seconds,damage,penetration,accuracy,blast_radius_m,suppression,can_fire_moving,ammo_cost,muzzle_speed_mps,min_elevation_deg,max_elevation_deg\nw,W,hitscan,1,0,1,1,1,1,0,0,true,0,0,0,0';
    expect(() => buildGameData(units, weapons, JSON.stringify({ ...rules, proposed_defaults: { ...rules.proposed_defaults, production_unit_weights: {} } }))).toThrow(/unknown weapon/);
  });
});

describe('economy (BALANCE_SPEC §2)', () => {
  it('default allocation yields P 123 / M 111 / L 46 / build ×1.0204', () => {
    const r = economyRates([0.35, 0.45, 0.2], rules);
    expect(r.pPerMin).toBeCloseTo(123);
    expect(r.mPerMin).toBeCloseTo(111);
    expect(r.logistics).toBeCloseTo(46);
    expect(r.buildTimeMul).toBeCloseTo(1.0204, 3);
  });
  it('E01: two purchases against stock for one — only one succeeds, never negative', () => {
    const f = faction({ p: 100, m: 50 });
    expect(trySpend(f, 70, 10).ok).toBe(true);
    const second = trySpend(f, 70, 10);
    expect(second.ok).toBe(false);
    expect(f.p).toBeCloseTo(30);
    expect(f.m).toBeCloseTo(40);
  });
  it('node bonus has diminishing returns and caps', () => {
    expect(nodeBonus(1, 0, rules).p).toBe(20);
    expect(nodeBonus(2, 0, rules).p).toBe(34);
    expect(nodeBonus(5, 0, rules).p).toBe(40);
    expect(nodeBonus(0, 3, rules).m).toBe(30);
  });
  it('E03: steward keeps sum = 1, min 15 %, and never touches locked shares', () => {
    let f = faction({ locks: [false, true, false] });
    const locked = f.alloc[1];
    for (let k = 0; k < 120; k++) {
      stewardStep(f, { needP60: 900, needM60: 50, incomeP60: 100, incomeM60: 100, forecastDemand: 10, logistics: 46, now: k * 5 }, rules);
      const sum = f.alloc[0] + f.alloc[1] + f.alloc[2];
      expect(sum).toBeCloseTo(1, 9);
      expect(Math.min(...f.alloc)).toBeGreaterThanOrEqual(0.15 - 1e-9);
      expect(f.alloc[1]).toBeCloseTo(locked, 9);
    }
    expect(f.alloc[0]).toBeGreaterThan(0.35);
    f = faction({ locks: [true, true, true] });
    expect(stewardStep(f, { needP60: 900, needM60: 900, incomeP60: 0, incomeM60: 0, forecastDemand: 90, logistics: 46, now: 0 }, rules).changed).toBe(false);
  });
  it('steward does not reverse a shift within the 15 s hold', () => {
    const f = faction();
    const first = stewardStep(f, { needP60: 900, needM60: 0, incomeP60: 0, incomeM60: 0, forecastDemand: 0, logistics: 46, now: 0 }, rules);
    expect([first.from, first.to]).toEqual([2, 0]);
    // L shortfall below the 30 % emergency threshold, so the hold applies.
    const reverse = { needP60: 0, needM60: f.m + 25, incomeP60: 0, incomeM60: 0, forecastDemand: 60, logistics: 46 };
    expect(stewardStep(f, { ...reverse, now: 5 }, rules).changed).toBe(false);
    const later = stewardStep(f, { ...reverse, now: 20 }, rules);
    expect([later.from, later.to]).toEqual([0, 2]);
  });
});

describe('combat formulas (BALANCE_SPEC §4)', () => {
  it('rifle at 100 m vs static open target ≈ .381 (spec §11.2)', () => {
    const p = hitProbability({ baseAccuracy: 0.65, distance: 100, maxRange: 110, shooterMoving: false, shooterSuppressed: false, targetMoving: false, cover: 0 });
    expect(p).toBeCloseTo(0.65 * (1 - 0.5 * (100 / 110) ** 2), 6);
    expect(p).toBeCloseTo(0.381, 2);
  });
  it('pHit is clamped to [.05, .95]', () => {
    expect(hitProbability({ baseAccuracy: 0.01, distance: 200, maxRange: 200, shooterMoving: true, shooterSuppressed: true, targetMoving: true, cover: 3 })).toBe(0.05);
  });
  it('penetration: medium vs heavy front ≈ .05, side ≈ .667; small arms 0', () => {
    expect(penetrationProbability(100, 140)).toBe(0.05);
    expect(penetrationProbability(100, 90)).toBeCloseTo(0.667, 2);
    expect(penetrationProbability(8, 25)).toBe(0);
    expect(penetrationProbability(10, 95)).toBe(0);
  });
  it('C02: armour facing by attack bearing vs hull heading', () => {
    expect(armorFacing(0, 0)).toBe('front');
    expect(armorFacing(0, 59 * DEG)).toBe('front');
    expect(armorFacing(0, 90 * DEG)).toBe('side');
    expect(armorFacing(0, 180 * DEG)).toBe('rear');
    expect(armorFacing(0, -140 * DEG)).toBe('rear');
  });
  it('HE falloff is quadratic and zero outside radius', () => {
    expect(blastFalloff(0, 10)).toBe(1);
    expect(blastFalloff(5, 10)).toBeCloseTo(0.75);
    expect(blastFalloff(12, 10)).toBe(0);
  });
  it('squad firepower scales with surviving members; crew floor .5', () => {
    const inf = data.units.get('infantry')!;
    expect(firepowerScale(inf, 800, 800)).toBe(1);
    expect(firepowerScale(inf, 400, 800)).toBe(0.5);
    const mg = data.units.get('mg')!;
    expect(firepowerScale(mg, 50, 400)).toBe(0.5);
  });
});

describe('ballistics (BALANCE_SPEC §8.1, C04)', () => {
  const g = 9.81;
  it('solved arc lands on the target point', () => {
    const p0 = { x: 0, y: 10, z: 0 };
    const p1 = { x: 250, y: 30, z: 100 };
    const res = solveArc(p0, p1, 62, g, 45, 85, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const end = arcPoint(p0, res.sol.vel, g, res.sol.tFlight);
    expect(end.x).toBeCloseTo(p1.x, 3);
    expect(end.y).toBeCloseTo(p1.y, 3);
    expect(end.z).toBeCloseTo(p1.z, 3);
    expect(res.sol.thetaRad).toBeGreaterThan(45 * DEG);
  });
  it('reports no solution beyond physical reach', () => {
    const res = solveArc({ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }, 62, g, 45, 85, true);
    expect(res.ok).toBe(false);
  });
  it('high mortar arc clears a ridge the low howitzer arc would hit', () => {
    const ridge = (x: number): number => (x > 90 && x < 110 ? 40 : 0);
    const p0 = { x: 0, y: 1, z: 0 };
    const p1 = { x: 200, y: 0, z: 0 };
    const hi = solveArc(p0, p1, 62, g, 45, 85, true);
    const lo = solveArc(p0, p1, 100, g, 15, 75, false);
    expect(hi.ok && arcClear(p0, hi.sol, g, ridge)).toBe(true);
    expect(lo.ok && arcClear(p0, lo.sol, g, ridge)).toBe(false);
  });
});

describe('supply allocation (BALANCE_SPEC §6.2, S01)', () => {
  it('never exceeds needs or L, and wastes nothing when L < total need', () => {
    const needs = [1, 4, 2, 6];
    const alloc = allocateSupply(needs, [1, 1.25, 1, 1], 10);
    alloc.forEach((a, i) => expect(a).toBeLessThanOrEqual(needs[i] + 1e-9));
    expect(alloc.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 6);
  });
  it('fully satisfies everyone when L is ample', () => {
    const alloc = allocateSupply([1, 2, 3], [1, 1, 1], 100);
    expect(alloc).toEqual([1, 2, 3]);
  });
});
