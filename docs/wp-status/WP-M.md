# WP-M status: 3.0 performance round (V30_SPEC §14)

Branch: `worktree-agent-a71b5e2ec10e0548f`, based on `feat/v3.0` fd3a892. feat/v3.0 (WP-REV) was merged
in at 16eac99 before the final measurements. State: **complete**. The tables are in `docs/PERFORMANCE.md`,
section "3.0 round".

## Commits
- 5630e77, bf6a14f: tools (perf.ts SIZE / µs per unit; profile.mjs modules, --dir / --reuse; spike.ts;
  snapsize.ts; simhash.ts; perf-browser SIZE / tier / GOVERNOR / 3.0 parts).
- 06ecc20: nav grids share terrain samples. A lazy grid build on the large map dropped from 230–370 ms
  to 50–140 ms per class.
- 16fc38f: economic lot road scan bounded. Large-map load: econLots 2.46 s → 0.27 s.
- 5a2f7c8: navFor cached per def.
- 7e61df1: the anchor grid applies captures incrementally. Paired runs: −3 to −15 % ms/tick.

Every sim change gives an identical `simhash` to 30 min (medium and large, seeds 7 and 11).
npm test: 43 files green. Typecheck clean.

## Results
- Sim vs 2.2.1, paired runs, µs per unit-tick: before ×1.31, after ×1.17 (large ×1.08, medium ×1.24).
  The worst tick fell from 576 ms to 406 ms.
- Renderer: no change. 3.0 parts are < 0.3 ms per frame. Close view is 5.2–5.7 ms against a 4 ms
  target, but 2.2.1 measures 4.8 ms under the same machine load.
- Large map in the browser: 60 fps, but the worker reaches 6.2–7.3× instead of 8× (before: 4.5–6.7×).
- The quality governor steps 0 → 1 → 2 under a ×6 CPU throttle.

## Proposals
Infiltration hunter re-pathing (closeOn), the flow-field memory budget, and large-map load time.
See PERFORMANCE.md, "Open".
