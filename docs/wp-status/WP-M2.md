# WP-M2 status: hunter re-pathing and flow-field memory

Branch: `worktree-agent-a01c7435d110dcc25`, based on `feat/v3.0` 24b6837. State: **complete**.
Tables: `docs/PERFORMANCE.md`, "WP-M2" under "3.0 round".

## Commits
- e969f29: `scripts/fieldmem.ts` (array buffers, cached fields per class, touched share, rebuilds every 5 min).
- 40bd479: hunters hold a far-chase aim on the 128 m field lattice (report position), re-aim when the
  target leaves 150 m of it or after `infiltration.hunt_repath_s` (15 s, new rules key). Changes behaviour.
- d886b10: sparse flow fields in one 192 MB LRU budget across movement classes.
- d7f3763: hot/cold fields (dense while expanding, compact when cold, 6 hot per terrain), Uint16 chunk
  table, A* scratch shared per terrain. (Sparse expansion was 30-40 % slower per cell, hence the hot form.)
- docs commit: PERFORMANCE.md tables, this note.

## Results
- Infiltration lab, 15 seeds open + 9 fog: past the line undetected 9 of 1152 units before, 0 after.
  Other metrics within seed-to-seed noise; open-mode engagement 189 -> 164 of 240 is the one to watch.
- simhash 30 min, 40bd479 vs d7f3763: identical on medium 7/11 and large 7/11.
- fieldmem (large, seed 7, 30 min, same war): array buffers 876 -> 316 MB, builds 3281 -> 2577,
  rebuilds of evicted goals 44 % -> 28 %. Cells settled per 40 min -21 % / -12 % (seeds 7 / 11).
- Profile: closeOn -> moveTo 2.1 % -> 1.4 % of sim CPU.
- Wall-clock ms/tick, worst ticks and browser 8x: no difference that this loaded machine can resolve.
  The late-war slow ticks are far-field expansions (siege parties, convoys, commanders), not hunters.

npm run typecheck clean; npm test 44 files / 366 tests green (2 skipped files).
