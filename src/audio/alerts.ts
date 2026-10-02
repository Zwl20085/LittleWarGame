import type { LogEntry } from '../sim/types';
import type { World } from '../sim/world';
import { newReq, PRIO, type Mixer } from './mixer';
import type { SoundId } from './recipes';

const CAT_ALERT = 16;
const CAT_AMBIENT = 17;

interface Cue {
  readonly sound: SoundId;
  readonly gain: number;
  readonly cooldown: number;
  readonly danger: boolean;
  /** Optional follow-up (e.g. radio after the teleprinter). */
  readonly then?: SoundId;
}

const CUES: Record<string, Cue> = {
  'log.hqUnderAttack': { sound: 'alarm', gain: 0.4, cooldown: 10, danger: true },
  'log.eliminated': { sound: 'toll', gain: 0.45, cooldown: 4, danger: true },
  'log.pointTaken': { sound: 'chime', gain: 0.28, cooldown: 3, danger: false },
  'log.pointLost': { sound: 'teleprinter', gain: 0.32, cooldown: 3, danger: false, then: 'radio' },
  'log.spearhead': { sound: 'radio', gain: 0.2, cooldown: 6, danger: false },
  'log.raidLaunched': { sound: 'radio', gain: 0.18, cooldown: 8, danger: false },
  'log.convoyThreat': { sound: 'teleprinter', gain: 0.26, cooldown: 6, danger: false },
};
const GENERIC_ALERT: Cue = { sound: 'teleprinter', gain: 0.3, cooldown: 3, danger: false };
const GENERIC_WARN: Cue = { sound: 'teleprinter', gain: 0.2, cooldown: 4, danger: false };

/**
 * Watches the world log for the player's important events and plays operations-room cues
 * (brass bell, alarm, teleprinter, radio). Danger cues duck the battle bus briefly.
 */
export class AlertWatcher {
  private last: LogEntry | null = null;
  private readonly cool = new Map<string, number>();
  private gapUntil = 0;
  private ambientIn = 20 + Math.random() * 20;
  private readonly req = newReq();
  /** Audio time until which music intensity is held high (HQ under attack). */
  dangerUntil = 0;
  cues = 0;

  constructor(private readonly mix: Mixer, private readonly playerId: number, private readonly spectator: boolean, private readonly enabled: boolean, w: World) {
    // Do not replay history that existed before this session started.
    this.last = w.log.length ? w.log[w.log.length - 1] : null;
  }

  private relevant(l: LogEntry): boolean {
    if (!this.enabled || l.key.startsWith('log.protect')) return false;
    return this.spectator ? l.severity === 'alert' : l.faction === this.playerId;
  }

  update(dt: number, w: World, paused: boolean): void {
    const log = w.log;
    if (log.length && log[log.length - 1] !== this.last) {
      let from = this.last ? log.lastIndexOf(this.last) + 1 : 0;
      if (this.last && from === 0) {
        // Our cursor fell off the capped log: resume after its tick.
        const tick = this.last.tick;
        while (from < log.length && log[from].tick <= tick) from++;
      }
      for (let i = from; i < log.length; i++) if (this.relevant(log[i])) this.cue(log[i]);
      this.last = log[log.length - 1];
    }
    // Faint operations-room ambience: an occasional distant teleprinter or radio burst.
    if (this.enabled && !paused) {
      this.ambientIn -= dt;
      if (this.ambientIn <= 0) {
        this.ambientIn = 25 + Math.random() * 35;
        this.play(Math.random() < 0.5 ? 'teleprinter' : 'radio', 0.06, PRIO.distant, CAT_AMBIENT, 0, (Math.random() - 0.5) * 0.6);
      }
    }
  }

  private cue(l: LogEntry): void {
    const now = this.mix.ctx.currentTime;
    const c = CUES[l.key] ?? (l.severity === 'alert' ? GENERIC_ALERT : l.severity === 'warn' ? GENERIC_WARN : null);
    if (!c) return;
    if ((this.cool.get(l.key) ?? 0) > now) return;
    if (!c.danger && this.gapUntil > now) return;
    this.cool.set(l.key, now + c.cooldown);
    this.gapUntil = now + 0.8;
    let gain = c.gain;
    if (l.key === 'log.eliminated' && l.params.f !== this.playerId) gain *= 0.55;
    const danger = c.danger && (l.key !== 'log.eliminated' || l.params.f === this.playerId);
    this.play(c.sound, gain, danger ? PRIO.danger : PRIO.own, CAT_ALERT, 0, 0);
    if (c.then) this.play(c.then, gain * 0.6, PRIO.own, CAT_ALERT, 0.7, 0.2);
    if (danger) {
      this.dangerUntil = now + 20;
      // Priority: pull the battle down so the warning reads clearly.
      const p = this.mix.sfxDuck.gain;
      p.cancelScheduledValues(now);
      p.setTargetAtTime(0.45, now, 0.05);
      p.setTargetAtTime(1, now + 1.4, 0.6);
    }
  }

  private play(id: SoundId, gain: number, prio: number, cat: number, delay: number, pan: number): void {
    const q = this.req;
    q.id = id;
    q.variant = -1;
    q.gain = gain;
    q.pan = pan;
    q.cutoff = cat === CAT_AMBIENT ? 2500 : 20000;
    q.rate = 1;
    q.delay = delay;
    q.bus = 'alert';
    q.prio = prio;
    q.cat = cat;
    q.catMax = 3;
    if (this.mix.play(q)) this.cues++;
  }
}
