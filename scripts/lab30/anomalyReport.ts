// Markdown for the anomaly lab: per-seed count tables, per-class totals with the top causes, tank
// ammunition lines and the 10 worst episodes with their timelines.
import { CLASSES, episodeScore, type AnomalyClass, type Episode } from './anomalyProbe';
import type { AnomalyRun } from './anomaly';
import { mdTable } from './common';

const mmss = (t: number): string => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1)} %` : '-');

export function anomalyMarkdown(runs: readonly AnomalyRun[], meta: { label: string; src: string; minutes: number }): string {
  const L: string[] = [];
  const runName = (r: AnomalyRun): string => `s${r.seed} ${r.mapSize}`;
  L.push(`# Anomaly lab — ${meta.label}`, '', `src \`${meta.src}\`, 4-FFA, ${meta.minutes} min cap, window 30 s. Counts are **episodes** (consecutive flagged windows of one object / cluster); "unit-windows" sums the units flagged in every window.`, '');
  L.push('## Episodes per run', '');
  L.push(mdTable(['class', ...runs.map(runName), 'total'], CLASSES.map((c) => [c, ...runs.map((r) => r.counts[c].episodes), runs.reduce((a, r) => a + r.counts[c].episodes, 0)]), ['l', ...runs.map(() => 'r' as const), 'r']));
  L.push('', '## Totals per class', '');
  L.push(mdTable(['class', 'episodes', 'high sev.', 'flagged windows', 'unit-windows', 'top causes (episodes)'], CLASSES.map((c) => {
    const causes: Record<string, number> = {};
    for (const r of runs) for (const [k, n] of Object.entries(r.counts[c].causes)) causes[k] = (causes[k] ?? 0) + n;
    const top = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ×${n}`).join('; ') || '-';
    const sum = (k: 'episodes' | 'high' | 'records' | 'unitWindows'): number => runs.reduce((a, r) => a + r.counts[c][k], 0);
    return [c, sum('episodes'), sum('high'), sum('records'), sum('unitWindows'), top];
  }), ['l', 'r', 'r', 'r', 'r', 'l']));
  const ts = runs.reduce((a, r) => ({ samples: a.samples + r.tank.samples, low: a.low + r.tank.low, lowIdle: a.lowIdle + r.tank.lowIdle, deadZone: a.deadZone + r.tank.deadZone }), { samples: 0, low: 0, lowIdle: 0, deadZone: 0 });
  const cs = runs.reduce((a, r) => ({ samples: a.samples + r.combat.samples, low: a.low + r.combat.low }), { samples: 0, low: 0 });
  L.push('', '## Ammunition (after 5 min, every 10 s)', '');
  L.push(mdTable(['metric', 'value'], [
    ['combat unit-samples with ammo < 0.15', pct(cs.low, cs.samples)],
    ['tank-samples with ammo < 0.15', pct(ts.low, ts.samples)],
    ['… and not rearming', pct(ts.lowIdle, ts.samples)],
    ['tank-samples that cannot fire a shell but are above rearm_below', pct(ts.deadZone, ts.samples)],
  ], ['l', 'r']));
  L.push('', '## Runs', '');
  L.push(mdTable(['run', 'result', 'sim min', 'wall s'], runs.map((r) => [runName(r), r.result, r.simMinutes.toFixed(1), r.wallS.toFixed(0)]), ['l', 'l', 'r', 'r']));
  L.push('', '## Worst 10 episodes', '');
  const all = runs.flatMap((r) => r.episodes.map((e) => ({ run: runName(r), e })));
  all.sort((a, b) => episodeScore(b.e) - episodeScore(a.e) || a.e.id - b.e.id);
  all.slice(0, 10).forEach(({ run, e }, i) => L.push(...episodeBlock(i + 1, run, e)));
  return L.join('\n');
}

function episodeBlock(k: number, run: string, e: Episode): string[] {
  const causes = Object.entries(e.causes).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ×${n}`).join('; ');
  const out = [`### ${k}. ${e.cls as AnomalyClass} — F${e.faction}, ${run}, ${mmss(e.startT)}–${mmss(e.endT)} (${e.severity}, peak ${e.peakSize})`, '',
    `at (${e.pos.x}, ${e.pos.z}); causes: ${causes}; units ${e.unitIds.slice(0, 16).join(',')}${e.unitIds.length > 16 ? '…' : ''}`, ''];
  const tl = e.timeline.length > 12 ? [...e.timeline.slice(0, 6), ...e.timeline.slice(-6)] : e.timeline;
  out.push(mdTable(['t', 'size', 'pos', 'cause', 'detail'], tl.map((s) => [mmss(s.t), s.size, `${s.pos.x},${s.pos.z}`, s.cause, Object.entries(s.detail).map(([a, b]) => `${a} ${b}`).join(', ')]), ['l', 'r', 'l', 'l', 'l']), '');
  return out;
}
