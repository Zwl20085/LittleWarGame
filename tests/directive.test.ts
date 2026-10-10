import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { CommandBus, type Command, type CommandOutcome } from '../src/sim/commands';
import { thinkHighCommand } from '../src/sim/command';
import { chooseDirective } from '../src/sim/directive';
import { frontById } from '../src/sim/frontref';
import { directiveMain, RESPONSE } from '../src/sim/frontresponse';
import { frontDistance } from '../src/sim/frontops';
import { counterStrikes } from '../src/sim/frontref';
import type { Faction } from '../src/sim/types';
import { dist, headingTo, type V2 } from '../src/sim/vec';
import type { World } from '../src/sim/world';

/** 2.2 universal directive (docs/V22_SPEC.md §1): one command, every front commander answers it. */
type M = ReturnType<typeof createMatch>;

function setup(seconds: number): M {
  const match = createMatch(loadGameData(), { mapId: 'generated', factions: 4, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: false });
  run(match, seconds);
  return match;
}

function run(match: M, seconds: number): void {
  for (let i = 0; i < seconds * match.world.tickHz; i++) {
    step(match);
    match.world.fx.length = 0;
  }
}

function issue(match: M, cmd: Command): CommandOutcome {
  const bus = new CommandBus();
  let out: CommandOutcome = { ok: true };
  bus.onResult = (_e, o) => { out = o; };
  bus.issue(match, 0, cmd);
  bus.flush(match);
  return out;
}

const nearestEnemyHq = (world: World, f: Faction): V2 => {
  const e = world.factions.filter((x) => x.id !== f.id && x.alive).sort((a, b) => dist(world.hqPos(a.id), world.hqPos(f.id)) - dist(world.hqPos(b.id), world.hqPos(f.id)))[0];
  return world.hqPos(e.id);
};

describe('directive (2.2 supreme-HQ command)', () => {
  it('validates setDirective and reports every failure', () => {
    const match = setup(5);
    const { world } = match;
    const f = world.factions[0];
    const before = f.directive;
    expect(issue(match, { type: 'setDirective', kind: 'retreat' as never })).toEqual({ ok: false, reason: 'BAD_VALUE' });
    expect(issue(match, { type: 'setDirective', kind: 'offensive', axis: { x: NaN, z: 0 } })).toEqual({ ok: false, reason: 'BAD_VALUE' });
    expect(issue(match, { type: 'setDirective', kind: 'offensive', axis: { x: -50_000, z: 10 } })).toEqual({ ok: false, reason: 'OUT_OF_BOUNDS' });
    const hq = world.hqPos(0);
    const a = world.nav(false, 35).nearestPassable({ x: hq.x + 300, z: hq.z }, 80)!;
    const b = world.nav(false, 35).nearestPassable({ x: hq.x + 300, z: hq.z + 200 }, 80)!;
    expect(issue(match, { type: 'setDirective', kind: 'defend', line: { a, b } })).toEqual({ ok: false, reason: 'LINE_ONLY_FORTIFY' });
    expect(issue(match, { type: 'setDirective', kind: 'fortify', line: { a, b: { x: a.x + 10, z: a.z } } })).toEqual({ ok: false, reason: 'LINE_SHORT' });
    expect(f.directive).toBe(before);
    expect(issue(match, { type: 'setDirective', kind: 'defend' })).toEqual({ ok: true });
    expect(f.directive).toMatchObject({ kind: 'defend', axis: null, line: null, manual: true });
  });

  it('offensive: the front nearest the axis is the main effort and attacks it; binding orders', () => {
    const match = setup(60);
    const { world } = match;
    const f = world.factions[0];
    const axis = nearestEnemyHq(world, f);
    expect(issue(match, { type: 'setDirective', kind: 'offensive', axis })).toEqual({ ok: true });
    const main = frontById(f, directiveMain(f))!;
    expect(main).toBeDefined();
    // Main effort = the front whose line is nearest the axis objective (here an enemy capital).
    const nearest = [...f.fronts].sort((x, y) => frontDistance(x, axis) - frontDistance(y, axis))[0];
    expect(main.id).toBe(nearest.id);
    expect(main.order).toMatchObject({ kind: 'attack', manual: true });
    expect(dist(main.order.a, axis)).toBeLessThan(1);
    expect(main.targetCity).not.toBeNull();
    expect(main.response).toBe('resp.main');
    // Every front attacks (its own objective, the axis, or a weaker place it pins) — none sits idle on auto.
    for (const s of f.fronts) {
      expect(['attack', 'defend']).toContain(s.order.kind);
      expect(s.response.startsWith('resp.')).toBe(true);
      if (s.order.kind === 'defend') expect(s.response).toBe('resp.holdOutmatched');
    }
    // The main effort gets the reinforcement priority (cityai.thinkCity reads the directive's main front).
    f.aiThinkAt = 0;
    run(match, 1);
    expect(f.mainFront).toBe(main.id);
  });

  it('offensive: a front facing a much stronger enemy at its objective pins a weaker place instead', () => {
    const match = setup(60);
    const { world } = match;
    const f = world.factions[0];
    const axis = nearestEnemyHq(world, f);
    issue(match, { type: 'setDirective', kind: 'offensive', axis });
    const other = f.fronts.find((s) => s.id !== directiveMain(f) && dist(s.front, axis) > RESPONSE.supportM + 200);
    if (!other) return; // every front supports the axis on this map
    // Pile a strong enemy force on its objective.
    const enemy = world.factions.find((e) => e.id !== 0 && e.alive)!;
    const obj = { ...other.targetPos };
    for (let i = 0; i < 25; i++) world.spawnUnit(enemy.id, 'medium_tank', world.terrain.freeNear({ x: obj.x + (i % 5) * 12, z: obj.z + Math.floor(i / 5) * 12 }, 40), enemy.fronts[0].id);
    world.spatial.rebuild(world.aliveUnits);
    f.command.nextAt = 0;
    thinkHighCommand(world, f);
    expect(['resp.pin', 'resp.holdOutmatched']).toContain(other.response);
    if (other.response === 'resp.pin') expect(dist(other.order.a, obj)).toBeGreaterThan(1);
  });

  it('defend: every front holds its line; no deep attacks, no counter-strike', () => {
    const match = setup(120);
    const { world } = match;
    const f = world.factions[0];
    expect(issue(match, { type: 'setDirective', kind: 'defend' })).toEqual({ ok: true });
    const lines = new Map(f.fronts.map((s) => [s.id, { ...s.order.a }]));
    for (const s of f.fronts) expect(s.order).toMatchObject({ kind: 'defend', manual: true });
    for (let t = 0; t < 180; t += 5) {
      run(match, 5);
      for (const s of f.fronts) {
        expect(counterStrikes.has(s)).toBe(false);
        const home = lines.get(s.id);
        if (!home || s.order.kind === 'auto') continue;
        // Only local counter-attacks: an attack goes to a place near the front's line.
        if (s.order.kind === 'attack') expect(dist(s.order.a, home)).toBeLessThanOrEqual(RESPONSE.counterM + 1);
        else expect(['defend', 'fortify']).toContain(s.order.kind);
      }
    }
  }, 120_000);

  it('contract: fronts fall back toward home and hold there', () => {
    const match = setup(240);
    const { world } = match;
    const f = world.factions[0];
    const hq = world.hqPos(0);
    const before = new Map(f.fronts.map((s) => [s.id, dist(s.front, hq)]));
    expect(issue(match, { type: 'setDirective', kind: 'contract' })).toEqual({ ok: true });
    for (const s of f.fronts) {
      expect(['fallBack', 'defend']).toContain(s.order.kind);
      expect(s.order.manual).toBe(true);
      // The new line is not farther out than the front stood.
      expect(dist(s.order.a, hq)).toBeLessThanOrEqual((before.get(s.id) ?? 0) + RESPONSE.holdBackSlackM + RESPONSE.holdPadM + 80);
      expect(['resp.contract', 'resp.contractHold']).toContain(s.response);
    }
    const far = f.fronts.filter((s) => (before.get(s.id) ?? 0) >= RESPONSE.contractHomeM);
    for (const s of far) expect(dist(s.order.a, hq)).toBeLessThan(before.get(s.id)! - RESPONSE.contractStepM / 2);
  });

  it('fortify with a drawn line makes a permanent fortified zone held by the nearest front', () => {
    const match = setup(60);
    const { world } = match;
    const f = world.factions[0];
    const hq = world.hqPos(0);
    const h = headingTo(hq, nearestEnemyHq(world, f));
    const c = { x: hq.x + Math.cos(h) * 450, z: hq.z + Math.sin(h) * 450 };
    const nav = world.nav(false, 35);
    const a = nav.nearestPassable({ x: c.x - Math.sin(h) * 150, z: c.z + Math.cos(h) * 150 }, 30)!;
    const b = nav.nearestPassable({ x: c.x + Math.sin(h) * 150, z: c.z - Math.cos(h) * 150 }, 30)!;
    const zones = f.zones.length;
    expect(issue(match, { type: 'setDirective', kind: 'fortify', line: { a, b } })).toEqual({ ok: true });
    const z = f.zones.find((x) => dist(x.a, a) < 1 && dist(x.b, b) < 1);
    expect(z).toBeDefined();
    expect(f.zones.length).toBeGreaterThan(zones);
    const main = frontById(f, directiveMain(f))!;
    expect(main.order).toMatchObject({ kind: 'fortify', manual: true });
    expect(dist(main.order.a, a) + dist(main.order.b!, b)).toBeLessThan(1);
    expect(z!.frontId).toBe(main.id);
    // The other fronts fortify their own lines (or hold beside another front's zone, or counter-attack).
    for (const s of f.fronts) expect(['fortify', 'defend', 'attack']).toContain(s.order.kind);
    // One front per zone: nobody else took the drawn line.
    expect(f.fronts.filter((s) => s.order.kind === 'fortify' && s.order.b && dist(s.order.a, a) < 1).length).toBe(1);
    // Permanent: a later directive keeps the zone.
    issue(match, { type: 'setDirective', kind: 'advance' });
    run(match, 6);
    expect(f.zones.find((x) => x.id === z!.id && !x.cancelled)).toBeDefined();
    expect(main.order.manual && main.order.kind === 'fortify').toBe(false);
  });

  it('the AI supreme HQ chooses its directive through the same API (finisher → offensive on the finish capital)', () => {
    const match = setup(30);
    const { world } = match;
    const f = world.factions[1];
    expect(f.directive).toMatchObject({ kind: 'advance', manual: false });
    const fin = world.factions.find((e) => e.id !== 1 && e.alive)!.id;
    f.command.finishTarget = fin;
    f.command.finisher = true;
    expect(chooseDirective(world, f)).toBe(true);
    expect(f.directive).toMatchObject({ kind: 'offensive', manual: false });
    expect(dist(f.directive.axis!, world.hqPos(fin))).toBeLessThan(1);
    // The player's faction is never steered by the AI.
    expect(chooseDirective(world, world.factions[0])).toBe(false);
  });
});
