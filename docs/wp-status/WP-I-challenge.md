# WP-I challenge lab: status (resumable note)

Branch: worktree-agent-a00de1da53255b7d4 (fast-forwarded to feat/v3.0 docs commit bd00fdc, then own commits).

## Done (all deliverables)
- 3a13681 strategies armour_raid, shadow_strike, backdoor, feint, econ_war, siege, ai_only; route.ts; experience.ts;
  expLog.ts; experienceReport.ts; CLI `--suite diversity` / `--experience` / `--experience-out` / `--variant` / `--map-size`; tests.
- 86c902a fix (defender value in the ring series) and the 3.0 section of docs/CHALLENGE_LAB.md.
- Final commit: baseline JSON (`docs/lab/base-2.2.1-experience.json`, `-large.json`) and the baseline table in docs/CHALLENGE_LAB.md.
- Runtime: medium 54 matches 55 min wall (9 jobs); large 30 matches 53 min wall (7 jobs).

## Remaining
Nothing required. Optional: `doctrine_*` strategies (V30_SPEC section 12) wait for the WP-A doctrine commands; an armour_raid flank
that actually changes the approach; investigate the 50 % supply-starved share.

## Resume
`npx tsx scripts/challenge.ts --suite diversity --seeds 7,11,13 --minutes 40 --jobs 9 --experience` reproduces the medium baseline.
