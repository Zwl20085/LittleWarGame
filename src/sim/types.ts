import type { HighCommand } from './command';
import type { UnitDef, WeaponDef } from '../data/types';
import type { ObjectiveType } from './mapdef';
import type { V2 } from './vec';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export type Posture = 'cautious' | 'assault' | 'hold' | 'fortify' | 'withdraw';
export type Behavior = 'rally' | 'advance' | 'hold' | 'retreat' | 'recover' | 'routing' | 'evacuate' | 'garrison';
export type SetupState = 'packed' | 'setting' | 'set' | 'packing';
export type MoraleState = 'normal' | 'suppressed' | 'pinned';
export type InfoMode = 'open' | 'fog';
/** Force doctrine: production mix and preferred battle operations. */
export type Personality = 'armor' | 'infantry' | 'artillery' | 'balanced' | 'mechanized';
export type Difficulty = 'easy' | 'normal' | 'hard';

export type ManualTask =
  | { type: 'move'; dest: V2; arrivedAt: number | null; hold: boolean }
  | { type: 'attackMove'; dest: V2; clearSince: number | null }
  | { type: 'focus'; targetId: number; startedAt: number }
  | { type: 'retreat' }
  | { type: 'hold'; pos: V2 };

export interface Unit {
  readonly id: number;
  readonly owner: number;
  readonly def: UnitDef;
  readonly primary: WeaponDef | null;
  readonly secondary: WeaponDef | null;
  pos: V2;
  prev: V2;
  y: number;
  heading: number;
  turret: number;
  hp: number;
  morale: number;
  suppression: number;
  lastSuppressedAt: number;
  routing: boolean;
  wavering: boolean;
  moraleState: MoraleState;
  ammo: number;
  supplyRatio: number;
  supplied: boolean;
  setup: SetupState;
  setupTimer: number;
  cooldown1: number;
  cooldown2: number;
  targetId: number | null;
  targetSince: number;
  targetScore: number;
  path: V2[];
  pathIdx: number;
  dest: V2 | null;
  repathAt: number;
  pathFailed: boolean;
  moving: boolean;
  speedNow: number;
  frontId: number;
  behavior: Behavior;
  manual: ManualTask | null;
  queue: ManualTask[];
  cover: 0 | 1 | 2 | 3;
  fortId: number | null;
  lastDamagedAt: number;
  lastFiredAt: number;
  noTargetSince: number;
  thinkAt: number;
  evacuateAt: number;
  /** Fixed strongpoints: immobile map-defined fortifications with an MG. */
  readonly fixed: boolean;
  readonly fixedFacing: number;
  /** Visual-only seed for squad layout. */
  readonly vseed: number;
  lastMoraleWipeAt: number;
  buildTargetId: number | null;
  status: string;
  /** Convoy state (supply trucks only). */
  cargo: number;
  truckState: 'load' | 'out' | 'unload' | 'return';
  truckDest: V2 | null;
  truckIdleSince: number;
  /** Last time a convoy handed this unit ammunition (or reached it). */
  lastSuppliedAt: number;
  /** Enemy truck this raider is hunting. */
  raidTargetId: number | null;
  /** Breakthrough target (objective id or `hq:<faction>`): spearhead units drive past the front. */
  spearhead: string | null;
  /** Operational role: holds the line, raids enemy supply, or guards our own convoy routes. */
  opRole: 'line' | 'raid' | 'rearguard' | 'garrison' | 'occupy' | 'maneuver' | 'infiltrate' | 'siege';
  /** Settlement this unit garrisons / occupies under a high-command directive. */
  opObjective: string | null;
  /** Preferred wall-slide side (+1 / −1) when a building blocks the way. */
  slideSide: number;
  /** Motorized infantry riding its trucks (fast, but fights only after dismounting). */
  mounted: boolean;
  /** Mount/dismount in progress until this time. */
  mountUntil: number;
  /** Facing of the finished field work sheltering this unit (null = none). */
  worksFacing: number | null;
  /** Earliest time for the next local building detour search. */
  detourAt: number;
  /** Local detours planned on the current waypoint leg (repath after a few). */
  detours: number;
  opTarget: V2 | null;
  opUntil: number;
  /** Indirect-fire salvos since the battery last moved (shoot-and-scoot). */
  salvos: number;
  /** Current path stops at the navigation horizon (ask for the next stretch on arrival). */
  pathPartial: boolean;
  /** Cached terrain speed factor (ground × grade) and the tick it was sampled (perf). */
  terrainMul: number;
  terrainMulAt: number;
  /** Waypoint index whose "next leg is wall-free" test has been evaluated, and its result (perf). */
  legCheckIdx: number;
  legClear: boolean;
  /** Stuck watchdog: waypoint index and distance at the last progress, and when that was. */
  progressIdx: number;
  progressD: number;
  progressAt: number;
}

/** 正面推进 / 侧面迂回 / 钳形攻势 / 武装渗透 / 筑垒围攻. */
export type OperationKind = 'frontal' | 'flank' | 'pincer' | 'infiltrate' | 'siege';

/**
 * 2.0 command hierarchy. The supreme HQ (the player, or the AI's theatre planner) gives each
 * front one high-level order; the front commander (a unit) turns it into tactics.
 *   auto     — the front commander picks its own objective (supreme HQ attack bias still applies)
 *   attack   — take the place / break the line at `a` (`b` = a line to assault along)
 *   defend   — hold the line a–b (a point: a line through `a` facing away from home)
 *   fortify  — hold the line a–b and have the engineers build works along it
 *   fallBack — give up the current ground and defend the (nearer) line a–b
 */
export type OrderKind = 'auto' | 'attack' | 'defend' | 'fortify' | 'fallBack';

export interface FrontOrder {
  readonly kind: OrderKind;
  readonly a: V2;
  /** Second point of a line order (null = a point order). */
  readonly b: V2 | null;
  readonly issuedAt: number;
  /** Who issued it: the player (manual) or the AI supreme HQ. */
  readonly manual: boolean;
}

/** A line the front holds / assaults along (from a line order, or chosen by the commander). */
export interface FrontLine {
  readonly a: V2;
  readonly b: V2;
}

/**
 * An army group with a front commander (2.0; was the fixed left/centre/right "sector").
 * Fronts are created and dissolved by the supreme HQ; `id` is unique per faction for the match.
 */
export interface Front {
  readonly id: number;
  /** Settlement id the front is named after (its current objective), '' until it has one. */
  name: string;
  /** Wing from the capital's view: -1 left, 0 centre, +1 right (replaces the old sector key). */
  wing: -1 | 0 | 1;
  /** The front commander unit (null while a replacement is on its way). */
  commanderId: number | null;
  /** When the commander was lost (−1 = none lost); the front fights without cohesion until replaced. */
  commanderLostAt: number;
  /** Standing supreme-HQ order. */
  order: FrontOrder;
  /** Line derived from the order (defend / fortify / fallBack, or an attack along a line), else null. */
  line: FrontLine | null;
  share: number;
  posture: Posture;
  targetPos: V2;
  targetObjective: string | null;
  targetCity: number | null;
  rally: V2;
  reason: string;
  reasonParams: Record<string, string | number>;
  lastRetarget: number;
  postureSince: number;
  manualTarget: boolean;
  gatheredSince: number;
  advancing: boolean;
  /** Centre of this group's battle line and the direction it faces (toward the enemy). */
  front: V2;
  facing: number;
  /** Formation slot per unit id (recomputed every front think). */
  slots: Record<number, V2>;
  /** Route crossing (bridge/ford) being staged for, if any. */
  crossing: { pos: V2; kind: 'bridge' | 'ford' | 'pass'; staging: V2; key: string } | null;
  stagedSince: number;
  lastSpearhead: number;
  /** Last time shells landed among this group (spacing doctrine). */
  shelledAt: number;
  /** River span this group's engineers should bridge (null = not needed). */
  bridgeSite: { a: V2; b: V2; mid: V2 } | null;
  bridgeCheckAt: number;
  /** This group's stretch of the faction front (angle-ordered cell centres). */
  segment: V2[];
  /** Current operational mode, for the UI. */
  mode: 'advance' | 'hold' | 'push' | 'breakthrough';
  /** Battle doctrine for this group's attack (AI-chosen unless the player locked one). */
  op: OperationKind;
  opLocked: boolean;
  /** Manoeuvre arrow for the map: front → waypoint(s) → objective (empty = none). */
  opRoute: V2[];
  /** Phase of the operation, for the UI ('form' | 'move' | 'assault' | 'dig' | ''). */
  opPhase: string;
}

export interface ProductionOrder {
  readonly id: number;
  readonly unitId: string;
  readonly facility: string;
  readonly slot: number;
  readonly manual: boolean;
  readonly frontId: number;
  remaining: number;
  total: number;
  readonly costP: number;
  readonly costM: number;
  blocked: boolean;
  /** Where the finished unit rolls out (an owned production place near its group's front). */
  readonly spawn: V2;
}
/* `frontId` on an order: the front the unit joins (-1 = the supreme HQ picks on roll-out). */

export interface SpendRecord {
  readonly tick: number;
  readonly unitId: string;
  readonly value: number;
}

export interface Faction {
  readonly id: number;
  readonly color: string;
  readonly roman: string;
  readonly isPlayer: boolean;
  readonly cityIdx: number;
  readonly personality: Personality;
  readonly difficulty: Difficulty;
  alive: boolean;
  eliminatedAt: number | null;
  p: number;
  m: number;
  alloc: [number, number, number];
  locks: [boolean, boolean, boolean];
  autoEconomy: boolean;
  stewardHoldUntil: number;
  stewardLastDir: number;
  stewardReason: string;
  stewardParams: Record<string, string | number>;
  resolve: number;
  popPresent: number;
  popReserved: number;
  logistics: number;
  supplyDemand: number;
  weights: Record<string, number>;
  caps: Record<string, number>;
  paused: Record<string, boolean>;
  spent: SpendRecord[];
  protectedOrder: { unitId: string; until: number } | null;
  protectRetryAt: number;
  /** Operations bookkeeping: next raid launch time. */
  nextRaidAt: number;
  /** Theatre commander state (directives, attack bias). */
  command: HighCommand;
  /** Ammunition waiting at the city depot for convoys (grows at logistics L per minute). */
  depot: number;
  lastWorksAt: number;
  orders: ProductionOrder[];
  manualQueue: { unitId: string; frontId: number }[];
  fronts: Front[];
  mainFront: number;
  /** Next front id (fronts are created and dissolved during the match). */
  frontSeq: number;
  incomeP: number;
  incomeM: number;
  overflowWarnAt: number;
  hqProgress: Record<number, number>;
  lostUnits: number;
  producedUnits: number;
  spentTotalP: number;
  spentTotalM: number;
  aiThinkAt: number;
  /** Supply trucks of this faction hit recently (id, time); escorts read this short list (perf). */
  trucksUnderFire: { id: number; at: number }[];
}

export interface Objective {
  readonly id: string;
  readonly type: ObjectiveType;
  readonly pos: V2;
  readonly name: { zh: string; en: string };
  readonly kind: 'point' | 'village' | 'town' | 'city';
  readonly strategic: boolean;
  /** Capture radius (m). */
  readonly radius: number;
  owner: number;
  progress: Record<number, number>;
  contested: boolean;
  activeAt: number;
}

export type ProjectileKind = 'ap' | 'shell';

export interface Projectile {
  readonly id: number;
  readonly owner: number;
  readonly weapon: WeaponDef | null;
  readonly kind: ProjectileKind;
  pos: V3;
  prev: V3;
  vel: V3;
  readonly targetId: number | null;
  readonly intendedHit: boolean;
  readonly sourceId: number;
  /** Attacker unit type for the stats ledger. */
  readonly srcType: string;
  readonly damage: number;
  readonly blastRadius: number;
  readonly suppression: number;
  readonly penetration: number;
  age: number;
  done: boolean;
}

/** 2.0: pillbox (炮楼) and bunker (堡垒) are engineer-built defensive buildings manned by squads. */
export type FortKind = 'field_cover' | 'mg_bunker' | 'trench' | 'sandbag' | 'pontoon' | 'pillbox' | 'bunker';

export interface Fort {
  readonly id: number;
  owner: number;
  /**
   * field_cover: sandbagged foxhole (1 squad). mg_bunker: concrete MG nest.
   * trench: dug line from start to end (siege works / field lines; many squads along it).
   * sandbag: barricade wall across a street or town edge, start to end (town defence).
   * pontoon: engineer bridge (start/end = banks).
   */
  readonly kind: FortKind;
  readonly pos: V2;
  readonly facing: number;
  /** Pontoon bridges: span endpoints (bank to bank) and deck length. */
  readonly start?: V2;
  readonly end?: V2;
  readonly length?: number;
  hp: number;
  readonly maxHp: number;
  progress: number;
  occupant: number | null;
  /** Defensive buildings: squads it can hold (default 1); occupants beyond `occupant` (bunkers). */
  readonly capacity?: number;
  occupants?: number[];
}

export type FxEvent =
  | { t: 'muzzle'; pos: V3; dir: number; big: boolean; weapon: string }
  | { t: 'tracer'; from: V3; to: V3; hit: boolean; weapon: string }
  | { t: 'explosion'; pos: V3; radius: number; kind: ProjectileKind | 'he' }
  | { t: 'death'; pos: V3; vehicle: boolean; unitType: string }
  | { t: 'ricochet'; pos: V3 };

export interface LogEntry {
  readonly tick: number;
  readonly key: string;
  readonly params: Record<string, string | number>;
  readonly faction: number;
  readonly severity: 'info' | 'warn' | 'alert';
}

export interface MatchConfig {
  /** 'generated' = procedural map from seed (default); the two hand-made maps remain as test maps. */
  readonly mapId: 'generated' | 'greystone_pinecreek' | 'four_cities';
  readonly mapSize?: 'medium' | 'large';
  /** Force-size multiplier (default from rules.json proposed_defaults.army_scale). */
  readonly armyScale?: number;
  readonly factions: number;
  readonly infoMode: InfoMode;
  readonly seed: number;
  readonly difficulty: Difficulty;
  readonly personalities?: Personality[];
  readonly playerSlot: number;
  readonly spectate?: boolean;
}

export interface MatchResult {
  readonly winners: number[];
  readonly reason: 'last_standing' | 'mutual';
  readonly tick: number;
}
