/**
 * Renderer side of the desktop hot updater (docs/UPDATER.md). The Electron preload exposes
 * `window.littlewar`; the web build has no bridge and keeps the plain release notice. Shell
 * messages are validated like any other external input. No DOM here (unit-tested in node).
 */

export type ShellState =
  | 'idle' | 'unavailable' | 'checking' | 'up-to-date' | 'available' | 'downloading'
  | 'ready' | 'installer-downloading' | 'installer-ready' | 'error';

const STATES: readonly ShellState[] = ['idle', 'unavailable', 'checking', 'up-to-date', 'available', 'downloading', 'ready', 'installer-downloading', 'installer-ready', 'error'];

export interface ShellStatus {
  readonly state: ShellState;
  readonly version: string | null;
  readonly progress: number | null;
  readonly installerName: string | null;
  readonly autoDownload: boolean;
  readonly releaseUrl: string | null;
}

export interface ShellBridge {
  status(): Promise<unknown>;
  onStatus(cb: (s: unknown) => void): () => void;
  check(): void;
  ready(): void;
  restartToUpdate(): void;
  openDownloads(): void;
  setAutoDownload(on: boolean): Promise<unknown>;
}

export type NoticeView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'downloading'; readonly version: string; readonly pct: number }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'installer-downloading'; readonly version: string; readonly pct: number }
  | { readonly kind: 'installer-ready'; readonly version: string }
  | { readonly kind: 'release'; readonly version: string; readonly url: string }
  /** The shell cannot verify bundles (no key yet): use the web release check instead. */
  | { readonly kind: 'web' };

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** The preload bridge, or null in the web build / an old shell. */
export function shellBridge(w: unknown = typeof window === 'undefined' ? undefined : window): ShellBridge | null {
  const b = (w as { littlewar?: unknown } | undefined)?.littlewar as Partial<ShellBridge> | undefined;
  if (!b || typeof b !== 'object') return null;
  const fns: (keyof ShellBridge)[] = ['status', 'onStatus', 'check', 'ready', 'restartToUpdate', 'openDownloads', 'setAutoDownload'];
  return fns.every((k) => typeof b[k] === 'function') ? (b as ShellBridge) : null;
}

/** Validate a status message from the shell; null when malformed. */
export function parseShellStatus(raw: unknown): ShellStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!STATES.includes(o.state as ShellState)) return null;
  const version = typeof o.version === 'string' && VERSION.test(o.version) ? o.version : null;
  const progress = typeof o.progress === 'number' && Number.isFinite(o.progress) ? Math.min(1, Math.max(0, o.progress)) : null;
  return {
    state: o.state as ShellState,
    version,
    progress,
    installerName: typeof o.installerName === 'string' && FILE.test(o.installerName) ? o.installerName : null,
    autoDownload: o.autoDownload !== false,
    releaseUrl: typeof o.releaseUrl === 'string' ? o.releaseUrl : null,
  };
}

/** What the title-screen notice shows for a shell status. */
export function noticeView(s: ShellStatus | null, isTrustedUrl: (u: unknown) => boolean): NoticeView {
  if (!s) return { kind: 'hidden' };
  const pct = Math.round((s.progress ?? 0) * 100);
  const v = s.version;
  switch (s.state) {
    case 'unavailable': return { kind: 'web' };
    case 'checking': return { kind: 'checking' };
    case 'up-to-date': return { kind: 'up-to-date' };
    case 'downloading': return v ? { kind: 'downloading', version: v, pct } : { kind: 'checking' };
    case 'ready': return v ? { kind: 'ready', version: v } : { kind: 'hidden' };
    case 'installer-downloading': return v ? { kind: 'installer-downloading', version: v, pct } : { kind: 'checking' };
    case 'installer-ready': return v ? { kind: 'installer-ready', version: v } : { kind: 'hidden' };
    case 'available':
    case 'error':
      return v && isTrustedUrl(s.releaseUrl) ? { kind: 'release', version: v, url: s.releaseUrl as string } : { kind: 'hidden' };
    default: return { kind: 'hidden' };
  }
}

let last: ShellStatus | null = null;

/** Most recent shell status (for the Settings toggle, which renders synchronously). */
export function lastShellStatus(): ShellStatus | null {
  return last;
}

/** Subscribe to shell status (fetching the current one first). Returns an unsubscribe. */
export function watchShell(bridge: ShellBridge, cb: (s: ShellStatus) => void): () => void {
  const push = (raw: unknown): void => {
    const s = parseShellStatus(raw);
    if (!s) return;
    last = s;
    cb(s);
  };
  const off = bridge.onStatus(push);
  bridge.status().then(push, () => undefined);
  return off;
}

/** Toggle auto-download in the shell; resolves with the new status (or null). */
export async function setShellAutoDownload(bridge: ShellBridge, on: boolean): Promise<ShellStatus | null> {
  try {
    const s = parseShellStatus(await bridge.setAutoDownload(on));
    if (s) last = s;
    return s;
  } catch {
    return null;
  }
}
