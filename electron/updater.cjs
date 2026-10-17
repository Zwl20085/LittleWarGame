// Hot updater (docs/UPDATER.md, V23_SPEC §2): checks the GitHub release feed, downloads a
// signed game bundle into userData/bundles/<ver>/, serves the newest good bundle through
// app://, falls back to the built-in dist/ when a bundle does not reach the title screen, and
// downloads (never runs) the full installer when a release needs a newer shell.
//
// This file composes the two halves around one shared context: updateCheck.cjs (feed check, decide,
// download / verify / install) and updateServe.cjs (serving, trial / ready / fallback, relaunch).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logic = require('./updateLogic.cjs');
const store = require('./bundle.cjs');
const { createCheck } = require('./updateCheck.cjs');
const { createServe } = require('./updateServe.cjs');

/**
 * Ed25519 public key (base64 SPKI DER) that verifies game bundle manifests. Printed by
 * `node scripts/release/keygen.mjs`; paste it here once. While it is the placeholder the shell
 * never installs bundles and the title screen keeps the plain "new version" notice.
 */
const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEABtzQVf6yjdoPuLitgXYfDivKuoRSmi+iuqtzg8PrPd8=';

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

function readAutoDownload(settingsFile) {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return typeof v.autoDownload === 'boolean' ? v.autoDownload : true;
  } catch {
    return true;
  }
}

/** The state both halves share: fixed config plus the few fields they mutate (serving, win, status, pending, ...). */
function createContext({ app, net, shell, ipcMain, builtinRoot }) {
  const dev = devEnv(app);
  const shellVersion = app.getVersion();
  const settingsFile = path.join(app.getPath('userData'), 'updater.json');
  const ctx = {
    app, net, shell, ipcMain, builtinRoot, dev, shellVersion, settingsFile,
    publicKey: dev.publicKey ?? UPDATE_PUBLIC_KEY,
    readyMs: dev.readyMs ?? DEFAULT_READY_MS,
    builtinVersion: shellVersion,
    dir: path.join(app.getPath('userData'), 'bundles'),
    feed: logic.resolveFeed(process.env, app.isPackaged),
    serving: null, // bundle version being served, or null for the built-in dist/
    win: null,
    pending: null, // { verdict, rel } offered but not downloaded (auto-download off)
    installerPath: null,
    status: { state: 'idle', version: null, progress: null, installerName: null, error: null },
    autoDownload: readAutoDownload(settingsFile),
    downloadsDir: () => dev.downloads ?? app.getPath('downloads'),
    log(event, data = {}) {
      if (!dev.logFile) return;
      try {
        fs.appendFileSync(dev.logFile, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`);
      } catch {
        // test log only
      }
    },
    publicStatus() {
      const v = ctx.status.version;
      return Object.freeze({
        ...ctx.status,
        autoDownload: ctx.autoDownload,
        shellVersion,
        serving: Object.freeze({ source: ctx.serving ? 'bundle' : 'builtin', version: ctx.serving ?? ctx.builtinVersion }),
        releaseUrl: v ? `${RELEASE_PAGE}${v}` : null,
      });
    },
    setStatus(patch) {
      ctx.status = { ...ctx.status, ...patch };
      if (ctx.win && !ctx.win.isDestroyed()) ctx.win.webContents.send('updater:status-changed', ctx.publicStatus());
    },
  };
  return ctx;
}

function fromGame(e) {
  const url = e.senderFrame && e.senderFrame.url;
  return typeof url === 'string' && url.startsWith('app://game/');
}

function createUpdater(deps) {
  const ctx = createContext(deps);
  const serve = createServe(ctx);
  const { check, startPending } = createCheck(ctx);

  /** Renderer bridge: every channel only answers the game page (app://game/). */
  function registerIpc() {
    const { ipcMain, shell } = ctx;
    ipcMain.handle('updater:status', (e) => (fromGame(e) ? ctx.publicStatus() : null));
    ipcMain.on('updater:ready', (e) => { if (fromGame(e)) serve.onRendererReady(); });
    ipcMain.on('updater:check', (e) => { if (fromGame(e)) void check(); });
    ipcMain.on('updater:restart', (e) => {
      if (!fromGame(e) || ctx.status.state !== 'ready') return;
      serve.restart();
    });
    ipcMain.on('updater:open-downloads', (e) => {
      if (!fromGame(e)) return;
      if (ctx.installerPath && fs.existsSync(ctx.installerPath)) shell.showItemInFolder(ctx.installerPath);
      else void shell.openPath(ctx.downloadsDir());
    });
    ipcMain.handle('updater:set-auto', (e, on) => {
      if (!fromGame(e) || typeof on !== 'boolean') return null;
      ctx.autoDownload = on;
      try {
        store.writeFileAtomic(ctx.settingsFile, JSON.stringify({ autoDownload: ctx.autoDownload }));
      } catch (err) {
        console.warn('[updater] could not save settings:', err && err.message);
      }
      if (on && ctx.pending) void startPending();
      else ctx.setStatus({});
      return ctx.publicStatus();
    });
  }

  return { init: serve.init, root: serve.root, attach: serve.attach, registerIpc, check, status: ctx.publicStatus };
}

module.exports = { createUpdater, UPDATE_PUBLIC_KEY };
