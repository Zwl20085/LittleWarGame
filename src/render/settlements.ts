import * as THREE from 'three';
import type { Building, BuildingKind, Terrain } from '../sim/terrain';
import { GeoBuilder, trs } from './instancing';
import { PAL } from './palette';
import { buildingFrame, tileKey, type Frame } from './townProps';

const BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * Unit gable roof with eaves and a ridge cap: ridge along x, spans z in [-.5, .5], height 1.
 * Vertex colours: tiles 1, ridge cap darker (multiplied by the instance colour).
 */
function gableRoofGeo(): THREE.BufferGeometry {
  const v = [
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0,
    0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0,
    -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0,
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,
  ];
  const idx = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 11, 13, 12];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const b = new GeoBuilder();
  b.add(g, new THREE.Matrix4(), new THREE.Color(1, 1, 1));
  // Ridge cap and the gable-end barge boards (thin, slightly proud of the roof planes).
  b.add(BOX, trs(0, 0.985, 0, 0, 0, 0, 1.02, 0.06, 0.07), new THREE.Color(0.62, 0.6, 0.58));
  return b.build();
}

/**
 * Wall material with storey/window bands computed from instance-scaled object coordinates,
 * so windows keep a real size on any footprint or height (2.1: reveals, sills, two-tone glass,
 * a darker plinth and a door in the middle bay of each long face). `factory` = tall
 * industrial glazing with mullions on 4.5 m storeys, a loading door instead of a house door.
 */
function windowedWallMaterial(factory: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  const storey = factory ? 4.5 : 3.2;
  const bay = factory ? 3.6 : 2.8;
  const winLo = factory ? 0.22 : 0.38;
  const winHi = factory ? 0.86 : 0.78;
  const winW = factory ? 0.38 : 0.2;
  const doorW = factory ? 1.6 : 0.62;
  const doorH = factory ? 3.4 : 2.3;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMet;\nvarying vec3 vSc;\nvarying float vSide;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vSc = sc;
        vMet = (position + vec3(0.5, 0.0, 0.5)) * sc;
        vSide = abs(normal.y) > 0.5 ? 0.0 : (abs(normal.x) > 0.5 ? 1.0 : 2.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMet;\nvarying vec3 vSc;\nvarying float vSide;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vSide > 0.5) {
          float u = vSide < 1.5 ? vMet.z : vMet.x;
          float span = vSide < 1.5 ? vSc.z : vSc.x;
          // Rendered plinth (darker, a little warmer) along the ground.
          diffuseColor.rgb *= 1.0 - 0.16 * (1.0 - step(0.6, vMet.y));
          if (vMet.y > 1.2 && vMet.y < vSc.y - 0.5) {
            float fy = fract(vMet.y / ${storey.toFixed(2)});
            float fu = fract(u / ${bay.toFixed(2)});
            float lo = ${winLo.toFixed(2)}; float hi = ${winHi.toFixed(2)}; float hw = ${winW.toFixed(2)};
            float win = step(lo, fy) * step(fy, hi) * step(0.5 - hw, fu) * step(fu, 0.5 + hw);
            float reveal = step(lo - 0.035, fy) * step(fy, hi + 0.03) * step(0.46 - hw, fu) * step(fu, 0.54 + hw) - win;
            float sill = step(lo - 0.07, fy) * step(fy, lo - 0.035) * step(0.45 - hw, fu) * step(fu, 0.55 + hw);
            // Glass: dark, the upper part catching the sky; factory panes split by mullions.
            vec3 glass = mix(vec3(0.12, 0.13, 0.15), vec3(0.30, 0.34, 0.38), step(lo + (hi - lo) * 0.62, fy) * 0.7);
            ${factory ? 'float mu = abs(fract((fu - 0.5 + hw) / (2.0 * hw) * 3.0) - 0.5); float tr = fract((fy - lo) / (hi - lo) * 4.0); glass *= 1.0 - 0.5 * max(step(0.44, mu), step(0.9, tr));' : ''}
            diffuseColor.rgb *= 1.0 - 0.3 * reveal;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.83, 0.77), sill * 0.85);
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.92);
            // Cornice / string course at each storey line.
            diffuseColor.rgb *= 1.0 - 0.12 * step(0.95, fy);
          }
          // Door in the middle bay of each long face.
          if (vSide > 1.5) {
            float du = abs(u - span * 0.5);
            float door = step(du, ${(doorW / 2).toFixed(2)}) * step(vMet.y, ${doorH.toFixed(2)});
            float frame = step(du, ${(doorW / 2 + 0.12).toFixed(2)}) * step(vMet.y, ${(doorH + 0.14).toFixed(2)}) - door;
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.62, frame);
            diffuseColor.rgb = mix(diffuseColor.rgb, ${factory ? 'vec3(0.24, 0.27, 0.25)' : 'vec3(0.30, 0.20, 0.13)'}, door);
          }
          // Eaves shadow line under the roof.
          diffuseColor.rgb *= 1.0 - 0.22 * smoothstep(vSc.y - 0.5, vSc.y, vMet.y);
        }`);
  };
  m.customProgramCacheKey = () => (factory ? 'windowed-wall-f2' : 'windowed-wall-2');
  return m;
}

/** Roof tiles: courses along the slope from the instance-scaled height, faded before aliasing. */
function tiledRoofMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, side: THREE.DoubleSide, vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCourse;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCourse = position.y * length(instanceMatrix[1].xyz) / 0.42;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCourse;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float fw = fwidth(vCourse);
        float c = smoothstep(0.0, 0.25, fract(vCourse)) * (1.0 - smoothstep(0.6, 1.2, fw));
        diffuseColor.rgb *= 1.0 - 0.12 * (1.0 - c);`);
  };
  m.customProgramCacheKey = () => 'tiled-roof';
  return m;
}

/** Flat roof with a raised parapet rim (unit footprint, height 1 = parapet height). */
function flatRoofGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const roof = new THREE.Color(1, 1, 1);
  b.add(BOX, trs(0, 0.15, 0, 0, 0, 0, 1.02, 0.3, 1.02), roof);
  const t = 0.05;
  for (const s of [-1, 1]) {
    b.add(BOX, trs(0, 0.6, s * (0.5 - t / 2), 0, 0, 0, 1.02, 0.9, t), roof);
    b.add(BOX, trs(s * (0.5 - t / 2), 0.6, 0, 0, 0, 0, t, 0.9, 1.02), roof);
  }
  b.add(BOX, trs(0.2, 0.9, -0.15, 0, 0, 0, 0.18, 1.2, 0.18), roof);
  return b.build();
}

const ROOFS = ['#8a5a44', '#7a5238', '#9a6a3e', '#6e6a62', '#55524d', '#84503f'].map((h) => new THREE.Color(h));
const BARN_WALLS = ['#8a5a3c', '#7d6a55', '#94877a'].map((h) => new THREE.Color(h));
const BLOCK_WALLS = ['#cfc4ad', '#bdb29b', '#d6cdb9', '#b9a991', '#c9bba0'].map((h) => new THREE.Color(h));
const CHURCH_WALL = new THREE.Color('#ddd4bf');
const SPIRE = new THREE.Color('#5f8472');
const BRICK = new THREE.Color('#8a5a44');
const SOOT = new THREE.Color('#3a3631');
const SLATE = new THREE.Color('#5d5a55');
const GLASS = new THREE.Color('#3b4248');
const DARK = new THREE.Color('#26241f');
const STONE = new THREE.Color('#bdb4a0');
const GOLD = new THREE.Color('#b59a52');

type Part = 'wall' | 'factoryWall' | 'plainWall' | 'gable' | 'flat';

interface Item {
  readonly m: THREE.Matrix4;
  readonly c: THREE.Color;
}

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

function h01(b: Building, s: number): number {
  const v = Math.sin(b.x * 12.9898 + b.z * 78.233 + s * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

/** House roof height above the eaves (m): shared by the roof part and the chimney. */
export function houseRoofHeight(b: Building): number {
  return Math.max(b.w, b.d) * (0.38 + h01(b, 3) * 0.14);
}

function compose(b: Building, y: number, lx: number, ly: number, lz: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  _q.setFromAxisAngle(_up, b.rot);
  const off = new THREE.Vector3(lx, 0, lz).applyQuaternion(_q);
  return new THREE.Matrix4().compose(new THREE.Vector3(b.x + off.x, y + ly, b.z + off.z), _q, new THREE.Vector3(sx, sy, sz));
}

/** Break one building into instanced parts by kind. */
function partsOf(b: Building, y: number, kind: BuildingKind, emit: (p: Part, it: Item) => void): void {
  const r = h01(b, 1);
  const roofC = ROOFS[Math.floor(h01(b, 2) * ROOFS.length)].clone().multiplyScalar(0.9 + r * 0.2);
  switch (kind) {
    case 'barn': {
      emit('plainWall', { m: compose(b, y, 0, 0, 0, b.w, b.h * 0.6, b.d), c: BARN_WALLS[Math.floor(r * BARN_WALLS.length)] });
      emit('gable', { m: compose(b, y, 0, b.h * 0.6, 0, b.w * 1.06, b.h * 0.5, b.d * 1.12), c: roofC });
      break;
    }
    case 'block': case 'tower': {
      const wall = BLOCK_WALLS[Math.floor(r * BLOCK_WALLS.length)].clone();
      if (kind === 'tower') wall.lerp(new THREE.Color('#a9a596'), 0.4);
      emit('wall', { m: compose(b, y, 0, 0, 0, b.w, b.h, b.d), c: wall });
      emit('flat', { m: compose(b, y, 0, b.h, 0, b.w, kind === 'tower' ? 1.4 : 1, b.d), c: PAL.roofB.clone().multiplyScalar(0.75 + r * 0.2) });
      if (kind === 'tower') {
        // Set-back crown storey for a readable skyline (its battlements are baked in the landmarks).
        emit('wall', { m: compose(b, y, 0, b.h, 0, b.w * 0.6, Math.min(8, b.h * 0.18), b.d * 0.6), c: wall });
      }
      break;
    }
    case 'church': {
      const nave = b.h * 0.62;
      emit('wall', { m: compose(b, y, b.w * 0.08, 0, 0, b.w * 0.84, nave, b.d), c: CHURCH_WALL.clone() });
      emit('gable', { m: compose(b, y, b.w * 0.08, nave, 0, b.w * 0.88, b.d * 0.55, b.d * 1.08), c: ROOFS[4] });
      break;
    }
    case 'factory': {
      emit('factoryWall', { m: compose(b, y, 0, 0, 0, b.w, b.h, b.d), c: new THREE.Color('#9c8f7c').multiplyScalar(0.9 + r * 0.15) });
      break;
    }
    default: {
      emit('wall', { m: compose(b, y, 0, 0, 0, b.w, b.h, b.d), c: PAL.wall.clone().lerp(PAL.wallB, r) });
      emit('gable', { m: compose(b, y, 0, b.h, 0, b.w * 1.08, houseRoofHeight(b), b.d * 1.15), c: roofC });
    }
  }
}

/** Church steeple in the building frame: tower, belfry with louvres and clock, spire, cross. */
function steeple(k: Frame, b: Building, y: number): void {
  const h = b.h;
  const x = -b.w * 0.42;
  const s = h * 0.42;
  k.box(s, h * 1.5, s, x, y + h * 0.75, 0, CHURCH_WALL);
  // Corner buttresses and a plinth.
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.box(s * 0.14, h * 0.7, s * 0.14, x + dx * s * 0.5, y + h * 0.35, dz * s * 0.5, STONE);
  k.box(s * 1.08, h * 0.08, s * 1.08, x, y + h * 0.04, 0, STONE);
  // Belfry ledge, louvred openings and clock faces on all four sides.
  k.box(s * 1.14, h * 0.06, s * 1.14, x, y + h * 1.52, 0, STONE);
  k.box(s * 1.08, h * 0.04, s * 1.08, x, y + h * 1.12, 0, STONE);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ox = x + dx * s * 0.505;
    const oz = dz * s * 0.505;
    const along = dx !== 0 ? [0.02, s * 0.36] : [s * 0.36, 0.02];
    k.box(along[0], h * 0.2, along[1], ox, y + h * 1.36, oz, DARK);
    k.cyl(s * 0.16, s * 0.16, 0.06, 12, ox + dx * 0.02, y + h * 1.0, oz + dz * 0.02, new THREE.Color('#ece6d6'), dz !== 0 ? Math.PI / 2 : 0, 0, dx !== 0 ? Math.PI / 2 : 0);
    k.box(dx !== 0 ? 0.08 : s * 0.12, s * 0.12, dz !== 0 ? 0.08 : s * 0.12, ox + dx * 0.05, y + h * 1.0, oz + dz * 0.05, DARK);
  }
  k.cone(s * 0.79, h * 1.0, 4, x, y + h * 2.05, 0, SPIRE, Math.PI / 4);
  k.box(0.18, h * 0.22, 0.18, x, y + h * 2.62, 0, GOLD);
  k.box(0.18, 0.18, h * 0.12, x, y + h * 2.66, 0, GOLD);
}

/** Factory: sawtooth north-light roof (glazed faces), a tall brick chimney, roof vents. */
function factoryTop(k: Frame, b: Building, y: number): void {
  const teeth = Math.max(3, Math.round(b.w / 7));
  const tw = b.w / teeth;
  const th = Math.min(b.d, b.w) * 0.2;
  for (let i = 0; i < teeth; i++) {
    const x0 = -b.w / 2 + i * tw;
    // Sloped back (rises toward +x) and the vertical glazing on its high side.
    k.slope(x0, x0 + tw, b.d * 1.02, y + b.h, th, SLATE);
    k.box(0.12, th, b.d * 0.96, x0 + tw - 0.06, y + b.h + th / 2, 0, GLASS);
  }
  const cx = b.w * 0.38;
  const cz = b.d * 0.3;
  k.cyl(0.9, 1.25, b.h * 2.6, 10, cx, y + b.h * 1.3, cz, BRICK);
  k.cyl(1.05, 1.05, 0.5, 10, cx, y + b.h * 2.55, cz, SOOT);
  k.box(1.6, 1.0, 1.6, -b.w * 0.2, y + b.h + th + 0.4, -b.d * 0.2, SLATE);
}

/** Tower: crenellated parapet around the set-back crown storey, a water tank on the roof. */
function towerTop(k: Frame, b: Building, y: number): void {
  const top = y + b.h + Math.min(8, b.h * 0.18);
  const w = b.w * 0.6;
  const d = b.d * 0.6;
  k.box(w * 1.04, 0.35, d * 1.04, 0, top + 0.17, 0, STONE);
  for (const [len, across, alongX] of [[w, d, true], [d, w, false]] as const) {
    const n = Math.max(3, Math.round(len / 1.6));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (len * (i + 0.5)) / n;
      for (const s of [-1, 1]) {
        if (alongX) k.box(len / n * 0.55, 0.9, 0.3, t, top + 0.8, s * across / 2, STONE);
        else k.box(0.3, 0.9, len / n * 0.55, s * across / 2, top + 0.8, t, STONE);
      }
    }
  }
  k.cyl(1.0, 1.0, 1.8, 8, w * 0.15, top + 1.25, -d * 0.1, new THREE.Color('#6f6a60'));
}

/** House / block chimney stack on the roof slope, with a pot. */
function houseChimney(k: Frame, b: Building, y: number): void {
  const rh = houseRoofHeight(b);
  const side = h01(b, 5) < 0.5 ? -1 : 1;
  const cx = side * b.w * 0.28;
  const cz = b.d * 0.16 * (h01(b, 6) < 0.5 ? -1 : 1);
  const halfSpan = (b.d * 1.15) / 2;
  const surf = y + b.h + rh * (1 - Math.abs(cz) / halfSpan);
  const top = y + b.h + rh + 0.9;
  const base = surf - 0.4;
  k.box(0.75, top - base, 0.6, cx, (top + base) / 2, cz, BRICK.clone().multiplyScalar(0.85 + h01(b, 7) * 0.3));
  k.box(0.9, 0.16, 0.75, cx, top, cz, SOOT);
}

/**
 * Settlements from the sim's building list: instanced per part (walls with window bands and
 * doors, tiled gable roofs, flat roofs with parapets), plus one baked "landmark" mesh per tile
 * for one-off shapes (steeples, factory sawtooth roofs and chimneys, tower battlements, house
 * chimneys), grouped in spatial tiles for culling. Returns the group and the factory chimney
 * tops (for smoke).
 */
export interface Settlements {
  readonly group: THREE.Group;
  /** Factory chimney tops (world), for the faint smoke. */
  readonly chimneys: THREE.Vector3[];
  /** Show the detailed landmark variants (with the town props) instead of the plain ones. */
  setDetail(on: boolean): void;
}

export function buildSettlements(t: Terrain, props: ReadonlyMap<string, GeoBuilder> = new Map()): Settlements {
  const g = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const geos: Record<Part, THREE.BufferGeometry> = {
    wall: box, factoryWall: box, plainWall: box, gable: gableRoofGeo(), flat: flatRoofGeo(),
  };
  const mats: Record<Part, THREE.Material> = {
    wall: windowedWallMaterial(false),
    factoryWall: windowedWallMaterial(true),
    plainWall: new THREE.MeshStandardMaterial({ roughness: 0.97 }),
    gable: tiledRoofMaterial(),
    flat: new THREE.MeshStandardMaterial({ roughness: 0.93, vertexColors: true, flatShading: true }),
  };
  const landmarkMat = new THREE.MeshStandardMaterial({ roughness: 0.92, vertexColors: true, flatShading: true });
  const tiles = new Map<string, { parts: Map<Part, Item[]>; marks: GeoBuilder }>();
  const chimneys: THREE.Vector3[] = [];
  for (const b of t.buildings) {
    const key = tileKey(b.x, b.z);
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, (tile = { parts: new Map(), marks: new GeoBuilder() }));
    const y = t.heightAt(b.x, b.z) - 0.5;
    const kind = b.kind ?? 'house';
    partsOf(b, y, kind, (p, it) => {
      let list = tile!.parts.get(p);
      if (!list) tile!.parts.set(p, (list = []));
      list.push(it);
    });
    const k = buildingFrame(tile.marks, b);
    if (kind === 'church') steeple(k, b, y);
    else if (kind === 'factory') {
      factoryTop(k, b, y);
      chimneys.push(k.point(b.w * 0.38, y + b.h * 2.85, b.d * 0.3));
    } else if (kind === 'tower') towerTop(k, b, y);
    else if (kind === 'house' && h01(b, 4) < 0.85) houseChimney(k, b, y);
  }
  for (const tile of tiles.values()) {
    for (const [part, items] of tile.parts) {
      const im = new THREE.InstancedMesh(geos[part], mats[part], items.length);
      items.forEach((it, k) => {
        im.setMatrixAt(k, it.m);
        im.setColorAt(k, it.c);
      });
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    }
  }
  // Landmarks per tile in two variants: plain, and plain + town props (one visible at a time).
  const plain: THREE.Mesh[] = [];
  const full: THREE.Mesh[] = [];
  const keys = new Set([...tiles.keys(), ...props.keys()]);
  const mesh = (b: GeoBuilder, out: THREE.Mesh[]): void => {
    const m = new THREE.Mesh(b.build(), landmarkMat);
    m.castShadow = true;
    m.receiveShadow = true;
    out.push(m);
    g.add(m);
  };
  for (const key of keys) {
    const marks = tiles.get(key)?.marks;
    const extra = props.get(key);
    if (marks && !marks.empty) mesh(marks, plain);
    if (extra && !extra.empty) mesh(new GeoBuilder().append(marks ?? new GeoBuilder()).append(extra), full);
    else if (marks && !marks.empty) full.push(plain[plain.length - 1]);
  }
  let detail: boolean | null = null;
  const setDetail = (on: boolean): void => {
    if (on === detail) return;
    detail = on;
    for (const m of plain) m.visible = false;
    for (const m of full) m.visible = false;
    for (const m of on ? full : plain) m.visible = true;
  };
  setDetail(false);
  return { group: g, chimneys, setDetail };
}
