#!/usr/bin/env node
// One-time: create the Ed25519 key pair that signs game bundles (docs/UPDATER.md).
// The private key is written OUTSIDE the repository and never overwritten; the public key is
// printed for pasting into electron/updater.cjs (UPDATE_PUBLIC_KEY).
//
//   node scripts/release/keygen.mjs [--out <path>]
//   default path: %USERPROFILE%/.littlewar/update-signing-key.pem (or $LITTLEWAR_SIGNING_KEY)
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function defaultKeyPath() {
  return process.env.LITTLEWAR_SIGNING_KEY || resolve(homedir(), '.littlewar', 'update-signing-key.pem');
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function insideRepo(file) {
  const rel = relative(REPO, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function main() {
  const out = resolve(argValue('--out') ?? defaultKeyPath());
  if (insideRepo(out)) {
    console.error(`Refusing to write the private key inside the repository: ${out}`);
    process.exit(2);
  }
  if (existsSync(out)) {
    console.error(`Refusing to overwrite an existing key: ${out}\nBack it up and delete it first if you really mean to rotate keys (that needs a new shell release).`);
    process.exit(2);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  console.log(`Private key written to ${out}`);
  console.log('BACK IT UP NOW (password manager / offline copy). Losing it means shipping a new installer to rotate keys.');
  console.log('\nPaste this into electron/updater.cjs as UPDATE_PUBLIC_KEY:\n');
  console.log(`const UPDATE_PUBLIC_KEY = '${pub}';`);
}

main();
