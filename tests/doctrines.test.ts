import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { buildGameData } from '../src/data/loader';
import { createMatch } from '../src/sim/sim';
import {
  assignDoctrines, DOCTRINE_AB, DOCTRINE_IDS, doctrineCaps, doctrineKnown, doctrineWeights, frontDensity, investWeight, markContact,
  occupyWeight, profileOf, raidIntervalMul, retreatHp, temperamentBias,
} from '../src/sim/doctrines';
import { doctrineDirective, doctrinePhase } from '../src/sim/doctrineai';
import { thinkInvestment } from '../src/sim/econai';
import { investStyleOf } from '../src/sim/econZoneAi';
import type { DoctrineId } from '../src/sim/types';
import type { World } from '../src/sim/world';

const data = loadGameData();

function duel(doctrines: DoctrineId[], seed = 21, spectate = true): World {
  return createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate, doctrines }).world;
}

/** Keep only `keep` combat units of faction `f` alive (army ratio set-up). */
function thin(w: World, f: number, keep: number): void {
  let n = 0;
  for (const u of w.aliveUnits) {
    if (u.owner !== f || u.fixed || u.def.id === 'supply_truck' || u.def.id === 'commander') continue;
    if (n++ >= keep) u.hp = 0;
  }
}

const at = (w: World, s: number): void => { w.tick = Math.round(s * w.tickHz); };

describe('doctrines: assignment (V30_SPEC §1)', () => {
  it('draws all four different doctrines for a 4-FFA, deterministically per seed', () => {
    for (const seed of [1, 7, 11, 13, 99]) {
      const a = assignDoctrines(seed, 4);
      expect(new Set(a).size).toBe(4);
      expect(assignDoctrines(seed, 4)).toEqual(a);
    }
    // Different seeds do not all give the same order.
    const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => assignDoctrines(s, 4).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('keeps explicit choices and fills random slots with the doctrines left', () => {
    const a = assignDoctrines(7, 4, ['random', 'blitz', 'random', 'blitz']);
    expect(a[1]).toBe('blitz');
    expect(a[3]).toBe('blitz');
    expect(a[0]).not.toBe('blitz');
    expect(a[2]).not.toBe('blitz');
    expect(a[0]).not.toBe(a[2]);
  });

  it('createMatch gives every faction its doctrine and an AI the doctrine production flavour', () => {
    const w = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 13, difficulty: 'normal', playerSlot: 0, spectate: true }).world;
    expect(w.factions.map((f) => f.doctrine)).toEqual(assignDoctrines(13, 4));
    for (const f of w.factions) expect(f.personality).toBe(data.rules.doctrines!.profiles[f.doctrine].personality);
    expect(w.factions.every((f) => f.contactAt.length === 4 && f.contactAt.every((t) => t === -1))).toBe(true);
  });
});

describe('doctrines: profile levers', () => {
  it('invest share, occupation, retreat, density and temperament follow the profile; the player is never steered', () => {
    const w = duel(['builder', 'blitz']);
    const [builder, blitz] = w.factions;
    expect(investWeight(w, builder)).toBeGreaterThan(investWeight(w, blitz));
    expect(occupyWeight(w, builder)).toBeGreaterThan(occupyWeight(w, blitz));
    expect(temperamentBias(w, blitz)).toBeGreaterThan(0);
    const a = duel(['attrition', 'maneuver']);
    expect(retreatHp(a, 0)).toBeGreaterThan(data.rules.morale.auto_retreat_hp_ratio);
    expect(frontDensity(a, a.factions[0])).toBeGreaterThan(1);
    const p = duel(['attrition', 'blitz'], 21, false);
    expect(profileOf(p, p.factions[0])).toBeNull();
    expect(retreatHp(p, 0)).toBeNull();
    expect(investWeight(p, p.factions[0])).toBe(1);
  });

  it('the doctrine invest weight is the zone investment style of an AI (econZoneAi seam)', () => {
    const w = duel(['builder', 'blitz']);
    for (const f of w.factions) thinkInvestment(w, f);
    expect(investStyleOf(w.factions[0])).toBe(data.rules.doctrines!.profiles.builder.invest);
    expect(investStyleOf(w.factions[1])).toBe(data.rules.doctrines!.profiles.blitz.invest);
  });

  it('production weights and caps are scaled by the doctrine (blitz: motorized, attrition: guns)', () => {
    const w = duel(['blitz', 'attrition']);
    const base = data.rules.proposed_defaults.production_unit_weights;
    expect(doctrineWeights(w, w.factions[0], base).motor_inf).toBeGreaterThan(base.motor_inf);
    const caps = data.rules.proposed_defaults.production_unit_caps;
    expect(doctrineCaps(w, w.factions[1], caps).howitzer).toBeGreaterThan(caps.howitzer);
    expect(w.factions[0].caps.motor_inf).toBeGreaterThan(caps.motor_inf);
  });

  it('raid targeting: attrition raids convoys more often, builder never raids rail, maneuver never zones', () => {
    const w = duel(['attrition', 'builder']);
    expect(raidIntervalMul(w, w.factions[0], 'convoy')).toBeLessThan(1);
    expect(raidIntervalMul(w, w.factions[0], 'econ')).toBeLessThan(raidIntervalMul(w, w.factions[1], 'econ'));
    expect(raidIntervalMul(w, w.factions[1], 'rail')).toBe(Infinity);
    const m = duel(['maneuver', 'blitz']);
    expect(raidIntervalMul(m, m.factions[0], 'zone')).toBe(Infinity);
  });

  it('the lab switch turns every lever neutral', () => {
    const w = duel(['builder', 'attrition']);
    DOCTRINE_AB.on = false;
    try {
      expect(investWeight(w, w.factions[0])).toBe(1);
      expect(retreatHp(w, 1)).toBeNull();
      expect(raidIntervalMul(w, w.factions[1], 'convoy')).toBe(1);
      expect(doctrineDirective(w, w.factions[0])).toBeNull();
    } finally {
      DOCTRINE_AB.on = true;
    }
  });
});

describe('doctrines: directive choice', () => {
  it('outmatched: builder defends then contracts, attrition fortifies', () => {
    const w = duel(['builder', 'attrition']);
    at(w, 200);
    thin(w, 0, 8);
    w.spatial.rebuild(w.aliveUnits);
    const b = doctrineDirective(w, w.factions[0]);
    expect(['defend', 'contract']).toContain(b?.kind);
    thin(w, 0, 2);
    expect(doctrineDirective(w, w.factions[0])?.kind).toBe('contract');
    const a = duel(['attrition', 'builder']);
    at(a, 200);
    thin(a, 0, 6);
    expect(doctrineDirective(a, a.factions[0])?.kind).toBe('fortify');
  });

  it('even armies before the doctrine offensive: advance', () => {
    const w = duel(['blitz', 'maneuver']);
    at(w, 60);
    expect(doctrineDirective(w, w.factions[0])).toEqual({ kind: 'advance', axis: null });
    expect(doctrineDirective(w, w.factions[1])).toEqual({ kind: 'advance', axis: null });
  });

  it('blitz: at the force ratio with a full army, one deep offensive on the enemy capital; called off when spent', () => {
    const w = duel(['blitz', 'builder']);
    const p = data.rules.doctrines!.profiles.blitz.offensive;
    at(w, p.after_s + 10);
    thin(w, 1, 6);
    const f = w.factions[0];
    f.command.fullness = 0.95;
    const c = doctrineDirective(w, f);
    expect(c?.kind).toBe('offensive');
    expect(c?.axis).toEqual(w.hqPos(1));
    expect(doctrinePhase(f)).toMatchObject({ phase: 'offensive', target: 1 });
    // Still on a little later; spent (army below break_share) → re-arm.
    at(w, p.after_s + 40);
    expect(doctrineDirective(w, f)?.kind).toBe('offensive');
    thin(w, 0, 3);
    expect(doctrineDirective(w, f)?.kind).not.toBe('offensive');
    expect(doctrinePhase(f).phase).toBe('idle');
  });

  it('maneuver: no battle without an isolated enemy force it can beat', () => {
    const w = duel(['maneuver', 'blitz']);
    at(w, 400);
    w.factions[0].command.fullness = 0.9;
    // Even armies, enemy massed at home: no decisive battle.
    const c = doctrineDirective(w, w.factions[0]);
    expect(c?.kind).toBe('advance');
  });
});

describe('doctrines: discovery and rules', () => {
  it('an enemy doctrine is known after the first battle or after reveal_s', () => {
    const w = duel(['builder', 'blitz']);
    at(w, 10);
    expect(doctrineKnown(w, 0, 1)).toBe(false);
    markContact(w, 0, 1);
    expect(doctrineKnown(w, 0, 1)).toBe(true);
    expect(doctrineKnown(w, 1, 0)).toBe(true);
    const v = duel(['builder', 'blitz']);
    at(v, data.rules.doctrines!.reveal_s);
    expect(doctrineKnown(v, 0, 1)).toBe(true);
  });

  it('rules.json doctrines are validated (unknown unit, bad mode)', () => {
    const rd = (f: string): string => readFileSync(`docs/data/${f}`, 'utf8');
    const rules = JSON.parse(rd('rules.json'));
    expect(Object.keys(rules.doctrines.profiles).sort()).toEqual([...DOCTRINE_IDS].sort());
    const bad = structuredClone(rules);
    bad.doctrines.profiles.blitz.production.panzer = 2;
    expect(() => buildGameData(rd('units.csv'), rd('weapons.csv'), JSON.stringify(bad))).toThrow(/unknown unit/);
    const bad2 = structuredClone(rules);
    bad2.doctrines.profiles.maneuver.offensive.mode = 'yolo';
    expect(() => buildGameData(rd('units.csv'), rd('weapons.csv'), JSON.stringify(bad2))).toThrow(/offensive.mode/);
  });
});
