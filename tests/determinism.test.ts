import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';

/** FNV-1a over the exact float64 bits of the state that matters (positions, hp, morale, ammo, economy). */
function stateHash(seconds: number): { hash: string; units: number } {
  const match = createMatch(loadGameData(), {
    mapId: 'generated', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true,
  });
  const w = match.world;
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  let h = 2166136261 >>> 0;
  const mix = (v: number): void => {
    f64[0] = v;
    h = Math.imul(h ^ u32[0], 16777619) >>> 0;
    h = Math.imul(h ^ u32[1], 16777619) >>> 0;
  };
  for (let i = 1; i <= seconds * w.tickHz; i++) {
    step(match);
    w.fx.length = 0;
    // Sample every 10 s so a divergence anywhere along the run changes the hash.
    if (i % (10 * w.tickHz) !== 0) continue;
    for (const u of w.units.values()) {
      mix(u.id); mix(u.pos.x); mix(u.pos.z); mix(u.hp); mix(u.morale); mix(u.ammo); mix(u.targetId ?? -1);
    }
    for (const f of w.factions) { mix(f.p); mix(f.m); mix(f.resolve); }
    for (const o of w.objectives) mix(o.owner);
    mix(w.rngAi.seed); mix(w.rngCombat.seed); mix(w.rngScatter.seed);
  }
  return { hash: h.toString(16), units: w.units.size };
}

describe('determinism', () => {
  it('same seed and commands give identical state after 120 s (generated map, seed 7)', () => {
    const a = stateHash(120);
    const b = stateHash(120);
    expect(a.units).toBeGreaterThan(100);
    expect(b).toEqual(a);
  }, 300000);
});
