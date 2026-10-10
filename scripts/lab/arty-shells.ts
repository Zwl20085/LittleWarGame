// Artillery ammunition use from balance.ts ledgers: shells fired, damage dealt and damage per shell
// for mortars and howitzers, and their damage to infantry (kill matrix).
//   npx tsx scripts/lab/arty-shells.ts [dir=media/stats] [seeds=7,11,13,17]
import { readFileSync } from 'node:fs';

const dir = process.argv[2] ?? 'media/stats';
const seeds = (process.argv[3] ?? '7,11,13,17').split(',');
interface T { shots: number; dmgDealt: number; kills: number }
interface L { byType: Record<string, T>[]; matrix: Record<string, Record<string, { dmg: number; kills: number }>> }
for (const id of ['mortar', 'howitzer']) {
  let shots = 0, dmg = 0, inf = 0;
  const per: string[] = [];
  for (const s of seeds) {
    const l = JSON.parse(readFileSync(`${dir}/generated-${s}.json`, 'utf8')) as L;
    let sh = 0;
    for (const t of l.byType) { sh += t[id]?.shots ?? 0; dmg += t[id]?.dmgDealt ?? 0; }
    shots += sh;
    per.push(`s${s} ${sh}`);
    for (const v of ['infantry', 'recon', 'engineer', 'motor_inf']) inf += l.matrix[id]?.[v]?.dmg ?? 0;
  }
  console.log(`${id.padEnd(9)} shells ${shots} (${per.join(' ')}) dmg ${Math.round(dmg)} dmg/shell ${(dmg / Math.max(1, shots)).toFixed(1)} dmg→foot ${Math.round(inf)} (${(inf / Math.max(1, shots)).toFixed(1)}/shell)`);
}
