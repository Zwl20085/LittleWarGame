// 3.0 pace probe (WP-T): why do 4-FFA wars not end? Runs one AI war headless and every `--every`
// minutes prints, per faction: settlements held, population, the HQ's finish target and finisher
// flag, the directive, the doctrine phase / target, own units within 400 m of the finish target's
// capital, and that capital's perimeter (strongpoints standing, crews alive, ring supported).
// Eliminations are printed as they happen.
//
//   npx tsx scripts/lab30/pace.ts [--seed 13] [--minutes 60] [--every 3]      (LAB_SET env: overrides)
import { perimeterOf, perimeterPosts, ringSupported } from '../../src/sim/capitalDefence';
import { doctrinePhase } from '../../src/sim/doctrineai';
import { step } from '../../src/sim/sim';
import { dist } from '../../src/sim/vec';
import { argNum, labMatch, loadData, parseArgs } from './common';

const a = parseArgs(process.argv.slice(2));
const seed = argNum(a, 'seed', 13);
const minutes = argNum(a, 'minutes', 60);
const every = argNum(a, 'every', 3);
const m = labMatch(loadData(), { seed, factions: 4 });
const w = m.world;
const dead = new Set<number>();
console.log(`seed ${seed}: doctrines ${w.factions.map((f) => `${f.id}=${f.doctrine}`).join(' ')}`);
for (let i = 0; i < minutes * 60 * w.tickHz && !w.result; i++) {
  step(m);
  w.fx.length = 0;
  for (const f of w.factions) if (!f.alive && !dead.has(f.id)) { dead.add(f.id); console.log(`  ** t=${(w.time / 60).toFixed(1)} faction ${f.id} eliminated`); }
  if ((i + 1) % (every * 60 * w.tickHz) !== 0) continue;
  console.log(`t=${Math.round(w.time / 60)} min`);
  for (const f of w.factions) {
    if (!f.alive) continue;
    const held = w.objectives.filter((o) => o.owner === f.id && o.kind !== 'point').length;
    const fin = f.command.finishTarget;
    const dp = doctrinePhase(f);
    const tgt = dp.phase === 'offensive' && dp.target >= 0 ? dp.target : fin;
    const near = tgt >= 0 ? w.aliveUnits.filter((u) => u.owner === f.id && u.hp > 0 && !u.fixed && dist(u.pos, w.hqPos(tgt)) < 400).length : 0;
    const ring = (id: number): string => {
      const sp = perimeterOf(w, id).filter((x) => x.hp > 0).length;
      const crews = perimeterPosts(w).filter((p) => p.owner === id && w.unitAlive(p.crewId)).length;
      return `${sp}sp/${crews}crew${ringSupported(w, id) ? '' : ' unsupported'}`;
    };
    const home = w.aliveUnits.filter((u) => u.owner === f.id && u.hp > 0 && !u.fixed && dist(u.pos, w.hqPos(f.id)) < 400).length;
    console.log(`  f${f.id} ${f.doctrine.padEnd(9)} held ${String(held).padStart(2)} pop ${String(f.popPresent).padStart(3)} home ${String(home).padStart(3)} ring ${ring(f.id)} | fin ${fin} finisher ${f.command.finisher ? 'Y' : 'n'} ratio ${f.command.finishArmyRatio.toFixed(2)} aggr ${f.command.aggression.toFixed(2)} full ${f.command.fullness.toFixed(2)} | dir ${f.directive.kind} | doct ${dp.phase}${dp.phase === 'offensive' ? `→${dp.target}` : ''} | near tgt(${tgt}) ${near}`);
  }
}
console.log(w.result ? `RESULT ${w.result.reason} winners ${w.result.winners.join(',')} at ${(w.result.tick / w.tickHz / 60).toFixed(1)} min` : `no result after ${minutes} min`);
