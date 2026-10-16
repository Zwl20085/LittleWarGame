/** Renderer side of the desktop updater: bridge detection, status validation, notice states. */
import { describe, expect, it, vi } from 'vitest';
import { lastShellStatus, noticeView, parseShellStatus, setShellAutoDownload, shellBridge, watchShell, type ShellBridge } from '../src/update/shell';
import { isTrustedReleaseUrl } from '../src/ui/updateCheck';

const URL_OK = 'https://github.com/Zwl20085/LittleWarGame/releases/tag/v3.1.0';

function fakeBridge(initial: unknown): ShellBridge & { emit: (s: unknown) => void } {
  let cb: ((s: unknown) => void) | null = null;
  return {
    status: () => Promise.resolve(initial),
    onStatus: (f) => { cb = f; return () => { cb = null; }; },
    check: vi.fn(),
    ready: vi.fn(),
    restartToUpdate: vi.fn(),
    openDownloads: vi.fn(),
    setAutoDownload: (on) => Promise.resolve({ state: 'idle', autoDownload: on }),
    emit: (s) => cb?.(s),
  };
}

describe('shell bridge', () => {
  it('is only detected when every method is present (web build has none)', () => {
    expect(shellBridge(undefined)).toBeNull();
    expect(shellBridge({})).toBeNull();
    expect(shellBridge({ littlewar: { status: () => 0 } })).toBeNull();
    expect(shellBridge({ littlewar: fakeBridge(null) })).not.toBeNull();
  });

  it('validates status messages', () => {
    expect(parseShellStatus(null)).toBeNull();
    expect(parseShellStatus({ state: 'pwned' })).toBeNull();
    const s = parseShellStatus({ state: 'downloading', version: '3.1.0', progress: 7, installerName: '../x.exe', autoDownload: false });
    expect(s).toMatchObject({ state: 'downloading', version: '3.1.0', progress: 1, installerName: null, autoDownload: false });
    expect(parseShellStatus({ state: 'ready', version: '<img src=x>' })?.version).toBeNull();
  });

  it('maps states to notice views', () => {
    const v = (raw: object) => noticeView(parseShellStatus(raw), isTrustedReleaseUrl);
    expect(v({ state: 'idle' })).toEqual({ kind: 'hidden' });
    expect(v({ state: 'unavailable' })).toEqual({ kind: 'web' });
    expect(v({ state: 'checking' })).toEqual({ kind: 'checking' });
    expect(v({ state: 'up-to-date' })).toEqual({ kind: 'up-to-date' });
    expect(v({ state: 'downloading', version: '3.1.0', progress: 0.426 })).toEqual({ kind: 'downloading', version: '3.1.0', pct: 43 });
    expect(v({ state: 'ready', version: '3.1.0' })).toEqual({ kind: 'ready', version: '3.1.0' });
    expect(v({ state: 'installer-downloading', version: '4.0.0', progress: 0.5 })).toEqual({ kind: 'installer-downloading', version: '4.0.0', pct: 50 });
    expect(v({ state: 'installer-ready', version: '4.0.0' })).toEqual({ kind: 'installer-ready', version: '4.0.0' });
    expect(v({ state: 'available', version: '3.1.0', releaseUrl: URL_OK })).toEqual({ kind: 'release', version: '3.1.0', url: URL_OK });
    expect(v({ state: 'error', version: '3.1.0', releaseUrl: 'https://evil.example/' })).toEqual({ kind: 'hidden' });
  });

  it('subscribes, remembers the last status and toggles auto-download', async () => {
    const b = fakeBridge({ state: 'checking' });
    const seen: string[] = [];
    const off = watchShell(b, (s) => seen.push(s.state));
    await Promise.resolve();
    await Promise.resolve();
    b.emit({ state: 'ready', version: '3.1.0' });
    b.emit({ state: 'bogus' });
    expect(seen).toEqual(['checking', 'ready']);
    expect(lastShellStatus()?.state).toBe('ready');
    off();
    expect((await setShellAutoDownload(b, false))?.autoDownload).toBe(false);
    expect(lastShellStatus()?.autoDownload).toBe(false);
  });
});
