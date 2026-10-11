// Economic raid trace (2.2 strategy round): each party's launch, closest approach, losses, and outcome.
// npx tsx scripts/lab/raid-diag.ts [seed=11] [minutes=30]
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { createMatch, step } from '../../src/sim/sim';
import { ECON_WAR_STATS } from '../../src/sim/econwar';

const seed = Number(process.argv[2] ?? 11);
const minutes = Number(process.argv[3] ?? 30);
const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
interface P { f: number; tag: string; start: number; ids: Set<number>; best: number; dead: number; bhp0: number; status: Record<string, number>; done: boolean }
const parties = new Map<string, P>();
for (let i = 0; i < minutes * 60 * w.tickHz && !w.result; i++) {
  step(m);
  w.fx.length = 0;
  if (w.tick % w.tickHz !== 0) continue;
  const live = new Map<string, number[]>();
  for (const u of w.aliveUnits) {
    if (u.hp <= 0 || !u.opObjective?.startsWith('econ:') || u.opRole !== 'raid') continue;
    const key = `${u.owner}:${u.opObjective}`;
    (live.get(key) ?? live.set(key, []).get(key)!).push(u.id);
    let p = parties.get(key);
    const b = w.econ.find((x) => `econ:${x.id}` === u.opObjective);
    if (!p) { p = { f: u.owner, tag: u.opObjective, start: w.time, ids: new Set(), best: 1e9, dead: 0, bhp0: b?.hp ?? 0, status: {}, done: false }; parties.set(key, p); }
    p.ids.add(u.id);
    if (b) p.best = Math.min(p.best, Math.hypot(b.pos.x - u.pos.x, b.pos.z - u.pos.z));
    p.status[u.status] = (p.status[u.status] ?? 0) + 1;
  }
  for (const [key, p] of parties) {
    if (p.done || live.has(key)) continue;
    p.done = true;
    for (const id of p.ids) { const u = w.unitAlive(id); if (!u || u.hp <= 0) p.dead++; }
    const b = w.econ.find((x) => `econ:${x.id}` === p.tag);
    console.log(`F${p.f} ${p.tag} t=${Math.round(p.start)}-${Math.round(w.time)} n=${p.ids.size} dead=${p.dead} closest=${Math.round(p.best)} bhp ${Math.round(p.bhp0)}→${b ? Math.round(b.hp) : '?'}${b?.ruined ? ' RUINED' : ''} ${JSON.stringify(p.status)}`);
  }
}
console.log(JSON.stringify(ECON_WAR_STATS), 'buildings', w.econ.length);
