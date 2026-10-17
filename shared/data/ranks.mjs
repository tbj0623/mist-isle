// 雾岛突围 / MIST ISLE — 段位体系（共享纯函数，Node/浏览器同构，无 DOM）
// 7 大段位来自 rules.RANK_TIERS；每个大段位内再分 III→I 小段（I 为最高）。
import { RANK_TIERS as CORE_TIERS } from '../rules.mjs';

export const RANK_TIERS = CORE_TIERS;
export const RANK_TIER_COUNT = RANK_TIERS.length;
export const RANK_ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ'];
// 连败保护：连败达到 3 场后，本场掉分不会跌破当前大段位下限。
export const DEMOTION_SHIELD = { losses: 3, label: '连败保护' };
export const LEGEND_SPAN = 900; // 传奇段位内部的进度跨度（无下一段位时使用）

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
