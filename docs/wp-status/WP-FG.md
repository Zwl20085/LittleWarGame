# WP-F + WP-G status (economic zones, defensive works) — resumable note

Branch: the WP-F/G agent worktree branch, based on `feat/v3.0` at bd00fdc (not yet merged with later v3.0).
Spec: `docs/V30_SPEC.md` §7, §8; V23 §1.3.

## Done
- 87b8cf3 sim core: `econZones.ts`, `econZoneAi.ts`, `worksTiers.ts`, `minefields.ts`, `capitalDefence.ts`; rules.json blocks
  `econ_zones`, `construction.defensive.tiers`, `capital_defence`; hooks in structures / fortplans / sim / econ / econwar /
  movement / works / terrainrules.
- cae7674 commands (`buildZone`, `upgradeZone`, `upgradeWork`, `layMines` → `src/sim/worksCommands.ts`), snapshot
  `econZones`, UI: economy panel "build zone" → map click mode `placeZone`, `src/ui/zonePanel.ts`, minimap ring + zones,
  strings `src/ui/i18n-works.ts` (zh + en).
- 12a6af2 render: `src/render/worksModels.ts` (ezone1..3, fortress, at_emplacement, strongpoint, minefield).
- 674e1fe tests: `tests/econZones.test.ts`, `tests/worksTiers.test.ts`; econwar / structures tests adjusted for the perimeter.
- 37d1f92 labs: `scripts/lab30/defence.ts`, `scripts/lab30/economy.ts`, helper `scripts/lab30/fgkit.ts`.

## Baseline (before)
- `npx tsx scripts/soak.ts 45 7,11,13` at bd00fdc: eliminations 2 / 1 / 1 in 3 × 45 min = **1.78 / hour**.

## In progress
- Lab runs: defence (assault + mines, then cheapwin), economy, soak after. Tune from the numbers.

## Seams for the lead
- `world.roadnet.linkedToOwnTown(owner, p)` (econZones.linkedAt) — fallback walks `MapDef.roads`.
- `INVEST_STYLE` / `setInvestStyle` (econZoneAi.ts) — doctrine weights.
- `scripts/lab30/fgkit.ts` may be folded into `scripts/lab30/common.ts`.
