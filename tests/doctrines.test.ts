import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { buildGameData } from '../src/data/loader';
import { createMatch } from '../src/sim/sim';
import {
  assignDoctrines, DOCTRINE_AB, DOCTRINE_IDS, doctrineCaps, doctrineKnown, doctrineWeights, frontDensity, investWeight, markContact,
  occupyWeight, picketGapMul, profileOf, raidIntervalMul, raidsHeld, retreatHp, retreatHpOf, temperamentBias, DOCTRINE_RAID,
} from '../src/sim/doctrines';
import { picketGap } from '../src/sim/pickets';
import { pointAlong, railSecond } from '../src/sim/rail';
import { cutByRaid, pickRailTarget, RAIL_RAID, RAIL_RAID_STATS, railRaider } from '../src/sim/railraid';
import { completeJob, startRailRepair } from '../src/sim/transportjobs';
import type { RailLine } from '../src/sim/transportstate';
import { nextWanted, upgradePriority } from '../src/sim/upgrades';
import { dist, type V2 } from '../src/sim/vec';
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

describe('doctrines: seams wired (WP-Y)', () => {
  /** A 4-FFA with attrition in slot 0 and builder in slot 1 (spectated: every slot is an AI; seed 7 has town-to-town lines). */
  const ffa = (): World => createMatch(data, {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true,
    doctrines: ['attrition', 'builder', 'blitz', 'maneuver'],
  }).world;

  /** The longest line between two towns, held by faction f (rail.ts state refreshed). */
  function heldLine(w: World, f: number): RailLine {
    const st = w.transport!;
    const line = [...st.lines].sort((a, b) => b.len - a.len || a.id - b.id).find((l) => st.stations[l.a].placeIdx >= 0 && st.stations[l.b].placeIdx >= 0)!;
    for (const sid of [line.a, line.b]) w.objectives[st.stations[sid].placeIdx].owner = f;
    w.tick = Math.ceil(w.tick / 40 + 1) * 40;
    railSecond(w, null);
    return line;
  }

  const frontAt = (w: World, f: number, cells: V2[]): void => {
    w.frontInfo[f] = { cells, enemyDist: new Float32Array(1), nx: 1, nz: 1, cell: 1 };
  };

  it('rail raids: only a doctrine with rail weight raids rail; the target is an enemy-held line near our front', () => {
    const w = ffa();
    expect(railRaider(w, w.factions[0])).toBe(true);
    for (const f of w.factions.slice(1)) expect(railRaider(w, f)).toBe(false);
    const line = heldLine(w, 1);
    expect(line.heldBy).toBe(1);
    const mid = pointAlong(line.pts, line.cum, line.len / 2);
    frontAt(w, 0, [{ x: mid.x + 200, z: mid.z }]);
    const pick = pickRailTarget(w, w.factions[0], 400);
    expect(pick).not.toBeNull();
    expect(pick!.line).toBe(line.id);
    expect(dist(pick!.pos, pick!.cell)).toBeLessThanOrEqual(RAIL_RAID.rangeM);
    // Too far from our front, our own line, or a line already cut: not a target.
    const far = RAIL_RAID.rangeM + line.len;
    frontAt(w, 0, [{ x: mid.x + far, z: mid.z + far }]);
    expect(pickRailTarget(w, w.factions[0], 400)?.line).not.toBe(line.id);
    frontAt(w, 1, [{ x: mid.x + 200, z: mid.z }]);
    expect(pickRailTarget(w, w.factions[1], 400)?.line).not.toBe(line.id);
    line.cut = true;
    expect(pickRailTarget(w, w.factions[0], 400)?.line).not.toBe(line.id);
    line.cut = false;
  });

  it('rail raids: a cut by raiders stops the trains and goes through the normal engineer repair', () => {
    const w = ffa();
    const line = heldLine(w, 1);
    expect(line.owner).toBe(1);
    const before = RAIL_RAID_STATS.cuts ?? 0;
    expect(cutByRaid(w, 0, line.id, -1)).toBe(1);
    expect(RAIL_RAID_STATS.cuts).toBe(before + 1);
    expect(line.cut).toBe(true);
    // A cut line is not cut twice; the holder's own raiders never cut it.
    expect(cutByRaid(w, 0, line.id, -1)).toBe(0);
    w.tick += 40;
    railSecond(w, null);
    expect(line.owner).toBe(-1);
    w.factions[1].p = 1e5;
    w.factions[1].m = 1e5;
    const job = startRailRepair(w, 1, line.id);
    expect(job.ok).toBe(true);
    if (job.ok) completeJob(w, job.job);
    w.tick += 40;
    railSecond(w, null);
    expect(line.cut).toBe(false);
    expect(line.owner).toBe(1);
    expect(cutByRaid(w, 1, line.id, -1)).toBe(0);
    // At a station every hostile whole line through it is cut.
    const st = w.transport!;
    const hostile = st.stations[line.a].lines.filter((id) => !st.lines[id].cut && st.lines[id].heldBy >= 0 && w.isHostile(0, st.lines[id].heldBy)).length;
    expect(cutByRaid(w, 0, line.id, line.a)).toBe(hostile);
    expect(line.cut).toBe(true);
  });

  it('picket spacing: attrition pickets tighter, maneuver looser, builder / blitz / the player / doctrines off neutral', () => {
    const w = ffa();
    const [attrition, builder, blitz, maneuver] = w.factions;
    expect(picketGapMul(w, attrition)).toBeLessThan(1);
    expect(picketGapMul(w, maneuver)).toBeGreaterThan(1);
    expect(picketGapMul(w, builder)).toBe(1);
    expect(picketGapMul(w, blitz)).toBe(1);
    const r = w.data.rules.infiltration!;
    expect(picketGap(r, 0, picketGapMul(w, attrition))).toBeLessThan(picketGap(r, 0));
    expect(picketGap(r, 0, picketGapMul(w, maneuver))).toBeGreaterThan(picketGap(r, 0));
    const p = duel(['attrition', 'blitz'], 21, false);
    expect(picketGapMul(p, p.factions[0])).toBe(1);
    DOCTRINE_AB.on = false;
    try {
      expect(picketGapMul(w, attrition)).toBe(1);
    } finally {
      DOCTRINE_AB.on = true;
    }
  });

  it('upgrades: a doctrine AI buys in its doctrine order (rules profile = upgrades.ts row); doctrines off = personality row', () => {
    const w = ffa();
    for (const f of w.factions) {
      expect(upgradePriority(f.doctrine)).toEqual(data.rules.doctrines!.profiles[f.doctrine].upgrades);
      expect(nextWanted(f, data.rules.upgrades!, w)).toBe(upgradePriority(f.doctrine)[0]);
    }
    DOCTRINE_AB.on = false;
    try {
      const f = w.factions[0];
      expect(nextWanted(f, data.rules.upgrades!, w)).toBe(upgradePriority(undefined, f.personality)[0]);
    } finally {
      DOCTRINE_AB.on = true;
    }
  });

  it('home-defence reserve: capital guards keep the rules retreat threshold; no new raid on alert or past the raid share', () => {
    const w = ffa();
    const dflt = w.data.rules.morale.auto_retreat_hp_ratio;
    const f = w.factions[0];
    const u = [...w.aliveUnits].find((x) => x.owner === 0 && x.def.id === 'infantry')!;
    u.opRole = 'line';
    u.opObjective = null;
    expect(retreatHpOf(w, u)).toBe(retreatHp(w, 0));
    expect(retreatHpOf(w, u)).toBeGreaterThan(dflt);
    u.opRole = 'garrison';
    u.opObjective = 'hq:0';
    expect(retreatHpOf(w, u)).toBe(dflt);
    // A town garrison is not a capital guard.
    u.opObjective = 'obj:3';
    expect(retreatHpOf(w, u)).toBe(retreatHp(w, 0));
    expect(raidsHeld(w, f)).toBe(false);
    f.command.homeThreat.alert = true;
    expect(raidsHeld(w, f)).toBe(true);
    f.command.homeThreat.alert = false;
    const army = [...w.aliveUnits].filter((x) => x.owner === 0 && !x.fixed && x.def.id !== 'supply_truck' && x.def.id !== 'commander');
    for (const x of army.slice(0, Math.ceil(army.length * DOCTRINE_RAID.maxShare))) x.opRole = 'raid';
    expect(raidsHeld(w, f)).toBe(true);
    // The player is never held by a doctrine (2.2 raid rules only).
    const p = duel(['attrition', 'blitz'], 21, false);
    p.factions[0].command.homeThreat.alert = true;
    expect(raidsHeld(p, p.factions[0])).toBe(false);
  });
});
