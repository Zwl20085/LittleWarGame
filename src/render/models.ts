import * as THREE from 'three';

/** Procedural matte miniatures for the few non-instanced objects (field works). */

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
