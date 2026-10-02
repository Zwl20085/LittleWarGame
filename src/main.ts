import './ui/styles.css';
import { loadGameData } from './data';
import type { GameData } from './data/types';
import { Game } from './game';
import type { MatchConfig } from './sim/types';
import { h } from './ui/dom';
import { lang, setLang, t } from './ui/i18n';
import { showTitle } from './ui/menu';
import { applyUiScale } from './ui/settings';

const root = document.getElementById('app')!;
setLang(lang());
applyUiScale();

let data: GameData;
try {
  data = loadGameData();
} catch (err: unknown) {
  // Data validation failure: show which row/field, with no silent fallback (AGENT_HANDOFF §2).
  const msg = err instanceof Error ? err.message : String(err);
  root.append(h('div', { class: 'fatal panel' }, h('h2', {}, 'docs/data validation failed'), h('pre', {}, msg)));
  throw err;
}

let game: Game | null = null;
let closeTitle: (() => void) | null = null;

function menu(): void {
  game?.dispose();
  game = null;
  closeTitle = showTitle(root, data, start);
}

function start(cfg: MatchConfig): void {
  // Dispose the title screen (and its background battle) before building the real match.
  closeTitle?.();
  closeTitle = null;
  game?.dispose();
  game = null;
  const loading = h('div', { class: 'loading' }, h('div', { class: 'loading-k' }, t('setup.loading')), h('div', { class: 'loading-bar' }));
  root.append(loading);
  // Let the loading label paint before the heavy terrain build.
  setTimeout(() => {
    loading.remove();
    try {
      game = new Game(root, data, cfg, {
        again: () => start({ ...cfg, seed: Math.floor(Math.random() * 1e6) }),
        menu,
      });
      (window as unknown as { __game: Game }).__game = game;
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      root.append(h('div', { class: 'fatal panel' }, h('h2', {}, t('err.start')), h('pre', {}, msg),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => { root.innerHTML = ''; menu(); } }, t('res.menu')),
          h('button', { class: 'btn', onclick: () => location.reload() }, t('err.reload')))));
      throw err;
    }
  }, 40);
}

// `?quick` skips the title (screenshots / iteration): `&map=1v1|4|gen`, `&size=large`, `&fog`, `&seed=`, `&spectate`.
const params = new URLSearchParams(location.search);
if (params.has('quick')) {
  const m = params.get('map');
  const mapId: MatchConfig['mapId'] = m === '1v1' ? 'greystone_pinecreek' : m === 'gen' ? 'generated' : 'four_cities';
  start({
    mapId,
    mapSize: params.get('size') === 'large' ? 'large' : 'medium',
    factions: mapId === 'greystone_pinecreek' ? 2 : Number(params.get('factions') ?? 4),
    infoMode: params.get('fog') !== null ? 'fog' : 'open',
    seed: Number(params.get('seed') ?? 7),
    difficulty: 'normal',
    playerSlot: 0,
    spectate: params.has('spectate'),
  });
} else menu();
