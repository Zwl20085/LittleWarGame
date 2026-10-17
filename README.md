<div align="center">

**English** · [简体中文](README.zh-CN.md)

<img src="docs/media/hero.gif" width="100%" alt="Trailer cut from live play: a war map with fronts, unit counters and attack arrows, shells streaking in over a town at the edge of a forest, tanks driving between villages with rifle squads close behind, rifle squads storming across a railway past a pillbox at the edge of a town, troops crossing a river bridge, and the LITTLE WAR title screen over a live battle with its one-line Quick Battle description and version 3.0.0" />

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

[What's new](#whats-new-in-30) · [Features](#features) · [Download](#download-and-play) · [How a war plays](#how-a-war-plays) · [Controls](#controls) · [Under the hood](#under-the-hood) · [Roadmap](#roadmap) · [Build from source](#build-from-source)

</div>

---

## What's new in 3.0

**3.0.1 — hands-off play.** You can now do nothing and just watch: by default your HQ staff run every 3.0 system for you — **Auto-research** buys upgrades in your doctrine's order, **Auto-engineering** lays road links and repairs rail, and **Auto HQ** picks your directive by your doctrine (pick it in a Custom game as *Your doctrine*, or let Quick Battle draw one). Any order you give takes over: a directive you issue stands until you issue Advance or 10 minutes pass, and each toggle hands a system back to you. The infantry attached-gun upgrade is gone (12 upgrades now).

- **Four AI doctrines that clash.** Every AI supreme HQ now fights with a doctrine that sets its production, investment, directives, front behaviour and appetite for risk. **Builder** takes land and builds the economy first, then turns the lead into a large late army. **Blitz** keeps a compact perimeter, masses armour and motor rifles and launches one deep offensive on an enemy capital. **Attrition** fights from works, pulls damaged units back, keeps fewer, denser fronts and raids convoys and economic zones. **Maneuver** keeps a large mechanized main body that hunts isolated enemy fronts at 1.5:1 and cares about towns only once the enemy army is broken. A Quick Battle deals a different doctrine to each AI; a Custom game lets you pick each AI's doctrine or Random. An enemy's doctrine appears on its faction card after your first fight with it (or after 5 minutes), and the score plays your strongest enemy's theme. In the doctrine lab (36 duels and 6 four-way wars) no doctrine wins or loses 75 % of its matches (win / loss: builder 46 / 21 %, blitz 42 / 29 %, attrition 29 / 29 %, maneuver 21 / 58 %), and a classifier names the right doctrine from a faction's behaviour 71–77 % of the time ([DOCTRINES](docs/DOCTRINES.md), [STRATEGY_LAB](docs/STRATEGY_LAB.md#30-doctrines-wp-a-docsdoctrinesmd)).
- **More fronts, and big fronts fight better.** The 8-front cap is gone (keys <kbd>1</kbd>–<kbd>8</kbd> still pick the first eight, and the card list scrolls). A front of 12, 24 or 40 combat units becomes a **Corps**, an **Army** or an **Army Group**: its batteries fire on one shared barrage point, it hits 5 / 8 / 12 % more often and loses less morale, and it gets supply and reinforcements first. A front with too few troops for its line is marked **Stretched** and fights worse. The theatre wants a front for every 16 troops or 700 m of line, opens one where a cluster of free troops stands, and merges a front that stays under 7 units. In AI wars on the large map, fronts per faction in mid-war rose from 3.9 to 6.6, and the AI still kept its capital in all 21 challenge matches ([COMMAND_V2 §8](docs/COMMAND_V2.md#8-30--unlimited-fronts-front-tiers-directive-compliance-as-built)).
- **Front commanders may decline.** A directive is no longer obeyed blindly. Each front weighs it against the enemy strength at its objective, the own towns it would leave open and its ammunition; fronts near the capital answer sooner and more readily. A front that declines says why on its card ("Declined — enemy 2.4:1, would expose Greycrest") and does the best thing it can locally; the fronts that accept move in order of distance from the capital. Give the same directive again within 30 s, or switch on **Force** on the HQ card, and every front obeys at once. A defence of your own capital is never declined by the fronts near it.
- **Roads and railways.** Roads are now a movement layer: off the road tanks run at 0.6×, trucks at 0.4× and infantry at 0.75×, so armies funnel onto roads, junctions and bridges. Railways join every capital to its cities, with stations. A unit sent far rides a train (up to 6 squads or vehicles, three times truck speed) when a station lies near both ends of a line its side holds whole; an enemy on any station cuts the line, and supply moves along held lines as stock. Engineers lay roads, rebuild cut track and extend the rail to a town from the new **Engineering** popover (<kbd>I</kbd>). In the transport lab a 20-unit force crossed the large map in 302 s by rail against 984 s without it, and the share of fights within 150 m of a road junction rose from 52–61 % to 56–66 %.
- **Economic zones anywhere.** Engineers build an economic zone on own or neutral ground away from the towns (economy panel → **Build economic zone**, then a click on the map). Level 1 is cheap; levels 2 and 3 are further engineer jobs from the zone's panel. A zone with a road link to an own town pays in full, an unlinked one half. Zones can be shelled, raided, captured and rebuilt from the ruins, and the AI and your auto-invest place them where the land is safe and a road is near. In the economy lab a builder HQ that invests in zones was ahead of the same seed without them by 602 strength at 20 minutes and by 2 621 at 45.
- **Works that hold.** Engineers upgrade works in place (pillbox → bunker → **fortress**, trench → fortified trench), dig **AT emplacements** and lay **minefields** that slow and damage vehicles until enemy engineers clear them. Manned works also observe farther and spot for the artillery. Every capital gets an **absolute defence perimeter**: five free strongpoints with machine guns, guns and bunker armour that only armour can storm, and an observation ring under fog of war. In the defence lab a tank-led assault at equal cost won 33 % of its trials in the open and 83 % against pillboxes, but none against bunkers or a fortress line; two rows of mines knocked out 15 of 20 tanks.
- **Unit upgrades.** The supreme HQ researches 12 upgrades at the capital, one at a time (**Upgrades**, <kbd>Y</kbd>): armour-piercing grenades, full motorization, tank armour I–III (side skirts) and gun I–III (a longer barrel), artillery range, truck capacity, engineer speed and a staff upgrade that lowers the front tiers. Each upgrade makes the next dearer, and the AI buys by doctrine. Motorized reinforcements reached a town 1.6 km away in 364–467 s, where the same squads on foot took 787 s or never arrived. With 1.5× income the rich side led at the end of all 12 lab wars, but only 2 of them ended within the hour (at 45 and 55 minutes): an economic lead snowballs slowly.
- **Infiltrators get caught.** An enemy within 150 m of a front's line units moves at half speed and is revealed, and slipping between two line units less than 250 m apart counts as contact. Fronts post pickets every 220 m and keep a motorized or tank reaction group behind the line. A raid deep in your ground is reported (**Infiltrator reported**, with a blinking ring on the minimap), the nearest free units hunt it, and the towns and zones near it post a screen. In the infiltration lab the share of raiders that got past the line unseen fell from 21 % to 0 %, and the AI kept its capital in all 42 challenge matches, shadow strikes and backdoor raids included, for 5–10 % more simulation time ([COMMAND_V2 §9](docs/COMMAND_V2.md#9-30--sparse-fronts-and-infiltration-as-built-wp-e)).
- **The debug lab finds what looks like a bug.** `scripts/lab30/anomaly.ts` plays whole wars and flags ammo-starved herds, dry supply chains, idle herds, stuck units, convoy loops, phantom fronts and unreachable orders, each with a root-cause guess. It found why tanks herded without ammunition: trucks fled from the line and drove home full, and units walked kilometres to a stock. Trucks now hand over where they meet units short of ammunition and fall back only 160 m when threatened. Ammo-starved episodes fell from 156 to 106 and the unit-time spent starved was halved (2 745 → 1 380 unit-windows) ([DEBUG_LAB](docs/DEBUG_LAB.md)).
- **Cameras for watching a war.** **Orbit** (<kbd>O</kbd>), **follow** a unit or a front (<kbd>F</kbd>, or double-click a front card), the **battle cam** (<kbd>K</kbd>: it finds the hottest fight you can see and cuts to the next one every 12–20 s) and the **overview** (<kbd>Tab</kbd>, again to come back), with eased moves and a camera strip on the HUD. The battle cam respects the fog of war. The light drifts from dawn through noon to dusk over the first hour of a war (Settings → *Time of day drifts*), and a light depth blur can be switched on for low close-in views on the high tier.
- **Automatic updates.** The desktop app downloads each new release as an Ed25519-signed game bundle in the background, checks its signature, size and hash, and plays it from the next start (or at once with **Restart now**). A release that needs a newer shell downloads the installer to your Downloads folder instead and never runs it. **Auto-download updates** in Settings turns it off. 2.2.x has only the update notice, so 2.2 players install 3.0 once by hand; from 3.0 on, updates arrive by themselves ([UPDATER](docs/UPDATER.md)).
- **A score for each doctrine.** Each doctrine has its own theme (pastoral strings for the builder, trumpet anapests over a driving ostinato for the blitz, a low march of trombones and timpani for attrition, galloping horns for maneuver). New cues mark an offensive you launch, your capital falling and a quiet spell, and the strings now move in four-part voice leading in a new hall ([MUSIC](docs/MUSIC.md)).
- **A wider challenge lab.** New scripted opponents attack the AI: an armour raid, a shadow strike (a detachment routed outside every defender's sight), a backdoor raid, a feint, an economic war, a siege and one per doctrine. Each match is scored with player-experience metrics: one-sidedness, a cheap-win index, warning time before a capital falls and pacing ([CHALLENGE_LAB](docs/CHALLENGE_LAB.md#30-diversity-suite-and-player-experience-metrics-wp-i)).

<details>
<summary><b>What was new in 2.2</b></summary>

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

</details>

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
<img src="docs/media/doctrines.gif" width="100%" alt="War-room HUD early in a war: the pointer moves along the enemy faction cards in the top bar, each labelled with its doctrine, and the tooltips read Builder, economy and land first; Maneuver, seek the decisive battle; Attrition, hold, preserve, interdict. Then a blitz army's tanks and trucks push between apartment blocks into an enemy city, and an attrition raiding party in loose file crosses the fields toward an enemy village" />
<br/><sub><b>Four doctrines, four kinds of war.</b> Every AI supreme HQ fights with a doctrine: Builder, Blitz, Attrition or Maneuver. Once you have fought an enemy, its doctrine stands on its card in the top bar, and hovering the card names it in full. Below, two of them at work: a blitz army drives into an enemy city, and an attrition raiding party sets off for an enemy village behind the lines.</sub>
</div>
<br/>

<div align="center">
<img src="docs/media/fronts.gif" width="100%" alt="War-room HUD in a mid-war match: the player presses General offensive and clicks an enemy capital; the front cards, badged Corps and Army, answer: two fronts take the order and move within seconds, the fourth stamps Declined, enemy 2.9 to 1; then the player presses Force, a notice says every front must obey, and every card turns to Forced, Attack" />
<br/><sub><b>Fronts that answer back.</b> Fronts are as many as the war needs, and a big front is a <i>Corps</i>, an <i>Army</i> or an <i>Army Group</i>, with massed artillery, better aim and morale, and first call on supply. Here the player orders a general offensive on an enemy capital: fronts near the capital take it within seconds, while the fourth front, facing 2.9 to 1, declines and says so on its card. <b>Force</b> overrides them, and every front attacks.</sub>
</div>
<br/>

<table>
  <tr>
    <td width="50%"><img src="docs/media/rail.gif" width="100%" alt="A short steam train stands at a station between a factory and town houses, then runs out along its single track over a rail bridge across a river; then an engineer team works between two villages and a new road appears across the fields joining them" /></td>
    <td width="50%"><img src="docs/media/zones.gif" width="100%" alt="The player opens the economy panel, presses Build economic zone and clicks a site by a farm road; level 1 sheds appear; the zone panel then reads Level 1, output +10 P / +20 M per minute, road link to an own town, and the player raises it to level 2, after which a larger works with chimneys stands on the site and the panel shows +20 P / +40 M" /></td>
  </tr>
  <tr>
    <td><b>Roads and railways.</b> Off the road, tanks, trucks and infantry slow right down, so the fighting gathers at road junctions and bridges. Units sent far ride the train when a line their side holds whole runs near both ends, and a station in enemy hands cuts the line. Engineers lay roads and rebuild and extend the rail. Here a train takes on squads at a city station and runs across the river on its own line, then engineers finish a road between two villages.</td>
    <td><b>Economic zones.</b> Engineers build an economic zone on open ground away from the towns and raise it to level 2 and 3. A road link to an own town doubles its output. Zones are targets: the enemy shells and raids them, and they change hands with the ground. Here the player sites a zone by a farm road, then raises it from level 1 to level 2.</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/media/works.gif" width="100%" alt="Three 3.0 works close up: a concrete strongpoint of a capital's defence perimeter with its rifle garrison around it inside a wire fence; a dug-in AT emplacement under a camouflage roof on open ground before a capital; and a heavy tank that has driven into a staked minefield, stopped among craters, with a medium tank beside it" /></td>
    <td width="50%"><img src="docs/media/upgrades.gif" width="100%" alt="The Upgrades panel lists AP grenades, full motorization, tank armour I to III and tank gun I to III with prices and research times; the player starts Tank armour I and a research bar begins to fill. Then a medium tank with side skirts and a long barrel drives along a country road, and a rifle squad stands in a village street" /></td>
  </tr>
  <tr>
    <td><b>Works that hold.</b> Pillboxes become bunkers and fortresses, trenches are reinforced, AT guns dig in, and minefields slow and wreck vehicles until engineers clear them. Every capital has a free defence perimeter of strongpoints that only armour can storm. At equal cost a tank-led assault took open ground a third of the time and no bunker or fortress line at all. In the clip: a perimeter strongpoint with its garrison, a dug-in AT emplacement on a capital's approach, and a heavy tank caught in a minefield the script laid across its route.</td>
    <td><b>Unit upgrades.</b> The capital researches one upgrade at a time: AP grenades, full motorization, tank armour (side skirts) and tank guns (longer barrels) in three steps, artillery range, truck beds, engineer tools and staff work. Tanks and squads refit when they next rearm at a town. In the clip the player starts Tank armour I; the tank shown carries armour II and gun III. (The clip predates 3.0.1, which removed the attached-gun upgrade.)</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/media/infiltration.gif" width="100%" alt="Six enemy rifle squads in file cross the fields deep in the player's rear toward a town, under an Infiltrator reported caption, with the player's minimap in the corner" /></td>
    <td width="50%"><img src="docs/media/camera.gif" width="100%" alt="Three camera modes in the HUD: K, the battle cam cuts from a river crossing to a fight between city tower blocks; F, the camera rides behind a selected medium tank as it drives into a village; Tab, the view flies out to the whole war map with its fronts and comes back" /></td>
  </tr>
  <tr>
    <td><b>No more walking through the line.</b> Enemies near a front's line units are slowed and revealed, pickets cover the gaps and a reaction group waits behind the line. A raid that still gets through is reported with a blinking ring on the minimap, and the nearest free units hunt it while rear towns post a screen. Here six enemy squads have slipped deep into the rear: they are reported, slowed and tracked as they head for a town.</td>
    <td><b>Cameras for watching.</b> <kbd>K</kbd> is the battle cam: it finds the hottest fight you can see, frames it and cuts to the next. <kbd>F</kbd> follows the selected unit or front, <kbd>O</kbd> orbits and <kbd>Tab</kbd> flies out to the overview and back.</td>
  </tr>
</table>
<br/>

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
    <td><img src="docs/media/overview.gif" width="100%" alt="Whole-map view of a generated 3.0 war: four armies' unit counters, front lines and war-map arrows among rivers, ranges, forests, towns and cities, the camera slowly zooming in" /></td>
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

**Doctrine.** Before a battle, choose *balanced*, *infantry first*, *armour first*, *mechanized* or *artillery first*. Your doctrine sets your production mix and the plans your front commanders prefer. Since 3.0 each AI supreme HQ also fights with one of four war doctrines (Builder, Blitz, Attrition, Maneuver; see [What's new](#whats-new-in-30)), which go deeper than the production mix: investment, directives, raids, front density and risk.

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

**Updating.** From 3.0 the desktop app updates itself: each release carries a signed game bundle that the app downloads, verifies against the public key built into it, and plays from the next start. If the bundle cannot start, the app falls back to the game it shipped with. A release that needs a newer desktop shell saves the new installer to your Downloads folder for you to run. **Coming from 2.2.x?** That version can only point you at the release page, so download and install 3.0 by hand once; later updates arrive by themselves. How it works and how it is secured: [docs/UPDATER.md](docs/UPDATER.md).

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
| **Force** on the HQ card, or the same directive again within 30 s | Every front obeys at once; none may decline |
| <kbd>1</kbd>–<kbd>8</kbd> or click a front card | Open or close that front's dossier: its answer to the directive (or why it declined), tier, plan, position and units |
| Fortified zones list on the HQ card | Progress of each permanent zone; Cancel stops the work (standing works remain) |
| Click a town or city on the map | Town panel: supply stock, local production queue (queue a unit here), economic buildings (build or rebuild) |

Fronts are opened, merged and dissolved by the theatre itself; there is no key for it any more. There is no cap on fronts: the first eight have hotkeys and the card list scrolls.

**Engineering, economy and research**

| Input | Action |
|---|---|
| <kbd>I</kbd> or **Engineering** on the economy panel | Engineering popover: **Build road** (click two points, or drag), **Repair rail** (a cut line you hold at both ends), **Extend rail** (an own station, then an own town) |
| Economy panel (the *Auto* button in the top bar) → **Build economic zone**, then click the map | Site an economic zone on own or neutral ground, away from towns and near a road |
| Click an economic zone | Zone panel: level, output, road link, condition; raise it to the next level or rebuild the ruin |
| <kbd>Y</kbd> or **Upgrades** | Upgrade panel: research one item at a time at the capital, see the timer, cancel for a partial refund |
| **Auto-invest** / **Auto-research** (economy panel), **Auto-engineering** (Engineering), **Auto HQ** (HQ card) | On by default: the HQ staff invest, research, build roads / repair rail and pick the directive for you; switch one off to take it over (a directive you issue pauses Auto HQ until you issue Advance or 10 min pass) |

**Custom game:** next to your own doctrine (production mix) and *Your doctrine* (what Auto HQ and Auto-research follow), pick each AI side's doctrine (*Builder*, *Blitz*, *Attrition*, *Maneuver* or *Random*). Quick Battle and Spectate deal them at random, all different in a four-way war.

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
| <kbd>[</kbd> / <kbd>]</kbd>, <kbd>PgDn</kbd>/<kbd>PgUp</kbd> or <kbd>Ctrl</kbd>+wheel | Camera tilt |
| <kbd>O</kbd> · <kbd>K</kbd> | Orbit · battle cam (frames the hottest fight you can see, cuts every 12–20 s) |
| <kbd>F</kbd>, or double-click a front card | Follow the selected unit, else the open front |
| <kbd>Tab</kbd> | Overview; press again to fly back |
| Camera strip on the HUD | Free · Orbit · Follow · Battle · Overview |
| <kbd>Space</kbd> <kbd>U</kbd> <kbd>Esc</kbd> | Pause · hide HUD · back to the free camera / cancel / menu |
| <kbd>F11</kbd> · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> | Fullscreen · developer console (desktop app) |

Game speed: 1× / 2× / 4× / 8×. If the simulation can't keep up, the game slows down and shows a notice. It never skips ticks.

**Graphics quality** (Settings, on the title screen or in the Esc menu): *auto* (default), *high*, *medium* or *low*. Auto starts at a tier guessed from your graphics card, drops one tier after about 3 s of slow frames and tells you when it does.

**Quick Battle** is fought under fog of war; a Custom game has its own fog toggle, and Spectate shows everything. **Updates:** the title screen looks for a newer release on start (Settings → *Check for updates on start* turns it off). In the desktop app a newer release downloads and verifies itself in the background and the title screen offers **Restart now**; Settings → *Auto-download updates* turns that off and leaves only the notice with a link to the release page. The browser build always runs the latest version.

## Under the hood

```mermaid
flowchart LR
  subgraph Worker[Web Worker: deterministic simulation, 20 Hz]
    MG[Map generator] --> T[Terrain · buildings · navigation]
    T --> AI[Supreme HQ and its doctrine → fronts: tiers, compliance → units]
    AI --> CB[Combat · works and minefields · morale · supply · economy and zones · roads and rail · upgrades]
  end
  Worker -- packed snapshots --> Main
  subgraph Main[Main thread]
    R[Three.js diorama<br/>instancing · soldier motion · effects · order lines · camera modes · time of day] --- UI[War-room HUD · i18n]
    AU[Score composer · doctrine themes · mixer]
  end
  subgraph Orch[Web Worker: orchestra]
    OR[Synthesized instrument samples]
  end
  subgraph Shell[Electron shell]
    UP[Updater: signed bundles · fallback]
  end
  OR -- samples --> AU
  UI -- commands --> Worker
  UP -- app://game/ --> Main
```

- **Deterministic simulation.** Fixed 20 Hz ticks with seeded RNG, so the same seed and the same commands give the same war. A test checks this. The simulation runs in a Web Worker, and the main thread only draws.
- **One command hierarchy for everyone.** The supreme HQ (you, or the AI planner) decides the war effort and gives one directive with an optional axis or line. The theatre opens, merges and dissolves fronts and keeps the capital's garrison for every side. Each front commander turns the directive into its own response (main effort, support, pin, hold, counter-attack, fall back), then decides the objective, the posture, the battle plan, the slots on the line, crossings and spearheads. Units decide targets and cover. The AI supreme HQ thinks every 5 s and issues its directive through the same `setDirective` command the UI sends ([COMMAND_V2 §7](docs/COMMAND_V2.md), [STRATEGY_LAB Round 6](docs/STRATEGY_LAB.md)). Since 3.0 each front answers through a compliance score (proximity to the capital, local risk, temperament), and fronts are planned in staggered chunks of eight per tick, so their cost grows with the number of fronts per 5 s think rather than per tick ([COMMAND_V2 §8](docs/COMMAND_V2.md)).
- **Doctrines are levers, not a second AI.** A doctrine profile in `docs/data/rules.json` (`doctrines`) scales the dials the AI already reads: production mix and caps, investment, occupation, defend and attack thresholds, retreat HP, raid targets, front density, compliance temperament, main-effort share and upgrade priorities. The finisher that ends a war still comes first ([DOCTRINES](docs/DOCTRINES.md)).
- **Transport as a movement layer.** Speed and navigation cost depend on the move class (tracked, wheeled, foot, towed) and whether the cell is a road or a town street; trucks path on their own wheeled grid. Rail lines are generated from the map with no extra RNG draws, so old seeds keep their maps; ownership, cuts, trains and engineer jobs are plain data in the snapshot ([rules.json](docs/data/rules.json) `transport`).
- **Every 3.0 system has a switch and a lab.** Each one ships with a `rules.json` block, an `enabled` flag for A/B runs, unit tests and a lab suite in `scripts/lab30/`, and the deterministic-replay test still passes with all of them on.
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
  - The **anomaly lab** (`scripts/lab30/anomaly.ts`) runs four-way wars on medium and large maps with read-only probes and reports every ammo-starved cluster, dry supply chain, idle herd, stuck unit, convoy loop, phantom front and unreachable order with a root-cause guess and a timeline; `--src` points it at a frozen older tree for a before / after ([DEBUG_LAB](docs/DEBUG_LAB.md)).
  - The **3.0 suites** in `scripts/lab30/`: `doctrine.ts` (doctrine-vs-doctrine win matrix, curves, distinctiveness), `fronts.ts` and `directive.ts` (fronts per faction, front cost, order spam with compliance on and off, home-recall timing), `transport.ts` (crossing times by rail and road, road share, fights at junctions), `economy.ts` (zone income by doctrine), `defence.ts` (equal-cost assaults on tiered works, mines, cheap-win probes), `infiltration.ts` (detachments and motorized raids at the widest gap, open and `--fog`) and `upgrade.ts` (value per cost, rich vs poor, motorization).
  - The challenge lab's **experience metrics** (`--experience`) score every match for one-sidedness, cheap wins, warning time before a capital falls, pacing and engagement health; the 2.2.1 baseline is kept in `docs/lab/` ([CHALLENGE_LAB, 3.0](docs/CHALLENGE_LAB.md#30-diversity-suite-and-player-experience-metrics-wp-i)).

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
| `armour_raid` (3.0) | saves up 20 tanks and 10 motor rifles, then drives them at the nearest capital, direct or by a flank |
| `shadow_strike` (3.0) | from 10 min a small detachment takes a route outside every defender's sight to the capital (open and fog) |
| `backdoor` (3.0) | a loud offensive elsewhere while a capturing detachment slips to the capital by the shadow route |
| `feint` · `econ_war` · `siege` (3.0) | a loud offensive on one axis and the real one on another · raids on every economic site and convoy · an artillery line and works, then a storm |
| `doctrine_*` (3.0) | the challenger plays one of the four AI doctrines through the command API |

In the first baseline the AI survived every blunt strategy. The one loss led to the Round 7 defence fixes: holders on the HQ point, a forecast of the defenders that can actually block a capture, the nearest group's arrival time, and a counter-attack.

| strategy (3 seeds × 40 min) | AI keeps its capital | … when not outmatched (attacker < 2× the AI army) |
|---|---|---|
| rush at 3 / 5 / 10 min | 67 / 67 / 33 % | 100 / 100 / 100 % |
| turtle · two axes · late blitz · human-like | 100 % each | 100 % |
| raid | 67 % | 100 % |
| every unit on the capital (`rush_micro`) at 3 / 5 / 10 min | 67 / 100 / 100 % | 67 / 100 / 100 % |
| **all 33 matches** | 27 / 33 | **32 / 33** |

A capital taken by a challenger fielding at least twice the defender's army counts as a legitimate loss. The one remaining failure is a 3-minute direct rush on one seed at 1.2×, where the holders on the HQ point were suppressed. In 2.2 the strategies drive the universal directive instead of per-front orders, and the challenger gets the theatre's own front management, so it is a stronger opponent; in the 2.2 strategy round the AI kept its capital in all 21 matches (7 strategies × 3 seeds × 40 min). Full tables and the A/B switches: [docs/CHALLENGE_LAB.md](docs/CHALLENGE_LAB.md).

On 2.2.1 the 3.0 diversity suite found one exploit that still worked: a shadow strike with open information took the AI's capital in 2 of 3 seeds, after as little as 17 s of warning. With the 3.0 zone of control, rear reports and hunts, the AI kept its capital in all 42 matches of `--all` (14 strategies × 3 seeds × 40 min), the shadow strike's shortest warning rose from 216 to 408 s, and under fog it never reached the capital. Where a `doctrine_*` challenger took a capital, it came late and with the larger army, never as a cheap win.

```bash
npx tsx scripts/challenge.ts --all --rushAt 300,180,600 --seeds 7,11,13 --jobs 8   # the baseline
npx tsx scripts/challenge.ts --suite diversity --seeds 7,11,13 --minutes 40 --jobs 9 --experience   # 3.0 suite + experience metrics
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

<img src="docs/media/roadmap.svg" width="100%" alt="War-map roadmap: an inked road through shipped versions 0.4, 0.5, 1.0, 1.1, 2.0, 2.1 and 2.2 to 3.0 doctrine war, this release, starred, then a dashed road to the planned stop 3.x: war pace, river assaults, save and replay, linked maps and mods" />

> [!NOTE]
> Everything past 3.0 is a plan, not a promise. Stops may move, merge or drop out as playtesting shows what matters.

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
    <tr><td>2.2</td><td>Economic war: one supreme-HQ directive answered by every front, supply stocks in every town with gradual rearm, per-town production, factories, recruiting offices and depots with raids, roadside farms as cover, armour groups, a weaker AT gun, fog-of-war Quick Battle, update check, a smoother renderer</td><td><img src="https://img.shields.io/badge/shipped-3a3326?style=flat-square" alt="shipped" /></td></tr>
    <tr><td><b>3.0</b></td><td><b>Doctrine war: four clashing AI doctrines, unlimited fronts with Corps / Army / Army Group tiers, front commanders who may decline an order (and a Force switch), roads and railways, engineer-built economic zones, fortresses, AT emplacements, minefields and a capital defence perimeter, 13 unit upgrades, zone of control and infiltrator hunts, camera modes and time of day, signed automatic updates, a debug lab, doctrine themes in the score</b></td><td><img src="https://img.shields.io/badge/this_release-a63f36?style=flat-square" alt="this release" /></td></tr>
    <tr><td>3.0.x</td><td>War pace: with zones, works and the perimeter on, four-way AI wars end about half as often as in 2.2 (0.9 eliminations an hour against 1.3–1.8); a tuning pass on the perimeter, works tiers and zone output</td><td><img src="https://img.shields.io/badge/in_progress-8a6a2c?style=flat-square" alt="in progress" /></td></tr>
    <tr><td>3.0.x</td><td>Performance round on large maps with every 3.0 system on</td><td><img src="https://img.shields.io/badge/in_progress-8a6a2c?style=flat-square" alt="in progress" /></td></tr>
    <tr><td>3.x</td><td>Harder AI difficulties</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>3.x</td><td>Fortifications that block movement; AI garrisons in captured enemy works</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>3.x</td><td>River assaults under fire and naval crossings</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>3.x</td><td>Save and replay a war</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>3.x</td><td>A campaign of linked maps</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>3.x</td><td>Steam-style achievements</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>3.x</td><td>Localisation beyond Chinese and English</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
    <tr><td>3.x</td><td>Mod-friendly unit data</td><td><img src="https://img.shields.io/badge/planned-6b7a3a?style=flat-square" alt="planned" /></td></tr>
  </tbody>
</table>

## Build from source

Requires Node.js 18+.

```bash
npm install
npm run dev          # browser: http://localhost:5173
npm run app          # desktop window (Electron)
npm run dist:win     # Windows portable .exe + installer → release/
npm run pack:game    # signed game bundle for the updater: game-<ver>.zip + .json + .json.sig → release/
```

<details>
<summary><b>Releasing with the updater</b></summary>

```bash
npm run release:keygen   # once: Ed25519 key pair; the private key goes to %USERPROFILE%\.littlewar\ (never into the repo)
                         # paste the printed UPDATE_PUBLIC_KEY line into electron/updater.cjs and back the key up
npm run dist:win         # build dist/ and both installers
npm run pack:game        # zip dist/, write and sign the manifest (checks the key in updater.cjs matches)
npm run updater:e2e      # real Electron shell against a localhost feed: install, tamper, fallback, installer path
```

Upload `game-<ver>.zip`, `game-<ver>.json`, `game-<ver>.json.sig` and both installers to the GitHub release tagged `v<ver>`. Bump `scripts/release/release.config.json` → `minShell` when a change under `electron/` is one the game depends on; older shells then fetch the installer instead of the bundle. Until the public key is pasted in, the shell ships a placeholder key and never installs bundles ([docs/UPDATER.md](docs/UPDATER.md)).
</details>

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

# 3.0 labs (reports → media/stats/lab30/)
npx tsx scripts/lab30/anomaly.ts --seeds 7,11,13 --maps medium,large --minutes 45 --jobs 6   # debug lab
npx tsx scripts/lab30/doctrine.ts --seeds 7,11,13 --minutes 45 --jobs 8   # doctrine win matrix, curves, distinctiveness
npx tsx scripts/lab30/fronts.ts --seeds 7,11,13 --size large              # fronts per faction, front cost
npx tsx scripts/lab30/directive.ts --seeds 7,11,13 --minutes 40           # order spam with compliance on / off, home recall
npx tsx scripts/lab30/transport.ts --seeds 7,11 --minutes 30              # rail vs road crossing, road share, junction fights
npx tsx scripts/lab30/economy.ts --seeds 7,11,13 --minutes 45             # economic zones by doctrine
npx tsx scripts/lab30/defence.ts --suite assault                          # equal-cost assaults on tiered works, mines
npx tsx scripts/lab30/infiltration.ts --seeds 7,11,13 [--fog]             # raids at the widest gap
npx tsx scripts/lab30/upgrade.ts --parts value,rich,motor --seeds 7,11,13 # upgrade value, rich vs poor, motorization
npx tsx scripts/challenge.ts --suite diversity --seeds 7,11,13 --minutes 40 --jobs 9 --experience  # challenge + experience metrics

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
              AI (supreme HQ and doctrines / fronts, tiers and compliance / cities / units),
              roads and rail, economic zones, works tiers and minefields, capital perimeter,
              zone of control and infiltration, unit upgrades, stats ledger
src/render/   Three.js diorama: instanced units, soldier motion, terrain, water, settlements,
              structures, order lines, impact and artillery FX, rail and trains, upgrade models,
              camera modes, time of day, quality tiers
src/ui/       war-room HUD, title screen, supreme-HQ and front cards, engineering, zone and upgrade
              panels, camera strip, settings, i18n (zh / en)
src/update/   renderer side of the updater (status, notice states)
src/audio/    score composer and themes, synthesized orchestra (worker), sound effects (Web Audio)
scripts/      balance, strategy and challenge labs, 3.0 lab suites (lab30/), soak test, perf and
              profiling tools, capture scripts, release tools (release/: keygen, pack, updater e2e)
electron/     standalone desktop shell (serves the built game over app://) and the signed-bundle updater
docs/         design documents (mostly Chinese) and docs/data/*.csv|json: unit, weapon and rule data
tests/        rule, terrain, map-generation, determinism, structure and AI smoke tests
trailer/      Remotion project for the promo trailer
```

Design docs: [docs/README.md](docs/README.md). Implementation-time decisions are listed in `docs/GAME_DESIGN.md` §2.1.1.
</details>

## Status

**v3.0.** Balance and AI are tuned from headless AI-vs-AI wars, the 3.0 labs and the challenge lab, not yet from much human play. The 3.0 systems are new and each passed its own lab, but together they make wars slower to end: with economic zones, tiered works and the capital perimeter on, four AI sides eliminate about 0.9 factions an hour against 1.3–1.8 in 2.2, and 1v1 duels rarely end inside an hour. A tuning pass on the perimeter, works tiers and zone output comes next ([roadmap](#roadmap)).

**Known limitations:** the orchestra is synthesized, not recorded, and sounds like it. Single player only: there is no multiplayer. The Windows build is not code-signed.

## License

MIT. See [LICENSE](LICENSE). The trailer is built with [Remotion](https://www.remotion.dev/), which is free for individuals and teams of up to 3.
