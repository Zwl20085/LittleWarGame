/**
 * 3.0 lab — sparse fronts and infiltration (docs/V30_SPEC.md §11, WP-E).
 *
 * 4 AI factions on a generated map (open information). At `--launch` minutes the lab gives faction 0
 * (the attacker) two scripted groups next to the widest gap of the nearest enemy's line (the gap =
 * the front cell facing the attacker farthest from any of the defender's line units):
 *   detachment — 6 rifle squads, shadow route (unseen by the defender at launch, scripts/challenge/route.ts)
 *                to 650 m of the defender's capital, then attack-move on it;
 *   raid       — 10 motorized units (6 motor_inf + 4 light tanks) the same way through the second gap.
 * They run for `--after` minutes. Both variants of the infiltration system (INFILTRATION_AB on / off)
 * play the same seeds. Per unit: got past the line (200 m inside the gap toward the capital), seen by
 * the defender before that (visibility, zone-of-control reveals included), first damage, depth reached.
 *
 *   npx tsx scripts/lab30/infiltration.ts [--seeds 7,11,13] [--launch 12] [--after 8] [--size medium] [--jobs 6] [--variants on,off] [--tag run]
 *
 * Output: media/stats/lab30/infiltration-<tag>-<ts>.{md,json}.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Unit } from '../../src/sim/types';
import { dist, headingTo, type V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import { seenBy, shadowRoute } from '../challenge/route';
import { createLabMatch, mdTable, parseArgs, runJobs, serveWorker, stamp, writeReport } from './common';

interface Spec { seed: number; on: boolean; launchMin: number; afterMin: number; size: 'medium' | 'large'; fog: boolean }

interface GroupResult {
  readonly name: string;
  readonly n: number;
  /** Units that got 200 m past the gap toward the capital, and those of them not detected before (seen, hit or reported). */
  readonly past: number;
  readonly pastUnseen: number;
  /** Units the defender saw / reported at all; damaged at all; median seconds from launch to first damage. */
  readonly seen: number;
  readonly reported: number;
  /** Median seconds from launch to the first detection (seen, hit or reported). */
  readonly detectS: number;
  readonly engaged: number;
  readonly engageS: number;
  /** Mean / max depth (m) reached past the gap toward the capital; reached the 700 m ring; alive at the end. */
  readonly depthMean: number;
  readonly depthMax: number;
  readonly ring: number;
  readonly alive: number;
  readonly gapM: number;
}

interface Result {
  readonly seed: number;
  readonly on: boolean;
  readonly defender: number;
  readonly defenderFronts: number;
  /** Largest distance from a front cell facing the attacker to the defender's nearest line unit (m), at launch. */
  readonly widestGapM: number;
  readonly groups: GroupResult[];
  readonly msPerTick: number;
  readonly msPerTickPre: number;
  readonly reports: number;
  readonly reportedAtS: number;
}

const SRC = 'src';
const DATA = 'docs/data';
const PAST_M = 200;
const RING_M = 700;

const holdsLineFn = async (): Promise<(u: Unit) => boolean> => ((await import(pathToFileURL(resolve(SRC, 'sim/zoc.ts')).href)) as { holdsLine: (u: Unit) => boolean }).holdsLine;

/** Front cells of `d` facing the attacker's capital (±70°), each with the distance to d's nearest line unit. */
function gaps(world: World, d: number, a: number, holds: (u: Unit) => boolean): { p: V2; gap: number }[] {
  const hqD = world.hqPos(d);
  const toA = headingTo(hqD, world.hqPos(a));
  const line = world.aliveUnits.filter((u) => u.owner === d && holds(u));
  const cells = world.frontInfo[d]?.cells ?? [];
  const out: { p: V2; gap: number }[] = [];
  for (const c of cells) {
    let da = headingTo(hqD, c) - toA;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) > (70 * Math.PI) / 180) continue;
    let g = Infinity;
    for (const u of line) g = Math.min(g, dist(u.pos, c));
    out.push({ p: c, gap: g });
  }
  return out.sort((x, y) => y.gap - x.gap || x.p.x - y.p.x);
}

function spawnGroup(world: World, a: number, kinds: string[], at: V2): Unit[] {
  const nav = world.nav(false, 35);
  const f = world.factions[a];
  return kinds.map((k, i) => {
    const p = nav.nearestPassable({ x: at.x + (i % 3) * 12 - 12, z: at.z + Math.floor(i / 3) * 12 - 12 }, 60) ?? at;
    const u = world.spawnUnit(a, k, p, f.fronts[0].id);
    u.behavior = 'advance';
    return u;
  });
}

/** The challenge lab's shadow route as queued orders (moves, then an attack-move on the capital). */
function sendShadow(world: World, units: Unit[], from: V2, hq: V2, d: number): void {
  const route = shadowRoute(world, units.find((u) => u.def.kind === 'vehicle') ?? units[0], from, hq, seenBy(world, [d]), 650);
  const pts = [...route.waypoints, route.staging].slice(0, 7);
  units.forEach((u, i) => {
    const off = { x: (i % 3) * 10 - 10, z: Math.floor(i / 3) * 10 - 10 };
    const tasks = [...pts.map((p) => ({ type: 'move' as const, dest: { x: p.x + off.x, z: p.z + off.z }, arrivedAt: null, hold: false })),
      { type: 'attackMove' as const, dest: { ...hq }, clearSince: null }];
    u.manual = tasks[0];
    u.queue = tasks.slice(1);
    u.thinkAt = 0;
    u.repathAt = 0;
  });
}

interface Track { u: Unit; seenAt: number; repAt: number; pastAt: number; hitAt: number; minD: number }

const detectedAt = (t: Track): number => Math.min(...[t.seenAt, t.repAt, t.hitAt].filter((x) => x >= 0), Infinity);

async function runOne(spec: Spec): Promise<Result> {
  const { INFILTRATION_AB } = (await import(pathToFileURL(resolve(SRC, 'sim/zoc.ts')).href)) as { INFILTRATION_AB: { on: boolean } };
  const { infiltrationReports } = (await import(pathToFileURL(resolve(SRC, 'sim/infiltration.ts')).href)) as { infiltrationReports: (f: unknown) => readonly { firstAt: number; noted: boolean; ids: readonly number[] }[] };
  INFILTRATION_AB.on = spec.on;
  const holds = await holdsLineFn();
  const m = await createLabMatch({ seed: spec.seed, minutes: spec.launchMin + spec.afterMin, mapSize: spec.size, factions: 4, src: SRC, data: DATA, infoMode: spec.fog ? 'fog' : 'open' });
  const w = m.world;
  const launchTick = spec.launchMin * 60 * w.tickHz;
  // CPU time of this process (other jobs on the machine skew wall time; this is what the sim costs).
  let c0 = process.cpuUsage();
  for (let i = 0; i < launchTick && !w.result; i++) m.step();
  const cpuMs = (c: NodeJS.CpuUsage): number => (c.user + c.system) / 1000;
  const msPre = cpuMs(process.cpuUsage(c0)) / Math.max(1, launchTick);
  const a = 0;
  const hqA = w.hqPos(a);
  const d = w.factions.filter((f) => f.alive && f.id !== a).sort((x, y) => dist(w.hqPos(x.id), hqA) - dist(w.hqPos(y.id), hqA))[0].id;
  const hqD = w.hqPos(d);
  const g = gaps(w, d, a, holds);
  const first = g[0];
  const second = g.find((x) => first && dist(x.p, first.p) > 600) ?? first;
  const groups: { name: string; units: Unit[]; gap: { p: V2; gap: number } }[] = [];
  if (first) {
    for (const [name, kinds, gp] of [['detachment', Array(6).fill('infantry'), first], ['raid', [...Array(6).fill('motor_inf'), ...Array(4).fill('light_tank')], second]] as const) {
      const out = headingTo(hqD, gp.p);
      const from = { x: gp.p.x + Math.cos(out) * 450, z: gp.p.z + Math.sin(out) * 450 };
      const units = spawnGroup(w, a, [...kinds], from);
      sendShadow(w, units, from, hqD, d);
      groups.push({ name, units, gap: gp });
    }
  }
  const tracks = groups.map((gr) => gr.units.map((u): Track => ({ u, seenAt: -1, repAt: -1, pastAt: -1, hitAt: -1, minD: dist(u.pos, hqD) })));
  const launchAt = w.time;
  const afterTicks = spec.afterMin * 60 * w.tickHz;
  c0 = process.cpuUsage();
  let ticks = 0;
  for (let i = 0; i < afterTicks && !w.result; i++, ticks++) {
    m.step();
    if (w.tick % 10 !== 0) continue;
    const reported = new Set(infiltrationReports(w.factions[d]).flatMap((rp) => (rp.noted ? [...rp.ids] : [])));
    groups.forEach((gr, k) => {
      const lineD = dist(gr.gap.p, hqD);
      for (const t of tracks[k]) {
        if (t.u.hp <= 0) continue;
        const dd = dist(t.u.pos, hqD);
        t.minD = Math.min(t.minD, dd);
        if (t.seenAt < 0 && w.visibleTo[d].has(t.u.id)) t.seenAt = w.time - launchAt;
        if (t.repAt < 0 && reported.has(t.u.id)) t.repAt = w.time - launchAt;
        if (t.pastAt < 0 && dd < lineD - PAST_M) t.pastAt = w.time - launchAt;
        if (t.hitAt < 0 && t.u.lastDamagedAt >= launchAt) t.hitAt = t.u.lastDamagedAt - launchAt;
      }
    });
  }
  const msPerTick = cpuMs(process.cpuUsage(c0)) / Math.max(1, ticks);
  const reps = infiltrationReports(w.factions[d]);
  return {
    seed: spec.seed, on: spec.on, defender: d, defenderFronts: w.factions[d].fronts.length, widestGapM: Math.round(first?.gap ?? 0),
    groups: groups.map((gr, k) => summarize(gr.name, tracks[k], dist(gr.gap.p, hqD), gr.gap.gap)),
    msPerTick, msPerTickPre: msPre, reports: reps.length, reportedAtS: reps.length ? Math.round(reps[0].firstAt - launchAt) : -1,
  };
}

const median = (xs: number[]): number => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function summarize(name: string, ts: Track[], lineD: number, gapM: number): GroupResult {
  const depth = ts.map((t) => Math.max(0, lineD - t.minD));
  const past = ts.filter((t) => t.pastAt >= 0);
  return {
    name, n: ts.length, past: past.length, pastUnseen: past.filter((t) => detectedAt(t) > t.pastAt).length,
    seen: ts.filter((t) => t.seenAt >= 0).length, reported: ts.filter((t) => t.repAt >= 0).length, detectS: Math.round(median(ts.map(detectedAt).filter(Number.isFinite))), engaged: ts.filter((t) => t.hitAt >= 0).length, engageS: Math.round(median(ts.filter((t) => t.hitAt >= 0).map((t) => t.hitAt))),
    depthMean: Math.round(depth.reduce((a, b) => a + b, 0) / Math.max(1, depth.length)), depthMax: Math.round(Math.max(0, ...depth)),
    ring: ts.filter((t) => t.minD <= RING_M).length, alive: ts.filter((t) => t.u.hp > 0).length, gapM: Math.round(gapM),
  };
}

function report(rows: Result[], tag: string): void {
  const head = ['variant', 'group', 'units', 'past the line', 'past undetected', 'seen', 'reported', 'median s to detected', 'engaged', 'median s to engaged', 'mean depth m', 'max depth m', 'at 700 m ring', 'alive at end'];
  const body: (string | number)[][] = [];
  for (const on of [true, false]) {
    const rs = rows.filter((r) => r.on === on);
    if (!rs.length) continue;
    for (const name of ['detachment', 'raid']) {
      const gs = rs.flatMap((r) => r.groups.filter((g) => g.name === name));
      const n = gs.reduce((a, g) => a + g.n, 0);
      const sum = (k: keyof GroupResult): number => gs.reduce((a, g) => a + (g[k] as number), 0);
      const pct = (x: number): string => `${x} (${Math.round((100 * x) / Math.max(1, n))} %)`;
      body.push([on ? 'on' : 'off', name, n, pct(sum('past')), pct(sum('pastUnseen')), pct(sum('seen')), pct(sum('reported')), median(gs.map((g) => g.detectS).filter((x) => x >= 0)), pct(sum('engaged')), median(gs.map((g) => g.engageS).filter((x) => x >= 0)),
        Math.round(sum('depthMean') / Math.max(1, gs.length)), Math.max(0, ...gs.map((g) => g.depthMax)), pct(sum('ring')), pct(sum('alive'))]);
    }
  }
  const perSeed = mdTable(['seed', 'variant', 'defender', 'its fronts', 'widest gap m', 'reports', 'first report s', 'ms/tick before launch', 'ms/tick after'],
    rows.map((r) => [r.seed, r.on ? 'on' : 'off', r.defender, r.defenderFronts, r.widestGapM, r.reports, r.reportedAtS, r.msPerTickPre.toFixed(2), r.msPerTick.toFixed(2)]));
  const cost = (on: boolean, k: 'msPerTick' | 'msPerTickPre'): number => { const rs = rows.filter((r) => r.on === on); return rs.reduce((a, r) => a + r[k], 0) / Math.max(1, rs.length); };
  const delta = (k: 'msPerTick' | 'msPerTickPre'): string => (cost(false, k) > 0 ? `${(((cost(true, k) - cost(false, k)) / cost(false, k)) * 100).toFixed(1)} %` : '—');
  const md = [`# Infiltration lab (${tag}, ${new Date().toISOString()})`, '', mdTable(head, body), '', perSeed, '',
    `Sim cost on vs off: before launch ${delta('msPerTickPre')}, after launch ${delta('msPerTick')} (mean CPU ms/tick of each match process).`].join('\n');
  const out = writeReport(`infiltration-${tag}-${stamp()}`, md, rows);
  console.log(md);
  console.log(`report written to ${out.md}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('worker')) {
    serveWorker(runOne);
    return;
  }
  const seeds = args.nums('seeds', '7,11,13');
  const variants = args.str('variants', 'on,off').split(',').map((v) => v === 'on');
  const specs: Spec[] = seeds.flatMap((seed) => variants.map((on) => ({ seed, on, launchMin: args.num('launch', 12), afterMin: args.num('after', 8), size: args.str('size', 'medium') as 'medium' | 'large', fog: args.has('fog') })));
  const rows = await runJobs<Spec, Result>(process.argv[1], specs, args.num('jobs', 6), (s) => `seed ${s.seed} ${s.on ? 'on' : 'off'}`);
  report(rows, `${args.str('tag', 'run')}${args.has('fog') ? '-fog' : ''}`);
}

void main();
