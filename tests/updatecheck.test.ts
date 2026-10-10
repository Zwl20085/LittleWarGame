import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_KEY, CACHE_TTL_MS, checkForUpdate, compareSemver, isNewer, isTrustedReleaseUrl, parseRelease, parseSemver,
  RELEASES_API, type UpdateEnv,
} from '../src/ui/updateCheck';

const GOOD = { tag_name: 'v2.3.0', name: 'Little War 2.3', html_url: 'https://github.com/Zwl20085/LittleWarGame/releases/tag/v2.3.0', draft: false, prerelease: false };

function memStorage(init: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

function env(body: unknown, opts: { ok?: boolean; status?: number; storage?: UpdateEnv['storage']; now?: number; reject?: boolean } = {}): UpdateEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      if (opts.reject) throw new Error('offline');
      return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
    },
    storage: opts.storage === undefined ? memStorage() : opts.storage,
    now: () => opts.now ?? 1_000_000,
    warn: vi.fn(),
  };
}

describe('semver', () => {
  it('parses tags with and without v, short forms and pre-release suffixes', () => {
    expect(parseSemver('v2.1.0')).toEqual([2, 1, 0]);
    expect(parseSemver('2.10')).toEqual([2, 10, 0]);
    expect(parseSemver('3')).toEqual([3, 0, 0]);
    expect(parseSemver('v2.2.0-beta.1')).toEqual([2, 2, 0]);
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver('v2.1.0; rm -rf')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(compareSemver('v2.10.0', '2.9.0')).toBe(1);
    expect(compareSemver('v2.1.0', '2.1.0')).toBe(0);
    expect(compareSemver('v2.1.0', '2.1.1')).toBe(-1);
    expect(compareSemver('v3.0.0', '2.99.99')).toBe(1);
    expect(compareSemver('x', '2.1.0')).toBeNull();
    expect(isNewer('v2.2.0', '2.1.0')).toBe(true);
    expect(isNewer('v2.1.0', '2.1.0')).toBe(false);
    expect(isNewer('v2.0.9', '2.1.0')).toBe(false);
    expect(isNewer('garbage', '2.1.0')).toBe(false);
  });
});

describe('release validation (untrusted API JSON)', () => {
  it('accepts a well-formed release of this repository', () => {
    expect(parseRelease(GOOD)).toEqual({ tag: 'v2.3.0', name: 'Little War 2.3', url: GOOD.html_url });
  });

  it('rejects foreign or unsafe links', () => {
    for (const url of [
      'http://github.com/Zwl20085/LittleWarGame/releases/tag/v2.3.0',
      'https://github.com/evil/LittleWarGame/releases',
      'https://github.com.evil.com/Zwl20085/LittleWarGame/',
      'https://user:pw@github.com/Zwl20085/LittleWarGame/',
      'javascript:alert(1)//https://github.com/Zwl20085/LittleWarGame/',
      'https://github.com/Zwl20085/LittleWarGameX/releases',
      42, null,
    ]) {
      expect(isTrustedReleaseUrl(url)).toBe(false);
      expect(parseRelease({ ...GOOD, html_url: url })).toBeNull();
    }
  });

  it('rejects bad shapes, drafts, prereleases and non-version tags', () => {
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease([GOOD])).toBeNull();
    expect(parseRelease('v2.3.0')).toBeNull();
    expect(parseRelease({ ...GOOD, tag_name: 5 })).toBeNull();
    expect(parseRelease({ ...GOOD, tag_name: 'nightly' })).toBeNull();
    expect(parseRelease({ ...GOOD, draft: true })).toBeNull();
    expect(parseRelease({ ...GOOD, prerelease: true })).toBeNull();
  });

  it('cleans the release name to plain, bounded text', () => {
    expect(parseRelease({ ...GOOD, name: undefined })?.name).toBe('v2.3.0');
    expect(parseRelease({ ...GOOD, name: 'a\u0000b\nc' })?.name).toBe('a b c');
    expect(parseRelease({ ...GOOD, name: 'x'.repeat(500) })?.name.length).toBe(120);
  });
});

describe('checkForUpdate', () => {
  it('reports a newer release and caches it', async () => {
    const e = env(GOOD);
    expect(await checkForUpdate('2.2.0', e)).toEqual(parseRelease(GOOD));
    expect(e.calls).toEqual([RELEASES_API]);
    const store = e.storage as ReturnType<typeof memStorage>;
    expect(JSON.parse(store.data[CACHE_KEY]).release.tag).toBe('v2.3.0');
  });

  it('is silent when up to date', async () => {
    expect(await checkForUpdate('2.3.0', env(GOOD))).toBeNull();
  });

  it('uses a fresh cache instead of the network, and refetches after 6 h', async () => {
    const storage = memStorage({ [CACHE_KEY]: JSON.stringify({ at: 1_000_000, release: { tag: 'v9.0.0', name: 'n', url: GOOD.html_url } }) });
    const fresh = env(GOOD, { storage, now: 1_000_000 + CACHE_TTL_MS - 1 });
    expect((await checkForUpdate('2.2.0', fresh))?.tag).toBe('v9.0.0');
    expect(fresh.calls).toHaveLength(0);
    const stale = env(GOOD, { storage, now: 1_000_000 + CACHE_TTL_MS + 1 });
    expect((await checkForUpdate('2.2.0', stale))?.tag).toBe('v2.3.0');
    expect(stale.calls).toHaveLength(1);
  });

  it('re-validates the cache (a tampered url is ignored)', async () => {
    const storage = memStorage({ [CACHE_KEY]: JSON.stringify({ at: 1_000_000, release: { tag: 'v9.0.0', name: 'n', url: 'https://evil.example/' } }) });
    expect(await checkForUpdate('2.2.0', env(GOOD, { storage }))).toBeNull();
  });

  it('never throws: offline, HTTP errors, bad JSON, no storage', async () => {
    const off = env(GOOD, { reject: true });
    expect(await checkForUpdate('2.2.0', off)).toBeNull();
    expect(off.warn).toHaveBeenCalled();
    expect(await checkForUpdate('2.2.0', env(GOOD, { ok: false, status: 403 }))).toBeNull();
    expect(await checkForUpdate('2.2.0', env({ message: 'rate limited' }))).toBeNull();
    expect((await checkForUpdate('2.2.0', env(GOOD, { storage: null })))?.tag).toBe('v2.3.0');
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect((await checkForUpdate('2.2.0', env(GOOD, { storage: throwing })))?.tag).toBe('v2.3.0');
  });
});
