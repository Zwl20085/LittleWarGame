# WP-I challenge lab: status (resumable note)

Branch: worktree-agent-a00de1da53255b7d4 (fast-forwarded to feat/v3.0 docs commit bd00fdc, then own commits).

## Done
- 3a13681 feat(lab): strategies armour_raid, shadow_strike, backdoor, feint, econ_war, siege, ai_only (ids stable, registered
  in scripts/challenge/strategies/index.ts); route.ts (unseen-ground A*, flank waypoint); experience.ts (metrics, bands,
  score); expLog.ts (collector); experienceReport.ts; CLI `--suite diversity`, `--experience`, `--experience-out`,
  `--variant`, `--map-size`; tests (synthetic metric series) in tests/challenge.test.ts.
- docs/CHALLENGE_LAB.md: strategies table + metric definitions + bands (section "3.0"); a `<!--BASELINE-->` marker awaits the results table.

## In progress
- Baseline runs on the 2.2.1 sim (after fixing the defender-in-ring series bug in expLog.ts, uncommitted at the time of writing):
  medium: `npx tsx scripts/challenge.ts --suite diversity --seeds 7,11,13 --minutes 40 --jobs 9 --experience --experience-out docs/lab/base-2.2.1-experience.json` (about 45 min wall at 12 jobs)
  large: `... --seeds 7,11 --map-size large --variant 15-flank --experience --experience-out docs/lab/base-2.2.1-experience-large.json`

## Remaining
1. When the runs finish: read media/stats/lab30/experience-<ts>.md, put the per-scenario table and capital-fall table into
   docs/CHALLENGE_LAB.md at `<!--BASELINE-->`, commit docs/lab/base-2.2.1-experience*.json.
2. `npm run typecheck` and `npm test` green, commit.

## First baseline (before the fix, medium, 3 seeds, 40 min)
All 18 scenarios PASS on score (75-95). AI survival 100 % except shadow_strike open 33 % (challenger took 2 capitals),
ai_only 67 % (the scripted faction 0 is an AI there). Cheap-win flags: rush_micro 1, backdoor 1. Never-seen capital
losses: turtle, two_axis, late_blitz, backdoor (2), siege, ai_only. Supply-starved share about 50 % everywhere (supplyRatio < 0.5).
armour_raid never fielded 20 tanks + 10 motor inf (population), launches late.
