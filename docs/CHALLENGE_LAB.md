# Challenge lab — can the AI survive a scripted strategy?

User request (2.0): *"build a mechanism to test if the AI could handle different strategies; in
some game I just let all units attack the capital, then it wins."*

`scripts/challenge.ts` plays one faction (the **challenger**) with a scripted supreme-HQ strategy
and lets the normal AI play the other three. The challenger uses only the public command API, the
same calls the UI makes: `CommandBus.issue(match, actor, cmd)` and `bus.flush(match)` before every
`step`, like `sim.worker.ts`. It sends `setDirective` (2.2: one universal directive), `setWeight` and `setCap`. It
never writes to the world. The report shows whether the AI keeps its capital and how it defended:
alarm, recall, works, garrison and counter-attack.

## Running it

```
npx tsx scripts/challenge.ts --strategy rush --seeds 7,11,13 --minutes 40 --jobs 6
npx tsx scripts/challenge.ts --all --seeds 7,11,13 --minutes 40 --jobs 6          # every strategy
npx tsx scripts/challenge.ts --strategy rush --rushAt 180,300,600 --seeds 7,11,13  # rush at 3 / 5 / 10 min
npx tsx scripts/challenge.ts --all --rushAt 300,180,600 --seeds 7,11,13 --jobs 8  # the baseline: all + rush variants
npx tsx scripts/challenge.ts --strategy turtle,raid --challenger 2                  # another slot
npx tsx scripts/challenge.ts --strategy rush,rush_micro --fog --seeds 7,11,13       # AI factions in fog of war
```

- Each match runs in its own child process (`--jobs`, default 6). A 40-minute match takes about
  1–4 min of wall time.
- The raw report for each match goes to `media/stats/challenge-runs/<strategy>[-<rushAt>]-c<slot>-<seed>-<min>m.json`.
  The Markdown report goes to `media/stats/challenge-<timestamp>.md`, and the script also prints
  the summary table.
- `--fog` runs the match in fog of war: the AI factions only know what they see. The challenger
  still reads the world, so it stays omniscient. Report labels get a `/fog` suffix.
- Setup: generated map, 4 factions, `open` information (unless `--fog`), `normal` difficulty, default personalities
  (slot id % 5). The challenger is `playerSlot` with `spectate: false`, so it is a player faction.
  `isPlayer` switches off the production mix in `cityai.thinkCity` and the AI's directive choice
  (`directive.chooseDirective`) for that faction. 2.2: its fronts are opened / merged / dissolved by
  `theatre.thinkTheatre` and answer its directive like everyone else's. Everything else still runs for
  it, the same as for a human: front commanders, home defence forecast and standing garrison, and
  the economy steward.
- The run is deterministic per seed: strategies read only world state, use no RNG and no clock,
  and act once per game second.
- Smoke test: `npx vitest run tests/challenge.test.ts` (a 2-minute rush on seed 7).

## Strategies (`scripts/challenge/strategies/`)

| id | production (`setWeight` / `setCap`) | orders |
|---|---|---|
| `rush` | infantry, motor inf, light / medium / heavy tanks only | `advance` until `--rushAt` (default 300 s), then a general `offensive` with the nearest enemy capital as the axis (checked every 60 s). Never defends. Once a capital falls it moves on to the next nearest. |
| `turtle` | infantry, engineers, MG, AT, mortars | `fortify` with a 300 m line drawn 400 m out across the nearest enemy's approach (a fortified zone; every other front fortifies its own line). At 25 min it switches to a tank mix and an `offensive` on the capital of the weaker (by army value) of the two nearest neighbours. |
| `two_axis` | balanced | every 90 s an `offensive` whose axis alternates between the two nearest neighbours' nearest towns (village at 1.5× distance, its capital once nothing else is left). |
| `raid` | motor inf, light tanks, recon | every 60 s an `offensive` with the least defended enemy village or town ≥ 900 m from its owner's capital as the axis, nearest to home first, using omniscient defence values. |
| `late_blitz` | armour heavy | `fortify` (a line 450 m out) until 15 min, then an `offensive` on the nearest capital, checked every 60 s. |
| `rush_micro` | as `rush` | no directive. From `--rushAt`, every 60 s, *every* combat unit gets a unit-level `unitOrder attackMove` on the nearest enemy capital. This is the literal "select all, attack the capital", bypassing the front commanders. |
| `human_like` | balanced, tank leaning | every 30 s: (1) a strike under way continues (an `offensive` on that capital) until the capital falls or our army drops below 50 % of its value at launch. (2) If ≥ 300 hostile value is within 900 m of home and outweighs 0.8× the home value: `defend` with the threatened approach as the axis. (3) After 12 min it strikes a neighbour (one of the two nearest) whose capital area holds < 40 % of its army, when our army is ≥ 2.2× that capital's defence and ≥ 0.8× their army. (4) Otherwise an `offensive` on the best cheap place: value ÷ defence ÷ distance from home. |

## Adding a strategy

1. Create `scripts/challenge/strategies/<name>.ts` and export a `Strategy`
   (`scripts/challenge/types.ts`): `id`, `summary`, `setup(ctx)` (called once, before tick 0) and
   `tick(ctx)` (called once per game second while the challenger is alive).
2. Act only through `ctx.issue(cmd)`. The helpers in `scripts/challenge/worldq.ts` cover the usual
   calls: `setMix`, `order`, `orderAll`, `frontIds`, `enemiesByDistance`, `armyValue`, `valueNear`,
   `hostileNear`, `frontCentre`, `towards`. The ones in `strategies/common.ts` cover `holdRing`,
   `weakestNeighbour` and `allOnCapital`. Keep per-match memory in `ctx.state`.
3. Call `ctx.markAttack(enemy)` when the strategy commits to an enemy capital. That sets the
   match's "attack" time and the AI faction the report is about. Without it, the report looks at
   the AI whose capital is nearest.
4. Register the strategy in `strategies/index.ts` and in the id list in `tests/challenge.test.ts`.

## Reading the report

**Summary per strategy**

- **AI survival**: the share of matches in which the challenger took no AI capital within the
  time cap. This is the headline number. Anything below 100 % means a scripted, non-adaptive plan
  beat the AI.
- *challenger capital lost*: how often the AI punished the strategy.
- *mean attack / mean arrival*: when the strategy launched its capital attack, and when it first
  stood at the target capital. Arrival is measured after the launch (any time for strategies that
  never launch one). It means capture progress > 0, or a challenger value (P+M × hp share) within
  600 m of at least max(300, 25 % of the challenger's army).
- *alarm delay after attack*: the target AI's first `homeThreat.active` after launch, minus the
  launch time. 0 means the alarm was already on. *alarm ≤ arrival* counts the matches where the
  alarm came before the attackers arrived.
- *defence ÷ attacker at arrival*: `storm.capitalDefence(world, challenger, target)` (known units
  ≤ the storm radius plus finished trenches and sandbags) divided by the challenger's value within
  600 m.
- *target alarm on*: the share of the target AI's alive time with `homeThreat.active`. A value near
  100 % means the alarm is permanently on, so it says nothing about the real attack.
- *max capture progress*: the most capture seconds the challenger reached on the target capital
  (`victory.command_capture_seconds`, currently 45 s, takes it). Only *eligible* infantry
  (infantry / recon / engineer, ≥ 50 % hp, not suppressed or routing) inside `victory.command_radius_m`
  (35 m) captures the HQ or blocks a capture. Tanks, crews and fixed MGs do neither.
- *verdict*: `AI holds` (100 %), `AI shaky` (≥ 50 %) or `AI BEATEN` (< 50 %).

**Per match.** The target is the AI that the strategy attacked, or else the nearest AI. Columns:

- first alarm at any time, and the first alarm after the attack;
- the alarm's share of time and its number of onsets;
- max `homeThreat.level`;
- distinct fronts recalled (and the peak number recalled at once);
- peak finished works within 300 m of the capital, by kind;
- peak challenger value within 600 m (and when), and max capture progress;
- defence and attacker value at arrival, `homeThreat.garrison` at arrival, and whether the alarm was
  on at arrival (with the number of groups recalled);
- AI fronts with `targetCity === challenger`, at first and after the attack (counter-attack);
- capitals the challenger took, and its own fall;
- units lost by both sides;
- the result.

**Timelines**: every capital the challenger took, then the two closest calls (most capture
progress). The rows are every 30 s from 1 min before the attack and show the target AI's
`homeThreat` (level, alarm, forecast `enemy`, eta, recalled groups, garrison, works),
`capitalDefence`, the challenger's value within 600 / 1 500 m, the AI's own value within
1 500 m, both armies, capture progress, and the eligible infantry of each side inside the 35 m
HQ radius (*HQ point holders*). Rows come every 5 s while the challenger is at the gates. This is the place to read *why* a capital fell.

**Settlements held**: F0 / F1 / F2 / F3 every 5 min.

**Rejected commands**: should be `none`. Any entry means a strategy sent an order that the real
validation refused (`UNREACHABLE`, `NO_FRONT` …), so its plan did not happen as written.

## Caveats

- The challenger is omniscient (open mode) and reacts on exact values. It is a stress test, not a
  model of a human.
- Since Round 7, player fronts on an `attack` order switch between cautious and assault by the
  same rule `cityai` uses for the AI (`fronts.orderedAssault`). Repeating an identical manual order
  keeps the posture and the operation that is under way.
- `thinkHomeDefence` runs for the challenger too, but manual orders set `manualTarget`, which
  exempts those fronts from recall.

## A/B switches

- `R7_OFF=hqPoint,eta,assault` (or `all`) switches the Round-7 AI fixes off in the match processes.
- `R7_ON=alarm,counter` switches on the two Round-7 variants that were rejected.
- The switches are read by `scripts/challenge/match.ts` and set `homeguard.ROUND7_AB`, and the
  report labels get `/r7off:…`.
- `R7_OFF=… npx tsx scripts/challenge/soak-ab.ts 60 7` runs `scripts/soak.ts` with the same
  switches.
- Other agents edit the sim while the lab runs. For a clean A/B, copy `src`, `scripts`,
  `docs/data`, `package.json` and `tsconfig.json` to a scratch folder with a `node_modules`
  junction, and run both variants there. The runs are deterministic per seed.

## Round 7 results (2026-10-04)

Both columns come from frozen copies of the tree that include the balance agent's attack-side
round (67f3b05): buffed tanks, `STORM.massR` 500 m, and pillbox / bunker values in
`capitalDefence`. "Off" is `R7_OFF=all` on the copy frozen at 17:05. "Final" is the copy frozen
at 18:00, with the lead's rules (hopeless, finisher massing).

| strategy (3 seeds × 40 min) | AI survival, R7 off | AI survival, R7 final | survival when not outmatched, final |
|---|---|---|---|
| rush@3m | 100 % | 67 % | 100 % |
| rush@5m | 100 % | 67 % | 100 % |
| rush@10m | 100 % | 33 % | 100 % |
| turtle | 100 % | 100 % | 100 % |
| two_axis | 100 % | 100 % | 100 % |
| raid | 67 % | 67 % | 100 % |
| late_blitz | 100 % | 100 % | 100 % |
| human_like | 100 % | 100 % | 100 % |
| rush_micro@3m | 67 % | 67 % | 67 % |
| rush_micro@5m | 67 % | 100 % | 100 % |
| rush_micro@10m | 33 % | 100 % | 100 % |
| **all 33 matches** | 27 / 33 | 27 / 33 | **32 / 33 (97 %)** |

- The "off" column comes from the frozen-tree A/B run before the lead's rules were added. The
  final column is `media/stats/challenge-2026-10-04T18-28-44.md`.
- *Not outmatched* counts a capital taken by a challenger with ≥ 2 × the defender's army as a
  legitimate loss. That is the lead's rule: a defender must not hold against 2.5× forever. Every
  rush loss in the final run was at 2.4–12× the AI's army.
- `rush_micro` is the literal "select all, attack the capital". The AI now survives 8/9 of those
  matches, against 5/9 with Round 7 off.
- Front-order rushes win more often. Their fronts can now assault (item 6), which buffs the
  challenger the same way it buffs a human player.

The alarm became a signal. The new `homeThreat.alert` fires 1–5 min after an attack is launched,
and is on 18–72 % of the time. The old readiness alarm `active` is on 51–94 % of the time and is
kept for recall: gating recall on the narrow alert lost 4 more capitals.

## 2.2: directives instead of front orders

The strategies were ported from per-front orders (`frontOrder`, `setMainFront`) to the universal
directive (docs/V22_SPEC.md §1): the scripted supreme HQ picks `offensive` / `advance` / `defend` /
`fortify` / `contract` with an optional axis or fortify line, and the challenger's front commanders
decide their own orders, exactly as for a human player. `worldq.directive` does not re-send a
directive that already stands. The challenger now also gets the theatre's front management and the
AI's posture / reserve rules (cityai) — it is a stronger opponent than the 2.1 challenger.

## 3.0: diversity suite and player-experience metrics (WP-I)

```
npx tsx scripts/challenge.ts --suite diversity --seeds 7,11,13 --minutes 40 --jobs 9 --experience
npx tsx scripts/challenge.ts --strategy armour_raid --variant 15-flank,25-direct --seeds 7
npx tsx scripts/challenge.ts --suite diversity --seeds 7,11 --map-size large --variant 15-flank --experience
npx tsx scripts/challenge.ts --suite diversity --experience-out docs/lab/base-2.2.1-experience.json   # baseline file
```

- `--suite diversity` runs every registered strategy: the old seven (rush / rush_micro at `--rushAt`),
  `armour_raid` in its four variants, `shadow_strike` in open and fog mode, and the rest once.
  `--all` still runs every strategy with its default variant. `--variant a,b` picks variants,
  `--map-size large` runs on the large generated map, `--experience` writes
  `media/stats/lab30/experience-<ts>.{md,json}` (and `--experience-out f` copies the JSON to `f`).
- The unit-level orders the new strategies give (`unitOrder move / moveHold / attackMove`, queued)
  go through the same `CommandBus` validation as a player's; nothing writes to the world.

| id | variants | production | orders |
|---|---|---|---|
| `armour_raid` | `15-direct`, `15-flank`, `25-direct`, `25-flank` (default `15-direct`) | medium / heavy / light tanks + motor inf | saves up under `defend`; at 15 / 25 min, with 20+ tanks and 10+ motor inf (or 5 min later with what it has), the whole column marches to a staging point 1 000 m from the nearest enemy capital (`flank`: via a waypoint half-way, 900 m or more off the road, on the side with less hostile value), attack-moves once 70 % of it has closed up. |
| `shadow_strike` | run it with and without `--fog` (`--suite` does both) | infantry, recon, motor inf, light / medium tanks, support | main army `advance`; from 10 min a detachment of 4-10 foot squads + up to 2 light tanks takes a coarse A* route (50 m cells, seen cells cost 9x) over ground outside every defender unit's vision radius (`route.ts`: units, owned observation points), stages 650 m from the capital and attack-moves in. Relaunched 4 min after it dies. |
| `backdoor` | | balanced, tank leaning | main army `offensive` on the nearest enemy settlement (loud); from 10 min a detachment of capturing infantry worth at most 15 % of the army value takes the shadow route (against all hostile vision) to that enemy's capital. |
| `feint` | | armour heavy | `advance` to 7 min, a loud `offensive` on the nearest enemy's nearest settlement for 3 min, then a general `offensive` on the second nearest enemy's capital. |
| `econ_war` | | motor inf, light tanks, recon | home `defend`; from 7 min raiding groups of 6 (up to 5) attack-move onto the nearest enemy economic building (outside 450 m of its capital) or supply truck, re-tasked every 30 s. |
| `siege` | | howitzers, mortars, infantry, engineers, MG, AT | `fortify` on a 400 m line 45 % of the way to the nearest capital; at 8 howitzers (6-15 min) a general `offensive` on that capital (the front commanders run it as a siege). |
| `ai_only` | | none | no scripted player: all four factions are the AI (spectate). Pacing / one-sidedness baseline. |

Scenario-only hooks: none. Every force is built from normal production and ordered through the command
API, so a strategy that cannot field its force (the `armour_raid` 20+10 column needs population) launches
after 5 min with what it has and reports it that way.

### Metric definitions (`scripts/challenge/experience.ts`, collector `expLog.ts`)

All of it is computed from logged series, never from the match result: army value and territory
(held objectives) per faction every 30 s; sightings, arrivals, capital snapshots every second.
Army value = P + M cost x hp share of combat units (no fixed strongpoints, trucks, commanders).

- **One-sidedness**: share of samples in which one side holds more than 70 % of the total army value;
  lead changes (the leader changes only when the new one has 1.1x the old one's army); largest deficit
  later overturned (share of total army value by which a side trailed the leader before it led itself);
  territory Gini at 15 / 30 / 45 min.
- **Cheap-win index**: for each capital fall, the capturing faction's combat value within 600 m of the
  capital one second before (the *force*), its share of that faction's army, and defender army over force.
  Flagged when the force is under 20 % of the attacker's army or the defender's army is at least 3x the force.
- **Warning time**: an *arrival* is the first time a faction has 400 value within 600 m of an enemy
  capital (or capture progress). First sighting = the earliest time the defender's visibility set held any
  unit of that arriving force within 2 500 m of its capital (a unit unseen for 60 s starts a new sighting).
  Warning = sighting to arrival; reaction = sighting to the defender's `homeThreat.active`;
  defenders in strength = sighting to the defender having half the force's value inside the ring.
  Never seen (in either mode: the sighting is real line of sight, not the AI's information mode) counts as 0 s.
- **Pacing**: first contact (first hostile unit seen by anyone), first non-capital settlement taken,
  first capital lost, eliminations per hour, whether the match was undecided at the end of the run.
- **Engagement health** (share of combat-unit samples every 30 s): idle far from every own front and HQ
  (700 m, no order, no target), stuck (an order or path, no target, moved under 2 m in 30 s),
  supply-starved (`supplyRatio` < 0.5).
- **Score**: each metric gets pass / warn / fail from the bands below, the match score is the weighted
  share of passes (warn counts half) from 0 to 100: PASS at 75 or more, WARN at 50 or more, else FAIL.
  A scenario's score is the mean over its seeds.

| metric | pass | warn | weight |
|---|---|---|---|
| dominated share of time | <= 40 % | <= 60 % | 2 |
| territory Gini at 30 min | <= 0.45 | <= 0.60 | 1 |
| cheap-win capital losses | none | - | 3 |
| warning before a capital loss | >= 90 s | >= 45 s | 3 |
| first contact | 3-15 min | up to 25 min (under 2 min fails) | 1 |
| first capital lost | >= 15 min | >= 10 min | 2 |
| eliminations per hour | <= 3 | <= 5 | 1 |
| idle far / stuck / starved | <= 15 % / 3 % / 25 % | <= 30 % / 8 % / 45 % | 1 each |

### Baseline on 2.2.1 (seeds 7, 11, 13, 40 min, medium map)

Files: `docs/lab/base-2.2.1-experience.json` (medium, 54 matches, 55 min wall at 9 jobs) and
`docs/lab/base-2.2.1-experience-large.json` (large map, seeds 7 and 11, `--variant 15-flank`, 30 matches,
53 min wall at 7 jobs). The *capital falls* column counts every capital that fell, the challenger's own included
(the AI taking the challenger's capital is the common case). *Warning* is the warning time of capital losses
(min / median seconds from first sighting of the arriving force to its arrival at the 600 m ring).

| scenario | score | AI survival (challenger took no capital) | capitals taken by the challenger | capital falls | warning s min / median | never seen | cheap-win flags |
|---|---|---|---|---|---|---|---|
| rush@5m | 93 | 100 % | 0 | 3 | 224 / 226 | 0 | 0 |
| turtle | 89 | 100 % | 0 | 2 | 0 / 112 | 1 | 0 |
| two_axis | 89 | 100 % | 0 | 4 | 0 / 161 | 1 | 0 |
| raid | 93 | 100 % | 0 | 4 | 123 / 237 | 0 | 0 |
| late_blitz | 84 | 100 % | 0 | 4 | 0 / 74 | 1 | 0 |
| human_like | 88 | 100 % | 0 | 1 | 7 / 7 | 0 | 0 |
| rush_micro@5m | 87 | 100 % | 0 | 5 | 213 / 289 | 0 | 1 |
| armour_raid:15-direct | 88 | 100 % | 0 | 3 | 33 / 110 | 0 | 0 |
| armour_raid:15-flank | 88 | 100 % | 0 | 3 | 33 / 110 | 0 | 0 |
| armour_raid:25-direct | 94 | 100 % | 0 | 2 | 110 / 209 | 0 | 0 |
| armour_raid:25-flank | 94 | 100 % | 0 | 2 | 110 / 209 | 0 | 0 |
| **shadow_strike (open)** | 87 | **33 %** | **2** | 5 | 17 / 112 | 0 | 0 |
| shadow_strike/fog | 94 | 100 % | 0 | 5 | 106 / 202 | 0 | 0 |
| **backdoor** | 75 | 100 % | 0 | 2 | 0 / 0 | 2 | 1 |
| feint | 95 | 100 % | 0 | 2 | 288 / 441 | 0 | 0 |
| econ_war | 95 | 100 % | 0 | 2 | 121 / 174 | 0 | 0 |
| siege | 81 | 100 % | 0 | 3 | 0 / 42 | 1 | 0 |
| ai_only (no challenger) | 88 | 67 % (faction 0 is an AI) | 1 | 4 | 0 / 121 | 1 | 0 |

Large map (2 seeds): the same picture. Only `shadow_strike` (open) takes a capital (1 of 2, warning 572 s),
`rush`, `turtle`, `two_axis` and `rush_micro` each lose the challenger's own capital once to an AI with the
attacking force never seen (0 s), nothing is cheap-win flagged. First contact comes at 5-9 min on the large
map against 3:45-4:00 on the medium one.

Reading it:
- Which exploits take a capital today: `shadow_strike` in open mode (2 of 3 medium seeds, 1 of 2 large), with 17-318 s of
  warning in the captures; `backdoor` takes none but its detachment is the only one the defender never saw
  (2 capital losses to AI armies with 0 s, see the `never seen` column, and 1 flagged cheap win). No variant of
  `armour_raid` takes a capital: the 20 tanks + 10 motor inf column is rarely complete (population), and it arrives
  after 33-110 s of warning at best.
- Cheap-win flags: `rush_micro@5m` seed 11 (the capital fell to 18 % of the attacker's army) and one `backdoor` fall.
- Pacing is healthy (first capital falls at 17-39 min, 1-2.5 eliminations an hour, every match undecided at 40 min,
  never dominated for long). The supply-starved share (about 50 % of combat unit samples with `supplyRatio` < 0.5)
  is the one persistent band miss in every scenario and the clearest engagement-health finding.
- `armour_raid` direct and flank give nearly the same numbers: the flank waypoint only moves the staging
  point, and the AI's alarm does not depend on the road. Treat the flank variant as unproven.
- The score never reaches FAIL on 2.2.1 because the weighted bands mostly pass; the signal is in the per-column
  flags (`never seen`, `cheap-win flags`, captures by the challenger).


## 3.0: doctrine_* strategies (WP-A)

`doctrine_builder`, `doctrine_blitz`, `doctrine_attrition`, `doctrine_maneuver`
(`scripts/challenge/strategies/doctrine.ts`): the challenger plays a 3.0 AI doctrine through the
command API only — the production mix and caps of the doctrine profile (`setWeight` / `setCap`),
and every 5 s the doctrine's directive (`doctrineai.doctrineChoice`: defence thresholds, the late /
strike / battle offensive) via `setDirective` when it changes; attrition also sends 4-squad raiding
parties (unit `attackMove`) at the nearest enemy convoy / economic site every 90 s. `DOCTRINES=0`
(env) runs the AI without its doctrines for an A/B.

`--all`, seeds 7 / 11 / 13, 40 min, WP-A head (the AIs have seed-drawn doctrines):

| strategy | AI survival | when not outmatched | first capital taken by the challenger |
|---|---|---|---|
| the seven 2.x strategies | **21 / 21** | 21 / 21 | – |
| armour_raid, shadow_strike, feint, econ_war, siege, ai_only | 100 % | 100 % | – |
| backdoor | 67 % (seed 11: the attrition AI's capital at 37:07) | 100 % | 37:07 |
| doctrine_builder | 67 % | 100 % | 32:59 |
| doctrine_blitz | 67 % | 100 % | 38:28 |
| doctrine_attrition | 100 % | 100 % | – |
| doctrine_maneuver | 100 % | 100 % | – |

`backdoor` with `DOCTRINES=0` on the same tree: 100 % (3 / 3). The one loss is an attrition AI
(retreating damaged units and raiding parties thin its home guard late in the war) — open item.
The doctrine challengers that take a capital do so late, with the army ratio behind them
(`defence ÷ attacker` 1.3–2.1 at arrival, not a cheap win).
