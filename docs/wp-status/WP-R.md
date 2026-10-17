# WP-R status: refactor splits (behaviour-preserving)

Done. Three splits, one commit each. `npm run typecheck`, `npm test` (43 files / 364 tests) and `npm run updater:e2e` (8/8) green.

| File | Before | After |
|---|---|---|
| `src/sim/commands.ts` | 309 | 136 (dispatcher + types + bus) + `commands/{shared,production,directive,units,transport,upgrades}.ts` |
| `electron/updater.cjs` | 362 | 135 (context + IPC bridge) + `updateCheck.cjs` 181 + `updateServe.cjs` 92 |
| `src/sim/railgen.ts` | 134 | 156 (`candidateLinks`, `stationPlacer`, `settlementGrid` extracted; `generateRails` ~30 lines) |

Notes:
- Shared command helpers (`fail`, `OK`, `finiteV2`, `validUnitIds`, `producibleId`) live in `commands/shared.ts` (not `commands.ts`) to avoid a runtime import cycle; the fail-reason map for engineer jobs moved with its handlers to `commands/transport.ts`.
- Updater halves share one mutable `ctx` object (serving, win, status, pending, ...) built in `updater.cjs`.
- Rails: `MapDef.rails` + `stations` hashed (sha256) for seeds 7 and 11 x {2,4 factions} x {small, medium, large} before and after: identical.
