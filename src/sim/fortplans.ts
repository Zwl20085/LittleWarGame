import { refund, trySpend } from './economy';
import { HOME } from './homeguard';
import { assignJob, canAfford, enemyNear, isStructure, jobOf, startStructure, structureSiteOk, STRUCT, type StructureKind } from './structures';
import { Ground } from './terrain';
import { startLine, WORKS } from './works';
import type { Faction, Fort, Unit, Zone } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * AI construction plans (2.0, user rules 5/6/8): where the engineers build defensive works.
 *  - Capital line (rule 8, "首都区域必须有驻防、且必须有工兵建设一道防线"): from minute 1 every faction
 *    builds `rules.command.capital_line_works` (trenches + pillboxes) across the capital's exit
 *    approach (HOME.trenchR, the home-defence geometry), rebuilding what is destroyed.
 *  - Fortified zone (筑垒地域, 2.1): every non-cancelled `Faction.zones` entry (one per Fortify
 *    order, fronts.addZone) is a permanent project — trenches along its line, pillboxes at the ends
 *    and a bunker behind the centre, facing away from the capital — built whatever the front's
 *    current order (user: 筑垒地域是永备工事). A cancelled zone stops (escrow released, standing
 *    works kept). Builders: the zone's front's engineers first, then any free engineer in range.
 *  - Pressed towns (homeguard.fortifyPlace): a pillbox behind the approach trench when M allows.
 * Runs once per HQ think (5 s) from homeguard.fortifyHome; builders are assigned here (engineers;
 * riflemen help with trenches only) and do the work in behavior.thinkUnit → structures.structureDuty.
 */
export const PLANS = {
  capital: {
    /** First capital-line site this long after the start (2.1: the two starting engineers start at once). */
    startS: 20,
    /** Trenches at HOME.trenchR, this far apart (rad) around the exit bearing; pillboxes on the flanks. */
    trenchStepRad: 0.34,
    pillboxFlankRad: 0.36,
    pillboxBackM: 6,
    maxOpen: 2,
    /** Builders: engineers within this of the capital; riflemen (trenches) within `rifleR`. */
    poolR: 1500,
    rifleR: 700,
  },
  zone: {
    trenchSpacingM: 55,
    maxTrenches: 4,
    /** Pillboxes at these fractions of the line (lines ≥ `twoPillboxM`; else one at the centre). */
    pillboxT: [0.08, 0.92],
    twoPillboxM: 120,
    pillboxBackM: 6,
    bunkerBackM: 18,
    maxOpen: 2,
    poolR: 1200,
    /** The zone's own front's engineers are called from this far. */
    frontPoolR: 3000,
  },
  place: {
    /** A pressed town gets a pillbox only with this × its M cost to spare. */
    spareMul: 3,
    /** …this far inside the approach trench. */
    insetM: 18,
    poolR: 700,
  },
  /** Builders wanted per open site: engineers for buildings, engineers + riflemen for trenches. */
  buildersPerSite: 2,
  diggersPerTrench: 2,
  /**
   * AI factions with building work waiting and too few engineers queue one (manual-queue priority,
   * one per HQ think): engineers wanted = buildings waiting (planned or open), at most `maxEngineers`.
   * (Soak, first build: the AI's production mix fielded no engineer in the first 5 min, so no pillbox rose.)
   */
  maxEngineers: 0.4,
  /** …and no request while the faction already has this many engineers (alive + queued). */
  maxEngineersAll: 0.8,
  /** The request is announced (log.engineersRequested) at most this often per faction. */
  requestNoteS: 120,
  /** Engineers this close to their front's planned bridge are left to build it. */
  bridgeKeepM: 500,
  /**
   * Trenches are paid in instalments: each HQ think takes up to this share of the P in stock
   * until the cost is collected (production competes for every point of P; a 120 P lump sum with
   * a 50 % reserve was never available in the soak, so half the capitals had no trench at 6 min).
   */
  escrowShare: 0.5,
  /** A failed start (budget, pacing, enemy) is retried after this. */
  retryS: 15,
  /** Nudges tried around a planned point until the ground is good (m, radial then lateral). */
  nudges: [[0, 0], [-15, 0], [15, 0], [0, 12], [0, -12], [-28, 0], [-15, 14], [-15, -14]] as readonly (readonly [number, number])[],
} as const;

type ItemKind = 'trench' | StructureKind;

interface PlanItem {
  readonly kind: ItemKind;
  readonly pos: V2;
  readonly facing: number;
  fortId: number | null;
  failedAt: number;
  /** P already collected for a trench (escrow instalments). */
  paid: number;
}

interface Plan {
  readonly key: string;
  readonly items: PlanItem[];
}

const capitalPlans = new WeakMap<Faction, Plan>();
/** Fortified-zone plans per faction, by zone id (2.1: zones outlive the orders that created them). */
const zonePlans = new WeakMap<Faction, Map<number, Plan>>();
const capitalAnnounced = new WeakSet<Faction>();
/** The one plan item per faction collecting trench instalments (escrows do not stack across zones). */
const escrowHolder = new WeakMap<Faction, PlanItem>();
const requestNotedAt = new WeakMap<Faction, number>();

function zonePlansOf(f: Faction): Map<number, Plan> {
  let m = zonePlans.get(f);
  if (!m) zonePlans.set(f, (m = new Map()));
  return m;
}

/** Per-HQ-think entry point (homeguard.fortifyHome). */
export function planStructures(world: World, f: Faction): void {
  if (!f.alive) return;
  planCapitalLine(world, f);
  planZones(world, f);
  requestEngineers(world, f);
}

/** Plan items (buildings and trenches) not yet finished: the capital line and every live zone. */
function sitesWaiting(world: World, f: Faction): number {
  let n = 0;
  const plans = [capitalPlans.get(f), ...zonePlansOf(f).values()];
  for (const p of plans) {
    for (const it of p?.items ?? []) {
      const fort = it.fortId !== null ? world.fortById(it.fortId) : undefined;
      if (!fort || fort.hp <= 0 || fort.progress < 1) n++;
    }
  }
  return n;
}

/**
 * The supreme HQ's war-effort automation (2.1, every faction including the player's — user
 * finding "单位生产似乎不顾及需求"): when works wait and the free engineers are fewer than the
 * sites (at most `maxEngineers`), queue the missing engineers at manual-queue priority, up to
 * `maxEngineersAll` engineers in all, and say so in the log. A paused engineer line is respected.
 */
function requestEngineers(world: World, f: Faction): void {
  if (f.paused.engineer) return;
  // Caps scale with the army (army_scale 10 fields ~20 engineers; the seed values are per scale 1).
  const k = world.data.rules.proposed_defaults.army_scale ?? 1;
  const want = Math.min(Math.round(PLANS.maxEngineers * k), sitesWaiting(world, f));
  if (want <= 0) return;
  // Engineers on other errands (sieges, occupations, bridges) do not count, up to a hard cap on all engineers.
  const queued = f.orders.filter((o) => o.unitId === 'engineer').length + f.manualQueue.filter((q) => q.unitId === 'engineer').length;
  let free = queued;
  let all = queued;
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || u.def.id !== 'engineer') continue;
    all++;
    if (freeHand(f, u)) free++;
  }
  const n = Math.min(want - free, Math.round(PLANS.maxEngineersAll * k) - all);
  if (n <= 0) return;
  f.manualQueue = [...f.manualQueue, ...Array.from({ length: n }, () => ({ unitId: 'engineer', frontId: -1 }))];
  if (world.time - (requestNotedAt.get(f) ?? -1e9) >= PLANS.requestNoteS) {
    requestNotedAt.set(f, world.time);
    world.note(f.id, 'log.engineersRequested', { n }, 'info');
  }
}

// ---------------------------------------------------------------- capital line

function planCapitalLine(world: World, f: Faction): void {
  if (world.time < PLANS.capital.startS) return;
  let plan = capitalPlans.get(f);
  if (!plan) {
    plan = layoutCapital(world, f);
    capitalPlans.set(f, plan);
  }
  const hq = world.hqPos(f.id);
  const started = advancePlan(world, f, plan, PLANS.capital.maxOpen, (site) => capitalPool(world, f, hq, site));
  if (started && !capitalAnnounced.has(f)) {
    capitalAnnounced.add(f);
    world.note(f.id, 'log.capitalLine', {}, 'info');
  }
}

/** Trenches across the exit approach at HOME.trenchR, pillboxes on their flanks (fixed for the match). */
function layoutCapital(world: World, f: Faction): Plan {
  const hq = world.hqPos(f.id);
  const ht = f.command.homeThreat;
  const bearing = ht.active ? ht.bearing : headingTo(hq, world.cityOf(f.id).exit);
  const want = world.data.rules.command.capital_line_works;
  const nT = Math.max(0, Math.round(want.trench ?? 0));
  const nP = Math.max(0, Math.round(want.pillbox ?? 0));
  const trenches: PlanItem[] = [];
  for (let i = 0; i < nT; i++) {
    const a = bearing + (i - (nT - 1) / 2) * PLANS.capital.trenchStepRad;
    const p = resolve(world, 'trench', polar(hq, a, HOME.trenchR), a);
    if (p) trenches.push(item('trench', p, a));
  }
  const pills: PlanItem[] = [];
  const half = (nT * PLANS.capital.trenchStepRad) / 2 + PLANS.capital.pillboxFlankRad - PLANS.capital.trenchStepRad / 2;
  for (let i = 0; i < nP; i++) {
    const a = nP === 1 ? bearing : bearing - half + (2 * half * i) / (nP - 1);
    const p = resolve(world, 'pillbox', polar(hq, a, HOME.trenchR - PLANS.capital.pillboxBackM), a);
    if (p) pills.push(item('pillbox', p, a));
  }
  return { key: 'capital', items: interleave(trenches, pills) };
}

/** Engineers near the capital; riflemen (trenches only) a little closer in. */
function capitalPool(world: World, f: Faction, hq: V2, site: Fort): Unit[] {
  const out: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.owner !== f.id || !freeHand(f, u)) continue;
    const d = dist(u.pos, hq);
    // Home guards man the buildings (structures.seekGarrison); riflemen of quiet fronts dig.
    if (u.def.id === 'engineer' ? d < PLANS.capital.poolR : canDig(u, site) && d < PLANS.capital.rifleR && u.opRole === 'line' && quietFront(f, u)) out.push(u);
  }
  return byDistance(out, site.pos);
}

const byDistance = (us: Unit[], p: V2): Unit[] => us.sort((x, y) => dist(x.pos, p) - dist(y.pos, p) || x.id - y.id);

// ---------------------------------------------------------------- fortified zones (2.1, Faction.zones)

/** Build every live zone; a cancelled (or vanished) zone's plan is dropped, its standing works stay. */
function planZones(world: World, f: Faction): void {
  const plans = zonePlansOf(f);
  const live = new Set<number>();
  for (const z of f.zones) {
    if (z.cancelled) continue;
    live.add(z.id);
    let plan = plans.get(z.id);
    if (!plan) {
      plan = layoutZone(world, f, `zone:${z.id}`, z.a, z.b);
      plans.set(z.id, plan);
    }
    advancePlan(world, f, plan, PLANS.zone.maxOpen, (site) => zonePool(world, f, z, site));
  }
  for (const [id, plan] of [...plans]) {
    if (live.has(id)) continue;
    for (const it of plan.items) releaseEscrow(world, f, it);
    plans.delete(id);
  }
}

/** Trenches along a–b, pillboxes at the ends (one at the centre on short lines), a bunker behind the centre. */
function layoutZone(world: World, f: Faction, key: string, a: V2, b: V2): Plan {
  const hq = world.hqPos(f.id);
  const len = Math.max(1, dist(a, b));
  const c = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  let nx = -(b.z - a.z) / len;
  let nz = (b.x - a.x) / len;
  if (nx * (c.x - hq.x) + nz * (c.z - hq.z) < 0) {
    nx = -nx;
    nz = -nz;
  }
  const facing = Math.atan2(nz, nx);
  const at = (t: number, back: number): V2 => ({ x: a.x + (b.x - a.x) * t - nx * back, z: a.z + (b.z - a.z) * t - nz * back });
  const nT = Math.max(1, Math.min(PLANS.zone.maxTrenches, Math.round(len / PLANS.zone.trenchSpacingM)));
  const ts = Array.from({ length: nT }, (_, i) => (i + 0.5) / nT).sort((x, y) => Math.abs(x - 0.5) - Math.abs(y - 0.5));
  const trenches = ts.map((t) => resolve(world, 'trench', at(t, 0), facing)).filter((p): p is V2 => !!p).map((p) => item('trench', p, facing));
  const pts = len >= PLANS.zone.twoPillboxM ? PLANS.zone.pillboxT : [0.5];
  const pills = pts.map((t) => resolve(world, 'pillbox', at(t, PLANS.zone.pillboxBackM), facing)).filter((p): p is V2 => !!p).map((p) => item('pillbox', p, facing));
  const bp = resolve(world, 'bunker', at(0.5, PLANS.zone.bunkerBackM), facing);
  const items = [...trenches.slice(0, 1), ...pills, ...(bp ? [item('bunker', bp, facing)] : []), ...trenches.slice(1)];
  return { key, items };
}

/**
 * Builders of a zone site: the zone's front's engineers (from `frontPoolR`) first, then any free
 * engineer within `poolR`; riflemen of the zone's front near the site dig its trenches. A zone whose
 * front dissolved (frontId null or gone) is built by whoever is in range.
 */
function zonePool(world: World, f: Faction, z: Zone, site: Fort): Unit[] {
  const out: { u: Unit; rank: number; d: number }[] = [];
  const fid = z.frontId !== null && f.fronts.some((x) => x.id === z.frontId) ? z.frontId : null;
  for (const u of world.units.values()) {
    if (u.owner !== f.id || !freeHand(f, u)) continue;
    const d = dist(u.pos, site.pos);
    const own = fid !== null && u.frontId === fid;
    if (u.def.id === 'engineer') {
      if (own ? d <= PLANS.zone.frontPoolR : d <= PLANS.zone.poolR) out.push({ u, rank: own ? 0 : 1, d });
    } else if (own && u.opRole === 'line' && d <= PLANS.zone.poolR && canDig(u, site)) out.push({ u, rank: 2, d });
  }
  return out.sort((x, y) => x.rank - y.rank || x.d - y.d || x.u.id - y.u.id).map((x) => x.u);
}

// ---------------------------------------------------------------- pressed towns (homeguard.fortifyPlace)

/**
 * A pressed town / city whose approach trench stands: add a pillbox just inside it when M allows,
 * and keep engineers on an unfinished one.
 */
export function planPlaceStructure(world: World, f: Faction, centre: V2, radius: number, bearing: number): void {
  let site: Fort | null = null;
  for (const w of world.forts) {
    if (w.owner === f.id && w.hp > 0 && isStructure(w.kind) && dist(w.pos, centre) < radius + 60) {
      if (w.progress >= 1) return;
      site = w;
    }
  }
  if (!site) {
    if (!canAfford(world, f, 'pillbox', PLANS.place.spareMul - 1)) return;
    const p = resolve(world, 'pillbox', polar(centre, bearing, radius - PLANS.place.insetM), bearing);
    if (!p || enemyNear(world, f.id, p, STRUCT.noBuildEnemyM)) return;
    site = startStructure(world, f, 'pillbox', p, bearing, PLANS.place.spareMul - 1);
    if (!site) return;
  }
  const s = site;
  assignBuilders(world, [s], () => byDistance([...world.units.values()].filter((u) => u.owner === f.id && u.def.id === 'engineer' && freeHand(f, u) && dist(u.pos, s.pos) < PLANS.place.poolR), s.pos));
}

// ---------------------------------------------------------------- shared

const item = (kind: ItemKind, pos: V2, facing: number): PlanItem => ({ kind, pos, facing, fortId: null, failedAt: -1e9, paid: 0 });
const polar = (o: V2, a: number, r: number): V2 => ({ x: o.x + Math.cos(a) * r, z: o.z + Math.sin(a) * r });

function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/** First nudge of `p` (radial along `facing`, then lateral) where the work can stand. */
function resolve(world: World, kind: ItemKind, p: V2, facing: number): V2 | null {
  const cx = Math.cos(facing);
  const cz = Math.sin(facing);
  for (const [r, l] of PLANS.nudges) {
    const q = { x: p.x + cx * r - cz * l, z: p.z + cz * r + cx * l };
    if (kind === 'trench' ? lineSiteOk(world, q) : structureSiteOk(world, q)) return q;
  }
  return null;
}

function lineSiteOk(world: World, p: V2): boolean {
  const t = world.terrain;
  if (!t.inBounds(p.x, p.z) || t.buildingH(p.x, p.z) > 0 || t.slopeAt(p.x, p.z) > STRUCT.maxSiteSlopeDeg) return false;
  return world.nav(false, 35).nearestPassable(p, 6) !== null && t.groundAt(p.x, p.z) !== Ground.Water;
}

/**
 * Track the plan's sites, start at most one missing item per think (budget, pacing, no enemy
 * near; destroyed works are rebuilt) and give every open site its builders. Returns whether a
 * site was started.
 */
function advancePlan(world: World, f: Faction, plan: Plan, maxOpen: number, pool: (site: Fort) => Unit[]): boolean {
  const open: Fort[] = [];
  for (const it of plan.items) {
    const fort = it.fortId !== null ? world.forts.find((x) => x.id === it.fortId) : undefined;
    if (fort && fort.hp > 0) {
      if (fort.progress < 1) open.push(fort);
      continue;
    }
    it.fortId = null;
  }
  let started = false;
  for (const it of plan.items) {
    if (started || open.length >= maxOpen) break;
    if (it.fortId !== null || world.time - it.failedAt < PLANS.retryS) continue;
    const fort = startItem(world, f, it);
    if (!fort) {
      // A trench still collecting its instalments retries next think (one item at a time).
      if (it.paid > 0) break;
      it.failedAt = world.time;
      continue;
    }
    it.fortId = fort.id;
    if (fort.progress < 1) {
      open.push(fort);
      started = true;
    }
  }
  for (const site of open) assignBuilders(world, [site], () => pool(site));
  return started;
}

/** Start (or adopt an existing own trench at) one plan item. */
function startItem(world: World, f: Faction, it: PlanItem): Fort | null {
  if (enemyNear(world, f.id, it.pos, STRUCT.noBuildEnemyM)) {
    // The enemy is on the site: give the instalments back (another site may collect meanwhile).
    releaseEscrow(world, f, it);
    return null;
  }
  if (it.kind !== 'trench') return startStructure(world, f, it.kind, it.pos, it.facing, HOME.reserveCostMul);
  for (const w of world.forts) {
    if (w.hp > 0 && (w.kind === 'trench' || w.kind === 'sandbag') && dist(w.pos, it.pos) < WORKS.trench.length * 0.7) {
      if (w.owner !== f.id) return null;
      releaseEscrow(world, f, it);
      return w;
    }
  }
  const cost = WORKS.trench.costP * (world.data.rules.proposed_defaults.army_scale ?? 1);
  if (it.paid < cost) {
    // One trench collects at a time per faction (several zones must not each take half the stock).
    const holder = escrowHolder.get(f);
    if (holder && holder !== it && holder.paid > 0) return null;
    escrowHolder.set(f, it);
    const take = Math.min(cost - it.paid, Math.max(0, f.p) * PLANS.escrowShare);
    if (take > 0 && trySpend(f, take, 0).ok) it.paid += take;
    if (it.paid < cost - 1e-6) return null;
  }
  const fort = startLine(world, f, 'trench', it.pos, it.facing, true);
  if (fort) {
    it.paid = 0;
    if (escrowHolder.get(f) === it) escrowHolder.delete(f);
  }
  return fort;
}

/** Give back what an item collected (plan dropped, or an existing trench adopted). */
function releaseEscrow(world: World, f: Faction, it: PlanItem): void {
  if (it.paid > 0) refund(f, it.paid, 0, world.data.rules);
  it.paid = 0;
  if (escrowHolder.get(f) === it) escrowHolder.delete(f);
}

/** Keep `buildersPerSite` (trenches: `diggersPerTrench`) assigned to each site, nearest first. */
function assignBuilders(world: World, sites: Fort[], pool: () => Unit[]): void {
  for (const site of sites) {
    const want = isStructure(site.kind) ? PLANS.buildersPerSite : PLANS.diggersPerTrench;
    // The pool's order is the preference (nearest first, or ranked by the pool).
    const cands = pool().filter((u) => isStructure(site.kind) ? u.def.id === 'engineer' : canDig(u, site));
    let have = 0;
    for (const u of cands) {
      if (jobOf(world, u) === site.id) {
        assignJob(world, u, site);
        have++;
      }
    }
    for (const u of cands) {
      if (have >= want) break;
      if (jobOf(world, u) !== null) continue;
      assignJob(world, u, site);
      have++;
    }
  }
}

/** Engineers dig twice as fast; riflemen and engineers may dig trenches, only engineers build. */
function canDig(u: Unit, site: Fort): boolean {
  return (site.kind === 'trench' || site.kind === 'sandbag') && (u.def.id === 'engineer' || u.def.id === 'infantry');
}

/** Not on another errand: alive, not manual / routing / spearhead / op role, not bridging, not in a building. */
function freeHand(f: Faction, u: Unit): boolean {
  if (u.hp <= 0 || u.fixed || u.manual || u.routing || u.spearhead || u.fortId !== null || u.mounted) return false;
  if (u.behavior !== 'advance' && u.behavior !== 'rally') return false;
  if (u.opRole !== 'line' && !(u.opRole === 'garrison' && u.opObjective === `hq:${f.id}`)) return false;
  // Engineers at (or near) their front's river crossing stay on the bridge.
  const s = f.fronts.find((x) => x.id === u.frontId);
  return !(u.def.id === 'engineer' && s?.bridgeSite && dist(u.pos, s.bridgeSite.mid) < PLANS.bridgeKeepM);
}

/** A rifleman's front is not attacking or in an operation (it can spare a digger). */
function quietFront(f: Faction, u: Unit): boolean {
  const s = f.fronts.find((x) => x.id === u.frontId);
  return !!s && s.posture !== 'assault' && s.opPhase === '';
}
