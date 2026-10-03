// Balance-lab report: Markdown tables for one variant, and the A/B diff table.
import { METRIC_INFO, type Metrics, type Summary } from './summary';

const fmt = (v: number, d: number): string => (Number.isFinite(v) ? v.toFixed(d) : '-');
const KEYS = Object.keys(METRIC_INFO) as (keyof Metrics)[];

export interface ReportMeta {
  readonly label: string;
  readonly seeds: readonly number[];
  readonly minutes: number;
  readonly warmup: number;
  readonly mapId: string;
  readonly sets: readonly string[];
  readonly srcRoot: string;
  readonly date: string;
}

function metricsTable(s: Summary): string[] {
  const seeds = Object.keys(s.perSeed).map(Number);
  const out = [
    `| metric | pooled | ${seeds.map((x) => `seed ${x}`).join(' | ')} |`,
    `|---|---:|${seeds.map(() => '---:').join('|')}|`,
  ];
  for (const k of KEYS) {
    const { label, digits } = METRIC_INFO[k];
    out.push(`| ${label} | **${fmt(s.pooled[k], digits)}** | ${seeds.map((x) => fmt(s.perSeed[x][k], digits)).join(' | ')} |`);
  }
  return out;
}

function bandsTable(s: Summary): string[] {
  const out = ['| band | value | target | verdict | why |', '|---|---:|---|---|---|'];
  for (const b of s.bands) {
    const d = METRIC_INFO[b.key].digits;
    out.push(`| ${METRIC_INFO[b.key].label} | ${fmt(b.value, d)} | ${b.lo}–${b.hi} | ${b.ok ? 'OK' : '**OUT**'} | ${b.why} |`);
  }
  return out;
}

function typesTable(s: Summary): string[] {
  const out = ['| type | built | lost | K/D | kills | dmg/min/unit | value killed / spent | share of dmg |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
  const total = Object.values(s.types).reduce((a, r) => a + r.dmgDealt, 0) || 1;
  for (const [type, r] of Object.entries(s.types).sort((a, b) => b[1].dmgDealt - a[1].dmgDealt)) {
    const perMin = r.aliveSeconds > 0 ? r.dmgDealt / (r.aliveSeconds / 60) : 0;
    out.push(`| ${type} | ${r.built} | ${r.lost} | ${r.lost ? (r.kills / r.lost).toFixed(2) : '-'} | ${r.kills} | ${perMin.toFixed(1)} | ${r.spent ? (r.killValue / r.spent).toFixed(2) : '-'} | ${((100 * r.dmgDealt) / total).toFixed(1)}% |`);
  }
  return out;
}

function killTable(s: Summary): string[] {
  const victims = [...new Set(Object.values(s.kills).flatMap((r) => Object.keys(r)))].sort();
  const out = [`| attacker \\ victim | ${victims.join(' | ')} |`, `|---|${victims.map(() => '---:').join('|')}|`];
  for (const a of Object.keys(s.kills).sort()) out.push(`| ${a} | ${victims.map((v) => s.kills[a][v] ?? 0).join(' | ')} |`);
  return out;
}

function econTable(s: Summary): string[] {
  const out = ['| min | pop / cap | P stock | M stock | P inc/min | M inc/min | combat units | settlements | lost (cum.) | firing |', '|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of s.econTimeline) {
    out.push(`| ${r.minute} | ${r.pop.toFixed(0)} / ${r.popCap.toFixed(0)} | ${r.p.toFixed(0)} | ${r.m.toFixed(0)} | ${r.incP.toFixed(0)} | ${r.incM.toFixed(0)} | ${r.combat.toFixed(0)} | ${r.held.toFixed(1)} | ${r.lost.toFixed(0)} | ${r.firing.toFixed(2)} |`);
  }
  return out;
}

export function variantMarkdown(title: string, s: Summary): string[] {
  const res = s.results.map((r) => `seed ${r.seed}: ${r.simMin.toFixed(1)} min in ${r.wallS.toFixed(0)} s, ${r.result ? `${r.result.reason} (winner ${r.result.winners.join('/')}) at ${r.result.minute.toFixed(1)} min` : 'no winner'}`);
  return [
    `## ${title}`, '',
    ...res.map((r) => `- ${r}`), '',
    '### Acceptance bands', '', ...bandsTable(s), '',
    '### Metrics (after warm-up; pooled = mean over faction-runs)', '', ...metricsTable(s), '',
    '### Timeline (pooled mean per faction)', '', ...econTable(s), '',
    `Binding constraint by minute (P = pop cap, S = slots busy, R = resources short, . = could build, C = unit caps): \`${s.bindTimeline}\``, '',
    `Territory (mean settlements per faction / neutral left): ${s.heldTimeline.map((h) => `${h.minute}′ ${h.held.toFixed(1)}/${h.neutral.toFixed(1)}`).join(' · ')}; owner swings between factions per match: ${s.swings.toFixed(1)}`, '',
    '### Unit ledger (all factions, all seeds)', '', ...typesTable(s), '',
    '### Kills: attacker × victim', '', ...killTable(s), '',
  ];
}

export function diffMarkdown(base: Summary, variant: Summary): string[] {
  const out = ['## A/B diff (variant − baseline, same seeds)', '', '| metric | baseline | variant | Δ | Δ% |', '|---|---:|---:|---:|---:|'];
  for (const k of KEYS) {
    const { label, digits } = METRIC_INFO[k];
    const a = base.pooled[k];
    const b = variant.pooled[k];
    const pct = Math.abs(a) > 1e-9 ? `${(((b - a) / Math.abs(a)) * 100).toFixed(0)}%` : '-';
    out.push(`| ${label} | ${fmt(a, digits)} | ${fmt(b, digits)} | ${(b - a >= 0 ? '+' : '') + fmt(b - a, digits)} | ${pct} |`);
  }
  const bandRows = variant.bands.map((b, i) => `| ${METRIC_INFO[b.key].label} | ${base.bands[i].ok ? 'OK' : 'OUT'} | ${b.ok ? 'OK' : 'OUT'} |`);
  return [...out, '', '| band | baseline | variant |', '|---|---|---|', ...bandRows, ''];
}

export function headerMarkdown(meta: ReportMeta): string[] {
  return [
    `# Balance lab — ${meta.label}`, '',
    `- date: ${meta.date}`,
    `- seeds: ${meta.seeds.join(', ')} · ${meta.minutes} min · map ${meta.mapId} · warm-up ${meta.warmup} min excluded from rates`,
    `- overrides: ${meta.sets.length ? meta.sets.map((s) => `\`${s}\``).join(' ') : '(none)'}`,
    `- source: ${meta.srcRoot}`, '',
  ];
}

/** Short console digest: bands + a few headline numbers. */
export function consoleDigest(name: string, s: Summary): string {
  const p = s.pooled;
  const bands = s.bands.map((b) => `${b.ok ? 'ok ' : 'OUT'} ${b.key}=${fmt(b.value, METRIC_INFO[b.key].digits)}`).join('  ');
  return `[${name}] fullness ${fmt(p.fullness, 2)} stockMin ${fmt(p.stockMinutes, 1)} bind P/S/R/free ${fmt(p.bindPop, 0)}/${fmt(p.bindSlots, 0)}/${fmt(p.bindResources, 0)}/${fmt(p.bindFree, 0)} attr ${fmt(p.attrition, 2)} dmg/min ${fmt(p.dmgPerMin, 0)} held ${fmt(p.heldEnd, 1)} cap/min ${fmt(p.capturesPerMin, 2)} occ ${fmt(p.occupyFrac, 2)} dist ${fmt(p.groupDist, 0)}\n  bind/min ${s.bindTimeline}\n  ${bands}`;
}
