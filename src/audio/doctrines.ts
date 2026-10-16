/**
 * Doctrine colours for the score (3.0). Each AI doctrine (docs/V30_SPEC.md §1) gets its own
 * theme plus an orchestration profile that colours every tension / battle phrase while it
 * is active: tempo offset, lead section, ostinato kind, snare and low-brass weight.
 * `setDoctrineTheme(id)` (index.ts) selects one; unknown ids fall back to the default score.
 */
import type { InstId } from './orchestra';
import type { ThemeId } from './themes';

export const DOCTRINE_IDS = ['builder', 'blitz', 'attrition', 'maneuver'] as const;
export type DoctrineId = (typeof DOCTRINE_IDS)[number];

export type OstKind = 'b8' | 'b16' | 'triplet' | 'march';

export interface DoctrineColour {
  readonly id: DoctrineId;
  readonly theme: ThemeId;
  /** Lead section for battle-tier statements (the tension tier uses horns or reeds). */
  readonly lead: InstId;
  /** Ostinato for battle phrases at tier 2 / tier 3. */
  readonly ost: readonly [OstKind, OstKind];
  /** Snare weight (0 = none, 1 = the default field snare). */
  readonly snare: number;
  /** Trombone / tuba weight in the battle harmony. */
  readonly lowBrass: number;
  /** Tempo offset (bpm) applied to the default battle themes while this doctrine is active. */
  readonly bpm: number;
}

export const DOCTRINES: Record<DoctrineId, DoctrineColour> = {
  // Economy first: lighter, string-led, woodwind colour, little snare.
  builder: { id: 'builder', theme: 'builder', lead: 'strings', ost: ['b8', 'b8'], snare: 0.45, lowBrass: 0.5, bpm: -6 },
  // One deep strike: driving 16ths, trumpets, full field snare.
  blitz: { id: 'blitz', theme: 'blitz', lead: 'brass', ost: ['b16', 'b16'], snare: 1.15, lowBrass: 0.9, bpm: 8 },
  // Grind: heavy march, trombones and timpani, slower.
  attrition: { id: 'attrition', theme: 'attrition', lead: 'horn', ost: ['march', 'march'], snare: 0.7, lowBrass: 1.3, bpm: -14 },
  // Decisive battle: triplet gallop, horns in unison, sweeping strings.
  maneuver: { id: 'maneuver', theme: 'maneuver', lead: 'strings', ost: ['triplet', 'triplet'], snare: 0.8, lowBrass: 1, bpm: 0 },
};

/** Validate an id from outside src/audio (UI / sim); anything unknown means "default score". */
export function asDoctrine(id: unknown): DoctrineId | null {
  return typeof id === 'string' && (DOCTRINE_IDS as readonly string[]).includes(id) ? (id as DoctrineId) : null;
}
