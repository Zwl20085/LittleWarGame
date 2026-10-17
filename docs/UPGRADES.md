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
Latest results: see the WP-H report and `media/stats/lab30/upgrade-*.md`.
