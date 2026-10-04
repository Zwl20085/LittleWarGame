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
  'setup.timeLimit': '不设时间上限：只有首都被攻占的一方才会被淘汰。',
  'setup.loading': '正在铺设沙盘……',
  'diff.easy': '简单', 'diff.normal': '普通', 'diff.hard': '困难',
  'info.open': '公开沙盘', 'info.fog': '战争迷雾',
  'map.greystone_pinecreek': '灰石市—松溪市（1v1）',
  'map.four_cities': '四城混战（4 方）',
  // top bar
  'hud.p': '兵员', 'hud.m': '军需', 'hud.pop': '人口', 'hud.log': '后勤', 'hud.resolve': '战役意志',
  'hud.perMin': '/分', 'hud.auto': '托管', 'hud.manual': '手动', 'hud.paused': '已暂停', 'hud.simSlow': '模拟负载过高：实际速度低于设定',
  'hud.speed': '速度', 'hud.time': '时间',
  'hud.layers': '图层', 'layer.front': '战线', 'layer.supply': '补给', 'layer.ranges': '射程', 'layer.fronts': '命令',
  'hud.help': '帮助',
  'hud.hideHint': '按 U 恢复界面',
  // fronts
  'front.named': '{place}方面', 'front.numbered': '第 {n} 方面', 'front.none': '—', 'front.commander': '前线指挥官', 'front.noCommander': '指挥官阵亡，{s} 秒后接替',
  'order.auto': '自主', 'order.attack': '突击', 'order.defend': '防御', 'order.fortify': '筑垒防守', 'order.fallBack': '回防', 'order.title': '作战命令', 'order.pick': '【{order}】→ {front}：左键点选地点，或按住拖出一条战线 · 右键 / Esc 取消',
  'order.short.attack': '突击', 'order.short.defend': '防御', 'order.short.fortify': '筑垒', 'order.short.fallBack': '回防', 'order.short.auto': '自主',
  'order.pickAuto': '【自主】→ {front}：在地图上点选，把该方面交还前线指挥官 · Esc 取消', 'order.target': '接令', 'order.nearest': '最近的方面（按落点）', 'order.nearestIs': '{front}（最近）',
  'order.how': '选命令（Z X C V B），再在地图上点选或拖线；点方面卡（1–8）指定接令方面', 'order.howArmed': '点选 = 地点 · 拖动 = 战线 · 按住 Shift 连续下达', 'order.issued': '命令已下达：{front} · {order}',
  'order.autoTip': '由前线指挥官自行选择目标', 'order.attackTip': '夺取指定地点 / 突破指定防线', 'order.defendTip': '在指定防线据守', 'order.fortifyTip': '据守指定防线并由工兵构筑工事', 'order.fallBackTip': '放弃当前阵地，回防至指定防线',
  'reason.order.attack': '奉命突击 {point}', 'reason.order.defend': '奉命防御该线', 'reason.order.fortify': '奉命筑垒据守', 'reason.order.fallBack': '奉命回防该线',
  'status.commanderPost': '前线指挥部', 'status.orderAttack': '奉命突击', 'status.orderMove': '奉命开赴防线', 'status.orderHold': '奉命据守防线', 'status.commanderMove': '指挥部转移', 'status.commanderWithdraw': '指挥部后撤',
  'log.commanderLost': '{point}方面指挥官阵亡！', 'log.commanderAppointed': '统帅部任命新的{point}方面指挥官',
  'front.main': '主攻', 'front.units': '{n} 支部队', 'front.mainTip': '主攻方向：优先获得增援与补给', 'front.cardTip': '点击：指定为接令方面并定位指挥官',
  'front.leaderless': '无指挥官', 'front.plan': '指挥官方案', 'front.order': '命令', 'front.orderSince': '{t} 前 · {who}', 'front.byYou': '你下达', 'front.byHq': '参谋代拟', 'front.gotoObjective': '定位目标',
  'hq.supreme': '最高统帅部', 'brief.stamp': '绝密', 'brief.title': '统帅部简报',
  'brief.body': '你是最高统帅。前线指挥官自行布阵、选择战法、指挥部队；你给每个方面下达一道命令：突击（Z）、防御（X）、筑垒防守（C）、回防（V），或交还自主（B）。选好命令后在地图上点选目标，或按住拖出一条战线。★ 主攻方面优先获得增援。按 N 在地图上新设方面（最多 8 个）；筑垒防守的防线是永备工事，换令不撤。出兵与劳动力在底部和顶部面板。',
  'sel.commanderOf': '前线指挥官 · {front}', 'fail.NO_FRONT': '没有可接令的方面',
  'op.title': '作战方式', 'op.auto': '自动', 'op.frontal': '正面推进', 'op.flank': '侧面迂回', 'op.pincer': '钳形攻势', 'op.infiltrate': '武装渗透', 'op.siege': '筑垒围攻',
  'op.autoTip': '由 AI 依据兵力构成、目标与作战倾向选择作战方式',
  'op.frontalTip': '全线沿战线稳步推进', 'op.flankTip': '机动部队绕至侧翼集结，再从侧面突击；正面部队负责牵制',
  'op.pincerTip': '左右两翼分别迂回，同时夹击同一目标', 'op.infiltrateTip': '小股步兵从敌线薄弱处渗透，直取目标',
  'op.siegeTip': '在城外挖掘堑壕、包围并消耗守军，削弱后再总攻',
  'phase.form': '集结', 'phase.move': '机动', 'phase.assault': '突击', 'phase.dig': '构筑工事',
  'status.maneuver': '迂回机动', 'status.infiltrating': '渗透敌后', 'status.digging': '挖掘堑壕', 'status.siegeLine': '据守围城阵地', 'status.fortifying': '构筑沙袋工事',
  'log.opFlank': '{n} 支部队开始侧面迂回，目标 {point}', 'log.opPincer': '{n} 支部队展开钳形攻势，合围 {point}', 'log.opInfiltrate': '{n} 支小队渗透敌线，直取 {point}',
  'log.opSiege': '开始围攻 {point}：构筑堑壕', 'log.opSiegeAssault': '{point} 守军已被削弱，发起总攻',
  'hq.defend': '守备', 'hq.attack': '进攻', 'hq.home': '首都受威胁', 'hq.homeEta': '{eta} 秒', 'hq.homeGroups': '{n} 个集团军回防', 'hq.occupy': '占领', 'hq.goto': '点击定位',
  'posture.cautious': '谨慎推进', 'posture.assault': '强攻', 'posture.hold': '固守', 'posture.fortify': '筑垒', 'posture.withdraw': '撤收',
  'reason.capturePoint': '争夺 {point}', 'reason.defendCity': '城市遇袭，回防', 'reason.homeDefence': '回防首都（敌约 {enemy}，我 {mine}，{eta} 秒后接敌）', 'reason.assaultCity': '进攻 {city}',
  'reason.outmatched': '敌强我弱，集结待援', 'reason.waitGroup': '等待集结（步兵 {n}/{need}）', 'reason.playerTarget': '玩家指定目标',
  // production
  'prod.title': '出兵配置', 'prod.weight': '支出权重', 'prod.cap': '数量上限', 'prod.pause': '暂停', 'prod.resume': '恢复',
  'prod.addOne': '加一支', 'prod.queue': '生产队列',
  'prod.unlockIn': '{s} 秒后解锁', 'prod.cost': '成本', 'prod.count': '在场/上限', 'prod.cancel': '取消（返还 50%）',
  'prod.preset': '预设', 'preset.balanced': '均衡推进', 'preset.armor': '装甲突破', 'preset.infantry': '步兵筑垒', 'preset.artillery': '炮兵消耗', 'preset.mechanized': '机动优先', 'setup.doctrine': '我方作战倾向',
  'doctrine.balanced': '均衡：步、炮、坦协同，按战况选择作战方式。', 'doctrine.infantry': '步兵优先：大量步兵与机枪，擅长筑垒与武装渗透。',
  'doctrine.armor': '装甲优先：以坦克为矛头，偏好侧面迂回与钳形攻势。', 'doctrine.mechanized': '机动优先：摩托化步兵与轻坦，快速迂回、抢占据点。',
  'doctrine.artillery': '炮兵优先：火力准备充分，偏好正面推进与围攻。',
  'block.LOCKED': '未解锁', 'block.CAP': '已达上限', 'block.POP_FULL': '人口已满', 'block.INSUFFICIENT_P': '缺兵员',
  'block.INSUFFICIENT_M': '缺军需', 'block.PROTECTED': '资源为高价订单预留', 'block.NO_SLOT': '等待生产位',
  'prod.building': '生产中 {p}%', 'prod.blocked': '等待出口', 'prod.protecting': '为 {unit} 预留军需',
  // economy
  'eco.title': '城市劳动力', 'eco.mobil': '动员', 'eco.industry': '工业', 'eco.logistics': '后勤', 'eco.lock': '锁定',
  'eco.reset': '还原均衡', 'eco.autoOn': '托管开启', 'eco.autoOff': '手动分配', 'eco.buildMul': '生产工时 ×{v}',
  'steward.default': '托管：维持当前分配', 'steward.shiftP': '托管：兵员需求上升，动员调至 {to}%',
  'steward.shiftI': '托管：军需订单增加，工业调至 {to}%', 'steward.shiftL': '托管：补给不足，后勤调至 {to}%',
  // selection
  'sel.hp': '兵力', 'sel.morale': '士气', 'sel.supp': '压制', 'sel.ammo': '弹药', 'sel.supply': '补给',
  'sel.mode': '控制', 'sel.auto': '自动', 'sel.manual': '手动覆盖', 'sel.front': '所属方面', 'sel.status': '状态',
  'sel.multi': '已选 {n} 支部队', 'sel.lowestMorale': '最低士气', 'sel.unsupplied': '缺补给',
  'sel.enemy': '敌方（仅可查看）', 'sel.setup.set': '已架设', 'sel.setup.packed': '收起', 'sel.setup.setting': '架设中', 'sel.setup.packing': '收起中',
  'cmd.move': '移动', 'cmd.moveHold': '移动并固守', 'cmd.attackMove': '攻击移动 (A)', 'cmd.hold': '固守 (H)', 'cmd.retreat': '撤退 (R)', 'cmd.resume': '恢复自动 (G)',
  'cmd.hint': '部队平时听从前线指挥官，执行统帅部命令 · 右键地面：移动，到达后归建 · 右键敌人：集火',
  'cmd.pickAttack': '左键选择攻击移动目的地',
  'fail.UNREACHABLE': '目标无法到达', 'fail.STALE_TARGET': '目标情报已过期', 'fail.ROUTING': '溃退部队无法执行', 'fail.LOCKED': '尚未解锁',
  'fail.INSUFFICIENT_M': '军需不足', 'fail.INSUFFICIENT_P': '兵员不足', 'fail.NOT_OWNER': '无法指挥该部队', 'fail.OUT_OF_BOUNDS': '超出地图',
  'fail.BAD_VALUE': '数值无效', 'fail.FACTION_DEAD': '阵营已淘汰', 'fail.NO_ORDER': '无可取消项',
  // 2.1: new / disband fronts, fortified zones, binding orders
  'order.stampManual': '奉命 · {order}', 'order.stampAuto': '自主', 'order.stampStaff': '自主 · {order}',
  'front.new': '新设方面', 'front.newTip': '在地图上点选一处开设新方面（任命前线指挥官 {p} 兵员，附近 350 米内的部队就地编入）', 'front.newPick': '【新设方面】左键点选方面驻地 · 右键 / Esc 取消',
  'front.countTip': '方面数 / 上限', 'front.troopsTip': '部队数',
  'front.inPosition': '到位', 'front.inPositionTip': '已抵达命令指定防线（或地点）80 米内的部队 / 该方面全部部队',
  'front.disband': '撤销方面', 'front.disbandConfirm': '再点一次确认撤销', 'front.disbandTip': '撤销该方面：部队与筑垒地域移交最近的方面（需连点两次）', 'front.disbanded': '统帅部撤销 {front}',
  'fail.frontLimit': '方面数量已达上限（{n}）', 'fail.frontNoP': '兵员不足：任命前线指挥官需 {n} 兵员',
  'zone.title': '筑垒地域', 'zone.mapLabel': '筑垒地域 #{n}', 'zone.unheld': '无方面驻守', 'zone.works': '{n}/{of}', 'zone.building': '+{n}在建',
  'zone.worksTip': '工事：已建成 / 计划（堑壕、炮楼、堡垒），+在建', 'zone.cancel': '取消', 'zone.cancelTip': '停止该筑垒地域施工（已建成的工事保留）',
  // statuses
  'status.noArc': '无可行弹道', 'status.unreachable': '目标无法到达', 'status.routing': '溃退中', 'status.retreat': '撤退中',
  'status.recovering': '休整补员', 'status.withdraw': '撤收', 'status.rally': '集结中', 'status.suppressed': '被压制，伏低',
  'status.engaging': '交战中', 'status.holding': '据守', 'status.assaultCity': '进攻城市', 'status.advancing': '推进中',
  'status.firing': '射击', 'status.positioning': '转移阵位', 'status.covering': '架设警戒', 'status.settingUp': '架设中',
  'status.observing': '前沿观察', 'status.noBudget': '缺工程预算', 'status.building': '施工中', 'status.buildingPillbox': '修筑炮楼', 'status.buildingBunker': '修筑堡垒', 'status.garrisoned': '据守工事', 'status.enteringStructure': '进入工事驻防', 'status.supplying': '中继补给',
  'status.manualMove': '手动：移动', 'status.manualAttackMove': '手动：攻击移动', 'status.manualFocus': '手动：集火',
  'status.spearhead': '突破纵深', 'status.bridging': '架设浮桥', 'status.relocating': '炮兵转移阵地', 'status.huntRaiders': '清剿后方渗透之敌', 'status.rearGuard': '警戒补给线', 'status.garrison': '奉命守备城镇', 'status.homeGuard': '首都警卫', 'status.fallingBack': '有序后撤，回防首都', 'status.occupy': '奉命占领城镇', 'status.toDepot': '返回补给站', 'status.loading': '装载弹药', 'status.convoyOut': '运送补给', 'status.unloading': '分发弹药', 'status.convoyBack': '空车返回', 'status.raiding': '袭击敌补给线', 'status.escort': '掩护补给车',
  'status.manualRetreat': '手动：撤退', 'status.manualHold': '手动：固守',
  'morale.normal': '正常', 'morale.suppressed': '受压制', 'morale.pinned': '钉住', 'morale.routing': '溃退', 'morale.wavering': '动摇',
  // logs
  'log.unitLost': '损失 {unit}（{weapon}）', 'log.routing': '{unit} 士气崩溃', 'log.unitRouting': '{unit} 溃退',
  'log.pointTaken': '占领 {point}', 'log.pointLost': '失去 {point}', 'log.hqUnderAttack': '指挥部遭敌步兵占领！',
  'log.overflow': '资源已达上限，溢出部分丢弃', 'log.eliminated': '{f} 被淘汰（{reason}）',
  'log.resumeAuto': '{unit} 恢复自动任务',
  'log.unreachable': '{unit} 目标无法到达，已恢复自动',
  'log.convoyThreat': '补给车队遭遇敌军，掉头返回', 'log.spearhead': '组织 {n} 支部队突破敌线，直取 {point}', 'log.raidLaunched': '{n} 支部队渗透敌后，袭击补给线', 'log.bridgeStarted': '工兵开始架设浮桥', 'log.reservesShifted': '抽调 {n} 支部队增援吃紧的战区', 'log.bridgeBuilt': '浮桥架设完成', 'log.pillboxBuilt': '工兵建成一座炮楼', 'log.bunkerBuilt': '工兵建成一座堡垒', 'log.structureLost': '炮楼/堡垒被摧毁，守军被迫撤出', 'log.capitalLine': '统帅部：工兵开始修筑首都防线（堑壕与炮楼）', 'log.engineersRequested': '统帅部：工事待工，补充工兵 ×{n}', 'log.hqDefend': '统帅部：抽调 {n} 支部队守备 {point}', 'log.homeThreat': '首都受威胁！敌军约 {enemy}，预计 {eta} 秒后抵达', 'log.homeDefence': '统帅部：回防首都，调回 {groups} 个集团军、{n} 支警卫部队（敌约 {enemy}）', 'log.homeFortify': '统帅部：敌军将至，在首都外围构筑堑壕与沙袋工事', 'log.homeSafe': '首都威胁解除，各集团军恢复原任务', 'log.hqOccupy': '统帅部：派 {n} 支部队占领 {point}', 'log.frontOpened': '统帅部开设 {point} 方面', 'log.zonePlanned': '统帅部批准 {point} 方面筑垒地域（永备工事）', 'log.frontMerged': '{point} 方面并入 {into} 方面', 'log.frontFallBack': '统帅部：{point} 方面回防', 'log.counterStrike': '统帅部：敌军倾巢而出，反击 {point}', 'log.raid': '{unit} 出击袭扰敌补给线',
  'log.protect': '为 {unit} 预留资源', 'log.protectExpired': '{unit} 资源预留到期', 'log.exitBlocked': '城市出口拥堵，等待出场', 'log.capitalBesieged': '首都被围，新部队无法出城',
  'reason.resolve': '战役意志耗尽', 'reason.hq': '指挥部失守',
  // results
  'res.victory': '胜利', 'res.defeat': '战败', 'res.draw': '共同毁灭', 'res.timeout': '时间到 · 裁定',
  'res.winner': '胜者：{f}', 'res.duration': '时长', 'res.produced': '出兵', 'res.lost': '损失', 'res.spent': '支出', 'res.resolve': '剩余意志',
  'res.again': '再来一局', 'res.menu': '回主界面', 'res.spectate': '继续观战', 'res.eliminatedSpectate': '你已被淘汰，可继续观战',
  'menu.title': '暂停', 'menu.resume': '继续', 'menu.quit': '退出到主界面', 'menu.settings': '设置',
  'set.smoke': '烟雾强度', 'set.shake': '镜头震动', 'set.uiScale': '界面缩放', 'set.elev': '俯角',
  'set.quality': '画质', 'quality.auto': '自动', 'quality.high': '高', 'quality.medium': '中', 'quality.low': '低',
  'hud.qualityLowered': '帧率偏低，已自动降低画质（可在菜单中更改）',
  'help.body': '最高统帅部：Z 突击 · X 防御 · C 筑垒防守 · V 回防 · B 交还自主 → 地图上左键点选地点，或按住拖出战线（Shift 连续下达） · 1–8 / 点方面卡：指定接令方面 · ★ 主攻\n方面：N 新设方面（地图点选，最多 8 个）· 展开方面卡 → 撤销方面（连点两次）· 命令为强约束：方面卡盖“奉命”章，“到位”显示部队抵达情况\n筑垒地域：C 筑垒防守的每条防线都是永备工事，换令不撤；统帅部卡“筑垒地域”列出进度，可取消\n部队（可选）：左键/拖框选择 · 右键移动/集火 · A 攻击移动 · H 固守 · R 撤退 · G 归建\n镜头：WASD/中键 平移 · Q/E 旋转 · 滚轮 缩放 · PgUp/PgDn 俯角 · Tab 总览 · F 跟随 · Space 暂停 · U 隐藏界面 · Esc 取消/菜单',
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
  'terr.height': '高度', 'terr.slope': '坡度', 'terr.cover': '掩护', 'cover.0': '无', 'cover.1': '轻度', 'cover.2': '重度', 'cover.3': '建筑（可驻守）',
  'terr.near': '附近', 'terr.impassable': '不可通行', 'terr.slow': '减速', 'terr.fast': '快速',
  'feat.mountain': '山', 'feat.hill': '丘陵', 'feat.river': '河流', 'feat.lake': '湖', 'feat.forest': '林', 'feat.town': '镇',
  'feat.city': '城市', 'feat.pass': '山口', 'feat.bridge': '桥', 'feat.ford': '渡口',
  'reason.crossAt': '在{feature}渡河（{kind}）', 'reason.holdRiver': '依托{feature}河线固守', 'reason.holdHigh': '占据{feature}高地', 'reason.holdLine': '在{feature}一线固守', 'reason.holdFront': '在{feature}前线固守', 'reason.pushFront': '向{point}推进战线', 'reason.bridging': '工兵架设浮桥中', 'feat.here': '前沿',
  'prod.unlockShort': '{s}秒解锁',
  'hud.sides': '各方意志', 'hud.territory': '各方据点', 'res.held': '持有据点', 'hud.speedTip': '模拟速度', 'hud.pauseTip': '暂停 / 继续（Space）', 'hud.logiTip': '后勤满足度：供给能力 / 需求', 'hud.resolveTip': '战役意志：归零即淘汰',
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
  'setup.timeLimit': 'No time limit: a side is defeated only when its capital is captured.',
  'setup.loading': 'Laying out the diorama…',
  'diff.easy': 'Easy', 'diff.normal': 'Normal', 'diff.hard': 'Hard',
  'info.open': 'Open table', 'info.fog': 'Fog of war',
  'map.greystone_pinecreek': 'Greystone – Pinecreek (1v1)',
  'map.four_cities': 'Four Cities (4-way FFA)',
  'hud.p': 'Manpower', 'hud.m': 'Munitions', 'hud.pop': 'Pop', 'hud.log': 'Logistics', 'hud.resolve': 'Resolve',
  'hud.perMin': '/min', 'hud.auto': 'Auto', 'hud.manual': 'Manual', 'hud.paused': 'PAUSED', 'hud.simSlow': 'Simulation overloaded — running below set speed',
  'hud.speed': 'Speed', 'hud.time': 'Time',
  'hud.layers': 'Layers', 'layer.front': 'Front', 'layer.supply': 'Supply', 'layer.ranges': 'Range', 'layer.fronts': 'Orders',
  'hud.help': 'Help',
  'hud.hideHint': 'Press U to restore HUD',
  'front.named': '{place} Front', 'front.numbered': 'Front {n}', 'front.none': '—', 'front.commander': 'Front commander', 'front.noCommander': 'Commander lost; replacement in {s} s',
  'order.auto': 'Auto', 'order.attack': 'Attack', 'order.defend': 'Defend', 'order.fortify': 'Fortify', 'order.fallBack': 'Fall back', 'order.title': 'Field orders', 'order.pick': '{order} → {front}: click a place, or drag a line · RMB / Esc cancels',
  'order.short.attack': 'Attack', 'order.short.defend': 'Defend', 'order.short.fortify': 'Fortify', 'order.short.fallBack': 'Fall back', 'order.short.auto': 'Auto',
  'order.pickAuto': 'Auto → {front}: click the map to hand the front back to its commander · Esc cancels', 'order.target': 'To', 'order.nearest': 'nearest front (where you click)', 'order.nearestIs': '{front} (nearest)',
  'order.how': 'Pick an order (Z X C V B), then click or drag on the map; click a front card (1–8) to choose who gets it', 'order.howArmed': 'Click = place · Drag = line · hold Shift to keep issuing', 'order.issued': 'Order received: {front} · {order}',
  'order.autoTip': 'The front commander chooses its own objective', 'order.attackTip': 'Take the place / break the line', 'order.defendTip': 'Hold the line', 'order.fortifyTip': 'Hold the line and have engineers fortify it', 'order.fallBackTip': 'Give up the current ground and defend this line',
  'reason.order.attack': 'Ordered to attack {point}', 'reason.order.defend': 'Ordered to defend the line', 'reason.order.fortify': 'Ordered to fortify and hold', 'reason.order.fallBack': 'Ordered to fall back to the line',
  'status.commanderPost': 'Front HQ', 'status.orderAttack': 'Attacking as ordered', 'status.orderMove': 'Moving to the ordered line', 'status.orderHold': 'Holding the ordered line', 'status.commanderMove': 'HQ relocating', 'status.commanderWithdraw': 'HQ withdrawing',
  'log.commanderLost': 'Commander of the {point} Front killed!', 'log.commanderAppointed': 'Supreme HQ appoints a new commander for the {point} Front',
  'front.main': 'Main effort', 'front.units': '{n} units', 'front.mainTip': 'Main effort: first call on reinforcements and supply', 'front.cardTip': 'Click: give orders to this front and locate its commander',
  'front.leaderless': 'Leaderless', 'front.plan': "Commander's plan", 'front.order': 'Order', 'front.orderSince': '{t} ago · {who}', 'front.byYou': 'by you', 'front.byHq': 'by staff', 'front.gotoObjective': 'Locate objective',
  'hq.supreme': 'Supreme HQ', 'brief.stamp': 'Secret', 'brief.title': 'Supreme HQ briefing',
  'brief.body': 'You are the supreme HQ. Front commanders deploy, choose the battle plan and lead the troops; you give each front one order: Attack (Z), Defend (X), Fortify (C), Fall back (V) or hand it back (Auto, B). Pick an order, then click a target on the map or drag a line. The ★ main effort gets reinforcements first. Press N to open a new front on the map (up to 8); a Fortify line is a permanent fortified zone that outlives later orders. Production and labour live in the bottom and top panels.',
  'sel.commanderOf': 'Front commander · {front}', 'fail.NO_FRONT': 'No front to take the order',
  'op.title': 'Battle plan', 'op.auto': 'Auto', 'op.frontal': 'Frontal push', 'op.flank': 'Flank', 'op.pincer': 'Pincer', 'op.infiltrate': 'Infiltrate', 'op.siege': 'Siege',
  'op.autoTip': 'Let the AI choose from force mix, target and doctrine',
  'op.frontalTip': 'Advance steadily along the whole front', 'op.flankTip': 'Mobile troops swing round to a flank, form up and strike from the side while the line pins the enemy',
  'op.pincerTip': 'Both wings swing round and strike the same target together', 'op.infiltrateTip': 'Small infantry teams slip through a weak stretch of the line to seize the objective',
  'op.siegeTip': 'Ring the town with trenches, wear the garrison down, then storm it',
  'phase.form': 'forming up', 'phase.move': 'moving', 'phase.assault': 'assault', 'phase.dig': 'digging in',
  'status.maneuver': 'Flanking manoeuvre', 'status.infiltrating': 'Infiltrating', 'status.digging': 'Digging trenches', 'status.siegeLine': 'Holding the siege lines', 'status.fortifying': 'Building sandbag works',
  'log.opFlank': '{n} units swing round to flank {point}', 'log.opPincer': '{n} units close a pincer on {point}', 'log.opInfiltrate': '{n} teams infiltrate toward {point}',
  'log.opSiege': 'Siege of {point}: digging in', 'log.opSiegeAssault': '{point} garrison worn down — general assault',
  'hq.defend': 'Defend', 'hq.attack': 'Attack', 'hq.home': 'Capital threatened', 'hq.homeEta': '{eta} s', 'hq.homeGroups': '{n} groups recalled', 'hq.occupy': 'Occupy', 'hq.goto': 'Click to locate',
  'posture.cautious': 'Cautious', 'posture.assault': 'Assault', 'posture.hold': 'Hold', 'posture.fortify': 'Fortify', 'posture.withdraw': 'Withdraw',
  'reason.capturePoint': 'Contesting {point}', 'reason.defendCity': 'City under attack — falling back', 'reason.homeDefence': 'Falling back to the capital (enemy ≈{enemy}, ours {mine}, contact in {eta} s)', 'reason.assaultCity': 'Attacking {city}',
  'reason.outmatched': 'Outmatched — massing first', 'reason.waitGroup': 'Gathering (infantry {n}/{need})', 'reason.playerTarget': 'Player-set target',
  'prod.title': 'Force Plan', 'prod.weight': 'Spend weight', 'prod.cap': 'Max count', 'prod.pause': 'Pause', 'prod.resume': 'Resume',
  'prod.addOne': 'Add one', 'prod.queue': 'Production',
  'prod.unlockIn': 'Unlocks in {s}s', 'prod.cost': 'Cost', 'prod.count': 'Field/cap', 'prod.cancel': 'Cancel (50% refund)',
  'prod.preset': 'Preset', 'preset.balanced': 'Balanced push', 'preset.armor': 'Armoured thrust', 'preset.infantry': 'Infantry & works', 'preset.artillery': 'Artillery attrition', 'preset.mechanized': 'Mechanized speed', 'setup.doctrine': 'Your doctrine',
  'doctrine.balanced': 'Balanced: rifles, guns and tanks together; the plan fits the situation.', 'doctrine.infantry': 'Infantry first: masses of rifles and MGs; good at digging in and infiltration.',
  'doctrine.armor': 'Armour first: tanks lead; prefers flanking and pincers.', 'doctrine.mechanized': 'Mechanized: motorized rifles and light tanks; fast envelopments, quick captures.',
  'doctrine.artillery': 'Artillery first: heavy fire preparation; prefers frontal pushes and sieges.',
  'block.LOCKED': 'Locked', 'block.CAP': 'At cap', 'block.POP_FULL': 'Population full', 'block.INSUFFICIENT_P': 'Need manpower',
  'block.INSUFFICIENT_M': 'Need munitions', 'block.PROTECTED': 'Reserved for priority order', 'block.NO_SLOT': 'Waiting for slot',
  'prod.building': 'Building {p}%', 'prod.blocked': 'Waiting for exit', 'prod.protecting': 'Reserving for {unit}',
  'eco.title': 'City Labour', 'eco.mobil': 'Mobilise', 'eco.industry': 'Industry', 'eco.logistics': 'Logistics', 'eco.lock': 'Lock',
  'eco.reset': 'Reset balance', 'eco.autoOn': 'Steward on', 'eco.autoOff': 'Manual', 'eco.buildMul': 'Build time ×{v}',
  'steward.default': 'Steward: holding allocation', 'steward.shiftP': 'Steward: manpower demand up, mobilise → {to}%',
  'steward.shiftI': 'Steward: munitions orders up, industry → {to}%', 'steward.shiftL': 'Steward: supply short, logistics → {to}%',
  'sel.hp': 'Strength', 'sel.morale': 'Morale', 'sel.supp': 'Suppression', 'sel.ammo': 'Ammo', 'sel.supply': 'Supply',
  'sel.mode': 'Control', 'sel.auto': 'Auto', 'sel.manual': 'Manual override', 'sel.front': 'Front', 'sel.status': 'Status',
  'sel.multi': '{n} units selected', 'sel.lowestMorale': 'Lowest morale', 'sel.unsupplied': 'Unsupplied',
  'sel.enemy': 'Enemy (view only)', 'sel.setup.set': 'Deployed', 'sel.setup.packed': 'Packed', 'sel.setup.setting': 'Deploying', 'sel.setup.packing': 'Packing',
  'cmd.move': 'Move', 'cmd.moveHold': 'Move & hold', 'cmd.attackMove': 'Attack-move (A)', 'cmd.hold': 'Hold (H)', 'cmd.retreat': 'Retreat (R)', 'cmd.resume': 'Resume auto (G)',
  'cmd.hint': 'Units normally follow their front commander, who carries out your orders · Right-click ground: move, then rejoin · Right-click enemy: focus fire',
  'cmd.pickAttack': 'Left-click attack-move destination',
  'fail.UNREACHABLE': 'Destination unreachable', 'fail.STALE_TARGET': 'Target intel is stale', 'fail.ROUTING': 'Routing units cannot comply', 'fail.LOCKED': 'Not unlocked yet',
  'fail.INSUFFICIENT_M': 'Not enough munitions', 'fail.INSUFFICIENT_P': 'Not enough manpower', 'fail.NOT_OWNER': 'Cannot command that unit', 'fail.OUT_OF_BOUNDS': 'Outside the map',
  'fail.BAD_VALUE': 'Invalid value', 'fail.FACTION_DEAD': 'Faction eliminated', 'fail.NO_ORDER': 'Nothing to cancel',
  // 2.1: new / disband fronts, fortified zones, binding orders
  'order.stampManual': 'Ordered · {order}', 'order.stampAuto': 'Own', 'order.stampStaff': 'Own · {order}',
  'front.new': 'New front', 'front.newTip': 'Click the map to open a new front there (appoints a commander for {p} P; troops within 350 m join it)', 'front.newPick': 'New front: click where it stands · RMB / Esc cancels',
  'front.countTip': 'Fronts / limit', 'front.troopsTip': 'Units',
  'front.inPosition': 'In position', 'front.inPositionTip': 'Units within 80 m of the ordered line (or place) / all units of this front',
  'front.disband': 'Disband', 'front.disbandConfirm': 'Click again to disband', 'front.disbandTip': 'Disband this front: its troops and fortified zones go to the nearest front (two clicks)', 'front.disbanded': 'Supreme HQ disbands the {front}',
  'fail.frontLimit': 'Front limit reached ({n})', 'fail.frontNoP': 'Not enough manpower: a front commander costs {n} P',
  'zone.title': 'Fortified zones', 'zone.mapLabel': 'Fortified zone #{n}', 'zone.unheld': 'unheld', 'zone.works': '{n}/{of}', 'zone.building': '+{n} bldg',
  'zone.worksTip': 'Works finished / planned (trenches, pillboxes, bunkers), + under construction', 'zone.cancel': 'Cancel', 'zone.cancelTip': 'Stop work on this fortified zone (finished works remain)',
  'status.noArc': 'No firing solution', 'status.unreachable': 'Destination unreachable', 'status.routing': 'Routing', 'status.retreat': 'Retreating',
  'status.recovering': 'Refitting', 'status.withdraw': 'Withdrawing', 'status.rally': 'Rallying', 'status.suppressed': 'Suppressed — going to ground',
  'status.engaging': 'Engaging', 'status.holding': 'Holding', 'status.assaultCity': 'Assaulting city', 'status.advancing': 'Advancing',
  'status.firing': 'Firing', 'status.positioning': 'Repositioning', 'status.covering': 'Deployed, covering', 'status.settingUp': 'Deploying',
  'status.observing': 'Forward observing', 'status.noBudget': 'No works budget', 'status.building': 'Building', 'status.buildingPillbox': 'Building a pillbox', 'status.buildingBunker': 'Building a bunker', 'status.garrisoned': 'Manning a strongpoint', 'status.enteringStructure': 'Moving into a strongpoint', 'status.supplying': 'Relaying supply',
  'status.manualMove': 'Manual: move', 'status.manualAttackMove': 'Manual: attack-move', 'status.manualFocus': 'Manual: focus fire',
  'status.spearhead': 'Spearhead: breaking through', 'status.bridging': 'Building a pontoon bridge', 'status.relocating': 'Battery relocating', 'status.huntRaiders': 'Hunting raiders in the rear', 'status.rearGuard': 'Guarding supply route', 'status.garrison': 'Garrisoning a town (HQ order)', 'status.homeGuard': 'Guarding the capital', 'status.fallingBack': 'Falling back to the capital in good order', 'status.occupy': 'Occupying a town (HQ order)', 'status.toDepot': 'To depot', 'status.loading': 'Loading ammunition', 'status.convoyOut': 'Convoy en route', 'status.unloading': 'Issuing ammunition', 'status.convoyBack': 'Returning empty', 'status.raiding': 'Raiding enemy supply', 'status.escort': 'Protecting convoy',
  'status.manualRetreat': 'Manual: retreat', 'status.manualHold': 'Manual: hold',
  'morale.normal': 'Steady', 'morale.suppressed': 'Suppressed', 'morale.pinned': 'Pinned', 'morale.routing': 'Routing', 'morale.wavering': 'Wavering',
  'log.unitLost': 'Lost {unit} ({weapon})', 'log.routing': '{unit} morale broke', 'log.unitRouting': '{unit} routing',
  'log.pointTaken': 'Captured {point}', 'log.pointLost': 'Lost {point}', 'log.hqUnderAttack': 'Enemy infantry are taking our HQ!',
  'log.overflow': 'Stockpile full — overflow discarded', 'log.eliminated': '{f} eliminated ({reason})',
  'log.resumeAuto': '{unit} resumed automatic tasks',
  'log.unreachable': '{unit}: destination unreachable, back to auto',
  'log.convoyThreat': 'Convoy ran into the enemy and turned back', 'log.spearhead': '{n} units break through toward {point}', 'log.raidLaunched': '{n} units infiltrate to raid enemy supply', 'log.bridgeStarted': 'Engineers started a pontoon bridge', 'log.reservesShifted': '{n} units shifted to a hard-pressed front', 'log.bridgeBuilt': 'Pontoon bridge completed', 'log.pillboxBuilt': 'Engineers completed a pillbox', 'log.bunkerBuilt': 'Engineers completed a bunker', 'log.structureLost': 'A pillbox / bunker was destroyed; its garrison was thrown out', 'log.capitalLine': 'High command: engineers begin the capital defence line (trenches and pillboxes)', 'log.engineersRequested': 'Supreme HQ: works are waiting — {n} engineer(s) queued', 'log.hqDefend': 'High command: {n} units sent to hold {point}', 'log.homeThreat': 'Capital threatened! ≈{enemy} enemy strength, arriving in about {eta} s', 'log.homeDefence': 'High command: {groups} army group(s) and {n} guard units recalled to the capital (enemy ≈{enemy})', 'log.homeFortify': 'High command: attack expected, digging trenches and sandbags around the capital', 'log.homeSafe': 'Threat to the capital has passed; army groups resume their orders', 'log.hqOccupy': 'High command: {n} units sent to occupy {point}', 'log.frontOpened': 'Supreme HQ opens the {point} Front', 'log.zonePlanned': 'Supreme HQ approves a fortified zone (permanent works) on the {point} Front', 'log.frontMerged': '{point} Front merged into the {into} Front', 'log.frontFallBack': 'Supreme HQ: {point} Front falls back', 'log.counterStrike': 'Supreme HQ: the enemy has committed everything — counter-strike on {point}', 'log.raid': '{unit} sent to raid enemy supply',
  'log.protect': 'Reserving resources for {unit}', 'log.protectExpired': 'Reservation for {unit} expired', 'log.exitBlocked': 'City exit congested, units waiting', 'log.capitalBesieged': 'Capital besieged: no units can roll out',
  'reason.resolve': 'resolve exhausted', 'reason.hq': 'HQ captured',
  'res.victory': 'Victory', 'res.defeat': 'Defeat', 'res.draw': 'Mutual destruction', 'res.timeout': 'Time limit · decision',
  'res.winner': 'Winner: {f}', 'res.duration': 'Duration', 'res.produced': 'Produced', 'res.lost': 'Lost', 'res.spent': 'Spent', 'res.resolve': 'Resolve left',
  'res.again': 'Play again', 'res.menu': 'Main menu', 'res.spectate': 'Keep watching', 'res.eliminatedSpectate': 'You were eliminated — you may keep watching',
  'menu.title': 'Paused', 'menu.resume': 'Resume', 'menu.quit': 'Quit to menu', 'menu.settings': 'Settings',
  'set.smoke': 'Smoke density', 'set.shake': 'Camera shake', 'set.uiScale': 'UI scale', 'set.elev': 'Elevation',
  'set.quality': 'Graphics quality', 'quality.auto': 'Auto', 'quality.high': 'High', 'quality.medium': 'Medium', 'quality.low': 'Low',
  'hud.qualityLowered': 'Low frame rate: graphics quality lowered automatically (change it in the menu)',
  'help.body': 'Supreme HQ: Z attack · X defend · C fortify · V fall back · B auto → click a place on the map, or drag a line (Shift keeps issuing) · 1–8 / front card: choose the front · ★ main effort\nFronts: N new front (click the map, up to 8) · expanded card → Disband (two clicks) · orders bind: the card is stamped "Ordered", "In position" shows the troops arriving\nFortified zones: every Fortify (C) line is a permanent project that survives new orders; the Supreme HQ card lists their progress and can cancel one\nUnits (optional): LMB/drag select · RMB move/focus · A attack-move · H hold · R retreat · G rejoin\nCamera: WASD/MMB pan · Q/E rotate · Wheel zoom · PgUp/PgDn tilt · Tab overview · F follow · Space pause · U hide HUD · Esc cancel/menu',
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
  'tip.weapon': 'Main weapon', 'tip.vision': 'Vision', 'tip.setup': 'Setup', 'tip.click': 'Click: weight, cap, front and add one',
  'layer.terrain': 'Terrain', 'terr.title': 'Ground',
  'ground.0': 'Open ground', 'ground.1': 'Road', 'ground.2': 'Woods', 'ground.3': 'Town', 'ground.4': 'Mud', 'ground.5': 'Deep water', 'ground.6': 'Ford',
  'terr.height': 'Height', 'terr.slope': 'Slope', 'terr.cover': 'Cover', 'cover.0': 'None', 'cover.1': 'Light', 'cover.2': 'Heavy', 'cover.3': 'Building (garrison)',
  'terr.near': 'Near', 'terr.impassable': 'Impassable', 'terr.slow': 'Slow going', 'terr.fast': 'Fast going',
  'feat.mountain': 'Mt.', 'feat.hill': 'Hill', 'feat.river': 'River', 'feat.lake': 'Lake', 'feat.forest': 'Woods', 'feat.town': 'Town',
  'feat.city': 'City', 'feat.pass': 'Pass', 'feat.bridge': 'Bridge', 'feat.ford': 'Ford',
  'reason.crossAt': 'Crossing at {feature} ({kind})', 'reason.holdRiver': 'Holding the river line at {feature}', 'reason.holdHigh': 'Holding high ground at {feature}', 'reason.holdLine': 'Holding the line near {feature}', 'reason.holdFront': 'Holding the front near {feature}', 'reason.pushFront': 'Pushing the front toward {point}', 'reason.bridging': 'Engineers bridging the river', 'feat.here': 'the front',
  'prod.unlockShort': 'Unlock {s}s',
  'hud.sides': 'All sides', 'hud.territory': 'Territory', 'res.held': 'Settlements', 'hud.speedTip': 'Simulation speed', 'hud.pauseTip': 'Pause / resume (Space)', 'hud.logiTip': 'Logistics: supply capacity / demand', 'hud.resolveTip': 'Resolve: a side at zero is eliminated',
};

/** Historical-flavour equipment names (fictional factions; user-approved naming). */
const unitNames: Record<string, [string, string]> = {
  infantry: ['步枪班', 'Rifle Squad'],
  recon: ['侦察班', 'Recon Section'],
  mg: ['重机枪组（维克斯式）', 'HMG Team (Vickers-type)'],
  engineer: ['突击工兵班', 'Assault Engineers'],
  motor_inf: ['摩托化步兵班（卡车载运）', 'Motorized Rifles (truck-borne)'],
  at_gun: ['反坦克炮（6磅式）', 'AT Gun (6-pdr type)'],
  mortar: ['81毫米迫击炮', '81 mm Mortar'],
  light_tank: ['轻型坦克（斯图亚特式）', 'Light Tank (Stuart-type)'],
  medium_tank: ['中型坦克（谢尔曼式）', 'Medium Tank (Sherman-type)'],
  heavy_tank: ['重型坦克（虎式）', 'Heavy Tank (Tiger-type)'],
  howitzer: ['105毫米榴弹炮', '105 mm Howitzer'],
  supply_truck: ['补给卡车（GMC式）', 'Supply Truck (GMC-type)'],
  commander: ['前线指挥官', 'Front Commander'],
};
const unitShort: Record<string, [string, string]> = {
  infantry: ['步兵', 'Rifles'], recon: ['侦察', 'Recon'], mg: ['机枪', 'HMG'], engineer: ['工兵', 'Engineers'], motor_inf: ['摩步', 'Motor rifles'],
  at_gun: ['反坦克', 'AT gun'], mortar: ['迫击炮', 'Mortar'], light_tank: ['轻坦', 'Light tk'], medium_tank: ['中坦', 'Medium tk'],
  heavy_tank: ['重坦', 'Heavy tk'], howitzer: ['榴弹炮', 'Howitzer'], supply_truck: ['补给车', 'Truck'], commander: ['指挥官', 'Commander'],
};
const weaponNames: Record<string, [string, string]> = {
  rifle: ['步枪火力', 'rifles'], recon_rifle: ['侦察火力', 'carbines'], engineer_rifle: ['工兵火力', 'SMGs'], mg: ['机枪', 'machine gun'],
  coax_mg: ['同轴机枪', 'coax MG'], at_cannon: ['反坦克炮', 'AT gun'], light_cannon: ['轻坦主炮', '37 mm gun'], medium_cannon: ['中坦主炮', '75 mm gun'],
  heavy_cannon: ['重坦主炮', '88 mm gun'], commander_pistols: ['警卫火力', 'staff pistols'], mortar_shell: ['迫击炮弹', 'mortar fire'], howitzer_shell: ['榴弹炮弹', 'howitzer fire'],
  collapse: ['工事坍塌', 'collapsing strongpoint'],
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
