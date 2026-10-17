# WP-T status — balance & pace tuning

Branch `worktree-agent-ab891e6b96ae2b9b8`; feat/v3.0 merged in at 4c3e73d (WP-REV) and 428147f (e4af9b6:
perf, refactor, README, 3.0.0). State: **complete** (report delivered). Full write-up: docs/BALANCE_LAB.md,
"2026-10-17 3.0 tuning round". typecheck + vitest green (43 files, 364 tests).

## Commits
- 4258d29 / 700fdc1 lab tooling: `LAB_SET` env overrides everywhere (soak, challenge, anomaly, lab30), `:=`
  override, soak `ELIMINATIONS` line, `scripts/lab30/pace.ts`, upgrade lab `--parts engage`
  (`upgradeEngage.ts`), assault kill attribution + `--tiers`.
- dc5b5b1 fix(upgrades): inf_guns never fired during an attack-move (dead item).
- (upgrade prices) balance(upgrades): ap_grenades, inf_guns, armour_3, gun_3 repriced from the engagement lab.
- b622e41 balance(works): bunker 0 → 50 %, fortress 0 → 29 % (AT guns in concrete); 4768b0d test.
- 87ffd8c + 902b638 balance(pace): broken-target finisher (storm.FINISH broken*) + lighter perimeter.
- 51cc0d7 balance(doctrines): maneuver retune. 411c42a balance(transport): wheeled off-road 0.55; a14843a tests.

## Results (final tree)
- Pace (6 seeds × 60 min): eliminations 2 → 6 (0.33 → 1.00 /h); every seed now has a fallen capital
  (36–59 min); 0/6 wars end. Goal 1.5 /h and 50 % ended NOT met — a beaten side keeps ~70 % of the leader's
  income and ~400 pop at home; needs a beaten-side economy change (lead decision).
- Assault win %: open 64, trenches 86, pillboxes 93, bunkers 50, fortress 29.
- Doctrine matrix win / loss: builder 62/19, blitz 33/38, attrition 33/52, maneuver 24/43 (was 5/90);
  fingerprints 71 %.
- Upgrades (engagement value/cost ÷ median): all combat items 0.74–1.5.
- Anomaly ammo_starved (4 seeds × 30 min): WP-I tree 22, wheeled 0.4 41, 0.55 24.
- Challenge --all: 53/54 (2.x 21/21); shadow_strike seed 11 took a beaten side's capital at 35:02 (outmatched
  per the lab). min_held_share 0.6 → 9/9 cheap-win holds but only 3 eliminations: lead to choose.

## Open
- Beaten-side economy (capital base income / capital econ buildings / capital_pop_share) is the next lever.
- fronts.test defend-order sample floor is sensitive to transport speed (now >= 3 settled squads).
