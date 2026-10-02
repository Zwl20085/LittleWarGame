import type { GameData } from '../data/types';
import { Game } from '../game';
import type { Difficulty, InfoMode, MatchConfig } from '../sim/types';
import { CinematicDirector } from './cinematic';
import { fmtTime, h, setText } from './dom';
import { lang, onLangChange, setLang, t } from './i18n';
import { settingsFields } from './pause';
import { prefersReducedMotion } from './settings';

const STORE_KEY = 'lwg.setup';
const WARMUP_SECONDS = 160;
/** Main-thread budget per warm-up slice, and the wall-clock cap before the battle is revealed anyway. */
const WARMUP_SLICE_MS = 60;
const WARMUP_MAX_MS = 15000;

type MapChoice = MatchConfig['mapId'];
type MapSize = NonNullable<MatchConfig['mapSize']>;

interface SetupState {
  readonly mapId: MapChoice;
  readonly mapSize: MapSize;
  readonly factions: number;
  readonly difficulty: Difficulty;
  readonly infoMode: InfoMode;
  readonly seed: number;
  readonly spectate: boolean;
}

const randomSeed = (): number => Math.floor(Math.random() * 1e6);

function loadState(): SetupState {
  const def: SetupState = { mapId: 'generated', mapSize: 'medium', factions: 4, difficulty: 'normal', infoMode: 'open', seed: randomSeed(), spectate: false };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return def;
    const v = JSON.parse(raw) as Partial<SetupState>;
    const mapId: MapChoice = v.mapId === 'four_cities' || v.mapId === 'greystone_pinecreek' ? v.mapId : 'generated';
    return {
      ...def,
      mapId,
      mapSize: v.mapSize === 'large' ? 'large' : 'medium',
      factions: Math.min(4, Math.max(2, Number(v.factions) || 4)),
      difficulty: v.difficulty === 'easy' || v.difficulty === 'hard' ? v.difficulty : 'normal',
      infoMode: v.infoMode === 'fog' ? 'fog' : 'open',
      spectate: !!v.spectate,
    };
  } catch {
    return def;
  }
}

function saveState(s: SetupState): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable — setup still works for this session
  }
}

function maxFactions(mapId: MapChoice): number {
  return mapId === 'greystone_pinecreek' ? 2 : 4;
}

function toConfig(s: SetupState): MatchConfig {
  const factions = Math.min(maxFactions(s.mapId), s.factions);
  return { mapId: s.mapId, mapSize: s.mapSize, factions, infoMode: s.infoMode, seed: s.seed, difficulty: s.difficulty, playerSlot: 0, spectate: s.spectate };
}

/** Background battle for the title screen: a real all-AI match framed by a cinematic camera. */
class AttractBattle {
  private game: Game | null = null;
  private timer = 0;
  private disposed = false;

  constructor(private readonly host: HTMLElement, dip: HTMLElement, data: GameData, onLive: () => void, private readonly onProgress: (f: number) => void) {
    const cfg: MatchConfig = { mapId: 'generated', mapSize: 'medium', factions: 4, infoMode: 'open', seed: randomSeed(), difficulty: 'normal', playerSlot: 0, spectate: true };
    try {
      this.game = new Game(host, data, cfg, { again: () => undefined, menu: () => undefined }, { attract: true });
    } catch (err: unknown) {
      // The title screen still works over its painted backdrop; log for diagnosis.
      console.error('Attract battle failed to start', err);
      return;
    }
    const game = this.game;
    game.ctx.paused = true;
    game.renderSuspended = true;
    const w = game.match.world;
    const began = performance.now();
    // Warm up in the simulation worker (its own core) in short chunks so progress can be shown.
    const warm = async (): Promise<void> => {
      if (this.disposed) return;
      await game.fastForward(10, WARMUP_SLICE_MS * 20);
      if (this.disposed) return;
      const outOfTime = performance.now() - began > WARMUP_MAX_MS;
      this.onProgress(Math.min(1, w.time / WARMUP_SECONDS));
      if (w.time < WARMUP_SECONDS && !w.result && !outOfTime) {
        this.timer = window.setTimeout(() => void warm(), 0);
        return;
      }
      const director = new CinematicDirector(w, game.renderer, dip, prefersReducedMotion());
      director.start();
      game.onFrame = (dt) => director.update(dt);
      game.renderSuspended = false;
      game.ctx.paused = false;
      onLive();
    };
    this.timer = window.setTimeout(() => void warm(), 60);
  }

  clock(): string {
    const w = this.game?.match.world;
    return w ? fmtTime(w.time) : '--:--';
  }

  mapName(): string {
    return this.game?.match.world.map.name.en ?? '';
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.game?.dispose();
    this.game = null;
    this.host.remove();
  }
}

interface MenuItem {
  readonly id: 'quick' | 'custom' | 'spectate' | 'settings';
  readonly action: () => void;
}

/**
 * Cinematic title screen (VISUAL_UX §9): live AI battle as the background, huge English title,
 * minimal vertical menu, dossier side-panel for custom battle and settings.
 */
export function showTitle(root: HTMLElement, data: GameData, onStart: (cfg: MatchConfig) => void): () => void {
  let state = loadState();
  let panel: 'custom' | 'settings' | null = null;
  let active = 0;

  const stage = h('div', { class: 'ts-stage' });
  const dip = h('div', { class: 'ts-dip boot' });
  const liveClock = h('span', { class: 'num' }, '--:--');
  const liveMap = h('span', {});
  const live = h('div', { class: 'ts-live' }, h('span', { class: 'rec' }), h('span', { class: 'live-k' }), liveMap, liveClock);
  const kicker = h('div', { class: 'ts-kicker' });
  const title = h('h1', { class: 'ts-title' });
  const sub = h('div', { class: 'ts-sub' });
  const nav = h('nav', { class: 'ts-menu', 'aria-label': 'Main menu' });
  const side = h('aside', { class: 'ts-panel dossier panel', 'aria-live': 'polite' });
  const keys = h('div', { class: 'ts-keys' });
  const langBtn = h('button', { class: 'ts-lang', onclick: () => setLang(lang() === 'zh' ? 'en' : 'zh') });
  const el = h('div', { class: `title-screen intro ${prefersReducedMotion() ? 'still' : ''}` },
    stage,
    h('div', { class: 'ts-grade' }), h('div', { class: 'ts-vignette' }), h('div', { class: 'ts-grain' }),
    h('div', { class: 'ts-bar top' }), h('div', { class: 'ts-bar bottom' }),
    dip,
    h('main', { class: 'ts-content' }, kicker, title, sub, nav),
    side,
    h('footer', { class: 'ts-foot' }, live, keys, langBtn));
  root.append(el);

  let warm = 0;
  let isLive = false;
  const liveLabel = (): string => (isLive ? t('title.live') : t('title.deploying', { p: Math.round(warm * 100) }));
  const battle = new AttractBattle(stage, dip, data, () => {
    isLive = true;
    dip.classList.remove('boot');
    el.classList.add('live');
    setText(live.querySelector('.live-k') as HTMLElement, liveLabel());
  }, (f) => {
    warm = f;
    setText(live.querySelector('.live-k') as HTMLElement, liveLabel());
  });
  const clockTimer = window.setInterval(() => {
    setText(liveClock, `T+${battle.clock()}`);
    setText(liveMap, battle.mapName());
  }, 500);

  const start = (cfg: MatchConfig): void => {
    saveState(state);
    onStart(cfg);
  };

  const items: MenuItem[] = [
    { id: 'quick', action: () => start(toConfig({ ...state, mapId: 'generated', mapSize: 'medium', factions: 4, difficulty: 'normal', infoMode: 'open', spectate: false, seed: randomSeed() })) },
    { id: 'custom', action: () => openPanel('custom') },
    { id: 'spectate', action: () => start(toConfig({ ...state, mapId: 'generated', factions: 4, spectate: true, infoMode: 'open', seed: randomSeed() })) },
    { id: 'settings', action: () => openPanel('settings') },
  ];

  const buttons = (): HTMLButtonElement[] => [...nav.querySelectorAll<HTMLButtonElement>('.ts-item')];

  function openPanel(p: 'custom' | 'settings' | null): void {
    panel = panel === p ? null : p;
    renderPanel();
    renderNav();
    if (panel) (side.querySelector('button, input') as HTMLElement | null)?.focus();
    else buttons()[active]?.focus();
  }

  function renderNav(): void {
    nav.innerHTML = '';
    items.forEach((it, i) => {
      const b = h('button', {
        class: `ts-item ${panel === it.id ? 'open' : ''}`,
        style: `--i:${i}`,
        'aria-expanded': it.id === 'custom' || it.id === 'settings' ? String(panel === it.id) : undefined,
        onclick: it.action,
        onfocus: () => { active = i; },
        onmouseenter: () => { active = i; },
      },
      h('span', { class: 'ts-idx num' }, String(i + 1).padStart(2, '0')),
      h('span', { class: 'ts-label' }, t(`title.${it.id}`)),
      h('span', { class: 'ts-desc' }, t(`title.${it.id}Desc`)));
      nav.append(b);
    });
  }

  function renderPanel(): void {
    side.innerHTML = '';
    side.classList.toggle('show', panel !== null);
    if (panel === 'settings') {
      side.append(
        h('div', { class: 'dossier-head' }, h('span', { class: 'stamp' }, t('title.settings')), closeBtn()),
        settingsFields(() => relabel()));
      return;
    }
    if (panel !== 'custom') return;
    const opt = <T extends string | number>(label: string, value: T, cur: T, set: (v: T) => SetupState): HTMLButtonElement =>
      h('button', { class: `btn seg ${cur === value ? 'on' : ''}`, 'aria-pressed': String(cur === value), onclick: () => { state = set(value); renderPanel(); focusPressed(label); } }, label);
    const maxF = maxFactions(state.mapId);
    const factions = Math.min(maxF, state.factions);
    const seedIn = h('input', { class: 'numin', type: 'number', min: 1, value: state.seed, 'aria-label': t('setup.seed'),
      onchange: (e: Event) => { state = { ...state, seed: Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value)) || 1) }; } });
    const generated = state.mapId === 'generated';
    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'dossier-head' }, h('span', { class: 'stamp' }, t('title.custom')), closeBtn()),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('setup.map')),
        h('div', { class: 'seg-group' },
          opt(t('map.generated'), 'generated' as MapChoice, state.mapId, (v) => ({ ...state, mapId: v })),
          opt(t('map.four_cities.short'), 'four_cities' as MapChoice, state.mapId, (v) => ({ ...state, mapId: v })),
          opt(t('map.greystone_pinecreek.short'), 'greystone_pinecreek' as MapChoice, state.mapId, (v) => ({ ...state, mapId: v, factions: 2 })))),
      generated ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('setup.mapSize')),
        h('div', { class: 'seg-group' }, ...(['medium', 'large'] as MapSize[]).map((s) => opt(t(`size.${s}`), s, state.mapSize, (v) => ({ ...state, mapSize: v }))))) : null,
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('setup.factions')),
        h('div', { class: 'seg-group' }, ...[2, 3, 4].filter((n) => n <= maxF).map((n) => opt(String(n), n, factions, (v) => ({ ...state, factions: v }))))),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('setup.difficulty')),
        h('div', { class: 'seg-group' }, ...(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => opt(t(`diff.${d}`), d, state.difficulty, (v) => ({ ...state, difficulty: v }))))),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('setup.info')),
        h('div', { class: 'seg-group' }, ...(['open', 'fog'] as InfoMode[]).map((m) => opt(t(`info.${m}`), m, state.infoMode, (v) => ({ ...state, infoMode: v }))))),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('setup.seed')), seedIn,
        h('button', { class: 'btn', onclick: () => { state = { ...state, seed: randomSeed() }; seedIn.value = String(state.seed); } }, `⟳ ${t('setup.random')}`)),
      h('label', { class: 'field check' },
        h('input', { type: 'checkbox', checked: state.spectate, onchange: (e: Event) => { state = { ...state, spectate: (e.target as HTMLInputElement).checked }; } }),
        h('span', {}, t('setup.spectate'))),
      h('div', { class: 'small note' }, t('setup.timeLimit')),
      h('button', { class: 'btn primary big', onclick: () => start(toConfig(state)) }, t('setup.start')),
    ];
    side.append(...parts.filter((x): x is HTMLElement => x !== null));
  }

  function focusPressed(label: string): void {
    const b = [...side.querySelectorAll<HTMLButtonElement>('.btn.seg')].find((x) => x.textContent === label);
    b?.focus();
  }

  function closeBtn(): HTMLButtonElement {
    return h('button', { class: 'btn icon close', 'aria-label': t('title.back'), title: 'Esc', onclick: () => openPanel(null) }, '×');
  }

  function relabel(): void {
    setText(kicker, t('title.kicker'));
    title.innerHTML = '';
    const words = t('title.name').split(' ');
    words.forEach((wd, i) => title.append(h('span', { class: 'w', style: `--w:${i}` }, wd), i < words.length - 1 ? ' ' : ''));
    setText(sub, t('title.sub'));
    setText(keys, t('title.keys'));
    setText(langBtn, t('lang.toggle'));
    langBtn.setAttribute('aria-label', t('set.lang'));
    setText(live.querySelector('.live-k') as HTMLElement, liveLabel());
    renderNav();
    renderPanel();
  }

  const onKey = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (e.key === 'Escape' && panel) {
      e.preventDefault();
      openPanel(null);
      return;
    }
    if (panel && side.contains(e.target as Node)) return;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    const bs = buttons();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length;
      bs[active]?.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      items[active]?.action();
    } else if (e.key === 'ArrowRight' && (items[active].id === 'custom' || items[active].id === 'settings') && !panel) {
      openPanel(items[active].id as 'custom' | 'settings');
    }
  };
  window.addEventListener('keydown', onKey);

  relabel();
  const offLang = onLangChange(relabel);
  // Focus the default item once the entrance animation has revealed it.
  const focusTimer = window.setTimeout(() => buttons()[0]?.focus({ preventScroll: true }), prefersReducedMotion() ? 0 : 900);
  // The staggered entrance plays once; later re-renders (panels, language) must not replay it.
  const introTimer = window.setTimeout(() => el.classList.remove('intro'), 2600);

  return () => {
    window.removeEventListener('keydown', onKey);
    clearInterval(clockTimer);
    clearTimeout(focusTimer);
    clearTimeout(introTimer);
    offLang();
    battle.dispose();
    el.remove();
  };
}
