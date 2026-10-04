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

## Round 3: home defence and fortification

User requests: *"加强统帅部决策，when the base is under risk, troops should back to defend"* and
*"for the base defend, I recommend to let the 统帅部建造工事, when they feel the base will be
attacked by the enemy"*. The new logic is in `src/sim/homeguard.ts` (constants in `HOME`). It is
gated by `STRATEGY_AI.homeDefence`, which is only active with `eager`, so the lab can A/B the
same tree (`--ab home` in the strategy lab, `HOME_DEFENCE=0` for the soak).

### Before: the round-2 rule

`sectors.thinkSectors` checked the known enemy value within 280 m of the HQ every 2 s. Above
300, **every** army group dropped its operation and marched home, and it went back to the
offensive as soon as the value dipped below 300. There was no forecast and no fortification. The
rule only fired once the enemy was already in the town, and it pulled every group at once. On
the current tree (6 seeds × 45 min), **7 of 10 capitals that fell had ≥ 1.5× the attackers'
value within 1.5 km** when the capture started. Those were raids and spearheads that the army
could have stopped.

### Design

**Forecast** (`forecast`, every HQ think = 5 s, one O(units) pass per faction):

- *Enemy*: the known (`world.knows`) hostile value around the capital, weighted as follows:
  - inside 450 m: weight 1;
  - 450–900 m: weight 1 if the unit is aimed at us (its spearhead is `hq:<f>`, its group's
    `targetCity` is us, or its destination is within 400 m of the HQ). Otherwise 0.35 if its
    group is closing in, else 0.1;
  - 900–2 400 m: aimed **and** closing only, with the weight falling linearly to 0 at 2 400 m.
  "Closing" means the group's value-weighted distance to our HQ shrinks at ≥ 0.25 m/s (smoothed
  from think to think). The first build used no closing test. A group aimed at us but fighting
  elsewhere then kept all three of our groups at home for 10 minutes.
- *ETA*: the value-weighted mean of (distance − 150 m) ÷ unit speed.
- *Bearing*: the value-weighted direction of the threat.
- *Garrison*: our value within 250 m. Each own unit is counted once: as garrison, as a home guard
  on its way, or as part of its group (value, centroid, share firing in the last 10 s).
- `level = enemy ÷ (enemy + garrison + 150)`.
- The result is exposed as `faction.command.homeThreat` (`level`, `eta`, `enemy`, `garrison`,
  `committed`, `bearing`, `active`, `recall`, `fortify`, `works`, `far`, `farEta`). The snapshot
  copies it with the rest of `command`. The HQ card (`ui/sectors.ts`) shows a 首都受威胁 /
  "Capital threatened" row with the ETA and the number of recalled groups.

**Alarm** (hysteresis): the alarm goes on at `level ≥ 0.4` with a forecast ≥ 150. It goes off
only after `level < 0.25` for 30 s **and** at least 60 s after it started. Log notes:
`log.homeThreat` when it goes on (alert), `log.homeDefence` for each recall (warn),
`log.homeSafe` when it ends, all in zh and en.

**Graded recall** (`recall`): the aim is home strength ≥ 1.5 × the forecast.

1. **Home guards** come first (`guardPool`). They are units on duty at the capital
   (`opRole 'garrison'`, `opObjective 'hq:<f>'`), at most 14, taken from within 1.5 km in this
   order, nearest first within each tier:
   - occupation detachments within 600 m, and garrisons of quiet towns;
   - then AT guns and MGs;
   - then free line troops of groups that are not in an operation phase.
2. **Whole army groups** come next, only while the guards are not enough. Candidates are sorted
   by cost = distance from the HQ ÷ 1 000 + 1.5 × share firing + 1 if storming + 0.4 if pushing.
   That is, the nearest and least engaged group goes first. A group is a candidate only if it can
   march home (1.6 m/s) within the threat's ETA + 360 s. The others keep the offensive going.
3. **Limits**: one group always stays on the offensive unless 1.5 × the forecast is ≥ half the
   whole army. If the forecast is ≥ 1.5 × our whole army and the enemy is still more than 120 s
   away, no further group is recalled early. Guards and works still go in, and groups are
   recalled once the enemy is at the gates.
4. **No yo-yo**: a recalled group stays recalled while the alarm lasts. A group is released early
   only after ≥ 60 s at home, and only if the rest still covers the target. When the alarm ends,
   `restoreOrders` gives each group back the target, rally point and retarget clock it had
   before.
5. **Explained in the UI**: a recalled group's reason is `reason.homeDefence`, for example
   "回防首都（敌约 {enemy}，我 {mine}，{eta} 秒后接敌）".
6. **Falling back**: units of a recalled group that are more than 450 m from the HQ walk back to
   their slot and fire at targets of opportunity (`fallBackHome`, `status.fallingBack`). This is
   a retreat in good order, not a rout. Guns are excluded. The group's line is anchored on the
   best defensive ground within 220 m of the HQ, facing the threat, with AT guns and MGs in the
   rank behind the infantry.

**Fortification** (`fortifyHome`, `ensureDiggers`, `thinkHomeGuard`):

- **Trigger**: (`level ≥ 0.2` and forecast ≥ 150) **or** a superior force (≥ 1.2 × garrison +
  our groups within 1.5 km) closing in with ETA ≤ 900 s, and no known enemy within 150 m of the
  HQ (inside that range they fight instead). Once on, the order stands for ≥ 60 s.
  `log.homeFortify` is announced at most once per 2 minutes.
- **Works**:
  - up to **3 trench lines** 160 m out (±20–35 m to avoid buildings and water), on the threat
    bearing and ±0.45 rad, each laid across the approach axis and facing out;
  - up to **4 sandbag barricades** at the town edge (85 m, ±0.22 and ±0.6 rad).
  - Built through `works.startLine`, so the P cost and `WORKS.startEverySeconds` pacing apply.
    At most 2 works are unfinished at a time, and a work starts only if P ≥ 1.5 × its cost, so
    production is not starved.
- **Diggers**: engineers within 1.5 km first, then infantry, about 2 per open work, as home
  guards. A home guard digs whenever no enemy is within 150 m of it. Otherwise it mans a post on
  the threatened approach:
  - infantry stand just behind a finished trench or sandbag line facing the threat, so the
    existing cover rules (`updateWorksCover`) apply;
  - AT guns and MGs stand 120 m out on the axis;
  - tanks stand at the town edge.
  Enemies inside 125 m of the HQ are attacked so the capture ring holds a defender. Guards go
  back to the line when neither the alarm nor the fortify order is on.
- **Towns and cities** (generalised): the two most pressed **garrisoned** towns or cities with a
  defend directive get one trench across the approach, 40 m outside the place
  (`fortifyPlace`). Their garrison digs it before it mans its posts (`command.digPlaceWork`).
  The first build let the garrison alternate between its post and the trench, and the soak
  flagged 30 "stuck" units. Digging now comes before manning the post, and the soak reports no
  stuck diggers.

Other changes: `planPincer` no longer uses a recalled wing as a jaw. The first build had 151
pincer `noForce` ops in 3 matches. `cityai` holds the posture for both recall reasons.

### Before / after — strategy lab (6 seeds × 45 min, same tree, `homeDefence` off → on)

`npx tsx scripts/strategy.ts --seeds 7,11,13,17,23,29 --minutes 45 --compare --ab home --jobs 12`.
The capital rows come from `scripts/strategy/home.ts`, sampled once per game second. "In reach"
means own value within 1.5 km against attackers within 300 m when capture progress starts.

| metric | off (round 2) | on (round 3) | Δ |
|---|---:|---:|---:|
| capital attack episodes (capture progress started) | 29 | 11 | −62 % |
| … of which the defender had ≥ 1.5× in reach | 20 | 0 | |
| capitals lost | 10 | 6 | −4 |
| **capitals lost although stoppable** | **7** | **0** | −7 |
| capital capture-progress seconds | 1 297 | 362 | −72 % |
| trench / sandbag lines started / finished at capitals | 0 / 0 | 84 / 63 (≈ 14 / 10.5 per match) | |
| home alarms | 0 | 27 (4.5 per match) | |
| group-minutes recalled home | 308 | 619 | +311 |
| captures per minute | 5.9 | 5.7 | −3 % ✓ |
| captures per match | 267 | 259 | −3 % ✓ |
| op success rate % | 40.6 | 36.8 | −3.7 pts (−9 % rel.) ✗ |
| wasted ops % | 20.0 | 16.9 | −3.1 |
| captures per 100 units lost | 32.4 | 31.3 | −1.1 |
| units lost per match | 824 | 827 | ≈ |
| occupy directives → captured % | 58.2 | 55.3 | −2.9 |
| eliminations per match | 1.7 | 1.0 | −0.7 |
| wars ended within 45 min | 0 / 6 | 0 / 6 | |

Iterations, all with the same-tree A/B (the other agents' balance edits moved the baseline
between runs):

| build | seeds | group-min home / match | captures / min Δ | stoppable losses (off → on) |
|---|---:|---:|---:|---|
| v1: no closing test, all groups recallable | 3 | 113 | −6 % | 5 → 0 |
| v2: + reach window, surplus release | 3 | 105 | −6 % | 5 → 2 |
| v3: + idle off-axis weight 0.1, level 0.4 / 0.25, one group kept attacking | 3 | 91 | −3 % | 5 → 2 (151 pincer `noForce`) |
| v4: + no pincer with a recalled wing | 6 | 97 | −9 % | 6 → 2 |
| **final**: + hopeless rule, occupation guards only within 600 m | 6 | 103 | −3 % | **7 → 0** |

Most of the recalled group-minutes come from factions that are already losing: a decisive
offensive of 15–35 k value closing on a capital. In the local diagnostic (`media/r3/diag.ts`,
seed 11), one faction had all 3 groups home for its last 9 minutes before it fell at 28 min.
Recalling there is the intended behaviour, and it is why eliminations per match fell.

### Soak (`npx tsx scripts/soak.ts 45 7,11,13`, same tree, off → on)

| seed | off | on |
|---|---|---|
| 7 | no result; 2 eliminated (held 85/0/0/45) | no result; 1 eliminated (68/0/32/37) |
| 11 | no result; 2 eliminated (0/0/48/95) | no result; 2 eliminated (0/0/49/97) |
| 13 | no result; 2 eliminated (50/0/0/88) | no result; 0 eliminated (39/40/28/44) |

**No war ended within 45 min on this tree with home defence off either.** In 1.0, 2 of 3 seeds
ended. The balance work done at the same time has already moved the baseline (round-2 rule).
Home defence slows the endgame further: 6 → 3 eliminations in 3 × 45 min. The remaining
anomalies with home defence on are path / reachability reports (`unreachable`, 20), plus one
stuck unit each in five other states (maneuver, raiding, rearGuard, spearhead, toDepot). None of
them comes from digging or garrison duty.

### Performance

`npx tsx scripts/perf.ts generated 300 7`: 1.4 ms/tick before the change (quiet machine), 1.6
after (p50 0.8, p90 3.3). Paired on/off runs started together (a local wrapper that sets the
flag) at 300 s: 1.9 vs 1.9 ms/tick. At 1 200 s, with alarms and works active: **1.4 (on) vs 1.5
(off)**, p90 2.8 vs 3.2. The forecast runs at HQ cadence: one O(units) pass and at most two pool
scans per faction every 5 s. The per-unit home-guard think does one spatial query (260 m) and a
scan of the works list, and a post is refreshed at most every 20 s. Nothing runs per tick per
unit. `npx vitest run` passes (48 tests), including determinism, the events tests and the new
`tests/homeguard.test.ts` (forecast → proportional recall → works on the approach → stand-down).

### Open issues

- **Wars end later.** Eliminations dropped from 1.7 to 1.0 per match. Together with the balance
  changes of the same week, no seed ends within 45 min. The next step is on the attacker's side:
  a siege op (trenches + guns) against a fortified capital, instead of frontal spearheads into
  dug-in guards.
- **Op success fell by 3.7 points**, mostly flank ops `reset` by a recall. A recall could wait for
  an op in its `assault` phase to finish when the ETA allows.
- The capital metrics rest on few events: 6–10 falls per 6 matches. The stoppable-loss count
  needs more seeds before it is a stable number.
- One AT gun (seed 11) sat "unreachable" for 10 minutes without a destination. Guard posts for
  crews use `terrain.freeNear` but do not test the crew's nav class. (Fixed in round 4.)

## Round 4: siege-and-storm, recall spares assaults, crew deployment

The lead's follow-up after the artillery balance round: on the combined tree no soak seed ended
within 45 min, with home defence on or off. The attacker needed an answer to fortified, garrisoned
capitals. This round also has to stop a recall from cutting an assault short, put the crew weapons
where the fighting is, and choose posts on the right nav grid. Everything is gated by
`STRATEGY_AI.storm`. The A/B uses the same tree: `--ab storm` in the strategy lab and `STORM=0`
for the soak.

### Changes

| change | where |
|---|---|
| **Capital siege-and-storm** through the existing siege op. A group whose target is an enemy capital, with ≥ 40 % of its units within 1.8 km and a forecast defence ≥ 0.2 × its value, lays siege instead of attacking frontally. A frontal march on a capital (phase `move`) switches to the siege on arrival. **Forecast defence** = the known value within 320 m of the capital + 160 per finished trench + 80 per finished sandbag line. **Mass** = our value within 1 km. **form**: the groups mass on the siege ring, with no spearheads in this phase. They storm at mass ≥ 1.6 × forecast after ≥ 40 s. After 150 s they storm anyway at ≥ 1.1 ×, or else switch to dig. **storm**: the front pushes whatever the local ratio at the anchor is. If after 75 s the forecast is still ≥ 0.8 × its value at the start and mass < 1.5 × forecast, the group falls back to **dig**: it digs its own trench ring while the guns work. It storms again once the forecast is ≤ 0.7 × its value when digging started (or the mass is enough), between 60 and 200 s. The op is `won` when the capital falls and times out after 20 min | `storm.ts`, `doctrine.ts` `stepCapitalSiege`, `digRing`; `sectors.ts` (push, spearheads) |
| **Guns at the capital**: every howitzer and mortar of a besieging group deploys within range of the defenders' mass: 0.8 × its range, on our side, at half its usual safety distance | `crewai.gunPost`, `storm.bombardPoint` |
| **A recall spares assaults**: a group in an `assault` phase, a breakthrough, or a siege of its own is not recalled unless the enemy is ≤ 120 s from the capital | `homeguard.ts` `recall` |
| **Crew deployment**: MGs and AT guns go to the nearest stretch of our front that is actually fighting. That is a front cell with known enemies within 250 m, out of 64 cells sampled every 3 s, within 900 m of the crew. Otherwise they go to the group's engagement. They stand on our side of the enemy mass, at 0.85 × (MG) or 0.8 × (AT) of their range. A post moves only if the wanted spot moves > 50 m (guns: > 90 m). Crews hold still for 15 s after the last shot (guns: 20 s). Mortars and howitzers deploy the same way at 0.75 × or 0.7 × their range, inside the safety distance. **MGs no longer guard convoy routes**: they were 39 % of all MGs, idle in the rear. **Garrison crews** man the town edge facing the threat and no longer charge enemies inside the town | `crewai.ts`, `behavior.ts`, `operations.ts`, `command.ts` |
| **Nav-grid posts**: guard, garrison, rear-guard and manoeuvre goals use `world.navFor(u).nearestPassable`. Siege and home trenches sit on infantry-passable ground. A unit leaves a work it failed to path to to others | `crewai.navPost`, `homeguard.ts`, `command.ts`, `operations.ts`, `doctrine.unitGoal`, `works.dig` |

The spec asked for a storm at ≥ 2 × the forecast defence. In the first build, mass counted within
700 m of the capital and the 2 × threshold. The groups held the ring 0.6–1 km out and were never
counted as massed. The besieger then alternated form → dig → storm for 15 minutes, holding in
place, because the local push ratio at the anchor stayed < 1. The defenders mass there. The final
build counts mass within 1 km, storms at 1.6 ×, and forces the push during the storm. In
`media/r3/stormdiag.ts`, seed 13, the defence forecast fell from 10.5 k to 4 k under the guns and
the storm, and the capital fell at 37 min.

### Before / after — strategy lab (6 seeds × 45 min, same tree, `storm` off → on)

| metric | off (round 3) | on (round 4) | target |
|---|---:|---:|---|
| op success rate % | 38.9 | **42.3** | within 5 % of round 2 (40.6) ✓ |
| wasted ops % | 16.8 | 15.5 | |
| value lost in failed ops per match (k) | 24.2 | 15.0 | |
| captures per match | 254 | 269 (+6 %) | |
| captures per 100 units lost | 31.4 | 33.4 | |
| MG firing % | 1.3 | **2.8** (×2.2) | ≥ 2× ✓ |
| AT gun firing % | 1.6 | **2.9** (×1.8) | ≥ 2× ✗ (close) |
| mortar firing % | 19.6 | 18.1 | |
| howitzer firing % | 13.5 | 15.1 | |
| AT / mortar / howitzer relocating with no target % | 76 / 72 / 52 | 74 / 71 / 46 | |
| capitals lost | 7 | 6 | |
| capitals lost although stoppable | 0 | **1** (seed 23, 42.9 min) | 0 ✗ |
| capital capture-progress seconds | 564 | 579 | |
| eliminations per match | 1.2 | 1.0 | |
| wars ended within 45 min | 0 / 6 | 0 / 6 | |

The relocating share stays high because crews walk 340–500 m on average to their post (crew diag,
seed 7). They spawn behind the line and move at 0.9–1.3 m/s. MGs now spend that time walking
instead of idling on rear-guard duty, so their "relocating" share rose while their firing share
doubled. One more variant let storming groups be recalled at threat level ≥ 0.6. It still lost
the seed-23 capital, and op success fell back to 39.2 %, so it was dropped.

### Soak (`npx tsx scripts/soak.ts 45 7,11,13`, same tree)

| seed | storm off | storm on |
|---|---|---|
| 7 | no result; 1 eliminated (69/0/34/40) | no result; 1 eliminated (70/0/53/17) |
| 11 | no result; 2 eliminated (0/0/46/101) | no result; 2 eliminated (0/0/80/66) |
| 13 | no result; 2 eliminated (0/34/0/96) | no result; 2 eliminated (0/0/91/42) |
| "unreachable" lines | 6 / 3 / 4 = 13 | **3 / 2 / 2 = 7** (round 3: 20) |

**The target (2 of 3 seeds end, ≥ 2 eliminations on the third) is not met.** The timelines show
why. Capitals now fall between 28 and 43 min: one at about 30–35 min, a second at 40–45 min. That
leaves two factions at or near the population cap (780) for the last duel, the stall already
noted in round 2. Ending a 4-faction war needs three capital falls. At the pace of one capital per
~8–10 minutes after the first decisive offensive (≈ 25 min), the third fall lands after 45 min.
The AI cannot fix the pop-cap duel alone. Options are a pop cap by land share, spawning outside
the HQ ring, or a resolve or majority victory condition (`victory.resolve_enabled`).

### Performance

Paired runs started together (`media/r3/perfab4.ts` sets the flag), generated map, seed 7:

| run | off | on |
|---|---:|---:|
| `perf.ts` 300 s | 1.2 ms/tick, p90 2.4, p99 8.4 | 1.2 ms/tick, p90 2.4, p99 8.3 |
| `perf.ts` 1 200 s | 1.2 ms/tick, p90 2.5, p99 7.6 | 1.2 ms/tick, p90 2.5, p99 7.8 |

The hot spots are 64 spatial queries per faction every 3 s. The engagement centre is cached per
group for 2 s. A post is recomputed only when the wanted spot moves. The capital forecast and mass
are 2 spatial queries per besieging group every 2 s. `npx vitest run` passes (51 tests), including
determinism, events, `homeguard.test.ts` and the new `storm.test.ts`.

### Open issues

- **Wars still do not end within 45 min.** The remaining blocker is the pop-capped final duel,
  which is an economy or capture-rule question (see above).
- **AT guns fire 1.8× as often, short of 2×.** Transit dominates: crews walk 340–500 m to the
  fight. Spawning crews at the forward town nearest the fight, or towing, would help.
- **One stoppable capital loss** (seed 23 at 42.9 min) appeared with storm on. Recalling storming
  groups at a high threat level did not prevent it, so the cause is elsewhere.
- **Mortars** still relocate about 70 % of the time. They follow hot spots that move as the front
  breathes. A longer hold, or a battery-level post, is the next step.

### Round 4b: endgame pace, with the territory-driven pop cap

The lead asked for wars to end within 35–50 min after the economy change: `territory.capital_pop_share`
0.25 and `pop_cap_max_multiplier` 1.5, so a map-holding leader fields 950–990 pop. These
constants changed in this pass (measured with `media/r3/stormdiag.ts` and soaks):

| constant | before → after | why |
|---|---|---|
| `HOME.overmatch` | 1.5 → 1.2 | recall only enough to cover the forecast |
| hopeless rule (`homeguard.recall`) | no early recall unless the enemy is within 120 s → **no new group recall at all** once the forecast is ≥ 1.5 × our whole army | the doomed defender's whole army sat at home for 15 min; raids never reach that ratio |
| `EAGER.dwarfPop` (new) | 2 | `chooseFinishTarget`: our pop ≥ 2 × an enemy's → finish it now. `storm.wantsCapitalSiege`: no siege then; it is rolled over frontally with spearheads |
| `STORM.stormRingM` / `stormArc` (new) | 25 m / ±1.4 rad | in the storm, the line's slots close on the HQ itself. It used to creep with the front 0.75–0.9 km out |
| storm stall | 75 s with no defence drop → **75 s with neither a defence drop nor ≥ 10 % more mass arriving** | storms 1.2 km out were called off before the mass could arrive |
| `behavior.approachPoint` | — | units of a capital siege or storm go straight for their ring slot, not via the group's front point (that point sat at a river 1.2–1.9 km out) |

Soak `npx tsx scripts/soak.ts 50 7,11,13` on the combined tree. "elim." is eliminations by 50 min.

| build | seed 7 | seed 11 | seed 13 | wars ended |
|---|---|---|---|---|
| lead's baseline (round 4 as shipped) | **ends 41.6 min** | 2 elim. | 2 elim. | 1 / 3 |
| round 4b (this pass, final) | 2 elim. | 1 elim. | 2 elim. | 0 / 3 |
| round 4b, `SIEGE=0` (no capital siege) | 2 elim. | 1 elim. | 2 elim. | 0 / 3 |
| round 4b, `HOME_DEFENCE=0` | 2 elim. | 2 elim. | 2 elim. | 0 / 3 |
| `STORM=0` (round 3) | **ends 34.1 min** | 1 elim. | 1 elim. | 1 / 3 |
| `STORM=0 HOME_DEFENCE=0` (round 2 rules) | **ends 40.2 min** | 2 elim. | **ends 47.8 min** | 2 / 3 |

Strategy lab, 6 seeds × 50 min, same tree, `--ab storm`:

| metric | storm off | storm on (4b) |
|---|---:|---:|
| wars ended | 1 (34.1 min) | 1 (49.8 min) |
| eliminations per match | 1.8 | 2.0 |
| op success % | 15.8 | 21.1 |
| captures per minute | 4.8 | 5.2 |
| capitals lost although stoppable | 3 | 2 |
| MG / AT firing % | 0.9 / 1.0 | 2.9 / 2.1 |

**The target (≥ 2 of 3 soak seeds end within 50 min) is not met.**

- Only the round-2 rules (no home defence, no siege) reach 2 of 3 on the three soak seeds. On
  6 seeds the storm build ends as many wars as storm off (1 each) and eliminates slightly more
  factions.
- Single soak outcomes swing by a whole elimination between builds that differ in one constant.
  The war end is a threshold event, and 3 seeds cannot separate the variants.
- What remains in most runs is a **duel between two sides of similar size**, for example 80 vs 61
  or 66 vs 83 places at 50 min. Neither side dwarfs the other, so no AI rule makes one roll over
  the other in 10 minutes.
- Op success in the lab dropped to 16–21 % on this tree on both sides, against 39–42 % before the
  economy change, so the economy change probably caused it. The lab runs show the same.
- Capitals lost although stoppable is 2 per 6 matches, above the ≤ 1 target.

Perf, paired 300 s: off 1.5 vs on 1.6 ms/tick, p90 3.0 for both. `npx vitest run` passes
(51 tests).

### Round 5: the finisher (capital-only victory)

User decision: the only victory is occupying every enemy capital (`sim.checkElimination`:
`last_standing` / `mutual`). All changes are behind `STRATEGY_AI.storm`; the constants are in
`storm.FINISH`.

**Finisher** (`storm.assessFinisher`, every HQ think). A faction becomes the finisher when both
hold:
- its population is ≥ **1.3 ×** its strongest remaining enemy's (it stays on until that falls
  below 1.15 ×);
- its stock is ≥ 50 % of the caps, or it is pop-capped (fullness ≥ 0.95).

While on:
- **Home defence** stands down to home guards and works: no army group is recalled, and recalled
  groups are released.
- **Rear guard and raids** stop: the troops join the storm.
- **Occupation** drops to 2 detachments.
- **Garrisons** are stripped to 2 per place. They are released after 15 s of calm (not 45 s),
  and the garrison budget is 5 % of the army.
- **Every group** besieges the finish target's capital, whatever the numbers.
- **Forced storm**: with our army ≥ **1.5 ×** the target's known army, the storm starts at once
  and never falls back to digging. The storm slots stay 25 m from the HQ, so units keep flowing in.

**No turtling**: any faction now recalls whole groups only when the forecast includes ≥ 150
value from units in contact or actually heading for the capital (`homeThreat.aimed`). Home
guards still answer any raid.

Two constants differ from the lead's spec, both measured on seed 7:
- The finisher trigger is 1.3 ×, not 1.5 ×. At 1.5 × the leader became a finisher only at about
  45 min, and the last capital fell at 59.9 min.
- The forced storm is at 1.5 × army, not 2 ×. With 2 ×, the 1.5–1.9 × leader cycled storm and
  dig against a defender whose whole army was at home, and the war did not end within 60 min.

A rejected variant sent one group to the next capital in parallel: seed 7 then did not end
within 60 min.

Soak `npx tsx scripts/soak.ts 60 7,11,13` (media/hero-trailer tree):

| build | seed 7 | seed 11 | seed 13 |
|---|---|---|---|
| before (round 4b) | 2 alive (44 / 100 places), no end | 3 alive (53/62/35) | 2 alive (73/78) |
| finisher at 1.5 ×, forced storm at 2 × | 2 alive (44 / 99) | 3 alive (identical) | 2 alive |
| finisher at 1.5 ×, forced storm at 1.5 × | **ends 59.9 min** | 3 alive | 2 alive |
| **final**: finisher at 1.3 ×, forced storm at 1.5 × | **ends 58.9 min** | **2 alive (76/60)** | 2 alive (73/78) |
| + parallel next-capital group (rejected) | 2 alive, no end | 2 alive | 2 alive |

Strategy lab, 6 seeds × 60 min, `--ab storm` (same tree):

| metric | storm off | final |
|---|---:|---:|
| wars ended | 1 (34.1 min) | 2 (mean 53.2 min) |
| eliminations per match | 1.8 | 2.3 |
| capitals lost although stoppable | 3 | 2 |
| op success % | 14.3 | 21.1 |
| captures per minute | 4.6 | 4.7 |
| MG / AT firing % | 0.8 / 1.0 | 2.9 / 2.2 |

- Seed 7 still ends after 50 min (58.9). The last capital takes about 15 min after the
  second-to-last falls: a 2 km march, then a storm into the defender's whole army.
- Op success is far below 40 % on both sides. On this tree 412 of about 520 ops target a
  capital, and an op against a capital only counts as won when that capital falls.
- Perf, paired 300 s: 1.3 vs 1.3 ms/tick. `npx vitest run` passes 51 tests.


## Round 6: command hierarchy 2.0 (AI supreme HQ, dynamic fronts, capital garrison)

User decisions (2026-10-04): "新设指挥层级，最高统帅部-前线指挥官-unit，最高统帅部仅负责全局战略设置，前线指挥官负责具体战术";
"取消左中右三路设计"; "首都区域必须有驻防"; and "in some game I just let all units attack the
capital, then it wins". Spec: docs/COMMAND_V2.md. Measured on the shared `feat/command-v2`
working tree, so the works agent's capital line (trench + pillboxes) is in every "after" number.
"Before" is HEAD 4a77d0a (foundation commit) exported to a scratch copy.

### Design

**AI supreme HQ** (`theatre.ts`, every HQ think = 5 s, AI factions only):

1. *Structure*: axes = neighbouring enemy capitals (≤ 1.3 × the nearest; the finish target always)
   plus clusters (700 m) of settlements the HQ wants to attack. At most one change per 30 s:
   dissolve a front empty for 30 s; merge two fronts on the same objective, or with objectives
   within 300 m and troops within 500 m when there are more fronts than needed; merge the weakest
   when fronts > the kept count; open a front for an uncovered axis when fronts < wanted and
   the new front gets ≥ 20 troops. Wanted = strong axes (≥ 0.45 × top), ≤ troops / 20, ≤
   `fronts_max`. Kept = axes ≥ 0.25 × top, troops / 12 (hysteresis). The floor is
   min(`fronts_initial`, troops / 25). Fronts on an enemy capital, in a siege, assault or
   manoeuvre, recalled, or younger than 120 s are never merged. The front commander's commander
   is paid (`commander_unit` P) when a front opens.
2. *Orders* through the player API (`issueFrontOrder`, `manual: false`):
   - `attack` on the objective `fronts.nextTarget` picks, so rounds 1–5 keep working.
     Retargeting still waits ≥ 60 s, except for the finish target.
   - `defend` a line in front of a freshly held town / city when known enemies within 500 m are
     ≥ 0.8 × the front. After 90 s under pressure the order becomes `fortify`.
   - `fallBack` to the nearest own town ≥ 400 m nearer home when ≥ 40 % of the front routs, or the
     enemy at its line is ≥ 3 × the front. When still pressed, this becomes `defend`.
   - A stance is released after 20 s of calm (enemy < 0.5 × front), or after 180 s once the front
     is no longer outmatched.
3. *Counter-strike*: an enemy with ≥ 40 % of its known army within 1.4 km of our capital, and
   its own capital held by ≤ 30 % of that army, is struck by our strongest non-recalled front.
   That front must be within 3.2 km and have ≥ 2 × the capital's forecast defence. Home recall
   takes counter-strike fronts last (`STANDING.counterStrikeCost`).

**Reinforcement** (`cityai.balanceReserves`): the fixed 45 / 35 / 20 % shares are replaced by
shares ∝ (0.6 + pressure + 0.8 × shortfall below the mean strength), × 1.4 for the main front.

**Front ids** are stable (`frontSeq`) but are no longer indices. Every sim consumer now goes
through `frontref.frontById`: behavior, convoy, damage, events, homeguard, production, doctrine,
cityai, and the thinkFronts groups. Units and production orders of a dissolved front rejoin the
nearest front (`frontops.reassignStale`, every HQ think).

**Player**: an order with no front, more than 900 m from every front's line, opens a new front
when fronts < `fronts_max` (`frontops.frontForOrder`). The new front gets its share of the free
line troops nearest the order.

**Front commander tactics** (`fronts.planFront`, `frontslots.ts`):
- defend / fortify / fall-back lines are snapped to terrain: every 32 m, the best
  `defensivePosition` within 40 m, cached per line. Slots stand 8 m behind the snapped line.
- An attack along a line keeps its shape and moves with the front point, massing on it.
- On a `fallBack` order, units march to their slot with return fire only, for up to 150 s
  (`behavior.fallingBack`).
- Commanders post at an own *uncontested* town. When none is in reach, the commander follows
  260 m behind the line on safe ground (`safeRear`). It steps away from armed enemies within
  160 m wherever it is, and it is excluded from the recall's fall-back march.

**Capital rule** (`homeguard.keepStanding`): from 120 s, `capital_standing_garrison` (3) infantry
squads are home guards at all times, drawn from any front. Release keeps them. The alarm level
now counts guards walking home (`level = enemy ÷ (enemy + garrison + guardAway + pad)`).

Lab switches: `STRATEGY_AI.theatre`; `THEATRE=0` / `THEATRE_OFF=stances,structure,counter` in
`scripts/soak.ts`. Diagnostics: `scripts/lab/fronts-diag.ts` (fronts per minute) and
`scripts/lab/rush-diag.ts` (all-in rush on capital 0).

### Before / after — strategy lab (`--seeds 7,11,13 --minutes 30`)

| metric | before (HEAD) | first build | final |
|---|---:|---:|---:|
| op success % | 20.5 | 25.2 | **30.5** |
| op captures / group-min | 0.08 | 0.12 | 0.15 |
| captures per minute | 6.22 | 6.48 | 6.29 |
| eliminations per match (30 min) | 1.0 | 0.67 | 1.0 |
| capitals lost | 3 | 2 | 3 |
| capitals lost although stoppable | 2 | 0 | **1** |
| units lost per match | 409 | 433 | 398 |
| home works built | 38 | 78 | 72 |

A rejected intermediate build also struck enemies committed against a *third party's* capital,
with csRatio 1 and csArmyShare 0.6. It turned every mid-game siege into a counter-strike
cascade: op success fell to 11.5 %, and there were no eliminations in 3 × 30 min.

### Soak (`npx tsx scripts/soak.ts 45 7,11,13`)

Eliminations by 45 min, and stuck / unreachable anomalies:

| build | seed 7 | seed 11 | seed 13 | elims | stuck / unreachable |
|---|---|---|---|---:|---:|
| before (HEAD) | 2 elim. | 2 elim. | 2 elim. | 6 | 38 (rear-guard tanks, commanders) |
| same tree, `THEATRE=0` | 1 | 1 | 2 | 4 | 6 |
| first build | 2 | 0 | 0 | 2 | 10 |
| `THEATRE_OFF=counter` (seeds 11, 13) | – | 1 | 1 | – | – |
| `THEATRE_OFF=structure` (seeds 11, 13) | – | 2 | 1 | – | – |
| **final** (floor 25, csRatio 2, csArmyShare 0.3) | 1 | 1 | 1 | **3** | **9** |

The final soak has no stuck / unreachable rear guards, because a guard whose post fails now takes
the next route point (`operations.planOperations`). The remaining entries are:
- AT guns "unreachable" in `status.homeGuard`: recall guards on a works post.
- Recon units and a light tank stuck or unreachable while observing / raiding.
- 1 commander and 1 occupier stuck.

The works agent's new invariant check `fort#… occupant … is dead` fired 34 times in one run
(pillbox occupancy). That code belongs to the works agent.

Wars end less often than at HEAD: 3 eliminations against 6. The same tree with the planner off
(`THEATRE=0`) gives 4, so the capital line, the pillboxes and the standing garrison account for
most of the drop. The planner accounts for the remaining 1.

### All-in rush (`scripts/lab/rush-diag.ts`, tests/fronts.test.ts)

- **March** (`rush-diag 7 5 14 1`): at minute 5, faction 1 sends its whole army (62 units) at
  capital 0.
  - Detected at the first HQ think (`aimed` 3.5k). Two to three fronts are recalled, and the home
    value grows from 1.7k to 7–8k before the rush arrives (~16 min).
  - The rush is destroyed (62 → 8 units), and the capital never sees capture progress.
  - Faction 0 then counter-strikes faction 1's capital, and is the finisher from minute 14.
  - Seed 11 behaves the same: the capital holds and the rushers fall from 64 to 15 units.
- **Teleport 700 m out** (worst case, 2–3 min warning): seed 11 holds. Seed 7 falls after
  5.5 min against an equal army (5.8k vs 6.0k). The recalled fronts were 1.5–2 km away and arrived
  piecemeal, and faction 0 had been the finisher, which keeps its groups out, until the first think.
- The emptied capital is rarely open to a counter-strike at minute 5. Its fixed strongpoints,
  works and new production alone are 1.5–3.9k of forecast defence, more than any single front.
  The punishment therefore comes from the finisher (`chooseFinishTarget`: a broken enemy) once
  the rush is beaten. The test checks the strike with the raider's capital emptied.

### Performance

Paired `npx tsx scripts/perf.ts generated 600 7`, same machine and same time, with three other
agents running:

| | before (HEAD) | after |
|---|---:|---:|
| mean tick | 1.8 ms | 1.9 ms |
| p99 | 12.1 | 13.2 |

An earlier pair gave before 2.1 / after 1.9. The planner runs every 5 s per faction and does
O(units + objectives × fronts) work. It adds no per-tick or per-unit work.

### Open issues

- Wars end less often (see the soak). The capital line, pillboxes and standing garrison make
  capitals much harder to take, and siege success in the lab fell to 2–4 %. The storm constants
  (`STORM.massRatio`, `FINISH.forceArmyRatio`) need a pass against the new fortifications.
- A rush that appears within 3 minutes of a capital can still beat an equal defender whose
  fronts are 2 km out.
- The planner usually keeps 2–3 fronts per faction. Front 4 opens only for a strong
  uncovered axis.
- New log keys for the UI: `log.frontOpened {point}`, `log.frontMerged {point, into}`,
  `log.frontFallBack {point}`, `log.counterStrike {point}`.

## Round 7: challenge lab (capital defence against scripted strategies)

User: *"in some game I just let all units attack the capital, then it wins."*
`scripts/challenge.ts` (docs/CHALLENGE_LAB.md) plays one faction through the command API with
scripted strategies against the three AIs. The phase-1 baseline found one real hole. A capital
falls when one eligible enemy squad holds the 35 m HQ radius for 45 s. The AI counted
"garrison" over 250 m, built its works at 85–160 m, and posted nobody on the point. On
human_like seed 13, F3 fell with 1.3 k of its own value inside 250 m and 7 k inside 1.5 km.

### Changes

- **HQ point** (`homeguard.HQ_POINT`, `assignHolders`, `hqDuty`; hook in `behavior.ts` before
  structure duty):
  - 2 standing-garrison squads stand within 12 m of the HQ. They must be eligible capturers
    (infantry / recon / engineer, ≥ 50 % hp), not engineers by preference.
  - A breach is capture progress, or an eligible enemy within `command_radius_m` + 40 m. It forces
    the alarm. Every own infantry / vehicle within 400 m becomes a home guard and makes for the
    point. Crews keep their posts.
  - Units of recalled fronts within 1.5 km also converge, unless the defence is hopeless.
- **Forecast**:
  - `garrison` counts eligible infantry fully and crews, vehicles and fixed MGs at × 0.5.
  - `eta` is the nearest aimed group's ETA (groups ≥ 150 value); `etaMean` keeps the old value.
    The nearest ETA decides "at the gates". The recall march window keeps the mean ETA, because
    the nearest ETA shrank the window and stopped distant groups from being recalled.
- **Alert**: `homeThreat.alert` / `alarmLevel` count only contact, aimed groups inside 900 m, and
  aimed closing groups with ETA ≤ 240 s.
  - The early alarms (≈ 1 min) were AI fronts marching out on a capital axis 900–2400 m away,
    with ETA 850–1070 s.
  - `active` (readiness, drives recall) keeps the wide forecast. Gating recall on the narrow
    alert lost 4 more capitals in the lab, so it is kept as the switch `ROUND7_AB.alarm` = off.
- **Hopeless** (lead rule, wars must end): the defence is hopeless when the forecast is ≥ 1.5 ×
  our army, or the main attacker's whole known army is ≥ `HOME.hopelessArmyRatio` (2) × ours.
  Then every recalled front is released and the capital keeps only its standing garrison, HQ
  squads and home guards.
- **Finisher** (lead rule): `theatre.orderFront` orders every front of the finisher to `attack`
  the finish capital, with no stances. `command.assignOccupations` sends no occupation
  detachments and returns those already out. Rear guards and raids were already off for a
  finisher in `operations.ts`.
- **Player attack fronts can assault** (`fronts.ORDER_ASSAULT`, `orderedAssault`): `cityai` never
  runs for players. The rule is assault when aggression ≥ assaultAll; or when the front is the
  main effort and aggression ≥ assaultMain or it is strong (> 900); or when it outweighs the
  known defence at the objective by 1.5×. Postures hold ≥ 45 s. An identical manual order given
  again no longer resets the posture or the operation.
- **Rejected**: `theatre.csCommittedAttacked` (counter-strike at 20 % committed while under
  alarm). It cost 2 of 5 soak eliminations with no lab gain, so `ROUND7_AB.counter` is off.

### Results

| | Round 7 off (same tree) | Round 7 final |
|---|---:|---:|
| challenge lab, AI survival (33 matches) | 27 / 33 | 27 / 33 |
| … when not outmatched (≥ 2 × army = legitimate loss) | — | **32 / 33** |
| … `rush_micro` (literal all-in rush, 9 matches) | 5 / 9 | **8 / 9** |
| soak 60 min (7, 11, 13): wars ended | 0 / 3 | 1 / 3 (seed 13, 52.0 min) |
| soak 60 min: eliminations | 5 | **7** |
| soak by 45 min: eliminations (Round 6: 3) | 5 | 4 |

The lead's target of ≥ 2 / 3 wars ended is not met. The two open soak wars at 60 min:
- Seed 7 is a near-even two-way fight (pop 536 vs 658), below the finisher threshold
  (pop ≥ 1.3 ×), which is a balance question.
- Seed 11 is a finisher war in progress (F3 949 vs F1 525 pop, 1.8 ×, F1 down from 65 to 41
  settlements since minute 45) that did not reach F1's capital within the hour.
Anomalies: 2–5 per seed, of the known kinds (home-guard AT guns "unreachable", raiders and
tanks on slopes).

## Round 8: binding orders, more fronts, zone garrisons

User findings (2.1): *"前线指挥官可以设置多位，不必拘泥于三位。甚至每条永备工事可以拥有单独的前线指挥官"*
and *"最高统帅部的指挥命令为强约束，单位需要根据最高统帅部的命令行动，不然人类玩家会感到单位不听指挥"*.
Spec: docs/COMMAND_V2.md §3 (binding column). Measured on frozen copies of the shared
`feat/fortress-war` tree (fortress / ui2 work included on both sides); "off" is the same snapshot
with the fronts agent's files at b23f42c.

### Changes

**Binding orders** (`frontref.boundOrder` = `manual && kind ≠ auto`; `boundLine` = not attack):
- No detachments from a bound front: `command.assignGarrisons` (busy set), `assignOccupations`,
  `operations.planOperations` (rear guard and raid pools), `cityai.balanceReserves` (reserve
  shift). Detachments already out come back (`fronts.recallDetachments`, on the order and every
  front think); the capital's guards (`hq:` garrison) are exempt (user rule 8).
- `attack`: no `outmatched` / leaderless hold; `eagerPush` always pushes after a massing wait of
  at most 30 s (`BOUND_MASS_WAIT_S`); river staging kept; flank / pincer / infiltrate / siege
  still allowed toward the ordered objective.
- `defend` / `fortify` / `fallBack`: no manoeuvre op (`holdOperation`: frontal, phase ''), no
  spearheads, nobody waits at the rally point, crews take line slots (no `crewPost`), no truck
  hunts or escorts away from the line (`behavior.thinkRaid` / `thinkEscort` skipped). On a
  `fallBack` the front's town garrisons come back too.
- Ordered lines man the works on them first (`fronts.manWorks` with `structures.structureSlots`,
  within `STRUCT.zoneSlotM`): free building slots, then trench bays, nearest squads.
- Visibility: a bound front's `reason` is `reason.order.<kind>` (except river staging / massing
  wait); its units' status is `status.orderAttack` / `status.orderMove` / `status.orderHold`.
- Home recall: a bound front is recalled only at the gates (breach, or nearest aimed ETA ≤
  `HOME.gatesEtaS`) and only if its order predates the alarm (`homeguard.recallable`); order and
  line are untouched by the recall, the objective is restored after it. A new manual order ends
  that front's recall (`releaseRecall`). (Before: manual fronts were never recalled.)

**More fronts** (`theatre.desiredFronts`): wanted = max(one per neighbouring enemy capital ≤
troops / 12, the 2.0 rule min(strong axes, troops / 20), troops / 28), ≤ `fronts_max` (8); kept
by the same rule with troops / 12 and troops / 20 (hysteresis below the opening rule). A new front
needs ≥ 14 free troops (was 20: mid-game only 20–70 of 100–130 troops are free). With every axis
covered, an extra front goes for the HQ's best attack objective ≥ 600 m from every front
(`extraObjective`). Seed 7 at 30 min: the strongest faction (154–219 troops) runs 5–7 fronts, a
100–120-troop faction 4, the weak ones 2–3.

**Zone garrison fronts** (`theatre.garrisonZone`): a zone with ≥ 1 finished pillbox / bunker
within 60 m of its line and no front holding a line within 300 m gets its own front (≤ 2 per
faction) when ≥ 6 free squads exist: 8 troops nearest the zone, named after the nearest
settlement, on a standing *binding* `defend` of the zone's line. Released (to `auto`) when the zone
is cancelled, unmanned or re-bound, or the faction becomes the finisher; never merged; reinforced
only when pressed (share × 0.2).

**AI fortified zones** (coordinator request; fortress agent's bunkers never showed in soaks):
`theatre` now fortifies (a) a quiet `defend` line about to be released and (b) a quiet, freshly
held town / city objective (a line 60 m beyond its edge toward the nearest enemy capital), when a
free engineer is within 450 m, the faction has < 3 live zones and none within 500 m. Soak: zones
0–3 per faction by 45 min, first bunkers built (were 0 in every soak).

**Capital defence** (`storm.capitalDefence`, coordinator request): pillboxes / bunkers count only
by their manned share (living occupants ÷ capacity), so empty concrete no longer deters a storm.

**Fixes**: `frontops.createFrontAt` (player `newFront`) adopted troops nearest the *settlement*
instead of the point, and pre-set the same manual order, which made the command's `defend` a
"repeat" that kept the front 'cautious'. It now adopts every free unit within 350 m of the point
(a bound donor keeps half) and the order applies the hold posture.

### Results

Challenge lab (`--strategy rush,human_like,rush_micro --seeds 7,11,13 --minutes 40`, plus
`rush_micro --rushAt 180`), same snapshot, binding orders off → on:

| strategy (3 seeds × 40 min) | off | on (final) |
|---|---|---|
| rush@5m | 67 % | **100 %** |
| human_like | 100 % | 100 % |
| rush_micro@5m | 100 % | 100 % |
| rush_micro@3m | 100 % | 100 % |
| **all 12** | 11 / 12 | **12 / 12** (12 / 12 not outmatched) |

The challenger's front orders are now binding (no outmatched hold, pushes after ≤ 30 s), so it
attacks harder; the AI still holds every capital and took the challenger's capital in 11 of 12
matches. Round 7's open `rush_micro@3m` seed-13 loss (hopeless verdict at 1.4 × forecast, recall
released 6 min before the fall) no longer reproduces on either side of the A/B — the fortress
round's manned capital buildings changed that match — so `HOME.hopelessRatio` was left alone.

Soak (`npx tsx scripts/soak.ts 45 7,11,13`):

| | off | on (final) |
|---|---:|---:|
| eliminations by 45 min (7 / 11 / 13) | 2 / 2 / 2 = 6 | 2 / 2 / 2 = **6** |
| anomalies per seed | 4 / 6 / 0 | 1 / 7 / 0 |
| zones per faction at 45 min | 0 | 0–3 |
| bunkers built | 0 | 1–2 per seed |

Round 7 had 4 eliminations by 45 min and 2–5 anomalies per seed. The anomalies are the known
kinds (home-guard AT guns "unreachable", a commander stuck on a slope, occupation squads on
slopes) plus the fortress invariant `fort#… occupant … is dead`, repeated each second while it
lasts (4 of the 7 on seed 11).

Performance (`npx tsx scripts/perf.ts generated 600 7`): 1.2 ms per tick, p99 9.4 ms (off
snapshot 1.4 / 10.7 with older data and 10 % more units). The new work is per front think
(O(front units) for detachments, O(slots × squads) for works) and per HQ think (zones).

### Open issues

- Units on a bound line still follow `structures.structureDuty` (engineer jobs, seeking a free
  building within `seek_radius_m`); an engineer with a job elsewhere leaves the line.
- The player can not move units between fronts; a `newFront` next to a bound front takes only
  half of its free troops.
- `fort#… occupant … is dead` (fortress code) is the largest anomaly source.
- New i18n keys needed: `status.orderAttack`, `status.orderMove`, `status.orderHold`.
- Lab helpers: `scripts/lab/fronts21-diag.ts [seed] [minutes] [every]` prints every faction's
  fronts (order, `!` binding, `Z` zone garrison, troops), zones, troops / free / wanted fronts.
