# WP-H unit upgrades — status (resume point)

Branch `worktree-agent-a355e4433af39a02b`; feat/v3.0 merged in at 5227186 (WP-F/G, WP-D2).
Spec `docs/V30_SPEC.md` §9; overview `docs/UPGRADES.md`; rules block BALANCE_SPEC §10.2.

## Done
- Sim: upgradestats.ts (tree, variant defs, refits), upgrades.ts (prices, research timer,
  cancel refund, AI fund + `upgradePriority(doctrine, personality)`), upgradekit.ts (gun team,
  AP grenades). Hooks in world, settlements, combat, movement, rail, convoy, frontTiers, works,
  worksTiers, structures, engineering, transportjobs, sim, snapshot, commands.
- UI panel (Y + HUD button), unit card line, zh/en strings. Panel screenshot checked.
- Render: skirts, barrel extension, gun team (src/render/upgradeModels.ts). Tank visuals not yet
  seen in a screenshot (no player tanks in the quick match tried).
- tests/upgrades.test.ts (8 tests) green; full suite green before the merge.
- Lab scripts/lab30/upgrade.ts. Round 1 (3 seeds): value-per-cost noise (± several × cost)
  swamps the item effects; 1v1 wars rarely end in 60 min (rich side won 1/12). Fixes: gun team
  friendly-fire guard, ammo 0.02 → 0.006; lab reports s.e. and end-state lead.

## Verification (final)
- Round 3 lab (repriced): tables in docs/UPGRADES.md. Challenge `--all --seeds 7,11,13 --minutes 40
  --jobs 6`: 14 strategies × 3 seeds, AI holds everywhere (42/42). Soak `30 7,11`: upgrades on 0
  anomalies, mean tick 6.7 ms; UPGRADES=0 2 anomalies (mg unreachable), 7.1 ms.
- typecheck + full suite green after the feat/v3.0 merge (38 files, 294 tests).

## Seams left
- Value lab is noise-dominated (bank P/M mix); a per-engagement lab would measure items better.
- 1v1 wars rarely end within 60 min, so the rich-wins-70 % criterion cannot be met by upgrades alone.
- Doctrine rows in UPGRADE_PRIORITY (WP-A). fronts.ts SPEAR_MOBILE does not count motorized rifle
  squads as mobile. Tank skirt / barrel visuals not seen in a screenshot yet.
- Foot reinforcements failed to arrive in 40 min on seeds 7 and 11 (motor lab) — worth a look by
  the pathing owner.
