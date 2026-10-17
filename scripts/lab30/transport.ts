// 3.0 lab suite `transport` (V30_SPEC §10): roads and railways, A/B against the 2.2 movement.
//
//   npx tsx scripts/lab30/transport.ts [--seeds 7,11] [--minutes 30] [--size medium] [--jobs 4]
//                                      [--variants on,norail,off] [--set path=value ...] [--skip-war] [--skip-cross]
//
// Variants: on = transport as shipped; norail = transport.rail.enabled=false (roads only);
// off = transport.enabled=false (2.2 ground multipliers, no rail). `--set` applies to every variant.
// Metrics:
//   cross  — a 20-unit force (8 rifles, 4 motorized, 4 medium tanks, 2 AT guns, 2 trucks) ordered from
//            its capital to the farthest settlement on its rail net (large map, all stations on the
//            route made its own): seconds until 18 of 20 are within 150 m, and how many rode a train;
//   war    — 4-FFA AI war: share of moving unit-seconds on a road (and road or town street), share of
//            engagements within 150 m of a road junction / bridge (all, and outside settlements),
//            convoy delivery time (truck leaves its stock → starts handing over), rail trips, cuts,
//            engineer roads / repairs, sim ms per tick.
// Output: media/stats/lab30/transport-<ts>.{json,md}.
import { Ground } from '../../src/sim/terrain';
import type { Match } from '../../src/sim/sim';
import type { Unit } from '../../src/sim/types';
import { dist, type V2 } from '../../src/sim/vec';
import { argList, argNum, argSets, argStr, isWorker, labMatch, loadData, mdTable, mean, parseArgs, runFor, runParallel, workerLoop, writeReport } from './common';

const VARIANTS: Record<string, string[]> = {
  on: [],
  norail: ['transport.rail.enabled=false'],
  off: ['transport.enabled=false'],
};

interface Task { kind: 'cross' | 'war'; seed: number; variant: string; sets: string[]; minutes: number; size: 'medium' | 'large' }

interface CrossResult { arrivedS: number | null; medianS: number | null; rode: number; routeM: number; straightM: number; simMsPerTick: number }
interface WarResult {
  movingS: number; roadS: number; streetS: number;
  fights: number; nearJunction: number; nearJunctionOpen: number;
  convoyTrips: number; convoyMeanS: number; convoyMedianS: number;
  railTrips: number; riderSeconds: number; cutsEver: number; roadsBuilt: number; repairs: number;
  simMsPerTick: number; result: string;
}

/** Cross scenario time cap (s). */
const CROSS_CAP_S = 2400;
const FORCE: [string, number][] = [['infantry', 8], ['motor_inf', 4], ['medium_tank', 4], ['at_gun', 2], ['supply_truck', 2]];

/** The farthest station reachable over the map rail net from a faction's capital station, and its route stations. */
function farthestStation(m: Match, fid: number, usableOnly = false): { dest: V2; stations: number[]; routeM: number } | null {
  const w = m.world;
  const st = w.transport!;
  const capIdx = -1 - w.factions[fid].cityIdx;
  const start = st.stations.find((s) => s.placeIdx === capIdx);
  if (!start) return null;
  const d = new Map<number, number>([[start.id, 0]]);
  const via = new Map<number, number>();
  const queue = [start.id];
  while (queue.length) {
    queue.sort((a, b) => d.get(a)! - d.get(b)!);
    const cur = queue.shift()!;
    for (const lid of st.stations[cur].lines) {
      const l = st.lines[lid];
      const o = l.a === cur ? l.b : l.a;
      // Never through another capital (its station is never ours).
      if (st.stations[o].placeIdx < 0 || (usableOnly && l.owner !== fid)) continue;
      const nd = d.get(cur)! + l.len;
      if (nd < (d.get(o) ?? Infinity)) { d.set(o, nd); via.set(o, cur); queue.push(o); }
    }
  }
  let far = start.id;
  for (const [id, v] of d) if (v > d.get(far)! && st.stations[id].placeIdx >= 0) far = id;
  if (far === start.id) return null;
  const chain: number[] = [];
  for (let c: number | undefined = far; c !== undefined; c = via.get(c)) chain.unshift(c);
  const o = w.objectives[st.stations[far].placeIdx];
  return { dest: { ...o.pos }, stations: chain, routeM: d.get(far)! };
}

function runCross(t: Task): CrossResult {
  const data = loadData([...VARIANTS[t.variant], ...t.sets]);
  // Geometry from the shipped rules so every variant gets the same map and route.
  const m = labMatch(data, { seed: t.seed, size: 'large', factions: 4 });
  const w = m.world;
  // The faction with the longest rail route from its capital moves the force.
  let fid = 0;
  let plan = farthestStation(m, 0);
  for (const g of w.factions) {
    const p = farthestStation(m, g.id);
    if (p && (!plan || p.routeM > plan.routeM)) { plan = p; fid = g.id; }
  }
  if (!plan) return { arrivedS: null, medianS: null, rode: 0, routeM: 0, straightM: 0, simMsPerTick: 0 };
  for (const sid of plan.stations) {
    const pi = w.transport!.stations[sid].placeIdx;
    if (pi >= 0) w.objectives[pi].owner = fid;
  }
  // Let the rail checks see the new owners, then aim at the farthest station the faction can actually run trains to
  // (a line crossing enemy ground stays closed); without rail the same destination is used.
  runFor(m, 20);
  plan = farthestStation(m, fid, true) ?? plan;
  if (process.env.XDBG) console.log('PLAN', fid, plan.stations.join('>'), w.time, w.transport!.lines.map((l) => l.owner).join(','));
  const f = w.factions[fid];
  const exit = w.cityOf(fid).exit;
  const force: Unit[] = [];
  let k = 0;
  for (const [id, n] of FORCE) {
    for (let i = 0; i < n; i++, k++) {
      const p = { x: exit.x + ((k % 5) - 2) * 14, z: exit.z + (Math.floor(k / 5) - 2) * 14 };
      const def = w.data.units.get(id)!;
      const u = w.spawnUnit(fid, id, w.nav(def.kind === 'vehicle', def.maxSlopeDeg).nearestPassable(p, 60) ?? exit, f.mainFront);
      u.ammo = 1;
      u.behavior = 'advance';
      force.push(u);
    }
  }
  force.forEach((u, i) => {
    const off = { x: ((i % 5) - 2) * 18, z: (Math.floor(i / 5) - 2) * 18 };
    u.manual = { type: 'move', dest: { x: plan.dest.x + off.x, z: plan.dest.z + off.z }, arrivedAt: null, hold: true };
  });
  const rode = new Set<number>();
  const arrivedAt = new Map<number, number>();
  let arrived: number | null = null;
  const t0 = w.time;
  const s = runFor(m, CROSS_CAP_S, (sec) => {
    for (const u of force) if (u.rail?.stage === 'aboard') rode.add(u.id);
    if (process.env.XDBG && sec - t0 < 30 && sec % 5 === 0) console.log('DBG', sec, plan.stations.join('>'), w.transport!.lines.map((l) => l.owner).join(','), force.map((u) => u.rail?.stage ?? '-').join(','));
    for (const u of force) if (!arrivedAt.has(u.id) && u.hp > 0 && dist(u.pos, plan.dest) < 150) arrivedAt.set(u.id, sec - t0);
    const there = arrivedAt.size;
    if (arrived === null && there >= 18) arrived = sec - t0;
  }, () => arrived !== null);
  if (process.env.XDBG) console.log('END', force.map((u) => `${u.def.id}:${arrivedAt.get(u.id) ?? 'x'}:${u.rail?.stage ?? '-'}:${Math.round(dist(u.pos, plan.dest))}:${u.status}`).join(' '));
  const times = [...arrivedAt.values()].sort((x, y) => x - y);
  return { arrivedS: arrived, medianS: times.length >= 10 ? times[9] : null, rode: rode.size, routeM: plan.routeM, straightM: dist(exit, plan.dest), simMsPerTick: s.simMs / Math.max(1, s.ticks) };
}

function runWar(t: Task): WarResult {
  const data = loadData([...VARIANTS[t.variant], ...t.sets]);
  const m = labMatch(data, { seed: t.seed, size: t.size, factions: 4 });
  const w = m.world;
  const st = w.transport!;
  let movingS = 0;
  let roadS = 0;
  let streetS = 0;
  const outAt = new Map<number, number>();
  const lastState = new Map<number, string>();
  const trips: number[] = [];
  let aboardPrev = new Set<number>();
  let railTrips = 0;
  let riderSeconds = 0;
  const cut = new Set<number>();
  let repairs = 0;
  let cutPrev = st.lines.map((l) => l.cut);
  const s = runFor(m, t.minutes * 60, (sec) => {
    const aboardNow = new Set<number>();
    for (const u of w.aliveUnits) {
      if (u.hp <= 0) continue;
      if (u.rail?.stage === 'aboard') { aboardNow.add(u.id); continue; }
      if (u.moving) {
        movingS++;
        const g = w.terrain.groundAt(u.pos.x, u.pos.z);
        if (g === Ground.Road) roadS++;
        if (g === Ground.Road || g === Ground.Town) streetS++;
      }
      if (u.def.id === 'supply_truck') {
        const prev = lastState.get(u.id);
        if (u.truckState === 'out' && prev !== 'out') outAt.set(u.id, sec);
        if (u.truckState === 'unload' && prev === 'out' && outAt.has(u.id)) trips.push(sec - outAt.get(u.id)!);
        lastState.set(u.id, u.truckState);
      }
    }
    for (const id of aboardNow) if (!aboardPrev.has(id)) railTrips++;
    riderSeconds += aboardNow.size;
    aboardPrev = aboardNow;
    st.lines.forEach((l, i) => { if (l.cut) cut.add(l.id); if (cutPrev[i] && !l.cut) repairs++; });
    cutPrev = st.lines.map((l) => l.cut);
  });
  const junctions = st.roads.junctions().map((n) => n.pos);
  const inTown = (p: V2): boolean => w.objectives.some((o) => o.kind !== 'point' && dist(o.pos, p) < o.radius + 60);
  const open = junctions.filter((p) => !inTown(p));
  const near = (p: V2, list: V2[]): boolean => list.some((q) => dist(p, q) < 150);
  const fights = w.battle.engagements;
  const sorted = [...trips].sort((a, b) => a - b);
  return {
    movingS, roadS, streetS,
    fights: fights.length, nearJunction: fights.filter((e) => near(e.pos, junctions)).length, nearJunctionOpen: fights.filter((e) => near(e.pos, open)).length,
    convoyTrips: trips.length, convoyMeanS: mean(trips), convoyMedianS: sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN,
    railTrips, riderSeconds, cutsEver: cut.size, roadsBuilt: st.builtRoads.length, repairs,
    simMsPerTick: s.simMs / Math.max(1, s.ticks), result: w.result ? `${w.result.reason} ${Math.round(w.result.tick / w.tickHz / 60)}m` : 'open',
  };
}

function runTask(t: Task): CrossResult | WarResult {
  return t.kind === 'cross' ? runCross(t) : runWar(t);
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const seeds = argList(a, 'seeds', '7,11');
  const minutes = argNum(a, 'minutes', 30);
  const size = argStr(a, 'size', 'medium') as 'medium' | 'large';
  const variants = argStr(a, 'variants', 'on,norail,off').split(',');
  const sets = argSets(a);
  const tasks: Task[] = [];
  for (const variant of variants) {
    for (const seed of seeds) {
      if (!a['skip-cross']) tasks.push({ kind: 'cross', seed, variant, sets, minutes, size });
      if (!a['skip-war']) tasks.push({ kind: 'war', seed, variant, sets, minutes, size });
    }
  }
  const t0 = performance.now();
  const results = await runParallel<Task, CrossResult | WarResult>(import.meta.url, tasks, argNum(a, 'jobs', 4));
  const rows = tasks.map((t, i) => ({ ...t, r: results[i] }));
  const cross = (v: string): CrossResult[] => rows.filter((x) => x.kind === 'cross' && x.variant === v).map((x) => x.r as CrossResult);
  const war = (v: string): WarResult[] => rows.filter((x) => x.kind === 'war' && x.variant === v).map((x) => x.r as WarResult);
  const pct = (n: number, d: number): string => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '–');
  const md: string[] = [
    `# Lab 3.0 — transport (roads and railways)`, '',
    `Seeds ${seeds.join(', ')} · war ${minutes} min 4-FFA ${size} · cross on a large 4-FFA map · sets: ${sets.join(' ') || 'none'} · wall ${((performance.now() - t0) / 60000).toFixed(1)} min`, '',
    '## 20-unit force across the map (capital → farthest own rail settlement)', '',
    mdTable(['variant', 'seed', 'route m', 'straight m', 'seconds to 10/20', 'seconds to 18/20', 'rode a train', 'sim ms/tick'],
      variants.flatMap((v) => cross(v).map((r, i) => [v, seeds[i], Math.round(r.routeM), Math.round(r.straightM), r.medianS ?? '–', r.arrivedS ?? `> ${CROSS_CAP_S}`, r.rode, r.simMsPerTick]))),
    '', '## AI war', '',
    mdTable(['variant', 'moving on road', 'on road or street', 'fights', 'fights ≤150 m of a junction', 'same, outside settlements', 'convoy trips', 'convoy mean s', 'convoy median s', 'rail trips', 'rider-min', 'lines cut', 'roads built', 'repairs', 'sim ms/tick', 'result'],
      variants.flatMap((v) => war(v).map((r, i) => [`${v} s${seeds[i]}`, pct(r.roadS, r.movingS), pct(r.streetS, r.movingS), r.fights, pct(r.nearJunction, r.fights), pct(r.nearJunctionOpen, r.fights),
        r.convoyTrips, r.convoyMeanS, r.convoyMedianS, r.railTrips, Math.round(r.riderSeconds / 60), r.cutsEver, r.roadsBuilt, r.repairs, r.simMsPerTick, r.result]))),
    '',
  ];
  const base = writeReport('transport', { seeds, minutes, size, sets, rows }, md.join('\n'));
  console.log(md.join('\n'));
  console.log(`\nreport: ${base}.md`);
}

if (isWorker()) workerLoop(runTask);
else main().catch((e) => { console.error(e); process.exit(1); });
