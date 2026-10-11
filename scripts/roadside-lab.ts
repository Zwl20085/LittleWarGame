/**
 * 2.2 shelter lab (V22_SPEC §12): controlled barrages on a squad caught in the open near a
 * roadside building, with and without the "take cover in a building" behaviour.
 *
 *   npx tsx scripts/roadside-lab.ts [seed=7] [trials=16]          (SHELTER=0 → behaviour off)
 *
 * Per trial: an infantry squad stands on open ground 40 m from a roadside building; every 10 s a
 * shell (howitzer / mortar alternately, unspotted dispersion at ≈450 / 250 m) is aimed at its current
 * position for 120 s. Reports HP lost and squads killed. The scatter uses its own seeded RNG so
 * both runs see the same fall of shot relative to the aim point.
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import { Ground } from '../src/sim/terrain';
import { isRoadside } from '../src/sim/roadside';
import { housedIn, SHELTER_AB } from '../src/sim/shelter';
import { resolveBlast } from '../src/sim/damage';
import { Rng } from '../src/sim/rng';
import type { V2 } from '../src/sim/vec';

if (process.env.SHELTER === '0') SHELTER_AB.enabled = false;
const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const seed = Number(process.argv[2] ?? 7);
const trials = Number(process.argv[3] ?? 16);
const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const t = w.terrain;
/** Dispersion at ≈450 / 250 m without a spotter (DISPERSION × noObserverMul 1.5); one shell every EVERY_S seconds. */
const SHELLS = [{ id: 'howitzer_shell', sigma: 17, src: 'howitzer' }, { id: 'mortar_shell', sigma: 10, src: 'mortar' }];
const EVERY_S = 10;

const probe = w.spawnUnit(0, 'infantry', { x: 0, z: 0 }, w.factions[0].fronts[0].id);
const nav = w.navFor(probe);
w.units.delete(probe.id);
const sites: V2[] = [];
for (const b of t.buildings) {
  if (sites.length >= trials || !isRoadside(w.map, b)) continue;
  if (sites.some((s) => Math.hypot(s.x - b.x, s.z - b.z) < 150)) continue;
  for (let a = 0; a < 8; a++) {
    const p = { x: b.x + Math.cos((a * Math.PI) / 4) * 40, z: b.z + Math.sin((a * Math.PI) / 4) * 40 };
    if (!nav.passable(p) || t.coverAt(p.x, p.z) !== 0 || t.groundAt(p.x, p.z) === Ground.Water) continue;
    sites.push(p);
    break;
  }
}
let lost = 0;
let killed = 0;
let covered = 0;
const perShell = { open: { n: 0, dmg: 0 }, wall: { n: 0, dmg: 0 } };
for (const [k, p] of sites.entries()) {
  const u = w.spawnUnit(0, 'infantry', p, w.factions[0].fronts[0].id);
  u.pos.x = p.x; u.pos.z = p.z; u.prev.x = p.x; u.prev.z = p.z; u.y = t.heightAt(p.x, p.z);
  step(m);
  const rng = new Rng(1000 + k);
  const hp0 = u.hp;
  let tookCover = false;
  for (let s = 0; s < 120 && u.hp > 0; s++) {
    if (s % EVERY_S === 0) {
      const sh = SHELLS[(s / EVERY_S) % 2];
      const wd = data.weapons.get(sh.id)!;
      const x = u.pos.x + rng.normal() * sh.sigma;
      const z = u.pos.z + rng.normal() * sh.sigma;
      const before = u.hp;
      const inCover = housedIn(w, u) >= 0;
      resolveBlast(w, { x, y: t.heightAt(x, z), z }, wd.blastRadius, wd.damage, wd.suppression, 1, sh.id, 'shell', null, sh.src);
      const acc = inCover ? perShell.wall : perShell.open;
      acc.n++;
      acc.dmg += before - Math.max(0, u.hp);
    }
    for (let i = 0; i < w.tickHz; i++) step(m);
    if (u.status === 'status.takingCover') tookCover = true;
  }
  lost += hp0 - Math.max(0, u.hp);
  if (u.hp <= 0) killed++;
  if (tookCover) covered++;
  w.units.delete(u.id);
}
console.log(`seed ${seed} shelter ${SHELTER_AB.enabled ? 'on' : 'off'} | trials ${sites.length} | squads that took cover ${covered} | HP lost ${Math.round(lost)} (${(lost / Math.max(1, sites.length)).toFixed(0)} per squad of ${data.units.get('infantry')!.maxHp}) | squads killed ${killed} | dmg/shell in the open ${(perShell.open.dmg / Math.max(1, perShell.open.n)).toFixed(0)} (${perShell.open.n}), inside a building ${(perShell.wall.dmg / Math.max(1, perShell.wall.n)).toFixed(0)} (${perShell.wall.n})`);
