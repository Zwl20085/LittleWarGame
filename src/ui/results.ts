import type { World } from '../sim/world';
import { fmtTime, h } from './dom';
import { t } from './i18n';
import { factionLabel } from './labels';

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
  const el = h('div', { class: 'results' },
    h('div', { class: 'results-card panel' },
      h('div', { class: 'stamp big' }, headline),
      h('div', { class: 'sub' }, `${t('res.duration')} ${fmtTime(world.time)}`),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('res.produced')), h('th', {}, t('res.lost')), h('th', {}, t('res.spent')), h('th', {}, t(resolveOn ? 'res.resolve' : 'res.held')))),
        h('tbody', {}, ...rows)),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: actions.again }, t('res.again')),
        !r ? h('button', { class: 'btn', onclick: () => { el.remove(); actions.watch(); } }, t('res.spectate')) : null,
        h('button', { class: 'btn', onclick: actions.menu }, t('res.menu')))));
  root.append(el);
  return el;
}
