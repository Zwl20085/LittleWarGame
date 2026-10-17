// Hot updater, check half (docs/UPDATER.md, V23_SPEC §2): reads the GitHub release feed, verifies
// the signed manifest, decides (bundle / installer / nothing) and downloads + verifies + installs.
// State lives on the shared `ctx` built by updater.cjs (net, feed, status helpers, pending, ...).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const logic = require('./updateLogic.cjs');
const store = require('./bundle.cjs');
const { httpGet } = require('./fetch.cjs');

function createCheck(ctx) {
  let checked = false;

  function fail(stage, err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[updater] ${stage} failed:`, msg);
    ctx.log('error', { stage, error: msg });
    ctx.setStatus({ state: 'error', error: msg, progress: null });
  }

  async function check() {
    if (checked) return;
    checked = true;
    if (!ctx.feed || logic.isPlaceholderKey(ctx.publicKey)) {
      ctx.setStatus({ state: 'unavailable' });
      return;
    }
    ctx.setStatus({ state: 'checking' });
    try {
      const raw = await httpGet(ctx.net, ctx.feed.url, { allowLocal: ctx.feed.allowLocal, maxBytes: logic.LIMITS.feedBytes, accept: 'application/vnd.github+json' });
      const rel = logic.parseFeed(JSON.parse(raw.body.toString('utf8')), { allowLocal: ctx.feed.allowLocal });
      const current = ctx.serving ?? ctx.builtinVersion;
      if (!rel || !logic.isNewer(rel.version, current)) {
        ctx.setStatus({ state: 'up-to-date' });
        ctx.log('up-to-date', { latest: rel && rel.version });
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
    const opts = { allowLocal: ctx.feed.allowLocal, accept: 'application/octet-stream' };
    const manifest = await httpGet(ctx.net, rel.assets[rel.manifestName], { ...opts, maxBytes: logic.LIMITS.manifestBytes });
    const sig = await httpGet(ctx.net, rel.assets[rel.sigName], { ...opts, maxBytes: logic.LIMITS.sigBytes });
    const v = logic.checkManifest({ manifestBytes: manifest.body, sigText: sig.body.toString('utf8'), publicKey: ctx.publicKey, shellVersion: ctx.shellVersion, feedVersion: rel.version });
    if (!v.ok) {
      ctx.log('rejected', { stage: v.stage, error: v.error, version: rel.version });
      ctx.setStatus({ state: 'error', version: rel.version, error: `${v.stage}: ${v.error}` });
      return null;
    }
    return { ...v, manifestBytes: manifest.body };
  }

  function act(verdict, rel) {
    const decision = logic.decide({ manifest: verdict.manifest, kind: verdict.kind, servingVersion: ctx.serving ?? ctx.builtinVersion, installed: store.listInstalled(ctx.dir, ctx.shellVersion), bad: store.readState(ctx.dir).bad });
    ctx.log('decision', { decision, version: verdict.manifest.version });
    const version = verdict.manifest.version;
    if (decision === 'up-to-date' || decision === 'known-bad') return ctx.setStatus({ state: 'up-to-date' });
    if (decision === 'already-installed') return ctx.setStatus({ state: 'ready', version });
    ctx.pending = { verdict, rel };
    if (!ctx.autoDownload) return ctx.setStatus({ state: 'available', version, needsInstaller: decision === 'installer' });
    return startPending();
  }

  function startPending() {
    if (!ctx.pending) return undefined;
    const { verdict, rel } = ctx.pending;
    ctx.pending = null;
    const job = verdict.kind === 'installer' ? downloadInstaller(verdict.manifest, rel) : downloadBundle(verdict, rel);
    return job.catch((err) => fail('download', err));
  }

  async function downloadBundle({ manifest, manifestBytes }, rel) {
    const url = rel.assets[manifest.file];
    if (!url) throw new Error(`release has no ${manifest.file}`);
    ctx.setStatus({ state: 'downloading', version: manifest.version, progress: 0 });
    const hash = crypto.createHash('sha256');
    const parts = [];
    const res = await httpGet(ctx.net, url, {
      allowLocal: ctx.feed.allowLocal,
      accept: 'application/octet-stream',
      maxBytes: manifest.size,
      onChunk: (c) => { hash.update(c); parts.push(c); },
      onProgress: (n) => ctx.setStatus({ progress: Math.min(1, n / manifest.size) }),
    });
    const ok = logic.checkPayload(manifest, { size: res.size, sha256: hash.digest('hex') });
    if (!ok.ok) {
      ctx.log('rejected', { stage: ok.stage, error: ok.error, version: manifest.version });
      ctx.setStatus({ state: 'error', error: `${ok.stage}: ${ok.error}`, progress: null });
      return;
    }
    store.installBundle(ctx.dir, manifest.version, Buffer.concat(parts), manifestBytes);
    const state = store.readState(ctx.dir);
    store.removeBundles(ctx.dir, logic.toPrune(state, store.listInstalled(ctx.dir, ctx.shellVersion), ctx.serving));
    ctx.log('installed', { version: manifest.version });
    ctx.setStatus({ state: 'ready', version: manifest.version, progress: 1 });
  }

  async function downloadInstaller(manifest, rel) {
    const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
    const ref = logic.pickInstaller(manifest, isPortable);
    const url = ref && rel.assets[ref.name];
    if (!ref || !url) {
      ctx.setStatus({ state: 'available', version: manifest.version, needsInstaller: true });
      return;
    }
    const downloads = ctx.downloadsDir();
    // Never overwrite or delete a file the user already has: use "name (1).exe" etc. instead.
    const target = await pickTarget(downloads, ref);
    if (target.have) return installerDone(target.file, ref, manifest.version);
    const final = target.file;
    ctx.setStatus({ state: 'installer-downloading', version: manifest.version, progress: 0, installerName: ref.name });
    fs.mkdirSync(downloads, { recursive: true });
    const part = `${final}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
      const fd = fs.openSync(part, 'w');
      const hash = crypto.createHash('sha256');
      let res;
      try {
        res = await httpGet(ctx.net, url, {
          allowLocal: ctx.feed.allowLocal,
          accept: 'application/octet-stream',
          maxBytes: ref.size ?? logic.LIMITS.installerBytes,
          onChunk: (c) => { hash.update(c); fs.writeSync(fd, c); },
          onProgress: (n, total) => ctx.setStatus({ progress: (ref.size || total) ? Math.min(1, n / (ref.size || total)) : null }),
        });
      } finally {
        fs.closeSync(fd);
      }
      const ok = logic.checkPayload(ref, { size: res.size, sha256: hash.digest('hex') });
      if (!ok.ok) {
        fs.rmSync(part, { force: true });
        ctx.log('rejected', { stage: ok.stage, error: ok.error, installer: ref.name });
        ctx.setStatus({ state: 'error', error: `${ok.stage}: ${ok.error}`, progress: null });
        return undefined;
      }
      if (fs.existsSync(final)) throw new Error(`${path.basename(final)} appeared during the download`);
      fs.renameSync(part, final);
    } catch (err) {
      fs.rmSync(part, { force: true }); // any failure leaves no .part behind
      throw err;
    }
    return installerDone(final, ref, manifest.version);
  }

  /** First free "name", "name (1)", ... in downloads, or an existing copy that already verifies. */
  async function pickTarget(downloads, ref) {
    const ext = path.extname(ref.name);
    const stem = ref.name.slice(0, ref.name.length - ext.length);
    for (let i = 0; i < 100; i++) {
      const file = path.join(downloads, i === 0 ? ref.name : `${stem} (${i})${ext}`);
      if (!fs.existsSync(file)) return { file, have: false };
      if ((await fileSha256(file)) === ref.sha256) return { file, have: true };
    }
    throw new Error('too many copies of the installer in the downloads folder');
  }

  function installerDone(file, ref, version) {
    ctx.installerPath = file;
    ctx.log('installer', { name: ref.name, version });
    ctx.setStatus({ state: 'installer-ready', version, progress: 1, installerName: ref.name });
  }

  function fileSha256(file) {
    return new Promise((resolve) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(null));
    });
  }

  return { check, startPending };
}

module.exports = { createCheck };
