import * as THREE from 'three';
import { GeoBuilder } from './instancing';

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

// ---------------------------------------------------------------- 2.0 defensive buildings (instanced parts)

/**
 * Part geometries for pillboxes (炮楼) and bunkers (堡垒), drawn by render/structures.ts through
 * shared InstancedMeshes. Local frame: +x toward the enemy (the building's facing), y up, metres.
 * Parts are vertex-coloured; the per-instance colour multiplies them (damage darkening). The
 * faction pennant uses the field-works pennant (tinted).
 */
export interface StructureParts {
  /** Pillbox: octagonal concrete drum (unit height, scaled by construction), roof with embrasure band, sandbag skirt. */
  readonly pbBody: THREE.BufferGeometry;
  readonly pbRoof: THREE.BufferGeometry;
  readonly pbSkirt: THREE.BufferGeometry;
  /** Bunker: low concrete block (unit height), roof slab with two embrasures, earth berm. */
  readonly bkBody: THREE.BufferGeometry;
  readonly bkRoof: THREE.BufferGeometry;
  readonly bkBerm: THREE.BufferGeometry;
  /** Foundation slab with formwork (construction), and a heap of broken concrete (ruin). */
  readonly footing: THREE.BufferGeometry;
  readonly rubble: THREE.BufferGeometry;
}

export const PILLBOX_SIZE = { r: 3.2, h: 2.4 } as const;
export const BUNKER_SIZE = { w: 9, d: 6, h: 1.9 } as const;

const STRUCT_COL = {
  concrete: new THREE.Color('#9c9a92'),
  concreteDark: new THREE.Color('#7d7b74'),
  slit: new THREE.Color('#1c1b19'),
  bag: new THREE.Color('#b5a479'),
  earth: new THREE.Color('#6f6146'),
  timber: new THREE.Color('#6a5842'),
};

function m4(x: number, y: number, z: number, ry = 0, sx = 1, sy = 1, sz = 1, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
}

function pillboxParts(): Pick<StructureParts, 'pbBody' | 'pbRoof' | 'pbSkirt'> {
  const { r } = PILLBOX_SIZE;
  const drum = new THREE.CylinderGeometry(r * 0.94, r, 1, 8, 1);
  const body = new GeoBuilder().add(drum, m4(0, 0.5, 0, Math.PI / 8), STRUCT_COL.concrete).build();
  const roof = new GeoBuilder();
  // Embrasure band: dark slits all round except the rear, then the overhanging roof slab.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI))) < Math.PI / 4) continue;
    roof.add(BOX_G, m4(Math.cos(a) * r * 0.9, -0.35, -Math.sin(a) * r * 0.9, a, 0.25, 0.32, 1.3), STRUCT_COL.slit);
  }
  roof.add(new THREE.CylinderGeometry(r * 1.08, r * 1.02, 0.45, 8, 1), m4(0, 0.05, 0, Math.PI / 8), STRUCT_COL.concreteDark);
  roof.add(new THREE.CylinderGeometry(r * 0.55, r * 0.7, 0.3, 8, 1), m4(0, 0.4, 0, Math.PI / 8), STRUCT_COL.concrete);
  const skirt = new GeoBuilder();
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    const rr = r + 0.75;
    skirt.add(BOX_G, m4(Math.cos(a) * rr, 0.3, -Math.sin(a) * rr, a + Math.PI / 2, 1.5, 0.6, 0.8), STRUCT_COL.bag.clone().multiplyScalar(0.9 + (k % 3) * 0.05));
    if (k % 2 === 0) skirt.add(BOX_G, m4(Math.cos(a) * rr, 0.85, -Math.sin(a) * rr, a + Math.PI / 2 + 0.1, 1.4, 0.5, 0.75), STRUCT_COL.bag);
  }
  return { pbBody: body, pbRoof: roof.build(), pbSkirt: skirt.build() };
}

function bunkerParts(): Pick<StructureParts, 'bkBody' | 'bkRoof' | 'bkBerm'> {
  const { w, d } = BUNKER_SIZE;
  const body = new GeoBuilder().add(BOX_G, m4(0, 0.5, 0, 0, d, 1, w), STRUCT_COL.concrete).build();
  const roof = new GeoBuilder();
  for (const z of [-w * 0.25, w * 0.25]) roof.add(BOX_G, m4(d / 2 + 0.02, -0.4, z, 0, 0.1, 0.35, 1.8), STRUCT_COL.slit);
  roof.add(BOX_G, m4(0.2, 0.1, 0, 0, d + 0.8, 0.5, w + 0.8), STRUCT_COL.concreteDark);
  roof.add(BOX_G, m4(-d / 2 + 0.6, 0.45, w * 0.3, 0, 0.9, 0.3, 0.9), STRUCT_COL.concrete);
  // Earth berm banked against the front (a sloped slab sunk into the ground) and both flanks.
  const berm = new GeoBuilder();
  berm.add(BOX_G, m4(d / 2 + 1.2, 0.2, 0, 0, 3.2, 0.9, w + 1.6, -0.45), STRUCT_COL.earth);
  for (const s of [-1, 1]) berm.add(BOX_G, m4(0.4, 0.45, s * (w / 2 + 0.9), 0, d + 1.6, 0.9, 1.8), STRUCT_COL.earth.clone().multiplyScalar(0.95));
  return { bkBody: body, bkRoof: roof.build(), bkBerm: berm.build() };
}

function footingGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(BOX_G, m4(0, 0.15, 0, 0, 1, 0.3, 1), STRUCT_COL.concreteDark);
  // Formwork boards on two sides.
  for (const s of [-1, 1]) b.add(BOX_G, m4(0, 0.45, s * 0.5, 0, 1, 0.5, 0.04), STRUCT_COL.timber);
  return b.build();
}

function rubbleGeo(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const chunks: [number, number, number, number, number][] = [[0, 0, 1.6, 0.7, 0.3], [1.2, 0.8, 1.1, 0.5, 1.1], [-1.1, 0.6, 1.3, 0.6, 2.0], [0.4, -1.2, 1.2, 0.45, 0.7], [-0.6, -0.9, 0.9, 0.4, 2.6], [1.6, -0.4, 0.8, 0.35, 1.7]];
  for (const [x, z, s, h, a] of chunks) b.add(BOX_G, m4(x, h / 2, z, a, s, h, s * 0.8), STRUCT_COL.concreteDark);
  return b.build();
}

const BOX_G = new THREE.BoxGeometry(1, 1, 1);
let structureParts: StructureParts | null = null;

export function getStructureParts(): StructureParts {
  structureParts ??= { ...pillboxParts(), ...bunkerParts(), footing: footingGeo(), rubble: rubbleGeo() };
  return structureParts;
}
