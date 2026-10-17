# WP-B + WP-C status — fronts (unlimited, tiers) and directive compliance

Branch: `worktree-agent-aa55ed9ace45ae466` (based on `feat/v3.0` bd00fdc). Spec: docs/V30_SPEC.md §5, §6. As-built summary: docs/COMMAND_V2.md §8.

## Done
- 27ef778 feat(sim): unlimited fronts (`fronts.soft_max` 32 perf guard, `command.fronts_max` removed), staggered
  `thinkFronts(world, f, chunk)` (8 fronts per tick), units passed to `issueFrontOrder` / `nextTarget`, cached id map in
  `frontref.frontById`; `src/sim/frontTiers.ts` (tiers 12/24/40, barrage, morale/accuracy, supply/reinforce weight,
  stretched; theatre `scaleFronts`, `strayCluster`, under-tier merge); `src/sim/compliance.ts` (compliance, declines,
  delay by distance, home recall, insist/force → `Directive.forced`, `battle.responses`); rules in `docs/data/rules.json`
  (`fronts`, `command.compliance*`), types in `src/data/frontRules.ts`.
- b5802b7 feat(ui): tier / stretched badges, compliance %, declined / forced stamps, HUD Force toggle (zh + en).
- 13bf06f test: fronts.test.ts (no cap, stagger, tiers, scale, stray), directive.test.ts (decline + reason + log,
  insist, force flag, compliance off, home recall ordering, AI model). Full `npm test` green, determinism green.
- b5d7fb9 docs: COMMAND_V2 §8.
- Labs: `scripts/lab30/fronts.ts` (war + cost suites), `scripts/lab30/directive.ts` (spam + recall suites).
- Rally point of a new front snapped to vehicle-passable ground (soak anomaly).

## Numbers so far (large map, 4 AI, 45 min, seeds 7/11/13)
| | before | after |
|---|---|---|
| mid-war (15–35 min) fronts / faction | 3.8 / 4.1 / 3.8 (mean 3.9) | 6.7 / 5.9 / 7.1 (mean 6.6) |
| mean front size (combat units) | 31.6 | 17.7 |
| fronts at tier ≥ 1 | — | 75–93 % |
Cost suite (seed 7, ms/tick, noisy shared machine): before 4/8/16/24 fronts = 33.0/23.5/19.8/27.1; after = 17.2/18.5/21.6/22.6.
Challenge baseline 21/21 AI survival.

## In progress / remaining
- Challenge lab after changes (`npx tsx scripts/challenge.ts --all --seeds 7,11,13 --minutes 40 --jobs 6`) — must stay 21/21.
- Directive lab (`npx tsx scripts/lab30/directive.ts`) — compliance on vs off for rush / two_axis / human_like + home recall.
- Soak `npx tsx scripts/soak.ts 30 7,11`: done after changes (1 anomaly class: tank rally on a slope → fixed, re-run to confirm).

## Next steps for a fresh agent
1. `npm run typecheck && npm test`.
2. Run the challenge lab and the directive lab above; put the tables in the final report.
3. Fold `scripts/lab30/*` runners into `scripts/lab30/common.ts` if that lands on feat/v3.0.
