import * as THREE from 'three';
import { Ground, type Terrain } from '../sim/terrain';
import { GeoBuilder, tintedMaterial, trs } from './instancing';
import { PAL } from './palette';

const TILE = 800; // bigger tiles: fewer draw calls at the overview zoom (GPU is not the limit)
const ZERO = new THREE.Color(0, 0, 0);

function coniferGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.3, 0.42, 3.2, 5, 1, true), trs(0, 1.6, 0), PAL.trunk);
  b.add(new THREE.ConeGeometry(2.7, 5.4, 7, 1, true), trs(0, 5.2, 0), ZERO, 0.85);
  b.add(new THREE.ConeGeometry(2.0, 4.4, 7, 1, true), trs(0, 7.9, 0), ZERO, 1);
  return b.build();
}

function broadleafGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.CylinderGeometry(0.32, 0.46, 3.6, 5, 1, true), trs(0, 1.8, 0), PAL.trunk);
  b.add(new THREE.IcosahedronGeometry(3, 0), trs(0, 6.3, 0, 0.3, 0.5, 0, 1, 0.9, 1), ZERO, 1);
  b.add(new THREE.IcosahedronGeometry(1.9, 0), trs(1.2, 7.6, 0.6, 0.7, 0, 0.2), ZERO, 1.08);
  return b.build();
}

/** Deterministic hash → [0,1). */
function hash(x: number, z: number, s: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233 + s * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

interface TreeInst {
  x: number;
  z: number;
  s: number;
  rot: number;
  conifer: boolean;
}

/**
 * Forests: the sim's trees plus visual-only infill so woods read as dense masses (LOS is
 * unaffected — it uses the ground grid). Instanced per spatial tile so culling works.
 */
export function buildForests(t: Terrain): THREE.Group {
  const g = new THREE.Group();
  const list: TreeInst[] = [];
  t.trees.forEach((tr, k) => list.push({ x: tr.x, z: tr.z, s: tr.s, rot: (k * 1.7) % 6.28, conifer: k % 2 === 0 }));
  // Infill on a jittered 8 m lattice inside forest cells, thinner near edges.
  const step = 8;
  for (let z = step / 2; z < t.depth; z += step) {
    for (let x = step / 2; x < t.width; x += step) {
      const jx = x + (hash(x, z, 1) - 0.5) * step * 0.9;
      const jz = z + (hash(x, z, 2) - 0.5) * step * 0.9;
      if (t.groundAt(jx, jz) !== Ground.Forest) continue;
      let edge = 0;
      for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10]]) if (t.groundAt(jx + dx, jz + dz) !== Ground.Forest) edge++;
      if (hash(x, z, 3) < 0.3 + edge * 0.15) continue;
      const highland = t.heightAt(jx, jz) / Math.max(45, t.maxHeight);
      list.push({ x: jx, z: jz, s: 0.8 + hash(x, z, 4) * 0.55, rot: hash(x, z, 5) * 6.28, conifer: hash(x, z, 6) < 0.35 + highland * 0.5 });
    }
  }
  const tiles = new Map<string, TreeInst[]>();
  for (const tr of list) {
    const key = `${Math.floor(tr.x / TILE)},${Math.floor(tr.z / TILE)}`;
    let a = tiles.get(key);
    if (!a) tiles.set(key, (a = []));
    a.push(tr);
  }
  const mat = tintedMaterial(1, 0);
  mat.flatShading = true;
  const geos = { conifer: coniferGeo(), broad: broadleafGeo() };
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (const trees of tiles.values()) {
    for (const conifer of [true, false]) {
      const sub = trees.filter((tr) => tr.conifer === conifer);
      if (sub.length === 0) continue;
      const im = new THREE.InstancedMesh(conifer ? geos.conifer : geos.broad, mat, sub.length);
      sub.forEach((tr, k) => {
        trs(tr.x, t.heightAt(tr.x, tr.z) - 0.3, tr.z, 0, tr.rot, 0, tr.s, tr.s * (0.9 + hash(tr.x, tr.z, 7) * 0.25), tr.s, m);
        im.setMatrixAt(k, m);
        const v = hash(tr.x, tr.z, 8);
        c.copy(conifer ? PAL.treeConifer : PAL.treeA).lerp(conifer ? PAL.treeA : PAL.treeB, v).multiplyScalar(0.9 + hash(tr.z, tr.x, 9) * 0.2);
        im.setColorAt(k, c);
      });
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    }
  }
  return g;
}
