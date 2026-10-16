/**
 * Hot updater (docs/UPDATER.md): the pure logic in electron/updateLogic.cjs, the defensive zip
 * reader in electron/zip.cjs and the on-disk bundle store in electron/bundle.cjs, all driven
 * without Electron. A throwaway Ed25519 key is generated per run.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const logic = require('../electron/updateLogic.cjs') as typeof import('../electron/updateLogic.cjs');
const zip = require('../electron/zip.cjs') as typeof import('../electron/zip.cjs');
const store = require('../electron/bundle.cjs') as typeof import('../electron/bundle.cjs');

const keys = generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const other = generateKeyPairSync('ed25519');
const OTHER_PUB = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const HEX = 'a'.repeat(64);

const tmpRoots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'lwg-updater-'));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function manifestOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 1, version: '3.1.0', minShell: '3.0.0', file: 'game-3.1.0.zip', sha256: HEX, size: 1000, installers: {}, ...over };
}
function signed(m: Record<string, unknown>): { manifestBytes: Buffer; sigText: string } {
  const manifestBytes = Buffer.from(JSON.stringify(m));
  return { manifestBytes, sigText: logic.signManifest(manifestBytes, keys.privateKey) };
}
/** Replace an entry name in both headers (same length) to forge archives writeZip refuses. */
function forge(buf: Buffer, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length);
  const out = Buffer.from(buf);
  let i = out.indexOf(from);
  let n = 0;
  while (i >= 0) {
    out.write(to, i, 'latin1');
    n += 1;
    i = out.indexOf(from, i + 1);
  }
  expect(n).toBe(2);
  return out;
}

describe('versions and minShell', () => {
  it('parses and compares versions', () => {
    expect(logic.parseSemver('v3.0.1')).toEqual([3, 0, 1]);
    expect(logic.parseSemver('nightly')).toBeNull();
    expect(logic.compareSemver('3.0.10', '3.0.9')).toBe(1);
    expect(logic.isNewer('3.0.0', '3.0.0')).toBe(false);
    expect(logic.isStrictVersion('3.0.0')).toBe(true);
    for (const v of ['3.0', 'v3.0.0', '3.0.0-beta', '../3.0.0', '3.0.0 ']) expect(logic.isStrictVersion(v)).toBe(false);
  });

  it('asks for the installer only when minShell is newer than the shell', () => {
    const ok = logic.checkManifest({ ...signed(manifestOf({ minShell: '3.0.0' })), publicKey: PUB, shellVersion: '3.0.0' });
    expect(ok.ok && ok.kind).toBe('bundle');
    const old = logic.checkManifest({ ...signed(manifestOf({ minShell: '3.1.0' })), publicKey: PUB, shellVersion: '3.0.5' });
    expect(old.ok && old.kind).toBe('installer');
  });

  it('decides download / installer / up-to-date / known-bad', () => {
    const m = logic.validateManifest(manifestOf());
    if (!m.ok) throw new Error(m.error);
    expect(logic.decide({ manifest: m.manifest, kind: 'bundle', servingVersion: '3.0.0' })).toBe('download');
    expect(logic.decide({ manifest: m.manifest, kind: 'bundle', servingVersion: '3.1.0' })).toBe('up-to-date');
    expect(logic.decide({ manifest: m.manifest, kind: 'bundle', servingVersion: '3.2.0' })).toBe('up-to-date');
    expect(logic.decide({ manifest: m.manifest, kind: 'bundle', servingVersion: '3.0.0', bad: ['3.1.0'] })).toBe('known-bad');
    expect(logic.decide({ manifest: m.manifest, kind: 'bundle', servingVersion: '3.0.0', installed: ['3.1.0'] })).toBe('already-installed');
    expect(logic.decide({ manifest: m.manifest, kind: 'installer', servingVersion: '3.0.0' })).toBe('installer');
  });

  it('picks the installer that matches the install type', () => {
    const r = logic.validateManifest(manifestOf({ installers: { setup: { name: 'LittleWar-3.1.0-setup.exe', sha256: HEX, size: 5 }, portable: { name: 'LittleWar-3.1.0-portable.exe', sha256: HEX } } }));
    if (!r.ok) throw new Error(r.error);
    expect(logic.pickInstaller(r.manifest, false)?.name).toBe('LittleWar-3.1.0-setup.exe');
    expect(logic.pickInstaller(r.manifest, true)?.name).toBe('LittleWar-3.1.0-portable.exe');
    const none = logic.validateManifest(manifestOf());
    if (!none.ok) throw new Error(none.error);
    expect(logic.pickInstaller(none.manifest, true)).toBeNull();
  });
});

describe('manifest validation', () => {
  it('accepts a well-formed manifest and freezes it', () => {
    const r = logic.validateManifest(manifestOf());
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.isFrozen(r.manifest)).toBe(true);
  });

  it.each([
    ['not an object', null],
    ['array', []],
    ['schema', manifestOf({ schema: 2 })],
    ['version', manifestOf({ version: '3.1' })],
    ['traversal version', manifestOf({ version: '../../x' })],
    ['minShell', manifestOf({ minShell: 'latest' })],
    ['file name', manifestOf({ file: '../game-3.1.0.zip' })],
    ['file/version mismatch', manifestOf({ file: 'game-3.0.9.zip' })],
    ['sha256', manifestOf({ sha256: 'XYZ' })],
    ['size zero', manifestOf({ size: 0 })],
    ['size huge', manifestOf({ size: logic.LIMITS.bundleBytes + 1 })],
    ['size float', manifestOf({ size: 1.5 })],
    ['installer path', manifestOf({ installers: { setup: { name: '..\\evil.exe', sha256: HEX } } })],
    ['installer hash', manifestOf({ installers: { portable: { name: 'a.exe', sha256: 'nope' } } })],
  ])('rejects %s', (_label, m) => {
    expect(logic.validateManifest(m).ok).toBe(false);
  });
});

describe('signatures and check order', () => {
  it('verifies with the right key only', () => {
    const { manifestBytes, sigText } = signed(manifestOf());
    expect(logic.verifySignature(manifestBytes, sigText, PUB)).toBe(true);
    expect(logic.verifySignature(manifestBytes, sigText, OTHER_PUB)).toBe(false);
    expect(logic.verifySignature(manifestBytes, sigText, logic.PLACEHOLDER_KEY)).toBe(false);
    expect(logic.verifySignature(manifestBytes, 'garbage', PUB)).toBe(false);
    expect(logic.verifySignature(manifestBytes, sigText, 'not-a-key')).toBe(false);
  });

  it('rejects a tampered manifest at the signature stage, before anything else', () => {
    const { manifestBytes, sigText } = signed(manifestOf());
    const tampered = Buffer.from(manifestBytes.toString().replace(HEX, 'b'.repeat(64)));
    expect(logic.checkManifest({ manifestBytes: tampered, sigText, publicKey: PUB, shellVersion: '3.0.0' })).toMatchObject({ ok: false, stage: 'signature' });
    // A signed but invalid manifest fails later, at the manifest stage.
    const bad = signed(manifestOf({ size: -1 }));
    expect(logic.checkManifest({ ...bad, publicKey: PUB, shellVersion: '3.0.0' })).toMatchObject({ ok: false, stage: 'manifest' });
    // Signed for another release (replay under a new tag).
    expect(logic.checkManifest({ ...signed(manifestOf()), publicKey: PUB, shellVersion: '3.0.0', feedVersion: '3.2.0' })).toMatchObject({ ok: false, stage: 'manifest' });
  });

  it('checks size before sha256', () => {
    expect(logic.checkPayload({ size: 10, sha256: HEX }, { size: 11, sha256: 'x' })).toMatchObject({ ok: false, stage: 'size' });
    expect(logic.checkPayload({ size: 10, sha256: HEX }, { size: 10, sha256: 'x' })).toMatchObject({ ok: false, stage: 'sha256' });
    expect(logic.checkPayload({ size: 10, sha256: HEX }, { size: 10, sha256: HEX })).toEqual({ ok: true });
  });
});

describe('feed host allow-list', () => {
  it('accepts only https GitHub hosts', () => {
    for (const u of [
      'https://api.github.com/repos/x/y/releases/latest',
      'https://github.com/Zwl20085/LittleWarGame/releases/download/v3.1.0/game-3.1.0.zip',
      'https://objects.githubusercontent.com/github-production-release-asset/1',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1',
    ]) expect(logic.isAllowedUrl(u)).toBe(true);
    for (const u of [
      'http://github.com/x', 'https://github.com:8443/x', 'https://evil.com/x', 'https://github.com.evil.com/x',
      'https://user:pw@github.com/x', 'file:///C:/x', 'https://127.0.0.1/x', 'ftp://github.com/x', 42, null, 'not a url',
    ]) expect(logic.isAllowedUrl(u)).toBe(false);
  });

  it('allows loopback only when asked (dev feed)', () => {
    expect(logic.isAllowedUrl('http://127.0.0.1:4000/feed', { allowLocal: true })).toBe(true);
    expect(logic.isAllowedUrl('http://127.0.0.1:4000/feed')).toBe(false);
    expect(logic.isAllowedUrl('http://evil.com/feed', { allowLocal: true })).toBe(false);
  });

  it('honours the env feed override only in an unpackaged shell', () => {
    const env = { LITTLEWAR_UPDATE_FEED: 'http://127.0.0.1:4000/feed' };
    expect(logic.resolveFeed(env, false)).toEqual({ url: env.LITTLEWAR_UPDATE_FEED, allowLocal: true });
    expect(logic.resolveFeed(env, true)).toEqual({ url: logic.FEED_URL, allowLocal: false });
    expect(logic.resolveFeed({ LITTLEWAR_UPDATE_FEED: 'https://evil.com/feed' }, false)).toBeNull();
    expect(logic.resolveFeed({}, false)).toEqual({ url: logic.FEED_URL, allowLocal: false });
  });

  it('parses a release feed and drops assets on foreign hosts', () => {
    const base = 'https://github.com/Zwl20085/LittleWarGame/releases/download/v3.1.0/';
    const feed = {
      tag_name: 'v3.1.0',
      assets: [
        { name: 'game-3.1.0.json', browser_download_url: `${base}game-3.1.0.json` },
        { name: 'game-3.1.0.json.sig', browser_download_url: `${base}game-3.1.0.json.sig` },
        { name: 'game-3.1.0.zip', browser_download_url: 'https://evil.com/game-3.1.0.zip' },
        { name: '../x', browser_download_url: `${base}x` },
      ],
    };
    const f = logic.parseFeed(feed);
    expect(f?.version).toBe('3.1.0');
    expect(Object.keys(f?.assets ?? {})).toEqual(['game-3.1.0.json', 'game-3.1.0.json.sig']);
    expect(logic.parseFeed({ ...feed, prerelease: true })).toBeNull();
    expect(logic.parseFeed({ ...feed, tag_name: 'nightly' })).toBeNull();
    expect(logic.parseFeed({ ...feed, assets: feed.assets.slice(0, 1) })).toBeNull();
  });
});

describe('zip reader (zip-slip and friends)', () => {
  const good = zip.writeZip([{ name: 'index.html', data: '<!doctype html>' }, { name: 'assets/app.js', data: 'x'.repeat(5000) }]);

  it('round-trips what the writer packs', () => {
    const entries = zip.readZip(good);
    expect(entries.map((e) => e.path)).toEqual(['index.html', 'assets/app.js']);
    expect(entries[1].data?.toString()).toBe('x'.repeat(5000));
  });

  it('normalises safe paths and refuses unsafe ones', () => {
    expect(zip.safeEntryPath('a/b.js')).toBe('a/b.js');
    expect(zip.safeEntryPath('a\\b.js')).toBe('a/b.js');
    for (const p of ['/etc/passwd', '../x', 'a/../../x', 'C:/x', 'c:x', '\\\\server\\share', 'a//b', './a', 'a\u0000b', 'a/b:ads', 'con. ', '']) {
      expect(zip.safeEntryPath(p)).toBeNull();
    }
  });

  it.each([
    ['parent traversal', 'assets/app.js', '../../../ap.js'.slice(0, 13)],
    ['absolute path', 'assets/app.js', '/tmp/evil.js!'.slice(0, 13)],
    ['drive letter', 'assets/app.js', 'C:/Windows/x1'],
    ['backslash traversal', 'assets/app.js', '..\\..\\evil.j'.padEnd(13, 's')],
  ])('rejects %s', (_label, from, to) => {
    expect(() => zip.readZip(forge(good, from, to))).toThrow(zip.ZipError);
  });

  it('rejects symlinks', () => {
    const link = zip.writeZip([{ name: 'index.html', data: 'x' }, { name: 'link', data: '/etc/passwd', mode: zip.S_IFLNK | 0o777 }]);
    expect(() => zip.readZip(link)).toThrow(/symlink/);
  });

  it('rejects oversize entries, archives and entry counts', () => {
    expect(() => zip.readZip(good, { maxEntryBytes: 100 })).toThrow(/too large/);
    expect(() => zip.readZip(good, { maxTotalBytes: 1000 })).toThrow(/too large/);
    expect(() => zip.readZip(good, { maxEntries: 1 })).toThrow(/too many/);
  });

  it('rejects corrupted data and duplicate names', () => {
    const bad = Buffer.from(good);
    bad[40] ^= 0xff; // inside the first entry's data
    expect(() => zip.readZip(bad)).toThrow(zip.ZipError);
    const dup = zip.writeZip([{ name: 'a.js', data: '1' }, { name: 'A.js', data: '2' }]);
    expect(() => zip.readZip(dup)).toThrow(/duplicate/);
    expect(() => zip.readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(zip.ZipError);
  });
});

describe('fallback state machine', () => {
  const S0 = logic.EMPTY_STATE;

  it('serves the newest good bundle newer than the built-in game', () => {
    expect(logic.onLaunch(S0, ['3.0.1', '3.0.2'], '3.0.0').serve).toBe('3.0.2');
    expect(logic.onLaunch(S0, ['2.9.0'], '3.0.0').serve).toBeNull();
    expect(logic.onLaunch({ ...S0, bad: ['3.0.2'] }, ['3.0.1', '3.0.2'], '3.0.0').serve).toBe('3.0.1');
  });

  it('marks a bundle bad after repeated launches that never reach ready, then uses the previous one', () => {
    let r = logic.onLaunch(S0, ['3.0.1', '3.0.2'], '3.0.0');
    expect(r.state.trial).toEqual({ version: '3.0.2', attempts: 1 });
    r = logic.onLaunch(r.state, ['3.0.1', '3.0.2'], '3.0.0');
    expect(r.state.trial).toEqual({ version: '3.0.2', attempts: 2 });
    r = logic.onLaunch(r.state, ['3.0.1', '3.0.2'], '3.0.0');
    expect(r.state.bad).toContain('3.0.2');
    expect(r.serve).toBe('3.0.1');
  });

  it('confirms on ready and marks bad on failure', () => {
    const r = logic.onLaunch(S0, ['3.0.1'], '3.0.0');
    const ok = logic.onReady(r.state, '3.0.1');
    expect(ok).toMatchObject({ trial: null, confirmed: ['3.0.1'] });
    expect(logic.onLaunch(ok, ['3.0.1'], '3.0.0').state.trial?.attempts).toBe(1);
    const failed = logic.onFailure(r.state, '3.0.1');
    expect(failed.bad).toEqual(['3.0.1']);
    expect(logic.onLaunch(failed, ['3.0.1'], '3.0.0').serve).toBeNull();
  });

  it('prunes bad bundles and keeps the newest two good ones plus the served one', () => {
    const st = { ...S0, bad: ['3.0.4'] };
    expect(logic.toPrune(st, ['3.0.1', '3.0.2', '3.0.3', '3.0.4'], null).sort()).toEqual(['3.0.1', '3.0.4']);
    expect(logic.toPrune(st, ['3.0.1', '3.0.2', '3.0.3', '3.0.4'], '3.0.1').sort()).toEqual(['3.0.4']);
  });

  it('survives garbage state', () => {
    expect(logic.normalizeState('x')).toEqual(S0);
    expect(logic.normalizeState({ bad: ['../x', '3.0.1'], trial: { version: 'x', attempts: 1 } })).toEqual({ bad: ['3.0.1'], confirmed: [], trial: null });
  });
});

describe('bundle store', () => {
  it('installs atomically, lists, persists state and removes', () => {
    const dir = tmp();
    const m = Buffer.from('{}');
    const archive = zip.writeZip([{ name: 'index.html', data: 'hi' }, { name: 'assets/a.js', data: 'a' }]);
    store.installBundle(dir, '3.0.1', archive, m);
    expect(readFileSync(join(dir, '3.0.1', 'assets', 'a.js'), 'utf8')).toBe('a');
    expect(store.listInstalled(dir)).toEqual(['3.0.1']);
    store.writeState(dir, logic.onFailure(logic.EMPTY_STATE, '3.0.1'));
    expect(store.readState(dir).bad).toEqual(['3.0.1']);
    store.removeBundles(dir, ['3.0.1']);
    expect(store.listInstalled(dir)).toEqual([]);
  });

  it('leaves nothing behind when an archive is hostile or lacks index.html', () => {
    const dir = tmp();
    const archive = zip.writeZip([{ name: 'index.html', data: 'x' }, { name: 'assets/app.js', data: 'y' }]);
    expect(() => store.installBundle(dir, '3.0.2', forge(archive, 'assets/app.js', '../../evil.js'), Buffer.from('{}'))).toThrow();
    expect(() => store.installBundle(dir, '3.0.2', zip.writeZip([{ name: 'a.js', data: 'x' }]), Buffer.from('{}'))).toThrow(/index.html/);
    expect(() => store.installBundle(dir, '../3.0.2', archive, Buffer.from('{}'))).toThrow();
    expect(existsSync(join(dir, '3.0.2'))).toBe(false);
    expect(existsSync(join(dir, '..', 'evil.js'))).toBe(false);
    expect(readdirSync(dir).filter((n) => n.startsWith('.staging'))).toEqual([]);
  });

  it('cleans up interrupted installs', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.staging-3.0.1-abcd'));
    writeFileSync(join(dir, 'x.zip.part'), 'x');
    store.cleanupStaging(dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('pack → verify → install round trip', () => {
  it('packs dist-like files into a bundle the shell accepts', async () => {
    const dist = tmp();
    const out = tmp();
    writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'main.js'), 'console.log(1)');
    const packPath = '../scripts/release/pack.mjs';
    const pack = (await import(/* @vite-ignore */ packPath)) as { packGame: (o: object) => { manifest: { sha256: string; size: number }; paths: { zip: string; manifest: string; sig: string } } };
    const res = pack.packGame({ dist, out, version: '3.0.7', minShell: '3.0.0', privateKey: keys.privateKey });
    const manifestBytes = readFileSync(res.paths.manifest);
    const v = logic.checkManifest({ manifestBytes, sigText: readFileSync(res.paths.sig, 'utf8'), publicKey: PUB, shellVersion: '3.0.0', feedVersion: '3.0.7' });
    expect(v.ok && v.kind).toBe('bundle');
    const zipBuf = readFileSync(res.paths.zip);
    expect(logic.checkPayload(res.manifest, { size: zipBuf.length, sha256: logic.sha256(zipBuf) })).toEqual({ ok: true });
    const dir = tmp();
    store.installBundle(dir, '3.0.7', zipBuf, manifestBytes);
    expect(readFileSync(join(dir, '3.0.7', 'assets', 'main.js'), 'utf8')).toBe('console.log(1)');
  });
});
