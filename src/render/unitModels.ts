import * as THREE from 'three';
import { GeoBuilder, trs } from './instancing';
import { PAL } from './palette';

/**
 * Merged, vertex-coloured unit geometries for instancing. Local +x is forward. Visual scale is
 * exaggerated (VISUAL_UX §2.1) — collision/range rules are unaffected. Faction colour arrives
 * as the per-instance colour; painted parts carry a tint weight (see GeoBuilder.paint).
 */
export const SOLDIER_SCALE = 2.9;
export const VEHICLE_SCALE = 1.75;
/** Crew-served guns (mg, at_gun, mortar, howitzer, aa); crew slots scale with the gun. */
export const GUN_SCALE = 1.4;

const PAINT_K = 0.28;
const UNIFORM_K = 0.35;
const UNIFORM_BASE = new THREE.Color('#6b6a52');
const RECON_GREEN = new THREE.Color('#5c6b45');

const BOX = new THREE.BoxGeometry(1, 1, 1);
const cylCache = new Map<string, THREE.BufferGeometry>();
function cylGeo(rt: number, rb: number, seg: number, open = false, thetaLen = Math.PI * 2): THREE.BufferGeometry {
  const key = `${rt},${rb},${seg},${open},${thetaLen}`;
  let g = cylCache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(rt, rb, 1, seg, 1, open, 0, thetaLen);
    cylCache.set(key, g);
  }
  return g;
}
const HEAD = new THREE.SphereGeometry(0.15, 6, 4);
const HELMET = new THREE.SphereGeometry(0.2, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
const DOME = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);

const ZERO = new THREE.Color(0, 0, 0);

/** Thin wrapper adding convenience primitives in a parent transform. */
class Kit {
  constructor(private readonly base = new THREE.Matrix4(), readonly b = new GeoBuilder()) {}

  private at(m: THREE.Matrix4): THREE.Matrix4 {
    return this.base.clone().multiply(m);
  }

  child(m: THREE.Matrix4): Kit {
    return new Kit(this.at(m), this.b);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, tint = 0, rx = 0, ry = 0, rz = 0): void {
    this.b.add(BOX, this.at(trs(x, y, z, rx, ry, rz, w, h, d)), c, tint);
  }

  /** Cylinder along local Y unless rotated. */
  cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, c: THREE.Color, tint = 0, rx = 0, ry = 0, rz = 0): void {
    this.b.add(cylGeo(rt, rb, seg), this.at(trs(x, y, z, rx, ry, rz, 1, h, 1)), c, tint);
  }

  geo(g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color, tint = 0): void {
    this.b.add(g, this.at(m), c, tint);
  }
}

/** Painted colour helpers: return [baseColour, tint] for a faction-tinted part. */
function paint(shade = 1): [THREE.Color, number] {
  return [PAL.olive.clone().multiplyScalar((1 - PAINT_K) * shade), PAINT_K * shade];
}
function uniform(shade = 1, recon = false): [THREE.Color, number] {
  if (!recon) return [UNIFORM_BASE.clone().multiplyScalar((1 - UNIFORM_K) * shade), UNIFORM_K * shade];
  // factionUniform(F).lerp(green, .35) = (.65·.65·base + .35·green) + .65·.35·F
  const c = UNIFORM_BASE.clone().multiplyScalar(0.65 * 0.65).add(RECON_GREEN.clone().multiplyScalar(0.35)).multiplyScalar(shade);
  return [c, 0.65 * UNIFORM_K * shade];
}

function soldierGeo(kneel: boolean, recon: boolean): THREE.BufferGeometry {
  const k = new Kit();
  const [legC, legT] = uniform(0.8, recon);
  const [bodyC, bodyT] = uniform(1, recon);
  const [helC, helT] = uniform(0.75, recon);
  const y = kneel ? -0.3 : 0;
  if (kneel) k.box(0.28, 0.44, 0.34, 0, 0.22, 0, legC, legT);
  else k.box(0.28, 0.8, 0.34, 0, 0.4, 0, legC, legT);
  k.box(0.32, 0.62, 0.46, 0, 1.1 + y, 0, bodyC, bodyT);
  k.geo(HEAD, trs(0, 1.55 + y, 0), PAL.skin);
  k.geo(HELMET, trs(0, 1.58 + y, 0), helC, helT);
  k.box(0.9, 0.06, 0.06, 0.25, 1.15 + y, 0.22, PAL.steel, 0, 0, 0, 0.25);
  return k.b.build();
}

function barrel(k: Kit, len: number, r: number, c: THREE.Color, t: number, brake = false): void {
  // Barrel along +x from the kit origin.
  k.cyl(r, r * 1.1, len, 8, len / 2, 0, 0, c, t, 0, 0, -Math.PI / 2);
  if (brake) k.cyl(r * 1.9, r * 1.9, len * 0.08, 8, len, 0, 0, c, t, 0, 0, -Math.PI / 2);
}

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

function tracks(k: Kit, len: number, width: number, h: number): void {
  const wheel = new THREE.Color('#3f3d38');
  for (const side of [-1, 1]) {
    k.box(len, h, 0.55, 0, h / 2, side * (width / 2 - 0.27), PAL.track);
    const n = Math.max(3, Math.round(len / 1.1));
    for (let i = 0; i < n; i++) {
      k.cyl(h * 0.38, h * 0.38, 0.12, 8, -len / 2 + (len * (i + 0.5)) / n, h * 0.42, side * (width / 2 + 0.02), wheel, 0, Math.PI / 2);
    }
  }
}

export function tankDeckY(s: TankSpec): number {
  return s.trackH + s.hullH - 0.15;
}

function tankHull(id: string): THREE.BufferGeometry {
  const s = TANKS[id];
  const k = new Kit();
  tracks(k, s.len, s.width, s.trackH);
  const [pc, pt] = paint();
  k.box(s.len * 0.92, s.hullH, s.width * 0.82, 0, s.trackH + s.hullH / 2 - 0.15, 0, pc, pt);
  if (s.slope) k.box(1.3, 0.12, s.width * 0.8, s.len * 0.42, s.trackH + s.hullH * 0.6, 0, pc, pt, 0, 0, -0.75);
  const [dc, dt] = paint(0.85);
  k.box(1.2, 0.18, s.width * 0.7, -s.len * 0.35, tankDeckY(s) + 0.08, 0, dc, dt);
  return k.b.build();
}

/** Turret geometry in turret-local space (origin on the deck at the turret ring). */
function tankTurret(id: string): THREE.BufferGeometry {
  const s = TANKS[id];
  const k = new Kit();
  const [pc, pt] = paint();
  if (s.round) k.geo(DOME, trs(0, 0, 0, 0, 0, 0, s.turretL / 2, s.turretH * 1.15, s.turretW / 2), pc, pt);
  else k.box(s.turretL, s.turretH, s.turretW, 0, s.turretH / 2, 0, pc, pt);
  k.box(s.turretL * 0.6, 0.18, s.turretW + 0.04, -0.1, s.turretH * 0.55, 0, ZERO, 1);
  k.cyl(0.3, 0.32, 0.25, 8, -s.turretL * 0.2, s.turretH + 0.1, -s.turretW * 0.2, pc, pt);
  const [bc, bt] = paint(0.9);
  barrel(k.child(trs(s.turretL / 2 - 0.1, s.turretH * 0.5, 0)), s.barrel, s.barrelR, bc, bt, s.brake);
  return k.b.build();
}

function truckGeo(): THREE.BufferGeometry {
  const k = new Kit();
  const [pc, pt] = paint();
  const canvas = new THREE.Color('#8d8a68');
  k.box(5.6, 0.35, 2.1, 0, 0.9, 0, PAL.steel);
  k.box(1.6, 1.3, 2.0, 1.8, 1.7, 0, pc, pt);
  k.box(0.8, 0.8, 1.9, 2.8, 1.4, 0, pc, pt);
  k.box(3.4, 0.6, 2.2, -1.0, 1.35, 0, pc, pt);
  // Half-cylinder tarp, axis along x.
  k.geo(cylGeo(1.1, 1.1, 10, false, Math.PI), trs(-1.0, 1.65, 0, 0, 0, Math.PI / 2, 1, 3.3, 1), canvas);
  for (const x of [2.2, -0.6, -1.9]) for (const side of [-1, 1]) k.cyl(0.5, 0.5, 0.35, 10, x, 0.5, side * 1.05, PAL.track, 0, Math.PI / 2);
  k.box(0.1, 0.5, 2.02, 1.0, 1.9, 0, ZERO, 1);
  return k.b.build();
}

/** Crew-served weapon, in turret-local space (it traverses as a whole). */
function crewGunGeo(id: string): THREE.BufferGeometry {
  const k = new Kit();
  const [pc, pt] = paint();
  const steel = PAL.steel;
  if (id === 'mg') {
    k.box(0.9, 0.12, 0.9, 0, 0.35, 0, steel);
    barrel(k.child(trs(-0.3, 0.55, 0)), 1.6, 0.06, steel, 0);
    k.box(0.25, 0.25, 0.25, -0.2, 0.7, 0, ZERO, 1);
  } else if (id === 'mortar') {
    k.box(0.8, 0.1, 0.8, 0, 0.05, 0, steel);
    barrel(k.child(trs(-0.2, 0.15, 0, 0, 0, 1.0)), 1.4, 0.09, steel, 0);
  } else if (id === 'aa') {
    k.cyl(1.0, 1.2, 0.4, 10, 0, 0, 0, pc, pt);
    k.box(0.9, 0.7, 1.2, 0, 0.9, 0, pc, pt);
    barrel(k.child(trs(0, 0.9, 0, 0, 0, 0.7)), 3.0, 0.08, steel, 0, true);
    k.box(0.5, 0.15, 1.25, 0, 1.15, 0, ZERO, 1);
  } else {
    const big = id === 'howitzer';
    const len = big ? 3.6 : 3.0;
    k.box(0.12, big ? 1.3 : 1.1, big ? 2.2 : 1.9, 0.3, big ? 1.0 : 0.85, 0, pc, pt);
    barrel(k.child(trs(0.2, big ? 1.05 : 0.8, 0, 0, 0, big ? 0.32 : 0)), len, big ? 0.14 : 0.08, pc, pt, !big);
    for (const side of [-1, 1]) {
      k.cyl(0.55, 0.55, 0.2, 10, 0, 0.55, side * (big ? 1.1 : 0.95), PAL.track, 0, Math.PI / 2);
      k.box(2.4, 0.15, 0.15, -1.4, 0.25, side * 0.45, pc, pt, 0, side * 0.25);
    }
    k.box(0.14, 0.25, big ? 2.22 : 1.92, 0.32, big ? 1.5 : 1.25, 0, ZERO, 1);
  }
  return k.b.build();
}

function bunkerGeo(): THREE.BufferGeometry {
  const k = new Kit();
  const concrete = new THREE.Color('#a29d8d');
  const sand = new THREE.Color('#b9a77c');
  k.box(6, 2.2, 6, 0, 1.1, 0, concrete);
  k.box(6.6, 0.5, 6.6, 0, 2.35, 0, concrete);
  k.box(0.2, 0.35, 3.6, 3.02, 1.5, 0, new THREE.Color('#1d1d1b'));
  for (let i = 0; i < 9; i++) {
    const a = -1.3 + (i / 8) * 2.6;
    k.box(1.4, 0.7, 0.9, Math.cos(a) * 5, 0.35, Math.sin(a) * 5, sand, 0, 0, -a);
  }
  k.box(0.6, 0.6, 0.6, 0, 2.9, 0, ZERO, 1);
  barrel(k.child(trs(2.9, 1.5, 0)), 1.3, 0.07, PAL.steel, 0);
  return k.b.build();
}

const cache = new Map<string, THREE.BufferGeometry>();

/** Geometry by key: soldier | soldierKneel | soldierRecon | hull:<tank> | turret:<tank> | truck | gun:<id> | bunker. */
export function unitGeometry(key: string): THREE.BufferGeometry {
  let g = cache.get(key);
  if (g) return g;
  const [a, b] = key.split(':');
  switch (a) {
    case 'soldier': g = soldierGeo(false, false); break;
    case 'soldierKneel': g = soldierGeo(true, false); break;
    case 'soldierRecon': g = soldierGeo(false, true); break;
    case 'hull': g = tankHull(b); break;
    case 'turret': g = tankTurret(b); break;
    case 'truck': g = truckGeo(); break;
    case 'gun': g = crewGunGeo(b); break;
    case 'bunker': g = bunkerGeo(); break;
    default: throw new Error(`unknown unit geometry ${key}`);
  }
  cache.set(key, g);
  return g;
}

/** How a unit type is assembled from instanced parts. */
export interface ModelSpec {
  /** Body geometry key (null = squad of soldiers only). */
  readonly body: string | null;
  /** Rotating part geometry key and its pivot in body-local space (pre-scale). */
  readonly turret: string | null;
  readonly pivot: [number, number, number];
  readonly scale: number;
  readonly vehicle: boolean;
  /** Crew positions in turret-local space ([x, z, kneel]). */
  readonly crew: [number, number, boolean][];
  readonly soldier: 'soldier' | 'soldierRecon';
  /** Leaves a wreck when destroyed. */
  readonly wreck: boolean;
  /** Counter height above ground (m). */
  readonly top: number;
}

const CREW_SPOTS: [number, number, boolean][] = [[-1.4, 1.2, true], [-1.6, -1.1, false], [-2.6, 0.4, true], [-0.6, -1.8, false], [-2.8, -1.4, true]];

export function modelSpec(unitType: string, fixed: boolean): ModelSpec {
  const base = { pivot: [0, 0, 0] as [number, number, number], scale: 1, vehicle: false, crew: [], soldier: 'soldier' as const, wreck: false, top: 7 };
  if (fixed) return { ...base, body: 'bunker', turret: null, wreck: true, top: 8 };
  switch (unitType) {
    case 'light_tank': case 'medium_tank': case 'heavy_tank': {
      const s = TANKS[unitType];
      return { ...base, body: `hull:${unitType}`, turret: `turret:${unitType}`, pivot: [s.turretX, tankDeckY(s), 0], scale: VEHICLE_SCALE, vehicle: true, wreck: true, top: 9 };
    }
    case 'supply_truck':
      return { ...base, body: 'truck', turret: null, scale: VEHICLE_SCALE, vehicle: true, wreck: true, top: 9 };
    case 'mg': case 'at_gun': case 'mortar': case 'howitzer': case 'aa':
      return { ...base, body: null, turret: `gun:${unitType}`, scale: GUN_SCALE, crew: CREW_SPOTS.slice(0, unitType === 'howitzer' ? 5 : 4), wreck: true, top: 8 };
    default:
      return { ...base, body: null, turret: null, soldier: unitType === 'recon' ? 'soldierRecon' : 'soldier' };
  }
}

/** Sim muzzle point ([forward, up] m from the unit origin) — mirrors sim/combat muzzlePos. */
const SIM_MUZZLE = { vehicle: [3, 2.4], crew: [0.5, 1.3] } as const;

/** Barrel tip [forward, up] of a crew gun in model space: barrel origin, elevation, length. */
const GUN_TIPS: Record<string, [number, number, number, number]> = {
  at_gun: [0.2, 0.8, 0, 3.0],
  howitzer: [0.2, 1.05, 0.32, 3.6],
  mortar: [-0.2, 0.15, 1.0, 1.4],
};

const WEAPON_MOUNT: Record<string, string> = {
  light_cannon: 'light_tank', medium_cannon: 'medium_tank', heavy_cannon: 'heavy_tank',
  at_cannon: 'at_gun', howitzer_shell: 'howitzer', mortar_shell: 'mortar',
};

const shiftCache = new Map<string, [number, number] | null>();

/**
 * How far the visible barrel tip sits from the sim's muzzle point ([forward, up] m), so muzzle
 * flashes leave the (exaggerated) model's barrel instead of its hull. Null = no correction.
 */
export function muzzleShift(weapon: string): [number, number] | null {
  if (shiftCache.has(weapon)) return shiftCache.get(weapon)!;
  const mount = WEAPON_MOUNT[weapon];
  let out: [number, number] | null = null;
  const tank = mount ? TANKS[mount] : undefined;
  if (tank) {
    const fwd = (tank.turretX + tank.turretL / 2 - 0.1 + tank.barrel) * VEHICLE_SCALE;
    const up = (tankDeckY(tank) + tank.turretH * 0.5) * VEHICLE_SCALE;
    out = [fwd - SIM_MUZZLE.vehicle[0], up - SIM_MUZZLE.vehicle[1]];
  } else if (mount && GUN_TIPS[mount]) {
    const [x, y, el, len] = GUN_TIPS[mount];
    out = [(x + Math.cos(el) * len) * GUN_SCALE - SIM_MUZZLE.crew[0], (y + Math.sin(el) * len) * GUN_SCALE - SIM_MUZZLE.crew[1]];
  }
  shiftCache.set(weapon, out);
  return out;
}
