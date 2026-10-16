#!/usr/bin/env node
// Build the signed hot-update bundle for a release (docs/UPDATER.md):
//   release/game-<ver>.zip       the contents of dist/
//   release/game-<ver>.json      manifest { schema, version, minShell, file, sha256, size, installers }
//   release/game-<ver>.json.sig  base64 Ed25519 signature of the manifest bytes
// Upload all three (plus the installers) to the GitHub release.
//
//   npm run pack:game -- [--dist dist] [--out release] [--version x.y.z] [--min-shell x.y.z] [--key <pem>]
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { writeZip } = require('../../electron/zip.cjs');
const logic = require('../../electron/updateLogic.cjs');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Every regular file under `root` as { name, data }, sorted; symlinks are an error. */
export function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`symlink in bundle: ${full}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ name: relative(root, full).split(sep).join('/'), data: readFileSync(full) });
    }
  };
  walk(root);
  return out;
}

function installerRef(dir, name) {
  const file = join(dir, name);
  if (!existsSync(file)) return undefined;
  const data = readFileSync(file);
  return { name, sha256: sha256(data), size: data.length };
}

/** Pack `dist` into `out` and sign the manifest with `privateKey` (a KeyObject or PEM). */
export function packGame({ dist, out, version, minShell, privateKey, installersDir = out }) {
  if (!logic.isStrictVersion(version)) throw new Error(`bad version ${version}`);
  if (!logic.isStrictVersion(minShell)) throw new Error(`bad minShell ${minShell}`);
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist} has no index.html (run npm run build first)`);
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('signing key is not Ed25519');
  const zip = writeZip(collectFiles(dist));
  const file = `game-${version}.zip`;
  const installers = {};
  const setup = installerRef(installersDir, `LittleWar-${version}-setup.exe`);
  const portable = installerRef(installersDir, `LittleWar-${version}-portable.exe`);
  if (setup) installers.setup = setup;
  if (portable) installers.portable = portable;
  const manifest = { schema: 1, version, minShell, file, sha256: sha256(zip), size: zip.length, installers };
  const v = logic.validateManifest(manifest);
  if (!v.ok) throw new Error(`manifest invalid: ${v.error}`);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const sig = logic.signManifest(manifestBytes, key);
  const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
  if (!logic.verifySignature(manifestBytes, sig, pub)) throw new Error('self-check of the signature failed');
  mkdirSync(out, { recursive: true });
  const paths = { zip: join(out, file), manifest: join(out, `game-${version}.json`), sig: join(out, `game-${version}.json.sig`) };
  writeFileSync(paths.zip, zip);
  writeFileSync(paths.manifest, manifestBytes);
  writeFileSync(paths.sig, `${sig}\n`);
  return { manifest, paths, publicKey: pub };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function embeddedKey() {
  const src = readFileSync(join(REPO, 'electron', 'updater.cjs'), 'utf8');
  const m = /const UPDATE_PUBLIC_KEY = '([^']+)'/.exec(src);
  return m ? m[1] : null;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(REPO, 'scripts', 'release', 'release.config.json'), 'utf8'));
  const keyPath = resolve(argValue('--key') ?? process.env.LITTLEWAR_SIGNING_KEY ?? join(homedir(), '.littlewar', 'update-signing-key.pem'));
  if (!existsSync(keyPath)) {
    console.error(`No signing key at ${keyPath}. Run node scripts/release/keygen.mjs once (see docs/UPDATER.md).`);
    process.exit(2);
  }
  const res = packGame({
    dist: resolve(argValue('--dist') ?? join(REPO, 'dist')),
    out: resolve(argValue('--out') ?? join(REPO, 'release')),
    version: argValue('--version') ?? pkg.version,
    minShell: argValue('--min-shell') ?? cfg.minShell,
    privateKey: readFileSync(keyPath),
  });
  console.log(`Packed game ${res.manifest.version} (${res.manifest.size} bytes, minShell ${res.manifest.minShell})`);
  for (const p of Object.values(res.paths)) console.log(`  ${p}`);
  const installers = Object.keys(res.manifest.installers);
  console.log(`  installers in manifest: ${installers.length ? installers.join(', ') : 'none (run npm run dist:win first to include them)'}`);
  const embedded = embeddedKey();
  if (embedded !== res.publicKey) {
    console.warn(`\nWARNING: electron/updater.cjs UPDATE_PUBLIC_KEY does not match this signing key.\nShells built from this tree will reject the bundle. Expected:\n  const UPDATE_PUBLIC_KEY = '${res.publicKey}';`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
