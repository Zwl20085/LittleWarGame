import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { CommandBus } from '../src/sim/commands';
import { thinkInvestment } from '../src/sim/econai';

const data = loadGameData();

/** 2.2.1 (user: 让玩家也是默认自动投资): the player's HQ staff invest too, unless switched off. */
describe('2.2.1 player auto-investment', () => {
  const makeMatch = (): ReturnType<typeof createMatch> => {
    const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: 21, difficulty: 'normal', playerSlot: 0, spectate: false });
    m.world.spatial.rebuild(m.world.aliveUnits);
    return m;
  };

  it('is on by default for the player, who then gets economic buildings without building by hand', () => {
    const m = makeMatch();
    const w = m.world;
    const f = w.factions[0];
    expect(f.isPlayer).toBe(true);
    expect(f.autoInvest).toBe(true);
    f.p = 3000;
    f.m = 3000;
    thinkInvestment(w, f);
    expect(w.econ.some((b) => b.owner === f.id)).toBe(true);
  });

  it('switched off: the money set aside goes back to the stock and nothing more is built', () => {
    const m = makeMatch();
    const w = m.world;
    const f = w.factions[0];
    f.econFund = { p: 80, m: 120, active: true };
    const before = { p: f.p, m: f.m };
    const bus = new CommandBus();
    bus.issue(m, 0, { type: 'setAutoInvest', on: false });
    bus.flush(m);
    expect(f.autoInvest).toBe(false);
    expect(f.econFund.p).toBe(0);
    expect(f.econFund.m).toBe(0);
    expect(f.p).toBeCloseTo(before.p + 80, 6);
    expect(f.m).toBeCloseTo(before.m + 120, 6);
    f.p = 3000;
    f.m = 3000;
    thinkInvestment(w, f);
    expect(w.econ.some((b) => b.owner === f.id)).toBe(false);
  });
});
