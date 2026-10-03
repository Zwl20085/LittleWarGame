# Performance: budgets, tools and the 1.0 optimisation round

The game runs the deterministic simulation (20 Hz) in a Web Worker and renders on the main
thread. At 8× speed the worker must finish 160 ticks per second **and** build a snapshot for every
rendered frame; the main thread must apply that snapshot, update the instanced unit views and
render. Either side can make 8× "slow": the HUD shows the *simulation slow* badge when the worker
falls behind, and frames stutter when the renderer does.

## Budgets (per tick / per frame)

| Item | Budget | Why |
|---|---|---|
| Sim tick, mean, 500 units | ≤ 2.5 ms | 160 ticks/s at 8× = 400 ms/s = 40 % of one core, leaving headroom for a 2× slower laptop |
| Sim tick, p99 | ≤ 10 ms | a 3-tick batch must fit in one 16.7 ms frame |
| Snapshot make + apply | ≤ 1.5 ms combined | up to 60 snapshots/s |
| Renderer frame CPU (`renderer.frame`) | ≤ 8 ms at 1600×900, high quality | 60 fps with the HUD and audio on top |
| Scene objects / shadow casters | ~700 / ~350 | Three.js CPU cost is per object, not per triangle |

## Tools

All tools are deterministic in what they run (same seed → same war), so numbers differ only by
machine load. **Measure on a quiet machine**: other processes (test runs, builds) inflate the
p99/max by preempting the process, which shows up as "100 ms scavenges" in `--trace-gc`.

| Command | What it measures |
|---|---|
| `npx tsx scripts/perf.ts generated 600 7` | Headless 10-min war: ms/tick mean, p50/p90/p99/max, the 10 slowest ticks with their phase in the 1 s / 2 s schedules, flow-field builds/hits/evictions, stuck units, supply health |
| `node scripts/profile.mjs 600 7 [--no-inline] [--callers fn]` | V8 CPU profile of the same run: hottest functions by self and inclusive time; `--no-inline` attributes small helpers exactly; `--callers` shows who calls a hot leaf |
| `node scripts/perf-browser.mjs 7 420 15 8` | Real game in headless Edge (GPU on) at 8×: fps, frame p50/p95, `renderer.frame` breakdown (gl.render, units.sync, labels, arrows, counters, front paint…), snapshot apply cost, achieved speed vs requested; `QUALITY=low` forces a tier; `PERF_URL` points at a `vite preview` build so HMR reloads don't interrupt |
| `node scripts/perf-probe.mjs 7 300` | Toggles scene parts live (shadows, terrain, units, scatter, markers…) and times `WebGLRenderer.render` for each, plus a scene census (objects, meshes, shadow casters, instances) |

Workflow for a change: run `perf.ts` before and after (mean *and* p99), then `profile.mjs` to see
where the remaining time goes; for anything touching the renderer, `perf-browser.mjs` against a
static build (`npx vite build --outDir /tmp/dist && npx vite preview --outDir /tmp/dist --port 4174`).

## What the 1.0 round found and changed

Baseline (v0.5.0, seed 7, 10 min, ~450 units): **4.5 ms/tick**, 60.9 s CPU for the run. Profile
shares: path building 19 %, per-tick movement 25 %, spatial queries 5.5 %, front-line field 4 %,
combat + line of sight under 3 %.

| Change | Effect |
|---|---|
| Flow-field paths built in 40-cell (320 m) stretches (`pathPartial`), goal lattice 64 → 128 m, cache 96 → 128, one shared long-route grid for all foot units | `pathByField` self time 13 % → 2 %; field builds 3.6/s → 1.1/s; cache evictions 1 939 → 391 per 10 min |
| String pulling: skip the 1.5 m building pass on open ground, binary search instead of scanning every look-ahead point | part of the above |
| Movement: terrain speed factor sampled every 5 ticks, wall test once per waypoint, stuck test only when blocked, small detour window first (22 m, then 40 m) | movement self time 8.9 % → ~7 % |
| Terrain cover and height only recomputed when the unit moved; cover every 4 ticks; field-work garrison scan every 5 ticks | `coverAt`+`buildingH` 11 % (after the new wall-cover rule) → staggered |
| Front-line field update and per-faction front info spread over consecutive ticks instead of one 10 ms burst every 2 s | removes the periodic spike |
| Escort check reads a per-faction "trucks under fire" list instead of a 300 m friendly scan per unit every 0.4 s; idle coax MGs rescan every 0.5 s instead of every tick; `findOwner` early-exit queries for "any enemy near?" | spatial query self time 5.5 % → ~3 % |
| Flat `aliveUnits` array for the tick loops; projectile positions updated in place; note de-duplication without JSON | loop overhead and GC |
| Renderer: settlement markers as 4 instanced meshes (poles, cloth flags, rings, capture arcs with a per-instance fraction) instead of ~600 meshes; static matrices frozen; map label widths cached; arrow geometry rebuilt at most every 400 ms; objectives sent as flat arrays in snapshots | scene objects 1 242 → 671, shadow casters 632 → 346; `gl.render` at the overview 7.2 → 5.3 ms; snapshot apply 1.5 → 1.0 ms |
| Quality tiers (`src/render/quality.ts`): high / medium / low (shadow map 2048 / 1024 / off, pixel ratio 2 / 1.5 / 1, scatter and soldier shadows off below high); **auto** lowers one tier after 3 s of frames slower than 24 ms, with a 12 s cooldown, and tells the player | weaker GPUs keep the frame rate |

Result on the dev machine (Ryzen 7 3800X, idle machine, same seed and 10 game-minutes):

| | v0.5.0 | 1.0.0 |
|---|---|---|
| Units alive at 10 min | 448 | 345 (the new AI fights harder; fewer survive) |
| Mean tick | 3.4 ms | 2.0 ms (1.4 ms over the last minute) |
| Tick p50 / p90 / p99 | – | 1.2 / 4.0 / 11.9 ms |
| Cost per unit-tick | 7.6 µs | 5.8 µs |

The per-unit cost fell by about a quarter although the 1.0 gameplay added work per tick (building
cover rules, the battle-event log, concentration of force that keeps far more units marching). In
the browser (Edge, 1600×900, high quality) the worker holds 8.0× with 350–500 units and
`renderer.frame` averages 5–8 ms (`gl.render` 3–5 ms); snapshot apply is 1.0–1.2 ms.

## 1.1 round (no gameplay change)

| Change | Effect |
|---|---|
| Faction records in snapshots only every 4th snapshot (the HUD refreshes at 5 Hz); visibility sets and enemy memory only in fog mode and only for the observer | snapshot apply 1.06 → 0.54 ms |
| Every hot spatial query (target selection, blast, wipe morale, capture presence, supply, crowding, AP collision, observers) reuses a module-level result array | fewer short-lived arrays per tick |
| Front info skipped for eliminated factions | front-line pass shrinks as the war narrows |
| Map labels drawn from cached sprites (halo + fill rendered once per text/font/dpr) | labels 0.71 → 0.58 ms at the overview |
| Vegetation tiles 400 → 800 m, settlement tiles 600 → 900 m | scene objects 671 → 493, shadow casters 346 → 168; `gl.render` 4.0 → 3.7 ms overview, ~2.0 ms in battle views |

Browser at 8× (Edge, 1600×900, high quality, ~350 units): `renderer.frame` 6.2 ms overview, 3.5 ms
front, 3.4 ms close; 8.00× achieved in all views. Headless mean tick 1.6 ms at 330 units
(p50 0.9, p90 3.2, p99 10.7) with other work running on the machine.

## Where the remaining time goes

Headless, final tree, ~350 units: path building + flow-field expansion 12 % (units now march far
more), per-tick movement 7 %, tick loop + weapons 6.5 %, spatial queries 5 %, front field + chamfer
+ front info 10 % (spread over ticks), GC 3 %, combat and line of sight under 3 %. Main thread: `gl.render` is per-object overhead (≈ 650 objects,
the 2 048² shadow pass), labels 0.3–0.8 ms (canvas text), units.sync 0.5–0.8 ms.

Ideas not done yet, in order of payoff: hierarchical (16 m) long-haul flow fields; scratch arrays
for every spatial query call site (GC); text sprites for map labels; merging vegetation /
settlement tiles into fewer instanced meshes at the overview zoom.
