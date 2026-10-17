# WP-H unit upgrades — status (resume point)

Branch `worktree-agent-a355e4433af39a02b` (based on feat/v3.0 1344bd5). Spec `docs/V30_SPEC.md` §9.

## Done
- Sim: `src/sim/upgradestats.ts` (13-item tree in bit order, class masks, cached variant
  UnitDef / WeaponDef per (type, bits), refit on spawn / at a town rearm / at once, faction-wide
  helpers), `src/sim/upgrades.ts` (prices with escalation, research timer at the capital, cancel
  refund, AI fund + priority table `upgradePriority(doctrine, personality)`),
  `src/sim/upgradekit.ts` (attached gun team HE, AP grenades). Rules block `upgrades` in
  docs/data/rules.json, typed in `src/data/upgradeRules.ts`.
- Hooks: world.spawnUnit (refitOnSpawn), settlements.drawSecond (refitAtTown), combat.updateWeapons
  (kitFire), movement.handleMount + rail.travelSpeed (isMotorized), convoy.truckCap (capacity),
  frontTiers (staff), works / structures / engineering / transportjobs (workMul), sim
  (makeFaction + upgradeSecond), snapshot (F.upg + mirror refit), commands (research /
  cancelResearch).
- UI: `src/ui/upgrades.ts` panel + HUD button + Y hotkey, unit card line, strings in
  `src/ui/i18n-upgrades.ts` (zh + en).

## Next
- Render visuals (skirts, long barrel, gun team, motorized trucks already drawn by mounted flag).
- tests/upgrades.test.ts, lab scripts/lab30/upgrade.ts, docs/UPGRADES.md, BALANCE_SPEC block.
- Challenge 21/21 and soak check.
