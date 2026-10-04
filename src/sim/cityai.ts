import { populationCap, populationOf } from './production';
import type { Faction, Personality, Unit } from './types';
import { hostileMask } from './spatial';
import { EAGER, eagerOn } from './strategyai';
import { defendingHome } from './homeguard';
import type { World } from './world';

const PERSONALITY_MUL: Record<Personality, Record<string, number>> = {
  balanced: {},
  armor: { light_tank: 1.5, medium_tank: 1.7, heavy_tank: 1.7, infantry: 0.8, supply_truck: 1.5 },
  infantry: { infantry: 1.25, mg: 1.6, engineer: 1.8, mortar: 1.3, light_tank: 0.7, medium_tank: 0.7 },
  artillery: { mortar: 1.6, howitzer: 1.6, recon: 1.5, heavy_tank: 0.7 },
  mechanized: { motor_inf: 3.5, light_tank: 1.5, medium_tank: 1.2, recon: 1.3, supply_truck: 1.4, infantry: 0.55, howitzer: 0.6, mortar: 0.8 },
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

/** City planner for AI factions: production mix, postures and reserves. Same interfaces as the player. */
export function thinkCity(world: World, f: Faction): void {
  if (!f.alive || f.isPlayer) return;
  const w = personalityWeights(world, f.personality);
  const mix = knownEnemyMix(world, f.id);
  if (mix.total > 0 && mix.armor / mix.total > 0.2) {
    w.at_gun = (w.at_gun ?? 0) * 1.6;
    w.medium_tank = (w.medium_tank ?? 0) * 1.2;
  }
  f.weights = w;
  // Postures: strongest front assaults, others push cautiously; hold freshly taken points.
  const strength = f.fronts.map((s) => {
    let v = 0;
    for (const u of world.units.values()) if (u.owner === f.id && u.frontId === s.id && u.hp > 0) v += u.def.costP + u.def.costM;
    return v;
  });
  const best = strength.indexOf(Math.max(...strength));
  const assaultAt = 900 * (world.data.rules.proposed_defaults.army_scale ?? 1);
  // Round 2: the old trigger (P stock > cap_p/2 and pop ≥ 90 % cap) never fired once stocks were
  // tuned down. Aggression (command.ts assessMood) = army fullness × strength vs the neighbour
  // + idle line share: a full, idle army attacks with its main group, then with every group.
  let surplus: boolean;
  let mainAssault = false;
  if (eagerOn()) {
    surplus = f.command.aggression >= EAGER.assaultAll || f.command.finishTarget >= 0;
    mainAssault = f.command.aggression >= EAGER.assaultMain;
  } else {
    const pop = populationOf(world, f);
    surplus = f.p > world.data.rules.economy.cap_p * 0.5 && pop.present + pop.reserved >= populationCap(world, f) * 0.9;
  }
  for (const s of f.fronts) {
    const own = world.objectives.find((o) => o.id === s.targetObjective);
    let next = s.posture;
    const attacking = !own || own.owner !== f.id;
    if (defendingHome(s)) next = 'hold';
    else if ((surplus && attacking) || (s.id === best && (mainAssault || strength[best] > assaultAt))) next = 'assault';
    else if (own && own.owner === f.id) next = f.personality === 'infantry' ? 'fortify' : 'hold';
    else next = 'cautious';
    // Hold a posture ≥45 s unless the city is threatened.
    if (next !== s.posture && (world.time - s.postureSince >= 45 || defendingHome(s))) {
      s.posture = next;
      s.postureSince = world.time;
    }
  }
  f.mainFront = best;
  balanceReserves(world, f, strength);
}

/**
 * Dynamic reserves (AI only): reinforcement shares lean toward groups under pressure, and every
 * minute a quiet group sends up to 10% of its line troops to a clearly outmatched one.
 * Pressure = known enemy value near the group's front ÷ own group value.
 */
function balanceReserves(world: World, f: Faction, strength: number[]): void {
  const base = world.data.rules.proposed_defaults.sector_reinforcement_shares;
  const pressure = f.fronts.map((s, i) => {
    let enemy = 0;
    for (const u of world.spatial.queryOwners(s.front.x, s.front.z, 450, hostileMask(world, f.id))) {
      if (u.hp > 0 && world.knows(f.id, u)) enemy += u.def.costP + u.def.costM;
    }
    return enemy / (strength[i] + 1);
  });
  const sorted = [...f.fronts].sort((a, b) => a.id - b.id);
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
    if (u.owner === f.id && u.frontId === calm && u.hp > 0 && !u.fixed && !u.manual && !u.spearhead && u.opRole === 'line'
      && u.behavior === 'advance' && u.def.id !== 'supply_truck' && u.def.id !== 'howitzer' && u.def.id !== 'commander') movable.push(u);
  }
  const n = Math.floor(movable.length * 0.1);
  movable.sort((a, b) => a.id - b.id);
  for (const u of movable.slice(0, n)) u.frontId = hot;
  if (n > 0) world.note(f.id, 'log.reservesShifted', { n }, 'info');
}
