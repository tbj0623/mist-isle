// 雾岛突围 / MIST ISLE 1.1 — 本地优先玩家遥测（shared：浏览器与 Node 同构）
// 合规底线：1) 默认关闭（settings.telemetry=false，玩家主动开启才采集）；2) 匿名：仅随机
//   sessionId（UUID v4），不关联账号/昵称/设备指纹；3) 无 PII：sanitize() 剥离邮箱/手机号/
//   座机/IPv4/IPv6 并截断 200 字符；4) 本地优先：endpoint 为空时 flush() 是 no-op，数据自托管、
//   可整目录删除；不接第三方 SDK、不跨站上报、不采集设备标识。
// EVENTS[name].props 是属性白名单，多余字段在 track() 丢弃。
export const MAX_PROP_LEN = 200;
export const MAX_PROPS = 40;
export const MAX_BATCH = 100; // 服务端单次请求上限
export const MAX_QUEUE = 2000;
export const PROTOCOL = 1;

export const EVENTS = Object.freeze({
  session_start: { props: ['platform', 'version', 'quality'] },
  session_end: { props: ['durationMs', 'matchesPlayed'] },
  screen_open: { props: ['screen', 'from'] },
  screen_leave: { props: ['screen', 'durationMs'] },
  dialog_open: { props: ['dialog'] },
  match_start: { props: ['mode', 'mapId', 'difficulty', 'offline'] },
  match_end: { props: ['mode', 'mapId', 'placement', 'kills', 'damage', 'survived', 'won'] },
  weapon_fire: { props: ['weaponId', 'distance'] }, // 客户端 1/20 采样
  weapon_kill: { props: ['weaponId', 'distance', 'headshot'] },
  death: { props: ['killerWeapon', 'distance', 'byHeadshot'] },
  funnel: { props: ['step', 'ok'] },
  purchase: { props: ['itemId', 'price', 'currency'] },
  mission_claim: { props: ['missionId', 'xp'] },
});

export const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));
export const FUNNEL_STEPS = Object.freeze(['boot', 'home', 'play', 'deploy', 'live', 'result']);
const EVENT_SET = new Set(EVENT_NAMES);
const FUNNEL_SET = new Set(FUNNEL_STEPS);

// PII 模式：命中即替换为 [redacted]；先邮箱再手机号，避免二次误伤。
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MOBILE_RE = /(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const LANDLINE_RE = /(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/g;
const IPV4_RE = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g;
const IPV6_RE = /(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}/gi;
export const REDACTED = '[redacted]';
// 键名黑名单：值再无害也不进遥测（昵称/账号/设备标识等）。
const PRIVATE_KEYS = new Set(['email', 'mail', 'phone', 'mobile', 'tel', 'ip', 'address', 'nickname',
  'name', 'token', 'auth', 'password', 'passwd', 'secret', 'deviceid', 'device', 'openid', 'uid',
  'userid', 'account', 'qq', 'wechat', 'steamid', 'mac', 'imei', 'androidid']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const truncate = (v, max = MAX_PROP_LEN) => (String(v).length > max ? String(v).slice(0, max) : String(v));

/** 清洗任意值：字符串脱敏 + 截断，数字保留（疑似手机号的整数脱敏），嵌套限深 2 层。 */
export function cleanValue(value, depth = 0) {
  if (value == null) return null;
  const type = typeof value;
  if (type === 'string') {
    return truncate(value.replace(EMAIL_RE, REDACTED).replace(MOBILE_RE, REDACTED)
      .replace(LANDLINE_RE, REDACTED).replace(IPV4_RE, REDACTED).replace(IPV6_RE, REDACTED));
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) && /^1[3-9]\d{9}$/.test(String(value)) ? REDACTED : value;
  }
  if (type === 'boolean') return value;
  if (type === 'bigint') return truncate(value.toString());
  if (type === 'function' || type === 'symbol' || depth >= 2) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => cleanValue(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, v] of Object.entries(value).slice(0, 20)) {
      if (PRIVATE_KEYS.has(key.toLowerCase())) continue;
      const cleaned = cleanValue(v, depth + 1);
      if (cleaned !== undefined) out[truncate(key, 40)] = cleaned;
    }
    return out;
  }
  return undefined;
}

/** PII 清洗：黑名单键 + 值脱敏 + 长度限制。非对象输入返回空对象，绝不抛错。 */
export function sanitize(props) {
  if (!isPlainObject(props)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(props).slice(0, MAX_PROPS)) {
    const key = truncate(String(rawKey), 40);
    if (!key || PRIVATE_KEYS.has(key.toLowerCase())) continue;
    const cleaned = cleanValue(rawValue);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

/** 事件属性白名单过滤（未知字段丢弃）+ sanitize。 */
export function pickProps(name, props) {
  const def = EVENTS[name];
  if (!def) return {};
  const safe = sanitize(props), out = {};
  for (const key of def.props) if (safe[key] !== undefined) out[key] = safe[key];
  // 漏斗步骤做枚举校验、ok 归一化为布尔，避免脏值污染分析口径。
  if (name === 'funnel') {
    if (!FUNNEL_SET.has(out.step)) return {};
    out.ok = out.ok === true || out.ok === 1 || out.ok === 'true';
  }
  return out;
}

/** 生成匿名会话 id；Node 18+/浏览器均有 crypto.randomUUID，兜底用随机串。 */
export function newSessionId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* 隐私模式 */ }
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}
export function isEventName(name) { return EVENT_SET.has(String(name)); }
// Telemetry：内存队列 + 满批/定时 flush。endpoint 为空即纯本地（no-op）。
// 不依赖 DOM / Node API，浏览器与 Node 测试共用同一份实现。
export class Telemetry {
  constructor({
    endpoint = null, bufferSize = 200, flushMs = 15000, enabled = true,
    sessionId = null, fetchImpl = null, maxQueue = MAX_QUEUE, now = () => Date.now(),
  } = {}) {
    this.endpoint = endpoint || null;
    this.bufferSize = Math.max(1, Number(bufferSize) || 200);
    this.flushMs = Math.max(0, Number(flushMs) || 0);
    this.enabled = enabled !== false;
    this.sessionId = sessionId || newSessionId();
    this.maxQueue = Math.max(this.bufferSize, Number(maxQueue) || MAX_QUEUE);
    this.now = now;
    this.queue = [];
    this.sent = 0;
    this.dropped = 0;
    this.errors = 0;
    this.lastFlushAt = 0;
    this._timer = null;
    this._inflight = null;
    this._fetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this._schedule();
  }

  /** 入队；队列达到 bufferSize 立即 flush。返回 flush promise 或 null（未触发）。 */
  track(name, props) {
    if (!this.enabled || !isEventName(name)) return null;
    this.queue.push({ name, ts: this.now(), sid: this.sessionId, v: PROTOCOL, props: pickProps(name, props) });
    if (this.queue.length > this.maxQueue) {
      this.dropped += this.queue.length - this.maxQueue;
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    return this.queue.length >= this.bufferSize ? this.flush() : null;
  }

  /** 上报队列（每个请求 ≤MAX_BATCH 条，循环发完）；无 endpoint/未启用/队列空时 no-op。 */
  flush(reason = 'auto') {
    if (!this.enabled) return Promise.resolve({ ok: false, sent: 0, reason: 'disabled' });
    if (!this.endpoint) return Promise.resolve({ ok: false, sent: 0, reason: 'no-endpoint' });
    if (!this._fetch) return Promise.resolve({ ok: false, sent: 0, reason: 'no-fetch' });
    if (!this.queue.length) return Promise.resolve({ ok: true, sent: 0, reason: 'empty' });
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      let sent = 0;
      while (this.queue.length) {
        const batch = this.queue.splice(0, Math.min(MAX_BATCH, this.queue.length));
        try {
          const res = await this._fetch(this.endpoint, {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json', 'X-Mist-Session': this.sessionId },
            body: JSON.stringify(batch),
          });
          if (!res || !res.ok) {
            this.errors++;
            this._requeue(batch);
            return { ok: false, sent, reason: `http-${res?.status ?? 0}`, count: batch.length };
          }
          sent += batch.length;
        } catch (err) {
          this.errors++;
          this._requeue(batch);
          return { ok: false, sent, reason: 'network', error: String(err?.message || err), count: batch.length };
        }
      }
      this.sent += sent;
      this.lastFlushAt = this.now();
      return { ok: true, sent, reason, count: sent };
    })();
    return this._inflight.finally(() => { this._inflight = null; });
  }

  /** 上报失败把批次放回队首（保持顺序），超上限丢最旧。 */
  _requeue(batch) {
    this.queue.unshift(...batch);
    if (this.queue.length > this.maxQueue) {
      this.dropped += this.queue.length - this.maxQueue;
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
  }

  setEnabled(value) {
    const next = value !== false;
    if (this.enabled === next) return this.enabled;
    this.enabled = next;
    if (!next) {
      // 关闭即丢弃待发队列：玩家撤回同意后不留残余数据。
      this.dropped += this.queue.length;
      this.queue.length = 0;
      this._clearTimer();
    } else {
      this._schedule();
    }
    return this.enabled;
  }

  getQueue() { return this.queue.map((e) => ({ ...e, props: { ...e.props } })); }
  get size() { return this.queue.length; }
  stop() { this._clearTimer(); return this; }

  _schedule() {
    this._clearTimer();
    if (!this.flushMs || !this.enabled || !this.endpoint) return;
    this._timer = setInterval(() => { this.flush('timer'); }, this.flushMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref(); // Node 不挂住进程
  }
  _clearTimer() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  static sanitize(props) { return sanitize(props); }
  static aggregate(events) { return aggregate(events); }
}

// aggregate：事件数组 → 分析口径（漏斗/界面/武器/会话/经济）。畸形行静默跳过。
const numOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const pct = (part, total) => (total > 0 ? Math.round((part / total) * 10000) / 10000 : 0);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;
const bumpIn = (map, key, make) => (map.has(key) ? map.get(key) : (map.set(key, make()), map.get(key)));

export function percentile(values, p) {
  const list = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1))];
}

export function aggregate(events = []) {
  const list = Array.isArray(events) ? events : [];
  const sessions = new Set();
  const screens = new Map();
  const weapons = new Map();
  const deaths = new Map();
  const funnel = new Map(FUNNEL_STEPS.map((s) => [s, { count: 0, ok: 0, sessions: new Set() }]));
  const purchases = new Map();
  const missions = new Map();
  const c = { matches: 0, wins: 0, ends: 0, dialogs: 0, totalMs: 0, placements: [], kills: 0, damage: 0, survived: [] };
  const weaponOf = (id) => bumpIn(weapons, String(id || 'unknown'), () => ({ fires: 0, kills: 0, headshots: 0, dist: 0, distN: 0 }));
  const screenOf = (n) => bumpIn(screens, String(n || 'unknown'), () => ({ opens: 0, totalMs: 0, durations: [] }));

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '');
    const p = raw.props && typeof raw.props === 'object' ? raw.props : {};
    if (raw.sid) sessions.add(String(raw.sid));
    if (name === 'screen_open') screenOf(p.screen).opens++;
    else if (name === 'screen_leave') {
      const s = screenOf(p.screen), ms = Math.max(0, numOr(p.durationMs));
      if (ms > 0) { s.totalMs += ms; s.durations.push(ms); }
    } else if (name === 'session_end') { c.ends++; c.totalMs += Math.max(0, numOr(p.durationMs)); }
    else if (name === 'dialog_open') c.dialogs++;
    else if (name === 'match_start') c.matches++;
    else if (name === 'match_end') {
      if (p.won === true) c.wins++;
      c.kills += numOr(p.kills);
      c.damage += numOr(p.damage);
      c.survived.push(numOr(p.survived));
      if (numOr(p.placement) > 0) c.placements.push(numOr(p.placement));
    } else if (name === 'weapon_fire' || name === 'weapon_kill') {
      const w = weaponOf(p.weaponId);
      if (name === 'weapon_fire') w.fires++;
      else { w.kills++; if (p.headshot === true) w.headshots++; }
      const d = numOr(p.distance, -1);
      if (d >= 0) { w.dist += d; w.distN++; }
    } else if (name === 'death') {
      bumpIn(deaths, String(p.killerWeapon || 'unknown'), () => ({ n: 0 })).n++;
    } else if (name === 'funnel') {
      const row = funnel.get(p.step);
      if (row) { row.count++; if (p.ok === true) row.ok++; if (raw.sid) row.sessions.add(String(raw.sid)); }
    } else if (name === 'purchase') {
      const row = bumpIn(purchases, String(p.itemId || 'unknown'), () => ({ count: 0, revenue: 0, currency: p.currency || 'credits' }));
      row.count++; row.revenue += numOr(p.price);
    } else if (name === 'mission_claim') {
      const row = bumpIn(missions, String(p.missionId || 'unknown'), () => ({ count: 0, xp: 0 }));
      row.count++; row.xp += numOr(p.xp);
    }
  }

  // 漏斗以第一步的独立会话数为基数（无 sid 时退化为事件数），并给出环比转化率。
  const baseRow = funnel.get(FUNNEL_STEPS[0]);
  const baseCount = baseRow.sessions.size || baseRow.count;
  let prev = baseCount;
  const funnelRows = FUNNEL_STEPS.map((step) => {
    const row = funnel.get(step);
    const count = row.sessions.size || row.count;
    const out = { step, count, rate: pct(count, baseCount), stepRate: pct(count, prev), drop: Math.max(0, prev - count) };
    if (count) prev = count;
    return out;
  });
  const totalKills = [...weapons.values()].reduce((a, w) => a + w.kills, 0);

  return {
    events: list.length,
    sessions: sessions.size,
    matches: c.matches,
    wins: c.wins,
    winRate: pct(c.wins, c.matches),
    avgSessionMin: c.ends ? round2(c.totalMs / 1000 / 60 / c.ends) : 0,
    kills: c.kills,
    damage: c.damage,
    avgPlacement: c.placements.length ? round2(c.placements.reduce((a, b) => a + b, 0) / c.placements.length) : 0,
    avgSurvivedSec: c.survived.length ? Math.round(c.survived.reduce((a, b) => a + b, 0) / c.survived.length) : 0,
    funnel: funnelRows,
    screens: [...screens.entries()].map(([screen, s]) => ({
      screen, opens: s.opens, totalMs: s.totalMs,
      avgDurationMs: s.durations.length ? Math.round(s.totalMs / s.durations.length) : 0,
      p90DurationMs: percentile(s.durations, 90),
    })).sort((a, b) => b.totalMs - a.totalMs),
    weapons: [...weapons.entries()].map(([id, w]) => ({
      id, fires: w.fires, kills: w.kills, headshots: w.headshots,
      kpm: round4(w.fires ? w.kills / w.fires : 0), // kills per round（与简报口径一致）
      killShare: pct(w.kills, totalKills),
      avgDistance: w.distN ? round1(w.dist / w.distN) : 0,
    })).sort((a, b) => b.fires - a.fires),
    deaths: [...deaths.entries()].map(([killerWeapon, v]) => ({ killerWeapon, count: v.n })).sort((a, b) => b.count - a.count),
    purchases: [...purchases.entries()].map(([itemId, v]) => ({ itemId, ...v })).sort((a, b) => b.revenue - a.revenue),
    missions: [...missions.entries()].map(([missionId, v]) => ({ missionId, ...v })).sort((a, b) => b.xp - a.xp),
    dialogsOpened: c.dialogs,
  };
}

// analyzeMatches：从 data/matches.jsonl 的对局记录算「对局侧」平衡指标。
// 与客户端遥测互补：matches 是服务端权威落盘（不受 settings.telemetry 开关影响），
// 看胜率/排名/结局最准；逐枪距离与 TTK 需配合 weapon_* 事件一起看。
export function analyzeMatches(matches = []) {
  const list = (Array.isArray(matches) ? matches : []).filter((m) => m && typeof m === 'object');
  const used = new Map();
  let players = 0, wins = 0, rankSum = 0, rankN = 0, durSum = 0, durN = 0;
  let kills = 0, damage = 0, survived = 0, survivedN = 0;
  const ttk = [];
  const bump = (id) => used.set(String(id), (used.get(String(id)) || 0) + 1);

  for (const m of list) {
    const rows = Array.isArray(m.players) ? m.players : [];
    const teams = Math.max(1, new Set(rows.map((p) => p.team)).size);
    const duration = numOr(m.durationSec, 0);
    if (duration > 0) { durSum += duration; durN++; }
    const me = rows.find((p) => !p.bot); // 单机视角：第一个真人
    if (me) {
      players++;
      if (!!m.won || (m.winnerTeam != null && me.team != null && m.winnerTeam === me.team)) wins++;
      rankSum += numOr(me.rank, 0) || teams; rankN++;
      kills += numOr(me.kills);
      damage += numOr(me.damage);
      const s = numOr(me.survived, duration);
      survived += s; survivedN++;
      // 单杀 TTK 粗估：存活秒 / 击杀数（无逐枪事件时的兜底口径，只看趋势）
      if (numOr(me.kills) > 0 && s > 0) ttk.push(s / numOr(me.kills));
    }
    for (const p of rows) for (const id of p.weapons || (p.weapon ? [p.weapon] : [])) bump(id);
  }

  const total = [...used.values()].reduce((a, b) => a + b, 0);
  return {
    matches: list.length,
    players,
    winRate: pct(wins, players),
    avgPlacement: rankN ? round2(rankSum / rankN) : 0,
    avgDurationSec: durN ? Math.round(durSum / durN) : 0,
    avgKills: players ? round2(kills / players) : 0,
    avgDamage: players ? Math.round(damage / players) : 0,
    avgSurvivedSec: survivedN ? Math.round(survived / survivedN) : 0,
    // 有逐枪数据时用真实交战间隔估计 TTK；无则退回 summary.weapons 的理论 TTK（由调用方补）
    ttkP50: ttk.length ? round2(percentile(ttk, 50)) : 0,
    ttkSource: ttk.length ? 'survived-per-kill' : 'none',
    weapons: [...used.entries()].map(([id, uses]) => ({ id, uses, share: pct(uses, total) }))
      .sort((a, b) => b.uses - a.uses),
    byMode: [...new Set(list.map((m) => m.mode).filter(Boolean))].map((mode) => {
      const rows = list.filter((m) => m.mode === mode);
      return { mode, matches: rows.length, decided: rows.filter((m) => m.winnerTeam != null).length };
    }),
  };
}
