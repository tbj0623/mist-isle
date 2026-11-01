// 雾岛突围 / MIST ISLE — 段位体系（共享纯函数，Node/浏览器同构，无 DOM）
// 7 大段位来自 rules.RANK_TIERS；每个大段位内再分 III→I 小段（I 为最高）。
import { RANK_TIERS as CORE_TIERS } from '../rules.mjs';

export const RANK_TIERS = CORE_TIERS;
export const RANK_TIER_COUNT = RANK_TIERS.length;
export const RANK_ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ'];
// 连败保护：连败达到 3 场后，本场掉分不会跌破当前大段位下限。
export const DEMOTION_SHIELD = { losses: 3, label: '连败保护' };
export const LEGEND_SPAN = 900; // 传奇段位内部的进度跨度（无下一段位时使用）

// ---------- 评级曲线参数（ratingDelta 从这里取值，便于调参） ----------
// 设计口径：16 队均匀名次（不含连败保护）期望 ≈ −10 分/局——段位必须净流出，才能成为技术分层。
// 旧参数（base 38 / spread 76 / winBonus 16 / 兜底 −34 / 连败护盾 0.35→−7）的实测均匀期望是
// **+4.63 分/局**：中位 +9，而连败 3 场后垫底只扣 −7（原 −34，削掉 79%），
// 于是「只要不是连续 3 局垫底，分数永远在涨」——随机玩家 713 局就能上传奇。
//
// 新曲线的锚点（16 队，均匀名次 = 1..16 各 1/16，含第 1 名的吃鸡加成）：
//   · 吃鸡                   +69
//   · 中位（第 8）           −11
//   · 垫底（第 16）          −45（lossFloor）
//   · 均匀名次期望           **−11.0/局**（1 杀 + 250 伤）/ **−10.3/局**（1 杀 + 400 伤）
//   · 50% 吃鸡率玩家         **+28.5/局**（一半 +69、一半 −11）
// 段位跨度 240–900 分：吃鸡率 50% 的玩家约 116 局净胜上传奇（3300 分），随机玩家净掉分。
// 连败保护保留，但只做「深负分托底」：连败 ≥3 后最多把 −45 收到 −36（20% 缓冲），
// 不再把所有负分压成 −7——旧护盾下随机玩家每局至多亏 7 分，数学上 E ≥ −6.56，
// 叠加 1/16 概率的吃鸡加分后，负期望根本不可能达到。
export const RATING = {
  base: 20, // 中位名次（第 8/16）附近的基准分
  spread: 76, // 名次从第 1 到第 last 的落差
  winBonus: 45, // 吃鸡额外加成（让第一名与第二名拉开档次）
  maxGain: 90, // 单局加分上限（防止极端战绩跳段）
  killWeight: 2.2,
  killCap: 14,
  damageDivisor: 180,
  damageCap: 10,
  lossFloor: -45,
  streakShield: 0.9, // 连败 ≥3 后的掉分乘数（只对深负分生效）
  streakShieldCap: -36, // 连败保护后的最低单局掉分
  hordeBase: 6,
  hordeWave: 3,
  hordeWaveCap: 30,
  hordeKillCap: 8,
};

// 每个段位的赛季奖励：信用点 + 专属物品 id（物品来自 shared/data/store.mjs）
// 结算/生涯界面据此展示「本赛季达到该段位可得」。
const RANK_REWARDS = {
  bronze: { credits: 300, items: ['spray_mist_eye'], label: '赛季保底' },
  silver: { credits: 800, items: ['emote_salute', 'card_veteran'], label: '白银奖励' },
  gold: { credits: 1600, items: ['chute_mist', 'wskin_ar7_olive'], label: '黄金奖励' },
  platinum: { credits: 2600, items: ['skin_ember', 'car_paint_fog'], label: '铂金奖励' },
  diamond: { credits: 4000, items: ['wskin_awm_white', 'skin_beacon'], label: '钻石奖励' },
  master: { credits: 6000, items: ['skin_legend_mist', 'wskin_sr338_phantom'], label: '大师奖励' },
  legend: { credits: 9000, items: ['skin_legend_dawn', 'wskin_legend_typhoon'], label: '传奇奖励' },
};

export const RANK_SEASONS = {
  id: 'S1',
  name: '第一赛季 · 雾起',
  note: '段位奖励在赛季结束时按最高段位发放；peakRating 决定档位。',
};

// 段位完整信息（含 minRating / maxRating / rewards）
export const RANK_LADDER = RANK_TIERS.map((tier, index) => {
  const next = RANK_TIERS[index + 1] || null;
  return {
    ...tier,
    index,
    minRating: tier.min,
    maxRating: next ? next.min - 1 : null,
    span: next ? next.min - tier.min : LEGEND_SPAN,
    rewards: RANK_REWARDS[tier.id] || { credits: 0, items: [], label: '' },
  };
});

export const RANK_BY_ID = Object.fromEntries(RANK_LADDER.map(t => [t.id, t]));


const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function tierSpan(index) {
  const i = clamp(Math.floor(num(index)), 0, RANK_TIER_COUNT - 1);
  const next = RANK_TIERS[i + 1];
  return next ? next.min - RANK_TIERS[i].min : LEGEND_SPAN;
}

// 定位 rating 所在大段位：{ index, tier, next, span }
export function tierAt(rating) {
  const r = Math.max(0, num(rating));
  let index = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) if (r >= RANK_TIERS[i].min) index = i;
  const tier = RANK_TIERS[index];
  return { index, tier, next: RANK_TIERS[index + 1] || null, span: tierSpan(index) };
}

// 段位查询：{ tier, division, name, color, progress }（+ 下一段位信息）
export function rankFor(rating) {
  const { index, tier, next, span } = tierAt(rating);
  const r = Math.max(0, num(rating));
  const offset = clamp(r - tier.min, 0, span);
  const step = span / Math.max(1, tier.divisions);
  const within = clamp(Math.floor(offset / step), 0, tier.divisions - 1);
  const division = tier.divisions - within; // III 最低、I 最高
  const progress = span > 0 ? clamp(offset / span, 0, 1) : 1;
  const divisionTag = tier.divisions > 1 ? ` ${RANK_ROMAN[division - 1] || ''}` : '';
  return {
    tier: tier.id,
    tierIndex: index,
    tierName: tier.name,
    division,
    divisions: tier.divisions,
    name: `${tier.name}${divisionTag}`.trim(),
    color: tier.color,
    min: tier.min,
    progress,
    next: next ? next.id : null,
    nextName: next ? next.name : null,
    nextMin: next ? next.min : null,
    toNext: next ? Math.max(0, next.min - r) : 0,
    isMax: !next,
  };
}

// 评级用的净期望：给 UI/测试一个「打多少局升一段」的参考值。
export function matchesToNextTier(rating, averageDelta = 22) {
  const info = rankFor(rating);
  if (info.isMax) return 0;
  const need = Math.max(0, num(info.nextMin) - Math.max(0, num(rating)));
  return Math.ceil(need / Math.max(1, num(averageDelta, 22)));
}

export function rewardsFor(tierId) {
  return (RANK_BY_ID[tierId] || RANK_LADDER[0]).rewards;
}

export function seasonRewards(rating) {
  const info = rankFor(rating);
  const tier = RANK_BY_ID[info.tier] || RANK_LADDER[0];
  return { tier: tier.id, name: tier.name, ...tier.rewards };
}

export function nextRank(rating) {
  const { next, span } = tierAt(rating);
  if (!next) return null;
  const r = Math.max(0, num(rating));
  return { tier: next.id, name: next.name, color: next.color, min: next.min, toNext: Math.max(0, next.min - r), span };
}

// 当前大段位下限（段位保护地板）
export function ratingFloor(rating) {
  return tierAt(rating).tier.min;
}

// 连败保护判定：{ active, floor, remaining }
export function demotionShield(rating, lossStreak = 0) {
  const streak = Math.max(0, Math.floor(num(lossStreak)));
  return {
    active: streak >= DEMOTION_SHIELD.losses,
    floor: ratingFloor(rating),
    remaining: Math.max(0, DEMOTION_SHIELD.losses - streak),
    label: DEMOTION_SHIELD.label,
  };
}

// 结算评级：返回最终 rating / 实际 delta / 是否触发保护 / 升降段
export function protectRating(rating, delta, lossStreak = 0) {
  const before = Math.max(0, num(rating));
  const d = num(delta);
  let after = Math.max(0, before + d);
  let shielded = false;
  if (d < 0 && demotionShield(before, lossStreak).active) {
    const floor = ratingFloor(before);
    if (after < floor) { after = floor; shielded = true; }
  }
  const from = rankFor(before);
  const to = rankFor(after);
  return {
    rating: Math.round(after),
    delta: Math.round(after - before),
    protected: shielded,
    from,
    to,
    promoted: to.tierIndex > from.tierIndex,
    demoted: to.tierIndex < from.tierIndex,
  };
}
