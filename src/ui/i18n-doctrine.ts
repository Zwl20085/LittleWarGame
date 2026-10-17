/** 3.0 AI doctrine strings (作战风格, sim/doctrines.ts); merged into the command dictionaries (i18n-command.ts). */
type Dict = Record<string, string>;

export const DOCTRINE_ZH: Dict = {
  'wdoc.builder': '优先发育·抢占地盘', 'wdoc.blitz': '优先军事·一波直捣黄龙', 'wdoc.attrition': '稳扎稳打·掐断部署', 'wdoc.maneuver': '寻机决战·大兵团歼灭',
  'wdoc.short.builder': '优先发育', 'wdoc.short.blitz': '直捣黄龙', 'wdoc.short.attrition': '稳扎稳打', 'wdoc.short.maneuver': '寻机决战',
  'wdoc.random': '随机',
  'wdoc.desc.builder': '经济与地盘优先：早早大举投资、占领每座空镇；劣势时防御或收缩，后期以经济优势换取大军。',
  'wdoc.desc.blitz': '军事优先：守住紧凑的防线、集结突击集团，兵力比达标即以装甲与摩托化矛头直扑敌国首都；受挫后整补再战。',
  'wdoc.desc.attrition': '保存实力：受损部队撤下休整、依托工事作战，只在侧翼稳固时扩张；袭扰敌方车队、铁路、公路与经济区，前线绵密连贯。',
  'wdoc.desc.maneuver': '保持庞大的机动主力（装甲、摩托化、炮兵），寻找孤立的敌方面军，以 1.5:1 以上优势决战；不打劣势仗，击溃敌军主力前不急于争城。',
  'wdoc.random.desc': '由随机种子决定（尽量各不相同）。',
  'wdoc.line': '作风：{d}', 'wdoc.unknown': '作风：未明',
  'setup.aiDoctrines': '电脑作战风格', 'setup.aiSlot': '{roman} 方',
  'log.doctrineOffensive': '按作战风格发起攻势：直指 {city}', 'log.doctrineBattle': '主力出击，寻求决战', 'log.doctrineRearm': '攻势结束，整补再战',
};

export const DOCTRINE_EN: Dict = {
  'wdoc.builder': 'Builder — economy and land first', 'wdoc.blitz': 'Blitz — one deep strike at the capital', 'wdoc.attrition': 'Attrition — hold, preserve, interdict', 'wdoc.maneuver': 'Maneuver — seek the decisive battle',
  'wdoc.short.builder': 'Builder', 'wdoc.short.blitz': 'Blitz', 'wdoc.short.attrition': 'Attrition', 'wdoc.short.maneuver': 'Maneuver',
  'wdoc.random': 'Random',
  'wdoc.desc.builder': 'Economy and territory first: invests early and heavily, occupies every free town, defends or contracts when outmatched, turns a late economic lead into a large army.',
  'wdoc.desc.blitz': 'Military first: a compact perimeter and a strike force, then one deep armoured and motorized offensive on an enemy capital once the force ratio is met; re-arms and tries again.',
  'wdoc.desc.attrition': 'Preserves its force: damaged units pull back, it fights from works and expands only with secure flanks; raids convoys, rail, roads and economic zones; keeps a dense, continuous front.',
  'wdoc.desc.maneuver': 'A large mobile main body (armour, motorized, artillery) roams for a decisive battle against an isolated enemy front at 1.5:1 or better; declines bad odds, cares little for towns until the enemy army is broken.',
  'wdoc.random.desc': 'Drawn from the seed (all different where possible).',
  'wdoc.line': 'Doctrine: {d}', 'wdoc.unknown': 'Doctrine: unknown',
  'setup.aiDoctrines': 'AI doctrines', 'setup.aiSlot': 'Side {roman}',
  'log.doctrineOffensive': 'Doctrine offensive: driving on {city}', 'log.doctrineBattle': 'Main body moves out to seek a decisive battle', 'log.doctrineRearm': 'Offensive over: re-arming',
};
