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

## 2.0 round (command hierarchy, structures, challenge lab)

2.0 added a theatre planner (every 5 s per AI faction), dynamic fronts with commander units,
pillbox / bunker construction and garrison checks, fortification planners, order lines and the
new effects. Profiled on the 2.0 tree (`node scripts/profile.mjs 600 7 --no-inline`, seed 7,
10 game-minutes, ~390 units): the new systems are each under 1 % of sim CPU (theatre planner,
`seekGarrison`, fort plans). The hot set is unchanged — flow-field settle 10 %, movement 6 %,
spatial queries + rebuild 5.5 %, the front field and its distance transform 7.4 % combined,
terrain height sampling 3 %. Two new leaves appeared behind the line planners:
`crossesWater` / `defensivePosition` (1.5 %) and recon cover searches (3.8 % inclusive).

| Change | Effect |
|---|---|
| Enemy-distance transform (`frontai.ts`) on a 32 m grid instead of the 16 m field; the front cells stay at 16 m; the two full-grid passes are one pass | `chamfer` 2.8 % → 0.8 % of sim CPU |
| `defensivePosition` results cached 20 s per anchor cell / bearing step / radius (terrain is static apart from pontoons) | `crossesWater` / `defensivePosition` leave the top 30 |
| Recon cover spot reuses the line-slot cover cache (recomputed only when the post moves > 8 m) | recon think 3.8 % → under 1 % inclusive |
| `World.fortById`: per-tick id → fort index for hit resolution, garrison checks and builders (they scanned the fort list linearly; 100+ works late in a war) | removes an O(forts) scan per hit |
| Convoy truck list no longer copies/filters per truck think | fewer short-lived arrays |

Paired run on the same machine, same seed, back to back (`scripts/perf.ts generated 600 7`,
other work running):

| | 2.0 foundation (before the new systems) | 2.0 head (all systems + this round) |
|---|---|---|
| Units at 10 min | 398 | 391 |
| Mean tick | 1.5 ms | 1.4 ms |
| p50 / p90 / p99 | 0.8 / 2.8 / 10.7 ms | 0.7 / 2.6 / 11.1 ms |

So the whole 2.0 feature set costs nothing net per tick. Browser (headless Edge, 1600×900, high
quality, static build, `perf-browser.mjs 7 300 15 8`): see the table below (filled from the
release run); the visuals agent measured `renderer.frame` 4.8 ms at the overview and 3.3–3.5 ms
in battle views with 8.00× achieved.

| View (8× requested, ~380–420 units) | fps | `renderer.frame` avg / p95 | `gl.render` | snapshot apply | achieved speed |
|---|---|---|---|---|---|
| overview | 59.6 | 5.1 / 8.1 ms | 2.6 ms | 0.43 ms × 852/s | 8.00× |
| front | 59.9 | 3.9 / 6.9 ms | 2.3 ms | 0.45 ms × 864/s | 7.99× |
| close | 59.6 | 4.7 / 8.2 ms | 2.2 ms | 0.68 ms × 813/s | 7.99× |

Measured while a 60-minute soak ran on the same machine. Lag frames 0 % in every view; the new
order lines, structures and effects together cost under 0.5 ms per frame (`forts` 0.09–0.20 ms,
`opArrows` 0.11–0.13 ms, `fx` 0.02–0.11 ms).

## 2.2 round (render agent)

Measured on the dev machine (Ryzen 7 3800X, RTX 2070 SUPER, headless Edge with the GPU on,
1600×900, high quality, static `vite build` + `vite preview`, generated 4-faction map, 8×
requested). Other agents were building and running soaks on the same machine during the round
(CPU load 40–97 %), so every before/after pair below was run back to back on the 2.1 build
(`83571b8`) and this branch; max frame times and fps are the load-sensitive numbers, the
per-frame CPU costs are steadier.

### Browser: before → after

Seed 7, 20 game-minutes (~440–460 units), `perf-browser.mjs 7 1200 15 8`:

| view | fps | frame p50 / p95 / max | `renderer.frame` avg / p95 | `gl.render` | snapshot apply |
|---|---|---|---|---|---|
| overview | 57.7 → **60.0** | 16.7 / 16.9 / 83.5 → 16.7 / 16.8 / 33.4 ms | 7.19 / 11.9 → **5.72 / 9.1** ms | 4.11 → **2.86** ms | 0.86 → **0.63** ms |
| front (z3) | 58.4 → **60.0** | 16.7 / 16.8 / 66.8 → 16.7 / 16.8 / 17.2 ms | 5.52 / 9.9 → **4.36 / 7.2** ms | 3.29 → **2.22** ms | 0.84 → **0.63** ms |
| close (z6) | 58.6 → **60.0** | 16.7 / 16.9 / 66.7 → 16.7 / 16.8 / 17.3 ms | 5.36 / 8.9 → **3.77 / 6.3** ms | 3.34 → **2.03** ms | 0.91 → **0.62** ms |

Seed 4242, 25 game-minutes (~405–427 units), `perf-browser.mjs 4242 1500 15 8`:

| view | fps | frame p95 / max | `renderer.frame` avg / p95 | `gl.render` | snapshot apply | achieved |
|---|---|---|---|---|---|---|
| overview | 56.8 → **60.0** | 18.7 / 66.6 → 16.8 / 17.1 ms | 7.61 / 12.9 → **5.44 / 8.4** ms | 4.54 → **2.76** ms | 1.03 → **0.70** ms | 7.92× → 7.99× |
| front | 58.4 → **60.0** | 16.9 / 66.5 → 16.8 / 17.0 ms | 5.75 / 9.7 → **4.66 / 7.7** ms | 3.51 → **2.36** ms | 0.89 → **0.74** ms | 7.99× → 8.00× |
| close | 59.7 → **60.0** | 16.8 / 49.9 → 16.8 / 17.1 ms | 4.80 / 9.0 → **4.12 / 7.1** ms | 2.78 → **2.04** ms | 0.83 → **0.70** ms | 8.01× → 8.00× |

The 2.1 build dropped a frame every second or so (the 33–83 ms maxima) and 1–3 fps on average;
the 2.2 build holds vsync in every view with no frame over 17.3 ms in these runs (one 33 ms
frame at the overview in one run). Draw calls are unchanged (65–151); the gain is CPU per
frame and the removal of the stalls.

### What was found (profile first)

New tool: `node scripts/profile-browser.mjs [seed] [ff] [seconds] [speed] [view]` — DevTools
CPU profile of the running game's main thread (self / inclusive time per function;
`CALLERS=fn` prints the stacks into a hot function). Build with `vite build --minify false` for
readable names. `scripts/review-shots.mjs <url> <outDir> [seed] [ff]` takes the fixed visual
review set used below.

| Finding (2.1) | Cost | Fix |
|---|---|---|
| Overlay route lines rebuilt every 250 ms disposed their `LineDashedMaterial`s; the program was released with the last user and **relinked synchronously** on the next rebuild (`getProgramInfoLog` waits for the driver) | ~4 shader links/s, 12 ms/s of stalls, the 33–83 ms frames | materials cached per colour / style, only geometry rebuilt |
| Minimap redrew the control field with one `fillRect` + `fillStyle` per 10 m cell at every HUD refresh (5 Hz) | ~10–12 ms per refresh (61 ms/s) | field painted once per field version into a cell-sized image, drawn scaled |
| HUD read `offsetHeight` of two panels right after their DOM writes every refresh | forced layout, ~1.5 ms per refresh | `ResizeObserver` keeps the CSS variables |
| Territory wash: canvas `blur(6px)` of the field onto a 2.5 m canvas (1 456² on a 3.6 km map) at every field update | ~15 ms per update, 4/s at 8× | one texel per cell, premultiplied, softened by 5 bilinear taps in the terrain shader |
| Shell instance buffer (2 000 × 64 B) uploaded in full every frame; craters' 1 200-instance buffer in full for every new crater; shock rings likewise | 128 kB/frame + 77 kB per crater | upload only the live range / the changed slot |
| Empty `InstancedMesh`es (unit kinds not on the map, wreck and garrison variants, idle particle pools) still went through `setProgram`, uniform upload and VAO setup in the colour **and** shadow pass | ~100 empty batches per pass | batches, particle pools and trail meshes are hidden while empty |
| Scene root (and container groups) recomposed their matrix every frame, which flagged the whole tree dirty and forced a world-matrix multiply for ~540 objects | ~0.5 ms/frame | root, container groups and instanced batches are frozen (`matrixAutoUpdate = false`); moving objects still update |
| Snapshots cloned all works (70–100 records, 0.30 ms per snapshot to clone) and all supply nodes (0.16 ms) every snapshot, up to 60/s | ~0.45 ms per snapshot on each thread | works every other snapshot (and whenever works are added / removed), supply nodes with the faction records (every 4th) |
| `SimHost.fastForward` resolved on any snapshot, so a queued advance batch (or the initial snapshot) ended a fast-forward while the worker was still running it | perf harnesses intermittently measured a frozen game (0× achieved, 228 units) | a fast-forward resolves on its own (`ff`-tagged) reply |

Auto quality now starts at a tier guessed from the WebGL renderer string and core count
(software rasterisers → low; integrated GPUs or ≤ 4 cores → medium; otherwise high) instead
of always starting high and stuttering for 3 s on weak machines; it still steps down on slow
frames. The new procedural ground texture is part of the profile (`groundDetail`, off on low).

### Simulation

No change to `step()` — results are identical (determinism test green). Headless
`perf.ts generated 1500 <seed>` on this branch, during the same machine load:

| seed | units at 25 min | mean tick | p50 / p90 / p99 / max |
|---|---|---|---|
| 7 | 453 | 3.0 ms | 1.9 / 5.9 / 22.1 / 163 ms |
| 4242 | 431 | 2.5 ms | 1.7 / 5.0 / 14.5 / 134 ms |

(An earlier seed-7 run at ~90 % machine load gave 6.9 ms mean with the identical end state —
453 units, 24 trucks lost, 40 raids — which also confirms the run is deterministic.)

The worker holds 8× with ~450 units at 20–25 minutes in the browser runs above. A spike
attribution from the CPU profile (`profile.mjs`) was not reliable under the machine load
(descheduled samples inflate single calls); the hot set is unchanged from 2.0 (movement and
flow-field paths ~25 %, spatial queries ~10 %, AI think ~25 % inclusive). The AI and economy
code is being rewritten by the 2.2 sim agents, so no sim hot spot was touched in this round.

Remaining ideas: map labels and unit counters redraw the 2D overlay canvas every frame
(0.3–0.6 ms at the overview); the standing order ribbons keep a 45 % minimum width at close
zoom (a 60 px band at z6 — belongs with the command rework).

## 3.0 round (WP-M)

Dev machine as before, but **fully loaded** for the whole round: 100 % CPU, ~55 node processes from
other agents' soaks and labs. Every comparison below was therefore run side by side (both trees at
once, same seeds). Single numbers swing ±20–40 % between runs, so only the paired ratios carry much
weight. Behaviour was held fixed with `scripts/simhash.ts` (a state hash every minute to 30 min,
medium and large maps, seeds 7 and 11). Every change had to keep it identical.

### New tools

| Command | What it does |
|---|---|
| `SIZE=large npx tsx scripts/perf.ts generated 2400 7` | as before, plus the large map, a window mean from the tick sums and µs per unit-tick |
| `node scripts/profile.mjs 1800 7 --no-inline --dir d`, then `--dir d --reuse --callers fn` | module names in the report; keeps the profile so it can be re-analysed without running the war again |
| `SIZE=large npx tsx scripts/spike.ts 7 10060,26907` | replays the deterministic war and profiles only the listed slow ticks (`SPIKE_MS=60` lists them) |
| `SIZE=large npx tsx scripts/snapsize.ts 2400 7 600` | structured-clone size of the worker snapshot per field, plus make / serialize ms |
| `SIZE=large npx tsx scripts/simhash.ts 1800 7` | per-minute state hash (the behaviour check for perf work) |
| `SIZE=large GOVERNOR=6 node scripts/perf-browser.mjs …` | large map; the quality tier in every line; GOVERNOR runs auto quality under a CDP CPU throttle; the 3.0 render parts (rails, day, orderLines, …) are timed |

### Simulation: 2.2.1 vs 3.0 (4 AI, 8 runs at once per round)

Window mean ms/tick (and µs per unit-tick) at 10 / 20 / 30 / 40 game-minutes.

Round 1: `feat/v3.0` fd3a892 (before this round) vs `main` 2.2.1.

| map, seed | 2.2.1 | 3.0 before |
|---|---|---|
| medium 7 | 4.5 / 4.7 / 3.7 / 3.6 ms (12.5 / 11.7 / 8.6 / 9.1 µs), 400 units at 40 min | 4.8 / 5.3 / 7.4 / 6.0 ms (12.5 / 12.2 / 14.6 / 11.5 µs), 523 units |
| medium 11 | 4.6 / 4.9 / 4.5 / 3.3 (13.0 / 11.3 / 8.6 / 7.4), 453 | 5.3 / 5.1 / 8.9 / 7.2 (13.9 / 11.3 / 15.5 / 11.8), 611 |
| large 7 | 3.0 / 5.8 / 6.3 / 5.2 (7.6 / 11.5 / 9.5 / 7.9), 658 | 4.9 / 6.9 / 9.2 / 13.2 (11.9 / 12.9 / 13.1 / 15.6), 843 |
| large 11 | 2.8 / 7.0 / 7.3 / 9.6 (7.1 / 13.8 / 10.2 / 13.1), 735 | 4.4 / 7.6 / 7.9 / 15.3 (10.7 / 14.0 / 12.9 / 19.7), 776 |
| mean µs/unit-tick | 10.2 | 13.4 (**×1.31**) |
| p99 / max (worst run) | 30 / 355 ms | 49 / 576 ms |

Round 2: this branch (after the WP-REV merge and the changes below) vs 2.2.1.

| map, seed | 2.2.1 | 3.0 after |
|---|---|---|
| medium 7 | 5.9 / 5.9 / 4.7 / 4.0 ms (16.4 / 14.8 / 10.9 / 9.9 µs), 400 units | 6.9 / 8.2 / 6.9 / 8.7 (17.9 / 19.3 / 14.1 / 15.3), 570 |
| medium 11 | 7.1 / 6.4 / 6.4 / 6.5 (20.0 / 15.0 / 12.1 / 14.4), 453 | 8.8 / 6.1 / 12.6 / 9.1 (22.7 / 13.7 / 23.8 / 14.7), 616 |
| large 7 | 6.8 / 6.4 / 9.3 / 4.7 (17.3 / 12.7 / 14.2 / 7.2), 658 | 5.0 / 9.5 / 7.4 / 9.9 (12.1 / 18.0 / 11.0 / 12.0), 822 |
| large 11 | 4.5 / 7.4 / 11.6 / 6.4 (11.5 / 14.6 / 16.2 / 8.7), 735 | 4.9 / 10.6 / 6.7 / 13.6 (12.1 / 20.2 / 10.0 / 16.6), 822 |
| mean µs/unit-tick | 13.5 | 15.8 (**×1.17**; medium ×1.24, large ×1.08) |
| p99 / max (worst run) | 60 / 578 ms | 68 / 406 ms |

Cost per unit is not linear (spatial queries grow with density), and 3.0 armies are 25–40 % larger
at 40 min, so ×1.17 is an upper bound at equal unit counts. The spec target (≤ ×1.2) is met on the
large map. On the medium map it is borderline, within this machine's run-to-run noise.

### What the profile showed (large map, seed 7, 30 min, `--no-inline`)

What 3.0 added over 2.2.1, as inclusive share of sim CPU:

- Infiltration ≈ 12 %: rear reports 5 %, the anchor scan inside them 2.9 %, and hunters re-pathing
  toward moving intruders 5.9 %.
- Extra flow-field settling 5 %: the 3.0 wheeled-truck grid and the chase goals (2.1 field builds/s
  vs 1.45).
- Convoy think +1.6 %, rail and zone-of-control hooks ≈ 2 %, match load +1.8 %.

The WP-REV anchor grid then cost 7 % on its own, because it was rebuilt in full on every capture.
After this round, infiltration is ≈ 5 %.

The worst single ticks were lazy nav-grid builds. The first heavy tank (or crew, wheeled truck, …)
of a match built its movement class's grid inside the tick: 0.3 s per class, 1.6 s under the
profiler at tick 10060.

### Changes (each one behaviour-identical, checked with simhash)

| Commit | Change | Effect |
|---|---|---|
| `perf(sim): share class-independent terrain samples between nav grids` | ground, slope, building raster and ford banks per 8 m cell are sampled once per terrain and refreshed with `refreshArea` | lazy grid build on the large map: 230–370 → 50–140 ms per class |
| `perf(sim): economic lot search scans only the roads that can be nearest` | road segments sorted by distance from the town; the scan stops by the triangle inequality; slope test first | match load (large) econLots 2 464 → 272 ms; lots identical (sha1 of every slotPos) |
| `perf(sim): resolve a unit type's nav grid once` | `navFor` cached per def (it re-derived the wheeled class from the transport rules on every call) | navFor + wheeledNav + moveClassOf were 2 % inclusive |
| `perf(sim): anchor grid applies settlement captures incrementally` | a capture lowers the new holder's cells and rescans only the old holder's cells whose minimum was that town; full build only when a faction falls | mean ms/tick over 30 min, side by side: medium 6.18 → 5.98 / 6.76 → 5.74, large 8.40 → 7.77 / 8.74 → 8.04 |

Tried and dropped: a typed-array bucket queue for the flow-field Dijkstra, and a modulo-free ring
index. Neither gained anything, because the settle loop is memory-bound.

### Snapshots (worker → main), `snapsize.ts`, seed 7

| | 10 min | 20 min | 30 min | 40 min |
|---|---|---|---|---|
| 2.2.1 medium | 103 kB | 120 kB | 137 kB | 138 kB (400 units) |
| 3.0 medium | 116 kB | 131 kB | 159 kB | 178 kB (523 units) |
| 2.2.1 large | 110 kB | 144 kB | 189 kB | 218 kB (658 units) |
| 3.0 large | 121 kB | 158 kB | 208 kB | 262 kB (843 units) |

The per-unit record is the same size (34 float64; `upg` was added). 80 % of the bytes are the unit
buffer, which is transferred, not cloned. The cloned part at 40 min (large map): works 26 kB,
faction records 23 kB (every 4th snapshot), economic buildings 9.5 kB, transport and zones under
1 kB. The growth comes from more units and works, not from the 3.0 records. `makeSnapshot` takes
1.4–2.1 ms at 700–840 units on the loaded machine; the cost is memory-bound unit reads.

### Renderer (headless Edge, RTX 2070 SUPER, 1600×900, high, static build, 8×, seed 7, 20 min)

| view | 2.2.1 (paired) | 3.0 (paired) | 3.0 after (other runs) | target |
|---|---|---|---|---|
| overview | 6.75 ms | 7.94 ms | 5.74–7.26 ms | ≤ 6 |
| front | 5.23 | 5.46 | 4.68–5.59 | — |
| close | 4.82 | 5.42 | 5.17–5.69 | ≤ 4 |
| close-low (blur off by default) | 5.60 | 5.10 | 5.05–6.25 | — |

Values are the `renderer.frame` average. Every medium-map run held 60 fps with 0 % lag frames.

- The 3.0 render parts are small: rails/trains 0.01–0.03 ms, time of day 0.04–0.07 ms, order
  ribbons 0.10–0.19 ms. Draw calls are 93–183 (2.2.1: 86–162).
- Under this load 2.2.1 misses the close target too. gl.render is 2.5–3.3 ms, a quarter of it the
  shadow pass; units.sync 0.7 ms, works 0.3–0.5 ms, map labels 0.3–0.7 ms at the overview.
- No renderer change in this round. The ideas left from 2.2 still apply: label / counter canvas
  redraw, and the field-works rebuild on every progress step.

Large map in the browser (20 min, 550–650 units): 60 fps in every view, but the **worker** does
not hold 8×. 3.0 before: 4.5–6.7×; after: 6.2–7.3×; 2.2.1 on the same map: 6.9–8.0×.

Quality governor (auto, large map, CDP CPU throttle ×6): tier 0 → 1 after ~14 s of slow frames,
then 1 → 2 after the 12 s cooldown. It still steps down with the 3.0 meshes.

### Open (proposals)

1. Infiltration hunters (`closeOn`) re-path toward a moving intruder snapped to a 50 m lattice, so
   a long chase builds new flow fields again and again: 2–6 % of sim CPU, and the 100–500 ms ticks
   late in a large-map war. Proposal: aim far chases at the report position on the 128 m field
   lattice, and hold the route while the target stays within ~150 m of it. This changes behaviour,
   so it needs the infiltration lab.
2. Flow-field memory: each grid caches 128 fields, ≈ 180 MB per class on the large map and
   ~700 MB of array buffers across the six classes. 53 % of builds re-create an evicted field. A
   shared budget across classes, or coarser long-haul fields, would cut both memory and builds.
3. Map load on the large map takes 11–16 s here (`generateMap` 5 s, terrain 2.3 s).
