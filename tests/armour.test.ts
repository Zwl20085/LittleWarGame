import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { ARMOUR, armourFront, blockGoal, paceArmour } from '../src/sim/armour';
import { pickFront } from '../src/sim/production';
import { ARTY, shellWorth } from '../src/sim/combat';
import type { Unit } from '../src/sim/types';
import { dist, type V2 } from '../src/sim/vec';

const data = loadGameData();

function world() {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 21, difficulty: 'normal', playerSlot: 0, spectate: false });
  return m.world;
}

/** Fake unit at a position (blockGoal only reads pos). */
const at = (x: number, z: number): Unit => ({ pos: { x, z } }) as unknown as Unit;
const plan = (pushing: boolean) => ({ front: { x: 0, z: 0 } as V2, facing: 0, pushing });

describe('2.2 armour tactics (V22_SPEC §7)', () => {
  it('holding: the tanks wait as one reserve behind the line centre', () => {
    const st = { assembleSince: -1, committed: false };
    const g = blockGoal([at(0, 0), at(30, 10), at(-50, 0)], [at(0, 0)], plan(false), st, 100);
    expect(g.mode).toBe('reserve');
    expect(g.pos.x).toBeCloseTo(-ARMOUR.reserveBackM, 6);
  });

  it('an armoured group assembles before it commits, then leads the infantry', () => {
    const st = { assembleSince: -1, committed: false };
    // Strung out: one tank 400 m ahead of the other two → assemble behind the line, no dribbling forward.
    const strung = [at(-100, 0), at(-90, 10), at(300, 0)];
    const foot = [at(-20, 0), at(-10, 5), at(0, -5), at(5, 0)];
    const a = blockGoal(strung, foot, plan(true), st, 100);
    expect(a.mode).toBe('assemble');
    expect(a.pos.x).toBeLessThan(0);
    // Assembled → commits and leads the foot by leadM (75th percentile of their progress + leadM, capped at the front + leadM).
    const together = [at(-100, 0), at(-90, 10), at(-80, -10)];
    const b = blockGoal(together, foot, plan(true), st, 110);
    expect(b.mode).toBe('lead');
    expect(st.committed).toBe(true);
    expect(b.pos.x).toBeCloseTo(ARMOUR.leadM, 6);
    // Infantry still far back: the block stays leadM ahead of them, not at the front point.
    const back = [at(-300, 0), at(-280, 0), at(-260, 0), at(-250, 0)];
    const c = blockGoal(together, back, plan(true), st, 112);
    expect(c.pos.x).toBeCloseTo(-250 + ARMOUR.leadM, 6);
  });

  it('a waiting assembly goes anyway after assembleMaxS', () => {
    const st = { assembleSince: -1, committed: false };
    const strung = [at(-100, 0), at(200, 0), at(500, 0)];
    expect(blockGoal(strung, [], plan(true), st, 10).mode).toBe('assemble');
    expect(blockGoal(strung, [], plan(true), st, 10 + ARMOUR.assembleMaxS).mode).toBe('lead');
  });

  it('fewer than minGroup tanks never attack alone: they lead infantry or stay in reserve', () => {
    const st = { assembleSince: -1, committed: false };
    const two = [at(0, 0), at(10, 0)];
    expect(blockGoal(two, [], plan(true), st, 0).mode).toBe('reserve');
    expect(blockGoal(two, [at(-40, 0), at(-30, 0)], plan(true), st, 0).mode).toBe('lead');
  });

  it('spearhead tanks wait for their riflemen (paceArmour)', () => {
    const w = world();
    const goal = { x: 1500, z: 1500 };
    const tank = w.spawnUnit(0, 'medium_tank', { x: 1400, z: 1500 }, w.factions[0].fronts[0].id);
    const rifle = w.spawnUnit(0, 'infantry', { x: 1100, z: 1500 }, w.factions[0].fronts[0].id);
    tank.spearhead = 'x';
    rifle.spearhead = 'x';
    expect(paceArmour(w, tank, goal)).toBe(true);
    rifle.pos = { x: 1380, z: 1500 };
    w.tick += w.tickHz; // next pacing sample
    expect(paceArmour(w, tank, goal)).toBe(false);
    expect(dist(tank.pos, goal)).toBeGreaterThan(0);
  });

  it('under an offensive new tanks go to the main effort; other units follow the shares', () => {
    const w = world();
    const f = w.factions[0];
    expect(f.fronts.length).toBeGreaterThan(1);
    const main = f.fronts[f.fronts.length - 1];
    f.mainFront = main.id;
    for (const s of f.fronts) s.share = s === main ? 0 : 1;
    f.directive = { kind: 'offensive', axis: null, line: null, issuedAt: 0, manual: true };
    expect(armourFront(w, f)).toBe(main.id);
    expect(pickFront(w, f, 'medium_tank')).toBe(main.id);
    expect(pickFront(w, f, 'infantry')).not.toBe(main.id);
    f.directive = { kind: 'contract', axis: null, line: null, issuedAt: 0, manual: true };
    expect(armourFront(w, f)).toBe(-1);
  });
});

describe('2.2 artillery conserves shells (wave 2)', () => {
  it('a lone squad inside a building or a lone vehicle is not worth a shell; an exposed group is', () => {
    expect(shellWorth(0.8, true, 0)).toBeLessThan(ARTY.minWorth);
    expect(shellWorth(0.25, false, 0)).toBeLessThan(ARTY.minWorth);
    expect(shellWorth(0.8, false, 0)).toBeGreaterThan(ARTY.minWorth + ARTY.lowAmmoExtra);
    expect(shellWorth(0.8, true, 1)).toBeGreaterThan(ARTY.minWorth);
    expect(shellWorth(1, false, 1)).toBeGreaterThan(shellWorth(0.8, false, 0));
  });
});
