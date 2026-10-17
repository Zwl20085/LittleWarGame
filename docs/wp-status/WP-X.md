# WP-X integration seams

- `RoadNet.linkedToTown(p, maxM, towns)` (roadnet.ts): nearest road within `maxM`, graph-connected to a node at a town.
- `econZones.linkedAt`: with transport on, asks `world.transport.roads` (own-held places, `econ_zones.road_link_m`);
  engineer roads join the graph, so the 10 s relink picks them up. Polyline fallback kept when transport is off.
- `unlinkedZoneSites(world, f)` -> `thinkTransport(..., extraSites)` in command.ts: one road job at a time.
- `scripts/lab30/fgkit.ts` now delegates data loading and the report writer to common.ts (arg reader, RNG, fan-out stay: different protocols).
- Tests: econZones (road built -> full output), transport (extraSites -> job). Smoke: economy / defence labs run.
