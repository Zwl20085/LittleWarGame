# AI doctrines — 作战风格 (3.0, V30_SPEC §1)

Every faction has a **doctrine**. An AI supreme HQ's doctrine scales the levers the existing AI
already reads; there is no second AI. The player's faction also draws a doctrine (the music and
spectate use it) but is never steered by it.

| id | zh | in one line |
|---|---|---|
| `builder` | 优先发育·抢占地盘 | invests early and heavily, occupies every free town, defends / contracts when outmatched, converts a late lead into a large army |
| `blitz` | 优先军事·一波直捣黄龙 | armour + motorized mix, masses, then one deep offensive on an enemy capital when the force ratio is met; re-arms and tries again |
| `attrition` | 稳扎稳打·掐断部署 | guns / MG / AT / engineers, damaged units pull back, fortifies when outmatched, raids convoys and economic sites, fewer denser fronts |
| `maneuver` | 寻机决战·大兵团歼灭 | mechanized + artillery main body (large main-effort share, most tanks), offensive on an isolated enemy front at 1.5:1, towns only after the enemy army is broken |

## Data — rules.json `doctrines`

`enabled` (A/B switch; `DOCTRINE_AB.on` in code as well), `reveal_s` (an enemy doctrine shows on
the faction card after the first battle with it or after this long), and `profiles.<id>`:

| field | lever | read in |
|---|---|---|
| `personality`, `production`, `caps` | production flavour, unit weight / cap multipliers | `sim.makeFaction`, `cityai.thinkCity` |
| `invest` | investment appetite × (buildings) and zone investment style | `econai.thinkInvestment` → `econZoneAi.setInvestStyle` |
| `occupy`, `occupy_broken`, `broken_ratio` | occupation detachments (× when the strongest enemy army < broken_ratio × ours) | `command.assignOccupations` |
| `defend_below`, `defend_exit`, `defend_kind`, `contract_below` | directive when outmatched (army ÷ strongest known) | `directive.chooseDirective` → `doctrineai.doctrineChoice` |
| `attack_ratio`, `offensive{mode, after_s, min_fullness, max_s, break_share, cooldown_s, force_after_s, force_ratio, between}` | the doctrine offensive: `late` / `strike` (enemy capital) / `battle` (isolated enemy front) | `doctrineai.ts` |
| `retreat_hp` | HP share at which a damaged unit leaves the line (capital guards keep the rules default) | `behavior.needsRetreat` → `doctrines.retreatHpOf` |
| `raid_rate`, `raid_targets{econ, convoy, rail, zone}`, `raid_on_defence` | raid cadence per target kind (0 = never); no new raid on a home alert or with ≥ 12 % of the army raiding (`raidsHeld`) | `econwar.planEconRaids`, `operations.planOperations`, `railraid.planRailRaids` |
| `front_density` | troops counted as fewer when sizing fronts (> 1 = fewer, denser fronts) | `theatre.restructure` |
| `picket_gap` | picket spacing × (attrition 0.7 tighter, maneuver 1.35 looser, others 1) | `pickets.placePickets` via `doctrines.picketGapMul` |
| `temperament` | compliance temperament bias (front commanders bolder / more cautious) | `compliance.complianceOf` |
| `main_share`, `armour_main_share` | main-effort reinforcement share, tanks on the main front under advance | `cityai.balanceReserves`, `armour.armourFront` |
| `upgrades` | AI upgrade purchase order (upgrade ids; = the doctrine row of `upgrades.UPGRADE_PRIORITY`) | `upgrades.nextWanted` (doctrines on only) |

The AI finisher (command.ts) still comes before the doctrine: wars must end.

## Assignment

`MatchConfig.doctrines?: (DoctrineId | 'random')[]` per slot. `doctrines.assignDoctrines(seed, n, choices)`:
explicit choices stand, every other slot draws from a seed-shuffled deck of the doctrines not chosen
(all four different in a 4-FFA). Quick Battle and Spectate: all random. Custom game: a selector per
AI side (随机 / Random + the four), stored with the setup.

## UI and music

- Faction card (top bar): `?` until discovered, then the short name; the tooltip reads "作风：优先发育·抢占地盘".
  Discovery: the first hit between the two factions (`events.noteHit` → `Faction.contactAt`) or `reveal_s`.
- `src/ui/musicCues.ts` (main thread): `setDoctrineTheme(strongest enemy's doctrine)` at the start
  (nearest enemy capital) and every minute; spectate: the doctrine of the player slot.
  `musicEvent('offensiveLaunched')` on an accepted player offensive, `'capitalLost'` when the player
  falls, `'quiet'` once after 60 s without the player's units firing or being hit.

## Seams left

- **zone** raid target: zone raids go through the econ raid cadence (econwar handles zones).
- Wired in WP-Y: **rail raids** (`railraid.ts`: a 3–4 squad party at a point on an enemy-held line or
  station within 1.3 km of our front; 10 s on the spot cuts the line like a lost station, the holder
  repairs it with engineers; lab `scripts/lab30/railraid.ts`), **picket spacing** (`picket_gap`),
  **upgrades** (doctrine rows), and the home-defence reserve (`raidsHeld`, `retreatHpOf`, breach rejoin
  in `homeguard.convergeOnPoint`).
- **strike route**: blitz offensives use the directive axis; the transport layer (`thinkTransport`)
  decides rail / road movement on its own.

## Lab

`npx tsx scripts/lab30/doctrine.ts [--seeds 7,11,13] [--minutes 45] [--jobs 8] [--suite duel,ffa]
[--only blitz] [--set "doctrines.profiles.blitz.attack_ratio=1.2"] [--off] [--tag t]` — see
docs/STRATEGY_LAB.md "3.0 doctrines" for the results.
