import * as THREE from 'three';
import { trs } from './instancing';
import { Kit, sphereGeo, uniform, ZERO, cylGeo } from './modelKit';
import { PAL } from './palette';

/**
 * Soldier figures (model units = metres before SOLDIER_SCALE; +x forward). Each stays under
 * ~150 triangles: legs that the soldier shader swings while walking, torso, arms holding the
 * weapon, head and helmet, and role kit — riflemen carry a pack with a bedroll and a canteen,
 * the squad's MG gunner a bipod LMG, the leader a peaked cap, binoculars and map case,
 * engineers a tool pack with a shovel, recon light kit with a field cap and binoculars.
 */

export type SoldierKey = 'soldier' | 'soldierKneel' | 'soldierRecon' | 'soldierMG' | 'soldierOfficer' | 'soldierEngineer';

const HEAD = sphereGeo(0.14, 5, 3);
const HELMET = sphereGeo(0.19, 6, 2, true);
const RIFLE = new THREE.Color('#4a453b');
const WEBBING = new THREE.Color('#7a7155');
const BLANKET = new THREE.Color('#6f6a5e');
const LEATHER = new THREE.Color('#5a4330');
const STEEL = PAL.steel;

/** Legs (standing, swinging) or a kneeling lower body; returns the torso height. */
function lowerBody(k: Kit, kneel: boolean, recon: boolean): number {
  const [legC, legT] = uniform(0.8, recon);
  if (!kneel) {
    k.box(0.26, 0.8, 0.15, 0, 0.4, -0.09, legC, legT, 0, 0, 0, 1);
    k.box(0.26, 0.8, 0.15, 0, 0.4, 0.09, legC, legT, 0, 0, 0, -1);
    return 1.1;
  }
  // Right knee down (shin back along the ground), left foot planted with the shin upright.
  k.box(0.15, 0.42, 0.15, -0.02, 0.3, 0.09, legC, legT);
  k.box(0.44, 0.14, 0.14, -0.22, 0.07, 0.09, legC, legT);
  k.box(0.4, 0.15, 0.15, 0.13, 0.5, -0.1, legC, legT);
  k.box(0.15, 0.46, 0.15, 0.3, 0.23, -0.1, legC, legT);
  return 0.82;
}

function torso(k: Kit, y: number, recon: boolean): void {
  const [bodyC, bodyT] = uniform(1, recon);
  k.box(0.3, 0.6, 0.44, 0, y, 0, bodyC, bodyT);
}

/** Arms forward holding a long arm across the body (port arms / ready). */
function armsHolding(k: Kit, y: number, recon: boolean): void {
  const [c, t] = uniform(0.92, recon);
  k.box(0.11, 0.5, 0.11, 0.1, y + 0.08, 0.25, c, t, 0, 0, -0.75);
  k.box(0.11, 0.5, 0.11, 0.16, y + 0.1, -0.2, c, t, 0.35, 0, -1.0);
}

function head(k: Kit, y: number, recon: boolean, helmet = true): void {
  k.geo(HEAD, trs(0, y + 0.45, 0), PAL.skin);
  if (helmet) {
    const [hc, ht] = uniform(0.75, recon);
    k.geo(HELMET, trs(0, y + 0.48, 0, 0, 0, 0, 1, 0.9, 1), hc, ht);
  }
}

function rifle(k: Kit, y: number, long = 0.95): void {
  k.box(long, 0.055, 0.055, 0.27, y + 0.05, 0.03, RIFLE, 0, 0, 0, 0.3);
}

function makeSoldier(key: SoldierKey): THREE.BufferGeometry {
  const k = new Kit();
  k.b.withSwing();
  const kneel = key === 'soldierKneel';
  const recon = key === 'soldierRecon';
  const y = lowerBody(k, kneel, recon);
  torso(k, y, recon);
  switch (key) {
    case 'soldierRecon': {
      armsHolding(k, y, true);
      head(k, y, true, false);
      // Soft field cap with a short peak, binoculars on the chest, a carbine.
      const [cc, ct] = uniform(0.85, true);
      k.geo(cylGeo(0.15, 0.16, 6), trs(0, y + 0.6, 0, 0, 0, 0, 1, 0.12, 1), cc, ct);
      k.box(0.1, 0.03, 0.2, 0.15, y + 0.56, 0, cc, ct);
      k.box(0.08, 0.1, 0.18, 0.18, y + 0.15, 0, ZERO.clone().addScalar(0.12));
      rifle(k, y, 0.75);
      break;
    }
    case 'soldierMG': {
      armsHolding(k, y, false);
      head(k, y, false);
      // Light MG at the hip: receiver, barrel with the bipod folded under it, drum magazine.
      k.box(0.5, 0.11, 0.08, 0.18, y + 0.02, 0.05, RIFLE, 0, 0, 0, 0.12);
      k.box(0.6, 0.04, 0.04, 0.62, y + 0.08, 0.05, STEEL, 0, 0, 0, 0.12);
      k.box(0.4, 0.025, 0.12, 0.55, y + 0.02, 0.05, STEEL, 0, 0, 0, 0.12);
      k.box(0.14, 0.14, 0.14, 0.12, y + 0.12, -0.04, STEEL);
      break;
    }
    case 'soldierOfficer': {
      // One arm forward (pointing the way), the other at the map case; peaked cap, binoculars.
      const [c, t] = uniform(0.95);
      k.box(0.11, 0.5, 0.11, 0.24, y + 0.18, 0.25, c, t, 0, 0, -1.3);
      k.box(0.11, 0.48, 0.11, 0.02, y - 0.05, -0.25, c, t);
      head(k, y, false, false);
      const [cc, ct] = uniform(1.15);
      k.geo(cylGeo(0.19, 0.15, 6), trs(0, y + 0.6, 0, 0, 0, 0, 1, 0.12, 1), cc, ct);
      k.box(0.12, 0.03, 0.26, 0.15, y + 0.54, 0, new THREE.Color('#2b2925'));
      k.box(0.08, 0.1, 0.18, 0.18, y + 0.15, 0, new THREE.Color('#1f1f1d'));
      k.box(0.06, 0.24, 0.28, 0.0, y - 0.22, -0.28, LEATHER);
      break;
    }
    case 'soldierEngineer': {
      armsHolding(k, y, false);
      head(k, y, false);
      rifle(k, y, 0.8);
      // Tool pack with a shovel strapped on, wire cutters on the belt.
      k.box(0.2, 0.36, 0.38, -0.25, y + 0.05, 0, WEBBING);
      k.box(0.05, 0.75, 0.05, -0.37, y + 0.15, 0.08, new THREE.Color('#6b5639'), 0, 0.25);
      k.box(0.03, 0.2, 0.16, -0.38, y + 0.55, 0.13, STEEL, 0, 0.25);
      break;
    }
    default: {
      // Rifleman (standing or kneeling): pack, bedroll on top, canteen on the hip (standing).
      armsHolding(k, y, false);
      head(k, y, false);
      rifle(k, y);
      k.box(0.18, 0.32, 0.34, -0.24, y + 0.06, 0, WEBBING);
      if (!kneel) {
        k.box(0.14, 0.14, 0.46, -0.25, y + 0.29, 0, BLANKET);
        k.box(0.08, 0.16, 0.1, -0.05, y - 0.26, 0.24, WEBBING);
      }
    }
  }
  return k.build();
}

const cache = new Map<SoldierKey, THREE.BufferGeometry>();

export function soldierGeometry(key: SoldierKey): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) cache.set(key, (g = makeSoldier(key)));
  return g;
}

/** Two-sided triangular pennant in the XY plane: hoist edge x = 0 (y 0..1), tip at (1, 0.5). */
function pennantGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0.5, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0.5, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1], 3));
  return g;
}

const PEAKED_CAP = new THREE.CylinderGeometry(0.19, 0.15, 0.1, 10);
const STAFF_HEAD = new THREE.SphereGeometry(0.15, 6, 4);
const STAFF_HELMET = new THREE.SphereGeometry(0.2, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);

/** One standing figure of the staff group (soldier units, local +x forward). */
function staffFigure(k: Kit, cap: boolean, shade = 1): void {
  const [legC, legT] = uniform(0.8 * shade);
  const [bodyC, bodyT] = uniform(shade);
  for (const z of [-0.09, 0.09]) k.box(0.26, 0.8, 0.15, 0, 0.4, z, legC, legT);
  k.box(0.32, 0.62, 0.46, 0, 1.1, 0, bodyC, bodyT);
  k.geo(STAFF_HEAD, trs(0, 1.55, 0), PAL.skin);
  if (cap) {
    // Officer's peaked service cap: crown in the faction tint, dark band and visor.
    const [cc, ct] = uniform(1.15);
    k.geo(PEAKED_CAP, trs(0, 1.69, 0), cc, ct);
    k.box(0.12, 0.03, 0.26, 0.15, 1.64, 0, new THREE.Color('#2b2925'));
  } else {
    const [hc, ht] = uniform(0.75);
    k.geo(STAFF_HELMET, trs(0, 1.58, 0), hc, ht);
  }
}

/**
 * Front commander's staff group (VISUAL_UX §2.1, 2.0): the officer with peaked cap, map case
 * and an open map; a kneeling radio operator with a backpack set and whip antenna; two guards
 * with slung rifles; a small HQ pennant on a pole in the faction colour. 2.1 adds a folding map
 * table with a lamp and a field telephone. Soldier-sized: the spec scales it by SOLDIER_SCALE.
 */
export function staffGeo(): THREE.BufferGeometry {
  const k = new Kit();
  const leather = LEATHER;
  const paper = new THREE.Color('#e6dcc0');
  const radio = new THREE.Color('#4d5040');
  const wood = new THREE.Color('#6b5639');
  // Officer, a little forward, looking over the map in his hands.
  const off = k.child(trs(0.45, 0, 0.1));
  staffFigure(off, true, 1.05);
  const [armC, armT] = uniform(1.05);
  off.box(0.06, 0.24, 0.3, 0.02, 0.92, 0.27, leather);
  off.box(0.36, 0.025, 0.46, 0.32, 1.22, 0, paper, 0, 0, 0, -0.5);
  off.box(0.28, 0.08, 0.08, 0.2, 1.18, -0.2, armC, armT);
  off.box(0.28, 0.08, 0.08, 0.2, 1.18, 0.2, armC, armT);
  // Radio operator, kneeling at the officer's side with the set on his back.
  const rad = k.child(trs(-0.35, 0, 0.75, 0, 0.5, 0));
  const [legC, legT] = uniform(0.8);
  const [bodyC, bodyT] = uniform(1);
  const [hc, ht] = uniform(0.75);
  rad.box(0.28, 0.44, 0.34, 0, 0.22, 0, legC, legT);
  rad.box(0.32, 0.62, 0.46, 0, 0.8, 0, bodyC, bodyT);
  rad.geo(STAFF_HEAD, trs(0.02, 1.25, 0), PAL.skin);
  rad.geo(STAFF_HELMET, trs(0.02, 1.28, 0), hc, ht);
  rad.box(0.24, 0.5, 0.38, -0.3, 0.85, 0, radio);
  rad.box(0.06, 0.08, 0.3, -0.18, 1.12, 0, PAL.steel);
  rad.cyl(0.012, 0.018, 2.4, 4, -0.42, 2.25, 0.12, PAL.steel, 0, 0, 0, 0.12);
  rad.box(0.06, 0.16, 0.06, 0.12, 1.18, 0.16, new THREE.Color('#222220'));
  // Two guards on either flank, rifles slung across the chest.
  for (const [x, z, yaw] of [[1.5, -1.0, -0.5], [-1.3, -1.15, 2.6]] as const) {
    const g = k.child(trs(x, 0, z, 0, yaw, 0));
    staffFigure(g, false);
    g.box(0.9, 0.06, 0.06, 0.2, 1.15, 0.2, PAL.steel, 0, 0.35, 0, 0.35);
  }
  // Folding map table behind the officer: top with a spread map, X legs, a lamp and a telephone.
  const tb = k.child(trs(-0.2, 0, -0.6, 0, 0.2, 0));
  tb.box(0.9, 0.05, 0.6, 0, 0.78, 0, wood);
  tb.box(0.8, 0.012, 0.5, 0, 0.81, 0, paper);
  for (const s of [-1, 1]) tb.box(0.05, 0.85, 0.05, s * 0.36, 0.38, 0, wood, 0, 0, 0, s * 0.35);
  tb.box(0.12, 0.08, 0.1, 0.3, 0.86, 0.18, new THREE.Color('#2d2f2a'));
  tb.cyl(0.05, 0.07, 0.14, 6, -0.32, 0.88, -0.16, new THREE.Color('#d8c48a'));
  // HQ pennant on a light pole, streaming back from the group.
  k.cyl(0.03, 0.035, 2.9, 5, -0.6, 1.45, -0.35, wood);
  k.geo(pennantGeo(), trs(-0.6, 2.35, -0.35, 0, Math.PI, 0, 0.95, 0.5, 1), ZERO, 1);
  k.cyl(0.06, 0.06, 0.06, 6, -0.6, 2.92, -0.35, PAL.steel);
  return k.build();
}
