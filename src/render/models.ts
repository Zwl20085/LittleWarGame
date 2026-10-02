import * as THREE from 'three';
import { factionPaint } from './palette';

/** Procedural matte miniatures for the few non-instanced objects (planes, field works). */

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: THREE.Color | string, rough = 0.92, metal = 0.05): THREE.MeshStandardMaterial {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const key = `${c.getHexString()}|${rough}|${metal}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });
    matCache.set(key, m);
  }
  return m;
}

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo(`box${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(rt: number, rb: number, h: number, m: THREE.Material, seg = 10): THREE.Mesh {
  const mesh = new THREE.Mesh(geo(`cyl${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), m);
  mesh.castShadow = true;
  return mesh;
}

function stripe(color: string, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  return box(w, h, d, mat(new THREE.Color(color), 0.8), x, y, z);
}

export function planeModel(color: string, bomber: boolean): THREE.Group {
  const g = new THREE.Group();
  const paint = mat(factionPaint(color).lerp(new THREE.Color('#8a9080'), 0.3), 0.8, 0.1);
  const s = bomber ? 1.6 : 1;
  const fus = cyl(0.5 * s, 0.35 * s, 9 * s, paint, 10);
  fus.rotation.z = -Math.PI / 2;
  g.add(fus);
  g.add(box(2.6 * s, 0.15, 13 * s, paint, 0.6 * s, 0, 0));
  g.add(box(1.2 * s, 0.12, 4.2 * s, paint, -4 * s, 0.1, 0));
  g.add(box(1.2 * s, 1.6 * s, 0.12, paint, -4 * s, 0.8 * s, 0));
  g.add(stripe(color, 0.6 * s, 0.17, 13.02 * s, 0.6 * s, 0, 0));
  if (bomber) {
    for (const z of [-3.2, 3.2]) {
      const eng = cyl(0.45, 0.45, 2.2, paint, 8);
      eng.rotation.z = -Math.PI / 2;
      eng.position.set(1.4 * s, -0.2, z * s);
      g.add(eng);
    }
  }
  g.traverse((o) => (o.castShadow = true));
  g.scale.setScalar(1.6);
  return g;
}

export function fortModel(kind: 'field_cover' | 'mg_bunker'): THREE.Group {
  const g = new THREE.Group();
  const sand = mat('#b9a77c', 1);
  const n = kind === 'field_cover' ? 6 : 9;
  for (let k = 0; k < n; k++) {
    const a = -1 + (k / (n - 1)) * 2;
    const sb = box(1.6, 0.8, 1.0, sand, Math.cos(a) * 3.5, 0.4, Math.sin(a) * 3.5);
    sb.rotation.y = -a;
    g.add(sb);
    if (k % 2 === 0) {
      const top = box(1.5, 0.6, 0.9, sand, Math.cos(a) * 3.5, 1.05, Math.sin(a) * 3.5);
      top.rotation.y = -a + 0.1;
      g.add(top);
    }
  }
  return g;
}
