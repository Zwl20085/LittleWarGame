# Debug lab — anomaly detection (V30_SPEC §2)

The anomaly lab runs whole AI-vs-AI wars headless and flags states a player would call a bug:
tanks with no ammunition herding together, trucks that never deliver, units that never arrive.
The probe only reads the world, so a probed match is bit-identical to an unprobed one.

## How to run

```bash
# 4-FFA, seeds 7/11/13 on medium and large maps, 45 min each, 6 child processes
npx tsx scripts/lab30/anomaly.ts --seeds 7,11,13 --maps medium,large --minutes 45 --jobs 6 [--label name]

# "Before": point --src / --data at a frozen tree, so the same probe measures the old code
git archive <rev> src docs/data | tar -x -C media/base30
npx tsx scripts/lab30/anomaly.ts --src media/base30/src --data media/base30/docs/data --label base
```

The report goes to `media/stats/lab30/anomaly-<label|timestamp>.{md,json}`. The runner helpers in
`scripts/lab30/common.ts` (match from a source tree, stepping, child jobs, report writer) are shared
by the other lab30 suites. Classifier tests: `tests/anomaly.test.ts` (one synthetic world per class).

## Anomaly classes (checked every 30 s window)

| class | condition | thresholds (`ANOMALY` in anomalyProbe.ts) |
|---|---|---|
| `ammo_starved` | ≥ 5 combat units of one faction within 120 m, median ammo < 15 %, half of them have received no ammunition for > 90 s, and an enemy within 400 m or a target assigned | `starved` |
| `supply_chain` | an owned place's stock < 0.5 for > 2 min while ≥ 2 own units below 50 % ammo stand in its draw radius | `supplyChain` |
| `idle_herd` | ≥ 8 units idle > 3 min (still, no target, not fired 30 s, not rearming or garrisoned) within 150 m, > 400 m from every own front line point and every enemy | `idle` |
| `stuck` | a path, no target, not moved 4 m for 60 s (the soak.ts / stuck.ts rule) | `stuck` |
| `convoy_loop` | a truck that has handed over nothing for 5 min (a full truck parked at its depot for lack of demand is not counted) | `convoy` |
| `phantom_front` | a front with a living commander and < 3 units for > 3 min | `phantom` |
| `unreachable` | ≥ 3 path failures for the same goal cell (25 m), or failing for > 60 s | `unreachable` |

"Receiving no ammunition" is measured from the ammo value, not the `rearming` flag: a unit that is
"rearming" on a long walk for minutes is still starved.

Each record has tick, faction, position, unit ids, severity and a root-cause guess (anomalyCauses.ts):
*cannot fire, above rearm_below*, *rearm search failed*, *path blocked*, *out of supply range*,
*town stock empty*, *crowd cap*, *no trucks*, *convoy destination elsewhere*, *no truck assigned*,
*truck stops short of the group*, *in contact (no draw while fighting)*, *above rearm_below*.

## Reading a report

- **Episodes per run**: consecutive windows of one object (unit, place, front) or one cluster
  (same class and faction within 250 m) form an episode. This is the headline count.
- **Totals per class**: episodes, high-severity episodes, flagged windows, unit-windows (units
  flagged, summed over windows: how much of the army was affected for how long), top causes.
- **Ammunition**: share of combat-unit and tank samples below 0.15 ammo, and tanks in the rearm
  dead zone (cannot fire a shell, above rearm_below).
- **Worst 10 episodes**: ranked by severity × duration × √size, each with a timeline (position,
  size, cause and detail per window). Unit ids let you find the units in a diagnostic run.

## Root cause of the ammo-starved tank herd (fixed in 3.0)

Trucks delivered almost nothing. In seed 7, about 70 trucks handed over about 150 cargo in 25
minutes. The supply point sat 110 m behind the line centre, but a truck flees any enemy within
130 m. Trucks near a moving front turned back, drove to the depot full and went out again. Only
units below 0.08 ammo and within 300 m of a truck ever walked to one. Every other unit walked to a
stock up to 2.2 km away. A tank block or spearhead away from the line centre walked 500–1200 m,
often through enemy ground and at 0.7 speed when empty. It arrived as a herd at an empty town, or
never arrived. A heavy tank's shell (0.1) also costs more than `rearm_below` (0.08), so a heavy
tank with 0.09 could neither fire nor rearm.

Fix (convoy.ts, settlements.ts; numbers in `rules.json` `logistics.truck_*`, 0 = off for A/B):
- `truck_meet_below 0.3`: a loaded truck stops and hands over where it meets own units below 0.3,
  away from a stock.
- `truck_fallback_m 160`: a threatened loaded truck falls back 160 m and hands over there, instead
  of driving home full.
- Trucks aim at the centre of their front's units that are short of ammunition.
- `truck_unload_wait_s 30`: an unloading truck waits 30 s for takers (was 12 s).
- `truck_meet_seek_m 900`: a rearming unit walks to a loaded convoy on its way if the convoy is
  nearer than its stock.
- A unit out of the fight below 0.3 tops up at an unloading truck within 300 m.
- A unit that cannot fire one round counts as empty.

### Before / after (45 min, 4-FFA, seeds 7/11/13 × medium/large, episodes)

| class | before (bd00fdc) | after |
|---|---:|---:|
| ammo_starved | 156 (132 high, 2745 unit-windows) | 106 (90 high, 1380 unit-windows) |
| supply_chain | 16 | 25 |
| idle_herd | 0 | 0 |
| stuck | 1 | 2 |
| convoy_loop | 749 | 676 |
| phantom_front | 2 | 2 |
| unreachable | 2 | 2 |
| tank samples with ammo < 0.15 | 20.2 % | 15.4 % |
| … and receiving nothing | 3.9 % | 2.3 % |

war22 supply metrics (seeds 7/11/13, 45 min): main-effort units below 0.3 ammo 14 % → 11 %;
firing units below 0.3 ammo 34 % → 33 %; supply trucks lost 205 → 136.

Open items:
- `convoy_loop` is still high. Most trucks reach their point and find no takers, because most
  units are above 0.3 ammo.
- `supply_chain` rose slightly. Stocks run dry in the large-map cities now that more units draw
  near them.
