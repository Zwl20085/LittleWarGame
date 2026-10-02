import type { Unit } from './types';
import { hostileMask } from './spatial';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Capped proportional allocation (BALANCE_SPEC §6.2): distribute L by need×priority,
 * saturated units drop out and the remainder is re-distributed. Never exceeds need or L.
 */
export function allocateSupply(needs: readonly number[], priorities: readonly number[], L: number): number[] {
  const alloc = needs.map(() => 0);
  let remaining = L;
  let active = needs.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  for (let iter = 0; iter < 50 && remaining > 1e-9 && active.length > 0; iter++) {
    const wsum = active.reduce((s, i) => s + needs[i] * priorities[i], 0);
    if (wsum <= 0) break;
    const next: number[] = [];
    let used = 0;
    for (const i of active) {
      const share = (remaining * needs[i] * priorities[i]) / wsum;
      const room = needs[i] - alloc[i];
      const give = Math.min(share, room);
      alloc[i] += give;
      used += give;
      if (needs[i] - alloc[i] > 1e-9) next.push(i);
    }
    remaining -= used;
    if (next.length === active.length && used < 1e-12) break;
    active = next;
  }
  return alloc;
}

export interface SupplyNode {
  readonly pos: V2;
  readonly radius: number;
  readonly parent: V2 | null;
  readonly cut: boolean;
}

/** Is the segment a→b cut by ≥40 m of continuous hostile ground control? */
function segmentCut(world: World, f: number, a: V2, b: V2, owner: (p: V2) => number): boolean {
  const len = dist(a, b);
  const n = Math.max(1, Math.ceil(len / 20));
  let run = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const o = owner({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    if (o >= 0 && world.isHostile(f, o)) {
      run += len / n;
      if (run >= 40) return true;
    } else run = 0;
  }
  return false;
}

/** Rebuild one faction's supply network and distribute logistics (every 2 s). */
export function rebuildSupply(world: World, f: number, owner: (p: V2) => number): SupplyNode[] {
  const s = world.data.rules.supply;
  const hq = world.hqPos(f);
  const nodes: SupplyNode[] = [{ pos: hq, radius: s.city_local_radius_m, parent: null, cut: false }];
  const trucks: Unit[] = [];
  const mine: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.owner !== f || u.hp <= 0) continue;
    if (u.def.id === 'supply_truck') trucks.push(u);
    if (!u.fixed) mine.push(u);
  }
  // BFS from root through trucks within relay path length (path ≈ 1.15 × straight line).
  const connected = new Set<number>();
  const frontier: V2[] = [hq];
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of trucks) {
      if (connected.has(t.id)) continue;
      for (const p of frontier) {
        if (dist(p, t.pos) * 1.15 > s.relay_max_path_m) continue;
        const cut = segmentCut(world, f, p, t.pos, owner);
        if (cut) {
          if (!nodes.some((n) => n.cut && n.pos.x === t.pos.x && n.pos.z === t.pos.z && n.parent === p)) nodes.push({ pos: { ...t.pos }, radius: 0, parent: p, cut: true });
          continue;
        }
        connected.add(t.id);
        frontier.push(t.pos);
        nodes.push({ pos: { ...t.pos }, radius: s.truck_local_radius_m, parent: p, cut: false });
        changed = true;
        break;
      }
    }
  }
  const eligible: Unit[] = [];
  for (const u of mine) {
    u.supplied = false;
    if (dist(u.pos, hq) <= s.city_local_radius_m || connected.has(u.id)) u.supplied = true;
    else for (const t of trucks) if (connected.has(t.id) && dist(t.pos, u.pos) <= s.truck_local_radius_m) { u.supplied = true; break; }
    if (u.supplied) eligible.push(u);
    else u.supplyRatio = 0;
  }
  const fac = world.factions[f];
  const needs = eligible.map((u) => u.def.supplyDemand);
  const pri = eligible.map((u) => (u.sectorId === fac.mainSector ? s.main_sector_priority : 1));
  const alloc = allocateSupply(needs, pri, fac.logistics);
  eligible.forEach((u, i) => (u.supplyRatio = needs[i] > 0 ? alloc[i] / needs[i] : 1));
  fac.supplyDemand = mine.reduce((a, u) => a + u.def.supplyDemand, 0);
  return nodes;
}

/** Ammo regeneration and paid recovery (§6.3–6.4); called once per second. */
export function supplyTick(world: World, u: Unit, seconds: number): void {
  const s = world.data.rules.supply;
  if (u.fixed) {
    u.ammo = Math.min(1, u.ammo + s.ammo_regeneration_per_second * seconds);
    return;
  }
  // Away from the city, ammunition arrives only by convoy (see convoy.ts).
  if (dist(u.pos, world.hqPos(u.owner)) <= s.city_local_radius_m) u.ammo = Math.min(1, u.ammo + s.ammo_regeneration_per_second * 3 * seconds);
  if (u.hp >= u.def.maxHp || u.moving || world.time - u.lastDamagedAt < 5) return;
  const hq = world.hqPos(u.owner);
  let canRecover = dist(u.pos, hq) <= s.city_recovery_radius_m;
  if (!canRecover && u.supplied) {
    for (const o of world.spatial.query(u.pos.x, u.pos.z, s.truck_recovery_radius_m)) {
      if (o.owner === u.owner && o.def.id === 'supply_truck' && o.hp > 0 && o.supplied) {
        canRecover = world.spatial.query(u.pos.x, u.pos.z, 15).some((e) => e.owner === u.owner && e.def.id === 'engineer' && e.hp > 0);
        if (canRecover) break;
      }
    }
  }
  if (!canRecover) return;
  for (const o of world.spatial.queryOwners(u.pos.x, u.pos.z, 100, hostileMask(world, u.owner))) if (o.hp > 0 && world.isHostile(u.owner, o.owner) && world.knows(u.owner, o)) return;
  const veh = u.def.kind === 'vehicle';
  const rate = veh ? s.vehicle_hp_recovery_ratio_per_second : s.infantry_hp_recovery_ratio_per_second;
  let h = Math.min(rate * seconds, (u.def.maxHp - u.hp) / u.def.maxHp);
  const fac = world.factions[u.owner];
  const costP = veh ? 0 : u.def.costP * 0.8;
  const costM = veh ? u.def.costM * 0.5 : u.def.costM * 0.25;
  // Buy only what the stock affords (atomic, never negative).
  if (costP > 0) h = Math.min(h, fac.p / costP);
  if (costM > 0) h = Math.min(h, fac.m / costM);
  if (h <= 0) return;
  fac.p = Math.max(0, fac.p - costP * h);
  fac.m = Math.max(0, fac.m - costM * h);
  fac.spentTotalP += costP * h;
  fac.spentTotalM += costM * h;
  u.hp = Math.min(u.def.maxHp, u.hp + h * u.def.maxHp);
}
