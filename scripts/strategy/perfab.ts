// Overhead check for the strategy layer: ms/tick with the battle log + adaptive AI on vs off
// (same code, same seed). Usage: npx tsx scripts/strategy/perfab.ts [seconds=300] [seed=7] [mode=on|off]
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { createMatch, step } from '../../src/sim/sim';
import { STRATEGY_AI } from '../../src/sim/strategyai';

const secs = Number(process.argv[2] ?? 300);
const seed = Number(process.argv[3] ?? 7);
const on = (process.argv[4] ?? 'on') === 'on';
STRATEGY_AI.adaptive = on;
const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
m.world.battle.enabled = on;
const t0 = performance.now();
for (let i = 0; i < 20 * secs; i++) {
  step(m);
  m.world.fx.length = 0;
}
console.log(`${on ? 'on ' : 'off'} units ${m.world.units.size} perTick ${((performance.now() - t0) / (20 * secs)).toFixed(2)}ms`);
