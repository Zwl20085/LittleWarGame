# 2.3 handover plan

Status (2026-10-11): **planning only, no 2.3 code written.** Shipped: v2.2.0 (PR #11) and v2.2.1
(PR #12, the player's HQ auto-invests). Branch `feat/v2.3` = `main` + `docs/V23_SPEC.md` (the
requirements and lead decisions) + this file. Read the spec first; this file is the work plan.

The user's request, in one line: build a player-experience evaluation lab on real maps, use it to
stop one-sided wars and cheap wins (偏师偷家, armoured raids, fog-shadow approaches), decide on a
capital observation ring and a free absolute defence perimeter (绝对国防圈), research further
mechanics with evidence, and make updates download automatically with hot-updatable game bundles.

## 0. How to work (what worked in 2.2)

- One lead session plans, merges and reviews; Opus subagents in worktrees do each work package.
  Merge each package into `feat/v2.3`, run `npm run typecheck && npm test` after every merge,
  then a release PR to `main`. Merging to `main` and publishing a release need the user's OK.
- Give each agent the spec section, the files it owns, the files to avoid, and a measurable
  acceptance target. Ask for before/after tables, not prose.
- Agents' worktrees have no `node_modules`; they junction to the main checkout's. Use free dev
  server ports (5173 is often taken). Playwright uses Edge at
  `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`.
- Conflict hot spots seen in 2.2: `src/sim/types.ts`, `sim.ts`, `commands.ts`, `cityai.ts`,
  `behavior.ts`, `snapshot.ts`, `ui/hud.ts`, `ui/i18n.ts`, `renderer.ts`. Keep hooks small there.
- Sim files are CRLF; scripted edits must preserve line endings.
- Any panel that rebuilds its DOM on refresh needs `PressGuard` (`src/ui/dom.ts`), or clicks get lost.

## 1. Work packages and order

```
WP1 lab ──► WP3 capital defence + fog ──► WP4 AI tuning ──► WP5 new mechanics ──► WP7 release
WP2 updater (independent, can run in parallel with WP1)          WP6 media/README ──┘
```

### WP1 — Evaluation lab and baseline (first; everything else is judged by it)
- **Owner:** one agent. Owns `scripts/lab23.ts`, `scripts/challenge/**`, `scripts/lab/**`,
  `docs/LAB_V23.md`, `docs/lab/*.json`. Read-only sim hooks only, all flags default off.
- **Scenarios** (generated maps, medium **and large**, ≥ 3 seeds):
  - The existing challenge strategies.
  - `armour_raid`: 20+ tanks + 10+ motorized infantry at one capital, at 15 and 25 min, by the
    direct road and by the widest flank. The scripted side may need a scenario-only grant or a
    pre-spawned force to afford it; record that.
  - `shadow_strike`: a 4–10 squad detachment routed by the defender's fog visibility, appearing
    at the capital ring. Run in fog and in open info.
  - `backdoor`: at most 15 % of the army goes for the capital while the rest pins the front.
  - AI-only 4-FFA wars, medium and large, 45–60 min.
- **Metrics:** computed from logged time series, with pass/fail bands. Definitions are in spec §1.2:
  - one-sidedness: share of time a side holds more than 70 % of army value, lead changes,
    comeback size, territory Gini;
  - cheap-win index: capital lost to under 20 % of an army, or to a side outnumbered 3:1;
  - warning time: from first sighting to arrival at the ring, defenders' reaction time, never-seen flag;
  - pacing: first contact, first town lost, first capital lost, eliminations per hour, share undecided at 60 min;
  - engagement health.
- **CLI:** `npx tsx scripts/lab23.ts --suite quick|full --jobs N --flags a,b --baseline docs/lab/base-2.2.1.json`.
  Quick should finish in about 10–15 minutes.
- **Deliverables:** a committed baseline JSON for 2.2.1, plus `docs/LAB_V23.md` with findings
  and ranked, evidence-backed proposals. Unit tests for the metric functions.
- **Done when:** the suite runs reproducibly; the baseline answers "does each exploit take a
  capital, with how much warning, medium vs large"; proposals are ranked.

### WP2 — Auto-download and hot-update bundles (parallel with WP1)
- **Feasibility:** yes. `electron/main.cjs` already serves `dist/` through the `app://`
  protocol, so the shell can serve a verified newer bundle from `userData/bundles/<ver>/`
  without reinstalling.
- **Release side:**
  - `scripts/release/keygen.mjs` creates an Ed25519 key pair. The private key goes **outside the
    repo** (`%USERPROFILE%/.littlewar/update-signing-key.pem`); it refuses to overwrite.
  - `scripts/release/pack.mjs` builds `game-<ver>.zip` plus `game-<ver>.json` (version, minShell,
    sha256, size, installer hashes) and `game-<ver>.json.sig`.
  - Add `npm run pack:game`, and add the three files to each GitHub release.
- **Shell side:**
  - The public key is embedded in the shell.
  - Downloads only over https, only from api.github.com, github.com and
    objects.githubusercontent.com (redirects too).
  - Order of checks: signature first, then minShell, then size and sha256.
  - Unzip safely: reject absolute paths, `..`, symlinks and oversized entries.
  - Install by atomic rename. Serve the bundle on the next launch, or via "restart now".
  - Keep the previous bundle and prune to 2.
  - If the page fails to load, or the renderer does not signal ready, fall back to the built-in
    `dist/` and mark the bundle bad.
- **Shell too old** (minShell newer than the shell): auto-download the matching installer
  (setup or portable; portable is detected via `PORTABLE_EXECUTABLE_DIR`) into Downloads,
  verified against the signed hash. Never run it automatically.
- **UI:** a preload + `contextBridge` exposing status, `restartToUpdate()` and "open folder".
  - Keep `contextIsolation` and `sandbox`, no `nodeIntegration`.
  - Title notice states: downloading %, ready (restart), full installer downloaded.
  - A Settings toggle for auto-download (default on).
  - The web build keeps the notice only.
- **Tests and proof:**
  - Unit tests: manifest validation, version and minShell logic, zip-slip rejection,
    signature check with a throwaway key, fallback state.
  - End-to-end against a localhost feed (env override honoured only when `!app.isPackaged`),
    including tampered zip/sig rejection and the fallback.
- **User action needed:** run keygen once with the lead, embed the public key, and back up the
  private key. Losing it means shipping a new shell (full installer) to rotate keys.

### WP3 — Capital observation ring and absolute defence perimeter (after the WP1 baseline)
- **Fog observation ring:** the capital always sees out to R. Use the lab to choose R in the
  600–900 m range: shadow strikes must be seen early enough for defenders to react, without
  making fog pointless. Show the ring on the minimap.
- **绝对国防圈:** a free, permanent ring around every capital.
  - Traits: artillery (indirect fire on attackers at the ring), MG (strong against infantry), and
    bunker hardness (only armour or heavy guns crack it).
  - Engineers repair it (restore HP).
  - It is visible on the map and has its own render model (render registry
    `src/render/structureKinds.ts`).
  - Build it from the existing pillbox/bunker/structures code (`structures.ts`, `homeguard.ts`
    capital line works) rather than a parallel system.
- **Acceptance (A/B in the lab, flags on vs off):**
  - backdoor and shadow strikes no longer take capitals;
  - `armour_raid` still can when it is big enough, and costs real time and losses;
  - defenders get at least X seconds to return home (set X from the WP1 data);
  - eliminations per hour and the share undecided at 60 min do not get worse than the 2.2 baseline.

  Watch for the 2.1 lesson: over-strong capitals stall the endgame. The user rejected time limits.

### WP4 — AI tuning against the lab
Focus on home-defence reaction to raids and shadow strikes, an armoured reserve, flank scouting,
counter-raids, and keeping the challenge lab at 21/21. Tune constants only with lab A/B and log
every change in `docs/BALANCE_LAB.md`.

### WP5 — New mechanics research
From the WP1 and WP3 data, write up candidates with evidence and rank them. Possible directions
to test, not decisions:
- recon and early-warning posts;
- a defender reaction bonus (rail/road movement inside one's own territory);
- attacker supply strain on deep raids (now that supply matters);
- capture rules that demand a held corridor;
- comeback mechanics for the side that is behind.

Implement only clear lab wins. List the rest as proposals for the user.

### WP6 — Media and README
- Update both READMEs (en + zh) for 2.3: the defence ring, the observation ring, auto-update, and
  the lab.
- Re-record only the GIFs that show changed visuals, using the existing scripts
  (`media/m22/*`, `scripts/capture*.mjs`).
- Fix two known media nits: the hero GIF still shows the old wrapped English Quick Battle line,
  and `roadside.gif` lacks a clear "inside the building" moment.

### WP7 — Release 2.3.0
- Set version 2.3.0 and open the release PR. Merge only with the user's OK.
- Run `npm run dist:win`, then `npm run pack:game` signed with the user's key.
- `gh release create v2.3.0` with both exe files plus `game-2.3.0.zip/.json/.sig`.
- 2.3.0 is the first shell with the hot updater, so 2.2.x users still update by installer.
- After release, do a real end-to-end check: publish a 2.3.1 test bundle as a prerelease or to a
  test feed and confirm a 2.3.0 install picks it up.

## 2. Carried-over issues from 2.2 (fold into WP1/WP4)
- Supply: main-effort units are short of ammo 13 % of the time (target 15 %); firing units 31 %.
- AT gun: 0.37 kill value per cost over a whole match. A buff broke the tank-assault lab and was
  reverted.
- Tank-attack success: 62–84 % across rounds, small samples.
- Eliminations are slower than in 2.1 (4 vs 6 per 3 × 45 min).
- Soak anomalies: 2 per 45-min × 3 seeds after the pathing fix (target ≤ 2; the count moves
  between runs).
- Artillery fired more shells once squads took cover; partly fixed by `combat.shellWorth`.

## 3. Useful commands
- `npm run typecheck`, `npm test` (146 tests, about 2 min).
- `npx tsx scripts/challenge.ts --all --seeds 7,11,13 --minutes 40 --jobs 8` (about 10 min). The
  AI must hold 21/21.
- `npx tsx scripts/soak.ts 45 7,11,13`, `npx tsx scripts/balance.ts 30 7,11,13,17`,
  `scripts/lab/war22.ts` (armour, economy war, supply, artillery tables).
- `scripts/clickcheck.mjs` (click registration), `scripts/review-shots.mjs` (screenshot set),
  `scripts/perf-browser.mjs` (fps at 8×).
- Release: `npm run dist:win`, then `gh release create vX.Y.Z release/LittleWar-X.Y.Z-portable.exe release/LittleWar-X.Y.Z-setup.exe --target main`.
