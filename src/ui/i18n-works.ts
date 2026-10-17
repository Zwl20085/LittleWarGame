/**
 * 3.0 strings for economic zones and defensive works (V30 §7, §8), zh + en. Looked up by
 * i18n.t after the main dictionaries.
 */
export const WORKS_ZH: Record<string, string> = {
  'status.buildingZone': '建设经济区', 'status.upgrading': '升级工事', 'status.layingMines': '布设雷场', 'status.repairing': '抢修国防圈',
  'log.zoneStarted': '统帅部：工兵开始建设一处经济区', 'log.zoneBuilt': '经济区建成（{level} 级）', 'log.zoneCaptured': '缴获一处敌方经济区',
  'log.zoneLost': '一处经济区落入敌手', 'log.zoneRuined': '一处经济区被摧毁', 'log.workUpgraded': '工兵完成工事升级：{kind}',
  'log.workBuilt': '工兵建成：{kind}', 'log.minefieldGone': '一处雷场已被扫除或耗尽',
  'fail.BAD_SITE': '此处不能建设（太靠近城镇 / 其他经济区 / 敌占区，或地形不合适）', 'fail.MAX_LEVEL': '已是最高等级', 'fail.BUSY': '工程进行中',
  'zone.title': '经济区', 'zone.level': '等级 {level}', 'zone.building': '施工中 {pct}%（{level} 级）', 'zone.ruined': '已成废墟',
  'zone.output': '产出 +{p} P / +{m} M 每分钟', 'zone.linked': '公路连通本方城镇（全额产出）', 'zone.unlinked': '未连通公路（产出减半）',
  'zone.hp': '完好度 {pct}%', 'zone.upgrade': '升级到 {level} 级（{p} P / {m} M）', 'zone.rebuild': '重建（{p} P / {m} M）', 'zone.max': '已达最高等级',
  'zone.enemy': '敌方经济区', 'zone.build': '建设经济区', 'zone.buildTip': '工兵在本方或中立地带建设经济区：点击地图选址（远离城镇，靠近公路）',
  'zone.pick': '点击地图选择经济区位置（右键取消）', 'zone.count': '经济区 {n} 处（合计 {lv} 级），产出 +{p} P / +{m} M',
  'work.fortress': '要塞', 'work.at_emplacement': '反坦克阵地', 'work.strongpoint': '国防圈支撑点', 'work.minefield': '雷场', 'work.bunker': '堡垒', 'work.pillbox': '炮楼', 'work.trench': '加固堑壕',
  'minimap.obsRing': '首都观察圈',
};

export const WORKS_EN: Record<string, string> = {
  'status.buildingZone': 'Building an economic zone', 'status.upgrading': 'Upgrading works', 'status.layingMines': 'Laying a minefield', 'status.repairing': 'Repairing the perimeter',
  'log.zoneStarted': 'Supreme HQ: engineers begin an economic zone', 'log.zoneBuilt': 'Economic zone completed (level {level})', 'log.zoneCaptured': 'An enemy economic zone was captured',
  'log.zoneLost': 'An economic zone fell to the enemy', 'log.zoneRuined': 'An economic zone was destroyed', 'log.workUpgraded': 'Engineers completed a works upgrade: {kind}',
  'log.workBuilt': 'Engineers completed: {kind}', 'log.minefieldGone': 'A minefield was cleared or used up',
  'fail.BAD_SITE': 'Cannot build here (too close to a town / another zone / enemy ground, or bad terrain)', 'fail.MAX_LEVEL': 'Already at the top level', 'fail.BUSY': 'Work in progress',
  'zone.title': 'Economic zone', 'zone.level': 'Level {level}', 'zone.building': 'Under construction {pct}% (level {level})', 'zone.ruined': 'In ruins',
  'zone.output': 'Output +{p} P / +{m} M per min', 'zone.linked': 'Road link to an own town (full output)', 'zone.unlinked': 'No road link (half output)',
  'zone.hp': 'Condition {pct}%', 'zone.upgrade': 'Raise to level {level} ({p} P / {m} M)', 'zone.rebuild': 'Rebuild ({p} P / {m} M)', 'zone.max': 'Top level reached',
  'zone.enemy': 'Enemy economic zone', 'zone.build': 'Build economic zone', 'zone.buildTip': 'Engineers build an economic zone on own or neutral ground: click the map (away from towns, near a road)',
  'zone.pick': 'Click the map to site the economic zone (right-click cancels)', 'zone.count': '{n} economic zone(s) ({lv} levels), output +{p} P / +{m} M',
  'work.fortress': 'fortress', 'work.at_emplacement': 'AT emplacement', 'work.strongpoint': 'perimeter strongpoint', 'work.minefield': 'minefield', 'work.bunker': 'bunker', 'work.pillbox': 'pillbox', 'work.trench': 'fortified trench',
  'minimap.obsRing': 'Capital observation ring',
};
