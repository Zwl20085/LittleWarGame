# WP-T status — balance & pace tuning (resume point)

Branch `worktree-agent-ab891e6b96ae2b9b8`; feat/v3.0 merged in at 4c3e73d (WP-REV) and 428147f (e4af9b6:
perf, refactor, README, 3.0.0). State: **in progress** — final runs on the merged tree pending.

## Tooling (committed)
- `LAB_SET="a.b=1;unit.x.cost_p*=1.1"` env overrides in soak, challenge, anomaly runner and every lab30 suite
  (`scripts/lab/overrides.ts envOverrides`); `:=` sets an optional rules leaf. Soak prints `ELIMINATIONS n at [...]`.
- `scripts/lab30/pace.ts` per-faction finish target / finisher / directive / doctrine phase / ring probe.
- `scripts/lab30/upgrade.ts --parts engage` (`upgradeEngage.ts`): fixed single engagements per combat item.
- `defence.ts`: kill attribution by defender type, `--tiers`. Soak/pace: `FINISH_BROKEN=0`, `FINISH_SET='{...}'`.
- Scratch runners in the session scratchpad (soakp.sh = 6 seeds in parallel; multi.sh = assault variants).

## Done
1. Works tiers (b622e41): bunker 0 → 50 %, fortress 0 → 29 % (AT guns in concrete were untouchable; cover lever).
2. inf_guns was dead (dc5b5b1): gun team never fired while the squad attack-moved. Fixed.
3. Upgrade prices (engagement lab, 3c… see git log): ap_grenades, inf_guns, armour_3, gun_3; all combat items in band.
4. Finisher for a broken side (87ffd8c, storm.FINISH brokenHeldShare 0.65 / brokenArmyRatio 1.5 /
   brokenStrongestRatio 0.8 / brokenFullness 0.7).

## Pace (6 seeds × 60 min, eliminations; 0/6 wars ended in every config)
| config | 7 | 11 | 13 | 17 | 19 | 23 | total | /h |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline (merged REV tree) | 0 | 1 | 0 | 1 | 0 | 0 | 2 | 0.33 |
| + finisher v1 (ring-unsupported target, ratio 2) | 0 | 1 | 0 | 1 | 0 | 1 | 3 | 0.50 |
| + finisher v2 (held share 0.65, ratio 1.5) | 0 | 0 | 1 | 2 | 0 | 0 | 3 | 0.50 |
| v2 + K1 ring stands down < 0.7 held share | 1 | 1 | 0 | 0 | 1 | 1 | 4 | 0.67 |
| v2 + K2 (K1 + 4 strongpoints, 6000 HP, crew respawn 150 s) | 1 | 2 | 0 | 1 | 2 | 1 | 7 | 1.17 |
| v2 + K3 perimeter off (bound) | 1 | 1 | 0 | 1 | 1 | 1 | 5 | 0.83 |
| K2 rerun on works/upgrade rules | 1 | 2 | 0 | 1 | 1 | 1 | 6 | 1.00 |
| K2 + earlier finisher (fullness 0.55, strongest 0.7) | 1 | 2 | 0 | 1 | 1 | 1 | 6 | 1.00 |
| K2 + capital_pop_share 0.15 | 1 | 1 | 0 | 1 | 1 | 0 | 4 | 0.67 |
| K2 + finisher ratio 1.2 | 1 | 2 | 0 | 1 | 1 | 1 | 6 | 1.00 |

Finding: the first capital falls at 37–55 min in every config; a beaten side (12–20 settlements) keeps ~70 %
of the leader's income and pop 400 at home (capital pop share + capital econ buildings), so leaders sit at
army ratio 1.0–1.4 and rarely commit. 50 % of wars ending inside 60 min would need three eliminations per war:
not reachable by these levers.

## Maneuver (doctrine lab --only maneuver, 3 seeds, 45 min)
| | maneuver win / loss |
|---|---|
| feat/v3.0 | 5 / 90 % |
| M1: occupy 0.7→1.1, main_share 1.8→1.3, battle after_s 300→600, cooldown 60→180, min_fullness 0.5→0.7 | 24 / 57 % |

## Next
Apply K2 + M1 (nudged) to rules.json, final soak / full doctrine lab / challenge / anomaly before-after on the
merged tree, BALANCE_LAB.md 3.0 section, typecheck + tests, report.
