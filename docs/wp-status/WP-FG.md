# WP-F + WP-G status (economic zones, defensive works) — resumable note

Branch: the WP-F/G agent worktree branch, based on `feat/v3.0` (bd00fdc). Spec: `docs/V30_SPEC.md` §7, §8; V23 §1.3.

## Done
- 87b8cf3 sim core (WIP commit):
  - `src/sim/econZones.ts` zones (start / level-up / rebuild, engineer job via structures.assignJob ids,
    output × level × HP × road link, capture with ground, demolition, shellfire), road-link fallback
    over `MapDef.roads` graph — SEAM `world.roadnet.linkedToOwnTown(owner, p)`.
  - `src/sim/econZoneAi.ts` AI placement (called from econai.thinkInvestment), `INVEST_STYLE` table +
    `setInvestStyle` (SEAM for doctrines).
  - `src/sim/worksTiers.ts` upgrades (pillbox→bunker→fortress, trench tier 1), AI planner (from
    fortplans.planStructures), manned observation / artillery spotting helpers.
  - `src/sim/minefields.ts` lay / slow / detonate / clear.
  - `src/sim/capitalDefence.ts` perimeter strongpoints + fixed MG crews + mortar position, respawn,
    repair jobs, fog observation ring (sim.updateVisibility).
  - rules.json blocks `econ_zones`, `construction.defensive.tiers`, `capital_defence` (+ loader validation).

## Baseline (before)
- `npx tsx scripts/soak.ts 45 7,11,13`: eliminations 2 / 1 / 1 in 3 × 45 min = **1.78 / hour**.

## Remaining (next steps)
1. Commands: buildZone {pos}, upgradeZone {zoneId}, upgradeWork {fortId}, layMines {pos, facing} (sim/commands.ts).
2. Snapshot: `econZones` array (snapshot.ts make/apply).
3. UI: EconomyPanel "build zone" button → InputMode `placeZone` (ui/context.ts, input.ts modeClick);
   ZonePanel (click a zone: level, output, link, level-up/rebuild); mode hint; minimap ring; i18n zh+en
   (status.buildingZone/upgrading/layingMines/repairing, log.zone*, log.work*, log.minefieldGone).
4. Render: register `ezone1..3`, `fortress`, `at_emplacement`, `strongpoint`, `minefield` kinds
   (render/worksModels.ts) and feed zones through renderer.extraStructures; exclude new kinds from fortModel fallback.
5. Tests: tests/econZones.test.ts, tests/worksTiers.test.ts; run `npm test` (determinism).
6. Labs: scripts/lab30/defence.ts (assault vs tiers, raids vs minefields, cheap-win ring on/off),
   scripts/lab30/economy.ts (income curves, zones vs pure army 20/45 min).
7. Soak after: `npx tsx scripts/soak.ts 45 7,11,13` — eliminations/hour must stay ≥ 1.78.
8. Tuning seen so far: zones take ~12 min to reach level 1 (engineers busy / long walks).
