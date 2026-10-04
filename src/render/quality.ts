/** Render quality tiers, highest first. `auto` starts high and steps down when frames are slow. */
export type QualityMode = 'auto' | 'high' | 'medium' | 'low';
export type QualityLevel = 0 | 1 | 2;

export interface QualityProfile {
  /** Shadow map resolution (0 = shadows off). */
  readonly shadowMap: number;
  /** Soldier figures cast shadows when zoomed in. */
  readonly soldierShadows: boolean;
  /** Device pixel ratio cap. */
  readonly maxPixelRatio: number;
  /** Ground clutter (rocks, shrubs). */
  readonly scatter: boolean;
  /** Town detail (street furniture, gardens, yards, telegraph poles) and chimney smoke. */
  readonly townProps: boolean;
}

export const QUALITY_PROFILES: readonly QualityProfile[] = [
  { shadowMap: 2048, soldierShadows: true, maxPixelRatio: 2, scatter: true, townProps: true },
  { shadowMap: 1024, soldierShadows: false, maxPixelRatio: 1.5, scatter: false, townProps: false },
  { shadowMap: 0, soldierShadows: false, maxPixelRatio: 1, scatter: false, townProps: false },
];

const LEVEL_OF: Record<Exclude<QualityMode, 'auto'>, QualityLevel> = { high: 0, medium: 1, low: 2 };

/** Frame time (ms, smoothed) above which auto mode steps down one tier. */
const SLOW_MS = 24;
/** The frame time must stay slow this long (s) before stepping down. */
const SLOW_HOLD_S = 3;
/** Minimum spacing between automatic step-downs (s). */
const COOLDOWN_S = 12;

/**
 * Decides the active quality tier. In auto mode it watches the smoothed real frame time and
 * lowers the tier when the machine cannot hold a steady frame rate; it never steps back up
 * within a match (no flapping between tiers while the battle grows).
 */
export class QualityGovernor {
  level: QualityLevel = 0;
  private mode: QualityMode = 'auto';
  private ema = 16;
  private slowFor = 0;
  private sinceChange = 0;

  setMode(mode: QualityMode): QualityLevel {
    const was = this.mode;
    this.mode = mode;
    if (mode !== 'auto') this.level = LEVEL_OF[mode];
    else if (was !== 'auto') {
      // Back to auto: start high again and let the frame-time watch decide.
      this.level = 0;
      this.ema = 16;
      this.sinceChange = 0;
    }
    this.slowFor = 0;
    return this.level;
  }

  get profile(): QualityProfile {
    return QUALITY_PROFILES[this.level];
  }

  /** Feed one frame's real duration; returns the new level when the tier changed, else null. */
  update(realDt: number): QualityLevel | null {
    this.sinceChange += realDt;
    if (this.mode !== 'auto' || this.level >= 2) return null;
    // Ignore pauses / tab switches: a 100 ms+ gap is not a slow frame.
    if (realDt > 0.1) return null;
    this.ema += (realDt * 1000 - this.ema) * 0.08;
    if (this.ema > SLOW_MS) this.slowFor += realDt;
    else this.slowFor = Math.max(0, this.slowFor - realDt * 2);
    if (this.slowFor >= SLOW_HOLD_S && this.sinceChange >= COOLDOWN_S) {
      this.level = (this.level + 1) as QualityLevel;
      this.slowFor = 0;
      this.sinceChange = 0;
      this.ema = 16;
      return this.level;
    }
    return null;
  }
}
