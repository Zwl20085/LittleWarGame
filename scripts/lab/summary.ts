// Balance-lab summary: turns raw probe samples into the metrics documented in
// docs/BALANCE_LAB.md, per faction-run and pooled, plus the acceptance-band verdicts.
import type { TypeStats } from '../../src/sim/stats';
import { BINDS, type Bind, type FactionPoint } from './probe';
import type { RunResult } from './run';

/** Scalar metrics per faction-run; pooled = mean over faction-runs. Keys are stable (JSON/diff). */
export interface Metrics {
  fullness: number; fullnessMin: number;
  stockFrac: number; stockPFrac: number; stockMFrac: number; stockMinutes: number; hoard: number;
  incomePerMin: number; spendPerMin: number; spendOverIncome: number;
  bindPop: number; bindSlots: number; bindResources: number; bindFree: number; bindCaps: number; resMShare: number;
  slotsBusy: number;
  attrition: number; valueLostPerMin: number; replaceMinutes: number;
  dmgPerMin: number; retreatFrac: number; firingFrac: number; hpFrac: number;
  heldEnd: number; heldGain: number; firstCaptureMin: number; capturesPerMin: number; settlementsLost: number;
  occupyFrac: number; groupDist: number;
  armyUnits: number;
}

export const METRIC_INFO: Record<keyof Metrics, { label: string; digits: number }> = {
  fullness: { label: 'army fullness pop/popCap (mean)', digits: 2 },
  fullnessMin: { label: 'army fullness (min)', digits: 2 },
  stockFrac: { label: 'stock / cap', digits: 2 },
  stockPFrac: { label: 'manpower stock / cap_p', digits: 2 },
  stockMFrac: { label: 'munitions stock / cap_m', digits: 2 },
  stockMinutes: { label: 'stock in minutes of spend', digits: 1 },
  hoard: { label: 'hoarding: stock / 5-min spend', digits: 2 },
  incomePerMin: { label: 'income P+M /min', digits: 0 },
  spendPerMin: { label: 'spend P+M /min', digits: 0 },
  spendOverIncome: { label: 'spend / income', digits: 2 },
  bindPop: { label: 'binding: pop-capped %', digits: 0 },
  bindSlots: { label: 'binding: slots busy %', digits: 0 },
  bindResources: { label: 'binding: resources short %', digits: 0 },
  bindFree: { label: 'binding: none (could build) %', digits: 0 },
  bindCaps: { label: 'binding: unit caps %', digits: 0 },
  resMShare: { label: 'resource-short seconds missing munitions (M) %', digits: 0 },
  slotsBusy: { label: 'production slot occupancy', digits: 2 },
  attrition: { label: 'attrition: losses /min /100 units', digits: 2 },
  valueLostPerMin: { label: 'value lost P+M /min', digits: 0 },
  replaceMinutes: { label: 'replacement time: army value / spend (min)', digits: 1 },
  dmgPerMin: { label: 'damage dealt HP /min', digits: 0 },
  retreatFrac: { label: 'combat units retreating/recovering', digits: 2 },
  firingFrac: { label: 'combat units firing (last 5 s)', digits: 2 },
  hpFrac: { label: 'mean HP ratio of combat units', digits: 2 },
  heldEnd: { label: 'settlements held at end', digits: 1 },
  heldGain: { label: 'settlements gained vs start', digits: 1 },
  firstCaptureMin: { label: 'time to first capture (min)', digits: 1 },
  capturesPerMin: { label: 'captures /min (by this faction)', digits: 2 },
  settlementsLost: { label: 'settlements lost', digits: 1 },
  occupyFrac: { label: 'eagerness: occupy+garrison share', digits: 2 },
  groupDist: { label: 'eagerness: group→nearest target settlement (m)', digits: 0 },
  armyUnits: { label: 'combat units (mean)', digits: 0 },
};

/** Acceptance bands (docs/BALANCE_LAB.md §3). */
export const BANDS: ReadonlyArray<{ key: keyof Metrics; lo: number; hi: number; why: string }> = [
  { key: 'fullness', lo: 0.55, hi: 0.85, why: 'armies should not sit at the cap; losses must show' },
  { key: 'fullnessMin', lo: 0.4, hi: 0.8, why: 'offensives should dip the army' },
  { key: 'stockMinutes', lo: 0, hi: 3, why: 'stock under ~3 min of spend (no hoarding)' },
  { key: 'bindResources', lo: 35, hi: 100, why: 'resources should be the binding constraint' },
  { key: 'bindPop', lo: 0, hi: 30, why: 'population cap should rarely bind' },
  { key: 'attrition', lo: 4, hi: 15, why: 'army turns over within ~10-25 min of sustained war' },
  { key: 'firstCaptureMin', lo: 0, hi: 4, why: 'the AI should grab territory early' },
  { key: 'capturesPerMin', lo: 0.15, hi: 2, why: 'territory should keep changing hands' },
];

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function inWindow(points: FactionPoint[][], f: number, warmup: number): FactionPoint[] {
  return points.map((p) => p[f]).filter((p) => p && p.alive && p.t >= warmup * 60);
}

/** Cumulative spend `secs` before sample i (interpolated on the 30 s grid). */
function spendAgo(series: FactionPoint[], i: number, secs: number): number {
  const target = series[i].t - secs;
  for (let j = i; j >= 0; j--) if (series[j].t <= target) return series[j].spent;
  return 0;
}

export function factionMetrics(run: RunResult, f: number, warmup: number): Metrics | null {
  const all = run.probe.points.map((p) => p[f]).filter(Boolean);
  const pts = inWindow(run.probe.points, f, warmup);
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const mins = Math.max(1e-6, (last.t - first.t) / 60);
  const spendPerMin = (last.spent - first.spent) / mins;
  const stockMin = pts.map((p) => {
    const i = all.indexOf(p);
    const s5 = (p.spent - spendAgo(all, i, 300)) / 5;
    return Math.min(30, (p.p + p.m) / Math.max(1, s5));
  });
  const binds: Record<Bind, number> = { pop: 0, slots: 0, resources: 0, free: 0, caps: 0 };
  let resM = 0;
  run.probe.bind[f].forEach((row, minute) => {
    if (!row || minute < warmup) return;
    for (const b of BINDS) binds[b] += row[b];
    resM += row.resM ?? 0;
  });
  const bTot = Math.max(1, BINDS.reduce((s, b) => s + binds[b], 0));
  const caps = run.probe.captures.filter((c) => c.to === f);
  const lostSettle = run.probe.captures.filter((c) => c.from === f).length;
  const typeRows = Object.entries(run.stats.byType[f] ?? {});
  const valueLost = typeRows.reduce((s, [id, r]) => s + r.lost * (run.unitValue[id] ?? 0), 0);
  const matchMin = Math.max(1e-6, all[all.length - 1].t / 60);
  const units = mean(pts.map((p) => p.combat));
  return {
    fullness: mean(pts.map((p) => p.pop / Math.max(1, p.popCap))),
    fullnessMin: Math.min(...pts.map((p) => p.pop / Math.max(1, p.popCap))),
    stockFrac: mean(pts.map((p) => (p.p + p.m) / (p.capP + p.capM))),
    stockPFrac: mean(pts.map((p) => p.p / p.capP)),
    stockMFrac: mean(pts.map((p) => p.m / p.capM)),
    stockMinutes: mean(stockMin),
    hoard: mean(stockMin) / 5,
    incomePerMin: mean(pts.map((p) => p.incP + p.incM)),
    spendPerMin,
    spendOverIncome: spendPerMin / Math.max(1, mean(pts.map((p) => p.incP + p.incM))),
    bindPop: (100 * binds.pop) / bTot, bindSlots: (100 * binds.slots) / bTot, bindResources: (100 * binds.resources) / bTot,
    bindFree: (100 * binds.free) / bTot, bindCaps: (100 * binds.caps) / bTot,
    resMShare: (100 * resM) / Math.max(1, binds.resources),
    slotsBusy: mean(pts.map((p) => p.slotsBusy)),
    attrition: (last.lost - first.lost) / mins / Math.max(0.01, units / 100),
    valueLostPerMin: valueLost / matchMin,
    replaceMinutes: mean(pts.map((p) => p.value)) / Math.max(1, spendPerMin),
    dmgPerMin: (last.dmg - first.dmg) / mins,
    retreatFrac: mean(pts.map((p) => p.retreatFrac)),
    firingFrac: mean(pts.map((p) => p.firingFrac)),
    hpFrac: mean(pts.map((p) => p.hpFrac)),
    heldEnd: last.held,
    heldGain: last.held - run.probe.initialHeld[f],
    firstCaptureMin: caps.length ? caps[0].t / 60 : matchMin,
    capturesPerMin: caps.length / matchMin,
    settlementsLost: lostSettle,
    occupyFrac: mean(pts.map((p) => p.occupyFrac)),
    groupDist: mean(pts.map((p) => p.groupDist)),
    armyUnits: units,
  };
}

export interface Summary {
  readonly pooled: Metrics;
  readonly perSeed: Record<number, Metrics>;
  readonly perFaction: Array<{ seed: number; faction: number; m: Metrics }>;
  readonly bands: Array<{ key: keyof Metrics; value: number; lo: number; hi: number; ok: boolean; why: string }>;
  /** Pooled settlements held per faction at 0, 5, 10, … min. */
  readonly heldTimeline: Array<{ minute: number; held: number; neutral: number }>;
  /** Pooled mean per faction every 5 min (alive factions). */
  readonly econTimeline: Array<Record<'minute' | 'pop' | 'popCap' | 'p' | 'm' | 'incP' | 'incM' | 'combat' | 'held' | 'lost' | 'firing', number>>;
  /** Dominant binding label per minute (pooled), e.g. "SSRRRP". */
  readonly bindTimeline: string;
  readonly swings: number;
  readonly results: Array<{ seed: number; result: RunResult['result']; simMin: number; wallS: number }>;
  readonly types: Record<string, TypeStats>;
  readonly kills: Record<string, Record<string, number>>;
}

function meanMetrics(ms: Metrics[]): Metrics {
  const out = {} as Metrics;
  for (const k of Object.keys(METRIC_INFO) as (keyof Metrics)[]) out[k] = mean(ms.map((m) => m[k]));
  return out;
}

export function summarize(runs: readonly RunResult[], warmup: number): Summary {
  const perFaction: Summary['perFaction'] = [];
  const perSeed: Record<number, Metrics> = {};
  for (const r of runs) {
    const ms: Metrics[] = [];
    const n = r.probe.initialHeld.length;
    for (let f = 0; f < n; f++) {
      const m = factionMetrics(r, f, warmup);
      if (m) { ms.push(m); perFaction.push({ seed: r.seed, faction: f, m }); }
    }
    if (ms.length) perSeed[r.seed] = meanMetrics(ms);
  }
  const pooled = meanMetrics(perFaction.map((x) => x.m));
  const bands = BANDS.map((b) => ({ ...b, value: pooled[b.key], ok: pooled[b.key] >= b.lo && pooled[b.key] <= b.hi }));
  const heldTimeline: Summary['heldTimeline'] = [];
  const maxMin = Math.max(...runs.map((r) => Math.floor(r.simSeconds / 60)));
  for (let minute = 0; minute <= maxMin; minute += 5) {
    const held: number[] = [];
    const neutral: number[] = [];
    for (const r of runs) {
      const pt = r.probe.points.find((p) => Math.abs((p[0]?.t ?? 0) - Math.max(30, minute * 60)) < 1);
      if (!pt) continue;
      const tot = pt.reduce((s, p) => s + p.held, 0);
      held.push(mean(pt.filter((p) => p.alive).map((p) => p.held)));
      neutral.push(r.probe.settlements - tot);
    }
    if (held.length) heldTimeline.push({ minute, held: mean(held), neutral: mean(neutral) });
  }
  const econTimeline: Summary['econTimeline'] = [];
  for (let minute = 0; minute <= maxMin; minute += 5) {
    const pts = runs.flatMap((r) => r.probe.points.find((p) => Math.abs((p[0]?.t ?? 0) - Math.max(30, minute * 60)) < 1) ?? []).filter((p) => p.alive);
    if (!pts.length) continue;
    const avg = (fn: (p: FactionPoint) => number): number => mean(pts.map(fn));
    econTimeline.push({
      minute, pop: avg((p) => p.pop), popCap: avg((p) => p.popCap), p: avg((p) => p.p), m: avg((p) => p.m),
      incP: avg((p) => p.incP), incM: avg((p) => p.incM), combat: avg((p) => p.combat), held: avg((p) => p.held),
      lost: avg((p) => p.lost), firing: avg((p) => p.firingFrac),
    });
  }
  const letters: Record<Bind, string> = { pop: 'P', slots: 'S', resources: 'R', free: '.', caps: 'C' };
  let bindTimeline = '';
  for (let minute = 0; minute <= maxMin; minute++) {
    const tot: Record<Bind, number> = { pop: 0, slots: 0, resources: 0, free: 0, caps: 0 };
    for (const r of runs) for (const fb of r.probe.bind) for (const b of BINDS) tot[b] += fb[minute]?.[b] ?? 0;
    const best = BINDS.reduce((a, b) => (tot[b] > tot[a] ? b : a), 'free' as Bind);
    if (BINDS.some((b) => tot[b] > 0)) bindTimeline += letters[best];
  }
  const types: Record<string, TypeStats> = {};
  const kills: Record<string, Record<string, number>> = {};
  for (const r of runs) {
    for (const tbl of r.stats.byType) {
      for (const [type, row] of Object.entries(tbl)) {
        const o = (types[type] ??= { built: 0, lost: 0, spent: 0, shots: 0, dmgDealt: 0, dmgTaken: 0, kills: 0, killValue: 0, aliveSeconds: 0 });
        for (const key of Object.keys(row) as (keyof TypeStats)[]) o[key] += row[key];
      }
    }
    for (const [a, rowM] of Object.entries(r.stats.matrix)) for (const [v, c] of Object.entries(rowM)) ((kills[a] ??= {})[v] = (kills[a][v] ?? 0) + c.kills);
  }
  return {
    pooled, perSeed, perFaction, bands, heldTimeline, econTimeline, bindTimeline,
    swings: mean(runs.map((r) => r.probe.captures.filter((c) => c.from >= 0).length)),
    results: runs.map((r) => ({ seed: r.seed, result: r.result, simMin: r.simSeconds / 60, wallS: r.wallSeconds })),
    types, kills,
  };
}
