/**
 * Title-screen update notice and version stamp (V22_SPEC §9). The network logic lives in
 * updateCheck.ts; this module runs it at most once per launch and draws the result.
 */
import { h, setText } from './dom';
import { t } from './i18n';
import { settings } from './settings';
import { checkForUpdate, isTrustedReleaseUrl, type ReleaseInfo, type UpdateEnv } from './updateCheck';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

let pending: Promise<ReleaseInfo | null> | null = null;

function browserEnv(): UpdateEnv {
  let storage: UpdateEnv['storage'] = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return {
    fetch: (url, init) => window.fetch(url, { ...init, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }),
    storage,
    now: () => Date.now(),
    warn: (msg, err) => console.warn(msg, err ?? ''),
  };
}

/**
 * Dev-only override for screenshots: `?mockUpdate=v9.9.9` pretends that release exists
 * (no network). Stripped from production builds by the `import.meta.env.DEV` guard.
 */
function devMock(): ReleaseInfo | null {
  if (!import.meta.env.DEV) return null;
  const tag = new URLSearchParams(location.search).get('mockUpdate');
  if (!tag) return null;
  return { tag, name: `Little War ${tag.replace(/^v/, '')}`, url: `https://github.com/Zwl20085/LittleWarGame/releases/tag/${encodeURIComponent(tag)}` };
}

/** The newer release, or null. Runs the network check at most once per launch. */
export function latestUpdate(): Promise<ReleaseInfo | null> {
  if (pending) return pending;
  const mock = devMock();
  if (mock) pending = Promise.resolve(mock);
  else if (!settings().checkUpdates) return Promise.resolve(null);
  else pending = checkForUpdate(APP_VERSION, browserEnv());
  return pending;
}

function openRelease(url: string): void {
  // Re-checked at the point of use; Electron routes this through setWindowOpenHandler.
  if (!isTrustedReleaseUrl(url)) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Footer stamp with the built version plus a dispatch card when a newer release exists.
 * `relabel` re-renders both texts after a language change.
 */
export function updateWidgets(): { version: HTMLElement; notice: HTMLElement; relabel: () => void } {
  const version = h('span', { class: 'ts-version num', title: t('update.version') }, `v${APP_VERSION}`);
  const notice = h('aside', { class: 'ts-update panel paper-stack', role: 'status', hidden: true });
  let release: ReleaseInfo | null = null;
  const render = (): void => {
    version.title = t('update.version');
    notice.innerHTML = '';
    notice.hidden = !release;
    if (!release) return;
    const r = release;
    const name = h('div', { class: 'ts-update-name' });
    setText(name, r.name);
    notice.append(
      h('div', { class: 'ts-update-k' }, t('update.kicker', { v: r.tag.replace(/^v/, ''), cur: APP_VERSION })),
      name,
      h('button', { class: 'btn primary ts-update-btn', onclick: () => openRelease(r.url) }, t('update.download')));
  };
  void latestUpdate().then((r) => {
    release = r;
    render();
  });
  return { version, notice, relabel: render };
}
