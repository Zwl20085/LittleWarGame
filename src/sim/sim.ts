import type { GameData } from '../data/types';
import { updateAir } from './air';
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
import { buildFrontInfo } from './frontai';
import type { Faction, MatchConfig, Unit } from './types';
import { hostileMask } from './spatial';
import { dist } from './vec';
import { FACTION_COLORS, ROMAN, World } from './world';
import { scaledData } from './scale';
import { sampleStats, STATS_SAMPLE_SECONDS } from './stats';
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
  const personality = personalities?.[id] ?? (['balanced', 'armor', 'infantry', 'artillery'] as const)[id % 4];
  const weights = isPlayer ? { ...world.data.rules.proposed_defaults.production_unit_weights } : personalityWeights(world, personality);
  return {
    id, color: FACTION_COLORS[id], roman: ROMAN[id], isPlayer, cityIdx: id, personality, difficulty: world.config.difficulty,
    alive: true, eliminatedAt: null, p: e.starting_p, m: e.starting_m,
    alloc: [...e.allocation_default] as [number, number, number], locks: [false, false, false], autoEconomy: true,
    stewardHoldUntil: 0, stewardLastDir: -1, stewardReason: 'steward.default', stewardParams: {},
    resolve: world.data.rules.victory.initial_resolve, popPresent: 0, popReserved: 0, logistics: 0, supplyDemand: 0,
    weights, caps: { ...world.data.rules.proposed_defaults.production_unit_caps }, paused: {}, unitSector: {},
    spent: [], protectedOrder: null, protectRetryAt: 0, nextRaidAt: 240, command: createHighCommand(), depot: 0, lastWorksAt: -999, orders: [], manualQueue: [], sectors: [], mainSector: 1,
    air: { missionId: null, phase: 'idle', timer: 0, target: null, paidM: 0, planeId: null, autoBudgetSpent: 0 },
    incomeP: 0, incomeM: 0, overflowWarnAt: -1e9, hqProgress: {}, lostUnits: 0, producedUnits: 0,
    spentTotalP: 0, spentTotalM: 0, aiThinkAt: id * 0.7,
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
        const safe = world.nav(false, 35).nearestPassable(p, 60) ?? center;
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
  world.spatial.rebuild(world.units.values());
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
      const elev = Math.min(0.15, Math.max(0, (u.y - 10) / 10) * 0.03);
      const r = u.def.vision * (1 + elev);
      for (const t of world.spatial.queryOwners(u.pos.x, u.pos.z, r, foes, near)) {
        if (t.hp <= 0 || vis.has(t.id) || !world.isHostile(f.id, t.owner)) continue;
        if (world.terrain.los(u.pos.x, u.y + 1.8, u.pos.z, t.pos.x, t.y + 1.2, t.pos.z)) vis.add(t.id);
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
    for (const p of world.planes) {
      if (p.owner !== f.id || world.time > p.visionUntil) continue;
      for (const t of world.spatial.query(p.pos.x, p.pos.z, 110)) if (t.hp > 0 && world.isHostile(f.id, t.owner)) vis.add(t.id);
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
  // Defeat = the capital falls (resolve only counts in the optional resolve mode).
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
  const limit = world.data.rules.proposed_defaults.match_seconds_limit;
  if (!world.result && limit > 0 && world.time >= limit) {
    const score = (f: Faction): number[] => [
      f.resolve,
      world.objectives.filter((o) => o.owner === f.id && !o.contested).length,
      [...world.units.values()].filter((u) => u.owner === f.id && u.hp > 0 && !u.fixed).reduce((s, u) => s + (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp), 0),
    ];
    const ranked = alive.map((f) => ({ f, s: score(f) }));
    ranked.sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || b.s[2] - a.s[2]);
    const top = ranked[0].s;
    world.result = { winners: ranked.filter((r) => r.s.every((v, i) => Math.abs(v - top[i]) < 1e-6)).map((r) => r.f.id), reason: 'timeout', tick: world.tick };
  }
}

/** One fixed simulation tick (AGENT_HANDOFF §5 order). */
export function step(match: Match): void {
  const world = match.world;
  if (world.result) return;
  const hz = world.tickHz;
  world.spatial.rebuild(world.units.values());
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
  for (const u of world.units.values()) {
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
  for (const u of world.units.values()) {
    if (u.hp <= 0) continue;
    updateMorale(world, u, world.dt);
    updateMovement(world, u);
    updateHeight(world, u);
  }
  if (world.tick % Math.round(hz / 2) === 0) updateVisibility(world);
  if (world.tick % (2 * hz) === 0) {
    match.supplyNodes = world.factions.map((f) => (f.alive ? convoyNodes(world, f.id) : []));
  }
  for (const u of world.units.values()) updateWeapons(world, u);
  for (const apply of world.deferred) apply();
  world.deferred.length = 0;
  updateAir(world);
  updateProjectiles(world);
  world.removeDead();
  if (world.tick % hz === 0) {
    economySecond(match);
    if (world.tick % (2 * hz) === 0) {
      match.front.update(2);
      match.frontView?.update(2);
      world.frontInfo = buildFrontInfo(world, match.front);
    }
  }
  if (world.tick % (STATS_SAMPLE_SECONDS * hz) === 0) {
    sampleStats(world.stats, world.time, world.units.values(), world.factions, (f) => ({ popCap: populationCap(world, f), held: world.objectives.filter((o) => o.owner === f.id).length }));
  }
  checkElimination(match);
  world.tick++;
}
