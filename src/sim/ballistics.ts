import type { V3 } from './types';

export type ArcFail = 'NO_SOLUTION' | 'ANGLE_LIMIT' | 'TOO_CLOSE';

export interface ArcSolution {
  readonly thetaRad: number;
  readonly vel: V3;
  readonly tFlight: number;
}

/**
 * Solve launch angle for fixed muzzle speed (BALANCE_SPEC §8.1).
 * tanθ = (v² ± √D)/(gR), D = v⁴ − g(gR² + 2·dy·v²). Returns high or low arc within limits.
 */
export function solveArc(
  p0: V3, p1: V3, v: number, g: number, minDeg: number, maxDeg: number, preferHigh: boolean,
): { ok: true; sol: ArcSolution; alt: ArcSolution | null } | { ok: false; reason: ArcFail } {
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const R = Math.hypot(dx, dz);
  if (R < 1) return { ok: false, reason: 'TOO_CLOSE' };
  const dy = p1.y - p0.y;
  const v2 = v * v;
  const D = v2 * v2 - g * (g * R * R + 2 * dy * v2);
  if (D < 0) return { ok: false, reason: 'NO_SOLUTION' };
  const sq = Math.sqrt(D);
  const high = Math.atan((v2 + sq) / (g * R));
  const low = Math.atan((v2 - sq) / (g * R));
  const lo = (minDeg * Math.PI) / 180;
  const hi = (maxDeg * Math.PI) / 180;
  const valid = (t: number): boolean => t >= lo - 1e-6 && t <= hi + 1e-6;
  const make = (theta: number): ArcSolution => {
    const vh = v * Math.cos(theta);
    return {
      thetaRad: theta,
      vel: { x: (dx / R) * vh, y: v * Math.sin(theta), z: (dz / R) * vh },
      tFlight: R / vh,
    };
  };
  const order = preferHigh ? [high, low] : [low, high];
  const sols = order.filter(valid).map(make);
  if (sols.length === 0) return { ok: false, reason: 'ANGLE_LIMIT' };
  return { ok: true, sol: sols[0], alt: sols[1] ?? null };
}

/** Position along a ballistic path at time t. */
export function arcPoint(p0: V3, vel: V3, g: number, t: number): V3 {
  return { x: p0.x + vel.x * t, y: p0.y + vel.y * t - 0.5 * g * t * t, z: p0.z + vel.z * t };
}

/** Horizontal metres in front of the muzzle checked every ~1.5 m (a gun parked against a wall or an up-slope is masked). */
export const MUZZLE_CLEAR_M = 24;

/** True if the arc clears terrain until shortly before impact. */
export function arcClear(p0: V3, sol: ArcSolution, g: number, heightAt: (x: number, z: number) => number): boolean {
  const vh = Math.hypot(sol.vel.x, sol.vel.z);
  if (vh > 0) {
    // The 0.1 s samples below start ~6-10 m out; a wall or bank right in front of the muzzle used to
    // burst ~20 % of howitzer shells on the gun's own position (balance lab 1.1).
    for (let d = 1.5; d <= MUZZLE_CLEAR_M; d += 1.5) {
      const t = d / vh;
      if (t >= sol.tFlight * 0.8) break;
      const p = arcPoint(p0, sol.vel, g, t);
      if (p.y < heightAt(p.x, p.z) + 0.5) return false;
    }
  }
  const steps = Math.max(8, Math.ceil(sol.tFlight / 0.1));
  for (let k = 1; k < steps - 1; k++) {
    const t = (k / steps) * sol.tFlight;
    const p = arcPoint(p0, sol.vel, g, t);
    if (p.y < heightAt(p.x, p.z) + 0.5) return false;
  }
  return true;
}
