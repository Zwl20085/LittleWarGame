// Game bundles on disk: userData/bundles/<version>/ holds one unpacked, verified game (the
// contents of dist/) plus bundle.json (its signed manifest). state.json holds the fallback
// state machine (electron/updateLogic.cjs). Installs are staged next to the target and moved in
// with one rename, so a half-written bundle is never visible under a version name.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readZip } = require('./zip.cjs');
const logic = require('./updateLogic.cjs');

const STATE_FILE = 'state.json';
const MANIFEST_FILE = 'bundle.json';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a file via a temp sibling + rename (no torn state files). */
function writeFileAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  // Windows: a virus scanner or indexer briefly holding the target makes rename fail with
  // EPERM/EBUSY/EACCES; retry a few times before giving up.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err && err.code)) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1));
    }
  }
}

function readState(dir) {
  try {
    return logic.normalizeState(JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')));
  } catch {
    return logic.EMPTY_STATE;
  }
}

function writeState(dir, state) {
  ensureDir(dir);
  writeFileAtomic(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

/** Installed bundle versions: x.y.z directories with an index.html and a manifest. */
function listInstalled(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && logic.isStrictVersion(d.name))
    .map((d) => d.name)
    .filter((v) => fs.existsSync(path.join(dir, v, 'index.html')) && fs.existsSync(path.join(dir, v, MANIFEST_FILE)));
}

function bundlePath(dir, version) {
  if (!logic.isStrictVersion(version)) throw new Error(`bad bundle version ${version}`);
  return path.join(dir, version);
}

/** Resolve an archive path inside `root`, refusing anything that would land outside it. */
function insideRoot(root, rel) {
  const file = path.resolve(root, ...rel.split('/'));
  const r = path.relative(root, file);
  if (r === '' || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`entry escapes bundle: ${rel}`);
  return file;
}

/**
 * Unpack a verified zip into bundles/<version>/ (zip-slip safe, atomic). Throws on any
 * problem and leaves no partial directory behind. Returns the bundle path.
 */
function installBundle(dir, version, zipBuf, manifestBytes) {
  const target = bundlePath(dir, version);
  const entries = readZip(zipBuf);
  if (!entries.some((e) => !e.dir && e.path === 'index.html')) throw new Error('bundle has no index.html');
  ensureDir(dir);
  const staging = path.join(dir, `.staging-${version}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(staging);
    for (const e of entries) {
      const file = insideRoot(staging, e.path);
      if (e.dir) {
        ensureDir(file);
        continue;
      }
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, e.data, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(staging, MANIFEST_FILE), manifestBytes);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    return target;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function removeBundles(dir, versions) {
  for (const v of versions) {
    try {
      fs.rmSync(bundlePath(dir, v), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[updater] could not remove bundle ${v}:`, err && err.message);
    }
  }
}

/** Leftovers of interrupted installs or downloads. */
function cleanupStaging(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!(n.startsWith('.staging-') || n.endsWith('.part') || n.endsWith('.tmp'))) continue;
    try {
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[updater] could not clean up ${n}:`, err && err.message);
    }
  }
}

module.exports = { readState, writeState, listInstalled, bundlePath, installBundle, removeBundles, cleanupStaging, writeFileAtomic, insideRoot, MANIFEST_FILE };
