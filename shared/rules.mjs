// 雾岛突围 / MIST ISLE — 共享常量（冻结文件，禁止他人修改）
// 所有单位：位置=米、时间=秒、角度=弧度（0 指向 +Z，x 分量 = sin(angle)）

export const VERSION = '1.4.0';
export const PROTOCOL_VERSION = 3;

export const TICK_RATE = 30;
export const SNAPSHOT_EVERY_TICKS = 3; // 10 Hz
export const MAX_PLAYERS = 64;
export const SQUAD_SIZE = 4;
export const MAX_TEAMS = 16;
export const MAX_HUMANS = 64;
export const MAX_LOOT = 640;
export const MAX_GRENADES = 160;
// 事件窗口容量。一局完整对局（64 人）实测约 1839 条事件，140 只能装下 7.6%：
// 客户端 10Hz 拉取、每次以 sinceEventId 递增消费，正常游玩不会丢；但一旦某一帧
// 卡顿/掉线重连，缺口就会越过被裁掉的事件，特效（爆炸/空投/Boss 技能）永久缺失。
// 512 覆盖约 2-3 秒的爆发窗口（一波 horde + 密集交火），内存代价每房间约 60KB。
export const MAX_EVENTS = 512;
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
  // 要害（爆头）核心区：命中点到目标中轴线的横向偏移 ≤ 命中半径 × 该比例时判为要害。
  // 俯视角没有垂直瞄准，用「打在躯干正中心」代理爆头：0.38 ≈ 站立命中圆约 14% 的面积，
  // 贴脸几乎必中、中远距要求更精的瞄准，与武器 headshotMul（1.4–2.2）的风险回报匹配。
  headshotCoreRatio: 0.38,
};

// 多阶段缩圈：[等待, 收缩时长, 半径比例, 伤害]
// 名义总时长 = Σ(wait + shrink) = 30+26 + 24+24 + 20+22 + 16+18 + 12+16 = **208s**。
// 首圈的 30s 等待是「落地搜物资」窗口，必须真的被消耗掉；旧实现里代码读的是
// ZONE_PHASES[z.phase + 1]?.wait，phase=-1 时跳过了 ZONE_PHASES[0].wait，
// 改用独立的 ZONE_FIRST_WAIT=26，导致总时长名义 258s / 实际 204s 两头对不上，
// 决赛圈在 187.9s 才开始收缩，而平均对局 187s 就结束了——P4/P5 的圈伤几乎从未生效。
export const ZONE_PHASES = [
  { wait: 30, shrink: 26, ratio: 0.72, damage: 5 },
  { wait: 24, shrink: 24, ratio: 0.52, damage: 9 },
  { wait: 20, shrink: 22, ratio: 0.34, damage: 14 },
  { wait: 16, shrink: 18, ratio: 0.19, damage: 20 },
  { wait: 12, shrink: 16, ratio: 0.075, damage: 28 },
];
// 首圈等待的唯一来源：直接引用 ZONE_PHASES[0].wait，杜绝「两处各写一个数」的漂移。
export const ZONE_FIRST_WAIT = ZONE_PHASES[0].wait;

// ── 空降（自由航线 + 跳伞）──────────────────────────────────────────────────
// deployStyle：
//   'instant' —— 开局直接落在地面出生锚点（1.x 行为，向后兼容；测试与快节奏模式用）
//   'skydive' —— 运输机沿随机航线飞越地图，玩家在可跳窗口内主动跳伞，
//                自由落体一段后自动开伞滑翔落地。
//
// 时序（秒，相对 deploying 阶段开始）：
//   航线从地图外一侧横穿到另一侧；窗口打开后可跳；窗口关闭时未跳的人被强制弹出。
export const DEPLOY = {
  planeSpeed: 46,          // 运输机速度（m/s）
  planeHeight: 190,        // 航线飞行高度（表现用）
  // 可跳窗口 10s：首版给 14s，算下来「进圈 1.3s + 窗口 14s + 自由落体 2.6s +
  // 滑翔 5.4s」最坏情况要 23 秒才落地。手游开局等 23 秒太久（同类产品多在 15s 内
  // 完成部署），而窗口只需要「够玩家选一次落点」——10s 已能完整扫过地图中段。
  jumpWindow: 10,
  forceJumpRatio: 0.9,     // 窗口剩余比例低于此值 → 未跳玩家被自动弹出
  // 自由落体 2.0s / 滑翔 4.4s：视觉上仍能看清「俯冲 → 开伞 → 减速」三段，
  // 但把落地前的纯等待压掉 1.6 秒。总时长最坏 ≈ 1.3 + 10 + 2 + 4.4 ≈ 17.7s。
  freefall: 2.0,           // 自由落体时长（秒）：水平速度最快、转向最灵敏
  freefallSpeed: 64,       // 自由落体水平速度（m/s）
  chuteGlide: 4.4,         // 开伞后滑翔时长（秒）
  chuteSpeed: 15,          // 开伞后水平速度（m/s）
  dropHeight: 150,         // 跳伞起始高度（m，表现用）
  landRadius: 8,           // 落地散开半径
  planeMargin: 0.34,       // 航线端点伸出地图边界的比例（保证横穿整图）
};

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
  // ── 平衡结论（120 局配对种子实测，scripts/ai-bench-paired.mjs）─────────────
  //
  // 先说两个被推翻的旧结论，别再走回头路：
  //
  // 1. 历史上写在这里的「29.2% / 25.0% / 45.8%」是 **单批 24 局的噪声**。
  //    同一份代码同一批种子跑 24 局得 20.8/41.7/37.5，跑 60 局得 11.7/45.0/43.3，
  //    5 个种子批次之间同一档位可差 ±7pt。24 局的胜率粒度是 1/24，不够用。
  //    现在一律以 **120 局** 为口径。
  //
  // 2. 「精锐吃鸡率最高」是幸存者偏差。死因拆解（60 局）显示：每档 20 人阵亡数
  //    几乎相同（1190/1144/1159），但新兵互杀只有 74 次，而被老兵打死 231 次、
  //    被精锐打死 531 次 —— 新兵在开局几秒就成片倒地，**根本不参与击杀**。
  //    它偶尔吃鸡是因为「精锐互相打完后它还剩一个人」，不是因为它强。
  //    真实强度顺序是 精锐 > 老兵 > 新兵，稳定反映在 KD（0.34 / 0.83 / 1.20）
  //    与「前 25% 队率」（8.3% / 25% / 44.7%）上，而不是吃鸡率上。
  //
  // 因此调参方向是明确的：**让新兵别那么快倒下**，而不是让老手更容易死。
  // 后者试过（veteran/elite 降血降伤害），结果是老兵吃鸡率反升 11.7pt、
  // 精锐掉 16.7pt，三档一起崩。
  //
  // 当前值，**两次独立 120 局**（不同脚本、不同档位-队伍映射）：
  //   轮换出生点  9.2% / 43.3% / 47.5%   前 25% 8.3% / 25.0% / 44.7%   KD 0.34 / 0.83 / 1.20
  //   不轮换     10.8% / 36.7% / 52.5%   前 25% 9.7% / 30.0% / 40.3%   KD 0.43 / 0.88 / 1.08
  // 两次的绝对值差 5–6pt，但**排序与量级一致**：新兵 ~10%、老兵 ~40%、精锐 ~50%，
  // 前 25% 率与 KD 的阶梯也稳定。这就是这个指标能给出的分辨率上限 ——
  // 再精确到个位数位就是自欺欺人。判据要同时看胜率、前 25% 队率、KD 三者。
  //
  // 已实测的敏感度（120 局，相对基线的胜率变化）：
  //   新兵 aimError .14→.11 且 hpMul .95→1.20 : 新兵 +5.0pt、精锐 −7.5pt、KD 0.34→0.50  ← 最有效
  //     ...再叠 dmgMul .90→1.00                : 新兵 +8.3pt、精锐 −12.5pt、KD 0.55
  //   精锐 aimError .085→.10                  : 精锐 −3.3pt（单动，温和）
  //   精锐 reaction  .20→.30                  : 精锐 −10.0pt
  //   精锐 burst     .78→.66                  : 零效果（该参数在 burst 循环里被别的项覆盖）
  //    老手降血/降伤害                          : 三档同崩，不要碰
  //
  // 诚实边界：新兵要真到 33% 公平份额，需要把 aimError 压到和老兵接近（≤.12），
  // 那时「新兵」这个档位在手感上就不再是新兵了。设计上选择保留可感知的档位差异，
  // 用前 25% 队率（新兵 8.3% vs 公平 25%）作为「新兵确实更弱」的诚实指标。
  recruit: {
    id: 'recruit', name: '新兵', desc: '反应慢、枪法散漫，适合熟悉地图。',
    reaction: 0.55, aimError: 0.14, aimSpeed: 5, burst: 0.55, retarget: 0.9,
    coverUse: 0.3, throwChance: 0.12, useVehicle: 0.3, reviveChance: 0.3,
    lootHaste: 0.75, aggression: 0.65, hpMul: 0.95, dmgMul: 0.9,
  },
  veteran: {
    id: 'veteran', name: '老兵', desc: '会找掩体、会补枪，正面交火很危险。',
    reaction: 0.34, aimError: 0.1, aimSpeed: 7.5, burst: 0.7, retarget: 0.65,
    coverUse: 0.55, throwChance: 0.28, useVehicle: 0.5, reviveChance: 0.6,
    lootHaste: 1, aggression: 0.85, hpMul: 1, dmgMul: 1,
  },
  elite: {
    id: 'elite', name: '精锐', desc: '压枪稳、会绕后与投掷物压制，慎战。',
    reaction: 0.2, aimError: 0.085, aimSpeed: 9, burst: 0.78, retarget: 0.5,
    coverUse: 0.78, throwChance: 0.45, useVehicle: 0.7, reviveChance: 0.85,
    lootHaste: 1.25, aggression: 0.9, hpMul: 1, dmgMul: 1,
  },
};

// ── 生存波次（horde / PvE）──────────────────────────────────────────────────
// 数据全部集中在这里：敌人数值、20 波编排、波次修正、10 种升级。
// 纯数据 + 纯函数 apply(match, team)：apply 只通过 match.hordeUpgrade(kind, team)
// 调用模拟层实现，避免 rules ↔ simulation 的循环依赖。
export const HORDE = {
  waves: 20,
  prepTime: 15,
  baseHp: 800,
  // 每波结束回复 8% 结构（在模拟层结算）
  waveHeal: 0.08,
  enemyStart: 6,
  enemyPerWave: 3,
  // 同时活跃敌人上限：超过后进入刷怪队列，死一个补一个
  maxActive: 60,
  // 难度曲线：1.13^19 ≈ 10.2 倍血量，1.06^19 ≈ 3.0 倍伤害
  hpPerWave: 1.13,
  dmgPerWave: 1.06,
  speedPerWave: 1.012,
  // 敌人打建筑只结算一部分伤害：基地是「压力表」而不是一击就碎的血包。
  baseDamageMul: 0.45,
  // 清波奖励：100 + wave * 40（模拟层结算）
  creditsBase: 100,
  creditsPerWave: 40,
  scoreWaveBase: 100,
  scoreWaveStep: 30,
  // 首领：每 5 波一只；16 波起双首领（见 waves 编排）
  bossEvery: 5,
  bossWave: 10, // 兼容旧字段（1.0.0 早期只有第 10 波有 boss）
  doubleBossFrom: 16,
  // 玩家复活分段：1–5 波 6s / 6–12 波 10s / 13+ 波 14s
  reviveAfter: 6,
  reviveTiers: [
    { maxWave: 5, time: 6 },
    { maxWave: 12, time: 10 },
    { maxWave: Infinity, time: 14 },
  ],
  // 无尽：默认 20 波清关；match 传入 hordeEndless 后 20 波后继续刷
  endlessAfter: 20,
  endlessHpStep: 0.16,
  endlessCountStep: 2,
  // 每 3 波一个随机修正（必须用 match.rng() 抽）
  modifierEvery: 3,
  modifierPool: ['frenzy', 'armored', 'swarm', 'fog', 'regen'],
  modifiers: {
    frenzy: { id: 'frenzy', name: '狂暴', desc: '敌人攻击速度 +40%。', attackSpeed: 1.4 },
    armored: { id: 'armored', name: '铁甲', desc: '敌人护甲 +50%（受到的伤害 -33%）。', armor: 0.5 },
    swarm: { id: 'swarm', name: '蜂群', desc: '敌人数量 ×1.5，血量 ×0.7。', countMul: 1.5, hpMul: 0.7 },
    fog: { id: 'fog', name: '浓雾', desc: '视野降低，敌人从雾里逼近。', viewMul: 0.55 },
    regen: { id: 'regen', name: '再生', desc: '敌人每秒回复 1% 最大生命。', regenPct: 0.01 },
  },
  // 6 种敌人：数值全部集中在此，behavior 决定 AI 分支
  enemies: {
    crawler: {
      id: 'crawler', name: '爬行者', hp: 60, speed: 3.0, damage: 8, attackCd: 1.25,
      radius: 0.5, color: 0x8fb6a8, kind: 'melee', behavior: 'advance', xp: 8, credits: 6, score: 25,
    },
    runner: {
      id: 'runner', name: '疾行者', hp: 45, speed: 5.7, damage: 7, attackCd: 0.9,
      radius: 0.45, color: 0xd0a35e, kind: 'melee', behavior: 'flank', xp: 10, credits: 8, score: 30,
      preferPlayer: true, flankOffset: 7,
    },
    brute: {
      id: 'brute', name: '重装兵', hp: 320, speed: 2.2, damage: 22, attackCd: 1.8,
      radius: 0.85, color: 0x6d7f8f, kind: 'melee', behavior: 'advance', xp: 30, credits: 22, score: 120,
      knockback: 3.2, meleeRange: 1.9,
    },
    spitter: {
      id: 'spitter', name: '喷吐者', hp: 90, speed: 2.5, damage: 12, attackCd: 2.6,
      radius: 0.55, color: 0x9fd06a, kind: 'ranged', behavior: 'ranged', xp: 16, credits: 12, score: 60,
      range: 15, projectileSpeed: 17, poolRadius: 4, poolTtl: 8, poolDps: 7,
    },
    bomber: {
      id: 'bomber', name: '自爆兵', hp: 70, speed: 4.4, damage: 45, attackCd: 0,
      radius: 0.5, color: 0xe2703f, kind: 'suicide', behavior: 'kamikaze', xp: 14, credits: 10, score: 50,
      blastRadius: 8, triggerRange: 2.5, lowHp: 0.2, fuse: 0.6,
    },
    boss: {
      id: 'boss', name: '雾岛之主', hp: 3200, speed: 2.6, damage: 34, attackCd: 1.4,
      radius: 1.5, color: 0xc48bf0, kind: 'boss', behavior: 'boss', xp: 300, credits: 250, score: 500,
      meleeRange: 2.2, skillCd: 6, chargeSpeed: 18, chargeTime: 1.5, chargeDamage: 40,
      summonCount: 3, quakeRadius: 8, quakeDamage: 30, knockback: 4,
    },
  },
  // 10 种升级；max 缺省视为无限
  upgrades: {
    repair: {
      id: 'repair', name: '修复基地', baseCost: 120, step: 60, max: 99,
      desc: '恢复基地 30% 结构。',
      apply: (match, team) => match.hordeUpgrade('repair', team),
    },
    ammo: {
      id: 'ammo', name: '补给弹药', baseCost: 100, step: 50, max: 99,
      desc: '全队补满弹药与投掷物。',
      apply: (match, team) => match.hordeUpgrade('ammo', team),
    },
    armor: {
      id: 'armor', name: '强化护甲', baseCost: 140, step: 70, max: 99,
      desc: '全队护甲提升一档。',
      apply: (match, team) => match.hordeUpgrade('armor', team),
    },
    turret: {
      id: 'turret', name: '自动炮塔', baseCost: 220, step: 120, max: 4,
      desc: '基地周围布置炮塔，自动射击 26m 内敌人。',
      apply: (match, team) => match.hordeUpgrade('turret', team),
    },
    barricade: {
      id: 'barricade', name: '路障', baseCost: 160, step: 80, max: 6,
      desc: '基地外围竖起减速路障（范围内敌人 -50% 速度）。',
      apply: (match, team) => match.hordeUpgrade('barricade', team),
    },
    medstation: {
      id: 'medstation', name: '医疗站', baseCost: 180, step: 90, max: 3,
      desc: '基地范围内每 2 秒回复 2 点生命。',
      apply: (match, team) => match.hordeUpgrade('medstation', team),
    },
    airstrike: {
      id: 'airstrike', name: '空袭', baseCost: 300, step: 150, max: 5,
      desc: '一次性：清掉当前波次 60% 的敌人。',
      apply: (match, team) => match.hordeUpgrade('airstrike', team),
    },
    slowfield: {
      id: 'slowfield', name: '减速场', baseCost: 240, step: 120, max: 2,
      desc: '基地 12m 内敌人速度 -35%（可叠加到 -50%）。',
      apply: (match, team) => match.hordeUpgrade('slowfield', team),
    },
    weaponcache: {
      id: 'weaponcache', name: '武器箱', baseCost: 260, step: 130, max: 3,
      desc: '全队随机升级一级武器并补满弹药。',
      apply: (match, team) => match.hordeUpgrade('weaponcache', team),
    },
    overcharge: {
      id: 'overcharge', name: '超载', baseCost: 200, step: 100, max: 99,
      desc: '下一波炮塔伤害 ×2（持续 1 波）。',
      apply: (match, team) => match.hordeUpgrade('overcharge', team),
    },
  },
  // 20 波编排：composition = [{type, count}]，modifier=null 时按 modifierEvery 随机
  // 注意：上方 waves 是总波数（数值），这张表叫 waveTable（数组）。
  waveTable: [
    { wave: 1, composition: [{ type: 'crawler', count: 6 }], modifier: null },
    { wave: 2, composition: [{ type: 'crawler', count: 8 }, { type: 'runner', count: 2 }], modifier: null },
    { wave: 3, composition: [{ type: 'crawler', count: 10 }, { type: 'runner', count: 3 }, { type: 'spitter', count: 1 }], modifier: null },
    { wave: 4, composition: [{ type: 'crawler', count: 10 }, { type: 'runner', count: 4 }, { type: 'spitter', count: 1 }], modifier: null },
    { wave: 5, composition: [{ type: 'crawler', count: 12 }, { type: 'runner', count: 4 }, { type: 'brute', count: 1 }, { type: 'boss', count: 1 }], modifier: null },
    { wave: 6, composition: [{ type: 'crawler', count: 14 }, { type: 'runner', count: 6 }, { type: 'spitter', count: 2 }, { type: 'brute', count: 1 }], modifier: null },
    { wave: 7, composition: [{ type: 'crawler', count: 12 }, { type: 'runner', count: 8 }, { type: 'spitter', count: 2 }, { type: 'bomber', count: 2 }], modifier: null },
    { wave: 8, composition: [{ type: 'crawler', count: 14 }, { type: 'runner', count: 8 }, { type: 'brute', count: 2 }, { type: 'spitter', count: 3 }, { type: 'bomber', count: 2 }], modifier: null },
    { wave: 9, composition: [{ type: 'crawler', count: 16 }, { type: 'runner', count: 10 }, { type: 'spitter', count: 3 }, { type: 'bomber', count: 3 }], modifier: null },
    { wave: 10, composition: [{ type: 'crawler', count: 16 }, { type: 'runner', count: 10 }, { type: 'brute', count: 3 }, { type: 'spitter', count: 3 }, { type: 'bomber', count: 2 }, { type: 'boss', count: 1 }], modifier: null },
    { wave: 11, composition: [{ type: 'crawler', count: 18 }, { type: 'runner', count: 12 }, { type: 'brute', count: 2 }, { type: 'spitter', count: 4 }, { type: 'bomber', count: 3 }], modifier: null },
    { wave: 12, composition: [{ type: 'crawler', count: 18 }, { type: 'runner', count: 12 }, { type: 'brute', count: 3 }, { type: 'spitter', count: 4 }, { type: 'bomber', count: 4 }], modifier: null },
    { wave: 13, composition: [{ type: 'crawler', count: 20 }, { type: 'runner', count: 14 }, { type: 'brute', count: 3 }, { type: 'spitter', count: 5 }, { type: 'bomber', count: 4 }], modifier: null },
    { wave: 14, composition: [{ type: 'crawler', count: 20 }, { type: 'runner', count: 14 }, { type: 'brute', count: 4 }, { type: 'spitter', count: 6 }, { type: 'bomber', count: 5 }], modifier: null },
    { wave: 15, composition: [{ type: 'crawler', count: 22 }, { type: 'runner', count: 16 }, { type: 'brute', count: 5 }, { type: 'spitter', count: 5 }, { type: 'bomber', count: 4 }, { type: 'boss', count: 1 }], modifier: null },
    { wave: 16, composition: [{ type: 'crawler', count: 22 }, { type: 'runner', count: 16 }, { type: 'brute', count: 5 }, { type: 'spitter', count: 6 }, { type: 'bomber', count: 5 }], modifier: null },
    { wave: 17, composition: [{ type: 'crawler', count: 24 }, { type: 'runner', count: 18 }, { type: 'brute', count: 6 }, { type: 'spitter', count: 6 }, { type: 'bomber', count: 6 }], modifier: null },
    { wave: 18, composition: [{ type: 'crawler', count: 24 }, { type: 'runner', count: 18 }, { type: 'brute', count: 7 }, { type: 'spitter', count: 7 }, { type: 'bomber', count: 6 }], modifier: null },
    { wave: 19, composition: [{ type: 'crawler', count: 26 }, { type: 'runner', count: 20 }, { type: 'brute', count: 8 }, { type: 'spitter', count: 8 }, { type: 'bomber', count: 8 }], modifier: null },
    { wave: 20, composition: [{ type: 'crawler', count: 26 }, { type: 'runner', count: 20 }, { type: 'brute', count: 8 }, { type: 'spitter', count: 8 }, { type: 'bomber', count: 6 }, { type: 'boss', count: 2 }], modifier: 'frenzy' },
  ],
};

export const INPUT_DEFAULTS = Object.freeze({
  mx: 0, mz: 0, aim: 0, fire: false,
  reload: false, heal: false, interact: false, swap: false, ping: false,
  sprint: false, crouch: false, dodge: false,
  throwable: null, useItem: null, pingKind: 'move', slot: -1,
  revive: false, buy: null, upgrade: null, ready: false, seq: 0,
  // jump：空降阶段请求跳伞（skydive 专用，地面阶段被忽略）
  jump: false,
  // jumpAt：跳伞落点（归一化 0-1），仅与 jump 同帧生效
  jumpAt: null,
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

// 画质档。pixelRatio 是 **物理像素比上限**（不是设备 DPR）：
// 实测 high=2.0 在 1280×720 视口下渲染 2560×1440（368 万像素），帧时间 p50 直接
// 从 16.7ms 翻到 33.3ms（60→30 FPS），而画面在 6 寸屏上与 1.5 肉眼无差别。
// 1.5 已足够覆盖 1080p/1440p 手机（逻辑 844×390 × 1.5 ≈ 1266×585）。
// shadows 目前恒为 false：scene.js 构造函数里硬关了 shadowMap（78 栋建筑 + 960 棵树
// 的全场景 shadow pass 在移动端不可行），这里保留字段仅为配置完整性，实际不生效。
export const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, fx: 0.5, viewDistance: 78, refl: false },
  balanced: { pixelRatio: 1.2, shadows: false, fx: 1, viewDistance: 96, refl: false },
  high: { pixelRatio: 1.5, shadows: false, fx: 1.4, viewDistance: 118, refl: true },
};
