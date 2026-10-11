<div align="center">

**English** · [简体中文](README.zh-CN.md)

<img src="docs/media/hero.gif" width="100%" alt="Trailer cut from live play: a war map with fronts, unit counters and attack arrows, a howitzer salvo streaking into the edge of a city, a group of tanks rolling across the fields with rifle squads close behind, a street fight between apartment blocks, supply trucks crossing a river bridge, and the LITTLE WAR title screen over a live battle" />

# LITTLE WAR

**A WWII real-time battle diorama.** Plan a nation's war effort, then watch thousands of soldiers fight along a living front on a procedurally generated map: rivers, mountain passes, villages, towns and cities that are worth dying for.

[![Download for Windows](https://img.shields.io/badge/Download-Windows%20x64-8a6a2c?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Zwl20085/LittleWarGame/releases/latest)
&nbsp;
[![Release](https://img.shields.io/github/v/release/Zwl20085/LittleWarGame?style=for-the-badge&color=3a3326)](https://github.com/Zwl20085/LittleWarGame/releases)

![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-r169-000000?logo=threedotjs&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-33-47848f?logo=electron&logoColor=white)
![Simulation](https://img.shields.io/badge/sim-deterministic%2020%20Hz-6b7a3a)
![License](https://img.shields.io/badge/license-MIT-blue)

[What's new](#whats-new-in-22) · [Features](#features) · [Download](#download-and-play) · [How a war plays](#how-a-war-plays) · [Controls](#controls) · [Under the hood](#under-the-hood) · [Roadmap](#roadmap) · [Build from source](#build-from-source)

</div>

---

## What's new in 2.2

- **One directive for the whole war.** The supreme HQ no longer gives each front its own order. You give one directive to the whole army: **General offensive**, **Steady advance** (the default), **General defence**, **Fortify and hold** or **Strategic contraction** (<kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd> <kbd>B</kbd>). Offensive and defence take an optional click on the map: the axis of the main effort, or the threatened place that gets the reserves. Under Fortify you can drag a line that becomes a permanent fortified zone. Every front commander then decides his own answer: the front nearest the axis becomes the main effort, the fronts near it support it, and a front facing an enemy 1.8 times its strength pins a weaker place nearby instead of attacking head-on. The front cards are now read-only dossiers that say what each commander does and why ("Main effort — toward Willowwell", "Pinning — Greycrest (enemy 2.1:1)"). Fronts are opened, merged and dissolved automatically for you as well as for the AI, and the AI supreme HQ picks its directive through the same command ([COMMAND_V2 §7](docs/COMMAND_V2.md)). A long-standing bug that lost clicks on the HQ panel is fixed.
- **Supply runs through the towns.** Every capital, city and town you hold keeps a supply stock (larger in a capital, smaller in a town, raised by a depot). Logistics fill the stocks, trucks load from them, and units near a town rearm from its stock gradually, about 40 s for a full load. Rearming is slower in a crowd, and convoy hand-overs in one area are capped, so piling trucks into one spot does not help. Units carry 40 % of the 2.1 load, and new units roll out with empty pouches and fetch ammunition before they fight. A lost town takes its stock with it.
- **Production happens at real places.** The capital, every city and every town has its own build slots and queue (capital: all facilities; city: barracks, vehicle works and support; town: barracks), and a finished unit appears where it was built. The scheduler places each order near the front that needs it; you can also queue a unit at a chosen town from its town panel. A lost or long-contested place refunds its queue.
- **Economic buildings and raids.** Settlements now yield half of their 2.1 income, and the rest comes from buildings: a **factory** (+munitions), a **recruiting office** (+manpower) and a **depot** (larger and faster-filling stock), built on lots at the edge of a town (2) or a city (3). They take time to build, can be shelled or demolished by engineers, infantry and tanks, keep their damage when a town changes hands, and can be rebuilt from the ruins. The AI invests when it feels safe and sends 2–4-squad raiding parties to wreck enemy buildings; garrisons guard the towns that have them. Your own HQ staff invest the same way by default (2.2.1): switch **Auto-invest** off in the economy panel to build only by hand. Click any town on the map for its **town panel**: stock, local queue, buildings and build buttons.
- **Roadside farms are cover.** Farmsteads, barns, inns, chapels and sheds now stand along the roads between settlements, 150–230 m apart. They are real buildings: they collide, block shells and sight lines and can collapse. Rifle squads caught by shellfire run into the nearest building with room and shelter inside, where blasts hurt them far less until the walls give way.
- **Tanks fight as a group.** A front's tanks form one armoured block: a reserve behind the line when holding, and in an attack they assemble first, then lead the infantry by about 45 m at the riflemen's pace. Fewer than 3 tanks no longer attack without infantry. In the strategy lab, the mean tank cluster in attacks rose from 1.7 to 2.8, the share of tanks killed while alone fell from 77 % to 50 %, and 75 % of tank-led attacks took their objective ([BALANCE_LAB](docs/BALANCE_LAB.md), Chinese).
- **The AT gun is weaker.** Range 240 → 200 m (it no longer outranges the medium tank's gun), reload 4.5 → 6 s, damage 900 → 650, accuracy .72 → .85. AT tank kills per 1 000 spent fell 37 %, and a tank-led assault on an AT gun and infantry line at equal cost now wins 12 of 20 lab trials instead of 4.
- **Quick Battle is fought under fog of war.** Custom games keep their own toggle.
- **Update check.** On start the title screen asks GitHub for the latest release and, when it is newer than yours, shows a small notice with a link to the release page. It never downloads anything, stays silent offline and can be turned off in Settings. The title screen also shows the version.
- **Smoother and sharper.** Shader relinks, idle buffer uploads and UI layout churn are gone: in the browser at 8× the renderer frame fell from 7.2 to 5.7 ms at the overview and from 5.4 to 3.8 ms close in, and every view holds 60 fps without the periodic stutter ([PERFORMANCE](docs/PERFORMANCE.md)). New procedural ground texture, crisper roads and rivers, a period city skyline, economic buildings as period models and stock gauges on the towns.

<details>
<summary><b>What was new in 2.1</b></summary>

## What's new in 2.1

- **Fortified zones are permanent works.** A Fortify order registers a zone; a later order to the same front never cancels it. Zones keep building from the supreme-HQ card's **Fortified zones** list (progress, who holds it, cancel) and stay on the map as stencils. Engineers of any front finish them.
- **As many fronts as you need.** Open a front anywhere with <kbd>N</kbd> (up to 8; the commander costs 120 P and free troops within 350 m join it), disband one from its card, pick fronts with <kbd>1</kbd>–<kbd>8</kbd>. The AI runs up to 8 fronts too and opens garrison fronts for its finished zones. (Since 2.2 the theatre opens and closes fronts for every side, the player included.)
- **Orders are binding.** A front under your order sends out no occupation, raid or rear-guard detachments; an attack order goes without the "outmatched" hold; a defend or fortify order keeps every unit on the line and mans its works first. Cards stamp **奉命 / ordered** for your orders and the expanded card shows how many units are in position.
- **Works that are worth it.** Pillboxes cost 6 P + 50 M (2 750 HP) and carry their own 200 m machine gun; bunkers 12 P + 100 M (5 625 HP) and sharpen their occupants' fire; trenches are cheaper. Capitals start with finished pillboxes at their strongpoints plus engineers in the field, and the supreme HQ queues engineers whenever works are waiting. In the soak, manned works went from 2 squads per side to 66–93 % of all slots.
- **Production follows demand.** When sites wait and no engineer is free, engineers are queued automatically (also for you; pausing the engineer line stops it).
- **Feet on the ground.** Units no longer float: they stand on the drawn terrain surface instead of the simulation's coarser height, vehicles pitch *and* roll with the slope, shadows start at the feet (the shadow bias now follows the shadow-map pixel size) and every unit gets a soft contact shadow. A fill light from the camera side lifts the faces you actually see.
- **Towns with streets.** Street grids are painted into the terrain (setts, kerbs, gutters, footways), every town has a square with a monument or well, stalls and benches; lamp posts, carts, garden walls, church yards, factory crate yards and rail spurs, telegraph poles along country roads, chimney smoke. Houses now sit square to their streets (a long-standing rotation bug in the layout).
- **Refined models.** Riflemen carry packs, bedrolls and canteens, squads have a leader and an LMG gunner; tanks got distinct running gear, hatches, mantlets, stowage and a muzzle brake on the heavy; trucks, guns and the commander's staff got the same treatment; buildings got window reveals, doors, chimneys, tile rows, spires and sawtooth factory roofs. All instanced: frame cost +0.4 ms at most, 8× still holds.

</details>

<details>
<summary><b>What was new in 2.0</b></summary>

## What's new in 2.0

- **You are the supreme HQ.** The fixed left / centre / right sectors are gone. You command *fronts*, and you give each front one standing order on the map: **Attack**, **Defend**, **Fortify**, **Fall back** or **Auto**. Click for a point, drag for a line. Each order is drawn as an inked war-map line with a stamp naming the front. An order far from every front opens a new front (up to 4). The AI supreme HQ opens, merges and dissolves its own fronts and gives its orders through the same command API as you ([docs/COMMAND_V2.md](docs/COMMAND_V2.md)).
- **Front commanders.** A commander on the map leads each front: a four-man staff (officer with a map, radio operator, two guards) under an HQ pennant, 2 400 HP. The commander posts at the nearest safe own town behind the line and, inside your order, picks the objective, posture, battle plan and battle line. Kill one and the front only holds its ground for a minute; a replacement is appointed after 90 s.
- **Pillboxes and bunkers.** Engineers build pillboxes (10 P + 80 M, 70 s, 2 200 HP, one squad, built-in MG, blind rear arc) and bunkers (20 P + 160 M, 120 s, 4 500 HP, two squads or an AT gun). A **Fortify** order lays out a fortified zone along your line: trenches, a pillbox at each end and a bunker behind the middle. Every capital now keeps a standing garrison of 3 squads and an engineer-built line of 2 trenches and 2 pillboxes from the first minutes.
- **Armoured and motorized thrusts.** A front with 3 or more spare tanks or motorized squads breaks through at a 1.5× local edge every 75 s, with armour and motor rifles in the lead. Motorized rifles on a thrust stay in their trucks until the enemy is within 220 m. The medium tank now has 2 100 HP, 2.8 m/s and a 130-damage gun, and the light tank does 3.3 m/s. Tanks crack concrete: a pillbox takes 4 hits from a heavy tank or 7 from a medium. In 2.0 the AT gun stayed the best tank killer (its share of tank kills rose from 13 % to 21 %, [BALANCE_SPEC §2.7](docs/BALANCE_SPEC.md)); 2.2 cut it back so that armoured assaults pay off again.
- **Challenge lab.** `scripts/challenge.ts` plays one faction with a scripted strategy (rush at 3 / 5 / 10 min, turtle, two axes, raids, late blitz, a human-like player, every unit on the capital) against three AI factions through the real command API. It reports whether the AI kept its capital and how it defended ([docs/CHALLENGE_LAB.md](docs/CHALLENGE_LAB.md)).
- **Heavier fire.** Explosions now depend on what they hit: water splashes, collapsing buildings that throw dust and rubble, roof hits, AP sparks and vehicle cook-offs. Guns fire tapered flames with smoke rings, tracers glow brighter, wrecks burn with embers that die down, and shelled ground gets a faint haze (high quality tier).
- **Still fast.** The enemy-distance transform runs on a coarser grid (2.8 % → 0.8 % of sim CPU), defensive-position and cover searches are cached, and forts are looked up through a per-tick index. The 2.0 planner thinks every 5 s and adds no per-tick work. In the browser the renderer frame takes 4.8 ms at the overview and 3.3–3.5 ms in battle views, and 8× speed holds.

</details>

<details>
<summary><b>What was new in 1.1 and 1.0</b></summary>

**1.1**

- **Stronger artillery.** Mortars and howitzers lead moving targets and no longer burst on their own gun line. Shells hit harder and burst wider (howitzer 180 damage in a 16 m radius, mortar 125 in 11 m), so two guns can break a squad caught in the open in a few salvos. Fewer, cheaper howitzers keep artillery at about a fifth of all kills.
- **Unit identity audit.** Every unit's damage and HP were checked against what its name promises. The heavy tank's gun now hits like one (150 → 210), and the balance spec matches the data again.
- **High command defends the capital.** It forecasts the threat from enemy groups aimed at the capital and closing in, recalls the nearest, least engaged groups, sends home guards and digs trench rings on the approach. In the strategy lab, capitals lost to attacks the army could have stopped fell from 7 to 0 (6 seeds × 45 min).
- **Siege and storm.** Groups ring a fortified capital, bring every gun into range, storm once they have the mass and dig in if the storm stalls.
- **Crews deploy where the fighting is.** MGs and AT guns go to the stretch of front that is in contact, and fire about twice as often.
- **A territory-driven army.** The population cap grows with the land you hold. Victory is still only by taking every enemy capital.
- **Faster again.** Snapshots apply in half the time, and the scene has a quarter fewer objects ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

**1.0**

- **Soldiers move like people.** Each soldier walks to his place in the formation at a capped pace, turns gradually and strides by the distance he covers.
- **Terrain and buildings fight.** Squads garrison houses and fire from the windows until HE brings the building down. High ground aims and spots better, a crest shields defenders, and forests hide troops that hold fire.
- **An orchestral score**, composed bar by bar and played on an orchestra synthesized in a worker.
- **A sharper AI.** Battle-plan rules retuned from the strategy lab: operation success rose from 42 % to 58 %.
- **Faster.** The mean simulation tick fell from 4.5 ms to 2.7 ms at about 460 units, and a new **Graphics quality** setting arrived.

</details>

## Features

<div align="center">
<img src="docs/media/orders.gif" width="100%" alt="The war-room HUD: the player presses General offensive on the supreme-HQ card and clicks an enemy town as the axis; the front cards switch to Main effort and Supporting the main effort, the first front's dossier opens, and inked attack lines toward the town appear as the fronts start to move" />
<br/><sub><b>One directive, every front answers.</b> Pick the directive (<kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd> <kbd>B</kbd>), then optionally click the axis on the map. Here the player orders a general offensive toward an enemy town: the nearest front becomes the main effort, the others support it, and each card says so. Top left: the supreme-HQ card with the directive palette, then one read-only card per front (the first one expanded). Bottom: production. Bottom right: minimap. Chinese by default, English with one click.</sub>
</div>
<br/>

<div align="center">
<img src="docs/media/town.gif" width="100%" alt="A town with a factory at its edge: the player clicks the town and its panel opens with the supply stock, the local production queue and the economic buildings; the player orders a recruiting office, whose building site appears on the second lot, and queues a rifle squad at the town" />
<br/><sub><b>Towns run the war economy.</b> Click a town for its panel: its supply stock (units nearby rearm from it), its own production queue and slots, and its economic buildings. Here a factory already earns munitions; the player orders a recruiting office on the second lot and queues a rifle squad that will march out of this town.</sub>
</div>
<br/>

<table>
  <tr>
    <td width="50%"><img src="docs/media/roadside.gif" width="100%" alt="A lone farmhouse beside a country road: a shell bursts next to it, and rifle squads caught in the open gather against its walls and take cover there" /></td>
    <td width="50%"><img src="docs/media/spearhead.gif" width="100%" alt="A group of tanks rolls across the fields toward burning wrecks, with rifle squads following close behind them" /></td>
  </tr>
  <tr>
    <td><b>Farms along the road are cover.</b> Single farmsteads, barns, inns, chapels and sheds line the country roads between settlements. When shells start to fall, rifle squads in the open run for the nearest building with room and take cover inside it: a blast hurts them far less there, and the walls soak up the shelling until they collapse.</td>
    <td><b>Tanks lead, infantry follows.</b> A front's tanks assemble into one group before they attack, then roll ahead of the riflemen by about 45 m at the infantry's pace instead of dribbling forward one by one. A front with fewer than three tanks never sends them in without infantry. Under a general offensive, new and idle tanks gather at the main effort.</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/media/commander.jpg" width="100%" alt="A front commander's staff at the edge of a village: an officer reading a map, a radio operator and two guards beside a pole with the HQ pennant" /></td>
    <td width="50%"><img src="docs/media/pillbox.gif" width="100%" alt="A concrete pillbox with its garrison at the edge of a town, while enemy rifle squads advance across the open field past a fresh shell crater" /></td>
  </tr>
  <tr>
    <td><b>Front commanders you can see.</b> Each commander is a staff of four under an HQ pennant. It posts at the nearest safe own town behind its line, fights only in self-defence and steps back from armed enemies. It answers your directive for its own front: the objective, the posture and the battle plan, and the front card says why. Lose the commander and the front holds without pushing for a minute; a replacement is appointed after 90 s if the HQ can pay for it.</td>
    <td><b>Pillboxes, bunkers and fortified zones.</b> Engineers build them, and squads move in when they stop next to one. A pillbox's squad fires a built-in MG that cannot cover the rear. A bunker takes two squads or an AT gun. The garrison stays hidden until it opens fire. Buildings cost no population. Tanks can crack them, but AP shot is capped on concrete.</td>
  </tr>
  <tr>
    <td><img src="docs/media/armour.gif" width="100%" alt="A group of tanks drives across open fields toward a village, with the camera riding behind them" /></td>
    <td><img src="docs/media/effects.jpg" width="100%" alt="A town under shellfire: a house collapses in a cloud of dust and smoke, craters scorch the street, and squads of two sides fight between the buildings" /></td>
  </tr>
  <tr>
    <td><b>Armoured thrusts.</b> Fronts with spare tanks or motorized squads break through at a smaller local edge than infantry fronts, with armour in the lead and motor rifles riding behind until the enemy is close. Light tanks exploit the gap, and medium tanks have the HP and the gun to lead a breakthrough. Spearhead tanks wait for their riflemen instead of running ahead alone.</td>
    <td><b>Effects that depend on what is hit.</b> Shells splash in rivers, bring houses down in dust and rubble, burst on roofs and spark off armour. Vehicles cook off and their wrecks keep burning. Guns throw tapered flames with smoke rings, and ground that has been shelled for a while lies under a faint haze.</td>
  </tr>
  <tr>
    <td><img src="docs/media/artillery.gif" width="100%" alt="A howitzer salvo streaks in over the edge of a city and bursts among the houses, leaving smoke over the streets" /></td>
    <td><img src="docs/media/front.gif" width="100%" alt="Tanks and rifle squads fight at the edge of a village on the front line while a shell arcs in from the woods" /></td>
  </tr>
  <tr>
    <td><b>Artillery you can follow with your eyes.</b> Mortar and howitzer shells fly real ballistic arcs over ridges and roofs, leave glowing trails, and burst on walls and fields. Gunners lead moving targets, and a burst can break up a squad caught in the open. Batteries are sound-ranged by the enemy and must relocate after a few salvos.</td>
    <td><b>Real fronts, not lanes.</b> Ground control is computed from where troops stand. Fronts hold good ground, push when stronger and launch spearheads through weak points. Tanks are tough enough to lead the attack. AT guns still hurt them, but since 2.2 a tank group leading its infantry can break an AT line.</td>
  </tr>
  <tr>
    <td><img src="docs/media/city.gif" width="100%" alt="A street fight in a city: rifle squads and a column of vehicles trade fire between apartment blocks, a church and a factory, with tracer crossing the street" /></td>
    <td><img src="docs/media/river.gif" width="100%" alt="Supply trucks cross a stone bridge over a river while rifle squads hold the fields on both banks" /></td>
  </tr>
  <tr>
    <td><b>Towns are solid and worth holding.</b> Every building has collision: troops move through the streets, and walls block sight lines, direct fire and incoming shells. Each town adds income, production slots, a supply stock and population, and lots for economic buildings, so the supreme HQ garrisons threatened towns and sends detachments to occupy open ones.</td>
    <td><b>Rivers shape the war.</b> Valleys carry rivers with bridges and fords. Fronts stage before a crossing, mass, then force it, and engineers throw pontoon bridges across when the nearest crossing is a long detour.</td>
  </tr>
  <tr>
    <td><img src="docs/media/overview.gif" width="100%" alt="Whole-map view of a generated war: four armies' unit counters, front lines and war-map arrows among rivers, ranges, forests, towns and cities" /></td>
    <td><img src="docs/media/convoy.gif" width="100%" alt="A supply truck leaves a town and crosses a river bridge on its way to the front" /></td>
  </tr>
  <tr>
    <td><b>Every map is new.</b> Each seed builds a large map (about 3.6 km square for four sides) with mountain ranges and passes, rivers along the valleys, forests, a field patchwork, over a hundred villages, street-grid towns, cities with towers, and a capital per faction.</td>
    <td><b>Supply you can see and cut.</b> Logistics fill the supply stocks of the capital and every held town (efficiency drops with distance), and trucks load there and carry ammunition to the lines. Units rearm gradually and less in a crowd, and a front-line town drained by an offensive takes time to fill up again. Raiders slip through weak stretches of the front to ambush convoys and wreck economic buildings; rear guards and garrisons hunt them.</td>
  </tr>
  <tr>
    <td><img src="docs/media/march.gif" width="100%" alt="Rifle squads marching in file follow a hedge round a field corner beside a village road, each soldier facing the way he walks" /></td>
    <td><img src="docs/media/garrison.jpg" width="100%" alt="Defenders hold the corners of houses at the edge of a town, a dug trench behind them, while attackers close in across the field" /></td>
  </tr>
  <tr>
    <td><b>Soldiers, not tokens.</b> Every soldier walks to his own place in the formation at a walking pace, turns gradually and strides by the ground he covers, so feet don't slide. On roads a squad marches in file or column and wheels through bends along the leader's path. Gun crews walk round their piece as it traverses.</td>
    <td><b>Terrain and buildings fight too.</b> Squads shelter behind houses and fire from the windows, with heavy cover on that side, until HE brings the building down. Church towers and steeples serve as observation posts. Troops that hold fire in a forest are only spotted at close range. High ground improves aim and artillery spotting, and a crest hides defenders from fire coming uphill. Fords and bridges leave troops exposed. A front commander snaps a defence line to good ground: the enemy-facing edges of towns and woods, crests and the lee side of buildings.</td>
  </tr>
</table>

### Battle plans, sieges and doctrines

<img src="docs/media/plans.jpg" width="100%" alt="War-map arrows: two groups swing round a river bend to close on a village, while a hatched siege line rings a city" />

Inside your order, every front commander attacks with a **battle plan**, drawn on the map as a war-room arrow under your order line. The commander picks it from the front's force mix, the target and its doctrine:

| Plan | What the troops do |
|---|---|
| **Frontal push** | The whole line advances steadily. |
| **Flank** | A mobile group (tanks, motorized rifles, recon) swings round to a waypoint on the weaker side, forms up, then strikes from the side while the line pins the enemy. |
| **Pincer** | Both wings swing round and close on the same objective together. |
| **Infiltrate** | Small rifle teams slip through the weakest stretch of the enemy line to seize the objective. |
| **Siege** | Against a defended town: ring it outside direct-fire range and dig trench lines. Storm it once the garrison is worn down. |

<table>
  <tr>
    <td width="50%"><img src="docs/media/works.jpg" width="100%" alt="Zig-zag trench lines with sandbagged parapets dug in a town, the garrison standing behind them" /></td>
    <td width="50%"><img src="docs/media/motorized.jpg" width="100%" alt="Motorized rifles riding troop trucks across the fields" /></td>
  </tr>
  <tr>
    <td><b>Field works.</b> Besiegers dig zig-zag trenches, and garrisons stack sandbag barricades. A threatened capital digs a ring of trenches on the approach, in front of its standing line of trenches and pillboxes. Troops behind finished works get the best cover against shells and fire from the front, so neither side can simply shell the other off the map. Digging costs manpower.</td>
    <td><b>Motorized rifles.</b> They ride trucks on long, safe trips and dismount near the enemy, when fired on or at the end of the trip. On an armoured thrust they stay mounted until the enemy is within 220 m. They are fast for flanks and quick captures, but vulnerable while mounted.</td>
  </tr>
</table>

**Doctrine.** Before a battle, choose *balanced*, *infantry first*, *armour first*, *mechanized* or *artillery first*. Your doctrine sets your production mix and the plans your front commanders prefer. Each AI faction has its own doctrine.

Also inside:
- **Territory is the economy.** Your capital alone feeds about a third of a full army. Villages supply recruits (manpower), and towns and cities supply industry (munitions), production slots, supply stocks, population and lots for economic buildings. Since 2.2 a settlement on its own yields half of its old income, and its buildings make up the rest. The mobilisation and industry sliders scale the output of all your territory. Losing ground shrinks your war effort, and losses take real time and money to replace. Every P/M spent on a factory is a squad not built, so economy against army is a real choice.
- **Thousands of soldiers.** Several hundred tactical units (squads, guns, tanks, trucks) with instanced rendering. Squads change formation with the situation (file on the road, wedge or teams on the move, a firing line in contact), and zoom-level unit counters keep the picture readable.
- **An orchestral score.** The music follows the fighting: a calm main theme, a tension theme as the fighting builds, a battle ostinato under heavy fire, a lament when you are losing ground, and stingers for victory, defeat and a fallen capital. A composer writes it bar by bar in 8-bar phrases with voice-led harmony and seeded variation, and plays it on strings, horns, brass, reeds, timpani and snare synthesized in a worker. Rifle volleys, MG bursts, cannon and shell whistles are synthesized too. The game ships no audio files; `npx vite-node scripts/music-preview.ts` renders the score to WAV files so you can listen offline.
- **Rules first.** Armour facing and penetration, HE blast, cover, suppression, morale, and line of sight over terrain and buildings all follow a written balance spec.

## Download and play

| | |
|---|---|
| **Windows (recommended)** | Download from **[Releases](https://github.com/Zwl20085/LittleWarGame/releases/latest)**. `LittleWar-<version>-portable.exe` is a single file with nothing to install. `LittleWar-<version>-setup.exe` is an installer with Start-menu and desktop shortcuts. |
| **Any OS, from source** | `npm install` then `npm run dev` and open http://localhost:5173, or `npm run app` for the desktop window. |

> [!NOTE]
> The Windows build is not code-signed, so SmartScreen may warn on first launch. Choose **More info → Run anyway**. You need a GPU with WebGL2 (any graphics card from the last ~8 years). Press **F11** for fullscreen.

## How a war plays

```mermaid
flowchart LR
  A[Capital and held towns<br/>income · supply stock · build slots · economic buildings] --> B[Production<br/>each town builds in its own queue]
  H[You: supreme HQ<br/>one directive · optional axis or line] --> C
  B --> C[Fronts, each under a front commander<br/>its own answer: main effort · support · pin · hold]
  C --> D{Front line}
  G[Capital garrison<br/>3 squads · trenches · pillboxes] --> D
  D -- capture towns --> A
  D -- take every enemy capital --> V[Victory]
  A -- stocks --> S[Supply convoys]
  S --> C
  D -- raids --> S
  D -- raids --> A
```

1. **Mobilise.** Your capital, cities and towns build units according to the weights in the bottom bar, each in its own queue, and invest in factories, recruiting offices and depots. A steward balances mobilisation, industry and logistics, or you take over. New units join the front they are needed on, but first pick up ammunition at the nearest stock or truck; the main effort gets first call on reinforcements and supply.
2. **Command.** You are the supreme HQ. Give the army one directive: **general offensive** (optionally toward an axis), **steady advance**, **general defence** (optionally of a threatened place), **fortify and hold** (optionally along a line you draw), or **strategic contraction** to the nearest line of your own towns. Each front commander answers it for his front: objective, posture, battle plan, the battle line snapped to good ground, crossings and armoured thrusts, and the card says what he chose. You can still select units and give them direct orders when you want to.
3. **Hold the capital.** From the first minutes every capital keeps a standing garrison of 3 squads, and engineers build a line of 2 trenches and 2 pillboxes in front of it. When a threat is forecast, the HQ recalls the nearest fronts and digs more works on the approach.
4. **Fight for ground.** Every one of the 100+ settlements can be captured. Each one you take feeds your economy and starves the enemy's, and a captured town keeps its economic buildings, damaged, for the new owner.
5. **Win.** A side is eliminated when enemy infantry capture its **capital**, and the war ends only when one side holds every capital. No resolve meter, no time limit and no territory rule: you can lose half your land and still fight back.

## Controls

**Supreme HQ directive** (the main way to play)

| Input | Action |
|---|---|
| <kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> <kbd>V</kbd> <kbd>B</kbd> or the HQ card's palette | Issue the directive: General offensive · Steady advance · General defence · Fortify and hold · Strategic contraction |
| Left click on the map (after Offensive, Defence or Fortify) | Optional: set the axis of the main effort, or the threatened place that gets the reserves |
| Left drag (25 px or more, after Fortify) | Optional: draw a line that becomes a permanent fortified zone |
| <kbd>Shift</kbd> while placing | Keep the directive armed for another click |
| Right click or <kbd>Esc</kbd> | Skip the optional click (the directive stands) |
| <kbd>1</kbd>–<kbd>8</kbd> or click a front card | Open or close that front's dossier: its answer to the directive, plan, position and units |
| Fortified zones list on the HQ card | Progress of each permanent zone; Cancel stops the work (standing works remain) |
| Click a town or city on the map | Town panel: supply stock, local production queue (queue a unit here), economic buildings (build or rebuild) |

Fronts are opened, merged and dissolved by the theatre itself; there is no key for it any more.

**Units** (optional direct control)

| Input | Action |
|---|---|
| Left click / drag | Select units (<kbd>Shift</kbd> adds) |
| Right click ground / enemy | Move / focus fire (<kbd>Ctrl</kbd>: move and hold, <kbd>Shift</kbd>: queue) |
| <kbd>A</kbd> <kbd>H</kbd> <kbd>R</kbd> <kbd>G</kbd> | Attack-move · hold · retreat · rejoin the front |

**Camera and game**

| Input | Action |
|---|---|
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or middle-drag, <kbd>Q</kbd>/<kbd>E</kbd>, wheel | Pan · rotate · zoom |
| <kbd>Ctrl</kbd>+wheel or <kbd>PgUp</kbd>/<kbd>PgDn</kbd>, <kbd>Tab</kbd>, <kbd>F</kbd> | Camera pitch · overview · follow the selected unit |
| <kbd>Space</kbd> <kbd>U</kbd> <kbd>Esc</kbd> | Pause · hide HUD · cancel / menu |
| <kbd>F11</kbd> · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> | Fullscreen · developer console (desktop app) |

Game speed: 1× / 2× / 4× / 8×. If the simulation can't keep up, the game slows down and shows a notice. It never skips ticks.

**Graphics quality** (Settings, on the title screen or in the Esc menu): *auto* (default), *high*, *medium* or *low*. Auto starts at a tier guessed from your graphics card, drops one tier after about 3 s of slow frames and tells you when it does.

**Quick Battle** is fought under fog of war; a Custom game has its own fog toggle, and Spectate shows everything. **Update check:** the title screen looks for a newer release on start (Settings → *Check for updates on start* turns it off).

## Under the hood

```mermaid
flowchart LR
  subgraph Worker[Web Worker: deterministic simulation, 20 Hz]
    MG[Map generator] --> T[Terrain · buildings · navigation]
    T --> AI[Supreme HQ → fronts and front commanders → units]
    AI --> CB[Combat · structures · morale · supply · economy]
  end
  Worker -- packed snapshots --> Main
  subgraph Main[Main thread]
    R[Three.js diorama<br/>instancing · soldier motion · effects · order lines] --- UI[War-room HUD · i18n]
    AU[Score composer · mixer]
  end
  subgraph Orch[Web Worker: orchestra]
    OR[Synthesized instrument samples]
  end
  OR -- samples --> AU
  UI -- commands --> Worker
```

- **Deterministic simulation.** Fixed 20 Hz ticks with seeded RNG, so the same seed and the same commands give the same war. A test checks this. The simulation runs in a Web Worker, and the main thread only draws.
- **One command hierarchy for everyone.** The supreme HQ (you, or the AI planner) decides the war effort and gives one directive with an optional axis or line. The theatre opens, merges and dissolves fronts and keeps the capital's garrison for every side. Each front commander turns the directive into its own response (main effort, support, pin, hold, counter-attack, fall back), then decides the objective, the posture, the battle plan, the slots on the line, crossings and spearheads. Units decide targets and cover. The AI supreme HQ thinks every 5 s and issues its directive through the same `setDirective` command the UI sends ([COMMAND_V2 §7](docs/COMMAND_V2.md), [STRATEGY_LAB Round 6](docs/STRATEGY_LAB.md)).
- **Logistics through places.** Every held place is a supply node with a stock, a draw radius, its own build slots and queue, and lots for economic buildings; stocks and buildings travel to the main thread in the snapshot for the town panel and the stock gauges. Rearming is a rate with a crowding penalty, and convoy hand-overs are capped per 200 m cell. Numbers live in `docs/data/rules.json` (`logistics`, `econ`).
- **Structures.** Pillboxes and bunkers are engineer-built forts with HP, a garrison, all-round cover, a raised muzzle and concealment until they fire. Hits resolve through a per-tick fort index, and garrison checks run every 10 ticks per unit. Rules and numbers: [BALANCE_SPEC §10.1](docs/BALANCE_SPEC.md).
- **Data-oriented hot paths.** Lazy flow fields (Dial's algorithm) are shared per goal, and paths are built in 320 m stretches. A cell-sorted spatial hash handles queries, and a 2 m building raster with local detours handles movement through towns. In 2.0 the enemy-distance transform moved to a 32 m grid (2.8 % → 0.8 % of sim CPU), and defensive-position and cover searches are cached. Over the releases the mean tick fell from 4.5 ms (0.5) to 2.7 ms (1.0) and 1.6 ms at about 330 units (1.1) ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

| 2.0, paired run, same seed and machine | foundation commit | 2.0 head (all systems) |
|---|---|---|
| Units at 10 min | 398 | 391 |
| Mean sim tick | 1.5 ms | 1.4 ms |
| p50 / p90 / p99 | 0.8 / 2.8 / 10.7 ms | 0.7 / 2.6 / 11.1 ms |

  Browser at 8× (headless Edge, 1600×900, high quality, ~380–420 units, measured while a soak ran on the same machine): `renderer.frame` 5.1 ms at the overview, 3.9 ms at the front, 4.7 ms close in; 8.00× / 7.99× achieved with 0 % lag frames.

| 2.2 render round, seed 7 at 20 min (~450 units), 8× | 2.1 | 2.2 |
|---|---|---|
| fps overview / front / close | 57.7 / 58.4 / 58.6 | 60.0 / 60.0 / 60.0 |
| `renderer.frame` overview / front / close | 7.19 / 5.52 / 5.36 ms | 5.72 / 4.36 / 3.77 ms |
| `gl.render` overview / front / close | 4.11 / 3.29 / 3.34 ms | 2.86 / 2.22 / 2.03 ms |
| worst frame (front) | 66.8 ms | 17.2 ms |

  The stalls came from shader programs relinked whenever overlay route lines were rebuilt, a minimap that repainted the control field cell by cell, forced layouts in the HUD and full instance-buffer uploads every frame ([PERFORMANCE, 2.2 round](docs/PERFORMANCE.md#22-round-render-agent)). The simulation step is unchanged by that round; the mean tick is 2.5–3.0 ms at 430–450 units at 25 min.

- **Render budget.** Settlement markers are drawn as 4 instanced meshes instead of about 600, and larger vegetation and settlement tiles bring the scene down to about 500 objects. Impact effects are pooled. Map labels come from cached sprites. Each soldier is a few floats in a flat array, stepped every frame, with no per-soldier objects. Quality tiers set the shadow map, pixel ratio, scatter and effect detail.
- **Numbers you can inspect.** Balance and AI changes are tested in headless wars before they ship:
  - `scripts/balance.ts` prints a ledger for each unit type, a kill matrix and an economy timeline.
  - The **balance lab** (`scripts/lab.ts`) runs A/B experiments with data overrides on the same seeds and checks army fullness, hoarding, attrition and territory churn against target bands ([docs/BALANCE_LAB.md](docs/BALANCE_LAB.md), Chinese). The 2.0 attack-side round is §5.6; the 2.2 AT gun nerf and the armour, economic war and supply round are the last two entries (`scripts/lab/at-assault.ts`, `scripts/lab/war22.ts`).
  - The **shelter lab** (`scripts/roadside-lab.ts`) shells a squad in the open next to a roadside building, with and without taking cover.
  - The **strategy lab** (`scripts/strategy.ts`) records every operation, engagement and capture, then reports which plans work against which odds and terrain ([docs/STRATEGY_LAB.md](docs/STRATEGY_LAB.md)). With the 2.0 supreme HQ, operation success went from 20.5 % to 30.5 % and capitals lost to stoppable attacks from 2 to 1 (3 seeds × 30 min).
  - The **challenge lab** (`scripts/challenge.ts`) attacks the AI with scripted supreme-HQ strategies through the real command API (below).
  - The **soak test** (`scripts/soak.ts`) plays whole wars and flags NaNs, stuck units, idle fronts and slow ticks.

### Challenge lab: can the AI survive a scripted strategy?

A player once won by sending every unit at an enemy capital. The challenge lab turns that into a test. One faction, the *challenger*, plays a scripted strategy through the same commands the UI sends, while the normal AI plays the other three. It reports whether the AI kept its capital, when it raised the alarm, which fronts it recalled, what works stood around the capital and whether it counter-attacked ([docs/CHALLENGE_LAB.md](docs/CHALLENGE_LAB.md)).

| Strategy | What it does |
|---|---|
| `rush` | tanks and infantry only; at 3, 5 or 10 min a general offensive with the nearest enemy capital as the axis |
| `turtle` | fortifies along a line 400 m out, then switches to tanks at 25 min and attacks the weaker neighbour |
| `two_axis` | general offensives whose axis alternates between the two nearest neighbours |
| `raid` | fast units; offensives on the least defended villages and towns far from their capital |
| `late_blitz` | fortifies until 15 min, then a general offensive on the nearest capital |
| `human_like` | defends when threatened, strikes a neighbour whose capital is thinly held |
| `rush_micro` | no directive: every combat unit gets a direct attack-move on the nearest capital |

In the first baseline the AI survived every blunt strategy. The one loss led to the Round 7 defence fixes: holders on the HQ point, a forecast of the defenders that can actually block a capture, the nearest group's arrival time, and a counter-attack.

| strategy (3 seeds × 40 min) | AI keeps its capital | … when not outmatched (attacker < 2× the AI army) |
|---|---|---|
| rush at 3 / 5 / 10 min | 67 / 67 / 33 % | 100 / 100 / 100 % |
| turtle · two axes · late blitz · human-like | 100 % each | 100 % |
| raid | 67 % | 100 % |
| every unit on the capital (`rush_micro`) at 3 / 5 / 10 min | 67 / 100 / 100 % | 67 / 100 / 100 % |
| **all 33 matches** | 27 / 33 | **32 / 33** |

A capital taken by a challenger fielding at least twice the defender's army counts as a legitimate loss. The one remaining failure is a 3-minute direct rush on one seed at 1.2×, where the holders on the HQ point were suppressed. In 2.2 the strategies drive the universal directive instead of per-front orders, and the challenger gets the theatre's own front management, so it is a stronger opponent; in the 2.2 strategy round the AI kept its capital in all 21 matches (7 strategies × 3 seeds × 40 min). Full tables and the A/B switches: [docs/CHALLENGE_LAB.md](docs/CHALLENGE_LAB.md).

```bash
npx tsx scripts/challenge.ts --all --rushAt 300,180,600 --seeds 7,11,13 --jobs 8   # the baseline
```

<details>
<summary><b>Sample balance ledger</b> (<code>npx tsx scripts/balance.ts 15 7</code>: 1 seed × 15 min, 4 AI factions)</summary>

```
== Operations launched / won ==
flank 24  frontal 21  infiltrate 10  pincer 9  siege 21  won:flank 4

type            built  lost  K/D   kills  dmgOut  dmgIn  dmg/min/unit  value-kill/spent  dmg/cost  share
infantry          102    72  0.79     57     49k    72k         18.9             0.60      6.00  44.5%
light_tank         32     5  3.40     17     19k   8.5k         88.5             0.25      2.72  17.4%
howitzer           31     3  4.67     14     15k   2.0k         97.9             0.19      1.75  13.3%
medium_tank        17     0     -     11     11k   1.4k        147.4             0.21      1.77   9.6%
recon              56    35  0.23      8    8.6k    21k         10.3             0.14      1.93   7.8%
mg                  8     2  4.00      8    5.3k    919         58.7             0.64      5.28   4.8%
```

It also prints an attacker × victim kill matrix, damage shares by attacker for each victim type, and an economy timeline: units, population against cap, settlements held, income and stock per faction every 5 minutes. This sample predates the 2.0 data changes.
</details>

## Roadmap

<img src="docs/media/roadmap.svg" width="100%" alt="War-map roadmap: an inked road through shipped versions 0.4, 0.5, 1.0, 1.1, 2.0 and 2.1 fortress war to 2.2 economic war, this release, then a dashed road through planned stops 2.3 sharper AI and 2.x rivers, records and campaign" />

> [!NOTE]
> Everything past 2.2 is a plan, not a promise. Stops may move, merge or drop out as playtesting shows what matters.

<table>
  <thead>
    <tr><th align="left">Stop</th><th align="left">Item</th><th align="left">Status</th></tr>
  </thead>
  <tbody>
    <tr><td>0.4</td><td>First diorama: deterministic simulation, generated maps, territory economy, convoys, Windows desktop app</td><td><img src="https://img.shields.io/badge/shipped-3a3326?style=flat-square" alt="shipped" /></td></tr>
    <tr><td>0.5</td><td>Battle plans, sieges and field works, motorized rifles, doctrines, capital-only defeat</td><td><img src="https://img.shields.io/badge/shipped-3a3326?style=flat-square" alt="shipped" /></td></tr>
    <tr><td>1.0</td><td>Soldier motion, terrain and buildings in combat, orchestral score, retuned AI, graphics quality</td><td><img src="https://img.shields.io/badge/shipped-3a3326?style=flat-square" alt="shipped" /></td></tr>
    <tr><td>1.1</td><td>Artillery and unit identity, capital defence, siege and storm, capital-only victory</td><td><img src="https://img.shields.io/badge/shipped-3a3326?style=flat-square" alt="shipped" /></td></tr>
    <tr><td>2.0</td><td>Supreme HQ and front commanders, pillboxes and bunkers, armoured thrusts, challenge lab, impact effects</td><td><img src="https://img.shields.io/badge/shipped-3a3326?style=flat-square" alt="shipped" /></td></tr>
    <tr><td>2.1</td><td>Fortress war: permanent fortified zones, binding orders, stronger and cheaper works, capital pillboxes, grounded units and detailed towns</td><td><img src="https://img.shields.io/badge/shipped-3a3326?style=flat-square" alt="shipped" /></td></tr>
    <tr><td><b>2.2</b></td><td><b>Economic war: one supreme-HQ directive answered by every front, supply stocks in every town with gradual rearm, per-town production, factories, recruiting offices and depots with raids, roadside farms as cover, armour groups, a weaker AT gun, fog-of-war Quick Battle, update check, a smoother renderer</b></td><td><img src="https://img.shields.io/badge/this_release-a63f36?style=flat-square" alt="this release" /></td></tr>
    <tr><td>2.2.x</td><td>Endgame pace: near-equal two-way duels can still run past an hour under capital-only victory (finisher and attrition tuning); supply that really starves an over-extended offensive</td><td><img src="https://img.shields.io/badge/in_progress-8a6a2c?style=flat-square" alt="in progress" /></td></tr>
    <tr><td>2.3</td><td>Fog-of-war challenge runs and harder AI difficulties</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.3</td><td>AI bunker garrisons with AT guns, using captured enemy works</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.3</td><td>Fortifications that block movement</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.x</td><td>Naval and river crossings under fire</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.x</td><td>Save and replay a war</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.x</td><td>A campaign of linked maps</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.x</td><td>Steam-style achievements</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.x</td><td>Localisation beyond Chinese and English</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>2.x</td><td>Mod-friendly unit data</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
  </tbody>
</table>

## Build from source

Requires Node.js 18+.

```bash
npm install
npm run dev          # browser: http://localhost:5173
npm run app          # desktop window (Electron)
npm run dist:win     # Windows portable .exe + installer → release/
```

<details>
<summary><b>Development commands</b></summary>

```bash
npm test                                          # unit, rule, map and AI smoke tests (vitest)
npm run typecheck
LONGRUN=1 npx vitest run tests/longrun.test.ts    # full-length AI wars

# Balance and AI
npx tsx scripts/balance.ts 15 7                   # unit ledger, kill matrix, economy (minutes, seeds)
npx tsx scripts/lab.ts --seeds 7,11 --minutes 30 --ab --set unit.infantry.cost_p=90  # balance lab A/B
npx tsx scripts/strategy.ts --seeds 7,11,13 --minutes 20 --compare  # strategy lab: plan outcomes, A/B
npx tsx scripts/challenge.ts --all --seeds 7,11,13 --minutes 40 --jobs 6  # challenge lab: scripted strategies vs the AI
npx tsx scripts/soak.ts 45 7,11,13                # whole wars: outcome, anomalies, tick cost (minutes, seeds)

# Performance
npx tsx scripts/perf.ts generated 600 7           # headless ms/tick (mean, p99), stuck units, supply health
node scripts/profile.mjs                          # V8 CPU profile of the same run, hottest functions
node scripts/perf-browser.mjs                     # real game in headless Edge at 8×: fps, renderer phases

# Media
npx vite-node scripts/music-preview.ts            # render the score's scenarios to WAV → media/stats/music
node scripts/capture.mjs                          # record gameplay clips → media/clips
node scripts/capture-page.mjs hero hud --lang en  # record title / HUD clips → media/page
```

URL shortcuts: `?quick` (hand-made 4-way map), `?quick&map=gen&seed=42`, `?quick&map=1v1`, `&fog`, `&spectate`. Unlike the menu's Quick Battle, `?quick` stays all-seeing unless `&fog` is given (the capture and perf scripts rely on that).

Trailer: `cd trailer && npm i && npx remotion studio` to preview. `npx remotion render src/index.ts Trailer ../media/trailer.mp4` exports it.
</details>

<details>
<summary><b>Project layout</b></summary>

```
src/sim/      deterministic simulation: map generator, terrain and buildings, navigation,
              economy, production, combat, structures, morale, supply convoys, front analysis,
              AI (supreme HQ / fronts and front commanders / cities / units), stats ledger
src/render/   Three.js diorama: instanced units, soldier motion, terrain, water, settlements,
              structures, order lines, impact and artillery FX, quality tiers
src/ui/       war-room HUD, title screen, supreme-HQ and front cards, settings, i18n (zh / en)
src/audio/    score composer and themes, synthesized orchestra (worker), sound effects (Web Audio)
scripts/      balance, strategy and challenge labs, soak test, perf and profiling tools, capture scripts
electron/     standalone desktop shell (serves the built game over app://)
docs/         design documents (mostly Chinese) and docs/data/*.csv|json: unit, weapon and rule data
tests/        rule, terrain, map-generation, determinism, structure and AI smoke tests
trailer/      Remotion project for the promo trailer
```

Design docs: [docs/README.md](docs/README.md). Implementation-time decisions are listed in `docs/GAME_DESIGN.md` §2.1.1.
</details>

## Status

**v2.2.** Balance and AI are tuned from headless AI-vs-AI wars and the challenge lab, not yet from much human play. The 2.2 economy, supply and production numbers are new and the least tested part of the game. Wars between four AI sides end less often: capitals with a standing garrison, pillboxes and recall are hard to take, and the endgame storm is still being tuned ([BALANCE_LAB](docs/BALANCE_LAB.md)). What comes next is in the [roadmap](#roadmap).

**Known limitations:** the orchestra is synthesized, not recorded, and sounds like it. Single player only: there is no multiplayer. The Windows build is not code-signed.

## License

MIT. See [LICENSE](LICENSE). The trailer is built with [Remotion](https://www.remotion.dev/), which is free for individuals and teams of up to 3.
