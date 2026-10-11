/**
 * Online update check (V22_SPEC §9): asks GitHub for the latest release once per launch and
 * reports it when its tag is newer than the built version. No DOM here (unit-tested in node).
 * The API response is untrusted: every field is validated and only release pages of this
 * repository are accepted as links.
 */

export const RELEASES_API = 'https://api.github.com/repos/Zwl20085/LittleWarGame/releases/latest';
export const RELEASE_URL_PREFIX = 'https://github.com/Zwl20085/LittleWarGame/';
export const CACHE_KEY = 'lwg.updateCheck';
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 5000;
const MAX_NAME_LEN = 120;

export interface ReleaseInfo {
  readonly tag: string;
  readonly name: string;
  readonly url: string;
}

type Semver = readonly [number, number, number];

/** Parse `v2.1.0` / `2.1` / `2.1.0-beta` into [major, minor, patch]; null when not a version. */
export function parseSemver(raw: string): Semver | null {
  const m = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+][0-9A-Za-z.-]*)?$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** -1 / 0 / 1 like a comparator; null when either side is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export function isNewer(tag: string, current: string): boolean {
  return compareSemver(tag, current) === 1;
}

/** Only https release pages of this repository (no credentials, no other host, no tricks). */
export function isTrustedReleaseUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 300 || !raw.startsWith(RELEASE_URL_PREFIX)) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.port === '' && u.username === '' && u.password === ''
      && u.pathname.startsWith('/Zwl20085/LittleWarGame/');
  } catch {
    return false;
  }
}

/** Plain text only: strip control characters and cap the length. */
function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s) return fallback;
  return s.length > MAX_NAME_LEN ? `${s.slice(0, MAX_NAME_LEN - 1)}…` : s;
}

/** Validate the GitHub "latest release" JSON; null when anything is off (draft, prerelease, bad tag/url). */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.draft === true || o.prerelease === true) return null;
  if (typeof o.tag_name !== 'string' || o.tag_name.length > 40 || !parseSemver(o.tag_name)) return null;
  if (!isTrustedReleaseUrl(o.html_url)) return null;
  return { tag: o.tag_name.trim(), name: cleanName(o.name, o.tag_name.trim()), url: o.html_url };
}

interface CacheEntry {
  readonly at: number;
  readonly release: ReleaseInfo | null;
}

export interface UpdateEnv {
  readonly fetch: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly now: () => number;
  readonly warn: (msg: string, err?: unknown) => void;
}

function readCache(env: UpdateEnv): CacheEntry | null {
  try {
    const raw = env.storage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { at?: unknown; release?: unknown };
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
    const age = env.now() - v.at;
    if (age < 0 || age > CACHE_TTL_MS) return null;
    return { at: v.at, release: v.release === null ? null : parseRelease(toApiShape(v.release)) };
  } catch {
    return null;
  }
}

/** Cached entries are re-validated through the same parser (storage is not trusted either). */
function toApiShape(r: unknown): unknown {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  return { tag_name: o.tag, name: o.name, html_url: o.url };
}

function writeCache(env: UpdateEnv, release: ReleaseInfo | null): void {
  try {
    env.storage?.setItem(CACHE_KEY, JSON.stringify({ at: env.now(), release }));
  } catch {
    // storage unavailable: the check simply runs again next launch
  }
}

/** Latest release (cached 6 h), or null on any failure. Never throws. */
export async function fetchLatestRelease(env: UpdateEnv): Promise<ReleaseInfo | null> {
  const cached = readCache(env);
  if (cached) return cached.release;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await env.fetch(RELEASES_API, { signal: ctl.signal, headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) {
      env.warn(`Update check: HTTP ${res.status}`);
      return null;
    }
    const release = parseRelease(await res.json());
    if (!release) env.warn('Update check: unexpected release data');
    writeCache(env, release);
    return release;
  } catch (err: unknown) {
    env.warn('Update check failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The newer release, if any (null when up to date, unknown or failed). */
export async function checkForUpdate(current: string, env: UpdateEnv): Promise<ReleaseInfo | null> {
  const release = await fetchLatestRelease(env);
  return release && isNewer(release.tag, current) ? release : null;
}
