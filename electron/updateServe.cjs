// Hot updater, serving half (docs/UPDATER.md, V23_SPEC §2): picks which bundle to serve through
// app:// at launch, runs the trial / ready / fallback / markBad cycle, and relaunches the shell.
// State lives on the shared `ctx` built by updater.cjs (serving, win, dir, ...).
'use strict';

const fs = require('node:fs');
const logic = require('./updateLogic.cjs');
const store = require('./bundle.cjs');

function createServe(ctx) {
  let readyTimer = null;
  let confirmedThisLaunch = false; // the served bundle reached ready: its trial is over

  /** Persist the bundle state; never throws (a failed write must not block the fallback). */
  function saveState(next) {
    try {
      store.writeState(ctx.dir, next);
    } catch (err) {
      console.warn('[updater] could not save bundle state:', err && err.message);
      ctx.log('error', { stage: 'state', error: String(err && err.message) });
    }
  }

  /** Pick what to serve this launch (before the window exists). */
  function init() {
    store.cleanupStaging(ctx.dir);
    const installed = store.listInstalled(ctx.dir, ctx.shellVersion);
    const { state, serve } = logic.onLaunch(store.readState(ctx.dir), installed, ctx.builtinVersion);
    saveState(state);
    ctx.serving = serve;
    store.removeBundles(ctx.dir, logic.toPrune(state, installed, ctx.serving));
    ctx.log('serving', { source: ctx.serving ? 'bundle' : 'builtin', version: ctx.serving ?? ctx.builtinVersion });
  }

  function root() {
    return ctx.serving ? store.bundlePath(ctx.dir, ctx.serving) : ctx.builtinRoot;
  }

  function reloadGame(clear) {
    const win = ctx.win;
    if (!win || win.isDestroyed()) return;
    const reload = () => { if (!win.isDestroyed()) win.loadURL('app://game/index.html').catch(() => undefined); };
    if (clear) win.webContents.session.clearCache().then(reload, reload);
    else reload();
  }

  function fallBack(reason) {
    if (!ctx.serving) return;
    if (confirmedThisLaunch) {
      // The bundle already reached the title screen this launch, so it is not the culprit of a
      // later crash or failed navigation: just reload, never blame (and demote) it.
      ctx.log('reload', { version: ctx.serving, reason });
      reloadGame(false);
      return;
    }
    const bad = ctx.serving;
    clearTimeout(readyTimer);
    ctx.serving = null; // serve the built-in game from now on, whatever happens below
    saveState(logic.onFailure(store.readState(ctx.dir), bad));
    console.warn(`[updater] bundle ${bad} failed (${reason}); falling back to the built-in game`);
    ctx.log('fallback', { version: bad, reason });
    reloadGame(true);
  }

  function attach(w) {
    ctx.win = w;
    if (ctx.serving) readyTimer = setTimeout(() => fallBack('not ready in time'), ctx.readyMs);
    w.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) fallBack(`load failed: ${desc}`);
    });
    w.webContents.on('render-process-gone', (_e, details) => fallBack(`renderer gone: ${details.reason}`));
  }

  function onRendererReady() {
    ctx.log('ready', { source: ctx.serving ? 'bundle' : 'builtin', version: ctx.serving ?? ctx.builtinVersion });
    if (!ctx.serving) return;
    clearTimeout(readyTimer);
    confirmedThisLaunch = true;
    saveState(logic.onReady(store.readState(ctx.dir), ctx.serving));
  }

  /** Relaunch the shell (the portable build relaunches its stable launcher path) to pick up a ready bundle. */
  function restart() {
    const exe = logic.portableRelaunchPath(process.env.PORTABLE_EXECUTABLE_FILE, fs.existsSync) ?? process.execPath;
    ctx.app.relaunch({ execPath: exe });
    ctx.app.exit(0);
  }

  return { init, root, attach, onRendererReady, restart };
}

module.exports = { createServe };
