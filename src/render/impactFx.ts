import * as THREE from 'three';
import type { ParticleSystem } from './particles';

const C = (hex: string): THREE.Color => new THREE.Color(hex);
const COL = {
  flash: C('#ffe6b0'), flashDim: C('#a8703c'), fire: C('#ff9a40'), fireDeep: C('#e0601c'), fireCore: C('#ffd890'),
  spark: C('#ffe8b8'), sparkHot: C('#ffc060'),
  water: C('#eef2ec'), foam: C('#dfe6dc'), mist: C('#cfd6d0'),
  masonry: C('#b9ad96'), masonryDark: C('#968b78'), plaster: C('#d6ccb8'), rubble: C('#6e655a'), tile: C('#8a4a32'),
  puff: C('#a8a196'), soot: C('#3b3833'), metal: C('#3a3631'), dust: C('#b8a888'), haze: C('#bdb4a2'),
  ember: C('#ffb050'),
};

/** Battlefield haze: hot spots of recent shelling (x, z, heat) — a small fixed pool. */
const HAZE_SPOTS = 24;
const HAZE_JOIN_M = 110;
/** Heat lost per second (a heavily shelled area stays hazy for a couple of minutes). */
const HAZE_COOL = 1 / 50;
const HAZE_MAX_HEAT = 6;
/** Haze puffs alive at most (huge, very faint quads: overdraw is the cost). */
const HAZE_CAP = 36;

const rnd = Math.random;

/**
 * Impact-specific effects layered on the shared particle pools (no allocation per event):
 * water splashes, masonry hits and building collapses, AP strikes, vehicle cook-offs, infantry
 * dust, burning-wreck embers and a faint battlefield haze over areas of heavy shelling.
 * `detail` follows the render quality tier: 0 high, 1 medium, 2 low (drops the optional layers).
 */
export class ImpactFx {
  smokeScale = 1;
  detail = 0;
  private readonly spots = new Float32Array(HAZE_SPOTS * 3);
  private hazeAlive = 0;
  private readonly hazeAge = new Float32Array(HAZE_CAP);
  private hazeTimer = 0;

  constructor(
    private readonly glow: ParticleSystem,
    private readonly smoke: ParticleSystem,
  ) {}

  private get lo(): boolean {
    return this.detail >= 2;
  }

  private get sa(): number {
    return Math.min(1, this.smokeScale);
  }

  /** Round into a river: white column, droplets, a foam ring and a little drifting mist. */
  splash(x: number, sy: number, z: number, r: number): void {
    const big = r >= 9;
    this.glow.emit(x, sy + 0.5, z, { life: 0.06, size: r * 0.5, grow: r, color: COL.flashDim });
    // Tall narrow column: stacked plumes launched at staggered speeds so it stretches upward.
    const nc = big ? 7 : 4;
    for (let k = 0; k < nc; k++) {
      this.smoke.emit(x + (rnd() - 0.5) * r * 0.15, sy + 0.2, z + (rnd() - 0.5) * r * 0.15, {
        color: COL.water, alpha: 0.9, life: 1.2 + rnd() * 0.5, size: r * 0.16, grow: r * 0.3, gravity: 16, drag: 0.4, fade: 1.4,
        vx: (rnd() - 0.5) * 1.5, vy: 5 + r * (0.8 + 1.3 * (k / nc) + rnd() * 0.3), vz: (rnd() - 0.5) * 1.5,
      });
    }
    const nd = this.lo ? 5 : big ? 16 : 10;
    for (let k = 0; k < nd; k++) {
      const a = rnd() * Math.PI * 2;
      const sp = 2 + r * (0.3 + rnd() * 0.6);
      this.smoke.emit(x, sy + 0.4, z, {
        color: COL.water, alpha: 0.95, life: 0.8 + rnd() * 0.6, size: 0.35 + rnd() * 0.35, gravity: 22, drag: 0.2,
        vx: Math.cos(a) * sp, vy: 5 + rnd() * r * 1.2, vz: Math.sin(a) * sp,
      });
    }
    const nr = this.lo ? 6 : 12;
    for (let k = 0; k < nr; k++) {
      const a = (k / nr) * Math.PI * 2 + rnd() * 0.4;
      const sp = r * (1.1 + rnd() * 0.5);
      this.smoke.emit(x + Math.cos(a) * r * 0.2, sy + 0.15, z + Math.sin(a) * r * 0.2, {
        color: COL.foam, alpha: 0.7, life: 2.2 + rnd(), size: r * 0.3, grow: r * 0.9, drag: 2.2, fade: 1.3,
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp,
      });
    }
    if (this.smokeScale > 0 && !this.lo) {
      this.smoke.emit(x, sy + r * 0.6, z, { color: COL.mist, alpha: 0.32 * this.sa, life: 4 + rnd() * 2, size: r * 0.8, grow: r * 1.8, drift: 1, drag: 1, fadeIn: 0.1, vy: 0.6 });
    }
  }

  /** Shell bursting on a roof or wall: hot flash, masonry dust, plaster and tile fragments. */
  masonryHit(x: number, y: number, z: number, r: number): void {
    this.glow.emit(x, y, z, { life: 0.08, size: r * 1.1, grow: r * 1.6, color: COL.flash });
    this.glow.emit(x, y, z, { life: 0.25, size: r * 0.6, grow: r * 0.8, color: COL.fireDeep, flicker: 0.3 });
    const nd = this.lo ? 3 : 6;
    for (let k = 0; k < nd; k++) {
      const a = rnd() * Math.PI * 2;
      const sp = r * (0.3 + rnd() * 0.5);
      this.smoke.emit(x, y, z, {
        color: k % 2 ? COL.masonry : COL.plaster, alpha: 0.75, life: 3 + rnd() * 2.5, size: r * 0.5, grow: r * 1.5 * Math.max(0.4, this.smokeScale),
        drag: 1.6, drift: 0.8, fadeIn: 0.03, fade: 1.1, vx: Math.cos(a) * sp, vy: 0.5 + rnd() * r * 0.25, vz: Math.sin(a) * sp,
      });
    }
    this.debris(x, y, z, r, this.lo ? 4 : 9, 0.6);
  }

  /**
   * A building comes down (`explosion` kind 'he' at the building centre): a short dim flash, a
   * big slow pale dust cloud rolling out from the footprint and settling, a ground-hugging
   * billow, flying rubble and roof tiles, then a darker column that lingers downwind.
   */
  collapse(x: number, y: number, z: number, gy: number, r: number): void {
    const ss = this.smokeScale;
    const top = Math.max(gy + 3, y * 2 - gy);
    this.glow.emit(x, y, z, { life: 0.12, size: r * 0.9, grow: r * 1.2, color: COL.flashDim });
    this.glow.emit(x, gy + 1, z, { life: 0.5, size: r * 0.8, grow: r * 0.5, color: COL.fireDeep, flicker: 0.4, fade: 1.6 });
    // Main dust cloud: stacked through the building's height, pushed out and up, very slow.
    const nm = this.lo ? 7 : 16;
    for (let k = 0; k < nm; k++) {
      const a = rnd() * Math.PI * 2;
      const h = gy + 1 + (top - gy) * (k / nm);
      const sp = r * (0.35 + rnd() * 0.5);
      this.smoke.emit(x + Math.cos(a) * r * 0.3, h, z + Math.sin(a) * r * 0.3, {
        color: k % 3 === 0 ? COL.masonryDark : COL.masonry, alpha: 0.95 * Math.max(0.6, this.sa), life: 10 + rnd() * 6, size: r * 0.9,
        grow: r * 2.8 * Math.max(0.5, ss), drag: 1.1, drift: 0.7, fadeIn: 0.03, fade: 1.3,
        vx: Math.cos(a) * sp, vy: 0.8 + rnd() * 1.6, vz: Math.sin(a) * sp,
      });
    }
    // Ground billow racing out along the street.
    const nb = this.lo ? 5 : 10;
    for (let k = 0; k < nb; k++) {
      const a = (k / nb) * Math.PI * 2 + rnd() * 0.5;
      const sp = r * (1.6 + rnd() * 0.8);
      this.smoke.emit(x + Math.cos(a) * r * 0.4, gy + 1, z + Math.sin(a) * r * 0.4, {
        color: COL.plaster, alpha: 0.8, life: 6 + rnd() * 3, size: r * 0.6, grow: r * 2 * Math.max(0.5, ss), drag: 2.2, drift: 0.6, fade: 1.2,
        vx: Math.cos(a) * sp, vy: 0.3, vz: Math.sin(a) * sp,
      });
    }
    this.debris(x, (y + gy) / 2, z, r, this.lo ? 8 : 20, 1);
    if (ss > 0 && !this.lo) {
      for (let k = 0; k < 2; k++) {
        this.smoke.emit(x + (rnd() - 0.5) * r * 0.5, top, z + (rnd() - 0.5) * r * 0.5, {
          color: COL.puff, alpha: 0.45 * this.sa, life: 16 + rnd() * 6, size: r * 0.8, grow: r * 2.4 * ss, vy: 1.2 + k * 0.5, drag: 0.4, drift: 1, fadeIn: 0.12, fade: 1,
        });
      }
    }
    this.note(x, z, r * 1.5);
  }

  /** Masonry / tile fragments thrown out and falling back under gravity. */
  private debris(x: number, y: number, z: number, r: number, n: number, k: number): void {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = r * k * (0.35 + rnd() * 0.6);
      this.smoke.emit(x, y, z, {
        color: i % 3 === 0 ? COL.tile : i % 3 === 1 ? COL.rubble : COL.masonryDark, alpha: 1, life: 1.2 + rnd() * 0.9,
        size: (0.45 + rnd() * 0.55) * (0.7 + 0.3 * k), grow: 0.05, gravity: 20, drag: 0.15, fade: 0.3,
        vx: Math.cos(a) * sp, vy: 5 + rnd() * r * 0.9 * k, vz: Math.sin(a) * sp,
      });
    }
  }

  /** AP round striking: a white spark spray and a small hot puff instead of a fireball. */
  apSparks(x: number, y: number, z: number, n: number): void {
    const m = this.lo ? Math.min(3, n) : n;
    for (let k = 0; k < m; k++) {
      const a = rnd() * Math.PI * 2;
      const sp = 6 + rnd() * 14;
      this.glow.emit(x, y, z, {
        life: 0.18 + rnd() * 0.22, size: 0.3 + rnd() * 0.3, color: k % 2 ? COL.spark : COL.sparkHot, gravity: 18, drag: 0.6,
        vx: Math.cos(a) * sp, vy: 2 + rnd() * 9, vz: Math.sin(a) * sp,
      });
    }
  }

  /**
   * Vehicle destroyed: ammunition cook-off — a fireball that climbs, a black smoke burst, and
   * dark metal fragments; the wreck then burns (Effects.wreckFire).
   */
  cookOff(x: number, y: number, z: number): void {
    this.glow.emit(x, y + 2, z, { life: 0.14, size: 9, grow: 12, color: COL.flash });
    const nf = this.lo ? 3 : 6;
    for (let k = 0; k < nf; k++) {
      this.glow.emit(x + (rnd() - 0.5) * 2, y + 1.5, z + (rnd() - 0.5) * 2, {
        life: 0.5 + rnd() * 0.4, size: 2.5 + rnd() * 1.5, grow: 4, color: k % 2 ? COL.fire : COL.fireDeep, flicker: 0.35, drag: 1.5,
        vx: (rnd() - 0.5) * 4, vy: 6 + rnd() * 8, vz: (rnd() - 0.5) * 4,
      });
    }
    this.apSparks(x, y + 2, z, 8);
    for (let k = 0; k < (this.lo ? 3 : 7); k++) {
      const a = rnd() * Math.PI * 2;
      const sp = 3 + rnd() * 8;
      this.smoke.emit(x, y + 2, z, {
        color: COL.metal, alpha: 1, life: 1.2 + rnd() * 0.8, size: 0.4 + rnd() * 0.4, gravity: 22, drag: 0.15, fade: 0.3,
        vx: Math.cos(a) * sp, vy: 8 + rnd() * 10, vz: Math.sin(a) * sp,
      });
    }
    if (this.smokeScale > 0) {
      for (let k = 0; k < 3; k++) {
        this.smoke.emit(x, y + 3 + k * 2, z, {
          color: COL.soot, alpha: 0.75 * this.sa, life: 5 + rnd() * 3, size: 2.5, grow: 9 * this.smokeScale, vy: 3 + k, drag: 0.9, drift: 0.9, fadeIn: 0.05, fade: 1.2,
        });
      }
    }
  }

  /** Infantry casualty: a brief puff of kicked-up dust where the man went down. */
  infantryDown(x: number, gy: number, z: number): void {
    if (this.lo || this.smokeScale <= 0 || this.smoke.free < 2500) return;
    for (let k = 0; k < 2; k++) {
      this.smoke.emit(x + (rnd() - 0.5) * 2, gy + 0.4, z + (rnd() - 0.5) * 2, {
        color: COL.dust, alpha: 0.4 * this.sa, life: 1 + rnd() * 0.6, size: 0.8, grow: 2.2, drag: 2, drift: 0.4, vx: (rnd() - 0.5) * 2, vy: 0.5, vz: (rnd() - 0.5) * 2,
      });
    }
  }

  /** Burning wreck extras: embers rising out of the hull and a flickering glow on the ground. */
  wreckEmbers(x: number, y: number, z: number, k: number): void {
    if (this.lo) return;
    if (rnd() < 0.3 + 0.5 * k) {
      this.glow.emit(x + (rnd() - 0.5) * 2, y - 1.2, z + (rnd() - 0.5) * 2, {
        life: 1 + rnd() * 1.2, size: 0.25 + rnd() * 0.25, color: COL.ember, flicker: 0.8, drag: 0.8, drift: 0.7, fade: 0.6,
        vx: (rnd() - 0.5) * 1.5, vy: 2.5 + rnd() * 3, vz: (rnd() - 0.5) * 1.5,
      });
    }
    if (k > 0.35 && rnd() < 0.5) {
      this.glow.emit(x, y - 2.6, z, { life: 0.5, size: 4 + 3 * k, grow: 0.5, color: COL.flashDim, flicker: 0.5, fade: 1.5 });
    }
  }

  /** Remember where the shelling is (feeds the battlefield haze). */
  note(x: number, z: number, r: number): void {
    const s = this.spots;
    let cold = 0;
    let coldH = Infinity;
    for (let i = 0; i < HAZE_SPOTS; i++) {
      const o = i * 3;
      const h = s[o + 2];
      if (h > 0 && (s[o] - x) ** 2 + (s[o + 1] - z) ** 2 < HAZE_JOIN_M * HAZE_JOIN_M) {
        // Drift the spot toward the new impact so it follows a moving front.
        s[o] += (x - s[o]) * 0.1;
        s[o + 1] += (z - s[o + 1]) * 0.1;
        s[o + 2] = Math.min(HAZE_MAX_HEAT, h + r * 0.04);
        return;
      }
      if (h < coldH) {
        coldH = h;
        cold = i;
      }
    }
    const o = cold * 3;
    s[o] = x;
    s[o + 1] = z;
    s[o + 2] = r * 0.04;
  }

  /** Cool the hot spots and keep a few huge, very faint haze puffs drifting over the hot ones. */
  update(dt: number, heightAt: (x: number, z: number) => number): void {
    if (dt <= 0) return;
    const s = this.spots;
    for (let i = 0; i < HAZE_SPOTS; i++) s[i * 3 + 2] = Math.max(0, s[i * 3 + 2] - dt * HAZE_COOL);
    for (let i = 0; i < this.hazeAlive; i++) this.hazeAge[i] -= dt;
    let w = 0;
    for (let i = 0; i < this.hazeAlive; i++) if (this.hazeAge[i] > 0) this.hazeAge[w++] = this.hazeAge[i];
    this.hazeAlive = w;
    if (this.detail > 0 || this.smokeScale <= 0) return;
    this.hazeTimer -= dt;
    if (this.hazeTimer > 0) return;
    this.hazeTimer = 0.4;
    // One puff per tick over the hottest spot that is above the threshold, weighted by heat.
    let best = -1;
    let bestV = 1.2;
    for (let i = 0; i < HAZE_SPOTS; i++) {
      const v = s[i * 3 + 2] * (0.6 + rnd() * 0.8);
      if (v > bestV) {
        bestV = v;
        best = i;
      }
    }
    if (best < 0 || this.hazeAlive >= HAZE_CAP || this.smoke.free < 1500) return;
    const o = best * 3;
    const h = s[o + 2];
    const life = 18 + rnd() * 8;
    this.hazeAge[this.hazeAlive++] = life;
    const a = rnd() * Math.PI * 2;
    const d = rnd() * 70;
    const px = s[o] + Math.cos(a) * d;
    const pz = s[o + 1] + Math.sin(a) * d;
    this.smoke.emit(px, heightAt(px, pz) + 6, pz, {
      color: COL.haze, alpha: Math.min(0.16, 0.05 + h * 0.022) * this.sa, life, size: 40, grow: 50 + h * 6, drag: 0.5, drift: 0.8,
      fadeIn: 0.3, fade: 1, vy: 0.3,
    });
  }
}
