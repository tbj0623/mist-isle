// 雾岛突围 / MIST ISLE — 第一赛季「雾起」数据与纯函数（共享层，Node/浏览器同构，禁止 DOM）
// 50 级赛季通行证 / 免费·高级双轨 / 7 日登录循环 / 连续登录加成 / 8 条赛季周挑战 / 三章 12 条主线。
// 经济口径：一局 80–260 赛季经验 → 约 4–8 局升一级，满级 50 级约 250–330 局。
// 只依赖 shared/progression.mjs 的 dayKey（不重复实现日期工具）。
import { dayKey } from '../progression.mjs';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round = v => Math.round(v);

export const SEASON_ID = 's1';
export const SEASON_TIERS = 50;
export const XP_PER_TIER = 1000;
// 50 级 = 49 次升级 × 1000 XP（tier 1 从 0 XP 起算，故满级门槛是 49 段）
export const SEASON_MAX_XP = (SEASON_TIERS - 1) * XP_PER_TIER;
export const ENDING_DAYS = 7;

// 奖励构造器：kind = credits | item | title
const reward = (tier, track, kind, label, desc, extra = {}) => ({
  id: `${track}_${tier}`, tier, track, kind, label, desc,
  amount: 0, itemId: null, itemKind: null, title: '', rarity: 'common', value: 0, ...extra,
});

// ---------- 免费轨：每 5 级一档，共 10 档 ----------
export const FREE_TIER_REWARDS = [
  reward(5, 'free', 'credits', '雾港补给', '第一笔像样的进账：三百信用点，够换一条好背带。', { amount: 300, value: 300 }),
  reward(10, 'free', 'item', '喷漆 · 雾眼', '在墙上睁开一只眼，让后来的人知道你来过。', { itemId: 'spray_mist_eye', itemKind: 'other', rarity: 'uncommon', value: 420 }),
  reward(15, 'free', 'credits', '旧港分账', '八百信用点。码头的人只认现金，不认故事。', { amount: 800, value: 800 }),
  reward(20, 'free', 'item', '表情 · 敬礼', '对倒下的对手，也对还没倒下的自己。', { itemId: 'emote_salute', itemKind: 'other', rarity: 'uncommon', value: 900 }),
  reward(25, 'free', 'credits', '中途补给', '一千二百信用点。雾还没散，路还长。', { amount: 1200, value: 1200 }),
  reward(30, 'free', 'item', '皮肤 · 赤砂旅人', '风沙磨出的厚布与护目镜，走过沙暴不留脚印。', { itemId: 'skin_sand', itemKind: 'character', rarity: 'uncommon', value: 1500 }),
  reward(35, 'free', 'credits', '长夜的价钱', '一千八百信用点。夜班总得有人上，账也得有人结。', { amount: 1800, value: 1800 }),
  reward(40, 'free', 'item', '降落伞 · 白雾', '开伞时像一片云，落地时像一场雾。', { itemId: 'chute_mist', itemKind: 'other', rarity: 'uncommon', value: 2100 }),
  reward(45, 'free', 'title', '称号 · 雾中常客', '你在岛上的时间，比很多人一辈子都长。', { title: '雾中常客', value: 2500 }),
  reward(50, 'free', 'item', '皮肤 · 灯塔守望', '海雾里的一束暖光，替迷路的人留着——现在轮到你了。', { itemId: 'skin_beacon', itemKind: 'character', rarity: 'epic', value: 3800 }),
];

// ---------- 高级轨：每 3 级一档，共 16 档（更好，但不影响平衡，只给外观与信用点）----------
export const PAID_TIER_REWARDS = [
  reward(3, 'paid', 'credits', '高级补给 · 壹', '通行证的第一次兑现，五百信用点。', { amount: 500, value: 500 }),
  reward(6, 'paid', 'item', 'P9 · 象牙', '温润的象牙握把，摸起来像旧时的烟盒。', { itemId: 'wskin_p9_ivory', itemKind: 'weapon', rarity: 'common', value: 720 }),
  reward(9, 'paid', 'credits', '高级补给 · 贰', '九百信用点，够把弹匣塞满一整晚。', { amount: 900, value: 900 }),
  reward(12, 'paid', 'item', 'AR7 · 橄榄', '林地标准涂装，油味比枪味重。', { itemId: 'wskin_ar7_olive', itemKind: 'weapon', rarity: 'uncommon', value: 1150 }),
  reward(15, 'paid', 'item', '降落伞 · 破晓', '落地前先亮一下，让底下的人抬头。', { itemId: 'chute_dawn', itemKind: 'other', rarity: 'epic', value: 1400 }),
  reward(18, 'paid', 'credits', '高级补给 · 叁', '一千五百信用点。雾里的买卖从不讲价。', { amount: 1500, value: 1500 }),
  reward(21, 'paid', 'item', 'MP5K · 潮汐', '机匣上的波纹随着潮位变化。', { itemId: 'wskin_mp5k_tide', itemKind: 'weapon', rarity: 'uncommon', value: 1750 }),
  reward(24, 'paid', 'item', '名片 · 雾行者', '只有走过整座岛的人，才配这个底色。', { itemId: 'card_mistwalker', itemKind: 'other', rarity: 'epic', value: 1950 }),
  reward(27, 'paid', 'credits', '高级补给 · 肆', '两千二百信用点，够买一次体面的退场。', { amount: 2200, value: 2200 }),
  reward(30, 'paid', 'item', '皮肤 · 余烬消防员', '隔热纤维里还带着烧焦的气味。', { itemId: 'skin_ember', itemKind: 'character', rarity: 'rare', value: 2500 }),
  reward(33, 'paid', 'item', 'M14 · 雾隐', '枪身做旧成海雾的颜色，抬枪像叹气。', { itemId: 'wskin_m14_fog', itemKind: 'weapon', rarity: 'rare', value: 2800 }),
  reward(36, 'paid', 'item', 'Vector · 霓虹', '长夜里最亮的那一条弹道。', { itemId: 'wskin_vector_neon', itemKind: 'weapon', rarity: 'epic', value: 3100 }),
  reward(39, 'paid', 'credits', '高级补给 · 伍', '三千信用点。账面上的数字终于像回事了。', { amount: 3000, value: 3300 }),
  reward(42, 'paid', 'item', '皮肤 · 矿坑工头', '头灯与重型护具，能把矿道走成家。', { itemId: 'skin_quarry', itemKind: 'character', rarity: 'epic', value: 3600 }),
  reward(45, 'paid', 'item', 'AWM · 白夜', '雪原上只剩呼吸声。', { itemId: 'wskin_awm_white', itemKind: 'weapon', rarity: 'epic', value: 3900 }),
  reward(48, 'paid', 'item', '皮肤 · 雾岛之主', '传说中走进雾里就不再回来的人——你回来了。', { itemId: 'skin_legend_mist', itemKind: 'character', rarity: 'legendary', value: 4800 }),
];

// ---------- 每日登录：7 天循环，第 8 天回 Day1 ----------
const login = (day, kind, label, desc, extra = {}) => ({
  day, kind, label, desc, amount: 0, itemId: null, itemKind: null, title: '', rarity: 'common', value: 0, ...extra,
});
export const DAILY_LOGIN = [
  login(1, 'credits', '雾港晨露', '一百信用点。开门第一件事，先数钱。', { amount: 100, value: 100 }),
  login(2, 'credits', '第一杯咖啡', '一百五十信用点，够买一份热的东西。', { amount: 150, value: 150 }),
  login(3, 'credits', '旧港的零钱', '两百信用点，边角磨得发亮。', { amount: 200, value: 200 }),
  login(4, 'item', '喷漆 · 苍狼', '狼头只剩一半，更凶。', { itemId: 'spray_wolf', itemKind: 'other', rarity: 'uncommon', value: 750 }),
  login(5, 'credits', '码头的分成', '三百信用点。有人替你算好了。', { amount: 300, value: 300 }),
  login(6, 'item', '表情 · 挑衅', '风险与快乐成正比，尤其在决赛圈。', { itemId: 'emote_taunt', itemKind: 'other', rarity: 'uncommon', value: 900 }),
  login(7, 'item', '皮肤 · 破晓号角', '每次突围都会吹响它——只是没人听过回声。', { itemId: 'skin_legend_dawn', itemKind: 'character', rarity: 'legendary', value: 7200 }),
];
// 七天一轮，第 8 天回到 Day1：loginDayFor 是唯一的循环入口
export function loginDayFor(dayIndex) {
  const n = Math.max(1, Math.floor(num(dayIndex, 1)));
  return ((n - 1) % DAILY_LOGIN.length) + 1;
}
export function loginRewardFor(dayIndex) {
  return DAILY_LOGIN[loginDayFor(dayIndex) - 1];
}

// ---------- 连续登录加成：3 / 7 / 14 / 30 天 ----------
const streak = (days, label, desc, extra = {}) => ({
  days, label, desc, kind: 'credits', amount: 0, itemId: null, itemKind: null, title: '', rarity: 'common', value: 0, ...extra,
});
export const STREAK_BONUSES = [
  streak(3, '三日不熄', '连续三天推开同一扇门，门开始认得你。', { amount: 300, value: 300 }),
  streak(7, '一周雾中人', '整整七天。岛上的雾开始绕着你走。', { amount: 800, value: 800, kind: 'item', itemId: 'spray_radio', itemKind: 'other', rarity: 'rare' }),
  streak(14, '半月同行', '两个星期没断过，连补给箱都开始准时。', { amount: 1800, value: 1800, kind: 'item', itemId: 'car_paint_fog', itemKind: 'other', rarity: 'rare' }),
  streak(30, '雾岛常驻', '三十天。你已经不是客人了。', { amount: 4000, value: 4000, kind: 'item', itemId: 'card_legend', itemKind: 'other', rarity: 'legendary' }),
];
export const STREAK_BONUS_DAYS = STREAK_BONUSES.map(b => b.days);

// 连续登录天数对应的下一档奖励（已过 30 天则回到 30 天档循环展示）
export function nextStreakBonus(streakDays = 0) {
  const days = Math.max(0, Math.floor(num(streakDays)));
  for (const bonus of STREAK_BONUSES) if (bonus.days > days) return { ...bonus, at: bonus.days, remaining: bonus.days - days };
  const last = STREAK_BONUSES[STREAK_BONUSES.length - 1];
  return { ...last, at: last.days, remaining: 0 };
}
export function streakBonusFor(streakDays = 0) {
  const days = Math.max(0, Math.floor(num(streakDays)));
  return STREAK_BONUSES.find(b => b.days === days) || null;
}

// ---------- 赛季专属周挑战（8 条，每周一刷新，只在本赛季内计数）----------
const ch = (id, title, desc, metric, target, xp, credits, dimension) => ({
  id, title, name: title, desc, metric, target, xp, credits, dimension, seasonXp: xp,
});
export const SEASON_WEEKLY_CHALLENGES = [
  ch('sc_fog_hunt', '雾里点名', '一周之内，让十二个人在雾里失去名字。', 'kills', 12, 260, 180, 'kill'),
  ch('sc_survive_long', '不肯离场', '累计在岛上活满二十分钟——雾会替你计时。', 'survived', 1200, 240, 160, 'survival'),
  ch('sc_top3_three', '三次靠岸', '三次挤进前三。决赛圈的空气，你已经开始习惯。', 'placementTop3', 3, 300, 200, 'placement'),
  ch('sc_damage_wall', '拆墙的人', '累计造成四千点伤害。数字不会说谎。', 'damage', 4000, 280, 190, 'damage'),
  ch('sc_revive_hands', '把人拽回来', '救援队友五次。有些胜利是从地上捡起来的。', 'revives', 5, 250, 170, 'support'),
  ch('sc_loot_run', '背包比人重', '累计拾取六十件物资。你带的不是装备，是整座仓库。', 'pickups', 60, 220, 150, 'loot'),
  ch('sc_vehicle_road', '压过整条路', '驾驶载具累计行驶一千五百米。', 'vehicleMeters', 1500, 230, 155, 'vehicle'),
  ch('sc_win_two', '两次登顶', '本周赢下两场。第一次叫运气，第二次叫本事。', 'wins', 2, 320, 220, 'win'),
];

// ---------- 赛季主线（3 章 × 4 条，章节逐步解锁）----------
export const SEASON_CHAPTERS = [
  { id: 1, name: '第一章 · 登岛', desc: '雾把你送上岸，第一课是活着。', unlockTier: 1 },
  { id: 2, name: '第二章 · 深入', desc: '岛的内侧没有地图，只有别人留下的痕迹。', unlockTier: 8 },
  { id: 3, name: '第三章 · 雾眼', desc: '走到雾的中心，才看清是谁在呼吸。', unlockTier: 18 },
];

const sm = (id, chapter, order, title, desc, metric, target, seasonXp, credits) => ({
  id, chapter, order, title, name: title, desc, metric, target,
  seasonXp, xp: seasonXp, credits,
  // 章节内的第一条是章节开启条件；必须按顺序推进，保证叙事连贯
  requires: order > 1 ? `${id.split('_')[0]}_${chapter}_${order - 1}` : null,
});
export const SEASON_MISSIONS = [
  sm('sm_1_1', 1, 1, '第一口雾', '完成三场对局。先学会在雾里呼吸。', 'matches', 3, 300, 200),
  sm('sm_1_2', 1, 2, '岸上的名字', '累计击杀十名敌人。岛会记住第一个名字。', 'kills', 10, 340, 220),
  sm('sm_1_3', 1, 3, '活过第一夜', '累计生存十五分钟。夜里的雾比白天重。', 'survived', 900, 360, 240),
  sm('sm_1_4', 1, 4, '登上高地', '两次进入前三。从高处看，雾是有形状的。', 'placementTop3', 2, 420, 280),

  sm('sm_2_1', 2, 1, '向岛心走', '完成十场对局。路是自己踩出来的。', 'matches', 10, 480, 320),
  sm('sm_2_2', 2, 2, '拆开防线', '累计造成八千点伤害。挡路的东西都要拆开。', 'damage', 8000, 520, 340),
  sm('sm_2_3', 2, 3, '不丢下任何人', '救援队友八次。岛上唯一比枪重要的东西。', 'revives', 8, 500, 330),
  sm('sm_2_4', 2, 4, '第一次突围', '赢下一场对局。雾会为你让开一条缝。', 'wins', 1, 600, 400),

  sm('sm_3_1', 3, 1, '雾眼的形状', '完成二十场对局。你开始认得每一阵风。', 'matches', 20, 640, 420),
  sm('sm_3_2', 3, 2, '刻在雾上', '累计击杀四十名敌人。名字太多，雾记不住了。', 'kills', 40, 700, 460),
  sm('sm_3_3', 3, 3, '三座岛的重量', '累计生存一小时。三张地图都压在你肩上。', 'survived', 3600, 760, 500),
  sm('sm_3_4', 3, 4, '雾散之后', '赢下三场对局。最后一次抬头，雾散了。', 'wins', 3, 900, 600),
];

export const SEASON_CHALLENGE_BY_ID = Object.fromEntries(SEASON_WEEKLY_CHALLENGES.map(c => [c.id, c]));
export const SEASON_MISSION_BY_ID = Object.fromEntries(SEASON_MISSIONS.map(m => [m.id, m]));
export const ALL_SEASON_REWARDS = [...FREE_TIER_REWARDS, ...PAID_TIER_REWARDS];

// ---------- 赛季总表 ----------
export const SEASON = {
  id: SEASON_ID,
  name: '第一赛季 · 雾起',
  shortName: '雾起',
  startAt: '2026-10-01',
  endAt: '2026-12-31',
  tiers: SEASON_TIERS,
  xpPerTier: XP_PER_TIER,
  maxXp: SEASON_MAX_XP,
  freeTierRewards: FREE_TIER_REWARDS,
  paidTierRewards: PAID_TIER_REWARDS,
  dailyLogin: DAILY_LOGIN,
  streakBonuses: STREAK_BONUSES,
  weeklyChallenges: SEASON_WEEKLY_CHALLENGES,
  seasonMissions: SEASON_MISSIONS,
  chapters: SEASON_CHAPTERS,
  note: '高级轨不内购：由赛季等级 + 段位/成就进度解锁，纯外观与信用点，不影响平衡。',
};

// ---------- 赛季经验：一局 80–260 ----------
// 只吃四件事：名次、击杀、存活、吃鸡。刻意不读击杀武器/爆头，避免结算口径漂移。
export function seasonXpForMatch(summary = {}) {
  const s = summary || {};
  if (s.mode === 'training') return 0; // 训练场不计赛季经验
  if (s.mode === 'horde') {
    const waves = Math.max(0, num(s.hordeWaves));
    return round(clamp(60 + Math.min(120, waves * 15) + Math.min(40, num(s.kills) * 2), 60, 220));
  }
  const totalTeams = Math.max(1, Math.floor(num(s.totalTeams, 16)));
  // 非法名次（缺失/0/负数）按垫底处理：坏数据不该被当成吃鸡白送经验
  const rawPlace = num(s.placement, totalTeams);
  const placement = rawPlace >= 1 ? clamp(rawPlace, 1, totalTeams) : totalTeams;
  const won = !!s.won || placement === 1;
  // 名次分：第 1 名满分，垫底为 0
  const placementScore = totalTeams > 1 ? 1 - (placement - 1) / (totalTeams - 1) : 1;
  const xp = 80
    + 80 * clamp(placementScore, 0, 1)
    + Math.min(50, Math.max(0, num(s.kills)) * 7)
    + Math.min(35, Math.max(0, num(s.survived)) / 12)
    + (won ? 25 : 0);
  return round(clamp(xp, 80, 260));
}

// ---------- 赛季经验 → 等级 ----------
export function tierFromXp(xp) {
  const total = Math.max(0, Math.floor(num(xp)));
  const tier = clamp(Math.floor(total / XP_PER_TIER) + 1, 1, SEASON_TIERS);
  const maxed = tier >= SEASON_TIERS;
  const base = (tier - 1) * XP_PER_TIER;
  const intoTier = maxed ? XP_PER_TIER : Math.min(XP_PER_TIER, total - base);
  const needed = maxed ? 0 : XP_PER_TIER;
  return {
    tier, totalXp: total, maxed,
    intoTier, needed,
    xpToNext: maxed ? 0 : XP_PER_TIER - intoTier,
    progress: maxed ? 1 : clamp(intoTier / XP_PER_TIER, 0, 1),
  };
}
// xpForTier(tier)：到达该等级所需的累计赛季经验（tier 1 = 0）
export function xpForTier(tier) {
  const t = clamp(Math.floor(num(tier, 1)), 1, SEASON_TIERS);
  return (t - 1) * XP_PER_TIER;
}

// ---------- 档位奖励查询 ----------
export function rewardForTier(tier, track = 'free') {
  const t = Math.floor(num(tier));
  const list = track === 'paid' ? PAID_TIER_REWARDS : FREE_TIER_REWARDS;
  return list.find(r => r.tier === t) || null;
}
export function rewardsUpto(tier, track = 'free') {
  const t = clamp(Math.floor(num(tier, 1)), 1, SEASON_TIERS);
  const list = track === 'paid' ? PAID_TIER_REWARDS : FREE_TIER_REWARDS;
  return list.filter(r => r.tier <= t);
}
// 高级轨开放条件：赛季等级 ≥ 10 或 段位 ≥ 黄金；满足一次后由 SeasonTracker 记入存档
export function paidTrackUnlocked(level = 1, rating = 0) {
  return Math.floor(num(level, 1)) >= 10 || num(rating) >= 620;
}

// ---------- 赛季时间 ----------
const DAY_MS = 86400000;
function parseDate(iso, endOfDay = false) {
  const parts = String(iso || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function seasonStart() { return parseDate(SEASON.startAt, false); }
export function seasonEnd() { return parseDate(SEASON.endAt, true); }

// 剩余天数：按自然日计（赛季最后一天 = 0），赛季前为整段长度，结束后恒为 0。
// 用自然日而非毫秒，UI 上「还剩 0 天」就是最后一天，不会出现 0.4 天这种读数。
export function seasonDaysLeft(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const end = parseDate(SEASON.endAt, false);
  if (!end || Number.isNaN(date.getTime())) return 0;
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.max(0, Math.round((end.getTime() - today.getTime()) / DAY_MS));
}
// 已过天数：赛季首日为第 1 天
export function seasonDaysElapsed(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const start = seasonStart();
  if (!start || Number.isNaN(date.getTime())) return 0;
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.max(0, Math.round((today.getTime() - start.getTime()) / DAY_MS) + 1);
}
export function seasonProgress(now = new Date()) {
  const start = seasonStart(); const end = seasonEnd();
  if (!start || !end) return 0;
  const date = now instanceof Date ? now : new Date(now);
  return clamp((date.getTime() - start.getTime()) / (end.getTime() - start.getTime()), 0, 1);
}

// 'preseason' | 'active' | 'ending' | 'ended'
export function seasonPhase(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const start = seasonStart(); const end = seasonEnd();
  if (!start || !end || Number.isNaN(date.getTime())) return 'ended';
  if (date.getTime() < start.getTime()) return 'preseason';
  if (date.getTime() > end.getTime()) return 'ended';
  return seasonDaysLeft(date) <= ENDING_DAYS ? 'ending' : 'active';
}
export const PHASE_LABELS = { preseason: '赛季未启', active: '赛季进行中', ending: '赛季收官', ended: '赛季已结束' };
export function seasonPhaseLabel(now = new Date()) { return PHASE_LABELS[seasonPhase(now)] || ''; }

// 当前赛季的 dayKey 边界（供测试与 UI 倒计时用）
export function seasonDayKey(now = new Date()) { return dayKey(now); }
