/**
 * Per-soldier locomotion for squads and gun crews (render only, no sim effect).
 *
 * Every soldier owns a few floats in a flat Float32Array (SOL_STRIDE per soldier): world
 * position, facing, stride phase and a smoothed walking speed. Each frame a soldier walks
 * toward its formation slot at a capped speed, turns at a limited rate toward where it is
 * walking (or toward the squad facing once it has arrived) and advances its stride by the
 * distance it actually covered, so feet never slide and nobody "moonwalks".
 *
 * While a squad marches, slots behind the leader are laid along the leader's recent path (a
 * breadcrumb Trail) instead of being rotated rigidly about the squad centre, so a column wheels
 * through a turn like real troops instead of spinning as one rigid body.
 */

/**
 * Floats per soldier: x, z, facing as a unit vector (cos, sin; heading convention, +x = 0 — a
 * vector so turning and drawing need no trigonometry), stride phase, smoothed walking speed.
 */
export const SOL_STRIDE = 6;
export const SX = 0;
export const SZ = 1;
export const SC = 2;
export const SS = 3;
export const SP = 4;
export const SV = 5;

/** Breadcrumb spacing (m) and capacity of a squad's marching trail. */
const TRAIL_STEP = 2.5;
const TRAIL_N = 24;
/** A jump larger than this (teleport / dismount) restarts the trail. */
const TRAIL_JUMP = 20;

/** Walking: slowest cap (m/s), cap relative to squad speed, and catch-up beyond CATCHUP_FREE m. */
const MIN_CAP = 1.8;
const CAP_K = 1.3;
const CAP_ADD = 0.3;
const CATCHUP_FREE = 4;
const CATCHUP_GAIN = 0.6;
/** Arrival: speed ∝ distance below this gain so soldiers decelerate into their slot. */
const ARRIVE_GAIN = 2.2;
const ARRIVED = 0.03;
/** Turn rate (rad/s) and the walking speed above which a soldier faces his own direction. */
const TURN_RATE = 5.5;
const FACE_WALK = 0.7;
/** Stride: radians of phase per metre (one footfall ≈ 1.3 m at the exaggerated scale). */
const STRIDE_K = Math.PI / 1.3;
/** Leg shear amplitude (model units, see the soldier shader) at full walking speed. */
export const STRIDE_AMP = 0.42;
const STRIDE_FULL = 1.2;

const TWO_PI = Math.PI * 2;

/** Wrap an angle difference into (-π, π]. */
export function wrapAngle(a: number): number {
  return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
}

/** Squad marching path: newest point first, with each point's distance to the older one. */
export class Trail {
  private readonly pts = new Float32Array(TRAIL_N * 2);
  private readonly seg = new Float32Array(TRAIL_N);
  private head = 0;
  private len = 0;

  reset(x: number, z: number): void {
    this.pts[0] = x;
    this.pts[1] = z;
    this.seg[0] = 0;
    this.head = 0;
    this.len = 1;
  }

  /** Record the leader's position (only every TRAIL_STEP metres). */
  push(x: number, z: number): void {
    if (this.len === 0) return this.reset(x, z);
    const o = this.head * 2;
    const dx = x - this.pts[o];
    const dz = z - this.pts[o + 1];
    const d2 = dx * dx + dz * dz;
    if (d2 < TRAIL_STEP * TRAIL_STEP) return;
    if (d2 > TRAIL_JUMP * TRAIL_JUMP) return this.reset(x, z);
    this.head = (this.head + 1) % TRAIL_N;
    this.pts[this.head * 2] = x;
    this.pts[this.head * 2 + 1] = z;
    this.seg[this.head] = Math.sqrt(d2);
    if (this.len < TRAIL_N) this.len++;
  }

  /**
   * World targets for n slots (goal = [fwd, right] pairs) of a leader at (hx, hz) heading
   * (hc, hs) = (cos, sin). Forward slots extrapolate along the heading; rear slots lie `-fwd`
   * metres back along the trail, offset sideways from the local path direction (so the squad
   * wheels through turns). `order` lists slots front to back, so one pass walks the trail.
   * Writes x, z pairs into out (indexed by slot).
   */
  placeAll(hx: number, hz: number, hc: number, hs: number, goal: Float32Array, order: Uint8Array, n: number, out: Float32Array): void {
    const pts = this.pts;
    let i = this.head;
    let ax = hx;
    let az = hz;
    let bx = pts[i * 2];
    let bz = pts[i * 2 + 1];
    // First leg: leader → newest breadcrumb.
    let sl = Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));
    let acc = 0;
    let visited = 1;
    let done = this.len === 0;
    let tx = hc;
    let tz = hs;
    for (let j = 0; j < n; j++) {
      const s = order[j];
      const fwd = goal[s * 2];
      const right = goal[s * 2 + 1];
      let px: number;
      let pz: number;
      let cx = hc;
      let cz = hs;
      if (fwd >= 0 || this.len === 0) {
        px = hx + hc * fwd;
        pz = hz + hs * fwd;
      } else {
        const dist = -fwd;
        while (!done && dist > acc + sl) {
          if (sl > 1e-3) {
            tx = (ax - bx) / sl;
            tz = (az - bz) / sl;
          }
          acc += sl;
          ax = bx;
          az = bz;
          if (visited >= this.len) {
            done = true;
            break;
          }
          sl = this.seg[i];
          i = (i + TRAIL_N - 1) % TRAIL_N;
          bx = pts[i * 2];
          bz = pts[i * 2 + 1];
          visited++;
        }
        if (!done && sl > 1e-3) {
          tx = (ax - bx) / sl;
          tz = (az - bz) / sl;
        }
        // Inside the current leg, or straight on back past the end of the trail.
        const r = dist - acc;
        px = ax - tx * r;
        pz = az - tz * r;
        cx = tx;
        cz = tz;
      }
      out[s * 2] = px - cz * right;
      out[s * 2 + 1] = pz + cx * right;
    }
  }
}

/** Slot indices sorted front to back by forward offset (insertion sort, no allocation). */
export function sortSlots(goal: Float32Array, n: number, order: Uint8Array): void {
  for (let k = 0; k < n; k++) {
    let j = k;
    while (j > 0 && goal[order[j - 1] * 2] < goal[k * 2]) {
      order[j] = order[j - 1];
      j--;
    }
    order[j] = k;
  }
}

/** Walking speed cap (m/s) for a squad moving at `squadSpeed`. */
export function walkCap(squadSpeed: number): number {
  return Math.max(MIN_CAP, squadSpeed * CAP_K + CAP_ADD);
}

/** Place soldier k exactly at (x, z) facing `face` (first sight / dismount). */
export function snapSoldier(sol: Float32Array, k: number, x: number, z: number, face: number): void {
  const o = k * SOL_STRIDE;
  sol[o + SX] = x;
  sol[o + SZ] = z;
  sol[o + SC] = Math.cos(face);
  sol[o + SS] = Math.sin(face);
  sol[o + SV] = 0;
}

/** Result of the last stepSoldier call (shared, so stepping allocates nothing). */
export const step = { stride: 0, settled: false };

/** Per-dt constants (dt is the same for every soldier in a frame). */
let turnDt = -1;
let turnCos = 1;
let turnSin = 0;
let speedBlend = 0;

/**
 * Walk soldier k toward (tx, tz) and turn toward `restFace` (or his walking direction). Sets
 * step.stride (leg shear for the soldier shader, 0 when standing) and step.settled (arrived,
 * turned and still: safe to cache his matrix).
 */
export function stepSoldier(sol: Float32Array, k: number, tx: number, tz: number, restFace: number, cap: number, dt: number): void {
  const o = k * SOL_STRIDE;
  const dx = tx - sol[o + SX];
  const dz = tz - sol[o + SZ];
  const d = Math.sqrt(dx * dx + dz * dz);
  let speed = 0;
  if (d > ARRIVED && dt > 0) {
    const lim = cap + (d > CATCHUP_FREE ? (d - CATCHUP_FREE) * CATCHUP_GAIN : 0);
    const want = Math.min(lim, d * ARRIVE_GAIN);
    const st = Math.min(d, want * dt);
    sol[o + SX] += (dx / d) * st;
    sol[o + SZ] += (dz / d) * st;
    const ph = sol[o + SP] + st * STRIDE_K;
    sol[o + SP] = ph > TWO_PI ? ph - TWO_PI : ph;
    speed = st / dt;
  } else if (d > 0) {
    sol[o + SX] = tx;
    sol[o + SZ] = tz;
  }
  // Smoothed speed drives facing and stride amplitude (no flicker on tiny corrections).
  if (dt !== turnDt) {
    turnDt = dt;
    turnCos = Math.cos(TURN_RATE * dt);
    turnSin = Math.sin(TURN_RATE * dt);
    speedBlend = Math.min(1, dt * 8);
  }
  let sv = sol[o + SV] + (speed - sol[o + SV]) * speedBlend;
  if (sv < 0.01) sv = 0;
  sol[o + SV] = sv;
  // Turn the facing vector toward the walking direction (or the rest facing) at TURN_RATE.
  let wx: number;
  let wz: number;
  const walking = sv > FACE_WALK && d > 0.5;
  if (walking) {
    wx = dx / d;
    wz = dz / d;
  } else {
    wx = Math.cos(restFace);
    wz = Math.sin(restFace);
  }
  const fc = sol[o + SC];
  const fs = sol[o + SS];
  const aligned = fc * wx + fs * wz >= turnCos;
  if (aligned) {
    sol[o + SC] = wx;
    sol[o + SS] = wz;
  } else {
    const sn = fc * wz - fs * wx >= 0 ? turnSin : -turnSin;
    const nc = fc * turnCos - fs * sn;
    const ns = fc * sn + fs * turnCos;
    const inv = 1 / Math.sqrt(nc * nc + ns * ns);
    sol[o + SC] = nc * inv;
    sol[o + SS] = ns * inv;
  }
  step.settled = sv === 0 && d <= ARRIVED && aligned && !walking;
  // Feet together when standing still.
  step.stride = sv === 0 ? 0 : Math.sin(sol[o + SP]) * (sv >= STRIDE_FULL ? STRIDE_AMP : (STRIDE_AMP * sv) / STRIDE_FULL);
}
