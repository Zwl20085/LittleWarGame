import type { GameData } from '../data/types';
import { thinkUnit } from './behavior';
import { majorityBleed, hqCaptured, updateHq, updateObjective } from './capture';
import { personalityWeights, thinkCity } from './cityai';
import { updateProjectiles, updateWeapons } from './combat';
import { AI } from './config';
import { applyIncome, economyRates, nodeBonus, stewardStep } from './economy';
import { FrontlineField } from './frontline';
import { updateMorale } from './morale';
import { updateHeight, updateMovement } from './movement';
import { advanceProduction, normalizedWeights, populationCap, populationOf, scheduleProduction } from './production';
import { initSectors, thinkSectors } from './sectors';
import { supplyTick, type SupplyNode } from './supply';
import { convoySecond } from './convoy';
import { createHighCommand, thinkHighCommand } from './command';
import { buildFrontInfoFor } from './frontai';
import type { Faction, MatchConfig, Unit } from './types';
import { hostileMask } from './spatial';
import { dist } from './vec';
import { FACTION_COLORS, ROMAN, World } from './world';
import { scaledData } from './scale';
import { sampleStats, STATS_SAMPLE_SECONDS } from './stats';
import { battleSecond } from './events';
import { canSpot, observerOf } from './terrainrules';
import type { V2 } from './vec';

export interface Match {
  readonly world: World;
  readonly front: FrontlineField;
  /** Player-observed field for fog mode (null in open mode — use `front`). */
  readonly frontView: FrontlineField | null;
  supplyNodes: SupplyNode[][];
}

function makeFaction(world: World, id: number, isPlayer: boolean): Faction {
  const e = world.data.rules.economy;
  const personalities = world.config.personalities;
  const personality = personalities?.[id] ?? (['balanced', 'armor', 'infantry', 'mechanized', 'artillery'] as const)[id % 5];
  // The player's chosen doctrine sets the starting production mix too (balanced = spec defaults).
  const weights = isPlayer && !personalities?.[id] ? { ...world.data.rules.proposed_defaults.production_unit_weights } : personalityWeights(world, personality);
  return {
    id, color: FACTION_COLORS[id], roman: ROMAN[id], isPlayer, cityIdx: id, personality, difficulty: world.config.difficulty,
    alive: true, eliminatedAt: null, p: e.starting_p, m: e.starting_m,
    alloc: [...e.allocation_default] as [number, number, number], locks: [false, false, false], autoEconomy: true,
    stewardHoldUntil: 0, stewardLastDir: -1, stewardReason: 'steward.default', stewardParams: {},
    resolve: world.data.rules.victory.initial_resolve, popPresent: 0, popReserved: 0, logistics: 0, supplyDemand: 0,
    weights, caps: { ...world.data.rules.proposed_defaults.production_unit_caps }, paused: {}, unitSector: {},
    spent: [], protectedOrder: null, protectRetryAt: 0, nextRaidAt: 240, command: createHighCommand(), depot: 0, lastWorksAt: -999, orders: [], manualQueue: [], sectors: [], mainSector: 1,
    incomeP: 0, incomeM: 0, overflowWarnAt: -1e9, hqProgress: {}, lostUnits: 0, producedUnits: 0,
    spentTotalP: 0, spentTotalM: 0, aiThinkAt: id * 0.7, trucksUnderFire: [],
  };
}

/** Create a match: factions, sectors, free initial units and fixed strongpoints (§3.3, §5.2). */
export function createMatch(baseData: GameData, config: MatchConfig): Match {
  const data = scaledData(baseData, config.armyScale ?? baseData.rules.proposed_defaults.army_scale ?? 1);
  const world = new World(data, config);
  const n = world.hostile.length;
  for (let i = 0; i < n; i++) world.factions.push(makeFaction(world, i, !config.spectate && i === config.playerSlot));
  for (const f of world.factions) {
    initSectors(world, f);
    const city = world.cityOf(f.id);
    const init = world.data.rules.economy.initial_units;
    const fwd = (city.forwardDeg * Math.PI) / 180;
    // Initial forces deploy as lines facing the enemy around the map-defined points (§3.3).
    const line = (center: V2, count: number, spacing: number, unitId: string, sector: (k: number) => number): void => {
      const perRow = Math.max(1, Math.min(count, 8));
      for (let k = 0; k < count; k++) {
        const col = (k % perRow) - (perRow - 1) / 2;
        const row = Math.floor(k / perRow);
        const side = col * spacing;
        const back = -row * spacing * 0.9;
        const p = { x: center.x + Math.cos(fwd) * back - Math.sin(fwd) * side, z: center.z + Math.sin(fwd) * back + Math.cos(fwd) * side };
        // Never deploy into a pocket cut off from the capital (a plateau above the slope limit).
        const nav = world.nav(false, 35);
        let safe = nav.nearestPassable(p, 60) ?? center;
        if (!nav.connected(safe, city.exit)) safe = nav.nearestPassable(center, 60) ?? city.exit;
        world.spawnUnit(f.id, unitId, safe, sector(k)).behavior = 'advance';
      }
    };
    const inf = init.infantry ?? 3;
    city.vanguard.forEach((p, k) => line(p, Math.ceil(inf / city.vanguard.length), 18, 'infantry', () => k));
    line(city.recon, init.recon ?? 1, 26, 'recon', (k) => k % 3);
    line(city.truck, init.supply_truck ?? 1, 20, 'supply_truck', (k) => k % 3);
    for (const sp of city.strongpoints) world.spawnUnit(f.id, 'mg', sp.pos, f.mainSector, { fixed: true, facingDeg: sp.facingDeg });
  }
  // Starting territory: settlements near each capital (and closer to it than to any other).
  const initR = data.rules.territory?.initial_radius_m ?? 0;
  for (const o of world.objectives) {
    if (!o.kind || o.kind === 'point') continue;
    let best = -1;
    let bd = Infinity;
    for (const f of world.factions) {
      const d = dist(world.hqPos(f.id), o.pos);
      if (d < bd) { bd = d; best = f.id; }
    }
    if (best >= 0 && bd < initR) o.owner = best;
  }
  for (const u of world.units.values()) updateHeight(world, u);
  world.spatial.rebuild(world.aliveUnits);
  const front = new FrontlineField(world, null);
  const frontView = config.infoMode === 'fog' && !config.spectate ? new FrontlineField(world, config.playerSlot) : null;
  const match: Match = { world, front, frontView, supplyNodes: world.factions.map(() => []) };
  updateVisibility(world);
  return match;
}

/** Line-of-sight visibility per faction (also used in open mode for spotting/artillery). */
export function updateVisibility(world: World): void {
  const mem = world.data.rules.information.enemy_memory_seconds * world.tickHz;
  // Bucket observers by owner once (same per-faction order as iterating world.units each time).
  const byOwner: Unit[][] = world.factions.map(() => []);
  for (const u of world.units.values()) if (u.hp > 0) byOwner[u.owner]?.push(u);
  const near: Unit[] = [];
  for (const f of world.factions) {
    const vis = world.visibleTo[f.id];
    vis.clear();
    if (!f.alive) continue;
    // Only hostile units can be added, so the query skips cells holding friendly units only.
    const foes = hostileMask(world, f.id);
    for (const u of byOwner[f.id]) {
      // Height bonus, tower/church perches, forest concealment, window sight (terrainrules.ts).
      const o = observerOf(world, u);
      for (const t of world.spatial.queryOwners(u.pos.x, u.pos.z, o.r, foes, near)) {
        if (t.hp <= 0 || vis.has(t.id) || !world.isHostile(f.id, t.owner)) continue;
        if (canSpot(world, u, o, t)) vis.add(t.id);
      }
    }
    // Owned observation points add an observer with 180 m radius.
    for (const o of world.objectives) {
      if (o.owner !== f.id || o.type !== 'observation') continue;
      const y = world.terrain.heightAt(o.pos.x, o.pos.z) + 6;
      for (const t of world.spatial.query(o.pos.x, o.pos.z, 180)) {
        if (t.hp > 0 && world.isHostile(f.id, t.owner) && world.terrain.los(o.pos.x, y, o.pos.z, t.pos.x, t.y + 1.2, t.pos.z)) vis.add(t.id);
      }
    }
    const seen = world.lastSeen[f.id];
    for (const id of vis) {
      const t = world.units.get(id);
      if (t) seen.set(id, { tick: world.tick, pos: { ...t.pos } });
    }
    for (const [id, s] of seen) if (world.tick - s.tick > mem || !world.unitAlive(id)) seen.delete(id);
  }
}

function forecastNeeds(world: World, f: Faction): { p: number; m: number } {
  const w = normalizedWeights(world, f);
  let p = 0;
  let m = 0;
  const byFac = new Map<string, { w: number; p: number; m: number; t: number }>();
  for (const [id, wt] of w) {
    const d = world.data.units.get(id)!;
    const acc = byFac.get(d.facility) ?? { w: 0, p: 0, m: 0, t: 0 };
    acc.w += wt;
    acc.p += wt * d.costP;
    acc.m += wt * d.costM;
    acc.t += wt * d.buildSeconds;
    byFac.set(d.facility, acc);
  }
  for (const [fac, a] of byFac) {
    if (a.w <= 0) continue;
    const slots = world.data.rules.economy.facilities[fac] ?? 1;
    const perMin = (60 / (a.t / a.w)) * slots;
    p += perMin * (a.p / a.w);
    m += perMin * (a.m / a.w);
  }
  return { p, m };
}

/** Once per game second: income, steward, production, supply ammo, capture, morale. */
function economySecond(match: Match): void {
  const world = match.world;
  const rules = world.data.rules;
  for (const f of world.factions) {
    if (!f.alive) continue;
    let man = 0;
    let ind = 0;
    for (const o of world.objectives) {
      if (o.owner !== f.id || o.contested || world.time < o.activeAt) continue;
      if (!inSupply(match, f.id, o.pos)) continue;
      if (o.type === 'manpower') man++;
      else if (o.type === 'industry') ind++;
    }
    const terr = rules.territory;
    let bonus = nodeBonus(man, ind, rules);
    let cityShare = 1;
    if (terr && world.map.objectives.some((o) => o.kind)) {
      // Territory economy: every held, uncontested, connected settlement adds income.
      const k = (rules.proposed_defaults.army_scale ?? 1) * (rules.proposed_defaults.army_scale_income_factor ?? 1);
      let p = 0;
      let m = 0;
      for (const o of world.objectives) {
        if (o.owner !== f.id || o.contested || world.time < o.activeAt || !inSupply(match, f.id, o.pos)) continue;
        p += (terr.income_p_per_min[o.kind] ?? 0) * k;
        m += (terr.income_m_per_min[o.kind] ?? 0) * k;
      }
      // The economy sliders steer all territory, not just the capital: mobilisation scales
      // recruits (P), industry scales munitions (M); the default split is neutral (×1).
      const def = rules.economy.allocation_default;
      p *= Math.max(0.4, 0.55 + 0.45 * (f.alloc[0] / (def[0] || 1)));
      m *= Math.max(0.4, 0.55 + 0.45 * (f.alloc[1] / (def[1] || 1)));
      bonus = { p, m };
      cityShare = terr.capital_income_share;
    }
    const rates = economyRates(f.alloc, rules, bonus.p, bonus.m, cityShare);
    f.incomeP = rates.pPerMin;
    f.incomeM = rates.mPerMin;
    f.logistics = rates.logistics;
    if (applyIncome(f, rates, 1, rules) && world.time - f.overflowWarnAt > 60) {
      f.overflowWarnAt = world.time;
      world.note(f.id, 'log.overflow', {}, 'info');
    }
    const pop = populationOf(world, f);
    f.popPresent = pop.present;
    f.popReserved = pop.reserved;
    if (world.tick % (5 * world.tickHz) === 0 && f.autoEconomy) {
      const need = forecastNeeds(world, f);
      const out = stewardStep(f, {
        needP60: need.p, needM60: need.m, incomeP60: rates.pPerMin, incomeM60: rates.mPerMin,
        forecastDemand: f.supplyDemand * 1.1, logistics: rates.logistics, now: world.time,
      }, rules);
      if (out.changed) {
        const names = ['P', 'I', 'L'];
        f.stewardReason = `steward.shift${names[out.to]}`;
        f.stewardParams = { to: Math.round(out.alloc[out.to] * 100), from: names[out.from] };
      }
    }
    scheduleProduction(world, f);
    advanceProduction(world, f, 1);
    convoySecond(world, f);
  }
  for (const u of world.units.values()) {
    if (u.hp <= 0) continue;
    supplyTick(world, u, 1);
  }
  for (const o of world.objectives) updateObjective(world, o, 1);
  for (const f of world.factions) updateHq(world, f, 1);
  majorityBleed(world, 1);
  // Territorial collapse: a faction holding no settlements at all bleeds resolve (can't turtle forever).
  const collapse = rules.territory?.collapse_bleed_per_second;
  if (collapse && rules.victory.resolve_enabled && world.map.objectives.some((o) => o.kind)) {
    const k = rules.proposed_defaults.army_scale ?? 1;
    for (const f of world.factions) {
      if (f.alive && !world.objectives.some((o) => o.owner === f.id)) f.resolve = Math.max(0, f.resolve - collapse * k);
    }
  }
}

/** A node pays only if it is inside our own ground control (or next to the city) — a cut-off point earns nothing. */
function inSupply(match: Match, f: number, p: { x: number; z: number }): boolean {
  return match.front.ownerAt(p) === f || dist(p, match.world.hqPos(f)) <= match.world.data.rules.supply.city_local_radius_m;
}

/** Convoy chains for display: each truck links back to its depot or forward to its supply point. */
function convoyNodes(world: World, f: number): SupplyNode[] {
  const depot = world.cityOf(f).exit;
  const out: SupplyNode[] = [{ pos: depot, radius: world.data.rules.supply.city_local_radius_m, parent: null, cut: false }];
  for (const t of world.units.values()) {
    if (t.owner !== f || t.def.id !== 'supply_truck' || t.hp <= 0) continue;
    const parent = t.truckState === 'out' && t.truckDest ? t.truckDest : depot;
    out.push({ pos: { ...t.pos }, radius: t.truckState === 'unload' ? 190 : 0, parent, cut: t.truckState === 'return' && t.cargo > 1 });
  }
  return out;
}

function checkElimination(match: Match): void {
  const world = match.world;
  const out: Faction[] = [];
  // Defeat = the capital falls (resolve only counts in the optional resolve mode). A war ends
  // only when one side has taken every enemy capital (user decision: no time or territory rule).
  const resolveOn = !!world.data.rules.victory.resolve_enabled;
  for (const f of world.factions) if (f.alive && ((resolveOn && f.resolve <= 0) || hqCaptured(world, f))) out.push(f);
  // Collect all first, then apply (order-independent, F02).
  for (const f of out) {
    f.alive = false;
    f.eliminatedAt = world.time;
    f.orders = [];
    f.manualQueue = [];
    for (const u of world.units.values()) {
      if (u.owner !== f.id || u.hp <= 0) continue;
      u.behavior = 'evacuate';
      u.evacuateAt = world.time + world.data.rules.victory.eliminated_evacuation_seconds;
      u.manual = null;
    }
    for (const o of world.objectives) if (o.owner === f.id) o.owner = -1;
    for (const other of world.factions) delete other.hqProgress[f.id];
    for (const g of world.factions) world.note(g.id, 'log.eliminated', { f: f.id, reason: resolveOn && f.resolve <= 0 ? 'resolve' : 'hq' }, 'alert');
  }
  const alive = world.factions.filter((f) => f.alive);
  if (!world.result && alive.length <= 1 && out.length > 0) {
    world.result = alive.length === 1
      ? { winners: [alive[0].id], reason: 'last_standing', tick: world.tick }
      : { winners: out.map((f) => f.id), reason: 'mutual', tick: world.tick };
  }
}

/** One fixed simulation tick (AGENT_HANDOFF §5 order). */
export function step(match: Match): void {
  const world = match.world;
  if (world.result) return;
  const hz = world.tickHz;
  const units = world.aliveUnits;
  world.spatial.rebuild(units);
  // City + sector AI at their own cadence.
  for (const f of world.factions) {
    if (!f.alive) continue;
    const cityEvery = f.difficulty === 'easy' ? 30 : f.difficulty === 'hard' ? 12 : AI.cityThinkSeconds;
    if (world.time >= f.aiThinkAt) {
      thinkCity(world, f);
      f.aiThinkAt = world.time + cityEvery;
    }
    thinkHighCommand(world, f);
    if (world.tick % Math.round(AI.sectorThinkSeconds * hz) === f.id % (AI.sectorThinkSeconds * hz)) thinkSectors(world, f);
  }
  // Unit executor, staggered.
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.hp <= 0) continue;
    if (u.behavior === 'evacuate' && world.time >= u.evacuateAt) {
      u.hp = 0;
      continue;
    }
    if (world.time >= u.thinkAt) {
      thinkUnit(world, u);
      const slow = u.def.id === 'howitzer' || u.def.id === 'mortar' ? 1 : 0.4;
      u.thinkAt = world.time + slow + ((u.id * 7) % 10) / 50;
    }
  }
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.hp <= 0) continue;
    updateMorale(world, u, world.dt);
    updateMovement(world, u);
    updateHeight(world, u);
  }
  if (world.tick % Math.round(hz / 2) === 0) updateVisibility(world);
  if (world.tick % (2 * hz) === 0) {
    match.supplyNodes = world.factions.map((f) => (f.alive ? convoyNodes(world, f.id) : []));
  }
  for (let i = 0; i < units.length; i++) updateWeapons(world, units[i]);
  for (const apply of world.deferred) apply();
  world.deferred.length = 0;
  updateProjectiles(world);
  world.removeDead();
  if (world.tick % hz === 0) {
    economySecond(match);
    battleSecond(world);
  }
  // Front field every 2 s, then one faction's front info per tick: the ~10 ms burst of doing
  // it all at once stalled frames at high game speed. Scheduled just before the groups think
  // (sector AI of faction f runs at tick ≡ f mod 2 s), so they read fresh information.
  const frontPeriod = 2 * hz;
  const phase = world.tick % frontPeriod;
  const frontAt = frontPeriod - world.factions.length - 1;
  if (phase === frontAt) {
    match.front.update(2);
    match.frontView?.update(2);
  } else if (phase > frontAt) {
    const f = phase - frontAt - 1;
    // An eliminated faction's units only evacuate: its front info is never read again.
    if (f < world.factions.length && world.factions[f].alive) world.frontInfo[f] = buildFrontInfoFor(world, match.front, f);
  }
  if (world.tick % (STATS_SAMPLE_SECONDS * hz) === 0) {
    sampleStats(world.stats, world.time, world.units.values(), world.factions, (f) => ({ popCap: populationCap(world, f), held: world.objectives.filter((o) => o.owner === f.id).length }));
  }
  // Destroyed works (hp 0) are dropped every 10 s so per-unit scans stay short in long wars, and
  // works whose occupant died outside the damage path (evacuation, elimination) are freed.
  if (world.tick % (10 * hz) === 0) {
    for (let i = world.forts.length - 1; i >= 0; i--) {
      const f = world.forts[i];
      if (f.hp <= 0 && f.kind !== 'pontoon') world.forts.splice(i, 1);
      else if (f.occupant !== null && !world.unitAlive(f.occupant)) f.occupant = null;
    }
  }
  checkElimination(match);
  world.tick++;
}
