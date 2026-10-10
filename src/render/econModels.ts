import * as THREE from 'three';
import { GeoBuilder, trs } from './instancing';
import { registerStructureKind, type StructureKindDef } from './structureKinds';

/**
 * 2.2 economic buildings as period miniatures, registered in the structure-kind registry:
 * 工厂 factory (brick hall, sawtooth north-light roof, tall chimney, loading dock),
 * 征兵站 recruitment office (rendered two-storey office, hipped tile roof, portico, notice
 * boards, sandbags, flag), 仓库 depot (timber warehouse with big doors, crates, fuel drums and
 * a tarpaulined dump). Each has a scaffold stage and a burnt-out ruin. Local frame: +x toward
 * the building's facing (the town), y up, metres; `body` is unit height (scaled while it rises).
 */

const BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10).toNonIndexed();
const PYR = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0).toNonIndexed();

const C = {
  brick: new THREE.Color('#8a5642'),
  brickDark: new THREE.Color('#6a4434'),
  soot: new THREE.Color('#38332e'),
  slate: new THREE.Color('#57544f'),
  glass: new THREE.Color('#3a4247'),
  concrete: new THREE.Color('#9d988c'),
  plaster: new THREE.Color('#d6cbb0'),
  plasterDark: new THREE.Color('#b3a78c'),
  tile: new THREE.Color('#87513d'),
  stone: new THREE.Color('#bdb4a0'),
  door: new THREE.Color('#3b2c20'),
  timber: new THREE.Color('#77654a'),
  timberDark: new THREE.Color('#564834'),
  roofTin: new THREE.Color('#6b6d66'),
  crate: new THREE.Color('#9c8358'),
  crateDark: new THREE.Color('#7d6744'),
  drum: new THREE.Color('#4f5a3c'),
  drumRed: new THREE.Color('#7a3d30'),
  tarp: new THREE.Color('#6f7350'),
  sand: new THREE.Color('#b5a479'),
  board: new THREE.Color('#2f3a2e'),
  paper: new THREE.Color('#e8e0c8'),
  pole: new THREE.Color('#4a4038'),
  charred: new THREE.Color('#3b3632'),
  ash: new THREE.Color('#5e5850'),
};

type B = GeoBuilder;
const box = (b: B, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, ry = 0, rz = 0): void => {
  b.add(BOX, trs(x, y, z, 0, ry, rz, w, h, d), c);
};
const cyl = (b: B, r: number, h: number, x: number, y: number, z: number, c: THREE.Color, rx = 0): void => {
  b.add(CYL, trs(x, y, z, rx, 0, 0, r, h, r), c);
};
const pyramid = (b: B, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color): void => {
  b.add(PYR, trs(x, y, z, 0, 0, 0, w, h, d), c);
};

const WEDGE = (() => {
  const p = [[0, 0, -0.5], [1, 0, -0.5], [1, 1, -0.5], [0, 0, 0.5], [1, 0, 0.5], [1, 1, 0.5]];
  const tris = [[0, 2, 1], [3, 4, 5], [0, 3, 5], [0, 5, 2], [1, 2, 5], [1, 5, 4], [0, 1, 4], [0, 4, 3]];
  const pos: number[] = [];
  for (const t of tris) for (const k of t) pos.push(...p[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
})();

/**
 * Wedge rising along local +x from y = 0 to `h` over [x0, x1], `d` deep, then turned by `ry`
 * about the y axis and moved to (ox, y, oz).
 */
function wedge(b: B, x0: number, x1: number, h: number, d: number, y: number, c: THREE.Color, ry = 0, ox = 0, oz = 0): void {
  const m = new THREE.Matrix4().makeTranslation(ox, y, oz)
    .multiply(new THREE.Matrix4().makeRotationY(ry))
    .multiply(trs(x0, 0, 0, 0, 0, 0, x1 - x0, h, d));
  b.add(WEDGE, m, c);
}

/** Window band on both long faces (±x), normalised to a unit-height body. */
function windowBands(b: B, fx: number, fz: number, lo: number, hi: number, bays: number, c: THREE.Color): void {
  for (const s of [-1, 1]) {
    for (let i = 0; i < bays; i++) {
      const z = -fz / 2 + (fz * (i + 0.5)) / bays;
      box(b, 0.08, hi - lo, (fz / bays) * 0.55, s * (fx / 2 + 0.02), (lo + hi) / 2, z, c);
    }
  }
}

/** Scaffold of poles and planks around a fx × fz footprint up to height h. */
function scaffold(fx: number, fz: number, h: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const ox = fx / 2 + 0.8;
  const oz = fz / 2 + 0.8;
  for (const [sx, n] of [[ox, Math.max(2, Math.round(fz / 3))], [-ox, Math.max(2, Math.round(fz / 3))]] as const) {
    for (let i = 0; i <= n; i++) {
      const z = -oz + (2 * oz * i) / n;
      cyl(b, 0.07, h + 1, sx, (h + 1) / 2, z, C.timber);
    }
  }
  for (const sz of [-oz, oz]) for (let i = 1; i < Math.max(2, Math.round(fx / 3)); i++) cyl(b, 0.07, h + 1, -ox + (2 * ox * i) / Math.max(2, Math.round(fx / 3)), (h + 1) / 2, sz, C.timber);
  for (let lv = 1; lv <= Math.max(1, Math.floor(h / 2.2)); lv++) {
    const y = lv * 2.2;
    for (const s of [-1, 1]) {
      box(b, 0.5, 0.08, 2 * oz, s * ox, y, 0, C.timberDark);
      box(b, 2 * ox, 0.08, 0.5, 0, y, s * oz, C.timberDark);
    }
  }
  // A ladder and a heap of bricks / timber at the foot.
  box(b, 0.5, h, 0.12, ox + 0.4, h / 2, oz * 0.3, C.timberDark, 0, 0.12);
  box(b, 2.2, 0.8, 1.4, -ox - 1.6, 0.4, -oz * 0.4, C.brick);
  box(b, 3.0, 0.4, 0.9, -ox - 1.4, 0.2, oz * 0.4, C.timber);
  return b.build();
}

/** Burnt-out shell: broken wall stubs of uneven height, charred, with rubble inside and out. */
function ruin(fx: number, fz: number, h: number, wall: THREE.Color): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const burnt = wall.clone().lerp(C.charred, 0.55);
  const segs: [number, number, number, number][] = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const t0 = -0.5 + i / n;
    const hh = h * (0.25 + 0.5 * (((i * 7 + 3) % 5) / 5));
    segs.push([t0 + 0.5 / n, hh, 0, 0]);
  }
  for (const [t, hh] of segs) {
    if (hh > h * 0.3) box(b, 0.4, hh, fz / n * 0.8, fx / 2, hh / 2, t * fz, burnt);
    box(b, 0.4, hh * 0.7, fz / n * 0.8, -fx / 2, hh * 0.35, -t * fz, burnt);
    box(b, fx / n * 0.8, hh * 0.85, 0.4, t * fx, hh * 0.42, fz / 2, burnt);
    if (hh < h * 0.6) box(b, fx / n * 0.8, hh * 0.5, 0.4, -t * fx, hh * 0.25, -fz / 2, burnt);
  }
  const chunks: [number, number, number, number][] = [[0, 0, 2.2, 0.4], [0.25, 0.2, 1.6, 1.1], [-0.2, 0.3, 1.8, 2.0], [0.1, -0.3, 1.4, 0.7], [-0.3, -0.2, 1.2, 2.6], [0.35, -0.1, 1.0, 1.7]];
  for (const [u, v, s, a] of chunks) box(b, s, s * 0.35, s * 0.8, u * fx, s * 0.17, v * fz, C.ash, a);
  box(b, fx * 0.9, 0.15, fz * 0.9, 0, 0.07, 0, C.charred);
  // Fallen roof timbers.
  box(b, fx * 0.8, 0.25, 0.3, 0, 0.6, fz * 0.1, C.charred, 0, 0.35);
  box(b, 0.3, 0.25, fz * 0.7, fx * 0.15, 0.5, 0, C.charred, 0.3, 0);
  return b.build();
}

function factory(): StructureKindDef {
  const fx = 12;
  const fz = 18;
  const h = 6.5;
  const body = new GeoBuilder();
  box(body, fx, 1, fz, 0, 0.5, 0, C.brick);
  box(body, fx + 0.1, 0.08, fz + 0.1, 0, 0.04, 0, C.brickDark);
  windowBands(body, fx, fz, 0.35, 0.78, 5, C.glass);
  // Pilasters between the bays.
  for (const s of [-1, 1]) for (let i = 0; i <= 5; i++) box(body, 0.2, 1, 0.5, s * (fx / 2 + 0.05), 0.5, -fz / 2 + (fz * i) / 5, C.brickDark);
  // Big loading door on the front.
  box(body, 0.1, 0.6, 3.2, fx / 2 + 0.06, 0.3, 0, C.door);
  const teeth = 4;
  const tw = fz / teeth;
  // Sawtooth north-light roof: each tooth rises along z (slate back, glazed vertical face).
  const roofZ = new GeoBuilder();
  for (let i = 0; i < teeth; i++) {
    const z0 = -fz / 2 + tw * i;
    // Rotated −90° about y: local +x (the rise) runs along +z, local z (depth) across x.
    wedge(roofZ, 0, tw, 2.2, fx, 0, C.slate, -Math.PI / 2, 0, z0);
    box(roofZ, fx * 0.96, 2.1, 0.12, 0, 1.05, z0 + tw - 0.06, C.glass);
  }
  box(roofZ, fx + 0.4, 0.3, fz + 0.4, 0, 0.0, 0, C.brickDark);
  // Chimney stack at the back corner, banded, and roof vents.
  cyl(roofZ, 0.75, 13, -fx * 0.3, 6.5, fz * 0.32, C.brick);
  cyl(roofZ, 0.9, 0.5, -fx * 0.3, 12.9, fz * 0.32, C.soot);
  cyl(roofZ, 0.85, 0.3, -fx * 0.3, 8.0, fz * 0.32, C.brickDark);
  box(roofZ, 1.4, 0.9, 1.4, fx * 0.2, 2.6, -fz * 0.3, C.slate);
  const yard = new GeoBuilder();
  // Loading dock with crates, a handcart and a coal heap.
  box(yard, 2.4, 1.1, 7, fx / 2 + 1.2, 0.55, 0, C.concrete);
  for (const [z, s] of [[-2.2, 1], [-1, 0.8], [1.6, 1.1]] as const) box(yard, s, s, s, fx / 2 + 1.2, 1.1 + s / 2, z, C.crate);
  pyramid(yard, 4, 1.6, 3, -fx / 2 - 2.5, 0, -fz * 0.25, C.soot);
  for (const z of [-1, 1]) cyl(yard, 0.35, 0.9, -fx / 2 - 1.2, 0.45, fz * 0.3 + z * 0.8, C.drum);
  return {
    body: body.build(), roof: roofZ.build(), skirt: yard.build(), scaffold: scaffold(fx, fz, h), ruin: ruin(fx, fz, h, C.brick),
    height: h, footprint: { x: fx, z: fz }, flag: { back: fx * 0.35, top: h + 3.2 },
  };
}

function recruit(): StructureKindDef {
  const fx = 8;
  const fz = 11;
  const h = 6;
  const body = new GeoBuilder();
  box(body, fx, 1, fz, 0, 0.5, 0, C.plaster);
  box(body, fx + 0.12, 0.12, fz + 0.12, 0, 0.06, 0, C.plasterDark);
  box(body, fx + 0.1, 0.03, fz + 0.1, 0, 0.5, 0, C.plasterDark);
  for (const [lo, hi] of [[0.15, 0.38], [0.6, 0.85]]) windowBands(body, fx, fz, lo, hi, 4, C.glass);
  box(body, 0.1, 0.42, 1.4, fx / 2 + 0.07, 0.21, 0, C.door);
  const roof = new GeoBuilder();
  box(roof, fx + 0.6, 0.35, fz + 0.6, 0, 0.17, 0, C.stone);
  pyramid(roof, fx + 0.8, 3.0, fz + 0.8, 0, 0.3, 0, C.tile);
  box(roof, 0.8, 1.6, 0.6, -fx * 0.2, 2.2, fz * 0.25, C.brick);
  const yard = new GeoBuilder();
  // Portico: steps, two columns and a pediment over the door.
  box(yard, 1.6, 0.3, 3.4, fx / 2 + 0.8, 0.15, 0, C.stone);
  for (const z of [-1.2, 1.2]) cyl(yard, 0.2, 3.0, fx / 2 + 1.3, 1.65, z, C.stone);
  box(yard, 1.4, 0.35, 3.2, fx / 2 + 1.0, 3.3, 0, C.stone);
  // Sign over the entrance and notice boards with posters.
  box(yard, 0.12, 0.7, 4.2, fx / 2 + 0.1, 3.95, 0, C.board);
  box(yard, 0.14, 0.32, 3.4, fx / 2 + 0.12, 3.95, 0, C.paper);
  for (const z of [-3.6, 3.6]) {
    box(yard, 0.1, 1.2, 1.6, fx / 2 + 0.12, 1.5, z, C.board);
    box(yard, 0.12, 0.8, 1.2, fx / 2 + 0.14, 1.55, z, C.paper);
  }
  // Sandbag walls flanking the door, a bench and a queue rail.
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) box(yard, 1.0, 0.45, 0.6, fx / 2 + 2.6, 0.25 + (i % 2) * 0.4, s * (2.6 + i * 0.9), C.sand);
  box(yard, 0.4, 0.45, 2.2, fx / 2 + 3.2, 0.23, -4.5, C.timber);
  // Flag pole by the steps (the owner pennant flies from it).
  cyl(yard, 0.08, 8.5, fx / 2 + 3.4, 4.25, 0, C.pole);
  return {
    body: body.build(), roof: roof.build(), skirt: yard.build(), scaffold: scaffold(fx, fz, h), ruin: ruin(fx, fz, h, C.plaster),
    height: h, footprint: { x: fx, z: fz }, flag: { back: -(fx / 2 + 3.4), top: 8.1 },
  };
}

function depot(): StructureKindDef {
  const fx = 11;
  const fz = 16;
  const h = 4.6;
  const body = new GeoBuilder();
  box(body, fx, 1, fz, 0, 0.5, 0, C.timber);
  // Vertical boarding battens and two big doors on the front.
  for (const s of [-1, 1]) for (let i = 0; i <= 8; i++) box(body, 0.08, 1, 0.12, s * (fx / 2 + 0.03), 0.5, -fz / 2 + (fz * i) / 8, C.timberDark);
  for (const z of [-3.6, 3.6]) box(body, 0.1, 0.78, 3.4, fx / 2 + 0.06, 0.39, z, C.timberDark);
  box(body, fx + 0.2, 0.1, fz + 0.2, 0, 0.05, 0, C.concrete);
  const roof = new GeoBuilder();
  // Shallow gabled tin roof with a ridge vent.
  const roofH = 2.2;
  for (const s of [-1, 1]) wedge(roof, 0, fx / 2 + 0.6, roofH, fz + 0.8, 0, C.roofTin, s > 0 ? Math.PI : 0, s * (fx / 2 + 0.6), 0);
  box(roof, 1.2, 0.5, fz * 0.8, 0, roofH + 0.2, 0, C.slate);
  const yard = new GeoBuilder();
  // Crate stacks, fuel drum clusters and a tarpaulined dump.
  const crateStack = (x: number, z: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const lx = x + (i % 2) * 1.15;
      const lz = z + (Math.floor(i / 2) % 2) * 1.15;
      const ly = Math.floor(i / 4) * 1.05;
      box(yard, 1.05, 1.0, 1.05, lx, ly + 0.5, lz, i % 3 ? C.crate : C.crateDark, (i % 2) * 0.08);
    }
  };
  // Yard on the flanks and behind the shed (the front faces the street).
  crateStack(fx / 2 - 3.2, -fz / 2 - 2.6, 7);
  crateStack(-fx / 2 + 0.6, fz / 2 + 1.4, 5);
  for (let i = 0; i < 9; i++) cyl(yard, 0.33, 0.95, -fx / 2 - 1.4 - (i % 3) * 0.72, 0.47, -fz * 0.3 + Math.floor(i / 3) * 0.72, i === 4 ? C.drumRed : C.drum);
  for (let i = 0; i < 3; i++) cyl(yard, 0.33, 0.95, fx / 2 - 1.5 - i * 1.0, 0.33, fz / 2 + 1.2, C.drum, Math.PI / 2);
  pyramid(yard, 4.2, 1.8, 3.4, -fx / 2 - 2.8, 0, fz * 0.22, C.tarp);
  box(yard, 4.4, 0.25, 3.6, -fx / 2 - 2.8, 0.12, fz * 0.22, C.timberDark);
  return {
    body: body.build(), roof: roof.build(), skirt: yard.build(), scaffold: scaffold(fx, fz, h), ruin: ruin(fx, fz, h, C.timber),
    height: h, footprint: { x: fx, z: fz }, flag: { back: fx * 0.2, top: h + roofH + 0.6 },
  };
}

let registered = false;

/** Register the economic building kinds (idempotent). */
export function registerEconModels(): void {
  if (registered) return;
  registered = true;
  registerStructureKind('factory', factory());
  registerStructureKind('recruit', recruit());
  registerStructureKind('depot', depot());
}
