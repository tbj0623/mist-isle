// 雾岛突围 / MIST ISLE — 本地存档层（客户端 localStorage；Node 测试可注入内存 storage）
// 只依赖 shared/ 纯函数，不触碰 DOM 渲染。存档 key: mist-isle-save-v1
import {
  SAVE_KEY, SAVE_VERSION, MAX_LEVEL, DEFAULT_LOADOUT, DEFAULT_SETTINGS, emptyMeta,
  levelFromXp, xpForLevel, totalXpForLevel, computeRewards, ratingDelta, rankFor,
  protectRating, achievementValue, dayKey, weekKey, pickDaily, pickWeekly,
  missionContribution, matchSummaryFromState,
} from '../shared/progression.mjs';
import { ALL_MISSIONS } from '../shared/data/missions.mjs';
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID } from '../shared/data/achievements.mjs';
import { getStoreItem, defaultSkinIds, STORE_ALL } from '../shared/data/store.mjs';
import { RANK_TIERS } from '../shared/data/ranks.mjs';
export { RANK_TIERS };

export class MemoryStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
}

function defaultStorage() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  } catch { /* 隐私模式等场景 */ }
  return new MemoryStorage();
}

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const clone = value => JSON.parse(JSON.stringify(value));

export class Meta {
  constructor(storage = null) {
    this.storage = storage || defaultStorage();
    this.key = SAVE_KEY;
    this.data = this.load();
    this.refreshMissions(new Date()); // 构造即对齐当日/当周任务并落盘
    this.save();
  }

  // ---------- 存档读写 ----------
  load() {
    let raw = null;
    try { raw = this.storage?.getItem?.(this.key) ?? null; } catch { raw = null; }
    if (!raw) return emptyMeta();
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return this.repair(parsed);
    } catch {
      return emptyMeta(); // 损坏存档 → 回到新档，避免整个游戏进入死循环
    }
  }

  repair(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyMeta();
    const base = emptyMeta();
    const data = {
      ...base,
      ...raw,
      version: SAVE_VERSION,
      xp: Math.max(0, num(raw.xp)),
      credits: Math.max(0, num(raw.credits, base.credits)),
      rating: Math.max(0, num(raw.rating)),
      peakRating: Math.max(0, num(raw.peakRating, num(raw.rating))),
      stats: { ...base.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) },
      unlocked: {
        weapons: Array.isArray(raw.unlocked?.weapons) ? [...raw.unlocked.weapons] : [],
        skins: Array.isArray(raw.unlocked?.skins) ? [...raw.unlocked.skins] : [],
        modes: Array.isArray(raw.unlocked?.modes) ? [...raw.unlocked.modes] : [...base.unlocked.modes],
        items: Array.isArray(raw.unlocked?.items) ? [...raw.unlocked.items] : [],
      },
      loadout: { ...base.loadout, ...(raw.loadout && typeof raw.loadout === 'object' ? raw.loadout : {}) },
      missions: {
        day: typeof raw.missions?.day === 'string' ? raw.missions.day : '',
        week: typeof raw.missions?.week === 'string' ? raw.missions.week : '',
        daily: raw.missions?.daily && typeof raw.missions.daily === 'object' ? raw.missions.daily : {},
        weekly: raw.missions?.weekly && typeof raw.missions.weekly === 'object' ? raw.missions.weekly : {},
      },
      achievements: raw.achievements && typeof raw.achievements === 'object' ? { ...raw.achievements } : {},
      settings: { ...base.settings, ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) },
      lastResult: raw.lastResult ?? null,
    };
    for (const id of defaultSkinIds()) if (!data.unlocked.skins.includes(id)) data.unlocked.skins.push(id);
    const levelInfo = levelFromXp(data.xp);
    data.level = levelInfo.level;
    if (!data.missions.day || !data.missions.week) this.refreshMissions(data, new Date());
    return data;
  }

  save() {
    try { this.storage?.setItem?.(this.key, JSON.stringify(this.data)); } catch { /* 配额满时不阻塞游戏 */ }
    return this.data;
  }

  get level() { return this.data.level; }
  get xp() { return this.data.xp; }
  get credits() { return this.data.credits; }
  get rating() { return this.data.rating; }
  get peakRating() { return this.data.peakRating; }
  get stats() { return this.data.stats; }
  get settings() { return this.data.settings; }
  get loadout() { return this.data.loadout; }
  get rank() { return rankFor(this.data.rating); }
  get levelInfo() { return levelFromXp(this.data.xp); }
  get xpToNext() { const info = this.levelInfo; return info.needed ? info.needed - info.current : 0; }
  // UI 兼容：ui-screens 会调用 meta.xpInfo()
  xpInfo() { return this.levelInfo; }
  rankInfo() { return rankFor(this.data.rating); }

  // ---------- 每日 / 每周任务 ----------
  refreshMissions(now = new Date(), target = this.data) {
    const day = dayKey(now), week = weekKey(now);
    const missions = target.missions || (target.missions = { day: '', week: '', daily: {}, weekly: {} });
    const resetGroup = (key, ids, prev, savedDay) => {
      const group = {};
      const samePeriod = savedDay === key;
      for (const id of ids) {
        const prior = samePeriod ? prev?.[id] : null;
        group[id] = { progress: Math.max(0, num(prior?.progress)), done: !!prior?.done, claimed: !!prior?.claimed };
      }
      return group;
    };
    if (missions.day !== day) {
      const ids = pickDaily(day);
      missions.daily = resetGroup(day, ids, missions.daily, missions.day);
      missions.day = day;
    }
    if (missions.week !== week) {
      const ids = pickWeekly(week);
      missions.weekly = resetGroup(week, ids, missions.weekly, missions.week);
      missions.week = week;
    }
    // 补齐缺失的当日条目（老存档/损坏数据）
    const ensure = (ids, group) => { for (const id of ids) if (!group[id]) group[id] = { progress: 0, done: false, claimed: false }; };
    ensure(pickDaily(missions.day), missions.daily);
    ensure(pickWeekly(missions.week), missions.weekly);
    if (target === this.data) this.save();
    return missions;
  }

  missionDefs(cadence = 'daily') {
    const group = cadence === 'weekly' ? this.data.missions.weekly : this.data.missions.daily;
    return Object.keys(group || {}).map(id => ALL_MISSIONS[id]).filter(Boolean);
  }

  missionList(cadence = 'daily') {
    this.refreshMissions(new Date());
    const group = cadence === 'weekly' ? this.data.missions.weekly : this.data.missions.daily;
    return Object.keys(group).map(id => {
      const def = ALL_MISSIONS[id];
      const entry = group[id] || { progress: 0, done: false, claimed: false };
      return def ? { ...def, progress: entry.progress, target: def.target, done: entry.done, claimed: entry.claimed, pct: clamp(entry.progress / def.target, 0, 1) } : null;
    }).filter(Boolean);
  }

  claimMission(id) {
    this.refreshMissions(new Date());
    const groups = [this.data.missions.daily, this.data.missions.weekly];
    for (const group of groups) {
      const entry = group?.[id];
      if (!entry) continue;
      const def = ALL_MISSIONS[id];
      if (!def) return { ok: false, error: 'unknown-mission' };
      if (entry.claimed) return { ok: false, error: 'already-claimed' };
      if (!entry.done) return { ok: false, error: 'not-complete' };
      entry.claimed = true;
      this.addXp(def.xp);
      this.data.credits += num(def.credits);
      this.save();
      return { ok: true, id, xp: num(def.xp), credits: num(def.credits), level: this.data.level };
    }
    return { ok: false, error: 'unknown-mission' };
  }

  // ---------- 成就 ----------
  achievementList() {
    return ACHIEVEMENTS.map(def => {
      const entry = this.data.achievements[def.id] || { progress: 0, done: false, claimed: false };
      return { ...def, progress: entry.progress, done: entry.done, claimed: entry.claimed, pct: clamp(entry.progress / def.target, 0, 1) };
    });
  }

  claimAchievement(id) {
    const def = ACHIEVEMENT_BY_ID[id];
    if (!def) return { ok: false, error: 'unknown-achievement' };
    const entry = this.data.achievements[id];
    if (!entry) return { ok: false, error: 'not-unlocked' };
    if (entry.claimed) return { ok: false, error: 'already-claimed' };
    if (!entry.done) return { ok: false, error: 'not-complete' };
    entry.claimed = true;
    this.addXp(def.xp);
    this.data.credits += num(def.credits);
    this.data.stats.creditsEarned = num(this.data.stats.creditsEarned) + num(def.credits);
    this.save();
    return { ok: true, id, xp: num(def.xp), credits: num(def.credits), level: this.data.level };
  }

  // ---------- 升级 ----------
  addXp(amount) {
    const gain = Math.max(0, num(amount));
    if (!gain) return { levelUp: false, level: this.data.level };
    const before = this.data.level;
    this.data.xp += gain;
    const info = levelFromXp(this.data.xp);
    this.data.level = info.level;
    return { levelUp: info.level > before, before, level: info.level, gained: gain };
  }

  // ---------- 单局结算 ----------
  addMatchResult(summary = {}) {
    const safe = { ...summary };
    this.refreshMissions(new Date());
    const stats = this.data.stats;
    const lossStreak = num(stats.lossStreak);
    const delta = summary.mode === 'training' ? 0 : ratingDelta({ ...safe, totalTeams: num(safe.totalTeams, 16), lossStreak });
    const rewards = computeRewards(safe, {
      level: this.data.level, stats: { ...stats }, ratingDelta: delta,
    });
    this.updateStats(safe);
    // 任务进度
    const missionsCompleted = [];
    for (const cadence of ['daily', 'weekly']) {
      const group = this.data.missions[cadence] || {};
      for (const [id, entry] of Object.entries(group)) {
        const def = ALL_MISSIONS[id];
        if (!def || entry.done) continue;
        entry.progress = Math.min(def.target, num(entry.progress) + missionContribution(def.metric, safe));
        if (entry.progress >= def.target) { entry.done = true; missionsCompleted.push({ id, title: def.title, xp: def.xp, credits: def.credits }); }
      }
    }
    // 成就进度（解锁只记录一次）
    const achievementsCompleted = [];
    for (const def of ACHIEVEMENTS) {
      let entry = this.data.achievements[def.id];
      if (entry?.done) continue;
      const value = achievementValue(def.metric, safe, this.data.stats);
      if (!entry) entry = this.data.achievements[def.id] = { progress: 0, done: false, claimed: false };
      entry.progress = Math.min(def.target, Math.max(num(entry.progress), value));
      if (entry.progress >= def.target) { entry.done = true; entry.claimed = false; achievementsCompleted.push({ id: def.id, title: def.title, xp: def.xp, credits: def.credits }); }
    }
    // 评级（连败保护）
    if (summary.mode !== 'training') {
      const result = protectRating(this.data.rating, delta, lossStreak);
      this.data.rating = result.rating;
      this.data.peakRating = Math.max(num(this.data.peakRating), result.rating);
      this.ratingChange = { delta: result.delta, protected: result.protected, promoted: result.promoted, demoted: result.demoted, ...result.to };
    }
    const xpGain = num(rewards.xp), creditGain = num(rewards.credits);
    const levelUpInfo = this.addXp(xpGain);
    this.data.credits = Math.max(0, num(this.data.credits) + creditGain);
    this.data.stats.creditsEarned = num(this.data.stats.creditsEarned) + creditGain;
    const payload = {
      summary: safe, xp: xpGain, credits: creditGain,
      levelUp: levelUpInfo.levelUp, oldLevel: levelUpInfo.before ?? levelUpInfo.level, newLevel: this.data.level,
      missionsCompleted, achievementsCompleted, ratingDelta: summary.mode === 'training' ? 0 : num(this.ratingChange?.delta, delta),
      rating: this.data.rating, rank: rankFor(this.data.rating), totalXp: this.data.xp,
    };
    this.data.lastResult = { mode: safe.mode, won: !!safe.won, placement: num(safe.placement), kills: num(safe.kills), xp: xpGain, credits: creditGain, level: this.data.level, at: Date.now() };
    this.save();
    return payload;
  }

  updateStats(summary = {}) {
    const s = this.data.stats;
    const placed = num(summary.placement, 99);
    s.matches = num(s.matches) + 1;
    s.kills = num(s.kills) + num(summary.kills);
    s.damage = num(s.damage) + num(summary.damage);
    s.survived = num(s.survived) + num(summary.survived);
    s.assists = num(s.assists) + num(summary.assists);
    s.downs = num(s.downs) + num(summary.downs);
    s.headshots = num(s.headshots) + num(summary.headshots);
    s.revives = num(s.revives) + num(summary.revives);
    s.pickups = num(s.pickups) + num(summary.pickups);
    s.vehicles = num(s.vehicles) + num(summary.vehiclesUsed);
    s.vehicleRams = num(s.vehicleRams) + num(summary.vehicleRams);
    s.bossKills = num(s.bossKills) + num(summary.bossKills);
    if (summary.won) {
      s.wins = num(s.wins) + 1;
      s.streak = num(s.streak) + 1;
      s.bestStreak = Math.max(num(s.bestStreak), num(s.streak));
      if (num(summary.damageTaken) === 0) s.unscathedWins = num(s.unscathedWins) + 1;
    } else {
      s.streak = 0;
    }
    s.lossStreak = summary.won ? 0 : num(s.lossStreak) + 1;
    s.top3Streak = placed <= 3 ? num(s.top3Streak) + 1 : 0;
    s.bestTop3Streak = Math.max(num(s.bestTop3Streak), num(s.top3Streak));
    s.bestPlacement = num(s.bestPlacement) ? Math.min(num(s.bestPlacement), placed) : placed;
    const accuracy = num(summary.shotsFired) > 0 ? (num(summary.shotsHit) / num(summary.shotsFired)) * 100 : 0;
    s.accuracyBest = Math.max(num(s.accuracyBest), round1(accuracy));
    s.hordeWaves = Math.max(num(s.hordeWaves), num(summary.hordeWaves));
    if (summary.timeOfDay === 'night' || summary.weather === 'snow') s.nightMatches = num(s.nightMatches) + 1;
    if (!summary.aliveAtEnd && num(summary.survived) < 20) s.earlyDeaths = num(s.earlyDeaths) + 1;
    const used = normalizeWeapons(summary.weapons ?? summary.weaponsUsed);
    if (used.length) {
      s.weaponsUsed = { ...(s.weaponsUsed || {}) };
      for (const weapon of used) s.weaponsUsed[weapon] = 1;
    }
    return s;
  }

  // ---------- 商店 / 外观 ----------
  isUnlocked(kind, id) {
    const k = String(kind || '').toLowerCase();
    const cosmetics = [...(this.data.unlocked.skins || []), ...(this.data.unlocked.items || [])];
    if (k === 'character' || k === 'skin' || k === 'skins') return cosmetics.includes(id);
    if (k === 'weapon' || k === 'weapons') return this.data.unlocked.weapons.includes(id);
    if (k === 'weaponSkin' || k === 'weaponskins') return this.data.unlocked.items.includes(id);
    if (k === 'mode' || k === 'modes') return this.data.unlocked.modes.includes(id);
    if (k === 'item' || k === 'store' || k === 'other') return cosmetics.includes(id);
    return cosmetics.includes(id);
  }

  ownsAny(entry) {
    return !!(this.data.unlocked.skins.includes(entry.id) || this.data.unlocked.items.includes(entry.id));
  }

  buySkin(skinId) {
    const item = getStoreItem(skinId);
    if (!item) return { ok: false, error: 'unknown-skin' };
    // 兼容旧 UI：商店任何外观都通过 buySkin 下单，非角色皮肤转交通用购买。
    if (item.kind !== 'character') return this.buyStoreItem(skinId);
    if (this.data.unlocked.skins.includes(skinId)) return { ok: true, already: true, id: skinId, credits: this.data.credits };
    if (num(this.data.level) < num(item.unlockLevel, 1)) return { ok: false, error: 'level-required', level: num(item.unlockLevel, 1) };
    if (num(this.data.credits) < num(item.price)) return { ok: false, error: 'not-enough-credits', price: num(item.price), credits: this.data.credits };
    this.data.credits = num(this.data.credits) - num(item.price);
    this.data.unlocked.skins.push(skinId);
    this.save();
    return { ok: true, id: skinId, price: num(item.price), credits: this.data.credits };
  }

  equipSkin(skinId) {
    const item = getStoreItem(skinId);
    if (!item || !this.ownsAny(item)) return { ok: false, error: 'locked' };
    if (item.kind === 'character' || item.kind === 'weapon') {
      const key = item.kind === 'character' ? 'skin' : 'weaponSkin';
      this.data.loadout[key] = skinId;
    } else {
      this.data.loadout.slot = { ...(this.data.loadout.slot || {}), [item.slot || 'other']: skinId };
    }
    this.save();
    return { ok: true, skin: this.data.loadout.skin, kind: item.kind };
  }

  // 兼容 UI：app.meta.buy('skin', id)
  buy(kind, id) {
    const k = String(kind || '').toLowerCase();
    const item = getStoreItem(id);
    if (!item) return false;
    if (k === 'skin' || item.kind === 'character') return this.buySkin(id).ok;
    return this.buyStoreItem(id).ok;
  }

  storeList() { return STORE_ALL; }

  buyStoreItem(itemId) {
    const item = getStoreItem(itemId);
    if (!item) return { ok: false, error: 'unknown-item' };
    if (item.kind === 'character') return this.buySkin(itemId);
    if (this.ownsAny(item)) return { ok: true, already: true, id: itemId, credits: this.data.credits };
    if (num(this.data.level) < num(item.unlockLevel, 1)) return { ok: false, error: 'level-required', level: num(item.unlockLevel, 1) };
    if (num(this.data.credits) < num(item.price)) return { ok: false, error: 'not-enough-credits', price: num(item.price), credits: this.data.credits };
    this.data.credits = num(this.data.credits) - num(item.price);
    this.data.unlocked.items.push(itemId);
    this.save();
    return { ok: true, id: itemId, price: num(item.price), credits: this.data.credits };
  }

  setLoadout(loadout = {}) {
    const next = { ...this.data.loadout, ...loadout };
    next.attachments = { ...this.data.loadout.attachments, ...(loadout.attachments || {}) };
    if (next.skin && !this.data.unlocked.skins.includes(next.skin)) next.skin = this.data.loadout.skin;
    this.data.loadout = next;
    this.save();
    return next;
  }

  setSettings(partial = {}) {
    this.data.settings = { ...this.data.settings, ...partial };
    this.save();
    return this.data.settings;
  }

  // ---------- 存档维护 ----------
  reset() {
    this.data = emptyMeta();
    this.refreshMissions(new Date());
    this.save();
    return this.data;
  }

  exportSave() { return JSON.stringify(this.data); }

  importSave(input) {
    let parsed = input;
    try { parsed = typeof input === 'string' ? JSON.parse(input) : input; } catch { return { ok: false, error: 'invalid-json' }; }
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'invalid-data' };
    this.data = this.repair(parsed);
    this.save();
    return { ok: true, data: this.data };
  }

  // ---------- 兼容别名 ----------
  // 旧 UI 会同时尝试 recordMatch 与 addMatchResult；结算只能发生一次，因此 recordMatch 只记录不结算。
  recordMatch(summary = {}) {
    if (!summary || typeof summary !== 'object') return null;
    this.data.recent = [{ ...summary }, ...(Array.isArray(this.data.recent) ? this.data.recent : [])].slice(0, 8);
    this.save();
    return null;
  }

  toJSON() { return clone(this.data); }
}

const round1 = value => Math.round(value * 10) / 10;
// summary.weapons 可能是字符串数组，也可能是 { id } 数组或 id→true 的映射
function normalizeWeapons(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => (typeof item === 'string' ? item : item?.id || item?.weapon)).filter(Boolean);
  if (typeof value === 'object') return Object.keys(value).filter(key => value[key]);
  if (typeof value === 'string') return [value];
  return [];
}

export function createMeta(storage = null) { return new Meta(storage); }
export { levelFromXp, xpForLevel, totalXpForLevel, rankFor, ratingDelta, dayKey, weekKey, matchSummaryFromState };
export const META_VERSION = SAVE_VERSION;
export const META_STORAGE_KEY = SAVE_KEY;
export const META_MAX_LEVEL = MAX_LEVEL;
export const DEFAULT_META_LOADOUT = DEFAULT_LOADOUT;
export const DEFAULT_META_SETTINGS = DEFAULT_SETTINGS;
export default Meta;
