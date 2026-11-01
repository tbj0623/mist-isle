// 雾岛突围 / MIST ISLE — 生涯统计核心（纯逻辑，无 DOM，Node 可测）
// ─────────────────────────────────────────────────────────────────────────────
// 数据落点：meta.data.careerStats。只写这一个字段，不碰 matches/xp/credits/stats。
// 老存档（无 careerStats）构造时自动初始化；字段损坏按项修复，不整块丢弃。
// 幂等：matchId/endedAt 显式键永久去重；无显式键时用内容指纹，仅 120s 窗口内去重
//       （与 client/mastery.js 的 matchKeyOf 口径一致，避免 UI 双路径重复结算）。
import { WEAPONS } from '../shared/data/weapons.mjs';
import { weaponContributions } from '../shared/data/mastery.mjs';

export const CAREER_FIELD = 'careerStats';
export const CAREER_VERSION = 1;
export const DEDUPE_WINDOW_MS = 120000;
export const MAX_RECENT = 50;
const MAX_KEYS = 20;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const nonNeg = value => Math.max(0, num(value));
const round = (value, digits = 0) => { const p = 10 ** digits; return Math.round(value * p) / p; };

const COUNTERS = ['matches', 'wins', 'top10', 'top3', 'kills', 'deaths', 'assists', 'downs',
  'damage', 'survived', 'headshots', 'shotsFired', 'shotsHit', 'placementSum',
  'bestPlacement', 'bestKills', 'bestDamage', 'streak', 'bestStreak'];

export function emptyCareerStats() {
  return {
    v: CAREER_VERSION, matches: 0, wins: 0, top10: 0, top3: 0, kills: 0, deaths: 0,
    assists: 0, downs: 0, damage: 0, survived: 0, headshots: 0, shotsFired: 0, shotsHit: 0,
    placementSum: 0, bestPlacement: 0, bestKills: 0, bestDamage: 0, streak: 0, bestStreak: 0,
    weapons: {}, recent: [], dedupe: { keys: [], times: {} }, updatedAt: 0,
  };
}

/** 内容指纹：显式 matchId/endedAt 优先，否则取本局稳定字段（不含随机量）。 */
export function matchKeyOf(summary = {}) {
  const s = summary || {};
  if (s.matchId != null && String(s.matchId).length) return `m:${String(s.matchId)}`;
  if (s.endedAt != null && String(s.endedAt).length) return `t:${String(s.endedAt)}`;
  const parts = [s.mode, s.mapId, s.placement, s.totalTeams, s.kills, s.damage, s.survived,
    s.shotsFired, s.shotsHit, s.headshots, s.won ? 1 : 0];
  const weapons = Array.isArray(s.weapons)
    ? s.weapons.map(w => (typeof w === 'string' ? w : w?.id)).join(',') : '';
  const hasContent = parts.some(v => v != null && v !== '' && v !== 0) || weapons.length > 0;
  if (!hasContent) return null; // 空 summary 无法识别，交给调用方忽略
  return `c:${parts.map(v => (v == null ? '' : v)).join('|')}#${weapons}`;
}

function repairRecent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    at: nonNeg(entry.at), mode: typeof entry.mode === 'string' ? entry.mode : 'squad',
    mapId: typeof entry.mapId === 'string' ? entry.mapId : 'qinglan',
    placement: nonNeg(entry.placement), kills: nonNeg(entry.kills), damage: nonNeg(entry.damage),
    survived: nonNeg(entry.survived), deaths: nonNeg(entry.deaths), assists: nonNeg(entry.assists),
    headshots: nonNeg(entry.headshots), won: !!entry.won,
  };
}

/** 把任意历史/损坏的 careerStats 修补成合法结构（缺字段补 0，不丢可读数据）。 */
export function repairCareerStats(raw) {
  const state = emptyCareerStats();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  for (const key of COUNTERS) state[key] = nonNeg(raw[key]);
  if (raw.weapons && typeof raw.weapons === 'object' && !Array.isArray(raw.weapons)) {
    for (const [id, entry] of Object.entries(raw.weapons)) {
      if (!WEAPONS[id] || !entry || typeof entry !== 'object') continue;
      state.weapons[id] = { kills: nonNeg(entry.kills), damage: nonNeg(entry.damage), matches: nonNeg(entry.matches) };
    }
  }
  if (Array.isArray(raw.recent)) state.recent = raw.recent.map(repairRecent).filter(Boolean).slice(0, MAX_RECENT);
  const dedupe = raw.dedupe && typeof raw.dedupe === 'object' ? raw.dedupe : {};
  const keys = Array.isArray(dedupe.keys)
    ? dedupe.keys.filter(key => typeof key === 'string' && key.length).slice(-MAX_KEYS) : [];
  const times = dedupe.times && typeof dedupe.times === 'object' ? dedupe.times : {};
  state.dedupe = { keys, times: {} };
  for (const key of keys) if (Number.isFinite(Number(times[key]))) state.dedupe.times[key] = Number(times[key]);
  return state;
}

export class CareerStats {
  /** @param {object} meta client/meta.js 的 Meta 实例（或任何带 data/save 的壳） */
  constructor(meta = null) {
    this.meta = meta || null;
    this.state = emptyCareerStats();
    this._host = null;
    this._sync();
    const host = this.meta && this.meta.data;
    // 老存档自动初始化（首次构造即落盘，UI 可直接读 meta.data.careerStats）
    if (host && typeof host === 'object' && !host[CAREER_FIELD]) this.save();
  }

  /** meta.data 被整体替换（reset / importSave）时自动重新加载，避免把旧统计写回新档。 */
  _sync() {
    const host = this.meta && typeof this.meta === 'object' ? this.meta.data : null;
    if (!host || typeof host !== 'object') return this.state;
    if (this._host !== host) {
      this._host = host;
      this.state = repairCareerStats(host[CAREER_FIELD]);
    }
    return this.state;
  }

  save() {
    const host = this.meta && this.meta.data;
    if (!host || typeof host !== 'object') return this.state;
    host[CAREER_FIELD] = this.state;
    this._host = host;
    try { this.meta.save?.(); } catch { /* 配额满不阻塞对局 */ }
    return this.state;
  }

  reset() {
    this._sync();
    this.state = emptyCareerStats();
    this.save();
    return { ok: true, matches: 0 };
  }

  /**
   * 结算一局。训练场不计入生涯（与武器精通口径一致）。
   * @returns {{ ok: boolean, key?: string|null, matches?: number, skipped?: string }}
   */
  recordMatch(summary = {}) {
    const s = summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : null;
    if (!s) return { ok: false, skipped: 'invalid' };
    if (s.mode === 'training') return { ok: false, skipped: 'training' };
    this._sync();
    const state = this.state;
    const clock = Date.now();
    const key = matchKeyOf(s);
    if (key && state.dedupe.keys.includes(key)) {
      const last = nonNeg(state.dedupe.times[key]);
      const explicit = key.startsWith('m:') || key.startsWith('t:');
      if (explicit || (last > 0 && clock - last <= DEDUPE_WINDOW_MS)) {
        return { ok: false, skipped: 'duplicate', key };
      }
    }
    const kills = nonNeg(s.kills);
    const damage = nonNeg(s.damage);
    const survived = nonNeg(s.survived);
    const placement = nonNeg(s.placement);
    const totalTeams = Math.max(1, num(s.totalTeams, 16));
    const won = !!s.won;
    // 死亡：BR 里「未存活到终局」记 1 次；summary 显式给 deaths 时以它为准。
    const deaths = s.deaths != null ? nonNeg(s.deaths) : (s.aliveAtEnd ? 0 : 1);
    const at = nonNeg(s.at) || nonNeg(s.endedAt) || clock;

    state.matches += 1;
    state.kills += kills;
    state.deaths += deaths;
    state.assists += nonNeg(s.assists);
    state.downs += nonNeg(s.downs);
    state.damage += damage;
    state.survived += survived;
    state.headshots += nonNeg(s.headshots);
    state.shotsFired += nonNeg(s.shotsFired);
    state.shotsHit += nonNeg(s.shotsHit);
    if (won) state.wins += 1;
    if (placement > 0) {
      state.placementSum += placement;
      if (placement <= Math.min(10, totalTeams)) state.top10 += 1;
      if (placement <= 3) state.top3 += 1;
      state.bestPlacement = state.bestPlacement ? Math.min(state.bestPlacement, placement) : placement;
    }
    state.streak = won ? state.streak + 1 : 0;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
    state.bestKills = Math.max(state.bestKills, kills);
    state.bestDamage = Math.max(state.bestDamage, damage);
    state.updatedAt = clock;

    // 武器归因：summary.weapons 支持 id 数组 / {id,kills} 数组 / 映射；无分枪数据时按把均分。
    const rows = weaponContributions(s);
    const totalWeaponKills = rows.reduce((acc, row) => acc + nonNeg(row.kills), 0);
    for (const row of rows) {
      const entry = state.weapons[row.weaponId]
        || (state.weapons[row.weaponId] = { kills: 0, damage: 0, matches: 0 });
      const own = s.weaponStats && s.weaponStats[row.weaponId] ? s.weaponStats[row.weaponId].damage : null;
      const share = totalWeaponKills > 0 ? nonNeg(row.kills) / totalWeaponKills : 1 / rows.length;
      entry.kills += nonNeg(row.kills);
      entry.damage += own != null && Number.isFinite(Number(own)) ? Number(own) : damage * share;
      entry.matches += 1;
    }

    state.recent.unshift({
      at, mode: typeof s.mode === 'string' ? s.mode : 'squad',
      mapId: typeof s.mapId === 'string' ? s.mapId : 'qinglan',
      placement, kills, damage, survived, deaths,
      assists: nonNeg(s.assists), headshots: nonNeg(s.headshots), won,
    });
    if (state.recent.length > MAX_RECENT) state.recent.length = MAX_RECENT;

    if (key) {
      state.dedupe.keys = [...state.dedupe.keys.filter(item => item !== key), key].slice(-MAX_KEYS);
      const times = {};
      for (const item of state.dedupe.keys) if (state.dedupe.times[item]) times[item] = state.dedupe.times[item];
      times[key] = clock;
      state.dedupe.times = times;
    }
    this.save();
    return { ok: true, key, matches: state.matches };
  }

  /** career 页顶部的聚合数字（全部为数字，空存档返回 0，不返回 null/NaN）。 */
  summary() {
    this._sync();
    const st = this.state;
    const matches = st.matches;
    const kd = st.deaths > 0 ? st.kills / st.deaths : st.kills; // 零死亡不除零
    return {
      matches, wins: st.wins, losses: Math.max(0, matches - st.wins),
      top10: st.top10, top3: st.top3,
      kills: st.kills, deaths: st.deaths, assists: st.assists, downs: st.downs,
      damage: st.damage, survived: st.survived,
      headshots: st.headshots, shotsFired: st.shotsFired, shotsHit: st.shotsHit,
      bestPlacement: st.bestPlacement, bestKills: st.bestKills, bestDamage: st.bestDamage,
      streak: st.streak, bestStreak: st.bestStreak,
      kd: round(kd, 2),
      winRate: matches ? round(st.wins / matches, 3) : 0,          // 0..1
      winRatePct: matches ? round((st.wins / matches) * 100, 1) : 0, // 0..100
      avgKills: matches ? round(st.kills / matches, 2) : 0,
      avgDamage: matches ? round(st.damage / matches, 1) : 0,
      avgSurvival: matches ? round(st.survived / matches, 1) : 0,
      avgPlacement: matches ? round(st.placementSum / matches, 1) : 0,
      headshotRate: st.shotsHit > 0 ? round((st.headshots / st.shotsHit) * 100, 1) : 0,
      accuracy: st.shotsFired > 0 ? round((st.shotsHit / st.shotsFired) * 100, 1) : 0,
      playTime: st.survived,
      updatedAt: st.updatedAt,
    };
  }

  /** 武器使用分布，按击杀降序；share 为「占全部武器击杀」的 0..1 比例。 */
  weaponBreakdown() {
    this._sync();
    const rows = Object.entries(this.state.weapons).map(([weaponId, entry]) => ({
      weaponId,
      name: WEAPONS[weaponId]?.name || weaponId,
      kills: entry.kills,
      damage: round(entry.damage, 0),
      matches: entry.matches,
      share: 0,
    }));
    const total = rows.reduce((acc, row) => acc + row.kills, 0);
    for (const row of rows) row.share = total > 0 ? round(row.kills / total, 3) : 0;
    rows.sort((a, b) => b.kills - a.kills || b.damage - a.damage || a.weaponId.localeCompare(b.weaponId));
    return rows;
  }

  /** 最近战绩，新→旧；字段固定为 UI 契约里的 7 个。 */
  recentMatches(limit = 10) {
    this._sync();
    const n = Math.max(0, Math.min(MAX_RECENT, Math.floor(num(limit, 10))));
    return this.state.recent.slice(0, n).map(entry => ({
      at: entry.at, mode: entry.mode, mapId: entry.mapId, placement: entry.placement,
      kills: entry.kills, damage: entry.damage, won: !!entry.won,
    }));
  }

  /** 最近 N 局某指标的走势（旧→新），长度 = min(buckets, 已记录局数)。 */
  trend(metric, buckets = 10) {
    this._sync();
    const field = TREND_FIELDS[metric];
    if (!field) return [];
    const n = Math.max(1, Math.min(MAX_RECENT, Math.floor(num(buckets, 10))));
    return this.state.recent.slice(0, n).reverse()
      .map(entry => (field === 'won' ? (entry.won ? 1 : 0) : num(entry[field])));
  }
}

const TREND_FIELDS = {
  kills: 'kills', damage: 'damage', placement: 'placement', survived: 'survived',
  won: 'won', deaths: 'deaths', assists: 'assists', headshots: 'headshots',
};

export default CareerStats;
