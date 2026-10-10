# Version 2.2 — team spec

User request (2026-10-10), eleven items. This file is the shared contract for the agents working
on branch `feat/v2.2`. The user's latest words win over older docs (`COMMAND_V2.md`,
`BALANCE_SPEC.md`). Where the user left a choice open, the lead decided and the decision is
marked **(lead)** — keep it unless the measurements prove it wrong, and then say so in the report.

## 0. Ground rules for every agent

- Branch: work in your worktree, commit with conventional commits (`feat(sim): …`), end each
  commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push,
  do not merge, do not touch `main`.
- The sim is deterministic and runs in a worker (`src/sim/sim.worker.ts`, `src/simhost.ts`): new
  state the UI needs must go through `src/sim/snapshot.ts`. Never use `Math.random` in the sim;
  use the world's RNGs.
- Numbers live in `docs/data/rules.json` / CSVs (validated by `src/data/loader.ts`), not as
  magic numbers spread through code. Module-local tuning tables (`THEATRE`, `CONVOY` style) are
  acceptable for AI constants.
- UI strings: both `zh` (default) and `en` in `src/ui/i18n.ts`.
- Before you report: `npm run typecheck` and `npm test` green; for sim changes also a headless
  run, `npx tsx scripts/soak.ts 30 7,11` (or the lab) and a short before/after table. Screenshots
  for UI/visual work (`scripts/shot.mjs`, dev server on :5173).
- Keep files under ~800 lines; split new systems into their own modules.

## 1. Command system rebuild (item 1)

User: the supreme HQ (最高统帅部) no longer assigns a command to each front (方面军); it gives one
universal command, and every front decides its own response to it. Also: assigning orders by
click sometimes does not work.

**Data** — `Faction.directive: Directive`:

```ts
type DirectiveKind = 'offensive' | 'advance' | 'defend' | 'fortify' | 'contract';
interface Directive {
  readonly kind: DirectiveKind;
  readonly axis: V2 | null;      // 主攻方向 / 重点: optional point (main effort / threatened place)
  readonly line: { a: V2; b: V2 } | null; // fortify only: optional line → a fortified zone
  readonly issuedAt: number;
  readonly manual: boolean;
}
```

| directive | zh | what the fronts do (each front decides for itself) |
|---|---|---|
| `offensive` | 全线进攻 | every front attacks; the front nearest the axis is the main effort (reinforcement + supply priority, armour goes there); a front facing a much stronger enemy pins (attacks a nearer, weaker objective) instead of suiciding |
| `advance` (default) | 稳步推进 | 2.1 behaviour: each commander picks its own objective; strong fronts attack, weak fronts hold |
| `defend` | 全线防御 | every front holds its line; local counter-attacks only on a clearly weaker enemy near its line; the axis (if set) is the threatened place that gets reserves |
| `fortify` | 筑垒固守 | defend + engineers build works along every front's line; a drawn line becomes a fortified zone (2.1 zones stay permanent) |
| `contract` | 战略收缩 | fronts fall back to the nearest defensible own town line, give up exposed ground, garrison towns and economic buildings |

- Fronts are now created, merged and dissolved automatically by the theatre for **every**
  faction, the player's included (the AI's 2.1 theatre logic in `theatre.ts`). The player no
  longer opens / disbands fronts or sets the main front **(lead)**; `newFront`, `disbandFront`,
  `setMainFront` and per-front `frontOrder` leave the player command API (internal functions stay).
- Front orders (`Front.order`) remain as the front commander's own decision, made every HQ think
  from the directive + the local situation (strength ratio, distance to axis, threats, supply).
  The front card shows the response and the reason (e.g. "主攻 — 方向:Ostrava", "牵制",
  "固守 — 敌优势 2.1:1").
- New player commands: `{ type: 'setDirective'; kind; axis?: V2; line?: {a,b} }`, `cancelZone` stays.
- The AI supreme HQ uses the same directive API (it chooses a directive from its strategic
  state), so player and AI are symmetric.
- UI: the HQ card is a five-button directive palette (+ hotkeys Z X C V B) with an optional
  "set axis" click on the map / "draw line" drag for fortify; front cards become read-only
  dossiers. **Click bug:** find the root cause (suspect: the 5 Hz card rebuild replacing the DOM
  between pointerdown and pointerup, or the map click being eaten by the input controller /
  pointer capture) and prove the fix with a Playwright check that clicks 20 times.

## 2. Anti-tank gun nerf (item 2)

User: AT guns counter tanks far too hard; armoured assault no longer makes sense. Nerf the AT gun
(no compensating tank buff needed). Measure with `npx tsx scripts/balance.ts 30 7,11,13`
before/after (kill matrix, damage per cost). Levers: damage, accuracy vs moving targets, rate of
fire, setup/pack time, cost, HP. Target **(lead)**: AT gun tank-kills per cost spent down by
roughly 35–45 %, and a tank-led assault on an AT + infantry line wins at equal cost in the lab.

## 3. Supply rebuild (item 3)

1. Units carry much less: a full load lasts about 40 % of what it lasts in 2.1 **(lead)**
   (raise weapon `ammo_cost` or lower the carried load — one lever, documented).
2. Crowding cuts supply efficiency: units resupplying in a crowd get less each; convoy hand-over
   in one area has a cap (total transfer per area per second), so many trucks in one spot do not
   stack.
3. Supply is distributed through all towns/cities: every owned town/city (and the capital) holds
   a supply stock with a maximum (`stockCap` by kind, raised by a depot building, §5). Logistics
   fill the stocks; convoys load from a town's stock; units near a town draw from its stock.
   Lost town = lost stock.
4. New units roll out with **no ammunition** and must resupply before they fight: their front
   sends them to the nearest stock / truck first.
5. Rearming takes time (a rate, not an instant top-up), at depots and from trucks.

## 4. Production rebuild (item 4)

Units no longer come out of "any" place. Every production place (capital, city, town) has its own
production queue and its own build slots (capital: all facilities; city: barracks + vehicle +
support; town: barracks only **(lead)**, numbers in rules.json). A finished unit appears at its
own place. The auto scheduler (weights) assigns each order to a place (near the front that needs
it, safe, with a free slot); the player can queue a unit at a chosen place. A lost or contested
place stops its queue (orders refunded at the cancel ratio).

## 5. Economy (item 9)

- Settlement base output drops **(lead: ~50 % of 2.1 territory income)**.
- The supreme HQ invests P/M in **economic buildings** in its towns/cities (new building types,
  visible on the map): 工厂 factory (+M), 征兵站/农庄 recruitment office (+P), 仓库 depot (+supply
  stock cap and fill rate). Build slots by kind (village 0–1, town 2, city 3 **(lead)**),
  construction time, cost; levels optional.
- Economic buildings have HP and can be destroyed (shellfire, tanks, demolition by infantry and
  engineers). A captured town keeps damaged buildings (capture is worth more than razing, but
  razing denies) **(lead)**. Ruins can be rebuilt.
- AI: invests when safe, defends its economic towns, and sends small raiding / infiltration
  parties to destroy enemy economic buildings; garrisons respond. Economy vs army is a real
  trade-off (measure: investment share, payback time, raid losses).
- Player: select a town on the map → town panel: its production queue, its stock, its buildings,
  "build" buttons.

## 6. Quick start defaults to fog of war (item 5)

The Quick Start match uses `infoMode: 'fog'`. Custom keeps its toggle (default unchanged).

## 7. AI strategy (item 6)

Armour should act in clusters (armoured group: ≥ 3 tanks moving and engaging together, no
dribbling in one by one), or as the spearhead of an infantry attack (tanks lead, infantry follows
close behind). Metrics in the lab: mean tank cluster size during attacks, share of tanks lost
while alone, tank-led attack success. Test with `scripts/challenge.ts` and the soak.

## 8. Visuals and performance (items 7, 8)

Further polish of the picture (lighting, terrain, units, towns, the new economic buildings and
town depots) and a performance round (profile first: `scripts/perf.ts`, `scripts/perf-browser.mjs`;
report before/after numbers in `docs/PERFORMANCE.md`).

## 9. Online update check (item 10)

On start (Electron and web), query
`https://api.github.com/repos/Zwl20085/LittleWarGame/releases/latest`, compare its tag with the
built version (`package.json`, injected at build time), and when newer show a small notice on
the title screen with the release notes title and a button that opens the release page
(Electron: `shell.openExternal` via a safe IPC/preload or `setWindowOpenHandler`; web: link).
Silent on network failure (logged, not shown). A settings toggle turns the check off. No
automatic download or install.

## 10. Media (item 11)

Re-record the title-screen animation and every README animation with the 2.2 picture. The shot
choreography (`scripts/capture.mjs`, `scripts/capture-page.mjs` and the GIF scripts) stays; only
the picture changes (seed/time adjustments allowed when a shot no longer finds its action).
README en + zh describe 2.2; version 2.2.0.

## 11. Waves and owners

| wave | agent | items | main files |
|---|---|---|---|
| 1 | logistics | 3, 4, 9 (sim + panels) | supply.ts, convoy.ts, production.ts, economy.ts, new `settlements`/`econ` modules, ui/production.ts, ui/economy.ts, new town panel |
| 1 | command | 1 | commands.ts, theatre.ts, fronts.ts, frontops.ts, command.ts, ui/fronts.ts, ui/input.ts, ui/zones.ts |
| 1 | platform | 2, 5, 10 | weapons.csv / units.csv, menu.ts, main.ts, electron/, new ui/update.ts |
| 1 | render | 7, 8 | src/render/**, perf |
| 2 | strategy | 6, 9-AI, balance | theatre/fronts/doctrine/operations, lab |
| 2 | render | buildings / depots visuals | src/render/** |
| 3 | media | 11, README, version | scripts/capture*, docs/media, README*.md |

## 12. Roadside buildings as cover (item 12, added 2026-10-10)

User: buildings must not exist only in towns/cities — several single buildings (farmsteads,
barns, roadside inns, chapels, sheds) are spread along the roads so infantry can find cover when
shelled. They are real map buildings (collide, block shells and LOS like town houses, can be
damaged/ruined), generated deterministically from the map seed by `mapgen.ts`, kept clear of
bridges, crossings and town cores, with sensible spacing (not every road metre). Infantry under
artillery fire and with no works nearby move to the nearest roadside building within a short
radius and take cover there; fronts may use them as strongpoints. Agent: "roadside" (wave 1b).
