import * as THREE from 'three';

/** Matte diorama palette (VISUAL_UX §2.2). Seeds — expected to iterate with the user. */
export const PAL = {
  grassA: new THREE.Color('#9aa36a'),
  grassB: new THREE.Color('#b3ab78'),
  dirt: new THREE.Color('#b59c6e'),
  road: new THREE.Color('#c9b48a'),
  roadEdge: new THREE.Color('#a8936b'),
  forestFloor: new THREE.Color('#6f7a4b'),
  town: new THREE.Color('#b8ad93'),
  mud: new THREE.Color('#7d6a4c'),
  rock: new THREE.Color('#948d80'),
  high: new THREE.Color('#c2b98f'),
  treeA: new THREE.Color('#5a6b3f'),
  treeB: new THREE.Color('#6d7b46'),
  treeConifer: new THREE.Color('#44553a'),
  trunk: new THREE.Color('#5b4a36'),
  wall: new THREE.Color('#d9d2c0'),
  wallB: new THREE.Color('#c9bea4'),
  roof: new THREE.Color('#8a5a44'),
  roofB: new THREE.Color('#6e6a62'),
  olive: new THREE.Color('#5d6446'),
  steel: new THREE.Color('#4a4d48'),
  track: new THREE.Color('#3a3a36'),
  skin: new THREE.Color('#c8a888'),
  sky: new THREE.Color('#d8d2c2'),
  wreck: new THREE.Color('#2e2c28'),
  bank: new THREE.Color('#8e8665'),
  riverBed: new THREE.Color('#5f6249'),
  gravel: new THREE.Color('#b0a588'),
  hedge: new THREE.Color('#5f6a3d'),
  /** Town paving (2.1): granite setts, kerb stone, pavement flags, garden ground. */
  sett: new THREE.Color('#7e776b'),
  kerb: new THREE.Color('#d8d1c1'),
  flag: new THREE.Color('#bdb39d'),
  garden: new THREE.Color('#8f9660'),
  /** Field patchwork: wheat, young green, ploughed, pale meadow, fallow, mustard. */
  fields: ['#c8b676', '#8f9c58', '#94795a', '#a8ad70', '#b3a57c', '#c2b263'].map((h) => new THREE.Color(h)),
  water: { deep: new THREE.Color('#2a5257'), shallow: new THREE.Color('#4f7d72'), ford: new THREE.Color('#8ea486') },
};

/** Faction paint: matte equipment base tinted slightly toward the faction colour. */
export function factionPaint(hex: string): THREE.Color {
  return PAL.olive.clone().lerp(new THREE.Color(hex), 0.28);
}

export function factionUniform(hex: string): THREE.Color {
  return new THREE.Color('#6b6a52').lerp(new THREE.Color(hex), 0.35);
}
