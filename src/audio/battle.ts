import type { CameraRig } from '../render/camera';
import type { World } from '../sim/world';
import { newReq, PRIO, type Mixer, type PlayReq } from './mixer';
import type { SoundId } from './recipes';

/** Sound categories. Each aggregates its events per frame and fires at most one voice per cooldown. */
const C = { Rifle: 0, Mg: 1, Cannon: 2, At: 3, Mortar: 4, How: 5, ExpS: 6, ExpB: 7, ApHit: 8, Rico: 9, VDeath: 10, Whistle: 11, Distant: 12, Count: 13 } as const;

interface CatDef {
  readonly name: string;
  readonly sound: SoundId;
  readonly cd: readonly [number, number];
  readonly max: number;
  readonly base: number;
  /** Beyond this many screen radii the event is culled (big ones then feed the distant bed). */
  readonly cull: number;
  readonly prio: number;
  /** Battle-intensity contribution per event at full proximity. */
  readonly energy: number;
  readonly rate: number;
}

const CATS: readonly CatDef[] = [
  { name: 'rifle', sound: 'rifle', cd: [0.16, 0.3], max: 4, base: 0.3, cull: 2.2, prio: PRIO.near, energy: 0.004, rate: 1 },
  { name: 'mg', sound: 'mg', cd: [0.3, 0.5], max: 3, base: 0.3, cull: 2.4, prio: PRIO.near, energy: 0.006, rate: 1 },
  { name: 'cannon', sound: 'cannon', cd: [0.2, 0.4], max: 3, base: 0.55, cull: 3.5, prio: PRIO.near, energy: 0.05, rate: 1 },
  { name: 'at', sound: 'at', cd: [0.2, 0.4], max: 3, base: 0.5, cull: 3.5, prio: PRIO.near, energy: 0.04, rate: 1 },
  { name: 'mortar', sound: 'mortar', cd: [0.25, 0.45], max: 2, base: 0.35, cull: 2.5, prio: PRIO.near, energy: 0.02, rate: 1 },
  { name: 'howitzer', sound: 'howitzer', cd: [0.25, 0.5], max: 2, base: 0.55, cull: 4.5, prio: PRIO.near, energy: 0.06, rate: 1 },
  { name: 'expSmall', sound: 'expSmall', cd: [0.12, 0.25], max: 4, base: 0.5, cull: 3, prio: PRIO.near, energy: 0.05, rate: 1 },
  { name: 'expBig', sound: 'expBig', cd: [0.25, 0.45], max: 3, base: 0.75, cull: 4.5, prio: PRIO.near, energy: 0.12, rate: 1 },
  { name: 'apHit', sound: 'apHit', cd: [0.2, 0.4], max: 2, base: 0.32, cull: 2, prio: PRIO.near, energy: 0.03, rate: 1 },
  { name: 'ricochet', sound: 'ricochet', cd: [0.18, 0.4], max: 2, base: 0.22, cull: 1.6, prio: PRIO.near, energy: 0, rate: 1 },
  { name: 'vehicleDeath', sound: 'vehicleDeath', cd: [0.2, 0.4], max: 2, base: 0.75, cull: 4, prio: PRIO.own, energy: 0.15, rate: 1 },
  { name: 'whistle', sound: 'whistle', cd: [0.9, 1.6], max: 1, base: 0.3, cull: 1.3, prio: PRIO.own, energy: 0, rate: 1 },
  { name: 'distant', sound: 'expBig', cd: [0.45, 0.9], max: 2, base: 0.22, cull: 99, prio: PRIO.distant, energy: 0, rate: 0.8 },
];

const N = C.Count;

type Loop = NonNullable<ReturnType<Mixer['loop']>>;

/**
 * Listens to the battle: reads `world.fx` (without consuming it) and projectiles,
 * positions everything relative to the screen centre, aggregates per category and enforces
 * per-category cooldowns so hundreds of firing units never become white noise.
 */
export class BattleListener {
  private readonly weaponCat = new Map<string, number>();
  // Per-frame aggregation.
  private readonly fBest = new Float64Array(N);
  private readonly fSum = new Float64Array(N);
  private readonly fPan = new Float64Array(N);
  private readonly fN = new Float64Array(N);
  // Pending (carried across frames until a voice fires).
  private readonly pBest = new Float64Array(N);
  private readonly pSum = new Float64Array(N);
  private readonly pPan = new Float64Array(N);
  private readonly pN = new Float64Array(N);
  private readonly cd = new Float64Array(N);
  // Stats (per second).
  private readonly evAcc = new Float64Array(N);
  private readonly playAcc = new Float64Array(N);
  readonly evRate = new Float64Array(N);
  readonly playRate = new Float64Array(N);
  private statT = 0;
  culled = 0;
  /** Last heavy event position (debug: lets QA scripts point the camera at the fighting). */
  hotX = 0;
  hotZ = 0;
  private hotE = 0;
  private readonly req: PlayReq = newReq();
  private readonly whistled = new Int32Array(64).fill(-1);
  private whistleHead = 0;
  private rumble: Loop | null = null;
  private loopT = 0;
  // Listener frame for this update.
  private tx = 0;
  private tz = 0;
  private rx = 1;
  private rz = 0;
  private radius = 200;
  private halfW = 200;
  /** 0.25 (whole table) – 1 (close in): zoomed-out views sound distant and dull. */
  zoomGain = 1;
  // Intensity inputs.
  private localEnergy = 0;
  private distantEnergy = 0;
  private fireRate = 0;
  private fireAcc = 0;
  /** 0–1 raw battle intensity (local energy + global combat). */
  intensity = 0;
  combat = 0;

  constructor(private readonly mix: Mixer) {}

  private catOf(weapon: string, big: boolean): number {
    const known = this.weaponCat.get(weapon);
    if (known !== undefined) return known;
    let c: number;
    if (weapon.includes('rifle')) c = C.Rifle;
    else if (weapon === 'mg' || weapon.endsWith('_mg')) c = C.Mg;
    else if (weapon === 'at_cannon') c = C.At;
    else if (weapon.includes('cannon')) c = C.Cannon;
    else if (weapon.startsWith('mortar')) c = C.Mortar;
    else if (weapon.startsWith('howitzer')) c = C.How;
    else c = big ? C.Cannon : C.Rifle;
    this.weaponCat.set(weapon, c);
    return c;
  }

  /** Accumulate one positioned event into a category. */
  private add(c: number, x: number, z: number, scale: number): void {
    this.evAcc[c]++;
    const dx = x - this.tx;
    const dz = z - this.tz;
    const n = Math.sqrt(dx * dx + dz * dz) / this.radius;
    const def = CATS[c];
    if (def.energy * scale >= this.hotE) {
      this.hotE = def.energy * scale;
      this.hotX = x;
      this.hotZ = z;
    }
    if (n > def.cull) {
      this.culled++;
      // Heavy events still rumble on the horizon.
      if (def.energy >= 0.04) {
        this.distantEnergy += def.energy * scale;
        this.add(C.Distant, x, z, scale * 0.5);
      }
      return;
    }
    // Horizon booms fall off far more gently than near-field sounds.
    const w = c === C.Distant ? scale / (1 + 0.12 * n * n) : scale / (1 + 2.2 * n * n);
    this.localEnergy += def.energy * w;
    this.fSum[c] += w;
    if (w > this.fBest[c]) {
      this.fBest[c] = w;
      this.fN[c] = n;
      const p = (dx * this.rx + dz * this.rz) / this.halfW;
      this.fPan[c] = p > 1 ? 0.8 : p < -1 ? -0.8 : p * 0.8;
    }
  }

  private setListener(rig: CameraRig): void {
    this.tx = rig.target.x;
    this.tz = rig.target.z;
    this.rx = Math.sin(rig.yaw);
    this.rz = -Math.cos(rig.yaw);
    const cam = rig.camera;
    const aspect = Math.max(0.5, (cam.right - cam.left) / Math.max(1, cam.top - cam.bottom));
    this.radius = Math.max(60, 230 / Math.max(0.05, rig.zoom));
    this.halfW = this.radius * aspect;
    this.zoomGain = Math.min(1, Math.max(0.25, 0.2 + 0.8 * Math.sqrt(rig.zoom / 1.6)));
  }

  update(dt: number, w: World, rig: CameraRig, paused: boolean, feed: boolean): void {
    this.setListener(rig);
    this.hotE *= Math.exp(-dt / 3);
    this.fBest.fill(0);
    this.fSum.fill(0);
    if (feed) {
      const fx = w.fx;
      for (let i = 0; i < fx.length; i++) {
        const e = fx[i];
        switch (e.t) {
          case 'muzzle':
            this.fireAcc++;
            this.add(this.catOf(e.weapon, e.big), e.pos.x, e.pos.z, 1);
            break;
          case 'explosion':
            if (e.kind === 'ap') this.add(C.ApHit, e.pos.x, e.pos.z, 1);
            else if (e.kind === 'shell') this.add(e.radius >= 8 ? C.ExpB : C.ExpS, e.pos.x, e.pos.z, 1);
            else if (e.kind === 'he') this.add(e.radius >= 4 ? C.ExpB : C.ExpS, e.pos.x, e.pos.z, e.radius >= 4 ? 1 : 0.45);
            break;
          case 'death':
            if (e.vehicle) this.add(C.VDeath, e.pos.x, e.pos.z, 1);
            break;
          case 'ricochet':
            this.add(C.Rico, e.pos.x, e.pos.z, 1);
            break;
        }
      }
      if (!paused) this.scanWhistles(w);
    }
    this.fire(dt);
    this.updateIntensity(dt, paused);
    this.loopT -= dt;
    if (this.loopT <= 0) {
      this.loopT = 0.06;
      this.updateLoops(paused || !feed);
    }
    this.stats(dt);
  }

  /** Fire at most one voice per category whose cooldown has elapsed. */
  private fire(dt: number): void {
    const decay = Math.exp(-dt / 0.25);
    const q = this.req;
    for (let c = 0; c < N; c++) {
      const fb = this.fBest[c];
      this.pBest[c] *= decay;
      this.pSum[c] = this.pSum[c] * decay + this.fSum[c];
      if (fb > 0 && fb >= this.pBest[c]) {
        this.pBest[c] = fb;
        this.pPan[c] = this.fPan[c];
        this.pN[c] = this.fN[c];
      }
      this.cd[c] -= dt;
      if (this.cd[c] > 0 || this.pBest[c] < 0.03 || c === C.Whistle) continue;
      const def = CATS[c];
      // Busy battlefields thin out small-arms triggers instead of stacking them.
      const busy = c === C.Rifle || c === C.Mg ? 1 + this.combat : 1;
      this.cd[c] = (def.cd[0] + Math.random() * (def.cd[1] - def.cd[0])) * busy;
      const crowd = Math.min(1.8, 1 + 0.3 * Math.log2(Math.max(1, this.pSum[c] / this.pBest[c])));
      const n = this.pN[c];
      q.id = def.sound;
      q.variant = -1;
      q.gain = def.base * this.zoomGain * this.pBest[c] * crowd;
      q.pan = this.pPan[c];
      q.cutoff = c === C.Distant ? 260 + Math.random() * 200 : 300 + 15000 * this.zoomGain * this.zoomGain * Math.exp(-1.8 * n);
      q.rate = def.rate * (0.94 + Math.random() * 0.12);
      q.delay = Math.random() * 0.04;
      q.bus = n > 0.9 || c === C.Distant ? 'far' : 'near';
      q.prio = def.prio;
      q.cat = c;
      q.catMax = def.max;
      if (this.mix.play(q)) this.playAcc[c]++;
      this.pBest[c] = 0;
      this.pSum[c] = 0;
    }
  }

  /** Incoming shells near the screen centre whistle just before they land. */
  private scanWhistles(w: World): void {
    if (this.zoomGain < 0.45) return;
    const g = w.data.rules.simulation.gravity_mps2;
    for (const p of w.projectiles) {
      if (p.kind !== 'shell' || p.vel.y >= 0 || p.done) continue;
      const dx = p.pos.x - this.tx;
      const dz = p.pos.z - this.tz;
      const n = Math.sqrt(dx * dx + dz * dz) / this.radius;
      if (n > CATS[C.Whistle].cull) continue;
      const h = p.pos.y - w.terrain.heightAt(p.pos.x, p.pos.z);
      const v = -p.vel.y;
      const tti = (-v + Math.sqrt(v * v + 2 * g * Math.max(0, h))) / g;
      const dur = 1.25;
      if (tti > dur * 1.05 || tti < dur * 0.6) continue;
      if (this.whistled.includes(p.id)) continue;
      if (this.cd[C.Whistle] > 0 || this.mix.catCount(C.Whistle) >= CATS[C.Whistle].max) continue;
      this.whistled[this.whistleHead] = p.id;
      this.whistleHead = (this.whistleHead + 1) % this.whistled.length;
      this.cd[C.Whistle] = CATS[C.Whistle].cd[0] + Math.random() * (CATS[C.Whistle].cd[1] - CATS[C.Whistle].cd[0]);
      this.evAcc[C.Whistle]++;
      const q = this.req;
      q.id = 'whistle';
      q.variant = -1;
      q.gain = CATS[C.Whistle].base * this.zoomGain / (1 + 2.2 * n * n);
      const pn = (dx * this.rx + dz * this.rz) / this.halfW;
      q.pan = Math.max(-0.8, Math.min(0.8, pn * 0.8));
      q.cutoff = 20000;
      q.rate = (dur / Math.max(0.3, tti)) * 1;
      q.rate = Math.max(0.85, Math.min(1.5, q.rate));
      q.delay = 0;
      q.bus = 'near';
      q.prio = PRIO.own;
      q.cat = C.Whistle;
      q.catMax = CATS[C.Whistle].max;
      if (this.mix.play(q)) this.playAcc[C.Whistle]++;
    }
  }

  /** The distant artillery rumble bed. */
  private updateLoops(silent: boolean): void {
    const t = this.mix.ctx.currentTime;
    if (!this.rumble) this.rumble = this.mix.loop('rumble', 0);
    if (this.rumble) {
      const target = silent ? 0 : Math.min(0.55, this.distantEnergy * 0.5 + this.combat * 0.12);
      this.rumble.gain.gain.setTargetAtTime(target, t, silent ? 0.6 : 1.2);
      this.rumble.filter.frequency.value = 220;
    }
  }

  private updateIntensity(dt: number, paused: boolean): void {
    if (paused) return;
    this.localEnergy *= Math.exp(-dt / 6);
    this.distantEnergy *= Math.exp(-dt / 4);
    this.fireRate += (this.fireAcc / Math.max(1e-3, dt) - this.fireRate) * Math.min(1, dt / 2);
    this.fireAcc = 0;
    this.combat = 1 - Math.exp(-this.fireRate / 80);
    const local = 1 - Math.exp(-this.localEnergy / 1.2);
    this.intensity = Math.min(1, 0.6 * local + 0.4 * this.combat);
  }

  private stats(dt: number): void {
    this.statT += dt;
    if (this.statT < 1) return;
    for (let c = 0; c < N; c++) {
      this.evRate[c] = this.evAcc[c] / this.statT;
      this.playRate[c] = this.playAcc[c] / this.statT;
    }
    this.evAcc.fill(0);
    this.playAcc.fill(0);
    this.statT = 0;
  }

  /** Per-category events/sec and voices/sec (for the debug hook). */
  rates(): Record<string, { ev: number; play: number }> {
    const out: Record<string, { ev: number; play: number }> = {};
    for (let c = 0; c < N; c++) out[CATS[c].name] = { ev: Math.round(this.evRate[c] * 10) / 10, play: Math.round(this.playRate[c] * 10) / 10 };
    return out;
  }

  /** Fade loops out (session ended). */
  silence(): void {
    const t = this.mix.ctx.currentTime;
    this.rumble?.gain.gain.setTargetAtTime(0, t, 0.5);
  }

  dispose(): void {
    const t = this.mix.ctx.currentTime;
    const L = this.rumble;
    if (!L) return;
    L.gain.gain.setTargetAtTime(0, t, 0.2);
    try { L.src.stop(t + 1.2); } catch { /* already stopped */ }
  }
}
