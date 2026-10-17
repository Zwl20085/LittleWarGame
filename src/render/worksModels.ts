import * as THREE from 'three';
import { GeoBuilder, trs } from './instancing';
import { registerStructureKind, type StructureKindDef } from './structureKinds';

/**
 * 3.0 models in the structure-kind registry (V30 §7, §8), drawn instanced by StructureViews:
 *  - economic zones by level: `ezone1` workshops and sheds, `ezone2` works with chimneys,
 *    `ezone3` a walled plant with a hall, chimneys and a water tower;
 *  - defensive works: `fortress` (stepped concrete casemate with turret cupolas), `at_emplacement`
 *    (horseshoe sandbag pit with a camouflage net), `strongpoint` (perimeter blockhouse with an
 *    observation cupola) and `minefield` (stakes, wire and warning signs).
 * Local frame: +x toward the facing, y up, metres; `body` is built at unit height (it rises with
 * construction progress), roof / skirt / ruin at absolute heights.
 */

const BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10).toNonIndexed();
const DOME = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
const PYR = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0).toNonIndexed();

const C = {
  brick: new THREE.Color('#8a5642'), brickDark: new THREE.Color('#6a4434'), soot: new THREE.Color('#38332e'),
  tin: new THREE.Color('#6b6d66'), tinDark: new THREE.Color('#55574f'), timber: new THREE.Color('#77654a'),
  timberDark: new THREE.Color('#564834'), concrete: new THREE.Color('#9d988c'), concreteDark: new THREE.Color('#7f7a6f'),
  glass: new THREE.Color('#3a4247'), sand: new THREE.Color('#b5a479'), earth: new THREE.Color('#6d5d43'),
  net: new THREE.Color('#5d6440'), wire: new THREE.Color('#4a4640'), sign: new THREE.Color('#d8c9a0'),
  red: new THREE.Color('#8a3a2c'), crate: new THREE.Color('#9c8358'), drum: new THREE.Color('#4f5a3c'),
  charred: new THREE.Color('#3b3632'), steel: new THREE.Color('#5a5c58'),
};

type B = GeoBuilder;
const box = (b: B, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, ry = 0): void => {
  b.add(BOX, trs(x, y, z, 0, ry, 0, w, h, d), c);
};
const cyl = (b: B, r: number, h: number, x: number, y: number, z: number, c: THREE.Color, rx = 0): void => {
  b.add(CYL, trs(x, y, z, rx, 0, 0, r, h, r), c);
};
const roofRidge = (b: B, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color): void => {
  b.add(PYR, trs(x, y, z, 0, 0, 0, w, h, d), c);
};

/** Burnt-out remains over a footprint: low wall stubs and heaps. */
function ruinOf(fx: number, fz: number, h: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    box(b, fx * 0.3, h * (0.15 + (i % 3) * 0.12), 0.5, Math.cos(a) * fx * 0.35, h * 0.1, Math.sin(a) * fz * 0.35, C.charred, a);
  }
  box(b, fx * 0.7, 0.6, fz * 0.6, 0, 0.3, 0, C.earth);
  return b.build();
}

/** Corrugated shed: unit-height body + absolute pitched roof. */
function shed(body: B, roof: B, w: number, d: number, h: number, x: number, z: number, wall: THREE.Color): void {
  box(body, w, 1, d, x, 0.5, z, wall);
  box(body, 0.06, 0.5, d * 0.5, x + w / 2 + 0.03, 0.3, z, C.timberDark);
  roofRidge(roof, w * 1.08, h * 0.35, d * 1.08, x, 0, z, C.tin);
}

function chimney(b: B, x: number, z: number, h: number, r: number): void {
  cyl(b, r, h, x, h / 2, z, C.brickDark);
  cyl(b, r * 1.15, 0.5, x, h - 0.25, z, C.soot);
}

function zoneModel(level: 1 | 2 | 3): StructureKindDef {
  const body = new GeoBuilder();
  const roof = new GeoBuilder();
  const skirt = new GeoBuilder();
  const fx = [16, 22, 30][level - 1];
  const fz = [14, 20, 26][level - 1];
  const h = [3.2, 4.2, 5.4][level - 1];
  if (level === 1) {
    shed(body, roof, 7, 5, h, -2, -3, C.timber);
    shed(body, roof, 5, 4, h, 3, 3.5, C.tinDark);
    shed(body, roof, 4, 3.5, h, -4, 4, C.timber);
  } else if (level === 2) {
    box(body, 12, 1, 8, -1, 0.5, -4, C.brick);
    box(body, 6, 1, 5, 5, 0.5, 5, C.tinDark);
    roofRidge(roof, 12.6, 1.6, 8.6, -1, 0, -4, C.tin);
    roofRidge(roof, 6.4, 1.2, 5.4, 5, 0, 5, C.tin);
    chimney(skirt, -5, -6.5, 11, 0.55);
    chimney(skirt, 2, -6.5, 9, 0.45);
  } else {
    box(body, 18, 1, 11, -2, 0.5, -5, C.brick);
    box(body, 8, 1, 7, 8, 0.5, 6, C.brickDark);
    box(body, 7, 1, 6, -8, 0.5, 7, C.concrete);
    for (let i = 0; i < 4; i++) roofRidge(roof, 4.5, 1.8, 11.4, -8.75 + i * 4.5, 0, -5, C.tin);
    roofRidge(roof, 8.4, 1.4, 7.4, 8, 0, 6, C.tinDark);
    for (const [cx, ch] of [[-9, 16], [-4, 14], [1, 15]] as const) chimney(skirt, cx, -11, ch, 0.7);
    // Water tower and the plant wall.
    for (const [sx, sz] of [[11, -9], [13, -9], [11, -11], [13, -11]] as const) cyl(skirt, 0.15, 8, sx, 4, sz, C.steel);
    cyl(skirt, 1.6, 2.4, 12, 9, -10, C.steel);
    for (const s of [-1, 1]) box(skirt, fx, 1.8, 0.4, 0, 0.9, s * (fz / 2), C.brickDark);
    box(skirt, 0.4, 1.8, fz, -fx / 2, 0.9, 0, C.brickDark);
  }
  // Yard: crates, drums, a cart track.
  for (let i = 0; i < 3 + level * 2; i++) box(skirt, 1, 1, 1, fx / 2 - 2 - (i % 3) * 1.2, 0.5, -fz / 2 + 2 + Math.floor(i / 3) * 1.2, i % 2 ? C.crate : C.timberDark);
  for (let i = 0; i < 2 + level; i++) cyl(skirt, 0.33, 0.95, fx / 2 - 2 - i * 0.8, 0.47, fz / 2 - 2, C.drum);
  box(skirt, fx, 0.04, 2.4, 0, 0.02, 0, C.earth);
  return {
    body: body.build(), roof: roof.build(), skirt: skirt.build(), ruin: ruinOf(fx, fz, h),
    height: h, footprint: { x: fx, z: fz }, flag: { back: fx * 0.3, top: h + 2.2 },
  };
}

function fortress(): StructureKindDef {
  const body = new GeoBuilder();
  const roof = new GeoBuilder();
  const skirt = new GeoBuilder();
  box(body, 12, 1, 14, 0, 0.5, 0, C.concrete);
  box(body, 0.2, 0.18, 9, 6.05, 0.62, 0, C.glass);
  box(body, 7, 0.4, 9, -1, 1.1, 0, C.concreteDark);
  box(roof, 12.6, 0.6, 14.6, 0, 0.3, 0, C.concreteDark);
  for (const z of [-4, 4]) roof.add(DOME, trs(2, 0.6, z, 0, 0, 0, 1.4, 1.1, 1.4), C.steel);
  box(skirt, 15, 1.4, 18, -1.5, 0.3, 0, C.earth);
  for (let i = 0; i < 9; i++) box(skirt, 1.3, 0.55, 0.8, 7.8, 0.3 + (i % 2) * 0.5, -6 + i * 1.5, C.sand, Math.PI / 2);
  return { body: body.build(), roof: roof.build(), skirt: skirt.build(), ruin: ruinOf(12, 14, 3.4), height: 3.4, footprint: { x: 12, z: 14 }, flag: { back: 5, top: 4.6 } };
}

function atEmplacement(): StructureKindDef {
  const body = new GeoBuilder();
  const roof = new GeoBuilder();
  const skirt = new GeoBuilder();
  // Horseshoe of sandbags open to the rear.
  for (let i = 0; i < 11; i++) {
    const a = -Math.PI * 0.75 + (i / 10) * Math.PI * 1.5;
    box(body, 1.3, 1, 0.8, Math.cos(a) * 3.2, 0.5, Math.sin(a) * 3.2, C.sand, -a + Math.PI / 2);
  }
  // Camouflage net on poles.
  for (const [x, z] of [[2, -2.5], [2, 2.5], [-2, -2.5], [-2, 2.5]] as const) cyl(skirt, 0.07, 1.6, x, 0.8, z, C.timberDark);
  box(roof, 5.2, 0.08, 6.2, 0, 0.35, 0, C.net);
  box(skirt, 7.5, 0.25, 7.5, -0.5, 0.05, 0, C.earth);
  for (let i = 0; i < 4; i++) box(skirt, 0.7, 0.4, 0.5, -3.2, 0.2, -1.5 + i, C.crate);
  return { body: body.build(), roof: roof.build(), skirt: skirt.build(), height: 1.2, footprint: { x: 7, z: 7 }, flag: null };
}

function strongpoint(): StructureKindDef {
  const body = new GeoBuilder();
  const roof = new GeoBuilder();
  const skirt = new GeoBuilder();
  box(body, 8, 1, 8, 0, 0.5, 0, C.concrete);
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) box(body, 0.16, 0.16, 3.4, Math.cos(a) * 4.05, 0.6, Math.sin(a) * 4.05, C.glass, -a);
  box(roof, 8.6, 0.5, 8.6, 0, 0.25, 0, C.concreteDark);
  cyl(roof, 1.1, 1.2, 0, 1.1, 0, C.concreteDark);
  roof.add(DOME, trs(0, 1.7, 0, 0, 0, 0, 1.1, 0.7, 1.1), C.steel);
  box(skirt, 11, 1.1, 11, 0, 0.2, 0, C.earth);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    cyl(skirt, 0.05, 1, Math.cos(a) * 7, 0.5, Math.sin(a) * 7, C.wire);
  }
  return { body: body.build(), roof: roof.build(), skirt: skirt.build(), ruin: ruinOf(8, 8, 3), height: 2.8, footprint: { x: 8, z: 8 }, flag: { back: 3, top: 4.4 } };
}

function minefield(depth: number, length: number): StructureKindDef {
  const body = new GeoBuilder();
  const skirt = new GeoBuilder();
  // Perimeter stakes with a strand of wire, and warning signs on the friendly side.
  const hx = depth / 2;
  const hz = length / 2;
  for (let z = -hz; z <= hz + 0.01; z += 4) for (const x of [-hx, hx]) cyl(body, 0.06, 1, x, 0.5, z, C.timberDark);
  for (let x = -hx; x <= hx + 0.01; x += 4) for (const z of [-hz, hz]) cyl(body, 0.06, 1, x, 0.5, z, C.timberDark);
  for (const x of [-hx, hx]) box(body, 0.03, 0.03, length, x, 0.8, 0, C.wire);
  for (const z of [-hz, hz]) box(body, depth, 0.03, 0.03, 0, 0.8, z, C.wire);
  for (let z = -hz + 6; z < hz; z += 12) {
    box(skirt, 0.05, 0.5, 0.7, -hx - 0.3, 1.1, z, C.sign);
    box(skirt, 0.06, 0.12, 0.72, -hx - 0.28, 1.2, z, C.red);
  }
  // Disturbed earth over the buried mines.
  for (let i = 0; i < 14; i++) box(skirt, 0.6, 0.06, 0.6, -hx + ((i * 7) % 10) / 10 * depth, 0.03, -hz + ((i * 13) % 14) / 14 * length, C.earth);
  return { body: body.build(), skirt: skirt.build(), height: 1.1, footprint: { x: depth, z: length }, flag: null };
}

let registered = false;

/** Register the 3.0 zone and works kinds (idempotent). Minefield size from rules.json defaults. */
export function registerWorksModels(minefieldDepth = 18, minefieldLength = 48): void {
  if (registered) return;
  registered = true;
  registerStructureKind('ezone1', zoneModel(1));
  registerStructureKind('ezone2', zoneModel(2));
  registerStructureKind('ezone3', zoneModel(3));
  registerStructureKind('fortress', fortress());
  registerStructureKind('at_emplacement', atEmplacement());
  registerStructureKind('strongpoint', strongpoint());
  registerStructureKind('minefield', minefield(minefieldDepth, minefieldLength));
}
