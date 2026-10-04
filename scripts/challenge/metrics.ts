// Challenge lab: read-only per-second sampler of how the AI factions defend against the challenger.
import { eligibleCapturer } from '../../src/sim/capture';
import { capitalDefence } from '../../src/sim/storm';
import { dist } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import type { AiDefence, CapitalEvent } from './types';
import { armyValue, valueNear } from './worldq';

const WORKS_R = 300;
const ARRIVAL_R = 600;
const ARRIVAL_VALUE = 300;
const HELD_EVERY_S = 300;
const TRACE_EVERY_S = 30;
/** …and every 5 s while the challenger is at the gates (≥ ARRIVAL_VALUE within 600 m) or capturing. */
const TRACE_CLOSE_S = 5;
/** Arrival = capture progress, or challenger value within ARRIVAL_R ≥ max(ARRIVAL_VALUE, this share of its army). */
const ARRIVAL_ARMY_SHARE = 0.25;

export interface Sampler {
  /** After every tick: capital falls (cheap). */
  afterTick(): void;
  /** Once per game second. */
  second(attackS: number): void;
  readonly ai: AiDefence[];
  readonly falls: CapitalEvent[];
  readonly held: { t: number; byFaction: number[] }[];
}

/** Eligible capturers of `owner` inside the HQ capture radius of `city` (what actually blocks / makes a capture). */
export function hqHolders(w: World, owner: number, city: number): number {
  const hq = w.hqPos(city);
  const r = w.data.rules.victory.command_radius_m;
  let n = 0;
  for (const u of w.units.values()) if (u.owner === owner && eligibleCapturer(w, u) && dist(u.pos, hq) <= r) n++;
  return n;
}

export function createSampler(w: World, me: number): Sampler {
  const hqMe = w.hqPos(me);
  const ai: AiDefence[] = w.factions.filter((f) => f.id !== me).map((f) => ({
    id: f.id, personality: f.personality, capitalDistM: Math.round(dist(hqMe, w.hqPos(f.id))),
    firstAlarmS: -1, firstAlarmAfterAttackS: -1, maxLevel: 0, groupsRecalled: 0, peakRecalled: 0,
    worksPeak: 0, worksKinds: {}, counterAttackS: -1, counterAfterAttackS: -1, arrivalS: -1, defenceAtArrival: 0, garrisonAtArrival: 0,
    homeValueAtArrival: 0, attackerAtArrival: 0, alarmActiveAtArrival: false, recalledAtArrival: 0, holdersAtArrival: 0, lostS: -1, lostTo: -1, unitsLost: 0,
    alarmShare: 0, alarmOnsets: 0, alertShare: 0, firstAlertAfterAttackS: -1, ratioAtProgress: -1, peakAttacker: 0, peakAttackerS: -1, maxProgress: 0, progressS: 0, trace: [],
  }));
  const recalled = ai.map(() => new Set<number>());
  const aliveS = ai.map(() => 0);
  const alarmS = ai.map(() => 0);
  const alertS = ai.map(() => 0);
  const wasOn = ai.map(() => false);
  const inProgress = ai.map(() => false);
  const alive = w.factions.map((f) => f.alive);
  const falls: CapitalEvent[] = [];
  const held: { t: number; byFaction: number[] }[] = [];

  const afterTick = (): void => {
    for (const f of w.factions) {
      if (!alive[f.id] || f.alive) continue;
      alive[f.id] = false;
      let by = -1;
      let bp = 0;
      for (const [k, p] of Object.entries(f.hqProgress)) if (p > bp) { bp = p; by = Number(k); }
      falls.push({ capital: f.id, by, t: Math.round(w.time) });
      const a = ai.find((x) => x.id === f.id);
      if (a) { a.lostS = Math.round(w.time); a.lostTo = by; }
    }
  };

  const second = (attackS: number): void => {
    const t = Math.round(w.time);
    if (t % HELD_EVERY_S === 0) held.push({ t, byFaction: w.factions.map((f) => w.objectives.filter((o) => o.owner === f.id).length) });
    const myArmy = armyValue(w, me);
    ai.forEach((a, i) => {
      const f = w.factions[a.id];
      if (!f.alive) return;
      const ht = f.command.homeThreat;
      const hq = w.hqPos(a.id);
      aliveS[i]++;
      if (ht.active) alarmS[i]++;
      if (ht.active && !wasOn[i]) a.alarmOnsets++;
      wasOn[i] = ht.active;
      a.alarmShare = Math.round((alarmS[i] / aliveS[i]) * 100) / 100;
      const alert = !!(ht as { alert?: boolean }).alert;
      if (alert) alertS[i]++;
      a.alertShare = Math.round((alertS[i] / aliveS[i]) * 100) / 100;
      if (alert && attackS >= 0 && t >= attackS && a.firstAlertAfterAttackS < 0) a.firstAlertAfterAttackS = t;
      if (ht.active && a.firstAlarmS < 0) a.firstAlarmS = t;
      if (ht.active && attackS >= 0 && t >= attackS && a.firstAlarmAfterAttackS < 0) a.firstAlarmAfterAttackS = t;
      a.maxLevel = Math.max(a.maxLevel, Math.round(ht.level * 100) / 100);
      for (const id of ht.recall) recalled[i].add(id);
      a.groupsRecalled = recalled[i].size;
      a.peakRecalled = Math.max(a.peakRecalled, ht.recall.length);
      if (t % 5 === 0) {
        const kinds: Record<string, number> = {};
        let n = 0;
        for (const x of w.forts) {
          if (x.owner !== a.id || x.hp <= 0 || x.progress < 1 || x.kind === 'pontoon' || dist(x.pos, hq) > WORKS_R) continue;
          kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
          n++;
        }
        if (n > a.worksPeak) { a.worksPeak = n; a.worksKinds = kinds; }
      }
      const counter = f.fronts.some((s) => s.targetCity === me);
      if (counter && a.counterAttackS < 0) a.counterAttackS = t;
      if (counter && attackS >= 0 && t >= attackS && a.counterAfterAttackS < 0) a.counterAfterAttackS = t;
      const prog = f.hqProgress[me] ?? 0;
      if (prog > 0 && !inProgress[i]) a.ratioAtProgress = Math.round((myArmy / Math.max(1, armyValue(w, a.id))) * 100) / 100;
      inProgress[i] = prog > 0;
      if (prog > 0) a.progressS++;
      a.maxProgress = Math.max(a.maxProgress, Math.round(prog));
      const att = valueNear(w, me, hq, ARRIVAL_R);
      const afterAttack = attackS < 0 || t >= attackS;
      if (afterAttack && att > a.peakAttacker) { a.peakAttacker = Math.round(att); a.peakAttackerS = t; }
      if (a.arrivalS < 0 && afterAttack && (prog > 0 || att >= Math.max(ARRIVAL_VALUE, ARRIVAL_ARMY_SHARE * myArmy))) {
        a.arrivalS = t;
        a.attackerAtArrival = Math.round(att);
        a.defenceAtArrival = Math.round(capitalDefence(w, me, a.id));
        a.garrisonAtArrival = Math.round(ht.garrison);
        a.homeValueAtArrival = Math.round(valueNear(w, a.id, hq, 1500));
        a.alarmActiveAtArrival = ht.active;
        a.recalledAtArrival = ht.recall.length;
        a.holdersAtArrival = hqHolders(w, a.id, a.id);
      }
      if (t % TRACE_EVERY_S === 0 || (t % TRACE_CLOSE_S === 0 && (prog > 0 || att >= ARRIVAL_VALUE))) {
        a.trace.push({
          t, level: Math.round(ht.level * 100) / 100, on: ht.active, recalled: ht.recall.length, garrison: Math.round(ht.garrison),
          forecast: Math.round(ht.enemy), eta: Math.round(ht.eta), defence: Math.round(capitalDefence(w, me, a.id)), att600: Math.round(att),
          att1500: Math.round(valueNear(w, me, hq, 1500)), home1500: Math.round(valueNear(w, a.id, hq, 1500)), army: Math.round(armyValue(w, a.id)),
          myArmy: Math.round(myArmy), progress: Math.round(prog), works: ht.works,
          holders: hqHolders(w, a.id, a.id), raiders: hqHolders(w, me, a.id),
        });
      }
    });
  };

  return { afterTick, second, ai, falls, held };
}
