// Hot updater (docs/UPDATER.md, V23_SPEC §2): checks the GitHub release feed, downloads a
// signed game bundle into userData/bundles/<ver>/, serves the newest good bundle through
// app://, falls back to the built-in dist/ when a bundle does not reach the title screen, and
// downloads (never runs) the full installer when a release needs a newer shell.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const logic = require('./updateLogic.cjs');
const store = require('./bundle.cjs');
const { httpGet } = require('./fetch.cjs');

/**
 * Ed25519 public key (base64 SPKI DER) that verifies game bundle manifests. Printed by
 * `node scripts/release/keygen.mjs`; paste it here once. While it is the placeholder the shell
 * never installs bundles and the title screen keeps the plain "new version" notice.
 */
const UPDATE_PUBLIC_KEY = logic.PLACEHOLDER_KEY;

const DEFAULT_READY_MS = 30000;
const RELEASE_PAGE = 'https://github.com/Zwl20085/LittleWarGame/releases/tag/v';

/** Dev-only knobs (ignored in a packaged shell): see docs/UPDATER.md "Testing". */
function devEnv(app) {
  if (app.isPackaged) return {};
  const e = process.env;
  return {
    publicKey: e.LITTLEWAR_UPDATE_PUBKEY || undefined,
    readyMs: Number(e.LITTLEWAR_UPDATE_READY_MS) > 0 ? Number(e.LITTLEWAR_UPDATE_READY_MS) : undefined,
    logFile: e.LITTLEWAR_UPDATE_LOG || undefined,
    downloads: e.LITTLEWAR_DOWNLOADS || undefined,
  };
}

function createUpdater({ app, net, shell, ipcMain, builtinRoot }) {
  const dev = devEnv(app);
  const publicKey = dev.publicKey ?? UPDATE_PUBLIC_KEY;
  const readyMs = dev.readyMs ?? DEFAULT_READY_MS;
  const shellVersion = app.getVersion();
  const builtinVersion = shellVersion;
  const dir = path.join(app.getPath('userData'), 'bundles');
  const settingsFile = path.join(app.getPath('userData'), 'updater.json');
  const feed = logic.resolveFeed(process.env, app.isPackaged);

  let serving = null; // bundle version being served, or null for the built-in dist/
  let win = null;
  let readyTimer = null;
  let checked = false;
  let pending = null; // { kind, manifest, feed } offered but not downloaded (auto-download off)
  let installerPath = null;
  let status = { state: 'idle', version: null, progress: null, installerName: null, error: null };
  let autoDownload = readAutoDownload();

  function log(event, data = {}) {
    if (!dev.logFile) return;
    try {
      fs.appendFileSync(dev.logFile, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`);
    } catch {
      // test log only
    }
  }

  function readAutoDownload() {
    try {
      const v = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return typeof v.autoDownload === 'boolean' ? v.autoDownload : true;
    } catch {
      return true;
    }
  }

  function publicStatus() {
    const v = status.version;
    return Object.freeze({
      ...status,
      autoDownload,
      shellVersion,
      serving: Object.freeze({ source: serving ? 'bundle' : 'builtin', version: serving ?? builtinVersion }),
      releaseUrl: v ? `${RELEASE_PAGE}${v}` : null,
    });
  }

  function setStatus(patch) {
    status = { ...status, ...patch };
    if (win && !win.isDestroyed()) win.webContents.send('updater:status-changed', publicStatus());
  }

  // ------------------------------------------------------------ serving + fallback

  /** Pick what to serve this launch (before the window exists). */
  function init() {
    store.cleanupStaging(dir);
    const installed = store.listInstalled(dir);
    const { state, serve } = logic.onLaunch(store.readState(dir), installed, builtinVersion);
    store.writeState(dir, state);
    serving = serve;
    store.removeBundles(dir, logic.toPrune(state, installed, serving));
    log('serving', { source: serving ? 'bundle' : 'builtin', version: serving ?? builtinVersion });
  }

  function root() {
    return serving ? store.bundlePath(dir, serving) : builtinRoot;
  }

  function fallBack(reason) {
    if (!serving) return;
    const bad = serving;
    clearTimeout(readyTimer);
    store.writeState(dir, logic.onFailure(store.readState(dir), bad));
    serving = null;
    console.warn(`[updater] bundle ${bad} failed (${reason}); falling back to the built-in game`);
    log('fallback', { version: bad, reason });
    if (win && !win.isDestroyed()) {
      win.webContents.session.clearCache().finally(() => win.loadURL('app://game/index.html'));
    }
  }

  function attach(w) {
    win = w;
    if (serving) readyTimer = setTimeout(() => fallBack('not ready in time'), readyMs);
    w.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) fallBack(`load failed: ${desc}`);
    });
    w.webContents.on('render-process-gone', (_e, details) => fallBack(`renderer gone: ${details.reason}`));
  }

  function onRendererReady() {
    log('ready', { source: serving ? 'bundle' : 'builtin', version: serving ?? builtinVersion });
    if (!serving) return;
    clearTimeout(readyTimer);
    store.writeState(dir, logic.onReady(store.readState(dir), serving));
  }

  // ------------------------------------------------------------ check + download

  async function check() {
    if (checked) return;
    checked = true;
    if (!feed || logic.isPlaceholderKey(publicKey)) {
      setStatus({ state: 'unavailable' });
      return;
    }
    setStatus({ state: 'checking' });
    try {
      const raw = await httpGet(net, feed.url, { allowLocal: feed.allowLocal, maxBytes: logic.LIMITS.feedBytes, accept: 'application/vnd.github+json' });
      const rel = logic.parseFeed(JSON.parse(raw.body.toString('utf8')), { allowLocal: feed.allowLocal });
      const current = serving ?? builtinVersion;
      if (!rel || !logic.isNewer(rel.version, current)) {
        setStatus({ state: 'up-to-date' });
        log('up-to-date', { latest: rel && rel.version });
        return;
      }
      const verdict = await fetchManifest(rel);
      if (!verdict) return;
      act(verdict, rel);
    } catch (err) {
      fail('check', err);
    }
  }

  async function fetchManifest(rel) {
    const opts = { allowLocal: feed.allowLocal, accept: 'application/octet-stream' };
    const manifest = await httpGet(net, rel.assets[rel.manifestName], { ...opts, maxBytes: logic.LIMITS.manifestBytes });
    const sig = await httpGet(net, rel.assets[rel.sigName], { ...opts, maxBytes: logic.LIMITS.sigBytes });
    const v = logic.checkManifest({ manifestBytes: manifest.body, sigText: sig.body.toString('utf8'), publicKey, shellVersion, feedVersion: rel.version });
    if (!v.ok) {
      log('rejected', { stage: v.stage, error: v.error, version: rel.version });
      setStatus({ state: 'error', version: rel.version, error: `${v.stage}: ${v.error}` });
      return null;
    }
    return { ...v, manifestBytes: manifest.body };
  }

  function act(verdict, rel) {
    const decision = logic.decide({ manifest: verdict.manifest, kind: verdict.kind, servingVersion: serving ?? builtinVersion, installed: store.listInstalled(dir), bad: store.readState(dir).bad });
    log('decision', { decision, version: verdict.manifest.version });
    const version = verdict.manifest.version;
    if (decision === 'up-to-date' || decision === 'known-bad') return setStatus({ state: 'up-to-date' });
    if (decision === 'already-installed') return setStatus({ state: 'ready', version });
    pending = { verdict, rel };
    if (!autoDownload) return setStatus({ state: 'available', version, needsInstaller: decision === 'installer' });
    return startPending();
  }

  function startPending() {
    if (!pending) return undefined;
    const { verdict, rel } = pending;
    pending = null;
    const job = verdict.kind === 'installer' ? downloadInstaller(verdict.manifest, rel) : downloadBundle(verdict, rel);
    return job.catch((err) => fail('download', err));
  }

  async function downloadBundle({ manifest, manifestBytes }, rel) {
    const url = rel.assets[manifest.file];
    if (!url) throw new Error(`release has no ${manifest.file}`);
    setStatus({ state: 'downloading', version: manifest.version, progress: 0 });
    const hash = crypto.createHash('sha256');
    const parts = [];
    const res = await httpGet(net, url, {
      allowLocal: feed.allowLocal,
      accept: 'application/octet-stream',
      maxBytes: manifest.size,
      onChunk: (c) => { hash.update(c); parts.push(c); },
      onProgress: (n) => setStatus({ progress: Math.min(1, n / manifest.size) }),
    });
    const ok = logic.checkPayload(manifest, { size: res.size, sha256: hash.digest('hex') });
    if (!ok.ok) {
      log('rejected', { stage: ok.stage, error: ok.error, version: manifest.version });
      setStatus({ state: 'error', error: `${ok.stage}: ${ok.error}`, progress: null });
      return;
    }
    store.installBundle(dir, manifest.version, Buffer.concat(parts), manifestBytes);
    const state = store.readState(dir);
    store.removeBundles(dir, logic.toPrune(state, store.listInstalled(dir), serving));
    log('installed', { version: manifest.version });
    setStatus({ state: 'ready', version: manifest.version, progress: 1 });
  }

  async function downloadInstaller(manifest, rel) {
    const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
    const ref = logic.pickInstaller(manifest, isPortable);
    const url = ref && rel.assets[ref.name];
    if (!ref || !url) {
      setStatus({ state: 'available', version: manifest.version, needsInstaller: true });
      return;
    }
    const downloads = dev.downloads ?? app.getPath('downloads');
    const final = path.join(downloads, ref.name);
    if (fs.existsSync(final) && (await fileSha256(final)) === ref.sha256) {
      return installerDone(final, ref, manifest.version);
    }
    setStatus({ state: 'installer-downloading', version: manifest.version, progress: 0, installerName: ref.name });
    fs.mkdirSync(downloads, { recursive: true });
    const part = `${final}.${crypto.randomBytes(4).toString('hex')}.part`;
    const fd = fs.openSync(part, 'w');
    const hash = crypto.createHash('sha256');
    let res;
    try {
      res = await httpGet(net, url, {
        allowLocal: feed.allowLocal,
        accept: 'application/octet-stream',
        maxBytes: ref.size ?? logic.LIMITS.installerBytes,
        onChunk: (c) => { hash.update(c); fs.writeSync(fd, c); },
        onProgress: (n, total) => setStatus({ progress: (ref.size || total) ? Math.min(1, n / (ref.size || total)) : null }),
      });
    } finally {
      fs.closeSync(fd);
    }
    const ok = logic.checkPayload(ref, { size: res.size, sha256: hash.digest('hex') });
    if (!ok.ok) {
      fs.rmSync(part, { force: true });
      log('rejected', { stage: ok.stage, error: ok.error, installer: ref.name });
      setStatus({ state: 'error', error: `${ok.stage}: ${ok.error}`, progress: null });
      return;
    }
    fs.rmSync(final, { force: true });
    fs.renameSync(part, final);
    return installerDone(final, ref, manifest.version);
  }

  function installerDone(file, ref, version) {
    installerPath = file;
    log('installer', { name: ref.name, version });
    setStatus({ state: 'installer-ready', version, progress: 1, installerName: ref.name });
  }

  function fail(stage, err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[updater] ${stage} failed:`, msg);
    log('error', { stage, error: msg });
    setStatus({ state: 'error', error: msg, progress: null });
  }

  function fileSha256(file) {
    return new Promise((resolve) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(null));
    });
  }

  // ------------------------------------------------------------ renderer bridge

  function fromGame(e) {
    const url = e.senderFrame && e.senderFrame.url;
    return typeof url === 'string' && url.startsWith('app://game/');
  }

  function registerIpc() {
    ipcMain.handle('updater:status', (e) => (fromGame(e) ? publicStatus() : null));
    ipcMain.on('updater:ready', (e) => { if (fromGame(e)) onRendererReady(); });
    ipcMain.on('updater:check', (e) => { if (fromGame(e)) void check(); });
    ipcMain.on('updater:restart', (e) => {
      if (!fromGame(e) || status.state !== 'ready') return;
      const exe = process.env.PORTABLE_EXECUTABLE_FILE;
      app.relaunch(exe ? { execPath: exe } : undefined);
      app.exit(0);
    });
    ipcMain.on('updater:open-downloads', (e) => {
      if (!fromGame(e)) return;
      if (installerPath && fs.existsSync(installerPath)) shell.showItemInFolder(installerPath);
      else void shell.openPath(dev.downloads ?? app.getPath('downloads'));
    });
    ipcMain.handle('updater:set-auto', (e, on) => {
      if (!fromGame(e) || typeof on !== 'boolean') return null;
      autoDownload = on;
      try {
        store.writeFileAtomic(settingsFile, JSON.stringify({ autoDownload }));
      } catch (err) {
        console.warn('[updater] could not save settings:', err && err.message);
      }
      if (on && pending) void startPending();
      else setStatus({});
      return publicStatus();
    });
  }

  return { init, root, attach, registerIpc, check, status: publicStatus };
}

module.exports = { createUpdater, UPDATE_PUBLIC_KEY };
