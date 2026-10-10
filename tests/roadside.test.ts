import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { generateMap } from '../src/sim/mapgen';
import { Ground, Terrain, type Building } from '../src/sim/terrain';
import { ROADSIDE, isRoadside } from '../src/sim/roadside';
import { createMatch, step } from '../src/sim/sim';
import { capacityOf, housedIn, noteShellBurst, SHELTER, shelterSpot } from '../src/sim/shelter';
import { isCollapsed, noteBuildingHit } from '../src/sim/buildings';
import { coverAgainst, resolveBlast } from '../src/sim/damage';
import type { Unit } from '../src/sim/types';
import { dist, type V2 } from '../src/sim/vec';

/** Footprint sample points (2 m grid incl. the edges), same rotation convention as the raster. */
function footprint(b: Building): V2[] {
  const out: V2[] = [];
  const cs = Math.cos(b.rot);
  const sn = Math.sin(b.rot);
  for (let lx = -b.w / 2; lx <= b.w / 2 + 0.01; lx += b.w / Math.ceil(b.w / 2)) {
    for (let lz = -b.d / 2; lz <= b.d / 2 + 0.01; lz += b.d / Math.ceil(b.d / 2)) out.push({ x: b.x + lx * cs + lz * sn, z: b.z - lx * sn + lz * cs });
  }
  return out;
}

describe('roadside buildings (2.2 §12)', () => {
  const def = generateMap({ seed: 21, factions: 2, size: 'medium' });
  const t = new Terrain(def);
  const rs = t.buildings.filter((b) => isRoadside(def, b));

  it('are generated deterministically from the map seed', () => {
    const again = new Terrain(generateMap({ seed: 21, factions: 2, size: 'medium' }));
    expect(JSON.stringify(again.buildings.filter((b) => isRoadside(def, b)))).toBe(JSON.stringify(rs));
    expect(rs.length).toBeGreaterThan(15);
    // Farmhouses / inns, barns / sheds and chapels.
    expect(new Set(rs.map((b) => b.kind)).size).toBe(3);
  }, 120000);

  it('stand off the road, water, bridges, fords, steep ground and settlements', () => {
    for (const b of rs) {
      for (const p of footprint(b)) {
        const g = t.groundAt(p.x, p.z);
        expect(g === Ground.Road || g === Ground.Water || g === Ground.Ford || g === Ground.Town).toBe(false);
        expect(t.slopeAt(p.x, p.z)).toBeLessThanOrEqual(ROADSIDE.maxSlopeDeg);
      }
      for (const br of t.bridges) expect(Math.hypot(br.x - b.x, br.z - b.z)).toBeGreaterThan(ROADSIDE.bridgeClearM - 30);
      for (const rv of def.rivers) for (const f of rv.fords) expect(dist(f, b)).toBeGreaterThan(ROADSIDE.fordClearM - 30);
      for (const tw of def.towns) expect(Math.hypot(tw.x - b.x, tw.z - b.z)).toBeGreaterThan(tw.r + 12);
      // Real buildings in the raster (collision, shells, LOS, garrison cover).
      expect(t.buildingH(b.x, b.z)).toBeGreaterThanOrEqual(4);
    }
    // No roadside building sits on a road centreline (outside settlements, where town houses stand).
    for (const road of def.roads) {
      for (let s = 0; s < road.length - 1; s++) {
        const L = dist(road[s], road[s + 1]);
        for (let m = 0; m <= L; m += 2) {
          const p = { x: road[s].x + ((road[s + 1].x - road[s].x) * m) / L, z: road[s].z + ((road[s + 1].z - road[s].z) * m) / L };
          if (def.towns.some((tw) => dist(tw, p) < tw.r + 20)) continue;
          expect(t.buildingH(p.x, p.z)).toBe(0);
        }
      }
    }
  });
});

describe('shelled squads take cover in buildings', () => {
  const data = loadGameData();
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, armyScale: 1 });
  const w = m.world;
  const t = w.terrain;
  const place = (u: Unit, p: V2): Unit => {
    u.pos.x = p.x; u.pos.z = p.z; u.prev.x = p.x; u.prev.z = p.z;
    u.y = t.heightAt(p.x, p.z);
    u.cover = t.coverAt(p.x, p.z);
    return u;
  };

  it('goes into a building on the first close burst, is inside it (all-round cover, blast cut), and resumes when the shelling stops', () => {
    // A roadside building with open ground 40 m off one side and the bursts 75 m off that side.
    let pick: { p: V2; from: V2 } | null = null;
    const probe = w.spawnUnit(0, 'infantry', { x: 0, z: 0 }, w.factions[0].fronts[0].id);
    const nav = w.navFor(probe);
    w.units.delete(probe.id);
    for (const b of t.buildings) {
      if (pick || !isRoadside(w.map, b)) continue;
      for (let a = 0; a < 8 && !pick; a++) {
        const c = Math.cos((a * Math.PI) / 4);
        const s = Math.sin((a * Math.PI) / 4);
        const p = { x: b.x + c * 40, z: b.z + s * 40 };
        const from = { x: b.x + c * 75, z: b.z + s * 75 };
        if (!nav.passable(p) || t.coverAt(p.x, p.z) !== 0 || t.groundAt(p.x, p.z) === Ground.Water) continue;
        pick = { p, from };
      }
    }
    expect(pick).not.toBeNull();
    const { p, from } = pick!;
    const sq = place(w.spawnUnit(0, 'infantry', p, w.factions[0].fronts[0].id), p);
    const got = shelterSpot(w, sq, from);
    expect(got).not.toBeNull();
    const spot = got!.p;
    const b = t.buildings[got!.k];
    expect(Math.hypot(spot.x - b.x, spot.z - b.z)).toBeLessThan(Math.hypot(b.w, b.d) / 2 + 3);
    expect(capacityOf(b)).toBeGreaterThanOrEqual(1);
    step(m); // into the spatial index
    // One burst 35 m away: the squad heads for the building.
    noteShellBurst(w, from);
    for (let i = 0; i < w.tickHz; i++) step(m);
    expect(sq.status).toBe('status.takingCover');
    expect(sq.dest && dist(sq.dest, spot)).toBeLessThan(3);
    // Keep shelling while it walks there.
    for (let s = 0; s < 60 && (dist(sq.pos, spot) > 2.5 || sq.moving); s++) {
      if (s % 5 === 0) noteShellBurst(w, sq.pos);
      for (let i = 0; i < w.tickHz; i++) step(m);
    }
    expect(housedIn(w, sq)).toBe(got!.k);
    // Inside: all-round cover, and a burst next to it does far less than in the open.
    expect(coverAgainst(w, sq, { x: sq.pos.x + 30, z: sq.pos.z })).toBe(3);
    expect(coverAgainst(w, sq, { x: sq.pos.x - 30, z: sq.pos.z })).toBe(3);
    const hp0 = sq.hp;
    resolveBlast(w, { x: sq.pos.x + 3, y: sq.y, z: sq.pos.z + 3 }, 16, 180, 0, 1, 'howitzer_shell', 'shell', null, 'howitzer');
    const insideLoss = hp0 - sq.hp;
    const open = place(w.spawnUnit(0, 'infantry', p, w.factions[0].fronts[0].id), p);
    step(m); // into the spatial index
    const o0 = open.hp;
    resolveBlast(w, { x: open.pos.x + 3, y: open.y, z: open.pos.z + 3 }, 16, 180, 0, 1, 'howitzer_shell', 'shell', null, 'howitzer');
    expect(insideLoss).toBeLessThan((o0 - open.hp) * 0.5);
    w.units.delete(open.id);
    // The building takes the beating; once it collapses the squad is exposed.
    for (let i = 0; i < 40 && !isCollapsed(w, got!.k); i++) noteBuildingHit(w, { x: b.x, y: t.heightAt(b.x, b.z) + 1, z: b.z }, 200);
    expect(isCollapsed(w, got!.k)).toBe(true);
    expect(housedIn(w, sq)).toBe(-1);
    // Shelling stops: after the hold time it goes back to its front task.
    for (let i = 0; i < (SHELTER.holdS + 2) * w.tickHz; i++) step(m);
    expect(sq.status).not.toBe('status.takingCover');
  }, 180000);

  it('ignores a single distant burst and units that are not foot squads', () => {
    const p = { x: w.cityOf(0).exit.x, z: w.cityOf(0).exit.z };
    const sq = place(w.spawnUnit(0, 'infantry', p, w.factions[0].fronts[0].id), p);
    const tank = place(w.spawnUnit(0, 'medium_tank', { x: p.x + 6, z: p.z }, w.factions[0].fronts[0].id), { x: p.x + 6, z: p.z });
    step(m);
    noteShellBurst(w, { x: p.x + 100, z: p.z });
    for (let i = 0; i < w.tickHz; i++) step(m);
    expect(sq.status).not.toBe('status.takingCover');
    noteShellBurst(w, { x: p.x + 20, z: p.z });
    for (let i = 0; i < w.tickHz; i++) step(m);
    expect(tank.status).not.toBe('status.takingCover');
  }, 60000);
});
