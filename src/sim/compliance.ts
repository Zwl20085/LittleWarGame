import type { ComplianceRules } from '../data/frontRules';
import { noteResponse } from './events';
import { RESPONSE, setResponse, type DirectiveCtx } from './frontresponse';
import { Rng } from './rng';
import { centroid, enemyNear, sumValue } from './theatreq';
import type { Directive, DirectiveKind, Faction, Front, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 directive compliance — 前线指挥官的自由 (docs/V30_SPEC.md §6, WP-C). The user found the 2.2
 * supreme-HQ directive too binding ("after many orders I lose"). Every HQ think each front commander
 * weighs the directive: compliance ∈ [0, 1] = base + proximity to the capital + temperament − risk
 * (expected force ratio at its objective, own towns it would leave exposed, its ammunition, an
 * assault it would break off). Below `command.compliance_threshold` it declines, says why on its
 * card and does its best local action (theatre.orderFront); above it obeys after a delay that grows
 * with its distance from the capital — nearer fronts move first. A `defend` on the capital is never
 * declined by a front within `home_recall_m`. A directive the player insists on (`Directive.forced`:
 * re-issued within `insist_window_s`, or the HUD Force toggle) is obeyed at once by every front, as
 * in 2.1. The AI supreme HQ's directives go through the same model.
 */

/** Lab switch (A/B, scripts/lab30/directive.ts): compliance on / off (rules `command.compliance.enabled` is the default). */
export const COMPLIANCE_AB = { on: true };

export type Answer = 'obey' | 'wait' | 'decline';

interface State { sig: string; obey: 'obey' | 'pending' | 'declined'; obeyAt: number; delay: number }
const states = new WeakMap<Front, State>();
/** Earliest time a waiting front of the faction moves (Infinity = none waiting). */
const due = new WeakMap<Faction, number>();

const rulesOf = (world: World): ComplianceRules => world.data.rules.command.compliance;
export const complianceOn = (world: World): boolean => COMPLIANCE_AB.on && rulesOf(world).enabled;

/** Same directive content (kind, axis, line within 30 m): a re-issue does not restart the answer. */
export function directiveSig(d: Pick<Directive, 'kind' | 'axis' | 'line'>): string {
  const p = (v: V2 | null | undefined): string => (v ? `${Math.round(v.x / 30)},${Math.round(v.z / 30)}` : '-');
  return `${d.kind}|${p(d.axis)}|${p(d.line?.a)}|${p(d.line?.b)}`;
}

/** The commander's temperament 0 (cautious) … 1 (bold): a deterministic per-front draw from the match seed. */
export function temperament(world: World, f: Faction, s: Front): number {
  return new Rng((world.config.seed ^ 0x51ed2701) + f.id * 7919 + s.id * 104729).next();
}

/** A defend directive whose axis is the faction's own capital (home recall). */
export function homeRecall(world: World, f: Faction, d: Directive): boolean {
  return d.kind === 'defend' && !!d.axis && dist(d.axis, world.hqPos(f.id)) <= RESPONSE.contractHomeM / 2;
}

interface Risk { risk: number; key: string; params: Record<string, string | number> }

/** Own town / city near the front that the enemy threatens (it would be left exposed). */
function exposedTown(world: World, f: Faction, at: V2, mine: number, c: ComplianceRules): string | null {
  let best: string | null = null;
  let bd = c.expose_m;
  for (const o of world.objectives) {
    if (o.owner !== f.id || (o.kind !== 'town' && o.kind !== 'city')) continue;
    const d = dist(o.pos, at);
    if (d >= bd) continue;
    if (enemyNear(world, f.id, o.pos, c.expose_r) < c.expose_ratio * Math.max(1, mine)) continue;
    bd = d;
    best = o.id;
  }
  return best;
}

/** The order's local risk for this front, with the reason it would give for declining. */
function riskOf(world: World, f: Faction, s: Front, combat: Unit[], ctx: DirectiveCtx, at: V2): Risk {
  const c = rulesOf(world);
  const mine = sumValue(combat);
  const kind: DirectiveKind = ctx.dir.kind;
  if (kind === 'offensive') {
    const t = ctx.axisTarget && (s === ctx.main || dist(at, ctx.axisTarget.pos) <= RESPONSE.supportM) ? ctx.axisTarget.pos : s.targetPos;
    const ratio = enemyNear(world, f.id, t, 400) / Math.max(1, mine);
    const rr = Math.max(0, Math.min(1, (ratio - c.ratio_ok) / (c.ratio_bad - c.ratio_ok)));
    const town = exposedTown(world, f, at, mine, c);
    let ammo = 0;
    for (const u of combat) ammo += u.ammo;
    ammo = combat.length > 0 ? ammo / combat.length : 1;
    const low = ammo < c.low_ammo;
    const risk = Math.min(1, rr + (town ? c.expose_risk : 0) + (low ? c.ammo_risk : 0));
    const r = (Math.round(ratio * 10) / 10).toFixed(1);
    if (rr >= 0.2 && town) return { risk, key: 'resp.declinedExpose', params: { r, point: town } };
    if (rr >= 0.2) return { risk, key: 'resp.declined', params: { r } };
    if (town) return { risk, key: 'resp.declinedTown', params: { point: town } };
    if (low) return { risk, key: 'resp.declinedAmmo', params: { ammo: Math.round(ammo * 100) } };
    return { risk, key: 'resp.declinedFar', params: {} };
  }
  // Defend / fortify / contract: breaking off a winning assault is the risk.
  if (s.order.kind === 'attack' && (s.opPhase === 'assault' || s.posture === 'assault')) {
    const theirs = enemyNear(world, f.id, s.targetPos, 300);
    if (mine >= c.assault_ratio * Math.max(1, theirs)) return { risk: c.assault_risk, key: 'resp.declinedAssault', params: s.targetCity !== null ? { city: s.targetCity } : { point: s.targetObjective ?? '' } };
  }
  return { risk: 0, key: 'resp.declinedFar', params: {} };
}

/** Compliance of front `s` with the directive in force (also stored on the front for the card). */
export function complianceOf(world: World, f: Faction, s: Front, combat: Unit[], ctx: DirectiveCtx): { value: number; distM: number; risk: Risk } {
  const c = rulesOf(world);
  const at = centroid(combat, s.front);
  const distM = dist(at, world.hqPos(f.id));
  const prox = 1 - Math.max(0, Math.min(1, (distM - c.near_m) / (c.far_m - c.near_m)));
  const risk = riskOf(world, f, s, combat, ctx, at);
  const value = Math.max(0, Math.min(1, c.base + c.proximity_weight * prox + c.temperament_weight * (temperament(world, f, s) - 0.5) - c.risk_weight * risk.risk));
  return { value, distM, risk };
}

/** Seconds a front this far from the capital takes to act on an order it accepts (by distance only: nearer fronts always move first). */
export function obeyDelay(world: World, distM: number): number {
  const c = rulesOf(world);
  return Math.max(c.delay_min_s, Math.min(c.delay_max_s, c.delay_s_per_km * (distM / 1000)));
}

/**
 * The front's answer to the directive this think: 'obey' (frontresponse answers it), 'wait' (it has
 * accepted and moves at `obeyAt`; the previous order stands) or 'decline' (it acts on its own; the
 * card says why). `advance`, the AI finisher's offensive and compliance off: always 'obey'.
 */
export function answerDirective(world: World, f: Faction, s: Front, combat: Unit[], ctx: DirectiveCtx): Answer {
  const dir = ctx.dir;
  const kind = dir.kind;
  if (kind === 'advance' || (kind === 'offensive' && !dir.manual && f.command.finisher) || !complianceOn(world)) {
    s.obey = '';
    s.compliance = -1;
    states.delete(s);
    return 'obey';
  }
  const sig = directiveSig(dir);
  const prev = states.get(s);
  const same = !!prev && prev.sig === sig;
  if (dir.forced) {
    if (s.obey !== 'forced') noteResponse(world, { f: f.id, front: s.id, kind, result: 'forced', c: 1, delay: 0, distM: 0, reason: '' });
    s.obey = 'forced';
    s.compliance = 1;
    states.set(s, { sig, obey: 'obey', obeyAt: world.time, delay: 0 });
    return 'obey';
  }
  const c = rulesOf(world);
  const thr = world.data.rules.command.compliance_threshold;
  const { value, distM, risk } = complianceOf(world, f, s, combat, ctx);
  s.compliance = Math.round(value * 100) / 100;
  const home = homeRecall(world, f, dir) && distM <= world.data.rules.command.home_recall_m;
  const bar = !same ? thr : prev.obey === 'declined' ? thr + c.hysteresis : thr - c.hysteresis;
  if (!home && value < bar) {
    if (!same || prev.obey !== 'declined') {
      noteResponse(world, { f: f.id, front: s.id, kind, result: 'declined', c: s.compliance, delay: 0, distM: Math.round(distM), reason: risk.key });
      world.note(f.id, 'log.frontDeclined', { point: s.name }, 'warn');
    }
    states.set(s, { sig, obey: 'declined', obeyAt: Infinity, delay: 0 });
    s.obey = 'declined';
    setResponse(s, risk.key, risk.params);
    return 'decline';
  }
  // Accepted: once per directive, after a delay by distance (a front that declined and now accepts starts counting now).
  let st = same && prev.obey !== 'declined' ? prev : null;
  if (!st) {
    const delay = obeyDelay(world, distM);
    const from = same ? world.time : Math.max(dir.issuedAt, world.time - 5);
    st = { sig, obey: 'pending', obeyAt: from + delay, delay: Math.round(delay) };
    states.set(s, st);
  }
  if (st.obey === 'pending' && world.time >= st.obeyAt) {
    st.obey = 'obey';
    noteResponse(world, { f: f.id, front: s.id, kind, result: 'obeyed', c: s.compliance, delay: st.delay, distM: Math.round(distM), reason: '' });
  }
  s.obeyAt = st.obeyAt;
  if (st.obey === 'pending') {
    s.obey = 'pending';
    due.set(f, Math.min(due.get(f) ?? Infinity, st.obeyAt));
    setResponse(s, 'resp.pending', { s: Math.max(1, Math.ceil(st.obeyAt - world.time)) });
    return 'wait';
  }
  s.obey = 'obey';
  return 'obey';
}

/** A waiting front of the faction is due to move now (command.thinkHighCommand then answers at once). */
export function complianceDue(world: World, f: Faction): boolean {
  const t = due.get(f);
  if (t === undefined || world.time < t) return false;
  due.delete(f);
  return true;
}

/**
 * The player insists (V30 §6): the same directive again within `insist_window_s` of the last one,
 * or an explicit force flag from the HUD toggle (true / false wins over the re-issue rule).
 */
export function insisted(world: World, f: Faction, next: Pick<Directive, 'kind' | 'axis' | 'line'>, force: boolean | undefined): boolean {
  if (force !== undefined) return force;
  const cur = f.directive;
  if (cur.forced && directiveSig(cur) === directiveSig(next)) return true;
  return cur.manual && cur.kind !== 'advance' && directiveSig(cur) === directiveSig(next) && world.time - cur.issuedAt <= world.data.rules.command.insist_window_s;
}
