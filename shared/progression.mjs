// 雾岛突围 / MIST ISLE — 成长系统纯函数（共享层，Node/浏览器同构，禁止 DOM）
// 经验/等级/段位/评级/奖励/每日每周任务/结算 summary。
import { PROGRESSION } from './rules.mjs';
import { DAILY_POOL, WEEKLY_POOL, ALL_MISSIONS, DAILY_PICK, WEEKLY_PICK } from './data/missions.mjs';
import { ACHIEVEMENT_BY_ID } from './data/achievements.mjs';
import { rankFor, protectRating, demotionShield } from './data/ranks.mjs';

export const MAX_LEVEL = PROGRESSION.maxLevel;
export const SAVE_VERSION = 1;
export const SAVE_KEY = 'mist-isle-save-v1';
export const DEFAULT_LOADOUT = {
  primary: 'ar7', secondary: 'p9',
  attachments: { primary: ['red_dot'], secondary: [] },
  skin: 'skin_default', throwable: 'frag', consumable: 'medkit',
};
export const DEFAULT_SETTINGS = {
  sound: true, music: true, quality: 'balanced', sensitivity: 1, autoFire: true,
  joystickScale: 1, showFps: false, haptics: true, invertY: false,
};

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

// key 既可直接传 '2026-10-18' / '2026-W42'，也可传 Date（自动转换为对应 key）
const dailySeed = key => (key instanceof Date ? dayKey(key) : String(key ?? dayKey()));
const weeklySeed = key => (key instanceof Date ? weekKey(key) : String(key ?? weekKey()));

export function pickDaily(key = dayKey()) { return pickFrom(DAILY_POOL, DAILY_PICK, `d:${dailySeed(key)}`).map(m => m.id); }
export function pickWeekly(key = weekKey()) { return pickFrom(WEEKLY_POOL, WEEKLY_PICK, `w:${weeklySeed(key)}`).map(m => m.id); }

// ---------- 任务进度 ----------
export function missionContribution(metric, summary = {}) {
  const top3 = num(summary.placement, 99) <= 3 ? 1 : 0;
  switch (metric) {
    case 'kills': return num(summary.kills);
    case 'wins': return summary.won ? 1 : 0;
    case 'matches': return 1;
    case 'damage': return num(summary.damage);
    case 'survived': return num(summary.survived);
    case 'revives': return num(summary.revives);
    case 'pickups': return num(summary.pickups);
    case 'headshots': return num(summary.headshots);
    case 'vehicles': return num(summary.vehiclesUsed);
    case 'hordeWaves': return num(summary.hordeWaves);
    case 'placementTop3': return top3;
    case 'accuracyShots': return num(summary.shotsHit);
    case 'downs': return num(summary.downs);
    default: return 0;
  }
}

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
    default: return num(stats[metric]);
  }
}

// ---------- 评级 ----------
export function ratingDelta(result = {}) {
  const totalTeams = Math.max(1, num(result.totalTeams, 16));
  const placement = clamp(num(result.placement, totalTeams), 1, totalTeams);
  const won = !!result.won || placement === 1;
  const kills = num(result.kills);
  const damage = num(result.damage);
  const lossStreak = num(result.lossStreak);
  if (result.mode === 'horde') {
    return round(6 + Math.min(30, num(result.hordeWaves) * 3) + Math.min(8, kills));
  }
  if (result.mode === 'training') return 0;
  const pct = totalTeams > 1 ? (placement - 1) / (totalTeams - 1) : 0;
  let delta = 42 - 68 * pct;
  delta += Math.min(14, kills * 2.2);
  delta += Math.min(10, damage / 180);
  if (won) delta += 16;
  if (delta < 0) {
    delta = Math.max(-34, delta);
    if (lossStreak >= 3) delta = Math.max(delta * 0.35, -7); // 连败保护
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
  const mine = e => e.player === id || e.attacker === id || e.by === id;
  const shotsFired = count('shot', e => e.player === id);
  const shotsHit = count('shot', e => e.player === id && !!e.hit) + count('hit', e => e.player === id);
  const headshots = count('hit', e => e.player === id && !!e.headshot);
  const revives = count('revive', e => e.by === id || e.player === id);
  const pickups = count('pickup', e => e.player === id);
  const vehiclesUsed = count('vehicle', e => e.player === id && (e.action === 'enter' || !e.action));
  const kills = Math.max(0, num(me?.kills, count('kill', e => e.attacker === id)));
  const downs = Math.max(0, num(me?.downs, count('down', e => e.attacker === id)));
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
  return {
    mode: view.mode || 'squad',
    mapId: view.mapId || 'qinglan',
    weather: view.weather || 'clear',
    timeOfDay: view.timeOfDay || 'day',
    won, placement, totalTeams,
    kills, assists: num(me?.assists), damage,
    damageTaken: num(me?.damageTaken, num(extra.damageTaken)),
    survived: round(survived),
    shotsFired, shotsHit, headshots,
    revives, downs, pickups, vehiclesUsed,
    hordeWaves: num(view.horde?.wave, num(extra.hordeWaves)),
    aliveAtEnd: !!me?.alive, rating: num(extra.rating, num(view.rating)),
    weapons: Array.isArray(extra.weapons) ? extra.weapons : (me?.weapon ? [me.weapon] : []),
    vehicleRams: num(extra.vehicleRams),
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
    },
    unlocked: {
      weapons: [], skins: ['skin_default', 'skin_scout', 'skin_medic'],
      modes: ['solo', 'squad', 'horde', 'training'], items: [],
    },
    loadout: { ...DEFAULT_LOADOUT, attachments: { primary: ['red_dot'], secondary: [] } },
    missions: { day: '', week: '', daily: {}, weekly: {} },
    achievements: {},
    settings: { ...DEFAULT_SETTINGS },
    lastResult: null,
    ...base,
  };
}

export { rankFor, protectRating, demotionShield };
export const rankInfo = rating => rankFor(rating);

// 兼容契约 §9 的命名：rankFor 返回 { tier, division, name, color, progress }，
// 另外提供 rankOf 作为更语义化的别名。
export const rankOf = rating => rankFor(rating);
export const ratingFor = rating => rankFor(rating);
