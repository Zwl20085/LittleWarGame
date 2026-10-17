# WP-B + WP-C status — fronts (unlimited, tiers) and directive compliance

Branch: `worktree-agent-aa55ed9ace45ae466` (based on `feat/v3.0` bd00fdc). Spec: docs/V30_SPEC.md §5, §6. As-built summary: docs/COMMAND_V2.md §8.
State: **complete** (all labs run; final report delivered).

## Done
- 27ef778 feat(sim): unlimited fronts (`fronts.soft_max` 32 perf guard, `command.fronts_max` removed), staggered
  `thinkFronts(world, f, chunk)` (8 fronts per tick), units passed to `issueFrontOrder` / `nextTarget`, cached id map in
  `frontref.frontById`; `src/sim/frontTiers.ts` (tiers 12/24/40, barrage, morale/accuracy, supply/reinforce weight,
  stretched; theatre `scaleFronts`, `strayCluster`, under-tier merge); `src/sim/compliance.ts` (compliance, declines,
  delay by distance, home recall, insist/force → `Directive.forced`, `battle.responses`); rules in `docs/data/rules.json`
  (`fronts`, `command.compliance*`), types in `src/data/frontRules.ts`.
- b5802b7 feat(ui): tier / stretched badges, compliance %, declined / forced stamps, HUD Force toggle (zh + en).
- 13bf06f test: fronts.test.ts (no cap, stagger, tiers, scale, stray), directive.test.ts (decline + reason + log,
  insist, force flag, compliance off, home recall ordering, AI model).
- b5d7fb9 docs: COMMAND_V2 §8.
- 2bbf275 labs `scripts/lab30/fronts.ts` (war + cost), `scripts/lab30/directive.ts` (spam + recall); challenge report carries `responses`.
- (next commit) fix(sim): every front rally point snapped to vehicle-passable ground (soak anomaly: tank unreachable on a 23° slope).

## Acceptance numbers
| | before | after |
|---|---|---|
| mid-war (15–35 min) fronts / faction, large map 4 AI, seeds 7/11/13 | 3.8 / 4.1 / 3.8 (mean 3.9) | 6.7 / 5.9 / 7.1 (mean 6.6) |
| mean front size (combat units) | 31.6 | 17.7 |
| challenge lab `--all` 7,11,13 × 40 min | 21/21 | 21/21 |
| soak 30 min seeds 7,11: anomalies | 0 / 1 | 0 / 0 |
Directive lab (player capital kept, compliance on vs off): rush 1/3 vs 0/3, two_axis 1/3 vs 0/3, human_like 2/3 vs 3/3.
Home recall: fronts move in order of distance (2–8 s after the order), first front at the capital 17 / 75 / 85 s (off: 14 / — / 79 s).

## Next steps (follow-ups, not blocking)
1. Fold `scripts/lab30/*` runners into `scripts/lab30/common.ts` when that lands on feat/v3.0.
2. Tune `command.compliance` for human_like (one more capital lost with compliance on) if the lead wants.
