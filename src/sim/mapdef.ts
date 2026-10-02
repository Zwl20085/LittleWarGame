import type { V2 } from './vec';

export type ObjectiveType = 'manpower' | 'industry' | 'observation';

export interface HillDef {
  readonly x: number;
  readonly z: number;
  readonly r: number;
  readonly h: number;
  /** Optional flat plateau height (m) — the hill is clipped to this. */
  readonly plateau?: number;
}

export interface RidgeDef {
  readonly a: V2;
  readonly b: V2;
  readonly width: number;
  readonly h: number;
}

export interface CityDef {
  readonly name: { zh: string; en: string };
  readonly hq: V2;
  readonly exit: V2;
  readonly truck: V2;
  readonly vanguard: V2[];
  readonly recon: V2;
  readonly strongpoints: { pos: V2; facingDeg: number }[];
  /** Direction toward the battlefield (radians), for initial facing. */
  readonly forwardDeg: number;
  /** Edge of the map where this faction's aircraft enter. */
  readonly airEntry: V2;
}

export interface ObjectiveDef {
  readonly id: string;
  readonly type: ObjectiveType;
  readonly pos: V2;
  readonly name: { zh: string; en: string };
  /** Settlement size (generated maps): drives capture time, income and production slots. */
  readonly kind?: 'point' | 'village' | 'town' | 'city';
  /** Counts toward the majority-control resolve bleed (GAME_DESIGN §5.3). */
  readonly strategic?: boolean;
  readonly radius?: number;
}

/** Named geographic features, for map labels, terrain readouts and AI terrain analysis. */
export type FeatureKind = 'mountain' | 'hill' | 'river' | 'lake' | 'forest' | 'town' | 'city' | 'pass' | 'bridge' | 'ford';

export interface MapFeature {
  readonly kind: FeatureKind;
  readonly name: { zh: string; en: string };
  readonly pos: V2;
  /** Approximate extent radius (m) for label placement / hover hit-testing. */
  readonly radius: number;
}

export type SettlementKind = 'village' | 'town' | 'city' | 'capital';

export interface TownDef {
  readonly x: number;
  readonly z: number;
  readonly r: number;
  readonly buildings: number;
  /** Layout style: villages are organic clusters, towns/cities get street grids and landmarks. */
  readonly kind?: SettlementKind;
}

export interface RiverDef {
  readonly points: V2[];
  readonly width: number;
  readonly fords: V2[];
}

export interface MapDef {
  readonly id: string;
  readonly name: { zh: string; en: string };
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  readonly baseHeight: number;
  readonly noiseAmp: number;
  readonly hills: HillDef[];
  readonly ridges: RidgeDef[];
  readonly roads: V2[][];
  readonly forests: { x: number; z: number; r: number }[];
  readonly towns: TownDef[];
  readonly mud: { x: number; z: number; r: number }[];
  /** Rivers: deep water is impassable; roads crossing become bridges; fords are shallow crossings. */
  readonly rivers: RiverDef[];
  readonly cities: CityDef[];
  readonly objectives: ObjectiveDef[];
  /** Named features (generated maps fill this; hand-made maps may leave it empty). */
  readonly features?: MapFeature[];
  /**
   * Optional precomputed heightfield on a 4 m grid ((width/4+1) × (depth/4+1), row-major by z).
   * When present it replaces hills/ridges/noise. Generated maps use this.
   */
  readonly heightfield?: Float32Array;
}
