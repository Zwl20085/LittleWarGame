import type { FxEvent } from '../sim/types';
import { HeatGrid, type Hotspot } from './battleHeat';

/**
 * 3.0 camera modes (V30_SPEC §4): free (the 2.x camera), orbit (slow turntable around the
 * view centre), follow (ride behind a unit or a front), battle (auto-directed: frames the hottest
 * fight and cuts every 12–20 s through a dip to black) and overview (whole map, the previous view
 * remembered). Pure logic over a small rig / world interface so it is testable without WebGL.
 */
export type CameraMode = 'free' | 'orbit' | 'follow' | 'battle' | 'overview';
export const CAMERA_MODES: readonly CameraMode[] = ['free', 'orbit', 'follow', 'battle', 'overview'];

export type FollowRef = { readonly kind: 'unit'; readonly id: number } | { readonly kind: 'front'; readonly faction: number; readonly id: number };

interface P2 { readonly x: number; readonly z: number }

/** What the modes drive (CameraRig satisfies it). */
export interface CamRig {
  readonly target: { x: number; z: number };
  yaw: number;
  readonly yawTarget: number;
  readonly zoomTarget: number;
  readonly elevationGoal: number;
  readonly minZoom: number;
  easeRate: number;
  followRate: number | null;
  readonly panCount: number;
  readonly lookCount: number;
  follow: (() => P2 | null) | null;
  setZoom(z: number): void;
  setElevation(deg: number): void;
  setYawGoal(yaw: number): void;
  rotate(delta: number): void;
  lookAt(x: number, z: number): void;
}

/** What the modes read from the (mirror) world. */
export interface CamWorld {
  readonly terrain: { readonly width: number; readonly depth: number };
  unitAlive(id: number): { readonly pos: P2; readonly heading: number } | null | undefined;
  readonly factions: readonly { readonly fronts: readonly { readonly id: number; readonly front: P2; readonly facing: number }[] }[];
}

/** Tuning (render only). */
export const CAM = {
  /** Eased mode transition: target glide time (s) and the rig's easing rate meanwhile. */
  glideSeconds: 0.9,
  glideEaseRate: 3,
  normalEaseRate: 10,
  orbitSpin: 0.09,
  followUnit: { zoom: 3, elevation: 38, rate: 4, yawRate: 1.6 },
  followFront: { zoom: 1.5, elevation: 42, rate: 1.2, yawRate: 0.6 },
  overview: { elevation: 70 },
  battle: { minShot: 12, maxShot: 20, fadeLead: 0.45, dipHold: 0.15, retry: 3, zoomMin: 1.7, zoomMax: 2.6, elevMin: 35, elevMax: 41 },
} as const;

interface SavedView {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly elevation: number;
  readonly zoom: number;
  readonly mode: CameraMode;
  readonly follow: FollowRef | null;
}

interface Glide {
  readonly fromX: number;
  readonly fromZ: number;
  /** Fixed destination; null = the moving follow goal. */
  readonly to: P2 | null;
  t: number;
}

interface Shot {
  readonly spot: Hotspot;
  t: number;
  readonly duration: number;
  readonly spin: number;
  dipping: boolean;
}

const wrapPi = (a: number): number => {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t < 0 ? t + Math.PI * 2 : t) - Math.PI;
};
/** `goal` moved by whole turns to the turn nearest `from` (no full spins). */
export const nearestTurn = (from: number, goal: number): number => from + wrapPi(goal - from);
const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface CameraModesOptions {
  /** Random source for shot lengths and orbits (tests inject a fixed one). */
  readonly rng?: () => number;
  /** Dip to black on (true) / off (false) around a battle-cam cut. */
  readonly onDip?: (on: boolean) => void;
  /** Reduced motion: no orbit drift in battle shots and no dip (straight cuts). */
  readonly still?: boolean;
  /** Fallback battle spot when no fight is hot (e.g. where hostile units mix). */
  readonly fallback?: () => Hotspot | null;
}

export class CameraModes {
  private current: CameraMode = 'free';
  private followRef: FollowRef | null = null;
  private saved: SavedView | null = null;
  private glide: Glide | null = null;
  private shot: Shot | null = null;
  private retryIn = 0;
  private dipHold = 0;
  private lastPan: number;
  private lastLook: number;
  private followYaw: number | null = null;
  private snapped = false;
  /** Last non-free mode of this match (the HUD button re-enters it). */
  private remembered: CameraMode = 'battle';
  readonly heat: HeatGrid;
  private readonly rng: () => number;
  /** Called when the mode changes (HUD indicator). */
  onChange: ((mode: CameraMode) => void) | null = null;

  constructor(private readonly rig: CamRig, private readonly world: CamWorld, private readonly opts: CameraModesOptions = {}) {
    this.heat = new HeatGrid(world.terrain.width, world.terrain.depth);
    this.rng = opts.rng ?? Math.random;
    this.lastPan = rig.panCount;
    this.lastLook = rig.lookCount;
  }

  get mode(): CameraMode {
    return this.current;
  }
  get following(): FollowRef | null {
    return this.current === 'follow' ? this.followRef : null;
  }
  get lastMode(): CameraMode {
    return this.remembered;
  }
  /** Current battle-cam shot (tests / HUD). */
  get battleSpot(): Hotspot | null {
    return this.shot?.spot ?? null;
  }
  get overviewSaved(): boolean {
    return this.saved !== null;
  }

  /** Feed the frame's fx events (before the renderer consumes them). */
  ingest(events: readonly FxEvent[]): void {
    this.heat.ingest(events);
  }

  setMode(mode: CameraMode, follow?: FollowRef): boolean {
    if (mode === 'overview') return this.enterOverview();
    if (mode === 'follow') {
      const ref = follow ?? this.followRef;
      if (!ref || !this.followPoint(ref)) return false;
      this.followRef = ref;
    }
    this.saved = null;
    this.switchTo(mode);
    return true;
  }

  follow(ref: FollowRef): boolean {
    return this.setMode('follow', ref);
  }

  /** Overview on / off; off restores the remembered view and mode. */
  toggleOverview(): void {
    if (this.current === 'overview') this.leaveOverview();
    else this.enterOverview();
  }

  /** Esc: leave the current mode. True when something was left (the key is consumed). */
  exit(): boolean {
    if (this.current === 'free') return false;
    if (this.current === 'overview') this.leaveOverview();
    else this.switchTo('free');
    return true;
  }

  /** The HUD's mode button: free ⇄ the last mode used this match. */
  toggleRemembered(): void {
    if (this.current !== 'free') this.exit();
    else this.setMode(this.remembered);
  }

  private enterOverview(): boolean {
    if (this.current === 'overview') return true;
    const r = this.rig;
    this.saved = { x: r.target.x, z: r.target.z, yaw: r.yawTarget, elevation: r.elevationGoal, zoom: r.zoomTarget, mode: this.current, follow: this.followRef };
    this.switchTo('overview');
    r.setZoom(r.minZoom);
    r.setElevation(CAM.overview.elevation);
    this.startGlide({ x: this.world.terrain.width / 2, z: this.world.terrain.depth / 2 });
    return true;
  }

  private leaveOverview(): void {
    const s = this.saved;
    this.saved = null;
    if (!s) {
      this.switchTo('free');
      return;
    }
    const back = s.mode === 'overview' ? 'free' : s.mode;
    if (back === 'follow' && s.follow && this.followPoint(s.follow)) this.followRef = s.follow;
    this.switchTo(back === 'follow' && !this.followRef ? 'free' : back);
    if (this.current !== 'follow' && this.current !== 'battle') {
      this.startGlide({ x: s.x, z: s.z });
      this.rig.setYawGoal(nearestTurn(this.rig.yaw, s.yaw));
    }
    this.rig.setZoom(s.zoom);
    this.rig.setElevation(s.elevation);
  }

  private switchTo(mode: CameraMode): void {
    const r = this.rig;
    const was = this.current;
    this.current = mode;
    if (mode !== 'free' && mode !== 'overview') this.remembered = mode;
    r.follow = null;
    r.followRate = null;
    this.followYaw = null;
    this.shot = null;
    this.glide = null;
    this.lastPan = r.panCount;
    this.lastLook = r.lookCount;
    if (this.dipHold > 0 || was === 'battle') this.opts.onDip?.(false);
    this.dipHold = 0;
    r.easeRate = mode === 'free' ? CAM.normalEaseRate : CAM.glideEaseRate;
    if (mode === 'follow' && this.followRef) {
      const ref = this.followRef;
      const cfg = ref.kind === 'unit' ? CAM.followUnit : CAM.followFront;
      r.followRate = cfg.rate;
      r.follow = () => this.followPoint(ref);
      r.setZoom(cfg.zoom);
      r.setElevation(cfg.elevation);
    }
    if (mode === 'battle') this.cut(false);
    if (was !== mode) this.onChange?.(mode);
  }

  private followPoint(ref: FollowRef): (P2 & { heading: number }) | null {
    if (ref.kind === 'unit') {
      const u = this.world.unitAlive(ref.id);
      return u ? { x: u.pos.x, z: u.pos.z, heading: u.heading } : null;
    }
    const s = this.world.factions[ref.faction]?.fronts.find((f) => f.id === ref.id);
    return s ? { x: s.front.x, z: s.front.z, heading: s.facing } : null;
  }

  /** Move the view centre (the modes' own moves are not mistaken for a UI jump). */
  private look(x: number, z: number): void {
    this.rig.lookAt(x, z);
    this.lastLook = this.rig.lookCount;
  }

  private startGlide(to: P2 | null): void {
    this.glide = { fromX: this.rig.target.x, fromZ: this.rig.target.z, to, t: 0 };
    this.rig.easeRate = CAM.glideEaseRate;
  }

  /** Per frame (real seconds), before the rig update. */
  update(dt: number): void {
    const r = this.rig;
    this.heat.decay(dt);
    if (this.snapped) {
      // A hard cut snapped the rig for one update (inside the black); ease normally again.
      this.snapped = false;
      if (this.current === 'battle') r.easeRate = CAM.glideEaseRate;
    }
    if (r.panCount !== this.lastPan || r.lookCount !== this.lastLook) {
      // A manual pan, or a jump from the UI (minimap click, "go to" buttons).
      this.lastPan = r.panCount;
      this.lastLook = r.lookCount;
      this.glide = null;
      // A manual pan takes the camera back (orbit and overview keep running around the new spot).
      if (this.current === 'follow' || this.current === 'battle') this.switchTo('free');
    }
    if (this.glide) this.stepGlide(dt);
    switch (this.current) {
      case 'orbit':
        r.rotate(CAM.orbitSpin * dt);
        break;
      case 'follow':
        this.stepFollow(dt);
        break;
      case 'battle':
        this.stepBattle(dt);
        break;
      default:
        break;
    }
    if (!this.glide && this.current !== 'follow' && this.current !== 'battle' && r.easeRate !== CAM.normalEaseRate) r.easeRate = CAM.normalEaseRate;
  }

  private stepGlide(dt: number): void {
    const g = this.glide!;
    g.t += dt / CAM.glideSeconds;
    const to = g.to;
    if (to) {
      const k = smooth(g.t);
      this.look(g.fromX + (to.x - g.fromX) * k, g.fromZ + (to.z - g.fromZ) * k);
    }
    if (g.t >= 1) this.glide = null;
  }

  private stepFollow(dt: number): void {
    const ref = this.followRef;
    const p = ref ? this.followPoint(ref) : null;
    if (!ref || !p) {
      // The unit died or the front closed: hold the last view in free mode.
      this.switchTo('free');
      return;
    }
    const cfg = ref.kind === 'unit' ? CAM.followUnit : CAM.followFront;
    // Ride behind: the followed heading points up the screen, smoothed so jitter never swings it.
    const goal = p.heading + Math.PI;
    const r = this.rig;
    if (this.followYaw === null) this.followYaw = nearestTurn(r.yaw, goal);
    const k = 1 - Math.exp(-dt * cfg.yawRate);
    this.followYaw += wrapPi(goal - this.followYaw) * k;
    r.setYawGoal(nearestTurn(r.yaw, this.followYaw));
  }

  private stepBattle(dt: number): void {
    const r = this.rig;
    if (this.dipHold > 0) {
      this.dipHold -= dt;
      if (this.dipHold <= 0) this.opts.onDip?.(false);
    }
    const s = this.shot;
    if (!s) {
      this.retryIn -= dt;
      if (this.retryIn <= 0) this.cut(false);
      return;
    }
    s.t += dt;
    if (!this.opts.still) r.rotate(s.spin * dt);
    const left = s.duration - s.t;
    if (left < CAM.battle.fadeLead && !s.dipping && !this.opts.still) {
      s.dipping = true;
      this.opts.onDip?.(true);
    }
    if (left <= 0) this.cut(true);
  }

  /** Pick the next fight and frame it; `hard` = a cut under the dip (instant), else a glide. */
  private cut(hard: boolean): void {
    const B = CAM.battle;
    const prev = this.shot?.spot ?? null;
    const spot = this.heat.hottest(prev) ?? this.opts.fallback?.() ?? null;
    if (!spot) {
      this.shot = null;
      this.retryIn = B.retry;
      if (hard) this.opts.onDip?.(false);
      return;
    }
    const rnd = this.rng;
    const shot: Shot = {
      spot,
      t: 0,
      duration: B.minShot + rnd() * (B.maxShot - B.minShot),
      spin: (rnd() < 0.5 ? -1 : 1) * (0.03 + rnd() * 0.04),
      dipping: false,
    };
    this.shot = shot;
    const r = this.rig;
    const zoom = B.zoomMin + rnd() * (B.zoomMax - B.zoomMin);
    const elev = B.elevMin + rnd() * (B.elevMax - B.elevMin);
    const yaw = nearestTurn(r.yaw, r.yaw + (rnd() - 0.5) * Math.PI * 1.2);
    r.setZoom(zoom);
    r.setElevation(elev);
    r.setYawGoal(yaw);
    if (hard) {
      r.easeRate = 1000; // settle within the black frame
      this.look(spot.x, spot.z);
      r.yaw = yaw;
      this.glide = null;
      this.dipHold = B.dipHold;
      this.snapped = true;
    } else {
      this.startGlide(spot);
    }
  }
}
