# WP-E status — sparse fronts and infiltration (V30_SPEC §11)

Branch: `worktree-agent-aa578224f6cc603a0` (based on `feat/v3.0` 68f663a).

## Done
- WIP commit: rules `infiltration` block (+ validator `src/data/infiltrationRules.ts`), `src/sim/zoc.ts` (zone of control,
  line crossings, `INFILTRATION_AB` lab switch with sub-switches), `src/sim/pickets.ts` (pickets, reaction group,
  `segmentsByProximity` — front segments by nearest front instead of array index), `src/sim/infiltration.ts`
  (contacts, rear reports, screens, hunts, response budget, unit duty), hooks in sim.ts / behavior.ts / movement.ts /
  fronts.ts (net 0 lines) / operations.ts / types.ts / world.ts, i18n zh+en (`log.infiltrator`, statuses), minimap blip,
  `scripts/lab30/infiltration.ts` (cpu ms/tick, `--fog`), `tests/infiltration.test.ts` (10 tests green).

## Baseline (feat/v3.0 68f663a, before WP-E)
- challenge `shadow_strike,backdoor` 7/11/13 × 40 min: AI survival 100 % / 100 %; experience: shadow_strike score 96,
  min warning 181 s; backdoor 88, min warning 40 s; shadow_strike fog 66 WARN, 3 cheap-win flags, min warning 0 s.
- soak 30 min seeds 7, 11: anomalies none / none.

## In progress / next
1. Merge feat/v3.0 (WP-F/G econ zones, WP-D/D2); use econ zones for the rear screen.
2. Full infiltration lab on/off seeds 7,11,13 (+ fog), challenge --all 21/21, shadow_strike/backdoor, soak 30 7,11.
3. Cost: CPU-time measure is noisy (other agents' labs); smoke showed ≈ +8 %.
4. Docs (COMMAND_V2 §9 or V30 notes), final report.
Scratch (not committed): scripts/lab30/infilDiag.ts, infilProf.ts.
