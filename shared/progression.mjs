// 雾岛突围 / MIST ISLE — 成长系统纯函数（共享层，Node/浏览器同构，禁止 DOM）
// 经验/等级/段位/评级/奖励/每日每周任务/结算 summary。
import { PROGRESSION } from './rules.mjs';
import {
  DAILY_POOL, WEEKLY_POOL, ALL_MISSIONS, DAILY_PICK, WEEKLY_PICK,
  missionPool, MISSION_STREAK, MISSION_METRIC_INFO,
} from './data/missions.mjs';
import { ACHIEVEMENT_BY_ID } from './data/achievements.mjs';
import { rankFor, protectRating, demotionShield, RATING, seasonRewards } from './data/ranks.mjs';

export const MAX_LEVEL = PROGRESSION.maxLevel;
// v2：新增 streak（七日任务链）、missionStats、equipped 等字段；旧 v1 存档由 client/meta.js 迁移。
export const SAVE_VERSION = 2;
export const SAVE_KEY = 'mist-isle-save-v1';
export const DEFAULT_LOADOUT = {
  primary: 'ar7', secondary: 'p9',
  attachments: { primary: ['red_dot'], secondary: [] },
  skin: 'skin_default', throwable: 'frag', consumable: 'medkit',
};
export const DEFAULT_SETTINGS = {
  sound: true, music: true, quality: 'balanced', sensitivity: 1, autoFire: true,
  joystickScale: 1, showFps: false, haptics: true, invertY: false,
  // 玩家遥测默认关闭：必须在设置页主动开启才采集（合规底线，见 shared/telemetry.mjs）。
  telemetry: false,
};
export { MISSION_STREAK, seasonRewards, RATING };

// 虫潮单局收益上限（见 computeRewards 注释）：与一局优秀 PvP 的收益同量级。
export const HORDE_REWARD_CAP = { xp: 1800, credits: 900 };

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const round = v => Math.round(v);

let curveCache = null;
function curve() {
  if (curveCache) return curveCache;
  const levels = [0];
  for (let lv = 1; lv < MAX_LEVEL; lv++) levels.push(levels[lv - 1] + xpForLevel(lv));
  curveCache = levels;
  return levels;
}

// 升到 level+1 所需经验（level 1..59；满级后为 0）
// 曲线：100 + 17·lv^1.3；1→60 合计约 95000 XP（首级 117、末级 3508，比值约 30 倍）。
// 混合战绩（含任务/成就奖励）约 290–310 场满级；全胜约 180 场。
export function xpForLevel(level) {
  const lv = clamp(Math.floor(num(level, 1)), 1, MAX_LEVEL);
  if (lv >= MAX_LEVEL) return 0;
  return round(100 + 17 * Math.pow(lv, 1.3));
}

export function totalXpForLevel(level) { return curve()[clamp(Math.floor(num(level, 1)), 1, MAX_LEVEL) - 1]; }

export function levelFromXp(xp) {
  const total = Math.max(0, Math.floor(num(xp)));
  const table = curve();
  let level = 1;
  while (level < MAX_LEVEL && total >= table[level]) level++;
  const base = table[level - 1];
  const needed = level >= MAX_LEVEL ? 0 : table[level] - base;
  return { level, current: total - base, needed, total, maxed: level >= MAX_LEVEL, progress: needed ? clamp((total - base) / needed, 0, 1) : 1 };
}

// ---------- 日期 key ----------
const pad = n => String(n).padStart(2, '0');
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function weekKey(date = new Date()) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - day + 3); // 该周的周四决定 ISO 年
  const year = d.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${year}-W${pad(week)}`;
}

function hashKey(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function hashFloat(seed, salt) { return (hashKey(`${seed}|${salt}`) % 100000) / 100000; }

function pickFrom(pool, count, key) {
  const chosen = [];
  const used = new Set();
  for (let i = 0; chosen.length < Math.min(count, pool.length); i++) {
    const roll = hashFloat(key, `${i}#${chosen.length}`);
    let index = Math.floor(roll * pool.length) % pool.length;
    while (used.has(index)) index = (index + 1) % pool.length;
    used.add(index);
    chosen.push(pool[index]);
  }
  return chosen;
}

// 维度轮换：按 dimension 分桶，先保证每个维度最多出现一次，再补足数量。
// telemetry 任务（引擎暂缺事件）排到最后一轮，避免玩家当天接到无法推进的任务。
function pickDiverse(pool, count, key) {
  const want = Math.min(count, pool.length);
  const safe = pool.filter(m => !m.telemetry);
  const risky = pool.filter(m => m.telemetry);
  const bucketOf = mission => mission.dimension || mission.metric;
  const chosen = [];
  const seenId = new Set();
  const seenDim = new Set();
  const tryTake = (source, allowRepeatDim) => {
    const ordered = pickFrom(source, source.length, `${key}:${chosen.length}`);
    for (const mission of ordered) {
      if (chosen.length >= want) return;
      if (seenId.has(mission.id)) continue;
      const dim = bucketOf(mission);
      if (!allowRepeatDim && seenDim.has(dim)) continue;
      chosen.push(mission); seenId.add(mission.id); seenDim.add(dim);
    }
  };
  tryTake(safe, false); // 1) 不同维度、可推进
  tryTake(safe, true); // 2) 维度不够时允许重复维度
  tryTake(risky, false); // 3) 最后才用 telemetry 任务补位
  return chosen;
}

// key 既可直接传 '2026-10-18' / '2026-W42'，也可传 Date（自动转换为对应 key）
const dailySeed = key => (key instanceof Date ? dayKey(key) : String(key ?? dayKey()));
const weeklySeed = key => (key instanceof Date ? weekKey(key) : String(key ?? weekKey()));

export function pickDaily(key = dayKey()) { return pickDiverse(DAILY_POOL, DAILY_PICK, `d:${dailySeed(key)}`).map(m => m.id); }
export function pickWeekly(key = weekKey()) { return pickDiverse(WEEKLY_POOL, WEEKLY_PICK, `w:${weeklySeed(key)}`).map(m => m.id); }

// 从任意池中按维度抽 count 条（供 UI「换一批」或 GM 调试使用）；不传池则按 cadence。
export function pickDimDiverse(cadence = 'daily', count = null, key = null) {
  const pool = missionPool(cadence);
  const n = count ?? (cadence === 'weekly' ? WEEKLY_PICK : DAILY_PICK);
  const seed = key ?? (cadence === 'weekly' ? weekKey() : dayKey());
  return pickDiverse(pool, n, `${cadence[0]}:${seed}`).map(m => m.id);
}

// ---------- 任务进度 ----------
// 所有数值都来自 matchSummaryFromState 的输出字段；新增 metric 必须在这里有对应 case，
// 否则 missionProgress 恒为 0（tests/meta.test.mjs 会校验 MISSION_METRICS 全覆盖）。
export function missionContribution(metric, summary = {}) {
  const s = summary || {};
  const won = !!s.won;
  const top3 = num(s.placement, 99) <= 3 ? 1 : 0;
  switch (metric) {
    case 'kills': return num(s.kills);
    case 'wins': return won ? 1 : 0;
    case 'matches': return 1;
    case 'damage': return num(s.damage);
    case 'survived': return num(s.survived);
    case 'revives': return num(s.revives);
    case 'pickups': return num(s.pickups);
    case 'headshots': return num(s.headshots);
    case 'vehicles': return num(s.vehiclesUsed);
    case 'hordeWaves': return num(s.hordeWaves);
    case 'placementTop3': return top3;
    case 'accuracyShots': return num(s.shotsHit);
    case 'downs': return num(s.downs);
    case 'assists': return num(s.assists);
    case 'dodges': return num(s.dodges);
    case 'airdrops': return num(s.airdrops);
    case 'attachments': return num(s.attachments);
    case 'dismantles': return num(s.dismantles);
    case 'throws': return num(s.throws);
    case 'throwHits': return num(s.throwHits);
    case 'vehicleRams': return num(s.vehicleRams);
    case 'vehicleMeters': return num(s.vehicleMeters);
    case 'matchKills': return num(s.kills);
    case 'crouchKills': return num(s.crouchKills);
    case 'unscathedWins': return won && num(s.damageTaken) === 0 ? 1 : 0;
    case 'killsPistol': return num(s.killsPistol);
    case 'killsShotgun': return num(s.killsShotgun);
    case 'killsSniper': return num(s.killsSniper);
    case 'killsSmg': return num(s.killsSmg);
    case 'killsRifle': return num(s.killsRifle);
    case 'killsLmg': return num(s.killsLmg);
    case 'winsQinglan': return won && s.mapId === 'qinglan' ? 1 : 0;
    case 'winsChisha': return won && s.mapId === 'chisha' ? 1 : 0;
    case 'winsBaiye': return won && s.mapId === 'baiye' ? 1 : 0;
    case 'winsSolo': return won && s.mode === 'solo' ? 1 : 0;
    case 'winsSquad': return won && s.mode === 'squad' ? 1 : 0;
    case 'matchesSolo': return s.mode === 'solo' ? 1 : 0;
    case 'matchesSquad': return s.mode === 'squad' ? 1 : 0;
    default: return 0;
  }
}

// 单局 summary 中「会推进任务」的字段全集（与 MISSION_METRIC_INFO 一一对应）。
export const SUMMARY_METRIC_FIELDS = Object.keys(MISSION_METRIC_INFO);

// progressMap: { [id]: number | {progress} }；defs: 任务定义数组（或 id 数组）
// 兼容契约 §9 的 missionProgress(missions, summary)：第二个参数若像 summary 则直接按本局结算。
const SUMMARY_KEYS = ['mode', 'won', 'placement', 'kills', 'damage', 'survived', 'aliveAtEnd', 'totalTeams'];
const looksLikeSummary = value => !!value && typeof value === 'object'
  && SUMMARY_KEYS.some(key => key in value);

export function missionProgress(defs = [], progressMap = {}) {
  const fromSummary = looksLikeSummary(progressMap) ? progressMap : null;
  const out = {};
  for (const def of defs || []) {
    const entry = typeof def === 'string' ? { id: def, ...(ALL_MISSIONS[def] || { id: def, target: 1 }) } : def;
    if (!entry || !entry.id) continue;
    const raw = fromSummary ? null : progressMap?.[entry.id];
    const base = typeof raw === 'number' ? raw : num(raw?.progress);
    const progress = fromSummary ? missionContribution(entry.metric, fromSummary) : base;
    const target = Math.max(1, num(entry.target, 1));
    out[entry.id] = {
      id: entry.id, metric: entry.metric || 'kills', progress: Math.min(progress, target), target,
      done: progress >= target, claimed: !!raw?.claimed, pct: clamp(progress / target, 0, 1),
    };
  }
  return out;
}

// 成就进度值：累计型读 stats，单局型读 summary
export function achievementValue(metric, summary = {}, stats = {}) {
  switch (metric) {
    case 'matchKills': return num(summary.kills);
    case 'matchDamage': return num(summary.damage);
    case 'matchSurvived': return num(summary.survived);
    case 'bestAccuracy': return num(stats.bestAccuracy ?? stats.accuracyBest);
    case 'top3Streak': return num(stats.top3Streak);
    case 'winStreak': return Math.max(num(stats.streak), num(stats.winStreak));
    case 'weaponsUsed': return Array.isArray(stats.weaponsUsed) ? stats.weaponsUsed.length : Object.keys(stats.weaponsUsed || {}).length;
    case 'skinsOwned': return num(stats.skinsOwned);
    case 'winsAllMaps': return stats.wonMaps && typeof stats.wonMaps === 'object'
      ? Object.keys(stats.wonMaps).filter(k => stats.wonMaps[k]).length : 0;
    default: return num(stats[metric]);
  }
}

// ---------- 评级 ----------
// 曲线目标：赢一局最多 +90（< 最小段内跨度，不会一局跳段）；十连胜 ≥ +700（不会原地踏步）。
export function ratingDelta(result = {}) {
  const totalTeams = Math.max(1, num(result.totalTeams, 16));
  const placement = clamp(num(result.placement, totalTeams), 1, totalTeams);
  const won = !!result.won || placement === 1;
  const kills = num(result.kills);
  const damage = num(result.damage);
  const lossStreak = num(result.lossStreak);
  if (result.mode === 'horde') {
    return round(RATING.hordeBase
      + Math.min(RATING.hordeWaveCap, num(result.hordeWaves) * RATING.hordeWave)
      + Math.min(RATING.hordeKillCap, kills));
  }
  if (result.mode === 'training') return 0;
  const pct = totalTeams > 1 ? (placement - 1) / (totalTeams - 1) : 0;
  let delta = RATING.base - RATING.spread * pct;
  delta += Math.min(RATING.killCap, kills * RATING.killWeight);
  delta += Math.min(RATING.damageCap, damage / RATING.damageDivisor);
  if (won) delta += RATING.winBonus;
  if (delta < 0) {
    delta = Math.max(RATING.lossFloor, delta);
    // 连败保护：连败 ≥3 场后大幅收敛掉分（最低 -7）
    if (lossStreak >= 3) delta = Math.max(delta * RATING.streakShield, RATING.streakShieldCap);
  } else {
    delta = Math.min(RATING.maxGain, delta);
  }
  return round(delta);
}

// ---------- 单局结算 ----------
const placementScore = summary => {
  const total = Math.max(1, num(summary.totalTeams, 16));
  return clamp(1 - (clamp(num(summary.placement, total), 1, total) - 1) / total, 0, 1);
};

// computeRewards(summary, metaSnapshot[, missions])
//   metaSnapshot 可为 level 数字，或 { level, stats, missions, achievements, ratingDelta }；
//   第三个参数兼容契约 §9 的 computeRewards(summary, level, missions) 写法。
export function computeRewards(summary = {}, metaSnapshot = {}, missionsArg = null) {
  const meta = typeof metaSnapshot === 'number' ? { level: metaSnapshot } : (metaSnapshot || {});
  const missionsInput = missionsArg ?? meta.missions;
  const kills = Math.max(0, num(summary.kills));
  const damage = Math.max(0, num(summary.damage));
  const won = !!summary.won;
  const score = placementScore(summary);
  const hordeWaves = Math.max(0, num(summary.hordeWaves));
  // 基础参与经验 + 名次/击杀/伤害/救援/拾取/波次；训练模式收益封顶
  let xp = 90 + (won ? PROGRESSION.xpWin : 0) + kills * PROGRESSION.xpPerKill
    + damage * PROGRESSION.xpPerDamage + PROGRESSION.xpPlacement * (1 + score)
    + Math.min(80, num(summary.revives) * 12) + Math.min(60, num(summary.pickups) * 0.8)
    + Math.min(160, hordeWaves * 18);
  if (summary.mode === 'training') xp = Math.min(xp, 90);
  let credits = (won ? PROGRESSION.creditsWin : 0) + kills * PROGRESSION.creditsPerKill
    + PROGRESSION.creditsPlacement * (1 + score) + Math.min(40, num(summary.revives) * 8)
    + Math.min(60, hordeWaves * 6);
  if (summary.mode === 'training') credits = Math.min(credits, 40);
  // 虫潮（horde）是 PvE 刷子模式，单局经验效率是普通对局的 6 倍（实测 485 vs 80 XP/min）：
  // 20 波约等于 39 局普通对局，直接把 PvP 的成长曲线架空了。
  // 这里对 horde 单局收益设上限：XP 1800 / 信用点 900（约等于一局打得很好的 PvP），
  // 保留「打得越好拿得越多」，但不再让刷 PvE 成为唯一最优解。
  // 注意：任务/成就奖励在上限之后单独相加，不受封顶影响（那些是一次性/每日限定的）。
  if (summary.mode === 'horde') {
    xp = Math.min(xp, HORDE_REWARD_CAP.xp);
    credits = Math.min(credits, HORDE_REWARD_CAP.credits);
  }
  xp = round(xp); credits = round(credits);

  const missionDone = [];
  const missions = missionsInput;
  if (Array.isArray(missions)) {
    for (const entry of missions) {
      const def = entry.def || ALL_MISSIONS[entry.id] || null;
      if (!def || entry.done) continue;
      const before = num(entry.progress);
      const after = before + missionContribution(def.metric, summary);
      if (after >= num(def.target)) missionDone.push({ id: def.id, title: def.title, xp: num(def.xp), credits: num(def.credits) });
    }
  }
  const achievementsDone = [];
  const achievements = meta.achievements;
  if (Array.isArray(achievements)) {
    for (const entry of achievements) {
      const def = entry.def || ACHIEVEMENT_BY_ID[entry.id] || null;
      if (!def || entry.done) continue;
      const value = achievementValue(def.metric, summary, { ...(meta.stats || {}), ...(entry.stats || {}) });
      if (value >= num(def.target)) achievementsDone.push({ id: def.id, title: def.title, xp: num(def.xp), credits: num(def.credits) });
    }
  }
  for (const item of missionDone) { xp += num(item.xp); credits += num(item.credits); }
  for (const item of achievementsDone) { xp += num(item.xp); credits += num(item.credits); }
  return {
    xp, credits, missionDone, achievementsDone,
    ratingDelta: meta.ratingDelta ?? ratingDelta(summary),
    level: num(meta.level, 1),
  };
}

// ---------- 从快照构造 summary ----------
export function matchSummaryFromState(snapshot = {}, selfId = null, extra = {}) {
  const view = snapshot || {};
  const events = Array.isArray(view.events) ? view.events : [];
  const id = selfId || view.selfId || view.me?.id || null;
  const me = (view.me && (!id || view.me.id === id) ? view.me : null)
    || (Array.isArray(view.players) ? view.players.find(p => p.id === id) : null) || null;
  const count = (type, match) => events.filter(e => e.type === type && match(e)).length;
  const mine = e => e.player === id || e.attacker === id || e.by === id || e.owner === id;
  // 权威累计统计（v1.2）：模拟层在 Match 内维护 `p.stats` 并随 `me.stats` 下发。
  //
  // 为什么需要它：结算摘要过去只从「最后一帧快照的 events 窗口」派生，而
  // MAX_EVENTS=140 只能装下整局约 1839 条事件的 7.6%，且客户端结算时 sinceEventId
  // 已消费到最新、窗口为空 —— shotsFired/shotsHit/headshots/pickups/revives/throws
  // 等 12 个字段恒为 0，直接导致 35% 成就、54% 每日任务不可达。
  // 现在以 stats 为准，事件计数退化为「旧快照/离线兜底」。
  const st = (me && me.stats && typeof me.stats === 'object') ? me.stats : null;
  const statNum = (key, fallback) => {
    if (!st) return fallback;
    const v = num(st[key], NaN);
    return Number.isFinite(v) ? Math.max(0, v) : fallback;
  };
  const shotsFired = statNum('shotsFired', count('shot', e => e.player === id));
  const shotsHit = statNum('shotsHit', count('shot', e => e.player === id && !!e.hit) + count('hit', e => e.player === id));
  // 爆头计数：simulation 对同一次要害命中会同时发 shot.headshots（弹丸计数）与
  // 独立 headshot 事件——两个通道描述同一数量，求和会双计，取 max 去重；
  // 旧快照的 hit.headshot 标记（现行模拟不再产生）保持向后兼容。
  const shotHeadshots = events.reduce((acc, e) => {
    if (e.type !== 'shot' || e.player !== id || !(e.headshots > 0)) return acc;
    return acc + Math.max(1, Math.floor(num(e.headshots, 1)));
  }, 0);
  const headshots = statNum('headshots',
    Math.max(shotHeadshots, count('headshot', e => e.player === id))
    + count('hit', e => e.player === id && !!e.headshot));
  const revives = statNum('revives',
    count('revive', e => e.by === id || e.player === id) + count('revived', e => e.by === id));
  const pickups = statNum('pickups', count('pickup', e => e.player === id));
  const attachments = count('pickup', e => e.player === id && (e.kind === 'attachment' || e.itemKind === 'attachment'));
  const vehiclesUsed = count('vehicle', e => e.player === id && (e.action === 'enter' || !e.action));
  const vehicleRams = count('vehicle', e => e.action === 'hit' && num(extra.vehicleRams) === 0)
    + Math.max(0, num(extra.vehicleRams));
  const airdrops = statNum('airdrops', count('dropOpen', e => e.player === id || e.by === id));
  const dodges = statNum('dodges', count('dodge', e => e.player === id));
  const throws = statNum('throws', count('throw', e => e.player === id));
  const throwHits = count('explosion', e => e.owner === id && e.kind !== 'flash');
  const dismantles = count('dismantle', e => e.player === id);
  const crouchKills = count('kill', e => e.by === id && !!e.crouch);
  const killsBy = cls => Math.max(0, num(extra[`kills${cls}`],
    count('kill', e => e.by === id && String(e.weaponClass || '').toLowerCase() === cls.toLowerCase())));
  const weaponKills = extra.weaponsByClass && typeof extra.weaponsByClass === 'object' ? extra.weaponsByClass : {};
  const killsPistol = Math.max(killsBy('pistol'), num(weaponKills.pistol));
  const killsShotgun = Math.max(killsBy('shotgun'), num(weaponKills.shotgun));
  const killsSniper = Math.max(killsBy('sniper'), num(weaponKills.sniper));
  const killsSmg = Math.max(killsBy('smg'), num(weaponKills.smg));
  const killsRifle = Math.max(killsBy('rifle'), num(weaponKills.rifle));
  const killsLmg = Math.max(killsBy('lmg'), num(weaponKills.lmg));
  const kills = Math.max(0, num(me?.kills, count('kill', e => e.attacker === id)));
  // 事件字段是 by（不是 attacker），且 me.downs 来自 _selfView.stats；两条路都兜住。
  const downs = statNum('downs', Math.max(0, num(me?.downs, count('down', e => e.by === id || e.attacker === id))));
  const damage = Math.max(0, num(me?.damage));
  const result = view.result || null;
  const ranks = Array.isArray(result?.ranks) ? result.ranks : [];
  let placement = ranks.length + 1;
  let totalTeams = Math.max(ranks.length, num(view.counts?.teams, ranks.length || 1), 1);
  for (const row of ranks) {
    const members = Array.isArray(row.players) ? row.players : [];
    if ((me && row.team === me.team) || members.some(p => p.id === id)) { placement = num(row.rank, placement); break; }
  }
  if (me && num(me.rank) > 0) placement = num(me.rank, placement);
  placement = clamp(placement, 1, totalTeams);
  const winnerTeam = result?.winnerTeam;
  const won = !!result && (winnerTeam != null
    ? (me && winnerTeam === me.team) || ranks.some(r => r.rank === 1 && (r.team === me?.team || (r.players || []).some(p => p.id === id)))
    : placement === 1);
  const ended = view.phase === 'ended' || !!result;
  const survived = num(extra.survived, ended ? num(view.matchTime, num(view.time)) : num(view.matchTime, num(view.time)));
  // 载具里程：进入载具到离开之间按巡航速度折算（引擎没有里程事件，用时长 × 12 m/s 估算）
  const seatSeconds = Math.max(0, num(extra.seatSeconds));
  const vehicleMeters = Math.max(0, num(extra.vehicleMeters, seatSeconds * 12));
  return {
    mode: view.mode || 'squad',
    mapId: view.mapId || 'qinglan',
    weather: view.weather || 'clear',
    timeOfDay: view.timeOfDay || 'day',
    won, placement, totalTeams,
    kills, assists: statNum('assists', num(me?.assists)), damage,
    damageTaken: statNum('damageTaken', num(me?.damageTaken, num(extra.damageTaken))),
    hpLeft: num(me?.hp, num(extra.hpLeft)),
    survived: round(survived),
    shotsFired, shotsHit, headshots,
    revives, downs, pickups, vehiclesUsed,
    hordeWaves: num(view.horde?.wave, num(extra.hordeWaves)),
    aliveAtEnd: !!me?.alive, rating: num(extra.rating, num(view.rating)),
    weapons: Array.isArray(extra.weapons) ? extra.weapons : (me?.weapon ? [me.weapon] : []),
    vehicleRams, vehicleMeters, seatSeconds,
    airdrops, dodges, throws, throwHits, dismantles, attachments, crouchKills,
    killsPistol, killsShotgun, killsSniper, killsSmg, killsRifle, killsLmg,
    ...extra,
  };
}

// 契约 §9 的命名别名：matchSummary(state, selfId)
export const matchSummary = matchSummaryFromState;

// ---------- 初始存档 ----------
export function emptyMeta(base = {}) {
  return {
    version: SAVE_VERSION,
    xp: 0, level: 1, credits: 500, rating: 0, peakRating: 0,
    stats: {
      matches: 0, wins: 0, kills: 0, damage: 0, survived: 0, bestPlacement: 0,
      streak: 0, bestStreak: 0, hordeWaves: 0, assists: 0, downs: 0, headshots: 0,
      revives: 0, pickups: 0, vehicles: 0, top3Streak: 0, bestTop3Streak: 0,
      accuracyBest: 0, creditsEarned: 0, unscathedWins: 0, vehicleRams: 0,
      bossKills: 0, nightMatches: 0, earlyDeaths: 0, weaponsUsed: {},
      // v2 新增计数（任务/成就共用）
      lossStreak: 0, airdrops: 0, dodges: 0, throwHits: 0, attachments: 0,
      dismantles: 0, vehicleMeters: 0, crouchKills: 0, nightWins: 0,
      skinsOwned: 3, wonMaps: {}, killsByClass: {},
    },
    unlocked: {
      weapons: [], skins: ['skin_default', 'skin_scout', 'skin_medic'],
      modes: ['solo', 'squad', 'horde', 'training'], items: [],
    },
    loadout: { ...DEFAULT_LOADOUT, attachments: { primary: ['red_dot'], secondary: [] } },
    missions: { day: '', week: '', daily: {}, weekly: {} },
    // 七日任务链：day 为最近一次「清空全部每日任务」的日期，count 为连续天数，best 为历史最佳。
    streak: { count: 0, best: 0, day: '', claimed: [], lastRewardDay: '' },
    achievements: {},
    settings: { ...DEFAULT_SETTINGS },
    lastResult: null,
    ...base,
  };
}

// 任务链结算的纯函数：传入 meta.streak 与「昨日/今日 key + 今日是否全清」，
// 返回新的 streak 状态与是否触发七日奖励。client/meta.js 在 claimMission 后调用。
export function advanceStreak(streak = {}, todayKey = '', allCleared = false, yesterdayKey = '') {
  const prev = streak && typeof streak === 'object' ? streak : {};
  const next = {
    count: Math.max(0, num(prev.count)), best: Math.max(0, num(prev.best)),
    day: typeof prev.day === 'string' ? prev.day : '',
    claimed: Array.isArray(prev.claimed) ? [...prev.claimed] : [],
    lastRewardDay: typeof prev.lastRewardDay === 'string' ? prev.lastRewardDay : '',
  };
  if (!allCleared || !todayKey || next.day === todayKey) {
    return { streak: next, rewarded: null, extended: false };
  }
  // 昨天也清空过 → 连续；否则从 1 重新开始
  next.count = next.day === yesterdayKey ? next.count + 1 : 1;
  next.day = todayKey;
  next.best = Math.max(next.best, next.count);
  let rewarded = null;
  if (next.count > 0 && next.count % MISSION_STREAK.days === 0 && next.lastRewardDay !== todayKey) {
    next.lastRewardDay = todayKey;
    const reward = { ...MISSION_STREAK, day: todayKey, count: next.count };
    if (!next.claimed.includes(todayKey)) next.claimed.push(todayKey);
    rewarded = reward;
  }
  return { streak: next, rewarded, extended: true };
}

// 昨日 key：用于判断任务链是否连续。
export function previousDayKey(key = dayKey()) {
  const text = String(key || dayKey());
  const parts = text.split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '';
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setDate(date.getDate() - 1);
  return dayKey(date);
}

export { rankFor, protectRating, demotionShield };
export const rankInfo = rating => rankFor(rating);

// 任务 metric 元信息（UI 文案 / 排障用）
export { MISSION_METRIC_INFO };
export const missionMetricInfo = metric => MISSION_METRIC_INFO[metric] || { label: metric, source: 'unknown' };

// 兼容契约 §9 的命名：rankFor 返回 { tier, division, name, color, progress }，
// 另外提供 rankOf 作为更语义化的别名。
export const rankOf = rating => rankFor(rating);
export const ratingFor = rating => rankFor(rating);
