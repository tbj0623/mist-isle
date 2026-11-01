// 雾岛突围 / MIST ISLE — 武器精通存档层（纯逻辑，无 DOM）
// ─────────────────────────────────────────────────────────────────────────────
// 只依赖 shared/data/mastery.mjs 的纯函数与 shared/data/weapons.mjs 的静态表。
// 数据落点：meta.data.mastery = { [weaponId]: { xp, level, kills, hits, matches } }
//           meta.data.masteryMeta = { lastMatchKeys: string[] }   ← 幂等去重键（最多 20）
// 兼容：老存档没有 mastery / 只有旧的 { [weaponId]: number } 或 { weapons: {...} } 两种形态，
//       load() 会走 migrate() 安全升级，不丢历史，也不会凭空空降等级。
import {
  MASTERY, MASTERY_MAX_XP, masteryTitle, masteryLevelFromXp, rewardsBetween,
  unlockCheck, masterySummary, totalMasteryLevel as sumMasteryLevels,
  masteryXpFromMatch, nextAttachmentUnlock, weaponContributions,
} from '../shared/data/mastery.mjs';
import { WEAPONS, WEAPON_ORDER } from '../shared/data/weapons.mjs';

export const MASTERY_STORAGE_FIELD = 'mastery';
export const MASTERY_META_FIELD = 'masteryMeta';
export const MAX_MATCH_KEYS = 20;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** 空条目：xp 0 表示「从未用过」，对外 level 报 0（与 masterySummary 一致）。 */
function emptyEntry() {
  return { xp: 0, level: 0, kills: 0, hits: 0, matches: 0 };
}

/** 由 xp 推出对外 level：xp<=0 → 0，否则走 1..10 曲线。 */
function levelForXp(xp) {
  return xp > 0 ? masteryLevelFromXp(xp).level : 0;
}

/** 把任意数字/对象归一成合法条目，xp 封顶 MASTERY_MAX_XP。 */
function normalizeEntry(raw) {
  if (raw == null) return emptyEntry();
  const source = typeof raw === 'object' && !Array.isArray(raw) ? raw : { xp: raw };
  const xp = clamp(Math.floor(num(source.xp ?? source.total ?? source.exp)), 0, MASTERY_MAX_XP);
  if (xp <= 0) return emptyEntry();
  return {
    xp,
    level: levelForXp(xp),
    kills: Math.max(0, Math.floor(num(source.kills))),
    hits: Math.max(0, Math.floor(num(source.hits))),
    matches: Math.max(0, Math.floor(num(source.matches))),
  };
}

/**
 * 把各种历史形态的「老精通数据」摊平成 weaponId → entry：
 *   { ar7: 500 }                      旧版直接存 XP 数字
 *   { ar7: { xp, kills } }            半成品对象
 *   { weapons: { ar7: 500 } }         带包裹层
 *   { mastery: { ar7: 500 } }         从整份存档里抠出来
 * 未知 weaponId 直接丢弃（与 client/meta.js 的 repair 口径一致）。
 */
export function migrateMastery(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  let source = raw;
  if (raw.weapons && typeof raw.weapons === 'object' && !Array.isArray(raw.weapons)) source = raw.weapons;
  else if (raw.mastery && typeof raw.mastery === 'object' && !Array.isArray(raw.mastery)) source = raw.mastery;
  const out = {};
  for (const weaponId of WEAPON_ORDER) {
    if (!(weaponId in source)) continue;
    const entry = normalizeEntry(source[weaponId]);
    if (entry.xp > 0) out[weaponId] = entry;
  }
  return out;
}

/** 去重键：优先 matchId，其次 endedAt，最后用「内容指纹」兜底。
 *  重要：shared/progression.mjs 的 matchSummaryFromState 输出的 summary **不含**
 *  matchId/endedAt，所以真实对局必须靠内容指纹识别，否则同一场比赛的两次结算会翻倍。
 *  指纹只取本局稳定字段（模式/地图/名次/击杀/伤害/时长/武器），不含随机量。 */
export function matchKeyOf(summary = {}) {
  const s = summary || {};
  if (s.matchId != null && String(s.matchId).length) return `m:${String(s.matchId)}`;
  if (s.endedAt != null && String(s.endedAt).length) return `t:${String(s.endedAt)}`;
  const parts = [s.mode, s.mapId, s.placement, s.totalTeams, s.kills, s.damage, s.survived,
    s.shotsFired, s.shotsHit, s.headshots, s.won ? 1 : 0];
  const weapons = Array.isArray(s.weapons) ? s.weapons.map(w => (typeof w === 'string' ? w : w?.id)).join(',') : '';
  const hasContent = parts.some(v => v != null && v !== '' && v !== 0) || weapons.length > 0;
  if (!hasContent) return null; // 空 summary 无法识别，交给调用方
  return `c:${parts.map(v => (v == null ? '' : v)).join('|')}#${weapons}`;
}

/** 显式键（matchId/endedAt）永远去重；内容指纹只在时间窗内去重，
 *  避免「两场数据一模一样的真实对局」被误判成重复结算。默认 120 秒。 */
const DEDUPE_WINDOW_MS = 120000;
const isExplicitKey = key => typeof key === 'string' && (key.startsWith('m:') || key.startsWith('t:'));

export class MasteryTracker {
  /** @param {object} meta client/meta.js 的 Meta 实例（或任何带 data/save 的壳） */
  constructor(meta = null) {
    this.meta = meta || null;
    this.data = {};
    this.lastMatchKeys = [];
    this.matchTimes = {};
    this.load();
  }

  /** 从 meta.data 读；缺失/损坏/旧版都会安全初始化。返回 this.data。 */
  load() {
    const host = this.meta && this.meta.data && typeof this.meta.data === 'object' ? this.meta.data : null;
    if (!host) { this.data = {}; this.lastMatchKeys = []; this.matchTimes = {}; return this.data; }
    const raw = host[MASTERY_STORAGE_FIELD];
    this.data = migrateMastery(raw);
    // 去重键：新位置优先，其次兼容早期塞在 mastery.lastMatchKeys 的写法
    const metaBox = host[MASTERY_META_FIELD];
    const legacyKeys = raw && typeof raw === 'object' && Array.isArray(raw.lastMatchKeys) ? raw.lastMatchKeys : [];
    const keys = Array.isArray(metaBox?.lastMatchKeys) ? metaBox.lastMatchKeys : legacyKeys;
    this.lastMatchKeys = keys.filter((key) => typeof key === 'string' && key.length).slice(-MAX_MATCH_KEYS);
    // 每个键的最近结算时间戳（内容指纹只在时间窗内去重）
    const times = metaBox && typeof metaBox.matchTimes === 'object' && metaBox.matchTimes ? metaBox.matchTimes : {};
    this.matchTimes = {};
    for (const key of this.lastMatchKeys) if (Number.isFinite(Number(times[key]))) this.matchTimes[key] = Number(times[key]);
    return this.data;
  }

  /** 写回 meta.data.mastery / masteryMeta 并落盘；没有 meta 时退化为内存态（测试可用）。 */
  save() {
    if (!this.meta || !this.meta.data || typeof this.meta.data !== 'object') return this.data;
    this.meta.data[MASTERY_STORAGE_FIELD] = this.data;
    // 只保留仍在 lastMatchKeys 里的时间戳，避免存档无限膨胀
    const times = {};
    for (const key of this.lastMatchKeys) if (this.matchTimes[key]) times[key] = this.matchTimes[key];
    this.matchTimes = times;
    this.meta.data[MASTERY_META_FIELD] = { lastMatchKeys: this.lastMatchKeys.slice(-MAX_MATCH_KEYS), matchTimes: times };
    try { this.meta.save?.(); } catch { /* 配额满不阻塞对局 */ }
    return this.data;
  }

  /** 旧存档迁移入口：传整份 meta.data 或单块 mastery 数据；返回迁移后的武器表。 */
  migrate(oldData) {
    const incoming = oldData && oldData.data ? oldData.data : oldData;
    const box = incoming && typeof incoming === 'object'
      ? (incoming[MASTERY_STORAGE_FIELD] ?? incoming[MASTERY_META_FIELD] ?? incoming)
      : null;
    const merged = { ...this.data };
    for (const [weaponId, entry] of Object.entries(migrateMastery(box))) {
      // 已存在的记录取 XP 更高的一方，迁移不降级已有进度
      if (!merged[weaponId] || merged[weaponId].xp < entry.xp) merged[weaponId] = entry;
    }
    this.data = merged;
    this.save();
    return this.data;
  }

  /** 清空全部精通（GM / 新档）。 */
  reset() {
    this.data = {};
    this.lastMatchKeys = [];
    this.save();
    return { ok: true, weapons: 0, totalLevel: 0 };
  }

  /**
   * 结算一局：按 summary.weapons 逐把加 XP。
   * @returns {{ updates: Array, skipped: string|null, key: string|null }}
   * 幂等：matchId / endedAt 显式键永久去重；缺省时用内容指纹，且仅在
   * DEDUPE_WINDOW_MS 时间窗内去重（防 UI 双路径重复结算，又不误杀同数据的两场真对局）。
   * loadout 仅用于平票时判断主武器（{ primary, secondary } 或字符串）。
   */
  recordMatch(summary = {}, loadout = null) {
    const s = summary && typeof summary === 'object' ? summary : {};
    const key = matchKeyOf(s);
    const now = Date.now();
    if (key && this.lastMatchKeys.includes(key)) {
      const explicit = isExplicitKey(key);
      const last = this.matchTimes[key];
      const withinWindow = Number.isFinite(last) && (now - last) <= DEDUPE_WINDOW_MS;
      if (explicit || withinWindow) return { updates: [], skipped: 'duplicate', key };
    }
    const lo = loadout && typeof loadout === 'object' ? loadout : {};
    const primary = typeof lo === 'string' ? lo : lo.primary || null;
    const contributions = weaponContributions(s);
    const updates = [];
    for (const row of contributions) {
      const weaponId = row.weaponId;
      const before = normalizeEntry(this.data[weaponId]);
      const wasMaxed = before.xp >= MASTERY_MAX_XP;
      const beforeLevel = before.xp > 0 ? levelForXp(before.xp) : 0;
      const gained = masteryXpFromMatch(s, weaponId, { primaryWeapon: primary });
      // Lv10 封顶：XP 不再增长，但击杀/命中/场次继续累计（战绩展示用）
      const nextXp = wasMaxed ? MASTERY_MAX_XP : clamp(before.xp + gained, 0, MASTERY_MAX_XP);
      const afterLevel = levelForXp(nextXp);
      const entry = {
        xp: nextXp,
        level: afterLevel,
        kills: before.kills + Math.max(0, Math.round(row.kills)),
        hits: before.hits + Math.max(0, Math.round(row.hits)),
        matches: before.matches + 1,
      };
      this.data[weaponId] = entry;
      updates.push({
        weaponId,
        name: WEAPONS[weaponId]?.name || weaponId,
        gained: nextXp - before.xp,
        before: before.xp,
        after: nextXp,
        beforeLevel,
        afterLevel,
        leveledUp: afterLevel > beforeLevel,
        maxed: afterLevel >= MASTERY.maxLevel && nextXp >= MASTERY_MAX_XP,
        rewards: afterLevel > beforeLevel ? rewardsBetween(beforeLevel, afterLevel, weaponId) : [],
        nextAt: masteryLevelFromXp(nextXp).nextAt,
      });
    }
    if (key) {
      // 指纹键可能已存在（超出时间窗的旧记录）→ 先移除再追加，保证时间戳最新
      this.lastMatchKeys = this.lastMatchKeys.filter((item) => item !== key);
      this.lastMatchKeys.push(key);
      this.matchTimes[key] = now;
      if (this.lastMatchKeys.length > MAX_MATCH_KEYS) {
        const kept = this.lastMatchKeys.slice(-MAX_MATCH_KEYS);
        this.lastMatchKeys = kept;
      }
    }
    this.save();
    return { updates, skipped: key ? null : 'no-match-key', key };
  }

  /** 单把武器视图；未使用过返回 level 0 的占位（nextAt 指向 Lv2 门槛）。 */
  get(weaponId) {
    const entry = normalizeEntry(this.data[weaponId]);
    const weapon = WEAPONS[weaponId] || null;
    const used = entry.xp > 0;
    const info = used ? masteryLevelFromXp(entry.xp) : null;
    return {
      weaponId,
      name: weapon?.name || weaponId,
      class: weapon?.cls || null,
      xp: entry.xp,
      level: used ? info.level : 0,
      title: used ? masteryTitle(info.level) : '未入门',
      kills: entry.kills,
      hits: entry.hits,
      matches: entry.matches,
      current: used ? info.current : 0,
      needed: used ? info.needed : MASTERY.xpTable[1],
      nextAt: used ? info.nextAt : MASTERY.xpTable[1],
      progress: used ? info.progress : 0,
      maxed: used ? info.maxed : false,
      unlockedAttachments: this.unlockedAttachments(weaponId),
      nextUnlock: nextAttachmentUnlock(weaponId, used ? info.level : 0),
    };
  }

  /** 18 条（含未使用武器 level 0），顺序与 WEAPON_ORDER 一致。 */
  all() {
    return masterySummary(this.data);
  }

  /** 该武器当前精通下可装的配件 id。 */
  unlockedAttachments(weaponId) {
    const entry = normalizeEntry(this.data[weaponId]);
    const level = entry.xp > 0 ? levelForXp(entry.xp) : 0;
    return unlockCheck(weaponId, level);
  }

  /** 全部武器等级之和（0..180），成就/称号用。 */
  totalMasteryLevel() {
    return sumMasteryLevels(this.data);
  }

  /** 当前配装里「因精通不足而失效」的配件（供 UI 标灰/自动卸下）。 */
  lockedAttachments(weaponId, attachmentIds = []) {
    const unlocked = new Set(this.unlockedAttachments(weaponId));
    return (Array.isArray(attachmentIds) ? attachmentIds : []).filter((id) => !unlocked.has(id));
  }

  /** 过滤配装：只保留该武器当前能装的配件（接线时 setLoadout 前调用）。 */
  sanitizeAttachments(weaponId, attachmentIds = []) {
    const unlocked = new Set(this.unlockedAttachments(weaponId));
    return (Array.isArray(attachmentIds) ? attachmentIds : []).filter((id) => unlocked.has(id));
  }

  /** 进度文案：「AR7 · 熟练 Lv2 · 120/320（37%）→ 还差 200 XP，约 1 局」 */
  describe(weaponId, xpPerMatch = 205) {
    const view = this.get(weaponId);
    if (!view.level) return `${view.name} · 未入门（首战即记录）`;
    if (view.maxed) return `${view.name} · ${view.title} Lv${view.level} · 已满级`;
    const remain = Math.max(0, view.needed - view.current);
    const games = Math.max(1, Math.ceil(remain / Math.max(1, xpPerMatch)));
    return `${view.name} · ${view.title} Lv${view.level} · ${view.current}/${view.needed}（${Math.round(view.progress * 100)}%）· 还差 ${remain} XP，约 ${games} 局`;
  }

  /** 导出可 JSON 的纯数据（备份/云同步用，不含 meta 引用）。 */
  toJSON() {
    return { mastery: JSON.parse(JSON.stringify(this.data)), lastMatchKeys: [...this.lastMatchKeys] };
  }

  /** 从 toJSON() 的产物恢复（会与现有数据取 XP 较高者合并）。 */
  fromJSON(payload) {
    if (!payload || typeof payload !== 'object') return this.data;
    this.migrate(payload.mastery || payload);
    if (Array.isArray(payload.lastMatchKeys)) {
      const merged = [...this.lastMatchKeys];
      for (const key of payload.lastMatchKeys) {
        if (typeof key === 'string' && key && !merged.includes(key)) merged.push(key);
      }
      this.lastMatchKeys = merged.slice(-MAX_MATCH_KEYS);
      this.save();
    }
    return this.data;
  }
}

export default MasteryTracker;
