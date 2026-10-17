import * as THREE from 'three';
import { armourLevel, gunLevel } from '../sim/upgradestats';
import type { Unit } from '../sim/types';
import { trs, type InstanceBatch } from './instancing';
import { writeTilted } from './unitMatrices';
import { Kit, paint } from './modelKit';
import { TANKS } from './vehicleModels';

/**
 * 3.0 upgrade visuals (V30_SPEC §9): one unit-sized geometry per visual, so each adds at most one
 * instanced mesh whatever the tank class. Placed per instance by a local matrix scaled to the
 * class (`skirtLocal`, `barrelLocal`): side skirts for tank armour, a barrel extension with a
 * muzzle brake for the tank gun. The infantry gun team reuses the anti-tank gun model.
 */

const DARK = new THREE.Color('#2f2e2a');

/** Two side plates at z = ±1 (unit length along x, unit height), with a top rail. */
function skirtGeo(): THREE.BufferGeometry {
  const k = new Kit();
  const [pc, pt] = paint(0.92);
  for (const side of [-1, 1]) {
    k.box(1, 1, 0.05, 0, 0, side, pc, pt);
    k.box(1.01, 0.08, 0.07, 0, 0.5, side, DARK);
    // Plate seams: the skirts hang in sections.
    for (const x of [-0.25, 0, 0.25]) k.box(0.012, 0.95, 0.06, x, 0, side, DARK);
  }
  return k.build();
}

/** Barrel extension along +x from 0 to 1 (radius 1) with a muzzle brake. */
function barrelGeo(): THREE.BufferGeometry {
  const k = new Kit();
  const [bc, bt] = paint(0.9);
  k.rod(1, 1, 8, 0.5, 0, 0, bc, bt, 1.05);
  k.rod(1.7, 0.1, 8, 0.95, 0, 0, bc, bt);
  return k.build();
}

/** Attached gun team: distance behind the squad centre (m) and model scale. */
const GUN_TEAM_BACK = 7;
const GUN_TEAM_SCALE = 1.0;
const _m = new THREE.Matrix4();

type BatchOf = (key: string) => InstanceBatch;

/** Tank upgrades on a hull / turret already placed: side skirts (armour), a longer gun (gun). */
export function drawTankUpgrades(batch: BatchOf, u: Unit, body: THREE.Matrix4, turret: THREE.Matrix4, color: THREE.Color): void {
  const skirt = skirtLocal(u.def.id, armourLevel(u.upg));
  if (skirt) batch('upg:skirts').push(_m.multiplyMatrices(body, skirt), color);
  const ext = barrelLocal(u.def.id, gunLevel(u.upg));
  if (ext) batch('upg:barrel').push(_m.multiplyMatrices(turret, ext), color);
}

/** Attached gun team: an infantry gun (the anti-tank gun model) trailing the squad. */
export function drawGunTeam(batch: BatchOf, x0: number, z0: number, heading: number, ground: (x: number, z: number) => number, color: THREE.Color): void {
  const x = x0 - Math.cos(heading) * GUN_TEAM_BACK;
  const z = z0 - Math.sin(heading) * GUN_TEAM_BACK;
  writeTilted(_m.elements, 0, x, ground(x, z), z, heading, 0, 0, GUN_TEAM_SCALE);
  batch('gun:at_gun').push(_m, color);
}

export function upgradeGeometry(id: string): THREE.BufferGeometry | null {
  if (id === 'skirts') return skirtGeo();
  if (id === 'barrel') return barrelGeo();
  return null;
}

const skirtCache = new Map<string, THREE.Matrix4>();
const barrelCache = new Map<string, THREE.Matrix4>();

/** Hull-local placement of the skirts for a tank class and armour level (null: not a tank). */
export function skirtLocal(unitId: string, level: number): THREE.Matrix4 | null {
  const s = TANKS[unitId];
  if (!s || level <= 0) return null;
  const key = `${unitId}|${level}`;
  let m = skirtCache.get(key);
  if (!m) {
    const h = s.trackH * (0.62 + 0.08 * level);
    m = trs(0, s.trackH * 0.98 - h / 2, 0, 0, 0, 0, s.len * 0.82, h, s.width / 2 + 0.05);
    skirtCache.set(key, m);
  }
  return m;
}

/** Turret-local placement of the barrel extension for a tank class and gun level. */
export function barrelLocal(unitId: string, level: number): THREE.Matrix4 | null {
  const s = TANKS[unitId];
  if (!s || level <= 0) return null;
  const key = `${unitId}|${level}`;
  let m = barrelCache.get(key);
  if (!m) {
    m = trs(s.turretL / 2 - 0.1 + s.barrel * 0.98, s.turretH * 0.5, 0, 0, 0, 0, s.barrel * 0.14 * level, s.barrelR, s.barrelR);
    barrelCache.set(key, m);
  }
  return m;
}
