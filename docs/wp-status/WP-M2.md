# WP-M2 status: hunter re-pathing and flow-field memory

Branch: `worktree-agent-a01c7435d110dcc25`, based on `feat/v3.0` 24b6837. State: **in progress**.

## Commits
- e969f29: `scripts/fieldmem.ts` (array buffers, cached fields per class, touched share, rebuilds every 5 min).
- 40bd479: hunters hold a far-chase aim on the 128 m field lattice (report position), re-aim when the
  target leaves 150 m of it or after `infiltration.hunt_repath_s` (15 s, new rules key).
- d886b10: sparse flow fields (32-cell chunks) in one 192 MB LRU budget across movement classes.
- WIP: hot/cold fields (dense while expanding, compact when cold, 6 hot per terrain), Uint16 chunk
  table, A* scratch shared per terrain. The sparse settle loop was 30-40 % slower per cell than the
  dense one (in-process A/B), so expansion now always runs on a dense buffer.

## Results so far
- Infiltration lab, 15 seeds open + 9 fog: past the line undetected before 9 of 1152 units
  (fog seeds 37, 61), after 0. Other metrics within seed-to-seed noise (the war diverges before launch).
- Profile (large, seed 7, 30 min): closeOn -> moveTo 2.1 % -> 1.4 % of sim CPU. Ticks over 150 ms
  (spike.ts, seed 7, 30 min): 20 before, 3 after.
- fieldmem (large, seed 7, 30 min, same war): array buffers 876 MB -> 323 MB, rebuilds 44 % -> 36 %,
  builds 3281 -> 2887.

## Open
Paired perf of the hot/cold tree, simhash 4 x 30 min vs 40bd479, browser 8x, PERFORMANCE.md.
