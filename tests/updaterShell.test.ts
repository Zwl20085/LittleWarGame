/**
 * electron/updater.cjs driven in node with a fake Electron (app, net, window, ipc): the full
 * check → download → verify → install → serve → fallback flow against an in-memory release
 * feed signed with a throwaway key, including tampered zip / manifest / signature.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const logic = require('../electron/updateLogic.cjs') as typeof import('../electron/updateLogic.cjs');
const zip = require('../electron/zip.cjs') as typeof import('../electron/zip.cjs');
const store = require('../electron/bundle.cjs') as typeof import('../electron/bundle.cjs');

interface Updater {
  init(): void;
  root(): string;
  attach(w: unknown): void;
  registerIpc(): void;
  check(): Promise<void>;
  status(): { state: string; version: string | null; serving: { source: string; version: string } };
}
const { createUpdater } = require('../electron/updater.cjs') as { createUpdater: (deps: unknown) => Updater };

const FEED = 'http://127.0.0.1:9/feed';
const SHELL = '3.0.0';
const keys = generateKeyPairSync('ed25519');
const PUB = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

type Route = { body: Buffer } | { redirect: string };
let routes: Record<string, Route> = {};
const requested: string[] = [];

/** Minimal stand-in for Electron's net.request (manual redirects, streamed body). */
function fakeNet() {
  return {
    request(opts: { url: string }) {
      const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
      let url = opts.url;
      let follow = false;
      req.setHeader = () => undefined;
      req.abort = () => undefined;
      req.followRedirect = () => { follow = true; };
      const serve = (): void => {
        requested.push(url);
        const r = routes[url];
        if (r && 'redirect' in r) {
          follow = false;
          req.emit('redirect', 302, 'GET', r.redirect);
          if (follow) {
            url = r.redirect;
            setImmediate(serve);
          }
          return;
        }
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
        res.statusCode = r ? 200 : 404;
        res.headers = r ? { 'content-length': String(r.body.length) } : {};
        req.emit('response', res);
        if (!r) return;
        for (let i = 0; i < r.body.length; i += 4096) res.emit('data', r.body.subarray(i, i + 4096));
        res.emit('end');
      };
      req.end = () => setImmediate(serve);
      return req;
    },
  };
}

interface Release { version: string; zip: Buffer; manifest: Buffer; sig: string; extra?: Record<string, Buffer> }

function makeRelease(version: string, opts: { minShell?: string; files?: { name: string; data: string }[]; key?: KeyObject; installers?: Record<string, { name: string; data: Buffer }> } = {}): Release {
  const z = zip.writeZip(opts.files ?? [{ name: 'index.html', data: `<!doctype html>game ${version}` }, { name: 'assets/main.js', data: 'ok' }]);
  const installers: Record<string, { name: string; sha256: string; size: number }> = {};
  const extra: Record<string, Buffer> = {};
  for (const [kind, f] of Object.entries(opts.installers ?? {})) {
    installers[kind] = { name: f.name, sha256: logic.sha256(f.data), size: f.data.length };
    extra[f.name] = f.data;
  }
  const manifest = Buffer.from(JSON.stringify({ schema: 1, version, minShell: opts.minShell ?? SHELL, file: `game-${version}.zip`, sha256: logic.sha256(z), size: z.length, installers }));
  return { version, zip: z, manifest, sig: logic.signManifest(manifest, opts.key ?? keys.privateKey), extra };
}

/** Publish a release on the fake feed; assets go through one redirect like GitHub's. */
function publish(r: Release): void {
  const files: Record<string, Buffer> = {
    [`game-${r.version}.json`]: r.manifest,
    [`game-${r.version}.json.sig`]: Buffer.from(r.sig),
    [`game-${r.version}.zip`]: r.zip,
    ...r.extra,
  };
  routes = {
    [FEED]: { body: Buffer.from(JSON.stringify({ tag_name: `v${r.version}`, assets: Object.keys(files).map((name) => ({ name, browser_download_url: `http://127.0.0.1:9/dl/${name}` })) })) },
  };
  for (const [name, body] of Object.entries(files)) {
    routes[`http://127.0.0.1:9/dl/${name}`] = { redirect: `http://localhost:9/blob/${name}` };
    routes[`http://localhost:9/blob/${name}`] = { body };
  }
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

let profile = '';
beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'lwg-shell-'));
  roots.push(profile);
  requested.length = 0;
  vi.stubEnv('LITTLEWAR_UPDATE_FEED', FEED);
  vi.stubEnv('LITTLEWAR_UPDATE_PUBKEY', PUB);
  vi.stubEnv('LITTLEWAR_UPDATE_READY_MS', '50');
  vi.stubEnv('LITTLEWAR_DOWNLOADS', join(profile, 'Downloads'));
  vi.stubEnv('LITTLEWAR_UPDATE_LOG', join(profile, 'log.jsonl'));
});
afterEach(() => vi.unstubAllEnvs());

function events(): { event: string; [k: string]: unknown }[] {
  const f = join(profile, 'log.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** One "launch" of the shell: a fresh updater + fake window on the same profile. */
function launch(opts: { isPackaged?: boolean } = {}) {
  const app = { isPackaged: opts.isPackaged ?? false, getVersion: () => SHELL, getPath: (k: string) => join(profile, k) };
  const ipc = { handle: vi.fn(), on: vi.fn() };
  const u = createUpdater({ app, net: fakeNet(), shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }, ipcMain: ipc, builtinRoot: 'BUILTIN' });
  const wc = Object.assign(new EventEmitter(), { send: vi.fn(), session: { clearCache: () => Promise.resolve() } });
  const loads: string[] = [];
  const win = { webContents: wc, isDestroyed: () => false, loadURL: (x: string) => { loads.push(x); return Promise.resolve(); } };
  u.init();
  u.registerIpc();
  u.attach(win);
  const send = (channel: string) => {
    const call = ipc.on.mock.calls.find((c) => c[0] === channel);
    call?.[1]({ senderFrame: { url: 'app://game/index.html' } });
  };
  return { u, win, wc, loads, send };
}

const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('updater shell (fake Electron)', () => {
  it('(a) installs a good bundle, serves it next launch and confirms it on ready', async () => {
    publish(makeRelease('3.1.0'));
    const one = launch();
    expect(one.u.root()).toBe('BUILTIN');
    await one.u.check();
    await until(() => one.u.status().state === 'ready');
    expect(existsSync(join(profile, 'userData', 'bundles', '3.1.0', 'index.html'))).toBe(true);
    expect(requested.some((u) => u.startsWith('http://localhost:9/blob/'))).toBe(true); // redirect followed
    const two = launch();
    expect(two.u.root()).toBe(join(profile, 'userData', 'bundles', '3.1.0'));
    expect(two.u.status().serving).toEqual({ source: 'bundle', version: '3.1.0' });
    two.send('updater:ready');
    await new Promise((r) => setTimeout(r, 80));
    expect(two.loads).toEqual([]); // no fallback
    expect(store.readState(join(profile, 'userData', 'bundles')).confirmed).toEqual(['3.1.0']);
  });

  it('(b) rejects a tampered zip at sha256 and installs nothing', async () => {
    const r = makeRelease('3.1.0');
    const z = Buffer.from(r.zip);
    z[z.length >> 1] ^= 0x5a;
    publish({ ...r, zip: z });
    const one = launch();
    await one.u.check();
    await until(() => one.u.status().state === 'error');
    expect(events().find((e) => e.event === 'rejected')).toMatchObject({ stage: 'sha256' });
    expect(store.listInstalled(join(profile, 'userData', 'bundles'))).toEqual([]);
  });

  it('(c) rejects a tampered manifest and a foreign signature before downloading the zip', async () => {
    const r = makeRelease('3.1.0');
    publish({ ...r, manifest: Buffer.from(r.manifest.toString().replace('"minShell":"3.0.0"', '"minShell":"1.0.0"')) });
    const one = launch();
    await one.u.check();
    expect(events().find((e) => e.event === 'rejected')).toMatchObject({ stage: 'signature' });
    expect(requested.some((u) => u.endsWith('.zip'))).toBe(false);
    publish(makeRelease('3.1.0', { key: generateKeyPairSync('ed25519').privateKey }));
    const two = launch();
    await two.u.check();
    expect(events().filter((e) => e.event === 'rejected').map((e) => e.stage)).toEqual(['signature', 'signature']);
  });

  it('(d) falls back to the built-in game when the bundle never signals ready, and remembers it', async () => {
    publish(makeRelease('3.1.0', { files: [{ name: 'index.html', data: '<!doctype html>blank' }] }));
    const one = launch();
    await one.u.check();
    await until(() => one.u.status().state === 'ready');
    const two = launch();
    expect(two.u.status().serving.source).toBe('bundle');
    await until(() => two.loads.length > 0);
    expect(two.loads).toEqual(['app://game/index.html']);
    expect(two.u.root()).toBe('BUILTIN');
    expect(store.readState(join(profile, 'userData', 'bundles')).bad).toEqual(['3.1.0']);
    const three = launch();
    expect(three.u.root()).toBe('BUILTIN');
    await three.u.check();
    expect(three.u.status().state).toBe('up-to-date'); // known bad: not downloaded again
  });

  it('(d2) also falls back when the page fails to load or the renderer dies', async () => {
    publish(makeRelease('3.1.0'));
    const one = launch();
    await one.u.check();
    await until(() => one.u.status().state === 'ready');
    vi.stubEnv('LITTLEWAR_UPDATE_READY_MS', '60000');
    const two = launch();
    two.wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'app://game/index.html', true);
    await until(() => two.loads.length > 0);
    expect(two.u.root()).toBe('BUILTIN');
  });

  it('(e) downloads (never runs) the verified installer when the shell is too old', async () => {
    const exe = Buffer.from('MZ fake installer');
    publish(makeRelease('4.0.0', { minShell: '4.0.0', installers: { setup: { name: 'LittleWar-4.0.0-setup.exe', data: exe } } }));
    const one = launch();
    await one.u.check();
    await until(() => one.u.status().state === 'installer-ready');
    expect(readFileSync(join(profile, 'Downloads', 'LittleWar-4.0.0-setup.exe'))).toEqual(exe);
    expect(requested.some((u) => u.endsWith('.zip'))).toBe(false);
    expect(store.listInstalled(join(profile, 'userData', 'bundles'))).toEqual([]);
  });

  it('(e2) rejects a tampered installer', async () => {
    const r = makeRelease('4.0.0', { minShell: '4.0.0', installers: { setup: { name: 'LittleWar-4.0.0-setup.exe', data: Buffer.from('MZ good') } } });
    publish({ ...r, extra: { 'LittleWar-4.0.0-setup.exe': Buffer.from('MZ evil') } });
    const one = launch();
    await one.u.check();
    await until(() => one.u.status().state === 'error');
    expect(existsSync(join(profile, 'Downloads', 'LittleWar-4.0.0-setup.exe'))).toBe(false);
  });

  it('ignores the env feed and test key in a packaged shell (placeholder key = no hot update)', async () => {
    publish(makeRelease('3.1.0'));
    const one = launch({ isPackaged: true });
    await one.u.check();
    expect(one.u.status().state).toBe('unavailable');
    expect(requested).toEqual([]);
  });
});
