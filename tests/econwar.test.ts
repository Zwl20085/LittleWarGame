import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { econSecond, startBuilding } from '../src/sim/econ';
import { ECON_WAR, econWorth, pickRaidTarget, planEconRaids, raidValue } from '../src/sim/econwar';
import { investAppetite } from '../src/sim/econai';
import { placeOwner } from '../src/sim/settlements';
import type { EconBuilding, Place } from '../src/sim/types';
import type { World } from '../src/sim/world';

const data = loadGameData();

function makeWorld(): World {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 21, difficulty: 'normal', playerSlot: 0, spectate: true });
  return m.world;
}

const sites = (w: World, f: number): Place[] => w.places.filter((p) => p.slotPos.length > 0 && placeOwner(w, p) === f);

function build(w: World, f: number, p: Place, kind: 'factory' | 'recruit' | 'depot'): EconBuilding {
  const fac = w.factions[f];
  fac.p = 5000;
  fac.m = 5000;
  const b = startBuilding(w, fac, p.id, kind) as EconBuilding;
  b.progress = 1;
  b.hp = b.maxHp;
  return b;
}

/** Pretend faction 0's front line runs through `p` (frontInfo cells). */
function frontAt(w: World, p: { x: number; z: number }): void {
  w.frontInfo[0] = { ...w.frontInfo[0], cells: [{ x: p.x, z: p.z }] };
}

describe('2.2 economic raids (V22_SPEC §5, AI)', () => {
  it('raid value: factories over depots, finished over sites, healthy over damaged', () => {
    const base = { id: 1, placeId: 'x', slot: 0, pos: { x: 0, z: 0 }, facing: 0, owner: 1, maxHp: 1000, ruined: false };
    const f = { ...base, kind: 'factory' as const, hp: 1000, progress: 1 };
    expect(raidValue(f)).toBeGreaterThan(raidValue({ ...f, kind: 'depot' }));
    expect(raidValue(f)).toBeGreaterThan(raidValue({ ...f, progress: 0.5 }));
    expect(raidValue(f)).toBeGreaterThan(raidValue({ ...f, hp: 200 }));
  });

  it('targets the valuable, weakly defended building near our front; skips one that is too well defended', () => {
    const w = makeWorld();
    const a = sites(w, 1)[0];
    // A second town for faction 1: the neutral / enemy town nearest its first one.
    const b = w.places.filter((p) => p.slotPos.length > 0 && p !== a && placeOwner(w, p) !== 0)
      .sort((x, y) => Math.hypot(x.pos.x - a.pos.x, x.pos.z - a.pos.z) - Math.hypot(y.pos.x - a.pos.x, y.pos.z - a.pos.z))[0];
    w.objectives[b.objIdx].owner = 1;
    const fa = build(w, 1, a, 'factory');
    const fb = build(w, 1, b, 'factory');
    frontAt(w, { x: (a.pos.x + b.pos.x) / 2, z: (a.pos.z + b.pos.z) / 2 });
    w.spatial.rebuild(w.aliveUnits);
    // Defend A heavily: the raid goes for B.
    for (let i = 0; i < 6; i++) w.spawnUnit(1, 'infantry', { x: fa.pos.x + i * 3, z: fa.pos.z }, w.factions[1].fronts[0].id);
    w.spatial.rebuild(w.aliveUnits);
    const pick = pickRaidTarget(w, w.factions[0], 300);
    expect(pick?.b.id).toBe(fb.id);
    // B defended too, beyond maxDefence × the party: nothing worth the cost.
    for (let i = 0; i < 6; i++) w.spawnUnit(1, 'infantry', { x: fb.pos.x + i * 3, z: fb.pos.z }, w.factions[1].fronts[0].id);
    w.spatial.rebuild(w.aliveUnits);
    expect(pickRaidTarget(w, w.factions[0], 300)).toBeNull();
  });

  it('a building far beyond our front is out of reach', () => {
    const w = makeWorld();
    const [a] = sites(w, 1);
    build(w, 1, a, 'factory');
    frontAt(w, { x: a.pos.x + ECON_WAR.rangeM + 300, z: a.pos.z });
    w.spatial.rebuild(w.aliveUnits);
    expect(pickRaidTarget(w, w.factions[0], 300)).toBeNull();
  });

  it('launches a small party (2–4 squads) that demolishes the building', () => {
    const w = makeWorld();
    const [a] = sites(w, 1);
    const b = build(w, 1, a, 'factory');
    const f = w.factions[0];
    frontAt(w, b.pos);
    for (let i = 0; i < 6; i++) w.spawnUnit(0, i === 0 ? 'engineer' : 'infantry', { x: b.pos.x - 200 + i * 6, z: b.pos.z }, f.fronts[0].id);
    for (const u of w.aliveUnits) if (u.owner === 0) { u.behavior = 'advance'; u.ammo = 1; }
    w.spatial.rebuild(w.aliveUnits);
    w.tick = (ECON_WAR.firstS + 1) * w.tickHz;
    f.command.fullness = 0.9;
    planEconRaids(w, f);
    const party = w.aliveUnits.filter((u) => u.owner === 0 && u.opRole === 'raid');
    expect(party.length).toBeGreaterThanOrEqual(ECON_WAR.partyMin);
    expect(party.length).toBeLessThanOrEqual(ECON_WAR.partyMax);
    expect(party.some((u) => u.def.id === 'engineer')).toBe(true);
    // At the building, the party demolishes it (econ.econSecond).
    for (const u of party) u.pos = { x: b.pos.x + 3, z: b.pos.z };
    w.spatial.rebuild(w.aliveUnits);
    for (let i = 0; i < 200 && !b.ruined; i++) econSecond(w);
    expect(b.ruined).toBe(true);
  });

  it('a town with economic buildings is worth defending; appetite falls to 0 under a defend directive', () => {
    const w = makeWorld();
    const [a] = sites(w, 0);
    expect(econWorth(w, a.id, 0)).toBe(0);
    build(w, 0, a, 'recruit');
    expect(econWorth(w, a.id, 0)).toBeGreaterThan(0);
    const f = w.factions[0];
    expect(investAppetite(w, f).appetite).toBeGreaterThan(0);
    f.directive = { kind: 'defend', axis: null, line: null, issuedAt: 0, manual: false };
    expect(investAppetite(w, f).appetite).toBe(0);
  });
});
