/**
 * Title-screen update notice and version stamp (V22_SPEC §9). The network logic lives in
 * updateCheck.ts; this module runs it at most once per launch and draws the result. In the
 * desktop app the Electron shell does the checking and downloading (docs/UPDATER.md) and this
 * notice shows its progress; the web build keeps the plain "new version" card.
 */
import { h, setText } from './dom';
import { t } from './i18n';
import { settings } from './settings';
import { checkForUpdate, isTrustedReleaseUrl, type ReleaseInfo, type UpdateEnv } from './updateCheck';
import { noticeView, shellBridge, watchShell, type NoticeView, type ShellBridge } from '../update/shell';

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

/** "Up to date" is shown briefly, then the card folds away. */
const UP_TO_DATE_MS = 5000;

/**
 * Footer stamp with the built version plus a dispatch card for updates. `relabel` re-renders
 * both texts after a language change; `dispose` drops the shell subscription.
 */
export function updateWidgets(): { version: HTMLElement; notice: HTMLElement; relabel: () => void; dispose: () => void } {
  const version = h('span', { class: 'ts-version num', title: t('update.version') }, `v${APP_VERSION}`);
  const notice = h('aside', { class: 'ts-update panel paper-stack', role: 'status', hidden: true });
  const bridge = devMock() ? null : shellBridge();
  let release: ReleaseInfo | null = null;
  let view: NoticeView = { kind: 'hidden' };
  let webStarted = false;
  let fadeTimer = 0;

  const render = (): void => {
    version.title = t('update.version');
    notice.innerHTML = '';
    if (release && (!bridge || view.kind === 'web')) {
      notice.hidden = false;
      notice.append(...releaseCard(release.tag.replace(/^v/, ''), release.name, release.url));
      return;
    }
    const parts = bridge ? shellCard(view, bridge) : [];
    notice.hidden = parts.length === 0;
    notice.append(...parts);
  };

  const startWeb = (): void => {
    if (webStarted) return;
    webStarted = true;
    void latestUpdate().then((r) => {
      release = r;
      render();
    });
  };

  let off = (): void => undefined;
  if (!bridge) {
    startWeb();
  } else {
    // Reaching the title screen proves the served game bundle works (crash/blank-page guard).
    bridge.ready();
    off = watchShell(bridge, (s) => {
      view = noticeView(s, isTrustedReleaseUrl);
      if (view.kind === 'web') startWeb();
      clearTimeout(fadeTimer);
      if (view.kind === 'up-to-date') {
        fadeTimer = window.setTimeout(() => {
          view = { kind: 'hidden' };
          render();
        }, UP_TO_DATE_MS);
      }
      render();
    });
    if (settings().checkUpdates) bridge.check();
  }
  render();
  return {
    version,
    notice,
    relabel: render,
    dispose: () => {
      off();
      clearTimeout(fadeTimer);
    },
  };
}

function releaseCard(v: string, title: string, url: string): HTMLElement[] {
  const name = h('div', { class: 'ts-update-name' });
  setText(name, title);
  return [
    h('div', { class: 'ts-update-k' }, t('update.kicker', { v, cur: APP_VERSION })),
    name,
    h('button', { class: 'btn primary ts-update-btn', onclick: () => openRelease(url) }, t('update.download')),
  ];
}

function progressBar(pct: number): HTMLElement {
  return h('div', { class: 'ts-update-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct },
    h('span', { style: `width:${pct}%` }));
}

/** Card contents for a desktop-shell state (empty = no card). */
function shellCard(view: NoticeView, bridge: ShellBridge): HTMLElement[] {
  const kicker = (text: string): HTMLElement => h('div', { class: 'ts-update-k' }, text);
  switch (view.kind) {
    case 'checking': return [kicker(t('update.checking'))];
    case 'up-to-date': return [kicker(t('update.upToDate', { cur: APP_VERSION }))];
    case 'downloading': return [kicker(t('update.downloading', { v: view.version, p: view.pct })), progressBar(view.pct)];
    case 'ready': return [
      kicker(t('update.ready', { v: view.version })),
      h('button', { class: 'btn primary ts-update-btn', onclick: () => bridge.restartToUpdate() }, t('update.restart')),
    ];
    case 'installer-downloading': return [kicker(t('update.installerDownloading', { v: view.version, p: view.pct })), progressBar(view.pct)];
    case 'installer-ready': return [
      kicker(t('update.installerReady', { v: view.version })),
      h('div', { class: 'ts-update-name small' }, t('update.installerHint')),
      h('button', { class: 'btn primary ts-update-btn', onclick: () => bridge.openDownloads() }, t('update.openFolder')),
    ];
    case 'release': return releaseCard(view.version, `Little War ${view.version}`, view.url);
    default: return [];
  }
}
