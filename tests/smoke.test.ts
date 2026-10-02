import { describe, it, expect } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';

describe('AI vs AI smoke', () => {
  it('runs a 4-faction 10x match for 200 s with real combat', () => {
    const data = loadGameData();
    const match = createMatch(data, { mapId: 'four_cities', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true });
    const w = match.world;
    const t0 = performance.now();
    let firstShot = -1;
    for (let i = 0; i < 20 * 200; i++) {
      step(match);
      if (firstShot < 0 && w.fx.some((e) => e.t === 'tracer' || e.t === 'muzzle')) firstShot = w.time;
      w.fx.length = 0;
    }
    const ms = performance.now() - t0;
    const summary = w.factions.map((f) => ({
      id: f.id, alive: f.alive, p: Math.round(f.p), m: Math.round(f.m), resolve: Math.round(f.resolve),
      units: [...w.units.values()].filter((u) => u.owner === f.id && !u.fixed).length,
      produced: f.producedUnits, lost: f.lostUnits, alloc: f.alloc.map((a) => a.toFixed(2)).join('/'),
    }));
    console.log(JSON.stringify({ ms: Math.round(ms), perTick: (ms / 7200).toFixed(2), firstShot, summary, objectives: w.objectives.map((o) => [o.id, o.owner]) }, null, 1));
    console.log(w.log.slice(-15).map((l) => `${l.tick / 20}s f${l.faction} ${l.key} ${JSON.stringify(l.params)}`).join('\n'));
    expect(firstShot).toBeGreaterThan(0);
    expect(summary.every((s) => s.produced > 0)).toBe(true);
  }, 120000);
});
