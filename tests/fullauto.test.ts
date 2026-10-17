import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { CommandBus, type Command } from '../src/sim/commands';
import { autoCommandActive } from '../src/sim/directive';
import { createMatch, step, type Match } from '../src/sim/sim';
import type { Faction } from '../src/sim/types';

const data = loadGameData();

/**
 * 3.0.1 (user: 斗蛐蛐 — the player may do nothing and just watch): research, engineering and the
 * directive run for the player's faction by default, each with a take-over toggle like Auto-invest.
 * Seed 3 draws the blitz doctrine for the player, whose strike lands inside 20 minutes.
 */
const makeMatch = (d: GameData = data, seed = 3): Match =>
  createMatch(d, { mapId: 'generated', factions: 2, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: false });

interface Watch { autoDirs: Set<string>; jobs: number; reasons: Set<string>; manualDirs: Set<string> }

/** Run `seconds` of game time issuing `cmds` (at their second); watch the player's directive and engineers. */
function run(m: Match, seconds: number, cmds: { at: number; cmd: Command }[] = [], each?: (t: number) => void): Watch {
  const w = m.world;
  const f = w.factions[0];
  const bus = new CommandBus();
  const watch: Watch = { autoDirs: new Set(), jobs: 0, reasons: new Set(), manualDirs: new Set() };
  let had = false;
  const end = w.tick + seconds * w.tickHz;
  while (w.tick < end && !w.result) {
    if (w.tick % w.tickHz === 0) {
      const t = Math.round(w.time);
      for (const c of cmds) if (c.at === t) bus.issue(m, 0, c.cmd);
      const d = f.directive;
      const sig = `${d.kind}${d.axis ? `@${Math.round(d.axis.x)},${Math.round(d.axis.z)}` : ''}`;
      (d.manual ? watch.manualDirs : watch.autoDirs).add(sig);
      if (f.autoEngReason) watch.reasons.add(f.autoEngReason);
      const has = (w.transport?.jobs ?? []).some((j) => j.owner === f.id);
      if (has && !had) watch.jobs++;
      had = has;
      each?.(t);
    }
    bus.flush(m);
    step(m);
    w.fx.length = 0;
  }
  return watch;
}

const researched = (f: Faction): boolean => f.upgrades.owned !== 0 || f.upgrades.research !== null;

describe('3.0.1 full auto: a hands-off player', () => {
  it('starts with every auto toggle on', () => {
    const f = makeMatch().world.factions[0];
    expect(f.isPlayer).toBe(true);
    expect([f.autoInvest, f.autoResearch, f.autoEngineering, f.autoCommand]).toEqual([true, true, true, true]);
  }, 60_000);

  it('20 min with no command: researches, runs the engineers and changes its directive', () => {
    const m = makeMatch();
    const f = m.world.factions[0];
    const seen = run(m, 20 * 60);
    expect(researched(f)).toBe(true);
    expect(seen.jobs > 0 || seen.reasons.size > 0).toBe(true);
    expect(seen.autoDirs.size).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it('toggles off: no research, no engineering think, the directive stays the player\'s', () => {
    const m = makeMatch();
    const f = m.world.factions[0];
    const off: Command[] = [{ type: 'setAutoResearch', on: false }, { type: 'setAutoEngineering', on: false }, { type: 'setAutoCommand', on: false }];
    const seen = run(m, 20 * 60, off.map((cmd) => ({ at: 0, cmd })));
    expect([f.autoResearch, f.autoEngineering, f.autoCommand]).toEqual([false, false, false]);
    expect(researched(f)).toBe(false);
    expect(f.upgrades.fundP + f.upgrades.fundM).toBe(0);
    expect(seen.jobs).toBe(0);
    expect(seen.reasons.size).toBe(0);
    expect(seen.autoDirs.size).toBe(0);
    expect(f.directive.kind).toBe('advance');
  }, 240_000);

  it('Auto-research off returns the fund set aside; a manual purchase leaves it on', () => {
    const m = makeMatch();
    const f = m.world.factions[0];
    f.upgrades.fundP = 40;
    f.upgrades.fundM = 60;
    const before = { p: f.p, m: f.m };
    const bus = new CommandBus();
    bus.issue(m, 0, { type: 'setAutoResearch', on: false });
    bus.flush(m);
    expect(f.upgrades.fundP + f.upgrades.fundM).toBe(0);
    expect(f.p).toBeCloseTo(before.p + 40, 6);
    expect(f.m).toBeCloseTo(before.m + 60, 6);
    const m2 = makeMatch();
    const f2 = m2.world.factions[0];
    f2.p = 5000;
    f2.m = 5000;
    run(m2, 2, [{ at: 0, cmd: { type: 'research', upgradeId: 'staff' } }]);
    expect(f2.upgrades.research?.id).toBe('staff');
    expect(f2.autoResearch).toBe(true);
  }, 60_000);

  it('a manual directive pauses the auto HQ; it resumes after auto_resume_s, at once on advance or the toggle', () => {
    const quick: GameData = { ...data, rules: { ...data.rules, command: { ...data.rules.command, auto_resume_s: 60 } } };
    const m = makeMatch(quick);
    const w = m.world;
    const f = w.factions[0];
    let pausedAt20 = false;
    run(m, 30, [{ at: 10, cmd: { type: 'setDirective', kind: 'defend' } }], (t) => {
      if (t === 20) pausedAt20 = !autoCommandActive(w, f) && f.directive.manual && f.directive.kind === 'defend';
    });
    expect(pausedAt20).toBe(true);
    // Past auto_resume_s the HQ takes the directive back (its next think adopts or replaces it).
    run(m, 50);
    expect(autoCommandActive(w, f)).toBe(true);
    expect(f.directive.manual).toBe(false);
    // A manual advance hands it back at once; the toggle does too.
    run(m, 2, [{ at: Math.round(w.time), cmd: { type: 'setDirective', kind: 'fortify' } }]);
    expect(autoCommandActive(w, f)).toBe(false);
    run(m, 1, [{ at: Math.round(w.time), cmd: { type: 'setDirective', kind: 'advance' } }]);
    expect(autoCommandActive(w, f)).toBe(true);
    run(m, 1, [{ at: Math.round(w.time), cmd: { type: 'setDirective', kind: 'contract' } }]);
    expect(autoCommandActive(w, f)).toBe(false);
    run(m, 1, [{ at: Math.round(w.time), cmd: { type: 'setAutoCommand', on: true } }]);
    expect(autoCommandActive(w, f)).toBe(true);
  }, 120_000);

  it('the three toggles go through the bus, boolean only', () => {
    const m = makeMatch();
    const bus = new CommandBus();
    const outs: boolean[] = [];
    bus.onResult = (_e, o) => outs.push(o.ok);
    for (const type of ['setAutoResearch', 'setAutoEngineering', 'setAutoCommand'] as const) {
      bus.issue(m, 0, { type, on: 'yes' } as unknown as Command);
      bus.issue(m, 0, { type, on: undefined } as unknown as Command);
      bus.issue(m, 0, { type, on: false });
    }
    bus.flush(m);
    expect(outs).toEqual([false, false, true, false, false, true, false, false, true]);
  }, 60_000);

  it('is deterministic with the player on auto', () => {
    const hash = (): string => {
      const m = makeMatch();
      const w = m.world;
      let h = 2166136261 >>> 0;
      const mix = (v: number): void => { h = Math.imul(h ^ Math.round(v * 1000), 16777619) >>> 0; };
      run(m, 300, [], (t) => {
        if (t % 10 !== 0) return;
        for (const u of w.units.values()) { mix(u.id); mix(u.pos.x); mix(u.pos.z); mix(u.hp); }
        for (const f of w.factions) { mix(f.p); mix(f.m); mix(f.upgrades.owned); mix(f.upgrades.fundP); }
      });
      return `${h.toString(16)}:${w.factions[0].directive.kind}`;
    };
    expect(hash()).toBe(hash());
  }, 240_000);
});
