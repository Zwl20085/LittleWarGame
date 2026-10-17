# WP-REV status (code-review fixes)

Branch: `worktree-agent-a454729feb76eab03` (based on feat/v3.0 0da96b2, merging feat/v3.0 as it moves).
Regression tests: `tests/review.test.ts` (one block per finding).

| # | finding | state |
|---|---|---|
| 1 | engineer double-booking (transport vs works/zone jobs) | done (894653f) |
| 7 | drop/reassign unfit transport workers, log drops, refund unstarted | done (894653f) |
| 3 | setWeight/setCap/togglePause/normalizedWeights reject non-producible | code in, test pending |
| 2 | fog leaks: minimap zones, rail trains/riders, zone models, ZonePanel.pickAt | todo |
| 4 | zoc holdsLine / selectTarget skip train riders | todo |
| 5 | transportsnap mirrors bridges, road paint, road graph | todo |
| 6 | AI road links: iterate candidates, remember failures 5 min | todo |
| 8 | loader validation for transport / econ_zones / capital_defence | todo |
| 9 | infiltration report merge within cluster radius, capped | todo |
| 10 | infiltration anchorDistances cost (measure ms/tick) | todo |
| 11 | PressGuard on ZonePanel; engineering panel free engineers, Fix disabled while under repair | todo |
| 12 | pickets: remove vacated slot from slotList | todo |
| 13 | file splits | skipped by instruction |

Baseline (0da96b2, possibly with first edits loaded mid-run; to be re-measured): infiltration lab seed 7 10 min,
on: 4.87 ms/tick before launch, 4.90 after; off: 4.42 after.
