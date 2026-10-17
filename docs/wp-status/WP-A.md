# WP-A status — AI doctrines (作战风格), music wiring, doctrine_* strategies

Branch `worktree-agent-ac07b57b1ae15b872`. Spec: docs/V30_SPEC.md §1. feat/v3.0 (c26da27, zones/works +
roads/rail) merged in at 82d3a6e. State: **complete** (report delivered); one open item below.

## Commits
- b9f5c99 doctrines core: rules.json `doctrines`, `src/data/doctrineRules.ts`, `src/sim/doctrines.ts`,
  `src/sim/doctrineai.ts`, lever hooks, lab `scripts/lab30/doctrine.ts` + `doctrineReport.ts`.
- 39058d3 UI selector + faction-card line, `src/ui/musicCues.ts`, doctrine_* strategies, tests, blitz retune.
- 82d3a6e merge feat/v3.0; doctrine invest weight → `econZoneAi.setInvestStyle`.
- ae7f772 v6 retune, docs/DOCTRINES.md, lab `--only` / `--set`.
- (next) finish-a-broken-enemy rule + 2.2 defend thresholds; STRATEGY_LAB / CHALLENGE_LAB sections; test fixes.

## Results (merged tree, final tuning)
- Overall win / loss (36 duels both slot orders + 6 FFA): builder 46/21 %, blitz 42/29, attrition 29/29,
  maneuver 21/58 (< 75 % everywhere).
- Distinctiveness: fingerprint classification 71–77 % (chance 25 %); FFA curve distance 0.16–0.75.
- Eliminations / h (lab FFA 6 seeds + soak 45 7,11,13): on 0.89, off 0.89 (same tree). Pre-merge 2.2 soak 1.33.
- Challenge --all: legacy 21/21; backdoor 67 % (attrition AI, seed 11; 100 % with DOCTRINES=0).
- npm test: all green after the test updates (challenge registry, zone style).

## Open
- backdoor vs attrition AI (seed 11, capital at 37:07): attrition's retreat / raids thin the home guard late.
- Seams: rail raid target (WP-D), zone raid weight (zones go through the econ raid cadence), picket gap
  (`picketGapMul`, WP-E), upgrades (`upgradePriorities`, WP-H).
