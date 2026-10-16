// Standalone desktop shell: serves the built game (dist/) over a privileged app:// scheme so
// module scripts and the simulation Web Worker load exactly as they do on a web server.
const { app, BrowserWindow, Menu, ipcMain, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createUpdater } = require('./updater.cjs');

const BUILTIN_ROOT = path.join(__dirname, '..', 'dist');
// Dev-only: a throwaway profile for the updater end-to-end test (scripts/release/updater-e2e.mjs).
if (!app.isPackaged && process.env.LITTLEWAR_USER_DATA) app.setPath('userData', process.env.LITTLEWAR_USER_DATA);
const updater = createUpdater({ app, net, shell, ipcMain, builtinRoot: BUILTIN_ROOT });
// Only the bundled game plus Google Fonts (the UI typefaces); no remote scripts at all. The one
// remote request is the update check against the GitHub releases API (src/ui/updateCheck.ts).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data: https://api.github.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/** Serves the built-in dist/ or, after a verified hot update, userData/bundles/<ver>/. */
function serveGame() {
  protocol.handle('app', (req) => {
    const root = updater.root();
    let file;
    try {
      file = path.normalize(path.join(root, decodeURIComponent(new URL(req.url).pathname)));
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    // Never serve anything outside the game bundle.
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString()).catch(() => new Response('Not found', { status: 404 })).then((res) => {
      if (!file.endsWith('.html')) return res;
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    });
  });
}

/** https://github.com/… only (no credentials, no other host or port). */
function isSafeExternal(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.port === '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    title: 'Little War',
    backgroundColor: '#1b1a17',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  // F11 toggles fullscreen; Ctrl+Shift+I opens dev tools for bug reports.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  // External links (the update notice's release page) open in the system browser, never inside
  // the game, and only for GitHub pages over https.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The game never navigates away from its own bundle.
  const stayHome = (e, url) => {
    if (!url.startsWith('app://game/')) e.preventDefault();
  };
  win.webContents.on('will-navigate', stayHome);
  win.webContents.on('will-redirect', stayHome);
  updater.attach(win);
  win.loadURL('app://game/index.html');
}

Menu.setApplicationMenu(null);
app.whenReady().then(() => {
  // No camera, microphone, geolocation, notifications etc. are ever needed.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  updater.init();
  updater.registerIpc();
  serveGame();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
