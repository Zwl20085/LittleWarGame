# 3.0 code map (generated 2026-10-16 at a8b8f38; line numbers drift as 3.0 lands)

Conventions: paths are relative to C:\Users\ZhangWentao\Documents\GitHub\LittleWarGame. Line numbers are from the current working tree, which is HEAD a8b8f38 (3.0 spec commit) and clean. "(rules)" means docs/data/rules.json. docs/V30_SPEC.md (245 lines) already exists and targets most of this release: §5 fronts unlimited, §6 directive priority, §7 economic zones, §10 roads and rail, §2 debug labs, §3 updater, §4 camera, §13 music, §14 perf.

## 1. Fronts / theatre
**Where the cap of 8 is enforced**
- (rules):241 `command.fronts_max: 8`, :240 `fronts_initial: 3`. Typed at src/data/types.ts:283-284.
- src/sim/frontops.ts:35 `createFront` returns null at the cap.
- src/sim/frontops.ts:150 `frontForOrder` returns the nearest front instead of opening one at the cap.
- src/sim/theatre.ts:263 `desiredFronts` clamps with `Math.min(fronts_max, ...)`.
- src/sim/theatre.ts:369 `garrisonZone` stops opening garrison fronts at the cap.
- src/sim/theatre.ts:283 uses `fronts_initial` as the merge floor.
- src/sim/fronts.ts:51 `initFronts` opens `fronts_initial` fronts at match start.
- tests/fronts.test.ts:360 asserts the cap.
- Separate "8" constants:
  - src/sim/frontresponse.ts `RESPONSE.zonesMax: 8`, a cap on live zones.
  - src/ui/input.ts ~305 hotkeys `'1'..'8'` call `fronts.toggle(factions[pid].fronts[n-1].id)`. The key is an array index, not a front id.
  - src/ui/input.ts:12 comment: "1-8 are taken". Directive keys are Z X C V B (input.ts:13), so any hotkey above 8 needs a new scheme.
  - src/ui/fronts.ts:25 `COMPACT_OVER = 3` (card list goes compact above 3 fronts). :292 comment about scroll with 8 fronts.

**How the AI opens, merges and dissolves** (all in src/sim/theatre.ts)
- `THEATRE` constants :30-130: `changeEveryS 30`, `minAgeS 120`, `newFrontFree 14`, `unitsPerFront 20`, `troopsPerFront 28`, keep-hysteresis variants, `zoneFrontsMax 2`, `zoneTroops 8`.
- `thinkTheatre` :153. Order: `assignWings`, `upkeepZoneGarrisons`, `restructure` (one change per 30 s), `counterStrike`, `respondAll`.
- `theatreAxes` :218 builds the axes. `desiredFronts` :257 is the count rule: the max of neighbour capitals, strong axes and troops/28.
- `restructure` :277 runs in priority order:
  1. empty fronts dissolve;
  2. converged fronts merge (smaller into larger; `mergeable` :271);
  3. surplus over `keep` merges the weakest into its nearest neighbour;
  4. an uncovered axis opens a front via `createFront`, or `extraObjective` :340;
  5. `garrisonZone` :367.
- Structure ops are in src/sim/frontops.ts:
  - `createFront` :33 (pays `commander_unit` P, takes `donorKeep` 0.5 of each donor's free troops).
  - `transferUnits` :55.
  - `dissolveFront` :84.
  - `assignWings` :121 (wing -1/0/+1 by bearing from the capital).
  - `createFrontAt` :186 (player).
  - `disbandFront` :206 (player).
  - `FRONT_OPS` :14, `newFrontM 900`.
- A new front's `share` is split as 1/n and the others are scaled (frontops.ts:41-43).

**How a unit gets its front**
- `Unit.frontId` (types.ts). It is set at spawn via `world.spawnUnit(owner, id, pos, frontId)` (world.ts:204).
- Production chooses the front with `pickFront` (production.ts, ~line 175) by reinforcement-share deficit.
- `transferUnits` (frontops.ts:55) reassigns `transferable(u)` units (:22: line role, not on a task).
- `reassignStale` (frontops.ts:164) moves units of a dissolved front to the nearest front.
- Lookup: src/sim/frontref.ts `frontById` :8 (index fast path), `frontOf` :12 (falls back to fronts[0]).
- The commander is a unit: `appointCommander` fronts.ts:317, `upkeepCommander` :335, `COMMANDER` :286.

**Per-front, per-think cost that scales badly**
- Cadence: `thinkFronts` runs per faction every 2 s, staggered by faction id (sim.ts:340, `AI.frontThinkSeconds` config.ts:90). `thinkTheatre` and `thinkHighCommand` run from the high-command path.
- `frontUnits(world, f, frontId)` (fronts.ts:392) scans ALL `world.units` for each call, so cost is O(U) per front. Callers:
  - fronts.ts:145, 153, 162, 169;
  - fronts.ts:412 in `nextTarget`, per front retarget;
  - frontops.ts:86;
  - src/ui/fronts.ts:151, called per front at about 5 Hz;
  - src/ui/zones.ts:69.
- `frontGroups` (fronts.ts:458) is the correct single-pass O(U) version. It is used by `thinkFronts` :477 and theatre.ts:172.
- Other full `world.units` scans per HQ think:
  - theatre.ts:330, 374, 518, 641;
  - operations.ts:94, 139;
  - command.ts:103, 283, 303, 367, 380;
  - homeguard.ts:237, 424, 443, 474, 497.
- `restructure` merge loop is O(F²) pairs, and `nearestOther` re-sorts per front (theatre.ts:~286).
- `frontSegments` (operations.ts:40) sorts all frontline cells by angle and splits them across fronts. The per-front `segment` is rebuilt every think.
- `Front.slots: Record<number,V2>` is rebuilt per front per think (`planFront` fronts.ts:575).
- `eager` WeakMap state is per front (fronts.ts:803).
- `buildFrontInfoFor` (frontai.ts:32) is per faction, not per front. sim.ts:386-392 spreads it across ticks.
- Per unit tick: `thinkUnit` (behavior.ts:82) calls `frontOf` (:85).
- V30 §0 forbids new per-tick O(units × fronts) loops.

## 2. Supreme HQ directive flow
**Directive creation and delivery**
- Player path: UI `FrontsPanel.pickDirective` (ui/fronts.ts) → `ctx.issue({type:'setDirective', kind, axis?, line?})` → src/sim/commands.ts:38 type, :159 handler.
  - The handler validates: kind, `LINE_ONLY_FORTIFY`, bounds, `UNREACHABLE` via `nav.nearestPassable`, `LINE_SHORT`.
  - It then calls `setDirective(...manual=true)` (:172) and `applyDirectiveNow` (:173), which calls `respondAll` at once (theatre.ts:166).
- `setDirective` is at src/sim/directive.ts:~25. It writes `f.directive` (types.ts:172 `Directive`) and calls `addZoneLine` for a drawn fortify line. `DIRECTIVE_KINDS` :13. `DirectiveKind` = offensive | advance | defend | fortify | contract (types.ts:170).
- AI path: `thinkHighCommand` (command.ts:214) calls `chooseDirective` (command.ts:273; directive.ts ~55). It picks:
  - finisher offensive when `command.finishTarget >= 0`;
  - `defend` when `armyRatio < AI_DIRECTIVE.defendBelow 0.35`, back to advance above `defendExit 0.55`;
  - otherwise `advance`.
  - It also keeps a directive for `keepS 60` and uses the same `setDirective` with `manual=false`.
- Note: there are two things called Directive. command.ts:47-58 has a legacy `DirectiveKind`/`Directive` = defend | occupy | attack (HQ garrison and occupy tasks). The 2.2 universal directive is the one in types.ts and directive.ts.
- The per-tick answer is `respondAll` (theatre.ts:189), reached from `thinkTheatre`.
  - It builds `directiveContext` (frontresponse.ts:116) once: `{dir, bind, main, axisTarget}`.
  - `bind = dir.manual && kind !== 'advance'`.
  - Per front, in order:
    1. zone garrison (`resp.zone`);
    2. recalled or defending home (`resp.home`);
    3. counter-strike;
    4. else `respondToDirective` (frontresponse.ts:160).
  - If it returns false (advance, or the AI finisher), `orderFront` (theatre.ts:436) gives the 2.1 order.
- `respondToDirective` dispatches: `offensive` :174, `contract` :279, `hold` :218 (defend and fortify).
- `give` (frontresponse.ts:144) stores the order with `manual: bind`, dedupes it, and calls `issueFrontOrder` (fronts.ts:103). It also records the order in the `given` WeakSet (`givenByDirective` :141).
- `RESPONSE` constants: frontresponse.ts:21-57.

**Binding orders (2.1 rule: "最高统帅部的指挥命令为强约束")**
- Definition: src/sim/frontref.ts
  - `boundOrder` :20 = `order.manual && kind !== 'auto'`.
  - `boundLine` :23 = bound and not attack.
  - `lendsGarrisons` :29.
  - `onBoundFront` :32.
- Enforcement sites:
  - behavior.ts:155, 195, 354.
  - fronts.ts:169 (`recallDetachments` :191), :517-522 (`holdOperation` :553 instead of `runOperation`), :537 (release gate skipped), :601, :635, :828.
  - command.ts:341 (garrisons not drawn from bound fronts), :379 (occupations).
  - operations.ts:146 (rear guards).
  - econwar.ts:174 (raiders).
  - cityai.ts:82, 153.
  - frontops.ts:69.
  - shelter.ts:239.
- Exempt: the capital's standing garrison and HQ-point squads (`capitalGuard` fronts.ts:173, `HOME`/`STANDING` homeguard.ts:25, 130).
- `issueFrontOrder` (fronts.ts:103-110) releases a recall when the order is manual.
- V30 §6 plans "softer directive priority".

**Main effort, supporting and pinning**
- `directiveContext` frontresponse.ts:116-135:
  - offensive with an axis: `main = nearestOf(field, axisTarget.pos)`;
  - offensive without an axis: highest `sumValue` front;
  - defend or fortify with an axis or line: front nearest that point.
  - The result is stored in the `mains` WeakMap (`directiveMain` :71).
- `offensive()` frontresponse.ts:174:
  - main, or any front whose troops are within `supportM 1400` of the axis target, gets `give(attack)`, with response `resp.main` or `resp.support`.
  - Otherwise it picks its own objective via `nextTarget` (kept at least `retargetS 60`).
  - If `threat > mine × pinRatio 1.8` and it is not main, it pins on `pinTarget` :203 (`pinSearchM 1200`, `pinPickRatio 0.8`, response `resp.pin`).
  - If there is no pin target it holds (`resp.holdOutmatched`).
- `shareMainAxis: 2` weights reinforcement toward the main effort (read in cityai.balanceReserves; armour.armourFront also uses `directiveMain`).
- AI 2.1 stances come from theatre.ts: `orderFront` :436, `holdStance` :487, `wantsFallBack` :543, `defendPoint` :569, `counterStrike` :595. Shares: `THEATRE.shareMain` etc. at theatre.ts:~98-110.

**Distance of a front to the capital**
- There is no stored per-front field.
- Computed ad hoc:
  - `assignWings` frontops.ts:121 uses `headingTo(city.hq, a.targetPos)`.
  - `contractPoint` frontresponse.ts:330 and `holdPoint` :315 use `world.hqPos(f.id)`; `RESPONSE.contractHomeM 900` and `holdBackSlackM 150`.
  - `frontDistance(s,p)` frontops.ts:132 is distance to a front's line, not to the capital.
  - `distanceToHq(world,u)` capture.ts:111 is per unit.
  - command.ts:114-120 neighbour capital by distance; :154-169 `chooseFinishTarget`.
  - `capitalDistM` exists only in scripts/challenge/metrics.ts.

## 3. Movement
**Speed**
- `speedOf(world,u,heading)` src/sim/movement.ts:164.
  - Mounted: `MOTOR.speed` (:135) × `groundSpeedMul(g,true)` × tempo.
  - Otherwise: `def.speed × u.terrainMul × tempo_move_multiplier`.
  - `terrainMul` = `groundSpeedMul(ground, vehicle) × (grade>0 ? clamp(1-0.02·grade, .45, 1) : 1)`. It is sampled every `TERRAIN_SAMPLE_TICKS=5` (:420).
  - Morale status: pinned 0.25, suppressed 0.7, routing ≥ 0.9.
  - Vehicles below 25% hp × `COMBAT.lowHpVehicleSpeedMul`.
  - Vehicles with `ammo<=0` × `supply.empty_vehicle_speed_multiplier` 0.7 (:185).
  - (rules):21 `tempo_move_multiplier: 1.8`.
- `updateMovement` movement.ts:190. Helpers: `separate` :445, `unstick` :400, `escapeStep` :384. Stuck constants :413-443 (`STUCK_REPLAN_S 20`, `STUCK_DROP_S 45`, `STUCK_MOVE_M 4`).

**Terrain modifiers**
- src/sim/config.ts:63 `TERRAIN_MOVE` as `[foot, vehicle]`: open 1/1, road 1.05/1.35, forest 0.85/0.55, town 0.8/0.55, mud 0.65/0.4. Ford maps to the mud entry.
- Mapping from ground enum: nav.ts:18 `groundKey`, :22 `groundSpeedMul`.
- `Ground` enum: terrain.ts:8 (Open 0, Road 1, Forest 2, Town 3, Mud 4, Water 5, Ford 6).
- `terrain.groundAt`, `slopeAt`, `gradeAlong`.
- Road bonus for combat or cover: terrainrules.ts:59 (non-road returns 1, so road matters there too).

**Roads**
- A road network exists but is purely geometric.
- Data: `MapDef.roads: V2[][]` (mapdef.ts).
- Generation: src/sim/mapgen.ts:430-465.
  - Prim MST over capitals and towns, plus the 2 nearest links when d<900.
  - Each edge is routed by `gridPath` (:18) on a 16 m grid with a slope and river cost.
  - Then `simplify(path,10)`.
  - Result pushed to `roads` (:463), returned at :534.
  - `roadMask` (:466) keeps forests and the like off roads.
- Painted into the terrain: terrain.ts:`paintGround` :407-422 stamps `Ground.Road` with radius 8 m every 2 m (`forCells`).
  - Also grading: terrain.ts:356-359 `smoothSegment`, slope cap ~:379.
  - River crossings: `carveRivers` ~:444-536; road cells are kept as causeways and recorded as `Bridge` (terrain.ts:33).
  - Runtime pontoon: terrain.ts:~656 turns water cells into Road; engineering.ts `completeBridge` :99; `refreshArea` nav.ts:177.
- Road-adjacent features: roadside.ts (`placeRoadside` called at terrain.ts:558); econLots.ts:30 `roadDistance` (lots sit near roads).
- Render: render/roadField.ts.
- There is no road graph, no rail, and no per-road speed object. The speed bonus is only the ground-type multiplier. V30 §10 wants off-road slowdown.

**Nav grid** (src/sim/nav.ts, `NavGrid` :82; `world.nav(vehicle,maxSlope)` world.ts:137; `world.navFor(u)` :148)
- Constants: `GOAL_LATTICE_M 128`, `FIELD_CACHE 128`.
- `cellCost` :150:
  - Water is impassable.
  - Roads and fords ignore the slope limit (slope capped at 10).
  - A slope above the class `maxSlopeDeg` is impassable.
  - Cost = `(1 + built·(vehicle?4:2)) / (groundSpeedMul × slopeMul)`.
  - Cells where `built>0.55` or with building height are walls.
- Other methods: `refreshArea` :177, `buildRegions` :198, `regionAt` :239, `nearestPassable` :350, `lineClear` :377 (:380 comment: "do not shortcut through slower ground than segment start (keeps road following)"), `flowField` :457, `pathByField` :497, `findPath` :560 (A*), `connected` :635.
- Flow fields: src/sim/flowfield.ts (`EdgeTable` :23, `FlowField` :63).

**Pathfinding entry points**
- `moveTo(world,u,dest,force)` movement.ts:12 is the single entry for units.
  - Dest over 120 m uses `longNav.pathByField(.., PATH_HORIZON_CELLS=40)`. Vehicles share `world.nav(true,15)`.
  - Short dest uses `nav.findPath(...,4000)`.
  - Fallbacks: own-class `pathByField`, `findPath(..., DETOUR_SEARCH_CELLS=150000)`, relaxCorners, then `terrain.detour`.
  - Rate limit: `repathAt = time+2+rand`, `FAR_ROUTE_HOLD_S 6`.
- `reachableDest` movement.ts:86; `commands.ts` `setDirective` validates with `nav.nearestPassable`.
- Only other direct caller: terrainai.ts:149 `pathByField`.

## 4. Supply and ammo
**Ammo storage**
- `Unit.ammo` (types.ts:46) is a 0..1 fraction of a load. `u.supplyRatio`, `u.supplied`, `u.rearming`, `u.rearmAt`, `u.cargo`, `u.truckState` and `u.truckDest` also exist.
- `UnitDef.supplyDemand` (units.csv `supply_demand`) is cargo units per full load.
- Spawn: `ammo: 1` (world.ts:229). Produced units start at 0 when logistics exist (production.ts:331).
- Snapshot field: snapshot.ts:119, 193.
- Weapon cost: `WeaponDef.ammoCost` (weapons.csv `ammo_cost`), multiplied by (rules) `logistics.ammo_cost_multiplier 2.5` in loader/scale.

**Where "out of ammo" bites**
- combat.ts:48 `canEngage` returns 'NO_AMMO' if `u.ammo + 1e-9 < w.ammoCost`.
- combat.ts:197-198 slows fire interval: `critical_ammo_threshold 0.1` ×1.6, `low_ammo_threshold 0.3` ×1.25 (rules :124 `supply`).
- combat.ts:124 artillery `ARTY.lowAmmo` worth penalty.
- combat.ts:274 consumption `u.ammo = max(0, u.ammo - w.ammoCost)`.
- movement.ts:185 empty vehicle speed ×0.7.
- behavior.ts:78 return-to-fight needs `ammo ≥ return_ammo_ratio 0.5`.
- econwar.ts:132 raiders need ammo > 0.25.

**Resupply, convoys, town stock** (2.2 logistics, (rules):146-177)
- src/sim/settlements.ts:
  - `Place` stock: `initPlaces` :43, `seedStocks` :77, `stockCap` :106 (cap_k capital 40, city 20, town 10).
  - `stockSecond` :140 fills stocks from logistics L with distance falloff `depot_efficiency_falloff_m 2600`.
  - `drawSecond` :212 lets units near a place draw ammo (needs `rearm_per_second`).
  - `inContact` :244 means a unit that fired in the last `draw_contact_seconds 8` draws only inside the town.
  - `nearestStock` :257.
  - `rearmDuty` :292: a unit walks to rearm below `rearm_below`, back at `rearm_until`.
  - `stockSummary` :326.
  - `logisticsDemand` :185.
- src/sim/convoy.ts: `CONVOY` :15, `ammoNeed` :32, `thinkConvoyTruck` :101, `convoySecond` :192 (truck hands over within 80 m, carries 25, 4/s), `bestStock` :38, `pickDestination` :53, `frontNeeds` :76.
- src/sim/supply.ts: legacy supply network. `rebuildSupply` :63, `supplyTick` :115 (`ammo_regeneration_per_second` 0.012), `allocateSupply` :15. `inSupply` in sim.ts:277.
- Economy feed: sim.ts:`economySecond` :189 sets `f.logistics` L, and calls `stockSecond`, `drawSecond`, `convoySecond`.

**Existing anomaly / stuck detection**
- scripts/stuck.ts (23 lines): hardcoded seed 7, 4 factions. It runs 480 s, snapshots, runs 60 s, then prints up to 14 non-moving units with path and ground diagnostics. No CLI args.
- scripts/soak.ts: `npx tsx scripts/soak.ts [minutes=60] [seeds=7,11,13]`. Env A/B: `HOME_DEFENCE=0`, `STORM=0`, `SIEGE=0`, `THEATRE=0`, `THEATRE_OFF=stances,structure,counter`.
  - `note()` :60 caps at 60 anomalies.
  - Invariants: negative or non-finite stock, NaN position, out of bounds, hp range, dead fort occupant (:91-110).
  - Behaviour: stuck over 90 s (:100, tracked per unit via `Track`), unreachable over 60 s, batteries that never fired (>30%), log spam over 30/min.
  - Perf: per-5-min tick mean and p99 in `report()`; the health line prints average ammo per faction.
  - It reports rearming% and stockpile in `soakExtra`.
  - There is no detector for "ammo-starved but still advancing" or "tank herd with ammo 0". V30 §2 (:60) specs that.

## 5. Structures
**Kinds**
- `FortKind` (types.ts:439): field_cover, mg_bunker, trench, sandbag, pontoon, pillbox, bunker. `Fort` types.ts:441 (`owner, kind, pos, facing, hp, progress, occupant, occupants`).
- `StructureKind` = pillbox | bunker (structures.ts:61; `isStructure` :63).
- Stats in (rules) `construction.defensive.structures` (:224-225):
  - pillbox: cost 6P/50M, 60 s, hp 2750, capacity 1, weapon `pillbox_mg`, blind_rear 90°.
  - bunker: 12P/100M, 100 s, hp 5625, capacity 2, accepts at_gun, weapon null, fire_mul 1.2/1.15.
  - Also `mg_bunker` (:218).
  - `capital_line_works` (:246) `{trench:2, pillbox:2}`.
  - Types in data/types.ts:53 `DefensiveStructureDef`, :82 `DefensiveRules`. Validation loader.ts:133.
- Trench and sandbag lines: works.ts (`WORKS` :13, `startLine` :59, `dig` :88, `updateWorksCover` :114, `worksProtect` :128).
- Economic buildings are `EconKind` factory | recruit | depot (data/types.ts:100). "Recruiting office" = `recruit`.
  - Stats (rules):179-190: factory 60P/160M 90 s makes M; recruit 40P/120M 75 s makes P; depot 40P/100M 60 s has a stock cap.
  - Slots: village 0, town 2, city 3.
  - Logic: src/sim/econ.ts (`canBuild` :44, `startBuilding` :59, `buildingOutput` :82, `econIncome` :95, `damageEcon` :117, `econSecond` :153, `econCounts` :190).
  - AI: econai.ts (`ECON_AI` :17, `thinkInvestment` :124, `investKind` :98).
  - `EconBuilding` types.ts:306.
- NB: `BuildingKind` terrain.ts:20 includes 'factory' as a decorative house model, unrelated.

**Lots**
- src/sim/econLots.ts `econLots(t,c,townR,n,angle0,passable,fallback)` :67 and `LOTS` :11.
  - Search band is the town edge, `roadMinM 18`, `roadNearM 32`, `gapM 30`.
  - Pure geometry; `roadDistance` :30 scans `t.def.roads`.
- Called from settlements.ts:71 in `initPlaces`. Slots come from `Place.slots`.
- Tests: tests/econLots.test.ts.

**Engineer build jobs**
- Planner side, fortplans.ts:
  - `PLANS` :24.
  - `planStructures` :116.
  - `planCapitalLine` :168 and `layoutCapital` :184.
  - `planZones` :224 and `layoutZone` :245.
  - `planPlaceStructure` :292.
  - `advancePlan` :347 and `startItem` :379.
  - `assignBuilders` :419 and `requestEngineers` :142.
  - `canDig` :441.
- Worker side, structures.ts:
  - `startStructure` :342 and `placeStructure` :360.
  - `buildStep` :384 and `completeStructure` :403.
  - `assignJob` :414, `jobOf` :419 and `dropJob` :425 (`jobSeconds 30`).
  - `structureDuty` :553 (engineers build, troops seek garrison).
  - `STRUCT` constants :25-59.
  - `structureSiteOk` :304 and `canAfford` :333.
- Engineers' pontoon bridges: engineering.ts (`PONTOON` :15, `thinkBridgeBuilder` :63).

**How defensive works fire and are manned**
- Occupancy:
  - `seekGarrison` :488 (troops look every 4 s, claim 60 s).
  - `mayHold` :465, `holdGarrison` :479, `pickBuilding` :513.
  - `enter` :170 and `leaveStructure` :181.
  - `updateStructureGarrison` :223 (cadence `STRUCT.garrisonCheckTicks 10`) and `rebind` :247.
- The occupant fires the structure's weapon:
  - `weaponOf(u)` :99 returns `garrisonWeapon` (:157). It uses a `slitWeapons` cache of the weapon with `fire_mul` damage and range applied.
  - `combat.ts:96` and :225 use `weaponOf(u)` instead of `u.primary`.
  - `garrisonRaise` :105 (muzzle height), `garrisonBlind` :120 (rear arc), `garrisonCover` :108, `garrisonBlastMul` :114.
  - `combat.ts:11` imports these.
- Damage: `absorbHit` :266, `damageStructure` :274, `collapseStructure` :282.
- Manning slots:
  - `structureSlots` :592, `zoneSlots` :621, `capitalBuildingSlots` :626, `mannedShare` :636 (soak uses it).
  - Garrisons are not counted against population (see (rules):222 comment).
- Shelter in houses is a separate system: shelter.ts.

**homeguard.ts (capital line)**
- Capital line planning is in fortplans.ts (`planCapitalLine` :168).
- homeguard.ts:
  - `HOME` :25, `ROUND7_AB` :110, `HQ_POINT` :112, `STANDING` :130, `homeOn` :123.
  - `HomeThreat` :145.
  - `thinkHomeDefence` :342 (forecast, alarm, `recall` :524, `releaseGuards` :606).
  - `keepStanding` :628, `ensureDiggers` :641, `fortifyHome` :670, `fortifyPlace` :718.
  - `thinkHomeGuard(u)` :754, `hqDuty` :799, `guardPost` :834, `fallBackHome` :879.
  - `saveOrders`/`restoreOrders` :896/:902, `isRecalled` :914, `releaseRecall` :931.
- Tests: tests/homeguard.test.ts. Visuals: render/fieldWorks.ts, structures.ts.

## 6. Unit roster and data
**Unit ids** (units.csv rows; 13)
- infantry, recon, mg, engineer, motor_inf, at_gun, mortar, light_tank, medium_tank, heavy_tank, howitzer, supply_truck, commander.

**units.csv columns** (24)
- id, label_zh, kind (infantry|crew|vehicle), facility (barracks|vehicle|support), cost_p, cost_m, population, supply_demand, build_seconds, unlock_seconds, max_hp, member_count, speed_mps, vision_m, primary_weapon, secondary_weapon, armor_front, armor_side, armor_rear, max_slope_deg, hull_turn_degps, turret_turn_degps, setup_seconds, pack_seconds.

**weapons.csv columns** (16)
- id, label_zh, fire_mode (hitscan|direct_projectile|ballistic), range_m, min_range_m, interval_seconds, damage, penetration, accuracy, blast_radius_m, suppression, can_fire_moving, ammo_cost, muzzle_speed_mps, min_elevation_deg, max_elevation_deg.
- Weapon ids: rifle, recon_rifle, engineer_rifle, mg, pillbox_mg, coax_mg, at_cannon, light_cannon, medium_cannon, heavy_cannon, mortar_shell, howitzer_shell, commander_pistols.

**Where stats are read at runtime**
- Loading: src/data/loader.ts
  - `buildGameData(unitsCsv, weaponsCsv, rulesJson)` :86.
  - `parseUnit` :43, `parseWeapon` :16.
  - Validators `validateLogistics` :111 and `validateDefensive` :133.
- Test and app entry: `loadGameData()` src/data/index.ts:8, which uses the files bundled by Vite `?raw`.
- Types: src/data/types.ts `UnitDef` :5, `WeaponDef` :32, `Rules` :159 (loosely typed), `GameData` :309.
- Rules scaling by army scale: src/sim/scale.ts `scaledData` :52. It is applied in `createMatch` (sim.ts:61).
  - It scales rules only (caps, income, population, logistics, resolve), never `UnitDef`.
- Runtime reads: `u.def.*` directly (movement.ts:179 `def.speed`; combat/damage `def.maxHp`, armor; `u.primary`/`u.secondary` WeaponDef cached at spawn world.ts:204-215).
- `UnitDef` is shared and readonly across all factions.
- Combat tuning constants live in src/sim/config.ts (`COMBAT`, `TERRAIN_MOVE`, `FRONTLINE`, `AI`, `ARTY`). Formulas are in formulas.ts.

**Per-faction modifier hook today**
- None. There is no veterancy, XP, tech or upgrade code (grep found nothing).
- The closest hooks:
  - `Faction.personality` (balanced|armor|infantry|mechanized|artillery) affects only production weights via `personalityWeights` (cityai.ts) and the AI doctrine mix.
  - `Faction.difficulty` affects only the city think interval (sim.ts:334).
  - `Faction.weights` and `caps`.
  - rules block `proposed_defaults.production_unit_weights/caps`.
- Any per-faction stat change would need a new indirection on `u.def`. Candidate seams are `spawnUnit` (world.ts:204) and the `def.speed`/`def.maxHp` read sites listed above.
- V30 §9 specs unit upgrades.

## 7. Labs
**scripts/lab.ts** (balance lab, docs/BALANCE_LAB.md)
- `npx tsx scripts/lab.ts --seeds 7,11,13 --minutes 20 [--warmup W] [--set path=value]... [--vs "label:set1;set2"] [--ab] [--label n] [--map generated|four_cities] [--factions 4] [--difficulty normal] [--src dir] [--data dir] [--jobs N]`.
- Forks child processes. Run: scripts/lab/run.ts `runOne(RunSpec)`:
  - dynamic import of `<srcRoot>/sim/sim.ts`;
  - `createMatch` with spectate=true, 4 factions, open info;
  - loop `step(match); w.fx.length=0`;
  - `probeSecond` every second, `probeSample` every 30 s.
- Other files: overrides.ts (`--set` path syntax `a.b=value`, `*=` multiply), probe.ts, summary.ts, report.ts (Markdown + JSON). Output goes to media/stats/lab-*.md and .json.
- Metrics (probe + `w.stats`): economy, production, combat, territory and slot occupancy; the per-type combat ledger is in sim/stats.ts (`TypeStats` :9: built, lost, spent, shots, dmgDealt, dmgTaken, kills, killValue, aliveSeconds).
- Other lab modules in scripts/lab/: war22.ts, war22probe.ts, zones.ts, at-assault.ts, `*-diag.ts` (fronts, directive, raid, rush).
- Related: scripts/balance.ts `npx tsx scripts/balance.ts [minutes=20] [seeds=7,11] [mapId]` prints the per-type ledger, attacker×victim matrix and economy timeline, and writes media/stats/<seed>.json.

**scripts/challenge.ts** (docs/CHALLENGE_LAB.md)
- `npx tsx scripts/challenge.ts --strategy rush[,turtle..] | --all --seeds 7,11,13 --minutes 40 --jobs 6 [--challenger 0] [--rushAt 300|180,300,600] [--fog]`. Env `R7_OFF=hqPoint,eta,assault,counter|all`, `R7_ON=alarm`.
- Spawns one child per task. Output goes to media/stats/challenge-<ts>.md, with per-match JSON in media/stats/challenge-runs/.
- Runner: scripts/challenge/match.ts `runChallengeMatch`:
  - creates a match with `spectate:false` and `playerSlot=challenger`;
  - builds a `CommandBus` and a `StrategyCtx` with `issue(cmd)` and `markAttack`;
  - once per game second calls `strategy.tick(ctx)` and `sampler.second`;
  - every tick calls `bus.flush(match); step(match)`.
- A strategy is `Strategy {id, summary, setup(ctx), tick(ctx)}` (scripts/challenge/types.ts:21-27).
  - It plays only through `ctx.issue(Command)`, the same API as the UI.
  - Register it by adding a module to scripts/challenge/strategies/index.ts `STRATEGIES`.
  - Existing: rush, rushMicro, turtle, twoAxis, raid, lateBlitz, humanLike.
  - Helpers: strategies/common.ts `allOnCapital`; worldq.ts `enemiesByDistance`, `setMix`, `armyValue`, `valueNear`.
  - Smallest example: strategies/rush.ts (26 lines).
- Metrics (metrics.ts + types.ts): per-AI `AiDefence` (alarm timing, recalled groups, works peak within 300 m, counter-attack time, arrival defence, holders, capital lost time and by whom, trace every 30 s or 5 s near the gates). The report also has captures, `held` per 5 min, `commandsIssued` and `commandsFailed` (the latter via `bus.onResult`). Report assembly: report.ts.

**scripts/strategy.ts** (docs/STRATEGY_LAB.md, 1008 lines)
- `npx tsx scripts/strategy.ts --seeds 7,11,13 --minutes 20 [--map generated] [--jobs 3] [--baseline] [--compare] [--ab home|storm] [--no-rotate]`.
- It rotates doctrines (balanced, armor, infantry, mechanized) over slots by seed index. It uses `STRATEGY_AI` toggles (strategyai.ts) for A/B.
- It runs matches, then `finalizeBattleLog` and `battleRecords` from events.ts. analyze.ts builds the report (ops by kind×doctrine, success by force ratio and terrain, capture efficiency, directive follow-through, wasted ops, stuck and idle time). Output goes to media/stats/strategy-<ts>.md and strategy-runs/*.json.

**Other**: scripts/soak.ts (section 4); scripts/perf.ts, profile.mjs, perf-browser.mjs, perf-probe.mjs; scripts/capture*.mjs, shot.mjs and review-shots.mjs (Playwright shots); scripts/music-preview.ts (`npx vite-node scripts/music-preview.ts [seconds=80] [seed=7]` renders WAVs to media/stats/music/); scripts/roadside*.ts. V30 §0 expects a new `scripts/lab30/`.

**Headless entry point**
- `createMatch(data, MatchConfig)` sim.ts:60, then `step(match)` sim.ts:325 (one 20 Hz tick). Clear `w.fx.length = 0` after each step, as all labs do.
- `MatchConfig` types.ts:481: mapId ('generated'|'greystone_pinecreek'|'four_cities'), mapSize?, armyScale?, factions, infoMode ('open'|'fog'), seed, difficulty, personalities?, playerSlot, spectate?.
- `Match` {world, front, frontView, supplyNodes} sim.ts:~21.
- Load data with `buildGameData(readFile(...))` or `loadGameData()`.
- Order within a tick: sim.ts:325-412. City AI, high command, front think; unit think (staggered, 0.4 s or 1 s for guns); morale, movement, height; visibility at 2 Hz; weapons; deferred queue; projectiles; `removeDead`; each second `economySecond` and `battleSecond`; frontline updates; stats every 30 s; fort cleanup every 10 s; `checkElimination`; `tick++`.
- Browser path: src/game.ts → SimHost (src/simhost.ts) → sim.worker.ts.

**Log and event hooks** (src/sim/events.ts)
- `world.note(faction, key, params, severity)` world.ts:156 writes to `world.log` (capped at 400, deduped).
- `world.fx: FxEvent[]` (world.ts:61, type :466) is the render and audio event queue.
- `world.battle: BattleLog` (world.ts:91, `createBattleLog` events.ts:144). Records: `OpRecord` :35, `DirectiveRecord` :65, `EngagementRecord` :86, `CaptureRecord` :101, `BattleSample` :119.
- Hooks:
  - `noteHit` :206 (from damage.ts:73).
  - `noteCapture` :238 (capture.ts:45).
  - `noteOpStart`/`noteOpPhase`/`noteOpEnd` :273/300/306 (doctrine.ts:187, 484, 492).
  - `noteDirective` :320 (command.ts:257, 357, 411).
  - `battleSecond` :365 is called from sim.ts:380.
  - `finalizeBattleLog` :422, `battleRecords` :434.
- stats.ts `recordShot`, `recordDamage`, `recordBuilt`, `sampleStats` (sim.ts:398).
- tests/events.test.ts covers events.

## 8. Update check
- Logic (pure, testable): src/ui/updateCheck.ts (143 lines).
  - `RELEASES_API` :8 = https://api.github.com/repos/Zwl20085/LittleWarGame/releases/latest.
  - `RELEASE_URL_PREFIX` :9, `CACHE_KEY 'lwg.updateCheck'` :10, `CACHE_TTL_MS` 6 h, `FETCH_TIMEOUT_MS` 5000.
  - `parseSemver` :24, `compareSemver` :31, `isNewer` :39, `isTrustedReleaseUrl` :44, `parseRelease` :65.
  - `readCache` :86, `writeCache` :107, `fetchLatestRelease` :116, `checkForUpdate(current, env)` :140.
  - Injected env: `UpdateEnv` :79 (`fetch`, `storage`, `now`, `warn`).
- UI wiring: src/ui/update.ts (82 lines).
  - `APP_VERSION` :10 comes from the Vite define `__APP_VERSION__`, which reads package.json at build time (vite.config.ts:9).
  - `latestUpdate()` :41 runs once per launch and returns null if `settings().checkUpdates` is false.
  - `devMock` :33 (`?mockUpdate=v9.9.9`, dev only).
  - `openRelease` :50 uses `window.open`.
  - `updateWidgets()` :60 builds the title-screen version stamp and notice. It is called from src/ui/menu.ts:160.
- Settings toggle: `Settings.checkUpdates` settings.ts:14, default true :18, load :37. Checkbox in src/ui/pause.ts:38 (`settingsFields`), used by the title Settings panel (menu.ts:236) and the pause menu. i18n key `set.checkUpdates` (i18n.ts:136 zh, :291 en).
- Test: tests/updatecheck.test.ts.
- electron/main.cjs (102 lines):
  - `ROOT = dist` (:7).
  - `protocol.registerSchemesAsPrivileged` app:// standard, secure, fetch, cors, stream (:24).
  - `serveDist()` :28 `protocol.handle('app', ...)`. It resolves the path under `ROOT`, rejects traversal with 403, uses `net.fetch(file://)`, and injects the CSP header only on .html responses.
  - CSP :9-21; connect-src allows only `'self'` and `https://api.github.com`.
  - `isSafeExternal` :45 allows https github.com only; `setWindowOpenHandler` opens it with `shell.openExternal`.
  - `createWindow` :55: `webPreferences {contextIsolation:true, sandbox:true, nodeIntegration:false}`.
  - There is NO preload script and no IPC. `loadURL('app://game/index.html')`. `will-navigate` is restricted to `app://game/`.
  - Permissions are denied (:96). F11 toggles fullscreen, Ctrl+Shift+I opens dev tools.
- The updater today is notify-only. There is no download or hot-update code. V30 §3 plans a "hot updater".
- Packaging (package.json): electron-builder, `files: dist/**, electron/**, package.json`, win portable and nsis.

## 9. Camera and input
- Camera: src/render/camera.ts, `CameraRig` :8 (128 lines, LF file).
  - Orthographic: `THREE.OrthographicCamera` :25, `baseHalfHeight 160`, near 1 and far 12000.
  - Fields: yaw (default π/2) and `yawGoal`, `elevationDeg` 45 (clamped 35-70 in `setElevation` :40), `zoom` (clamp `minZoom`..6; `minZoom` 0.08-0.35 from map size :27), `target`, `shake`.
  - Rotation `rotate(delta)` :47 (smoothed toward `yawGoal`); `faceHeading` :52; `zoomBy` :57; `setZoom` :61; `pan(right,forward)` :66 clears `follow`; `lookAt` :76; `update(dt, groundY)` :88; `viewCorners` :117.
  - There is a follow hook: `follow: (() => Vector3|null)|null` :18, consumed in `update` at :93.
- Created in renderer.ts:117 (`this.rig = new CameraRig(...)`). Renderer is a `WebGLRenderer` (:107): ACESFilmic tone mapping (:112), PCFSoft shadows (:109-110), `setQuality` ~:612 (shadow map size and pixel ratio).
- Input: src/ui/input.ts (346 lines).
  - Keys (`keydown` :252): Space pause; A attack-move; H hold; R retreat; G resume; Q/E rotate ±π/8 (:277-280); PageUp/PageDown elevation ±5; Tab toggles elevation 45/70 with zoom 0.55/1; F follow the first selected unit (:296); U hide HUD; Z X C V B directives; 1-8 toggle front cards; Esc cancel or clear selection.
  - Pan keys in `update(dt)` :~335-346: W/S/D/arrows. A pans only when nothing is selected. Left arrow is explicit.
  - Mouse: wheel zoom ×0.88 or ×1.14 (:243); Ctrl+wheel elevation ±3; MMB drag pan (:66, 207); LMB select, drag-box or order-drag; RMB `rightClick` (:85). There is no edge scrolling.
- Cinematic camera: src/ui/cinematic.ts `CinematicDirector` :28 (LF file). It is title-screen attract mode only (menu.ts:106). It finds hotspots on a 90 m `CELL` grid, applies a dip-to-black `FADE_LEAD 0.45` between shots, and respects `prefersReducedMotion`.
- There is no in-game cinematic or kill-cam. Follow exists only as the F key on a single unit.

## 10. Audio
**Files and roles** (src/audio/, ~3000 lines; fortune/music/music.worker/themes are LF)
- engine.ts: `AudioSession` :24 (per match; `update(dt,w,rig,paused,feed)` :39), `AudioEngine` :97 (singleton `audio` :231; `drive(intensity,mode,mood)` :156; `applyVolumes` :168 uses Settings).
- battle.ts: `BattleListener` :48. It turns `world.fx` events into positional SFX across categories (`C` :7: Rifle, Mg, Cannon, At, Mortar, How, ExpS, ExpB, ApHit, Rico, VDeath, Whistle, Distant), rate-limited by the `CATS` table :23, and `scanWhistles` :235.
- mixer.ts: `Mixer` :41, `MAX_VOICES 24`, `BUSY_VOICES 16`, buses 'near'|'far'|'ui'|'alert', `PRIO` :15, `play(PlayReq)` :234, `loop` :306, glue compressor and limiter, sample-bank pump via bank.worker.ts (`BankRequest` :8).
- recipes.ts: procedural SFX `RECIPES` :257, `SOUND_IDS`.
- dsp.ts: primitives (`lowpass`, `noiseBurst`, `sweep`, ...).
- alerts.ts: `AlertWatcher` :34 maps log events to alert cues (`CUES` :18).
- fortune.ts: `FortuneWatch` :14 (implements `MusicMood`: retreat, outcome, stinger from sampled army-value trend, `TREND_TAU 90`).
- music.ts: `Music` :47. It schedules notes ahead (`LOOKAHEAD 0.35`, `MAX_NOTES 48`), calls `conductor.nextBar` :172, applies per-layer buses `applyBuses` :197, and renders the sample bank in music.worker.ts (also `setMode` :158, `setMood` :162).

**Composition**
- Pieces:
  - score.ts `Conductor` :146 composes bar by bar, with `nextBar(ScoreState)` :174, `startPhrase` :212, `stinger` :170. `Style` :51 is calm | tension | battle | lament | hymn | fill | stinger. Layers :18: strings, bass, winds, horns, brass, ostinato, trem, perc, lead.
  - themes.ts `THEMES` :119: chord progressions and bpm (main 66, interlude, tension 76, battle 100, lament 56, hymn 60, victory, defeat, capital) plus melody arrays and rhythm patterns (`SNARE_PATTERNS` :141, `BATTLE_OST8` :146, `STABS`). Key is D minor.
  - orchestra.ts: sample renderer (`INSTRUMENTS` :375, `renderSample` :400, `sampleKeys` :391). Instruments are strings, trem, horn, brass, reed, spic, timp, snare, bdrum, cymbal. Synthesized via oscillators and filters at 24/32 kHz.

**How battle intensity selects music**
- `BattleListener.updateIntensity` battle.ts:284: `intensity = 0.6·local + 0.4·combat`.
  - `local = 1 - exp(-localEnergy/1.2)`, with `localEnergy` decaying at τ6 s.
  - `combat = 1 - exp(-fireRate/80)`.
- `AudioSession.update` engine.ts:~50 smooths it (rise τ1.5 s, fall τ6 s) and raises it to at least 0.75 while an alert is in force. Mode: attract='title', game over='aftermath', else 'battle'. It passes the result to `engine.drive`.
- `Music.update(intensity)` smooths `x` (0.02/frame), builds `layerTargets(x, mode, retreat)` score.ts:89 (the layer gain curve) and brightness `brightness(x)` :118.
- `Conductor.updateWant` :194 chooses calm, tension or battle phrases from the intensity.

**Media renders**: scripts/music-preview.ts writes media/stats/music/{battle,battle-full,calm,defeat,journey,retreat,tension,title,victory}.wav (`OUT_DIR`). Test: tests/music.test.ts. V30 §13 covers music.

## 11. Settlements and economy
**Territory and capture**
- Territory: `Objective` (types.ts:400; kind point|village|town|city, `owner`, `progress`, `contested`, `activeAt`, `radius`). Built from the map def in world.ts. HQ and cities are `world.cityOf(f)` / `hqPos(f)`.
- Ground control: `FrontlineField.ownerAt(p)` (frontline.ts:9). `inSupply(match,f,p)` sim.ts:277 means a settlement pays only if inside own ground control or within `city_local_radius_m` 260 of the HQ.
- Capture: capture.ts `updateObjective(world,o,seconds)` :25, called each economy second (sim.ts:263).
  - `eligibleCapturer` :10 means hp ≥ 50% and the like.
  - Contested if an enemy is present. Multiple sides pause the capture.
  - A single attacker accumulates progress, reaching `territory.capture_seconds[kind]` (village 15, town 30, city 45, point 15 (rules):90).
  - On capture it sets `activeAt = time + node_activation_seconds 30`, writes `noteCapture` and `log.pointTaken`, and applies `resolve_loss_on_capture` (rules :98).
  - Defender presence decays progress at 2/s (:34).
  - HQ: `updateHq` :61, `hqCaptured` :106, 45 s; `majorityBleed` :90; elimination `checkElimination` sim.ts:293. There is no time or territory victory rule, so the war ends only by last standing.
- Places: `Place` (types.ts:288; stock, queue slots, `capitalOf`, `objIdx`). `initPlaces` settlements.ts:43. `placeOwner`/`placeContested`/`placeUsable` :91-101.

**Income** (sim.ts:`economySecond` :189 per faction per second)
- Territory: for each held, uncontested, activated, in-supply objective: `income_p_per_min[kind]` (village 2.25, town 6.75, city 11.25, point 3.4) and `income_m_per_min[kind]` ((rules):88-89) × `k = army_scale × army_scale_income_factor`.
  - Then multiplied by the slider factor `max(0.4, 0.55+0.45·alloc/default)` for P and M.
  - `cityShare = capital_income_share 0.15`.
- Economic buildings: `econIncome` econ.ts:95 (factory M, recruit P; scales with HP and requires supply).
- `economyRates(alloc, rules, bonusP, bonusM, cityShare)` economy.ts:32 combines base income (60 P/min, 30 M/min), allocated income and logistics L. `applyIncome` :44 caps at `cap_p` 1500 and `cap_m` 1200. Also `nodeBonus` :53 (old manpower and industry nodes).
- Steward (auto allocation): `stewardStep` economy.ts:85, run every 5 s. AI investment: `thinkInvestment`, `fundSecond`.
- Logistics L: `logistics_base 6 + logistics_per_allocation 30 × share`, × army_scale. It feeds `stockSecond` settlements.ts:140.

**Population cap tied to territory**
- `populationCap(world,f)` production.ts:144.
  - `n = population_cap(80) × capital_pop_share(0.25) + Σ over owned objectives of territory.pop_per_place[kind] × army_scale`.
  - pop_per_place: village 0.4, town 2, city 4, point 1 ((rules):97).
  - Ceiling: `min(round(cap × pop_cap_max_multiplier 1.5), round(n))`.
- Enforcement in `canStart` :132-137 (`POP_FULL`). `populationOf` is also in production.ts.
- Structures do not count toward population.

## 12. UI structure
- Bootstrapping: src/main.ts (79 lines) → src/ui/menu.ts (339; title menu with items quick, custom, spectate, settings; `openPanel` :204) → src/game.ts `Game` :31 (240 lines) which owns the match, renderer, `SimHost` worker, audio session, `Hud` and `InputController`.
- `GameContext` (src/ui/context.ts, 29 lines): match, bus, renderer, playerId, spectator, speed, paused, `mode` (`InputMode` normal | attackMove | directive), hudHidden, `issue`, `toast`, `openPanel`.
- HUD: src/ui/hud.ts (135 lines) `Hud`.
  - Constructor :30 instantiates every panel and appends them in `this.root` (:47-50). Panels: TopBar (topbar.ts), FrontsPanel (fronts.ts), SelectionPanel (selection.ts), EconomyPanel (economy.ts), TownPanel (town.ts), ProductionBar (production.ts), MinimapPanel (minimap.ts), plus toasts, mode hint, help and paused badge. Zones UI: zones.ts.
  - `relabel()` :~83 and `refresh()` :~105 (5 Hz) call each panel; `dispose()`.
  - Registering a new panel means: build the class with `{el, refresh(), relabel(), dispose?()}`, add it to the Hud constructor and the `this.root` children, and call it in `relabel`, `refresh` and `dispose`. Styles go in src/ui/styles.css (615 lines). DOM helper `h(tag, attrs, ...children)` in dom.ts:4; `PressGuard` :33 holds rebuilds while a button is pressed (used by EconomyPanel).
  - Panel pattern (economy.ts): `el` is `h('div',{class:'x panel'})`, uses `sig` string diffing to skip rebuilds, and toggles `display`.
  - `ctx.openPanel` string is for mutually exclusive popovers.
- i18n: src/ui/i18n.ts (395 lines).
  - `zh: Dict` :7-171 and `en: Dict` :172-325 are flat `'group.key': 'text {param}'` maps.
  - `t(key, params)` :385 looks up in this order: `COMMAND_ZH`/`COMMAND_EN` (src/ui/i18n-command.ts, the 2.2 command strings, which override the main dicts) → dict → `COMMAND_EN` → `en` → the key itself. It then replaces `{name}` params.
  - Unit and weapon names are in separate tables: `unitNames` :326, `unitShort` :341, `weaponNames` :346. Accessors: `unitName`, `unitShortName`, `weaponName`.
  - `lang()`, `setLang()` :369, `onLangChange(fn)` :380. The persisted key is read in `loadLang` :356.
  - A new string requires adding the key to both zh and en (or to both command dicts).
- Settings: src/ui/settings.ts (`Settings` :2, `settings()` :48, `updateSettings(patch)` :52, `onSettingsChange` :64, `applyUiScale` :69, `prefersReducedMotion` :73). Storage key `lwg.settings` in localStorage.
- Settings UI: `settingsFields(onLang)` in src/ui/pause.ts:6 (volume sliders via `volumeField` :44, language, quality, smoke, shake, checkUpdates). It is shared by the title Settings panel (menu.ts:233) and the pause menu `showPauseMenu` :54. A new setting needs a new field in `Settings`, `DEFAULTS`, `load` and a control in pause.ts.
- Fronts UI: src/ui/fronts.ts (363 lines). `DIRECTIVES` :12 palette, `DIRECTIVE_TONE`, `FrontsPanel` (cards for each front, `toggle(frontId)`, `pickDirective`, `modeHint`, `briefing`).
- LF files in the UI: topbar.ts, terrainTip.ts, cinematic.ts (the rest are CRLF).

## 13. Tests
- Runner: Vitest 2.1 (vite.config.ts `test: { environment:'node', include:['tests/**/*.test.ts'] }`). `npm test` = `vitest run`. 29 test files, no shared helper module. Each test defines its own local `setup()` or builds a match inline.
- Fast headless world:
  ```
  import { loadGameData } from '../src/data';
  const match = createMatch(loadGameData(), { mapId:'generated', factions:4, infoMode:'open', seed:11, difficulty:'normal', playerSlot:0, spectate:true });
  ```
  - Then `for (i<seconds*match.world.tickHz) { step(match); match.world.fx.length = 0; }` (tests/fronts.test.ts:19-33 `setup`/`run`).
  - Smaller: `factions:2` (tests/supplyround.test.ts:9).
  - Seeds used: 7, 11, 21.
  - Direct world manipulation is common: `w.spawnUnit(owner, 'infantry', pos, frontId)`, `w.spatial.rebuild(w.aliveUnits)`, `w.tick = n`, set `u.ammo`, call internals such as `drawSecond(w)` and `convoySecond`.
  - Player commands: `new CommandBus()` with `bus.issue(match, actor, cmd); bus.flush(match)` (tests/fronts.test.ts, directive.test.ts).
  - A match build costs real time (map gen and nav), so tests such as pathing.test.ts build the match once at `describe` scope.
- Determinism: tests/determinism.test.ts. It runs seed 7, 4 factions for 120 s twice, FNV-1a hashing float64 bits of every unit's id, pos, hp, morale, ammo, `targetId` and every faction's p, m and resolve every 10 s, plus objective owners and the three RNG seeds (`rngAi`, `rngCombat`, `rngScatter`). It asserts equality and more than 100 units. Timeout 300 s.
- Other notable tests: fronts.test.ts, directive.test.ts, homeguard.test.ts, logistics.test.ts, supplyround.test.ts, econ.test.ts, econLots.test.ts, econwar.test.ts, structures.test.ts, structureKinds.test.ts, territory.test.ts, storm.test.ts, terrainai.test.ts, terraincombat.test.ts, mapgen.test.ts, roadside.test.ts, pathing.test.ts, rules.test.ts, perf.test.ts, longrun.test.ts, smoke.test.ts, events.test.ts, challenge.test.ts, quality.test.ts, music.test.ts, updatecheck.test.ts, armour.test.ts, autoinvest.test.ts.

## 14. Visual fx
- src/render/effects.ts (520 lines) `Effects` :43. It handles `FxEvent` via `handle(e)` :125 and holds instanced decals (`MAX_DECALS 1200`), tracers (`MAX_TRACERS 5000`), smoke and glow particle pools. Also `wreckFire` :248, `workSite` :274, `trackDust` :283, `chimneySmoke` :295, `syncProjectiles` :445 and `update(dt)` :480. `WIND` constant :26.
  - Composed from `ArtilleryFx` (artilleryFx.ts, with `ShellTrails`), `ImpactFx` (impactFx.ts) and `TownFires` (townFires.ts), built at effects.ts:83-85.
  - Other fx: particles.ts, fxTextures.ts, glslNoise.ts, shellTrails.ts, contactShadows.ts.
- Atmosphere: atmosphere.ts. `LIGHT` :4 is a fixed late-afternoon sun, hemisphere light and a shadowless fill. `Haze` :47 is distance haze, and `roomBackground` :28 is the war-room backdrop.
- Renderer: ACES tone mapping and PCF shadows (renderer.ts:109-113). A sun `DirectionalLight` with a shadow camera (:125-139) updates shadows less often when zoomed out (:535-536). `fog` flag :99 is the fog-of-war flag, not scene fog.
- Screen-space: screenOverlay.ts `ScreenOverlay` :7 and `Declutter` :62 are 2D labels. They are not an EffectComposer.
- There is NO post-processing pass (no EffectComposer or bloom), and NO day/night cycle or weather. Sun direction and colours are constants. The only ambient motion is `WIND` and smoke.
- Quality tiers: render/quality.ts (`QUALITY_PROFILES` :20, `QualityGovernor` :77: auto drop above 24 ms for 3 s, cooldown 12 s). Wired through Settings.quality.
- Storm (siege) is a sim concept (sim/storm.ts), not weather.

## Extras
**15 largest source files** (src, scripts, tests and electron; lines)
- 938 src/sim/homeguard.ts
- 920 src/sim/fronts.ts
- 791 src/sim/terrain.ts
- 777 src/render/unitViews.ts
- 773 src/sim/behavior.ts
- 660 src/sim/theatre.ts
- 651 src/sim/nav.ts
- 649 src/render/renderer.ts
- 645 src/sim/structures.ts
- 632 src/render/townProps.ts
- 615 src/ui/styles.css
- 605 src/audio/score.ts
- 538 src/sim/mapgen.ts
- 530 src/sim/command.ts
- 529 src/sim/movement.ts
- Next: sim/doctrine.ts 507, render/effects.ts 520, sim/combat.ts 496, sim/types.ts 500.
- Largest doc: docs/STRATEGY_LAB.md 1008. Non-code: package-lock.json 6251.
- The 30 V3 hot-spot files from V30 §0 (types.ts, sim.ts, snapshot.ts, commands.ts, behavior.ts, hud.ts, i18n.ts, renderer.ts, rules.json) are all in the top groups.

**CRLF vs LF**
- Working tree: every src/sim/*.ts file is CRLF (all lines end in `\r\n`; 68 files checked, CR count equals line count).
- Git: `.gitattributes` has `* text=auto` and `core.autocrlf=true`. The index stores LF (`git ls-files --eol` shows `i/lf w/crlf` for sim files, rules.json, units.csv and main.cjs), so the working tree is converted on checkout.
- Working-tree LF exceptions (19 files): scripts/lab.ts, scripts/lab/overrides.ts, scripts/lab/run.ts, scripts/perf-browser.mjs, scripts/profile.mjs, scripts/strategy/perfab.ts, src/audio/{fortune,music,music.worker,themes}.ts, src/render/{camera,fieldWorks,objectiveMarkers,pontoon,soldierMotion,trenchSweep}.ts, src/ui/{cinematic,terrainTip,topbar}.ts, tests/events.test.ts.
- When scripting edits over CRLF files, match the line ending or the diff may show whole-file churn (git normalizes on add).

**npm scripts** (package.json, version 2.2.1)
- `dev` = vite (port 5173)
- `build` = tsc --noEmit && vite build
- `preview` = vite preview
- `test` = vitest run
- `typecheck` = tsc --noEmit
- `app` = npm run build && electron .
- `dist:win` = npm run build && electron-builder --win portable nsis
- Labs are run via `npx tsx scripts/<name>.ts` (no npm script). music-preview uses `npx vite-node`. Deps: three ^0.169, vite 5.4, vitest 2.1, TypeScript 5.6, electron ^33, electron-builder ^25, playwright-core 1.48.

**Key global constants**
- Tick rate 20 Hz ((rules):39 `tick_hz`).
- Unit think is staggered: 0.4 s, or 1 s for howitzer and mortar, plus `(id*7%10)/50`.
- Front think is 2 s. Frontline field update is 2 s. Economy runs every 1 s. City AI runs every `AI.cityThinkSeconds`, 30 s on easy and 12 s on hard.
- Army scale is `proposed_defaults.army_scale`, applied in `scaledData`.
- Default map is 'generated' with seed. Factions can be 2 to 4.