# Version 2.3 — team spec

User request (2026-10-11). Shared contract for agents on branch `feat/v2.3`. §0 of
`docs/V22_SPEC.md` (ground rules: worktree, conventional commits with the Co-Authored-By line,
deterministic sim, numbers in rules.json, zh + en strings, typecheck + tests before reporting)
applies unchanged. **(lead)** marks a decision the user left open.

## 1. Evaluation lab (the core of 2.3)

User: make the scripted lab more complex, test on real maps, turn logs into data and build an
evaluation mechanism **aimed at player experience**: matches must not be one-sided, and no side
may win by a simple trick (e.g. a detachment sneaking to the capital — 偏师偷家). Add large-map
evaluation, a large armoured raid on a capital (20+ tanks + 10+ motorized infantry), and the
fog-shadow approach (a detachment slipping through unseen ground and appearing right at the
capital's defence ring). Analyse, then propose and add mechanics that improve playability.

### 1.1 Scenarios (all on generated maps, medium and large, ≥ 3 seeds each)
- Existing challenge strategies (rush, turtle, two_axis, raid, late_blitz, human_like, rush_micro).
- **armour_raid**: the challenger saves up and launches 20+ tanks + 10+ motorized infantry at one
  enemy capital (variants: at 15 / 25 min; direct road vs widest flank).
- **shadow_strike**: a small detachment (4–10 squads, optionally a few light tanks) routes
  through ground the defender cannot currently see (path cost from the defender's visibility in
  fog mode) and appears at the capital's defence ring. Run in fog and open info.
- **backdoor**: the main army pins the front while a detachment (≤ 15 % of the army) goes for the
  capital — the "cheap win" probe.
- AI-only wars (4-FFA, medium + large, 45–60 min) for pacing and one-sidedness.

### 1.2 Player-experience metrics (computed from logged time series, not eyeballed)
- **Decisiveness without one-sidedness:** territory share and army value share per side over
  time; lead changes; largest deficit later overturned (comeback); time spent with one side
  above 70 % of total army value; Gini of territory at 15/30/45 min.
- **Cheap-win index:** for every capital loss, the attacking force's share of the attacker's army
  value and its cost vs the defender's army; flag losses to < 20 % of an army or to a force
  the defender outnumbered ≥ 3:1 overall.
- **Warning and reaction:** time from first sighting of the attacking force to its arrival at the
  defence ring; time until defenders arrive; whether the defender ever saw it (fog).
- **Pacing:** time to first contact, first town lost, first capital lost; eliminations per hour;
  share of matches undecided at 60 min.
- **Engagement health:** units idle far from any front, stuck anomalies, supply starvation share.
- One summary score per scenario with explicit pass/fail bands, written as a markdown + JSON
  report (`media/stats/lab23-*.{md,json}`) and a comparable baseline file so every change is
  judged A/B.

### 1.3 Candidate mechanics to evaluate (implement behind flags, A/B in the lab)
- **Capital observation ring (fog):** the capital always sees out to R (e.g. 600–900 m), so a
  shadow strike is seen before it reaches the defence ring. **(lead: likely yes; lab decides R.)**
- **Absolute defence perimeter (绝对国防圈):** a free, permanent ring around every capital with
  artillery, MG and bunker traits (strong vs infantry and light vehicles; must be stormed by
  armour), giving the army time to come home. Engineers repair it (restore HP). It must slow a
  real assault, not make capitals unbreakable (keep wars endable: watch eliminations/hour and
  the 2.1 finding that over-strong capitals stall the endgame).
- AI strategy changes the lab motivates (home-defence reaction to raids/shadow strikes, armoured
  reserve, scouting the flanks, counter-raids).
- Other mechanics the analysis suggests — write them up with evidence; implement only those with
  a clear lab win, list the rest as proposals for the user.

## 2. Auto-download updates and update packages (hot update)

User: the update check should download the update automatically; build an update-package
mechanism so the client is not tied to a version (hot update) — is it feasible?

**Feasibility (lead):** yes for the Electron app. The shell (`electron/main.cjs`) already serves
the game from `dist/` through the `app://` protocol, so the game bundle can be swapped without
reinstalling:
- Release CI/script publishes `game-<ver>.zip` (the `dist/` folder) + `game-<ver>.json`
  manifest (version, min shell version, sha256, size) + an **Ed25519 signature** of the manifest.
- The shell embeds the public key. On start it checks the latest release, downloads the bundle
  to `userData/bundles/<ver>/` in the background, verifies size + sha256 + signature, unpacks
  (zip-slip safe), and on the next launch (or "restart now") serves that folder instead of the
  built-in `dist/`. Keeps the previous bundle; falls back to the built-in one if a bundle fails
  to load (crash/blank-page guard) and marks it bad.
- When a release needs a newer shell (Electron/main.cjs change, `min_shell`), the notice offers
  the full installer download instead (auto-download the setup/portable exe to Downloads,
  verified by sha256 from the signed manifest, never run automatically).
- Web build: always latest; it only shows the notice.
- The private signing key never enters the repo: generated once on the user's machine
  (`scripts/release/keygen.mjs` → outside the repo, path in an env var), used by
  `scripts/release/pack.mjs`. Tell the user to back it up.
- Settings: auto-download on/off (default on), "restart to update" prompt.
