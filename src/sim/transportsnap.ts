import type { SnapshotCursor } from './snapshot';
import type { RailLine, RailStation, Train } from './transportstate';
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
  readonly version: number;
  /** Null unless the geometry changed since the last snapshot of this cursor. */
  readonly geo: {
    readonly stations: { pos: V2; placeIdx: number }[];
    readonly lines: { a: number; b: number; pts: V2[]; built: boolean }[];
    readonly builtRoads: { a: V2; b: V2 }[];
  } | null;
}

export function packTransport(w: World, cur: SnapshotCursor): TransportSnap | null {
  const st = w.transport;
  if (!st) return null;
  const lineState = Int8Array.from(st.lines, (l) => (l.cut ? LINE_CUT : l.owner));
  const trains = new Float32Array(st.trains.length * TRAIN_STRIDE);
  st.trains.forEach((t, k) => {
    trains.set([t.id, t.owner, t.pos.x, t.pos.z, t.prev.x, t.prev.z, t.heading, t.riders.length, STATES.indexOf(t.state)], k * TRAIN_STRIDE);
  });
  const geo = cur.transportVersion !== st.version
    ? { stations: st.stations.map((s) => ({ pos: s.pos, placeIdx: s.placeIdx })), lines: st.lines.map((l) => ({ a: l.a, b: l.b, pts: l.pts, built: l.built })), builtRoads: st.builtRoads }
    : null;
  cur.transportVersion = st.version;
  return { lineState, trains, version: st.version, geo };
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
    for (let i = st.builtRoads.length; i < g.builtRoads.length; i++) st.builtRoads.push(g.builtRoads[i]);
    st.version = snap.version;
  }
  for (let i = 0; i < st.lines.length && i < snap.lineState.length; i++) {
    const v = snap.lineState[i];
    st.lines[i].cut = v === LINE_CUT;
    st.lines[i].owner = v === LINE_CUT ? -1 : v;
  }
  const b = snap.trains;
  st.trains.length = 0;
  for (let o = 0; o < b.length; o += TRAIN_STRIDE) {
    st.trains.push({
      id: b[o], owner: b[o + 1], from: -1, to: -1, path: [], cum: [], len: 0, lines: [], state: STATES[b[o + 8]] ?? 'running', s: 0,
      pos: { x: b[o + 2], z: b[o + 3] }, prev: { x: b[o + 4], z: b[o + 5] }, heading: b[o + 6], riders: new Array<number>(b[o + 7]).fill(-1), timer: 0,
    });
  }
}

/** Mirror-side ride record of a unit the worker reports as aboard (the renderer hides it). */
export function mirrorRide(u: Unit): RailRide {
  return { stage: 'aboard', from: -1, to: -1, dest: { ...u.pos }, trainId: -1, since: 0 };
}
