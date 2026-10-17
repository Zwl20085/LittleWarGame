import type { TransportRules } from '../data/types';
import type { FrontlineField } from './frontline';
import { moveTo, MOTOR, stop } from './movement';
import { RoadNet } from './roadnet';
import { armyScale, placeOwner, stockCap } from './settlements';
import { moveClassOf, transportRules } from './transport';
import type { RailLine, RailStation, Train, TransportState } from './transportstate';
import type { Place, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';
import { isMotorized } from './upgradestats';

/**
 * 3.0 railways (V30_SPEC §10). Lines link stations at settlements (railgen.ts). A line runs trains
 * for a faction while it holds every station on it, the track is whole and no enemy ground lies
 * across it. A unit sent far (`moveTo`) rides when a usable station is within `board_radius_m`
 * of both ends and the trip saves at least `min_saving` of the time: it walks to the station,
 * boards a train (up to `capacity` units; hidden aboard, like mounted infantry), rides at the
 * train's speed (units.csv `train`, 3× a truck) and gets off at the far station. A station lost
 * to an enemy of the line's holder cuts the track (engineers rebuild it, transportjobs.ts). Held
 * lines also even out the supply stocks of their two settlements. Deterministic: no RNG draws.
 */

export const railRules = (world: World): TransportRules['rail'] | null => {
  const t = transportRules(world.data.rules);
  return t && t.rail.enabled ? t.rail : null;
};

/** Build the run-time transport state from the map (call once at match start). */
export function initTransport(world: World): void {
  const map = world.map;
  const bridges = world.terrain.bridges.filter((b) => b.kind !== 'pontoon').map((b) => ({ x: b.x, z: b.z }));
  const stations: RailStation[] = (map.stations ?? []).map((s, id) => ({ id, pos: { ...s.pos }, placeIdx: s.placeIdx, lines: [] }));
  const st: TransportState = {
    roads: RoadNet.build(map.roads, bridges), stations, lines: [], trains: [], riders: [], jobs: [], builtRoads: [], nextId: 1, version: 1,
  };
  world.transport = st;
  for (const l of map.rails ?? []) addLine(st, l.a, l.b, l.pts, false);
  const r = railRules(world);
  for (const line of st.lines) {
    const held = heldBy(world, line);
    line.heldBy = held;
    line.owner = r ? held : -1;
  }
}

/** Add a rail line between two stations (map generation or an engineer extension). */
export function addLine(st: TransportState, a: number, b: number, pts: readonly V2[], built: boolean): RailLine {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]));
  const line: RailLine = { id: st.lines.length, a, b, pts: pts.map((p) => ({ ...p })), cum, len: cum[cum.length - 1], cut: false, owner: -1, heldBy: -1, built };
  st.lines.push(line);
  st.stations[a].lines.push(line.id);
  st.stations[b].lines.push(line.id);
  st.version++;
  return line;
}

/** Faction holding a station's settlement (−1 none). */
export function stationOwner(world: World, s: RailStation): number {
  if (s.placeIdx < 0) {
    const f = world.factions.find((x) => x.cityIdx === -1 - s.placeIdx);
    return f && f.alive ? f.id : -1;
  }
  return world.objectives[s.placeIdx]?.owner ?? -1;
}

/** Faction holding both stations of a line, else −1. */
function heldBy(world: World, line: RailLine): number {
  const st = world.transport!;
  const a = stationOwner(world, st.stations[line.a]);
  return a >= 0 && a === stationOwner(world, st.stations[line.b]) ? a : -1;
}

/** Ground control along the line: none of it belongs to an enemy of `f`. */
function clearOfEnemyGround(world: World, front: FrontlineField | null, line: RailLine, f: number, step: number): boolean {
  if (!front) return true;
  for (let s = step / 2; s < line.len; s += step) {
    const o = front.ownerAt(pointAlong(line.pts, line.cum, s));
    if (o >= 0 && o !== f && world.isHostile(f, o)) return false;
  }
  return true;
}

/**
 * Once per game second (sim.ts): line ownership and cuts every `check_seconds`, trains whose
 * route stopped being usable unload where they stand, and the rail stock transfer.
 */
export function railSecond(world: World, front: FrontlineField | null): void {
  const st = world.transport;
  const r = railRules(world);
  if (!st || !r) return;
  if (Math.round(world.time) % Math.max(1, Math.round(r.check_seconds)) === 0) {
    for (const line of st.lines) {
      const held = heldBy(world, line);
      // A station that fell to an enemy of the line's holder: the track is torn up.
      if (!line.cut && line.heldBy >= 0 && held !== line.heldBy && lostToEnemy(world, line)) {
        line.cut = true;
        st.version++;
        world.note(line.heldBy, 'log.railCut', {}, 'warn');
      }
      if (held >= 0) line.heldBy = held;
      line.owner = held >= 0 && !line.cut && clearOfEnemyGround(world, front, line, held, r.frontline_sample_m) ? held : -1;
    }
    for (const t of st.trains) {
      if (t.state === 'running' && t.lines.some((id) => st.lines[id].owner !== t.owner)) beginUnload(world, t, 0);
    }
    for (let i = st.riders.length - 1; i >= 0; i--) {
      const u = world.unitAlive(st.riders[i]);
      if (u?.rail && !railRoute(world, u.owner, u.rail.from, u.rail.to)) abandon(world, u);
    }
  }
  stockTransfer(world, r);
}

function lostToEnemy(world: World, line: RailLine): boolean {
  const st = world.transport!;
  for (const id of [line.a, line.b]) {
    const o = stationOwner(world, st.stations[id]);
    if (o >= 0 && o !== line.heldBy && world.isHostile(line.heldBy, o)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ routes

export interface RailRoute {
  readonly lines: number[];
  readonly path: V2[];
  readonly len: number;
}

/** Shortest route from station s1 to s2 over lines usable by `f` (null when none). */
export function railRoute(world: World, f: number, s1: number, s2: number): RailRoute | null {
  const st = world.transport;
  if (!st || s1 === s2) return null;
  const n = st.stations.length;
  const d = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  d[s1] = 0;
  for (;;) {
    let cur = -1;
    for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (cur < 0 || d[i] < d[cur])) cur = i;
    if (cur < 0) return null;
    if (cur === s2) break;
    done[cur] = 1;
    for (const lid of st.stations[cur].lines) {
      const line = st.lines[lid];
      if (line.owner !== f) continue;
      const o = line.a === cur ? line.b : line.a;
      if (d[cur] + line.len < d[o]) { d[o] = d[cur] + line.len; via[o] = lid; }
    }
  }
  const lines: number[] = [];
  const path: V2[] = [];
  for (let cur = s2; cur !== s1;) {
    const line = st.lines[via[cur]];
    lines.unshift(line.id);
    const pts = line.b === cur ? line.pts : [...line.pts].reverse();
    path.unshift(...(path.length ? pts.slice(0, -1) : pts));
    cur = line.a === cur ? line.b : line.a;
  }
  return { lines, path, len: d[s2] };
}

/** Nearest station within r of p that has a line usable by f. */
function usableStation(world: World, f: number, p: V2, r: number): RailStation | null {
  let best: RailStation | null = null;
  let bd = r;
  for (const s of world.transport!.stations) {
    const d = dist(s.pos, p);
    if (d < bd && s.lines.some((id) => world.transport!.lines[id].owner === f)) { bd = d; best = s; }
  }
  return best;
}

function trainSpeed(world: World): number {
  const tempo = world.data.rules.proposed_defaults.tempo_move_multiplier ?? 1;
  const def = world.data.units.get('train') ?? world.data.units.get('supply_truck');
  return (def ? def.speed : 9.6) * tempo * (world.data.units.has('train') ? 1 : 3);
}

/** Rough cross-country travel speed of a unit (m/s): half on roads, half off. */
function travelSpeed(world: World, u: Unit): number {
  const t = transportRules(world.data.rules);
  const tempo = world.data.rules.proposed_defaults.tempo_move_multiplier ?? 1;
  const base = isMotorized(u) ? MOTOR.speed : u.def.speed;
  const cls = isMotorized(u) ? 'wheeled' : moveClassOf(t, u.def);
  const mul = t ? (t.on_road + t.off_road[cls]) / 2 : 1;
  return Math.max(0.1, base * tempo * mul);
}

/** Route detour factor of a walk (m walked per m straight line). */
const WALK_DETOUR = 1.15;
/** A walk to the station taking longer than this (s) is abandoned. */
const TO_STATION_MAX_S = 300;
/** A new order this close to the trip's goal (m) keeps the trip. */
const SAME_GOAL_M = 150;
/** Per-unit decision cache: no fresh rail decision for this long (s) for about the same goal. */
const DECIDE_HOLD_S = 6;
const decided = new WeakMap<Unit, { at: number; dest: V2 }>();

/** What `moveTo` does with a rail trip: walk to `to`, stand still (`hold`), or route normally (null). */
export type RailLeg = { readonly hold: true } | { readonly hold: false; readonly to: V2 } | null;
const HOLD: RailLeg = { hold: true };

/**
 * Called first by `moveTo`. A unit on a trip keeps it while its orders stay about the same (aboard,
 * a new goal just replaces the far end); a unit without one may start one (see the module comment).
 */
export function railLeg(world: World, u: Unit, dest: V2): RailLeg {
  const st = world.transport;
  if (!st) return null;
  if (u.rail) {
    const station = st.stations[u.rail.from];
    const same = dist(dest, u.rail.dest) < SAME_GOAL_M || dist(dest, station.pos) < 40;
    if (u.rail.stage === 'aboard') {
      if (!same) u.rail.dest = { ...dest };
      return HOLD;
    }
    if (same) return u.rail.stage === 'waiting' ? HOLD : { hold: false, to: station.pos };
    abandon(world, u, false);
  }
  const r = railRules(world);
  if (!r || u.fixed || u.fortId !== null) return null;
  // Supply moves by rail as stock (stockTransfer); trucks only ride when the rules say so (lab: they lost time waiting).
  if (u.def.id === 'supply_truck' && !r.trucks_ride) return null;
  const d = dist(u.pos, dest);
  if (d < r.min_trip_m) return null;
  const last = decided.get(u);
  if (last && world.time - last.at < DECIDE_HOLD_S && dist(last.dest, dest) < 60) return null;
  decided.set(u, { at: world.time, dest: { ...dest } });
  const s1 = usableStation(world, u.owner, u.pos, r.board_radius_m);
  const s2 = s1 && usableStation(world, u.owner, dest, r.board_radius_m);
  if (!s1 || !s2 || s1 === s2) return null;
  const route = railRoute(world, u.owner, s1.id, s2.id);
  if (!route) return null;
  const v = travelSpeed(world, u);
  const direct = (d * WALK_DETOUR) / v;
  const byRail = ((dist(u.pos, s1.pos) + dist(s2.pos, dest)) * WALK_DETOUR) / v + r.depart_wait_s + route.len / trainSpeed(world) + r.unload_s;
  if (byRail > (1 - r.min_saving) * direct) return null;
  u.rail = { stage: 'toStation', from: s1.id, to: s2.id, dest: { ...dest }, trainId: -1, since: world.time };
  st.riders.push(u.id);
  return { hold: false, to: s1.pos };
}

/** Give up a trip that has not boarded yet; optionally resume the walk to its goal. */
function abandon(world: World, u: Unit, resume = true): void {
  const st = world.transport!;
  const ride = u.rail;
  if (!ride || ride.stage === 'aboard') return;
  u.rail = null;
  const i = st.riders.indexOf(u.id);
  if (i >= 0) st.riders.splice(i, 1);
  for (const t of st.trains) {
    const k = t.riders.indexOf(u.id);
    if (k >= 0) t.riders.splice(k, 1);
  }
  decided.set(u, { at: world.time, dest: { ...ride.dest } });
  if (resume) moveTo(world, u, ride.dest, true);
}

// ------------------------------------------------------------------ per tick

/** Station proximity that counts as arrived (m). */
const AT_STATION_M = 45;

/** Every tick (after movement): walkers reach stations and board, trains run and unload. */
export function railTick(world: World): void {
  const st = world.transport;
  if (!st || (st.riders.length === 0 && st.trains.length === 0)) return;
  const r = railRules(world);
  if (!r) return;
  for (let i = 0; i < st.riders.length; i++) {
    const u = world.unitAlive(st.riders[i]);
    if (!u || !u.rail) {
      st.riders.splice(i--, 1);
      continue;
    }
    const ride = u.rail;
    const station = st.stations[ride.from];
    if (ride.stage === 'toStation') {
      if (dist(u.pos, station.pos) < AT_STATION_M) {
        ride.stage = 'waiting';
        ride.since = world.time;
        stop(u);
      } else if (world.time - ride.since > TO_STATION_MAX_S) {
        abandon(world, u);
        i--;
        continue;
      }
    }
    if (ride.stage === 'waiting') {
      u.status = 'status.awaitingTrain';
      const t = boardingTrain(world, r, u.owner, ride.from, ride.to);
      if (t) {
        t.riders.push(u.id);
        ride.stage = 'aboard';
        ride.trainId = t.id;
        stop(u);
        u.mounted = false;
        st.riders.splice(i--, 1);
      }
    }
  }
  const speed = trainSpeed(world);
  for (let i = 0; i < st.trains.length; i++) {
    const t = st.trains[i];
    t.prev = { ...t.pos };
    if (t.state === 'boarding' && (t.riders.length >= r.capacity || world.time >= t.timer)) t.state = t.riders.length > 0 ? 'running' : t.state;
    if (t.state === 'boarding' && world.time >= t.timer && t.riders.length === 0) {
      st.trains.splice(i--, 1);
      continue;
    }
    if (t.state === 'running') {
      t.s = Math.min(t.len, t.s + speed * world.dt);
      const p = pointAlong(t.path, t.cum, t.s);
      const ahead = pointAlong(t.path, t.cum, Math.min(t.len, t.s + 4));
      if (ahead.x !== p.x || ahead.z !== p.z) t.heading = Math.atan2(ahead.z - p.z, ahead.x - p.x);
      t.pos = p;
      if (t.s >= t.len) beginUnload(world, t, r.unload_s);
    }
    if (t.state === 'unloading' && world.time >= t.timer) {
      unloadAll(world, t);
      st.trains.splice(i--, 1);
      continue;
    }
    carry(world, t);
  }
}

/** A train boarding at `from` for `to` with room, or a new one (if the faction has stock to spare). */
function boardingTrain(world: World, r: TransportRules['rail'], f: number, from: number, to: number): Train | null {
  const st = world.transport!;
  let mine = 0;
  for (const t of st.trains) {
    if (t.owner !== f) continue;
    mine++;
    if (t.state === 'boarding' && t.from === from && t.to === to && t.riders.length < r.capacity) return t;
  }
  if (mine >= r.trains_per_faction) return null;
  const route = railRoute(world, f, from, to);
  if (!route) return null;
  const cum = [0];
  for (let k = 1; k < route.path.length; k++) cum.push(cum[k - 1] + dist(route.path[k - 1], route.path[k]));
  const p0 = route.path[0];
  const p1 = route.path[Math.min(1, route.path.length - 1)];
  const t: Train = {
    id: st.nextId++, owner: f, from, to, path: route.path, cum, len: cum[cum.length - 1], lines: route.lines,
    state: 'boarding', s: 0, pos: { ...p0 }, prev: { ...p0 }, heading: Math.atan2(p1.z - p0.z, p1.x - p0.x), riders: [], timer: world.time + r.depart_wait_s,
  };
  st.trains.push(t);
  return t;
}

function beginUnload(world: World, t: Train, seconds: number): void {
  t.state = 'unloading';
  t.timer = world.time + seconds;
}

/** Riders sit on the train: same position, no path, shown as riding. */
function carry(world: World, t: Train): void {
  for (const id of t.riders) {
    const u = world.unitAlive(id);
    if (!u) continue;
    u.pos.x = t.pos.x;
    u.pos.z = t.pos.z;
    u.heading = t.heading;
    u.status = 'status.ridingRail';
  }
}

/** Everyone off around the train, then on to their own goals. */
function unloadAll(world: World, t: Train): void {
  t.riders.forEach((id, k) => {
    const u = world.unitAlive(id);
    if (!u || !u.rail) return;
    const dest = u.rail.dest;
    const a = (k / Math.max(1, t.riders.length)) * Math.PI * 2;
    const p = { x: t.pos.x + Math.cos(a) * (10 + 3 * k), z: t.pos.z + Math.sin(a) * (10 + 3 * k) };
    const q = world.navFor(u).nearestPassable(p, 40) ?? world.navFor(u).nearestPassable(t.pos, 60) ?? t.pos;
    u.pos.x = q.x;
    u.pos.z = q.z;
    u.prev.x = q.x;
    u.prev.z = q.z;
    u.y = world.terrain.heightAt(q.x, q.z);
    u.rail = null;
    u.terrainMulAt = -1;
    decided.set(u, { at: world.time, dest: { ...dest } });
    moveTo(world, u, dest, true);
  });
  t.riders.length = 0;
}

// ------------------------------------------------------------------ supply by rail

const placeCache = new WeakMap<World, (Place | null)[]>();

/** The supply place of a station's settlement (capital or town / city), if it has one. */
export function stationPlace(world: World, s: RailStation): Place | null {
  let list = placeCache.get(world);
  if (!list || list.length !== world.transport!.stations.length) {
    list = world.transport!.stations.map((x) => world.places.find((p) => (x.placeIdx < 0 ? p.capitalOf >= 0 && world.factions[p.capitalOf]?.cityIdx === -1 - x.placeIdx : p.objIdx === x.placeIdx)) ?? null);
    placeCache.set(world, list);
  }
  return list[s.id];
}

/** Held lines even out the fill of their two settlements' stocks (stock_transfer_per_min_k per line). */
function stockTransfer(world: World, r: TransportRules['rail']): void {
  const st = world.transport!;
  const rate = (r.stock_transfer_per_min_k * armyScale(world)) / 60;
  if (rate <= 0) return;
  for (const line of st.lines) {
    if (line.owner < 0) continue;
    const pa = stationPlace(world, st.stations[line.a]);
    const pb = stationPlace(world, st.stations[line.b]);
    if (!pa || !pb || placeOwner(world, pa) !== line.owner || placeOwner(world, pb) !== line.owner) continue;
    const ca = stockCap(world, pa);
    const cb = stockCap(world, pb);
    if (ca <= 0 || cb <= 0) continue;
    const [hi, lo, ch, cl] = pa.stock / ca >= pb.stock / cb ? [pa, pb, ca, cb] : [pb, pa, cb, ca];
    const gap = hi.stock / ch - lo.stock / cl;
    if (gap < 0.05) continue;
    const move = Math.min(rate, (gap * Math.min(ch, cl)) / 2, hi.stock, cl - lo.stock);
    if (move <= 0) continue;
    hi.stock -= move;
    lo.stock += move;
  }
}

// ------------------------------------------------------------------ geometry

export function pointAlong(pts: readonly V2[], cum: readonly number[], s: number): V2 {
  if (pts.length === 1) return { ...pts[0] };
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m;
    else hi = m;
  }
  const L = cum[hi] - cum[lo];
  const t = L > 0 ? Math.min(1, Math.max(0, (s - cum[lo]) / L)) : 0;
  return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * t, z: pts[lo].z + (pts[hi].z - pts[lo].z) * t };
}

/** Is the unit aboard a train (hidden, carried; no thinking, moving or firing)? */
export const aboard = (u: Unit): boolean => u.rail !== null && u.rail.stage === 'aboard';
