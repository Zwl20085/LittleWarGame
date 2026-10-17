/** 3.0.1 auto toggles (斗蛐蛐: the player may just watch); merged into the main dictionaries in i18n.ts. */
export const AUTO_ZH: Record<string, string> = {
  'auto.researchOn': '自动研究：开', 'auto.researchOff': '自动研究：关',
  'auto.researchTip': '开启时由统帅部参谋按作战风格选购技术升级（先从收入中预留资金）；首都告急或收入下滑时暂停并退回预留。手动研究不会关闭它。',
  'auto.researchFund': '研究预留 {p} P / {m} M', 'auto.researchWant': '参谋拟研究：{name}',
  'auto.engOn': '自动工程：开', 'auto.engOff': '自动工程：关',
  'auto.engTip': '开启时工兵自行修复己方断开的铁路、为未通路的城镇与经济区修筑连接公路；手动下达的工程照常执行。',
  'eng.why.busy': '工兵：工程进行中', 'eng.why.noEngineer': '工兵：暂无空闲工兵', 'eng.why.rail': '工兵：正在修复铁路',
  'eng.why.road': '工兵：正在修筑连接公路', 'eng.why.funds': '工兵：军需不足，暂缓修路', 'eng.why.linked': '工兵：城镇均已通路', 'eng.why.none': '工兵：无可做的工程',
  'auto.cmdOn': '自动统帅：开', 'auto.cmdOff': '自动统帅：关',
  'auto.cmdTip': '开启时由统帅部按你的作战风格自行选择总方针。你下达的总方针优先；下达「推进」或最后一次命令 {min} 分钟后交还统帅部。',
  'auto.cmdNow': '统帅部：{dir}', 'auto.cmdPaused': '执行你的命令，{t} 后交还统帅部',
  'setup.playerDoctrine': '玩家作风', 'setup.playerDoctrineTip': '自动统帅与自动研究按此作风行事（随机 = 由种子决定）。',
};

export const AUTO_EN: Record<string, string> = {
  'auto.researchOn': 'Auto-research: on', 'auto.researchOff': 'Auto-research: off',
  'auto.researchTip': 'When on, the HQ staff buy upgrades in your doctrine\'s order (saving part of the income first); paused, and the savings returned, when the capital is in danger or income falls. A manual purchase does not switch it off.',
  'auto.researchFund': 'Set aside for research {p} P / {m} M', 'auto.researchWant': 'Staff plan: {name}',
  'auto.engOn': 'Auto-engineering: on', 'auto.engOff': 'Auto-engineering: off',
  'auto.engTip': 'When on, the engineers repair your cut rail lines and lay road links to unlinked towns and economic zones on their own; jobs you order still run.',
  'eng.why.busy': 'Engineers: a job is under way', 'eng.why.noEngineer': 'Engineers: none free', 'eng.why.rail': 'Engineers: repairing the rail',
  'eng.why.road': 'Engineers: laying a road link', 'eng.why.funds': 'Engineers: short of M, road deferred', 'eng.why.linked': 'Engineers: every town is linked', 'eng.why.none': 'Engineers: nothing to build',
  'auto.cmdOn': 'Auto HQ: on', 'auto.cmdOff': 'Auto HQ: off',
  'auto.cmdTip': 'When on, the HQ picks the directive by your doctrine. A directive you issue comes first; issuing Advance, or {min} min after your last order, hands it back.',
  'auto.cmdNow': 'HQ: {dir}', 'auto.cmdPaused': 'Your order stands; back to the HQ in {t}',
  'setup.playerDoctrine': 'Your doctrine', 'setup.playerDoctrineTip': 'Auto HQ and auto research follow this doctrine (Random = drawn from the seed).',
};
