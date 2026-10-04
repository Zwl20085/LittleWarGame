/**
 * All-in rush diagnostic (docs/STRATEGY_LAB.md "Round 6"): at minute `at` one faction throws its
 * whole mobile army at faction 0's capital (as a player exploiting the AI would); prints faction
 * 0's home-defence state, guards, recalls, counter-strikes and the capital's capture state.
 *
 *   npx tsx scripts/lab/rush-diag.ts [seed=11] [at=5] [minutes=6] [march=0]
 * march=1: the army marches from where it stands (a player's rush); else it is placed 700 m out.
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { createMatch, step } from '../../src/sim/sim';
import { issueFrontOrder } from '../../src/sim/fronts';
import { counterStrikes } from '../../src/sim/frontref';
import { isCommander } from '../../src/sim/formulas';
import { capitalDefence } from '../../src/sim/storm';
import { dist, headingTo } from '../../src/sim/vec';

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const seed = Number(process.argv[2] ?? 11);
const at = Number(process.argv[3] ?? 5);
const minutes = Number(process.argv[4] ?? 6);
const march = process.argv[5] === '1';
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const tick = (s: number): void => { for (let i = 0; i < s * w.tickHz && !w.result; i++) { step(m); w.fx.length = 0; } };
tick(at * 60);
const victim = w.factions[0];
const raider = w.factions.find((x) => x.alive && x.id !== 0 && w.isHostile(0, x.id))!;
const hq = w.hqPos(0);
const toward = headingTo(hq, w.hqPos(raider.id));
const army = [...w.units.values()].filter((u) => u.owner === raider.id && u.hp > 0 && !u.fixed && !isCommander(u.def) && u.def.id !== 'supply_truck');
army.forEach((u, i) => {
  if (march) { u.opRole = 'line'; u.spearhead = 'hq:0'; return; }
  u.pos = { ...w.terrain.freeNear({ x: hq.x + Math.cos(toward) * (700 + (i % 5) * 12) + (i % 7) * 8, z: hq.z + Math.sin(toward) * (700 + (i % 5) * 12) + Math.floor(i / 7) * 8 }, 60) };
  u.path = []; u.dest = null; u.opRole = 'line'; u.spearhead = 'hq:0';
});
for (const s of raider.fronts) issueFrontOrder(w, raider, s, { kind: 'attack', a: { ...hq }, b: null, issuedAt: w.time, manual: true });
console.log(`rush: faction ${raider.id} sends ${army.length} units at capital 0 (t=${w.time}s)`);
const value = (f: number, r = Infinity): number => [...w.units.values()].filter((u) => u.owner === f && u.hp > 0 && !u.fixed && !isCommander(u.def) && u.def.id !== 'supply_truck' && dist(u.pos, hq) < r).reduce((a, u) => a + (u.def.costP + u.def.costM) * u.hp / u.def.maxHp, 0);
for (let k = 0; k < minutes * 6 && !w.result; k++) {
  tick(10);
  const ht = victim.command.homeThreat;
  const guards = [...w.units.values()].filter((u) => u.owner === 0 && u.hp > 0 && u.opObjective === 'hq:0').length;
  const near = army.filter((u) => u.hp > 0 && dist(u.pos, hq) < 300).length;
  const cs = w.factions.flatMap((x) => x.fronts.filter((s) => counterStrikes.has(s)).map((s) => `f${x.id}#${s.id}->${s.targetCity}`)).join(',');
  const defR = w.factions.filter((x) => x.id !== raider.id && x.alive).map((x) => Math.round(capitalDefence(w, x.id, raider.id))).join('/');
  console.log(`t=${Math.round(w.time)}s alive0=${victim.alive} hqProg=${JSON.stringify(w.factions[raider.id].hqProgress)} lvl=${ht.level.toFixed(2)} aimed=${Math.round(ht.aimed)} active=${ht.active} recall=[${ht.recall}] guards=${guards} raidersAlive=${army.filter((u) => u.hp > 0).length} atGates=${near} v0=${Math.round(value(0))} home0=${Math.round(value(0, 450))} vR=${Math.round(value(raider.id))} raiderCapDef=${defR} cs=[${cs}] finish0=${victim.command.finishTarget}`);
}
