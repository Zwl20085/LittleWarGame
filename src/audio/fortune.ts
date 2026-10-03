import type { World } from '../sim/world';
import type { MusicMood, Outcome, Stinger } from './music';

/** Seconds between territory samples. */
const SAMPLE_EVERY = 1;
/** Time constant (s) of the "usual" territory the player holds. */
const TREND_TAU = 90;

/**
 * Reads the player's fortunes for the score: falling back (territory dropping below its
 * recent level), enemy capitals falling, and the final outcome. Cheap: one pass over the
 * objectives per second, one pass over the factions per frame.
 */
export class FortuneWatch implements MusicMood {
  retreat = false;
  outcome: Outcome = null;
  stinger: Stinger | null = null;
  private trend = -1;
  private acc = 0;
  private readonly alive: boolean[] = [];

  constructor(private readonly playerId: number, private readonly spectator: boolean, private readonly attract: boolean) {}

  update(dt: number, w: World, paused: boolean): void {
    this.stinger = null;
    const me = w.factions[this.playerId];
    const player = !this.spectator && !this.attract;
    if (w.result) this.outcome = !player || w.result.winners.includes(this.playerId) ? 'victory' : 'defeat';
    else if (player && me && !me.alive) this.outcome = 'defeat';
    for (const f of w.factions) {
      const was = this.alive[f.id];
      this.alive[f.id] = f.alive;
      // An enemy capital fell (we only learn about it after the first frame).
      if (was && !f.alive && f.id !== this.playerId && !this.attract && !this.outcome) this.stinger = 'capital';
    }
    if (!player || paused) return;
    this.acc += dt;
    if (this.acc < SAMPLE_EVERY) return;
    const step = this.acc;
    this.acc = 0;
    let owned = 0;
    for (const o of w.objectives) if (o.owner === this.playerId) owned++;
    if (this.trend < 0) this.trend = owned;
    this.trend += (owned - this.trend) * (1 - Math.exp(-step / TREND_TAU));
    // Hysteresis: losing ~2 points against the recent level is a retreat; recovering ends it.
    if (!this.retreat && owned <= this.trend - 1.6) this.retreat = true;
    else if (this.retreat && owned >= this.trend - 0.4) this.retreat = false;
  }
}
