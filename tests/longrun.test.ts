import { describe, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch, step } from '../src/sim/sim';

// Long AI-vs-AI runs for balance diagnostics; enable with LONGRUN=1.
const run = process.env.LONGRUN ? it : it.skip;

describe('long AI runs', () => {
  for (const [mapId, factions] of [['greystone_pinecreek', 2], ['four_cities', 4]] as const) {
    run(`${mapId} full match`, () => {
      const data = loadGameData();
      const match = createMatch(data, { mapId, factions, infoMode: 'open', seed: 11, difficulty: 'normal', playerSlot: 0, spectate: true });
      const w = match.world;
      const t0 = performance.now();
      let worst = 0;
      while (!w.result && w.time < 2760) {
        const a = performance.now();
        step(match);
        worst = Math.max(worst, performance.now() - a);
        w.fx.length = 0;
        if (w.tick % (20 * 300) === 0) {
          const s = w.factions.map((f) => `f${f.id}:${f.alive ? 'A' : 'X'} R${Math.round(f.resolve)} u${[...w.units.values()].filter((u) => u.owner === f.id && !u.fixed).length} lost${f.lostUnits} p${Math.round(f.p)} m${Math.round(f.m)}`).join(' | ');
          console.log(`${Math.round(w.time / 60)}min ${s} obj=${w.objectives.map((o) => o.owner).join(',')}`);
        }
      }
      console.log(`${mapId} result`, JSON.stringify(w.result), `time ${Math.round(w.time)}s`, `avg ${((performance.now() - t0) / w.tick).toFixed(2)}ms/tick worst ${worst.toFixed(1)}ms`);
    }, 900000);
  }
});
