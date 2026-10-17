# WP-A status — AI doctrines (作战风格), music wiring, doctrine_* strategies

Branch `worktree-agent-ac07b57b1ae15b872`. Spec: docs/V30_SPEC.md §1. feat/v3.0 (c26da27, zones/works +
roads/rail) merged in at 82d3a6e.

## Done
- b9f5c99 rules.json `doctrines` block + `src/data/doctrineRules.ts` (types, loader validation);
  `src/sim/doctrines.ts` (ids, levers, seeded assignment, contact/reveal); `src/sim/doctrineai.ts`
  (doctrine directive: defence thresholds, late / strike / battle offensives; `doctrineChoice` for strategies).
  Hooks: sim.makeFaction, directive.chooseDirective, cityai, econai, command.assignOccupations,
  behavior.needsRetreat, econwar / operations, theatre.restructure, compliance, armour.armourFront, events.noteHit.
- 39058d3 UI: per-AI doctrine selector (custom game, zh+en, random), faction-card doctrine line (topbar,
  after first battle or reveal_s); `src/ui/musicCues.ts` wired in game.ts (theme, offensiveLaunched,
  capitalLost, quiet); `scripts/challenge/strategies/doctrine.ts` (doctrine_builder|blitz|attrition|maneuver,
  registered); `tests/doctrines.test.ts` (13 tests); blitz retuned (balanced personality + armour/motor mix).
- 82d3a6e merge: econai passes the un-doctrined appetite to `thinkZones` and sets `setInvestStyle(f, invest)`
  for doctrine AIs (the doctrine is the zone investment style). Lab uses `scripts/lab30/runner.ts`.

## Lab (pre-merge v4, 36 duels both slot orders + 3 FFA, 45 min)
- overall win/loss: builder 43/38 %, blitz 38/43 %, attrition 43/19 %, maneuver 29/52 % (acceptance < 75 %).
- baseline soak 45 min 7,11,13 (68f663a): 3 eliminations / 2.25 h = 1.33 / h.

## Running / next
- v5 lab on the merged tree; FFA on/off 6 seeds for eliminations/hour; challenge --all; soak.
- docs/DOCTRINES.md + STRATEGY_LAB section; screenshots of the selector and the card line.
