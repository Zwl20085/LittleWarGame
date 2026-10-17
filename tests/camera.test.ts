import { describe, expect, it } from 'vitest';
import { HeatGrid, HEAT, SeenMask } from '../src/render/battleHeat';
import { CAM, CameraModes, nearestTurn, type CamRig, type CamWorld } from '../src/render/cameraModes';
import { LIGHT } from '../src/render/atmosphere';
import { DAY, dayPhase, daylightAt } from '../src/render/timeOfDay';
import { tiltStrength } from '../src/render/tiltShift';
import type { FxEvent } from '../src/sim/types';

/** Rig stand-in with the CameraRig contract (goals + counters), no WebGL. */
class FakeRig implements CamRig {
  target = { x: 500, z: 500 };
  yaw = Math.PI / 2;
  private yawGoal = Math.PI / 2;
  private zoomGoal = 1;
  private elevGoal = 45;
  readonly minZoom = 0.1;
  easeRate = 10;
  followRate: number | null = null;
  panCount = 0;
  lookCount = 0;
  follow: (() => { x: number; z: number } | null) | null = null;
  get yawTarget(): number { return this.yawGoal; }
  get zoomTarget(): number { return this.zoomGoal; }
  get elevationGoal(): number { return this.elevGoal; }
  setZoom(z: number): void { this.zoomGoal = Math.max(this.minZoom, Math.min(6, z)); }
  setElevation(d: number): void { this.elevGoal = Math.max(35, Math.min(70, d)); }
  setYawGoal(y: number): void { this.yawGoal = y; }
  rotate(d: number): void { this.yawGoal += d; }
  lookAt(x: number, z: number): void { this.lookCount++; this.target = { x, z }; }
  pan(dx: number): void { this.panCount++; this.follow = null; this.target = { x: this.target.x + dx, z: this.target.z }; }
  /** Like CameraRig.update: follow pulls the target. */
  step(dt: number): void {
    const p = this.follow?.();
    if (p) { this.target = { x: p.x, z: p.z }; }
    this.yaw += (this.yawGoal - this.yaw) * (1 - Math.exp(-dt * this.easeRate));
  }
}

function world(): CamWorld & { units: Map<number, { pos: { x: number; z: number }; heading: number }> } {
  const units = new Map<number, { pos: { x: number; z: number }; heading: number }>();
  units.set(7, { pos: { x: 1200, z: 800 }, heading: 0.5 });
  return {
    terrain: { width: 4000, depth: 3000 },
    units,
    unitAlive: (id: number) => units.get(id),
    factions: [{ fronts: [{ id: 3, front: { x: 2000, z: 1500 }, facing: -1 }] }],
  };
}

const boom = (x: number, z: number, n = 1): FxEvent[] => Array.from({ length: n }, () => ({ t: 'explosion', pos: { x, y: 0, z }, radius: 10, kind: 'he' }) as FxEvent);

function run(m: CameraModes, rig: FakeRig, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds; t += dt) {
    m.update(dt);
    rig.step(dt);
  }
}

describe('nearestTurn', () => {
  it('never asks for more than half a turn', () => {
    expect(nearestTurn(0, Math.PI * 2 + 0.1)).toBeCloseTo(0.1);
    const r = nearestTurn(10, -0.2);
    expect(Math.abs(r - 10)).toBeLessThanOrEqual(Math.PI);
    expect(Math.abs(Math.sin((r + 0.2) / 2))).toBeLessThan(1e-9);
    expect(Math.abs(nearestTurn(3, 3 + 5) - 3)).toBeLessThanOrEqual(Math.PI);
  });
});

describe('battle heat', () => {
  it('picks the hottest fight and its weighted centre', () => {
    const g = new HeatGrid(4000, 3000);
    g.ingest(boom(1000, 1000, 3));
    g.ingest(boom(3000, 2000, 10));
    const s = g.hottest()!;
    expect(s.x).toBeCloseTo(3000);
    expect(s.z).toBeCloseTo(2000);
    expect(s.score).toBeGreaterThan(HEAT.minScore);
  });

  it('prefers a different fight than the current shot', () => {
    const g = new HeatGrid(4000, 3000);
    g.ingest(boom(1000, 1000, 3));
    g.ingest(boom(3000, 2000, 10));
    const s = g.hottest({ x: 3000, z: 2000 })!;
    expect(s.x).toBeCloseTo(1000);
    // Only one fight: it is shown again rather than nothing.
    const one = new HeatGrid(4000, 3000);
    one.ingest(boom(3000, 2000, 10));
    expect(one.hottest({ x: 3000, z: 2000 })!.x).toBeCloseTo(3000);
  });

  it('decays by half-life and ignores stray noise', () => {
    const g = new HeatGrid(4000, 3000);
    g.ingest(boom(500, 500, 4));
    const before = g.scoreAt(500, 500);
    g.decay(HEAT.halfLife);
    expect(g.scoreAt(500, 500)).toBeCloseTo(before / 2, 3);
    const quiet = new HeatGrid(4000, 3000);
    quiet.ingest([{ t: 'ricochet', pos: { x: 10, y: 0, z: 10 } }]);
    expect(quiet.hottest()).toBeNull();
  });

  it('weights deaths and blasts above rifle fire', () => {
    const g = new HeatGrid(4000, 3000);
    for (let i = 0; i < 20; i++) g.ingest([{ t: 'muzzle', pos: { x: 500, y: 0, z: 500 }, dir: 0, big: false, weapon: 'rifle' }]);
    g.ingest([{ t: 'death', pos: { x: 2500, y: 0, z: 2500 }, vehicle: true, unitType: 'tank' }]);
    expect(g.hottest()!.x).toBeCloseTo(2500);
  });
});

describe('camera mode state machine', () => {
  it('orbit turns slowly; Esc returns to free', () => {
    const rig = new FakeRig();
    const m = new CameraModes(rig, world());
    expect(m.setMode('orbit')).toBe(true);
    const y0 = rig.yawTarget;
    run(m, rig, 2);
    expect(rig.yawTarget - y0).toBeCloseTo(CAM.orbitSpin * 2, 1);
    expect(m.exit()).toBe(true);
    expect(m.mode).toBe('free');
    expect(m.exit()).toBe(false);
  });

  it('overview remembers the view and restores it', () => {
    const rig = new FakeRig();
    const m = new CameraModes(rig, world());
    rig.setZoom(2.5);
    rig.setElevation(40);
    rig.lookAt(900, 700);
    m.update(0);
    m.toggleOverview();
    expect(m.mode).toBe('overview');
    expect(rig.zoomTarget).toBe(rig.minZoom);
    expect(rig.elevationGoal).toBe(CAM.overview.elevation);
    run(m, rig, CAM.glideSeconds + 0.1);
    expect(rig.target.x).toBeCloseTo(2000);
    expect(rig.target.z).toBeCloseTo(1500);
    m.toggleOverview();
    run(m, rig, CAM.glideSeconds + 0.1);
    expect(m.mode).toBe('free');
    expect(rig.target.x).toBeCloseTo(900);
    expect(rig.target.z).toBeCloseTo(700);
    expect(rig.zoomTarget).toBe(2.5);
    expect(rig.elevationGoal).toBe(40);
  });

  it('overview returns to the mode it interrupted', () => {
    const rig = new FakeRig();
    const m = new CameraModes(rig, world());
    m.follow({ kind: 'unit', id: 7 });
    m.toggleOverview();
    expect(m.following).toBeNull();
    m.toggleOverview();
    expect(m.mode).toBe('follow');
    expect(m.following).toEqual({ kind: 'unit', id: 7 });
  });

  it('follows a unit from behind and drops out when it dies or the player pans', () => {
    const rig = new FakeRig();
    const w = world();
    const m = new CameraModes(rig, w);
    expect(m.follow({ kind: 'unit', id: 99 })).toBe(false);
    expect(m.mode).toBe('free');
    expect(m.follow({ kind: 'unit', id: 7 })).toBe(true);
    run(m, rig, 6);
    expect(rig.target).toEqual({ x: 1200, z: 800 });
    // Camera behind the unit: yaw = heading + π (within a turn).
    expect(Math.abs(Math.sin((rig.yawTarget - (0.5 + Math.PI)) / 2))).toBeLessThan(0.05);
    w.units.delete(7);
    run(m, rig, 0.1);
    expect(m.mode).toBe('free');
    m.follow({ kind: 'front', faction: 0, id: 3 });
    expect(m.mode).toBe('follow');
    rig.pan(10);
    m.update(0.016);
    expect(m.mode).toBe('free');
  });

  it('battle cam frames the hottest fight and cuts under a dip to black', () => {
    const rig = new FakeRig();
    const dips: boolean[] = [];
    const m = new CameraModes(rig, world(), { rng: () => 0.5, onDip: (on) => dips.push(on) });
    m.ingest(boom(1000, 1000, 6));
    m.ingest(boom(3000, 2000, 12));
    m.setMode('battle');
    expect(m.battleSpot!.x).toBeCloseTo(3000);
    run(m, rig, CAM.glideSeconds + 0.1);
    expect(rig.target.x).toBeCloseTo(3000);
    // Shot length is 12–20 s (rng 0.5 → 16 s); keep both fights alive meanwhile.
    for (let t = 0; t < 13; t += 1) {
      m.ingest(boom(1000, 1000, 2));
      m.ingest(boom(3000, 2000, 2));
      run(m, rig, 1);
    }
    expect(m.battleSpot!.x).toBeCloseTo(3000);
    run(m, rig, 2.2);
    expect(dips).toContain(true);
    expect(m.battleSpot!.x).toBeCloseTo(1000);
    expect(rig.target.x).toBeCloseTo(1000);
    run(m, rig, 0.5);
    expect(dips[dips.length - 1]).toBe(false);
  });

  it('battle cam waits when nothing is fighting and uses the fallback', () => {
    const rig = new FakeRig();
    let calls = 0;
    const m = new CameraModes(rig, world(), { fallback: () => (calls++ > 0 ? { x: 400, z: 300, score: 1 } : null) });
    m.setMode('battle');
    expect(m.battleSpot).toBeNull();
    run(m, rig, CAM.battle.retry + 0.1);
    expect(m.battleSpot).toEqual({ x: 400, z: 300, score: 1 });
  });

  it('a UI jump (minimap click) leaves battle cam; the HUD button re-enters the last mode', () => {
    const rig = new FakeRig();
    const m = new CameraModes(rig, world());
    m.ingest(boom(3000, 2000, 12));
    m.setMode('battle');
    run(m, rig, 0.5);
    rig.lookAt(100, 100);
    m.update(0.016);
    expect(m.mode).toBe('free');
    expect(m.lastMode).toBe('battle');
    m.toggleRemembered();
    expect(m.mode).toBe('battle');
  });
});

describe('battle cam under fog of war', () => {
  it('only counts fights near units the player can see', () => {
    const mask = new SeenMask(4000, 3000);
    // Own unit at (1000, 1000); a seen enemy at (3500, 500). The big fight at (3000, 2500) is hidden.
    mask.rebuild([{ x: 1000, z: 1000 }, { x: 3500, z: 500 }]);
    expect(mask.has(1050, 1080)).toBe(true);
    expect(mask.has(3000, 2500)).toBe(false);
    const g = new HeatGrid(4000, 3000);
    g.ingest(boom(3000, 2500, 30), mask.has);
    expect(g.hottest()).toBeNull();
    g.ingest(boom(1000, 1000, 3), mask.has);
    expect(g.hottest()!.x).toBeCloseTo(1000);
  });

  it('never cuts to a hidden fight; spectators (no mask) see everything', () => {
    const mask = new SeenMask(4000, 3000);
    mask.rebuild([{ x: 1000, z: 1000 }]);
    let fog = true;
    const rig = new FakeRig();
    const m = new CameraModes(rig, world(), { rng: () => 0.5, seen: () => (fog ? mask.has : null) });
    m.ingest(boom(3000, 2500, 30));
    m.ingest(boom(1000, 1000, 4));
    m.setMode('battle');
    expect(m.battleSpot!.x).toBeCloseTo(1000);
    // Stale heat from before the fog check is also refused at pick time.
    const g = new HeatGrid(4000, 3000);
    g.ingest(boom(3000, 2500, 30));
    expect(g.hottest(null, undefined, undefined, mask.has)).toBeNull();
    fog = false;
    m.exit();
    m.ingest(boom(3000, 2500, 30));
    m.setMode('battle');
    expect(m.battleSpot!.x).toBeCloseTo(3000);
  });
});

describe('time of day', () => {
  it('drifts from morning to dusk and holds there (no night)', () => {
    expect(dayPhase(0)).toBeCloseTo(DAY.startPhase);
    expect(dayPhase(DAY.spanSeconds / 2)).toBeGreaterThan(dayPhase(60));
    expect(dayPhase(DAY.spanSeconds * 5)).toBe(1);
    expect(dayPhase(Number.NaN)).toBeCloseTo(DAY.startPhase);
    expect(dayPhase(9999, false)).toBe(DAY.fixedPhase);
    for (let p = 0; p <= 1; p += 0.05) expect(Math.asin(daylightAt(p).sunDir.y) * (180 / Math.PI)).toBeGreaterThanOrEqual(20);
  });

  it('the fixed phase reproduces the 2.x light', () => {
    const d = daylightAt(DAY.fixedPhase);
    expect(d.sunDir.distanceTo(LIGHT.sunDir)).toBeLessThan(1e-3);
    expect(d.sunColor.getHexString()).toBe(LIGHT.sunColor.slice(1));
    expect(d.sunIntensity).toBeCloseTo(LIGHT.sunIntensity);
  });

  it('the sun moves slowly (shadows stay stable)', () => {
    const a = daylightAt(dayPhase(600)).sunDir;
    const b = daylightAt(dayPhase(610)).sunDir.clone();
    expect(a.angleTo(b) * (180 / Math.PI)).toBeLessThan(0.5);
  });
});

describe('tilt-shift', () => {
  it('only at low angles and close zoom', () => {
    expect(tiltStrength(45, 10)).toBe(0);
    expect(tiltStrength(35, 1)).toBe(0);
    expect(tiltStrength(35, 10)).toBe(1);
    const mid = tiltStrength(40, 4);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});
