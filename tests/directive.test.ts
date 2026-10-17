import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
import { CommandBus, type Command, type CommandOutcome } from '../src/sim/commands';
import { thinkHighCommand } from '../src/sim/command';
import { chooseDirective, setDirective } from '../src/sim/directive';
import { COMPLIANCE_AB, directiveSig, homeRecall, obeyDelay, temperament } from '../src/sim/compliance';
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
    expect(issue(match, { type: 'setDirective', kind: 'offensive', axis, force: true })).toEqual({ ok: true });
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
    issue(match, { type: 'setDirective', kind: 'offensive', axis, force: true });
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
    expect(issue(match, { type: 'setDirective', kind: 'defend', force: true })).toEqual({ ok: true });
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
    expect(issue(match, { type: 'setDirective', kind: 'contract', force: true })).toEqual({ ok: true });
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
    expect(issue(match, { type: 'setDirective', kind: 'fortify', line: { a, b }, force: true })).toEqual({ ok: true });
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

describe('directive compliance (3.0, V30_SPEC §6)', () => {
  it('a front facing a much stronger enemy at the axis declines, says why, and the decline is logged', () => {
    const match = setup(60);
    const { world } = match;
    const f = world.factions[0];
    const axis = nearestEnemyHq(world, f);
    const enemy = world.factions.find((e) => e.alive && dist(world.hqPos(e.id), axis) < 1)!;
    for (let i = 0; i < 40; i++) world.spawnUnit(enemy.id, 'heavy_tank', world.terrain.freeNear({ x: axis.x + (i % 8) * 12 - 40, z: axis.z + Math.floor(i / 8) * 12 - 30 }, 60), enemy.fronts[0].id);
    world.spatial.rebuild(world.aliveUnits);
    expect(issue(match, { type: 'setDirective', kind: 'offensive', axis })).toEqual({ ok: true });
    expect(f.directive.forced).toBe(false);
    const main = frontById(f, directiveMain(f))!;
    expect(main.obey).toBe('declined');
    expect(main.compliance).toBeLessThan(world.data.rules.command.compliance_threshold);
    expect(main.response.startsWith('resp.declined')).toBe(true);
    if (main.response === 'resp.declined' || main.response === 'resp.declinedExpose') expect(Number(main.responseParams.r)).toBeGreaterThan(1);
    // It does its own (non-binding) action instead of the binding attack on the axis.
    expect(main.order.manual && main.order.kind === 'attack' && dist(main.order.a, axis) < 1).toBe(false);
    const rec = world.battle.responses.filter((r) => r.f === 0 && r.front === main.id && r.result === 'declined');
    expect(rec.length).toBe(1);
    expect(rec[0].reason).toBe(main.response);
    // Insist: the same directive again within insist_window_s is forced; every front obeys at once.
    run(match, 5);
    expect(issue(match, { type: 'setDirective', kind: 'offensive', axis })).toEqual({ ok: true });
    expect(f.directive.forced).toBe(true);
    expect(main.obey).toBe('forced');
    expect(main.order).toMatchObject({ kind: 'attack', manual: true });
    expect(dist(main.order.a, axis)).toBeLessThan(1);
    expect(f.fronts.every((s) => s.obey === 'forced' || s.obey === '')).toBe(true);
  }, 60_000);

  it('the Force flag forces at once; force: false keeps the compliance model; compliance off = 2.2', () => {
    const match = setup(30);
    const { world } = match;
    const f = world.factions[0];
    expect(issue(match, { type: 'setDirective', kind: 'defend', force: true })).toEqual({ ok: true });
    expect(f.directive.forced).toBe(true);
    for (const s of f.fronts) expect(s.order).toMatchObject({ kind: 'defend', manual: true });
    expect(issue(match, { type: 'setDirective', kind: 'defend', force: false })).toEqual({ ok: true });
    expect(f.directive.forced).toBe(false);
    expect(issue(match, { type: 'setDirective', kind: 'defend', force: 'yes' as never })).toEqual({ ok: false, reason: 'BAD_VALUE' });
    COMPLIANCE_AB.on = false;
    try {
      issue(match, { type: 'setDirective', kind: 'contract', force: false });
      for (const s of f.fronts) {
        expect(s.obey).toBe('');
        expect(['fallBack', 'defend']).toContain(s.order.kind);
      }
    } finally {
      COMPLIANCE_AB.on = true;
    }
  });

  it('home recall: a defend on the capital is never declined near home, and nearer fronts move first', () => {
    const match = setup(240);
    const { world } = match;
    const f = world.factions[0];
    const hq = world.hqPos(0);
    // Make every front's commander as unwilling as possible: an assault it is winning.
    expect(issue(match, { type: 'setDirective', kind: 'defend', axis: hq })).toEqual({ ok: true });
    expect(homeRecall(world, f, f.directive)).toBe(true);
    const near = f.fronts.filter((s) => s.obey !== '' && dist(s.front, hq) <= world.data.rules.command.home_recall_m * 0.8);
    for (const s of near) expect(s.obey).not.toBe('declined');
    const waiting = f.fronts.filter((s) => s.obey === 'pending').sort((a, b) => a.obeyAt - b.obeyAt);
    expect(waiting.length).toBeGreaterThan(0);
    // Delay grows with distance from the capital (by the front's troops), within the rules' bounds.
    const c = world.data.rules.command.compliance;
    for (const s of waiting) {
      const d = s.obeyAt - world.time;
      expect(d).toBeGreaterThanOrEqual(c.delay_min_s - 1e-6);
      expect(d).toBeLessThanOrEqual(c.delay_max_s + 1e-6);
    }
    expect(obeyDelay(world, 500)).toBeLessThan(obeyDelay(world, 2500));
    // Waiting fronts keep their previous order and show the countdown; each moves when its delay is over.
    for (const s of waiting) expect(s.response).toBe('resp.pending');
    const first = waiting[0];
    run(match, Math.ceil(first.obeyAt - world.time) + 1);
    expect(first.obey).toBe('obey');
    expect(['defend', 'attack']).toContain(first.order.kind);
    const obeyed = world.battle.responses.filter((r) => r.f === 0 && r.result === 'obeyed');
    expect(obeyed.length).toBeGreaterThan(0);
    // Obeyed in order of distance: the earliest obeyer is the nearest of those that obeyed.
    for (let i = 1; i < obeyed.length; i++) expect(obeyed[i].delay).toBeGreaterThanOrEqual(obeyed[i - 1].delay);
  }, 120_000);

  it('the AI supreme HQ goes through the same model (its defend directive is answered with a delay)', () => {
    const match = setup(30);
    const { world } = match;
    const f = world.factions[1];
    setDirective(world, f, 'defend', null, null, false);
    f.command.nextAt = 0;
    thinkHighCommand(world, f);
    expect(f.fronts.every((s) => s.compliance >= 0 && s.obey !== '')).toBe(true);
    expect(temperament(world, f, f.fronts[0])).toBe(temperament(world, f, f.fronts[0]));
    expect(directiveSig({ kind: 'defend', axis: { x: 100, z: 100 }, line: null })).toBe(directiveSig({ kind: 'defend', axis: { x: 104, z: 98 }, line: null }));
  });
});
