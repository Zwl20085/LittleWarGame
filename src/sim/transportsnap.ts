import type { SnapshotCursor } from './snapshot';
import { fogFiltered, trainSeen } from './fogview';
import { BRIDGE_W, paintRoad, roadHalfWidth } from './transportjobs';
import type { BuiltRoad, RailLine, RailStation, Train, TransportJobView } from './transportstate';
import type { RailRide, Unit } from './types';
import type { V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 roads and railways in the worker → main-thread snapshot (snapshot.ts keeps a two-line hook).
 * Every snapshot: each line's state (owner, or CUT) and the trains (flat Float32Array). Only when
 * `transport.version` changed: the geometry that can grow during a match (engineer roads, new
 * stations and lines) so the mirror and the renderer can rebuild.
 */

/** Line state value for a cut line. */
export const LINE_CUT = -2;
/** Packed train record: id, owner, x, z, prevX, prevZ, heading, riders, state (0 boarding, 1 running, 2 unloading). */
export const TRAIN_STRIDE = 9;
const STATES: Train['state'][] = ['boarding', 'running', 'unloading'];

export interface TransportSnap {
  readonly lineState: Int8Array;
  readonly trains: Float32Array;
  /** Open engineer jobs (review MEDIUM 11): kind and rail line for all, the worker for the observer's own. */
  readonly jobs: readonly TransportJobView[];
  readonly version: number;
  /** Null unless the geometry changed since the last snapshot of this cursor. */
  readonly geo: {
    readonly stations: { pos: V2; placeIdx: number }[];
    readonly lines: { a: number; b: number; pts: V2[]; built: boolean }[];
    readonly builtRoads: readonly BuiltRoad[];
  } | null;
}

export function packTransport(w: World, cur: SnapshotCursor, observer = -1): TransportSnap | null {
  const st = w.transport;
  if (!st) return null;
  const lineState = Int8Array.from(st.lines, (l) => (l.cut ? LINE_CUT : l.owner));
  // Review HIGH 2: in fog only the trains the observer sees, and the load of its own trains only.
  const fog = observer >= 0 && fogFiltered(w, observer);
  const sent = fog ? st.trains.filter((t) => trainSeen(w, observer, t)) : st.trains;
  const trains = new Float32Array(sent.length * TRAIN_STRIDE);
  sent.forEach((t, k) => {
    const riders = fog && t.owner !== observer ? 0 : t.riders.length;
    trains.set([t.id, t.owner, t.pos.x, t.pos.z, t.prev.x, t.prev.z, t.heading, riders, STATES.indexOf(t.state)], k * TRAIN_STRIDE);
  });
  const geo = cur.transportVersion !== st.version
    ? { stations: st.stations.map((s) => ({ pos: s.pos, placeIdx: s.placeIdx })), lines: st.lines.map((l) => ({ a: l.a, b: l.b, pts: l.pts, built: l.built })), builtRoads: st.builtRoads }
    : null;
  cur.transportVersion = st.version;
  const jobs = st.jobs.map((j) => ({ owner: j.owner, kind: j.kind, lineId: j.lineId, worker: j.owner === observer ? j.worker : -1 }));
  return { lineState, trains, jobs, version: st.version, geo };
}

export function applyTransport(w: World, snap: TransportSnap): void {
  const st = w.transport;
  if (!st) return;
  if (snap.geo) {
    const g = snap.geo;
    for (let i = st.stations.length; i < g.stations.length; i++) {
      const s: RailStation = { id: i, pos: g.stations[i].pos, placeIdx: g.stations[i].placeIdx, lines: [] };
      st.stations.push(s);
    }
    for (let i = st.lines.length; i < g.lines.length; i++) {
      const l = g.lines[i];
      const cum = [0];
      for (let k = 1; k < l.pts.length; k++) cum.push(cum[k - 1] + Math.hypot(l.pts[k].x - l.pts[k - 1].x, l.pts[k].z - l.pts[k - 1].z));
      const line: RailLine = { id: i, a: l.a, b: l.b, pts: l.pts, cum, len: cum[cum.length - 1], cut: false, owner: -1, heldBy: -1, built: l.built };
      st.lines.push(line);
      st.stations[l.a]?.lines.push(i);
      st.stations[l.b]?.lines.push(i);
    }
    for (let i = st.builtRoads.length; i < g.builtRoads.length; i++) {
      st.builtRoads.push(g.builtRoads[i]);
      mirrorRoad(w, g.builtRoads[i]);
    }
    st.version = snap.version;
  }
  for (let i = 0; i < st.lines.length && i < snap.lineState.length; i++) {
    const v = snap.lineState[i];
    st.lines[i].cut = v === LINE_CUT;
    st.lines[i].owner = v === LINE_CUT ? -1 : v;
  }
  st.jobView = [...(snap.jobs ?? [])];
  const b = snap.trains;
  st.trains.length = 0;
  for (let o = 0; o < b.length; o += TRAIN_STRIDE) {
    st.trains.push({
      id: b[o], owner: b[o + 1], from: -1, to: -1, path: [], cum: [], len: 0, lines: [], state: STATES[b[o + 8]] ?? 'running', s: 0,
      pos: { x: b[o + 2], z: b[o + 3] }, prev: { x: b[o + 4], z: b[o + 5] }, heading: b[o + 6], riders: new Array<number>(b[o + 7]).fill(-1), timer: 0,
    });
  }
}

/**
 * Review MEDIUM 5: replay an engineer road on the main-thread world as transportjobs.completeJob did
 * in the worker (ground paint, bridged gaps, road graph), so the renderer, minimap and terrain tip
 * read the same ground as the sim.
 */
function mirrorRoad(w: World, r: BuiltRoad): void {
  paintRoad(w, r.a, r.b, roadHalfWidth(w));
  for (const [p, q] of r.gaps ?? []) w.terrain.addBridge(p, q, BRIDGE_W);
  w.onTerrainChanged?.(r.a, r.b);
  w.transport?.roads.addSegment(r.a, r.b);
}

/** Mirror-side ride record of a unit the worker reports as aboard (the renderer hides it). */
export function mirrorRide(u: Unit): RailRide {
  return { stage: 'aboard', from: -1, to: -1, dest: { ...u.pos }, trainId: -1, since: 0 };
}
