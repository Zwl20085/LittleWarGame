# WP-REV status (code-review fixes) — complete

Branch: `worktree-agent-a454729feb76eab03` (base feat/v3.0 0da96b2; feat/v3.0 fd3a892 merged in 0e8ae9b).
Regression tests: `tests/review.test.ts` (one block per finding). Not pushed, not merged.

| # | finding | fix | test | commit |
|---|---|---|---|---|
| 1 | engineer double-booking | assignWorkers / freeEngineer skip engineers with a works/zone job (`jobOf`); `fortplans.freeHand(f, u, world)` skips transport workers. Owner: whoever took the engineer first; a transport worker stays with transportjobs until released | HIGH 1 block | 894653f |
| 7 | unfit transport workers | worker manual / routing / riding / > 2200 m for > 60 s is released and the job reassigned (`log.transportWorkerLost`); stale drop refunds P/M when progress 0 and logs `log.transportJobDropped` | MED 7 blocks | 894653f |
| 3 | non-producible production settings | setWeight / setCap / togglePause refuse train + commander (on top of WP-SEC's existence check); `normalizedWeights` skips non-producible; challenge `setMix` follows | HIGH 3 block, challenge.test | f571f0e, 3849283, 0f8e746 |
| 12 | picket slot bookkeeping | vacated slot removed from `slotList` | MED 12 block (fails without fix) | 5973fb4 |
| 4 | train riders | `holdsLine` and enemy `selectTarget` skip `rail.stage === 'aboard'` | MED 4 block | 7b198f6 |
| 6 | AI road links | iterate all candidates, skip a site for 5 min after a failed start | MED 6 block | 199e7ac |
| 8 | loader validation | new `src/data/transportRules.ts`; econ_zones levels / road_link_m / max_per_faction / beaten_output; capital_defence crew_respawn_seconds / quiet_m; errors name the key | MED 8 block; rules.test green | 33b095d |
| 10 | anchorDistances cost | only units a hostile faction knows; 100 m anchor-distance grid (rebuilt every 10 s or on owner change, checked once per tick) with exact fallback when the error bound cannot decide — same answer | MED 10 block (grid == exact over the map) | d183e21, 52942a6, e3f5ac6 |
| 5 | road/bridge mirror | builtRoads carry bridged gaps; `applyTransport` replays paint + addBridge + nav refresh + roads.addSegment on the main thread | MED 5 block (mirror ground == worker ground) | 6479099 |
| 2 | fog leaks | new `src/sim/fogview.ts` (observers of the unit visibility pass); snapshot sends own zones live, enemy zones seen live / else last seen; only seen trains, no enemy rider counts; minimap hides riders. Spectators / open mode see all | HIGH 2 block | 1f9c781 |
| 11 | panels | ZonePanel PressGuard; snapshot job view (owner, kind, lineId, own workers); Engineering panel counts free engineers, Fix disabled ("Under repair") while a rail job is open | MED 11 block | 1f9c781 |
| 9 | report merging | a report is taken by one cluster per pass; others join only within report_cluster_m, else a new report (max 8 per faction) | MED 9 block (fails without fix) | d2f1906 |
| 13 | file splits | skipped by instruction (infiltration.ts, transportjobs.ts, review.test.ts are the candidates) | — | — |

Note: 6479099 accidentally carried a reverted infiltration.ts (benchmark swap staged it); 52942a6 restores it.

## Measurements

reportInfiltrators per call on a 10-min seed-7 state (temporary bench, machine shared with other agents):
open 2.97 -> 0.82 ms, fog 4.48 -> 0.16 ms. Infiltration lab (`--seeds 7 --minutes 10`, ms/tick after launch,
whole sim, noisy): feat/v3.0 on 5.21 / off 4.66; WP-REV on 5.09 / off 4.58. Lab results (reports, depth) unchanged.

Soak `30 7,11`: no anomalies, no result in 30 min, on both feat/v3.0 and WP-REV. Tick ms are dominated by
machine load (seed 7: 4.56 base vs 7.9-9.7 WP-REV runs; seed 11: 11.41 base vs 8.2-10.3), so no reliable
perf delta; the engineer-ownership change shifts zone/works timing (zones 0/1/0/0, 1/0/3/0 base vs 0/0/1/0, 0/0/2/0).

`npm run typecheck` green; `npm test` 358 passed / 3 skipped, determinism green.
