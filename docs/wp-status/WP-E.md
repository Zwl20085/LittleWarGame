# WP-E status — sparse fronts and infiltration (V30_SPEC §11)

Branch: `worktree-agent-aa578224f6cc603a0` (feat/v3.0 merged in at b9a0eff). State: **complete** (labs run, report delivered).

## Done
- cc4956c WIP: rules `infiltration` + validator (`src/data/infiltrationRules.ts`), `src/sim/zoc.ts`, `src/sim/pickets.ts`,
  `src/sim/infiltration.ts`, hooks (sim / behavior / movement / fronts net 0 lines / operations / types / world),
  i18n zh+en, minimap blip, lab, tests.
- b9a0eff merge feat/v3.0 (WP-F/G, D/D2); rear screen covers economic zones (`world.econZones`).
- 24b7061 lab on the shared `scripts/lab30/common.ts` (merge had collided two versions; kept feat/v3.0's, added
  `infoMode`), `INFIL_OFF=1` challenge switch. 51ca288 docs COMMAND_V2 §9.
- d1c40e5 rear ground = nearest capital / held settlement (`rearDepth`): the influence field follows a moving
  detachment, so a raid deep in our ground stood on "its own" cells and was never reported. 32c2a98 soak switch.

## Results (seeds 7, 11, 13)
Infiltration lab (`scripts/lab30/infiltration.ts`, 6-squad detachment + 10-unit motorized raid at the widest gap, 10 min):

| | open on | open off | fog on | fog off |
|---|---|---|---|---|
| past the line (200 m inside), all 48 units | 9 (19 %) | 17 (35 %) | 1 (2 %) | 10 (21 %) |
| past the line undetected | 0 (0 %) | 10 (21 %) | 0 (0 %) | 0 (0 %) |
| median s to detected (detachment / raid) | 53 / 48 | 79 / 115 | 17 / 108 | 84 / 62 |
| reached 700 m of the capital | 3 (6 %) | 15 (31 %) | 19 (40 %) | 10 (21 %) |
| CPU ms/tick vs off (before / after launch) | +9.6 % / +7.3 % | — | +4.8 % / +5.8 % | — |

Challenge (merged base, system off via INFIL_OFF vs on): `--all` 42/42 matches AI holds (14 strategies);
shadow_strike open: score 95→96, min warning 216→408 s; backdoor 89→94, min warning 25→187 s;
shadow_strike fog: off 67 % AI survival (1 capital taken) → on 100 %, the strike never arrived.
Soak 30 min: seed 11 none; seed 7 one MG (#505) unreachable on a forest slope — same unit with the system off
(2 reports off, 5 on); pre-existing on the merged base, not caused by WP-E.

## Follow-ups (not blocking)
1. Doctrine hook: "attrition lowers the picket spacing" waits for WP-A (`picket_tier_mul` is the lever).
2. The AI lines are hollow (most units on garrison / manoeuvre / raid duty), so pickets often find no spare squads;
   the rear reports + hunts do most of the work. A theatre-level picket quota would be the next step.
