import * as THREE from 'three';
import { Ground, type Terrain } from '../sim/terrain';
import { trs } from './instancing';
import { PAL } from './palette';

/** Spatial tile for culling (m). */
const TILE = 800;

/** Deterministic hash → [0,1). */
function hash(x: number, z: number, s: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233 + s * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

interface Inst {
  readonly x: number;
  readonly z: number;
  readonly m: THREE.Matrix4;
  readonly c: THREE.Color;
}

const ROCK = new THREE.IcosahedronGeometry(1, 0).scale(1, 0.6, 0.85);
const SHRUB = new THREE.IcosahedronGeometry(1, 0).scale(1, 0.72, 1);
const SHRUB_COL = new THREE.Color('#58663a');
const SHRUB_COL_B = new THREE.Color('#6c7442');

function slopeDeg(t: Terrain, x: number, z: number): number {
  const e = 2;
  const dx = (t.heightAt(x + e, z) - t.heightAt(x - e, z)) / (2 * e);
  const dz = (t.heightAt(x, z + e) - t.heightAt(x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
}

/**
 * Visual-only ground clutter (no effect on movement or LOS): weathered rocks scattered on steep
 * slopes and crests, and shrubs fringing forest edges so woods fade into the fields instead of
 * stopping at a hard line. Static instanced meshes, tiled for frustum culling.
 */
export function buildScatter(t: Terrain): THREE.Group {
  const rocks: Inst[] = [];
  const shrubs: Inst[] = [];
  const step = 6;
  for (let z = step / 2; z < t.depth; z += step) {
    for (let x = step / 2; x < t.width; x += step) {
      const jx = x + (hash(x, z, 11) - 0.5) * step;
      const jz = z + (hash(x, z, 12) - 0.5) * step;
      const g = t.groundAt(jx, jz);
      if (g === Ground.Water || g === Ground.Ford || g === Ground.Road || g === Ground.Town) continue;
      const y = t.heightAt(jx, jz);
      if (g !== Ground.Forest) {
        const sl = slopeDeg(t, jx, jz);
        const p = Math.min(0.35, Math.max(0, (sl - 12) / 16) * 0.35 + Math.max(0, y / Math.max(45, t.maxHeight) - 0.8) * 0.6);
        // Clustered: some 40 m patches are scree, others nearly bare.
        const cluster = hash(Math.floor(jx / 40), Math.floor(jz / 40), 30);
        if (hash(x, z, 13) < p * (0.25 + 1.3 * cluster * cluster)) {
          const s = 0.5 + hash(x, z, 14) ** 2 * 1.8;
          const v = 0.82 + hash(x, z, 15) * 0.3;
          rocks.push({ x: jx, z: jz, m: trs(jx, y - s * 0.22, jz, hash(x, z, 16) * 0.5, hash(x, z, 17) * 6.28, hash(x, z, 18) * 0.4, s), c: PAL.rock.clone().multiplyScalar(v) });
        }
        // Shrubs on the open side of forest edges.
        if (g === Ground.Open && hash(x, z, 19) < 0.32) {
          let near = false;
          for (const [dx, dz] of [[7, 0], [-7, 0], [0, 7], [0, -7]]) if (t.groundAt(jx + dx, jz + dz) === Ground.Forest) near = true;
          if (near) {
            const s = 0.9 + hash(x, z, 20) * 1.3;
            shrubs.push({ x: jx, z: jz, m: trs(jx, y + s * 0.35, jz, 0, hash(x, z, 21) * 6.28, 0, s * 1.3, s, s * 1.1), c: SHRUB_COL.clone().lerp(SHRUB_COL_B, hash(x, z, 22)) });
          }
        }
      }
    }
  }
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true });
  addTiled(g, rocks, ROCK, mat, false);
  addTiled(g, shrubs, SHRUB, mat, false);
  return g;
}

function addTiled(g: THREE.Group, list: readonly Inst[], geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean): void {
  const tiles = new Map<string, Inst[]>();
  for (const it of list) {
    const key = `${Math.floor(it.x / TILE)},${Math.floor(it.z / TILE)}`;
    let a = tiles.get(key);
    if (!a) tiles.set(key, (a = []));
    a.push(it);
  }
  for (const sub of tiles.values()) {
    const im = new THREE.InstancedMesh(geo, mat, sub.length);
    sub.forEach((it, k) => {
      im.setMatrixAt(k, it.m);
      im.setColorAt(k, it.c);
    });
    im.computeBoundingSphere();
    im.castShadow = cast;
    im.receiveShadow = true;
    g.add(im);
  }
}
