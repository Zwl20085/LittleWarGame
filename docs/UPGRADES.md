# Unit upgrades (3.0)

V30_SPEC §9. The supreme HQ buys upgrades with P/M; the capital researches one at a time. Numbers
live in `docs/data/rules.json` → `upgrades` (table in BALANCE_SPEC §10.2). Off switch:
`upgrades.enabled=false` (lab: `--set upgrades.enabled=false`; AI buying only:
`upgrades.ai.enabled=false`).

## The tree (13 items)

| id | effect | reaches existing units |
|---|---|---|
| `inf_guns` | an infantry gun / mortar team per rifle squad: lobbed HE at works, buildings, garrisons and dug-in targets | at a town rearm |
| `ap_grenades` | squads hit vehicles within 35 m | at once |
| `motorization` | new rifle squads ride trucks (motor_inf rules); old squads get trucks at a town rearm | at a town rearm |
| `armour_1..3` | tank armour, hit points up, speed slightly down (side skirts) | at a town rearm |
| `gun_1..3` | tank gun penetration, damage, range (longer barrel) | at a town rearm |
| `arty_range` | mortar and howitzer range ×1.2 | at once |
| `truck_capacity` | supply truck loads ×1.4 | at once |
| `eng_speed` | engineer work rate ×1.5 (works, structures, bridges, roads, rail, work upgrades, mines) | at once |
| `staff` | front tier thresholds ×0.8 | faction-wide |

Prices: `p_k`/`m_k` × army_scale × army_scale_income_factor, × (1 + `escalation` × items owned).
Cancelling a research returns `cancel_refund_ratio` of the price.

## Code

- `src/sim/upgradestats.ts` — bit order, class masks, the stat layer. An upgraded unit points at a
  variant `UnitDef` / `WeaponDef` cached per (type, bits), so every existing read (`u.def.speed`,
  `u.def.maxHp`, armour, `u.primary.range` …) sees the upgraded value with no per-tick cost.
  `refitOnSpawn` (World.spawnUnit), `refitAtTown` (settlements.drawSecond), `refitNow` (field items).
  `u.upg` holds the bits a unit carries (snapshot field `upg`; the mirror refits too).
- `src/sim/upgrades.ts` — prices, `startResearch` / `cancelResearch` / `grantUpgrade`,
  `upgradeSecond` (timer + AI), `UPGRADE_PRIORITY` and `upgradePriority(doctrineId?, personality?)`.
  WP-A fills doctrine rows; `Faction.doctrine` may be an id string or an object with `id`.
- `src/sim/upgradekit.ts` — attached gun team and AP grenades (combat.updateWeapons → `kitFire`).
- Commands: `{ type: 'research', upgradeId }`, `{ type: 'cancelResearch' }`.
- UI: `src/ui/upgrades.ts` (panel, HUD button, Y), unit card line, strings in `src/ui/i18n-upgrades.ts`.
- Render: `src/render/upgradeModels.ts` — side skirts and a barrel extension (one instanced mesh
  each for every tank class), the gun team drawn with the anti-tank gun model; motorized squads use
  the existing truck column of mounted infantry.

## AI

After `ai.start_s`, with no threat to the capital, income ≥ `income_floor_k` and not falling more
than `trend_drop` over `trend_window_s`, the AI sets aside `fund_share` of its income for the
first item of its priority table it does not own, and starts it when the fund (plus stock above
`reserve_*_k`) covers the price. The fund goes back to the stock when it stops being eligible.

## Lab

`npx tsx scripts/lab30/upgrade.ts [--parts value,rich,motor] [--seeds 7,11,13] [--jobs 6]`
(value per cost at equal resources, rich vs poor at 1.5× income, motorization reinforcement time).
Reports land in `media/stats/lab30/upgrade-*.md` (not committed).

### Results (2026-10-17, shipped rules after the munitions repricing)

(a) value per cost, seeds 7,11,13,17,19,23 × both sides, 30 min, 1v1. Δscore = A's score minus the
same seed/side with no item and no bank; value/cost = 1 + Δ / cost.

| item | cost P+M | Δscore ± s.e. | value/cost ± s.e. |
|---|---|---|---|
| inf_guns | 1200 | −4958 ± 1441 | −3.13 ± 1.20 |
| ap_grenades | 900 | +31 ± 1816 | 1.03 ± 2.02 |
| motorization | 1650 | +267 ± 1876 | 1.16 ± 1.14 |
| armour_1 | 1150 | −2405 ± 1589 | −1.09 ± 1.38 |
| armour_2 (with I) | 2979 | −7307 ± 2658 | −1.45 ± 0.89 |
| armour_3 (with I, II) | 5555 | −5020 ± 2387 | 0.10 ± 0.43 |
| gun_1 | 1150 | −968 ± 1921 | 0.16 ± 1.67 |
| gun_2 (with I) | 2979 | −8052 ± 2412 | −1.70 ± 0.81 |
| gun_3 (with I, II) | 5555 | −5915 ± 2476 | −0.06 ± 0.45 |
| arty_range | 1050 | −975 ± 2063 | 0.07 ± 1.96 |
| truck_capacity | 800 | −150 ± 1349 | 0.81 ± 1.69 |
| eng_speed | 650 | −1873 ± 1926 | −1.88 ± 2.96 |
| staff | 950 | −3195 ± 1783 | −2.36 ± 1.88 |

Reading: no item beats the same P/M banked into units at t = 0 over 30 minutes (nothing
dominates); the standard error (1–3 × the cost) is larger than most item effects, and repricing
P → M alone moved staff by −2300 and truck_capacity by +3300, so the bank's P/M mix (P is the
scarce stock) dominates this metric. The 0.6–1.6 × median band is not meaningful with a median
near 0; a lower-noise engagement-level lab is the follow-up (see the WP-H report).

(b) rich (1.5× income) vs poor, 6 seeds × both sides, 60 min, AI research on: the rich side is
ahead at the end in 12/12 (more settlements in 11, larger army in 11), but only 2/12 wars end in
60 min (both rich wins, at 45 and 55 min). Snowball is slow (median win > 30 min); the ≥ 70 % *win*
criterion fails because 1v1 wars on the medium map rarely finish within an hour at all.

(c) motorization, 6 rifle squads from the capital exit to the farthest own-side settlement
(1.6–1.7 km): motorized 4 of 6 arrive in 364–467 s (seeds 7, 11, 13); on foot 787 s on seed 13
and not within 40 min on seeds 7 and 11.
