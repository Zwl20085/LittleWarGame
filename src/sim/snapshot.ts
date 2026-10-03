import type { SupplyNode } from './supply';
import type { Match } from './sim';
import type {
  Behavior, Faction, Fort, FxEvent, LogEntry, ManualTask, MatchResult, MoraleState, Objective, Projectile, SetupState, Unit,
} from './types';
import type { V2 } from './vec';

/**
 * Worker → main-thread state transfer. The worker owns the authoritative simulation; the main
 * thread keeps a read-only mirror World that the renderer and HUD read exactly as before.
 * Units are packed into one Float64Array (transferable); small collections are cloned.
 */

const SETUP: SetupState[] = ['packed', 'setting', 'set', 'packing'];
const MORALE: MoraleState[] = ['normal', 'suppressed', 'pinned'];
const BEHAVIOR: Behavior[] = ['rally', 'advance', 'hold', 'retreat', 'recover', 'routing', 'evacuate', 'garrison'];
const TRUCK: Unit['truckState'][] = ['load', 'out', 'unload', 'return'];

/** Field order of the packed unit record. */
const F = {
  id: 0, owner: 1, def: 2, x: 3, z: 4, px: 5, pz: 6, y: 7, heading: 8, turret: 9, hp: 10, morale: 11, supp: 12,
  ammo: 13, supplyRatio: 14, setup: 15, flags: 16, moraleState: 17, behavior: 18, target: 19, sector: 20, cargo: 21,
  truck: 22, fort: 23, cover: 24, vseed: 25, lastDamaged: 26, lastFired: 27, status: 28, speed: 29, lastSupplied: 30,
  setupTimer: 31, fixedFacing: 32,
} as const;
const STRIDE = 33;

export interface Snapshot {
  readonly tick: number;
  readonly units: Float64Array;
  readonly statusTable: string[];
  readonly manual: [number, ManualTask | null, number][];
  /** Null on most snapshots (sent every FACTION_EVERY-th snapshot). */
  readonly factions: Faction[] | null;
  /**
   * Objectives are static apart from owner / contest / activation / capture progress, so only
   * those travel, as flat arrays in map order (no 150 object clones per snapshot).
   */
  readonly objectives: { owner: Int8Array; contested: Uint8Array; activeAt: Float32Array; leader: Int8Array; progress: Float32Array };
  readonly projectiles: Projectile[];
  readonly forts: Fort[];
  readonly fx: FxEvent[];
  readonly log: LogEntry[];
  /** Observer's visible enemy ids and memory (fog mode only; null in open mode). */
  readonly visible: number[] | null;
  readonly lastSeen: [number, number, V2][] | null;
  readonly front: { owner: Int8Array; version: number } | null;
  readonly frontView: { owner: Int8Array; version: number } | null;
  readonly supplyNodes: SupplyNode[][];
  readonly result: MatchResult | null;
}

/** Per-consumer cursor so only new log entries / changed fields are sent. */
export interface SnapshotCursor {
  lastLog: LogEntry | null;
  frontVersion: number;
  viewVersion: number;
  statusIndex: Map<string, number>;
  statusSent: number;
  /** Snapshots made so far (faction records go out on every FACTION_EVERY-th). */
  sent: number;
  /** Unit type id → index in `unitOrder` (built once, not per snapshot). */
  defIndex: Map<string, number> | null;
}

export const newCursor = (): SnapshotCursor => ({ lastLog: null, frontVersion: -1, viewVersion: -1, statusIndex: new Map(), statusSent: 0, sent: 0, defIndex: null });

function packObjectives(objectives: readonly Objective[]): Snapshot['objectives'] {
  const n = objectives.length;
  const out = { owner: new Int8Array(n), contested: new Uint8Array(n), activeAt: new Float32Array(n), leader: new Int8Array(n), progress: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const o = objectives[i];
    out.owner[i] = o.owner;
    out.contested[i] = o.contested ? 1 : 0;
    out.activeAt[i] = o.activeAt;
    let leader = -1;
    let best = 0;
    for (const k in o.progress) {
      const v = o.progress[k as unknown as number];
      if (v > best) { best = v; leader = Number(k); }
    }
    out.leader[i] = leader;
    out.progress[i] = best;
  }
  return out;
}

/** Faction records are sent on every N-th snapshot (the HUD refreshes at 5 Hz). */
const FACTION_EVERY = 4;

export function makeSnapshot(match: Match, cur: SnapshotCursor, observer: number): Snapshot {
  const fog = match.world.config.infoMode === 'fog';
  cur.sent++;
  const w = match.world;
  const list = w.aliveUnits.filter((u) => u.hp > 0);
  const buf = new Float64Array(list.length * STRIDE);
  const defIndex = (cur.defIndex ??= new Map(w.data.unitOrder.map((id, i) => [id, i])));
  const manual: [number, ManualTask | null, number][] = [];
  list.forEach((u, k) => {
    const o = k * STRIDE;
    let st = cur.statusIndex.get(u.status);
    if (st === undefined) {
      st = cur.statusIndex.size;
      cur.statusIndex.set(u.status, st);
    }
    buf[o + F.id] = u.id; buf[o + F.owner] = u.owner; buf[o + F.def] = defIndex.get(u.def.id)!;
    buf[o + F.x] = u.pos.x; buf[o + F.z] = u.pos.z; buf[o + F.px] = u.prev.x; buf[o + F.pz] = u.prev.z; buf[o + F.y] = u.y;
    buf[o + F.heading] = u.heading; buf[o + F.turret] = u.turret; buf[o + F.hp] = u.hp; buf[o + F.morale] = u.morale;
    buf[o + F.supp] = u.suppression; buf[o + F.ammo] = u.ammo; buf[o + F.supplyRatio] = u.supplyRatio;
    buf[o + F.setup] = SETUP.indexOf(u.setup);
    buf[o + F.flags] = (u.moving ? 1 : 0) | (u.routing ? 2 : 0) | (u.wavering ? 4 : 0) | (u.supplied ? 8 : 0) | (u.fixed ? 16 : 0) | (u.pathFailed ? 32 : 0) | (u.mounted ? 64 : 0);
    buf[o + F.moraleState] = MORALE.indexOf(u.moraleState); buf[o + F.behavior] = BEHAVIOR.indexOf(u.behavior);
    buf[o + F.target] = u.targetId ?? -1; buf[o + F.sector] = u.sectorId; buf[o + F.cargo] = u.cargo;
    buf[o + F.truck] = TRUCK.indexOf(u.truckState); buf[o + F.fort] = u.fortId ?? -1; buf[o + F.cover] = u.cover;
    buf[o + F.vseed] = u.vseed; buf[o + F.lastDamaged] = u.lastDamagedAt; buf[o + F.lastFired] = u.lastFiredAt;
    buf[o + F.status] = st; buf[o + F.speed] = u.speedNow; buf[o + F.lastSupplied] = u.lastSuppliedAt;
    buf[o + F.setupTimer] = u.setupTimer; buf[o + F.fixedFacing] = u.fixedFacing;
    if (u.manual || u.queue.length) manual.push([u.id, u.manual, u.queue.length]);
  });
  // The status table is tiny (a few dozen keys); send it whole.
  const statusTable: string[] = [];
  for (const [s, i] of cur.statusIndex) statusTable[i] = s;
  // New log entries only (the log is capped, so track the last sent entry by identity).
  const from = cur.lastLog ? w.log.lastIndexOf(cur.lastLog) + 1 : 0;
  const log = w.log.slice(from);
  if (w.log.length) cur.lastLog = w.log[w.log.length - 1];
  const fx = w.fx.splice(0, w.fx.length);
  const front = match.front.version !== cur.frontVersion ? { owner: match.front.owner.slice(), version: match.front.version } : null;
  cur.frontVersion = match.front.version;
  const fv = match.frontView;
  const frontView = fv && fv.version !== cur.viewVersion ? { owner: fv.owner.slice(), version: fv.version } : null;
  if (fv) cur.viewVersion = fv.version;
  const seen = w.lastSeen[observer];
  return {
    tick: w.tick,
    units: buf,
    statusTable,
    manual,
    // Faction records (economy, orders, groups) feed the HUD, which refreshes at 5 Hz: sending
    // them with every snapshot (up to 60 Hz) is wasted cloning on both threads.
    factions: cur.sent % FACTION_EVERY === 0 ? w.factions.map((f) => ({ ...f, command: { ...f.command, attackBias: {}, threatAt: {} }, spent: [], sectors: f.sectors.map((s) => ({ ...s, slots: {}, segment: [], bridgeSite: null })) })) : null,
    objectives: packObjectives(w.objectives),
    projectiles: w.projectiles,
    forts: w.forts,
    fx,
    log,
    // Only the observer's visibility matters on the main thread, and only in fog mode.
    visible: fog && w.visibleTo[observer] ? [...w.visibleTo[observer]] : null,
    lastSeen: fog && seen ? [...seen].map(([id, v]) => [id, v.tick, v.pos]) : null,
    front,
    frontView,
    supplyNodes: match.supplyNodes,
    result: w.result,
  };
}

/** Apply a snapshot to the main-thread mirror (creates/updates/removes Unit objects in place). */
export function applySnapshot(match: Match, snap: Snapshot, observer: number): void {
  const w = match.world;
  const statusTable = snap.statusTable;
  const buf = snap.units;
  const n = buf.length / STRIDE;
  const seen = new Set<number>();
  const order = w.data.unitOrder;
  for (let k = 0; k < n; k++) {
    const o = k * STRIDE;
    const id = buf[o + F.id];
    seen.add(id);
    let u = w.units.get(id);
    if (!u) {
      const def = w.data.units.get(order[buf[o + F.def]])!;
      const fixed = (buf[o + F.flags] & 16) !== 0;
      u = w.spawnUnit(buf[o + F.owner], def.id, { x: buf[o + F.x], z: buf[o + F.z] }, buf[o + F.sector], { fixed, mirrorId: id });
    }
    u.pos.x = buf[o + F.x]; u.pos.z = buf[o + F.z]; u.prev.x = buf[o + F.px]; u.prev.z = buf[o + F.pz]; u.y = buf[o + F.y];
    u.heading = buf[o + F.heading]; u.turret = buf[o + F.turret]; u.hp = buf[o + F.hp]; u.morale = buf[o + F.morale];
    u.suppression = buf[o + F.supp]; u.ammo = buf[o + F.ammo]; u.supplyRatio = buf[o + F.supplyRatio];
    u.setup = SETUP[buf[o + F.setup]] ?? 'packed';
    const fl = buf[o + F.flags];
    u.moving = (fl & 1) !== 0; u.routing = (fl & 2) !== 0; u.wavering = (fl & 4) !== 0; u.supplied = (fl & 8) !== 0; u.pathFailed = (fl & 32) !== 0; u.mounted = (fl & 64) !== 0;
    u.moraleState = MORALE[buf[o + F.moraleState]] ?? 'normal'; u.behavior = BEHAVIOR[buf[o + F.behavior]] ?? 'advance';
    u.targetId = buf[o + F.target] < 0 ? null : buf[o + F.target]; u.sectorId = buf[o + F.sector]; u.cargo = buf[o + F.cargo];
    u.truckState = TRUCK[buf[o + F.truck]] ?? 'load'; u.fortId = buf[o + F.fort] < 0 ? null : buf[o + F.fort];
    u.cover = buf[o + F.cover] as Unit['cover']; u.lastDamagedAt = buf[o + F.lastDamaged]; u.lastFiredAt = buf[o + F.lastFired];
    u.status = statusTable[buf[o + F.status]] ?? ''; u.speedNow = buf[o + F.speed]; u.lastSuppliedAt = buf[o + F.lastSupplied];
    u.setupTimer = buf[o + F.setupTimer];
    u.manual = null;
    u.queue = [];
  }
  for (const [id, m, q] of snap.manual) {
    const u = w.units.get(id);
    if (u) {
      u.manual = m;
      u.queue = new Array(q).fill(m);
    }
  }
  for (const u of w.units.values()) if (!seen.has(u.id)) u.hp = 0;
  w.removeDead();
  w.tick = snap.tick;
  if (snap.factions) snap.factions.forEach((f, i) => Object.assign(w.factions[i], f));
  {
    const so = snap.objectives;
    for (let i = 0; i < w.objectives.length && i < so.owner.length; i++) {
      const o = w.objectives[i];
      o.owner = so.owner[i];
      o.contested = so.contested[i] === 1;
      o.activeAt = so.activeAt[i];
      const leader = so.leader[i];
      // Reuse the progress record when the leader is unchanged (no allocation per snapshot).
      if (leader < 0) {
        if (Object.keys(o.progress).length) o.progress = {};
      } else if (o.progress[leader] === undefined || Object.keys(o.progress).length !== 1) o.progress = { [leader]: so.progress[i] };
      else o.progress[leader] = so.progress[i];
    }
  }
  replace(w.projectiles, snap.projectiles);
  replace(w.forts, snap.forts);
  for (const e of snap.fx) w.fx.push(e);
  if (w.fx.length > 4000) w.fx.splice(0, w.fx.length - 4000);
  for (const l of snap.log) w.log.push(l);
  if (w.log.length > 400) w.log.splice(0, w.log.length - 400);
  if (snap.visible && w.visibleTo[observer]) {
    const set = w.visibleTo[observer];
    set.clear();
    for (const id of snap.visible) set.add(id);
  }
  const ls = w.lastSeen[observer];
  if (ls && snap.lastSeen) {
    ls.clear();
    for (const [id, tick, pos] of snap.lastSeen) ls.set(id, { tick, pos });
  }
  if (snap.front) {
    match.front.owner.set(snap.front.owner);
    match.front.version = snap.front.version;
  }
  if (snap.frontView && match.frontView) {
    match.frontView.owner.set(snap.frontView.owner);
    match.frontView.version = snap.frontView.version;
  }
  match.supplyNodes = snap.supplyNodes;
  w.result = snap.result;
  w.spatial.rebuild(w.aliveUnits);
}

function replace<T>(target: T[], src: T[]): void {
  target.length = 0;
  for (const x of src) target.push(x);
}
