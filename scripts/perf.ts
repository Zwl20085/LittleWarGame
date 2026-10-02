import { readFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import { NavGrid } from '../src/sim/nav';
import { populationCap } from '../src/sim/production';
const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const mapId = (process.argv[2] ?? 'four_cities') as 'four_cities' | 'generated';
const secs = Number(process.argv[3] ?? 90);
const m = createMatch(data, { mapId, factions: 4, infoMode: 'open', seed: Number(process.argv[4] ?? 7), difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const t0 = performance.now();
let last = performance.now();
const stuckMap = new Map<number, { x: number; z: number; t: number }>();
import { Ground } from '../src/sim/terrain';
let lastBuilds = 0;
// Report every 60 s of game time: mean ms/tick and flow-field builds/s over the window.
const WINDOW = 1200;
for (let i = 0; i < 20 * secs; i++) {
  step(m); w.fx.length = 0;
  if (i % WINDOW === WINDOW - 1) {
    const now = performance.now();
    const held = w.factions.map((f) => w.objectives.filter((o) => o.owner === f.id).length).join('/');
    const inc = w.factions.map((f) => `${Math.round(f.incomeP)}p${Math.round(f.incomeM)}m`).join(' ');
    const arty = w.log.filter((l) => l.key === 'log.unitLost' && (l.params.unit === 'howitzer' || l.params.unit === 'mortar')).length;
    const spear = w.log.filter((l) => l.key === 'log.spearhead').length;
    const modes = w.factions.map((f) => f.sectors.map((s) => s.mode[0]).join('')).join(' ');
    let stuck = 0, stuckFord = 0, stuckWater = 0;
    for (const u of w.units.values()) {
      if (u.fixed || u.hp <= 0) continue;
      const prev = stuckMap.get(u.id);
      const wants = u.path.length > 0 && u.targetId === null;
      if (prev && wants && Math.hypot(u.pos.x - prev.x, u.pos.z - prev.z) < 3) {
        stuck++;
        let ford = false, water = false;
        for (let a = 0; a < 6.28; a += 0.8) { const g = w.terrain.groundAt(u.pos.x + Math.cos(a) * 25, u.pos.z + Math.sin(a) * 25); if (g === Ground.Ford) ford = true; if (g === Ground.Water) water = true; }
        if (ford) stuckFord++; else if (water) stuckWater++;
      }
      stuckMap.set(u.id, { x: u.pos.x, z: u.pos.z, t: w.time });
    }
    const bridges = w.forts.filter((x) => x.kind === 'pontoon').map((x) => Math.round(x.progress * 100)).join(',');
    const all = [...w.units.values()].filter((u) => !u.fixed && u.hp > 0);
    const crowd = all.reduce((a, u) => a + w.spatial.query(u.pos.x, u.pos.z, 30).filter((o) => o.owner === u.owner).length - 1, 0) / Math.max(1, all.length);
    const raidN = all.filter((u) => u.opRole === 'raid').length, guardN = all.filter((u) => u.opRole === 'rearguard').length;
    const raids = w.log.filter((l) => l.key === 'log.raidLaunched').length;
    const trucksLost = w.log.filter((l) => l.key === 'log.unitLost' && l.params.unit === 'supply_truck').length;
    console.log(`t=${Math.round(w.time)}s units ${w.units.size} ${((now - last) / WINDOW).toFixed(1)}ms/tick ff ${((NavGrid.builds - lastBuilds) / (WINDOW / 20)).toFixed(2)}/s held ${held} inc ${inc} lost ${w.factions.map((f) => f.lostUnits).join('/')} R ${w.factions.map((f) => Math.round(f.resolve)).join('/')} pop ${w.factions.map((f) => f.popPresent + '+' + f.popReserved).join('/')} stock ${w.factions.map((f) => Math.round(f.p) + '|' + Math.round(f.m)).join(' ')} artyLost ${arty} trucksLost ${trucksLost} raids ${raids} onRaid ${raidN} guards ${guardN} crowd ${crowd.toFixed(1)} stuck ${stuck}(ford ${stuckFord} water ${stuckWater}) pontoons [${bridges}] popCap ${w.factions.map((f) => populationCap(w, f)).join('/')} spear ${spear} modes ${modes}`);
    last = now;
    lastBuilds = NavGrid.builds;
  }
}
console.log(`units ${w.units.size} perTick ${((performance.now() - t0) / (20 * secs)).toFixed(1)}ms`);
const trucks = [...w.units.values()].filter((u) => u.def.id === 'supply_truck');
const states: Record<string, number> = {};
for (const t of trucks) states[t.truckState] = (states[t.truckState] ?? 0) + 1;
const nonTruck = [...w.units.values()].filter((u) => !u.fixed && u.def.id !== 'supply_truck');
console.log('trucks', trucks.length, JSON.stringify(states), 'avgAmmo', (nonTruck.reduce((a, u) => a + u.ammo, 0) / nonTruck.length).toFixed(2), 'supplied', (nonTruck.filter((u) => u.supplied).length / nonTruck.length).toFixed(2), 'depot', w.factions.map((f) => Math.round(f.depot)).join('/'));
console.log('raids', w.log.filter((l) => l.key === 'log.raid').length, 'convoyThreat', w.log.filter((l) => l.key === 'log.convoyThreat').length, 'trucksLost', w.log.filter((l) => l.key === 'log.unitLost' && l.params.unit === 'supply_truck').length);
console.log('fieldBuilds', NavGrid.builds, 'perSec', (NavGrid.builds / secs).toFixed(2));
