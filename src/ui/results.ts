import type { TimelinePoint } from '../sim/stats';
import type { World } from '../sim/world';
import { fmtTime, h } from './dom';
import { lang, t } from './i18n';
import { factionLabel } from './labels';

type LedgerMetric = 'held' | 'value' | 'income';

function renderTimelineChart(world: World): HTMLElement | null {
  const tl = world.stats?.timeline ?? [];
  if (tl.length < 2) return null;
  let metric: LedgerMetric = 'held';
  const canvas = h('canvas', {
    width: 440,
    height: 120,
    style: 'width:100%;height:120px;display:block;margin:6px 0;background:rgba(255,252,242,0.55);border:1px solid rgba(90,74,50,0.25);border-radius:3px',
  }) as HTMLCanvasElement;

  const valOf = (pt: TimelinePoint['f'][number], m: LedgerMetric): number =>
    m === 'held' ? pt.held : m === 'value' ? pt.value : pt.incP + pt.incM;

  const draw = (): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const padL = 34;
    const padR = 10;
    const padT = 10;
    const padB = 18;
    const pw = W - padL - padR;
    const ph = H - padT - padB;
    let maxY = 1;
    for (const step of tl) {
      for (const f of step.f) maxY = Math.max(maxY, valOf(f, metric));
    }
    ctx.strokeStyle = 'rgba(90,74,50,0.18)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 2; g++) {
      const y = padT + (ph * g) / 2;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#5a4a32';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(maxY)), padL - 4, padT + 8);
    ctx.fillText('0', padL - 4, padT + ph);
    ctx.textAlign = 'left';
    ctx.fillText(fmtTime(tl[0].t), padL, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(tl[tl.length - 1].t), W - padR, H - 4);

    world.factions.forEach((fac, fi) => {
      ctx.strokeStyle = fac.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      tl.forEach((step, idx) => {
        const fp = step.f[fi];
        if (!fp) return;
        const x = padL + (idx / (tl.length - 1)) * pw;
        const y = padT + ph - (valOf(fp, metric) / maxY) * ph;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  };

  const zh = lang() === 'zh';
  const labels: Record<LedgerMetric, string> = zh
    ? { held: '据点曲线', value: '兵力价值', income: '产能曲线' }
    : { held: 'Settlements', value: 'Army Value', income: 'Income' };
  const tabs = h('div', { class: 'row', style: 'gap:4px;margin-top:8px' });
  const btns: Record<LedgerMetric, HTMLButtonElement> = {
    held: h('button', { class: 'btn primary' }, labels.held) as HTMLButtonElement,
    value: h('button', { class: 'btn' }, labels.value) as HTMLButtonElement,
    income: h('button', { class: 'btn' }, labels.income) as HTMLButtonElement,
  };
  (['held', 'value', 'income'] as const).forEach((m) => {
    btns[m].onclick = () => {
      metric = m;
      (['held', 'value', 'income'] as const).forEach((k) => btns[k].classList.toggle('primary', k === m));
      draw();
    };
    tabs.append(btns[m]);
  });
  requestAnimationFrame(draw);
  return h('div', { class: 'results-ledger' }, tabs, canvas);
}

/** End-of-match report: cause, duration, per-faction production/loss/spend (VISUAL_UX §9). */
export function showResults(root: HTMLElement, world: World, playerId: number, spectator: boolean, actions: { again: () => void; menu: () => void; watch: () => void }): HTMLElement {
  const r = world.result;
  let headline = t('res.timeout');
  if (r) {
    if (r.reason === 'mutual') headline = t('res.draw');
    else if (!spectator) headline = r.winners.includes(playerId) ? t('res.victory') : t('res.defeat');
    else headline = t('res.winner', { f: r.winners.map((f) => factionLabel(world, f)).join(' / ') });
  } else {
    headline = t('res.eliminatedSpectate');
  }
  const resolveOn = !!world.data.rules.victory.resolve_enabled;
  const rows = world.factions.map((f) =>
    h('tr', { class: f.alive ? '' : 'dead' },
      h('td', {}, h('span', { class: 'roman', style: `background:${f.color}` }, f.roman), ' ', factionLabel(world, f.id)),
      h('td', { class: 'num' }, String(f.producedUnits)),
      h('td', { class: 'num' }, String(f.lostUnits)),
      h('td', { class: 'num' }, `${Math.round(f.spentTotalP)}P / ${Math.round(f.spentTotalM)}M`),
      h('td', { class: 'num' }, f.alive ? String(resolveOn ? Math.round(f.resolve) : world.objectives.filter((o) => o.owner === f.id).length) : '✕')));
  const chart = renderTimelineChart(world);
  const el = h('div', { class: 'results' },
    h('div', { class: 'results-card panel' },
      h('div', { class: 'stamp big' }, headline),
      h('div', { class: 'sub' }, `${t('res.duration')} ${fmtTime(world.time)}`),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('res.produced')), h('th', {}, t('res.lost')), h('th', {}, t('res.spent')), h('th', {}, t(resolveOn ? 'res.resolve' : 'res.held')))),
        h('tbody', {}, ...rows)),
      chart,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: actions.again }, t('res.again')),
        !r ? h('button', { class: 'btn', onclick: () => { el.remove(); actions.watch(); } }, t('res.spectate')) : null,
        h('button', { class: 'btn', onclick: actions.menu }, t('res.menu')))));
  root.append(el);
  return el;
}
