import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { TransportState } from '../sim/transportstate';
import type { V2 } from '../sim/vec';
import { tintedMaterial } from './instancing';
import { Kit, paint } from './modelKit';
import { trainGeometry, TRAIN_LEN } from './vehicleModels';

/**
 * 3.0 railways and engineer roads on the map (V30_SPEC §10), all instanced: a ballast bed,
 * sleepers every 2.4 m, two rails, a small station building at each station, dirt strips for the
 * roads engineers lay during the match, and the trains (locomotive + two wagons, faction tint).
 * Static parts are rebuilt only when `transport.version` changes (an extension or a new road);
 * trains are re-posed every frame. Cut lines show a rust-red bed so a severed railway reads at a
 * glance.
 */

const SLEEPER_STEP = 2.4;
const PIECE = 6;
const GAUGE = 1.44;
const MAX_TRAINS = 48;
const BALLAST = new THREE.Color('#7b766b');
const BALLAST_CUT = new THREE.Color('#7d4a3a');
const SLEEPER = new THREE.Color('#4b3a2a');
const RAIL = new THREE.Color('#9a9a96');
const DIRT = new THREE.Color('#8c7b5e');
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

/** A piece of straight track: centre, heading, length, height. */
interface Piece { readonly x: number; readonly z: number; readonly y: number; readonly h: number; readonly len: number; readonly cut: boolean }

export class RailField {
  readonly group = new THREE.Group();
  private version = -1;
  private cutKey = '';
  private statics: THREE.InstancedMesh[] = [];
  private readonly trains: THREE.InstancedMesh;

  constructor(private readonly terrain: Terrain, private readonly state: () => TransportState | null, private readonly colorOf: (owner: number) => string) {
    this.group.name = 'rails';
    this.trains = new THREE.InstancedMesh(trainGeometry(), tintedMaterial(0.75, 0.25), MAX_TRAINS);
    this.trains.count = 0;
    this.trains.castShadow = true;
    this.trains.frustumCulled = false;
    this.group.add(this.trains);
  }

  /** Height of the track bed at (x, z): the ground, or a bridge deck over water. */
  private bedY(x: number, z: number): number {
    const t = this.terrain;
    const i = Math.max(0, Math.min(t.nx - 1, Math.round(x / t.cell)));
    const j = Math.max(0, Math.min(t.nz - 1, Math.round(z / t.cell)));
    const w = t.waterSurface[j * t.nx + i];
    const g = t.heightAt(x, z);
    return Number.isNaN(w) ? g : Math.max(g, w + 1.2);
  }

  private pieces(pts: readonly V2[], step: number, cut: boolean): Piece[] {
    const out: Piece[] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.01) continue;
      const n = Math.max(1, Math.round(L / step));
      const h = Math.atan2(b.z - a.z, b.x - a.x);
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        out.push({ x, z, y: this.bedY(x, z), h, len: L / n, cut });
      }
    }
    return out;
  }

  private rebuild(st: TransportState): void {
    for (const m of this.statics) {
      this.group.remove(m);
      m.dispose();
    }
    this.statics = [];
    const beds: Piece[] = [];
    const ties: Piece[] = [];
    for (const l of st.lines) {
      beds.push(...this.pieces(l.pts, PIECE, l.cut));
      ties.push(...this.pieces(l.pts, SLEEPER_STEP, l.cut));
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    const plain = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    const metal = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.6, color: RAIL });
    const bed = this.instanced(box, plain, beds, (p) => [p.len + 0.3, 0.35, 3.2, 0.12], (p) => (p.cut ? BALLAST_CUT : BALLAST));
    const sleepers = this.instanced(box, plain, ties, () => [0.26, 0.14, 2.5, 0.33], () => SLEEPER);
    const railPieces = beds.flatMap((p) => [-1, 1].map((side) => ({ ...p, side })));
    const rails = this.instanced(box, metal, railPieces, (p) => [p.len + 0.05, 0.14, 0.08, 0.44], null, (p) => (p as Piece & { side: number }).side * GAUGE * 0.5);
    const roads = st.builtRoads.flatMap((r) => this.pieces([r.a, r.b], PIECE, false));
    const dirt = this.instanced(box, plain, roads, (p) => [p.len + 0.4, 0.12, 8, 0.06], () => DIRT);
    const stationGeo = stationGeometry();
    const stations = new THREE.InstancedMesh(stationGeo, tintedMaterial(0.9, 0.05), Math.max(1, st.stations.length));
    st.stations.forEach((s, k) => {
      const line = s.lines.length > 0 ? st.lines[s.lines[0]] : null;
      const h = line ? stationHeading(line.pts, s.pos) : 0;
      _p.set(s.pos.x, this.terrain.heightAt(s.pos.x, s.pos.z), s.pos.z);
      _q.setFromEuler(_e.set(0, -h, 0));
      _m.compose(_p, _q, _s.set(1, 1, 1));
      stations.setMatrixAt(k, _m);
      stations.setColorAt(k, _c.set(0, 0, 0));
    });
    stations.count = st.stations.length;
    stations.castShadow = true;
    stations.receiveShadow = true;
    for (const m of [bed, sleepers, rails, dirt, stations]) {
      if (!m) continue;
      m.matrixAutoUpdate = false;
      this.statics.push(m);
      this.group.add(m);
    }
  }

  private instanced<T extends Piece>(geo: THREE.BufferGeometry, mat: THREE.Material, list: T[], size: (p: T) => [number, number, number, number], color: ((p: T) => THREE.Color) | null, side: (p: T) => number = () => 0): THREE.InstancedMesh | null {
    if (list.length === 0) return null;
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((p, k) => {
      const [sx, sy, sz, lift] = size(p);
      const off = side(p);
      _p.set(p.x - Math.sin(p.h) * off, p.y + lift, p.z + Math.cos(p.h) * off);
      _q.setFromEuler(_e.set(0, -p.h, 0));
      _m.compose(_p, _q, _s.set(sx, sy, sz));
      m.setMatrixAt(k, _m);
      if (color) m.setColorAt(k, color(p));
    });
    m.receiveShadow = true;
    return m;
  }

  /** Per frame: rebuild static track when it changed; pose the trains (interpolated by alpha). */
  update(alpha: number): void {
    const st = this.state();
    if (!st) return;
    const cutKey = st.lines.map((l) => (l.cut ? 1 : 0)).join('');
    if (st.version !== this.version || cutKey !== this.cutKey) {
      this.version = st.version;
      this.cutKey = cutKey;
      this.rebuild(st);
    }
    const n = Math.min(MAX_TRAINS, st.trains.length);
    for (let k = 0; k < n; k++) {
      const t = st.trains[k];
      const x = t.prev.x + (t.pos.x - t.prev.x) * alpha;
      const z = t.prev.z + (t.pos.z - t.prev.z) * alpha;
      // The model's origin is mid-train: shift it back so the locomotive leads from the train position.
      const cx = x - Math.cos(t.heading) * TRAIN_LEN * 0.5;
      const cz = z - Math.sin(t.heading) * TRAIN_LEN * 0.5;
      _p.set(cx, this.bedY(cx, cz) + 0.3, cz);
      _q.setFromEuler(_e.set(0, -t.heading, 0));
      _m.compose(_p, _q, _s.set(1, 1, 1));
      this.trains.setMatrixAt(k, _m);
      this.trains.setColorAt(k, _c.set(this.colorOf(t.owner)));
    }
    this.trains.count = n;
    this.trains.instanceMatrix.needsUpdate = true;
    if (this.trains.instanceColor) this.trains.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.statics) m.dispose();
    this.trains.dispose();
  }
}

/** Heading of a line at its end nearest the station (the building sits along the track). */
function stationHeading(pts: readonly V2[], at: V2): number {
  const first = Math.hypot(pts[0].x - at.x, pts[0].z - at.z) < Math.hypot(pts[pts.length - 1].x - at.x, pts[pts.length - 1].z - at.z);
  const a = first ? pts[0] : pts[pts.length - 1];
  const b = first ? pts[1] ?? pts[0] : pts[pts.length - 2] ?? a;
  return Math.atan2(b.z - a.z, b.x - a.x);
}

/** Small halt: brick building with a pitched roof and a platform beside the track (+x along it). */
function stationGeometry(): THREE.BufferGeometry {
  const k = new Kit();
  const [pc, pt] = paint(0.5);
  k.box(16, 0.6, 3, 0, 0.3, 3.4, new THREE.Color('#8f8a7e'));
  k.box(9, 3.6, 5, 0, 1.8, 7.6, new THREE.Color('#8a5a44'));
  k.box(9.6, 0.4, 3.2, 0, 4.2, 6.4, new THREE.Color('#4a4038'), 0, 0.5, 0, 0);
  k.box(9.6, 0.4, 3.2, 0, 4.2, 8.8, new THREE.Color('#4a4038'), 0, -0.5, 0, 0);
  k.box(1.6, 2.4, 0.1, -2, 1.2, 5.05, new THREE.Color('#3a2e24'));
  k.box(2.2, 0.5, 0.12, 2, 3.1, 5.06, pc, pt);
  k.cyl(0.06, 0.06, 4, 5, 6.5, 2, 4.8, new THREE.Color('#333333'));
  return k.build();
}
