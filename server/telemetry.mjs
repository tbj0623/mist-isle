// 雾岛突围 / MIST ISLE 1.1 — 服务端遥测收集与内部分析（自托管，无第三方）
// ─────────────────────────────────────────────────────────────────────────────
// 职责：POST /telemetry 批量接收 → data/telemetry/YYYY-MM-DD.jsonl；
//      GET /analytics/{summary,funnel,weapons}（管理员 token 保护）。
// 设计：不收 PII（只存客户端 sanitize 过的白名单字段，不落 IP/UA/Referer）；
// 分析用 readline 逐行流式扫描，内存与行数无关；ANALYTICS_TOKEN 未配置时分析
// 端点一律 503（默认不裸奔）；按天分文件，删除某天 = 删一个文件。
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import {
  EVENTS, FUNNEL_STEPS, MAX_BATCH, MAX_PROP_LEN, isEventName, percentile,
} from '../shared/telemetry.mjs';
import { timeToKill, WEAPONS } from '../shared/data/weapons.mjs';

const DEFAULT_DIR = fileURLToPath(new URL('../data/telemetry/', import.meta.url));
const MAX_BODY = 1024 * 1024; // 1MB
const MAX_LINE = 16 * 1024; // 单行保护：异常超长行直接跳过，不占内存
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 事件时间戳可接受窗口：最多回溯 7 天、最多前瞻 1 小时（容忍客户端时钟漂移）。
// 窗口外的 ts 一律回落到服务端当前时间 —— 历史 bug：客户端传 1e16 会让
// dayKeyOf(new Date(ts)) 里的 toISOString() 抛 RangeError；而传 2099 年这类
// 合法范围内的远端时间会创建 data/telemetry/2099-01-01.jsonl，攻击者可无限
// 制造文件撑爆 inode。
const TS_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const TS_FUTURE_MS = 60 * 60 * 1000;

const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;
const round4 = (v) => Math.round(v * 10000) / 10000;
// 全武器理论 TTK（秒）：无逐枪事件时作为 balance.ttkP50 的常量基线。
const TTK_TABLE = Object.values(WEAPONS).map((w) => timeToKill(w)).filter((t) => t > 0);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : 0);

/** 当日文件路径（UTC 日期，跨时区部署口径统一）。 */
export function dayKeyOf(date = new Date()) { return date.toISOString().slice(0, 10); }

/**
 * 落盘日期白名单：只接受 YYYY-MM-DD，且必须是日历上真实存在的日期
 * （挡住 2026-13-45 这类「格式对但不存在」的值），同时杜绝 `../` 路径穿越。
 */
export const isValidDay = (day) => {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00.000Z`);
  // 往返比对：Date 会把 13 月 / 45 日自动进位，进位后字符串就对不上了。
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day;
};

/**
 * 由时间戳安全推导日期键：非法/越界时间戳返回 null（由调用方跳过该事件），
 * 绝不把 RangeError 抛给请求处理链。钳制层已保证正常路径不触发，这里是独立兜底。
 */
export function dayKeyFor(ts) {
  try {
    const day = dayKeyOf(new Date(ts));
    return isValidDay(day) ? day : null;
  } catch { return null; }
}

/**
 * 日期必须落在合理窗口内：不早于 7 天前、不晚于明天（1 小时时钟漂移可能跨 UTC 午夜）。
 * 格式白名单只能挡住 `../`，挡不住 2099-01-01 这种「格式合法但无限多」的日期文件；
 * 时间戳钳制是第一道闸，这里是落盘前最后一道（ingest 也对外暴露）。
 */
export function dayInRange(day, today = new Date()) {
  if (!isValidDay(day)) return false;
  try {
    const lo = dayKeyOf(new Date(today.getTime() - 7 * 86400000));
    const hi = dayKeyOf(new Date(today.getTime() + 86400000));
    return day >= lo && day <= hi;
  } catch { return false; }
}

/**
 * 钳制客户端时间戳：只接受 [now - 7 天, now + 1 小时]，其余（含 NaN / Infinity /
 * 超出 Date 可表示范围的 1e16）一律替换为服务端当前时间。
 * 这样 normalizeEvents → ingest → dayKeyOf 的链路永远不会碰到 Invalid Date。
 */
export function clampTs(ts, now = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return now;
  if (n < now - TS_PAST_MS || n > now + TS_FUTURE_MS) return now;
  // 额外兜底：即使数值落在窗口内，Date 也必须能表示（防御窗口常量被改大后的回归）。
  try { new Date(n).toISOString(); } catch { return now; }
  return n;
}

/** 安全比较 token，避免逐字符短路泄露长度信息。 */
function tokenMatches(expected, given) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(given || ''));
  if (!a.length || a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(JSON.stringify(body));
}

/** 读请求体；声明或实际超过 MAX_BODY 立刻中止（不 buffer 全量）。 */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve_, reject) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('too_large'), { code: 'too_large' })); return;
    }
    const chunks = [];
    let size = 0, done = false;
    const finish = (err, value) => { if (done) return; done = true; if (err) reject(err); else resolve_(value); };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { finish(Object.assign(new Error('too_large'), { code: 'too_large' })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => finish(err));
  });
}

/** 逐条校验归一化：未知事件名/非法 json/超长字段丢弃该条（不是整批拒绝）。 */
export function normalizeEvents(input) {
  if (!Array.isArray(input)) return { events: [], rejected: 0, reason: 'not-array' };
  const out = [];
  let rejected = 0;
  const now = Date.now();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || !isEventName(raw.name)) { rejected++; continue; }
    const props = raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props) ? raw.props : {};
    const clean = {};
    const allowed = EVENTS[raw.name].props;
    for (const key of allowed) {
      const value = props[key];
      if (value === undefined) continue;
      if (typeof value === 'string' && value.length > MAX_PROP_LEN) { clean[key] = value.slice(0, MAX_PROP_LEN); continue; }
      clean[key] = value;
    }
    if (raw.name === 'funnel' && !FUNNEL_STEPS.includes(clean.step)) { rejected++; continue; }
    const sid = typeof raw.sid === 'string' ? raw.sid.slice(0, 64) : null;
    out.push({
      // ts 必须钳制到合理窗口：1e16 会让 new Date(ts).toISOString() 抛 RangeError（整批 500），
      // 2099 年则会落出一个 2099-01-01.jsonl，攻击者可无限制造日期文件。
      name: raw.name, ts: clampTs(raw.ts, now),
      sid, v: Number(raw.v) || 1, props: clean,
    });
  }
  return { events: out, rejected, reason: null };
}

/**
 * 创建遥测服务。返回 { handle(req,res,path) -> Promise<boolean>, ingest, summary, funnel, weapons, readAll }
 * handle 返回 true 表示已处理（http.mjs 据此短路），false 表示不是遥测路由。
 */
export function createTelemetryService({
  dir = DEFAULT_DIR, token = null, maxBatch = MAX_BATCH, log = null,
} = {}) {
  const root = resolve(dir);
  const authToken = token || null;
  const logger = (level, event, detail) => { try { log?.(level, event, detail); } catch { /* 忽略 */ } };
  // broken 计数「被拒写的脏数据」；writeFailed 只用于「写入失败只记一次日志」的去重。
  const stats = { ingested: 0, rejected: 0, batches: 0, denied: 0, lastAt: 0, broken: 0 };
  let writeFailed = false;

  // 落盘：一天一个文件，appendFile 串行化，同一进程内不会交错写坏行。
  let writeChain = Promise.resolve();
  const writeDay = (day, lines) => {
    // 日期白名单 + 范围校验：只允许最近 7 天内的 YYYY-MM-DD。day 来自事件的 ts
    // 经 dayKeyOf 推导，一旦上游钳制失效（或有人绕过 normalizeEvents 直接调 ingest），
    // 这里就是最后一道闸：不合法则拒绝写入并计入 stats.broken，
    // 避免出现 2099-01-01.jsonl 这类无穷多的日期文件把 data 目录撑爆 inode。
    if (!dayInRange(day)) {
      stats.broken++;
      logger('warn', 'telemetry-bad-day', { day: String(day).slice(0, 32) });
      return writeChain;
    }
    const file = join(root, `${day}.jsonl`);
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, lines, 'utf8');
      writeFailed = false;
    }).catch((err) => {
      if (!writeFailed) { writeFailed = true; logger('warn', 'telemetry-write-failed', { file, error: String(err?.message || err) }); }
    });
    return writeChain;
  };

  /** 接收一批事件（已解析对象）；单条脏数据只丢该条，不整批拒绝。 */
  async function ingest(rawEvents) {
    if (!Array.isArray(rawEvents)) return { accepted: 0, rejected: 0, error: 'not-array' };
    if (rawEvents.length > maxBatch) return { accepted: 0, rejected: rawEvents.length, error: 'batch-too-large' };
    const { events, rejected: rejectedRaw } = normalizeEvents(rawEvents);
    let rejected = rejectedRaw;
    if (!events.length) { stats.rejected += rejected; return { accepted: 0, rejected, error: rejected ? 'all-rejected' : null }; }
    // 按天分桶：一批可能跨午夜（罕见，但保持文件口径正确）。
    let accepted = 0;
    const buckets = new Map();
    for (const ev of events) {
      // dayKeyFor 内部是 date.toISOString()：非法/越界 ts 会抛 RangeError。
      // 归一化层已钳制过，但 ingest 也是对外 API（测试/脚本可直接调用），
      // 这里再兜一层：算不出合法日期的事件跳过并计入 rejected，绝不让整批 500。
      // 除了格式，日期还必须落在近期窗口内 —— 否则一条 ts=2099 的事件就能造出
      // 2099-01-01.jsonl，反复提交不同日期即可无限制造文件。
      const day = dayKeyFor(ev.ts);
      if (!day || !dayInRange(day)) { rejected++; stats.broken++; continue; }
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(`${JSON.stringify(ev)}\n`);
      accepted++;
    }
    for (const [day, lines] of buckets) await writeDay(day, lines.join(''));
    stats.ingested += accepted;
    stats.rejected += rejected;
    stats.batches++;
    stats.lastAt = Date.now();
    return { accepted, rejected, error: accepted ? null : rejected ? 'all-rejected' : null };
  }

  async function* streamDay(file) {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line || line.length > MAX_LINE) continue;
        try {
          const ev = JSON.parse(line);
          if (ev && typeof ev === 'object' && typeof ev.name === 'string') yield ev;
        } catch { /* 坏行跳过 */ }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  /** 可用日期文件（升序）。 */
  async function listDays() {
    try {
      const names = await readdir(root);
      return names.filter((n) => DAY_RE.test(n.replace(/\.jsonl$/, '')) && n.endsWith('.jsonl'))
        .map((n) => n.replace(/\.jsonl$/, '')).sort();
    } catch { return []; }
  }

  /** 选择窗口内的文件（days=0 表示全部）。 */
  async function selectFiles({ days = 0 } = {}) {
    const all = await listDays();
    if (!days || days <= 0) return all;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return all.filter((d) => d >= cutoff);
  }

  /** 流式聚合：一次扫描算完 summary/funnel/weapons，避免多次读盘。 */
  async function scan({ days = 0, onEvent = null } = {}) {
    const files = await selectFiles({ days });
    const acc = {
      files: files.length, events: 0, sessions: new Set(), matches: 0, sessionMs: 0, sessionEnds: 0,
      funnel: new Map(FUNNEL_STEPS.map((s) => [s, { count: 0, ok: 0, sessions: new Set() }])),
      screens: new Map(), weapons: new Map(), deaths: new Map(), ttk: [],
      matchEnds: 0, wins: 0, placements: 0, placementSum: 0, damage: 0, kills: 0, dialogOpens: 0,
    };
    const weaponOf = (id) => {
      const key = String(id || 'unknown');
      if (!acc.weapons.has(key)) acc.weapons.set(key, { id: key, fires: 0, kills: 0, headshots: 0, dist: 0, distN: 0 });
      return acc.weapons.get(key);
    };
    const screenOf = (name) => {
      const key = String(name || 'unknown');
      if (!acc.screens.has(key)) acc.screens.set(key, { screen: key, opens: 0, ms: 0, durations: [] });
      return acc.screens.get(key);
    };
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

    for (const day of files) {
      for await (const ev of streamDay(join(root, `${day}.jsonl`))) {
        acc.events++;
        if (ev.sid) acc.sessions.add(String(ev.sid));
        const p = ev.props || {};
        switch (ev.name) {
          case 'session_end': acc.sessionEnds++; acc.sessionMs += Math.max(0, n(p.durationMs)); break;
          case 'screen_open': screenOf(p.screen).opens++; break;
          case 'screen_leave': {
            const s = screenOf(p.screen), ms = Math.max(0, n(p.durationMs));
            if (ms > 0) { s.ms += ms; s.durations.push(ms); }
            break;
          }
          case 'dialog_open': acc.dialogOpens++; break;
          case 'match_start': acc.matches++; break;
          case 'match_end':
            acc.matchEnds++;
            if (p.won === true) acc.wins++;
            acc.kills += n(p.kills);
            acc.damage += n(p.damage);
            if (n(p.placement) > 0) { acc.placements++; acc.placementSum += n(p.placement); }
            break;
          case 'weapon_fire':
          case 'weapon_kill': {
            const w = weaponOf(p.weaponId);
            if (ev.name === 'weapon_fire') w.fires++;
            else { w.kills++; if (p.headshot === true) w.headshots++; }
            const d = n(p.distance);
            if (d > 0) { w.dist += d; w.distN++; }
            break;
          }
          case 'death':
            acc.deaths.set(String(p.killerWeapon || 'unknown'), (acc.deaths.get(String(p.killerWeapon || 'unknown')) || 0) + 1);
            break;
          case 'funnel': {
            const row = acc.funnel.get(p.step);
            if (row) { row.count++; if (p.ok === true) row.ok++; if (ev.sid) row.sessions.add(String(ev.sid)); }
            break;
          }
          default: break;
        }
        if (onEvent) onEvent(ev);
      }
    }
    return acc;
  }

  /** 由扫描结果组装 summary（字段与简报一致）。 */
  function summarize(acc) {
    const baseRow = acc.funnel.get(FUNNEL_STEPS[0]);
    const base = baseRow.sessions.size || baseRow.count;
    let prev = base;
    const funnel = FUNNEL_STEPS.map((step) => {
      const row = acc.funnel.get(step);
      const count = row.sessions.size || row.count;
      const out = { step, count, rate: pct(count, base), stepRate: pct(count, prev), drop: Math.max(0, prev - count) };
      if (count) prev = count;
      return out;
    });
    const totalKills = [...acc.weapons.values()].reduce((a, w) => a + w.kills, 0);
    const weapons = [...acc.weapons.values()].map((w) => ({
      id: w.id, fires: w.fires, kills: w.kills, headshots: w.headshots,
      kpm: round4(w.fires ? w.kills / w.fires : 0), // kills per round
      killShare: pct(w.kills, totalKills),
      avgDistance: w.distN ? round1(w.dist / w.distN) : 0,
    })).sort((a, b) => b.fires - a.fires);
    const screens = [...acc.screens.values()].map((s) => ({
      screen: s.screen, opens: s.opens, totalMs: s.ms,
      avgDurationMs: s.durations.length ? Math.round(s.ms / s.durations.length) : 0,
      p90DurationMs: percentile(s.durations, 90),
    })).sort((a, b) => b.totalMs - a.totalMs);
    return {
      sessions: acc.sessions.size,
      matches: acc.matches || acc.matchEnds,
      avgSessionMin: acc.sessionEnds ? round2(acc.sessionMs / 1000 / 60 / acc.sessionEnds) : 0,
      funnel,
      screens,
      weapons,
      balance: buildBalance(weapons, acc),
      windows: { days: acc.files, events: acc.events },
    };
  }

  /** 平衡结论：使用率分布 + 寡头/冷门标记 + TTK 分位。 */
  function buildBalance(weapons, acc, { overuse = 0.35, underuse = 0.02 } = {}) {
    const totalFires = weapons.reduce((a, w) => a + w.fires, 0);
    const rows = weapons.map((w) => ({ ...w, fireShare: pct(w.fires, totalFires) }));
    const ranked = rows.slice().sort((a, b) => b.kills - a.kills);
    return {
      topWeapons: ranked.slice(0, 5).map((w) => ({ id: w.id, fireShare: w.fireShare, killShare: w.killShare, kpm: w.kpm })),
      underused: rows.filter((w) => w.fireShare < underuse).map((w) => w.id).slice(0, 8),
      overused: rows.filter((w) => w.fireShare > overuse).map((w) => w.id),
      totalFires,
      // 有逐枪事件用实测交战间隔；否则退回武器表理论 TTK 的 P50（常量基线）。
      ttkP50: acc.ttk.length ? round2(percentile(acc.ttk, 50)) : round2(percentile(TTK_TABLE, 50)),
      ttkSource: acc.ttk.length ? 'observed' : 'weapon-table',
    };
  }

  const requireAuth = (req, res) => {
    if (!authToken) { json(res, 503, { error: 'analytics_disabled', hint: '设置 ANALYTICS_TOKEN 后启用' }); return false; }
    const header = String(req.headers?.authorization || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // token 只接受 Authorization 头或 X-Analytics-Token，不接受 query（避免进访问日志）。
    const given = bearer || String(req.headers?.['x-analytics-token'] || '').trim();
    if (!tokenMatches(authToken, given)) {
      stats.denied++;
      json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="analytics"' });
      return false;
    }
    return true;
  };

  const summary = async (days = 0) => summarize(await scan({ days }));
  const funnel = async (days = 0) => { const s = await summary(days); return { funnel: s.funnel, sessions: s.sessions, windows: s.windows }; };
  const weapons = async (days = 0) => { const s = await summary(days); return { weapons: s.weapons, balance: s.balance, windows: s.windows }; };

  /** 分析端点路由；返回 true 表示已处理。 */
  async function handle(req, res, path) {
    const query = new URLSearchParams((req.url || '').split('?')[1] || '');
    const days = Math.max(0, Math.min(365, Number(query.get('days')) || 0));
    const method = req.method || 'GET';

    if (path === '/telemetry') {
      if (method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST' }); return true; }
      let body;
      try { body = await readBody(req); } catch (err) {
        if (err?.code === 'too_large') { json(res, 413, { error: 'payload_too_large', limit: MAX_BODY }); return true; }
        json(res, 400, { error: 'bad_request' }); return true;
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { json(res, 400, { error: 'invalid_json' }); return true; }
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : null;
      if (!list) { json(res, 400, { error: 'expected_array' }); return true; }
      if (list.length > maxBatch) { json(res, 413, { error: 'batch_too_large', limit: maxBatch, got: list.length }); return true; }
      const result = await ingest(list);
      json(res, result.error === 'batch-too-large' ? 413 : 200, { ok: !result.error || result.error === 'all-rejected', ...result });
      return true;
    }

    if (path === '/analytics/summary' || path === '/analytics/funnel' || path === '/analytics/weapons') {
      if (method !== 'GET' && method !== 'HEAD') { json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); return true; }
      if (!requireAuth(req, res)) return true;
      try {
        const data = path.endsWith('/funnel') ? await funnel(days)
          : path.endsWith('/weapons') ? await weapons(days) : await summary(days);
        json(res, 200, data);
      } catch (err) {
        logger('warn', 'analytics-failed', { path, error: String(err?.message || err) });
        json(res, 500, { error: 'analytics_failed' });
      }
      return true;
    }
    return false;
  }

  /** 测试/离线报告用：流式读全部事件（生产分析走 summary）。 */
  async function readAll({ days = 0, limit = Infinity } = {}) {
    const out = [];
    for (const day of await selectFiles({ days })) {
      for await (const ev of streamDay(join(root, `${day}.jsonl`))) {
        out.push(ev);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  // writeDay 不对外暴露业务用途，但测试需要直接验证「日期白名单」这道闸（正常 ingest
  // 路径已把 day 钳制干净，无法造出脏 day）。仅作只读调试口。
  return { handle, ingest, summary, funnel, weapons, scan, summarize, readAll, listDays, stats, root, authToken, writeDay };
}

/** 给 http.mjs 用的便捷工厂：从环境变量读 token 与目录。 */
export function createTelemetryFromEnv(env = process.env) {
  const dir = env.TELEMETRY_DIR ? resolve(env.TELEMETRY_DIR) : DEFAULT_DIR;
  const token = String(env.ANALYTICS_TOKEN || '').trim() || null;
  return createTelemetryService({ dir, token });
}

export { DEFAULT_DIR as TELEMETRY_DIR, MAX_BODY as MAX_TELEMETRY_BODY };
