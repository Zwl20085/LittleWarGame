import { it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';
const run = process.env.PERF ? it : it.skip;
run('perf 4ffa', () => {
  const m = createMatch(loadGameData(), { mapId: 'four_cities', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  const t0 = performance.now();
  for (let i = 0; i < 20 * 90; i++) { step(m); w.fx.length = 0; }
  console.log(`units ${w.units.size} perTick ${((performance.now() - t0) / 1800).toFixed(1)}ms`);
}, 900000);
