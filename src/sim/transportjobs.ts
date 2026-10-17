import { trySpend } from './economy';
import { moveTo, stop } from './movement';
import { availableM } from './production';
import { addLine, railRules, stationOwner } from './rail';
import { armyScale } from './settlements';
import { Ground } from './terrain';
import { transportRules } from './transport';
import type { TransportJob, TransportJobKind } from './transportstate';
import type { Faction, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 engineer transport jobs (V30_SPEC §10): lay a road segment (cheap; ≤ road_job.max_len_m;
 * paints Ground.Road, bridges a short water gap — which is also how a lost crossing is rebuilt —
 * and refreshes navigation), rebuild a cut rail line, or extend the rail from a station to a town
 * (expensive, slow). Jobs are started by the player's / AI's HQ (`startRoadJob`, `startRailRepair`,
 * `startRailExtension`); the nearest free engineer is assigned and builds from a → b. The AI side
 * is deliberately small: `needRoadLinks` lists settlements cut off from the capital's road net,
 * and `transportSecond` repairs the faction's own cut lines and lays those links.
 */

export type JobResult = { ok: true; job: TransportJob } | { ok: false; reason: string };

const roadRules = (world: World): NonNullable<ReturnType<typeof transportRules>>['road_job'] | null => transportRules(world.data.rules)?.road_job ?? null;

/** Engineers this far from a job (m) are not sent to it. */
const ASSIGN_RADIUS_M = 2200;
/** An engineer works within this of the job's current work point (m). */
const WORK_RADIUS_M = 16;
/** Two road jobs whose endpoints are this close are the same job (m). */
const ROAD_OVERLAP_M = 30;
/** Unit-executor cadence the work increment assumes (s; behaviour thinks every 0.4 s). */
const THINK_S = 0.4;
/** A job nobody has worked on for this long is dropped (s). */
const STALE_S = 900;
/** Bridge deck width of an engineer road across a water gap (m). */
const BRIDGE_W = 9;

// ------------------------------------------------------------------ starting jobs

/** Check a road a → b: length, grade, water gaps (each ≤ bridge_max_span_m). Returns the gaps. */
export function roadSegmentOk(world: World, a: V2, b: V2): { ok: true; gaps: [V2, V2][] } | { ok: false; reason: string } {
  const r = roadRules(world);
  if (!r) return { ok: false, reason: 'DISABLED' };
  const t = world.terrain;
  const L = dist(a, b);
  if (L < 20 || L > r.max_len_m) return { ok: false, reason: 'LENGTH' };
  if (!t.inBounds(a.x, a.z) || !t.inBounds(b.x, b.z)) return { ok: false, reason: 'OUT_OF_BOUNDS' };
  const gaps: [V2, V2][] = [];
  const n = Math.ceil(L / 4);
  let wet: V2 | null = null;
  for (let k = 0; k <= n; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n };
    const g = t.groundAt(p.x, p.z);
    const water = g === Ground.Water || g === Ground.Ford;
    if (water && !wet) wet = p;
    if (!water && wet) {
      if (dist(wet, p) > r.bridge_max_span_m) return { ok: false, reason: 'WATER' };
      if (t.groundAt(wet.x, wet.z) === Ground.Water || dist(wet, p) > 8) gaps.push([wet, p]);
      wet = null;
    }
    if (!water && !wet && g !== Ground.Road && t.slopeAt(p.x, p.z) > r.max_slope_deg) return { ok: false, reason: 'SLOPE' };
  }
  if (wet) return { ok: false, reason: 'WATER' };
  return { ok: true, gaps };
}

function newJob(world: World, owner: number, kind: TransportJobKind, a: V2, b: V2, workSeconds: number, lineId = -1, fromStation = -1, toPlace = -1): TransportJob {
  const st = world.transport!;
  const job: TransportJob = {
    id: st.nextId++, owner, kind, a: { ...a }, b: { ...b }, lineId, fromStation, toPlace, workSeconds, progress: 0, workedAt: world.time, worker: -1, startedAt: world.time,
  };
  st.jobs.push(job);
  return job;
}

function pay(world: World, f: number, p: number, m: number): boolean {
  const fac = world.factions[f];
  return availableM(world, fac) >= m && fac.p >= p && trySpend(fac, p, m).ok;
}

/** Engineers lay a road a → b (cost and time by length, rules transport.road_job). */
export function startRoadJob(world: World, f: number, a: V2, b: V2): JobResult {
  const r = roadRules(world);
  if (!r || !world.transport) return { ok: false, reason: 'DISABLED' };
  const chk = roadSegmentOk(world, a, b);
  if (!chk.ok) return chk;
  // An overlapping road job (an endpoint within ROAD_OVERLAP_M of one of its endpoints) is already in flight.
  const near = (p: V2, q: V2): boolean => dist(p, q) <= ROAD_OVERLAP_M;
  if (world.transport.jobs.some((j) => j.kind === 'road' && [a, b].some((p) => near(p, j.a) || near(p, j.b)))) return { ok: false, reason: 'BUSY' };
  const L = dist(a, b);
  if (!pay(world, f, 0, (r.cost_m_k_per_100m * armyScale(world) * L) / 100)) return { ok: false, reason: 'NO_BUDGET' };
  world.note(f, 'log.roadJob', {}, 'info');
  return { ok: true, job: newJob(world, f, 'road', a, b, (r.seconds_per_100m * L) / 100) };
}

/** Engineers rebuild a cut rail line the faction holds at both ends. */
export function startRailRepair(world: World, f: number, lineId: number): JobResult {
  const r = railRules(world);
  const st = world.transport;
  const line = st?.lines[lineId];
  if (!r || !st) return { ok: false, reason: 'DISABLED' };
  if (!line) return { ok: false, reason: 'NO_SUCH' };
  if (!line.cut) return { ok: false, reason: 'NOT_CUT' };
  if (stationOwner(world, st.stations[line.a]) !== f || stationOwner(world, st.stations[line.b]) !== f) return { ok: false, reason: 'NOT_HELD' };
  if (st.jobs.some((j) => j.kind === 'rail' && j.lineId === lineId)) return { ok: false, reason: 'BUSY' };
  const k = armyScale(world);
  if (!pay(world, f, r.repair.cost_p_k * k, r.repair.cost_m_k * k)) return { ok: false, reason: 'NO_BUDGET' };
  world.note(f, 'log.railJob', {}, 'info');
  return { ok: true, job: newJob(world, f, 'rail', line.pts[0], line.pts[line.pts.length - 1], r.repair.work_seconds, lineId) };
}

/** Engineers extend the rail from an own station to an own town or city (≤ extend.max_len_m). */
export function startRailExtension(world: World, f: number, stationId: number, objIdx: number): JobResult {
  const r = railRules(world);
  const st = world.transport;
  const s = st?.stations[stationId];
  const o = world.objectives[objIdx];
  if (!r || !st) return { ok: false, reason: 'DISABLED' };
  if (!s || !o) return { ok: false, reason: 'NO_SUCH' };
  if (o.kind !== 'town' && o.kind !== 'city') return { ok: false, reason: 'BAD_TARGET' };
  if (stationOwner(world, s) !== f || o.owner !== f) return { ok: false, reason: 'NOT_HELD' };
  if (st.stations.some((x) => x.placeIdx === objIdx)) return { ok: false, reason: 'HAS_STATION' };
  // One extension per objective and per station at a time.
  if (st.jobs.some((j) => j.kind === 'rail' && j.lineId < 0 && (j.toPlace === objIdx || j.fromStation === stationId))) return { ok: false, reason: 'BUSY' };
  const d = dist(s.pos, o.pos);
  const end = { x: o.pos.x + ((s.pos.x - o.pos.x) / (d || 1)) * Math.min(o.radius, d / 2), z: o.pos.z + ((s.pos.z - o.pos.z) / (d || 1)) * Math.min(o.radius, d / 2) };
  const L = dist(s.pos, end);
  if (L > r.extend.max_len_m) return { ok: false, reason: 'LENGTH' };
  if (!pay(world, f, 0, (r.extend.cost_m_k_per_100m * armyScale(world) * L) / 100)) return { ok: false, reason: 'NO_BUDGET' };
  world.note(f, 'log.railJob', {}, 'info');
  return { ok: true, job: newJob(world, f, 'rail', s.pos, end, (r.extend.seconds_per_100m * L) / 100, -1, stationId, objIdx) };
}

// ------------------------------------------------------------------ engineers

/** Work point of a job: its build front, advancing from a to b. */
export const jobFront = (j: TransportJob): V2 => ({ x: j.a.x + (j.b.x - j.a.x) * j.progress, z: j.a.z + (j.b.z - j.a.z) * j.progress });

/**
 * Engineer hook (behavior.thinkEngineer): an engineer assigned to a transport job walks to its
 * build front and works (only while not suppressed). True while busy.
 */
export function transportDuty(world: World, u: Unit): boolean {
  const st = world.transport;
  if (!st || u.def.id !== 'engineer' || u.manual || u.routing) return false;
  const job = st.jobs.find((j) => j.worker === u.id);
  if (!job) return false;
  const at = jobFront(job);
  if (dist(u.pos, at) > WORK_RADIUS_M) moveTo(world, u, at);
  else {
    stop(u);
    if (u.moraleState === 'normal') {
      job.progress = Math.min(1, job.progress + THINK_S / Math.max(1, job.workSeconds));
      job.workedAt = world.time;
      if (job.progress >= 1) completeJob(world, job);
    }
  }
  u.status = job.kind === 'road' ? 'status.buildingRoad' : 'status.buildingRail';
  return true;
}

/** Finish a job: paint the road / restore or lay the track. */
export function completeJob(world: World, job: TransportJob): void {
  const st = world.transport!;
  const i = st.jobs.indexOf(job);
  if (i >= 0) st.jobs.splice(i, 1);
  if (job.kind === 'road') {
    const chk = roadSegmentOk(world, job.a, job.b);
    paintRoad(world, job.a, job.b, roadRules(world)?.half_width_m ?? 5);
    if (chk.ok) for (const [p, q] of chk.gaps) world.terrain.addBridge(p, q, BRIDGE_W);
    world.onTerrainChanged?.(job.a, job.b);
    st.roads.addSegment(job.a, job.b);
    st.builtRoads.push({ a: { ...job.a }, b: { ...job.b } });
    st.version++;
    world.note(job.owner, 'log.roadBuilt', {}, 'info');
    return;
  }
  if (job.lineId >= 0) {
    const line = st.lines[job.lineId];
    line.cut = false;
    st.version++;
  } else {
    const id = st.stations.length;
    st.stations.push({ id, pos: { ...job.b }, placeIdx: job.toPlace, lines: [] });
    addLine(st, job.fromStation, id, [job.a, job.b], true);
  }
  world.note(job.owner, 'log.railBuilt', {}, 'info');
}

/** Stamp Ground.Road along a → b (half width w), never over water or into houses. */
export function paintRoad(world: World, a: V2, b: V2, w: number): void {
  const t = world.terrain;
  const L = dist(a, b);
  const steps = Math.max(1, Math.ceil(L / 2));
  for (let k = 0; k <= steps; k++) {
    const cx = a.x + ((b.x - a.x) * k) / steps;
    const cz = a.z + ((b.z - a.z) * k) / steps;
    const i0 = Math.max(0, Math.floor((cx - w) / t.cell));
    const i1 = Math.min(t.nx - 1, Math.ceil((cx + w) / t.cell));
    const j0 = Math.max(0, Math.floor((cz - w) / t.cell));
    const j1 = Math.min(t.nz - 1, Math.ceil((cz + w) / t.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * t.cell;
        const z = j * t.cell;
        if (Math.hypot(x - cx, z - cz) > w) continue;
        const idx = j * t.nx + i;
        const g = t.ground[idx];
        if (g === Ground.Water || g === Ground.Ford || t.buildingH(x, z) > 0) continue;
        t.ground[idx] = Ground.Road;
      }
    }
  }
}

/** Give each open job without a living worker the nearest free engineer of its owner. */
function assignWorkers(world: World): void {
  const st = world.transport!;
  const busy = new Set(st.jobs.map((j) => j.worker));
  for (const job of st.jobs) {
    if (job.worker >= 0 && world.unitAlive(job.worker)) continue;
    job.worker = -1;
    const at = jobFront(job);
    let best: Unit | null = null;
    let bd = ASSIGN_RADIUS_M;
    for (const u of world.aliveUnits) {
      if (u.owner !== job.owner || u.hp <= 0 || u.def.id !== 'engineer' || u.manual || busy.has(u.id) || u.rail) continue;
      const d = dist(u.pos, at);
      if (d < bd) { bd = d; best = u; }
    }
    if (best) {
      job.worker = best.id;
      busy.add(best.id);
    }
  }
}

// ------------------------------------------------------------------ AI helper

export interface RoadLinkWant {
  /** Settlement (objective index) or a free point (−1) to link. */
  readonly objIdx: number;
  readonly from: V2;
  readonly to: V2;
}

/**
 * Own towns / cities (and any `extra` sites, e.g. WP-F economic zones) with no road within 150 m
 * that joins the capital's road net, each with the nearest point of that net within
 * `ai.link_max_m`. The lead wires this into the HQ think; `transportSecond` uses it for the AI.
 */
export function needRoadLinks(world: World, f: number, extra: readonly V2[] = []): RoadLinkWant[] {
  const st = world.transport;
  const t = transportRules(world.data.rules);
  if (!st || !t) return [];
  const maxD = t.ai?.link_max_m ?? 600;
  const net = st.roads;
  const comp = net.components();
  const home = net.nearestNode(world.hqPos(f), 400);
  if (!home) return [];
  const homeComp = comp[home.id];
  const linked = (p: V2): boolean => {
    for (const n of net.nodes) if (comp[n.id] === homeComp && dist(n.pos, p) < 150) return true;
    return false;
  };
  const sites: { objIdx: number; pos: V2 }[] = [];
  world.objectives.forEach((o, i) => { if (o.owner === f && (o.kind === 'town' || o.kind === 'city')) sites.push({ objIdx: i, pos: o.pos }); });
  for (const p of extra) sites.push({ objIdx: -1, pos: p });
  const out: RoadLinkWant[] = [];
  for (const s of sites) {
    if (linked(s.pos)) continue;
    let best: V2 | null = null;
    let bd = maxD;
    for (const n of net.nodes) {
      if (comp[n.id] !== homeComp) continue;
      const d = dist(n.pos, s.pos);
      if (d < bd) { bd = d; best = n.pos; }
    }
    if (best) out.push({ objIdx: s.objIdx, from: { ...best }, to: { ...s.pos } });
  }
  return out;
}

const nextThink = new WeakMap<World, number[]>();

/** An engineer of `f` that could take a job now (alive, not on a manual order, not riding, not already on a job). */
export function freeEngineer(world: World, f: number): boolean {
  const st = world.transport;
  if (!st) return false;
  const busy = new Set(st.jobs.map((j) => j.worker));
  for (const u of world.aliveUnits) {
    if (u.owner === f && u.hp > 0 && u.def.id === 'engineer' && !u.manual && !u.rail && !busy.has(u.id)) return true;
  }
  return false;
}

/**
 * HQ think (command.thinkHighCommand, every HQ think) for an AI faction: every `ai.think_seconds`,
 * with no open job, an engineer free and a reserve in the stock, repair one of its own cut lines,
 * else lay one missing road link (settlements and `extraSites` cut off from the capital's net).
 * `extraSites` is the seam for WP-F economic zones (pass the zone positions once `econZones` lands).
 */
export function thinkTransport(world: World, f: Faction, extraSites: readonly V2[] = []): void {
  const st = world.transport;
  const t = transportRules(world.data.rules);
  const ai = t?.ai;
  if (!st || !t || !ai?.enabled || !f.alive || f.isPlayer) return;
  const due = nextThink.get(world) ?? world.factions.map((x) => x.id * 3);
  nextThink.set(world, due);
  if (world.time < due[f.id]) return;
  due[f.id] = world.time + ai.think_seconds;
  if (st.jobs.some((j) => j.owner === f.id)) return;
  if (!freeEngineer(world, f.id)) return;
  const cut = st.lines.find((l) => l.cut && stationOwner(world, st.stations[l.a]) === f.id && stationOwner(world, st.stations[l.b]) === f.id);
  if (cut && railRules(world) && startRailRepair(world, f.id, cut.id).ok) return;
  const want = needRoadLinks(world, f.id, extraSites)[0];
  const road = roadRules(world);
  if (!want || !road) return;
  // Keep a reserve: the road is paid from what is left after a few of its own cost.
  const cost = (road.cost_m_k_per_100m * armyScale(world) * dist(want.from, want.to)) / 100;
  if (availableM(world, f) < cost * ROAD_RESERVE) return;
  startRoadJob(world, f.id, want.from, want.to);
}

/** Road work is only ordered when the stock holds this many times its cost. */
const ROAD_RESERVE = 3;

/** Once per game second (sim.ts): assign engineers and drop stale jobs. The AI side is `thinkTransport`. */
export function transportSecond(world: World): void {
  const st = world.transport;
  if (!st || !transportRules(world.data.rules)) return;
  for (let i = st.jobs.length - 1; i >= 0; i--) {
    const j = st.jobs[i];
    if (!world.factions[j.owner]?.alive || world.time - j.workedAt > STALE_S) st.jobs.splice(i, 1);
  }
  if (st.jobs.length > 0) assignWorkers(world);
}

/** Open transport jobs of a faction (lab / HUD). */
export const openJobs = (world: World, f: number): number => world.transport?.jobs.filter((j) => j.owner === f).length ?? 0;
