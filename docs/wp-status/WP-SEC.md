# WP-SEC status

Fixes from the security review. Base `feat/v3.0` at bc67fc0. Typecheck and the full vitest suite
are green; `npm run updater:e2e` passes 8/8 against the real Electron shell.

| Finding | Fix | Test |
|---|---|---|
| M1 app:// handler | `electron/appProtocol.cjs` (new, Electron-free): CSP on every response, 400 for `:` / `\` / segments ending in `.` or space, 404 for host != `game`, 403 outside root | `tests/appProtocol.test.ts` |
| M2 confirmed bundle demoted | `confirmedThisLaunch` in `updater.cjs`; after `ready()` a crash / failed load only reloads | `updaterShell.test.ts` (f) |
| M3 single instance | `requestSingleInstanceLock()` before `updater.init()`, quit if refused, focus on `second-instance` | `updater:e2e` (a real second launch is refused while a killed instance's lock is held) |
| M4 stacked jobs | `startRailExtension` BUSY for same objective or station; `startRoadJob` BUSY for an endpoint within 30 m of an in-flight road job's endpoints (surfaces as `JOB_BUSY`) | `commandsHardening.test.ts` |
| L1 `.part` leak | whole installer download is in try/catch that removes the `.part` | `updaterShell.test.ts` (g) |
| L2 minShell | `listInstalled(dir, shellVersion)` skips bundles whose stored `minShell` is newer (or unreadable); `logic.shellCompatible` | `updater.test.ts`, `updaterShell.test.ts` (i) |
| L4 reserved names | `safeEntryPath` rejects `con prn aux nul com1-9 lpt1-9 conin$ conout$` per segment, any extension, case-insensitive | `updater.test.ts` |
| L5 relaunch exe | `logic.portableRelaunchPath`: basename `/^LittleWar-\d+\.\d+\.\d+-portable\.exe$/i` and exists, else `process.execPath` | `updater.test.ts` |
| L7 installer name | `validFileRef` requires `/^LittleWar-\d+\.\d+\.\d+-(setup\|portable)\.exe$/`; downloads never clobber, use ` (1)` names | `updater.test.ts`, `updaterShell.test.ts` (h) |
| L10-L12 commands | `unitOrder` / `focus` / `setAlloc` / `setCap` / `togglePause` / `setAuto` / `setAutoInvest` / `setLock` validated; rail index errors are `BAD_VALUE` (non-integer or negative) or `STALE_TARGET` (no such line / station / objective) | `commandsHardening.test.ts`, `transport.test.ts` (updated 9999 case) |

Also: `scripts/release/updater-e2e.mjs` now waits for the profile `lockfile` to be released after
a hard kill (otherwise the next launch is correctly treated as a second instance).

## Follow-ups (not done, as instructed)

- L3: per-file re-verification of installed bundles at launch.
- L6: Electron fuses.
- L9: signing key passphrase.
