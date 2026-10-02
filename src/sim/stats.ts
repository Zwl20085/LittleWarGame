import type { Faction, Unit } from './types';

/**
 * Numeric analysis (user request): per-unit-type combat ledger and an economy timeline, so the
 * balance can be tuned from data — damage dealt/taken, kills, losses, value traded, ammo used.
 * Plain counters only (a few additions per damage event); never read by the AI, so it cannot
 * change the deterministic outcome of a match.
 */
export interface TypeStats {
  built: number;
  lost: number;
  spent: number; // P + M paid for units of this type
  shots: number;
  dmgDealt: number; // HP actually removed (no overkill)
  dmgTaken: number;
  kills: number;
  killValue: number; // P + M of enemy units destroyed
  aliveSeconds: number; // unit-seconds on the field (for per-minute rates)
}

export interface TimelinePoint {
  readonly t: number;
  readonly f: ReadonlyArray<{
    p: number; m: number; incP: number; incM: number; units: number; pop: number; popCap: number;
    held: number; resolve: number; lost: number; value: number;
  }>;
}

export interface MatchStats {
  /** [faction][unitType] */
  readonly byType: Record<string, TypeStats>[];
  /** attacker type → victim type → { dmg, kills } (all factions pooled). */
  readonly matrix: Record<string, Record<string, { dmg: number; kills: number }>>;
  readonly timeline: TimelinePoint[];
}

export const STATS_SAMPLE_SECONDS = 30;

export function createStats(factions: number): MatchStats {
  return { byType: Array.from({ length: factions }, () => ({})), matrix: {}, timeline: [] };
}

function row(s: MatchStats, f: number, type: string): TypeStats {
  const tbl = s.byType[f];
  if (!tbl) return blank();
  return (tbl[type] ??= blank());
}

function blank(): TypeStats {
  return { built: 0, lost: 0, spent: 0, shots: 0, dmgDealt: 0, dmgTaken: 0, kills: 0, killValue: 0, aliveSeconds: 0 };
}

export function recordBuilt(s: MatchStats, u: Unit): void {
  const r = row(s, u.owner, u.def.id);
  r.built++;
  r.spent += u.def.costP + u.def.costM;
}

export function recordShot(s: MatchStats, u: Unit): void {
  row(s, u.owner, u.def.id).shots++;
}

/** `src` = attacker unit type ('air' for aircraft); `srcOwner` = attacking faction. */
export function recordDamage(s: MatchStats, srcOwner: number, src: string, victim: Unit, hp: number, killed: boolean): void {
  const vt = victim.fixed ? 'fixed' : victim.def.id;
  const a = row(s, srcOwner, src);
  a.dmgDealt += hp;
  const v = row(s, victim.owner, vt);
  v.dmgTaken += hp;
  const m = ((s.matrix[src] ??= {})[vt] ??= { dmg: 0, kills: 0 });
  m.dmg += hp;
  if (!killed) return;
  m.kills++;
  a.kills++;
  a.killValue += victim.def.costP + victim.def.costM;
  v.lost++;
}

/** Once per STATS_SAMPLE_SECONDS: alive time per type plus the economy snapshot. */
export function sampleStats(s: MatchStats, t: number, units: Iterable<Unit>, factions: readonly Faction[], extra: (f: Faction) => { popCap: number; held: number }): void {
  const count = factions.map(() => ({ n: 0, value: 0 }));
  for (const u of units) {
    if (u.hp <= 0 || u.fixed) continue;
    row(s, u.owner, u.def.id).aliveSeconds += STATS_SAMPLE_SECONDS;
    const c = count[u.owner];
    if (c) {
      c.n++;
      c.value += u.def.costP + u.def.costM;
    }
  }
  s.timeline.push({
    t,
    f: factions.map((f, i) => {
      const x = extra(f);
      return {
        p: Math.round(f.p), m: Math.round(f.m), incP: Math.round(f.incomeP), incM: Math.round(f.incomeM),
        units: count[i].n, pop: f.popPresent + f.popReserved, popCap: x.popCap, held: x.held,
        resolve: Math.round(f.resolve), lost: f.lostUnits, value: count[i].value,
      };
    }),
  });
}
