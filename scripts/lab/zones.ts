/**
 * 2.1 zone probe (fortress agent): fortified zones outlive the orders that created them.
 *
 *   npx tsx scripts/lab/zones.ts [seed=7] [minutes=8] [faction=1]
 *
 * An AI faction (spectated match, no player) gets two Fortify orders on its main front 60 s apart,
 * on two lines toward its nearest enemy (500 m and 800 m out). The AI supreme HQ then gives its
 * fronts whatever orders it likes; every minute the probe prints each zone's works (finished +
 * sites per kind, occupants) and the front's current order, so both zones can be seen being built.
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import { issueFrontOrder } from '../../src/sim/fronts';
import { createMatch, step } from '../../src/sim/sim';
import { isStructure } from '../../src/sim/structures';
import type { Faction, Zone } from '../../src/sim/types';
import { dist, headingTo, type V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';

const seed = Number(process.argv[2] ?? 7);
const minutes = Number(process.argv[3] ?? 8);
const fid = Number(process.argv[4] ?? 1);
const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const f = w.factions[fid];

function run(seconds: number): void {
  for (let i = 0; i < seconds * w.tickHz && !w.result; i++) {
    step(m);
    w.fx.length = 0;
  }
}

/** A 200 m line square to the bearing toward the nearest enemy capital, `r` m out from ours. */
function lineAt(world: World, fac: Faction, r: number): { a: V2; b: V2 } {
  const hq = world.hqPos(fac.id);
  const foe = world.factions.filter((x) => x.id !== fac.id).map((x) => world.hqPos(x.id)).sort((p, q) => dist(p, hq) - dist(q, hq))[0];
  const bearing = headingTo(hq, foe);
  const nav = world.nav(false, 35);
  const c = nav.nearestPassable({ x: hq.x + Math.cos(bearing) * r, z: hq.z + Math.sin(bearing) * r }, 60) ?? hq;
  const along = bearing + Math.PI / 2;
  return { a: { x: c.x - Math.cos(along) * 100, z: c.z - Math.sin(along) * 100 }, b: { x: c.x + Math.cos(along) * 100, z: c.z + Math.sin(along) * 100 } };
}

function segDist(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

function zoneLine(z: Zone): string {
  const works = w.forts.filter((x) => x.owner === f.id && x.hp > 0 && segDist(x.pos, z.a, z.b) < 60);
  const kind = (k: string): string => {
    const all = works.filter((x) => x.kind === k);
    const done = all.filter((x) => x.progress >= 1);
    const occ = done.reduce((n, x) => n + (isStructure(x.kind) ? x.occupants?.length ?? 0 : 0), 0);
    return `${k} ${done.length}+${all.length - done.length}${isStructure(k as 'pillbox') ? `(${occ})` : ''}`;
  };
  return `zone#${z.id} front ${z.frontId ?? '-'}${z.cancelled ? ' CANCELLED' : ''}: ${kind('trench')} ${kind('pillbox')} ${kind('bunker')}`;
}

run(30);
const s = f.fronts[f.mainFront] ?? f.fronts[0];
const l1 = lineAt(w, f, 500);
const l2 = lineAt(w, f, 800);
issueFrontOrder(w, f, s, { kind: 'fortify', a: l1.a, b: l1.b, issuedAt: w.time, manual: false });
console.log(`t=${w.time.toFixed(0)} s: fortify #1 on front ${s.id} (${s.name}); zones ${f.zones.length}`);
run(60);
issueFrontOrder(w, f, s, { kind: 'fortify', a: l2.a, b: l2.b, issuedAt: w.time, manual: false });
console.log(`t=${w.time.toFixed(0)} s: fortify #2 on front ${s.id}; zones ${f.zones.length}`);
for (let k = 0; k * 60 < minutes * 60 - 90 && !w.result; k++) {
  run(60);
  console.log(`t=${(w.time / 60).toFixed(1)} min | front ${s.id} order ${s.order.kind} posture ${s.posture} | P ${Math.round(f.p)} M ${Math.round(f.m)}`);
  for (const z of f.zones) console.log(`   ${zoneLine(z)}`);
}
