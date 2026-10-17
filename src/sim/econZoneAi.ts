import { enemyDistance } from './frontai';
import { linkedAt, startZone, townClearance, upgradeZone, zoneJobCost, zoneRules, zoneSiteFail, zonesOf, type EconZone } from './econZones';
import { Ground } from './terrain';
import type { Faction } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 AI investment in economic zones (V30 §7): the supreme HQ's auto-invest (every faction with
 * `autoInvest`, the player's too) also places zones where the land is safe (far from hostile
 * ground) and a road is near, raises them to level 2 / 3, and rebuilds ruins. How much it does
 * is `appetite` (econai.investAppetite) × the faction's investment style.
 *
 * SEAM (lead, 3.0 doctrines): `INVEST_STYLE` is the per-doctrine weight table; `setInvestStyle`
 * overrides one faction (labs, doctrine wiring). Until doctrines land the key is the personality.
 */
export const INVEST_STYLE: Readonly<Record<string, number>> = {
  // 2.x personalities
  balanced: 1, armor: 0.7, infantry: 1.1, mechanized: 0.8, artillery: 1,
  // 3.0 doctrines (V30 §1) — the lead connects these
  builder: 2.2, blitz: 0.25, attrition: 1.2, defensive: 1.4,
};

const styleOverride = new WeakMap<Faction, number>();
export const setInvestStyle = (f: Faction, w: number): void => { styleOverride.set(f, w); };
export const investStyleOf = (f: Faction): number => styleOverride.get(f) ?? INVEST_STYLE[f.personality] ?? 1;

export const ZONE_AI = {
  /** Stock kept after paying (÷ appetite × style). */
  reserveP: 30,
  reserveM: 180,
  /** Hostile ground at least this far (+ unsafePadM × (1 − safety)) from a new zone. */
  safeM: 450,
  unsafePadM: 250,
  /** Road sample spacing and the side offset of a site from the road (m). */
  roadStepM: 90,
  roadOffsetM: 38,
  /** Distance from the capital costs this much score per metre (stay near home). */
  homePull: 0.35,
  /** Candidates checked in full per think (best scores first). */
  checkTop: 24,
} as const;

/** Static candidate sites per world: along every road, off to both sides, away from towns and capitals. */
const candidates = new WeakMap<World, V2[]>();

function candidateSites(world: World): V2[] {
  let c = candidates.get(world);
  if (c) return c;
  c = [];
  const r = zoneRules(world);
  const t = world.terrain;
  for (const road of t.def.roads) {
    for (let k = 0; k + 1 < road.length; k++) {
      const a = road[k];
      const b = road[k + 1];
      const len = dist(a, b);
      if (len < 1) continue;
      const nx = -(b.z - a.z) / len;
      const nz = (b.x - a.x) / len;
      for (let s = ZONE_AI.roadStepM / 2; s < len; s += ZONE_AI.roadStepM) {
        for (const side of [1, -1]) {
          const p = { x: a.x + ((b.x - a.x) * s) / len + nx * side * ZONE_AI.roadOffsetM, z: a.z + ((b.z - a.z) * s) / len + nz * side * ZONE_AI.roadOffsetM };
          if (!t.inBounds(p.x, p.z) || t.groundAt(p.x, p.z) === Ground.Water || t.buildingH(p.x, p.z) > 0) continue;
          if (r && world.objectives.some((o) => o.kind !== 'point' && dist(o.pos, p) < townClearance(r, o))) continue;
          c.push(p);
        }
      }
    }
  }
  candidates.set(world, c);
  return c;
}

/** Best new zone site for `f` (safe, near a road, near home), or null. */
export function pickZoneSite(world: World, f: Faction, safety: number): V2 | null {
  const hq = world.hqPos(f.id);
  const safeM = ZONE_AI.safeM + ZONE_AI.unsafePadM * (1 - safety);
  const scored: { p: V2; s: number }[] = [];
  for (const p of candidateSites(world)) {
    const e = enemyDistance(world, f.id, p);
    if (e < safeM) continue;
    scored.push({ p, s: Math.min(e, 2000) - ZONE_AI.homePull * dist(p, hq) });
  }
  scored.sort((a, b) => b.s - a.s || a.p.x - b.p.x || a.p.z - b.p.z);
  // Road-linked sites first (full output), else the best unlinked one.
  let fallback: V2 | null = null;
  for (const c of scored.slice(0, ZONE_AI.checkTop)) {
    if (zoneSiteFail(world, f, c.p) !== null) continue;
    if (linkedAt(world, f.id, c.p)) return c.p;
    fallback ??= c.p;
  }
  return fallback;
}

/**
 * One zone decision per investment think (econai.thinkInvestment): rebuild a ruin, raise a zone,
 * or found a new one — one job open at a time, paid from stock while a reserve is left.
 */
export function thinkZones(world: World, f: Faction, appetite: number, safety: number): void {
  const r = zoneRules(world);
  const w = investStyleOf(f);
  if (!r || w <= 0 || appetite <= 0) return;
  const mine = zonesOf(world, f.id);
  if (mine.some((z) => !z.ruined && z.progress < 1)) return;
  const keep = 1 / Math.max(0.5, appetite * w);
  const can = (c: { p: number; m: number }): boolean => f.p >= c.p + ZONE_AI.reserveP * keep && f.m >= c.m + ZONE_AI.reserveM * keep;
  const safeM = ZONE_AI.safeM * 0.6;
  const safeZone = (z: EconZone): boolean => enemyDistance(world, f.id, z.pos) >= safeM;
  // Ruins first (cheaper than new), then levels, then new zones.
  for (const z of mine) {
    if (!z.ruined || !safeZone(z)) continue;
    const c = zoneJobCost(world, z);
    if (c && can(c)) upgradeZone(world, f, z);
    return;
  }
  const allowed = Math.min(r.max_per_faction, Math.round(w * (1 + 2 * appetite)));
  const levels = mine.reduce((s, z) => s + z.level, 0);
  const wantNew = mine.length < allowed && mine.length * 2 <= levels;
  if (!wantNew) {
    const up = mine.filter((z) => !z.ruined && z.level < r.levels.length && safeZone(z)).sort((a, b) => a.level - b.level || Number(b.linked) - Number(a.linked) || a.id - b.id)[0];
    if (!up) return;
    const c = zoneJobCost(world, up);
    if (c && can(c)) upgradeZone(world, f, up);
    return;
  }
  const first = r.levels[0];
  if (!can({ p: first.cost_p, m: first.cost_m })) return;
  const site = pickZoneSite(world, f, safety);
  if (site) startZone(world, f, site);
}
