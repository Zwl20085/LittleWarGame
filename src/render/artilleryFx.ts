import * as THREE from 'three';
import type { Projectile } from '../sim/types';
import { shockTexture } from './fxTextures';
import type { LinePool, ParticleSystem } from './particles';
import { ShellTrails, type TrailStyle } from './shellTrails';

const C = (hex: string): THREE.Color => new THREE.Color(hex);
const COL = {
  flash: C('#fff0c8'), fire: C('#ff9a40'), fireDeep: C('#e0601c'), fireCore: C('#ffd890'),
  headMortar: C('#ffe2a0'), headHowitzer: C('#ffc070'), whistle: C('#fff6e0'),
  smoke: C('#c2baab'), trailSmoke: C('#a9a196'), dust: C('#b8a888'), dirt: C('#4e3f2d'), dirtDark: C('#352a1f'),
  linger: C('#7d776d'), shock: C('#ffe4b0'),
};

/** Mortar bomb: short, thin, white-hot lob. Howitzer round: long, wide, orange arc. */
export const MORTAR_TRAIL: TrailStyle = { points: 22, spacing: 3.5, width: 1.6, alpha: 0.9, head: C('#fff0c8'), tail: C('#e06a20'), smokeEvery: 2 };
export const HOWITZER_TRAIL: TrailStyle = { points: 32, spacing: 6, width: 3.2, alpha: 1, head: C('#ffe2a0'), tail: C('#d8481a'), smokeEvery: 2 };

const MAX_SHOCKS = 96;
/** Seconds a shockwave ring takes to race out and fade. */
const SHOCK_LIFE = 0.42;

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * Artillery-specific visuals layered on the shared particle pools: a gun-sized muzzle blast at
 * the battery, a glowing head + light ribbon + shed smoke along each shell's real arc, a
 * brightening "incoming" streak on the plunge, and a punchier impact (hot flash, tall dirt
 * column, expanding shockwave ring, lingering dark smoke). Everything is pooled.
 */
export class ArtilleryFx {
  readonly trails = new ShellTrails();
  readonly shocks: THREE.InstancedMesh;
  // Shockwave rings as struct-of-arrays (x, y, z, radius, age).
  private readonly sh = new Float32Array(MAX_SHOCKS * 5);
  private shN = 0;
  /** Smoke density multiplier from the settings (0 = off). */
  smokeScale = 1;

  constructor(
    private readonly glow: ParticleSystem,
    private readonly smoke: ParticleSystem,
    private readonly lines: LinePool,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    this.trails.onSmoke = (x, y, z, st) => this.trailSmoke(x, y, z, st === HOWITZER_TRAIL);
    const mat = new THREE.MeshBasicMaterial({
      map: shockTexture(), color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.shocks = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), mat, MAX_SHOCKS);
    this.shocks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHOCKS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.shocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shocks.count = 0;
    this.shocks.frustumCulled = false;
    this.shocks.renderOrder = 2;
  }

  /**
   * Battery fired: a big flash and fire tongue up the (elevated) barrel, sparks, a dense blast
   * cloud that rolls forward and rises, and a ring of dust kicked off the ground.
   */
  muzzle(x: number, y: number, z: number, dir: number, howitzer: boolean): void {
    const el = howitzer ? 0.45 : 1.1;
    const ux = Math.cos(dir) * Math.cos(el);
    const uz = Math.sin(dir) * Math.cos(el);
    const uy = Math.sin(el);
    const k = howitzer ? 1 : 0.6;
    this.glow.emit(x, y, z, { life: 0.22, size: 12 * k, grow: 20 * k, color: COL.flash });
    this.glow.emit(x + ux * 4 * k, y + uy * 4 * k, z + uz * 4 * k, { life: 0.18, size: 8 * k, grow: 12 * k, color: COL.fire });
    this.glow.emit(x + ux * 8 * k, y + uy * 8 * k, z + uz * 8 * k, { life: 0.14, size: 5 * k, grow: 8 * k, color: COL.fireCore });
    const ground = this.heightAt(x, z);
    // Ground lit by the flash.
    this.glow.emit(x, ground + 0.6, z, { life: 0.4, size: 16 * k, grow: 8 * k, color: COL.fireDeep, fade: 1.6 });
    const ns = howitzer ? 9 : 5;
    for (let i = 0; i < ns; i++) {
      const sp = 14 + Math.random() * 16;
      this.glow.emit(x, y, z, {
        life: 0.3 + Math.random() * 0.25, size: 0.5 + Math.random() * 0.4, color: COL.fireCore, gravity: 12, drag: 1.2,
        vx: ux * sp + (Math.random() - 0.5) * 8, vy: uy * sp + Math.random() * 4, vz: uz * sp + (Math.random() - 0.5) * 8,
      });
    }
    const ss = this.smokeScale;
    if (ss <= 0) return;
    const a = Math.min(1, ss);
    const nb = howitzer ? 10 : 6;
    for (let i = 0; i < nb; i++) {
      const sp = (howitzer ? 16 : 9) * (0.3 + Math.random() * 0.9);
      this.smoke.emit(x, y, z, {
        color: COL.smoke, alpha: 0.62 * a, life: 3 + Math.random() * 1.8 + (howitzer ? 2 : 0), size: 3 * k + 1, grow: 13 * k * ss,
        drag: 2, drift: 1, fadeIn: 0.04, fade: 1.2,
        vx: ux * sp + (Math.random() - 0.5) * 3, vy: uy * sp * 0.6 + 1.2, vz: uz * sp + (Math.random() - 0.5) * 3,
      });
    }
    const nd = howitzer ? 10 : 6;
    for (let i = 0; i < nd; i++) {
      const ang = (i / nd) * Math.PI * 2 + Math.random() * 0.5;
      const sp = (howitzer ? 14 : 8) * (0.7 + Math.random() * 0.5);
      this.smoke.emit(x + Math.cos(ang), ground + 0.5, z + Math.sin(ang), {
        color: COL.dust, alpha: 0.5 * a, life: 1.8 + Math.random() * 0.9, size: 2 * k + 0.8, grow: 7 * k * ss, drag: 2.6, drift: 0.5,
        vx: Math.cos(ang) * sp, vy: 0.4, vz: Math.sin(ang) * sp,
      });
    }
  }

  /**
   * One ballistic shell this frame: hot head glow (bigger and flickering on the plunge), the
   * incoming streak along its velocity, and its light ribbon. `sc` is the zoom size boost.
   */
  shell(p: Projectile, x: number, y: number, z: number, sc: number): void {
    const howitzer = p.weapon?.id === 'howitzer_shell';
    const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z) || 1;
    // Descent 0..1: how steeply it is plunging (mortars come down almost vertically).
    const heat = p.vel.y < 0 ? Math.min(1, (-p.vel.y / sp) * 1.4) : 0;
    if (this.glow.free > 500) {
      const size = (howitzer ? 3.4 : 2.4) * Math.max(1, sc * 0.6) * (1 + 0.7 * heat);
      this.glow.emit(x, y, z, { life: 0.07, size, color: howitzer ? COL.headHowitzer : COL.headMortar, fade: 0.6, flicker: 0.35 * heat });
    }
    if (heat > 0.15) {
      // Bright streak trailing the head as it screams in.
      const t = 0.05 + 0.07 * heat;
      this.lines.push(x, y, z, x - p.vel.x * t, y - p.vel.y * t, z - p.vel.z * t, COL.whistle, 0.95 * heat, 0);
    }
    this.trails.track(p.id, x, y, z, howitzer ? HOWITZER_TRAIL : MORTAR_TRAIL, heat);
  }

  private trailSmoke(x: number, y: number, z: number, howitzer: boolean): void {
    const ss = this.smokeScale;
    if (ss <= 0 || this.smoke.free < 2500) return;
    this.smoke.emit(x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6, {
      color: COL.trailSmoke, alpha: (howitzer ? 0.45 : 0.36) * Math.min(1, ss), life: howitzer ? 3.6 : 2.2,
      size: howitzer ? 2.2 : 1.3, grow: (howitzer ? 6 : 3.5) * ss, drag: 1, drift: 0.9, fadeIn: 0.06, fade: 1.3, vy: 0.25,
    });
  }

  /** Extra punch for a shell landing on the ground (on top of the generic explosion). */
  impact(x: number, gy: number, z: number, r: number, busy: boolean): void {
    const big = r >= 13;
    this.glow.emit(x, gy + r * 0.3, z, { life: 0.16, size: r * 1.6, grow: r * 2.6, color: COL.flash });
    this.glow.emit(x, gy + 0.6, z, { life: 0.3, size: r * 2.2, grow: r, color: COL.fireDeep, fade: 1.8 });
    this.addShock(x, gy, z, r);
    // Tall dirt column: stacked plumes thrown straight up, collapsing under gravity.
    const nc = busy ? 2 : big ? 6 : 4;
    for (let k = 0; k < nc; k++) {
      this.smoke.emit(x + (Math.random() - 0.5) * r * 0.15, gy + 0.4, z + (Math.random() - 0.5) * r * 0.15, {
        color: k % 2 ? COL.dirt : COL.dirtDark, alpha: 0.92, life: 1.8 + Math.random() * 0.6, size: r * 0.28, grow: r * (0.8 + k * 0.08), gravity: 8, drag: 0.7,
        vx: (Math.random() - 0.5) * 2, vy: r * (2.1 + k * 0.32), vz: (Math.random() - 0.5) * 2,
      });
    }
    const ss = this.smokeScale;
    if (ss <= 0 || busy) return;
    // A dark smoke column that lingers over the strike and leans with the wind.
    const nl = big ? 2 : 1;
    for (let k = 0; k < nl; k++) {
      this.smoke.emit(x + (Math.random() - 0.5) * r * 0.4, gy + r * 0.5, z + (Math.random() - 0.5) * r * 0.4, {
        color: COL.linger, alpha: Math.min(0.5, 0.4 * ss), life: 9 + Math.random() * 5, size: r * 0.6, grow: r * 2 * ss,
        vy: 1.4 + k * 0.6, drag: 0.4, drift: 1, fadeIn: 0.15, fade: 1.1,
      });
    }
  }

  private addShock(x: number, y: number, z: number, r: number): void {
    if (this.shN >= MAX_SHOCKS) return;
    const o = this.shN++ * 5;
    this.sh[o] = x;
    this.sh[o + 1] = y + 0.35;
    this.sh[o + 2] = z;
    this.sh[o + 3] = r;
    this.sh[o + 4] = 0;
  }

  /** Age the shockwave rings; trails are rebuilt by `endTrails` after projectiles are synced. */
  update(dt: number): void {
    const sh = this.sh;
    let write = 0;
    for (let i = 0; i < this.shN; i++) {
      const o = i * 5;
      const age = sh[o + 4] + dt;
      if (age >= SHOCK_LIFE) continue;
      const w = write * 5;
      if (w !== o) sh.copyWithin(w, o, o + 5);
      sh[w + 4] = age;
      const t = age / SHOCK_LIFE;
      const s = sh[w + 3] * (0.3 + 1.8 * (1 - (1 - t) * (1 - t)));
      _m.makeScale(s, 1, s).setPosition(sh[w], sh[w + 1], sh[w + 2]);
      this.shocks.setMatrixAt(write, _m);
      this.shocks.setColorAt(write, _c.copy(COL.shock).multiplyScalar(0.75 * (1 - t) ** 1.5));
      write++;
    }
    this.shN = write;
    this.shocks.count = write;
    this.shocks.instanceMatrix.needsUpdate = true;
    if (this.shocks.instanceColor) this.shocks.instanceColor.needsUpdate = true;
  }
}
