// 雾岛突围 / MIST ISLE — 每日 / 每周任务池（共享数据，无 DOM）
// metric 必须来自 MISSION_METRICS；进度由 shared/progression.mjs missionProgress 统一结算。

export const MISSION_METRICS = [
  'kills', 'wins', 'matches', 'damage', 'survived', 'revives', 'pickups',
  'headshots', 'vehicles', 'hordeWaves', 'placementTop3', 'accuracyShots', 'downs',
];

export const METRIC_LABELS = {
  kills: '击杀', wins: '胜场', matches: '对局', damage: '伤害', survived: '生存',
  revives: '救援', pickups: '拾取', headshots: '爆头', vehicles: '载具',
  hordeWaves: '波次', placementTop3: '前三', accuracyShots: '命中', downs: '击倒',
};

export const DIFFICULTY_LABELS = { easy: '简单', normal: '普通', hard: '困难', elite: '精英' };

// 每日任务池（≥14）：单局可完成的小目标，xp 90–220 / credits 50–140
export const DAILY_POOL = [
  { id: 'd_kill6', title: '清扫街区', desc: '单日累计击杀 6 名敌人。', metric: 'kills', target: 6, xp: 120, credits: 70, difficulty: 'easy' },
  { id: 'd_kill12', title: '火力压制', desc: '单日累计击杀 12 名敌人。', metric: 'kills', target: 12, xp: 220, credits: 130, difficulty: 'hard' },
  { id: 'd_win1', title: '今晚突围', desc: '赢下 1 场对局。', metric: 'wins', target: 1, xp: 180, credits: 110, difficulty: 'normal' },
  { id: 'd_match3', title: '保持手感', desc: '完成 3 场对局。', metric: 'matches', target: 3, xp: 130, credits: 90, difficulty: 'easy' },
  { id: 'd_damage800', title: '撕开防线', desc: '累计造成 800 点伤害。', metric: 'damage', target: 800, xp: 150, credits: 90, difficulty: 'normal' },
  { id: 'd_damage1800', title: '持续输出', desc: '累计造成 1800 点伤害。', metric: 'damage', target: 1800, xp: 240, credits: 140, difficulty: 'hard' },
  { id: 'd_survive6', title: '雾中生存', desc: '累计生存 6 分钟。', metric: 'survived', target: 360, xp: 140, credits: 80, difficulty: 'normal' },
  { id: 'd_revive2', title: '不抛下队友', desc: '救援队友 2 次。', metric: 'revives', target: 2, xp: 160, credits: 100, difficulty: 'normal' },
  { id: 'd_pickup20', title: '搜刮专家', desc: '累计拾取 20 件物资。', metric: 'pickups', target: 20, xp: 120, credits: 70, difficulty: 'easy' },
  { id: 'd_headshot5', title: '精准狩猎', desc: '累计爆头 5 次。', metric: 'headshots', target: 5, xp: 160, credits: 100, difficulty: 'normal' },
  { id: 'd_vehicle1', title: '引擎咆哮', desc: '使用载具 1 次。', metric: 'vehicles', target: 1, xp: 100, credits: 60, difficulty: 'easy' },
  { id: 'd_top3_2', title: '稳定发挥', desc: '2 次进入前三名。', metric: 'placementTop3', target: 2, xp: 200, credits: 120, difficulty: 'hard' },
  { id: 'd_horde2', title: '守住基地', desc: '在虫潮中守住 2 波。', metric: 'hordeWaves', target: 2, xp: 180, credits: 110, difficulty: 'normal' },
  { id: 'd_accuracy150', title: '弹无虚发', desc: '累计命中敌人 150 次。', metric: 'accuracyShots', target: 150, xp: 170, credits: 100, difficulty: 'normal' },
  { id: 'd_down4', title: '击倒专家', desc: '累计击倒 4 名敌人。', metric: 'downs', target: 4, xp: 140, credits: 80, difficulty: 'easy' },
  { id: 'd_win2', title: '连胜之路', desc: '单日赢下 2 场对局。', metric: 'wins', target: 2, xp: 260, credits: 160, difficulty: 'elite' },
];

// 每周任务池（≥10）：跨多局的长期目标，xp 400–1200 / credits 240–700
export const WEEKLY_POOL = [
  { id: 'w_kill60', title: '本周屠榜', desc: '本周累计击杀 60 名敌人。', metric: 'kills', target: 60, xp: 900, credits: 520, difficulty: 'hard' },
  { id: 'w_match20', title: '活跃战士', desc: '本周完成 20 场对局。', metric: 'matches', target: 20, xp: 700, credits: 400, difficulty: 'normal' },
  { id: 'w_win5', title: '常胜之雾', desc: '本周赢下 5 场对局。', metric: 'wins', target: 5, xp: 1000, credits: 600, difficulty: 'elite' },
  { id: 'w_damage12000', title: '毁灭性打击', desc: '本周累计造成 12000 点伤害。', metric: 'damage', target: 12000, xp: 950, credits: 550, difficulty: 'hard' },
  { id: 'w_survive90', title: '雾岛常客', desc: '本周累计生存 90 分钟。', metric: 'survived', target: 5400, xp: 800, credits: 450, difficulty: 'normal' },
  { id: 'w_revive20', title: '队友的后盾', desc: '本周救援队友 20 次。', metric: 'revives', target: 20, xp: 820, credits: 480, difficulty: 'hard' },
  { id: 'w_pickup120', title: '资源猎手', desc: '本周累计拾取 120 件物资。', metric: 'pickups', target: 120, xp: 650, credits: 360, difficulty: 'normal' },
  { id: 'w_headshot40', title: '狙击时刻', desc: '本周累计爆头 40 次。', metric: 'headshots', target: 40, xp: 880, credits: 500, difficulty: 'hard' },
  { id: 'w_top3_12', title: '排行榜前排', desc: '本周 12 次进入前三名。', metric: 'placementTop3', target: 12, xp: 1100, credits: 650, difficulty: 'elite' },
  { id: 'w_horde8', title: '虫潮防线', desc: '在虫潮模式中守住合计 8 波。', metric: 'hordeWaves', target: 8, xp: 760, credits: 420, difficulty: 'normal' },
  { id: 'w_accuracy1200', title: '万弹归宗', desc: '本周累计命中敌人 1200 次。', metric: 'accuracyShots', target: 1200, xp: 900, credits: 520, difficulty: 'hard' },
  { id: 'w_vehicle20', title: '机械化部队', desc: '本周使用载具 20 次。', metric: 'vehicles', target: 20, xp: 600, credits: 340, difficulty: 'normal' },
];

export const DAILY_PICK = 3;
export const WEEKLY_PICK = 3;

const byId = pool => Object.fromEntries(pool.map(m => [m.id, m]));
export const DAILY_BY_ID = byId(DAILY_POOL);
export const WEEKLY_BY_ID = byId(WEEKLY_POOL);
export const ALL_MISSIONS = Object.fromEntries(
  [...DAILY_POOL, ...WEEKLY_POOL].map(m => [m.id, { ...m, cadence: DAILY_BY_ID[m.id] ? 'daily' : 'weekly' }]),
);

export function getMission(id) { return ALL_MISSIONS[id] || null; }
export function missionPool(cadence) { return cadence === 'weekly' ? WEEKLY_POOL : DAILY_POOL; }
