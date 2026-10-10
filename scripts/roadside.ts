/**
 * 2.2 roadside buildings (V22_SPEC §12): map coverage and the shelled-infantry numbers.
 *
 *   npx tsx scripts/roadside.ts [minutes=30] [seeds=7,11]      (minutes=0 → map stats only)
 *
 * Per seed: building counts, how far a squad on a road (outside settlements) is from the nearest
 * building (median / p75 / p90, share within 150 / 250 m), then a headless AI war reporting
 * artillery (howitzer + mortar) damage and kills on foot units, squads taking cover in buildings,
 * stuck units (> 90 s wanting to move without progress) and sim ms/tick.
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import { Ground, type Terrain } from '../src/sim/terrain';
import { buildingsNear } from '../src/sim/buildings';
import { dist } from '../src/sim/vec';
import { ROADSIDE_AB } from '../src/sim/roadside';
import { SHELTER_AB } from '../src/sim/shelter';

// A/B: ROADSIDE=0 → no roadside buildings; SHELTER=0 → shelled squads do not seek buildings.
if (process.env.ROADSIDE === '0') ROADSIDE_AB.enabled = false;
if (process.env.SHELTER === '0') SHELTER_AB.enabled = false;

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const minutes = Number(process.argv[2] ?? 30);
const seeds = (process.argv[3] ?? '7,11').split(',').map(Number);
const ARTY = ['howitzer', 'mortar'];
/** Infantry squads and MG teams (guns and vehicles are not "infantry losses"). */
const INF = ['infantry', 'recon', 'mg', 'engineer', 'motor_inf', 'commander'];
const FOOT = (id: string): boolean => INF.includes(id);

/** Distance from road points (every 20 m, outside settlements) to the nearest building footprint centre. */
export function roadCoverage(t: Terrain): { n: number; med: number; p75: number; p90: number; max: number; over80: number; over100: number; in150: number; in250: number } {
  const ds: number[] = [];
  const near: number[] = [];
  for (const road of t.def.roads) {
    for (let s = 0; s < road.length - 1; s++) {
      const a = road[s];
      const b = road[s + 1];
      const L = dist(a, b);
      for (let m = 0; m < L; m += 20) {
        const p = { x: a.x + ((b.x - a.x) * m) / L, z: a.z + ((b.z - a.z) * m) / L };
        if (!t.inBounds(p.x, p.z) || t.groundAt(p.x, p.z) === Ground.Water) continue;
        if (t.def.towns.some((tw) => dist(tw, p) < tw.r + 20)) continue;
        let best = 600;
        for (const k of buildingsNear(t, p, 600, near)) {
          const bb = t.buildings[k];
          const d = Math.hypot(bb.x - p.x, bb.z - p.z);
          if (d < best) best = d;
        }
        ds.push(best);
      }
    }
  }
  ds.sort((x, y) => x - y);
  const q = (f: number): number => Math.round(ds[Math.floor((ds.length - 1) * f)] ?? 0);
  const share = (r: number): number => Math.round((100 * ds.filter((d) => d <= r).length) / Math.max(1, ds.length));
  return { n: ds.length, med: q(0.5), p75: q(0.75), p90: q(0.9), max: q(1), over80: 100 - share(80), over100: 100 - share(100), in150: share(150), in250: share(250) };
}

for (const seed of seeds) {
  const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  const t = w.terrain;
  const inTown = t.buildings.filter((b) => t.def.towns.some((tw) => Math.hypot(b.x - tw.x, b.z - tw.z) < tw.r + 12)).length;
  const c = roadCoverage(t);
  console.log(`\n=== seed ${seed}: ${t.width}x${t.depth} m | buildings ${t.buildings.length} (settlement ${inTown}, outside ${t.buildings.length - inTown}) | road pts ${c.n} nearest bldg median ${c.med} m p75 ${c.p75} p90 ${c.p90} max ${c.max} | >80 m ${c.over80}% >100 m ${c.over100}% | <=150 m ${c.in150}% <=250 m ${c.in250}%`);
  if (minutes <= 0) continue;
  const tracks = new Map<number, { x: number; z: number; since: number; flagged: boolean }>();
  let stuck = 0;
  let coverSamples = 0;
  let coverCount = 0;
  const ms: number[] = [];
  const ticks = minutes * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    const t0 = performance.now();
    step(m);
    ms.push(performance.now() - t0);
    w.fx.length = 0;
    if (i % w.tickHz !== 0) continue;
    for (const u of w.units.values()) {
      if (u.fixed || u.hp <= 0) continue;
      if (u.status === 'status.takingCover') coverCount++;
      if (u.def.kind !== 'vehicle') coverSamples++;
      let tr = tracks.get(u.id);
      if (!tr) tracks.set(u.id, (tr = { x: u.pos.x, z: u.pos.z, since: w.time, flagged: false }));
      const wants = u.path.length > 0 && u.targetId === null && !u.mounted;
      if (!wants || dist(u.pos, tr) > 4) { tr.x = u.pos.x; tr.z = u.pos.z; tr.since = w.time; tr.flagged = false; }
      else if (!tr.flagged && w.time - tr.since > 90) { tr.flagged = true; stuck++; }
    }
  }
  let dmg = 0;
  let kills = 0;
  let allKills = 0;
  for (const [src, row] of Object.entries(w.stats.matrix)) {
    for (const [vt, v] of Object.entries(row)) {
      if (!FOOT(vt)) continue;
      allKills += v.kills;
      if (!ARTY.includes(src)) continue;
      dmg += v.dmg;
      kills += v.kills;
    }
  }
  let shots = 0;
  for (const tbl of w.stats.byType) for (const id of ARTY) shots += tbl[id]?.shots ?? 0;
  ms.sort((a, b) => a - b);
  const mean = ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length);
  console.log(`RESULT ${w.result ? `${w.result.reason} at ${(w.result.tick / w.tickHz / 60).toFixed(1)} min` : `none after ${minutes} min`}`);
  console.log(`ARTY vs infantry: shells ${shots} dmg ${Math.round(dmg)} (${(dmg / Math.max(1, shots)).toFixed(1)}/shell) kills ${kills} (of ${allKills} infantry kills, ${Math.round((100 * kills) / Math.max(1, allKills))}%) | taking cover ${(100 * coverCount / Math.max(1, coverSamples)).toFixed(2)}% of foot-unit-seconds | stuck>90s ${stuck} | tick mean ${mean.toFixed(2)} ms p99 ${(ms[Math.floor(ms.length * 0.99)] ?? 0).toFixed(1)}`);
}
