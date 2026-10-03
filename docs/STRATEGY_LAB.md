# Strategy lab — battle events, strategy choice, analysis

User request: *"make a mechanism for the battle event, strategy choice, analysis, and try to base on
this improve the AI."* This document covers the recording mechanism, the offline analysis and the
AI changes that came out of it, with before/after numbers.

## 1. What is recorded (`src/sim/events.ts`)

`World.battle` is a write-only battle-event log. The AI never reads it and it uses no RNG, so a
match plays out the same with or without it (see `tests/determinism.test.ts`, `tests/events.test.ts`).
Every array is capped at 4 000 records, and the oldest records are dropped first.

| record | when | fields |
|---|---|---|
| `OpRecord` | an army group picks a new operation (`doctrine.runOperation`) | op kind, doctrine (faction personality), posture, locked, target (objective / `hq:<f>`), target kind and owner, group value `mine`, known enemy value within 260 m of the target `theirs`, `ratio`, units, terrain context on the way (`river` / `pass` crossing, `town` assault, `open`), distance; closed with `t1`, `outcome`, value and units the group lost, phases reached (`form>assault`, `dig>assault`, …) |
| op outcome | `endOp` / re-plan / reset | `won` (target captured while the op ran) · `abort` (adaptive: hopeless assault called off) · `spent` (manoeuvre group < 30 %) · `timeout` · `noForce` (could not find its troops) · `unreachable` (siege ring) · `retarget` · `rethink` (frontal re-plan after 75 s) · `reset` (home defence) · `open` (still running when the run ended) |
| `DirectiveRecord` | high command issues a new garrison (`defend`), occupation detachment (`occupy`), or a new top `attack` target | units and value committed, owner at issue; resolved as `captured` / `held` / `lost` / `expired` (defend and occupy after 300 s, attack after 600 s) |
| `EngagementRecord` | hostile damage is clustered by area: the settlement whose radius + 150 m covers the victim (precomputed 50 m grid, O(1) per hit), or else a 400 m field cell | holder at start, per-side value / HP lost, kills, HP dealt, peak value present (sampled every 5 s); closed after 30 s of quiet or on capture; outcome `captured` / `repulsed` (holder kept it) / `stalemate` / `won` (field or neutral place, at least 2:1 losses). Fights under 60 HP total count as skirmishes and are not stored. |
| `CaptureRecord` | a settlement changes hands (`capture.updateObjective`) | from, to, kind, linked engagement |
| `BattleSample` | every 10 s | per faction: units, stuck (has a path, moved < 3 m, not fighting), idle, fighting, army-group modes and reasons |

There are four hooks into existing systems. They only add calls and change no existing behaviour:
`applyDamage → noteHit` (damage.ts), `updateObjective → noteCapture` (capture.ts),
`step → battleSecond` once per game second (sim.ts), and the op and directive calls in doctrine.ts,
command.ts and sectors.ts. `world.battle.enabled = false` turns the hot hooks off, which is how the
overhead was measured.

## 2. Running the analysis (`scripts/strategy.ts`)

```
npx tsx scripts/strategy.ts --seeds 7,11,13 --minutes 20            # adaptive AI (the game's)
npx tsx scripts/strategy.ts --seeds 7,11,13 --minutes 20 --baseline # adaptive layer off
npx tsx scripts/strategy.ts --seeds 7,11,13,17,23,29,31,37 --minutes 20 --jobs 8 --compare   # A/B + before/after table
```

- Each match runs in its own child process (`--jobs`, default min(4, seeds)). The script writes raw
  JSON to `media/stats/strategy-runs/` and the report to `media/stats/strategy-<timestamp>.md`.
- By default the four doctrines (balanced, armor, infantry, mechanized) are **rotated across map
  slots** by seed index, so a strong start position is not mistaken for a strong doctrine.
  `--no-rotate` turns the rotation off.
- The report contains:
  - ops by kind × doctrine, by force-ratio bucket, by ratio × kind, by terrain and by target kind:
    count, success, mean duration, **captures per group-minute**, loss ratio (enemy ÷ own, joined
    with the engagements at the target while the op ran);
  - the op outcome mix (wasted ops);
  - engagements by kind and outcome, and held settlements by peak attacker ÷ holder ratio;
  - directive follow-through;
  - per doctrine: lead rate, settlements held, captures per 100 units lost, captures per op,
    stuck / idle / fighting share and hold-mode share;
  - army-group reasons.
- `scripts/strategy/perfab.ts [secs] [seed] on|off` measures ms/tick with the log and the adaptive
  layer on or off.

`STRATEGY_AI.adaptive` (in `src/sim/strategyai.ts`) exists only so the lab can A/B the same code.
The game always runs with it on.

## 3. Findings (baseline, 6 seeds × 20 min, then 8 seeds rotated)

1. **Wasted ops: 23–29 % of all operations ended `noForce`**, launched without the troops to carry
   them out. Most of these came from **pincer churn**. `planPincer` turned both wings into a pincer
   whenever each wing had ≥ 3 mobile units, even when those units were busy (garrison, raid, op
   roles). `launch` then failed, the wing fell back to frontal, and 2 s later it was turned back
   into a pincer. The infantry doctrine ran 173 pincers with a mean duration of 22 s and 25 %
   success. Flank ops had the same problem (56 `noForce`).
2. **Frontal attacks are the least productive op**: 0.17–0.19 captures per group-minute and 18–22 %
   success. Pincers manage 0.53, flanks 0.29–0.31 and infiltration 0.21–0.26. Most targets are
   lightly held: 50–60 % of ops face < 50 known enemy value at the target, so a direct push into
   the defended front is the worst use of the group.
3. **Failed assaults are expensive.** `timeout` and `spent` ops cost about 950–1 250 value each, for
   6.5–8.9 k value per match with nothing captured.
4. **Sieges are rare (4–9 per 6–8 matches) and almost never won** (0–1 won), because they were
   launched exactly when the defenders were strong compared with the group.
5. **Occupation detachments expire.** 31–33 % of occupy directives ran out of their fixed 240 s
   before arriving, because the HQ picked the most valuable place rather than the nearest.
6. **Held settlements attacked with less than half the holder's value** (504 of 842 engagements)
   are repulsed 93 % of the time. Captures need about 1:1 at the point of contact: 31 % at 0.5–1,
   43 % at 1–2.
7. **Fights stall.** Army groups spend about 50 % of their time in `hold` mode and only 7–8 % of
   units are fighting in any 10 s sample. Stuck units are under 1 %, so pathing is not the cause.
   The holding comes from the front-push threshold (local ratio > 1.4).
8. **Terrain**: ops through a mountain pass succeed 13–18 % of the time, against 45–74 % in open
   ground. River crossings sit in between (37–53 %).
9. **Doctrines are already viable**: with rotation, the top lead rate is 37.5 % (no doctrine above
   50 %).

## 4. AI changes (`src/sim/strategyai.ts` constants, used under `adaptive()`)

| change | where | evidence |
|---|---|---|
| Only pick **launchable** ops: flank needs ≥ `minManeuver` free manoeuvre troops, infiltration ≥ 3 healthy infiltrators | `doctrine.ts` `chooseOperation` (`maneuverPool`, `infiltrationPool`) | finding 1 |
| **Pincer gate**: both wings must have free manoeuvre troops, and a pincer that failed to form is not retried for 90 s | `doctrine.ts` `planPincer`, `launch` | finding 1 |
| **Frontal penalty** (−0.45 score) when the target's defenders are < 25 % of the group, so a manoeuvre is preferred | `doctrine.ts` `chooseOperation` | finding 2 |
| **Abort hopeless assaults**: after 45 s in the assault, if the group is down to < 60 % of its start value and the defenders outweigh what is left by 1.2×, call it off (`abort`) | `doctrine.ts` `hopeless` (flank, pincer, infiltrate) | finding 3 |
| **No siege without numbers**: group value must be ≥ 1.5× the defenders | `doctrine.ts` `siegeWorthy` | finding 4 |
| **Occupy nearest first**: occupy directives are ranked by value ÷ (1 + distance from the nearest free detachment / 600 m), and the march time is 120 s + 0.28 s/m instead of a fixed 240 s | `command.ts` `byReach`, `assignOccupations` | finding 5 |
| **Occupy undefended enemy villages and points** (no known enemy within 340 m) with a detachment instead of waiting for an army group | `command.ts` `thinkHighCommand` | findings 5, 6 |
| **Exploit routs**: routed or pinned enemies count at 0.35 weight when a group decides whether to push its front | `sectors.ts` `fightingEnemyStrength` | finding 7 |
| *Rejected:* push threshold 1.4 → 1.2 | `ADAPT.pushRatio` stays 1.4 | 8 seeds: +15 units lost per match, and captures per 100 lost rose only +2 (+10 without it) |

Unit-behaviour constants (`behavior.ts`: cautious engage distance of 0.8 × range, cover search)
were **not changed**. Stuck and idle shares are about 1 %, and the stall comes from the group-level
hold decision (finding 7). The one experiment on that decision made losses worse.

## 5. Before / after (8 seeds × 20 min, doctrines rotated, same code with `--baseline` vs adaptive)

`npx tsx scripts/strategy.ts --seeds 7,11,13,17,23,29,31,37 --minutes 20 --jobs 8 --compare`

| metric | baseline | adaptive | Δ |
|---|---|---|---|
| ops (closed) | 1200 | 982 | −218 |
| op success rate % | 41.8 | 58.2 | +16.4 |
| wasted ops % (noForce / unreachable / timeout / spent / abort) | 28.7 | 18.3 | −10.3 |
| value lost in failed (timeout / spent) ops per match (k) | 8.9 | 4.5 | −4.5 |
| captures per match | 116.8 | 137.1 | **+20.4 (+17 %)** |
| captures per 100 units lost | 48.6 | 59.7 | **+11.1 (+23 %)** |
| units lost per match | 240.4 | 229.6 | −10.8 |
| occupy directives → captured % | 52.9 | 61.9 | +9.0 |
| stuck / idle / fighting share % | 1.0 / 0.6 / 7.8 | 1.0 / 0.7 / 7.5 | ≈ |
| max doctrine lead rate % | 37.5 | 37.5 | 0 |

Ops by kind (success · captures per group-minute):

| op | baseline | adaptive |
|---|---|---|
| flank | 54 % · 0.29 | 81 % · 0.35 |
| frontal | 18 % · 0.17 (320 ops) | 11 % · 0.09 (179 ops) |
| infiltrate | 43 % · 0.21 | 67 % · 0.33 |
| pincer | 51 % · 0.54 (437 ops) | 52 % · 0.49 (266 ops) |
| siege | 0 % (9) | 20 % (5) |

Per doctrine (lead rate, captures per 100 lost), baseline → adaptive: armor 38 %, 42 → 13 %, 59 ·
balanced 25 %, 54 → 38 %, 67 · infantry 13 %, 49 → 38 %, 63 · mechanized 25 %, 50 → 13 %, 51.
None goes above 50 %. The lead rates move between runs because 8 matches give 2 leads per doctrine
on average, so a lead rate is noise at ±1 match. Captures per 100 lost improved for all four
doctrines.

Earlier 6-seed A/B (without rotation): captures +17 per match, captures per 100 lost 55.4 → 65.6,
wasted ops 23.3 → 11.1 %, occupy follow-through 54.9 → 63.0 %.

## 6. Performance

The battle log costs one grid lookup and a few additions per damage event, plus one pass over the
units every 10 s. The adaptive layer adds O(group) work only when an op is chosen or a pincer is
considered. Measured with `npx tsx scripts/strategy/perfab.ts 300 7 on|off` (generated map, seed 7,
300 s). Five runs each on a shared, busy machine gave: **on**: min 2.50, median 3.30 ms/tick;
**off**: min 2.68, median 3.08 ms/tick. That is within the noise, with no measurable regression.
`scripts/perf.ts generated 300 7`: 3.2 ms/tick with everything on.

## 7. Open issues

- `noForce` is still 10 % of ops, mostly pincers formed when a wing loses its free troops between
  the gate and `launch` (same think), and infiltration when the healthy pool shrinks.
- Ops through **passes** succeed only 13–18 % of the time. A pass penalty in `sectors.nextTarget`
  (like the existing river penalty) is the obvious next step.
- **Defend directives** lose the place 29–39 % of the time. With more occupation on both sides,
  garrisons now see more pressure. Garrison sizing (`HQ.overmatch`) could be tuned next.
- **Frontal** ops are now the fallback when no manoeuvre is possible, so their per-op success fell.
  They are still the least productive op. A "hold and wait for reinforcements" alternative could
  replace frontal pushes at a low ratio.
- The force ratio at launch is mostly ≥ 4 or unopposed, because targets are judged by defenders
  within 260 m. The ratio at the **front anchor** would be a better predictor and is the next field
  to record.
- No match ended inside 20 min (eliminations = 0), so lead rate uses the settlements held at the end.

## Round 2: eagerness and engagement

Goal (user): "during the fight, always full troop, so resource becomes meaningless" and "the
commander should be more eager for the territory". Follow-up from the soak test: wars should end
by capital capture within 30–45 min. All new behaviour is in `EAGER` (`src/sim/strategyai.ts`) and
gated by `eagerOn()` (`STRATEGY_AI.eager`, only active with `adaptive`). The A/B below compares the
same frozen source tree with `eager: true` vs `eager: false`, so the work other agents did at the
same time is identical on both sides.

### Root causes found

Diagnostics came from `media/r2/diag.ts` and `media/r2/trace.ts`, which are local scripts that are
not committed. They sample unit roles, statuses, distance to the nearest enemy, the group's mode,
and the local force ratio at the front anchor every 10 s.

| # | finding | where |
|---|---|---|
| 1 | Firing happens almost only within 150 m of an enemy (82 % of firing units). Only 17 % of units are that close. 72 % of `line` units stand more than 300 m from any enemy. | — |
| 2 | Units spawn at the forward town nearest the front, but the rally point is laid out from the **capital** (`lerp(city.exit, target, 0.35)`). So reinforcements walked back to it, waited, and walked forward again. 12–15 % of all units were in `rally` at any time. | `behavior.ts` rally block, `sectors.ts` rally |
| 3 | Screen slots were assigned by unit id along a front segment that can be several km long. Only 0.3 % of line units stood at their slot, and 30 % were more than 500 m from it. | `sectors.ts` `planFront` slot loop |
| 4 | Groups were in `hold` 60–74 % of the time. In hold, the local ratio at the anchor was < 1 in 90 % of samples, while only 10–30 % of the group stood within 450 m of the anchor. The group was strong enough but spread out, so lowering the push threshold could not fix it. | `sectors.ts` push decision |
| 5 | Howitzers spent 60–72 % of their life in `rally` (they move at 0.7 m/s). Once deployed (0.55 × range behind the line, ≥ 300 m from enemy ground), the nearest enemy was out of range 40–60 % of the time. Value killed ÷ spent was 0.02–0.04. | `behavior.ts` `thinkArtillery`, rally |
| 6 | Occupation was a flat 3 detachments × 3 units. `placeValue` and the `cityai` aggression trigger (P > cap/2 and pop ≥ 90 %) never fired after the economy was retuned. | `command.ts` `HQ`, `cityai.ts` `surplus` |
| 7 | The rear guard (10 % of the army) fired 1–2 % of the time. | `operations.ts` |
| 8 | No war ended. A dominant faction had no rule that made it go for a capital. A first draft of the "broken enemy" rule (≤ 8 places) also matched every faction's ~7 starting places, which sent whole armies at capitals in minute 3 and dropped op success to 26 %. | `command.ts` |

### Changes

| change | file |
|---|---|
| **Commander mood** every HQ think, O(units): `fullness` = pop ÷ popCap; `need` = max(fullness ramp, slow replacement time = army value ÷ income); `aggression` = fullness ramp × strength against the nearest neighbour + idle-line share | `command.ts` `assessMood` |
| `placeValue(world, o, need)`: adds the pop-cap room of the place × need. The `attackBias` pull in `nextTarget` rises with need (0.6 → 1.0) | `command.ts`, `sectors.ts` |
| **Occupation scales**: detachments = 3 + ⌊free occupiers ÷ 8 × (0.5 + need)⌋, at most 10. Size is 2 for villages and points deep in our ground, 3 near the line and for towns, 4 for cities. The safe distance shrinks a little with need. Detachments get +60 s of march budget | `command.ts` `assignOccupations` |
| **Aggression trigger** replaces `surplus`: aggression ≥ 0.35 → the main group assaults; ≥ 0.7, or a decisive offensive → every attacking group assaults | `cityai.ts` |
| **Holding has a cost**: after 60 s in hold, if the whole group is ≥ 1.5 × the enemy at the anchor and aggression > 0, the group pushes and stays committed for 30 s (unless the local ratio drops below 0.8). The push threshold falls 0.3 × aggression | `sectors.ts` `eagerPush` |
| **Schwerpunkt**: in contact, 50–80 % of the line (more with aggression) masses on the axis toward the target. The rest screens only the stretches of the segment that have known enemies within 300 m | `sectors.ts` `massSlot`, `activeSegment` |
| **Frontal attacks mass first**: phase `form` until 60 % of the mass is within 260 m of the anchor (at most 50 s). A frontal march out of contact toward a capital is phase `move`, so it no longer re-plans every 75 s | `sectors.ts`, `doctrine.ts` |
| Screen slots are matched in the units' own order along the segment | `sectors.ts` `orderAlong` |
| Reinforcements of a group in contact, and units already nearer the target than the rally point, join the line directly. Units more than 350 m from their slot march on the group's front point first (one shared flow field) | `behavior.ts` |
| **Pass penalty** 0.35 in `nextTarget`, like the river penalty | `sectors.ts` |
| **Guns**: no rally. Deploy at 0.35 × (howitzer) or 0.3 × (mortar) range behind the line, ≥ 180 / 100 m from enemy ground. Fire from where they stand if they have a target (they used to keep walking) | `behavior.ts` `thinkArtillery` |
| Rear guard 4 % of the army until one of our convoys is hit (90 s alert), then 10 % | `operations.ts` |
| **Cover** (terrain agent request): assaulting foot squads in range bound from cover to cover toward the enemy, one bound at a time. Holding squads take the cover spot near their slot (cached until the slot moves) | `behavior.ts` |
| **Decisive offensive**: a faction is dominant if it holds ≥ 27 % of the places, or has fullness ≥ 0.9 with stock ≥ 60 % of the caps, or is ready (aggression ≥ 0.6 and fullness ≥ 0.65). Any faction with fullness ≥ 0.6 also goes after a **broken** enemy (≤ 6 places while we hold 4 × as many, or an army < 0.4 × ours and fewer places). Every group then targets the nearest, weakest enemy capital, picked by distance × (0.5 + 2 × their land share + their army ÷ ours) and kept ≥ 120 s. An assault already under way finishes first. Spearheads toward that capital launch at a local ratio of 1.3 every 60 s. There is no siege of that capital and no pincer | `command.ts` `chooseFinishTarget`, `sectors.ts`, `doctrine.ts`, `cityai.ts` |

### Before / after — balance lab (3 seeds × 30 min, same tree, `eager` off → on)

`npx tsx scripts/lab.ts --seeds 7,11,13 --minutes 30 --src <snapshot>/src --data <snapshot>/docs/data`

| metric | off | on | Δ | goal |
|---|---:|---:|---:|---|
| combat units firing (last 5 s) | 0.09 | 0.11–0.12 | +29–36 % | ≥ 0.15 (not reached) |
| attrition (losses /min /100 units) | 4.98 | 5.7–5.9 | +15–19 % | ≥ 6 (6.2 in the 0.85-threshold build) |
| fullness mean / min | 0.62 / 0.48 | 0.59 / 0.45 | −0.03 | ≤ 0.8, dip < 0.6 ✓ |
| captures /min (per faction) | 1.66 | 1.76–1.77 | +6–7 % | +25 % (not reached; see below) |
| settlements held at end | 34.3 | 38.4–38.8 | +12 % | — |
| time to first capture (min) | 2.1 | 2.0 | −0.1 | ↓ ✓ |
| damage dealt HP /min | 3560 | 3770–3930 | +6–10 % | — |
| howitzer value killed / spent | 0.04 | 0.11–0.13 | ×3 | — |
| owner swings per match | 91.7 | 86.7–87.7 | −5 % | ↑ (not reached) |
| bands | all OK | fullness mean 0.59 **OUT** (0.60–0.85); rest OK | | |

The ranges cover the two final builds: `finishAggression` 0.7 and 0.6. The fullness band should be
re-targeted to **0.55–0.85**. The goal for this round was "mean ≤ 0.8, dipping below 0.6 during
offensives", and a mean just under 0.6 is that goal. The captures/min band (0.15–2) also caps a
+25 % gain: the baseline is already 1.66, and most captures are the ~119 neutral settlements taken
in the first 20 min.

### Before / after — strategy lab (3 seeds × 20 min)

| metric | off | on (0.7 threshold) | on (0.6, final) |
|---|---:|---:|---:|
| op success rate % | 55.7 | 53.3 | 48.0 |
| wasted ops % | 7.4 | 11.2 | 13.0 |
| captures per match | 145.3 | 160.7 (+11 %) | 152.0 (+5 %) |
| captures per 100 units lost | 64.7 | 65.2 | 56.4 |
| units lost per match | 224.7 | 246.3 | 269.3 |
| fighting share % | 8.2 | 11.1 | 11.4 |
| ops through a pass: success | 28 % (18 ops) | — | 44 % (9 ops) |

Op success in the final build is below the 58 % target. The cause is the decisive offensive:
ops aimed at a capital only count as won when the capital falls, and the long marches between
capitals end as `retarget`. With the later trigger (0.7) op success stays at 53 %, within noise of
the baseline, but wars end later (see soak).

### Soak (`npx tsx scripts/soak.ts 45 7,11,13`)

| build | seed 7 | seed 11 | seed 13 |
|---|---|---|---|
| eager off | no result, 0 eliminated, leader at stock cap | no result, 0 eliminated | no result, 0 eliminated, leader at stock cap |
| on, finish ≥ 0.7 (60 min run) | **result 47.2 min** | 2 eliminated (no result at 60) | **result 47.0 min** |
| on, finish ≥ 0.6 (fin5) | **result 43.7 min** | 2 eliminated | **result 32.5 min** |
| on, final (fin5 + cover bounds) | **result 39.1 min** | 2 eliminated, 58/90 held | 2 eliminated, 44/102 held |

The first two eliminations come at about 19–33 min and 26–45 min. The last duel is what stalls.
Both survivors reach the global `population_cap` (780) with full stocks, and the capital spawns
reinforcements inside its own 35 m capture ring. A bigger territory then cannot turn into a bigger
army. Fixing that is an economy / capture-rule change (pop cap by land share, or spawn outside the
HQ ring), not an AI change.

### Performance

`npx tsx scripts/perf.ts generated 300 7`, run as paired off/on runs started together (the
machine was shared): 2.33 → 2.53 ms/tick (+8 %), p90 +12 %. Under `node scripts/profile.mjs 300
7`: 2.1 vs 2.1 ms/tick, 17.6 vs 17.1 s CPU. The extra cost is pathing: units move more, with
+49 % flow-field nodes expanded in the first 5 min, so `pathByField` goes from 3.0 % to 5.1 % of
CPU. The AI passes added nothing visible. They run at their own rate: one O(units) pass per faction
every 5 s, 16 spatial queries per group every 2 s, and an O(units × 64) slot ordering per group
every 2 s. There is no per-tick O(units²) work. `npx vitest run` passes, including the determinism
and event tests.

### Open issues

- Firing share (0.11–0.12) is short of 0.15. A large part of every army is on the march across a
  3.6 km map at 1.6 m/s; transit time is the main limit on engagement.
- The final two-faction duel stalls at the pop cap (see Soak).
- Occupy follow-through fell from 67 % to 53–56 %. There are more, smaller detachments, so more of
  them expire or get contested, even though the absolute number of captures rose.
- The dominant faction still sits at the stock cap once it reaches the pop cap; nothing in the AI
  can spend that money.
