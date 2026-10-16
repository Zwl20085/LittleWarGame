#!/usr/bin/env node
// End-to-end proof of the hot updater (docs/UPDATER.md). Starts a localhost release feed signed
// with a throwaway Ed25519 key, packs real game bundles, launches the unpackaged Electron shell
// with the dev-only env overrides and reads its updater event log.
//
//   node scripts/release/updater-e2e.mjs [--build]     (--build forces `vite build` first)
//
// Scenarios: good bundle installed then served; tampered zip rejected; tampered signature
// rejected; bundle that never reaches the title screen falls back to the built-in game and is
// remembered as bad; release needing a newer shell downloads (never runs) the installer.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packGame } from './pack.mjs';

const require = createRequire(import.meta.url);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(REPO, 'dist');
const logic = require('../../electron/updateLogic.cjs');
const ELECTRON = require('electron'); // path to the electron binary when required from node
const SHELL_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const READY_MS = 8000;
const WAIT_MS = 90000;
const VERBOSE = process.argv.includes('--verbose');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const want = (id) => !ONLY || ONLY.split(',').includes(id);

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildIfNeeded() {
  if (existsSync(join(DIST, 'index.html')) && !process.argv.includes('--build')) return;
  console.log('Building dist/ …');
  const r = spawnSync('npx vite build', { cwd: REPO, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error('vite build failed');
}

// ------------------------------------------------------------------ feed server

function startFeed() {
  let release = null; // { version, files: { name: Buffer } }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!release) return void res.writeHead(404).end();
    if (url.pathname === '/feed') {
      const base = `http://127.0.0.1:${server.address().port}/files/`;
      const body = JSON.stringify({
        tag_name: `v${release.version}`,
        draft: false,
        prerelease: false,
        assets: Object.keys(release.files).map((name) => ({ name, browser_download_url: base + name })),
      });
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    }
    // One hop of redirect, like github.com → objects.githubusercontent.com.
    if (url.pathname.startsWith('/files/')) {
      return void res.writeHead(302, { location: url.pathname.replace('/files/', '/blob/') }).end();
    }
    const name = decodeURIComponent(url.pathname.replace('/blob/', ''));
    const data = release.files[name];
    if (!data) return void res.writeHead(404).end();
    return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${server.address().port}/feed`,
    set: (r) => { release = r; },
    close: () => server.close(),
  })));
}

function releaseFrom(res, extra = {}) {
  const files = {
    [`game-${res.manifest.version}.json`]: readFileSync(res.paths.manifest),
    [`game-${res.manifest.version}.json.sig`]: readFileSync(res.paths.sig),
    [res.manifest.file]: readFileSync(res.paths.zip),
    ...extra,
  };
  return { version: res.manifest.version, files };
}

// ------------------------------------------------------------------ shell runs

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/** Launch the shell on a profile and wait until `until(events)` is true (or time out). */
async function runShell(profile, feedUrl, pubKey, until) {
  const log = join(profile, 'updater-log.jsonl');
  const before = readLog(log).length;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    LITTLEWAR_USER_DATA: join(profile, 'userData'),
    LITTLEWAR_DOWNLOADS: join(profile, 'Downloads'),
    LITTLEWAR_UPDATE_FEED: feedUrl,
    LITTLEWAR_UPDATE_PUBKEY: pubKey,
    LITTLEWAR_UPDATE_READY_MS: String(READY_MS),
    LITTLEWAR_UPDATE_LOG: log,
  });
  const child = spawn(ELECTRON, [REPO], { env, stdio: VERBOSE ? 'inherit' : 'ignore', windowsHide: false });
  const t0 = Date.now();
  try {
    for (;;) {
      const events = readLog(log).slice(before);
      const why = until(events) ? 'done' : Date.now() - t0 > WAIT_MS ? 'timeout' : child.exitCode !== null ? `exited ${child.exitCode}` : null;
      if (why) {
        if (VERBOSE) console.log(`[e2e] run ended: ${why} after ${Date.now() - t0} ms`);
        return events;
      }
      await sleep(250);
    }
  } finally {
    killTree(child);
    await sleep(800);
  }
}

const has = (events, event, match = {}) => events.some((e) => e.event === event && Object.entries(match).every(([k, v]) => e[k] === v));

// ------------------------------------------------------------------ scenarios

async function main() {
  buildIfNeeded();
  const work = mkdtempSync(join(tmpdir(), 'lwg-updater-e2e-'));
  const keys = generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const feed = await startFeed();
  const results = [];
  const record = (scenario, expectation, pass, detail) => {
    results.push({ scenario, expectation, result: pass ? 'PASS' : 'FAIL', detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${scenario}: ${expectation}  (${detail})`);
  };
  const profile = (name) => {
    const p = join(work, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const pack = (version, opts = {}) => packGame({ dist: opts.dist ?? DIST, out: join(work, 'pack', version), version, minShell: opts.minShell ?? SHELL_VERSION, privateKey: keys.privateKey, installersDir: opts.installersDir ?? join(work, 'none') });

  try {
    // (a) good bundle: run 1 downloads + installs, run 2 serves it and it signals ready.
    if (want('a')) {
      const p = profile('good');
      feed.set(releaseFrom(pack('9.9.9')));
      const r1 = await runShell(p, feed.url, pub, (ev) => has(ev, 'installed') || has(ev, 'rejected') || has(ev, 'error'));
      const installed = has(r1, 'installed', { version: '9.9.9' }) && existsSync(join(p, 'userData', 'bundles', '9.9.9', 'index.html'));
      record('a1 good bundle', 'downloaded, verified, installed', installed, r1.map((e) => e.event).join(' → '));
      const r2 = await runShell(p, feed.url, pub, (ev) => has(ev, 'ready') || has(ev, 'fallback'));
      record('a2 good bundle', 'next launch serves 9.9.9 and reaches the title', has(r2, 'serving', { source: 'bundle', version: '9.9.9' }) && has(r2, 'ready', { source: 'bundle', version: '9.9.9' }) && !has(r2, 'fallback'),
        r2.map((e) => `${e.event}:${e.source ?? ''}${e.version ?? ''}`).join(' → '));
    }
    // (b) tampered zip: sha256 mismatch, nothing installed.
    if (want('b')) {
      const p = profile('tampered-zip');
      const res = pack('9.9.9');
      const rel = releaseFrom(res);
      const zip = Buffer.from(rel.files[res.manifest.file]);
      zip[Math.floor(zip.length / 2)] ^= 0x5a;
      rel.files[res.manifest.file] = zip;
      feed.set(rel);
      const r = await runShell(p, feed.url, pub, (ev) => has(ev, 'installed') || has(ev, 'rejected') || has(ev, 'error'));
      record('b tampered zip', 'rejected at sha256, nothing installed', has(r, 'rejected', { stage: 'sha256' }) && !existsSync(join(p, 'userData', 'bundles', '9.9.9')), r.map((e) => `${e.event}:${e.stage ?? ''}`).join(' → '));
    }
    // (c) tampered signature: manifest edited after signing, and a signature by another key.
    if (want('c')) {
      const res = pack('9.9.9');
      const rel = releaseFrom(res);
      const name = `game-${res.manifest.version}.json`;
      rel.files[name] = Buffer.from(rel.files[name].toString().replace(res.manifest.sha256, sha256(Buffer.from('evil'))));
      feed.set(rel);
      const p1 = profile('tampered-manifest');
      const r1 = await runShell(p1, feed.url, pub, (ev) => has(ev, 'installed') || has(ev, 'rejected') || has(ev, 'error'));
      record('c1 tampered manifest', 'rejected at signature', has(r1, 'rejected', { stage: 'signature' }) && !has(r1, 'installed'), r1.map((e) => `${e.event}:${e.stage ?? ''}`).join(' → '));
      const rogue = generateKeyPairSync('ed25519');
      const rel2 = releaseFrom(res);
      rel2.files[`${name}.sig`] = Buffer.from(logic.signManifest(rel2.files[name], rogue.privateKey));
      feed.set(rel2);
      const p2 = profile('rogue-sig');
      const r2 = await runShell(p2, feed.url, pub, (ev) => has(ev, 'installed') || has(ev, 'rejected') || has(ev, 'error'));
      record('c2 signature by another key', 'rejected at signature', has(r2, 'rejected', { stage: 'signature' }) && !has(r2, 'installed'), r2.map((e) => `${e.event}:${e.stage ?? ''}`).join(' → '));
    }
    // (d) broken bundle: installs, but its page never reaches the title → fallback + marked bad.
    if (want('d')) {
      const p = profile('fallback');
      const broken = join(work, 'broken-dist');
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, 'index.html'), '<!doctype html><title>broken</title><p>no game here</p>');
      feed.set(releaseFrom(pack('9.9.8', { dist: broken })));
      const r1 = await runShell(p, feed.url, pub, (ev) => has(ev, 'installed') || has(ev, 'rejected') || has(ev, 'error'));
      const r2 = await runShell(p, feed.url, pub, (ev) => has(ev, 'ready', { source: 'builtin' }));
      const ok = has(r1, 'installed', { version: '9.9.8' }) && has(r2, 'serving', { source: 'bundle', version: '9.9.8' }) && has(r2, 'fallback', { version: '9.9.8' }) && has(r2, 'ready', { source: 'builtin' });
      record('d1 broken bundle', 'served, not ready in time → built-in game', ok, r2.map((e) => `${e.event}:${e.source ?? ''}${e.version ?? ''}`).join(' → '));
      const r3 = await runShell(p, feed.url, pub, (ev) => has(ev, 'ready') || has(ev, 'decision'));
      const state = JSON.parse(readFileSync(join(p, 'userData', 'bundles', 'state.json'), 'utf8'));
      record('d2 broken bundle', 'remembered as bad: next launch serves built-in', has(r3, 'serving', { source: 'builtin' }) && state.bad.includes('9.9.8'), `bad=${JSON.stringify(state.bad)}`);
    }
    // (e) release needs a newer shell: the installer is downloaded to Downloads and verified.
    if (want('e')) {
      const p = profile('installer');
      const inst = join(work, 'installers');
      mkdirSync(inst, { recursive: true });
      const fake = Buffer.from(`MZ fake installer ${Date.now()}`);
      writeFileSync(join(inst, 'LittleWar-99.0.0-setup.exe'), fake);
      const res = pack('99.0.0', { minShell: '99.0.0', installersDir: inst });
      feed.set(releaseFrom(res, { 'LittleWar-99.0.0-setup.exe': fake }));
      const r = await runShell(p, feed.url, pub, (ev) => has(ev, 'installer') || has(ev, 'rejected') || has(ev, 'error'));
      const file = join(p, 'Downloads', 'LittleWar-99.0.0-setup.exe');
      const ok = has(r, 'installer') && existsSync(file) && sha256(readFileSync(file)) === sha256(fake) && !existsSync(join(p, 'userData', 'bundles', '99.0.0'));
      record('e shell too old', 'installer saved to Downloads, hash verified, no bundle', ok, r.map((e) => `${e.event}:${e.decision ?? e.name ?? ''}`).join(' → '));
    }
  } finally {
    feed.close();
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`could not remove ${work}: ${err.code}`);
    }
  }

  console.log('\n| scenario | expectation | result |\n|---|---|---|');
  for (const r of results) console.log(`| ${r.scenario} | ${r.expectation} | ${r.result} |`);
  const failed = results.filter((r) => r.result !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
