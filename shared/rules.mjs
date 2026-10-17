// 雾岛突围 / MIST ISLE — 共享常量（冻结文件，禁止他人修改）
// 所有单位：位置=米、时间=秒、角度=弧度（0 指向 +Z，x 分量 = sin(angle)）

export const VERSION = '1.0.0';
export const PROTOCOL_VERSION = 3;

export const TICK_RATE = 30;
export const SNAPSHOT_EVERY_TICKS = 3; // 10 Hz
export const MAX_PLAYERS = 64;
export const SQUAD_SIZE = 4;
export const MAX_TEAMS = 16;
export const MAX_HUMANS = 64;
export const MAX_LOOT = 640;
export const MAX_GRENADES = 160;
export const MAX_EVENTS = 140;
export const MAX_CARS = 18;

export const REVIVE_TIME = 4.5;
export const BLEEDOUT_TIME = 30;
export const DOWNED_MOVE_SPEED = 2.2;
export const REVIVE_RANGE = 2.9;
export const REVIVE_HP = 42;

export const MATCH_MODES = ['solo', 'squad', 'horde', 'training'];
export const GAME_MODES = ['solo', 'squad', 'horde', 'training'];
export const DEFAULT_DURATION = { solo: 390, squad: 420, horde: 600, training: 480 };

// 移动（米/秒）
export const MOVE = {
  walk: 6.2,
  sprint: 8.9,
  crouch: 3.4,
  downed: DOWNED_MOVE_SPEED,
  adsMul: 0.72,
  waterMul: 0.55,
  sprintStamina: 100,
  sprintDrain: 22,
  sprintRegen: 15,
  sprintMin: 12,
  dodgeDistance: 4.3,
  dodgeTime: 0.26,
  dodgeCooldown: 1.9,
  radius: 0.55,
  vehicleRadius: 1.45,
};

// 战斗
export const COMBAT = {
  headshotMul: 1.8,
  armorBaseAbsorb: 0.35,
  armorDurabilityLoss: 0.8,
  damageFalloffStart: 0.55, // 超过射程 55% 开始衰减
  damageFalloffEnd: 0.28, // 射程末端只保留 28%
  maxArmor: 150,
  maxHp: 100,
  maxShield: 100,
  zoneBaseDamage: 4,
  zoneDamageStep: 5,
  bleedoutSnowStep: 2,
  friendlyFire: 0,
  downedDamageMul: 1.35,
};

// 多阶段缩圈：[等待, 收缩时长, 半径比例, 伤害]
export const ZONE_PHASES = [
  { wait: 30, shrink: 26, ratio: 0.72, damage: 5 },
  { wait: 24, shrink: 24, ratio: 0.52, damage: 9 },
  { wait: 20, shrink: 22, ratio: 0.34, damage: 14 },
  { wait: 16, shrink: 18, ratio: 0.19, damage: 20 },
  { wait: 12, shrink: 16, ratio: 0.075, damage: 28 },
];
export const ZONE_FIRST_WAIT = 26;

export const WEATHER = ['clear', 'rain', 'fog', 'sandstorm', 'snow'];
export const WEATHER_INFO = {
  clear: { name: '晴朗', icon: '☀', fog: [0.9, 1], wind: 0.2, particles: 0 },
  rain: { name: '阵雨', icon: '☂', fog: [0.55, 0.82], wind: 0.6, particles: 900 },
  fog: { name: '浓雾', icon: '≋', fog: [0.32, 0.6], wind: 0.1, particles: 0 },
  sandstorm: { name: '沙暴', icon: '≋', fog: [0.4, 0.68], wind: 1, particles: 700 },
  snow: { name: '落雪', icon: '❄', fog: [0.5, 0.78], wind: 0.35, particles: 800 },
};
export const TIME_OF_DAY = {
  day: { name: '白昼', sky: 0x86b5b6, ambient: 1, sun: 1 },
  dusk: { name: '黄昏', sky: 0xc98a63, ambient: 0.72, sun: 0.8 },
  night: { name: '长夜', sky: 0x1b2b3a, ambient: 0.42, sun: 0.35 },
};

export const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const RARITY_NAMES = { common: '普通', uncommon: '精良', rare: '稀有', epic: '史诗', legendary: '传说' };
export const RARITY_COLORS = { common: '#c9d2cb', uncommon: '#7ed3a5', rare: '#6fb7f0', epic: '#c48bf0', legendary: '#f5b445' };
export const RARITY_STAT_MUL = { common: 1, uncommon: 1.04, rare: 1.09, epic: 1.14, legendary: 1.2 };

export const PROGRESSION = {
  maxLevel: 60,
  creditsWin: 120,
  creditsPerKill: 14,
  creditsPlacement: 30,
  xpWin: 260,
  xpPerKill: 22,
  xpPerDamage: 0.05,
  xpPlacement: 40,
};

export const RANK_TIERS = [
  { id: 'bronze', name: '青铜', min: 0, divisions: 3, color: '#b07a4f' },
  { id: 'silver', name: '白银', min: 240, divisions: 3, color: '#b9c6bf' },
  { id: 'gold', name: '黄金', min: 620, divisions: 3, color: '#e2bb5b' },
  { id: 'platinum', name: '铂金', min: 1100, divisions: 3, color: '#7fd0cf' },
  { id: 'diamond', name: '钻石', min: 1680, divisions: 3, color: '#7fb6f0' },
  { id: 'master', name: '大师', min: 2400, divisions: 2, color: '#c48bf0' },
  { id: 'legend', name: '传奇', min: 3300, divisions: 1, color: '#f5b445' },
];

export const DIFFICULTY = {
  recruit: {
    id: 'recruit', name: '新兵', desc: '反应慢、枪法散漫，适合熟悉地图。',
    reaction: 0.55, aimError: 0.16, aimSpeed: 5, burst: 0.55, retarget: 0.9,
    coverUse: 0.3, throwChance: 0.12, useVehicle: 0.3, reviveChance: 0.3,
    lootHaste: 0.75, aggression: 0.65, hpMul: 0.9, dmgMul: 0.8,
  },
  veteran: {
    id: 'veteran', name: '老兵', desc: '会找掩体、会补枪，正面交火很危险。',
    reaction: 0.34, aimError: 0.1, aimSpeed: 7.5, burst: 0.7, retarget: 0.65,
    coverUse: 0.55, throwChance: 0.28, useVehicle: 0.5, reviveChance: 0.6,
    lootHaste: 1, aggression: 0.85, hpMul: 1, dmgMul: 1,
  },
  elite: {
    id: 'elite', name: '精锐', desc: '压枪稳、会绕后与投掷物压制，慎战。',
    reaction: 0.2, aimError: 0.055, aimSpeed: 10, burst: 0.82, retarget: 0.45,
    coverUse: 0.78, throwChance: 0.45, useVehicle: 0.7, reviveChance: 0.85,
    lootHaste: 1.25, aggression: 1, hpMul: 1.05, dmgMul: 1.08,
  },
};

export const HORDE = {
  waves: 10,
  prepTime: 15,
  baseHp: 600,
  enemyStart: 6,
  enemyPerWave: 3,
  hpPerWave: 1.16,
  dmgPerWave: 1.07,
  reviveAfter: 8,
  bossWave: 10,
  upgrades: {
    repair: { id: 'repair', name: '修复基地', baseCost: 120, step: 60, desc: '恢复基地 30% 结构。' },
    ammo: { id: 'ammo', name: '补给弹药', baseCost: 100, step: 50, desc: '全队补满弹药与投掷物。' },
    armor: { id: 'armor', name: '强化护甲', baseCost: 140, step: 70, desc: '全队护甲提升一档。' },
    turret: { id: 'turret', name: '自动炮塔', baseCost: 220, step: 120, max: 4, desc: '基地周围布置炮塔。' },
  },
};

export const INPUT_DEFAULTS = Object.freeze({
  mx: 0, mz: 0, aim: 0, fire: false,
  reload: false, heal: false, interact: false, swap: false, ping: false,
  sprint: false, crouch: false, dodge: false,
  throwable: null, useItem: null, pingKind: 'move', slot: -1,
  revive: false, buy: null, upgrade: null, ready: false, seq: 0,
});

export const SCHEDULE = {
  inputSendMs: 40,
  pingMs: 2000,
  reconnectWindow: 20,
  loadingTimeout: 25,
  lobbyAutoStartMs: 20000,
  roomLifetimeMs: 30 * 60 * 1000,
  endedKeepMs: 180000,
};

export const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, fx: 0.5, viewDistance: 78, refl: false },
  balanced: { pixelRatio: 1.2, shadows: false, fx: 1, viewDistance: 96, refl: false },
  high: { pixelRatio: 2, shadows: true, fx: 1.4, viewDistance: 118, refl: true },
};
