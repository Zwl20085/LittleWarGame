export interface V2 {
  x: number;
  z: number;
}

export const dist2 = (a: V2, b: V2): number => {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
};
export const dist = (a: V2, b: V2): number => Math.sqrt(dist2(a, b));
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Heading angle (radians) where 0 = +x, measured toward +z. */
export const headingTo = (from: V2, to: V2): number => Math.atan2(to.z - from.z, to.x - from.x);

export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Rotate `cur` toward `target` by at most maxStep radians. */
export function turnToward(cur: number, target: number, maxStep: number): number {
  const d = angleDiff(cur, target);
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

export const DEG = Math.PI / 180;
