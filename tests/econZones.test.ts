import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step, type Match } from '../src/sim/sim';
import {
  damageZonesAt, econZonesSecond, startZone, upgradeZone, zoneJobCost, zoneOutput, zoneRules, zoneSiteFail, zoneStep, type EconZone,
} from '../src/sim/econZones';
import { INVEST_STYLE, investStyleOf, pickZoneSite, setInvestStyle } from '../src/sim/econZoneAi';
import { assignJob } from '../src/sim/structures';
import { profileOf } from '../src/sim/doctrines';
import type { V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** 3.0 engineer-built economic zones (econZones.ts, econZoneAi.ts; V30 §7). */
const data = loadGameData();

function setup(armyScale = 1): Match {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true, armyScale });
  // A few seconds so the ground picture (frontInfo) exists.
  for (let i = 0; i < 3 * m.world.tickHz; i++) {
    step(m);
    m.world.fx.length = 0;
  }
  return m;
}

function siteFor(w: World): V2 {
  const f = w.factions[0];
  const p = pickZoneSite(w, f, 1);
  if (p) return p;
  const hq = w.hqPos(0);
  for (let r = 300; r < 1200; r += 30) for (let a = 0; a < 6.3; a += 0.15) {
    const q = { x: hq.x + Math.cos(a) * r, z: hq.z + Math.sin(a) * r };
    if (zoneSiteFail(w, f, q) === null) return q;
  }
  throw new Error('no zone site');
}

function rich(w: World): void {
  w.factions[0].p = 5000;
  w.factions[0].m = 5000;
}

/** An engineer standing on the zone works it to completion. */
function build(w: World, z: EconZone): void {
  const u = w.spawnUnit(0, 'engineer', { x: z.pos.x + 2, z: z.pos.z + 2 }, w.factions[0].fronts[0].id);
  w.spatial.rebuild(w.aliveUnits);
  assignJob(w, u, z);
  for (let i = 0; i < 2000 && z.progress < 1; i++) {
    u.pos = { x: z.pos.x + 2, z: z.pos.z + 2 };
    expect(zoneStep(w, u, z.id)).toBe(true);
  }
}

describe('economic zones', () => {
  it('an engineer builds a level-1 zone that then pays; level-ups cost more and pay more up to the top level', () => {
    const { world: w } = setup();
    rich(w);
    const z = startZone(w, w.factions[0], siteFor(w)) as EconZone;
    expect(typeof z).toBe('object');
    expect(zoneOutput(w, z)).toEqual({ p: 0, m: 0 });
    build(w, z);
    expect(z.level).toBe(1);
    z.linked = true;
    const o1 = zoneOutput(w, z);
    expect(o1.m).toBeGreaterThan(0);
    const levels = zoneRules(w)!.levels.length;
    for (let lv = 2; lv <= levels; lv++) {
      expect(upgradeZone(w, w.factions[0], z)).toBeNull();
      expect(upgradeZone(w, w.factions[0], z)).toBe('BUSY');
      build(w, z);
      expect(z.level).toBe(lv);
    }
    z.linked = true;
    expect(zoneOutput(w, z).m).toBeGreaterThan(o1.m * 2);
    expect(upgradeZone(w, w.factions[0], z)).toBe('MAX_LEVEL');
  });

  it('an unlinked zone yields unlinked_output of a linked one; output falls with damage', () => {
    const { world: w } = setup();
    rich(w);
    const z = startZone(w, w.factions[0], siteFor(w)) as EconZone;
    build(w, z);
    z.linked = true;
    const full = zoneOutput(w, z).m;
    z.linked = false;
    expect(zoneOutput(w, z).m).toBeCloseTo(full * zoneRules(w)!.unlinked_output, 6);
    z.linked = true;
    z.hp = z.maxHp / 2;
    expect(zoneOutput(w, z).m).toBeCloseTo(full / 2, 6);
  });

  it('refuses sites in towns, next to another zone and on hostile ground', () => {
    const { world: w } = setup();
    rich(w);
    const f = w.factions[0];
    const town = w.objectives.find((o) => o.kind === 'town' || o.kind === 'city')!;
    expect(zoneSiteFail(w, f, town.pos)).not.toBeNull();
    const p = siteFor(w);
    startZone(w, f, p);
    expect(zoneSiteFail(w, f, { x: p.x + 20, z: p.z })).toBe('NEAR_ZONE');
    expect(zoneSiteFail(w, f, w.hqPos(1))).not.toBeNull();
  });

  it('is captured with the ground (HP capped), wrecked by shellfire and rebuilt at the ruin price', () => {
    const { world: w } = setup();
    rich(w);
    const z = startZone(w, w.factions[0], siteFor(w)) as EconZone;
    build(w, z);
    econZonesSecond(w, () => 1);
    expect(z.owner).toBe(1);
    expect(z.hp).toBeLessThanOrEqual(z.maxHp * zoneRules(w)!.captured_hp_ratio + 1e-6);
    econZonesSecond(w, () => 0);
    expect(z.owner).toBe(0);
    for (let i = 0; i < 50 && !z.ruined; i++) damageZonesAt(w, { x: z.pos.x, y: 0, z: z.pos.z }, 10, 400);
    expect(z.ruined).toBe(true);
    expect(zoneOutput(w, z)).toEqual({ p: 0, m: 0 });
    const r = zoneRules(w)!;
    expect(zoneJobCost(w, z)).toEqual({ p: Math.round(r.levels[0].cost_p * r.rebuild_cost_ratio), m: Math.round(r.levels[0].cost_m * r.rebuild_cost_ratio) });
    expect(upgradeZone(w, w.factions[0], z)).toBeNull();
    build(w, z);
    expect(z.ruined).toBe(false);
    expect(z.level).toBe(1);
  });

  it('investment style table: per-faction override for the doctrine wiring', () => {
    const { world: w } = setup();
    const f = w.factions[0];
    // 3.0 (WP-A): an AI's doctrine invest weight is its style once it has thought; else the personality table.
    expect(investStyleOf(f)).toBe(profileOf(w, f)?.invest ?? INVEST_STYLE[f.personality] ?? 1);
    setInvestStyle(f, 2.5);
    expect(investStyleOf(f)).toBe(2.5);
    expect(INVEST_STYLE.builder).toBeGreaterThan(INVEST_STYLE.blitz);
  });

  it('the AI founds zones (default army scale)', () => {
    const m = setup(data.rules.proposed_defaults.army_scale ?? 10);
    const w = m.world;
    for (let i = 0; i < 9 * 60 * w.tickHz; i++) {
      step(m);
      w.fx.length = 0;
    }
    expect(w.econZones.length).toBeGreaterThan(0);
  }, 300_000);
});
