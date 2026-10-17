// 雾岛突围 / MIST ISLE — Bot 呼号 / 战队名 / 难度（共享数据，无 DOM）
import { DIFFICULTY } from '../rules.mjs';

export const BOT_NAMES = [
  '灰鹭', '铁鸦', '青隼', '夜狼', '断潮', '沙狐', '雾灯', '礁石',
  '北风', '赤鳞', '锈锚', '白鲨', '山魈', '雷隼', '空弦', '长夜',
  '盐霜', '孤星', '冻土', '低语', '碎浪', '纸鸢', '黑杉', '火镰',
  '南十字', '锈迹', '沉默者', '拾荒人', '听潮', '老渡口', '沙丁鱼', '残响',
  '雾笛', '青蛇', '铁皮', '落雷', '干盐', '暗礁', '流浪者', '钉子',
  '旧号角', '三叉戟', '冷焰', '陶罐', '半山', '风暴眼', '断桨', '苍狼',
];

export const BOT_TITLES = [
  '拾荒者', '守夜人', '爆破手', '侦察兵', '医疗兵', '狙击手',
  '老兵', '逃兵', '走私客', '向导', '灯塔工', '矿工',
];

export const TEAM_NAMES = [
  '雾岛小队', '青岚巡卫', '赤砂佣兵', '白夜守备', '断潮兄弟会', '盐碱旅团',
  '北境游骑', '旧港拾荒队', '灯塔守望者', '矿洞回声', '铁皮公司', '荒野信使',
  '长夜突击队', '落雷分队', '三号仓库帮', '风暴观察站', '黑杉猎手', '沙丘商队',
  '锈锚船团', '冷焰佣兵团', '碎浪侦察组', '半山游击队', '断桨游击队', '苍狼护卫',
];

// 波次敌人（horde PvE）：名称 + 主题色
export const HORDE_ENEMIES = {
  walker: { id: 'walker', name: '雾化游魂', color: 0x8fb6a8, hp: 1, speed: 1, damage: 1 },
  runner: { id: 'runner', name: '疾雾猎犬', color: 0xd0a35e, hp: 0.7, speed: 1.55, damage: 0.8 },
  brute: { id: 'brute', name: '雾甲重装', color: 0x6d7f8f, hp: 2.6, speed: 0.7, damage: 1.6 },
  spitter: { id: 'spitter', name: '酸雾喷吐者', color: 0x9fd06a, hp: 1.1, speed: 0.95, damage: 1.1 },
  boss: { id: 'boss', name: '雾岛之主', color: 0xc48bf0, hp: 14, speed: 0.62, damage: 2.4 },
};
export const HORDE_ENEMY_ORDER = ['walker', 'runner', 'spitter', 'brute'];
export const HORDE_WAVE_WEIGHTS = {
  // 每波各类型基础权重，随后乘以 rules.HORDE.hpPerWave 曲线在模拟层处理
  walker: 6, runner: 2, spitter: 1.5, brute: 0.7,
};

// bot 行为权重在 rules.DIFFICULTY 基础上补充（感知/搜刮/抱团/撤离）
const BEHAVIOR = {
  recruit: { nameWeight: 1, hordeMul: 0.85, perception: 34, lootTime: 1.3, groupUp: 0.25, retreatHp: 0.2, preferVehicle: 0.3, callout: 0.1 },
  veteran: { nameWeight: 1.4, hordeMul: 1, perception: 46, lootTime: 1, groupUp: 0.55, retreatHp: 0.32, preferVehicle: 0.5, callout: 0.35 },
  elite: { nameWeight: 1.8, hordeMul: 1.12, perception: 58, lootTime: 0.8, groupUp: 0.75, retreatHp: 0.42, preferVehicle: 0.7, callout: 0.6 },
};

export const DIFFICULTIES = Object.fromEntries(
  Object.entries(DIFFICULTY).map(([id, base]) => [id, { ...base, ...BEHAVIOR[id], weights: BEHAVIOR[id] }]),
);
export const DIFFICULTY_ORDER = Object.keys(DIFFICULTIES);

const hashString = text => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const pick = (list, n) => list[((n % list.length) + list.length) % list.length];

// rng 可为函数（返回 [0,1)）或种子值；确定性由调用方种子决定
export function randomBotProfile(rng = null) {
  const roll = typeof rng === 'function' ? rng() : (hashString(String(rng ?? Date.now())) % 1000) / 1000;
  const base = pick(BOT_NAMES, Math.floor(Math.abs(roll) * BOT_NAMES.length) % BOT_NAMES.length);
  const title = pick(BOT_TITLES, Math.floor(Math.abs(roll) * 9973) % BOT_TITLES.length);
  return { name: `${base}·${title}`, base, title };
}

// 单个呼号（字符串）：模拟层直接用作玩家名
export function randomBotName(rng = null) { return randomBotProfile(rng).name; }

export function teamNameFor(index = 0) {
  const i = Math.floor(Math.abs(Number(index) || 0));
  return TEAM_NAMES[i % TEAM_NAMES.length];
}

export { DIFFICULTY };
