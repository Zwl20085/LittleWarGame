// Read-only 2.2 war probe (strategy wave 2): armour clustering, economic raids / investment, and
// supply tightness. It never writes world state, so a probed match is the same match as an
// unprobed one. Used by scripts/lab/war22.ts (per-seed child processes, frozen-source A/B).
import type { Faction, Unit } from '../../src/sim/types';
import type { World } from '../../src/sim/world';

const TANKS = new Set(['light_tank', 'medium_tank', 'heavy_tank']);
const isTank = (u: Unit): boolean => TANKS.has(u.def.id) && !u.fixed;
/** Two tanks within this distance are one cluster (and a tank with none is "alone"). */
export const LINK_M = 80;

interface TankMemo { owner: number; x: number; z: number; alone: boolean; foot: boolean; attacking: boolean; front: number }
interface Episode { f: number; front: number; obj: string; start: number; last: number; tanks: number; led: boolean; foot: number }

export interface WarProbe {
  // armour
  clusterSum: number; clusterN: number; engagedClusterSum: number; engagedClusterN: number;
  attackTankSamples: number; attackTankInGroup3: number;
  tankDeaths: number; tankDeathsAlone: number; tankDeathsAloneNoFoot: number; tankDeathsAttacking: number;
  episodes: { tanks: boolean; led: boolean; ok: boolean }[];
  // economy war
  econDestroyed: { by: number; victim: number; raid: boolean; kind: string }[];
  raidUnits: number; raidDeaths: number; raidValueLost: number; raidValueSent: number;
  econRaidUnits: number; econRaidDeaths: number; econRaidValueLost: number;
  econIncomeSum: number[]; incomeSum: number[];
  // supply
  supply: { t: number; f: number; stockRatio: number; frontStockRatio: number; frontPlaces: number; lowMain: number; mainN: number; lowFight: number; fightN: number; rearm: number; logi: number; allocL: number; lowPush: number; pushN: number; truckLoss60: number }[];
  trucks: Map<number, number>; truckDeaths: number[]; truckDeathAt: number[][];
  // war progress
  captures: number; capturesByMinute: number[];
  // per-tick memo (not reported)
  memo: Map<number, TankMemo>; raidMemo: Map<number, number>; econMemo: Map<number, number>; econRuined: Set<number>; open: Map<string, Episode>; owners: Map<string, number>;
}

export function createWarProbe(w: World): WarProbe {
  return {
    clusterSum: 0, clusterN: 0, engagedClusterSum: 0, engagedClusterN: 0, attackTankSamples: 0, attackTankInGroup3: 0,
    tankDeaths: 0, tankDeathsAlone: 0, tankDeathsAloneNoFoot: 0, tankDeathsAttacking: 0, episodes: [],
    econDestroyed: [], raidUnits: 0, raidDeaths: 0, raidValueLost: 0, raidValueSent: 0, econRaidUnits: 0, econRaidDeaths: 0, econRaidValueLost: 0,
    econIncomeSum: w.factions.map(() => 0), incomeSum: w.factions.map(() => 0),
    supply: [], captures: 0, capturesByMinute: [], trucks: new Map(), truckDeaths: w.factions.map(() => 0), truckDeathAt: w.factions.map(() => []),
    memo: new Map(), raidMemo: new Map(), econMemo: new Map(), econRuined: new Set(w.econ.filter((b) => b.ruined).map((b) => b.id)), open: new Map(),
    owners: new Map(w.objectives.map((o) => [o.id, o.owner])),
  };
}

const d2 = (a: { x: number; z: number }, b: { x: number; z: number }): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const value = (u: Unit): number => u.def.costP + u.def.costM;

function attacking(f: Faction, u: Unit): boolean {
  if (u.spearhead) return true;
  const s = f.fronts.find((x) => x.id === u.frontId);
  return !!s && (s.mode === 'push' || s.mode === 'breakthrough') && u.behavior === 'advance';
}

/** Once per game second. */
export function warSecond(w: World, p: WarProbe): void {
  const tanks: Unit[] = [];
  const foot: Unit[] = [];
  for (const u of w.units.values()) {
    if (u.hp <= 0) continue;
    if (isTank(u)) tanks.push(u);
    else if (u.def.kind === 'infantry' && !u.fixed) foot.push(u);
  }
  // Cluster components (single linkage, LINK_M) per owner.
  const comp = new Map<number, number>();
  const size = new Map<number, number>();
  const L2 = LINK_M * LINK_M;
  for (const u of tanks) {
    if (comp.has(u.id)) continue;
    const stack = [u];
    comp.set(u.id, u.id);
    let n = 0;
    while (stack.length) {
      const a = stack.pop()!;
      n++;
      for (const b of tanks) if (!comp.has(b.id) && b.owner === a.owner && d2(a.pos, b.pos) <= L2) { comp.set(b.id, u.id); stack.push(b); }
    }
    size.set(u.id, n);
  }
  const seen = new Set<number>();
  for (const u of tanks) {
    seen.add(u.id);
    const f = w.factions[u.owner];
    const n = size.get(comp.get(u.id)!) ?? 1;
    const att = attacking(f, u);
    const engaged = w.time - u.lastFiredAt < 5;
    if (att) { p.clusterSum += n; p.clusterN++; p.attackTankSamples++; if (n >= 3) p.attackTankInGroup3++; }
    if (engaged) { p.engagedClusterSum += n; p.engagedClusterN++; }
    let footNear = false;
    for (const i of foot) if (i.owner === u.owner && d2(i.pos, u.pos) <= 60 * 60) { footNear = true; break; }
    p.memo.set(u.id, { owner: u.owner, x: u.pos.x, z: u.pos.z, alone: n <= 1, foot: footNear, attacking: att || engaged, front: u.frontId });
  }
  for (const [id, m] of p.memo) {
    if (seen.has(id)) continue;
    p.memo.delete(id);
    const u = w.units.get(id);
    if (u && u.hp > 0) continue;
    p.tankDeaths++;
    if (m.alone) p.tankDeathsAlone++;
    if (m.alone && !m.foot) p.tankDeathsAloneNoFoot++;
    if (m.attacking) p.tankDeathsAttacking++;
  }
  // Raid parties (opRole 'raid'): units sent and lost while raiding.
  for (const u of w.units.values()) {
    if (u.hp > 0 && u.opRole === 'raid' && !p.raidMemo.has(u.id)) { p.raidMemo.set(u.id, value(u)); p.raidUnits++; p.raidValueSent += value(u); }
  }
  for (const [id, v] of p.raidMemo) {
    const u = w.units.get(id);
    if (u && u.hp > 0 && u.opRole === 'raid') continue;
    p.raidMemo.delete(id);
    if (!u || u.hp <= 0) { p.raidDeaths++; p.raidValueLost += v; }
  }
  for (const u of w.units.values()) {
    if (u.hp > 0 && u.opRole === 'raid' && u.opObjective?.startsWith('econ:') && !p.econMemo.has(u.id)) { p.econMemo.set(u.id, value(u)); p.econRaidUnits++; }
  }
  for (const [id, v] of p.econMemo) {
    const u = w.units.get(id);
    if (u && u.hp > 0 && u.opRole === 'raid') continue;
    p.econMemo.delete(id);
    if (!u || u.hp <= 0) { p.econRaidDeaths++; p.econRaidValueLost += v; }
  }
  // Economic buildings destroyed: by whom (hostile units within 45 m), raiders or not.
  for (const b of w.econ) {
    if (!b.ruined || p.econRuined.has(b.id)) continue;
    p.econRuined.add(b.id);
    let by = -1;
    let raid = false;
    for (const u of w.units.values()) {
      if (u.hp <= 0 || u.owner === b.owner || d2(u.pos, b.pos) > 45 * 45) continue;
      by = u.owner;
      if (u.opRole === 'raid' || u.opRole === 'infiltrate') { raid = true; break; }
    }
    p.econDestroyed.push({ by, victim: b.owner, raid, kind: b.kind });
  }
  for (const b of w.econ) if (!b.ruined) p.econRuined.delete(b.id);
  for (const f of w.factions) {
    if (!f.alive) continue;
    p.econIncomeSum[f.id] += (f.econP + f.econM) / 60;
    p.incomeSum[f.id] += (f.incomeP + f.incomeM) / 60;
  }
  // Supply trucks lost.
  for (const u of w.units.values()) if (u.hp > 0 && u.def.id === 'supply_truck') p.trucks.set(u.id, u.owner);
  for (const [id, owner] of p.trucks) {
    const u = w.units.get(id);
    if (u && u.hp > 0) continue;
    p.trucks.delete(id);
    p.truckDeaths[owner]++;
    p.truckDeathAt[owner].push(w.time);
  }
  // Captures (territory swings).
  for (const o of w.objectives) {
    const prev = p.owners.get(o.id);
    if (prev !== o.owner) {
      p.owners.set(o.id, o.owner);
      if (o.owner >= 0) { p.captures++; const m = Math.floor(w.time / 60); p.capturesByMinute[m] = (p.capturesByMinute[m] ?? 0) + 1; }
    }
  }
  if (Math.round(w.time) % 2 === 0) episodes(w, p, tanks, foot);
  if (Math.round(w.time) % 30 === 0) supplySample(w, p);
}

/** Front attack episodes on a place: did tanks take part / lead, and did the place fall? */
function episodes(w: World, p: WarProbe, tanks: Unit[], foot: Unit[]): void {
  for (const f of w.factions) {
    if (!f.alive) continue;
    for (const s of f.fronts) {
      const obj = s.targetObjective ? w.objectives.find((o) => o.id === s.targetObjective) : null;
      if (!obj || obj.owner === f.id || s.mode !== 'push') continue;
      const key = `${f.id}:${s.id}:${obj.id}`;
      let e = p.open.get(key);
      if (!e) { e = { f: f.id, front: s.id, obj: obj.id, start: w.time, last: w.time, tanks: 0, led: false, foot: 0 }; p.open.set(key, e); }
      e.last = w.time;
      // Tanks and foot of this front within 450 m of the objective.
      let tn = 0, tx = 0, tz = 0, fn = 0, fx = 0, fz = 0;
      for (const u of tanks) if (u.owner === f.id && u.frontId === s.id && d2(u.pos, obj.pos) < 450 * 450) { tn++; tx += u.pos.x; tz += u.pos.z; }
      for (const u of foot) if (u.owner === f.id && u.frontId === s.id && d2(u.pos, obj.pos) < 450 * 450) { fn++; fx += u.pos.x; fz += u.pos.z; }
      e.tanks = Math.max(e.tanks, tn);
      e.foot = Math.max(e.foot, fn);
      if (tn > 0 && fn > 0 && d2({ x: tx / tn, z: tz / tn }, obj.pos) < d2({ x: fx / fn, z: fz / fn }, obj.pos)) e.led = true;
    }
  }
  for (const [key, e] of p.open) {
    const obj = w.objectives.find((o) => o.id === e.obj)!;
    const ok = obj.owner === e.f;
    if (ok || w.time - e.last > 120 || w.time - e.start > 600 || !w.factions[e.f].alive) {
      p.open.delete(key);
      if (e.tanks > 0 || e.foot > 0) p.episodes.push({ tanks: e.tanks > 0, led: e.led, ok });
    }
  }
}

function supplySample(w: World, p: WarProbe): void {
  const placeOwner = (pl: World['places'][number]): number => (pl.capitalOf >= 0 ? (w.factions[pl.capitalOf]?.alive ? pl.capitalOf : -1) : w.objectives[pl.objIdx]?.owner ?? -1);
  for (const f of w.factions) {
    if (!f.alive) continue;
    let stock = 0, cap = 0, fs = 0, fc = 0, fpn = 0;
    const capOf = (pl: World['places'][number]): number => {
      const k = w.data.rules.proposed_defaults.army_scale ?? 1;
      let c = (w.data.rules.logistics?.stock_cap_k[pl.kind] ?? 0) * k;
      const dep = w.data.rules.econ?.buildings.depot;
      for (const b of w.econ) if (b.placeId === pl.id && b.kind === 'depot' && !b.ruined && b.progress >= 1) c += (dep?.stock_cap_k ?? 0) * k * (b.hp / b.maxHp);
      return c;
    };
    for (const pl of w.places) {
      if (placeOwner(pl) !== f.id) continue;
      const c = capOf(pl);
      stock += pl.stock;
      cap += c;
      // Front place: a hostile combat unit within 700 m.
      let front = false;
      for (const u of w.spatial.query(pl.pos.x, pl.pos.z, 700)) if (u.hp > 0 && u.primary && w.isHostile(f.id, u.owner) && u.def.id !== 'supply_truck') { front = true; break; }
      if (front && pl.capitalOf < 0) { fs += pl.stock; fc += c; fpn++; }
    }
    let lowMain = 0, mainN = 0, lowFight = 0, fightN = 0, rearm = 0, n = 0, lowPush = 0, pushN = 0;
    const pushing = new Set(f.fronts.filter((s) => s.mode === 'push' || s.mode === 'breakthrough').map((s) => s.id));
    for (const u of w.units.values()) {
      if (u.owner !== f.id || u.hp <= 0 || u.fixed || !u.primary || u.def.id === 'supply_truck' || u.def.id === 'commander') continue;
      n++;
      if (u.rearming) rearm++;
      if (u.frontId === f.mainFront) { mainN++; if (u.ammo < 0.3) lowMain++; }
      if (u.frontId === f.mainFront && pushing.has(u.frontId)) { pushN++; if (u.ammo < 0.3) lowPush++; }
      if (w.time - u.lastFiredAt < 15) { fightN++; if (u.ammo < 0.3) lowFight++; }
    }
    p.supply.push({ t: w.time, f: f.id, stockRatio: cap > 0 ? stock / cap : 0, frontStockRatio: fc > 0 ? fs / fc : -1, frontPlaces: fpn, lowMain, mainN, lowFight, fightN, rearm: n ? rearm / n : 0, logi: f.logistics, allocL: f.alloc[2], lowPush, pushN, truckLoss60: p.truckDeathAt[f.id].filter((t) => w.time - t < 90).length });
  }
}

/** Finished-run summary (plain JSON). */
export function warSummary(w: World, p: WarProbe): Record<string, unknown> {
  const invested = w.factions.map((f) => f.econInvested);
  const spent = w.factions.map((f) => f.spentTotalP + f.spentTotalM);
  return {
    time: w.time, result: w.result ? { winners: w.result.winners, minute: w.result.tick / w.tickHz / 60 } : null,
    alive: w.factions.map((f) => f.alive),
    clusterSum: p.clusterSum, clusterN: p.clusterN, engagedClusterSum: p.engagedClusterSum, engagedClusterN: p.engagedClusterN,
    attackTankSamples: p.attackTankSamples, attackTankInGroup3: p.attackTankInGroup3,
    tankDeaths: p.tankDeaths, tankDeathsAlone: p.tankDeathsAlone, tankDeathsAloneNoFoot: p.tankDeathsAloneNoFoot, tankDeathsAttacking: p.tankDeathsAttacking,
    episodes: p.episodes, econDestroyed: p.econDestroyed,
    econRaidUnits: p.econRaidUnits, econRaidDeaths: p.econRaidDeaths, econRaidValueLost: p.econRaidValueLost,
    raidUnits: p.raidUnits, raidDeaths: p.raidDeaths, raidValueLost: p.raidValueLost, raidValueSent: p.raidValueSent,
    invested, spent, econIncomeSum: p.econIncomeSum, incomeSum: p.incomeSum,
    econBuilt: w.factions.map((f) => w.econ.filter((b) => b.owner === f.id && !b.ruined && b.progress >= 1).length),
    truckDeaths: p.truckDeaths, supply: p.supply, captures: p.captures, capturesByMinute: p.capturesByMinute,
    held: w.factions.map((f) => w.objectives.filter((o) => o.owner === f.id && o.kind !== 'point').length),
  };
}
