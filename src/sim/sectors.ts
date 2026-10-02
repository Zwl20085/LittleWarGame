import { AI } from './config';
import { hostileMask } from './spatial';
import { crossings, defensivePosition, firstCrossing, lineSlot, nearestFeature, threatCentre, unitDepthRank } from './terrainai';
import { frontAnchor } from './frontai';
import { bridgeSiteFor } from './engineering';
import { frontSegments, OPS, spreadAlong, planOperations } from './operations';
import type { Faction, Objective, Sector, Unit } from './types';
import { dist, headingTo, angleDiff, DEG, type V2 } from './vec';
import type { World } from './world';

const KEYS: Sector['key'][] = ['left', 'center', 'right'];

/** Assign each sector a primary objective by bearing from the city (left / centre / right). */
export function initSectors(world: World, f: Faction): void {
  const city = world.cityOf(f.id);
  const fwd = city.forwardDeg * DEG;
  const scored = world.objectives
    .map((o) => ({ o, ang: angleDiff(fwd, headingTo(city.hq, o.pos)), d: dist(city.hq, o.pos) }))
    .filter((x) => Math.abs(x.ang) < 75 * DEG)
    .sort((a, b) => a.d - b.d);
  const near = scored.slice(0, 3).sort((a, b) => a.ang - b.ang);
  // Negative bearing offset = left flank as seen from the city.
  const shares = world.data.rules.proposed_defaults.sector_reinforcement_shares;
  // Fallback: maps without forward objectives still get three sectors on the nearest points.
  const order = near.length > 0 ? near : world.objectives.map((o) => ({ o, ang: 0, d: dist(city.hq, o.pos) })).sort((a, b) => a.d - b.d).slice(0, 3);
  if (order.length === 0) throw new Error(`map ${world.map.id}: no objectives for sectors`);
  const centreIdx = order.length === 3 ? 1 : 0;
  // Biggest share to the centre objective, then left, then right.
  const shareFor = (i: number): number => (i === centreIdx ? shares[0] : i < centreIdx ? shares[1] : shares[2]);
  f.sectors = KEYS.map((key, i) => {
    const target = order[i]?.o ?? order[0].o;
    const rally = lerpV(city.exit, target.pos, 0.35);
    return {
      id: i, key, share: shareFor(i), posture: 'cautious', targetPos: { ...target.pos }, targetObjective: target.id,
      targetCity: null, rally, reason: 'reason.capturePoint', reasonParams: { point: target.id }, lastRetarget: -999, postureSince: 0,
      manualTarget: false, gatheredSince: -1, advancing: false,
      front: { ...target.pos }, facing: headingTo(city.hq, target.pos), slots: {}, crossing: null, stagedSince: -1, lastSpearhead: -999, mode: 'advance', shelledAt: -999, segment: [], bridgeSite: null, bridgeCheckAt: 0,
    };
  });
  f.mainSector = centreIdx;
}

export const lerpV = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

function knownEnemyStrength(world: World, f: number, at: V2, r: number): number {
  let s = 0;
  for (const u of world.spatial.queryOwners(at.x, at.z, r, hostileMask(world, f))) {
    if (u.hp > 0 && world.isHostile(f, u.owner) && world.knows(f, u)) s += (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));
  }
  return s;
}

/** Reason text describing the sector's current goal (not a temporary gate). */
function setGoalReason(s: Sector): void {
  if (s.manualTarget) {
    s.reason = 'reason.playerTarget';
    s.reasonParams = {};
  } else if (s.targetCity !== null) {
    s.reason = 'reason.assaultCity';
    s.reasonParams = { city: s.targetCity };
  } else {
    s.reason = 'reason.capturePoint';
    s.reasonParams = { point: s.targetObjective ?? '' };
  }
}

export function sectorUnits(world: World, f: number, sectorId: number): Unit[] {
  const out: Unit[] = [];
  for (const u of world.units.values()) if (u.owner === f && u.sectorId === sectorId && u.hp > 0 && !u.fixed) out.push(u);
  return out;
}

function strengthOf(units: Unit[]): number {
  return units.reduce((s, u) => s + (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp), 0);
}

/** Next objective for a sector once its own is secured: closest not-owned point, else weakest enemy city. */
function nextTarget(world: World, f: Faction, s: Sector): { pos: V2; obj: Objective | null; city: number | null } {
  const from = s.targetPos;
  const own = world.objectives.find((o) => o.id === s.targetObjective);
  if (own && own.owner !== f.id) return { pos: own.pos, obj: own, city: null };
  // Score open objectives: near our current front, weakly held, not already another group's target,
  // and penalise ones behind a river (crossings are costly).
  const mine = strengthOf(sectorUnits(world, f.id, s.id)) + 1;
  const taken = new Set(f.sectors.filter((x) => x.id !== s.id).map((x) => x.targetObjective));
  let best: Objective | null = null;
  let bestScore = -Infinity;
  for (const o of world.objectives) {
    if (o.owner === f.id) continue;
    const d = dist(o.pos, from);
    const enemy = knownEnemyStrength(world, f.id, o.pos, 260);
    const water = crossings(world).some((c) => c.kind !== 'pass' && dist(c.pos, from) + dist(c.pos, o.pos) < d * 1.25);
    // High command: valuable, winnable settlements pull the army groups (0 … 0.6).
    const hcBias = (f.command.attackBias[o.id] ?? 0) * 0.6;
    const score = 1 + hcBias + (o.owner >= 0 ? 0.3 : 0) - d / 1400 - (enemy / mine) * 0.8 - (water ? 0.25 : 0) - (taken.has(o.id) ? 0.6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  if (best && bestScore > -0.6) return { pos: best.pos, obj: best, city: null };
  const enemies = world.factions.filter((e) => e.alive && world.isHostile(f.id, e.id));
  if (enemies.length === 0) return { pos: from, obj: own ?? null, city: null };
  enemies.sort((a, b) => dist(world.hqPos(a.id), from) * (0.5 + a.resolve / 900) - dist(world.hqPos(b.id), from) * (0.5 + b.resolve / 900));
  return { pos: world.hqPos(enemies[0].id), obj: null, city: enemies[0].id };
}

/** Sector planner (2 s): target choice, gather/advance gate, city-defence override. */
export function thinkSectors(world: World, f: Faction): void {
  const hq = world.hqPos(f.id);
  const threat = knownEnemyStrength(world, f.id, hq, 280);
  // Each group owns a stretch of the front so the whole line is held, not one point.
  const segs = frontSegments(world, f, world.frontInfo[f.id]?.cells ?? []);
  f.sectors.forEach((s, i) => (s.segment = segs[i] ?? []));
  planOperations(world, f);
  for (const s of f.sectors) {
    const units = sectorUnits(world, f.id, s.id);
    if (threat > 300 && !s.manualTarget) {
      s.targetPos = { ...hq };
      s.targetObjective = null;
      s.targetCity = null;
      s.reason = 'reason.defendCity';
      s.reasonParams = {};
      s.advancing = true;
      s.rally = lerpV(hq, world.cityOf(f.id).exit, 1.5);
      for (const u of units) if (u.behavior === 'rally') u.behavior = 'advance';
      planFront(world, f, s, units, true);
      continue;
    }
    // Strategy changes slowly: a sector keeps its objective at least 60 s (user: AI was too fast).
    if (!s.manualTarget && world.time - s.lastRetarget > 60) {
      const t = nextTarget(world, f, s);
      if (dist(t.pos, s.targetPos) > 1 || s.reason === 'reason.defendCity') {
        s.targetPos = { ...t.pos };
        s.targetObjective = t.obj?.id ?? null;
        s.targetCity = t.city;
        s.lastRetarget = world.time;
        setGoalReason(s);
        s.rally = lerpV(world.cityOf(f.id).exit, s.targetPos, t.city !== null ? 0.5 : 0.35);
      }
    }
    // Losing badly near target → pause the push (avoid suicidal trickle). Count the whole sector,
    // including units waiting at the rally point, so the gate cannot deadlock.
    const mine = strengthOf(units);
    const theirs = knownEnemyStrength(world, f.id, s.targetPos, 220);
    const outmatched = theirs > mine * 1.6 && s.posture !== 'assault';
    const gatherAtRally = units.filter((u) => u.behavior === 'rally' && dist(u.pos, s.rally) < 60);
    const inf = gatherAtRally.filter((u) => u.def.kind === 'infantry').length;
    if (gatherAtRally.length > 0 && s.gatheredSince < 0) s.gatheredSince = world.time;
    const waited = s.gatheredSince >= 0 && world.time - s.gatheredSince > AI.rallyMaxWait;
    const scale = world.data.rules.proposed_defaults.army_scale ?? 1;
    const needInf = Math.max(AI.rallyMinInfantry, Math.round(AI.rallyMinInfantry * scale * 0.6));
    const release = (inf >= needInf || waited) && !outmatched && s.posture !== 'withdraw';
    if (release) {
      for (const u of gatherAtRally) u.behavior = 'advance';
      s.gatheredSince = -1;
    } else if (gatherAtRally.length > 0) {
      s.reason = outmatched ? 'reason.outmatched' : 'reason.waitGroup';
      s.reasonParams = { n: inf, need: needInf };
    }
    if ((release || gatherAtRally.length === 0) && (s.reason === 'reason.waitGroup' || s.reason === 'reason.outmatched')) setGoalReason(s);
    s.advancing = release;
    planFront(world, f, s, units, outmatched);
  }
}

/**
 * Terrain-aware battle line for one group: defend on high ground / behind a river when
 * holding or outmatched; when attacking across a river, stage before the crossing until the
 * group has massed, then push through. Units get formation slots on the line.
 */
function planFront(world: World, f: Faction, s: Sector, units: Unit[], defensive: boolean): void {
  const centroid = units.length > 0
    ? { x: units.reduce((a, u) => a + u.pos.x, 0) / units.length, z: units.reduce((a, u) => a + u.pos.z, 0) / units.length }
    : world.cityOf(f.id).exit;
  const threat = threatCentre(world, f.id, s.targetPos, 600) ?? s.targetPos;
  const holding = defensive || s.posture === 'hold' || s.posture === 'fortify' || s.reason === 'reason.defendCity';
  let front = s.targetPos;
  let facing = headingTo(centroid, s.targetPos);
  // After first contact the group fights along the real battle front (from the control map).
  const anchor = s.reason === 'reason.defendCity' ? null : frontAnchor(world, f.id, s.targetPos);
  if (anchor && s.posture !== 'withdraw') {
    const home = world.hqPos(f.id);
    const near = units.filter((u) => dist(u.pos, anchor) < 450 && !u.spearhead);
    const mine = strengthOf(near) + 1;
    const theirs = knownEnemyStrength(world, f.id, anchor, 380);
    const ratio = mine / (theirs + 1);
    const toTarget = headingTo(anchor, s.targetPos);
    const wantsPush = !defensive && s.posture !== 'hold' && s.posture !== 'fortify';
    const pushing = wantsPush && ratio > (s.posture === 'assault' ? 1.0 : 1.4);
    if (pushing) {
      // Push the line forward toward the objective in bounded steps.
      const d = Math.min(110, dist(anchor, s.targetPos));
      front = { x: anchor.x + Math.cos(toTarget) * d, z: anchor.z + Math.sin(toTarget) * d };
      facing = toTarget;
      s.mode = 'push';
      s.reason = 'reason.pushFront';
      s.reasonParams = { point: s.targetObjective ?? '' };
    } else {
      // Hold just behind the line on the best local ground, facing the enemy.
      const hd = headingTo(anchor, home);
      const back = { x: anchor.x + Math.cos(hd) * 35, z: anchor.z + Math.sin(hd) * 35 };
      const foe = threatCentre(world, f.id, anchor, 450) ?? { x: anchor.x + Math.cos(toTarget) * 150, z: anchor.z + Math.sin(toTarget) * 150 };
      const dp = defensivePosition(world, back, foe, 110);
      front = dp.pos;
      facing = headingTo(front, foe);
      s.mode = 'hold';
      const feat = nearestFeature(world, front, 500);
      s.reason = dp.river ? 'reason.holdRiver' : dp.height > 6 ? 'reason.holdHigh' : 'reason.holdFront';
      s.reasonParams = { feature: feat ? (world.map.features ?? []).indexOf(feat) : -1, point: s.targetObjective ?? '' };
    }
    if (!defensive && ratio > 2.2 && world.time - s.lastSpearhead > 120) launchSpearhead(world, f, s, units, anchor);
    s.crossing = null;
  } else if (holding) {
    // Anchor near the objective (or the city) on the best defensive ground facing the threat.
    const anchor = s.reason === 'reason.defendCity' ? world.hqPos(f.id) : s.targetObjective && world.objectives.find((o) => o.id === s.targetObjective)?.owner === f.id ? s.targetPos : lerpV(centroid, s.targetPos, 0.5);
    const dp = defensivePosition(world, anchor, threat, 220);
    front = dp.pos;
    facing = headingTo(front, threat);
    if (s.reason !== 'reason.defendCity' && s.reason !== 'reason.waitGroup' && s.reason !== 'reason.outmatched') {
      const feat = nearestFeature(world, front, 500);
      const fi = feat ? (world.map.features ?? []).indexOf(feat) : -1;
      s.reason = dp.river ? 'reason.holdRiver' : dp.height > 6 ? 'reason.holdHigh' : 'reason.holdLine';
      s.reasonParams = { feature: fi, point: s.targetObjective ?? '' };
    }
    s.crossing = null;
  } else if (s.posture !== 'withdraw') {
    const exit = world.cityOf(f.id).exit;
    const key = `${Math.round(s.targetPos.x)},${Math.round(s.targetPos.z)}`;
    if (!s.crossing || s.crossing.key !== key) {
      const fc = dist(centroid, s.targetPos) > 250 ? firstCrossing(world, dist(centroid, exit) < 400 ? exit : centroid, s.targetPos) : null;
      s.crossing = fc ? { pos: fc.crossing.pos, kind: fc.crossing.kind, staging: fc.staging, key } : null;
      s.stagedSince = -1;
    }
    const c = s.crossing;
    if (c) {
      const beforeCrossing = dist(centroid, s.targetPos) > dist(c.pos, s.targetPos) + 40;
      const massed = units.filter((u) => dist(u.pos, c.staging) < 160).length >= Math.max(3, units.length * 0.6);
      if (beforeCrossing && !massed && (s.stagedSince < 0 || world.time - s.stagedSince < 90)) {
        if (s.stagedSince < 0) s.stagedSince = world.time;
        front = c.staging;
        facing = headingTo(c.staging, c.pos);
        const feat = nearestFeature(world, c.pos, 300);
        s.reason = 'reason.crossAt';
        s.reasonParams = { feature: feat ? (world.map.features ?? []).indexOf(feat) : -1, kind: c.kind };
      } else {
        if (s.reason === 'reason.crossAt') setGoalReason(s);
        if (!beforeCrossing) s.crossing = null;
      }
    }
  }
  // Engineering: does the route to the objective need a bridge? (checked every 20 s)
  if (world.time >= s.bridgeCheckAt) {
    s.bridgeCheckAt = world.time + 20;
    s.bridgeSite = s.posture === 'withdraw' || holding ? null : bridgeSiteFor(world, s, centroid);
  }
  // Hysteresis: small drifts of the line keep the old anchor so units don't constantly re-path.
  const moved = dist(front, s.front) > 40 || Math.abs(angleDiff(facing, s.facing)) > 20 * DEG;
  if (moved) {
    s.front = front;
    s.facing = facing;
  }
  front = s.front;
  facing = s.facing;
  // Formation slots by rank (front-line troops, AT/MG line behind, support further back).
  const liners = units.filter((u) => u.behavior === 'advance' && !u.manual && !u.spearhead && u.opRole === 'line' && !['howitzer', 'mortar', 'supply_truck', 'aa', 'recon'].includes(u.def.id))
    .sort((a, b) => unitDepthRank(a) - unitDepthRank(b) || a.id - b.id);
  const byRank = new Map<number, Unit[]>();
  for (const u of liners) {
    const r = unitDepthRank(u);
    const arr = byRank.get(r) ?? [];
    arr.push(u);
    byRank.set(r, arr);
  }
  const slots: Record<number, V2> = {};
  const seg = s.segment;
  const home = world.hqPos(f.id);
  // Spacing doctrine: spread wider once enemy shells land among the group.
  const spacing = world.time - s.shelledAt < OPS.shelledMemorySeconds ? OPS.shelledSpacing : OPS.minSpacing;
  const segLen = seg.length * 10;
  for (const [rank, arr] of byRank) {
    // Along the whole front segment when in contact; otherwise a compact line at the objective.
    const perRow = seg.length > 0 ? Math.max(1, Math.floor(segLen / spacing)) : arr.length;
    arr.forEach((u, i) => {
      let p: V2;
      if (seg.length > 0 && s.reason !== 'reason.defendCity') {
        const row = Math.floor(i / perRow);
        const inRow = Math.min(perRow, arr.length - row * perRow);
        const base = spreadAlong(seg, inRow)[i % perRow] ?? seg[0];
        // Pull back from the contact line (holding) or lean forward (pushing); extra rows further back.
        const lean = s.mode === 'push' ? 25 : -35;
        const back = lean - (row + rank) * 30;
        const hd = headingTo(home, base);
        p = { x: base.x + Math.cos(hd) * back, z: base.z + Math.sin(hd) * back };
      } else p = lineSlot(front, facing, i, arr.length, rank);
      slots[u.id] = world.navFor(u).nearestPassable(p, 40) ?? p;
    });
  }
  s.slots = slots;
}

/**
 * Breakthrough: with decisive local superiority, detach a mobile group (tanks + fresh infantry)
 * to drive through the front and seize an enemy settlement behind it — or the enemy capital.
 */
function launchSpearhead(world: World, f: Faction, s: Sector, units: Unit[], anchor: V2): void {
  let target: string | null = null;
  let tpos: V2 | null = null;
  let best = Infinity;
  for (const o of world.objectives) {
    if (o.owner < 0 || o.owner === f.id || !world.isHostile(f.id, o.owner)) continue;
    const d = dist(o.pos, anchor) * (o.kind === 'city' ? 0.7 : o.kind === 'town' ? 0.85 : 1);
    if (d < best && d < 1100) {
      best = d;
      target = o.id;
      tpos = o.pos;
    }
  }
  if (!target) {
    for (const e of world.factions) {
      if (!e.alive || !world.isHostile(f.id, e.id)) continue;
      const d = dist(world.hqPos(e.id), anchor);
      if (d < best && d < 1400) {
        best = d;
        target = `hq:${e.id}`;
        tpos = world.hqPos(e.id);
      }
    }
  }
  if (!target || !tpos) return;
  const pool = units
    .filter((u) => !u.spearhead && !u.manual && !u.routing && u.behavior === 'advance' && u.hp > u.def.maxHp * 0.6
      && (u.def.kind === 'vehicle' ? u.def.id !== 'supply_truck' : u.def.id === 'infantry' || u.def.id === 'engineer'))
    .sort((a, b) => dist(a.pos, anchor) - dist(b.pos, anchor));
  const size = Math.max(4, Math.round(units.length * 0.3));
  const group = pool.slice(0, size);
  if (group.filter((u) => u.def.kind === 'infantry').length < 2) return;
  for (const u of group) u.spearhead = target;
  s.lastSpearhead = world.time;
  s.mode = 'breakthrough';
  world.note(f.id, 'log.spearhead', { point: target.startsWith('hq:') ? '' : target, n: group.length }, 'info');
}
