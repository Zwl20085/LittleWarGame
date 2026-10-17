# WP-F + WP-G status (economic zones, defensive works) — resumable note

Branch: the WP-F/G agent worktree branch, based on `feat/v3.0` at bd00fdc (not merged with later v3.0 work).
Spec: `docs/V30_SPEC.md` §7, §8; V23 §1.3. **State: delivered; one open issue (soak eliminations, below).**

## Commits
- 87b8cf3 sim core: `econZones.ts`, `econZoneAi.ts`, `worksTiers.ts`, `minefields.ts`, `capitalDefence.ts`; rules.json
  `econ_zones`, `construction.defensive.tiers`, `capital_defence`; hooks in structures / fortplans / sim / econ / econwar /
  movement / works / terrainrules.
- cae7674 commands (`buildZone`, `upgradeZone`, `upgradeWork`, `layMines` → `worksCommands.ts`), snapshot `econZones`,
  UI (economy panel "build zone" → `placeZone` click mode, `ui/zonePanel.ts`, minimap ring + zones, `ui/i18n-works.ts`).
- 12a6af2 render `render/worksModels.ts` (ezone1..3, fortress, at_emplacement, strongpoint, minefield).
- 674e1fe tests `tests/econZones.test.ts`, `tests/worksTiers.test.ts` (+ econwar / structures adjusted).
- 37d1f92 labs `scripts/lab30/defence.ts`, `scripts/lab30/economy.ts`, helper `scripts/lab30/fgkit.ts`.
- a3978fe AI digs AT emplacements (capital approach, behind fortified zones).
- 8370b4d tuning: zone labour (nearby riflemen at half rate, investor keeps more engineers, 2 jobs), 5 strongpoints, absorb 0.72.
- b278c7f / 8d16cd7 beaten side (< 0.5 × mean holdings): no new perimeter crews / repairs, crews stand down, zones pay 0.

## Lab results
Assault (`defence.ts --suite assault`, 6 valid trials per tier, equal cost incl. works):

| tier | attacker wins | atk value left | def value left | tanks lost |
|---|---:|---:|---:|---:|
| open | 33% | 28% | 34% | 6/12 |
| trenches | 100% | 70% | 5% | 2/18 |
| pillboxes | 83% | 51% | 33% | 4/18 |
| bunkers | 0% | 0% | 72% | 18/18 |
| fortress line | 0% | 1% | 67% | 24/24 |

Mines (4 medium tanks + 2 motor inf vs 2 AT guns, 5 trials): rows 0 / 1 / 2 → tanks surviving 20/20, 10/20, 5/20;
tank HP lost 16 % / 67 % / 82 %.

Cheap-win (4-FFA, 15 min warm-up, 10 min probe, seeds 7/11/13): backdoor 15 % never took a capital, ring on or off
(force lost 77–100 %); armour raid (20 tanks + 10 motor inf ≈ 52–62 % of army) never took one either, ring on or off
(losses 27–97 %) — the capital's home defence already holds; "big raid can still win" is not shown.

Economy (`economy.ts`, builder style f0 vs no zones, paired by seed): mean strength diff +602 at 20 min (2/3 ahead),
+2621 at 45 min (2/3 ahead). Default styles: 6 zones / 8 levels / +202 P+M per min across the map at 45 min.

Soak `scripts/soak.ts 45 7,11,13` eliminations (per seed):
| config | 7 | 11 | 13 | per hour |
|---|---:|---:|---:|---:|
| baseline bd00fdc | 2 | 1 | 1 | 1.78 |
| all three flags off (this branch) | 2 | 1 | 1 | 1.78 |
| final (all on, 8d16cd7) | 0 | 0 | 2 | 0.89 |
| perimeter off | 0 | 1 | 0 | 0.44 |
| zones off | 0 | 0 | 1 | 0.44 |
| tiers only | 2 | 0 | 1 | 1.33 |

**Open issue:** with any of the systems on, eliminations/hour fell below 1.78 in these samples (one run per seed,
counts of 0–2, so noisy). The lead should decide the defaults (flags `capital_defence.enabled`,
`econ_zones.enabled`, `construction.defensive.tiers.enabled`) after a longer, multi-seed soak.

## Seams for the lead
- `world.roadnet.linkedToOwnTown(owner, p)` (econZones.linkedAt): fallback walks the `MapDef.roads` graph.
- `INVEST_STYLE` / `setInvestStyle` (econZoneAi.ts): doctrine weights (builder 2.2, blitz 0.25, …).
- `scripts/lab30/fgkit.ts` can be folded into `scripts/lab30/common.ts`.
