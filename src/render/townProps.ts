import * as THREE from 'three';
import { Ground, type Building, type Terrain } from '../sim/terrain';
import { GeoBuilder, trs } from './instancing';
import type { TownGrid } from './townPlan';

/**
 * Town and roadside detail (2.1): lamp posts along the streets, a monument or well with
 * market stalls on the town square, church yards with walls and headstones, garden fences
 * behind the houses, parked carts, factory crate yards with a rail spur, village wells, hay
 * ricks by the barns and telegraph poles along the country roads. Everything is static, so it
 * is baked per 900 m tile into the detailed variant of that tile's landmark mesh (settlements):
 * no extra draw call; the plain variant is shown at the overview and on medium / low quality.
 */

const TILE = 900;

const C = {
  iron: new THREE.Color('#2e3530'),
  lampGlass: new THREE.Color('#e8dcae'),
  stone: new THREE.Color('#bdb4a0'),
  stoneDark: new THREE.Color('#948b78'),
  bronze: new THREE.Color('#5b6a58'),
  wood: new THREE.Color('#6b5639'),
  woodLight: new THREE.Color('#8a7350'),
  woodDark: new THREE.Color('#4a3b28'),
  fence: new THREE.Color('#9a8d76'),
  wall: new THREE.Color('#aca18a'),
  canvasA: new THREE.Color('#b8564a'),
  canvasB: new THREE.Color('#e3d9c0'),
  canvasC: new THREE.Color('#5f7a5a'),
  crate: new THREE.Color('#9c8358'),
  barrel: new THREE.Color('#5a4a3a'),
  rail: new THREE.Color('#4b4a46'),
  sleeper: new THREE.Color('#5a4c3c'),
  hay: new THREE.Color('#c9b06a'),
  yew: new THREE.Color('#3f5236'),
  water: new THREE.Color('#2f4448'),
  roof: new THREE.Color('#6e4a3a'),
  pole: new THREE.Color('#5d4b36'),
  insulator: new THREE.Color('#d9d4c4'),
};

/** Pre-de-indexed primitives: GeoBuilder.add would otherwise de-index on every call. */
const BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const geoCache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    if (g.index) g = g.toNonIndexed();
    geoCache.set(key, g);
  }
  return g;
}

/** Unit wedge: rises from y = 0 at x = 0 to y = 1 at x = 1; z in [-.5, .5]. */
function wedgeGeo(): THREE.BufferGeometry {
  const p = [
    [0, 0, -0.5], [1, 0, -0.5], [1, 1, -0.5], [0, 0, 0.5], [1, 0, 0.5], [1, 1, 0.5],
  ];
  const tris = [[0, 2, 1], [3, 4, 5], [0, 3, 5], [0, 5, 2], [1, 2, 5], [1, 5, 4], [0, 1, 4], [0, 4, 3]];
  const pos: number[] = [];
  for (const t of tris) for (const k of t) pos.push(...p[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Local drawing frame: origin (x, z) on the map, rotated by a Three.js Y angle; y is absolute. */
export interface Frame {
  box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, rx?: number, ry?: number, rz?: number): void;
  cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, c: THREE.Color, rx?: number, ry?: number, rz?: number): void;
  cone(r: number, h: number, seg: number, x: number, y: number, z: number, c: THREE.Color, ry?: number): void;
  /** Wedge from local x0 (height 0) to x1 (height h), `depth` across, base at y. */
  slope(x0: number, x1: number, depth: number, y: number, h: number, c: THREE.Color): void;
  /** World position of a local point. */
  point(x: number, y: number, z: number): THREE.Vector3;
}

export function frameAt(b: GeoBuilder, x: number, z: number, yaw: number): Frame {
  const base = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z);
  const m = new THREE.Matrix4();
  const at = (local: THREE.Matrix4): THREE.Matrix4 => m.multiplyMatrices(base, local);
  return {
    box(w, h, d, x, y, z, c, rx = 0, ry = 0, rz = 0) {
      b.add(BOX, at(trs(x, y, z, rx, ry, rz, w, h, d)), c);
    },
    cyl(rt, rb, h, seg, x, y, z, c, rx = 0, ry = 0, rz = 0) {
      const g = cached(`c${rt},${rb},${seg}`, () => new THREE.CylinderGeometry(rt, rb, 1, seg));
      b.add(g, at(trs(x, y, z, rx, ry, rz, 1, h, 1)), c);
    },
    cone(r, h, seg, x, y, z, c, ry = 0) {
      const g = cached(`k${seg}`, () => new THREE.ConeGeometry(1, 1, seg));
      b.add(g, at(trs(x, y, z, 0, ry, 0, r, h, r)), c);
    },
    slope(x0, x1, depth, y, h, c) {
      b.add(cached('wedge', wedgeGeo), at(trs(x0, y, 0, 0, 0, 0, x1 - x0, h, depth)), c);
    },
    point(px, py, pz) {
      return new THREE.Vector3(px, py, pz).applyMatrix4(base);
    },
  };
}

/** Frame of a building as drawn (Three.js rotation by `rot` about its centre). */
export function buildingFrame(b: GeoBuilder, bld: Building): Frame {
  return frameAt(b, bld.x, bld.z, bld.rot);
}

/** Inside a building footprint (+pad m), using the drawn rotation (as the sim rasterises it). */
function inBuilding(bs: readonly Building[], x: number, z: number, pad: number): boolean {
  for (const b of bs) {
    const dx = x - b.x;
    const dz = z - b.z;
    const r = Math.max(b.w, b.d) * 0.75 + pad;
    if (dx * dx + dz * dz > r * r) continue;
    const cs = Math.cos(b.rot);
    const sn = Math.sin(b.rot);
    if (Math.abs(dx * cs - dz * sn) <= b.w / 2 + pad && Math.abs(dx * sn + dz * cs) <= b.d / 2 + pad) return true;
  }
  return false;
}

function hash(x: number, z: number, s: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233 + s * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

type Ground3 = (x: number, z: number) => number;

/** Tile-keyed builders. */
class Tiles {
  readonly map = new Map<string, GeoBuilder>();
  at(x: number, z: number): GeoBuilder {
    const key = tileKey(x, z);
    let b = this.map.get(key);
    if (!b) this.map.set(key, (b = new GeoBuilder()));
    return b;
  }
}

/** Yaw that turns local +x toward the horizontal direction (dx, dz). */
function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

function lampPost(f: Frame, y: number): void {
  f.cyl(0.24, 0.3, 0.5, 6, 0, y + 0.25, 0, C.iron);
  f.cyl(0.08, 0.11, 5.6, 6, 0, y + 3.0, 0, C.iron);
  f.box(1.1, 0.09, 0.09, 0.5, y + 5.6, 0, C.iron);
  f.box(0.42, 0.5, 0.42, 1.0, y + 5.25, 0, C.lampGlass);
  f.cone(0.38, 0.3, 4, 1.0, y + 5.65, 0, C.iron, Math.PI / 4);
}

function marketStall(f: Frame, y: number, canvas: THREE.Color): void {
  for (const [x, z] of [[-1.3, -0.9], [1.3, -0.9], [-1.3, 0.9], [1.3, 0.9]]) f.box(0.12, 2.4, 0.12, x, y + 1.2, z, C.wood);
  f.box(2.8, 0.12, 1.6, 0, y + 0.95, 0, C.woodLight);
  f.box(2.6, 0.75, 1.4, 0, y + 0.5, 0, C.woodDark);
  for (let i = 0; i < 4; i++) f.box(0.7, 0.18, 1.6, -1.05 + i * 0.7, y + 2.55 - (i % 2) * 0.02, 0, i % 2 ? C.canvasB : canvas, 0.22);
  f.box(0.5, 0.35, 0.4, -0.7, y + 1.18, 0.2, C.crate);
  f.cyl(0.22, 0.22, 0.35, 6, 0.5, y + 1.18, -0.2, C.hay);
}

function cart(f: Frame, y: number, loaded: number): void {
  f.box(2.3, 0.18, 1.4, 0, y + 0.95, 0, C.woodLight);
  for (const s of [-1, 1]) {
    f.box(2.3, 0.4, 0.08, 0, y + 1.2, s * 0.68, C.wood);
    f.cyl(0.6, 0.6, 0.1, 10, -0.2, y + 0.6, s * 0.82, C.woodDark, Math.PI / 2);
    f.box(1.9, 0.08, 0.08, 1.9, y + 0.75, s * 0.4, C.wood);
  }
  if (loaded > 0.5) {
    f.box(0.6, 0.5, 0.6, -0.5, y + 1.3, 0.25, C.crate);
    f.cyl(0.32, 0.32, 0.6, 8, 0.4, y + 1.3, -0.2, C.barrel, Math.PI / 2);
  } else f.box(1.8, 0.45, 1.1, 0, y + 1.25, 0, C.hay);
}

function fenceRun(f: Frame, x0: number, z0: number, x1: number, z1: number, y: (x: number, z: number) => number, stone: boolean): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 0.5) return;
  const ry = Math.atan2(-(z1 - z0), x1 - x0);
  const mx = (x0 + x1) / 2;
  const mz = (z0 + z1) / 2;
  const ym = y(mx, mz);
  if (stone) {
    f.box(len, 0.95, 0.4, mx, ym + 0.4, mz, C.wall, 0, ry);
    f.box(len + 0.05, 0.1, 0.5, mx, ym + 0.9, mz, C.stoneDark, 0, ry);
    return;
  }
  f.box(len, 0.08, 0.06, mx, ym + 0.95, mz, C.fence, 0, ry);
  f.box(len, 0.08, 0.06, mx, ym + 0.45, mz, C.fence, 0, ry);
  const n = Math.max(1, Math.round(len / 2.2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = x0 + (x1 - x0) * t;
    const pz = z0 + (z1 - z0) * t;
    f.box(0.12, 1.25, 0.12, px, y(px, pz) + 0.55, pz, C.fence);
  }
}

/** Street furniture, square, gardens, church yards and factory yards of one grid town. */
function gridTown(tiles: Tiles, t: Terrain, g: TownGrid, ground: Ground3): void {
  const b = tiles.at(g.x, g.z);
  // Grid frame: local x = u, local z = v (Three yaw −ang maps +x to the grid's u axis).
  const f = frameAt(b, g.x, g.z, -g.ang);
  const ca = Math.cos(g.ang);
  const sa = Math.sin(g.ang);
  const wx = (u: number, v: number): number => g.x + u * ca - v * sa;
  const wz = (u: number, v: number): number => g.z + u * sa + v * ca;
  const gy = (u: number, v: number): number => ground(wx(u, v), wz(u, v));
  const lines: number[] = [];
  for (let u = -g.half - g.cell / 2; u <= g.half + g.cell / 2; u += g.cell) if (Math.abs(u) < g.reach - 8) lines.push(u);
  const nearLine = (v: number): number => lines.reduce((m, l) => Math.min(m, Math.abs(v - l)), Infinity);
  const blocked = (u: number, v: number, pad: number): boolean => inBuilding(g.buildings, wx(u, v), wz(u, v), pad) || t.groundAt(wx(u, v), wz(u, v)) === Ground.Water;
  const onSquare = (u: number, v: number, extra: number): boolean => g.square !== null && Math.hypot(wx(u, v) - g.square.x, wz(u, v) - g.square.z) < g.square.r + extra;
  // Lamp posts along both kerbs of every street, staggered, clear of crossings and houses.
  for (const line of lines) {
    for (const side of [-1, 1]) {
      const off = line + side * 4.6;
      const lim = Math.sqrt(Math.max(0, (g.reach - 6) ** 2 - off * off));
      for (let s = -lim + (side > 0 ? 6 : 19); s < lim; s += 26) {
        if (nearLine(s) < 8 || onSquare(off, s, 2)) continue;
        // Street along v at u = off, and the same lamp mirrored onto the street along u.
        for (const [u, v, du, dv] of [[off, s, -side, 0], [s, off, 0, -side]]) {
          if (blocked(u, v, 0.8)) continue;
          const yaw = yawTo(du * ca - dv * sa, du * sa + dv * ca);
          lampPost(frameAt(b, wx(u, v), wz(u, v), yaw), gy(u, v));
        }
      }
    }
  }
  // Parked carts on the carriageway edge.
  for (const line of lines) {
    for (const side of [-1, 1]) {
      const off = line + side * 2.4;
      const lim = Math.sqrt(Math.max(0, (g.reach - 10) ** 2 - off * off));
      for (let s = -lim; s < lim; s += 34) {
        const hsh = hash(off + g.x, s + g.z, 9);
        if (hsh > 0.16 || nearLine(s) < 10 || onSquare(off, s, 4)) continue;
        for (const [u, v, alongU] of [[off, s, false], [s, off, true]] as const) {
          if (hash(u, v, 3) > 0.5 || blocked(u, v, 1.5)) continue;
          const yaw = alongU ? -g.ang : -g.ang - Math.PI / 2;
          cart(frameAt(b, wx(u, v), wz(u, v), yaw + (side > 0 ? Math.PI : 0)), gy(u, v), hash(u, v, 4));
        }
      }
    }
  }
  // Town square: monument (cities) or a well (towns), market stalls on the diagonals, benches.
  if (g.square) {
    const sq = g.square;
    const y = ground(sq.x, sq.z);
    const s = frameAt(b, sq.x, sq.z, -g.ang);
    if (g.kind === 'town') {
      s.cyl(1.5, 1.6, 0.9, 12, 0, y + 0.45, 0, C.stone);
      s.cyl(1.15, 1.15, 0.12, 12, 0, y + 0.86, 0, C.water);
      for (const z of [-1.3, 1.3]) s.box(0.16, 2.6, 0.16, 0, y + 1.3, z, C.wood);
      s.box(0.12, 0.12, 2.8, 0, y + 2.4, 0, C.wood);
      s.slope(-1.2, 0, 3.2, y + 2.55, 0.8, C.roof);
      s.slope(1.2, 0, 3.2, y + 2.55, 0.8, C.roof);
    } else {
      s.box(6.4, 0.6, 6.4, 0, y + 0.3, 0, C.stoneDark);
      s.box(5.0, 0.6, 5.0, 0, y + 0.9, 0, C.stone);
      s.box(2.6, 2.6, 2.6, 0, y + 2.5, 0, C.stone);
      s.box(2.9, 0.3, 2.9, 0, y + 3.9, 0, C.stoneDark);
      s.cyl(0.55, 0.8, 7.0, 8, 0, y + 7.5, 0, C.stone);
      s.box(1.3, 0.35, 1.3, 0, y + 11.1, 0, C.stoneDark);
      // A bronze figure on top (a standing officer, cloak and cap).
      s.cyl(0.38, 0.55, 1.6, 6, 0, y + 12.1, 0, C.bronze);
      s.cyl(0.22, 0.22, 0.45, 6, 0, y + 13.1, 0, C.bronze);
      s.box(0.12, 0.9, 0.12, 0.45, y + 12.6, 0.15, C.bronze, 0, 0, 0.5);
    }
    const stalls = g.kind === 'town' ? 2 : 4;
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const r = sq.r * 0.72;
      const u = Math.cos(a) * r;
      const v = Math.sin(a) * r;
      const px = sq.x + u * ca - v * sa;
      const pz = sq.z + u * sa + v * ca;
      if (inBuilding(g.buildings, px, pz, 1.5)) continue;
      const yaw = -g.ang - a + Math.PI / 2;
      if (k < stalls) marketStall(frameAt(b, px, pz, yaw), ground(px, pz), [C.canvasA, C.canvasC, C.canvasA, C.canvasC][k]);
      else {
        const bf = frameAt(b, px, pz, yaw);
        const by = ground(px, pz);
        bf.box(2.2, 0.1, 0.5, 0, by + 0.5, 0, C.woodLight);
        for (const x of [-0.9, 0.9]) bf.box(0.12, 0.5, 0.45, x, by + 0.25, 0, C.iron);
      }
    }
  }
  for (const bld of g.buildings) {
    if (bld.kind === 'church') churchYard(b, t, g, bld, ground, lines, ca, sa);
    else if (bld.kind === 'factory') factoryYard(b, g, bld, ground);
    else if (bld.kind === 'house') garden(f, g, bld, gy, lines, blocked);
  }
}

/** Fenced back garden of a terraced house, toward its block's courtyard (grid frame). */
function garden(f: Frame, g: TownGrid, bld: Building, gy: (u: number, v: number) => number, lines: readonly number[], blocked: (u: number, v: number, pad: number) => boolean): void {
  if (hash(bld.x, bld.z, 21) < 0.25) return;
  const ca = Math.cos(g.ang);
  const sa = Math.sin(g.ang);
  const dx = bld.x - g.x;
  const dz = bld.z - g.z;
  const u = dx * ca + dz * sa;
  const v = -dx * sa + dz * ca;
  const snap = (c: number): number => -g.half + Math.round((c + g.half) / g.cell) * g.cell;
  const bu = snap(u);
  const bv = snap(v);
  // Back direction: toward the block centre along the axis the house is offset on.
  const alongU = Math.abs(bu - u) > Math.abs(bv - v);
  const dir = alongU ? Math.sign(bu - u) : Math.sign(bv - v);
  const halfW = Math.min(bld.w, 9) / 2;
  const back0 = 4.8;
  const depth = 6 + hash(bld.x, bld.z, 22) * 3;
  const stone = hash(bld.x, bld.z, 23) < 0.35;
  // Corners in (along-street, toward-back) → grid (u, v).
  const P = (a: number, k: number): [number, number] => (alongU ? [u + dir * k, v + a] : [u + a, v + dir * k]);
  const runs: [number, number, number, number][] = [[-halfW, back0, -halfW, back0 + depth], [-halfW, back0 + depth, halfW, back0 + depth]];
  for (const [a0, k0, a1, k1] of runs) {
    const [u0, v0] = P(a0, k0);
    const [u1, v1] = P(a1, k1);
    const mu = (u0 + u1) / 2;
    const mv = (v0 + v1) / 2;
    if (blocked(mu, mv, 0.4) || blocked(u1, v1, 0.2)) continue;
    const near = Math.min(...lines.map((l) => Math.abs(mu - l)), ...lines.map((l) => Math.abs(mv - l)));
    if (near < 6.5) continue;
    fenceRun(f, u0, v0, u1, v1, gy, stone);
  }
}

/** Low wall around the church, a gate on the tower side, headstones and two yews. */
function churchYard(b: GeoBuilder, t: Terrain, g: TownGrid, bld: Building, ground: Ground3, lines: readonly number[], ca: number, sa: number): void {
  const f = buildingFrame(b, bld);
  const hw = bld.w / 2 + 5;
  const hd = bld.d / 2 + 5;
  const others = g.buildings.filter((o) => o !== bld);
  const streetD = (x: number, z: number): number => {
    const dx = x - g.x;
    const dz = z - g.z;
    const u = dx * ca + dz * sa;
    const v = -dx * sa + dz * ca;
    return Math.min(...lines.map((l) => Math.min(Math.abs(u - l), Math.abs(v - l))));
  };
  const ok = (lx: number, lz: number): boolean => {
    const p = f.point(lx, 0, lz);
    return !inBuilding(others, p.x, p.z, 0.6) && streetD(p.x, p.z) > 6.4 && t.groundAt(p.x, p.z) !== Ground.Road;
  };
  const yAt = (lx: number, lz: number): number => {
    const p = f.point(lx, 0, lz);
    return ground(p.x, p.z);
  };
  const corners: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]];
  for (let s = 0; s < 4; s++) {
    const [x0, z0] = corners[s];
    const [x1, z1] = corners[s + 1];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 3));
    for (let i = 0; i < n; i++) {
      const ax = x0 + ((x1 - x0) * i) / n;
      const az = z0 + ((z1 - z0) * i) / n;
      const bx = x0 + ((x1 - x0) * (i + 1)) / n;
      const bz = z0 + ((z1 - z0) * (i + 1)) / n;
      // Gate in the middle of the tower (−x) side.
      if (s === 3 && Math.abs((az + bz) / 2) < 2) continue;
      if (!ok((ax + bx) / 2, (az + bz) / 2)) continue;
      fenceRun(f, ax, az, bx, bz, yAt, true);
    }
  }
  for (let i = 0; i < 12; i++) {
    const lx = -bld.w * 0.3 + (i % 6) * (bld.w * 0.12);
    const lz = (i < 6 ? 1 : -1) * (bld.d / 2 + 2.2 + (hash(bld.x, i, 5) - 0.5) * 0.8);
    if (!ok(lx, lz)) continue;
    f.box(0.55, 0.85 + hash(bld.x, i, 6) * 0.3, 0.16, lx, yAt(lx, lz) + 0.4, lz, C.stone);
  }
  for (const [lx, lz] of [[bld.w / 2 + 2.5, hd - 2], [bld.w / 2 + 2.5, -hd + 2]]) {
    if (!ok(lx, lz)) continue;
    const y = yAt(lx, lz);
    f.cyl(0.25, 0.3, 1.4, 5, lx, y + 0.7, lz, C.woodDark);
    f.cone(1.5, 4.2, 7, lx, y + 3.3, lz, C.yew);
  }
}

/** Crate stacks, barrels and a rail spur along the factory's long side. */
function factoryYard(b: GeoBuilder, g: TownGrid, bld: Building, ground: Ground3): void {
  const f = buildingFrame(b, bld);
  const others = g.buildings.filter((o) => o !== bld);
  const free = (lx: number, lz: number, pad: number): boolean => {
    const p = f.point(lx, 0, lz);
    return !inBuilding(others, p.x, p.z, pad);
  };
  const yAt = (lx: number, lz: number): number => {
    const p = f.point(lx, 0, lz);
    return ground(p.x, p.z);
  };
  for (const side of [-1, 1]) {
    const lz = side * (bld.d / 2 + 3.2);
    // Rail spur: two rails on sleepers along the whole side, when the strip is clear.
    let clear = true;
    for (let x = -bld.w / 2; x <= bld.w / 2 && clear; x += 3) clear = free(x, lz, 1.2);
    if (clear) {
      const y = yAt(0, lz);
      for (const r of [-0.72, 0.72]) f.box(bld.w + 4, 0.14, 0.1, 0, y + 0.27, lz + r, C.rail);
      for (let x = -bld.w / 2 - 2; x <= bld.w / 2 + 2; x += 1.1) f.box(0.3, 0.14, 2.2, x, yAt(x, lz) + 0.12, lz, C.sleeper);
      // A goods wagon standing on the spur.
      const wx = bld.w * 0.15;
      f.box(6.5, 2.4, 2.4, wx, y + 2.0, lz, C.woodDark);
      f.box(6.7, 0.25, 2.6, wx, y + 3.3, lz, C.rail);
      for (const x of [-2.2, 2.2]) for (const r of [-0.72, 0.72]) f.cyl(0.45, 0.45, 0.12, 8, wx + x, y + 0.75, lz + r, C.rail, Math.PI / 2);
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const lx = -bld.w * 0.3 + k * bld.w * 0.3;
      if (!free(lx, lz, 1)) continue;
      const y = yAt(lx, lz);
      const n = 1 + Math.floor(hash(bld.x + k, bld.z, 8) * 3);
      for (let i = 0; i < n; i++) f.box(1.2, 1.2, 1.2, lx + (i % 2) * 1.3, y + 0.6 + Math.floor(i / 2) * 1.2, (i % 2) * 0.2, C.crate, 0, hash(k, i, 2) * 0.3);
      for (let i = 0; i < 3; i++) f.cyl(0.45, 0.45, 1.1, 8, lx - 1.6 + i * 0.95, y + 0.55, 1.4, C.barrel);
    }
  }
}

/** Village: a well on the green, fenced gardens, hay ricks and a cart by each barn. */
function village(tiles: Tiles, t: Terrain, town: { x: number; z: number; r: number }, bs: readonly Building[], ground: Ground3): void {
  const b = tiles.at(town.x, town.z);
  if (!inBuilding(bs, town.x, town.z, 3) && t.groundAt(town.x, town.z) !== Ground.Road) {
    const f = frameAt(b, town.x, town.z, 0);
    const y = ground(town.x, town.z);
    f.cyl(1.3, 1.4, 0.9, 10, 0, y + 0.45, 0, C.stone);
    f.cyl(1.0, 1.0, 0.1, 10, 0, y + 0.86, 0, C.water);
    f.box(0.14, 2.3, 0.14, 0, y + 1.15, 1.1, C.wood);
    f.box(1.6, 0.12, 0.12, 0.6, y + 2.3, 1.1, C.wood, 0, 0, -0.35);
  }
  for (const bld of bs) {
    const f = buildingFrame(b, bld);
    const yAt = (lx: number, lz: number): number => {
      const p = f.point(lx, 0, lz);
      return ground(p.x, p.z);
    };
    const free = (lx: number, lz: number): boolean => {
      const p = f.point(lx, 0, lz);
      return !inBuilding(bs.filter((o) => o !== bld), p.x, p.z, 0.5) && t.groundAt(p.x, p.z) !== Ground.Road && t.groundAt(p.x, p.z) !== Ground.Water;
    };
    if (bld.kind === 'barn') {
      const lx = bld.w / 2 + 3;
      if (free(lx, 0)) {
        const y = yAt(lx, 0);
        f.cyl(1.5, 1.7, 2.2, 8, lx, y + 1.1, 0, C.hay);
        f.cone(1.75, 1.4, 8, lx, y + 2.9, 0, C.hay);
      }
      if (free(0, bld.d / 2 + 3)) cart(frameAt(b, f.point(0, 0, bld.d / 2 + 3).x, f.point(0, 0, bld.d / 2 + 3).z, bld.rot + 0.3), yAt(0, bld.d / 2 + 3), hash(bld.x, bld.z, 4));
      // Big doors on the gable end.
      f.box(0.1, bld.h * 0.45, bld.d * 0.4, bld.w / 2 + 0.03, yAt(bld.w / 2, 0) - 0.5 + bld.h * 0.225, 0, C.woodDark);
      continue;
    }
    if (hash(bld.x, bld.z, 31) < 0.4) continue;
    // Garden on the side away from the village centre.
    const away = f.point(0, 0, 1);
    const sgn = (away.x - bld.x) * (bld.x - town.x) + (away.z - bld.z) * (bld.z - town.z) > 0 ? 1 : -1;
    const hw = bld.w / 2 + 0.6;
    const z0 = sgn * (bld.d / 2 + 0.3);
    const z1 = sgn * (bld.d / 2 + 6 + hash(bld.x, bld.z, 32) * 3);
    const stone = hash(bld.x, bld.z, 33) < 0.3;
    for (const [ax, az, bx, bz] of [[-hw, z0, -hw, z1], [-hw, z1, hw, z1], [hw, z1, hw, z0]] as const) {
      if (!free((ax + bx) / 2, (az + bz) / 2) || !free(bx, bz)) continue;
      fenceRun(f, ax, az, bx, bz, yAt, stone);
    }
  }
}

/** Telegraph poles along the country roads (not in towns, water or on bridges). */
function telegraph(tiles: Tiles, t: Terrain, ground: Ground3): void {
  const towns = t.def.towns;
  for (const road of t.def.roads) {
    let carry = 0;
    for (let s = 0; s < road.length - 1; s++) {
      const a = road[s];
      const c = road[s + 1];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      if (len < 1) continue;
      const dx = (c.x - a.x) / len;
      const dz = (c.z - a.z) / len;
      for (let d = carry; d < len; d += 48) {
        carry = d + 48 - len;
        const x = a.x + dx * d - dz * 7;
        const z = a.z + dz * d + dx * 7;
        if (!t.inBounds(x, z) || towns.some((tw) => Math.hypot(tw.x - x, tw.z - z) < tw.r + 15)) continue;
        const gr = t.groundAt(x, z);
        if (gr === Ground.Water || gr === Ground.Ford || gr === Ground.Road || t.buildingH(x, z) > 0) continue;
        // Local +x along the road: the cross-arm (local z) stands across it.
        const f = frameAt(tiles.at(x, z), x, z, yawTo(dx, dz));
        const y = ground(x, z);
        f.cyl(0.13, 0.17, 7.6, 5, 0, y + 3.8, 0, C.pole);
        f.box(0.14, 0.14, 1.8, 0, y + 7.0, 0, C.pole);
        for (const zz of [-0.75, -0.25, 0.25, 0.75]) f.cyl(0.06, 0.06, 0.22, 4, 0, y + 7.2, zz, C.insulator);
      }
    }
  }
}

/** Tile key shared with the settlements' landmark meshes (900 m tiles). */
export function tileKey(x: number, z: number): string {
  return `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
}

/**
 * Town and roadside detail per 900 m tile. Settlements fold each tile's builder into its
 * landmark mesh (a second, detailed variant of that mesh), so detail costs no extra draw call.
 */
export function buildTownProps(t: Terrain, grids: readonly TownGrid[], ground: Ground3): Map<string, GeoBuilder> {
  const tiles = new Tiles();
  for (const g of grids) gridTown(tiles, t, g, ground);
  for (const town of t.def.towns) {
    const kind = town.kind ?? (town.buildings > 40 ? 'town' : 'village');
    if (kind !== 'village') continue;
    const bs = t.buildings.filter((b) => Math.hypot(b.x - town.x, b.z - town.z) < town.r + 12);
    village(tiles, t, town, bs, ground);
  }
  telegraph(tiles, t, ground);
  return tiles.map;
}
