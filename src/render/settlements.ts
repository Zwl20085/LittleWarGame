import * as THREE from 'three';
import type { Building, BuildingKind, Terrain } from '../sim/terrain';
import { GeoBuilder, trs } from './instancing';
import { PAL } from './palette';

const TILE = 600;

/** Unit gable roof: ridge along x, spans z in [-.5,.5], height 1. */
export function gableRoof(): THREE.BufferGeometry {
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
  return g;
}

/**
 * Wall material with storey/window bands computed from instance-scaled object coordinates,
 * so windows keep a real size (≈3.2 m storeys) on any building footprint or height.
 */
function windowedWallMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMet;\nvarying float vSide;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vMet = (position + vec3(0.5, 0.0, 0.5)) * sc;
        vSide = abs(normal.y) > 0.5 ? 0.0 : (abs(normal.x) > 0.5 ? 1.0 : 2.0);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMet;\nvarying float vSide;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vSide > 0.5 && vMet.y > 1.2) {
          float u = vSide < 1.5 ? vMet.z : vMet.x;
          float fy = fract(vMet.y / 3.2);
          float fu = fract(u / 2.8);
          float win = step(0.38, fy) * step(fy, 0.78) * step(0.3, fu) * step(fu, 0.7);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.17, 0.18), win * 0.75);
          // Cornice line at the top storey band.
          diffuseColor.rgb *= 1.0 - 0.12 * step(0.94, fy);
        }`);
  };
  m.customProgramCacheKey = () => 'windowed-wall';
  return m;
}

/** Flat roof with a raised parapet rim (unit footprint, height 1 = parapet height). */
function flatRoofGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const roof = new THREE.Color(1, 1, 1);
  b.add(box, trs(0, 0.15, 0, 0, 0, 0, 1.02, 0.3, 1.02), roof);
  const t = 0.05;
  for (const s of [-1, 1]) {
    b.add(box, trs(0, 0.6, s * (0.5 - t / 2), 0, 0, 0, 1.02, 0.9, t), roof);
    b.add(box, trs(s * (0.5 - t / 2), 0.6, 0, 0, 0, 0, t, 0.9, 1.02), roof);
  }
  b.add(box, trs(0.2, 0.9, -0.15, 0, 0, 0, 0.18, 1.2, 0.18), roof);
  return b.build();
}

/** Church steeple: square tower, belfry ledge and spire (unit = church height). */
function steepleGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const wall = new THREE.Color('#ddd4bf');
  b.add(box, trs(0, 0.75, 0, 0, 0, 0, 0.42, 1.5, 0.42), wall);
  b.add(box, trs(0, 1.52, 0, 0, 0, 0, 0.48, 0.06, 0.48), new THREE.Color('#c4b9a0'));
  b.add(new THREE.ConeGeometry(0.33, 1, 4).rotateY(Math.PI / 4), trs(0, 2.05, 0, 0, 0, 0, 1, 1.0, 1), new THREE.Color('#5f8472'));
  return b.build();
}

function chimneyGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.35, 0.5, 1, 8, 1, true), trs(0, 0.5, 0), new THREE.Color('#8a5a44'));
  b.add(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 8), trs(0, 0.98, 0), new THREE.Color('#3a3631'));
  return b.build();
}

const ROOFS = ['#8a5a44', '#7a5238', '#9a6a3e', '#6e6a62', '#55524d', '#84503f'].map((h) => new THREE.Color(h));
const BARN_WALLS = ['#8a5a3c', '#7d6a55', '#94877a'].map((h) => new THREE.Color(h));
const BLOCK_WALLS = ['#cfc4ad', '#bdb29b', '#d6cdb9', '#b9a991', '#c9bba0'].map((h) => new THREE.Color(h));

type Part = 'wall' | 'plainWall' | 'gable' | 'flat' | 'steeple' | 'chimney';

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
        // Set-back crown storey for a readable skyline.
        emit('wall', { m: compose(b, y, 0, b.h, 0, b.w * 0.6, Math.min(8, b.h * 0.18), b.d * 0.6), c: wall });
      }
      break;
    }
    case 'church': {
      const nave = b.h * 0.62;
      emit('wall', { m: compose(b, y, b.w * 0.08, 0, 0, b.w * 0.84, nave, b.d), c: new THREE.Color('#ddd4bf') });
      emit('gable', { m: compose(b, y, b.w * 0.08, nave, 0, b.w * 0.88, b.d * 0.55, b.d * 1.08), c: ROOFS[4] });
      emit('steeple', { m: compose(b, y, -b.w * 0.42, 0, 0, b.h, b.h, b.h), c: new THREE.Color(1, 1, 1) });
      break;
    }
    case 'factory': {
      emit('plainWall', { m: compose(b, y, 0, 0, 0, b.w, b.h, b.d), c: new THREE.Color('#9c8f7c').multiplyScalar(0.9 + r * 0.15) });
      emit('gable', { m: compose(b, y, 0, b.h, 0, b.w * 1.02, Math.min(b.w, b.d) * 0.22, b.d * 1.04), c: ROOFS[3] });
      emit('chimney', { m: compose(b, y, b.w * 0.38, 0, b.d * 0.3, 2.2, b.h * 2.6, 2.2), c: new THREE.Color(1, 1, 1) });
      break;
    }
    default: {
      emit('wall', { m: compose(b, y, 0, 0, 0, b.w, b.h, b.d), c: PAL.wall.clone().lerp(PAL.wallB, r) });
      emit('gable', { m: compose(b, y, 0, b.h, 0, b.w * 1.08, Math.max(b.w, b.d) * (0.38 + h01(b, 3) * 0.14), b.d * 1.15), c: roofC });
    }
  }
}

/**
 * Settlements from the sim's building list: instanced per part (walls with window bands,
 * gable roofs in varied colours, flat roofs with parapets, church steeples, factory chimneys),
 * grouped in spatial tiles for culling. City blocks and towers form readable skylines.
 */
export function buildSettlements(t: Terrain): THREE.Group {
  const g = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const geos: Record<Part, THREE.BufferGeometry> = {
    wall: box, plainWall: box, gable: gableRoof(), flat: flatRoofGeo(), steeple: steepleGeo(), chimney: chimneyGeo(),
  };
  const vc = new THREE.MeshStandardMaterial({ roughness: 0.93, vertexColors: true, flatShading: true });
  const mats: Record<Part, THREE.Material> = {
    wall: windowedWallMaterial(),
    plainWall: new THREE.MeshStandardMaterial({ roughness: 0.97 }),
    gable: new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, side: THREE.DoubleSide }),
    flat: vc,
    steeple: vc,
    chimney: vc,
  };
  const tiles = new Map<string, Map<Part, Item[]>>();
  for (const b of t.buildings) {
    const key = `${Math.floor(b.x / TILE)},${Math.floor(b.z / TILE)}`;
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, (tile = new Map()));
    const y = t.heightAt(b.x, b.z) - 0.5;
    partsOf(b, y, b.kind ?? 'house', (p, it) => {
      let list = tile!.get(p);
      if (!list) tile!.set(p, (list = []));
      list.push(it);
    });
  }
  for (const tile of tiles.values()) {
    for (const [part, items] of tile) {
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
  return g;
}
