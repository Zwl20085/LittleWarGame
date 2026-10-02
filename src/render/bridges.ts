import * as THREE from 'three';
import type { Bridge, Terrain } from '../sim/terrain';
import { GeoBuilder, trs } from './instancing';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const COL = {
  stone: new THREE.Color('#b8ae98'),
  stoneDark: new THREE.Color('#968c78'),
  deck: new THREE.Color('#8f8676'),
  steel: new THREE.Color('#56614f'),
  steelDark: new THREE.Color('#414a3d'),
  concrete: new THREE.Color('#a8a292'),
};

function box(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, rz = 0): void {
  b.add(BOX, trs(x, y, z, 0, 0, rz, w, h, d), c);
}

/** Lowest ground (river bed) under the bridge span, relative to the deck. */
function bedBelow(t: Terrain, br: Bridge): number {
  let lo = Infinity;
  const ca = Math.cos(br.angle);
  const sa = Math.sin(br.angle);
  for (let s = -br.length / 2; s <= br.length / 2; s += 2) lo = Math.min(lo, t.heightAt(br.x + ca * s, br.z + sa * s));
  return lo - br.deckY;
}

function stoneBridge(b: GeoBuilder, L: number, W: number, bed: number): void {
  box(b, L, 1.1, W, 0, -0.55, 0, COL.stone);
  box(b, L, 0.12, W - 1.4, 0, 0.05, 0, COL.deck);
  for (const side of [-1, 1]) box(b, L, 1.0, 0.6, 0, 0.5, side * (W / 2 - 0.3), COL.stoneDark);
  const spans = Math.max(1, Math.round(L / 13));
  const depth = Math.max(2, -bed + 1.5);
  for (let k = 1; k < spans; k++) {
    const x = -L / 2 + (L * k) / spans;
    box(b, 2.4, depth, W * 0.92, x, -depth / 2 - 0.6, 0, COL.stoneDark);
    // Cutwaters on both faces.
    for (const side of [-1, 1]) box(b, 1.7, depth, 1.7, x, -depth / 2 - 0.6, side * (W * 0.46 + 0.4), COL.stoneDark, 0);
  }
  // Abutments.
  for (const end of [-1, 1]) box(b, 3, depth, W + 1, end * (L / 2 + 1), -depth / 2 - 0.3, 0, COL.stone);
}

function trussBridge(b: GeoBuilder, L: number, W: number, bed: number): void {
  box(b, L, 0.8, W, 0, -0.4, 0, COL.steelDark);
  box(b, L, 0.12, W - 1.2, 0, 0.06, 0, COL.deck);
  const h = 5.5;
  const panel = 6;
  const n = Math.max(2, Math.round((L * 0.94) / panel));
  const span = (L * 0.94) / n;
  for (const side of [-1, 1]) {
    const z = side * (W / 2 - 0.2);
    box(b, L * 0.94, 0.45, 0.45, 0, h, z, COL.steel);
    box(b, L, 0.5, 0.5, 0, 0.3, z, COL.steel);
    for (let k = 0; k <= n; k++) {
      const x = -L * 0.47 + k * span;
      box(b, 0.35, h, 0.35, x, h / 2, z, COL.steel);
      if (k < n) {
        const dir = k < n / 2 ? 1 : -1;
        box(b, Math.hypot(span, h), 0.3, 0.3, x + span / 2, h / 2, z, COL.steel, dir * Math.atan2(h, span));
      }
    }
  }
  // Overhead cross bracing.
  for (let k = 0; k <= n; k += 2) box(b, 0.3, 0.3, W - 0.4, -L * 0.47 + k * span, h, 0, COL.steelDark);
  const depth = Math.max(2, -bed + 1.5);
  const piers = Math.max(1, Math.round(L / 30));
  for (let k = 1; k < piers; k++) box(b, 2.2, depth, W * 0.8, -L / 2 + (L * k) / piers, -depth / 2 - 0.8, 0, COL.concrete);
  for (const end of [-1, 1]) box(b, 2.5, depth, W + 1, end * (L / 2 + 0.8), -depth / 2 - 0.3, 0, COL.concrete);
}

/** Stone arch bridges for short crossings, steel trusses for long ones. */
export function buildBridges(t: Terrain): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.05 });
  for (const br of t.bridges) {
    const b = new GeoBuilder();
    const W = 9;
    const bed = bedBelow(t, br);
    if (br.length <= 46) stoneBridge(b, br.length, W, bed);
    else trussBridge(b, br.length, W, bed);
    const mesh = new THREE.Mesh(b.build(), mat);
    mesh.position.set(br.x, br.deckY, br.z);
    mesh.rotation.y = -br.angle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}
