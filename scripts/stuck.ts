import { readFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import { Ground } from '../src/sim/terrain';
const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: 7, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
for (let i = 0; i < 20 * 480; i++) { step(m); w.fx.length = 0; }
const snap = new Map([...w.units.values()].map((u) => [u.id, { x: u.pos.x, z: u.pos.z }]));
for (let i = 0; i < 20 * 60; i++) { step(m); w.fx.length = 0; }
const G = ['open', 'road', 'forest', 'town', 'mud', 'water', 'ford'];
let shown = 0;
for (const u of w.units.values()) {
  const p = snap.get(u.id);
  if (!p || u.fixed || u.path.length === 0 || u.targetId !== null) continue;
  if (Math.hypot(u.pos.x - p.x, u.pos.z - p.z) > 3) continue;
  const nav = w.navFor(u);
  const wp = u.path[u.pathIdx] ?? u.path[0];
  const h = Math.atan2(wp.z - u.pos.z, wp.x - u.pos.x);
  const next = { x: u.pos.x + Math.cos(h) * 2, z: u.pos.z + Math.sin(h) * 2 };
  if (shown++ < 14) console.log(JSON.stringify({ id: u.id, type: u.def.id, beh: u.behavior, role: u.opRole, st: u.status, pos: [Math.round(u.pos.x), Math.round(u.pos.z)], ground: G[w.terrain.groundAt(u.pos.x, u.pos.z)], slope: w.terrain.slopeAt(u.pos.x, u.pos.z).toFixed(1), passHere: nav.passable(u.pos), wp: [Math.round(wp.x), Math.round(wp.z)], dWp: Math.round(Math.hypot(wp.x - u.pos.x, wp.z - u.pos.z)), bldHere: w.terrain.buildingH(u.pos.x, u.pos.z), bldNext: w.terrain.buildingH(next.x, next.z), cover: w.terrain.buildingCover(u.pos.x, u.pos.z, 6).toFixed(2), nextPass: nav.passable(next), nextGround: G[w.terrain.groundAt(next.x, next.z)], idx: `${u.pathIdx}/${u.path.length}`, dest: u.dest && [Math.round(u.dest.x), Math.round(u.dest.z)], moraleSt: u.moraleState, setup: u.setup, speed: u.speedNow.toFixed(2) }));
}
console.log('stuck total', shown);
