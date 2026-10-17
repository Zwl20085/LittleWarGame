# WP-I-anomaly status (debug lab + ammo-starved herd fix)

Branch: worktree branch based on `feat/v3.0` (bd00fdc).

## Done
- 7c33d13 `feat(lab)`: scripts/lab30/{common,anomaly,anomalyProbe,anomalyCauses,anomalyWorld,anomalyReport}.ts, tests/anomaly.test.ts.
- Fix (convoy.ts, settlements.ts, rules.json `logistics.truck_*`, data/types.ts) + tests/convoyfix.test.ts — see commit `fix(supply)` after this note.

## Measurements (45 min, 4-FFA, seeds 7/11/13 x medium/large; media/stats/lab30/, gitignored)
Baseline = frozen bd00fdc at media/base30 (`git archive HEAD src docs/data`).

| ammo_starved | base2 | fix2 (meet+fallback+topup+needy aim) | fix3 (+meet-seek) |
|---|---:|---:|---:|
| episodes | 156 | 116 | 106 |
| high severity | 132 | 95 | 90 |
| unit-windows | 2745 | 1489 | 1380 |
| tank-samples ammo < 0.15 | 20.2 % | 16.6 % | 15.4 % |

war22 supply (base -> fix3): main-effort < 0.3 ammo 14 % -> 11 %; firing < 0.3 34 % -> 33 %; trucks lost 205 -> 136.

## Root cause
Trucks deliver almost nothing (seed 7: ~150 cargo handed over in 25 min by ~70 trucks): the supply
point is 110 m behind the line centre but trucks flee any enemy within 130 m, then drive back to the
depot full and out again; units only came to trucks below 0.08 ammo and within 300 m, otherwise they
walked up to 2.2 km to a stock (tank blocks / spearheads far from the line centre: 500-1200 m walks
through enemy ground, slowed to 0.7 when empty). Heavy tank shell (0.1) > rearm_below (0.08): dead zone.

## Status: complete
- cea4a2d docs/DEBUG_LAB.md; soak 45 7,11,13 anomalies 2 -> 0; challenge 21/21 AI holds; npm test 160 passed; typecheck green.
- Possible follow-ups: convoy_loop (trucks with no takers) and supply_chain (dry large-map city stocks) remain high; see DEBUG_LAB.md open items.
