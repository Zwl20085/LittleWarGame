import { h } from './dom';
import { lang, setLang, t } from './i18n';
import { settings, updateSettings } from './settings';

/** Settings controls shared by the title screen and the pause menu. */
export function settingsFields(onLang?: () => void): HTMLElement {
  const s = settings();
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const scaleOut = h('span', { class: 'num' }, pct(s.uiScale));
  const smokeOut = h('span', { class: 'num' }, pct(s.smoke));
  const langBtn = (l: 'zh' | 'en', label: string): HTMLButtonElement =>
    h('button', { class: `btn seg ${lang() === l ? 'on' : ''}`, 'aria-pressed': String(lang() === l), onclick: () => { setLang(l); onLang?.(); } }, label);
  return h('div', { class: 'settings-form' },
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('set.lang')),
      h('div', { class: 'seg-group' }, langBtn('zh', '中文'), langBtn('en', 'English'))),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, t('set.uiScale')),
      h('input', { type: 'range', min: 80, max: 150, step: 5, value: Math.round(s.uiScale * 100),
        oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value) / 100; scaleOut.textContent = pct(v); },
        onchange: (e: Event) => updateSettings({ uiScale: Number((e.target as HTMLInputElement).value) / 100 }) }),
      scaleOut),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, t('set.smoke')),
      h('input', { type: 'range', min: 0, max: 150, step: 5, value: Math.round(s.smoke * 100),
        oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value) / 100; smokeOut.textContent = pct(v); updateSettings({ smoke: v }); } }),
      smokeOut),
    h('label', { class: 'field check' },
      h('input', { type: 'checkbox', checked: s.shake, onchange: (e: Event) => updateSettings({ shake: (e.target as HTMLInputElement).checked }) }),
      h('span', {}, t('set.shake'))),
    volumeField('set.volMaster', 'volMaster'),
    volumeField('set.volMusic', 'volMusic'),
    volumeField('set.volSfx', 'volSfx'),
    h('label', { class: 'field check' },
      h('input', { type: 'checkbox', checked: s.muted, onchange: (e: Event) => updateSettings({ muted: (e.target as HTMLInputElement).checked }) }),
      h('span', {}, t('set.mute'))),
  );
}

/** One audio volume slider (0–100%), applied live. */
function volumeField(label: string, key: 'volMaster' | 'volMusic' | 'volSfx'): HTMLElement {
  const v0 = settings()[key];
  const out = h('span', { class: 'num' }, `${Math.round(v0 * 100)}%`);
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, t(label)),
    h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(v0 * 100),
      oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value) / 100; out.textContent = `${Math.round(v * 100)}%`; updateSettings({ [key]: v }); } }),
    out);
}

/** In-match pause dossier (Esc). Returns a close function. */
export function showPauseMenu(root: HTMLElement, actions: { resume: () => void; quit: () => void }): () => void {
  const el = h('div', { class: 'results pause' });
  const render = (): void => {
    el.innerHTML = '';
    el.append(h('div', { class: 'results-card panel dossier', role: 'dialog', 'aria-label': t('menu.title') },
      h('div', { class: 'stamp big' }, t('menu.title')),
      settingsFields(render),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: actions.resume }, t('menu.resume')),
        h('button', { class: 'btn', onclick: actions.quit }, t('menu.quit')))));
    (el.querySelector('.btn.primary') as HTMLButtonElement | null)?.focus();
  };
  render();
  root.append(el);
  return () => el.remove();
}
