import type { SupplyNode } from './supply';
import type { Match } from './sim';
import type { MatchStats } from './stats';
import type {
  Behavior, EconBuilding, Faction, Fort, FxEvent, LogEntry, ManualTask, MatchResult, MoraleState, Objective, Projectile, SetupState, Unit,
} from './types';
import type { V2 } from './vec';
import { applyTransport, mirrorRide, packTransport, type TransportSnap } from './transportsnap';
import type { EconZone } from './econZones';
import { refit } from './upgradestats';
import { fogFiltered, knownZones } from './fogview';

/**
 * Worker → main-thread state transfer. The worker owns the authoritative simulation; the main
 * thread keeps a read-only mirror World that the renderer and HUD read exactly as before.
 * Units are packed into one Float64Array (transferable); small collections are cloned.
 */

const SETUP: SetupState[] = ['packed', 'setting', 'set', 'packing'];
const MORALE: MoraleState[] = ['normal', 'suppressed', 'pinned'];
const BEHAVIOR: Behavior[] = ['rally', 'advance', 'hold', 'retreat', 'recover', 'routing', 'evacuate', 'garrison'];
const TRUCK: Unit['truckState'][] = ['load', 'out', 'unload', 'return'];

const SETUP_IDX: Readonly<Record<SetupState, number>> = { packed: 0, setting: 1, set: 2, packing: 3 };
const MORALE_IDX: Readonly<Record<MoraleState, number>> = { normal: 0, suppressed: 1, pinned: 2 };
const BEHAVIOR_IDX: Readonly<Record<Behavior, number>> = {
  rally: 0, advance: 1, hold: 2, retreat: 3, recover: 4, routing: 5, evacuate: 6, garrison: 7,
};
const TRUCK_IDX: Readonly<Record<Unit['truckState'], number>> = { load: 0, out: 1, unload: 2, return: 3 };

/**
 * Field order of the packed unit record.
 * `flags` bit-packs boolean flags (bits 0..7) plus small enums:
 * - bits 8..9: setup (0..3)
 * - bits 10..11: moraleState (0..2)
 * - bits 12..14: behavior (0..7)
 * - bits 15..16: truckState (0..3)
 */
const F = {
  id: 0, owner: 1, def: 2, x: 3, z: 4, px: 5, pz: 6, y: 7, heading: 8, turret: 9, hp: 10, morale: 11, supp: 12,
  ammo: 13, supplyRatio: 14, flags: 15, target: 16, front: 17, cargo: 18,
  fort: 19, cover: 20, vseed: 21, lastDamaged: 22, lastFired: 23, status: 24, speed: 25, lastSupplied: 26,
  setupTimer: 27, fixedFacing: 28, upg: 29,
} as const;
const STRIDE = 30;

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
  /** Null on most snapshots: sent every FORT_EVERY-th, and whenever works are added or removed. */
  readonly forts: Fort[] | null;
  /** 2.2 supply stock per place (world.places order) and economic buildings (render + town panel). */
  readonly placeStock: Float32Array;
  readonly placeContestedSince: Float32Array;
  readonly econ: EconBuilding[];
  /** 3.0 economic zones (econZones.ts; render + zone panel). */
  readonly econZones: EconZone[];
  readonly fx: FxEvent[];
  readonly log: LogEntry[];
  /** Observer's visible enemy ids and memory (fog mode only; null in open mode). */
  readonly visible: number[] | null;
  readonly lastSeen: [number, number, V2][] | null;
  readonly front: { owner: Int8Array; version: number } | null;
  readonly frontView: { owner: Int8Array; version: number } | null;
  /** Null on most snapshots (sent with the faction records; only the supply layer reads it). */
  readonly supplyNodes: SupplyNode[][] | null;
  readonly result: MatchResult | null;
  readonly stats?: MatchStats | null;
  /** 3.0 roads and railways (transportsnap.ts): line state and trains every snapshot, geometry when it changed. */
  readonly transport: TransportSnap | null;
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
  /** Number of works in the last fort list sent (-1 = never sent). */
  fortCount?: number;
  /** transport.version last sent (-1 = never). */
  transportVersion?: number;
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
/** Works (hp, build progress) are cloned every other snapshot: 70–100 records late in a war. */
const FORT_EVERY = 2;

export function makeSnapshot(match: Match, cur: SnapshotCursor, observer: number): Snapshot {
  const fog = match.world.config.infoMode === 'fog';
  cur.sent++;
  const w = match.world;
  const raw = w.aliveUnits;
  let alive = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i].hp > 0) alive++;
  const buf = new Float64Array(alive * STRIDE);
  const defIndex = (cur.defIndex ??= new Map(w.data.unitOrder.map((id, i) => [id, i])));
  const manual: [number, ManualTask | null, number][] = [];
  let o = 0;
  for (let i = 0; i < raw.length; i++) {
    const u = raw[i];
    if (u.hp <= 0) continue;
    let st = cur.statusIndex.get(u.status);
    if (st === undefined) {
      st = cur.statusIndex.size;
      cur.statusIndex.set(u.status, st);
    }
    buf[o + F.id] = u.id; buf[o + F.owner] = u.owner; buf[o + F.def] = defIndex.get(u.def.id)!;
    buf[o + F.x] = u.pos.x; buf[o + F.z] = u.pos.z; buf[o + F.px] = u.prev.x; buf[o + F.pz] = u.prev.z; buf[o + F.y] = u.y;
    buf[o + F.heading] = u.heading; buf[o + F.turret] = u.turret; buf[o + F.hp] = u.hp; buf[o + F.morale] = u.morale;
    buf[o + F.supp] = u.suppression; buf[o + F.ammo] = u.ammo; buf[o + F.supplyRatio] = u.supplyRatio;
    buf[o + F.flags] =
      (u.moving ? 1 : 0) | (u.routing ? 2 : 0) | (u.wavering ? 4 : 0) | (u.supplied ? 8 : 0) |
      (u.fixed ? 16 : 0) | (u.pathFailed ? 32 : 0) | (u.mounted ? 64 : 0) | (u.rail?.stage === 'aboard' ? 128 : 0) |
      ((SETUP_IDX[u.setup] & 3) << 8) | ((MORALE_IDX[u.moraleState] & 3) << 10) |
      ((BEHAVIOR_IDX[u.behavior] & 7) << 12) | ((TRUCK_IDX[u.truckState] & 3) << 15);
    buf[o + F.target] = u.targetId ?? -1; buf[o + F.front] = u.frontId; buf[o + F.cargo] = u.cargo;
    buf[o + F.fort] = u.fortId ?? -1; buf[o + F.cover] = u.cover;
    buf[o + F.vseed] = u.vseed; buf[o + F.lastDamaged] = u.lastDamagedAt; buf[o + F.lastFired] = u.lastFiredAt;
    buf[o + F.status] = st; buf[o + F.speed] = u.speedNow; buf[o + F.lastSupplied] = u.lastSuppliedAt;
    buf[o + F.setupTimer] = u.setupTimer; buf[o + F.fixedFacing] = u.fixedFacing; buf[o + F.upg] = u.upg;
    if (u.manual || u.queue.length) manual.push([u.id, u.manual, u.queue.length]);
    o += STRIDE;
  }
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
  const sendForts = cur.sent % FORT_EVERY === 0 || w.forts.length !== (cur.fortCount ?? -1);
  if (sendForts) cur.fortCount = w.forts.length;
  const slow = cur.sent % FACTION_EVERY === 0;
  const np = w.places.length;
  const placeStock = new Float32Array(np);
  const placeContestedSince = new Float32Array(np);
  for (let i = 0; i < np; i++) {
    placeStock[i] = w.places[i].stock;
    placeContestedSince[i] = w.places[i].contestedSince;
  }
  return {
    tick: w.tick,
    units: buf,
    statusTable,
    manual,
    // Faction records (economy, orders, groups) feed the HUD, which refreshes at 5 Hz: sending
    // them with every snapshot (up to 60 Hz) is wasted cloning on both threads.
    factions: slow ? w.factions.map((f) => ({ ...f, command: { ...f.command, attackBias: {}, threatAt: {} }, spent: [], fronts: f.fronts.map((s) => ({ ...s, slots: {}, segment: [], bridgeSite: null })) })) : null,
    objectives: packObjectives(w.objectives),
    projectiles: w.projectiles,
    forts: sendForts ? w.forts : null,
    placeStock,
    placeContestedSince,
    econ: w.econ,
    // Review HIGH 2: in fog the observer gets only the zones it knows (fogview.ts).
    econZones: fogFiltered(w, observer) ? knownZones(w, observer) : w.econZones,
    fx,
    log,
    // Only the observer's visibility matters on the main thread, and only in fog mode.
    visible: fog && w.visibleTo[observer] ? [...w.visibleTo[observer]] : null,
    lastSeen: fog && seen ? [...seen].map(([id, v]) => [id, v.tick, v.pos]) : null,
    front,
    frontView,
    supplyNodes: slow || cur.sent === 1 ? match.supplyNodes : null,
    result: w.result,
    stats: w.result || cur.sent % 20 === 0 ? w.stats : null,
    transport: packTransport(w, cur, observer),
  };
}

/** Apply a snapshot to the main-thread mirror (creates/updates/removes Unit objects in place). */
export function applySnapshot(match: Match, snap: Snapshot, observer: number): void {
  const w = match.world;
  const statusTable = snap.statusTable;
  const buf = snap.units;
  const n = buf.length / STRIDE;
  const order = w.data.unitOrder;
  const multi = snap.tick - w.tick > 1 && snap.tick - w.tick <= 20;
  // Mark existing mirror units dead first; every surviving unit in `buf` restores its positive `hp` below.
  for (let i = 0; i < w.aliveUnits.length; i++) w.aliveUnits[i].hp = 0;
  for (let k = 0; k < n; k++) {
    const o = k * STRIDE;
    const id = buf[o + F.id];
    const fl = buf[o + F.flags];
    let u = w.units.get(id);
    const had = !!u;
    if (!u) {
      const def = w.data.units.get(order[buf[o + F.def]])!;
      const fixed = (fl & 16) !== 0;
      u = w.spawnUnit(buf[o + F.owner], def.id, { x: buf[o + F.x], z: buf[o + F.z] }, buf[o + F.front], { fixed, mirrorId: id });
    }
    // 3.0 upgrades: the mirror swaps in the same variant def (unit card, render) before the hp is copied.
    if (u.upg !== buf[o + F.upg]) refit(w, u, buf[o + F.upg]);
    const oldX = u.pos.x;
    const oldZ = u.pos.z;
    u.pos.x = buf[o + F.x]; u.pos.z = buf[o + F.z];
    if (multi && had && Math.abs(u.pos.x - oldX) < 35 && Math.abs(u.pos.z - oldZ) < 35) {
      u.prev.x = oldX; u.prev.z = oldZ;
    } else {
      u.prev.x = buf[o + F.px]; u.prev.z = buf[o + F.pz];
    }
    u.y = buf[o + F.y];
    u.heading = buf[o + F.heading]; u.turret = buf[o + F.turret]; u.hp = buf[o + F.hp]; u.morale = buf[o + F.morale];
    u.suppression = buf[o + F.supp]; u.ammo = buf[o + F.ammo]; u.supplyRatio = buf[o + F.supplyRatio];
    u.setup = SETUP[(fl >> 8) & 3] ?? 'packed';
    u.moving = (fl & 1) !== 0; u.routing = (fl & 2) !== 0; u.wavering = (fl & 4) !== 0; u.supplied = (fl & 8) !== 0; u.pathFailed = (fl & 32) !== 0; u.mounted = (fl & 64) !== 0;
    u.rail = (fl & 128) !== 0 ? (u.rail ?? mirrorRide(u)) : null;
    u.moraleState = MORALE[(fl >> 10) & 3] ?? 'normal'; u.behavior = BEHAVIOR[(fl >> 12) & 7] ?? 'advance';
    u.targetId = buf[o + F.target] < 0 ? null : buf[o + F.target]; u.frontId = buf[o + F.front]; u.cargo = buf[o + F.cargo];
    u.truckState = TRUCK[(fl >> 15) & 3] ?? 'load'; u.fortId = buf[o + F.fort] < 0 ? null : buf[o + F.fort];
    u.cover = buf[o + F.cover] as Unit['cover']; u.lastDamagedAt = buf[o + F.lastDamaged]; u.lastFiredAt = buf[o + F.lastFired];
    u.status = statusTable[buf[o + F.status]] ?? ''; u.speedNow = buf[o + F.speed]; u.lastSuppliedAt = buf[o + F.lastSupplied];
    u.setupTimer = buf[o + F.setupTimer];
    u.manual = null;
    if (u.queue.length > 0) u.queue.length = 0;
  }
  for (const [id, m, q] of snap.manual) {
    const u = w.units.get(id);
    if (u) {
      u.manual = m;
      u.queue = new Array(q).fill(m);
    }
  }
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
  if (snap.forts) replace(w.forts, snap.forts);
  for (let i = 0; i < w.places.length && i < snap.placeStock.length; i++) {
    w.places[i].stock = snap.placeStock[i];
    w.places[i].contestedSince = snap.placeContestedSince[i];
  }
  replace(w.econ, snap.econ);
  replace(w.econZones, snap.econZones ?? []);
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
  if (snap.supplyNodes) match.supplyNodes = snap.supplyNodes;
  w.result = snap.result;
  if (snap.stats) w.stats = snap.stats;
  if (snap.transport) applyTransport(w, snap.transport);
  w.spatial.markDirty(w.aliveUnits);
}

function replace<T>(target: T[], src: T[]): void {
  target.length = 0;
  for (const x of src) target.push(x);
}
