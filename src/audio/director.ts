/**
 * Music director (3.0): a small, deterministic state machine that turns the player's
 * situation events into musical decisions. Pure logic, no Web Audio.
 *
 * - `post(kind)` may be called at any time; nothing changes until the next bar boundary,
 *   when the Conductor calls `tick()` (events are applied in arrival order).
 * - Each event sets a *situation* that lasts a number of bars (tension floor, sombre colour,
 *   layer emphasis) and queues a *cue* (a short motif or stinger phrase).
 * - Urgent cues (home threatened, capital lost, victory, defeat) start at the very next bar;
 *   the others wait for a half-phrase boundary (every 4 bars) so the music turns musically.
 * - A lower-ranked event never overrides a higher-ranked situation that is still running;
 *   victory / defeat are terminal. `quiet` relaxes back to the normal score.
 */

export const MUSIC_EVENTS = ['homeThreatened', 'offensiveLaunched', 'capitalLost', 'capitalTaken', 'victory', 'defeat', 'quiet'] as const;
export type MusicEventKind = (typeof MUSIC_EVENTS)[number];

/** Cue phrases (theme ids in themes.ts). */
export type CueId = 'victory' | 'defeat' | 'capital' | 'threat' | 'offensive' | 'fall';

export type Situation = 'normal' | 'threat' | 'offensive' | 'falling' | 'triumph' | 'won' | 'lost';

interface Rule {
  readonly situation: Situation;
  /** How long the situation colours the score (bars); Infinity = terminal. */
  readonly bars: number;
  readonly cue: CueId;
  readonly urgent: boolean;
  readonly rank: number;
  /** Minimum effective battle intensity while the situation lasts. */
  readonly floor: number;
}

export const RULES: Record<Exclude<MusicEventKind, 'quiet'>, Rule> = {
  offensiveLaunched: { situation: 'offensive', bars: 24, cue: 'offensive', urgent: false, rank: 1, floor: 0.6 },
  homeThreatened: { situation: 'threat', bars: 24, cue: 'threat', urgent: true, rank: 2, floor: 0.42 },
  capitalTaken: { situation: 'triumph', bars: 12, cue: 'capital', urgent: true, rank: 3, floor: 0.4 },
  capitalLost: { situation: 'falling', bars: 32, cue: 'fall', urgent: true, rank: 4, floor: 0.3 },
  victory: { situation: 'won', bars: Infinity, cue: 'victory', urgent: true, rank: 5, floor: 0 },
  defeat: { situation: 'lost', bars: Infinity, cue: 'defeat', urgent: true, rank: 5, floor: 0 },
};

/** A cue is not replayed if the same situation is refreshed within this many bars. */
const CUE_COOLDOWN = 16;
const INBOX_MAX = 8;
const QUEUE_MAX = 2;

const RANK: Record<Situation, number> = { normal: 0, offensive: 1, threat: 2, triumph: 3, falling: 4, won: 5, lost: 5 };
const URGENT = new Set<CueId>(Object.values(RULES).filter((r) => r.urgent).map((r) => r.cue));

export function isMusicEvent(k: unknown): k is MusicEventKind {
  return typeof k === 'string' && (MUSIC_EVENTS as readonly string[]).includes(k);
}

export class Director {
  private readonly inbox: MusicEventKind[] = [];
  private readonly queue: CueId[] = [];
  private sit: Situation = 'normal';
  private left = 0;
  private bars = 0;
  private readonly lastCue = new Map<CueId, number>();

  get situation(): Situation {
    return this.sit;
  }

  /** Bars the current situation still lasts (Infinity when terminal, 0 when normal). */
  get barsLeft(): number {
    return this.left;
  }

  /** Tension floor for the current situation. */
  get floor(): number {
    return this.sit === 'normal' ? 0 : ruleFor(this.sit)?.floor ?? 0;
  }

  /** Sombre colouring (lament style, string-led) while the capital falls or after defeat. */
  get sombre(): boolean {
    return this.sit === 'falling' || this.sit === 'lost';
  }

  get outcome(): 'victory' | 'defeat' | null {
    return this.sit === 'won' ? 'victory' : this.sit === 'lost' ? 'defeat' : null;
  }

  /** Cues waiting for their bar (read-only view, for tests / debug). */
  get pending(): readonly CueId[] {
    return this.queue;
  }

  /** Queue an event; it takes effect at the next bar boundary. */
  post(kind: MusicEventKind): void {
    if (this.inbox.length < INBOX_MAX) this.inbox.push(kind);
  }

  /** Bar boundary: apply queued events, then age the situation by one bar. */
  tick(): void {
    this.bars++;
    if (this.left !== Infinity && this.left > 0 && --this.left === 0) this.sit = 'normal';
    for (const k of this.inbox.splice(0)) this.apply(k);
  }

  /**
   * The cue to start at this bar, if any: urgent cues always (a terminal cue even inside
   * another cue), others only at a half-phrase boundary and never inside another cue.
   */
  takeCue(atHalf: boolean, inCue: boolean): CueId | null {
    const c = this.queue[0];
    if (!c) return null;
    const terminal = c === 'victory' || c === 'defeat';
    if (inCue && !terminal) return null;
    if (!URGENT.has(c) && !atHalf) return null;
    this.queue.shift();
    this.lastCue.set(c, this.bars);
    return c;
  }

  private apply(k: MusicEventKind): void {
    if (k === 'quiet') {
      if (RANK[this.sit] >= 5) return;
      this.sit = 'normal';
      this.left = 0;
      this.queue.length = 0;
      return;
    }
    const r = RULES[k];
    if (RANK[this.sit] >= 5) return;
    if (RANK[this.sit] > r.rank) return;
    const refresh = this.sit === r.situation;
    this.sit = r.situation;
    this.left = r.bars;
    if (r.rank >= 5) this.queue.length = 0;
    const recent = refresh && this.bars - (this.lastCue.get(r.cue) ?? -Infinity) < CUE_COOLDOWN;
    if (recent || this.queue.includes(r.cue)) return;
    // A more important cue jumps the queue; the queue never grows beyond two cues.
    if (r.urgent) this.queue.unshift(r.cue);
    else this.queue.push(r.cue);
    if (this.queue.length > QUEUE_MAX) this.queue.length = QUEUE_MAX;
  }
}

function ruleFor(s: Situation): Rule | undefined {
  for (const r of Object.values(RULES)) if (r.situation === s) return r;
  return undefined;
}
