# Challenge lab — can the AI survive a scripted strategy?

User request (2.0): *"build a mechanism to test if the AI could handle different strategies; in
some game I just let all units attack the capital, then it wins."*

`scripts/challenge.ts` plays one faction (the **challenger**) with a scripted supreme-HQ strategy
and lets the normal AI play the other three. The challenger uses only the public command API, the
same calls the UI makes: `CommandBus.issue(match, actor, cmd)` and `bus.flush(match)` before every
`step`, like `sim.worker.ts`. It sends `frontOrder`, `setMainFront`, `setWeight` and `setCap`. It
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
  `isPlayer` switches off `cityai.thinkCity` (production mix and postures), `theatre.thinkTheatre`
  (dynamic fronts and AI orders) and the engineer requests in `fortplans` for that faction. Everything else still runs for
  it, the same as for a human: front commanders, home defence forecast and standing garrison, and
  the economy steward.
- The run is deterministic per seed: strategies read only world state, use no RNG and no clock,
  and act once per game second.
- Smoke test: `npx vitest run tests/challenge.test.ts` (a 2-minute rush on seed 7).

## Strategies (`scripts/challenge/strategies/`)

| id | production (`setWeight` / `setCap`) | orders |
|---|---|---|
| `rush` | infantry, motor inf, light / medium / heavy tanks only | auto fronts until `--rushAt` (default 300 s), then every front gets `attack` on the nearest enemy capital, the first front is made main, and the order is re-issued every 60 s. Never defends. Once a capital falls it moves on to the next nearest. |
| `turtle` | infantry, engineers, MG, AT, mortars | every front gets `fortify` on a point 400 m from the capital toward that front's initial objective. At 25 min it switches to a tank mix and all fronts `attack` the capital of the weaker (by army value) of the two nearest neighbours. |
| `two_axis` | balanced | every 90 s two fronts each `attack` a different neighbour's nearest town (village at 1.5× distance, its capital once nothing else is left). The third front `defend`s 350 m out. Each front is matched to the neighbour whose bearing is closest to its axis. |
| `raid` | motor inf, light tanks, recon | every 60 s each front `attack`s the least defended enemy village or town ≥ 900 m from its owner's capital, nearest first, using omniscient defence values. Two fronts never take the same target. |
| `late_blitz` | armour heavy | `fortify` 450 m out until 15 min, then every front `attack`s the nearest capital with `setMainFront`, re-issued every 60 s. |
| `rush_micro` | as `rush` | no front orders. From `--rushAt`, every 60 s, *every* combat unit gets a unit-level `unitOrder attackMove` on the nearest enemy capital. This is the literal "select all, attack the capital", bypassing the front commanders. |
| `human_like` | balanced, tank leaning | every 30 s: (1) if ≥ 300 hostile value is within 900 m of home and outweighs 0.8× the home value, the front nearest home `defend`s toward it. (2) After 12 min it strikes a neighbour (one of the two nearest) whose capital area holds < 40 % of its army, when our army is ≥ 2.2× that capital's defence and ≥ 0.8× their army. The strike continues until the capital falls or our army drops below 50 % of its value at launch. (3) Otherwise each front `attack`s the best cheap place: value ÷ defence ÷ distance. |

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
