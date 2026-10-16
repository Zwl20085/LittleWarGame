# Version 3.0 — team spec

User request (2026-10-16). Shared contract for every agent on branch `feat/v3.0`. §0 of
`docs/V22_SPEC.md` (ground rules: worktree, conventional commits, deterministic sim, numbers in
`docs/data/rules.json`, zh + en strings, typecheck + tests before reporting) applies unchanged,
with one change: the Co-Authored-By line is `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
on commits the lead makes, and the agent's own model name on commits an agent makes.
`docs/V23_SPEC.md` (evaluation lab, capital defence perimeter, signed hot-update bundles) was
planned but never implemented; 3.0 absorbs it. **(lead)** marks a decision the user left open.

The user's request in one line: make wars interesting through **clashing AI doctrines**, catch
abnormal play (ammo-starved tank herds) with **debug labs**, finish the **hot updater**, more
**camera and visual** work, make the supreme HQ **want** more fronts (buffs for large fronts, no
8-front cap), **engineer-built economic zones** anywhere with levels, a **defensive works**
upgrade, **softer directive priority** (front commanders may decline a harmful order; fronts near
the capital respond faster), **more challenge diversity** against 偷家, a **unit upgrade** system
(infantry attached guns, tank armour / gun, full motorization for the rich side), **railways** and
**roads** (off-road speed cut so road junctions become the battles and engineers matter), a fix
for **sparse fronts** that enemies slip through, **better music**, a lab for every new system, a
**performance** pass, version **3.0.0** and both READMEs with new animations.

## 0. Ground rules (additions for 3.0)

- Every new system ships with (a) a `rules.json` block, (b) a flag that can switch it off for
  A/B in the lab, (c) a lab suite in `scripts/lab30/`, (d) unit tests, (e) zh + en strings.
- The sim must stay deterministic (tests/determinism.test.ts) and keep 8× speed in the browser:
  no new per-tick O(units × fronts) or O(units²) loops; cache per HQ think (5 s) where possible.
- Hot spots where several agents meet: `src/sim/types.ts`, `sim.ts`, `snapshot.ts`, `commands.ts`,
  `behavior.ts`, `ui/hud.ts`, `ui/i18n.ts`, `render/renderer.ts`, `docs/data/rules.json`. Keep
  your hook there to a few lines and put the system in its own module.
- Sim files are CRLF. Keep files under ~800 lines.
- Report with before/after tables from the lab, not prose.

## 1. AI doctrines — 作战风格 (WP-A)

Each AI supreme HQ has a **doctrine** that shapes production, investment, directive choice,
front behaviour and risk appetite. Doctrines must produce visibly different wars and different
*collisions* (builder vs blitz is a race; attrition vs maneuver is a hunt).

| id | zh | personality |
|---|---|---|
| `builder` | 优先发育·抢占地盘 | economy and territory first: invests early and heavily, occupies every free town, avoids pitched battles (defend / contract when outmatched), builds economic zones, converts a late economic lead into upgrades and a large late army |
| `blitz` | 优先军事·一波直捣黄龙 | military first; consolidates a compact perimeter and a strike force, then one deep offensive on the enemy capital (armour + motorized spearhead by road/rail) when the force ratio is met; re-arms and tries again |
| `attrition` | 稳扎稳打·掐断部署 | preserves its own force (retreats damaged units, fights from works), expands only with secure flanks, interdicts the enemy's deployment: raids convoys, rail, roads, economic zones and reinforcement routes, keeps a dense continuous front |
| `maneuver` | 寻机决战·大兵团歼灭 | keeps a large mobile main body (armour, motorized, artillery) that roams for a favourable decisive battle, strikes isolated enemy fronts at 1.5:1+, declines bad odds, cares less about towns until the enemy army is broken |

- Data: `Faction.doctrine: DoctrineId`, a `DoctrineProfile` table (module-local constants are
  fine) with weights the existing AI reads: production mix, invest share, occupy eagerness,
  attack ratio threshold, retreat threshold, raid rate, front density target, upgrade priorities.
- Assignment: Quick Battle picks a different doctrine for each AI faction from the seed
  (all four present in a 4-FFA); custom game lets the player choose each AI's doctrine or
  `random`. The HUD shows the enemy doctrine once discovered (after the first battle or 5 min)
  as a flavour line on the faction card.
- Lab: `doctrine` suite — every doctrine vs every other in 1v1 (medium map, 3 seeds, 45 min) and
  4-FFA with all four. Report a doctrine-vs-doctrine win matrix, territory / army value curves,
  first-contact time, and a **distinctiveness** score (how far the four time series are apart).
  Acceptance: no doctrine wins or loses ≥ 75 % of its matches overall; each doctrine's territory
  and army curves are distinguishable; every match remains endable (eliminations/hour ≥ 2.2 baseline).

## 2. Debug labs — anomaly detection (WP-I)

The user saw many tanks with no ammunition gathering in a herd, unable to fight. Build a
mechanism that finds such states automatically.

- `scripts/lab30/anomaly.ts` runs headless soaks (4-FFA, 3 seeds, 45 min, medium + large) with
  read-only sim probes and classifies anomalies per tick window:
  - **ammo-starved cluster**: ≥ 5 combat units of one faction within 120 m, median ammo < 15 %,
    not rearming for > 90 s, with enemies within 400 m or a target assigned;
  - **starved supply chain**: a town stock at 0 for > 2 min while units nearby wait;
  - **idle herd**: ≥ 8 units idle > 3 min farther than 400 m from any front line;
  - **stuck**: no movement for 60 s with a move goal (reuse `scripts/stuck.ts` detection);
  - **convoy loop**: a truck that never completes a delivery in 5 min;
  - **phantom front**: a front with a commander and < 3 units for > 3 min;
  - **unreachable order**: a unit whose path fails repeatedly for the same goal.
- Every anomaly is logged with tick, faction, position, unit ids, a root-cause guess (e.g. "no
  truck assigned", "town stock empty", "crowd cap", "path blocked by works") and a severity.
  Output `media/stats/lab30/anomaly-<ts>.{md,json}`, plus a per-seed count table.
- Add a `tests/anomaly.test.ts` with synthetic worlds that trigger each class.
- Then **fix the ammo-starved herd**: find why tanks lose resupply (likely crowd cap +
  convoys going elsewhere + the tank block waiting far from a town) and fix the root cause in the
  sim; prove it with the anomaly count before/after.

## 3. Hot updater (WP-J)

Implement `docs/V23_SPEC.md` §2 and `V23_HANDOVER.md` WP2 as written (Ed25519-signed game
bundles served by the Electron shell from `userData/bundles/<ver>/`, auto-download, verified,
fallback to built-in `dist/`, full installer when `minShell` is newer, settings toggle, web build
keeps the notice). The public key is embedded; the keygen is run once by the user (the lead will
ask). Until then the shell ships with a placeholder key and the updater is tested against a
localhost feed with a throwaway key.

## 4. Camera and visuals (WP-K)

- Camera modes with keys and a HUD button: free (today), **orbit** (<kbd>Q</kbd>/<kbd>E</kbd>
  rotate, <kbd>R</kbd>/<kbd>F</kbd> tilt), **follow** a selected unit or front (camera rides
  behind the unit; double-click a front card), **battle cam** (auto picks the hottest fight and
  frames it, cuts every 12–20 s; for the trailer and for watching), **overview** toggle.
- Smooth transitions between modes (eased), remembered per match.
- Visual polish: tilt-shift / depth blur at low angles (quality tier), time-of-day drift over the
  war (dawn → noon → dusk, no night), rail and road rendering, economic-zone and new works models,
  upgrade visuals (tank side skirts / long gun, infantry gun team, motorized squads in trucks).
- Keep the renderer frame under 6 ms at the overview and 4 ms close in at 8× (`scripts/perf-browser.mjs`).

## 5. Fronts: unlimited, and large fronts get buffs (WP-B)

- Remove the 8-front cap (hotkeys stay 1–8 for the first eight; the front list scrolls).
  Measure the per-tick cost of fronts: front think is staggered so N fronts cost O(N) per 5 s,
  not per tick. Lab: 4, 8, 16, 24 fronts on a large map, sim ms/tick table.
- **Front scale buffs** (why the supreme HQ should want more, larger fronts): a front with
  ≥ 12 / ≥ 24 / ≥ 40 units (tiers) gets a *command* bonus: coordinated artillery (barrage
  concentration), supply priority, +morale/accuracy, faster reinforcement allocation. A front
  with too few units for its line length gets a *stretched* penalty. The theatre opens a new
  front when a cluster of unattached units or a new axis would form a tier-1 front, and merges
  fronts that fall under tier.
- Acceptance: AI 4-FFA on a large map runs 6–12 fronts per faction mid-war (today's count
  reported first), and fronts' average size rises; the challenge lab stays at 21/21.

## 6. Directive priority — 前线指挥官的自由 (WP-C)

The user: supreme-HQ orders are too binding; after many orders he loses. Change to a
**compliance model**:

- Each front computes `compliance ∈ [0,1]` every HQ think from: distance to the capital (near
  fronts respond faster and more fully), the order's local risk (expected force ratio at the
  objective, exposure of its own towns, supply), and the front's doctrine/commander temperament.
- Below a threshold the front **declines** the order and states why on its card ("拒绝执行 —
  敌优势 2.4:1，将危及 Greycrest" / "Declined — enemy 2.4:1, would expose Greycrest"); it then
  does the best local action instead. Above the threshold it obeys with a delay scaled by
  distance from the capital. `defend` with the capital as axis is never declined by fronts within
  R of the capital (home recall must stay reliable, visibly: nearer fronts move first).
- The player may **insist** (re-issue within 30 s, or a HUD toggle "强制执行"): forced orders are
  obeyed as in 2.1, so the user keeps control when he wants it.
- Lab: `directive` suite reruns the challenge strategies that spam orders (`rush`, `two_axis`,
  `human_like`) with the player side under compliance on/off and reports the player-side
  survival and outcome, plus the home-recall timing (time until the first front reaches the
  capital after a `defend` on it).

## 7. Engineer-built economic zones (WP-F)

- Engineers can build an **economic zone** (经济区) anywhere on own or neutral ground, not
  only on town lots: level 1 (cheap, small income), upgradable to level 2 and 3 by a further
  engineer job and cost. Output scales with level and with a **road/rail link** to an own town
  (an unlinked zone yields 50 %); zones outside the front's protection are raid targets.
- Lot-based town buildings stay; the HQ's auto-invest (and the four doctrines) now also places
  zones where land is safe and roads are near. Player: a build button on the engineer / HQ panel
  and a click on the map; level-up button on the zone's panel.
- Lab: `economy` suite — income curves and zone counts by doctrine; raids on zones; acceptance:
  investing in zones beats pure army over 45 min for `builder` but loses to `blitz` before 20 min.

## 8. Defensive works upgrade (WP-G)

The user saw little effect from defensive works. Rework:

- Works gain **tiers**: trench → fortified trench, pillbox → bunker → fortress (upgradable in
  place by engineers), an **AT emplacement** (dug-in AT gun, bonus accuracy and armour), and
  **minefields** (engineer-laid, slow and damage vehicles, cleared by engineers under fire).
- Works are effective when manned: garrisoned works gain the 2.1 bonuses plus an observation
  bonus and artillery spotting; an unmanned work is still an obstacle.
- **Absolute defence perimeter (绝对国防圈)** from `V23_SPEC.md` §1.3: a free permanent ring at
  every capital with MG / artillery / bunker traits, repairable by engineers, must be stormed by
  armour; plus the **capital observation ring** in fog. The lab decides their radii.
- Lab: `defence` suite — tank-led assault vs tiered works at equal cost (reuse
  `scripts/lab/at-assault.ts`), raids vs minefields, the 2.3 cheap-win scenarios; acceptance: works
  change outcomes (an equal-cost attack on a fortress line wins < 40 %) but wars stay endable.

## 9. Unit upgrades (WP-H)

- A per-faction **upgrade tree** bought with P/M from the HQ panel (and by the AI per doctrine
  when the economy allows): infantry **attached guns** (an infantry gun / mortar team joins each
  squad: +攻坚 damage vs works and buildings), infantry **armour-piercing grenades**, **full
  motorization** (every new rifle squad rolls out motorized; existing squads get trucks when
  they rearm at a town), tank **armour I–III**, tank **gun I–III**, artillery **range**, truck
  **capacity**, engineer **build speed**, commander **staff** (front buff thresholds lower).
  Upgrades cost rising amounts and take time (a research timer at the capital), 10–14 items total.
- Each upgrade has a visible model change (WP-K list) and shows on the unit card.
- Lab: `upgrade` suite — value per cost of each upgrade in 1v1 at equal resources, and the
  rich-vs-poor scenario (one side 1.5× income) must snowball *slowly*: the rich side wins ≥ 70 %
  but the median win time is > 30 min.

## 10. Roads and railways (WP-D)

- **Roads**: the existing road network becomes a movement layer: on a road tanks / trucks move
  at 1.0×, infantry 1.0×; off road: tracked 0.6×, wheeled 0.4×, infantry 0.75×, guns towed 0.5×
  (rules.json). Terrain modifiers stack. The nav cost prefers roads, so armies funnel onto road
  junctions and bridges; river crossings without a bridge cost more. Engineers can **build
  roads** (a road job between two points, cheap) and repair blown bridges.
- **Railways**: generated between the capital and its cities (and some city–city links), with
  stations. Engineers can extend rail (expensive, slow). A faction's units ordered to a far
  objective **ride the rail** when a station is within 300 m of both ends and the line is
  entirely own-held: a train (new vehicle model) carries up to 6 squads/vehicles at 3× truck
  speed; supply convoys use rail too. Rail is cut when the enemy holds any station on the line;
  engineers rebuild cut track. Attrition doctrine raids rail.
- Lab: `transport` suite — time to move a 20-unit force across a large map with rail vs
  without; share of movement on roads; battles at junctions (fights within 150 m of a junction
  as a share of all fights, before/after).

## 11. Sparse fronts and infiltration (WP-E)

The user: fronts are too thin, enemies walk through. Solution **(lead)**, to be verified by lab:

- **Zone of control**: an enemy unit within 150 m of a combat unit of the front line (not
  towns) moves at 0.5× and is engaged; crossing a line between two own units closer than 250 m
  is treated as contact and the front reacts (nearest group turns to it).
- **Pickets**: a front spreads its spare infantry as pickets along its line at ≤ 220 m spacing
  (sized by the front tier), and keeps a **reaction group** (motorized / tanks) behind the line
  that intercepts anything crossing. Attrition doctrine lowers the spacing.
- **Rear screen**: towns and economic zones in the rear get a 1–2 squad screen when an
  infiltrator is reported, and the theatre creates a *hunt* task for the nearest reserve.
- Lab: `infiltration` suite — a scripted 6-squad detachment and a 10-unit motorized raid try
  to cross a 4-front line at its widest gap; metrics: share that gets through, time until
  engaged, depth reached. Acceptance: ≤ 25 % of infiltrators get past the line undetected,
  without raising sim cost by more than 10 %.

## 12. Challenge diversity (WP-I)

Add to `scripts/challenge/strategies/`: `armour_raid`, `shadow_strike`, `backdoor` from
`V23_SPEC.md` §1.1, plus `feint` (a loud offensive on one axis, the real strike on another),
`econ_war` (raid every economic zone and convoy), `siege` (artillery line + works, grind), and
`doctrine_*` (the four 3.0 doctrines driven through the command API). Compute the 2.3 player-
experience metrics (one-sidedness, cheap-win index, warning time, pacing). The AI must survive
≥ 90 % of matches where it is not outmatched; 偷家 and shadow strikes must not take a capital
against the 3.0 defence.

## 13. Music (WP-L)

Improve the procedural war-film score (`src/audio/score.ts`, `themes.ts`, `orchestra.ts`):
richer orchestration (brass / strings / percussion layers with proper voice leading), a theme
per doctrine, tension layers driven by battle intensity and by the player's situation (home
threatened, offensive launched, capital falling), musical transitions on bar boundaries, and
proper mixing. The lead found two knowledge skills on GitHub to read first:
`Tibsfox/gsd-skill-creator` `examples/skills/music/orchestration/SKILL.md` and
`harmony-analysis/SKILL.md`. Render offline previews to `media/stats/music/` and keep the
music tests green.

## 14. Performance (WP-M)

After the systems merge: profile at 8× on a large map with 4 AI (`scripts/perf.ts`,
`perf-browser.mjs`, `profile.mjs`); sim ms/tick must not exceed the 2.2 figure by more than
20 % at equal unit counts; the renderer budget in §4 holds. Fix the worst three hot spots.

## 15. Release (WP-N)

Version 3.0.0, both READMEs (crafting-effective-readmes skill), new GIFs for every new system
(demo-gif skill, same choreography scripts), `npm run dist:win`, signed game bundle, release PR.
Merging to `main` and publishing need the user's OK.
