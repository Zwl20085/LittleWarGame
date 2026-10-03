import { hostileMask } from './spatial';
import { EAGER, stormOn } from './strategyai';
import type { Faction, Sector, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Round 4 (lead: "wars must end again"): the decisive offensive against a fortified, garrisoned
 * capital becomes a siege-and-storm run by the existing siege op (doctrine.ts):
 *   form  — the groups mass on the siege ring outside the defenders' direct-fire range and every
 *           gun of the besieging groups deploys within range of the capital's works and garrison;
 *   storm — once the mass at the capital is ≥ `massRatio` × the forecast defence (or the forecast
 *           has dropped under the guns), the ring storms;
 *   dig   — a stalled storm falls back to the ring, digs trenches and lets the guns work, then
 *           storms again once the garrison has been worn down.
 * The forecast is the attacker's mirror of homeguard's: known enemy value around the capital
 * (fixed strongpoints included) plus the finished works there.
 */
export const STORM = {
  /** Defence forecast: known hostile value within this radius of the capital… */
  defenceR: 320,
  /** …plus this much value per finished trench / sandbag line within `defenceR`. */
  trenchValue: 160,
  sandbagValue: 80,
  /** Our value within `massR` of the capital that counts as the storm mass. */
  massR: 1000,
  /** Storm at mass ≥ massRatio × forecast; after `formMaxS` storm anyway at ≥ minRatio, else dig. */
  massRatio: 1.6,
  minRatio: 1.1,
  formMinS: 40,
  formMaxS: 150,
  /** A storm stalls when, after `stallS`, the forecast is still ≥ stallKeep × its value at the start and the mass < 1.5 × it. */
  stallS: 75,
  stallKeep: 0.8,
  /** Dig phase: storm again once the forecast has fallen to wornShare × its value when digging began (or mass ≥ massRatio ×), between digMinS and digMaxS. */
  wornShare: 0.7,
  digMinS: 60,
  digMaxS: 200,
  /** Whole capital siege gives up (timeout) after this long. */
  maxS: 1200,
  /** A group within this distance of an enemy capital it targets lays siege to it (instead of marching frontal). */
  engageM: 1800,
  /** Siege only when the forecast is at least this share of the group (an empty capital is simply taken). */
  minDefenceShare: 0.2,
  /** Storm: the whole line's slots close on the capital (ring of this radius, ±stormArc toward our side). */
  stormRingM: 25,
  stormArc: 1.4,
} as const;

const value = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));

/** Is this group's target an enemy capital it should besiege (round 4 on)? */
export const capitalSiege = (s: Sector): boolean => stormOn() && STORM_AB.siege && s.targetCity !== null;

/** Lab switch for the capital siege alone (the rest of round 4 stays on). */
export const STORM_AB = { siege: true };

/** Forecast defence of capital `city` as seen by faction `f` (known units + finished works). */
export function capitalDefence(world: World, f: number, city: number): number {
  const hq = world.hqPos(city);
  let v = 0;
  for (const u of world.spatial.queryOwners(hq.x, hq.z, STORM.defenceR, hostileMask(world, f))) {
    if (u.hp > 0 && u.owner === city && world.knows(f, u)) v += value(u);
  }
  for (const w of world.forts) {
    if (w.owner !== city || w.hp <= 0 || w.progress < 1 || dist(w.pos, hq) > STORM.defenceR) continue;
    if (w.kind === 'trench') v += STORM.trenchValue;
    else if (w.kind === 'sandbag') v += STORM.sandbagValue;
  }
  return v;
}

/** Our value within `massR` of the capital (every group converging on it counts). */
export function stormMass(world: World, f: number, at: V2): number {
  let v = 0;
  for (const u of world.spatial.query(at.x, at.z, STORM.massR)) {
    if (u.owner === f && u.hp > 0 && !u.fixed && u.def.id !== 'supply_truck') v += value(u);
  }
  return v;
}

/** Storm slots: an arc around the capital itself, facing our side (the line closes on the HQ instead of creeping with the front). */
export function stormRing(world: World, f: number, s: Sector, n: number): V2[] {
  const home = Math.atan2(world.hqPos(f).z - s.targetPos.z, world.hqPos(f).x - s.targetPos.x);
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    const a = home + t * 2 * STORM.stormArc;
    out.push({ x: s.targetPos.x + Math.cos(a) * STORM.stormRingM, z: s.targetPos.z + Math.sin(a) * STORM.stormRingM });
  }
  return out;
}

/** Should a group start a capital siege now (doctrine.chooseOperation)? */
export function wantsCapitalSiege(world: World, f: Faction, s: Sector, units: Unit[], groupValue: number): boolean {
  if (!capitalSiege(s) || s.targetCity === null) return false;
  // A side that dwarfs the defender (≥ EAGER.dwarfPop × its population) rolls over it frontally with
  // spearheads (soak: sieges by a 3–4× richer side waited in form / dig while frontal pushes ended wars).
  const them = world.factions[s.targetCity];
  if (them && f.popPresent >= EAGER.dwarfPop * Math.max(1, them.popPresent)) return false;
  let near = 0;
  for (const u of units) if (dist(u.pos, s.targetPos) < STORM.engageM) near++;
  if (near < units.length * 0.4) return false;
  return capitalDefence(world, f.id, s.targetCity) >= groupValue * STORM.minDefenceShare;
}

/** Point a gun (range `range`) should deploy at to bombard capital `target`: on our side, at `share` × range from the defenders' mass. */
export function bombardPoint(world: World, f: number, target: V2, home: V2, range: number, share: number): V2 {
  let sx = 0;
  let sz = 0;
  let w = 0;
  for (const u of world.spatial.queryOwners(target.x, target.z, STORM.defenceR, hostileMask(world, f))) {
    if (u.hp <= 0 || !world.knows(f, u)) continue;
    const v = u.def.costP + u.def.costM;
    sx += u.pos.x * v;
    sz += u.pos.z * v;
    w += v;
  }
  const c = w > 0 ? { x: sx / w, z: sz / w } : target;
  const d = Math.max(1, dist(c, home));
  const r = Math.min(range * share, d);
  return { x: c.x + ((home.x - c.x) / d) * r, z: c.z + ((home.z - c.z) / d) * r };
}
