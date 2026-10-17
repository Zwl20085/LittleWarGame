# WP-D — roads and railways: status

Branch: `worktree-agent-ab63c300467793cd5` (based on `feat/v3.0` bd00fdc). Spec: `docs/V30_SPEC.md` §10.
State: **complete, reported to the lead.** Commits: faf77ec (WIP, everything), 5716618 (fronts test +
lab metrics), 3a291c8 (wheeled nav grid for trucks), 238ba72 (trucks keep off trains, rail bed), + this note.

## What exists
- `rules.json` `transport` (enabled flag for A/B, on_road / off_road per class, class_of, ford_nav_cost,
  road_job, rail incl. trucks_ride=false, ai). Types: `TransportRules`, `MoveClass`, `UnitDef.producible`.
- `src/sim/transport.ts` speed + nav costs (town streets count as road; trucks on a wheeled nav grid).
- `src/sim/roadnet.ts` RoadNet on `world.transport.roads`.
- `src/sim/railgen.ts` + `MapDef.rails / stations` (no RNG draws).
- `src/sim/rail.ts` ownership, cuts, `railLeg` in `moveTo`, trains, stock transfer.
- `src/sim/transportjobs.ts` road / rail repair / rail extension jobs, engineer duty, `needRoadLinks`, small AI.
- `src/sim/transportsnap.ts` snapshot; `src/render/railField.ts`, `trainGeometry`; i18n keys.
- `scripts/lab30/common.ts`, `scripts/lab30/transport.ts`; `tests/transport.test.ts`.

## Acceptance numbers (lab 2026-10-17, seeds 7, 11)
- 20-unit force, large map, 16/20 arrived: rail 748 / 325-380 s; roads only 1200 / 1456 s; 2.2 989 / 1248 s.
- Moving unit-seconds on a road: 31.7-36.7 % (2.2: 25.1-25.9 %).
- Fights ≤ 150 m of a junction: 55.7-66.3 % (2.2: 52.1-61.4 %).
- Soak 30 min 7,11: anomalies 1 before → 0 after. npm test 28 files green. Sim ms/tick +5 %.

## Seams left for the lead
- Wire `needRoadLinks(world, f, extraSites)` into the HQ think / WP-F economic zones (an internal minimal
  AI in `transportSecond` already lays links and repairs own cut lines).
- Player commands / HUD for `startRoadJob`, `startRailRepair`, `startRailExtension` (no command type yet).
- Convoy trips fell vs 2.2 (wheeled 0.4 off road); ammo levels in the soak did not drop. Tune `off_road.wheeled`
  or `on_road` if WP-I's anomaly lab shows starved units.
- `perf-browser.mjs` not run; render adds 6 instanced draws.
