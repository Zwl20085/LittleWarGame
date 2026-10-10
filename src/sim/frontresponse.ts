import { deadCapital, maneuvering } from './doctrine';
import { frontDistance } from './frontops';
import { finishNow, issueFrontOrder, nextTarget } from './fronts';
import { centroid, enemyNear, segDist, sumValue } from './theatreq';
import { econWorth } from './econwar';
import type { Directive, Faction, Front, FrontOrder, Objective, OrderKind, Unit, Zone } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 front commanders' response to the supreme HQ's universal directive (docs/V22_SPEC.md §1).
 * The supreme HQ (player or AI) gives ONE directive; every HQ think each front commander turns it
 * into its own front order from the local situation (strength ratio, distance to the axis, threats)
 * and states the response + reason on its card (`Front.response`). `advance` is the 2.1 behaviour
 * and is answered by theatre.orderFront; this module answers the four other directives.
 *
 * Orders given under a player directive are binding (`manual: true`, the 2.1 rules in frontref.ts:
 * no detachments, attack goes regardless, every unit holds the ordered line); the AI's own directive
 * gives non-binding orders (its supreme HQ re-decides every think, as in 2.1).
 */
export const RESPONSE = {
  /** offensive: a front whose troops are within supportM of the axis objective joins the main effort. */
  supportM: 1400,
  /** offensive: a front (not the main effort) facing ≥ pinRatio × its own value at its objective pins instead … */
  pinRatio: 1.8,
  /** … attacking the nearest place within pinSearchM held by ≤ pinPickRatio × its value; none: it holds. */
  pinPickRatio: 0.8,
  pinSearchM: 1200,
  /** offensive: an objective within axisObjM of the axis point is the axis objective; an enemy capital within axisCapitalM. */
  axisObjM: 450,
  axisCapitalM: 350,
  /** A front keeps its own objective at least retargetS (1.x "AI was too fast"). */
  retargetS: 60,
  /** defend / fortify: the line is held at an own settlement within holdTownM of the front (not farther from home than the front + holdBackSlackM). */
  holdTownM: 700,
  holdBackSlackM: 150,
  /** … standing holdPadM beyond the settlement's radius toward the front. */
  holdPadM: 40,
  /** defend / fortify: local counter-attack on a place within counterM of the line, when the known enemy within counterR of the line and at the place is ≤ counterRatio × the front. */
  counterR: 500,
  counterM: 600,
  counterRatio: 0.4,
  counterPlaceR: 300,
  /** contract: fall back to an own town / city ≥ contractStepM nearer home (none: a point that far back); a front within contractHomeM of the capital holds where it is. */
  contractStepM: 300,
  contractHomeM: 900,
  /** contract: the fall back becomes a defence once the troops' centroid is within contractArriveM of the new line. */
  contractArriveM: 220,
  /** contract: a town with economic buildings counts this much nearer when choosing the fall-back town. */
  contractEconBonusM: 250,
  /** fortify: a front whose line is within zoneReuseM of a standing zone fortifies that zone; at zonesMax live zones a front without one just holds. */
  zoneReuseM: 350,
  zonesMax: 8,
  /** Reinforcement share multiplier of the directive's main effort (cityai.balanceReserves; 2.1 main = THEATRE.shareMain). */
  shareMainAxis: 2,
} as const;

/** Per-think view of the directive for one faction. */
export interface DirectiveCtx {
  readonly dir: Directive;
  /** Binding front orders (a player directive). */
  readonly bind: boolean;
  /** The main effort (offensive), the threatened place's front (defend / fortify with an axis), the front that takes the drawn line (fortify). */
  readonly main: Front | null;
  /** offensive: what the main effort attacks. */
  readonly axisTarget: { pos: V2; obj: Objective | null; city: number | null } | null;
}

/** Main-effort front chosen by the directive (-1 = none: cityai picks the strongest). */
const mains = new WeakMap<Faction, number>();
export const directiveMain = (f: Faction): number => mains.get(f) ?? -1;

/** Stable per-directive anchor of a front (hold point / fall-back point), recomputed when the directive changes. */
const anchors = new WeakMap<Front, { dir: Directive; p: V2 }>();

export function setResponse(s: Front, key: string, params: Record<string, string | number> = {}): void {
  s.response = key;
  s.responseParams = params;
}

/** The front whose line is nearest `p` (fronts given, so callers can leave zone garrisons out). */
function nearestOf(fronts: readonly Front[], p: V2): Front | null {
  let best: Front | null = null;
  let bd = Infinity;
  for (const s of fronts) {
    const d = frontDistance(s, p);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** What the main effort attacks: an enemy capital at the axis, else the place nearest the axis we do not hold, else the axis point. */
function axisTargetOf(world: World, f: Faction, axis: V2): { pos: V2; obj: Objective | null; city: number | null } {
  for (const e of world.factions) {
    if (e.alive && world.isHostile(f.id, e.id) && dist(world.hqPos(e.id), axis) < RESPONSE.axisCapitalM) return { pos: world.hqPos(e.id), obj: null, city: e.id };
  }
  // The place the axis was put on stays the axis objective once taken: the main effort holds what it
  // won instead of drifting to whatever other place lies near the point (merge 792e571: a captured
  // axis place retargeted the main effort 287 m sideways).
  const on = world.objectives.find((o) => dist(o.pos, axis) <= Math.max(40, o.radius));
  if (on) return { pos: on.pos, obj: on, city: null };
  let best: Objective | null = null;
  let bd: number = RESPONSE.axisObjM;
  for (const o of world.objectives) {
    if (o.owner === f.id) continue;
    const d = dist(o.pos, axis);
    if (d < bd) { bd = d; best = o; }
  }
  return best ? { pos: best.pos, obj: best, city: null } : { pos: { ...axis }, obj: null, city: null };
}

/**
 * Build the faction's directive view for this think. `field` = the fronts that answer the directive
 * (no zone garrisons); `value` = each front's combat value.
 */
export function directiveContext(world: World, f: Faction, field: readonly Front[], value: (s: Front) => number): DirectiveCtx {
  const dir = f.directive;
  const bind = dir.manual && dir.kind !== 'advance';
  let main: Front | null = null;
  let axisTarget: DirectiveCtx['axisTarget'] = null;
  if (dir.kind === 'offensive') {
    if (dir.axis) {
      axisTarget = axisTargetOf(world, f, dir.axis);
      main = nearestOf(field, axisTarget.pos);
    } else {
      for (const s of field) if (!main || value(s) > value(main)) main = s;
    }
  } else if ((dir.kind === 'defend' || dir.kind === 'fortify') && (dir.axis || dir.line)) {
    const at = dir.line ? mid(dir.line.a, dir.line.b) : dir.axis!;
    main = nearestOf(field, at);
  }
  if (main) mains.set(f, main.id);
  else mains.delete(f);
  return { dir, bind, main, axisTarget };
}

const mid = (a: V2, b: V2): V2 => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });

/** Orders the front commanders gave in answer to a directive (theatre: a binding one lapses when the directive goes back to advance). */
const given = new WeakSet<FrontOrder>();
export const givenByDirective = (o: FrontOrder): boolean => given.has(o);

/** Give the front an order unless it already stands (same kind, place, line and binding): no churn, operations keep running. */
function give(world: World, f: Faction, s: Front, kind: OrderKind, a: V2, b: V2 | null, bind: boolean): void {
  const o = s.order;
  const same = o.kind === kind && o.manual === bind && dist(o.a, a) < 5 && (o.b === null) === (b === null) && (!o.b || !b || dist(o.b, b) < 5);
  if (same) return;
  const order: FrontOrder = { kind, a: { ...a }, b: b ? { ...b } : null, issuedAt: world.time, manual: bind };
  given.add(order);
  const name = s.name;
  issueFrontOrder(world, f, s, order);
  // Fronts converging on the axis keep their own names (issueFrontOrder names a front after its objective).
  if (f.fronts.some((x) => x !== s && x.name === s.name)) s.name = name;
}

/**
 * The front commander answers the directive (every HQ think). Returns false for `advance` (and for
 * the AI's finisher offensive): theatre.orderFront then gives the 2.1 order.
 */
export function respondToDirective(world: World, f: Faction, s: Front, combat: Unit[], ctx: DirectiveCtx): boolean {
  const kind = ctx.dir.kind;
  if (kind === 'advance') return false;
  // The AI's finisher offensive keeps the 2.1 finisher (every front masses on the finish capital).
  if (kind === 'offensive' && !ctx.dir.manual && f.command.finisher) return false;
  const mine = sumValue(combat);
  if (kind === 'offensive') offensive(world, f, s, combat, mine, ctx);
  else if (kind === 'contract') contract(world, f, s, combat, ctx);
  else hold(world, f, s, mine, ctx);
  return true;
}

// ---------------------------------------------------------------- offensive

function offensive(world: World, f: Faction, s: Front, combat: Unit[], mine: number, ctx: DirectiveCtx): void {
  const t = ctx.axisTarget;
  const at = centroid(combat, s.front);
  if (t && (s === ctx.main || dist(at, t.pos) <= RESPONSE.supportM)) {
    give(world, f, s, 'attack', t.pos, null, ctx.bind);
    const held = t.obj !== null && t.obj.owner === f.id;
    setResponse(s, held ? 'resp.axisHeld' : s === ctx.main ? 'resp.main' : 'resp.support', placeParams(world, t.obj, t.city, t.pos));
    return;
  }
  // Own objective (the 1.x / 2.1 choice), kept ≥ retargetS unless it fell or the finish target calls.
  const keep = s.order.kind === 'attack' && !deadCapital(world, s) && (maneuvering(s) || (world.time - s.lastRetarget <= RESPONSE.retargetS && !finishNow(f, s)));
  const own = keep ? { pos: s.targetPos, obj: world.objectives.find((o) => o.id === s.targetObjective) ?? null, city: s.targetCity } : nextTarget(world, f, s);
  const threat = enemyNear(world, f.id, own.pos, 400);
  if (s !== ctx.main && mine > 0 && threat > mine * RESPONSE.pinRatio) {
    const pin = pinTarget(world, f, s, mine);
    if (pin) {
      give(world, f, s, 'attack', pin.pos, null, ctx.bind);
      setResponse(s, 'resp.pin', { point: pin.id, r: ratio(threat, mine) });
      return;
    }
    give(world, f, s, 'defend', anchorOf(world, f, s, ctx), null, ctx.bind);
    setResponse(s, 'resp.holdOutmatched', { r: ratio(threat, mine) });
    return;
  }
  give(world, f, s, 'attack', own.pos, null, ctx.bind);
  setResponse(s, s === ctx.main ? 'resp.main' : 'resp.attack', placeParams(world, own.obj, own.city, own.pos));
}

/** Pinning attack: the nearest place within pinSearchM of the front, not ours, held by ≤ pinPickRatio × the front. */
function pinTarget(world: World, f: Faction, s: Front, mine: number): Objective | null {
  let best: Objective | null = null;
  let bd: number = RESPONSE.pinSearchM;
  for (const o of world.objectives) {
    if (o.owner === f.id || (o.owner >= 0 && !world.isHostile(f.id, o.owner))) continue;
    const d = dist(o.pos, s.front);
    if (d >= bd || enemyNear(world, f.id, o.pos, 260) > mine * RESPONSE.pinPickRatio) continue;
    bd = d;
    best = o;
  }
  return best;
}

// ---------------------------------------------------------------- defend / fortify

function hold(world: World, f: Faction, s: Front, mine: number, ctx: DirectiveCtx): void {
  const fortify = ctx.dir.kind === 'fortify';
  const drawn = fortify && ctx.dir.line && s === ctx.main ? ctx.dir.line : null;
  const p = drawn ? mid(drawn.a, drawn.b) : anchorOf(world, f, s, ctx);
  const enemy = enemyNear(world, f.id, p, RESPONSE.counterR);
  // Local counter-attack: only on a clearly weaker enemy near the line.
  const ctr = mine > 0 && enemy > 0 && enemy <= mine * RESPONSE.counterRatio ? counterTarget(world, f, p, mine) : null;
  if (ctr) {
    give(world, f, s, 'attack', ctr.pos, null, ctx.bind);
    setResponse(s, 'resp.counter', { point: ctr.id });
    return;
  }
  // Fortify: a standing zone near the line is taken over, not duplicated; at the zone cap the front just holds.
  // (Another front's zone close by: this front holds its own line beside it — one front per zone, no parallel zones.)
  const near = fortify && !drawn ? zoneNear(f, p) : null;
  const zone = near && (near.frontId === null || near.frontId === s.id || !f.fronts.some((x) => x.id === near.frontId)) ? near : null;
  const full = fortify && !drawn && !zone && (!!near || f.zones.filter((z) => !z.cancelled).length >= RESPONSE.zonesMax);
  const kind: OrderKind = fortify && !full ? 'fortify' : 'defend';
  if (drawn) give(world, f, s, kind, drawn.a, drawn.b, ctx.bind);
  else if (zone) give(world, f, s, kind, zone.a, zone.b, ctx.bind);
  else give(world, f, s, kind, p, null, ctx.bind);
  const params = { point: s.targetObjective ?? '', r: ratio(enemy, mine) };
  if (mine > 0 && enemy > mine) setResponse(s, kind === 'fortify' ? 'resp.fortifyOutmatched' : 'resp.holdOutmatched', params);
  else if (drawn) setResponse(s, 'resp.fortifyLine', params);
  else if (s === ctx.main) setResponse(s, 'resp.holdAxis', params);
  else setResponse(s, kind === 'fortify' ? 'resp.fortify' : 'resp.hold', params);
}

/** A live fortified zone of ours whose line passes within zoneReuseM of `p`. */
function zoneNear(f: Faction, p: V2): Zone | null {
  let best: Zone | null = null;
  let bd: number = RESPONSE.zoneReuseM;
  for (const z of f.zones) {
    if (z.cancelled) continue;
    const d = segDist(p, z.a, z.b);
    if (d < bd) { bd = d; best = z; }
  }
  return best;
}

/**
 * A place within counterM of the line held by the enemy (an enemy settlement, or one with enemy troops
 * in it — empty neutral ground is not taken under a defence) with known enemy ≤ counterRatio × the front: the nearest.
 */
function counterTarget(world: World, f: Faction, p: V2, mine: number): Objective | null {
  let best: Objective | null = null;
  let bd: number = RESPONSE.counterM;
  for (const o of world.objectives) {
    if (o.owner === f.id || (o.owner >= 0 && !world.isHostile(f.id, o.owner))) continue;
    const d = dist(o.pos, p);
    if (d >= bd) continue;
    const there = enemyNear(world, f.id, o.pos, RESPONSE.counterPlaceR);
    if (there > mine * RESPONSE.counterRatio || (o.owner < 0 && there <= 0)) continue;
    bd = d;
    best = o;
  }
  return best;
}

// ---------------------------------------------------------------- contract

function contract(world: World, f: Faction, s: Front, combat: Unit[], ctx: DirectiveCtx): void {
  const p = anchorOf(world, f, s, ctx);
  const far = combat.length > 0 && dist(centroid(combat, s.front), p) > RESPONSE.contractArriveM;
  const params = { point: nearestPlace(world, p)?.id ?? '' };
  // March back first (fallBack drops spearheads and operations), then hold the new line.
  if (far && s.order.kind !== 'defend') {
    give(world, f, s, 'fallBack', p, null, ctx.bind);
    setResponse(s, 'resp.contract', params);
  } else {
    give(world, f, s, 'defend', p, null, ctx.bind);
    setResponse(s, 'resp.contractHold', params);
  }
}

// ---------------------------------------------------------------- anchors

/** The front's line under this directive, fixed while the directive stands (no drift as the front moves). */
function anchorOf(world: World, f: Faction, s: Front, ctx: DirectiveCtx): V2 {
  const kind = ctx.dir.kind === 'contract' ? 'contract' : 'hold';
  const m = anchors.get(s);
  if (m && m.dir === ctx.dir) return m.p;
  const p = kind === 'contract' ? contractPoint(world, f, s)
    : s === ctx.main && ctx.dir.axis && ctx.dir.kind !== 'offensive' ? snap(world, ctx.dir.axis) : holdPoint(world, f, s);
  anchors.set(s, { dir: ctx.dir, p });
  return p;
}

const snap = (world: World, p: V2): V2 => world.nav(false, 35).nearestPassable(p, 80) ?? { ...p };

/** Point `pad` beyond a place's radius toward `toward`. */
function edgeOf(o: Objective, toward: V2, pad: number): V2 {
  const h = dist(o.pos, toward) > 30 ? headingTo(o.pos, toward) : 0;
  return { x: o.pos.x + Math.cos(h) * (o.radius + pad), z: o.pos.z + Math.sin(h) * (o.radius + pad) };
}

/** Hold the front's line: in front of the nearest own settlement near the front (not farther out than the front), else at the front. */
function holdPoint(world: World, f: Faction, s: Front): V2 {
  const hq = world.hqPos(f.id);
  const c = s.front;
  const dc = dist(c, hq);
  let best: Objective | null = null;
  let bd: number = RESPONSE.holdTownM;
  for (const o of world.objectives) {
    if (o.owner !== f.id || o.contested || dist(o.pos, hq) > dc + RESPONSE.holdBackSlackM) continue;
    const d = dist(o.pos, c);
    if (d < bd) { bd = d; best = o; }
  }
  return snap(world, best ? edgeOf(best, c, RESPONSE.holdPadM) : c);
}

/** Contract: the nearest own uncontested town / city ≥ contractStepM nearer home than the front, else a point that far back. */
function contractPoint(world: World, f: Faction, s: Front): V2 {
  const hq = world.hqPos(f.id);
  const df = dist(s.front, hq);
  if (df < RESPONSE.contractHomeM) return holdPoint(world, f, s);
  let best: Objective | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    if (o.owner !== f.id || o.contested || (o.kind !== 'town' && o.kind !== 'city')) continue;
    if (dist(o.pos, hq) > df - RESPONSE.contractStepM) continue;
    // 2.2: a town with economic buildings is the line worth falling back to (econwar.econWorth).
    const d = dist(o.pos, s.front) - (econWorth(world, o.id, f.id) > 0 ? RESPONSE.contractEconBonusM : 0);
    if (d < bd) { bd = d; best = o; }
  }
  if (best) return snap(world, edgeOf(best, s.front, RESPONSE.holdPadM));
  const t = (RESPONSE.contractStepM * 2) / Math.max(1, df);
  return snap(world, { x: s.front.x + (hq.x - s.front.x) * t, z: s.front.z + (hq.z - s.front.z) * t });
}

// ---------------------------------------------------------------- text

const ratio = (theirs: number, mine: number): string => (theirs / Math.max(1, mine)).toFixed(1);

function nearestPlace(world: World, p: V2): Objective | null {
  let best: Objective | null = null;
  let bd = 500;
  for (const o of world.objectives) {
    const d = dist(o.pos, p);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

/** Card params: the objective (`point`), an enemy capital (`city`), else the place nearest the point. */
function placeParams(world: World, obj: Objective | null, city: number | null, pos: V2): Record<string, string | number> {
  if (obj) return { point: obj.id };
  if (city !== null) return { city };
  return { point: nearestPlace(world, pos)?.id ?? '' };
}
