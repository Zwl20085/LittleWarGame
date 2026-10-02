/**
 * Combat coefficients from BALANCE_SPEC.md that are not yet in docs/data/rules.json.
 * Versioned here so systems never scatter magic numbers. Keep in sync with the spec.
 */
export const COMBAT_CONFIG_VERSION = 'combat-0.1';

export const COMBAT = {
  rangeFalloff: 0.5, // rangeMul = clamp(1 - 0.5*(d/max)^2, .5, 1)
  shooterMovingMul: 0.75,
  shooterSuppressedMul: 0.65,
  targetMovingMul: 0.85,
  pHitMin: 0.05,
  pHitMax: 0.95,
  penOffset: 30,
  penSpan: 60,
  smallArmsPenCutoff: 15, // pen <= 15 vs armor > 20 => 0
  smallArmsArmorCutoff: 20,
  atVsInfantryMul: 0.15,
  nearMissRadius: 5,
  nearMissSuppressionMul: 0.25,
  heTargetMul: { infantry: 1, crew: 1, supply_truck: 0.8, light_tank: 0.35, medium_tank: 0.2, heavy_tank: 0.12, fort: 1.2 } as Record<string, number>,
  armorSuppressionMul: { tank: 0.35, truck: 0.6, none: 1 },
  frontArcDeg: 60,
  rearArcDeg: 45,
  targetSwitchMargin: 0.2,
  targetHoldSeconds: 2,
  crewMinFireScale: 0.5,
  lowHpVehicleSpeedMul: 0.75,
  setupArcDeg: 90,
  setupTurnDegps: 25,
  moraleHpLossFactor: 25,
  moraleSuppressionFactor: 0.04,
  friendWipeMoraleLoss: 5,
} as const;

/** Cover multipliers per BALANCE_SPEC §4.4: [hitMul, directDmgMul, blastMul, suppressionMul]. */
export type CoverLevel = 0 | 1 | 2 | 3;
export const COVER: Record<CoverLevel, { hit: number; direct: number; blast: number; supp: number }> = {
  0: { hit: 1, direct: 1, blast: 1, supp: 1 },
  1: { hit: 0.8, direct: 0.9, blast: 0.9, supp: 0.85 },
  2: { hit: 0.6, direct: 0.75, blast: 0.75, supp: 0.65 },
  3: { hit: 0.45, direct: 0.65, blast: 0.55, supp: 0.5 },
};

/** Indirect fire dispersion per BALANCE_SPEC §8.2. */
export const DISPERSION = {
  mortar_shell: { base: 5, perRange: 0.015 },
  howitzer_shell: { base: 8, perRange: 0.02 },
  noObserverMul: 1.5,
  staleIntelMul: 1.8,
  reconMul: 0.7,
  reconRange: 220,
  ninetyFiveFactor: 2.45,
} as const;

/** Terrain movement multipliers per BALANCE_SPEC §7. */
export const TERRAIN_MOVE = {
  // [foot, vehicle]
  open: [1, 1],
  road: [1.05, 1.35],
  forest: [0.85, 0.55],
  town: [0.8, 0.55],
  mud: [0.65, 0.4],
} as const;

export const FRONTLINE = {
  cell: 16, // 10 → 16 m (bigger maps): 2.5× fewer cells, still finer than a squad footprint
  radiusGround: 90,
  radiusCity: 180,
  radiusPoint: 60,
  weights: {
    infantry: 1, recon: 0.6, mg: 0.8, at_gun: 0.5, light_tank: 1.2, medium_tank: 1.6,
    heavy_tank: 2.0, engineer: 0.7, motor_inf: 1, supply_truck: 0.2, mortar: 0, howitzer: 0, aa: 0,
  } as Record<string, number>,
  cityWeight: 2.5,
  pointWeight: 0.5,
  neutralBelow: 0.25,
  contestedDelta: 0.15,
  smoothingSeconds: 3,
} as const;

export const AI = {
  sectorThinkSeconds: 2,
  cityThinkSeconds: 20,
  unitThinkSeconds: 0.2,
  rallyMinInfantry: 2,
  rallyMaxWait: 20,
  truckStandoff: 100,
  artilleryStandoffRatio: 0.65,
} as const;

/** Fortification seeds from GAME_DESIGN §10 / rules.json construction. */
export const FORT = {
  field_cover: { costM: 30, work: 20, hp: 500, cover: 2 as CoverLevel },
  mg_bunker: { costM: 100, work: 60, hp: 1400, cover: 3 as CoverLevel },
} as const;
