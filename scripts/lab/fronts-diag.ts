/**
 * Fronts diagnostic (2.0 command hierarchy, docs/STRATEGY_LAB.md "Round 6"): per minute, every AI
 * faction's fronts (id, order, units, op/phase) and the supreme-HQ log lines (front opened /
 * merged / fall back / counter-strike), plus a count of structural changes per faction.
 *
 *   npx tsx scripts/lab/fronts-diag.ts [minutes=20] [seed=7]
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { createMatch, step } from '../../src/sim/sim';

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const minutes = Number(process.argv[2] ?? 20);
const seed = Number(process.argv[3] ?? 7);
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const KEYS = new Set(['log.frontOpened', 'log.frontMerged', 'log.frontFallBack', 'log.counterStrike', 'log.homeThreat', 'log.commanderLost']);
const counts = new Map<string, number>();
const seen = new WeakSet<object>();
for (let i = 0; i < minutes * 60 * w.tickHz && !w.result; i++) {
  step(m);
  w.fx.length = 0;
  // The log is capped (400): walk back from the tail to the first entry already seen.
  const fresh = [];
  for (let k = w.log.length - 1; k >= 0 && !seen.has(w.log[k]); k--) fresh.push(w.log[k]);
  for (const e of fresh.reverse()) {
    seen.add(e);
    if (!KEYS.has(e.key)) continue;
    const k = `${e.faction}:${e.key}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (e.key !== 'log.commanderLost') console.log(`  ${w.time.toFixed(0)}s f${e.faction} ${e.key} ${JSON.stringify(e.params)}`);
  }
  if ((i + 1) % (60 * w.tickHz) !== 0) continue;
  const line = w.factions.filter((f) => f.alive).map((f) => {
    const fr = f.fronts.map((s) => {
      let n = 0;
      for (const u of w.units.values()) if (u.owner === f.id && u.frontId === s.id && u.hp > 0 && !u.fixed) n++;
      return `${s.id}${s.order.kind[0]}${s.wing < 0 ? 'L' : s.wing > 0 ? 'R' : 'C'}:${n}${s.opPhase ? `/${s.op[0]}${s.opPhase[0]}` : ''}`;
    }).join(' ');
    const guards = [...w.units.values()].filter((u) => u.owner === f.id && u.hp > 0 && u.opObjective === `hq:${f.id}`).length;
    return `f${f.id}[${fr}] g${guards}`;
  }).join(' | ');
  console.log(`t=${Math.round(w.time / 60)}m ${line}`);
}
console.log([...counts.entries()].sort().map(([k, v]) => `${k} ${v}`).join('\n'));
