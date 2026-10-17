import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { CommandBus } from '../src/sim/commands';
import { cancelResearch, grantUpgrade, incomeSteady, nextWanted, researchBlock, startResearch, upgradeCost, upgradePriority, upgradeSecond, UPGRADE_IDS } from '../src/sim/upgrades';
import { classMask, isMotorized, refit, refitAtTown, staffThresholdMul, truckCapacityMul, UPG, workMul } from '../src/sim/upgradestats';
import { kitFire } from '../src/sim/upgradekit';
import { drawSecond } from '../src/sim/settlements';

const data = loadGameData();

const makeMatch = (seed = 21, spectate = false): ReturnType<typeof createMatch> => {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate });
  m.world.spatial.rebuild(m.world.aliveUnits);
  return m;
};

/** 3.0 unit upgrades (V30_SPEC §9, docs/UPGRADES.md). */
describe('3.0 unit upgrades', () => {
  it('has 10–14 items, each priced in rules.json, with rising tiers', () => {
    const r = data.rules.upgrades!;
    expect(UPGRADE_IDS.length).toBeGreaterThanOrEqual(10);
    expect(UPGRADE_IDS.length).toBeLessThanOrEqual(14);
    for (const id of UPGRADE_IDS) expect(r.items[id]).toBeDefined();
    expect(r.items.armour_2.p_k + r.items.armour_2.m_k).toBeGreaterThan(r.items.armour_1.p_k + r.items.armour_1.m_k);
    expect(r.items.gun_3.requires).toContain('gun_2');
  });

  it('purchase pays, the timer runs at the capital, completion grants; cancel refunds', () => {
    const m = makeMatch();
    const w = m.world;
    const f = w.factions[0];
    f.p = 5000;
    f.m = 5000;
    const c = upgradeCost(w, f, 'staff');
    const bus = new CommandBus();
    bus.issue(m, 0, { type: 'research', upgradeId: 'staff' });
    bus.flush(m);
    expect(f.upgrades.research?.id).toBe('staff');
    expect(f.p).toBeCloseTo(5000 - c.p);
    expect(f.m).toBeCloseTo(5000 - c.m);
    // One at a time; locked tiers need their predecessor.
    expect(researchBlock(w, f, 'gun_1')).toBe('RESEARCH_BUSY');
    expect(researchBlock(w, f, 'gun_2')).toBe('RESEARCH_BUSY');
    expect(staffThresholdMul(w, 0)).toBe(1);
    w.tick += Math.ceil(data.rules.upgrades!.items.staff.seconds * w.tickHz) + 1;
    upgradeSecond(w, f);
    expect(f.upgrades.research).toBeNull();
    expect(f.upgrades.owned & UPG.staff).not.toBe(0);
    expect(staffThresholdMul(w, 0)).toBeCloseTo(data.rules.upgrades!.effects.staff_threshold_mul);
    expect(researchBlock(w, f, 'staff')).toBe('OWNED');
    expect(researchBlock(w, f, 'gun_2')).toBe('LOCKED');
    // The next item is dearer (escalation).
    const g1 = upgradeCost(w, f, 'gun_1');
    expect(g1.m).toBeGreaterThan(Math.round(data.rules.upgrades!.items.gun_1.m_k * 2.5));
    const before = { p: f.p, m: f.m };
    expect(startResearch(w, f, 'gun_1')).toBeNull();
    expect(cancelResearch(w, f)).toBe(true);
    const k = data.rules.upgrades!.cancel_refund_ratio;
    expect(f.p).toBeCloseTo(before.p - g1.p * (1 - k));
    expect(f.m).toBeCloseTo(before.m - g1.m * (1 - k));
    expect(cancelResearch(w, f)).toBe(false);
  });

  it('refuses without the money', () => {
    const m = makeMatch();
    const f = m.world.factions[0];
    f.p = 0;
    f.m = 0;
    expect(startResearch(m.world, f, 'gun_1')).toBe('INSUFFICIENT_P');
    expect(f.upgrades.research).toBeNull();
  });

  it('stat layer: variants are cached, deterministic and keep the hp ratio; base defs untouched', () => {
    const m = makeMatch();
    const w = m.world;
    const base = data.units.get('medium_tank')!;
    const a = w.spawnUnit(0, 'medium_tank', w.cityOf(0).exit, 0);
    const b = w.spawnUnit(0, 'medium_tank', w.cityOf(0).exit, 0);
    a.hp = base.maxHp / 2;
    const bits = UPG.armour_1 | UPG.armour_2 | UPG.gun_1;
    refit(w, a, bits);
    refit(w, b, bits);
    expect(a.def).toBe(b.def);
    expect(a.primary).toBe(b.primary);
    const fx = data.rules.upgrades!.effects;
    expect(a.def.armorFront).toBe(Math.round(base.armorFront * (1 + 2 * fx.armour_per_level.armour)));
    expect(a.def.speed).toBeLessThan(base.speed);
    expect(a.primary!.penetration).toBe(data.weapons.get('medium_cannon')!.penetration + fx.gun_per_level.pen);
    expect(a.hp / a.def.maxHp).toBeCloseTo(0.5);
    expect(a.def.id).toBe('medium_tank');
    expect(data.units.get('medium_tank')!.armorFront).toBe(base.armorFront);
    refit(w, a, 0);
    expect(a.def).toBe(base);
  });

  it('new units roll out upgraded; tanks refit at a town, field items apply at once', () => {
    const m = makeMatch();
    const w = m.world;
    const f = w.factions[0];
    const old = w.spawnUnit(0, 'light_tank', w.cityOf(0).exit, 0);
    const eng = w.spawnUnit(0, 'engineer', w.cityOf(0).exit, 0);
    grantUpgrade(w, f, 'armour_1');
    grantUpgrade(w, f, 'eng_speed');
    grantUpgrade(w, f, 'truck_capacity');
    expect(old.upg).toBe(0);
    expect(eng.upg & UPG.eng_speed).not.toBe(0);
    expect(workMul(eng)).toBeCloseTo(data.rules.upgrades!.effects.eng_build_mul);
    expect(truckCapacityMul(w, 0)).toBeGreaterThan(1);
    const fresh = w.spawnUnit(0, 'light_tank', w.cityOf(0).exit, 0);
    expect(fresh.upg).toBe(UPG.armour_1);
    refitAtTown(w, old);
    expect(old.upg).toBe(UPG.armour_1 & classMask('light_tank'));
  });

  it('motorization: new rifle squads are motorized, old ones at a town rearm (drawSecond)', () => {
    const m = makeMatch();
    const w = m.world;
    const f = w.factions[0];
    const cap = w.places.find((p) => p.capitalOf === 0)!;
    const old = w.spawnUnit(0, 'infantry', cap.pos, 0);
    grantUpgrade(w, f, 'motorization');
    expect(isMotorized(old)).toBe(false);
    const fresh = w.spawnUnit(0, 'infantry', cap.pos, 0);
    expect(isMotorized(fresh)).toBe(true);
    w.spatial.rebuild(w.aliveUnits);
    cap.stock = Math.max(cap.stock, 100);
    drawSecond(w);
    expect(isMotorized(old)).toBe(true);
  });

  it('AP grenades hurt a close enemy tank (3.0.1: no attached gun team any more)', () => {
    const m = makeMatch();
    const w = m.world;
    const sq = w.spawnUnit(0, 'infantry', { x: 400, z: 400 }, 0);
    expect((UPG as Record<string, number>).inf_guns).toBeUndefined();
    refit(w, sq, UPG.ap_grenades);
    sq.ammo = 1;
    const tank = w.spawnUnit(1, 'light_tank', { x: 420, z: 400 }, 0);
    w.spatial.rebuild(w.aliveUnits);
    const hp0 = tank.hp;
    let hit = false;
    for (let i = 0; i < 40 && !hit; i++) {
      sq.upgNadeAt = 0;
      kitFire(w, sq);
      for (const f of w.deferred) f();
      w.deferred.length = 0;
      hit = tank.hp < hp0;
    }
    expect(hit).toBe(true);
    // No shell from the squad: the kit is grenades only.
    w.forts.push({ ...(w.forts.find((x) => x.owner === 1) ?? w.forts[0]), id: w.newId(), owner: 1, pos: { x: 560, z: 400 }, hp: 500, progress: 1 });
    sq.upgNadeAt = 0;
    const n = w.projectiles.length;
    kitFire(w, sq);
    expect(w.projectiles.length).toBe(n);
  });

  it('AI buyer saves a share of income and follows its priority table', () => {
    const m = makeMatch(21, true);
    const w = m.world;
    const f = w.factions[1];
    expect(upgradePriority(undefined, 'armor')[0]).toBe('gun_1');
    expect(upgradePriority('no_such_doctrine')).toEqual(upgradePriority());
    expect(nextWanted(f, data.rules.upgrades!)).toBe(upgradePriority(undefined, f.personality)[0]);
    expect(incomeSteady({ owned: 0, research: null, aiAt: 0, incomeSamples: [100, 80], want: null, fundP: 0, fundM: 0 }, 0.15)).toBe(false);
    // Rich and safe after the start delay: it ends up researching.
    for (let i = 0; i < (data.rules.upgrades!.ai.start_s + 5) * w.tickHz; i++) step(m);
    f.incomeP = 2000;
    f.incomeM = 2000;
    f.p = 20000;
    f.m = 20000;
    f.command.homeThreat.alert = false;
    f.upgrades.aiAt = 0;
    f.upgrades.incomeSamples = [];
    upgradeSecond(w, f);
    expect(f.upgrades.research).not.toBeNull();
  });
});
