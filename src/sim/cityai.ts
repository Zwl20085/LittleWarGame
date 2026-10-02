import { missionDef, requestAir } from './air';
import { availableM, populationCap, populationOf } from './production';
import type { Faction, Personality, Unit } from './types';
import { hostileMask } from './spatial';
import type { World } from './world';

const PERSONALITY_MUL: Record<Personality, Record<string, number>> = {
  balanced: {},
  armor: { light_tank: 1.5, medium_tank: 1.7, heavy_tank: 1.7, infantry: 0.8, supply_truck: 1.5 },
  infantry: { infantry: 1.25, mg: 1.6, engineer: 1.8, mortar: 1.3, light_tank: 0.7, medium_tank: 0.7 },
  artillery: { mortar: 1.6, howitzer: 2, recon: 1.5, aa: 1.3, heavy_tank: 0.7 },
};

export function personalityWeights(world: World, p: Personality): Record<string, number> {
  const base = world.data.rules.proposed_defaults.production_unit_weights;
  const mul = PERSONALITY_MUL[p];
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(base)) out[k] = Math.round(v * (mul[k] ?? 1) * 10) / 10;
  return out;
}

function knownEnemyMix(world: World, f: number): { armor: number; total: number } {
  let armor = 0;
  let total = 0;
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.fixed || !world.isHostile(f, u.owner) || !world.knows(f, u)) continue;
    total++;
    if (u.def.kind === 'vehicle' && u.def.armorSide > 20) armor++;
  }
  return { armor, total };
}

/** City planner for AI factions: production mix, postures, automatic air support. Same interfaces as the player. */
export function thinkCity(world: World, f: Faction): void {
  if (!f.alive || f.isPlayer) return;
  const w = personalityWeights(world, f.personality);
  const mix = knownEnemyMix(world, f.id);
  if (mix.total > 0 && mix.armor / mix.total > 0.2) {
    w.at_gun = (w.at_gun ?? 0) * 1.6;
    w.medium_tank = (w.medium_tank ?? 0) * 1.2;
  }
  if (world.planes.some((p) => world.isHostile(f.id, p.owner))) w.aa = (w.aa ?? 0) * 2.5;
  f.weights = w;
  // Postures: strongest sector assaults, others push cautiously; hold freshly taken points.
  const strength = f.sectors.map((s) => {
    let v = 0;
    for (const u of world.units.values()) if (u.owner === f.id && u.sectorId === s.id && u.hp > 0) v += u.def.costP + u.def.costM;
    return v;
  });
  const best = strength.indexOf(Math.max(...strength));
  const assaultAt = 900 * (world.data.rules.proposed_defaults.army_scale ?? 1);
  // Rich and at the population cap: money can't buy more troops, so use them — go for the kill.
  const pop = populationOf(world, f);
  const surplus = f.p > world.data.rules.economy.cap_p * 0.5 && pop.present + pop.reserved >= populationCap(world, f) * 0.9;
  for (const s of f.sectors) {
    const own = world.objectives.find((o) => o.id === s.targetObjective);
    let next = s.posture;
    if (s.reason === 'reason.defendCity') next = 'hold';
    else if (surplus || (s.id === best && strength[best] > assaultAt)) next = 'assault';
    else if (own && own.owner === f.id) next = f.personality === 'infantry' ? 'fortify' : 'hold';
    else next = 'cautious';
    // Hold a posture ≥45 s unless the city is threatened.
    if (next !== s.posture && (world.time - s.postureSince >= 45 || s.reason === 'reason.defendCity')) {
      s.posture = next;
      s.postureSince = world.time;
    }
  }
  f.mainSector = best;
  balanceReserves(world, f, strength);
  autoAir(world, f);
}

function autoAir(world: World, f: Faction): void {
  if (f.air.phase !== 'idle') return;
  const ids = ['air_bomb', 'air_strafe'];
  const missionId = ids.find((id) => {
    const m = missionDef(world, id)!;
    return world.time >= m.unlock_seconds && availableM(world, f) >= m.cost_m + 120;
  });
  if (!missionId) return;
  // Only known enemy clusters or emplaced weapons (§12.2).
  let best: Unit | null = null;
  let bestScore = 0;
  for (const u of world.units.values()) {
    if (u.hp <= 0 || !world.isHostile(f.id, u.owner) || !world.knows(f.id, u)) continue;
    let n = 0;
    for (const o of world.spatial.query(u.pos.x, u.pos.z, 30)) if (o.owner === u.owner && o.hp > 0) n++;
    const score = n + (u.setup === 'set' ? 1.5 : 0) + (u.def.kind === 'vehicle' ? 0.5 : 0);
    const friendNear = world.spatial.query(u.pos.x, u.pos.z, 45).some((o) => o.owner === f.id && o.hp > 0);
    if (!friendNear && score > bestScore && score >= 3) {
      bestScore = score;
      best = u;
    }
  }
  if (!best) return;
  // AI avoids heavy AA belts when it can see them.
  let aa = 0;
  for (const o of world.spatial.query(best.pos.x, best.pos.z, 320)) if (o.def.id === 'aa' && o.hp > 0 && world.isHostile(f.id, o.owner)) aa++;
  if (aa >= 2) return;
  if (world.rngAi.chance(0.5)) requestAir(world, f, missionId, best.pos);
}

/**
 * Dynamic reserves (AI only): reinforcement shares lean toward groups under pressure, and every
 * minute a quiet group sends up to 10% of its line troops to a clearly outmatched one.
 * Pressure = known enemy value near the group's front ÷ own group value.
 */
function balanceReserves(world: World, f: Faction, strength: number[]): void {
  const base = world.data.rules.proposed_defaults.sector_reinforcement_shares;
  const pressure = f.sectors.map((s, i) => {
    let enemy = 0;
    for (const u of world.spatial.queryOwners(s.front.x, s.front.z, 450, hostileMask(world, f.id))) {
      if (u.hp > 0 && world.knows(f.id, u)) enemy += u.def.costP + u.def.costM;
    }
    return enemy / (strength[i] + 1);
  });
  const sorted = [...f.sectors].sort((a, b) => a.id - b.id);
  const raw = sorted.map((s, i) => (base[i] ?? 0.33) * (0.6 + Math.min(1.5, pressure[s.id])));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  sorted.forEach((s, i) => (s.share = raw[i] / sum));
  if (Math.floor(world.time / 60) === Math.floor((world.time - 20) / 60)) return; // once a minute
  let hot = 0;
  let calm = 0;
  for (let i = 1; i < pressure.length; i++) {
    if (pressure[i] > pressure[hot]) hot = i;
    if (pressure[i] < pressure[calm]) calm = i;
  }
  if (hot === calm || pressure[hot] < 1.2 || pressure[calm] > 0.5) return;
  const movable: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.owner === f.id && u.sectorId === calm && u.hp > 0 && !u.fixed && !u.manual && !u.spearhead && u.opRole === 'line'
      && u.behavior === 'advance' && u.def.id !== 'supply_truck' && u.def.id !== 'howitzer') movable.push(u);
  }
  const n = Math.floor(movable.length * 0.1);
  movable.sort((a, b) => a.id - b.id);
  for (const u of movable.slice(0, n)) u.sectorId = hot;
  if (n > 0) world.note(f.id, 'log.reservesShifted', { n }, 'info');
}
