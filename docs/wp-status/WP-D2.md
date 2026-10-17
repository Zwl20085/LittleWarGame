# WP-D2 - transport commands, Engineering HUD, AI wiring: status

State: complete (see the lead report). Base feat/v3.0 1344bd5.

- Commands (`src/sim/commands.ts`): `buildRoad {a,b}`, `repairRail {lineId}`, `extendRail {stationIdx, to}` (objective index).
  Failures: TOO_LONG, BAD_TERRAIN, NOT_CUT, JOB_BUSY, NOT_HELD, HAS_STATION, TRANSPORT_OFF, INSUFFICIENT_M, OUT_OF_BOUNDS, BAD_VALUE.
- HUD: `src/ui/engineering.ts` (popover, key I, also a button on the economy panel); map picks via `ctx.mode = {kind:'engineer'}`
  handled in `input.ts` (`finishEngineer`): road = click, click (or press-drag); extend = own station, then own town.
- Minimap: rail lines in the running faction's colour, cut = red dashed, stations as ticks.
- AI: `thinkTransport(world, f, extraSites)` in `transportjobs.ts`, called from `command.thinkHighCommand`
  (30 s gate, one open job, free engineer, stock >= 3x road cost). `transportSecond` now only assigns engineers and drops stale jobs.
  Seam: pass WP-F zone positions as `extraSites` in command.ts when `econZones` exists.
- Unit status: rail.ts already sets `status.ridingRail` / `status.awaitingTrain`; the selection panel shows `u.status`.
- Mirror note: the main-thread mirror has no job list, so the popover shows free engineers only.
