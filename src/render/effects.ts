import * as THREE from 'three';
import type { FxEvent, Projectile } from '../sim/types';
import { craterTexture, radialTexture, smokeTexture } from './fxTextures';
import { ArtilleryFx } from './artilleryFx';
import { LinePool, ParticleSystem } from './particles';
import { TownFires, type TownSite } from './townFires';
import { muzzleShift, VEHICLE_SCALE } from './unitModels';

const C = (hex: string): THREE.Color => new THREE.Color(hex);
const COL = {
  flash: C('#ffe6b0'), fire: C('#ff9a40'), fireDeep: C('#e0601c'), fireCore: C('#ffd890'),
  dust: C('#b8a888'), dustPale: C('#cfc2a4'), smokeLight: C('#d8d0c0'), smokeGround: C('#9a8d74'), smokeAir: C('#5a5650'),
  smokeLinger: C('#a39f97'), smokeDark: C('#3b3833'), smokeWreck: C('#6a655c'), clod: C('#5e4c36'), clodDark: C('#3f3326'),
  ricochet: C('#ffe0a0'), aa: C('#ffc060'), strafe: C('#ffd080'), mg: C('#ffb050'), shell: C('#ffe0a0'),
  trail: C('#f3e3b8'), splash: C('#dfe6dc'),
};
const TRACER_COLORS = [COL.shell, COL.aa, COL.strafe, COL.mg] as const;
const TRACER_GLOW = [C('#ffb060'), C('#ffc070'), C('#ffb050'), C('#ff9a40')] as const;

/**
 * Prevailing wind (m/s): every drifting smoke particle leans the same way so the field reads as
 * one weather system (late-afternoon breeze from the west-north-west).
 */
export const WIND = new THREE.Vector3(2.1, 0.15, 0.8);

const MAX_DECALS = 1200;
const MAX_TRACERS = 5000;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _fwd = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/**
 * Pooled particle / tracer / projectile visuals: two particle draw calls (additive + alpha),
 * one line-segment buffer, instanced shells, bombs and persistent craters. Purely cosmetic.
 */
export class Effects {
  readonly group = new THREE.Group();
  private readonly glow: ParticleSystem;
  private readonly smoke: ParticleSystem;
  private readonly lines = new LinePool(8000);
  private readonly arty: ArtilleryFx;
  private readonly towns: TownFires;
  // Tracers as struct-of-arrays (no per-shot allocation).
  private readonly tr = new Float32Array(MAX_TRACERS * 6);
  private readonly trLife = new Float32Array(MAX_TRACERS);
  private readonly trMax = new Float32Array(MAX_TRACERS);
  private readonly trAlpha = new Float32Array(MAX_TRACERS);
  private readonly trCol = new Uint8Array(MAX_TRACERS);
  private readonly trBolt = new Uint8Array(MAX_TRACERS);
  private trN = 0;
  private readonly shells: THREE.InstancedMesh;
  private readonly bombs: THREE.InstancedMesh;
  private readonly craters: THREE.InstancedMesh;
  private decalN = 0;
  private decalHead = 0;
  private smokeK = 1;
  reducedMotion = false;
  shake = 0;
  /** CSS pixels per metre (set by the renderer) — keeps shells visible when zoomed out. */
  pxPerM = 3;
  /** Camera forward direction (set by the renderer) — shell ribbons face the camera. */
  readonly viewDir = new THREE.Vector3(0, -1, 0);
  /** Big gun fired at (x, z) — lets unit views kick the turret back. */
  onBigMuzzle: ((x: number, z: number) => void) | null = null;

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    this.glow = new ParticleSystem(3500, radialTexture(), true);
    this.smoke = new ParticleSystem(8000, smokeTexture(), false);
    this.smoke.wind.copy(WIND);
    this.glow.wind.copy(WIND);
    this.arty = new ArtilleryFx(this.glow, this.smoke, this.lines, heightAt);
    this.towns = new TownFires(this.smoke, this.glow);
    this.shells = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 6, 4), new THREE.MeshBasicMaterial({ color: '#f6e7b8' }), 2000);
    this.bombs = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.35, 1.4, 3, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#3d3f38' }), 256);
    const crater = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.craters = new THREE.InstancedMesh(crater, new THREE.MeshBasicMaterial({ map: craterTexture(), color: '#ffffff', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), MAX_DECALS);
    for (const im of [this.shells, this.bombs, this.craters]) {
      im.count = 0;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.craters.renderOrder = 1;
    this.group.add(this.craters, this.arty.shocks, this.smoke.mesh, this.glow.mesh, this.lines.lines, this.arty.trails.mesh, this.shells, this.bombs);
  }

  /** Smoke density from the settings (0 = off); shared with the artillery visuals. */
  get smokeScale(): number {
    return this.smokeK;
  }

  set smokeScale(v: number) {
    this.smokeK = v;
    this.arty.smokeScale = v;
  }

  /** Settlements whose buildings smoulder after nearby shelling. */
  setTowns(sites: readonly TownSite[]): void {
    this.towns.setSites(sites);
  }

  handle(e: FxEvent): void {
    switch (e.t) {
      case 'muzzle': {
        if (!e.big) {
          this.glow.emit(e.pos.x, e.pos.y, e.pos.z, { life: 0.05, size: 1.0, grow: 1.2, color: COL.flash });
          break;
        }
        // Flash at the visible (scaled-up) barrel tip; recoil is keyed to the unit's sim position.
        const sh = muzzleShift(e.weapon);
        const x = e.pos.x + (sh ? Math.cos(e.dir) * sh[0] : 0);
        const y = e.pos.y + (sh ? sh[1] : 0);
        const z = e.pos.z + (sh ? Math.sin(e.dir) * sh[0] : 0);
        this.onBigMuzzle?.(e.pos.x, e.pos.z);
        if (e.weapon === 'mortar_shell' || e.weapon === 'howitzer_shell') this.arty.muzzle(x, y, z, e.dir, e.weapon === 'howitzer_shell');
        else this.bigMuzzle(x, y, z, e.dir);
        break;
      }
      case 'tracer':
        this.tracer(e.from.x, e.from.y, e.from.z, e.to.x, e.to.y, e.to.z, e.weapon, e.hit);
        break;
      case 'explosion':
        this.explosion(e.pos.x, e.pos.y, e.pos.z, e.radius, e.kind);
        break;
      case 'ricochet':
        this.glow.emit(e.pos.x, e.pos.y, e.pos.z, { life: 0.1, size: 1.5, grow: 6, color: COL.ricochet });
        for (let k = 0; k < 3; k++) {
          this.glow.emit(e.pos.x, e.pos.y, e.pos.z, { life: 0.25, size: 0.35, color: COL.fireCore, gravity: 14, drag: 0.5, vx: (Math.random() - 0.5) * 14, vy: 3 + Math.random() * 6, vz: (Math.random() - 0.5) * 14 });
        }
        break;
      case 'death':
        if (e.vehicle) {
          this.explosion(e.pos.x, e.pos.y + 1, e.pos.z, 6, 'he');
          this.shake = Math.max(this.shake, 0.3);
        }
        break;
      case 'planeDown':
        this.explosion(e.pos.x, e.pos.y, e.pos.z, 8, 'he');
        break;
    }
  }

  /** Tank / field-gun shot: hot flash, forward smoke cone, ground dust kicked by the blast. */
  private bigMuzzle(x: number, y: number, z: number, dir: number): void {
    const cx = Math.cos(dir);
    const cz = Math.sin(dir);
    this.glow.emit(x, y, z, { life: 0.12, size: 4.5, grow: 10, color: COL.flash });
    this.glow.emit(x + cx * 1.5, y, z + cz * 1.5, { life: 0.09, size: 3, grow: 6, color: COL.fire });
    const ss = this.smokeScale;
    if (ss <= 0) return;
    for (let k = 0; k < 4; k++) {
      const sp = 5 + Math.random() * 6;
      const side = (Math.random() - 0.5) * 3;
      this.smoke.emit(x, y, z, {
        color: COL.smokeLight, alpha: 0.42 * Math.min(1, ss), life: 2 + Math.random(), size: 1.6, grow: 4.5 * ss, drag: 2.4, drift: 0.8, fadeIn: 0.05,
        vx: cx * sp - cz * side, vy: 0.6 + Math.random() * 0.6, vz: cz * sp + cx * side,
      });
    }
    const ground = this.heightAt(x, z);
    if (y - ground < 6) {
      // Blast overpressure lifts a dust skirt under the muzzle.
      for (let k = 0; k < 6; k++) {
        const a = dir + (Math.random() - 0.5) * 2.4;
        const sp = 4 + Math.random() * 5;
        this.smoke.emit(x + cx * 2, ground + 0.4, z + cz * 2, {
          color: COL.dust, alpha: 0.38 * Math.min(1, ss), life: 1.4 + Math.random() * 0.8, size: 1.2, grow: 4 * ss, drag: 2.5, drift: 0.5,
          vx: Math.cos(a) * sp, vy: 0.4, vz: Math.sin(a) * sp,
        });
      }
    }
  }

  private tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: string, hit: boolean): void {
    const rifle = w.includes('rifle');
    const ci = w === 'aa_shell' ? 1 : w === 'strafe' ? 2 : w === 'mg' || w === 'coax_mg' ? 3 : 0;
    if (this.trN >= MAX_TRACERS) this.trN--; // drop the newest slot rather than allocate
    const i = this.trN++;
    const o = i * 6;
    this.tr[o] = ax; this.tr[o + 1] = ay; this.tr[o + 2] = az;
    this.tr[o + 3] = bx; this.tr[o + 4] = by; this.tr[o + 5] = bz;
    const dist = Math.hypot(bx - ax, by - ay, bz - az);
    this.trLife[i] = 0;
    // Rifles: brief faint line. Automatic fire: a glowing bolt that travels to the target.
    this.trBolt[i] = rifle ? 0 : 1;
    this.trMax[i] = rifle ? 0.08 : Math.min(0.4, Math.max(0.1, dist / 420));
    this.trAlpha[i] = rifle ? 0.32 : 0.95;
    this.trCol[i] = ci;
    if (!rifle) {
      // A hot glowing slug that actually travels the path (reads on bright ground, unlike a 1 px line).
      const life = this.trMax[i] * 0.8;
      this.glow.emit(ax, ay, az, { life, size: ci === 1 ? 1.4 : 1.0, color: TRACER_GLOW[ci], vx: (bx - ax) / life * 0.8, vy: (by - ay) / life * 0.8, vz: (bz - az) / life * 0.8, drag: 0, fade: 0.3 });
    }
    if (!hit || w === 'strafe') {
      this.smoke.emit(bx, by, bz, { color: COL.dust, alpha: 0.55, life: 0.7, size: 0.8, grow: 2.2, drift: 0.3 });
      if (w === 'strafe' || ci === 1) this.smoke.emit(bx, by, bz, { color: COL.clod, alpha: 0.8, life: 0.5, size: 0.4, gravity: 16, drag: 0.3, vx: (Math.random() - 0.5) * 3, vy: 4 + Math.random() * 3, vz: (Math.random() - 0.5) * 3 });
    }
  }

  /** Burning wreck: flickering flames at the hull and a dark column leaning with the wind. */
  wreckFire(x: number, y: number, z: number, intensity: number): void {
    const ss = this.smokeScale;
    const k = Math.max(0.15, intensity);
    if (ss > 0) {
      this.smoke.emit(x + (Math.random() - 0.5) * 1.5, y, z + (Math.random() - 0.5) * 1.5, {
        color: intensity > 0.6 ? COL.smokeDark : COL.smokeWreck, alpha: 0.36 * Math.min(1, ss) * (0.5 + 0.5 * k), life: 4 + Math.random() * 2.5,
        size: 1.6, grow: 7 * ss * (0.6 + 0.4 * k), drift: 1, fadeIn: 0.08, fade: 1.6,
        vx: (Math.random() - 0.5) * 0.8, vy: 2.6 + k * 1.2, vz: (Math.random() - 0.5) * 0.8,
      });
    }
    if (Math.random() < 0.35 + 0.6 * k) {
      this.glow.emit(x + (Math.random() - 0.5) * 2.2, y - 1.8 + Math.random() * 0.8, z + (Math.random() - 0.5) * 2.2, {
        life: 0.35 + Math.random() * 0.3, size: 1.2 + k * 1.6, grow: 0.8, color: Math.random() < 0.5 ? COL.fire : COL.fireDeep, flicker: 0.45, vy: 1.6, drift: 0.2,
      });
    }
  }

  /** Engineer work site: splashes and sawdust where the next pontoon is being floated in. */
  workSite(p: THREE.Vector3, dt: number): void {
    if (Math.random() < dt * 4) {
      this.smoke.emit(p.x + (Math.random() - 0.5) * 4, p.y, p.z + (Math.random() - 0.5) * 4, {
        color: COL.splash, alpha: 0.5, life: 0.8, size: 0.6, grow: 1.6, gravity: 6, drag: 1, vx: (Math.random() - 0.5) * 2, vy: 2.5, vz: (Math.random() - 0.5) * 2,
      });
    }
  }

  /** Tracks churn a little dust off dry ground. */
  trackDust(x: number, y: number, z: number, heading: number): void {
    if (this.smokeScale <= 0 || this.smoke.free < 1500) return;
    const back = 2.6 * VEHICLE_SCALE;
    const bx = x - Math.cos(heading) * back;
    const bz = z - Math.sin(heading) * back;
    this.smoke.emit(bx + (Math.random() - 0.5) * 2.5, y + 0.4, bz + (Math.random() - 0.5) * 2.5, {
      color: COL.dustPale, alpha: 0.3 * Math.min(1, this.smokeScale), life: 1.6 + Math.random() * 0.8, size: 1.2, grow: 4.5, drift: 0.6, fadeIn: 0.1,
      vx: (Math.random() - 0.5) * 0.8, vy: 0.5, vz: (Math.random() - 0.5) * 0.8,
    });
  }

  private explosion(x: number, y: number, z: number, radius: number, kind: string): void {
    const r = Math.max(1.5, radius);
    const ground = this.heightAt(x, z);
    const onGround = y - ground < 3;
    const ss = this.smokeScale;
    const busy = this.smoke.free < 2000;
    // Flash and fireball.
    this.glow.emit(x, y + 0.5, z, { life: 0.09, size: r * 1.2, grow: r * 2.2, color: COL.flash });
    const nf = Math.min(7, Math.round(2 + r * 0.45));
    for (let k = 0; k < nf; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = r * (0.3 + Math.random() * 0.5);
      this.glow.emit(x, y + r * 0.15, z, {
        life: 0.3 + Math.random() * 0.3, size: r * 0.45, grow: r * 1.1, color: k % 2 ? COL.fire : COL.fireDeep, flicker: 0.3, drag: 3,
        vx: Math.cos(a) * sp, vy: r * (0.4 + Math.random() * 0.6), vz: Math.sin(a) * sp,
      });
    }
    if (onGround) this.groundBurst(x, ground, z, r, kind, busy);
    if (onGround && (kind === 'shell' || kind === 'bomb')) this.arty.impact(x, ground, z, r, busy);
    else {
      // Air burst / flak: a dark ragged puff that hangs.
      this.smoke.emit(x, y, z, { color: COL.smokeAir, alpha: 0.7, life: 5, size: r * 0.8, grow: r * 1.6 * Math.max(0.3, ss), drift: 1, drag: 2 });
    }
    // Initial smoke burst.
    const n = busy ? 2 : Math.min(8, Math.round(3 + r * 0.4));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = r * (0.25 + Math.random() * 0.45);
      this.smoke.emit(x, y + 0.5, z, {
        color: onGround ? COL.smokeGround : COL.smokeAir, alpha: 0.62, life: 4 + Math.random() * 2.5 + r * 0.12,
        size: r * 0.7, grow: r * 1.7 * Math.max(0.35, ss), gravity: -0.5, drag: 1.3, drift: 0.8, fade: 0.9,
        vx: Math.cos(a) * sp, vy: 1.2 + Math.random() * r * 0.3, vz: Math.sin(a) * sp,
      });
    }
    // Lingering smoke that drifts downwind (thin enough to keep units readable).
    if (ss > 0 && onGround && r >= 2.5 && !busy) {
      const nl = r >= 6 ? 2 : 1;
      for (let k = 0; k < nl; k++) {
        this.smoke.emit(x + (Math.random() - 0.5) * r, ground + r * 0.4, z + (Math.random() - 0.5) * r, {
          color: COL.smokeLinger, alpha: Math.min(0.45, 0.34 * ss), life: 13 + Math.random() * 6, size: r * 1.0, grow: r * 2.4 * ss,
          vy: 0.7, drag: 0.2, drift: 1, fadeIn: 0.1, fade: 0.8,
        });
      }
    }
    if (onGround) this.towns.heat(x, z, r);
    if (r >= 10 && !this.reducedMotion) this.shake = Math.max(this.shake, Math.min(0.8, r / 25));
  }

  /** Dirt geyser, flying clods, a low dust ring and the crater left behind. */
  private groundBurst(x: number, gy: number, z: number, r: number, kind: string, busy: boolean): void {
    const heavy = kind === 'shell' || kind === 'bomb';
    // Dirt geyser (artillery reads as a tall brown plume, not a fireball).
    const ng = heavy ? 4 : 2;
    for (let k = 0; k < ng; k++) {
      this.smoke.emit(x + (Math.random() - 0.5) * r * 0.3, gy + 0.3, z + (Math.random() - 0.5) * r * 0.3, {
        color: k ? COL.clod : COL.smokeGround, alpha: 0.9, life: 1.5 + Math.random() * 0.7, size: r * 0.45, grow: r * 1.3, gravity: 9, drag: 0.9,
        vx: (Math.random() - 0.5) * 3, vy: r * (1.5 + Math.random() * 0.7), vz: (Math.random() - 0.5) * 3,
      });
    }
    const nc = busy ? 4 : Math.min(18, Math.round(5 + r));
    for (let k = 0; k < nc; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = r * (0.4 + Math.random() * 0.8);
      this.smoke.emit(x, gy + 0.5, z, {
        color: k % 3 ? COL.clod : COL.clodDark, alpha: 0.95, life: 1.0 + Math.random() * 0.7, size: 0.5 + Math.random() * 0.6, grow: 0.1, gravity: 20, drag: 0.2,
        vx: Math.cos(a) * sp, vy: 5 + Math.random() * r * 1.1, vz: Math.sin(a) * sp,
      });
    }
    // Dust ring racing out along the ground.
    const nr = busy ? 4 : Math.min(14, Math.round(6 + r * 0.6));
    for (let k = 0; k < nr; k++) {
      const a = (k / nr) * Math.PI * 2 + Math.random() * 0.4;
      const sp = r * (2 + Math.random() * 0.8);
      this.smoke.emit(x + Math.cos(a) * r * 0.3, gy + 0.5, z + Math.sin(a) * r * 0.3, {
        color: COL.dust, alpha: 0.55, life: 2 + Math.random() * 1, size: r * 0.35, grow: r * 1.2 * Math.max(0.4, this.smokeScale), drag: 3, drift: 0.5,
        vx: Math.cos(a) * sp, vy: 0.3, vz: Math.sin(a) * sp,
      });
    }
    if (r >= 2.5) this.addCrater(x, gy, z, r * (heavy ? 0.55 : 0.45));
  }

  /** Persistent scorch / crater decal tilted to the local slope (ring buffer, oldest replaced). */
  private addCrater(x: number, gy: number, z: number, size: number): void {
    const e = 1.5;
    _n.set(this.heightAt(x - e, z) - this.heightAt(x + e, z), 2 * e, this.heightAt(x, z - e) - this.heightAt(x, z + e)).normalize();
    _q.setFromUnitVectors(_up, _n);
    _q2.setFromAxisAngle(_up, Math.random() * Math.PI * 2);
    _q.multiply(_q2);
    const s = size * (0.85 + Math.random() * 0.3);
    _m.compose(_p.set(x, gy + 0.12, z), _q, _s.set(s, 1, s));
    const slot = this.decalN < MAX_DECALS ? this.decalN++ : this.decalHead;
    if (slot === this.decalHead && this.decalN >= MAX_DECALS) this.decalHead = (this.decalHead + 1) % MAX_DECALS;
    this.craters.setMatrixAt(slot, _m);
    this.craters.count = this.decalN;
    this.craters.instanceMatrix.clearUpdateRanges();
    this.craters.instanceMatrix.needsUpdate = true;
  }

  /**
   * Draw projectiles (interpolated) as instanced shells/bombs; ballistic shells also get a
   * glowing head and light ribbon (ArtilleryFx), fast rounds a short trail line.
   */
  syncProjectiles(list: readonly Projectile[], alpha: number, dt = 1 / 60): void {
    let ns = 0;
    let nb = 0;
    this.lines.begin();
    this.arty.trails.begin();
    // Shells stay at least ~3 px across when zoomed out.
    const sc = Math.max(1, Math.min(6, 3 / (0.32 * this.pxPerM)));
    _s.set(sc, sc, sc);
    for (const p of list) {
      const x = p.prev.x + (p.pos.x - p.prev.x) * alpha;
      const y = p.prev.y + (p.pos.y - p.prev.y) * alpha;
      const z = p.prev.z + (p.pos.z - p.prev.z) * alpha;
      if (p.kind === 'bomb') {
        if (nb >= this.bombs.instanceMatrix.count) continue;
        _dir.set(p.vel.x, p.vel.y, p.vel.z).normalize();
        _q.setFromUnitVectors(_fwd, _dir);
        this.bombs.setMatrixAt(nb++, _m.compose(_p.set(x, y, z), _q, _one));
        continue;
      }
      if (ns >= this.shells.instanceMatrix.count) continue;
      // Artillery rounds are drawn a little fatter than AP shot (howitzer the biggest).
      const k = p.kind !== 'shell' ? sc : p.weapon?.id === 'howitzer_shell' ? sc * 1.6 : sc * 1.25;
      this.shells.setMatrixAt(ns++, _m.makeScale(k, k, k).setPosition(x, y, z));
      if (p.kind === 'shell') this.arty.shell(p, x, y, z, sc);
      else {
        const len = 0.05;
        this.lines.push(x, y, z, x - p.vel.x * len, y - p.vel.y * len, z - p.vel.z * len, COL.trail, 0.8, 0);
      }
    }
    this.arty.trails.end(dt, this.viewDir, this.pxPerM);
    this.shells.count = ns;
    this.bombs.count = nb;
    this.shells.instanceMatrix.needsUpdate = true;
    this.bombs.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.towns.update(dt, this.smokeScale);
    this.arty.update(dt);
    this.glow.update(dt);
    this.smoke.update(dt);
    // Tracers; the line pool was opened by syncProjectiles this frame.
    let write = 0;
    const tr = this.tr;
    for (let i = 0; i < this.trN; i++) {
      const life = this.trLife[i] + dt;
      if (life >= this.trMax[i]) continue;
      if (write !== i) {
        tr.copyWithin(write * 6, i * 6, i * 6 + 6);
        this.trMax[write] = this.trMax[i];
        this.trAlpha[write] = this.trAlpha[i];
        this.trCol[write] = this.trCol[i];
        this.trBolt[write] = this.trBolt[i];
      }
      this.trLife[write] = life;
      const o = write * 6;
      const col = TRACER_COLORS[this.trCol[write]];
      const f = life / this.trMax[write];
      const a = this.trAlpha[write];
      if (this.trBolt[write]) {
        const h = Math.min(1, f * 1.25);
        const t0 = Math.max(0, h - 0.3);
        const ax = tr[o], ay = tr[o + 1], az = tr[o + 2];
        const dx = tr[o + 3] - ax, dy = tr[o + 4] - ay, dz = tr[o + 5] - az;
        this.lines.push(ax + dx * t0, ay + dy * t0, az + dz * t0, ax + dx * h, ay + dy * h, az + dz * h, col, 0, a);
      } else {
        const fa = a * (1 - f);
        this.lines.push(tr[o], tr[o + 1], tr[o + 2], tr[o + 3], tr[o + 4], tr[o + 5], col, fa * 0.6, fa);
      }
      write++;
    }
    this.trN = write;
    this.lines.end();
    this.shake = Math.max(0, this.shake - dt * 1.5);
  }
}
