import type { UnitDef } from '../data/types';
import { COMBAT, COVER, type CoverLevel } from './config';
import { angleDiff, clamp, DEG } from './vec';

/** Direct-fire hit probability (BALANCE_SPEC §4.1). */
export function hitProbability(args: {
  baseAccuracy: number;
  distance: number;
  maxRange: number;
  shooterMoving: boolean;
  shooterSuppressed: boolean;
  targetMoving: boolean;
  cover: CoverLevel;
  /** Terrain modifier (high ground, crest, vehicle in forest; BALANCE_SPEC §7.1). Default 1. */
  terrainMul?: number;
}): number {
  const rangeMul = clamp(1 - COMBAT.rangeFalloff * (args.distance / args.maxRange) ** 2, 0.5, 1);
  const p =
    args.baseAccuracy *
    rangeMul *
    (args.shooterMoving ? COMBAT.shooterMovingMul : 1) *
    (args.shooterSuppressed ? COMBAT.shooterSuppressedMul : 1) *
    (args.targetMoving ? COMBAT.targetMovingMul : 1) *
    COVER[args.cover].hit *
    (args.terrainMul ?? 1);
  return clamp(p, COMBAT.pHitMin, COMBAT.pHitMax);
}

/** Penetration probability (§4.2); small arms can never hurt real armour. */
export function penetrationProbability(penetration: number, armor: number): number {
  if (penetration <= COMBAT.smallArmsPenCutoff && armor > COMBAT.smallArmsArmorCutoff) return 0;
  return clamp((penetration - armor + COMBAT.penOffset) / COMBAT.penSpan, 0.05, 0.95);
}

export type ArmorFacing = 'front' | 'side' | 'rear';

/**
 * Which armour plate faces an attacker. `hullHeading` is the target's hull heading;
 * `attackBearing` is the bearing from the target to the attacker.
 */
export function armorFacing(hullHeading: number, attackBearing: number): ArmorFacing {
  const d = Math.abs(angleDiff(hullHeading, attackBearing));
  if (d <= COMBAT.frontArcDeg * DEG) return 'front';
  if (d >= Math.PI - COMBAT.rearArcDeg * DEG) return 'rear';
  return 'side';
}

export function armorValue(def: UnitDef, facing: ArmorFacing): number {
  return facing === 'front' ? def.armorFront : facing === 'rear' ? def.armorRear : def.armorSide;
}

/** HE falloff (§4.3). */
export function blastFalloff(distance: number, radius: number): number {
  if (radius <= 0) return 0;
  return Math.max(0, 1 - (distance / radius) ** 2);
}

export function heTargetMul(def: UnitDef): number {
  const t = COMBAT.heTargetMul;
  if (def.kind === 'vehicle') return t[def.id] ?? 0.3;
  return 1;
}

export function armorSuppressionMul(def: UnitDef): number {
  if (def.id === 'supply_truck') return COMBAT.armorSuppressionMul.truck;
  if (def.kind === 'vehicle') return COMBAT.armorSuppressionMul.tank;
  return COMBAT.armorSuppressionMul.none;
}

/** Fraction of a squad/crew still able to fire (§3.1 effective members). */
export function firepowerScale(def: UnitDef, hp: number, maxHp: number): number {
  if (def.kind === 'vehicle') return 1;
  const per = maxHp / def.memberCount;
  const alive = Math.ceil(hp / per - 1e-9);
  const s = alive / def.memberCount;
  return def.kind === 'crew' ? Math.max(COMBAT.crewMinFireScale, s) : s;
}

export function aliveMembers(def: UnitDef, hp: number, maxHp: number): number {
  if (def.kind === 'vehicle') return 1;
  return Math.max(0, Math.ceil(hp / (maxHp / def.memberCount) - 1e-9));
}
