# Command hierarchy 2.0 — supreme HQ, fronts, front commanders

User decision (2026-10-04) for the 2.0 version. This is the team spec: what the data model is,
what each layer decides, which files own what, and how to verify. It replaces the fixed
left / centre / right "sector" design of 1.x.

## 1. The three layers

| layer | who | decides | does **not** decide |
|---|---|---|---|
| **Supreme HQ** (最高统帅部) | the player, or the AI planner (`command.ts`) | war effort (production mix, economy), how many fronts and where, one standing **order** per front, the main effort, the capital's standing garrison and fortification | postures, battle plans, formation, which cover to use |
| **Front commander** (前线指挥官) | `fronts.ts` + `doctrine.ts`, embodied by one `commander` unit per front | objective inside the order, posture, battle plan (frontal / flank / pincer / infiltrate / siege), battle line and slots, crossings, spearheads, when to dig | production, other fronts |
| **Units** | `behavior.ts`, `combat.ts` … | targets, cover, bounds, digging | — |

The player's whole job is the first row. Everything in the second row is automatic and is
explained in the UI (front reason text) but is not a control.

## 2. Data model (`src/sim/types.ts`)

```ts
type OrderKind = 'auto' | 'attack' | 'defend' | 'fortify' | 'fallBack';
interface FrontOrder { kind; a: V2; b: V2 | null; issuedAt; manual }   // b = line order
interface FrontLine  { a: V2; b: V2 }
interface Front {
  id; name /* settlement id it is named after */; wing: -1|0|1;
  commanderId: number | null; commanderLostAt: number;
  order: FrontOrder; line: FrontLine | null;
  … all the 1.x planner fields (share, posture, targetPos, slots, op, opPhase, …)
}
Faction.fronts: Front[]; Faction.mainFront: number; Faction.frontSeq: number;
Unit.frontId: number   // -1 is never stored; ProductionOrder.frontId -1 = "pick on roll-out"
```

- Front ids are stable for the match. Today `id === index` in `f.fronts`; use `frontById(f, id)`
  (`fronts.ts`) so fronts can be created / dissolved later without breaking consumers.
- `rules.command` (`docs/data/rules.json`): `commander_unit`, `fronts_initial`, `fronts_max`,
  `commander_respawn_seconds`, `commander_lost_hold_seconds`, `commander_post_radius_m`,
  `capital_standing_garrison`, `capital_line_works`.
- The `commander` unit (`units.csv`): HP 2400, 4 staff, pistols only, population 1. It is
  **appointed** by the supreme HQ (`fronts.appointCommander`), never produced: the production
  bar hides it and `queueUnit` rejects it. `formulas.isCommander` — every strength sum skips it.

## 3. Order semantics (`fronts.issueFrontOrder`)

| order | line | objective | posture | engineers | binding (player, `manual: true`) — 2.1 |
|---|---|---|---|---|---|
| `auto` | none | commander picks (`nextTarget`, HQ attack bias) | commander picks | as 1.x | not binding: the 1.x / 2.0 freedoms |
| `attack a[,b]` | a–b if given | `a` (or the line's centre); an enemy capital there → `targetCity` | cautious → assault by aggression | — | the front goes: no `outmatched` / leaderless hold, `eagerPush` always pushes after a massing wait ≤ 30 s (`BOUND_MASS_WAIT_S`), river staging kept; flank / pincer / infiltrate / siege only toward the ordered objective; spearheads allowed |
| `defend a[,b]` | a–b (a point: 240 m line through `a`, square to the capital bearing) | line centre | hold | — | every unit takes a slot on the (terrain-snapped) line, crews included (no `crewPost`); nobody waits at the rally point; no push, spearhead, manoeuvre op (`op` frontal, phase ''), truck hunt or escort away from the line; targets only from the line |
| `fortify a[,b]` | same | same | fortify | build trench / pillbox / bunker along the line (a permanent zone, `fronts.addZone`) | as `defend` |
| `fallBack a[,b]` | same | same | hold | — ; every unit drops spearhead / op roles and marches back first | as `defend`; town garrisons of the front come back too |

While an order stands (`orderedTarget(s)`), the commander does not retarget. `planFront` holds a
line order *along the ordered line* (`lineCells`) instead of the computed front segment.

**Binding orders (2.1, user: "最高统帅部的指挥命令为强约束")** — `frontref.boundOrder(s)` = `manual && kind ≠ auto`:
- No detachments are drawn from a bound front: town garrisons (`command.assignGarrisons`),
  occupations (`assignOccupations`), raids and rear guard (`operations.planOperations`),
  reserve shifts (`cityai.balanceReserves`). Detachments already out come back
  (`fronts.recallDetachments`, on the order and every front think).
- Exempt (user rule 8): the capital's standing garrison and HQ-point squads (`homeguard.keepStanding`,
  `assignHolders`, breach convergence) are still drawn from any front.
- Home recall: a bound front is recalled only at the gates (a breach, or the nearest aimed group's
  ETA ≤ `HOME.gatesEtaS`) and only if its order predates the alarm (`homeguard.recallable`).
  The recall keeps `order` and `line`; `restoreOrders` returns the objective afterwards. A new
  manual order to a recalled front ends its recall (`homeguard.releaseRecall`).
- The front's `reason` shows the order (`reason.order.<kind>`) except for a river staging /
  massing wait; its units' status reads `status.orderAttack` / `status.orderMove` /
  `status.orderHold` instead of advancing / holding.
- AI fronts (`manual: false`) are not bound, except the AI's fortified-zone garrison fronts
  (`theatre.garrisonZone`), which get a standing binding `defend` on the zone's line.

`newFront {a}` (2.1): `frontops.createFrontAt` opens a front named after the nearest settlement,
appoints its commander (P), adopts every free unit within 350 m of `a` (a bound donor front keeps
half of its free troops), and the command then gives it a binding `defend` at `a` (posture hold).

Player commands (`commands.ts`): `frontOrder {frontId | null, kind, a, b?}` (null = nearest
front to `a`), `setMainFront`, `queueUnit {frontId: -1 | id}`, economy and unit micro as before.
Removed: `setPosture`, `setOperation`, `setSectorTarget`, `setShares`, `regroupSector`,
`setUnitSector`.

## 4. Commander lifecycle

- Appointed at the capital exit when the front is created; walks to `commanderPost`: the nearest
  own town / city (villages at 1.3× distance) within `commander_post_radius_m` of the front's
  line, else the capital exit. Fights only in self-defence; withdraws toward the capital when
  armed enemies reach its post (`behavior.thinkCommander`).
- Killed → `log.commanderLost`; the front is **leaderless** for `commander_lost_hold_seconds`
  (`planFront` treats it as outmatched: hold, no push, no spearheads); after
  `commander_respawn_seconds` a replacement is appointed if P ≥ its cost.

## 5. What the agents build on this (owners)

| task | owner | files (own) | must not touch |
|---|---|---|---|
| AI supreme HQ: dynamic fronts (create / merge / dissolve up to `fronts_max`), reinforcement allocation, orders for its own fronts; front commander tactics on ordered lines; capital standing garrison | **fronts** | `fronts.ts`, `doctrine.ts`, `cityai.ts`, `command.ts` (planner parts), `homeguard.ts` **forecast / recall only**, `operations.ts`, `storm.ts`, `convoy.ts`, `production.ts` (`pickFront`), `events.ts`, `snapshot.ts` (front clone), `behavior.ts` **except** `thinkEngineer` / `siegeDig`, `tests/fronts.test.ts` | UI, render, works code |
| Defensive buildings: pillbox / bunker / fortified zone, engineer construction, garrisoning, capital line (`capital_line_works`) | **works** | `works.ts`, new `structures.ts`, `engineering.ts`, `behavior.ts` **`thinkEngineer` / `siegeDig` only**, `homeguard.ts` **`fortifyHome` / `ensureDiggers` / `thinkHomeGuard` / `fortifyPlace` only**, `damage.ts` + `movement.ts` (occupancy), `render/fieldWorks.ts` or new `render/structures.ts`, `render/models.ts`, `rules.json` `construction`, `tests/structures.test.ts` | fronts planner, UI |
| Player orders UI | **ui** | `src/ui/*`, new `render/orderLines.ts`, `renderer.ts` (hook only), `render/unitViews.ts` / `icons.ts` (commander marker) | sim logic |
| Visual effects | **visuals** | `render/effects.ts`, `particles.ts`, `artilleryFx.ts`, `fxTextures.ts`, `shellTrails.ts`, `townFires.ts`, `atmosphere.ts`, `unitModels.ts` (commander model) | sim, UI, works models |

Shared rules: re-read a file right before editing it; edit only your functions; never reformat
or rewrite whole files others own; keep `npx tsc --noEmit` and `npx vitest run` green; the sim
stays deterministic (no `Math.random`, no Date, no wall-clock); perf budget per
`docs/PERFORMANCE.md` (mean tick ≤ 2.5 ms at 500 units; nothing per tick per unit that is O(n)).

## 6. Verification

- `npx vitest run` (51+ tests), `npx tsc --noEmit`.
- `npx tsx scripts/soak.ts 45 7,11,13` — anomalies list must not grow (stuck / unreachable).
- `npx tsx scripts/strategy.ts --seeds 7,11,13 --minutes 30` — op success, captures per minute.
- `npx tsx scripts/perf.ts generated 600 7` — mean / p99 tick.
- New: `scripts/challenge.ts` (challenge agent): scripted supreme-HQ strategies through the
  real `frontOrder` API against the AI.
