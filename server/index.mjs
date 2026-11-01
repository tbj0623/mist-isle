// 雾岛突围 / MIST ISLE 1.0 — 联机服务器入口（owner: netserver · server/index.mjs）
// 只做 wiring：HTTP 面（server/http.mjs）、房间（rooms.mjs）、会话（session.mjs）、
// 房内动作（actions.mjs）、防护（guard.mjs）。单进程内存房间；30Hz 推演、10Hz 广播。
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { PROTOCOL_VERSION, VERSION, TICK_RATE, SNAPSHOT_EVERY_TICKS, SCHEDULE } from '../shared/rules.mjs';
import {
  LIMITS, createLimits, takeToken, registerViolation, originAllowed,
  createInputWindow, trackInputRate, trackSeq, takeWindowQuota,
} from './guard.mjs';
import { createRequestHandler } from './http.mjs';
import { createRoomRegistry } from './rooms.mjs';
import { createSessions } from './session.mjs';
import { createActions } from './actions.mjs';
import { createSocial } from './social.mjs';
import { createTelemetryFromEnv, createTelemetryService } from './telemetry.mjs';
import { ReplayRecorder } from '../shared/replay.mjs';

const TICK_MS = 1000 / TICK_RATE;
const SHUTDOWN_GRACE_MS = 5000; // 优雅停机最多等 5 秒强退
const INPUT_TYPES = new Set(['input']);
const DEFAULT_MATCH_LOG_PATH = fileURLToPath(new URL('../data/matches.jsonl', import.meta.url));
const MESSAGE_TYPES = ['ping', 'rooms', 'join', 'leave', 'ready', 'start', 'rematch', 'chat', 'input', 'kick', 'config', 'team', 'spectate', 'pong', 'metrics'];

// ── Origin 默认策略 ──────────────────────────────────────────────────────────
// 未配置 ALLOWED_ORIGINS 时的安全兜底白名单，兼顾本地开发 / Playwright e2e / Android WebView：
//   1) 不带 Origin 的连接放行（原生客户端、探活脚本）；
//   2) 本机回环任意端口（http/https 的 localhost、127.0.0.1、[::1]）放行 —— npm run dev 与 e2e 直连；
//   3) Android WebView 的应用内来源 appassets.androidplatform.net（http/https 两种 scheme）放行；
//   4) 其余跨站来源一律 403。
// 显式设置 ALLOWED_ORIGINS 后切换为严格白名单（guard.originAllowed），回环与 appassets 不再自动放行。
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const ANDROID_ORIGIN_RE = /^https?:\/\/appassets\.androidplatform\.net$/i;
export function originPermitted(origins, origin) {
  const list = Array.isArray(origins) ? origins : String(origins || '').split(',');
  const clean = list.map((s) => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean);
  if (clean.length) return originAllowed(clean, origin);
  if (!origin) return true;
  const value = String(origin).trim().replace(/\/+$/, '');
  return LOCAL_ORIGIN_RE.test(value) || ANDROID_ORIGIN_RE.test(value);
}

/** 读取 TLS_CERT / TLS_KEY：两者同时配置返回 { cert, key }，都没配置返回 null，只配置其一视为配置错误。 */
export function loadTlsConfig(env = process.env) {
  const cert = String(env.TLS_CERT || '').trim();
  const key = String(env.TLS_KEY || '').trim();
  if (!cert && !key) return null;
  if (!cert || !key) throw new Error('TLS_CERT 与 TLS_KEY 必须同时设置（或同时不设置）');
  try {
    return { cert: readFileSync(resolve(cert), 'utf8'), key: readFileSync(resolve(key), 'utf8') };
  } catch (err) {
    throw new Error(`TLS 证书读取失败（TLS_CERT=${cert} TLS_KEY=${key}）：${err?.message || err}`);
  }
}

/**
 * IP 规范化：去掉 IPv6 映射前缀（`::ffff:1.2.3.4` → `1.2.3.4`）、
 * 去掉方括号与 zone id（`[::1]` → `::1`、`fe80::1%eth0` → `fe80::1`）。
 * 不做规范化的话，同一个客户端经不同路径拿到的 key 不同，配额与日志都会分裂。
 */
function normIp(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) s = s.replace(/^\[|\]$/g, '');
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (s.toLowerCase().startsWith('::ffff:')) s = s.slice(7);
  return s.toLowerCase();
}
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n > 255) return null;
    out = (out * 256) + n;
  }
  return out >>> 0;
}
function ipToBigInt(ip) {
  if (!ip.includes(':')) return null;
  // 展开 :: 简写
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? Math.max(0, 8 - h.length - t.length) : 0;
  const groups = [...h, ...new Array(fill).fill('0'), ...t];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    const n = parseInt(g || '0', 16);
    if (!Number.isFinite(n)) return null;
    out = (out << 16n) + BigInt(n);
  }
  return out;
}

/**
 * 反作弊阈值：全部走这里，便于测试注入。默认值来自 guard.LIMITS，生产环境不需要传。
 * 两种注入写法都支持（与现有扁平风格一致，分组写法便于一次覆盖多项）：
 *   createGameServer({ inputPerWindow: 20 })
 *   createGameServer({ antiCheat: { inputPerWindow: 20 } })
 * 顶层扁平字段优先于 antiCheat 分组里的同名字段。
 */
function resolveAntiCheat(options = {}, flat = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const num = (key, fallback) => {
    const raw = flat[key] != null ? flat[key] : o[key];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    inputWindowMs: num('inputWindowMs', LIMITS.inputWindowMs),
    inputPerWindow: num('inputPerWindow', LIMITS.inputPerWindow),
    inputWindowStrikes: num('inputWindowStrikes', LIMITS.inputWindowStrikes),
    seqRegressions: num('seqRegressions', LIMITS.seqRegressions),
    chatPerSec: num('chatPerSec', LIMITS.chatPerSec),
    chatMaxChars: num('chatMaxChars', LIMITS.chatMaxChars),
    dropvotePerSec: num('dropvotePerSec', LIMITS.dropvotePerSec),
    dropvoteWindowMs: num('dropvoteWindowMs', LIMITS.dropvoteWindowMs),
  };
}

export function createGameServer({
  port = 8787, host = '0.0.0.0', maxRooms = LIMITS.maxRooms, maxConnections = 512,
  autoStartMs = SCHEDULE.lobbyAutoStartMs, origins = [], maxConnectionsPerIp = LIMITS.maxConnectionsPerIp,
  shutdownGraceMs = SHUTDOWN_GRACE_MS, log = null,
  matchLogPath = DEFAULT_MATCH_LOG_PATH, tls = null,
  telemetryOptions = null, now = Date.now, binary = true, opsToken = null,
  trustProxy = false, trustProxyList = '', antiCheat = null, matchDropMs = LIMITS.matchDropMs,
  // 反作弊阈值的扁平注入（都能被 antiCheat 分组里的同名字段覆盖，见 resolveAntiCheat）。
  inputWindowMs = null, inputPerWindow = null, inputWindowStrikes = null, seqRegressions = null,
  chatPerSec = null, chatMaxChars = null, dropvotePerSec = null, dropvoteWindowMs = null,
} = {}) {
  // 统一时间基准：注册表 / 会话 / 社交都走它。默认 Date.now；测试可注入假时钟，
  // 这样「断线 20s 后剔除 + 30s 宽限期后回收」可以在毫秒级测试里真实跑一遍。
  const clock = () => Number(now()) || Date.now();
  const cheat = resolveAntiCheat(antiCheat, {
    inputWindowMs, inputPerWindow, inputWindowStrikes, seqRegressions,
    chatPerSec, chatMaxChars, dropvotePerSec, dropvoteWindowMs,
  });
  const clients = new Set();
  const ipCounts = new Map();
  const startedAt = Date.now();
  const tickSamples = [];
  const counters = {
    msgs: {}, rateDropped: 0, antiCheat: { fire: 0, teleport: 0 }, closeCalls: 0,
    // 反作弊踢出计数（/stats 的 stats.counters 输出）：速率窗口 / seq 回退 / dropvote 丢弃。
    rateKicks: 0, seqKicks: 0, dropvoteDropped: 0,
  };
  const shutdown = { active: false, at: 0, promise: null };
  const connectionsDrained = () => clients.size === 0;

  // 日志分级：debug/info/warn/error；默认只输出 warn 及以上，避免限流抖动刷屏。
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const logAt = log && typeof log === 'object' ? log : {};
  const logMin = LEVELS[logAt.level] || LEVELS.warn;
  const emitLog = (level, event, detail) => {
    if (LEVELS[level] < logMin) return;
    if (typeof logAt.sink === 'function') { logAt.sink(level, event, detail); return; }
    const line = `[${level}] ${event} ${detail ? JSON.stringify(detail) : ''}`.trim();
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  // binary：二进制快照开关（WIRE_BINARY=0 / createGameServer({ binary:false }) 可整体回退
  // 到纯 JSON）。老客户端不受影响 —— 是否走二进制由 join 里的 binary 能力位决定。
  const io = {
    protocol: PROTOCOL_VERSION,
    binary: binary !== false,
    send: null, sendBytes: null, fail: null, log: emitLog,
  };

  // ── 注册表与域服务 ────────────────────────────────────────────────────────
  // clock 可注入：注册表、会话、社交必须共用同一时间基准，
  // 否则测试无法推进时间去验证「空房宽限期后回收」的真实路径。
  const registry = createRoomRegistry({ io, maxRooms, autoStartMs, now: clock, matchDropMs });
  const sessions = createSessions({ io, registry, now: clock });
  const actions = createActions({ io, registry, now: clock });
  // 社交（好友/组队邀请/战队/表情）不与房间绑定：大厅、对局中都能用，registry 只读。
  const social = createSocial({ io, registry, now: clock });
  const { rooms } = registry;

  // ── 发送与背压 ────────────────────────────────────────────────────────────
  const send = (ws, data) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > LIMITS.maxBuffer) {
      const client = ws.__client;
      if (client && !client.slowSince) client.slowSince = Date.now();
      return false; // 背压：丢弃这一帧（快照），不断开
    }
    if (ws.__client?.slowSince) ws.__client.slowSince = 0;
    try { ws.send(JSON.stringify(data)); return true; } catch { return false; }
  };
  // 二进制帧发送：跳过 JSON.stringify，直接发 ArrayBuffer/Uint8Array（ws 会按 binary 帧下发）。
  const sendBytes = (ws, bytes) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > LIMITS.maxBuffer) {
      const client = ws.__client;
      if (client && !client.slowSince) client.slowSince = Date.now();
      return false;
    }
    if (ws.__client?.slowSince) ws.__client.slowSince = 0;
    try { ws.send(bytes); return true; } catch { return false; }
  };
  const fail = (ws, message, code = null) => send(ws, { type: 'error', message, ...(code ? { code } : {}) });
  io.send = send;
  io.sendBytes = sendBytes;
  io.fail = fail;

  const onlinePlayers = () => {
    let n = 0;
    for (const room of rooms.values()) n += room.members.size;
    return n;
  };
  const tickP = (p) => {
    if (!tickSamples.length) return 0;
    const sorted = [...tickSamples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  };

  // ── 对局结果落盘：data/matches.jsonl（UTF-8，一行一个 JSON）。 ────────────────
  // 目录创建失败 / 写失败一律 try/catch 降级为日志，绝不影响对局主流程；失败后每局重试一次。
  const matchLog = { path: matchLogPath, broken: false };
  const writeMatchLog = (room) => {
    if (!matchLog.path) return;
    const m = room.match;
    const record = {
      at: new Date().toISOString(),
      code: room.code,
      mode: m.mode, mapId: m.mapId, difficulty: m.difficulty,
      durationSec: Math.round((m.result?.duration ?? m.time) * 10) / 10,
      winnerTeam: m.winnerTeam,
      winnerName: m.result?.winnerName ?? null,
      reason: m.resultReason ?? null,
      humans: room.members.size,
      players: m.players.map((p) => ({
        id: p.id, name: p.name, bot: !!p.bot, team: p.team, kills: p.kills || 0,
        damage: Math.round(p.damage || 0), rank: p.rank || null, alive: !!(p.alive || p.downed),
      })),
    };
    try {
      mkdirSync(dirname(matchLog.path), { recursive: true });
      appendFileSync(matchLog.path, `${JSON.stringify(record)}\n`, 'utf8');
      matchLog.broken = false;
    } catch (err) {
      if (!matchLog.broken) {
        matchLog.broken = true;
        io.log('warn', 'match-log-failed', { path: matchLog.path, error: String(err?.message || err) });
      }
    }
  };
  /** 同一局只落一次盘：按 Match 引用去重，rematch 重建 Match 后允许再写。 */
  const flushMatchLog = (room) => {
    if (room.match.phase !== 'ended' || room.__loggedMatch === room.match) return;
    room.__loggedMatch = room.match;
    writeMatchLog(room);
  };

  // ── 运维端点 /stats：进程内存、房间/连接/对局数与最近 tick 耗时分位。 ────────
  const serverStats = () => {
    let spectators = 0;
    for (const room of rooms.values()) spectators += room.spectators.size;
    const mem = process.memoryUsage();
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      ok: true, version: VERSION, protocol: PROTOCOL_VERSION,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed },
      rooms: rooms.size,
      matches: [...rooms.values()].filter((r) => !['waiting', 'ended'].includes(r.match.phase)).length,
      sockets: clients.size,
      players: onlinePlayers(), spectators,
      tickMs: { p50: r2(tickP(0.5)), p95: r2(tickP(0.95)), p99: r2(tickP(0.99)) },
      // 反作弊计数：只增字段，不改变既有字段语义（老监控照常读）。
      counters: {
        rateKicks: counters.rateKicks,
        seqKicks: counters.seqKicks,
        dropvoteDropped: counters.dropvoteDropped,
        rateDropped: counters.rateDropped,
      },
    };
  };
  const handleStats = (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD', 'X-Content-Type-Options': 'nosniff' });
      res.end();
      return;
    }
    const body = JSON.stringify(serverStats());
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  // ── HTTP（原生 TLS 时切换为 https，WebSocket 自动升级为 wss） ────────────────
  const telemetry = telemetryOptions
    ? createTelemetryService(telemetryOptions)
    : createTelemetryFromEnv(process.env);
  const handleHttp = createRequestHandler({
    rooms, clients, startedAt,
    telemetry,
    opsToken,
    distRoot: new URL('../dist/', import.meta.url),
    roomSummary: registry.summary,
    roomPublicList: registry.summaries,
    onlinePlayers,
    tickP99: () => tickP(0.99),
    metrics: () => {
      const phases = {};
      for (const room of rooms.values()) phases[room.match.phase] = (phases[room.match.phase] || 0) + 1;
      let spectators = 0;
      for (const room of rooms.values()) spectators += room.spectators.size;
      return {
        rooms: rooms.size, phases, players: onlinePlayers(), spectators,
        connections: clients.size, ticks: tickSamples,
        msgs: counters.msgs, rateDropped: counters.rateDropped, antiCheat: counters.antiCheat,
        uptime: Math.round((Date.now() - startedAt) / 1000),
      };
    },
  });
  /**
   * 运维端点鉴权（/stats、/metrics）。必须在**这里**做，不能只放在 http.mjs：
   * `/stats` 由 routeHttp 直接短路处理，根本不进 http.mjs 的请求处理器，
   * 于是「http.mjs 里加了鉴权」对它完全无效（实测设置了 OPS_TOKEN 仍返回 200）。
   * 未配置 OPS_TOKEN 时放行，保持本机开发与内网部署的默认行为。
   */
  const opsAuthorized = (req) => {
    if (!opsToken) return true;
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ') && auth.slice(7).trim() === opsToken) return true;
    try {
      return new URL(req.url || '/', 'http://localhost').searchParams.get('token') === opsToken;
    } catch { return false; }
  };

  const routeHttp = (req, res) => {
    const path = (req.url || '/').split('?')[0];
    if ((path === '/stats' || path === '/metrics') && !opsAuthorized(req)) {
      // 404 而不是 403：不确认端点存在，避免探测
      try {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found');
      } catch { /* 连接已断开 */ }
      return;
    }
    if (path === '/stats') { handleStats(req, res); return; }
    handleHttp(req, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } });
  };
  const server = tls ? https.createServer(tls, routeHttp) : http.createServer(routeHttp);

  // ── WebSocket 升级（含 Origin 校验与连接配额） ─────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload || 8192, perMessageDeflate: false });
  const denyUpgrade = (socket, status, reason) => {
    try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch { /* ignore */ }
    try { socket.destroy(); } catch { /* ignore */ }
  };

  /**
   * 取客户端真实 IP。
   *
   * **默认不信任何代理头** —— 否则攻击者伪造 `X-Forwarded-For: 1.2.3.4`
   * 就能绕过 `maxConnectionsPerIp`（每个伪造 IP 一份配额）。
   *
   * `trustProxy` 打开时才读 `X-Forwarded-For`，且取**最右**一项：
   * 右侧是最近一层可信代理追加的地址，左侧是客户端可以随意伪造的。
   * 设 `trustedProxies`（逗号分隔的 CIDR / 精确 IP）时只在直连对端属于
   * 可信网段时才采信该头 —— 这是 Caddy 的 `trusted_proxies` 语义。
   */
  const trustedProxies = (() => {
    const raw = String(trustProxyList || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!raw.length) return null;
    return raw.map((entry) => {
      const [base, bitsRaw] = entry.split('/');
      const bits = bitsRaw === undefined ? null : Number(bitsRaw);
      return { base: normIp(base), bits: Number.isFinite(bits) ? bits : null };
    }).filter((e) => e.base);
  })();
  const ipTrusted = (ip) => {
    if (!trustedProxies) return true;          // 声明信任但没给网段：信任直连对端
    const norm = normIp(ip);
    if (!norm) return false;
    for (const rule of trustedProxies) {
      if (norm === rule.base) return true;
      if (rule.bits == null) continue;
      if (norm.includes(':') !== rule.base.includes(':')) continue;
      if (norm.includes(':')) {
        const a = ipToBigInt(norm), b = ipToBigInt(rule.base);
        if (a == null || b == null) continue;
        const shift = BigInt(128 - rule.bits);
        if ((a >> shift) === (b >> shift)) return true;
      } else {
        const a = ipv4ToInt(norm), b = ipv4ToInt(rule.base);
        if (a == null || b == null) continue;
        const mask = rule.bits === 0 ? 0 : (~0 << (32 - rule.bits)) >>> 0;
        if ((a & mask) === (b & mask)) return true;
      }
    }
    return false;
  };
  const clientIpOf = (req) => {
    const direct = req.socket?.remoteAddress || 'unknown';
    if (!trustProxy) return direct;
    if (!ipTrusted(direct)) return direct;     // 直连对端不可信 → 忽略伪造头
    const xff = String(req.headers['x-forwarded-for'] || '');
    if (!xff) return direct;
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    // 取最右（最后一个可信代理写入的那一项）
    return parts.length ? parts[parts.length - 1] : direct;
  };

  server.on('upgrade', (req, socket, head) => {
    if (shutdown.active) return denyUpgrade(socket, 503, 'Shutting down');
    const ip = clientIpOf(req);
    const origin = req.headers.origin;
    const url = (req.url || '').split('?')[0];
    if (url !== '/ws') return denyUpgrade(socket, 404, 'Not Found');
    if (!originPermitted(origins, origin)) return denyUpgrade(socket, 403, 'Forbidden Origin');
    if (clients.size >= maxConnections) return denyUpgrade(socket, 503, 'Server Full');
    if ((ipCounts.get(ip) || 0) >= maxConnectionsPerIp) return denyUpgrade(socket, 429, 'Too Many Connections');
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // ── 消息分发 ──────────────────────────────────────────────────────────────
  /**
   * 令牌桶：input 档 capacity 60 / refill 45/s，控制档 capacity 45 / refill 24/s。
   * 超限的输入只丢弃不断线；控制消息违规 3 次直接踢出（1008）。
   */
  const rate = (client, type) => {
    const isInput = INPUT_TYPES.has(type);
    const bucket = isInput ? client.limits.input : client.limits.control;
    if (takeToken(bucket)) return true;
    client.dropped++;
    counters.rateDropped++;
    if (isInput) {
      if (client.dropped % 100 === 1) io.log('warn', 'rate-drop', { ip: client.ip, dropped: client.dropped, rate: 'input' });
      return false;
    }
    const kick = registerViolation(client, `rate:${type}`);
    io.log('warn', 'rate-violation', { ip: client.ip, type, violations: client.violations, kick });
    return kick ? 'kick' : false;
  };

  /**
   * 聊天节流：契约 §4 规定 80 字 / 2 条每秒，观战者也必须走同一条闸门
   * （旧实现里观战者分支直接调 actions.chat，完全不受限）。
   * 返回 true 表示本次超限、已回错误。
   */
  const throttleChat = (client, ws, now = Date.now()) => {
    if (now - client.chatAt > 1000) { client.chatAt = now; client.chat = 0; }
    if (++client.chat > cheat.chatPerSec) { fail(ws, '发言太快了', 'CHAT_SPAM'); return true; }
    return false;
  };

  const handleMessage = (client, ws, msg, tick) => {
    const now = Date.now();
    const type = typeof msg.type === 'string' ? msg.type : '';
    counters.msgs[type] = (counters.msgs[type] || 0) + 1;

    if (type === 'ping') { send(ws, { type: 'pong', sent: Number(msg.sent) || 0, time: now, tick }); return; }
    if (type === 'rooms') { send(ws, { type: 'rooms', rooms: registry.summaries() }); return; }
    if (type === 'join') {
      if (now - client.joinsAt > 10000) { client.joinsAt = now; client.joins = 0; }
      if (++client.joins > 10) { fail(ws, '操作过于频繁，请稍后再试', 'JOIN_SPAM'); return; }
      sessions.join(client, ws, msg);
      if (client.id) {
        try { social.onConnect({ id: client.id, name: msg.name, ws }); social.setRoom(client.id, client.room); }
        catch (err) { io.log('warn', 'social-connect', { error: String(err?.message || err) }); }
      }
      return;
    }
    if (type === 'spectate') { sessions.spectate(client, ws, msg); return; }
    // 社交（好友/邀请/战队/表情）不要求进房：同一套 action 在任意阶段都可用。
    if (type.startsWith('social:')) {
      const reply = social.handle(client, ws, msg);
      if (reply) send(ws, reply);
      return;
    }
    if (!client.room) { fail(ws, '请先加入房间', 'NO_ROOM'); return; }
    const room = rooms.get(client.room);
    if (!room) { fail(ws, '房间已失效', 'ROOM_GONE'); return; }

    if (client.spectator) {
      if (type === 'leave') sessions.leave(client, ws);
      else if (type === 'chat') { if (!throttleChat(client, ws, now)) actions.chat(client, room, msg); }
      return; // 观战者不能输入/开始/踢人
    }
    switch (type) {
      case 'leave': sessions.leave(client, ws); break;
      case 'ready': actions.setReady(client, room, msg); break;
      case 'start': actions.start(client, room, msg); break;
      case 'rematch': actions.rematch(client, room); break;
      case 'chat':
        if (!throttleChat(client, ws, now)) actions.chat(client, room, msg);
        break;
      case 'input': actions.input(client, room, msg, tick); break;
      case 'kick': actions.kick(client, room, msg); break;
      case 'config': actions.config(client, room, msg); break;
      case 'team': actions.team(client, room, msg); break;
      case 'dropvote':
        // 每连接 5 条/秒：超限静默丢弃（不回错误，避免给刷子放大回包），只计数。
        if (!takeWindowQuota(client, '__dropvote', clock(), cheat.dropvoteWindowMs, cheat.dropvotePerSec)) {
          counters.dropvoteDropped++;
          break;
        }
        actions.dropVote(client, room, msg); break;
      default: fail(ws, `未知的消息类型: ${String(type).slice(0, 24)}`, 'UNKNOWN_TYPE'); break;
    }
  };

  wss.on('connection', (ws, req) => {
    const ip = clientIpOf(req);
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    // 服务端签发的连接身份：社交等「进房前」的协议用它认人。
    // 历史 bug：大厅阶段 client.id 为 null，social.handle 直接信任客户端自报的 pid，
    // 任何人都能拿明文可见的玩家 id 改别人档案 / 读别人好友与邀请。
    // 现在身份只来自这里，客户端无法伪造。
    const sid = randomBytes(16).toString('base64url');
    const client = {
      ws, ip, sid, id: null, room: null, spectator: false, alive: true,
      limits: createLimits(), violations: 0, dropped: 0, joins: 0, joinsAt: Date.now(),
      chat: 0, chatAt: Date.now(), slowSince: 0, lastMessageAt: Date.now(),
      lastPingAt: Date.now(), lastPongAt: Date.now(), seq: 0,
      // 反作弊状态：1 秒输入速率窗口、seq 单调性基准、dropvote 配额。
      inputWindow: createInputWindow(), lastInputSeq: 0, seqRegressions: 0,
    };
    ws.__client = client;
    ws.__sid = sid;
    clients.add(client);
    ws.on('error', () => {});
    ws.on('pong', () => { client.alive = true; client.lastPongAt = Date.now(); });
    ws.on('close', () => {
      sessions.disconnect(client);
      try { social.onDisconnect(client); } catch (err) { io.log('warn', 'social-disconnect', { error: String(err?.message || err) }); }
      clients.delete(client);
      const n = (ipCounts.get(ip) || 1) - 1;
      if (n > 0) ipCounts.set(ip, n); else ipCounts.delete(ip);
    });
    // sid：服务端签发的连接身份（见上方注释）。下发给客户端仅为便于调试/回显，
    // 服务端后续一律以 client.sid / ws.__sid 为准，不读客户端回传值。
    send(ws, {
      type: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, sid,
      motd: '雾岛突围 1.0 · 信号已接入', limits: { input: LIMITS.input, control: LIMITS.control },
      // 能力协商：wire 为二进制快照协议版本（0/缺省 = 只支持 JSON）。
      // 客户端只有在 join 里回传 binary:true 后才会收到二进制帧。
      wire: io.binary ? 1 : 0,
    });

    ws.on('message', (buffer, binary) => {
      client.alive = true;
      client.lastMessageAt = Date.now();
      if (binary) { fail(ws, '请使用 JSON 文本协议', 'BINARY'); return; }
      if (buffer.length > LIMITS.maxPayload) {
        // 单条消息超限：直接断开（1009），不与令牌桶重复计费。
        io.log('warn', 'payload-limit', { ip: client.ip, bytes: buffer.length });
        try { ws.close(1009, '消息过大'); } catch { /* ignore */ }
        return;
      }
      let msg;
      try { msg = JSON.parse(buffer.toString()); } catch { fail(ws, '消息格式错误', 'BAD_JSON'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { fail(ws, '消息格式错误', 'BAD_JSON'); return; }
      const msgType = typeof msg.type === 'string' ? msg.type : '';
      // 权威输入校验放在令牌桶**之前**：令牌桶只决定「处理还是丢弃」，
      // 若放在后面，攻击者只要被桶丢掉就不会被统计，速率窗口永远看不到洪泛。
      if (msgType === 'input') {
        const verdict = trackInputRate(client.inputWindow, Date.now(), {
          windowMs: cheat.inputWindowMs, max: cheat.inputPerWindow, strikes: cheat.inputWindowStrikes,
        });
        if (verdict === 'kick') {
          counters.rateKicks++;
          io.log('warn', 'input-rate-kick', { ip: client.ip, violations: client.inputWindow.violations });
          fail(ws, '输入频率异常，连接已断开', 'INPUT_RATE');
          try { ws.close(1008, 'input-rate'); } catch { /* ignore */ }
          return;
        }
        const inputSeq = msg.input && typeof msg.input === 'object' ? msg.input.seq : 0;
        const seqVerdict = trackSeq(client, inputSeq, cheat.seqRegressions);
        if (seqVerdict === 'kick') {
          counters.seqKicks++;
          io.log('warn', 'input-seq-kick', { ip: client.ip, regressions: client.seqRegressions });
          fail(ws, '输入序号异常，连接已断开', 'INPUT_SEQ');
          try { ws.close(1008, 'input-seq'); } catch { /* ignore */ }
          return;
        }
      }
      const verdict = rate(client, msgType);
      if (verdict === 'kick' || verdict === false) {
        if (verdict === 'kick') { fail(ws, '操作过于频繁，连接已断开', 'RATE_LIMIT'); try { ws.close(1008, 'rate'); } catch { /* ignore */ } }
        return;
      }
      try { handleMessage(client, ws, msg, ticks); } catch (err) {
        io.log('warn', 'handler-error', { type: msg.type, error: String(err?.message || err) });
        fail(ws, '服务器处理消息时出错', 'INTERNAL');
      }
    });
  });

  // ── 死亡回放：每 tick 采样；新 kill 且死者是在线真人 → 单播 killcam ──────────
  const replayRecorders = new Map();
  const serviceKillcam = (room) => {
    let rec = replayRecorders.get(room.code);
    const events = room.match.events || [];
    const lastId = events.length ? events[events.length - 1].id : 0;
    if (!rec) { rec = new ReplayRecorder(); replayRecorders.set(room.code, rec); room.killcamEventId = lastId; }
    rec.sample(room.match);
    if (!(lastId > (room.killcamEventId || 0))) return;
    const fresh = events.filter((ev) => ev.id > (room.killcamEventId || 0));
    room.killcamEventId = lastId;
    for (const ev of fresh) {
      if (ev.type !== 'kill') continue;
      const victim = room.members.get(ev.player);
      if (!victim?.ws) continue; // 只发给真人在线玩家，bot / 已掉线不发
      io.send(victim.ws, { type: 'killcam', data: rec.aroundDeath(ev.player, ev.by ?? null, 4.5) });
    }
  };

  // ── 主循环 ────────────────────────────────────────────────────────────────
  let previous = performance.now();
  let accumulator = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min((now - previous) / 1000, 0.25);
    previous = now;
    while (accumulator >= 1 / TICK_RATE) {
      accumulator -= 1 / TICK_RATE;
      ticks++;
      const tickStart = performance.now();
      for (const room of rooms.values()) {
        let wantSnapshot = false;
        try { wantSnapshot = registry.tickRoom(room, ticks, SNAPSHOT_EVERY_TICKS); } catch (err) {
          io.log('warn', 'tick-error', { code: room.code, error: String(err?.message || err) });
        }
        if (wantSnapshot) { try { registry.broadcastState(room); } catch (err) { io.log('warn', 'broadcast-error', { code: room.code, error: String(err?.message || err) }); } }
        try { serviceKillcam(room); } catch (err) { io.log('warn', 'killcam-error', { code: room.code, error: String(err?.message || err) }); }
        try { flushMatchLog(room); } catch (err) { io.log('warn', 'match-log-error', { code: room.code, error: String(err?.message || err) }); }
      }
      tickSamples.push(performance.now() - tickStart);
      if (tickSamples.length > 240) tickSamples.shift();
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  // ── 心跳：每 10s ws.ping()，连续 30s 没有 pong（也没有任何上行消息）就断开。
  // 掉线客户端可能在 close 前一直占着席位；terminate 会触发 close → sessions.disconnect 释放席位。
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const c of clients) {
      if (c.slowSince && now - c.slowSince > LIMITS.slowMs) {
        io.log('warn', 'backpressure-close', { ip: c.ip, buffered: c.ws.bufferedAmount, slowMs: now - c.slowSince });
        // 必须用 terminate() 而不是 close()：这个客户端之所以被判慢，正是因为
        // bufferedAmount 已经超过 512KB —— close 帧会排在 512KB 数据**之后**，
        // 要等内核把积压全部写出去才真正断开，期间它仍占着席位与 clients.size。
        // terminate() 直接销毁 TCP 连接，不留排队窗口。
        try { c.ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      const silentFor = now - Math.max(c.lastMessageAt, c.lastPongAt || 0);
      if (silentFor > LIMITS.pongTimeoutMs) {
        io.log('warn', 'heartbeat-drop', { ip: c.ip, silentMs: silentFor });
        try { c.ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      if (now - c.lastPingAt >= LIMITS.pingMs) { c.lastPingAt = now; try { c.ws.ping(); } catch { /* ignore */ } }
    }
  }, LIMITS.pingMs);
  if (heartbeat.unref) heartbeat.unref();

  const cleanup = setInterval(() => {
    try { registry.cleanup(); } catch (err) { io.log('warn', 'gc-error', { error: String(err?.message || err) }); }
    // 房间销毁 → 释放该房回放缓存
    for (const [code, rec] of replayRecorders) {
      if (rooms.has(code)) continue;
      rec.clear(); replayRecorders.delete(code);
    }
  }, 15000);
  if (cleanup.unref) cleanup.unref();

  // ── 优雅关闭（幂等） ──────────────────────────────────────────────────────
  // 1) 立刻停止接受新连接 2) 广播 shutdown 3) 最多等 shutdownGraceMs（默认 5s）让对局自然收尾
  // 4) 补写未落盘的对局结果 5) 用 1001 + 中文原因关闭所有 ws 与 http(s) server。重复调用返回同一个 promise。
  const broadcastAll = (data) => { for (const c of clients) send(c.ws, data); };
  const doClose = async () => {
    counters.closeCalls++;
    if (shutdown.promise) return shutdown.promise;
    shutdown.promise = (async () => {
      shutdown.active = true;
      shutdown.at = Date.now();
      clearInterval(timer); clearInterval(heartbeat); clearInterval(cleanup);
      // 先让 http server 停止监听：新连接立刻被拒绝（端口关闭）。
      // 兜底计时器带 ref、成功回调里清除：既保证事件循环清空时 close 路径必然有机会
      // 触发（否则进程会在 promise settle 前退出，exit 13），又不会拖慢正常退出。
      const serverClosed = server.listening
        ? new Promise((res) => {
          const fallback = setTimeout(res, shutdownGraceMs);
          try { server.close(() => { clearTimeout(fallback); res(); }); } catch { clearTimeout(fallback); res(); }
        })
        : Promise.resolve();
      const seconds = Math.max(1, Math.round(shutdownGraceMs / 1000));
      broadcastAll({ type: 'shutdown', inSeconds: seconds, reason: '服务器正在停机维护，请稍后重连' });
      io.log('warn', 'shutdown-start', { inSeconds: seconds, connections: clients.size, rooms: rooms.size });
      const hasLiveMatch = () => [...rooms.values()]
        .some((r) => !['waiting', 'ended'].includes(r.match.phase));
      const drained = () => new Promise((res) => {
        // 没有在线连接就不必空等：drain 只是给还连着的人争取收尾时间。
        if (clients.size === 0) { res(); return; }
        const deadline = Date.now() + shutdownGraceMs;
        // 这个轮询必须带 ref：连接关闭事件把循环清空后，唯一能 resolve drained 的
        // 就是它；unref 会让进程在它触发前直接退出（历史 exit 13 的根因）。
        if (!hasLiveMatch()) { res(); return; }
        const tick = setInterval(() => {
          if (!hasLiveMatch() || clients.size === 0 || Date.now() >= deadline) { clearInterval(tick); res(); }
        }, 100);
      });
      await drained();
      await new Promise((res) => {
        const fallback = setTimeout(res, 500); // 带 ref：wss 回调不触发时兜底，成功后清除
        try { wss.close(() => { clearTimeout(fallback); res(); }); } catch { clearTimeout(fallback); res(); }
        for (const c of clients) { try { c.ws.close(1001, '服务器停机维护，请稍后重连'); } catch { /* ignore */ } }
      });
      for (const c of clients) { try { c.ws.terminate(); } catch { /* ignore */ } }
      await serverClosed;
      clients.clear();
      // 停机前把已结束但还没落盘的对局补写一次（tick 已停，不能再依赖主循环）。
      for (const room of rooms.values()) { try { flushMatchLog(room); } catch { /* ignore */ } }
      rooms.clear();
      io.log('warn', 'shutdown-done', { ms: Date.now() - shutdown.at, closeCalls: counters.closeCalls, drained: connectionsDrained() });
    })();
    return shutdown.promise;
  };

  return {
    server, rooms, clients, wss, registry, sessions, actions, social,
    /** 测试钩子：验证反代 IP 解析（生产代码不调用）。 */
    clientIpForTest: clientIpOf,
    get shuttingDown() { return shutdown.active; },
    get stats() { return { ticks, tickSamples: [...tickSamples], counters }; },
    tickPercentile: tickP,
    listen: () => new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(port, host, () => { server.off('error', rej); res(server.address()); });
    }),
    close: doClose,
    /** 主动触发优雅关闭（供 CLI 的 SIGINT/SIGTERM 使用）。 */
    shutdown: doClose,
  };
}

/**
 * 生产入口：读取环境变量 → 组装服务 → 监听 → 挂接信号与兜底异常处理。
 * SIGINT/SIGTERM 触发优雅停机（停止接入 → 广播 → 落盘 → 最多 5 秒强退）。
 * 返回 app 供编程式启停（测试 / 嵌入式调用）；`node server/index.mjs` 行为不变。
 */
export async function main(env = process.env) {
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let tls = null;
  try { tls = loadTlsConfig(env); } catch (err) { console.error(`[server] ${err?.message || err}`); process.exit(1); }
  /**
   * 解析正整数环境变量。
   *
   * 为什么不用 `Number(v) || fallback`：Docker 的 `--env-file`、systemd 的
   * `EnvironmentFile`、以及手写的 `.env` 都可能把行内注释或空白带进值里
   *（`MAX_ROOMS=24   # 上限` → `Number()` 得到 NaN），于是**静默回落默认值** ——
   * 运维以为改了 24，实际还在跑 12，而且没有任何日志。`parseInt` 只取前导数字，
   * 配合显式告警，至少能让配置错误看得见。
   */
  const intEnv = (value, fallback, name) => {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`[server] 环境变量 ${name}="${raw}" 不是正整数，已回落到 ${fallback}\n`);
      return fallback;
    }
    if (String(n) !== raw) {
      process.stderr.write(`[server] 环境变量 ${name}="${raw}" 含多余字符，按 ${n} 处理\n`);
    }
    return n;
  };
  const maxConnectionsPerIp = intEnv(env.MAX_CONN_PER_IP, LIMITS.maxConnectionsPerIp, 'MAX_CONN_PER_IP');
  const app = createGameServer({
    port: intEnv(env.PORT, 8787, 'PORT'),
    host: env.HOST || '0.0.0.0',
    origins,
    maxRooms: intEnv(env.MAX_ROOMS, LIMITS.maxRooms, 'MAX_ROOMS'),
    maxConnections: intEnv(env.MAX_CONNECTIONS, 512, 'MAX_CONNECTIONS'),
    maxConnectionsPerIp,
    matchLogPath: env.MATCH_LOG_PATH || DEFAULT_MATCH_LOG_PATH,
    // 二进制快照总开关：WIRE_BINARY=0 时全服回退 JSON（灰度/回滚用，老客户端本来就只走 JSON）。
    binary: String(env.WIRE_BINARY ?? '1') !== '0',
    // 运维端点鉴权（/stats、/metrics）：设置后必须带 Bearer；不设则保持开放
    opsToken: env.OPS_TOKEN || null,
    // 反代支持：TRUST_PROXY=1 时才采信 X-Forwarded-For（默认关闭，防伪造绕过 IP 配额）
    trustProxy: /^(1|true|yes)$/i.test(String(env.TRUST_PROXY || '')),
    trustProxyList: String(env.TRUSTED_PROXIES || ''),
    tls,
    telemetryOptions: {
      dir: env.TELEMETRY_DIR || undefined,
      token: env.ANALYTICS_TOKEN || null,
    },
    log: env.LOG_LEVEL ? { level: env.LOG_LEVEL } : null,
  });
  const address = await app.listen();
  const scheme = tls ? 'https' : 'http';
  console.log(`MIST ISLE ${VERSION} · protocol ${PROTOCOL_VERSION} listening on ${scheme}://${address.address}:${address.port} (ws: ${tls ? 'wss' : 'ws'})`);
  console.log(`limits: rooms=${app.registry.maxRooms} conn/ip=${maxConnectionsPerIp} origins=${origins.join(',') || '默认白名单(回环+appassets)'} wire=${app.registry.binaryEnabled ? 'binary' : 'json'}`);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal} received, draining…`);
    try { await app.close(); } catch (err) { console.error('[server] close failed', err); }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('uncaughtException', (err) => { console.error('[server] uncaught', err); });
  process.on('unhandledRejection', (err) => { console.error('[server] unhandled', err); });
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) await main();
