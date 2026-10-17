import type { InfiltrationRules } from '../data/infiltrationRules';
import { selectTarget } from './combat';
import { isCommander } from './formulas';
import { enemyDistance } from './frontai';
import { NEUTRAL, type FrontlineField } from './frontline';
import { onBoundFront, frontById } from './frontref';
import { moveTo, stop } from './movement';
import { reactionGroup } from './pickets';
import type { Faction, Unit } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';
import { holdsLine, infilOn, infilRules, INFILTRATION_AB, updateZoc, type ZocContact } from './zoc';

/**
 * 3.0 infiltration response (docs/V30_SPEC.md §11, WP-E): what a faction does about enemies that got
 * through or around its line.
 *
 * - **Contact** (zoc.ts, every 0.5 s): an intruder in a line unit's zone of control is chased by up to
 *   `engage_per_intruder` line units (leashed); one that *crossed* the line is reported at once and
 *   the front's reaction group (pickets.ts) intercepts it.
 * - **Rear reports** (every 1 s): a known enemy on the faction's own ground, `report_depth_m` from
 *   hostile-held ground and away from its own line units, is an infiltrator; nearby ones form a report.
 *   A report worth `report_min_value` is announced (log `log.infiltrator` + minimap blip).
 * - **Rear screen**: the own towns / cities / economic towns / capital nearest the report get 1–2
 *   squads posted toward it. **Hunt**: the nearest free units (not fighting, not on a binding order)
 *   hunt it until they outweigh it `hunt_ratio`:1. Hunters and screens together stay under
 *   `response_max_share` of the faction's combat units.
 *
 * State lives in WeakMaps keyed by faction / unit (sim-only, not in snapshots); everything is
 * deterministic (unit order, no RNG). Units on a task carry opRole 'hunt' / 'screen'.
 */

interface Report {
  readonly id: number;
  pos: V2;
  value: number;
  /** Members last seen (unit ids), for the hunters' aim. */
  ids: number[];
  readonly firstAt: number;
  lastAt: number;
  noted: boolean;
  crossed: boolean;
  hunters: number[];
  readonly screens: Map<string, number[]>;
}

interface Task {
  readonly kind: 'hunt' | 'screen';
  readonly reportId: number;
  readonly post: V2 | null;
  readonly until: number;
  /** Reaction-group hunters stay within reaction_leash_m of here. */
  readonly leashFrom: V2 | null;
  releaseAt: number;
}

interface Engage { readonly targetId: number; readonly until: number; readonly ax: number; readonly az: number }

interface Book { list: Report[]; seq: number }

const books = new WeakMap<Faction, Book>();
const tasks = new WeakMap<Unit, Task>();
const engaged = new WeakMap<Unit, Engage>();

function bookOf(f: Faction): Book {
  let b = books.get(f);
  if (!b) {
    b = { list: [], seq: 0 };
    books.set(f, b);
  }
  return b;
}

/** Current infiltration reports of faction `f` (read-only view for labs, tests and the UI layer). */
export const infiltrationReports = (f: Faction): readonly { id: number; pos: V2; value: number; ids: readonly number[]; crossed: boolean; noted: boolean; firstAt: number }[] => bookOf(f).list;

const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);

/** Enemy kinds that count as infiltrators: fighting units (no trucks, commanders, fixed works). */
const infiltratorKind = (u: Unit): boolean =>
  u.hp > 0 && !u.fixed && !u.routing && u.behavior !== 'evacuate' && u.def.id !== 'supply_truck' && !isCommander(u.def) && u.primary !== null;

// ---------------------------------------------------------------- per-tick entry

const CONTACTS: ZocContact[] = [];

/** Every 0.5 s right after the visibility pass (sim.ts): zone of control and contacts; rear reports every 1 s. */
export function updateInfiltration(world: World, field: FrontlineField): void {
  if (!infilOn(world)) return;
  if (INFILTRATION_AB.zoc) updateZoc(world, CONTACTS);
  const perIntruder = new Map<number, number>();
  if (INFILTRATION_AB.engage) for (const c of CONTACTS) onContact(world, c, perIntruder);
  if (INFILTRATION_AB.rear && world.tick % world.tickHz === 0) reportInfiltrators(world, field);
}

function onContact(world: World, c: ZocContact, perIntruder: Map<number, number>): void {
  const r = infilRules(world);
  const { holder: h, intruder: m } = c;
  // Two lines facing each other slow each other down; only a real intruder (a detachment, a raid, a
  // column on the move) is chased and reported.
  if (holdsLine(m)) return;
  const n = perIntruder.get(m.id) ?? 0;
  if (n < r.engage_per_intruder && !engaged.has(h)) {
    engaged.set(h, { targetId: m.id, until: world.time + r.engage_s, ax: h.pos.x, az: h.pos.z });
    perIntruder.set(m.id, n + 1);
  }
  if (!c.crossed) return;
  const f = world.factions[h.owner];
  const rep = reportAt(world, f, m.pos, valueOf(m), [m.id]);
  rep.crossed = true;
  const s = frontById(f, h.frontId);
  if (!s) return;
  for (const id of reactionGroup(s)) {
    const u = world.unitAlive(id);
    if (!u || u.opRole !== 'line' || u.manual || u.routing) continue;
    assign(u, rep, { kind: 'hunt', reportId: rep.id, post: null, until: world.time + r.hunt_max_s, leashFrom: { ...u.pos }, releaseAt: -1 });
    rep.hunters.push(u.id);
  }
}

/** The faction's report near `p` (updated), or a new one. */
function reportAt(world: World, f: Faction, p: V2, value: number, ids: number[]): Report {
  const r = infilRules(world);
  const b = bookOf(f);
  let best: Report | null = null;
  let bd = r.report_match_m;
  for (const rep of b.list) {
    const d = dist(rep.pos, p);
    if (d < bd) { bd = d; best = rep; }
  }
  if (best) {
    best.lastAt = world.time;
    for (const id of ids) if (!best.ids.includes(id)) best.ids = [...best.ids, id];
    return best;
  }
  const rep: Report = { id: b.seq++, pos: { ...p }, value, ids, firstAt: world.time, lastAt: world.time, noted: false, crossed: false, hunters: [], screens: new Map() };
  b.list = [...b.list, rep];
  return rep;
}

// ---------------------------------------------------------------- rear reports

/**
 * Is `p` behind faction `f`'s line: own ground (`field`; unclaimed ground nearer its capital than any
 * other) at least report_depth_m from hostile-held ground, or where a report already tracks infiltrators?
 */
export function inRear(world: World, field: FrontlineField, f: Faction, p: V2): boolean {
  const r = infilRules(world);
  const owner = field.ownerAt(p);
  const ours = owner === f.id || (owner === NEUTRAL && nearestCapital(world, p) === f.id);
  if (ours && enemyDistance(world, f.id, p) >= r.report_depth_m) return true;
  // A detachment deep in our ground turns the cells around it contested: keep tracking it once reported.
  return bookOf(f).list.some((rep) => dist(rep.pos, p) < r.report_match_m);
}

function nearestCapital(world: World, p: V2): number {
  let best = -1;
  let bd = Infinity;
  for (const f of world.factions) {
    if (!f.alive) continue;
    const d = dist(world.hqPos(f.id), p);
    if (d < bd) { bd = d; best = f.id; }
  }
  return best;
}

interface Cluster { seed: V2; sx: number; sz: number; v: number; ids: number[] }

/** Rear reports (every 1 s): known enemies in each faction's rear, away from their own line units. */
export function reportInfiltrators(world: World, field: FrontlineField): void {
  const r = infilRules(world);
  const seen: Unit[][] = world.factions.map(() => []);
  for (const m of world.aliveUnits) {
    if (!infiltratorKind(m)) continue;
    let isolated: boolean | null = null;
    for (const f of world.factions) {
      if (!f.alive || f.id === m.owner || !world.isHostile(f.id, m.owner) || !world.knows(f.id, m) || !inRear(world, field, f, m.pos)) continue;
      isolated ??= !world.spatial.findOwner(m.pos.x, m.pos.z, r.report_isolated_m, 1 << m.owner, holdsLine);
      if (isolated) seen[f.id].push(m);
    }
  }
  for (const f of world.factions) if (f.alive) updateReports(world, f, r, seen[f.id]);
}

function clusters(r: InfiltrationRules, units: readonly Unit[]): Cluster[] {
  const out: Cluster[] = [];
  for (const u of units) {
    const c = out.find((k) => dist(k.seed, u.pos) < r.report_cluster_m);
    const v = valueOf(u);
    if (c) {
      c.sx += u.pos.x * v;
      c.sz += u.pos.z * v;
      c.v += v;
      c.ids.push(u.id);
    } else out.push({ seed: u.pos, sx: u.pos.x * v, sz: u.pos.z * v, v, ids: [u.id] });
  }
  return out;
}

function updateReports(world: World, f: Faction, r: InfiltrationRules, units: readonly Unit[]): void {
  const now = world.time;
  for (const c of clusters(r, units)) {
    const pos = { x: c.sx / Math.max(1e-6, c.v), z: c.sz / Math.max(1e-6, c.v) };
    const rep = reportAt(world, f, pos, c.v, c.ids);
    rep.pos = pos;
    rep.value = c.v;
    rep.ids = c.ids;
    if (!rep.noted && c.v >= r.report_min_value) {
      rep.noted = true;
      world.note(f.id, 'log.infiltrator', { n: c.ids.length, point: nearestOwnPlace(world, f.id, pos), x: Math.round(pos.x), z: Math.round(pos.z) }, 'alert');
    }
  }
  const b = bookOf(f);
  b.list = b.list.filter((rep) => now - rep.lastAt <= r.report_forget_s);
  if (!b.list.some((rep) => rep.noted || rep.crossed)) return;
  const budget = { left: responseBudget(world, f, r) };
  for (const rep of b.list) {
    if (!rep.noted && !rep.crossed) continue;
    rep.hunters = rep.hunters.filter((id) => onTask(world, id, rep.id, 'hunt'));
    // Hunters first (they end the raid), but at most 60 % of what is left, so the screens get squads too.
    const huntBudget = { left: Math.ceil(budget.left * 0.6) };
    ensureHunters(world, f, r, rep, huntBudget);
    budget.left -= Math.ceil(budget.left * 0.6) - huntBudget.left;
    if (rep.noted) ensureScreens(world, f, r, rep, budget);
  }
}

/** Units the faction may still put on hunts / screens: response_max_share of its combat units minus those already on one. */
function responseBudget(world: World, f: Faction, r: InfiltrationRules): number {
  let combat = 0;
  let busy = 0;
  for (const u of world.aliveUnits) {
    if (u.owner !== f.id || u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
    combat++;
    if (u.opRole === 'hunt' || u.opRole === 'screen') busy++;
  }
  return Math.floor(combat * r.response_max_share) - busy;
}

function nearestOwnPlace(world: World, f: number, p: V2): string {
  let best = '';
  let bd = Infinity;
  for (const o of world.objectives) {
    if (o.owner !== f) continue;
    const d = dist(o.pos, p);
    if (d < bd) { bd = d; best = o.id; }
  }
  return best;
}

// ---------------------------------------------------------------- screen and hunt tasks

const onTask = (world: World, id: number, reportId: number, kind: Task['kind']): boolean => {
  const u = world.unitAlive(id);
  const t = u ? tasks.get(u) : undefined;
  return !!u && !!t && t.reportId === reportId && t.kind === kind && u.opRole === kind;
};

/** A unit the HQ may take for a screen or a hunt: a line unit not fighting, not on a binding order. */
function canDetach(world: World, f: Faction, u: Unit): boolean {
  return u.opRole === 'line' && !u.manual && !u.spearhead && !u.routing && (u.behavior === 'advance' || u.behavior === 'rally') && !u.fixed && u.primary !== null
    && (u.def.kind === 'infantry' || u.def.kind === 'vehicle') && u.def.id !== 'engineer' && u.def.id !== 'supply_truck' && !isCommander(u.def)
    && u.hp > u.def.maxHp * 0.5 && world.time - u.lastFiredAt > 10 && !onBoundFront(f, u.frontId) && !engaged.has(u);
}

function assign(u: Unit, rep: Report, t: Task): void {
  u.opRole = t.kind;
  u.behavior = 'advance';
  u.opTarget = t.post ? { ...t.post } : { ...rep.pos };
  u.opObjective = null;
  tasks.set(u, t);
}

function release(u: Unit): void {
  tasks.delete(u);
  if (u.opRole === 'hunt' || u.opRole === 'screen') {
    u.opRole = 'line';
    u.opTarget = null;
    u.opObjective = null;
  }
}

function ensureHunters(world: World, f: Faction, r: InfiltrationRules, rep: Report, budget: { left: number }): void {
  let have = rep.hunters.reduce((a, id) => a + valueOf(world.unitAlive(id)!), 0);
  const need = rep.value * r.hunt_ratio;
  if (have >= need || rep.hunters.length >= r.hunt_max_units || budget.left <= 0) return;
  const cands = world.spatial.queryOwners(rep.pos.x, rep.pos.z, r.hunt_radius_m, 1 << f.id)
    .filter((u) => canDetach(world, f, u))
    .map((u) => ({ u, eta: dist(u.pos, rep.pos) / Math.max(0.5, u.def.speed) }))
    .sort((a, b) => a.eta - b.eta || a.u.id - b.u.id);
  for (const { u } of cands) {
    if (have >= need || rep.hunters.length >= r.hunt_max_units || budget.left <= 0) break;
    assign(u, rep, { kind: 'hunt', reportId: rep.id, post: null, until: world.time + r.hunt_max_s, leashFrom: null, releaseAt: -1 });
    rep.hunters.push(u.id);
    have += valueOf(u);
    budget.left--;
  }
}

interface ScreenPlace { readonly id: string; readonly pos: V2; readonly radius: number; readonly squads: number }

/** Own places that a report threatens, nearest first: the capital, cities / towns, and places with own economic buildings. */
function threatenedPlaces(world: World, f: Faction, r: InfiltrationRules, p: V2): ScreenPlace[] {
  const out: (ScreenPlace & { d: number })[] = [];
  const hq = world.hqPos(f.id);
  if (dist(hq, p) < r.screen_radius_m) out.push({ id: `hq:${f.id}`, pos: hq, radius: world.data.rules.victory.command_radius_m, squads: r.screen_squads_city, d: dist(hq, p) });
  const econ = new Set<string>();
  for (const b of world.econ) if (b.owner === f.id && !b.ruined) econ.add(b.placeId);
  for (const o of world.objectives) {
    if (o.owner !== f.id || o.kind === 'point') continue;
    const d = dist(o.pos, p);
    if (d >= r.screen_radius_m) continue;
    const rich = o.kind === 'city' || econ.has(o.id);
    if (!rich && o.kind !== 'town') continue;
    out.push({ id: o.id, pos: o.pos, radius: o.radius, squads: rich ? r.screen_squads_city : r.screen_squads_town, d });
  }
  return out.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1)).slice(0, r.screen_max_places);
}

function ensureScreens(world: World, f: Faction, r: InfiltrationRules, rep: Report, budget: { left: number }): void {
  for (const pl of threatenedPlaces(world, f, r, rep.pos)) {
    const cur = (rep.screens.get(pl.id) ?? []).filter((id) => onTask(world, id, rep.id, 'screen'));
    if (cur.length < pl.squads && budget.left > 0) {
      const hd = headingTo(pl.pos, rep.pos);
      const post = { x: pl.pos.x + Math.cos(hd) * (pl.radius + r.screen_post_m), z: pl.pos.z + Math.sin(hd) * (pl.radius + r.screen_post_m) };
      const cands = world.spatial.queryOwners(pl.pos.x, pl.pos.z, r.screen_pick_m, 1 << f.id)
        .filter((u) => u.def.kind === 'infantry' && canDetach(world, f, u))
        .sort((a, b) => dist(a.pos, pl.pos) - dist(b.pos, pl.pos) || a.id - b.id);
      for (const u of cands.slice(0, Math.min(budget.left, pl.squads - cur.length))) {
        const at = world.navFor(u).nearestPassable(post, 40) ?? post;
        assign(u, rep, { kind: 'screen', reportId: rep.id, post: at, until: Infinity, leashFrom: null, releaseAt: -1 });
        cur.push(u.id);
        budget.left--;
      }
    }
    rep.screens.set(pl.id, cur);
  }
}

// ---------------------------------------------------------------- unit duty (behavior.ts)

const findReport = (world: World, f: number, id: number): Report | undefined => bookOf(world.factions[f]).list.find((rep) => rep.id === id);

/** Nearest known member of the report (the hunters' aim), else null. */
function nearestMember(world: World, u: Unit, rep: Report): Unit | null {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const id of rep.ids) {
    const m = world.unitAlive(id);
    if (!m || !world.knows(u.owner, m)) continue;
    const d = dist(u.pos, m.pos);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

/** A far chase aims at a 50 m lattice point (a moving target does not re-plan a long route every think). */
const CHASE_SNAP_M = 50;
const CHASE_NEAR_M = 150;

/** Fight what is in range, else close on `at`. */
function closeOn(world: World, u: Unit, at: V2): void {
  selectTarget(world, u, at);
  const t = world.unitAlive(u.targetId);
  const range = u.primary?.range ?? 0;
  if (t && dist(u.pos, t.pos) < range * 0.85) {
    stop(u);
    return;
  }
  const far = dist(u.pos, at) > CHASE_NEAR_M;
  moveTo(world, u, far ? { x: Math.round(at.x / CHASE_SNAP_M) * CHASE_SNAP_M, z: Math.round(at.z / CHASE_SNAP_M) * CHASE_SNAP_M } : at);
}

/**
 * 3.0 infiltration duties (behavior.thinkUnit): hunters, rear screens and line units chasing an
 * intruder in their zone of control. Returns true when it handled the unit this think.
 */
export function infiltrationDuty(world: World, u: Unit): boolean {
  if (u.opRole === 'hunt' || u.opRole === 'screen') return taskDuty(world, u);
  const e = engaged.get(u);
  if (!e) return false;
  const t = world.unitAlive(e.targetId);
  const r = infilRules(world);
  if (!t || world.time > e.until || u.opRole !== 'line' || u.manual || !world.knows(u.owner, t) || Math.hypot(u.pos.x - e.ax, u.pos.z - e.az) > r.engage_leash_m) {
    engaged.delete(u);
    return false;
  }
  closeOn(world, u, t.pos);
  u.status = 'status.intercept';
  return true;
}

function taskDuty(world: World, u: Unit): boolean {
  const t = tasks.get(u);
  if (!t || t.kind !== u.opRole) {
    release(u);
    return false;
  }
  const r = infilRules(world);
  const rep = findReport(world, u.owner, t.reportId);
  if (t.kind === 'hunt') {
    if (!rep || world.time > t.until || (t.leashFrom && dist(u.pos, t.leashFrom) > r.reaction_leash_m)) {
      release(u);
      return false;
    }
    const m = nearestMember(world, u, rep);
    closeOn(world, u, m ? m.pos : rep.pos);
    u.status = 'status.hunting';
    return true;
  }
  // Screen: hold the post toward the threat while the report lasts, then screen_hold_s more.
  if (!rep) {
    if (t.releaseAt < 0) t.releaseAt = world.time + r.screen_hold_s;
    if (world.time >= t.releaseAt) {
      release(u);
      return false;
    }
  }
  const post = t.post ?? u.pos;
  const m = rep ? nearestMember(world, u, rep) : null;
  if (m && dist(m.pos, post) < r.zoc_m) closeOn(world, u, m.pos);
  else {
    selectTarget(world, u, post);
    if (dist(u.pos, post) > 12) moveTo(world, u, post);
    else stop(u);
  }
  u.status = 'status.screening';
  return true;
}
