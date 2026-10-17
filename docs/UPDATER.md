# Hot updater

The desktop app (Electron shell) can update the game without a reinstall. Each GitHub release
carries a signed **game bundle**: the contents of `dist/` as a zip. The shell downloads it in the
background, verifies it, and serves it in place of the built-in `dist/` from the next launch, or
straight away if the player clicks "restart now". When a release needs a newer shell, the shell
downloads the full installer to the Downloads folder instead. It never runs the installer. The web
build is always the latest version and only shows the "new version" notice.

Requirements: `docs/V23_SPEC.md` §2 and `docs/V23_HANDOVER.md` WP2, carried into
`docs/V30_SPEC.md` §3.

## Files

| File | Role |
|---|---|
| `electron/updateLogic.cjs` | Pure logic: semver, minShell, host allow-list, feed and manifest validation, Ed25519 checks, update decision, fallback state machine |
| `electron/zip.cjs` | Minimal zip writer (for packing) and a hostile-input zip reader (for installing) |
| `electron/bundle.cjs` | `userData/bundles/`: atomic install, listing, state file, pruning |
| `electron/fetch.cjs` | HTTPS GET over Electron `net`. Every hop, redirects included, must pass the allow-list. Bodies are capped |
| `electron/updater.cjs` | Orchestration, IPC, the embedded `UPDATE_PUBLIC_KEY` |
| `electron/preload.cjs` | Sandboxed `contextBridge` API `window.littlewar` |
| `src/update/shell.ts` | Renderer side: bridge detection, status validation, notice states |
| `src/ui/update.ts`, `src/ui/pause.ts` | Title-screen notice, Settings toggle "自动下载更新 / Auto-download updates" |
| `scripts/release/keygen.mjs` | One-time key pair generation |
| `scripts/release/pack.mjs` | Builds `game-<ver>.zip`, `game-<ver>.json` and `game-<ver>.json.sig` |
| `scripts/release/release.config.json` | `minShell`, the oldest shell that can run bundles from this tree |
| `scripts/release/updater-e2e.mjs` | End-to-end proof against the real Electron shell and a localhost feed |

## One-time setup (the maintainer does this once)

1. Generate the signing key on your own machine:
   ```
   npm run release:keygen
   ```
   This writes the private key to `%USERPROFILE%\.littlewar\update-signing-key.pem`, or to
   `$LITTLEWAR_SIGNING_KEY` if that is set. The key always lands outside the repository. The
   script will not overwrite an existing key, and it prints a line like this:
   ```
   const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA…';
   ```
2. Paste that line over the placeholder in `electron/updater.cjs` and commit it. The public key
   is not secret.
3. **Back up the private key** in a password manager or an offline copy. If you lose it, you
   can't sign bundles that existing installs will accept. Rotating the key means shipping a new
   shell (a full installer) with the new public key.

Until step 2 is done the shell ships with the placeholder key. In that state it never installs
bundles: the status is `unavailable`, and the title screen falls back to the plain release notice
it had in 2.2.

## Release flow

```
npm run dist:win     # builds dist/ and the installers into release/
npm run pack:game    # zips dist/, writes and signs the manifest into release/
```

`pack:game` writes these files:

- `release/game-<ver>.zip`: the files of `dist/`, deflated, with fixed timestamps.
- `release/game-<ver>.json`: the manifest.
  ```json
  { "schema": 1, "version": "3.0.1", "minShell": "3.0.0", "file": "game-3.0.1.zip",
    "sha256": "<hex>", "size": 1234567,
    "installers": { "setup": { "name": "LittleWar-3.0.1-setup.exe", "sha256": "<hex>", "size": 0 },
                    "portable": { "name": "LittleWar-3.0.1-portable.exe", "sha256": "<hex>", "size": 0 } } }
  ```
  `installers` only lists the installers that are present in `release/`. That's why you run
  `dist:win` first.
- `release/game-<ver>.json.sig`: the base64 Ed25519 signature of the exact manifest bytes.

The script checks its own signature. It warns if the key in `electron/updater.cjs` does not
match the signing key.

Upload the three game files and both installers to the GitHub release. The release tag must be
`v<version>`.

Options: `--dist`, `--out`, `--version`, `--min-shell` and `--key <pem>`.

**minShell.** Bump `scripts/release/release.config.json` whenever a change under `electron/` (main
process, preload API, protocol, CSP) is one the game depends on. Shells older than `minShell` get
the installer instead of the bundle.

## What the shell does

0. **One instance.** The shell takes `app.requestSingleInstanceLock()` before `init`. A second
   launch quits at once and the first window is restored and focused, so two shells never race on
   `bundles/` or the Downloads folder.
1. **On launch** (`init`) the shell picks the newest installed bundle that is newer than the
   built-in game, not marked bad, and whose stored manifest `minShell` is not newer than this
   shell. It serves that bundle through `app://game/`. Otherwise it serves the built-in `dist/`.
   `app://` answers only for host `game` (anything else is 404), sends the CSP header on every
   response, not just `.html`, and refuses paths with `:` or a segment ending in `.` or a space
   with 400.
2. **Ready guard.** The served bundle must call `window.littlewar.ready()` within 30 s. The title
   screen does this. If the page fails to load, the renderer dies, or `ready()` never arrives,
   the shell marks the bundle bad and reloads the built-in game. Only the open trial can mark a
   bundle bad: once `ready()` has confirmed it for this launch, a later renderer crash or failed
   load only reloads the page and never demotes the bundle. A bundle that was served on
   two launches and never confirmed (for example, a crash or a kill) is also marked bad on the
   next launch.
3. **Check.** The title screen calls `check()` once per run, when "check for updates on start" is
   on. The shell then fetches the releases feed and runs these steps in order:
   - **Feed.** The release must not be a draft or prerelease, its tag must be a version, and it
     must be newer than the version being served.
   - **Signature** of `game-<ver>.json`, checked with the embedded public key.
   - **Manifest schema**, including that the manifest version matches the release tag (no replay
     under another tag).
   - **minShell.** If the release needs a newer shell, the shell takes the installer path.
   - **Download** of the bundle. The download is capped at the signed size.
   - **Size** check, then the **sha256** check.
   - **Unzip** with zip-slip protection. Absolute paths, drive letters, `..`, symlinks or reparse
     points, Windows-unsafe names (including reserved device names such as `con`, `nul`,
     `com1`, `lpt1`, with or without an extension), duplicates, encrypted entries, ZIP64, unknown compression,
     CRC or size mismatches, and archives over 5000 entries, 64 MB per entry or 256 MB total
     are all rejected.
   - **Install.** The bundle is written into `bundles/.staging-<ver>-<rand>/` and then moved into
     place with one atomic rename to `bundles/<ver>/`.
   - **Prune.** Bad bundles are removed, along with all but the newest two good ones. The bundle
     currently being served is never removed.
4. **Installer path.** The shell picks the portable exe when `PORTABLE_EXECUTABLE_DIR` is set,
   and the NSIS setup otherwise. The installer name must match
   `LittleWar-<x.y.z>-(setup|portable).exe`. It downloads to `Downloads/<name>` via a `.part`
   file and verifies the size and sha256 from the signed manifest. The `.part` file is removed on
   any error, including a failed download. An existing file in Downloads is never overwritten or
   deleted: if the name is taken by a different file, the installer is saved as
   `<name> (1).exe`, `(2)`, and so on (a copy that already verifies is reused). The installer is
   never executed.
5. **Restart now** relaunches the app. For the portable build it uses `PORTABLE_EXECUTABLE_FILE`
   only if the file is named `LittleWar-<x.y.z>-portable.exe` and exists; otherwise it relaunches
   `process.execPath`.

With auto-download off, the notice shows the plain "new version, download" card that links to
the release page. The setting is saved in `userData/updater.json`.

### Renderer bridge (`window.littlewar`)

| Method | Purpose |
|---|---|
| `status()` | Current status: `{ state, version, progress, installerName, autoDownload, serving, releaseUrl }` |
| `onStatus(cb)` | Subscribe to status changes. Returns an unsubscribe function |
| `check()` | Run the release check (at most once per process) |
| `ready()` | The title screen was reached (the bundle is good) |
| `restartToUpdate()` | Relaunch onto the downloaded bundle (only in state `ready`) |
| `openDownloads()` | Reveal the downloaded installer, or the Downloads folder |
| `setAutoDownload(bool)` | Toggle auto-download. Returns the new status |

States: `idle`, `unavailable`, `checking`, `up-to-date`, `available`, `downloading`, `ready`,
`installer-downloading`, `installer-ready`, `error`.

## Security model

- **Trust anchor.** The Ed25519 public key embedded in the shell. Nothing is installed or saved
  as an installer unless it is covered by a manifest signed with the matching private key. The
  private key never enters the repository, CI or the app.
- **Transport.** HTTPS only, to `api.github.com`, `github.com`, `objects.githubusercontent.com`
  and `release-assets.githubusercontent.com`. GitHub has redirected release downloads to that
  last host since 2025. The allow-list is checked on every redirect hop. There are no
  credentials or cookies, at most 5 redirects, a 30 s idle timeout, and size caps: feed 1 MB,
  manifest 64 KB, signature 1 KB, bundle at its signed size (64 MB maximum), installer at its
  signed size. The allow-list is defence in depth; integrity comes from the signature.
- **Order of checks.** Signature, then minShell, then size, then sha256, then the zip checks.
  Unsigned input is never parsed beyond JSON.
- **Rollback protection.** A bundle is only taken when it is newer than the version being served.
  Bundles that are not newer than the built-in game are never served. A bad version is never
  downloaded again.
- **Renderer isolation.** `contextIsolation` and `sandbox` stay on, and `nodeIntegration` stays
  off. The preload exposes seven fixed functions. Every IPC message is checked to come from an
  `app://game/` frame, and the renderer validates every status it receives. The CSP, navigation
  lock and external-link rules are unchanged.
- **Dev overrides** apply only when `!app.isPackaged`, so a shipped app ignores them:
  - `LITTLEWAR_UPDATE_FEED` sets the feed URL. Loopback http is allowed only with this override.
  - `LITTLEWAR_UPDATE_PUBKEY` sets a test key.
  - `LITTLEWAR_UPDATE_READY_MS` sets the ready timeout.
  - `LITTLEWAR_UPDATE_LOG` writes a JSONL event log.
  - `LITTLEWAR_USER_DATA` sets the profile directory.
  - `LITTLEWAR_DOWNLOADS` sets the installer download directory.

## Testing

- `npm test`:
  - `tests/updater.test.ts` covers the logic, the zip reader and the bundle store, plus a
    pack → verify → install round trip.
  - `tests/updaterShell.test.ts` drives `electron/updater.cjs` with a fake Electron
    (`app`/`net`/window/IPC) against an in-memory signed feed. It covers:
    - a good bundle installed, served and confirmed
    - a tampered zip, a tampered manifest and a foreign signature, all rejected
    - a blank bundle and a failed load, both falling back and remembered as bad
    - an installer download, and a tampered installer rejected
    - a packaged shell ignoring the dev overrides
  - `tests/updateShell.test.ts` covers the renderer side.
- `npm run updater:e2e [-- --build] [-- --only a,b] [-- --verbose]`: the same scenarios against
  the real Electron shell and a localhost feed, with a throwaway key. It opens app windows.
