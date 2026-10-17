# WP-A status — AI doctrines (作战风格), music wiring, doctrine_* strategies

Branch `worktree-agent-ac07b57b1ae15b872` (based on feat/v3.0 68f663a). Spec: docs/V30_SPEC.md §1.

## Done
- rules.json `doctrines` block + `src/data/doctrineRules.ts` (types, validation in loader).
- `src/sim/doctrines.ts` (ids, profile levers, seeded assignment, contact/reveal), `src/sim/doctrineai.ts`
  (doctrine directive: defence thresholds, late / strike / battle offensives).
- Hooks (a few lines each): sim.makeFaction (doctrine, personality, caps), directive.chooseDirective,
  cityai (production, main share), econai (invest weight), command.assignOccupations (occupy), behavior.needsRetreat,
  econwar / operations (raid cadence), theatre.restructure (front density), compliance (temperament), armour.armourFront,
  events.noteHit (contact).
- Lab `scripts/lab30/doctrine.ts` + `doctrineReport.ts`.

## Baseline (feat/v3.0 68f663a, soak 45 min seeds 7,11,13, 4-FFA medium)
- 3 eliminations in 135 min = 1.33 / h (seed 7 none, seed 11 F0 at ~38 min, seed 13 F0 + F3).

## Next
- UI: custom-game doctrine selector, faction-card flavour line, i18n; music wiring in game.ts.
- doctrine_* challenge strategies; tests/doctrines.test.ts; docs/DOCTRINES.md; tuning from the lab.
