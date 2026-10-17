# WP-Y status — doctrine seams (rail raids, picket gap, upgrades) + backdoor regression

Branch `worktree-agent-a64b488ed4b0a6047` (base feat/v3.0 0da96b2). State: **in progress**.

## Done (WIP commit)
- `src/sim/railraid.ts`: rail raid parties for doctrines with `raid_targets.rail` > 0 (attrition); target = point
  on an enemy-held line / station near our front (econwar scoring rules); a member on the spot 20 s cuts the line
  (`line.cut`, same engineer repair path). Hooks: fronts.ts (planRailRaids), behavior.thinkOpRaid (`rail:` tag).
- Picket spacing: profile `picket_gap` (attrition 0.7, maneuver 1.35, others 1) → `doctrines.picketGapMul` →
  `pickets.picketGap(r, tier, mul)`.
- Home-defence reserve: capital guards keep the rules retreat threshold (`retreatHpOf`); doctrine raids (econ,
  rail, convoy) held on a home alert or with >= 12 % of the army already raiding (`raidsHeld`); on a breach a unit
  recovering at home above the rules threshold rejoins as a guard.
- Lab `scripts/lab30/railraid.ts` (1v1 attrition vs builder, both slot orders).

## Findings so far
- Backdoor regression does not reproduce on the merged base (0da96b2): backdoor 3/3, `--all` 2.x 21/21
  (the WP-A 37:07 loss was measured before the infiltration merge). Probe seed 11: attrition AI had 19 of 87
  units raiding with the home alarm on (3–4 stacked convoy raids at 2× cadence) and 20 % of its capital guards
  in retreat / recover under threat (INFIL_OFF) — the fixes target that.
- First rail raid lab: 11 launches, 0 cuts (parties do not arrive) — under investigation.

## Next
- Merge feat/v3.0 (WP-SEC, WP-H), fill `upgradePriority` doctrine rows; tests; labs (rail raid, infiltration
  cost, backdoor, --all, doctrine lab).
