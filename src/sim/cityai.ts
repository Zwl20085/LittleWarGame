import { populationCap, populationOf } from './production';
import type { Faction, Front, Personality, Posture, Unit } from './types';
import { hostileMask } from './spatial';
import { EAGER, eagerOn } from './strategyai';
import { defendingHome } from './homeguard';
import { isCommander } from './formulas';
import { THEATRE } from './theatre';
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
  // Value per front id (ids are stable, not indices: theatre.ts creates and dissolves fronts).
  const strength = new Map<number, number>(f.fronts.map((s) => [s.id, 0]));
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || isCommander(u.def)) continue;
    const v = strength.get(u.frontId);
    if (v !== undefined) strength.set(u.frontId, v + u.def.costP + u.def.costM);
  }
  let best = f.fronts[0]?.id ?? 0;
  for (const s of f.fronts) if ((strength.get(s.id) ?? 0) > (strength.get(best) ?? 0)) best = s.id;
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
    const ordered = orderPosture(s);
    if (defendingHome(s)) next = 'hold';
    else if (ordered) next = ordered;
    else if ((surplus && attacking) || (s.id === best && (mainAssault || (strength.get(best) ?? 0) > assaultAt))) next = 'assault';
    else if (own && own.owner === f.id) next = f.personality === 'infantry' ? 'fortify' : 'hold';
    else next = 'cautious';
    // Hold a posture ≥45 s unless the city is threatened.
    if (next !== s.posture && (world.time - s.postureSince >= 45 || defendingHome(s) || ordered)) {
      s.posture = next;
      s.postureSince = world.time;
    }
  }
  f.mainFront = best;
  balanceReserves(world, f, strength);
}

/** Posture a line order dictates (the supreme HQ's defend / fortify / fall back), else null. */
function orderPosture(s: Front): Posture | null {
  const k = s.order.kind;
  return k === 'defend' || k === 'fallBack' ? 'hold' : k === 'fortify' ? 'fortify' : null;
}

/**
 * Supreme-HQ reinforcement allocation (AI only, 2.0): every front's share of new units follows its
 * need — pressure (known enemy value near its line ÷ its own value), the main effort and a fresh
 * front that has yet to fill up — instead of the 1.x fixed 45 / 35 / 20 % per sector. Every minute
 * a quiet front also sends up to 10 % of its line troops to a clearly outmatched one.
 */
function balanceReserves(world: World, f: Faction, strength: ReadonlyMap<number, number>): void {
  if (f.fronts.length === 0) return;
  const pressure = new Map<number, number>();
  let total = 0;
  for (const s of f.fronts) {
    let enemy = 0;
    for (const u of world.spatial.queryOwners(s.front.x, s.front.z, 450, hostileMask(world, f.id))) {
      if (u.hp > 0 && world.knows(f.id, u)) enemy += u.def.costP + u.def.costM;
    }
    const own = strength.get(s.id) ?? 0;
    pressure.set(s.id, enemy / (own + 1));
    total += own;
  }
  const mean = total / f.fronts.length;
  const raw = f.fronts.map((s) => {
    const need = Math.min(1.5, pressure.get(s.id) ?? 0);
    // A front well below the mean strength (new, or bled) gets topped up first.
    const thin = mean > 0 ? Math.max(0, 1 - (strength.get(s.id) ?? 0) / mean) : 0;
    return (0.6 + need + THEATRE.shareThin * thin) * (s.id === f.mainFront ? THEATRE.shareMain : 1);
  });
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  f.fronts.forEach((s, i) => (s.share = raw[i] / sum));
  if (Math.floor(world.time / 60) === Math.floor((world.time - 20) / 60)) return; // once a minute
  let hot = f.fronts[0];
  let calm = f.fronts[0];
  for (const s of f.fronts) {
    if ((pressure.get(s.id) ?? 0) > (pressure.get(hot.id) ?? 0)) hot = s;
    if ((pressure.get(s.id) ?? 0) < (pressure.get(calm.id) ?? 0)) calm = s;
  }
  if (hot === calm || (pressure.get(hot.id) ?? 0) < 1.2 || (pressure.get(calm.id) ?? 0) > 0.5) return;
  const movable: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.owner === f.id && u.frontId === calm.id && u.hp > 0 && !u.fixed && !u.manual && !u.spearhead && u.opRole === 'line'
      && u.behavior === 'advance' && u.def.id !== 'supply_truck' && u.def.id !== 'howitzer' && !isCommander(u.def)) movable.push(u);
  }
  const n = Math.floor(movable.length * 0.1);
  movable.sort((a, b) => a.id - b.id);
  for (const u of movable.slice(0, n)) u.frontId = hot.id;
  if (n > 0) world.note(f.id, 'log.reservesShifted', { n }, 'info');
}
