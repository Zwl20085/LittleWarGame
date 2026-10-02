import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { slotsFor } from '../src/sim/production';
import { buildFrontInfo, enemyDistance } from '../src/sim/frontai';
import { NEUTRAL } from '../src/sim/frontline';

const data = loadGameData();

describe('territory', () => {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 21, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  it('every settlement is a capturable place and each side starts with nearby ones', () => {
    expect(w.objectives.length).toBeGreaterThan(10);
    expect(w.objectives.some((o) => o.strategic)).toBe(true);
    for (const f of w.factions) expect(w.objectives.some((o) => o.owner === f.id)).toBe(true);
  });
  it('capturing a town adds production slots', () => {
    const f = w.factions[0];
    const before = slotsFor(w, f, 'barracks');
    const town = w.objectives.find((o) => o.kind === 'town' && o.owner !== 0) ?? w.objectives.find((o) => o.kind === 'city' && o.owner !== 0)!;
    town.owner = 0;
    expect(slotsFor(w, f, 'barracks')).toBeGreaterThan(before);
  });
  it('front analysis: distance to hostile ground is 0 inside enemy territory and grows behind our lines', () => {
    for (let i = 0; i < 20 * 4; i++) step(m);
    const owner = m.front.owner;
    owner.fill(NEUTRAL);
    // Left half ours, right half theirs.
    for (let j = 0; j < m.front.nz; j++) for (let i = 0; i < m.front.nx; i++) owner[j * m.front.nx + i] = i < m.front.nx / 2 ? 0 : 1;
    w.frontInfo = buildFrontInfo(w, m.front);
    const mid = (m.front.nx / 2) * m.front.cell;
    expect(enemyDistance(w, 0, { x: mid + 50, z: 400 })).toBe(0);
    expect(enemyDistance(w, 0, { x: mid - 300, z: 400 })).toBeGreaterThan(250);
    expect(w.frontInfo[0].cells.length).toBeGreaterThan(10);
  });
});
