import type { GameData } from '../data/types';
import { NavGrid } from './nav';
import { Rng } from './rng';
import { SpatialHash } from './spatial';
import { Terrain } from './terrain';
import type { MapDef } from './mapdef';
import { MAPS } from './maps';
import { generateMap } from './mapgen';
import type { FrontInfo } from './frontai';
import type { BatteryReveal } from './operations';
import { createStats, type MatchStats } from './stats';
import type {
  Faction, Fort, FxEvent, LogEntry, MatchConfig, MatchResult, Objective, Plane, Projectile, Unit, Personality,
} from './types';
import type { V2 } from './vec';
import { DEG } from './vec';

export const FACTION_COLORS = ['#3D78A8', '#BA7D34', '#856DA8', '#3F8B83', '#A8457A', '#5FA8B8'];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const PERSONALITIES: Personality[] = ['balanced', 'armor', 'infantry', 'artillery'];

/**
 * Authoritative match state. Systems (economy, combat, ai …) mutate it only inside
 * `step()` at fixed ticks; UI reads it and issues commands through the CommandBus.
 * (Mutable entity state is intentional here: a 20 Hz simulation of hundreds of
 * entities cannot afford copy-on-write.)
 */
export class World {
  readonly dt: number;
  readonly tickHz: number;
  tick = 0;
  readonly map: MapDef;
  readonly terrain: Terrain;
  readonly units = new Map<number, Unit>();
  readonly factions: Faction[] = [];
  readonly objectives: Objective[] = [];
  readonly projectiles: Projectile[] = [];
  readonly planes: Plane[] = [];
  readonly forts: Fort[] = [];
  readonly fx: FxEvent[] = [];
  readonly log: LogEntry[] = [];
  readonly spatial = new SpatialHash(40);
  readonly rngCombat: Rng;
  readonly rngScatter: Rng;
  readonly rngAi: Rng;
  /** relation[a][b]: true when hostile. FFA = everyone hostile except self. */
  readonly hostile: boolean[][] = [];
  /** visibleTo[f] = set of enemy unit ids currently observed by faction f. */
  readonly visibleTo: Set<number>[] = [];
  /** lastSeen[f] = enemy id -> {tick, pos}. */
  readonly lastSeen: Map<number, { tick: number; pos: V2 }>[] = [];
  /** Hit resolutions queued during the weapons pass, applied together afterwards. */
  readonly deferred: (() => void)[] = [];
  /** Per-faction battle-front analysis (rebuilt every 2 s). */
  frontInfo: FrontInfo[] = [];
  /** Called when terrain changes at runtime (pontoon bridges): navigation must refresh. */
  onTerrainChanged: ((a: V2, b: V2) => void) | null = (a: V2, b: V2): void => {
    // Refresh only the changed box on every navigation grid built so far (flow fields reset).
    const pad = 24;
    for (const g of this.navCache.values()) {
      g.refreshArea(this.terrain, Math.min(a.x, b.x) - pad, Math.min(a.z, b.z) - pad, Math.max(a.x, b.x) + pad, Math.max(a.z, b.z) + pad);
    }
  };
  /** Sound-ranged enemy batteries (counter-battery intel). */
  readonly batteryReveals: BatteryReveal[] = [];
  result: MatchResult | null = null;
  /** Numeric analysis ledger (never read by the AI). */
  stats: MatchStats = createStats(0);
  private nextId = 1;
  private readonly navCache = new Map<number, NavGrid>();

  constructor(readonly data: GameData, readonly config: MatchConfig) {
    this.tickHz = data.rules.simulation.tick_hz;
    this.dt = 1 / this.tickHz;
    this.map = config.mapId === 'generated'
      ? generateMap({ seed: config.seed, factions: config.factions, size: config.mapSize ?? 'medium' })
      : MAPS[config.mapId]();
    this.terrain = new Terrain(this.map);
    this.spatial.setBounds(this.terrain.width, this.terrain.depth);
    this.rngCombat = new Rng(config.seed);
    this.rngScatter = new Rng(config.seed ^ 0x9e3779b9);
    this.rngAi = new Rng(config.seed ^ 0x7f4a7c15);
    const n = Math.min(config.factions, this.map.cities.length);
    for (let a = 0; a < n; a++) {
      this.hostile.push(Array.from({ length: n }, (_, b) => a !== b));
      this.visibleTo.push(new Set());
      this.lastSeen.push(new Map());
    }
    for (const o of this.map.objectives) {
      const kind = o.kind ?? 'point';
      const radius = o.radius ?? data.rules.victory.point_radius_m;
      this.objectives.push({ id: o.id, type: o.type, pos: o.pos, name: o.name, kind, strategic: o.strategic ?? true, radius, owner: -1, progress: {}, contested: false, activeAt: 0 });
    }
    this.personalitiesFor(n);
    this.stats = createStats(n);
  }

  private personalitiesFor(n: number): Personality[] {
    return Array.from({ length: n }, (_, i) => this.config.personalities?.[i] ?? PERSONALITIES[i % PERSONALITIES.length]);
  }

  get time(): number {
    return this.tick * this.dt;
  }

  newId(): number {
    return this.nextId++;
  }

  isHostile(a: number, b: number): boolean {
    return a !== b && (this.hostile[a]?.[b] ?? false);
  }

  nav(vehicle: boolean, maxSlopeDeg: number): NavGrid {
    // Numeric key: this is called several times per unit per tick (no string building).
    const key = maxSlopeDeg * 2 + (vehicle ? 1 : 0);
    let g = this.navCache.get(key);
    if (!g) {
      g = new NavGrid(this.terrain, { vehicle, maxSlopeDeg });
      this.navCache.set(key, g);
    }
    return g;
  }

  navFor(u: Unit): NavGrid {
    return this.nav(u.def.kind === 'vehicle', u.def.maxSlopeDeg);
  }

  emit(e: FxEvent): void {
    if (this.fx.length < 4000) this.fx.push(e);
  }

  note(faction: number, key: string, params: Record<string, string | number> = {}, severity: LogEntry['severity'] = 'info'): void {
    // Merge identical notes within 5 s (VISUAL_UX §8.3 rate limit).
    const since = this.tick - 5 * this.tickHz;
    for (let i = this.log.length - 1; i >= 0 && this.log[i].tick >= since; i--) {
      const l = this.log[i];
      if (l.faction === faction && l.key === key && JSON.stringify(l.params) === JSON.stringify(params)) return;
    }
    this.log.push({ tick: this.tick, key, params, faction, severity });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  unitAlive(id: number | null): Unit | null {
    if (id === null) return null;
    const u = this.units.get(id);
    return u && u.hp > 0 ? u : null;
  }

  cityOf(f: number): MapDef['cities'][number] {
    return this.map.cities[this.factions[f].cityIdx];
  }

  /** Does faction `f` currently know about enemy unit `u` (open mode: always). */
  knows(f: number, u: Unit): boolean {
    if (u.owner === f || this.config.infoMode === 'open') return true;
    return this.visibleTo[f].has(u.id);
  }

  spawnUnit(owner: number, unitId: string, pos: V2, sectorId: number, opts: { fixed?: boolean; facingDeg?: number; mirrorId?: number } = {}): Unit {
    const def = this.data.units.get(unitId);
    if (!def) throw new Error(`unknown unit ${unitId}`);
    const primary = def.primaryWeapon ? this.data.weapons.get(def.primaryWeapon)! : null;
    const secondary = def.secondaryWeapon ? this.data.weapons.get(def.secondaryWeapon)! : null;
    const city = this.map.cities[this.factions[owner]?.cityIdx ?? owner];
    const heading = opts.facingDeg !== undefined ? opts.facingDeg * DEG : city.forwardDeg * DEG;
    const u: Unit = {
      id: opts.mirrorId ?? this.newId(),
      owner,
      def,
      primary,
      secondary,
      pos: { ...pos },
      prev: { ...pos },
      y: this.terrain.heightAt(pos.x, pos.z),
      heading,
      turret: heading,
      hp: opts.fixed ? 1400 : def.maxHp,
      morale: 100,
      suppression: 0,
      lastSuppressedAt: -1e9,
      routing: false,
      wavering: false,
      moraleState: 'normal',
      ammo: 1,
      supplyRatio: 1,
      supplied: true,
      setup: opts.fixed ? 'set' : 'packed',
      setupTimer: 0,
      cooldown1: 0,
      cooldown2: 0,
      targetId: null,
      targetSince: 0,
      targetScore: 0,
      path: [],
      pathIdx: 0,
      dest: null,
      repathAt: 0,
      pathFailed: false,
      moving: false,
      speedNow: 0,
      sectorId,
      behavior: opts.fixed ? 'garrison' : 'rally',
      manual: null,
      queue: [],
      cover: opts.fixed ? 3 : 0,
      fortId: null,
      lastDamagedAt: -1e9,
      lastFiredAt: -1e9,
      noTargetSince: 0,
      thinkAt: 0,
      evacuateAt: 0,
      fixed: !!opts.fixed,
      fixedFacing: heading,
      vseed: (this.nextId * 2654435761) >>> 0,
      lastMoraleWipeAt: -1e9,
      buildTargetId: null,
      status: '',
      cargo: def.id === 'supply_truck' ? 20 : 0,
      truckState: 'load',
      truckDest: null,
      truckIdleSince: 0,
      lastSuppliedAt: 0,
      raidTargetId: null,
      spearhead: null,
      opRole: 'line',
      opObjective: null,
      slideSide: 1,
      detourAt: 0,
      detours: 0,
      opTarget: null,
      opUntil: 0,
      salvos: 0,
    };
    this.units.set(u.id, u);
    return u;
  }

  removeDead(): void {
    for (const [id, u] of this.units) if (u.hp <= 0) this.units.delete(id);
  }

  /** Point of a faction's city HQ. */
  hqPos(f: number): V2 {
    return this.cityOf(f).hq;
  }
}
