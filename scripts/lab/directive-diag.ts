/**
 * 2.2 directive diagnostic: an all-AI war, logging every directive change of every faction and, every
 * 5 min, how its fronts answer (response keys). `npx tsx scripts/lab/directive-diag.ts [minutes=30] [seed=7]`
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { createMatch, step } from '../../src/sim/sim';

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const minutes = Number(process.argv[2] ?? 30);
const seed = Number(process.argv[3] ?? 7);
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const last = w.factions.map((f) => f.directive);
const share = w.factions.map(() => new Map<string, number>());
for (let i = 0; i < minutes * 60 * w.tickHz && !w.result; i++) {
  step(m);
  w.fx.length = 0;
  for (const f of w.factions) {
    if (f.directive !== last[f.id]) {
      last[f.id] = f.directive;
      const d = f.directive;
      console.log(`t=${w.time.toFixed(0)}s F${f.id} → ${d.kind}${d.axis ? ` axis ${Math.round(d.axis.x)},${Math.round(d.axis.z)}` : ''}`);
    }
  }
  if (i % (5 * w.tickHz) === 0) {
    for (const f of w.factions) for (const s of f.fronts) share[f.id].set(s.response, (share[f.id].get(s.response) ?? 0) + 1);
  }
  if (i > 0 && i % (300 * w.tickHz) === 0) {
    console.log(`--- ${Math.round(w.time / 60)} min: fronts ${w.factions.map((f) => f.fronts.length).join('/')}`);
  }
}
for (const f of w.factions) {
  const tot = [...share[f.id].values()].reduce((a, b) => a + b, 0) || 1;
  console.log(`F${f.id} responses: ${[...share[f.id].entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / tot)}%`).join(', ')}`);
}
console.log(w.result ? `result: ${JSON.stringify(w.result)}` : 'no result');
