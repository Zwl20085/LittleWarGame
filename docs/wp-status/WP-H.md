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

## Running / next
- Round 2: value with 6 seeds + rich (6 seeds × 2 sides, 60 min).
- Then tune costs, challenge `--all --seeds 7,11,13 --minutes 40 --jobs 6` (21/21), soak `30 7,11`,
  full npm test after the merge.
