/** Procedural music + sound effects (Web Audio, no assets). See engine.ts for the entry points. */
import { audio } from './engine';
import type { MusicEventKind } from './director';

export { audio, AudioSession, type SessionOptions } from './engine';
export { MUSIC_EVENTS, type MusicEventKind } from './director';
export { DOCTRINE_IDS, type DoctrineId } from './doctrines';

/**
 * Tell the score about the player's situation (docs/MUSIC.md): 'homeThreatened',
 * 'offensiveLaunched', 'capitalLost', 'capitalTaken', 'victory', 'defeat', 'quiet'.
 * Safe to call at any time and from any frame; the music reacts at the next bar.
 */
export function musicEvent(kind: MusicEventKind): void {
  audio.musicEvent(kind);
}

/** Colour the score with a doctrine theme ('builder' | 'blitz' | 'attrition' | 'maneuver'); null / unknown = default. */
export function setDoctrineTheme(id: string | null): void {
  audio.setDoctrineTheme(id);
}
