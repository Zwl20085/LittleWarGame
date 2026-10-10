// Diagnostic trace for the 2.2 strategy round: tanks per front (block mode, opRoles, cluster sizes)
// and economic raid parties. npx tsx scripts/lab/war22-diag.ts [seed=7] [minutes=20]
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { createMatch, step } from '../../src/sim/sim';
import { armourMode, isTank } from '../../src/sim/armour';

const seed = Number(process.argv[2] ?? 7);
const minutes = Number(process.argv[3] ?? 20);
const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
let logAt = 0;
for (let i = 0; i < minutes * 60 * w.tickHz && !w.result; i++) {
  step(m);
  w.fx.length = 0;
  for (; logAt < w.log.length; logAt++) {
    const e = w.log[logAt];
    if (e.key === 'log.econRaid' || e.key === 'log.armourMassed' || e.key === 'log.econLost') console.log(`  t=${Math.round(w.time)} F${e.faction} ${e.key} ${JSON.stringify(e.params)}`);
  }
  if (w.tick % (60 * w.tickHz) !== 0) continue;
  console.log(`t=${Math.round(w.time / 60)} min`);
  for (const f of w.factions) {
    if (!f.alive) continue;
    const tanks = w.aliveUnits.filter((u) => u.owner === f.id && u.hp > 0 && isTank(u));
    const roles: Record<string, number> = {};
    for (const u of tanks) { const k = u.spearhead ? 'spear' : u.opRole + (u.rearming ? '/rearm' : '') + (u.behavior !== 'advance' ? `/${u.behavior}` : ''); roles[k] = (roles[k] ?? 0) + 1; }
    const fronts = f.fronts.map((s) => {
      const t = tanks.filter((u) => u.frontId === s.id && !u.spearhead && u.opRole === 'line');
      return `${s.id}${s.id === f.mainFront ? '*' : ''}:${s.mode}/${armourMode(s) || '-'} t${t.length}`;
    }).join(' ');
    const raiders = w.aliveUnits.filter((u) => u.owner === f.id && u.opObjective?.startsWith('econ:'));
    const raid = raiders.length;
    for (const u of raiders) {
      const b = w.econ.find((x) => `econ:${x.id}` === u.opObjective);
      console.log(`    raider ${u.def.id}#${u.id} ${u.status} d=${b ? Math.round(Math.hypot(b.pos.x - u.pos.x, b.pos.z - u.pos.z)) : '?'} bhp=${b ? Math.round(b.hp) : '?'} hp=${Math.round((100 * u.hp) / u.def.maxHp)}% moving=${u.moving} pathFailed=${u.pathFailed} ammo=${u.ammo.toFixed(2)}`);
    }
    const bld = w.econ.filter((b) => b.owner === f.id && !b.ruined).length;
    console.log(`  F${f.id} ${f.directive.kind} tanks ${tanks.length} ${JSON.stringify(roles)} | ${fronts} | econRaiders ${raid} bld ${bld} full ${f.command.fullness.toFixed(2)} cells ${w.frontInfo[f.id]?.cells.length ?? 0}`);
  }
}
