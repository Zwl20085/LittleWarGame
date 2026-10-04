import * as THREE from 'three';
import { trs } from './instancing';
import { barrel, Kit, ZERO } from './modelKit';
import { PAL } from './palette';
import { soldierGeometry, staffGeo, type SoldierKey } from './soldierModels';
import { tankDeckY, TANKS, vehicleGeometry } from './vehicleModels';

/**
 * Unit geometry registry and model specs. Merged, vertex-coloured geometries for instancing
 * (soldierModels / vehicleModels build them); local +x is forward. Visual scale is exaggerated
 * (VISUAL_UX §2.1) — collision/range rules are unaffected. Faction colour arrives as the
 * per-instance colour; painted parts carry a tint weight (see GeoBuilder.paint).
 */
export const SOLDIER_SCALE = 2.9;
export const VEHICLE_SCALE = 1.75;
/** Crew-served guns (mg, at_gun, mortar, howitzer); crew slots scale with the gun. */
export const GUN_SCALE = 1.4;

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
  return k.build();
}

const cache = new Map<string, THREE.BufferGeometry>();

const SOLDIER_KEYS: ReadonlySet<string> = new Set<SoldierKey>(['soldier', 'soldierKneel', 'soldierRecon', 'soldierMG', 'soldierOfficer', 'soldierEngineer']);

/**
 * Geometry by key: soldier | soldierKneel | soldierRecon | soldierMG | soldierOfficer |
 * soldierEngineer | hull:<tank> | turret:<tank> | truck | troopTruck | gun:<id> | bunker | staff.
 */
export function unitGeometry(key: string): THREE.BufferGeometry {
  let g = cache.get(key);
  if (g) return g;
  const [a, b] = key.split(':');
  if (SOLDIER_KEYS.has(a)) g = soldierGeometry(a as SoldierKey);
  else if (a === 'bunker') g = bunkerGeo();
  else if (a === 'staff') g = staffGeo();
  else g = vehicleGeometry(a, b) ?? undefined;
  if (!g) throw new Error(`unknown unit geometry ${key}`);
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
  readonly soldier: 'soldier' | 'soldierRecon' | 'soldierEngineer';
  /** Squad member 0 (the leader) and member 1 (the LMG gunner) geometry, when distinct. */
  readonly leader: SoldierKey | null;
  readonly gunner: SoldierKey | null;
  /** Leaves a wreck when destroyed. */
  readonly wreck: boolean;
  /** Counter height above ground (m). */
  readonly top: number;
  /** Ground footprint half-extents [along, across] in model units (tilt samples, contact blob). */
  readonly foot: [number, number];
  /** Rests on the ground as a rigid body: pitched and rolled to the local slope. */
  readonly tilt: boolean;
}

/** Supply / troop truck footprint (model units). */
export const TRUCK_FOOT: [number, number] = [2.9, 1.1];
const GUN_FOOT: Record<string, [number, number]> = { mg: [0.8, 0.5], mortar: [0.6, 0.6], at_gun: [1.9, 1.0], howitzer: [2.3, 1.2] };

const CREW_SPOTS: [number, number, boolean][] = [[-1.4, 1.2, true], [-1.6, -1.1, false], [-2.6, 0.4, true], [-0.6, -1.8, false], [-2.8, -1.4, true]];

const specCache = new Map<string, ModelSpec>();

/** Model spec per unit type (shared, read-only: views of one type share one object). */
export function modelSpec(unitType: string, fixed: boolean): ModelSpec {
  const key = fixed ? `fixed:${unitType}` : unitType;
  let spec = specCache.get(key);
  if (!spec) {
    spec = buildSpec(unitType, fixed);
    specCache.set(key, spec);
  }
  return spec;
}

function buildSpec(unitType: string, fixed: boolean): ModelSpec {
  const base = { pivot: [0, 0, 0] as [number, number, number], scale: 1, vehicle: false, crew: [], soldier: 'soldier' as 'soldier' | 'soldierRecon' | 'soldierEngineer', leader: null as SoldierKey | null, gunner: null as SoldierKey | null, wreck: false, top: 7, foot: [0, 0] as [number, number], tilt: false };
  if (fixed) return { ...base, body: 'bunker', turret: null, wreck: true, top: 8, foot: [3.4, 3.4] };
  switch (unitType) {
    case 'light_tank': case 'medium_tank': case 'heavy_tank': {
      const s = TANKS[unitType];
      return { ...base, body: `hull:${unitType}`, turret: `turret:${unitType}`, pivot: [s.turretX, tankDeckY(s), 0], scale: VEHICLE_SCALE, vehicle: true, wreck: true, top: 9, foot: [s.len / 2, s.width / 2], tilt: true };
    }
    case 'supply_truck':
      return { ...base, body: 'truck', turret: null, scale: VEHICLE_SCALE, vehicle: true, wreck: true, top: 9, foot: TRUCK_FOOT, tilt: true };
    case 'commander':
      // Staff group drawn as one turret-space part so it faces where the commander looks; no crew
      // slots (the four figures are in the geometry); it falls as a squad when killed.
      return { ...base, body: null, turret: 'staff', scale: SOLDIER_SCALE, foot: [1.6, 1.4] };
    case 'mg': case 'at_gun': case 'mortar': case 'howitzer':
      return { ...base, body: null, turret: `gun:${unitType}`, scale: GUN_SCALE, crew: CREW_SPOTS.slice(0, unitType === 'howitzer' ? 5 : 4), wreck: true, top: 8, foot: GUN_FOOT[unitType], tilt: true };
    case 'recon':
      return { ...base, body: null, turret: null, soldier: 'soldierRecon', leader: 'soldierOfficer' };
    case 'engineer':
      return { ...base, body: null, turret: null, soldier: 'soldierEngineer', leader: 'soldierOfficer' };
    default:
      // Rifle squads: a leader with cap and binoculars, an LMG gunner, riflemen.
      return { ...base, body: null, turret: null, soldier: 'soldier', leader: 'soldierOfficer', gunner: 'soldierMG' };
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
