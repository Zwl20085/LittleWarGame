import * as THREE from 'three';
import { trs } from './instancing';
import { barrel, cylGeo, Kit, paint, spokedWheel, uniform, ZERO } from './modelKit';
import { PAL } from './palette';

/**
 * Tanks, trucks and crew-served guns (model units, +x forward, faction tint via paint()).
 * 2.1 detail pass: distinct running gear per tank class (bogies and return rollers on the
 * light, three volute bogies on the medium, interleaved road wheels on the heavy), sprockets,
 * idlers, track guards, hatches, cupolas, mantlets, bow MGs, headlights, exhausts, tools,
 * stowage, antennae and a muzzle brake on the heavy; trucks with glazed cabs, grilles,
 * headlights, mudguards, a spare wheel and tarp ribs; guns with shields, spoked wheels,
 * trail spades and ammunition.
 */

export interface TankSpec {
  len: number; width: number; hullH: number; trackH: number;
  turretW: number; turretL: number; turretH: number; round: boolean;
  barrel: number; barrelR: number; brake: boolean; slope: boolean; turretX: number;
}

export const TANKS: Record<string, TankSpec> = {
  // Stuart-type: narrow, tall, small turret, short gun.
  light_tank: { len: 4.4, width: 2.3, hullH: 1.1, trackH: 0.9, turretW: 1.5, turretL: 1.6, turretH: 0.8, round: false, barrel: 2.0, barrelR: 0.07, brake: false, slope: true, turretX: -0.1 },
  // Sherman-type: tall sloped hull, rounded cast turret.
  medium_tank: { len: 5.8, width: 2.6, hullH: 1.3, trackH: 1.0, turretW: 1.9, turretL: 2.0, turretH: 0.95, round: true, barrel: 3.0, barrelR: 0.09, brake: false, slope: true, turretX: 0 },
  // Tiger-type: big box hull, wide slab turret, long gun with muzzle brake.
  heavy_tank: { len: 6.3, width: 3.5, hullH: 1.25, trackH: 1.05, turretW: 2.6, turretL: 2.7, turretH: 1.0, round: false, barrel: 5.0, barrelR: 0.11, brake: true, slope: false, turretX: 0.2 },
};

const WHEEL = new THREE.Color('#3f3d38');
const RUBBER = new THREE.Color('#2a2926');
const GLASS = new THREE.Color('#2b3236');
const LAMP = new THREE.Color('#d9d2b8');
const DARK = new THREE.Color('#1f1e1b');
const CANVAS = new THREE.Color('#8d8a68');
const WOOD = new THREE.Color('#7a6446');
const STEEL = PAL.steel;

export function tankDeckY(s: TankSpec): number {
  return s.trackH + s.hullH - 0.15;
}

/** Tracks with class-specific running gear, sprocket (front), idler (rear) and track guards. */
function runningGear(k: Kit, id: string, s: TankSpec): void {
  const h = s.trackH;
  const [gc, gt] = paint(0.8);
  for (const side of [-1, 1]) {
    const z = side * (s.width / 2 - 0.27);
    const zo = side * (s.width / 2 + 0.01);
    k.box(s.len, h * 0.92, 0.55, 0, h * 0.5, z, PAL.track);
    // Track guard / fender along the top run.
    k.box(s.len * 1.02, 0.06, 0.64, 0, h + 0.02, z, gc, gt);
    k.wheel(h * 0.36, 0.2, 7, s.len / 2 - 0.3, h * 0.62, zo, STEEL);
    k.wheel(h * 0.32, 0.2, 6, -s.len / 2 + 0.3, h * 0.55, zo, STEEL);
    if (id === 'heavy_tank') {
      // Interleaved big road wheels: two staggered rows.
      for (let i = 0; i < 8; i++) {
        const x = -s.len / 2 + 0.75 + (i * (s.len - 1.5)) / 7;
        k.wheel(h * 0.4, 0.12, 7, x, h * 0.43, zo + side * (i % 2 ? 0.0 : 0.08), WHEEL);
      }
    } else {
      const bogies = id === 'medium_tank' ? 3 : 2;
      for (let b = 0; b < bogies; b++) {
        const bx = -s.len / 2 + 0.85 + (b * (s.len - 1.7)) / (bogies - 1);
        // Volute bogie: two road wheels on a bracket, a return roller above.
        k.box(0.5, 0.36, 0.12, bx, h * 0.48, zo + side * 0.05, gc, gt);
        for (const dx of [-0.36, 0.36]) k.wheel(h * 0.27, 0.13, 6, bx + dx, h * 0.3, zo + side * 0.03, WHEEL);
        // Return roller on the light tank's two bogies (the medium's sit under the track guard).
        if (bogies === 2) k.wheel(h * 0.12, 0.1, 5, bx, h * 0.84, zo, STEEL);
      }
    }
  }
}

function tankHull(id: string): THREE.BufferGeometry {
  const s = TANKS[id];
  const k = new Kit();
  runningGear(k, id, s);
  const [pc, pt] = paint();
  const [dc, dt] = paint(0.85);
  const deck = tankDeckY(s);
  const hullY = s.trackH + s.hullH / 2 - 0.15;
  k.box(s.len * 0.92, s.hullH, s.width * 0.82, 0, hullY, 0, pc, pt);
  // Superstructure over the tracks (sponsons) on the medium and heavy.
  if (id !== 'light_tank') k.box(s.len * 0.86, s.hullH * 0.45, s.width * 1.0, -0.05, deck - s.hullH * 0.2, 0, pc, pt);
  if (s.slope) k.box(1.3, 0.12, s.width * 0.8, s.len * 0.42, s.trackH + s.hullH * 0.6, 0, pc, pt, 0, 0, -0.75);
  // Engine deck: raised plate with dark grilles, exhausts at the back.
  k.box(1.2, 0.18, s.width * 0.7, -s.len * 0.35, deck + 0.08, 0, dc, dt);
  for (const z of [-0.3, 0.3]) k.box(0.9, 0.04, s.width * 0.22, -s.len * 0.35, deck + 0.18, z * s.width, DARK);
  for (const z of [-0.28, 0.28]) k.rod(0.09, 0.5, 5, -s.len * 0.47, hullY + 0.15, z * s.width, DARK);
  // Driver's hatch and visor, bow MG, headlights.
  const fx = s.len * (s.slope ? 0.3 : 0.44);
  k.box(0.5, 0.1, 0.5, fx - 0.25, deck + 0.04, -s.width * 0.18, dc, dt);
  k.box(0.06, 0.08, 0.36, s.len * 0.46, hullY + s.hullH * 0.28, -s.width * 0.18, DARK);
  if (id !== 'heavy_tank') k.box(0.5, 0.14, 0.4, fx - 0.25, deck + 0.06, s.width * 0.18, dc, dt);
  k.rod(0.035, 0.45, 5, s.len * 0.47, hullY + s.hullH * 0.15, s.width * 0.18, STEEL);
  for (const z of [-0.36, 0.36]) k.cyl(0.11, 0.11, 0.14, 5, s.len * 0.47, hullY + s.hullH * 0.45, z * s.width, LAMP, 0, 0, 0, -Math.PI / 2);
  // Tools and tow cable along the hull sides, a stowage box on the rear deck.
  for (const side of [-1, 1]) k.box(s.len * 0.55, 0.06, 0.06, -0.2, deck - 0.05, side * s.width * 0.42, WOOD);
  k.box(0.5, 0.32, s.width * 0.5, -s.len * 0.44, deck + 0.12, 0, new THREE.Color('#6b6a52'));
  if (id === 'medium_tank') {
    // Rounded transmission nose and spare track links on the glacis.
    k.cyl(s.hullH * 0.42, s.hullH * 0.42, s.width * 0.82, 8, s.len * 0.44, s.trackH * 0.55, 0, pc, pt, Math.PI / 2);
    for (let i = 0; i < 4; i++) k.box(0.3, 0.06, 0.45, s.len * 0.38, s.trackH + s.hullH * 0.62, -0.75 + i * 0.5, PAL.track, 0, 0, 0, -0.75);
  }
  return k.build();
}

/** Turret geometry in turret-local space (origin on the deck at the turret ring). */
function tankTurret(id: string): THREE.BufferGeometry {
  const s = TANKS[id];
  const k = new Kit();
  const [pc, pt] = paint();
  const [dc, dt] = paint(0.85);
  if (s.round) k.geo(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), trs(0, 0, 0, 0, 0, 0, s.turretL / 2, s.turretH * 1.15, s.turretW / 2), pc, pt);
  else k.box(s.turretL, s.turretH, s.turretW, 0, s.turretH / 2, 0, pc, pt);
  // Faction recognition band.
  k.box(s.turretL * 0.6, 0.18, s.turretW + 0.04, -0.1, s.turretH * 0.55, 0, ZERO, 1);
  // Mantlet and coax MG.
  const mx = s.turretL / 2 - 0.05;
  k.box(0.3, s.turretH * 0.62, s.turretW * (id === 'heavy_tank' ? 0.62 : 0.5), mx, s.turretH * 0.5, 0, dc, dt);
  k.rod(0.03, 0.4, 5, mx + 0.3, s.turretH * 0.42, s.turretW * 0.17, STEEL);
  // Commander's cupola with hatch, loader's hatch.
  const cx = -s.turretL * 0.2;
  const cz = -s.turretW * 0.2;
  const top = s.round ? s.turretH * 1.0 : s.turretH;
  k.cyl(0.3, 0.33, 0.3, 10, cx, top + 0.12, cz, pc, pt);
  k.cyl(0.28, 0.28, 0.05, 10, cx - 0.05, top + 0.3, cz, dc, dt, 0, 0, 0.25);
  k.box(0.45, 0.06, 0.4, s.turretL * 0.05, top + 0.02, s.turretW * 0.2, dc, dt);
  // Antenna at the rear.
  k.cyl(0.012, 0.02, 2.4, 4, -s.turretL * 0.4, top + 1.2, s.turretW * 0.32, STEEL);
  if (id === 'medium_tank') {
    // Pintle .50 on the roof, rear bustle stowage.
    k.box(0.08, 0.35, 0.08, s.turretL * 0.05, top + 0.25, s.turretW * 0.32, STEEL);
    k.rod(0.03, 0.7, 5, s.turretL * 0.2, top + 0.45, s.turretW * 0.32, STEEL);
    k.box(0.5, 0.35, s.turretW * 0.6, -s.turretL * 0.55, s.turretH * 0.45, 0, new THREE.Color('#6b6a52'));
  } else if (id === 'heavy_tank') {
    // Stowage bin, smoke dischargers, spare track links on the turret sides.
    k.box(0.7, s.turretH * 0.6, s.turretW * 0.7, -s.turretL * 0.62, s.turretH * 0.5, 0, dc, dt);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) k.cyl(0.05, 0.05, 0.25, 5, s.turretL * 0.38, s.turretH * 0.85, side * (s.turretW * 0.4 + i * 0.09), STEEL, 0, 0, 0, -0.6);
      for (let i = 0; i < 3; i++) k.box(0.32, 0.38, 0.05, -0.4 + i * 0.36, s.turretH * 0.5, side * (s.turretW / 2 + 0.03), PAL.track);
    }
  } else {
    k.box(0.4, s.turretH * 0.5, s.turretW * 0.5, -s.turretL * 0.55, s.turretH * 0.4, 0, dc, dt);
  }
  const [bc, bt] = paint(0.9);
  barrel(k.child(trs(s.turretL / 2 - 0.1, s.turretH * 0.5, 0)), s.barrel, s.barrelR, bc, bt, s.brake);
  // Barrel sleeve near the mantlet.
  k.rod(s.barrelR * 1.6, s.barrel * 0.18, 8, s.turretL / 2 + s.barrel * 0.09, s.turretH * 0.5, 0, bc, bt);
  return k.build();
}

/** Shared truck chassis: frame, bonnet with grille and lamps, glazed cab, mudguards, wheels. */
function truckChassis(k: Kit): void {
  const [pc, pt] = paint();
  const [dc, dt] = paint(0.8);
  k.box(5.6, 0.3, 1.5, 0, 0.88, 0, STEEL);
  // Bonnet with radiator grille, bumper and headlights.
  k.box(1.0, 0.85, 1.6, 2.65, 1.45, 0, pc, pt);
  k.box(0.06, 0.7, 1.2, 3.17, 1.42, 0, DARK);
  k.box(0.15, 0.18, 2.1, 3.25, 0.95, 0, STEEL);
  for (const z of [-0.62, 0.62]) k.cyl(0.13, 0.13, 0.12, 8, 3.12, 1.72, z, LAMP, 0, 0, 0, -Math.PI / 2);
  // Cab with windscreen, side windows and a canvas roof.
  k.box(1.5, 1.25, 2.0, 1.55, 1.68, 0, pc, pt);
  k.box(0.05, 0.5, 1.7, 2.31, 2.0, 0, GLASS);
  for (const z of [-1.01, 1.01]) k.box(0.7, 0.45, 0.04, 1.7, 2.0, z, GLASS);
  k.box(1.55, 0.08, 2.05, 1.52, 2.33, 0, CANVAS);
  // Mudguards over the front wheels, running boards.
  for (const z of [-1, 1]) {
    k.box(1.1, 0.08, 0.45, 2.25, 1.2, z * 0.92, dc, dt);
    k.box(1.0, 0.06, 0.3, 1.45, 0.9, z * 1.05, dc, dt);
  }
  // Wheels: tyre + hub; twin rear axles.
  for (const x of [2.25, -0.6, -1.9]) {
    for (const side of [-1, 1]) {
      k.wheel(0.5, 0.35, 8, x, 0.5, side * 1.02, RUBBER);
      k.wheel(0.24, 0.38, 5, x, 0.5, side * 1.03, STEEL);
    }
  }
}

function truckGeo(): THREE.BufferGeometry {
  const k = new Kit();
  const [pc, pt] = paint();
  truckChassis(k);
  k.box(3.4, 0.6, 2.2, -1.0, 1.35, 0, pc, pt);
  // Tarp (half cylinder) over the bed, with ribs, a spare wheel and a rear tailboard.
  k.geo(cylGeo(1.1, 1.1, 10, false, Math.PI), trs(-1.0, 1.65, 0, 0, 0, Math.PI / 2, 1, 3.3, 1), CANVAS);
  const rib = new THREE.TorusGeometry(1.12, 0.035, 3, 8, Math.PI);
  for (const x of [0.4, -1.0, -2.4]) k.geo(rib, trs(x, 1.65, 0, 0, Math.PI / 2, 0), new THREE.Color('#77745a'));
  k.box(0.1, 0.62, 2.2, -2.72, 1.32, 0, pc, pt);
  k.wheel(0.45, 0.25, 10, 0.4, 1.1, 1.12, RUBBER);
  // Recognition band behind the cab.
  k.box(0.1, 0.5, 2.02, 0.75, 1.9, 0, ZERO, 1);
  return k.build();
}

/**
 * Troop-carrying truck (motorized infantry): same chassis, tarp rolled up behind the cab,
 * bare hoops over the open bed and a section seated on the benches.
 */
function troopTruckGeo(): THREE.BufferGeometry {
  const k = new Kit();
  const [pc, pt] = paint();
  const roll = new THREE.Color('#5f6448');
  truckChassis(k);
  k.box(3.4, 0.25, 2.2, -1.0, 1.15, 0, new THREE.Color('#8a7a5e'));
  for (const side of [-1, 1]) k.box(3.4, 0.45, 0.1, -1.0, 1.45, side * 1.05, pc, pt);
  k.box(0.1, 0.45, 2.2, -2.68, 1.45, 0, pc, pt);
  k.cyl(0.32, 0.32, 2.25, 8, 0.55, 2.05, 0, roll, 0, Math.PI / 2);
  const bow = new THREE.TorusGeometry(1.05, 0.045, 3, 8, Math.PI);
  for (const x of [-0.1, -1.6]) k.geo(bow, trs(x, 1.6, 0, 0, Math.PI / 2, 0), STEEL);
  const [bc, bt] = uniform();
  const [hc, ht] = uniform(0.75);
  const head = new THREE.SphereGeometry(0.15, 5, 3);
  const helmet = new THREE.SphereGeometry(0.2, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) {
      const x = -0.15 - i * 0.78;
      const z = side * 0.62;
      k.box(0.34, 0.55, 0.3, x, 1.6, z, bc, bt);
      k.geo(head, trs(x, 2.0, z * 0.97), PAL.skin);
      k.geo(helmet, trs(x, 2.03, z * 0.97), hc, ht);
    }
  }
  for (const side of [-1, 1]) k.box(0.05, 0.9, 0.05, -1.1, 2.0, side * 0.75, STEEL, 0, 0.15 * side);
  k.box(0.1, 0.5, 2.02, 0.75, 1.9, 0, ZERO, 1);
  return k.build();
}

/** Ammunition box (olive, stencilled lid) on the ground in gun-local space. */
function ammoBox(k: Kit, x: number, z: number, ry: number): void {
  k.box(0.6, 0.3, 0.35, x, 0.15, z, new THREE.Color('#5f6446'), 0, 0, ry);
  k.box(0.62, 0.03, 0.12, x, 0.31, z, new THREE.Color('#c9b98a'), 0, 0, ry);
}

/** Crew-served weapon, in turret-local space (it traverses as a whole). */
function crewGunGeo(id: string): THREE.BufferGeometry {
  const k = new Kit();
  const [pc, pt] = paint();
  const steel = STEEL;
  if (id === 'mg') {
    // Tripod-mounted MG: three legs, cradle, receiver, jacketed barrel, belt box.
    for (const [a, l] of [[0.0, 0.75], [2.3, 0.6], [-2.3, 0.6]] as const) {
      k.box(l, 0.05, 0.05, Math.cos(a) * l * 0.45, 0.22, Math.sin(a) * l * 0.45, steel, 0, 0, -a, Math.cos(a) * 0.45);
    }
    k.box(0.12, 0.25, 0.12, 0, 0.42, 0, steel);
    k.box(0.55, 0.14, 0.12, -0.25, 0.58, 0, new THREE.Color('#3a3934'));
    barrel(k.child(trs(-0.05, 0.6, 0)), 1.35, 0.06, steel, 0);
    k.rod(0.085, 0.55, 8, 0.4, 0.6, 0, steel);
    k.box(0.25, 0.25, 0.25, -0.2, 0.75, 0, ZERO, 1);
    ammoBox(k, -0.3, 0.55, 0.4);
  } else if (id === 'mortar') {
    // Baseplate, tube, bipod and sight, a crate of bombs.
    k.cyl(0.42, 0.45, 0.08, 8, 0, 0.04, 0, steel);
    barrel(k.child(trs(-0.2, 0.15, 0, 0, 0, 1.0)), 1.4, 0.09, steel, 0);
    for (const z of [-0.3, 0.3]) k.box(0.05, 0.85, 0.05, 0.42, 0.42, z, steel, 0, z * 0.6, 0, 0.35);
    k.box(0.12, 0.1, 0.18, 0.42, 0.82, 0, steel);
    k.box(0.1, 0.12, 0.08, 0.4, 0.95, 0.12, new THREE.Color('#2b2a26'));
    ammoBox(k, -0.7, 0.7, 0.2);
    for (let i = 0; i < 3; i++) k.rod(0.06, 0.35, 6, -0.6, 0.05, -0.6 + i * 0.15, new THREE.Color('#585a4c'));
  } else {
    const big = id === 'howitzer';
    const len = big ? 3.6 : 3.0;
    const wr = big ? 0.62 : 0.55;
    const wz = big ? 1.1 : 0.95;
    // Shield: two plates either side of the barrel and an upper plate, angled back.
    const sh = big ? 1.3 : 1.1;
    for (const side of [-1, 1]) k.box(0.08, sh, (big ? 2.2 : 1.9) * 0.42, 0.3, (big ? 1.0 : 0.85), side * (big ? 0.66 : 0.56), pc, pt, 0, 0, 0.12);
    k.box(0.08, sh * 0.3, 0.4, 0.3, (big ? 1.0 : 0.85) + sh * 0.36, 0, pc, pt, 0, 0, 0.12);
    // Cradle, recoil cylinder and barrel (howitzer elevated).
    const el = big ? 0.32 : 0;
    const gun = k.child(trs(0.2, big ? 1.05 : 0.8, 0, 0, 0, el));
    barrel(gun, len, big ? 0.14 : 0.08, pc, pt, !big);
    gun.rod(big ? 0.11 : 0.07, len * 0.45, 8, len * 0.2, -(big ? 0.2 : 0.13), 0, pc, pt);
    gun.box(0.9, 0.25, 0.3, -0.25, 0, 0, pc, pt);
    // Axle, spoked wheels, split trails with spades.
    k.wheel(0.06, wz * 2, 6, 0, wr, 0, steel);
    for (const side of [-1, 1]) {
      spokedWheel(k, wr, 0, wr, side * wz, PAL.track, pc, pt);
      k.box(2.4, 0.15, 0.15, -1.4, 0.25, side * 0.45, pc, pt, 0, side * 0.25);
      k.box(0.12, 0.4, 0.35, -2.55, 0.12, side * 0.75, steel, 0, 0, side * 0.25);
    }
    k.box(0.14, 0.25, (big ? 2.22 : 1.92) * 0.5, 0.32, big ? 1.5 : 1.25, 0, ZERO, 1);
    // Ready rounds: an open crate with shells beside the breech.
    ammoBox(k, -0.9, -1.25, 0.1);
    for (let i = 0; i < (big ? 3 : 2); i++) k.rod(big ? 0.09 : 0.06, big ? 0.7 : 0.55, 6, -0.4, 0.1, -1.6 - i * 0.2, new THREE.Color('#9a8450'));
  }
  return k.build();
}

export function vehicleGeometry(kind: string, id: string): THREE.BufferGeometry | null {
  switch (kind) {
    case 'hull': return tankHull(id);
    case 'turret': return tankTurret(id);
    case 'truck': return truckGeo();
    case 'troopTruck': return troopTruckGeo();
    case 'gun': return crewGunGeo(id);
    default: return null;
  }
}

