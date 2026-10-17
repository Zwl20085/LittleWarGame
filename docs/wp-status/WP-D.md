# WP-D — roads and railways: status

Branch: `worktree-agent-ab63c300467793cd5` (based on `feat/v3.0` bd00fdc). Spec: `docs/V30_SPEC.md` §10.

## Done (in the WIP commit, see git log)
- `rules.json` `transport` block (enabled flag, on_road / off_road per class, class_of, ford_nav_cost,
  road_job, rail, ai). Types in `src/data/types.ts` (`TransportRules`, `MoveClass`), `UnitDef.producible`
  (units.csv `producible` column; `train` row, not producible; commander false).
- `src/sim/transport.ts`: off-road multipliers (town streets count as road), nav cost fns (ford ×2.5,
  A* heuristic = cheapest cell); wired in `world.nav` and `movement.speedOf`. `enabled=false` = 2.2 exactly.
- `src/sim/roadnet.ts`: `RoadNet` (nodes town/junction/bridge, edges with length, crossings, T-junctions,
  `addSegment`, `junctions`, `roadDistance`, `components`) on `world.transport.roads`.
- `src/sim/railgen.ts` + `MapDef.rails/stations` (mapgen, no RNG draws; forests kept off the rail bed).
- `src/sim/rail.ts`: init, line ownership (all stations held + no enemy ground across), cut on station
  loss, `railLeg` hook in `moveTo` (walk to station → wait → aboard), trains (cap 6, 4/faction), unload,
  rail stock transfer. Hooks: sim.ts (think skip, railTick, railSecond), movement, combat, capture.
- `src/sim/transportjobs.ts`: road job (paint Ground.Road, bridges water gaps ≤ 70 m, nav refresh, road
  graph), rail repair / extension jobs, engineer duty (behavior.ts hook), `needRoadLinks`, minimal AI.
- `src/sim/transportsnap.ts` + snapshot hook (line state, trains, geometry on change, aboard flag 128).
- i18n zh/en keys (status.ridingRail, status.awaitingTrain, status.buildingRoad/Rail, job.road/rail, logs).
- Render: `src/render/railField.ts` (ballast, sleepers, rails, stations, built roads, trains instanced),
  `trainGeometry` in vehicleModels.ts, renderer + unitViews hooks (aboard units hidden).
- Lab: `scripts/lab30/common.ts`, `scripts/lab30/transport.ts`. Tests: `tests/transport.test.ts` (5 pass).

## Baseline numbers
- `npx tsx scripts/soak.ts 30 7,11` before: anomalies 0 (seed 7) + 1 (seed 11) = 1.

## In progress / open
- Cross scenario: riders board, but 18/20 arrival > 2400 s; diagnosing with `XDBG=1` (END line).
- `tests/fronts.test.ts` "binds a defend order": 0.9 vs > 0.9 (one light tank stops 92 m off the line,
  its dest is 90 m off: slot geometry under the new nav costs). Decide: tune or document.
- Full `npm test`, soak after, lab A/B tables, perf numbers, final report.

## Next steps
1. Fix cross scenario, run `npx tsx scripts/lab30/transport.ts --seeds 7,11 --minutes 30 --jobs 6`.
2. Run soak 30 7,11; compare with baseline. 3. npm test green. 4. Report to lead.
