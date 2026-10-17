// Doctrine lab report (scripts/lab30/doctrine.ts): win matrix, curves, distinctiveness, pacing.
import { mdTable } from './common';

const DOCTRINES = ['builder', 'blitz', 'attrition', 'maneuver'] as const;
const CURVE_MIN = [5, 10, 15, 20, 25, 30, 35, 40, 45];

export interface Sample { t: number; held: number[]; army: number[]; invest: number[]; spent: number[] }

export interface MatchOut {
  suite: 'duel' | 'ffa';
  seed: number;
  minutes: number;
  doctrines: string[];
  total: number;
  winners: number[];
  eliminatedAt: (number | null)[];
  samples: Sample[];
  firstContact: number;
  dirShare: Record<string, number>[];
  roles: { raid: number; retreat: number; occupy: number }[];
  n: number;
}

/** Territory and army as a multiple of the fair share (1 = 1/n of the total) at sample s. */
function shares(m: MatchOut, s: Sample): { terr: number[]; army: number[] } {
  const ta = s.army.reduce((a, b) => a + b, 0) || 1;
  return { terr: s.held.map((h) => (h / Math.max(1, m.total)) * m.n), army: s.army.map((v) => (v / ta) * m.n) };
}

const atMin = (m: MatchOut, min: number): Sample | undefined => {
  let best: Sample | undefined;
  for (const s of m.samples) if (s.t <= min * 60 + 1) best = s;
  return best;
};

/** Placement 0 = best: the winner; then by elimination (later = better); the living by territory + army share. */
function placements(m: MatchOut): number[] {
  const last = m.samples[m.samples.length - 1];
  const sh = last ? shares(m, last) : { terr: m.doctrines.map(() => 1), army: m.doctrines.map(() => 1) };
  const score = m.doctrines.map((_, i) => {
    if (m.winners.includes(i)) return 1e9;
    const e = m.eliminatedAt[i];
    if (e !== null) return -1e9 + e;
    return 0.5 * sh.terr[i] + 0.5 * sh.army[i];
  });
  const order = score.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  const out = new Array<number>(m.n);
  order.forEach((x, k) => (out[x.i] = k));
  return out;
}

/** Duel outcome for slot i: 'W' / 'D' / 'L' (alive-alive: a 10 % margin on the combined share decides). */
function duel(m: MatchOut, i: number): 'W' | 'D' | 'L' {
  if (m.winners.length === 1) return m.winners[0] === i ? 'W' : 'L';
  const last = m.samples[m.samples.length - 1];
  if (!last) return 'D';
  const sh = shares(m, last);
  const sc = sh.terr.map((t, k) => 0.5 * t + 0.5 * sh.army[k]);
  const me = sc[i];
  const them = sc[1 - i];
  return me > them * 1.1 ? 'W' : them > me * 1.1 ? 'L' : 'D';
}

interface Fp { d: string; v: number[] }

function fingerprint(m: MatchOut, i: number): number[] {
  const at = (min: number): { terr: number; army: number } => {
    const s = atMin(m, min);
    if (!s) return { terr: 0, army: 0 };
    const sh = shares(m, s);
    return { terr: sh.terr[i], army: sh.army[i] };
  };
  const last = m.samples[m.samples.length - 1];
  const inv = last ? last.invest[i] / Math.max(1, last.spent[i]) : 0;
  const ds = m.dirShare[i] ?? {};
  const r = m.roles[i];
  return [at(10).terr, at(20).terr, at(30).terr, at(10).army, at(20).army, at(30).army, inv,
    ds.offensive ?? 0, (ds.defend ?? 0) + (ds.fortify ?? 0) + (ds.contract ?? 0), ds.advance ?? 0, r.raid, r.retreat, r.occupy];
}

const FP_NAMES = ['terr@10', 'terr@20', 'terr@30', 'army@10', 'army@20', 'army@30', 'invest share', 'offensive time', 'defensive time', 'advance time', 'raiding', 'retreating', 'occupying'];

const dist = (a: number[], b: number[]): number => Math.sqrt(a.reduce((s, x, k) => s + (x - b[k]) ** 2, 0));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f2 = (x: number): string => x.toFixed(2);
const pct = (x: number): string => `${Math.round(x * 100)} %`;
const mmss = (s: number): string => (s < 0 ? '–' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

function distinctiveness(fps: Fp[]): { ratio: number; accuracy: number; centroids: Map<string, number[]>; between: number; within: number } {
  const k = fps[0]?.v.length ?? 0;
  const mu = Array.from({ length: k }, (_, j) => mean(fps.map((f) => f.v[j])));
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(mean(fps.map((f) => (f.v[j] - mu[j]) ** 2))) || 1);
  const z = fps.map((f) => ({ d: f.d, v: f.v.map((x, j) => (x - mu[j]) / sd[j]) }));
  const centroids = new Map<string, number[]>();
  for (const d of DOCTRINES) {
    const own = z.filter((f) => f.d === d);
    if (own.length) centroids.set(d, Array.from({ length: k }, (_, j) => mean(own.map((f) => f.v[j]))));
  }
  const cs = [...centroids.entries()];
  const pairs: number[] = [];
  for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) pairs.push(dist(cs[a][1], cs[b][1]));
  const within = mean(z.map((f) => dist(f.v, centroids.get(f.d)!)));
  let hit = 0;
  for (const f of z) {
    const best = cs.reduce((x, y) => (dist(f.v, y[1]) < dist(f.v, x[1]) ? y : x));
    if (best[0] === f.d) hit++;
  }
  return { ratio: mean(pairs) / Math.max(1e-9, within), accuracy: hit / Math.max(1, z.length), centroids, between: mean(pairs), within };
}

export function analyse(outs: MatchOut[], meta: { tag: string; off: boolean; wallS: number }): { md: string; json: unknown } {
  const lines: string[] = [`# Doctrine lab — ${meta.tag}${meta.off ? ' (doctrine effects OFF)' : ''}`, '',
    `${outs.length} matches, wall ${Math.round(meta.wallS)} s. Shares are multiples of the fair share (1 = 1/n of the total).`, ''];
  // Win matrix (duels).
  const duels = outs.filter((m) => m.suite === 'duel');
  const cell = new Map<string, { w: number; d: number; l: number }>();
  const tally = new Map<string, { w: number; d: number; l: number; n: number }>(DOCTRINES.map((d) => [d, { w: 0, d: 0, l: 0, n: 0 }]));
  for (const m of duels) {
    for (let i = 0; i < 2; i++) {
      const r = duel(m, i);
      const key = `${m.doctrines[i]}|${m.doctrines[1 - i]}`;
      const c = cell.get(key) ?? { w: 0, d: 0, l: 0 };
      if (r === 'W') c.w++; else if (r === 'D') c.d++; else c.l++;
      cell.set(key, c);
      const t = tally.get(m.doctrines[i])!;
      t.n++;
      if (r === 'W') t.w++; else if (r === 'D') t.d++; else t.l++;
    }
  }
  if (duels.length) {
    lines.push('## Win matrix (1v1, row vs column: W-D-L)', '');
    lines.push(mdTable(['', ...DOCTRINES], DOCTRINES.map((a) => [a, ...DOCTRINES.map((b) => {
      if (a === b) return '–';
      const c = cell.get(`${a}|${b}`);
      return c ? `${c.w}-${c.d}-${c.l}` : '';
    })])), '');
  }
  // FFA placements.
  const ffas = outs.filter((m) => m.suite === 'ffa');
  const ffaPlace = new Map<string, number[]>(DOCTRINES.map((d) => [d, []]));
  for (const m of ffas) placements(m).forEach((p, i) => ffaPlace.get(m.doctrines[i])?.push(p));
  for (const m of ffas) {
    const p = placements(m);
    for (let i = 0; i < m.n; i++) {
      const t = tally.get(m.doctrines[i])!;
      t.n++;
      if (p[i] === 0) t.w++; else if (p[i] === m.n - 1) t.l++; else t.d++;
    }
  }
  lines.push('## Overall (duels + FFA: 1st place = win, last = loss)', '');
  lines.push(mdTable(['doctrine', 'matches', 'win', 'draw / middle', 'loss', 'win %', 'loss %', 'FFA places (1 = best)'],
    DOCTRINES.map((d) => { const t = tally.get(d)!; return [d, t.n, t.w, t.d, t.l, pct(t.w / Math.max(1, t.n)), pct(t.l / Math.max(1, t.n)), (ffaPlace.get(d) ?? []).map((x) => x + 1).join(', ')]; }),
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l']), '');
  // Curves.
  const curves = new Map<string, { terr: number[]; army: number[] }>();
  for (const d of DOCTRINES) {
    const terr: number[] = [];
    const army: number[] = [];
    for (const min of CURVE_MIN) {
      const tv: number[] = [];
      const av: number[] = [];
      for (const m of outs) {
        const s = atMin(m, min);
        if (!s || s.t < min * 60 - 31) continue;
        const sh = shares(m, s);
        m.doctrines.forEach((x, i) => { if (x === d) { tv.push(sh.terr[i]); av.push(sh.army[i]); } });
      }
      terr.push(mean(tv));
      army.push(mean(av));
    }
    curves.set(d, { terr, army });
  }
  lines.push('## Territory curves (held settlements, × fair share; all matches)', '');
  lines.push(mdTable(['doctrine', ...CURVE_MIN.map((x) => `${x}′`)], DOCTRINES.map((d) => [d, ...curves.get(d)!.terr.map(f2)])), '');
  lines.push('## Army value curves (× fair share)', '');
  lines.push(mdTable(['doctrine', ...CURVE_MIN.map((x) => `${x}′`)], DOCTRINES.map((d) => [d, ...curves.get(d)!.army.map(f2)])), '');
  // Curve distance.
  const cd = (a: string, b: string): number => {
    const x = curves.get(a)!;
    const y = curves.get(b)!;
    return mean(x.terr.map((v, k) => Math.abs(v - y.terr[k]) + Math.abs(x.army[k] - y.army[k])));
  };
  lines.push('## Distinctiveness', '', '### Mean curve distance (Σ |Δterritory| + |Δarmy| per sample, × fair share)', '');
  lines.push(mdTable(['', ...DOCTRINES], DOCTRINES.map((a) => [a, ...DOCTRINES.map((b) => (a === b ? '–' : f2(cd(a, b))))])), '');
  const fps: Fp[] = outs.flatMap((m) => m.doctrines.map((d, i) => ({ d, v: fingerprint(m, i) })));
  const dis = distinctiveness(fps);
  lines.push(`Behaviour fingerprints (${FP_NAMES.join(', ')}; z-scored): between-doctrine centroid distance ${f2(dis.between)}, ` +
    `within-doctrine spread ${f2(dis.within)}, **ratio ${f2(dis.ratio)}**; nearest-centroid classification **${pct(dis.accuracy)}** (chance 25 %).`, '');
  const raw = new Map<string, number[]>();
  for (const d of DOCTRINES) {
    const own = fps.filter((f) => f.d === d);
    raw.set(d, FP_NAMES.map((_, j) => mean(own.map((f) => f.v[j]))));
  }
  lines.push(mdTable(['feature', ...DOCTRINES], FP_NAMES.map((n, j) => [n, ...DOCTRINES.map((d) => f2(raw.get(d)?.[j] ?? 0))])), '');
  // Pacing.
  lines.push('## Pacing', '');
  const pace = (ms: MatchOut[]): (string | number)[] => {
    const hours = ms.reduce((a, m) => a + m.minutes / 60, 0);
    const elim = ms.reduce((a, m) => a + m.eliminatedAt.filter((e) => e !== null).length, 0);
    const fc = ms.map((m) => m.firstContact).filter((x) => x >= 0).sort((a, b) => a - b);
    const firstFall = ms.map((m) => Math.min(...m.eliminatedAt.filter((e): e is number => e !== null))).filter((x) => Number.isFinite(x));
    return [ms.length, f2(hours), elim, f2(elim / Math.max(1e-9, hours)), mmss(fc[Math.floor(fc.length / 2)] ?? -1), firstFall.length ? mmss(mean(firstFall)) : '–', ms.filter((m) => m.winners.length > 0).length];
  };
  lines.push(mdTable(['suite', 'matches', 'hours', 'eliminations', 'elim / h', 'first contact (median)', 'first capital lost (mean)', 'decided'],
    [['duel', ...pace(duels)], ['ffa', ...pace(ffas)], ['all', ...pace(outs)]]), '');
  lines.push('## Matches', '');
  lines.push(mdTable(['suite', 'seed', 'doctrines', 'result', 'first contact', 'eliminated'],
    outs.map((m) => [m.suite, m.seed, m.doctrines.join(' / '), m.winners.length ? `won by ${m.winners.map((w) => m.doctrines[w]).join('+')} ${mmss(m.minutes * 60)}` : m.suite === 'duel' ? `${duel(m, 0)} for ${m.doctrines[0]}` : `places ${placements(m).map((p) => p + 1).join('/')}`,
      mmss(m.firstContact), m.eliminatedAt.map((e, i) => (e !== null ? `${m.doctrines[i]} ${mmss(e)}` : '')).filter(Boolean).join(', ')])), '');
  const json = { meta, tally: Object.fromEntries(tally), curves: Object.fromEntries(curves), distinct: { ratio: dis.ratio, accuracy: dis.accuracy, between: dis.between, within: dis.within, features: FP_NAMES, means: Object.fromEntries(raw) }, matches: outs.map((m) => ({ ...m, samples: undefined })) };
  return { md: lines.join('\n'), json };
}
