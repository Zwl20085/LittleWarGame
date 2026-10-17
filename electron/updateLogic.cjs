// Pure logic of the hot updater (docs/UPDATER.md): versions, the feed host allow-list, manifest
// validation, Ed25519 signature checks, the update decision and the bundle fallback state
// machine. No Electron and no file system here, so tests/updater.test.ts can drive all of it.
'use strict';

const crypto = require('node:crypto');

const FEED_URL = 'https://api.github.com/repos/Zwl20085/LittleWarGame/releases/latest';
/**
 * Hosts the shell may talk to, redirects included. GitHub serves release assets from
 * github.com and redirects to objects.githubusercontent.com (older) or
 * release-assets.githubusercontent.com (since 2025); every byte is checked against the signed
 * manifest anyway, so the allow-list is defence in depth, not the trust anchor.
 */
const ALLOWED_HOSTS = Object.freeze(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const LOCAL_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);

const LIMITS = Object.freeze({
  feedBytes: 1024 * 1024,
  manifestBytes: 64 * 1024,
  sigBytes: 1024,
  bundleBytes: 64 * 1024 * 1024,
  installerBytes: 512 * 1024 * 1024,
});
/** Launches a bundle may take without signalling ready before it is marked bad. */
const MAX_UNCONFIRMED_LAUNCHES = 2;
const KEEP_BUNDLES = 2;

const STRICT_VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const INSTALLER_NAME = /^LittleWar-\d+\.\d+\.\d+-(setup|portable)\.exe$/;
const PORTABLE_NAME = /^LittleWar-\d+\.\d+\.\d+-portable\.exe$/i;

// ---------------------------------------------------------------- versions

/** `v2.1.0` / `2.1` / `2.1.0-beta` → [major, minor, patch]; null when not a version. */
function parseSemver(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+][0-9A-Za-z.-]*)?$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** -1 / 0 / 1; null when either side is not a version. */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function isNewer(candidate, current) {
  return compareSemver(candidate, current) === 1;
}

/** Plain x.y.z only: these name directories on disk. */
function isStrictVersion(v) {
  return typeof v === 'string' && STRICT_VERSION.test(v);
}

// ---------------------------------------------------------------- hosts

/**
 * https to an allow-listed host on the default port, no credentials. With `allowLocal` (dev
 * builds only, for the localhost test feed) http/https to loopback on any port is accepted too.
 */
function isAllowedUrl(raw, opts = {}) {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (opts.allowLocal && LOCAL_HOSTS.includes(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:')) return true;
  return u.protocol === 'https:' && u.port === '' && ALLOWED_HOSTS.includes(u.hostname);
}

/** The feed URL; the env override is honoured only in an unpackaged (dev) shell. */
function resolveFeed(env, isPackaged) {
  const override = !isPackaged && env && typeof env.LITTLEWAR_UPDATE_FEED === 'string' ? env.LITTLEWAR_UPDATE_FEED.trim() : '';
  if (override) {
    if (!isAllowedUrl(override, { allowLocal: true })) return null;
    return { url: override, allowLocal: true };
  }
  return { url: FEED_URL, allowLocal: false };
}

// ---------------------------------------------------------------- feed + manifest

/**
 * The GitHub "latest release" JSON → { version, assets: { name: url } } for the files this
 * release offers. Null when it is a draft/prerelease, the tag is not a version, or the
 * manifest assets are missing. Asset URLs must pass the host allow-list.
 */
function parseFeed(json, opts = {}) {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  if (json.draft === true || json.prerelease === true) return null;
  if (typeof json.tag_name !== 'string') return null;
  const version = json.tag_name.trim().replace(/^v/, '');
  if (!isStrictVersion(version)) return null;
  if (!Array.isArray(json.assets) || json.assets.length > 200) return null;
  const assets = {};
  for (const a of json.assets) {
    if (typeof a !== 'object' || a === null) continue;
    if (typeof a.name !== 'string' || !SAFE_FILE.test(a.name)) continue;
    if (!isAllowedUrl(a.browser_download_url, opts)) continue;
    assets[a.name] = a.browser_download_url;
  }
  const manifestName = `game-${version}.json`;
  if (!assets[manifestName] || !assets[`${manifestName}.sig`]) return null;
  return Object.freeze({ version, manifestName, sigName: `${manifestName}.sig`, assets: Object.freeze(assets) });
}

function validFileRef(o, maxBytes) {
  return typeof o === 'object' && o !== null && typeof o.name === 'string' && SAFE_FILE.test(o.name) && INSTALLER_NAME.test(o.name)
    && typeof o.sha256 === 'string' && SHA256_HEX.test(o.sha256)
    && (o.size === undefined || (Number.isSafeInteger(o.size) && o.size > 0 && o.size <= maxBytes));
}

/** Validate a parsed manifest; returns { ok: true, manifest } or { ok: false, error }. */
function validateManifest(m) {
  const bad = (error) => ({ ok: false, error });
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return bad('manifest is not an object');
  if (m.schema !== 1) return bad('unknown manifest schema');
  if (!isStrictVersion(m.version)) return bad('bad version');
  if (!isStrictVersion(m.minShell)) return bad('bad minShell');
  if (m.file !== `game-${m.version}.zip`) return bad('bad file name');
  if (typeof m.sha256 !== 'string' || !SHA256_HEX.test(m.sha256)) return bad('bad sha256');
  if (!Number.isSafeInteger(m.size) || m.size <= 0 || m.size > LIMITS.bundleBytes) return bad('bad size');
  const installers = {};
  if (m.installers !== undefined) {
    if (typeof m.installers !== 'object' || m.installers === null) return bad('bad installers');
    for (const kind of ['setup', 'portable']) {
      const ref = m.installers[kind];
      if (ref === undefined) continue;
      if (!validFileRef(ref, LIMITS.installerBytes)) return bad(`bad installer ${kind}`);
      installers[kind] = Object.freeze({ name: ref.name, sha256: ref.sha256, size: ref.size });
    }
  }
  return {
    ok: true,
    manifest: Object.freeze({ schema: 1, version: m.version, minShell: m.minShell, file: m.file, sha256: m.sha256, size: m.size, installers: Object.freeze(installers) }),
  };
}

// ---------------------------------------------------------------- signatures

const PLACEHOLDER_KEY = 'REPLACE_WITH_PUBLIC_KEY_FROM_KEYGEN';

function isPlaceholderKey(key) {
  return typeof key !== 'string' || key === PLACEHOLDER_KEY || key.trim() === '';
}

/** Public key as base64 SPKI DER (what keygen prints). Throws on a malformed key. */
function loadPublicKey(b64) {
  const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('update key is not Ed25519');
  return key;
}

/** Ed25519 check of `data` against a base64 signature text. Never throws. */
function verifySignature(data, sigText, publicKeyB64) {
  if (isPlaceholderKey(publicKeyB64)) return false;
  try {
    const sig = Buffer.from(String(sigText).trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(data), loadPublicKey(publicKeyB64), sig);
  } catch {
    return false;
  }
}

function signManifest(data, privateKey) {
  return crypto.sign(null, Buffer.from(data), privateKey).toString('base64');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------- decisions

/**
 * Stage 1 (before downloading the bundle): signature → schema → feed/version match → minShell.
 * Returns { ok: true, manifest, kind: 'bundle' | 'installer' } or { ok: false, stage, error }.
 */
function checkManifest({ manifestBytes, sigText, publicKey, shellVersion, feedVersion }) {
  if (!verifySignature(manifestBytes, sigText, publicKey)) return { ok: false, stage: 'signature', error: 'manifest signature is invalid' };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch {
    return { ok: false, stage: 'manifest', error: 'manifest is not JSON' };
  }
  const v = validateManifest(parsed);
  if (!v.ok) return { ok: false, stage: 'manifest', error: v.error };
  if (feedVersion !== undefined && v.manifest.version !== feedVersion) return { ok: false, stage: 'manifest', error: 'manifest version does not match the release' };
  const shellOk = compareSemver(v.manifest.minShell, shellVersion);
  if (shellOk === null) return { ok: false, stage: 'minShell', error: 'unknown shell version' };
  return { ok: true, manifest: v.manifest, kind: shellOk > 0 ? 'installer' : 'bundle' };
}

/** Stage 2 (after download): size first, then sha256. */
function checkPayload(expected, actual) {
  if (expected.size !== undefined && actual.size !== expected.size) return { ok: false, stage: 'size', error: `size ${actual.size} != ${expected.size}` };
  if (actual.sha256 !== expected.sha256) return { ok: false, stage: 'sha256', error: 'sha256 mismatch' };
  return { ok: true };
}

/** What to do with a verified manifest given what this machine already runs and has. */
function decide({ manifest, kind, servingVersion, installed = [], bad = [] }) {
  if (!isNewer(manifest.version, servingVersion)) return 'up-to-date';
  if (bad.includes(manifest.version)) return 'known-bad';
  if (kind === 'installer') return 'installer';
  if (installed.includes(manifest.version)) return 'already-installed';
  return 'download';
}

/** Whether a stored bundle manifest (JSON text) can run on this shell: minShell <= shellVersion. */
function shellCompatible(manifestText, shellVersion) {
  try {
    const cmp = compareSemver(JSON.parse(manifestText).minShell, shellVersion);
    return cmp !== null && cmp <= 0;
  } catch {
    return false;
  }
}

/**
 * Exe to relaunch for the portable build: PORTABLE_EXECUTABLE_FILE only when it is named like
 * our release asset and exists, otherwise null (the caller then relaunches process.execPath).
 */
function portableRelaunchPath(file, exists) {
  if (typeof file !== 'string' || file.length === 0) return null;
  const base = file.split(/[\\/]/).pop();
  return PORTABLE_NAME.test(base) && exists(file) ? file : null;
}

/** Installer that matches how this shell was installed (portable exe or NSIS setup). */
function pickInstaller(manifest, isPortable) {
  return (isPortable ? manifest.installers.portable : manifest.installers.setup) ?? null;
}

// ---------------------------------------------------------------- bundle state machine

const EMPTY_STATE = Object.freeze({ bad: Object.freeze([]), confirmed: Object.freeze([]), trial: null });

function normalizeState(raw) {
  if (typeof raw !== 'object' || raw === null) return EMPTY_STATE;
  const list = (x) => Object.freeze(Array.isArray(x) ? [...new Set(x.filter(isStrictVersion))].slice(-50) : []);
  const t = raw.trial;
  const trial = t && isStrictVersion(t.version) && Number.isSafeInteger(t.attempts) && t.attempts > 0
    ? Object.freeze({ version: t.version, attempts: t.attempts }) : null;
  return Object.freeze({ bad: list(raw.bad), confirmed: list(raw.confirmed), trial });
}

function sortDesc(versions) {
  return [...versions].sort((a, b) => compareSemver(b, a) ?? 0);
}

/** Newest installed bundle that is newer than the built-in game and not marked bad. */
function pickServed(state, installed, builtinVersion) {
  return sortDesc(installed.filter((v) => isStrictVersion(v) && isNewer(v, builtinVersion) && !state.bad.includes(v)))[0] ?? null;
}

function markBad(state, version) {
  return Object.freeze({
    bad: Object.freeze([...state.bad.filter((v) => v !== version), version]),
    confirmed: Object.freeze(state.confirmed.filter((v) => v !== version)),
    trial: state.trial && state.trial.version === version ? null : state.trial,
  });
}

/**
 * Called once per launch. A bundle that was served on earlier launches without ever signalling
 * ready (crash, blank page, killed) is marked bad after MAX_UNCONFIRMED_LAUNCHES.
 * Returns { state, serve: version | null }.
 */
function onLaunch(state, installed, builtinVersion) {
  let s = normalizeState(state);
  for (;;) {
    const v = pickServed(s, installed, builtinVersion);
    if (!v) return { state: Object.freeze({ ...s, trial: null }), serve: null };
    const prev = s.trial && s.trial.version === v ? s.trial.attempts : 0;
    if (prev >= MAX_UNCONFIRMED_LAUNCHES) {
      s = markBad(s, v);
      continue;
    }
    return { state: Object.freeze({ ...s, trial: Object.freeze({ version: v, attempts: prev + 1 }) }), serve: v };
  }
}

/** The served bundle reached the title screen. */
function onReady(state, version) {
  const s = normalizeState(state);
  return Object.freeze({
    bad: s.bad,
    confirmed: Object.freeze([...s.confirmed.filter((v) => v !== version), version]),
    trial: null,
  });
}

/** The served bundle failed to load or did not signal ready in time: mark it bad now. */
function onFailure(state, version) {
  return markBad(normalizeState(state), version);
}

/** Bundle directories to delete: bad ones and all but the newest KEEP_BUNDLES good ones. */
function toPrune(state, installed, serving) {
  const s = normalizeState(state);
  const good = sortDesc(installed.filter((v) => !s.bad.includes(v)));
  const keep = new Set(good.slice(0, KEEP_BUNDLES));
  if (serving) keep.add(serving);
  return installed.filter((v) => !keep.has(v));
}

module.exports = {
  FEED_URL, ALLOWED_HOSTS, LIMITS, MAX_UNCONFIRMED_LAUNCHES, KEEP_BUNDLES, PLACEHOLDER_KEY, EMPTY_STATE,
  parseSemver, compareSemver, isNewer, isStrictVersion,
  isAllowedUrl, resolveFeed, parseFeed, validateManifest,
  isPlaceholderKey, loadPublicKey, verifySignature, signManifest, sha256,
  checkManifest, checkPayload, decide, pickInstaller, shellCompatible, portableRelaunchPath,
  normalizeState, pickServed, markBad, onLaunch, onReady, onFailure, toPrune,
};
