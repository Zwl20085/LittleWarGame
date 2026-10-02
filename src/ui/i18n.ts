export type Lang = 'zh' | 'en';

type Dict = Record<string, string>;

const zh: Dict = {
  'app.title': '小小战争沙盘',
  'app.subtitle': '二战即时战斗沙盘 · 作战室',
  'lang.toggle': 'EN',
  // setup
  'setup.quick': '快速开战',
  'setup.map': '地图',
  'setup.opponents': '电脑对手',
  'setup.difficulty': '难度',
  'setup.info': '敌情模式',
  'setup.seed': '随机种子',
  'setup.spectate': '仅观战（全 AI）',
  'setup.start': '开始作战',
  'setup.advanced': '进阶选项',
  'setup.timeLimit': '不设时间上限：攻占敌方首都或其战役意志崩溃才会结束战争。',
  'setup.loading': '正在铺设沙盘……',
  'diff.easy': '简单', 'diff.normal': '普通', 'diff.hard': '困难',
  'info.open': '公开沙盘', 'info.fog': '战争迷雾',
  'map.greystone_pinecreek': '灰石市—松溪市（1v1）',
  'map.four_cities': '四城混战（4 方）',
  // top bar
  'hud.p': '兵员', 'hud.m': '军需', 'hud.pop': '人口', 'hud.log': '后勤', 'hud.resolve': '战役意志',
  'hud.perMin': '/分', 'hud.auto': '托管', 'hud.manual': '手动', 'hud.paused': '已暂停', 'hud.simSlow': '模拟负载过高：实际速度低于设定',
  'hud.speed': '速度', 'hud.time': '时间',
  'hud.layers': '图层', 'layer.front': '战线', 'layer.supply': '补给', 'layer.ranges': '射程', 'layer.sectors': '战区',
  'hud.help': '帮助',
  'hud.hideHint': '按 U 恢复界面',
  // sectors
  'sector.left': '左翼', 'sector.center': '中路', 'sector.right': '右翼',
  'sector.main': '主攻', 'sector.setTarget': '指定目标', 'sector.clearTarget': '自动目标', 'sector.share': '增援份额',
  'sector.regroup': '重整战区', 'sector.units': '{n} 支部队',
  'hq.title': '统帅部指令', 'hq.defend': '守备', 'hq.attack': '进攻', 'hq.occupy': '占领', 'hq.goto': '点击定位',
  'posture.cautious': '谨慎推进', 'posture.assault': '强攻', 'posture.hold': '固守', 'posture.fortify': '筑垒', 'posture.withdraw': '撤收',
  'reason.capturePoint': '争夺 {point}', 'reason.defendCity': '城市遇袭，回防', 'reason.assaultCity': '进攻 {city}',
  'reason.outmatched': '敌强我弱，集结待援', 'reason.waitGroup': '等待集结（步兵 {n}/{need}）', 'reason.playerTarget': '玩家指定目标',
  // production
  'prod.title': '出兵配置', 'prod.weight': '支出权重', 'prod.cap': '数量上限', 'prod.pause': '暂停', 'prod.resume': '恢复',
  'prod.addOne': '加一支', 'prod.sector': '目标战区', 'prod.autoSector': '按份额', 'prod.queue': '生产队列',
  'prod.unlockIn': '{s} 秒后解锁', 'prod.cost': '成本', 'prod.count': '在场/上限', 'prod.cancel': '取消（返还 50%）',
  'prod.preset': '预设', 'preset.balanced': '均衡推进', 'preset.armor': '装甲突破', 'preset.infantry': '步兵筑垒', 'preset.artillery': '炮兵消耗',
  'block.LOCKED': '未解锁', 'block.CAP': '已达上限', 'block.POP_FULL': '人口已满', 'block.INSUFFICIENT_P': '缺兵员',
  'block.INSUFFICIENT_M': '缺军需', 'block.PROTECTED': '资源为高价订单预留', 'block.NO_SLOT': '等待生产位',
  'prod.building': '生产中 {p}%', 'prod.blocked': '等待出口', 'prod.protecting': '为 {unit} 预留军需',
  // economy
  'eco.title': '城市劳动力', 'eco.mobil': '动员', 'eco.industry': '工业', 'eco.logistics': '后勤', 'eco.lock': '锁定',
  'eco.reset': '还原均衡', 'eco.autoOn': '托管开启', 'eco.autoOff': '手动分配', 'eco.buildMul': '生产工时 ×{v}',
  'steward.default': '托管：维持当前分配', 'steward.shiftP': '托管：兵员需求上升，动员调至 {to}%',
  'steward.shiftI': '托管：军需订单增加，工业调至 {to}%', 'steward.shiftL': '托管：补给不足，后勤调至 {to}%',
  // air
  'air.title': '空勤', 'air.air_recon': '空中侦察', 'air.air_strafe': '对地扫射', 'air.air_bomb': '区域轰炸',
  'air.preparing': '准备中 {s}s', 'air.flying': '执行中', 'air.cooldown': '冷却 {s}s', 'air.idle': '待命',
  'air.pick': '点击地图选择{mission}区域（Esc 取消）', 'air.cancel': '取消（返还 50%）',
  // selection
  'sel.hp': '兵力', 'sel.morale': '士气', 'sel.supp': '压制', 'sel.ammo': '弹药', 'sel.supply': '补给',
  'sel.mode': '控制', 'sel.auto': '自动', 'sel.manual': '手动覆盖', 'sel.sector': '战区', 'sel.status': '状态',
  'sel.multi': '已选 {n} 支部队', 'sel.lowestMorale': '最低士气', 'sel.unsupplied': '缺补给',
  'sel.enemy': '敌方（仅可查看）', 'sel.setup.set': '已架设', 'sel.setup.packed': '收起', 'sel.setup.setting': '架设中', 'sel.setup.packing': '收起中',
  'cmd.move': '移动', 'cmd.moveHold': '移动并固守', 'cmd.attackMove': '攻击移动 (A)', 'cmd.hold': '固守 (H)', 'cmd.retreat': '撤退 (R)', 'cmd.resume': '恢复自动 (G)',
  'cmd.hint': '右键地面：移动，到达后恢复战区 · 右键敌人：集火',
  'cmd.pickAttack': '左键选择攻击移动目的地',
  'fail.UNREACHABLE': '目标无法到达', 'fail.STALE_TARGET': '目标情报已过期', 'fail.ROUTING': '溃退部队无法执行', 'fail.LOCKED': '尚未解锁',
  'fail.BUSY': '空勤正忙', 'fail.INSUFFICIENT_M': '军需不足', 'fail.NOT_OWNER': '无法指挥该部队', 'fail.OUT_OF_BOUNDS': '超出地图',
  'fail.BAD_VALUE': '数值无效', 'fail.FACTION_DEAD': '阵营已淘汰', 'fail.NO_ORDER': '无可取消项', 'fail.UNKNOWN_MISSION': '未知任务',
  // statuses
  'status.noArc': '无可行弹道', 'status.unreachable': '目标无法到达', 'status.routing': '溃退中', 'status.retreat': '撤退中',
  'status.recovering': '休整补员', 'status.withdraw': '撤收', 'status.rally': '集结中', 'status.suppressed': '被压制，伏低',
  'status.engaging': '交战中', 'status.holding': '据守', 'status.assaultCity': '进攻城市', 'status.advancing': '推进中',
  'status.firing': '射击', 'status.positioning': '转移阵位', 'status.covering': '架设警戒', 'status.settingUp': '架设中',
  'status.observing': '前沿观察', 'status.noBudget': '缺工程预算', 'status.building': '施工中', 'status.supplying': '中继补给',
  'status.manualMove': '手动：移动', 'status.manualAttackMove': '手动：攻击移动', 'status.manualFocus': '手动：集火',
  'status.spearhead': '突破纵深', 'status.bridging': '架设浮桥', 'status.relocating': '炮兵转移阵地', 'status.huntRaiders': '清剿后方渗透之敌', 'status.rearGuard': '警戒补给线', 'status.garrison': '奉命守备城镇', 'status.occupy': '奉命占领城镇', 'status.toDepot': '返回补给站', 'status.loading': '装载弹药', 'status.convoyOut': '运送补给', 'status.unloading': '分发弹药', 'status.convoyBack': '空车返回', 'status.raiding': '袭击敌补给线', 'status.escort': '掩护补给车',
  'status.manualRetreat': '手动：撤退', 'status.manualHold': '手动：固守',
  'morale.normal': '正常', 'morale.suppressed': '受压制', 'morale.pinned': '钉住', 'morale.routing': '溃退', 'morale.wavering': '动摇',
  // logs
  'log.unitLost': '损失 {unit}（{weapon}）', 'log.routing': '{unit} 士气崩溃', 'log.unitRouting': '{unit} 溃退',
  'log.pointTaken': '占领 {point}', 'log.pointLost': '失去 {point}', 'log.hqUnderAttack': '指挥部遭敌步兵占领！',
  'log.overflow': '资源已达上限，溢出部分丢弃', 'log.eliminated': '{f} 被淘汰（{reason}）', 'log.airPreparing': '{mission} 准备中，{s} 秒',
  'log.airLaunched': '{mission} 已起飞', 'log.planeLost': '{mission} 飞机被击落', 'log.resumeAuto': '{unit} 恢复自动任务',
  'log.unreachable': '{unit} 目标无法到达，已恢复自动',
  'log.convoyThreat': '补给车队遭遇敌军，掉头返回', 'log.spearhead': '组织 {n} 支部队突破敌线，直取 {point}', 'log.raidLaunched': '{n} 支部队渗透敌后，袭击补给线', 'log.bridgeStarted': '工兵开始架设浮桥', 'log.reservesShifted': '抽调 {n} 支部队增援吃紧的战区', 'log.bridgeBuilt': '浮桥架设完成', 'log.hqDefend': '统帅部：抽调 {n} 支部队守备 {point}', 'log.hqOccupy': '统帅部：派 {n} 支部队占领 {point}', 'log.raid': '{unit} 出击袭扰敌补给线',
  'log.protect': '为 {unit} 预留资源', 'log.protectExpired': '{unit} 资源预留到期', 'log.exitBlocked': '城市出口拥堵，等待出场',
  'reason.resolve': '战役意志耗尽', 'reason.hq': '指挥部失守',
  // results
  'res.victory': '胜利', 'res.defeat': '战败', 'res.draw': '共同毁灭', 'res.timeout': '时间到 · 裁定',
  'res.winner': '胜者：{f}', 'res.duration': '时长', 'res.produced': '出兵', 'res.lost': '损失', 'res.spent': '支出', 'res.resolve': '剩余意志',
  'res.again': '再来一局', 'res.menu': '回主界面', 'res.spectate': '继续观战', 'res.eliminatedSpectate': '你已被淘汰，可继续观战',
  'menu.title': '暂停', 'menu.resume': '继续', 'menu.quit': '退出到主界面', 'menu.settings': '设置',
  'set.smoke': '烟雾强度', 'set.shake': '镜头震动', 'set.uiScale': '界面缩放', 'set.elev': '俯角',
  'help.body': '左键/拖框：选择 · 右键：移动/集火 · A：攻击移动 · H：固守 · R：撤退 · G：恢复自动 · WASD/中键：平移 · Q/E：旋转 · 滚轮：缩放 · PgUp/PgDn：俯角 · Tab：总览 · F：跟随 · Space：暂停 · U：隐藏界面 · Esc：取消/菜单',
  'faction': '{roman} {city}',
  'you': '（你）',
  'ai.balanced': '均衡', 'ai.armor': '装甲', 'ai.infantry': '步兵', 'ai.artillery': '炮兵',  // title screen (titles stay English by design; descriptions follow the language)
  'title.kicker': 'OPERATIONS ROOM · EUROPE 1944', 'title.name': 'LITTLE WAR', 'title.sub': 'A WWII BATTLE DIORAMA',
  'title.quick': 'QUICK BATTLE', 'title.custom': 'CUSTOM BATTLE', 'title.spectate': 'SPECTATE', 'title.settings': 'SETTINGS',
  'title.quickDesc': '四方混战 · 随机生成地图 · 普通难度', 'title.customDesc': '地图、对手、难度、敌情模式与种子',
  'title.spectateDesc': '全 AI 对战，自由观看', 'title.settingsDesc': '语言、界面缩放、烟雾、镜头震动与声音',
  'title.live': '实况 · AI 交战', 'title.deploying': '部队展开中 {p}%', 'title.keys': '↑↓ 选择 · Enter 确认 · Esc 返回', 'title.back': '返回',
  'set.lang': '语言',
  'set.volMaster': '总音量', 'set.volMusic': '音乐', 'set.volSfx': '音效', 'set.mute': '静音',
  'setup.factions': '参战方', 'setup.mapSize': '地图尺寸', 'size.medium': '中型', 'size.large': '大型', 'setup.random': '随机',
  'map.generated': '随机生成', 'map.four_cities.short': '四城（测试）', 'map.greystone_pinecreek.short': '灰石—松溪（测试）',
  'err.start': '无法开始对局', 'err.reload': '重新载入',
  // unit tooltip
  'tip.hp': '兵力', 'tip.speed': '速度', 'tip.range': '射程', 'tip.armor': '装甲 前/侧/后', 'tip.pop': '人口', 'tip.build': '工时',
  'tip.weapon': '主武器', 'tip.vision': '视野', 'tip.setup': '架设', 'tip.click': '点击：配比、上限、战区与加一支',
  // terrain readout
  'layer.terrain': '地形', 'terr.title': '地况',
  'ground.0': '开阔地', 'ground.1': '道路', 'ground.2': '林地', 'ground.3': '城镇', 'ground.4': '泥地', 'ground.5': '深水', 'ground.6': '浅滩',
  'terr.height': '高度', 'terr.slope': '坡度', 'terr.cover': '掩护', 'cover.0': '无', 'cover.1': '轻度', 'cover.2': '重度',
  'terr.near': '附近', 'terr.impassable': '不可通行', 'terr.slow': '减速', 'terr.fast': '快速',
  'feat.mountain': '山', 'feat.hill': '丘陵', 'feat.river': '河流', 'feat.lake': '湖', 'feat.forest': '林', 'feat.town': '镇',
  'feat.city': '城市', 'feat.pass': '山口', 'feat.bridge': '桥', 'feat.ford': '渡口',
  'reason.crossAt': '在{feature}渡河（{kind}）', 'reason.holdRiver': '依托{feature}河线固守', 'reason.holdHigh': '占据{feature}高地', 'reason.holdLine': '在{feature}一线固守', 'reason.holdFront': '在{feature}前线固守', 'reason.pushFront': '向{point}推进战线', 'reason.bridging': '工兵架设浮桥中', 'feat.here': '前沿',
  'air.short.air_recon': '侦察', 'air.short.air_strafe': '扫射', 'air.short.air_bomb': '轰炸', 'prod.unlockShort': '{s}秒解锁',
  'hud.sides': '各方意志', 'hud.speedTip': '模拟速度', 'hud.pauseTip': '暂停 / 继续（Space）', 'hud.logiTip': '后勤满足度：供给能力 / 需求', 'hud.resolveTip': '战役意志：归零即淘汰',
};

const en: Dict = {
  'app.title': 'Little War Diorama',
  'app.subtitle': 'WWII real-time battle diorama · Operations Room',
  'lang.toggle': '中文',
  'setup.quick': 'Quick Battle',
  'setup.map': 'Map',
  'setup.opponents': 'AI opponents',
  'setup.difficulty': 'Difficulty',
  'setup.info': 'Intel mode',
  'setup.seed': 'Seed',
  'setup.spectate': 'Spectate only (all AI)',
  'setup.start': 'Begin Operation',
  'setup.advanced': 'Advanced',
  'setup.timeLimit': 'No time limit: the war ends only when capitals fall or resolve collapses.',
  'setup.loading': 'Laying out the diorama…',
  'diff.easy': 'Easy', 'diff.normal': 'Normal', 'diff.hard': 'Hard',
  'info.open': 'Open table', 'info.fog': 'Fog of war',
  'map.greystone_pinecreek': 'Greystone – Pinecreek (1v1)',
  'map.four_cities': 'Four Cities (4-way FFA)',
  'hud.p': 'Manpower', 'hud.m': 'Munitions', 'hud.pop': 'Pop', 'hud.log': 'Logistics', 'hud.resolve': 'Resolve',
  'hud.perMin': '/min', 'hud.auto': 'Auto', 'hud.manual': 'Manual', 'hud.paused': 'PAUSED', 'hud.simSlow': 'Simulation overloaded — running below set speed',
  'hud.speed': 'Speed', 'hud.time': 'Time',
  'hud.layers': 'Layers', 'layer.front': 'Front', 'layer.supply': 'Supply', 'layer.ranges': 'Range', 'layer.sectors': 'Sectors',
  'hud.help': 'Help',
  'hud.hideHint': 'Press U to restore HUD',
  'sector.left': 'Left', 'sector.center': 'Centre', 'sector.right': 'Right',
  'sector.main': 'Main effort', 'sector.setTarget': 'Set target', 'sector.clearTarget': 'Auto target', 'sector.share': 'Reinforcement share',
  'sector.regroup': 'Regroup sectors', 'sector.units': '{n} units',
  'hq.title': 'High command', 'hq.defend': 'Defend', 'hq.attack': 'Attack', 'hq.occupy': 'Occupy', 'hq.goto': 'Click to locate',
  'posture.cautious': 'Cautious', 'posture.assault': 'Assault', 'posture.hold': 'Hold', 'posture.fortify': 'Fortify', 'posture.withdraw': 'Withdraw',
  'reason.capturePoint': 'Contesting {point}', 'reason.defendCity': 'City under attack — falling back', 'reason.assaultCity': 'Attacking {city}',
  'reason.outmatched': 'Outmatched — massing first', 'reason.waitGroup': 'Gathering (infantry {n}/{need})', 'reason.playerTarget': 'Player-set target',
  'prod.title': 'Force Plan', 'prod.weight': 'Spend weight', 'prod.cap': 'Max count', 'prod.pause': 'Pause', 'prod.resume': 'Resume',
  'prod.addOne': 'Add one', 'prod.sector': 'Sector', 'prod.autoSector': 'By share', 'prod.queue': 'Production',
  'prod.unlockIn': 'Unlocks in {s}s', 'prod.cost': 'Cost', 'prod.count': 'Field/cap', 'prod.cancel': 'Cancel (50% refund)',
  'prod.preset': 'Preset', 'preset.balanced': 'Balanced push', 'preset.armor': 'Armoured thrust', 'preset.infantry': 'Infantry & works', 'preset.artillery': 'Artillery attrition',
  'block.LOCKED': 'Locked', 'block.CAP': 'At cap', 'block.POP_FULL': 'Population full', 'block.INSUFFICIENT_P': 'Need manpower',
  'block.INSUFFICIENT_M': 'Need munitions', 'block.PROTECTED': 'Reserved for priority order', 'block.NO_SLOT': 'Waiting for slot',
  'prod.building': 'Building {p}%', 'prod.blocked': 'Waiting for exit', 'prod.protecting': 'Reserving for {unit}',
  'eco.title': 'City Labour', 'eco.mobil': 'Mobilise', 'eco.industry': 'Industry', 'eco.logistics': 'Logistics', 'eco.lock': 'Lock',
  'eco.reset': 'Reset balance', 'eco.autoOn': 'Steward on', 'eco.autoOff': 'Manual', 'eco.buildMul': 'Build time ×{v}',
  'steward.default': 'Steward: holding allocation', 'steward.shiftP': 'Steward: manpower demand up, mobilise → {to}%',
  'steward.shiftI': 'Steward: munitions orders up, industry → {to}%', 'steward.shiftL': 'Steward: supply short, logistics → {to}%',
  'air.title': 'Air', 'air.air_recon': 'Recon flight', 'air.air_strafe': 'Strafing run', 'air.air_bomb': 'Bombing run',
  'air.preparing': 'Preparing {s}s', 'air.flying': 'In flight', 'air.cooldown': 'Cooldown {s}s', 'air.idle': 'Ready',
  'air.pick': 'Click the map to target {mission} (Esc cancels)', 'air.cancel': 'Cancel (50% refund)',
  'sel.hp': 'Strength', 'sel.morale': 'Morale', 'sel.supp': 'Suppression', 'sel.ammo': 'Ammo', 'sel.supply': 'Supply',
  'sel.mode': 'Control', 'sel.auto': 'Auto', 'sel.manual': 'Manual override', 'sel.sector': 'Sector', 'sel.status': 'Status',
  'sel.multi': '{n} units selected', 'sel.lowestMorale': 'Lowest morale', 'sel.unsupplied': 'Unsupplied',
  'sel.enemy': 'Enemy (view only)', 'sel.setup.set': 'Deployed', 'sel.setup.packed': 'Packed', 'sel.setup.setting': 'Deploying', 'sel.setup.packing': 'Packing',
  'cmd.move': 'Move', 'cmd.moveHold': 'Move & hold', 'cmd.attackMove': 'Attack-move (A)', 'cmd.hold': 'Hold (H)', 'cmd.retreat': 'Retreat (R)', 'cmd.resume': 'Resume auto (G)',
  'cmd.hint': 'Right-click ground: move, then resume sector · Right-click enemy: focus fire',
  'cmd.pickAttack': 'Left-click attack-move destination',
  'fail.UNREACHABLE': 'Destination unreachable', 'fail.STALE_TARGET': 'Target intel is stale', 'fail.ROUTING': 'Routing units cannot comply', 'fail.LOCKED': 'Not unlocked yet',
  'fail.BUSY': 'Air wing busy', 'fail.INSUFFICIENT_M': 'Not enough munitions', 'fail.NOT_OWNER': 'Cannot command that unit', 'fail.OUT_OF_BOUNDS': 'Outside the map',
  'fail.BAD_VALUE': 'Invalid value', 'fail.FACTION_DEAD': 'Faction eliminated', 'fail.NO_ORDER': 'Nothing to cancel', 'fail.UNKNOWN_MISSION': 'Unknown mission',
  'status.noArc': 'No firing solution', 'status.unreachable': 'Destination unreachable', 'status.routing': 'Routing', 'status.retreat': 'Retreating',
  'status.recovering': 'Refitting', 'status.withdraw': 'Withdrawing', 'status.rally': 'Rallying', 'status.suppressed': 'Suppressed — going to ground',
  'status.engaging': 'Engaging', 'status.holding': 'Holding', 'status.assaultCity': 'Assaulting city', 'status.advancing': 'Advancing',
  'status.firing': 'Firing', 'status.positioning': 'Repositioning', 'status.covering': 'Deployed, covering', 'status.settingUp': 'Deploying',
  'status.observing': 'Forward observing', 'status.noBudget': 'No works budget', 'status.building': 'Building', 'status.supplying': 'Relaying supply',
  'status.manualMove': 'Manual: move', 'status.manualAttackMove': 'Manual: attack-move', 'status.manualFocus': 'Manual: focus fire',
  'status.spearhead': 'Spearhead: breaking through', 'status.bridging': 'Building a pontoon bridge', 'status.relocating': 'Battery relocating', 'status.huntRaiders': 'Hunting raiders in the rear', 'status.rearGuard': 'Guarding supply route', 'status.garrison': 'Garrisoning a town (HQ order)', 'status.occupy': 'Occupying a town (HQ order)', 'status.toDepot': 'To depot', 'status.loading': 'Loading ammunition', 'status.convoyOut': 'Convoy en route', 'status.unloading': 'Issuing ammunition', 'status.convoyBack': 'Returning empty', 'status.raiding': 'Raiding enemy supply', 'status.escort': 'Protecting convoy',
  'status.manualRetreat': 'Manual: retreat', 'status.manualHold': 'Manual: hold',
  'morale.normal': 'Steady', 'morale.suppressed': 'Suppressed', 'morale.pinned': 'Pinned', 'morale.routing': 'Routing', 'morale.wavering': 'Wavering',
  'log.unitLost': 'Lost {unit} ({weapon})', 'log.routing': '{unit} morale broke', 'log.unitRouting': '{unit} routing',
  'log.pointTaken': 'Captured {point}', 'log.pointLost': 'Lost {point}', 'log.hqUnderAttack': 'Enemy infantry are taking our HQ!',
  'log.overflow': 'Stockpile full — overflow discarded', 'log.eliminated': '{f} eliminated ({reason})', 'log.airPreparing': '{mission} preparing, {s}s',
  'log.airLaunched': '{mission} airborne', 'log.planeLost': '{mission} aircraft shot down', 'log.resumeAuto': '{unit} resumed automatic tasks',
  'log.unreachable': '{unit}: destination unreachable, back to auto',
  'log.convoyThreat': 'Convoy ran into the enemy and turned back', 'log.spearhead': '{n} units break through toward {point}', 'log.raidLaunched': '{n} units infiltrate to raid enemy supply', 'log.bridgeStarted': 'Engineers started a pontoon bridge', 'log.reservesShifted': '{n} units shifted to a hard-pressed sector', 'log.bridgeBuilt': 'Pontoon bridge completed', 'log.hqDefend': 'High command: {n} units sent to hold {point}', 'log.hqOccupy': 'High command: {n} units sent to occupy {point}', 'log.raid': '{unit} sent to raid enemy supply',
  'log.protect': 'Reserving resources for {unit}', 'log.protectExpired': 'Reservation for {unit} expired', 'log.exitBlocked': 'City exit congested, units waiting',
  'reason.resolve': 'resolve exhausted', 'reason.hq': 'HQ captured',
  'res.victory': 'Victory', 'res.defeat': 'Defeat', 'res.draw': 'Mutual destruction', 'res.timeout': 'Time limit · decision',
  'res.winner': 'Winner: {f}', 'res.duration': 'Duration', 'res.produced': 'Produced', 'res.lost': 'Lost', 'res.spent': 'Spent', 'res.resolve': 'Resolve left',
  'res.again': 'Play again', 'res.menu': 'Main menu', 'res.spectate': 'Keep watching', 'res.eliminatedSpectate': 'You were eliminated — you may keep watching',
  'menu.title': 'Paused', 'menu.resume': 'Resume', 'menu.quit': 'Quit to menu', 'menu.settings': 'Settings',
  'set.smoke': 'Smoke density', 'set.shake': 'Camera shake', 'set.uiScale': 'UI scale', 'set.elev': 'Elevation',
  'help.body': 'LMB/drag: select · RMB: move/focus · A: attack-move · H: hold · R: retreat · G: resume auto · WASD/MMB: pan · Q/E: rotate · Wheel: zoom · PgUp/PgDn: tilt · Tab: overview · F: follow · Space: pause · U: hide HUD · Esc: cancel/menu',
  'faction': '{roman} {city}',
  'you': ' (you)',
  'ai.balanced': 'Balanced', 'ai.armor': 'Armour', 'ai.infantry': 'Infantry', 'ai.artillery': 'Artillery',  'title.kicker': 'OPERATIONS ROOM · EUROPE 1944', 'title.name': 'LITTLE WAR', 'title.sub': 'A WWII BATTLE DIORAMA',
  'title.quick': 'QUICK BATTLE', 'title.custom': 'CUSTOM BATTLE', 'title.spectate': 'SPECTATE', 'title.settings': 'SETTINGS',
  'title.quickDesc': '4-way free-for-all · generated map · normal', 'title.customDesc': 'Map, opponents, difficulty, intel and seed',
  'title.spectateDesc': 'All-AI battle, free camera', 'title.settingsDesc': 'Language, UI scale, smoke, camera shake, sound',
  'title.live': 'LIVE · AI BATTLE', 'title.deploying': 'DEPLOYING FORCES {p}%', 'title.keys': '↑↓ Select · Enter Confirm · Esc Back', 'title.back': 'Back',
  'set.lang': 'Language',
  'set.volMaster': 'Master volume', 'set.volMusic': 'Music', 'set.volSfx': 'Effects', 'set.mute': 'Mute',
  'setup.factions': 'Factions', 'setup.mapSize': 'Map size', 'size.medium': 'Medium', 'size.large': 'Large', 'setup.random': 'Random',
  'map.generated': 'Generated', 'map.four_cities.short': 'Four Cities (test)', 'map.greystone_pinecreek.short': 'Greystone 1v1 (test)',
  'err.start': 'Failed to start match', 'err.reload': 'Reload',
  'tip.hp': 'Strength', 'tip.speed': 'Speed', 'tip.range': 'Range', 'tip.armor': 'Armour F/S/R', 'tip.pop': 'Pop', 'tip.build': 'Build',
  'tip.weapon': 'Main weapon', 'tip.vision': 'Vision', 'tip.setup': 'Setup', 'tip.click': 'Click: weight, cap, sector and add one',
  'layer.terrain': 'Terrain', 'terr.title': 'Ground',
  'ground.0': 'Open ground', 'ground.1': 'Road', 'ground.2': 'Woods', 'ground.3': 'Town', 'ground.4': 'Mud', 'ground.5': 'Deep water', 'ground.6': 'Ford',
  'terr.height': 'Height', 'terr.slope': 'Slope', 'terr.cover': 'Cover', 'cover.0': 'None', 'cover.1': 'Light', 'cover.2': 'Heavy',
  'terr.near': 'Near', 'terr.impassable': 'Impassable', 'terr.slow': 'Slow going', 'terr.fast': 'Fast going',
  'feat.mountain': 'Mt.', 'feat.hill': 'Hill', 'feat.river': 'River', 'feat.lake': 'Lake', 'feat.forest': 'Woods', 'feat.town': 'Town',
  'feat.city': 'City', 'feat.pass': 'Pass', 'feat.bridge': 'Bridge', 'feat.ford': 'Ford',
  'reason.crossAt': 'Crossing at {feature} ({kind})', 'reason.holdRiver': 'Holding the river line at {feature}', 'reason.holdHigh': 'Holding high ground at {feature}', 'reason.holdLine': 'Holding the line near {feature}', 'reason.holdFront': 'Holding the front near {feature}', 'reason.pushFront': 'Pushing the front toward {point}', 'reason.bridging': 'Engineers bridging the river', 'feat.here': 'the front',
  'air.short.air_recon': 'Recon', 'air.short.air_strafe': 'Strafe', 'air.short.air_bomb': 'Bomb', 'prod.unlockShort': 'Unlock {s}s',
  'hud.sides': 'All sides', 'hud.speedTip': 'Simulation speed', 'hud.pauseTip': 'Pause / resume (Space)', 'hud.logiTip': 'Logistics: supply capacity / demand', 'hud.resolveTip': 'Resolve: a side at zero is eliminated',
};

/** Historical-flavour equipment names (fictional factions; user-approved naming). */
const unitNames: Record<string, [string, string]> = {
  infantry: ['步枪班', 'Rifle Squad'],
  recon: ['侦察班', 'Recon Section'],
  mg: ['重机枪组（维克斯式）', 'HMG Team (Vickers-type)'],
  engineer: ['突击工兵班', 'Assault Engineers'],
  at_gun: ['反坦克炮（6磅式）', 'AT Gun (6-pdr type)'],
  mortar: ['81毫米迫击炮', '81 mm Mortar'],
  light_tank: ['轻型坦克（斯图亚特式）', 'Light Tank (Stuart-type)'],
  medium_tank: ['中型坦克（谢尔曼式）', 'Medium Tank (Sherman-type)'],
  heavy_tank: ['重型坦克（虎式）', 'Heavy Tank (Tiger-type)'],
  howitzer: ['105毫米榴弹炮', '105 mm Howitzer'],
  aa: ['40毫米防空炮（博福斯式）', '40 mm AA (Bofors-type)'],
  supply_truck: ['补给卡车（GMC式）', 'Supply Truck (GMC-type)'],
};
const unitShort: Record<string, [string, string]> = {
  infantry: ['步兵', 'Rifles'], recon: ['侦察', 'Recon'], mg: ['机枪', 'HMG'], engineer: ['工兵', 'Engineers'],
  at_gun: ['反坦克', 'AT gun'], mortar: ['迫击炮', 'Mortar'], light_tank: ['轻坦', 'Light tk'], medium_tank: ['中坦', 'Medium tk'],
  heavy_tank: ['重坦', 'Heavy tk'], howitzer: ['榴弹炮', 'Howitzer'], aa: ['防空', 'AA'], supply_truck: ['补给车', 'Truck'],
};
const weaponNames: Record<string, [string, string]> = {
  rifle: ['步枪火力', 'rifles'], recon_rifle: ['侦察火力', 'carbines'], engineer_rifle: ['工兵火力', 'SMGs'], mg: ['机枪', 'machine gun'],
  coax_mg: ['同轴机枪', 'coax MG'], at_cannon: ['反坦克炮', 'AT gun'], light_cannon: ['轻坦主炮', '37 mm gun'], medium_cannon: ['中坦主炮', '75 mm gun'],
  heavy_cannon: ['重坦主炮', '88 mm gun'], mortar_shell: ['迫击炮弹', 'mortar fire'], howitzer_shell: ['榴弹炮弹', 'howitzer fire'], aa_shell: ['防空炮', 'AA fire'],
  air_strafe: ['空中扫射', 'strafing'], air_bomb: ['航空炸弹', 'bombs'],
};

let current: Lang = loadLang();
const listeners = new Set<() => void>();

function loadLang(): Lang {
  try {
    const v = localStorage.getItem('lwg.lang');
    return v === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function lang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  try {
    localStorage.setItem('lwg.lang', l);
  } catch {
    // storage may be unavailable; language still switches for this session
  }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  const dict = current === 'zh' ? zh : en;
  const raw = dict[key] ?? en[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

export const unitName = (id: string): string => unitNames[id]?.[current === 'zh' ? 0 : 1] ?? id;
export const unitShortName = (id: string): string => unitShort[id]?.[current === 'zh' ? 0 : 1] ?? id;
export const weaponName = (id: string): string => weaponNames[id]?.[current === 'zh' ? 0 : 1] ?? id;
