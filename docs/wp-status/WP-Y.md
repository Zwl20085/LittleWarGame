# WP-Y status — doctrine seams (rail raids, picket gap, upgrades) + backdoor regression

Branch `worktree-agent-a64b488ed4b0a6047` (feat/v3.0 fd3a892 merged in at 8cb4e8f). State: **complete**.

## Commits
- 596c241 wip: rail raids (`src/sim/railraid.ts`), doctrine picket gap, home-defence reserve, lab `scripts/lab30/railraid.ts`.
- 8cb4e8f merge feat/v3.0 (WP-SEC, WP-H).
- d85588f rail raid tuning, doctrine upgrade rows (`upgrades.UPGRADE_PRIORITY` = rules profile `upgrades`), tests.
- 8e36707 docs/DOCTRINES.md seams.

## Results
- Rail raids, 30 min, seeds 7 / 11 / 13. Before = 0da96b2, after = the WP-Y head.
  - 1v1 attrition vs builder, both slot orders: 0 cuts before and 0 after. After: 11 launches, 8 parties broken
    before arriving, 44 attempts with no target. The builder's lines are its capital spurs, deep behind its line;
    the WP-E rear defence (zone of control halves raider speed, then hunts) stops the parties.
  - 4-FFA: line cuts 7 before, 10 after; 1 of them by a raid (seed 13).
- Picket gap: attrition × 0.7, maneuver × 1.35. Infiltration lab, seed 7, launch at 5 min + 5 min: infiltration
  costs +3.6 % sim time before launch and +2.9 % after (cap +10 %).
- Challenge `--all`, seeds 7 / 11 / 13, 40 min, after: every strategy holds, 54 / 54 including backdoor 3 / 3.
  Before (0da96b2): 53 / 54, the only loss doctrine_attrition 67 %.
- Doctrine lab, default config (36 duels + 3 FFA, 45 min):

  | doctrine | feat/v3.0 win / loss | WP-Y win / loss |
  |---|---|---|
  | builder | 52 / 14 % | 62 / 29 % |
  | blitz | 48 / 19 % | 43 / 38 % |
  | attrition | 48 / 38 % | 57 / 19 % |
  | maneuver | 0 / 76 % | 5 / 81 % |

  Maneuver is outside the band on feat/v3.0 already. With maneuver picket_gap = 1 it is 10 / 76 %, so picket
  spacing does not cause it; it needs a maneuver retune (follow-up).

## Backdoor regression
It does not reproduce on the merged tree: backdoor holds 3 / 3 both before and after. The 37:07 loss in the WP-A
report came from the WP-A head before the infiltration merge. A probe of seed 11 found the mechanism WP-A
suspected: 19 of 87 attrition units were raiding while the home alarm was on, and up to 20 % of the capital guards
were in retreat / recover under threat (INFIL_OFF). Fixes:
- `doctrines.raidsHeld`: no new doctrine raid on a home alert or once 12 % of the army is raiding.
- `doctrines.retreatHpOf`: capital guards use the rules retreat threshold.
- `homeguard.convergeOnPoint`: on a breach, recovering units above that threshold rejoin the defence.
