// Strategy lab, round 3: capital-defence metrics sampled once per game second (read-only).
import type { Unit } from '../../src/sim/types';
import { dist } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';

export interface HomeStats {
  /** Capital capture-progress episodes (hqProgress rose from 0), and those where the defender had ≥ 1.5× the attackers' value within 1 500 m. */
  episodes: number;
  stoppable: number;
  /** Capitals that fell; of those, the ones whose last episode was stoppable. */
  capitalsLost: number;
  stoppableLost: number;
  /** Seconds any capital had capture progress. */
  progressS: number;
  /** Trench / sandbag lines started / finished within 300 m of their owner's capital. */
  worksStarted: number;
  worksBuilt: number;
  /** Alarm onsets (homeThreat.active false → true). */
  alarms: number;
  /** Army-group minutes spent recalled to the capital (either rule). */
  groupMinutesHome: number;
  /** Time (min) each capital fell, for the soak-style "wars end" check. */
  fallMin: number[];
  /** Round 4: crew-weapon samples per type (alive, not fixed): fired in the last 5 s, moving with no target, standing with no target. */
  crew?: Record<string, { n: number; firing: number; relocating: number; idle: number }>;
}

const ATTACK_R = 300;
const REACH_R = 1500;
const WORKS_R = 300;
const CREW = new Set(['mg', 'at_gun', 'mortar', 'howitzer']);

const value = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);

export function homeSampler(w: World): { sample: () => void; result: () => HomeStats } {
  const st: HomeStats = { episodes: 0, stoppable: 0, capitalsLost: 0, stoppableLost: 0, progressS: 0, worksStarted: 0, worksBuilt: 0, alarms: 0, groupMinutesHome: 0, fallMin: [], crew: {} };
  const inEp = w.factions.map(() => false);
  const epStoppable = w.factions.map(() => false);
  const wasAlive = w.factions.map((f) => f.alive);
  const wasActive = w.factions.map(() => false);
  const started = new Set<number>();
  const built = new Set<number>();
  const sample = (): void => {
    for (const f of w.factions) {
      if (wasAlive[f.id] && !f.alive) {
        st.capitalsLost++;
        st.fallMin.push(Math.round((w.time / 60) * 10) / 10);
        if (inEp[f.id] && epStoppable[f.id]) st.stoppableLost++;
        wasAlive[f.id] = false;
        inEp[f.id] = false;
      }
      if (!f.alive) continue;
      const active = !!f.command.homeThreat?.active;
      if (active && !wasActive[f.id]) st.alarms++;
      wasActive[f.id] = active;
      st.groupMinutesHome += f.fronts.filter((s) => s.reason === 'reason.defendCity' || s.reason === 'reason.homeDefence').length / 60;
      const p = Math.max(0, ...Object.values(f.hqProgress));
      if (p > 0) st.progressS++;
      if (p > 0 && !inEp[f.id]) {
        const hq = w.hqPos(f.id);
        let att = 0;
        let def = 0;
        for (const u of w.units.values()) {
          if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck') continue;
          const d = dist(u.pos, hq);
          if (u.owner === f.id && d < REACH_R) def += value(u);
          else if (u.owner !== f.id && w.isHostile(f.id, u.owner) && d < ATTACK_R) att += value(u);
        }
        inEp[f.id] = true;
        epStoppable[f.id] = def >= 1.5 * att;
        st.episodes++;
        if (epStoppable[f.id]) st.stoppable++;
      } else if (p === 0) inEp[f.id] = false;
    }
    for (const u of w.units.values()) {
      if (u.hp <= 0 || u.fixed || !CREW.has(u.def.id)) continue;
      const c = (st.crew![u.def.id] ??= { n: 0, firing: 0, relocating: 0, idle: 0 });
      c.n++;
      if (w.time - u.lastFiredAt < 5) c.firing++;
      else if (u.targetId === null) {
        if (u.moving) c.relocating++;
        else c.idle++;
      }
    }
    for (const x of w.forts) {
      if ((x.kind !== 'trench' && x.kind !== 'sandbag') || !w.factions[x.owner]?.alive) continue;
      if (dist(x.pos, w.hqPos(x.owner)) > WORKS_R) continue;
      started.add(x.id);
      if (x.progress >= 1) built.add(x.id);
    }
    st.worksStarted = started.size;
    st.worksBuilt = built.size;
  };
  return { sample, result: () => ({ ...st, groupMinutesHome: Math.round(st.groupMinutesHome * 10) / 10 }) };
}
