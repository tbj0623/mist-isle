// 雾岛突围 / MIST ISLE 1.1 — 客户端遥测包装（owner: telemetry · client/telemetry.js）
// ─────────────────────────────────────────────────────────────────────────────
// 设计原则（合规硬约束）：
//   1) 默认关闭：只有 meta.settings.telemetry === true 才创建采集器；否则整个类
//      退化成 no-op（track() 直接 return），连 sessionId 都不生成。
//   2) 匿名：sessionId 每次启动随机生成（sessionStorage 内复用以区分标签页），
//      不含昵称、账号、设备信息。
//   3) 联机才上报：endpoint 用同源 /telemetry；离线对局只写 localStorage 缓冲
//      （最多 500 条），下次联机时补发；玩家关闭开关时立即清空本地缓冲。
//   4) 不上传 PII：字段由 shared/telemetry.mjs 的白名单 + sanitize 双重过滤。
// 本文件只依赖 shared/telemetry.mjs 与浏览器全局（fetch/localStorage/performance）。
import { Telemetry, sanitize } from '../shared/telemetry.mjs';

const OFFLINE_KEY = 'mist-isle-telemetry-pending-v1';
const OFFLINE_MAX = 500;
const SAMPLE_RATE = 20; // weapon_fire 1/20 采样
export const TELEMETRY_VERSION = 1;

const isBrowser = typeof window !== 'undefined';

/** 内存兜底（Node/隐私模式）：接口与 localStorage 一致，便于单测离线缓冲逻辑。 */
const memoryStore = { map: new Map(), getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
  setItem(k, v) { this.map.set(String(k), String(v)); }, removeItem(k) { this.map.delete(k); }
};
/** localStorage 兜底：隐私模式/配额满或非浏览器环境时退回内存 store，绝不抛。 */
function safeStorage() {
  try { if (isBrowser && window.localStorage) return window.localStorage; } catch { /* 隐私模式 */ }
  return memoryStore;
}
function readJson(key, fallback) {
  try { const raw = safeStorage().getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { safeStorage().setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** 取（或创建）标签页级 sessionId：sessionStorage 存活期 = 一次浏览会话。 */
function sessionIdFor() {
  try {
    const store = isBrowser ? window.sessionStorage : null;
    const key = 'mist-isle-telemetry-sid';
    const existing = store?.getItem(key);
    if (existing) return existing;
    const id = globalThis.crypto?.randomUUID?.() || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    store?.setItem(key, id);
    return id;
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export class TelemetryClient {
  /**
   * @param {object} app  main.js 的 app 对象（可选，用于读 settings/meta）
   * @param {object} opts { enabled, endpoint, fetchImpl, now, flushMs }
   */
  constructor(app = null, opts = {}) {
    this.app = app;
    this.settings = app?.settings || null;
    this.enabled = opts.enabled !== undefined ? !!opts.enabled : this._settingsEnabled();
    this.online = opts.online !== undefined ? !!opts.online : !!(isBrowser && globalThis.navigator?.onLine);
    this.sameOrigin = opts.endpoint !== undefined ? opts.endpoint : (isBrowser && String(location.protocol).startsWith('http') ? '/telemetry' : null);
    this.endpoint = this.online ? this.sameOrigin : null;
    this.flushMs = opts.flushMs ?? 15000;
    this._now = opts.now || (() => Date.now());
    this.startedAt = this._now();
    this.sessionId = this.enabled ? sessionIdFor() : null;
    this.sampleRate = Math.max(1, opts.sampleRate || SAMPLE_RATE);
    this._fireCount = 0;
    this._screen = null;
    this._screenAt = 0;
    this._match = null;
    this._matchesPlayed = 0;
    this.tracker = this.enabled
      ? new Telemetry({
        endpoint: this.endpoint, flushMs: this.flushMs, bufferSize: 100,
        sessionId: this.sessionId, fetchImpl: opts.fetchImpl || null, now: this._now,
      })
      : null;
    if (this.enabled) this._drainOffline();
  }

  _settingsEnabled() {
    try { return this.settings?.telemetry === true || this.app?.meta?.data?.settings?.telemetry === true; } catch { return false; }
  }

  /** 设置页切换：立即生效；关闭时清空内存队列与离线缓冲。 */
  setEnabled(value) {
    const next = !!value;
    if (next === this.enabled) return this.enabled;
    this.enabled = next;
    if (!next) {
      this.tracker?.setEnabled(false);
      this.tracker?.stop();
      this.tracker = null;
      this.sessionId = null;
      this._clearOffline();
      return false;
    }
    this.sessionId = sessionIdFor();
    this.tracker = new Telemetry({
      endpoint: this.endpoint, flushMs: this.flushMs, bufferSize: 100,
      sessionId: this.sessionId, now: this._now,
    });
    this._drainOffline();
    this.boot({ platform: this._platform(), version: this.app?.version || '1.1.0', quality: this.settings?.quality });
    return true;
  }

  /** 切换联机状态：联机恢复时补发离线缓冲。 */
  setOnline(online) {
    const next = !!online;
    this.online = next;
    const endpoint = next ? this.sameOrigin : null;
    this.endpoint = endpoint;
    if (this.tracker) {
      this.tracker.endpoint = endpoint;
      this.tracker._schedule?.();
    }
    if (next) this._drainOffline();
    return this.online;
  }

  /** 底层入队：未启用 → no-op；离线 → 只落本地缓冲（避免联网后与补发重复）。 */
  track(name, props) {
    if (!this.enabled) return null;
    if (!this.online || !this.endpoint || !this.tracker) {
      this._bufferOffline(name, props);
      return null;
    }
    return this.tracker.track(name, props);
  }

  // ── 自动埋点 ──────────────────────────────────────────────────────────────
  boot(info = {}) {
    this.startedAt = this._now();
    return this.track('session_start', {
      platform: info.platform || this._platform(),
      version: info.version || this.app?.version || '1.1.0',
      quality: info.quality || this.settings?.quality || 'balanced',
    });
  }

  /** 开屏：自动补一条上屏的 screen_leave（带 durationMs），再发 screen_open。 */
  openScreen(screen, from = null) {
    if (this._screen && this._screen !== screen) this.leaveScreen();
    this._screen = screen || null;
    this._screenAt = this._now();
    return this.track('screen_open', { screen, from: from || this._lastScreen || 'boot' });
  }

  leaveScreen(screen = null) {
    const name = screen || this._screen;
    if (!name) return null;
    const durationMs = Math.max(0, this._now() - (this._screenAt || this._now()));
    this._lastScreen = name;
    this._screen = null;
    this._screenAt = 0;
    return this.track('screen_leave', { screen: name, durationMs });
  }

  dialog(name) { return this.track('dialog_open', { dialog: name }); }

  startMatch(info = {}) {
    this._match = { ...info, at: this._now() };
    return this.track('match_start', {
      mode: info.mode, mapId: info.mapId, difficulty: info.difficulty || 'veteran', offline: !!info.offline,
    });
  }

  /** 结算：match_end + funnel(result)。summary 来自 matchSummaryFromState。 */
  finishMatch(summary = {}) {
    const info = this._match || {};
    this._matchesPlayed++;
    this._match = null;
    const res = this.track('match_end', {
      mode: summary.mode || info.mode || 'squad',
      mapId: summary.mapId || info.mapId || 'qinglan',
      placement: summary.placement ?? 0,
      kills: summary.kills ?? 0,
      damage: Math.round(summary.damage ?? 0),
      survived: Math.round(summary.survived ?? 0),
      won: !!summary.won,
    });
    this.funnel('result', true);
    return res;
  }

  /** 开火：1/20 采样，其余直接丢弃（不计数、不占带宽）。 */
  weaponFire(weaponId, distance = 0) {
    if (!this.enabled) return null;
    this._fireCount++;
    if (this._fireCount % this.sampleRate !== 0) return null;
    return this.track('weapon_fire', { weaponId, distance: Math.round(Number(distance) || 0) });
  }

  weaponKill(weaponId, distance = 0, headshot = false) {
    return this.track('weapon_kill', { weaponId, distance: Math.round(Number(distance) || 0), headshot: !!headshot });
  }

  death(killerWeapon, distance = 0, byHeadshot = false) {
    return this.track('death', { killerWeapon, distance: Math.round(Number(distance) || 0), byHeadshot: !!byHeadshot });
  }

  funnel(step, ok = true) { return this.track('funnel', { step, ok: !!ok }); }

  purchase(itemId, price = 0, currency = 'credits') {
    return this.track('purchase', { itemId, price: Math.round(Number(price) || 0), currency });
  }

  missionClaim(missionId, xp = 0) { return this.track('mission_claim', { missionId, xp: Math.round(Number(xp) || 0) }); }

  /** 结束会话：session_end + 立刻 flush（页面卸载前用）。 */
  end() {
    if (!this.enabled) return null;
    const durationMs = Math.max(0, this._now() - this.startedAt);
    const res = this.track('session_end', { durationMs, matchesPlayed: this._matchesPlayed });
    try { this.leaveScreen(); } catch { /* 忽略 */ }
    this.flush('exit');
    return res;
  }

  flush(reason = 'manual') {
    if (!this.tracker) return Promise.resolve({ ok: false, sent: 0, reason: 'disabled' });
    return this.tracker.flush(reason).then((r) => {
      if (r?.ok) this._clearOffline();
      return r;
    });
  }

  getQueue() { return this.tracker?.getQueue?.() || []; }
  get pending() { return this.tracker?.size || 0; }
  get sampleCount() { return this._fireCount; }

  // ── 离线缓冲（最多 500 条，联机后补发一次） ───────────────────────────────
  _bufferOffline(name, props) {
    if (!this.enabled || this.online) return;
    const list = readJson(OFFLINE_KEY, []);
    if (!Array.isArray(list)) return;
    list.push({ name, props: sanitize(props), at: this._now() });
    if (list.length > OFFLINE_MAX) list.splice(0, list.length - OFFLINE_MAX);
    writeJson(OFFLINE_KEY, list);
  }

  get offlinePending() { const l = readJson(OFFLINE_KEY, []); return Array.isArray(l) ? l.length : 0; }

  _clearOffline() {
    const store = safeStorage();
    try { store?.removeItem(OFFLINE_KEY); } catch { /* 忽略 */ }
  }

  /** 联机恢复：把离线缓冲并入队列并按批上报。 */
  _drainOffline() {
    if (!this.enabled || !this.tracker || !this.online || !this.endpoint) return 0;
    const list = readJson(OFFLINE_KEY, []);
    if (!Array.isArray(list) || !list.length) return 0;
    this._clearOffline();
    for (const item of list.slice(0, OFFLINE_MAX)) {
      if (!item || typeof item.name !== 'string') continue;
      this.tracker.track(item.name, item.props);
    }
    this.flush('drain');
    return list.length;
  }

  _platform() {
    try {
      if (this.app?.native) return 'android';
      return isBrowser && /Mobi|Android/i.test(navigator.userAgent || '') ? 'mobile-web' : 'web';
    } catch { return 'web'; }
  }
}

/** 供 main.js 用的一行工厂：未开启遥测时返回 null（连对象都不建）。 */
export function createTelemetry(app) {
  const enabled = (() => {
    try { return app?.settings?.telemetry === true || app?.meta?.data?.settings?.telemetry === true; } catch { return false; }
  })();
  if (!enabled) return null;
  return new TelemetryClient(app, { enabled: true });
}

export { TelemetryClient as default, OFFLINE_KEY, OFFLINE_MAX };
