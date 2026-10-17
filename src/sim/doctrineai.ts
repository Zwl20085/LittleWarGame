import { profileOf, setEnemyBroken, type DoctrineProfile } from './doctrines';
import { isCommander } from './formulas';
import type { DirectiveKind, Faction } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 doctrine directives (V30_SPEC §1): the AI supreme HQ's directive choice by doctrine
 * (directive.chooseDirective asks here after the finisher). One O(units) pass every HQ think.
 *
 * - outmatched (army < defend_below × the strongest known, kept to defend_exit): the doctrine's
 *   defence — builder defends and contracts below contract_below, attrition fortifies (fights from
 *   works), blitz / maneuver defend;
 * - offensive `late` (builder, attrition): after after_s, with a full army and attack_ratio × the
 *   target's army, a general offensive on the weakest near capital (convert the lead), max_s long;
 * - offensive `strike` (blitz): after after_s it consolidates a compact perimeter (`between`:
 *   defend) and masses; at attack_ratio × the target's army and min_fullness (or force_ratio after
 *   force_after_s of waiting) one deep offensive on that capital; called off at break_share of the
 *   army or after max_s, then re-arms (cooldown_s) and tries again;
 * - offensive `battle` (maneuver): the main body (main_share of the army) hunts an isolated enemy
 *   front — known enemy at its line ≥ minBattle, no other enemy mass near it — at attack_ratio,
 *   offensive with that point as the axis; ends once that enemy is broken, after max_s or at
 *   break_share.
 * The AI finisher (command.ts) still comes first: wars must end.
 */
export const DOCTRINE_AI = {
  /** Battle: enemy value within lineR of an enemy front's line point is that front's force … */
  lineR: 450,
  /** … isolated when the known enemy within isolationR is at most isolationMul × it. */
  isolationR: 1300,
  isolationMul: 1.35,
  /** Smallest enemy force worth a decisive battle (value). */
  minBattle: 400,
  /** Battle over (won) when the enemy at the axis is down to this share of its value at launch. */
  wonShare: 0.3,
  /** Share of our army counted as the main body when weighing a battle. */
  mainBody: 0.6,
} as const;

interface State {
  phase: 'idle' | 'offensive';
  since: number;
  startArmy: number;
  target: number;
  axis: V2 | null;
  startEnemy: number;
  restUntil: number;
  /** Consolidating (no offensive) since (strike force_after_s). */
  idleSince: number;
}

const states = new WeakMap<Faction, State>();
function stateOf(f: Faction): State {
  let s = states.get(f);
  if (!s) {
    s = { phase: 'idle', since: 0, startArmy: 0, target: -1, axis: null, startEnemy: 0, restUntil: 0, idleSince: -1 };
    states.set(f, s);
  }
  return s;
}

/** Doctrine phase for the lab / tests ('idle' | 'offensive') and its target. */
export function doctrinePhase(f: Faction): { phase: State['phase']; target: number; axis: V2 | null } {
  const s = stateOf(f);
  return { phase: s.phase, target: s.target, axis: s.axis };
}

export interface Armies { mine: number; theirs: Map<number, number>; top: number }

/** Our army value and every hostile faction's known army value (combat units, P + M). */
export function armies(world: World, f: Faction): Armies {
  let mine = 0;
  const theirs = new Map<number, number>();
  for (const u of world.aliveUnits) {
    if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
    const v = u.def.costP + u.def.costM;
    if (u.owner === f.id) mine += v;
    else if (world.isHostile(f.id, u.owner) && world.knows(f.id, u)) theirs.set(u.owner, (theirs.get(u.owner) ?? 0) + v);
  }
  return { mine, theirs, top: Math.max(0, ...theirs.values()) };
}

export interface DoctrineChoice { readonly kind: DirectiveKind; readonly axis: V2 | null }

/** The doctrine's directive this think, or null (no doctrine: the 2.2 choice). */
export function doctrineDirective(world: World, f: Faction): DoctrineChoice | null {
  const p = profileOf(world, f);
  if (!p) return null;
  const a = armies(world, f);
  const ratio = a.top > 0 ? a.mine / a.top : Infinity;
  setEnemyBroken(f, a.top < p.broken_ratio * a.mine);
  const st = stateOf(f);
  if (st.phase === 'offensive') {
    const going = continueOffensive(world, f, p, st, a);
    if (going) return going;
  }
  const cur = f.directive.kind;
  if (p.contract_below > 0 && ratio < p.contract_below) return { kind: 'contract', axis: null };
  if (ratio < p.defend_below || ((cur === p.defend_kind || cur === 'contract') && ratio < p.defend_exit)) return { kind: p.defend_kind, axis: null };
  const o = p.offensive;
  if (o.mode === 'none' || world.time < o.after_s) {
    st.idleSince = -1;
    return { kind: 'advance', axis: null };
  }
  if (st.idleSince < 0) st.idleSince = world.time;
  const launch = world.time >= st.restUntil ? (o.mode === 'battle' ? battleTarget(world, f, p, a) : capitalTarget(world, f, p, st, a)) : null;
  if (launch) {
    st.phase = 'offensive';
    st.since = world.time;
    st.startArmy = a.mine;
    st.target = launch.target;
    st.axis = launch.axis;
    st.startEnemy = launch.enemy;
    st.idleSince = -1;
    world.note(f.id, o.mode === 'battle' ? 'log.doctrineBattle' : 'log.doctrineOffensive', launch.target >= 0 ? { city: launch.target } : {}, 'info');
    return { kind: 'offensive', axis: launch.axis };
  }
  return { kind: o.between, axis: null };
}

/** A running doctrine offensive: still on (its directive) or over (null; the rest starts). */
function continueOffensive(world: World, f: Faction, p: DoctrineProfile, st: State, a: Armies): DoctrineChoice | null {
  const o = p.offensive;
  const dead = st.target >= 0 && !world.factions[st.target]?.alive;
  const spent = a.mine < st.startArmy * o.break_share;
  const late = world.time - st.since > o.max_s;
  const won = o.mode === 'battle' && !!st.axis && enemyAt(world, f, st.axis, DOCTRINE_AI.lineR) < st.startEnemy * DOCTRINE_AI.wonShare;
  if (!dead && !spent && !late && !won) return { kind: 'offensive', axis: st.axis };
  st.phase = 'idle';
  st.restUntil = world.time + (dead || won ? Math.min(o.cooldown_s, 60) : o.cooldown_s);
  st.idleSince = world.time;
  world.note(f.id, 'log.doctrineRearm', {}, 'info');
  return null;
}

/** late / strike: the weakest near enemy capital, when the force ratio (and fullness) is met. */
function capitalTarget(world: World, f: Faction, p: DoctrineProfile, st: State, a: Armies): { target: number; axis: V2; enemy: number } | null {
  const o = p.offensive;
  const hq = world.hqPos(f.id);
  let best = -1;
  let bestScore = Infinity;
  for (const e of world.factions) {
    if (!e.alive || e.id === f.id || !world.isHostile(f.id, e.id)) continue;
    const theirs = a.theirs.get(e.id) ?? 0;
    const score = dist(world.hqPos(e.id), hq) * (0.5 + theirs / Math.max(1, a.mine));
    if (score < bestScore) { bestScore = score; best = e.id; }
  }
  if (best < 0) return null;
  const r = a.mine / Math.max(1, a.theirs.get(best) ?? 0);
  const full = f.command.fullness >= o.min_fullness;
  const ready = full && r >= p.attack_ratio && (o.mode !== 'late' || a.mine >= a.top);
  const forced = o.force_after_s > 0 && st.idleSince >= 0 && world.time - st.idleSince >= o.force_after_s && r >= o.force_ratio;
  return ready || forced ? { target: best, axis: world.hqPos(best), enemy: a.theirs.get(best) ?? 0 } : null;
}

/** Known hostile combat value within r of p. */
function enemyAt(world: World, f: Faction, p: V2, r: number): number {
  let v = 0;
  for (const u of world.spatial.query(p.x, p.z, r)) {
    if (u.hp <= 0 || u.fixed || !world.isHostile(f.id, u.owner) || !world.knows(f.id, u) || isCommander(u.def) || u.def.id === 'supply_truck') continue;
    v += (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);
  }
  return v;
}

/** battle: the isolated enemy front our main body beats by attack_ratio (largest such force first). */
function battleTarget(world: World, f: Faction, p: DoctrineProfile, a: Armies): { target: number; axis: V2; enemy: number } | null {
  if (f.command.fullness < p.offensive.min_fullness) return null;
  const body = a.mine * DOCTRINE_AI.mainBody;
  let best: { target: number; axis: V2; enemy: number } | null = null;
  for (const e of world.factions) {
    if (!e.alive || e.id === f.id || !world.isHostile(f.id, e.id)) continue;
    for (const s of e.fronts) {
      const v = enemyAt(world, f, s.front, DOCTRINE_AI.lineR);
      if (v < DOCTRINE_AI.minBattle || body < v * p.attack_ratio) continue;
      if (enemyAt(world, f, s.front, DOCTRINE_AI.isolationR) > v * DOCTRINE_AI.isolationMul) continue;
      if (!best || v > best.enemy) best = { target: e.id, axis: { ...s.front }, enemy: v };
    }
  }
  return best ? { ...best, target: -1 } : null;
}
