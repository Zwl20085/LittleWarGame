/**
 * 2.1 diagnostics (fronts agent): fronts per faction over time, with units / order / zone garrison.
 * Usage: npx tsx scripts/lab/fronts21-diag.ts [seed=11] [minutes=10] [every=60]
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { createMatch, step } from '../../src/sim/sim';
import { frontUnits } from '../../src/sim/fronts';
import { desiredFronts, garrisonsZone, theatreAxes } from '../../src/sim/theatre';
import { transferable } from '../../src/sim/frontops';
import { isCommander } from '../../src/sim/formulas';

const seed = Number(process.argv[2] ?? 11);
const minutes = Number(process.argv[3] ?? 10);
const every = Number(process.argv[4] ?? 60);
const match = createMatch(buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8')), { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const { world } = match;
for (let t = 1; t <= minutes * 60; t++) {
  for (let i = 0; i < world.tickHz; i++) {
    step(match);
    world.fx.length = 0;
  }
  if (t % every !== 0) continue;
  const rows = world.factions.filter((f) => f.alive).map((f) => {
    const fr = f.fronts.map((s) => {
      const n = frontUnits(world, f.id, s.id).filter((u) => !isCommander(u.def) && u.def.id !== 'supply_truck').length;
      return `${s.id}:${s.name}/${s.order.kind}${s.order.manual ? '!' : ''}${garrisonsZone(s) ? 'Z' : ''}/${n}`;
    });
    let total = 0;
    let free = 0;
    for (const u of world.units.values()) {
      if (u.owner !== f.id || u.hp <= 0 || u.fixed || isCommander(u.def) || u.def.id === 'supply_truck') continue;
      total++;
      if (transferable(u)) free++;
    }
    const want = desiredFronts(world, theatreAxes(world, f), total);
    return `F${f.id} z${f.zones.length} t${total} f${free} w${want} [${fr.join(' ')}]`;
  });
  console.log(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}  ${rows.join('  |  ')}`);
}
