// 雾岛突围 / MIST ISLE — 每日 / 每周任务池（共享数据，无 DOM）
// metric 必须来自 MISSION_METRICS；进度由 shared/progression.mjs missionProgress 统一结算。
// dimension 用于 pickDaily/pickWeekly 的「不同维度轮换」：同一天不会出现 6 条击杀任务。
// telemetry: true 表示该 metric 目前需要引擎补充事件（simulation.mjs 冻结，暂由上层事件推断），
// 轮换时优先挑选非 telemetry 任务，保证玩家每天接到的任务都能在实战中推进。

export const MISSION_METRICS = [
  'kills', 'wins', 'matches', 'damage', 'survived', 'revives', 'pickups',
  'headshots', 'vehicles', 'hordeWaves', 'placementTop3', 'accuracyShots', 'downs',
  'assists', 'dodges', 'airdrops', 'attachments', 'dismantles', 'throws', 'throwHits',
  'vehicleRams', 'vehicleMeters', 'matchKills', 'crouchKills', 'unscathedWins',
  'killsPistol', 'killsShotgun', 'killsSniper', 'killsSmg', 'killsRifle', 'killsLmg',
  'winsQinglan', 'winsChisha', 'winsBaiye', 'winsSolo', 'winsSquad', 'matchesSolo', 'matchesSquad',
];

// metric → { label, source }，source 说明该数值从哪来，方便 UI 文案与排障。
export const MISSION_METRIC_INFO = {
  kills: { label: '击杀', source: 'snapshot.me.kills' },
  wins: { label: '胜场', source: 'result.winnerTeam' },
  matches: { label: '对局', source: '每局 +1' },
  damage: { label: '伤害', source: 'snapshot.me.damage' },
  survived: { label: '生存', source: 'snapshot.matchTime' },
  revives: { label: '救援', source: 'revive 事件' },
  pickups: { label: '拾取', source: 'pickup 事件' },
  headshots: { label: '爆头', source: 'hit 事件（引擎待补，telemetry）' },
  vehicles: { label: '载具', source: 'vehicle enter 事件' },
  hordeWaves: { label: '波次', source: 'snapshot.horde.wave' },
  placementTop3: { label: '前三', source: 'placement ≤ 3' },
  accuracyShots: { label: '命中', source: 'shot.hit / hit 事件' },
  downs: { label: '击倒', source: 'snapshot.me.downs' },
  assists: { label: '助攻', source: 'snapshot.me.assists' },
  dodges: { label: '翻滚', source: 'dodge 事件' },
  airdrops: { label: '空投', source: 'dropOpen 事件' },
  attachments: { label: '配件拾取', source: 'pickup(kind=attachment) 事件' },
  dismantles: { label: '拆解', source: 'dismantle 事件（引擎待补，telemetry）' },
  throws: { label: '投掷', source: 'throw 事件' },
  throwHits: { label: '投掷命中', source: 'explosion 落在投掷落点附近' },
  vehicleRams: { label: '载具撞击', source: 'vehicle hit 事件（driver 判定）' },
  vehicleMeters: { label: '载具里程', source: '载具乘坐时长 × 巡航速度估算' },
  matchKills: { label: '单局击杀', source: '单局 kills' },
  crouchKills: { label: '蹲射击杀', source: 'kill 事件（引擎待补，telemetry）' },
  unscathedWins: { label: '无伤吃鸡', source: 'won 且终局血量 ≥ 95' },
  killsPistol: { label: '手枪击杀', source: 'kill 事件 + 武器类别' },
  killsShotgun: { label: '霰弹击杀', source: 'kill 事件 + 武器类别' },
  killsSniper: { label: '狙击击杀', source: 'kill 事件 + 武器类别' },
  killsSmg: { label: '冲锋枪击杀', source: 'kill 事件 + 武器类别' },
  killsRifle: { label: '步枪击杀', source: 'kill 事件 + 武器类别' },
  killsLmg: { label: '机枪击杀', source: 'kill 事件 + 武器类别' },
  winsQinglan: { label: '青岚吃鸡', source: 'won 且 mapId=qinglan' },
  winsChisha: { label: '赤砂吃鸡', source: 'won 且 mapId=chisha' },
  winsBaiye: { label: '白夜吃鸡', source: 'won 且 mapId=baiye' },
  winsSolo: { label: '单排吃鸡', source: 'won 且 mode=solo' },
  winsSquad: { label: '四排吃鸡', source: 'won 且 mode=squad' },
  matchesSolo: { label: '单排对局', source: 'mode=solo 每局 +1' },
  matchesSquad: { label: '四排对局', source: 'mode=squad 每局 +1' },
};

export const METRIC_LABELS = Object.fromEntries(
  Object.entries(MISSION_METRIC_INFO).map(([id, info]) => [id, info.label]),
);

export const DIFFICULTY_LABELS = { easy: '简单', normal: '普通', hard: '困难', elite: '精英' };

// 任务链：连续 7 天清空当日全部每日任务 → 额外奖励（由 client/meta.js 的 streak 字段结算）
export const MISSION_STREAK = { days: 7, xp: 900, credits: 600, label: '七日任务链' };

const m = (id, title, desc, metric, target, difficulty, xp, credits, dimension, extra = {}) => ({
  id, title, name: title, desc, metric, target, xp, credits, difficulty, dimension, ...extra,
});

// 每日任务池（28）：单日可完成的小目标，xp 90–260 / credits 60–160
export const DAILY_POOL = [
  m('d_kill6', '清扫街区', '单日累计击杀 6 名敌人。', 'kills', 6, 'easy', 120, 70, 'kill'),
  m('d_kill12', '血洗长街', '单日累计击杀 12 名敌人。', 'kills', 12, 'hard', 220, 130, 'kill'),
  m('d_win1', '今晚突围', '赢下 1 场对局。', 'wins', 1, 'normal', 180, 110, 'win'),
  m('d_win2', '连下两城', '单日赢下 2 场对局。', 'wins', 2, 'elite', 260, 160, 'win'),
  m('d_match3', '保持手感', '完成 3 场对局。', 'matches', 3, 'easy', 130, 90, 'activity'),
  m('d_damage800', '撕开防线', '累计造成 800 点伤害。', 'damage', 800, 'normal', 150, 90, 'damage'),
  m('d_damage1800', '拆骨卸甲', '累计造成 1800 点伤害。', 'damage', 1800, 'hard', 240, 140, 'damage'),
  m('d_survive6', '雾中呼吸', '累计生存 6 分钟。', 'survived', 360, 'normal', 140, 80, 'survival'),
  m('d_revive2', '不抛下队友', '救援队友 2 次。', 'revives', 2, 'normal', 160, 100, 'support'),
  m('d_pickup20', '搜刮专家', '累计拾取 20 件物资。', 'pickups', 20, 'easy', 120, 70, 'loot'),
  m('d_headshot5', '眉心一枪', '累计爆头 5 次。', 'headshots', 5, 'normal', 160, 100, 'precision', { telemetry: true }),
  m('d_accuracy150', '弹无虚发', '累计命中敌人 150 次。', 'accuracyShots', 150, 'normal', 170, 100, 'accuracy'),
  m('d_vehicle1', '引擎咆哮', '驾驶载具行驶一段路。', 'vehicles', 1, 'easy', 100, 60, 'vehicle'),
  m('d_top3_2', '稳定发挥', '2 次进入前三名。', 'placementTop3', 2, 'hard', 200, 120, 'placement'),
  m('d_horde2', '守住基地', '在虫潮中守住 2 波。', 'hordeWaves', 2, 'normal', 180, 110, 'horde'),
  m('d_down4', '击倒专家', '累计击倒 4 名敌人。', 'downs', 4, 'easy', 140, 80, 'down'),
  m('d_pistol2', '掌心惊雷', '用手枪击杀 2 名敌人。', 'killsPistol', 2, 'normal', 150, 90, 'weapon'),
  m('d_shotgun2', '贴脸问候', '用霰弹枪击杀 2 名敌人。', 'killsShotgun', 2, 'normal', 160, 95, 'weapon'),
  m('d_sniper1', '一枪定音', '用狙击枪击杀 1 名敌人。', 'killsSniper', 1, 'hard', 200, 120, 'weapon'),
  m('d_smg3', '巷战清道夫', '用冲锋枪击杀 3 名敌人。', 'killsSmg', 3, 'normal', 160, 95, 'weapon'),
  m('d_rifle4', '主力输出', '用突击步枪击杀 4 名敌人。', 'killsRifle', 4, 'normal', 170, 100, 'weapon'),
  m('d_lmg2', '火力覆盖', '用机枪击杀 2 名敌人。', 'killsLmg', 2, 'hard', 190, 110, 'weapon'),
  m('d_win_qinglan', '青岚之主', '在青岚岛赢下 1 场对局。', 'winsQinglan', 1, 'hard', 260, 160, 'map'),
  m('d_win_solo', '孤狼之夜', '在单排模式赢下 1 场对局。', 'winsSolo', 1, 'hard', 240, 150, 'mode'),
  m('d_squad2', '四人同行', '完成 2 场四人模式对局。', 'matchesSquad', 2, 'easy', 130, 80, 'mode'),
  m('d_airdrops1', '开箱之手', '开启 1 个补给空投。', 'airdrops', 1, 'normal', 180, 110, 'airdrop'),
  m('d_attach3', '配件工坊', '拾取 3 个配件并拆解改装。', 'attachments', 3, 'easy', 140, 85, 'attach'),
  m('d_dodge4', '雾中残影', '翻滚闪避 4 次。', 'dodges', 4, 'normal', 150, 90, 'dodge'),
];

// 每周任务池（20）：跨多局的长期目标，xp 400–1200 / credits 240–700
export const WEEKLY_POOL = [
  m('w_kill60', '本周屠榜', '本周累计击杀 60 名敌人。', 'kills', 60, 'hard', 900, 520, 'kill'),
  m('w_kill150', '尸横遍野', '本周累计击杀 150 名敌人。', 'kills', 150, 'elite', 1200, 700, 'kill'),
  m('w_match20', '活跃战士', '本周完成 20 场对局。', 'matches', 20, 'normal', 700, 400, 'activity'),
  m('w_match40', '雾岛通勤', '本周完成 40 场对局。', 'matches', 40, 'hard', 1000, 580, 'activity'),
  m('w_win5', '常胜之雾', '本周赢下 5 场对局。', 'wins', 5, 'elite', 1000, 600, 'win'),
  m('w_win12', '霸榜者', '本周赢下 12 场对局。', 'wins', 12, 'elite', 1200, 700, 'win'),
  m('w_damage12000', '毁灭性打击', '本周累计造成 12000 点伤害。', 'damage', 12000, 'hard', 950, 550, 'damage'),
  m('w_damage30000', '焦土政策', '本周累计造成 30000 点伤害。', 'damage', 30000, 'elite', 1150, 680, 'damage'),
  m('w_survive90', '雾岛常客', '本周累计生存 90 分钟。', 'survived', 5400, 'normal', 800, 450, 'survival'),
  m('w_revive20', '队友的后盾', '本周救援队友 20 次。', 'revives', 20, 'hard', 820, 480, 'support'),
  m('w_pickup120', '资源猎手', '本周累计拾取 120 件物资。', 'pickups', 120, 'normal', 650, 360, 'loot'),
  m('w_headshot40', '狙击时刻', '本周累计爆头 40 次。', 'headshots', 40, 'hard', 880, 500, 'precision', { telemetry: true }),
  m('w_top3_12', '排行榜前排', '本周 12 次进入前三名。', 'placementTop3', 12, 'elite', 1100, 650, 'placement'),
  m('w_horde8', '虫潮防线', '在虫潮模式中守住合计 8 波。', 'hordeWaves', 8, 'normal', 760, 420, 'horde'),
  m('w_accuracy1200', '万弹归宗', '本周累计命中敌人 1200 次。', 'accuracyShots', 1200, 'hard', 900, 520, 'accuracy'),
  m('w_vehicle20', '机械化部队', '本周驾驶载具 20 次。', 'vehicles', 20, 'normal', 600, 340, 'vehicle'),
  m('w_vehkm5', '五公里越野', '本周驾驶载具行驶 5000 米。', 'vehicleMeters', 5000, 'normal', 700, 400, 'vehicle'),
  m('w_throws15', '工兵作业', '本周用投掷物命中 6 次。', 'throwHits', 6, 'hard', 850, 470, 'throw'),
  m('w_sniper8', '远程点名', '本周用狙击枪击杀 8 名敌人。', 'killsSniper', 8, 'hard', 980, 560, 'weapon'),
  m('w_win_baiye', '白夜归途', '在白夜岛赢下 3 场对局。', 'winsBaiye', 3, 'elite', 1050, 620, 'map'),
];

export const DAILY_PICK = 6;
export const WEEKLY_PICK = 4;

const byId = pool => Object.fromEntries(pool.map(m => [m.id, m]));
export const DAILY_BY_ID = byId(DAILY_POOL);
export const WEEKLY_BY_ID = byId(WEEKLY_POOL);
export const ALL_MISSIONS = Object.fromEntries(
  [...DAILY_POOL, ...WEEKLY_POOL].map(m => [m.id, { ...m, tier: DAILY_BY_ID[m.id] ? 'daily' : 'weekly', cadence: DAILY_BY_ID[m.id] ? 'daily' : 'weekly' }]),
);

export function getMission(id) { return ALL_MISSIONS[id] || null; }
export function missionPool(cadence) { return cadence === 'weekly' ? WEEKLY_POOL : DAILY_POOL; }

// 轮换用的维度索引：同一个 dimension 在一次抽选中最多出现一次。
export function dimensionBuckets(pool = DAILY_POOL) {
  const buckets = new Map();
  for (const mission of pool) {
    const key = mission.dimension || mission.metric;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(mission);
  }
  return buckets;
}
