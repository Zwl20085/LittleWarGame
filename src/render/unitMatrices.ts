import type * as THREE from 'three';

/** Instance-matrix writers for unit views (no allocation; straight into instance arrays). */

/**
 * T(x,y,z)·Ry(a)·Rz(b)·S(s) into 16 floats of `te` at `o`, with the yaw given as (cos a, sin a)
 * (soldiers keep their facing as a vector); small tilts use a Taylor expansion.
 */
export function writeYZcs(te: Float32Array, o: number, x: number, y: number, z: number, c: number, sn: number, b: number, s: number): void {
  const small = b > -0.2 && b < 0.2;
  const cb = small ? 1 - b * b * 0.5 : Math.cos(b);
  const sb = small ? b - (b * b * b) / 6 : Math.sin(b);
  te[o] = c * cb * s; te[o + 1] = sb * s; te[o + 2] = -sn * cb * s; te[o + 3] = 0;
  te[o + 4] = -c * sb * s; te[o + 5] = cb * s; te[o + 6] = sn * sb * s; te[o + 7] = 0;
  te[o + 8] = sn * s; te[o + 9] = 0; te[o + 10] = c * s; te[o + 11] = 0;
  te[o + 12] = x; te[o + 13] = y; te[o + 14] = z; te[o + 15] = 1;
}

/** Write T(x,y,z)·Ry(a)·Rz(b)·S(s) straight into a matrix. */
export function setYZ(m: THREE.Matrix4, x: number, y: number, z: number, a: number, b: number, s: number): THREE.Matrix4 {
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const te = m.elements;
  te[0] = c * cb * s; te[1] = sb * s; te[2] = -sn * cb * s; te[3] = 0;
  te[4] = -c * sb * s; te[5] = cb * s; te[6] = sn * sb * s; te[7] = 0;
  te[8] = sn * s; te[9] = 0; te[10] = c * s; te[11] = 0;
  te[12] = x; te[13] = y; te[14] = z; te[15] = 1;
  return m;
}


/** Unit ground normal from four surface samples at ±e (x and z). */
export function groundNormal(h: (x: number, z: number) => number, x: number, z: number, e: number, out: Float32Array): Float32Array {
  const dx = h(x - e, z) - h(x + e, z);
  const dz = h(x, z - e) - h(x, z + e);
  const l = Math.hypot(dx, 2 * e, dz);
  out[0] = dx / l;
  out[1] = (2 * e) / l;
  out[2] = dz / l;
  return out;
}

/**
 * T(x,y,z)·[F Y Z]·S(s) for a body with heading `h` pitched by `p` (nose up) and rolled by `r`
 * (positive = right side (+z local) higher), written into 16 floats of `te` at `o`.
 */
export function writeTilted(te: Float32Array | number[], o: number, x: number, y: number, z: number, h: number, p: number, r: number, s: number): void {
  const ch = Math.cos(h);
  const sh = Math.sin(h);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  // Forward after pitch, up after pitch (before roll), flat side.
  const fx = cp * ch, fy = sp, fz = cp * sh;
  const ux = -sp * ch, uy = cp, uz = -sp * sh;
  const zx = -sh, zz = ch;
  te[o] = fx * s; te[o + 1] = fy * s; te[o + 2] = fz * s; te[o + 3] = 0;
  te[o + 4] = (ux * cr - zx * sr) * s; te[o + 5] = uy * cr * s; te[o + 6] = (uz * cr - zz * sr) * s; te[o + 7] = 0;
  te[o + 8] = (zx * cr + ux * sr) * s; te[o + 9] = uy * sr * s; te[o + 10] = (zz * cr + uz * sr) * s; te[o + 11] = 0;
  te[o + 12] = x; te[o + 13] = y; te[o + 14] = z; te[o + 15] = 1;
}
