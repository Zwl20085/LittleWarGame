import type { RoadNet } from './roadnet';
import type { V2 } from './vec';

/**
 * 3.0 roads and railways: the run-time state on `world.transport` (V30_SPEC §10). Static
 * geometry comes from the map (`MapDef.roads / rails / stations`); ownership, cuts, trains and
 * engineer jobs change during the match. Plain data only (snapshot.ts mirrors a small part).
 */

export interface RailStation {
  readonly id: number;
  readonly pos: V2;
  /** Objective index of its settlement, or −1 − cityIdx for a capital. */
  readonly placeIdx: number;
  /** Lines touching this station. */
  readonly lines: number[];
}

export interface RailLine {
  readonly id: number;
  /** Station ids at the two ends (pts run a → b). */
  readonly a: number;
  readonly b: number;
  readonly pts: V2[];
  /** Cumulative length at each point. */
  readonly cum: number[];
  readonly len: number;
  /** Track torn up (a station fell to an enemy of its holder); engineers rebuild it. */
  cut: boolean;
  /** Faction that may run trains on it now (all stations held, track whole, no enemy ground across), else −1. */
  owner: number;
  /** Faction that last held every station of the line (−1 = never). */
  heldBy: number;
  /** Laid by engineers during the match (station → town extension). */
  readonly built: boolean;
}

export type TrainState = 'boarding' | 'running' | 'unloading';

export interface Train {
  readonly id: number;
  readonly owner: number;
  readonly from: number;
  readonly to: number;
  /** Route polyline (lines concatenated in travel order), its cumulative lengths and the line ids used. */
  readonly path: V2[];
  readonly cum: number[];
  readonly len: number;
  readonly lines: number[];
  state: TrainState;
  /** Distance travelled along `path`. */
  s: number;
  pos: V2;
  prev: V2;
  heading: number;
  /** Unit ids aboard (boarding order). */
  readonly riders: number[];
  /** Boarding: leaves at this time even if not full. Unloading: riders get off at this time. */
  timer: number;
}

export type TransportJobKind = 'road' | 'rail';

/** Engineer job: lay a road a → b, rebuild a cut rail line, or extend rail station → town. */
export interface TransportJob {
  readonly id: number;
  readonly owner: number;
  readonly kind: TransportJobKind;
  readonly a: V2;
  readonly b: V2;
  /** Rail: the cut line to rebuild (−1 = an extension a → b). */
  readonly lineId: number;
  /** Rail extension: the station it starts from and the objective index of the town it reaches. */
  readonly fromStation: number;
  readonly toPlace: number;
  readonly workSeconds: number;
  progress: number;
  /** Last time an engineer worked on it. */
  workedAt: number;
  /** Engineer assigned to it (unit id, −1 = none). */
  worker: number;
  readonly startedAt: number;
}

export interface TransportState {
  readonly roads: RoadNet;
  readonly stations: RailStation[];
  readonly lines: RailLine[];
  readonly trains: Train[];
  /** Units on a rail trip that are not aboard yet (walking to a station or waiting), in order. */
  readonly riders: number[];
  readonly jobs: TransportJob[];
  /** Engineer roads laid so far (render + snapshot). */
  readonly builtRoads: { a: V2; b: V2 }[];
  nextId: number;
  /** Bumped when lines / stations / built roads change (render rebuilds its meshes). */
  version: number;
}
