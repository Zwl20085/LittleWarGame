import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import type { Unit } from '../src/sim/types';
import type { V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';
import { anomalySecond, anomalyWindow, createAnomalyProbe, type AnomalyClass, type AnomalyProbe, type AnomalyRecord } from '../scripts/lab30/anomalyProbe';
import { CAUSE } from '../scripts/lab30/anomalyCauses';
import { placeOwnerOf } from '../scripts/lab30/anomalyWorld';

/** V30_SPEC §2: synthetic worlds that trigger each anomaly class of the debug lab. */
const data = loadGameData();

function setup(): { w: World; p: AnomalyProbe } {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
  m.world.tick = 60 * m.world.tickHz;
  return { w: m.world, p: createAnomalyProbe() };
}

/** Probe once now, advance the clock `seconds` without stepping, probe again and classify. */
function after(w: World, p: AnomalyProbe, seconds: number, between?: () => void): AnomalyRecord[] {
  w.spatial.rebuild(w.aliveUnits);
  anomalySecond(w, p);
  between?.();
  w.tick += seconds * w.tickHz;
  w.spatial.rebuild(w.aliveUnits);
  anomalySecond(w, p);
  return anomalyWindow(w, p);
}

const ofClass = (rs: AnomalyRecord[], c: AnomalyClass, ids: readonly Unit[]): AnomalyRecord | undefined =>
  rs.find((r) => r.cls === c && ids.every((u) => r.unitIds.includes(u.id)));

/** A passable point at least `clear` m from every unit and every front line point. */
function quietSpot(w: World, clear: number): V2 {
  const nav = w.nav(false, 35);
  const lines = w.factions.flatMap((f) => f.fronts.flatMap((s) => [s.front, ...s.segment]));
  for (let x = 100; x < w.terrain.width - 100; x += 50) {
    for (let z = 100; z < w.terrain.depth - 100; z += 50) {
      const p = { x, z };
      const far = (q: V2): boolean => Math.hypot(q.x - x, q.z - z) > clear;
      if (nav.passable(p) && lines.every(far) && w.aliveUnits.every((u) => far(u.pos))) return p;
    }
  }
  throw new Error('no quiet spot on the map');
}

function squad(w: World, owner: number, type: string, at: V2, n: number, ammo: number): Unit[] {
  const front = w.factions[owner].fronts[0].id;
  return Array.from({ length: n }, (_, i) => {
    const u = w.spawnUnit(owner, type, { x: at.x + (i % 3) * 12, z: at.z + Math.floor(i / 3) * 12 }, front);
    u.ammo = ammo;
    return u;
  });
}

describe('3.0 debug lab: anomaly classifier', () => {
  it('ammo-starved cluster: ≥ 5 tanks, median ammo < 15 %, not rearming > 90 s, enemy within 400 m', () => {
    const { w, p } = setup();
    const at = quietSpot(w, 700);
    const tanks = squad(w, 0, 'medium_tank', at, 6, 0.05);
    squad(w, 1, 'infantry', { x: at.x + 300, z: at.z }, 1, 1);
    const r = ofClass(after(w, p, 100), 'ammo_starved', tanks);
    expect(r).toBeDefined();
    expect(r!.severity).toBe('high');
    expect(r!.detail.tanks).toBe(6);
    expect(r!.causes.length).toBeGreaterThan(0);
  });

  it('no starved cluster when the group has ammunition, is rearming, or has no enemy near', () => {
    const { w, p } = setup();
    const at = quietSpot(w, 700);
    const full = squad(w, 0, 'medium_tank', at, 6, 0.6);
    const enemy = squad(w, 1, 'infantry', { x: at.x + 300, z: at.z }, 1, 1);
    expect(ofClass(after(w, p, 100), 'ammo_starved', full)).toBeUndefined();
    for (const u of full) u.ammo = 0.05;
    // Still rearming within the last 90 s → not starved.
    expect(ofClass(after(w, p, 60, () => full.forEach((u) => { u.rearming = true; })), 'ammo_starved', full)).toBeUndefined();
    for (const u of full) u.rearming = false;
    enemy[0].hp = 0;
    expect(ofClass(after(w, p, 100), 'ammo_starved', full)).toBeUndefined();
  });

  it('flags the rearm dead zone: above rearm_below but below one shell', () => {
    const { w, p } = setup();
    const at = quietSpot(w, 700);
    const heavy = squad(w, 0, 'heavy_tank', at, 5, 0);
    const shell = heavy[0].primary!.ammoCost;
    const below = data.rules.logistics!.rearm_below;
    for (const u of heavy) u.ammo = (below + shell) / 2;
    squad(w, 1, 'infantry', { x: at.x + 250, z: at.z }, 1, 1);
    const r = ofClass(after(w, p, 100), 'ammo_starved', heavy);
    if (shell > below) expect(r?.causes).toContain(CAUSE.deadZone);
    else expect(r?.causes ?? []).not.toContain(CAUSE.deadZone);
  });

  it('starved supply chain: an owned stock at 0 for > 2 min with units waiting', () => {
    const { w, p } = setup();
    const place = w.places.find((x) => x.capitalOf < 0 && placeOwnerOf(w, x) === 0)!;
    place.stock = 0;
    const waiting = squad(w, 0, 'infantry', place.pos, 3, 0.2);
    const r = ofClass(after(w, p, 130), 'supply_chain', waiting);
    expect(r).toBeDefined();
    expect(r!.key).toBe(`place:${place.id}`);
  });

  it('idle herd: ≥ 8 idle units for > 3 min, far from any front line', () => {
    const { w, p } = setup();
    const herd = squad(w, 0, 'infantry', quietSpot(w, 600), 9, 1);
    expect(ofClass(after(w, p, 200), 'idle_herd', herd)).toBeDefined();
  });

  it('stuck: a unit with a path that has not moved for 60 s', () => {
    const { w, p } = setup();
    const at = quietSpot(w, 300);
    const [u] = squad(w, 0, 'infantry', at, 1, 1);
    u.path = [{ x: at.x + 200, z: at.z }];
    u.dest = { x: at.x + 200, z: at.z };
    expect(ofClass(after(w, p, 70), 'stuck', [u])).toBeDefined();
  });

  it('convoy loop: a truck with no delivery for 5 min', () => {
    const { w, p } = setup();
    const [t] = squad(w, 0, 'supply_truck', quietSpot(w, 300), 1, 1);
    t.truckState = 'out';
    t.cargo = 10;
    const r = ofClass(after(w, p, 310), 'convoy_loop', [t]);
    expect(r).toBeDefined();
    expect(r!.detail.state).toBe('out');
  });

  it('phantom front: a commanded front with < 3 units for > 3 min', () => {
    const { w, p } = setup();
    const f = w.factions[0];
    const s = f.fronts[0];
    let cmd = w.unitAlive(s.commanderId);
    if (!cmd) {
      cmd = w.spawnUnit(0, 'commander', quietSpot(w, 300), s.id);
      s.commanderId = cmd.id;
    }
    const other = f.fronts.find((x) => x.id !== s.id)?.id ?? s.id + 1000;
    for (const u of w.aliveUnits) if (u.owner === 0 && u.frontId === s.id && u.id !== cmd.id) u.frontId = other;
    const r = ofClass(after(w, p, 190), 'phantom_front', [cmd]);
    expect(r).toBeDefined();
    expect(r!.detail.members).toBe(0);
  });

  it('unreachable order: repeated path failures for the same goal', () => {
    const { w, p } = setup();
    const at = quietSpot(w, 300);
    const [u] = squad(w, 0, 'infantry', at, 1, 1);
    u.dest = { x: at.x + 400, z: at.z + 10 };
    for (let i = 0; i < 3; i++) {
      u.pathFailed = true;
      anomalySecond(w, p);
      u.pathFailed = false;
      anomalySecond(w, p);
    }
    u.pathFailed = true;
    expect(ofClass(after(w, p, 5), 'unreachable', [u])).toBeDefined();
  });

  it('merges consecutive windows into one episode', () => {
    const { w, p } = setup();
    const at = quietSpot(w, 300);
    const [u] = squad(w, 0, 'infantry', at, 1, 1);
    u.path = [{ x: at.x + 200, z: at.z }];
    after(w, p, 70);
    after(w, p, 30);
    const eps = p.episodes.filter((e) => e.cls === 'stuck' && e.key === `unit:${u.id}`);
    expect(eps.length).toBe(1);
    expect(eps[0].timeline.length).toBe(2);
  });
});
