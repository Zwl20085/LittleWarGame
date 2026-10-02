# LITTLE WAR · 小小战争沙盘

A WWII real-time battle diorama in the browser: plan a wartime city's war effort, then watch thousands of soldiers fight along a living front on a procedurally generated map.

二战即时战斗沙盘：统筹城市与占领区的资源和出兵，观看成千上万的士兵在程序生成的地图上沿真实战线自动作战；也可随时框选细操。默认中文，界面右上角一键切换英文。

<table>
  <tr>
    <td><img src="docs/media/front.gif" width="400" alt="Infantry skirmish lines and tanks assaulting a village; a wrecked vehicle burns" /></td>
    <td><img src="docs/media/river.gif" width="400" alt="A column crossing a stone bridge over a river toward a riverside town" /></td>
  </tr>
  <tr>
    <td><img src="docs/media/city.gif" width="400" alt="Fighting around a town with a church steeple, troops spread in loose formations" /></td>
    <td><img src="docs/media/overview.gif" width="400" alt="Overview of a generated map: rivers, forests, villages, towns and roads" /></td>
  </tr>
</table>

## What makes it different

- **The map is generated, and it reads like a map.** Each seed builds mountain ranges with passes, rivers along the valleys (bridges and fords), forests, field patchwork, many villages, street-grid towns, cities with towers, and a capital per faction.
- **Real fronts, not lanes.** Ground control is computed from where troops stand. Army groups hold the line on good ground (high ground, river banks, towns), push it forward when locally stronger, and launch armoured spearheads through weak points toward enemy towns and capitals.
- **Territory is the economy.** Every settlement can be captured. Held towns add income, production slots and population capacity, and serve as supply depots; new units roll out of the town closest to their front. The capital alone supports only about a third of a full army, so losing ground really shrinks your war effort, and losses take time and money to replace.
- **Supply you can see and cut.** Trucks shuttle ammunition from depots (capital, held towns and cities; efficiency drops with distance from the capital) to supply points behind the lines. The AI sends raid detachments through weak stretches of the enemy front to ambush convoys, and keeps a rear guard on its own supply routes.
- **Armour leads, artillery supports.** Tanks are tough enough to spearhead breakthroughs and fall to AT guns and other tanks. Artillery suppresses and softens, but firing batteries are sound-ranged and become counter-battery targets, so they relocate after a few salvos. Massed troops suffer extra under shellfire, so armies spread along the whole front.
- **Towns are solid.** Every building has collision: troops and vehicles move through the streets, and buildings block line of sight, direct fire and incoming shells.
- **A high command per side.** A theatre commander reviews every settlement every few seconds and issues defend / occupy / attack directives. Threatened towns get garrisons, open villages behind the lines get small occupation detachments, and valuable, winnable enemy towns pull the army groups.
- **Engineers bridge rivers.** When a river blocks the way and the nearest bridge or ford is a long detour, engineers build a pontoon bridge that everyone can then use.
- **Rules first.** Fire, armour facing and penetration, HE blast, cover, suppression and morale, ballistic arcs over ridges, and air strikes with flak all follow the design spec. The simulation is deterministic (fixed 20 Hz ticks, seeded RNG) and runs in a Web Worker.
- **Numbers you can inspect.** `scripts/balance.ts` runs headless AI matches and prints a per-unit-type ledger (damage dealt/taken, kills and losses, value traded), an attacker × victim kill matrix and an economy timeline; the balance is tuned from it.
- **Large scale.** Hundreds to 1,600 tactical units on screen (thousands of soldiers), with instanced rendering and zoom-level unit counters.
- **Procedural music and sound.** An adaptive orchestral score that swells with the fighting, plus rifle volleys, MG bursts, cannon, shell whistles, bombs and aircraft — all synthesized in the browser, no audio files.

## Download and play

**Windows (standalone, no browser needed):** get the latest build from the [Releases page](https://github.com/Zwl20085/LittleWarGame/releases).

| File | What it is |
|---|---|
| `LittleWar-<version>-portable.exe` | Single file, no install: double-click to play |
| `LittleWar-<version>-setup.exe` | Installer with Start-menu and desktop shortcuts |

The builds are not code-signed, so Windows SmartScreen may warn the first time: choose **More info → Run anyway**. A GPU with WebGL2 support is needed (any graphics card from the last ~8 years). Press **F11** for fullscreen.

## Run from source

Requires Node.js 18+ and a desktop browser with WebGL2 (Chrome, Edge, Firefox).

```bash
npm install
npm run dev          # open http://localhost:5173
npm run app          # or: run it as the standalone desktop app (Electron)
```

The title screen plays a live AI battle in the background. Choose **QUICK BATTLE** for a generated 4-faction map, or **CUSTOM BATTLE** to pick factions (2–4), map size, seed, difficulty and intel mode (open table or fog of war).

URL shortcuts for testing: `?quick` (hand-made 4-way map), `?quick&map=gen&seed=42`, `?quick&map=1v1`, `&fog`, `&spectate`.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select units (Shift to add) |
| Right click ground / enemy | Move (then resume group task) / focus fire |
| A, H, R, G | Attack-move, hold, retreat, resume automatic |
| WASD or middle-drag, Q/E, wheel | Pan, rotate, zoom |
| Ctrl+wheel or PgUp/PgDn, Tab | Camera pitch, overview |
| 1 / 2 / 3 | Army-group panels (posture, target, share) |
| Space, U, Esc | Pause, hide HUD, menu |

F11 toggles fullscreen in the desktop app.

Speed: 1× / 2× / 4× / 8×. If the simulation can't keep up, the game slows down and shows a notice; it never skips ticks.

## How a match plays

1. Your capital produces units by spending weights (bottom bar). The resource steward balances mobilisation, industry and logistics, or you can set them by hand.
2. Units join three army groups. Each group picks objectives from the terrain, takes neutral villages, then meets the enemy and forms a front.
3. Set a group's posture (cautious / assault / hold / fortify / withdraw) or a target. The AI handles the rest: holding river lines, massing before crossings, pushing, breaking through.
4. Win by capturing enemy capitals with infantry or by draining their campaign resolve (losses plus enemy control of strategic towns). There is no time limit: the war goes on until capitals fall or resolve collapses.

## Project layout

```
src/sim/      deterministic simulation: map generator, terrain, economy, production,
              combat, morale, supply convoys, front analysis, AI (city / army groups / units)
src/render/   Three.js diorama: instanced units, terrain, water, settlements, effects, labels
src/ui/       war-room HUD, title screen, high-command card, i18n (zh / en)
src/audio/    procedural music and sound effects (Web Audio)
electron/     standalone desktop shell (serves the built game over app://)
docs/         design documents (Chinese) and docs/data/*.csv|json: unit, weapon and rule seeds
tests/        rule, terrain, map-generation and AI smoke tests (vitest)
trailer/      Remotion project for the promo trailer (footage in media/, gitignored)
```

Design docs: [策划文档入口](./docs/README.md). Implementation-time decisions are listed in `docs/GAME_DESIGN.md` §2.1.1.

## Development

```bash
npm run dist:win     # build the Windows portable .exe and installer into release/
npm test             # unit + smoke tests
npm run typecheck
npm run build        # production bundle in dist/
LONGRUN=1 npx vitest run tests/longrun.test.ts   # full 45-minute AI matches
node scripts/capture.mjs                          # record gameplay clips to media/clips
npx tsx scripts/balance.ts 25 7,11                # numeric analysis: per-unit-type damage, kills/losses, kill matrix, economy timeline
```

Trailer: `cd trailer && npm i && npx remotion studio` to preview, `npx remotion render src/index.ts Trailer ../media/trailer.mp4` to export.

## Status

Prototype (v0.4). Balance is tuned from the numeric-analysis ledger of headless AI-vs-AI matches (`scripts/balance.ts`); it has not been tuned in human play yet. Not yet done: save/load and replay UI, AT obstacles and trenches, alliances (the data model supports them).

Last reviewed: 2026-10-02.

## License

MIT, see [LICENSE](LICENSE). The trailer is built with [Remotion](https://www.remotion.dev/), which is free for individuals and teams of up to 3.
