// 雾岛突围 / MIST ISLE 1.0 — HTTP 面（owner: netserver · server/http.mjs）
// 职责：静态资源（带 ETag/304 与 Cache-Control）、/health、/rooms、/rooms/:code、/metrics。
// 不持有房间状态：所有数据通过 ctx 回调读取，便于单测替换。
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { VERSION, PROTOCOL_VERSION, MAX_PLAYERS } from '../shared/rules.mjs';
import { LIMITS } from './guard.mjs';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self'; object-src 'none'; "
    + "base-uri 'none'; frame-ancestors 'none'",
};

// dist 产物不带内容 hash：用 no-cache + 强 ETag/304 换取正确性；SVG 图标长缓存。
const PRIORITY = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ['/icon.svg', 'icon.svg', 'image/svg+xml'],
];
/**
 * 静态资源的缓存策略。
 *
 * ⚠ 关键：`dist/` 的产物**文件名里没有内容 hash**（就是固定的 /app.js、/style.css）。
 * 对这类文件发 `immutable, max-age=1年` 会造成灾难性后果：浏览器在一年内
 * 永远不会重新验证，用户升级版本后仍跑旧代码，而且我们这边发新版本也"看不见效果"。
 * （开发时表现为：改了代码、构建成功、刷新页面却还是旧行为。）
 *
 * 正确做法：
 *  - 无 hash 的 js/css/html → `no-cache`（每次都带 ETag 回来验证，命中 304 时几乎零成本）
 *  - 图标/字体这类很少变的静态资源 → 允许中等长度缓存
 *  - 只有真的带内容 hash 的资源才配 immutable（目前没有，保留分支以备未来加 hash 构建）
 */
const HASHED = /\.[0-9a-f]{8,}\.(?:js|css|woff2?|png|jpe?g|webp|svg)$/i;
const LONG_LIVED = /(?:^|\/)(?:icon\.svg|favicon\.ico|licenses\/)/i;

function cacheControl(path) {
  if (HASHED.test(path)) return 'public, max-age=31536000, immutable';
  if (LONG_LIVED.test(path)) return 'public, max-age=604800';     // 7 天
  return 'no-cache';                                              // 必须回源验证
}

function etagOf(buffer) {
  return `"${createHash('sha1').update(buffer).digest('base64url').slice(0, 27)}"`;
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

const esc = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

/**
 * 解析单区间 Range 头；任何非法/不支持的写法都返回 null（调用方回退整文件）。
 * 不抛异常是刻意的：一个坏 Range 头不该把静态资源打成 500。
 */
function parseRange(raw, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(raw || '').trim());
  if (!m) return null;
  const [, first, second] = m;
  if (!first && !second) return null;
  let start; let end;
  if (!first) {
    // bytes=-N：最后 N 字节
    const len = Number(second);
    if (!Number.isFinite(len) || len <= 0) return null;
    start = Math.max(0, size - len);
    end = size - 1;
  } else {
    start = Number(first);
    end = second ? Number(second) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) return null;
    if (end >= size) end = size - 1;
    if (start > end) return null;
  }
  if (size <= 0 || start >= size) return null;
  return { start, end };
}

/** 安全解码：非法 % 序列返回 null（调用方回 400），而不是让 URIError 冒到 500。 */
function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

/** 极简 Prometheus histogram：累计桶 + +Inf。 */
function histogram(name, buckets, values) {
  const lines = [];
  let cumulative = 0;
  for (const bound of buckets) {
    cumulative = 0;
    for (const v of values) if (v <= bound) cumulative++;
    lines.push(`${name}_bucket{le="${bound}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{le="+Inf"} ${values.length}`);
  lines.push(`${name}_sum ${values.reduce((a, b) => a + b, 0).toFixed(3)}`);
  lines.push(`${name}_count ${values.length}`);
  return lines.join('\n');
}

export const TICK_BUCKETS = [1, 2, 4, 8, 12, 16, 22, 33, 50, 100];

/**
 * ctx: { rooms, clients, startedAt, distRoot, roomSummary(room), roomPublicList(), metrics() }
 * 返回 (req,res) => Promise<void>，由 http.createServer 直接挂载。
 */
export function createRequestHandler(ctx) {
  const fileCache = new Map(); // name -> { body, etag, type, encodings, mtimeMs }


  /**
   * 读取静态文件（带缓存）。
   *
   * 缓存同时记录文件的 mtime：命中缓存后再 stat 一次，mtime 变了就重新读。
   *
   * 为什么需要这一步：旧实现是「首次读入后永久缓存」，于是**改完 `npm run build`
   * 不重启服务端就永远是旧文件** —— 开发时表现为「改了 CSS 刷新没变化」，
   * 排查成本极高（我第一次遇到时以为是浏览器缓存，清了缓存、换了无痕窗口都没用）。
   * 生产环境多一次 stat 的开销可以忽略（内存命中 + 一次元数据查询）；
   * 也可以设 `STATIC_CACHE=1` 关掉 mtime 检查，换回纯内存缓存。
   */
  const checkMtime = ctx.staticCache !== true;
  const load = async (name, type) => {
    const cached = fileCache.get(name);
    const url = new URL(name, ctx.distRoot);
    if (cached) {
      if (!checkMtime) return cached;
      try {
        const info = await stat(url);
        if (info.mtimeMs === cached.mtimeMs) return cached;
      } catch {
        return cached;   // stat 失败（权限/竞态）就用旧的，不要因为新鲜度检查挂掉请求
      }
    }
    const body = await readFile(url);
    let mtimeMs = 0;
    try { mtimeMs = (await stat(url)).mtimeMs; } catch { /* 拿不到就当 0，下次必刷新 */ }
    const entry = { body, etag: etagOf(body), type, encodings: null, mtimeMs };
    fileCache.set(name, entry);
    return entry;
  };

  // 文本类资源压缩。app.js 1.19MB / style.css 281KB，gzip 后是 356KB / 53KB（-70%/-81%）。
  // 直接 `node server/index.mjs` 部署（README 的主路径）时没有 Caddy 在前面做压缩，
  // 弱网首屏会明显变慢。压缩结果随文件一起缓存，只在首次请求时计算一次。
  const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;
  const MIN_COMPRESS_BYTES = 1024;
  const compress = (entry) => {
    if (entry.encodings !== null) return entry.encodings;
    const out = {};
    if (COMPRESSIBLE.test(entry.type) && entry.body.length >= MIN_COMPRESS_BYTES) {
      try {
        out.br = brotliCompressSync(entry.body, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
        });
        out.gzip = gzipSync(entry.body, { level: 9 });
      } catch { /* 压缩失败就退回明文，绝不能因为压缩挂掉静态资源 */ }
    }
    entry.encodings = out;
    return out;
  };

  const serveStatic = async (req, res, path) => {
    const hit = PRIORITY.find(([route]) => route === path);
    if (!hit) return text(res, 404, 'Not found');
    if (!['GET', 'HEAD'].includes(req.method)) return text(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    let file;
    try { file = await load(hit[1], hit[2]); } catch {
      return text(res, 503, 'Run `npm run build` before starting the server.');
    }
    const cc = cacheControl(hit[1]);
    const headers = {
      'Content-Type': file.type, 'Cache-Control': cc, ETag: file.etag,
      'Accept-Ranges': 'bytes', ...SECURITY_HEADERS,
    };
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === file.etag)) {
      res.writeHead(304, headers);
      res.end();
      return undefined;
    }
    // Range：合法区间回 206（媒体流/断点续传需要）；非法写法一律忽略、回整文件。
    // 带 Range 时不做内容编码 —— 压缩后的字节偏移对不上原始文件的 Content-Range。
    const range = parseRange(req.headers.range, file.body.length);
    if (range) {
      const slice = file.body.subarray(range.start, range.end + 1);
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.body.length}`;
      headers['Content-Length'] = slice.length;
      res.writeHead(206, headers);
      res.end(req.method === 'HEAD' ? undefined : slice);
      return undefined;
    }
    // 内容协商：br > gzip > 明文。Vary 必须声明，否则中间缓存会把压缩版发给
    // 不支持它的客户端（或反过来）。
    const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
    const enc = compress(file);
    let body = file.body;
    if (enc.br && accept.includes('br')) { body = enc.br; headers['Content-Encoding'] = 'br'; }
    else if (enc.gzip && accept.includes('gzip')) { body = enc.gzip; headers['Content-Encoding'] = 'gzip'; }
    if (headers['Content-Encoding']) headers.Vary = 'Accept-Encoding';
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return undefined;
  };

  const metrics = (res) => {
    const m = ctx.metrics ? ctx.metrics() : {};
    const buckets = m.tickBuckets || TICK_BUCKETS;
    const label = (map) => Object.entries(map || {}).map(([k, v]) => `mist_msgs_total{type="${esc(k)}"} ${v}`).join('\n');
    const body = [
      '# HELP mist_rooms_total 当前房间数（含等待/进行中/已结束未回收）',
      '# TYPE mist_rooms_total gauge',
      `mist_rooms_total ${m.rooms || 0}`,
      '# HELP mist_rooms_by_phase 按阶段统计的房间数',
      '# TYPE mist_rooms_by_phase gauge',
      Object.entries(m.phases || {}).map(([k, v]) => `mist_rooms_by_phase{phase="${esc(k)}"} ${v}`).join('\n'),
      '# HELP mist_players_online 房间内人类玩家数（含掉线保留席位）',
      '# TYPE mist_players_online gauge',
      `mist_players_online ${m.players || 0}`,
      '# HELP mist_spectators 观战者人数',
      '# TYPE mist_spectators gauge',
      `mist_spectators ${m.spectators || 0}`,
      '# HELP mist_ws_connections 当前 WebSocket 连接数',
      '# TYPE mist_ws_connections gauge',
      `mist_ws_connections ${m.connections || 0}`,
      '# HELP mist_tick_ms 房间推进耗时（毫秒）',
      '# TYPE mist_tick_ms histogram',
      histogram('mist_tick_ms', buckets, m.ticks || []),
      '# HELP mist_msgs_total 按类型统计的入站消息数',
      '# TYPE mist_msgs_total counter',
      label(m.msgs) || 'mist_msgs_total{type="none"} 0',
      '# HELP mist_rate_dropped_total 因令牌桶被丢弃的消息数',
      '# TYPE mist_rate_dropped_total counter',
      `mist_rate_dropped_total ${m.rateDropped || 0}`,
      '# HELP mist_anticheat_total 反作弊计数',
      '# TYPE mist_anticheat_total counter',
      Object.entries(m.antiCheat || {}).map(([k, v]) => `mist_anticheat_total{kind="${esc(k)}"} ${v}`).join('\n'),
      '# HELP mist_uptime_seconds 进程运行时间（秒）',
      '# TYPE mist_uptime_seconds gauge',
      `mist_uptime_seconds ${m.uptime || 0}`,
      '# HELP mist_version_info 版本信息',
      '# TYPE mist_version_info gauge',
      `mist_version_info{version="${esc(VERSION)}",protocol="${esc(PROTOCOL_VERSION)}"} 1`,
      '',
    ].join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.end(body);
  };

  /** 这些端点只读：除 GET/HEAD 外一律 405（Allow 头必须给，客户端/缓存据此判断）。 */
  const readOnly = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return false;
    text(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return true;
  };

  return async (req, res) => {
    const rawUrl = req.url || '/';
    // 414：超长 URL 先拒绝，别让它进入路由/解码（每多一次解码就多一次 CPU 放大）。
    // 这行在 try 之外，必须自己兜住写响应失败（连接已断开）的情况。
    if (Buffer.byteLength(rawUrl, 'utf8') > LIMITS.maxUrlBytes) {
      try { text(res, 414, 'URI Too Long', { Connection: 'close' }); } catch { /* 连接已断开 */ }
      return;
    }
    const path = rawUrl.split('?')[0];
    try {
      if (path === '/health') {
        if (readOnly(req, res)) return;
        json(res, 200, {
          ok: true,
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          rooms: ctx.rooms.size,
          connections: ctx.clients.size,
          players: ctx.onlinePlayers ? ctx.onlinePlayers() : 0,
          maxPlayers: MAX_PLAYERS,
          uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
          tick: ctx.tickP99 ? Math.round(ctx.tickP99() * 100) / 100 : 0,
        });
        return;
      }
      // /metrics 的 OPS_TOKEN 鉴权在 server/index.mjs 的 routeHttp 里统一处理
      // （那里还负责 /stats，两个端点必须同一处校验，否则容易漏一个）。
      if (path === '/metrics') { if (readOnly(req, res)) return; metrics(res); return; }
      // 遥测与分析（server/telemetry.mjs）：/telemetry、/analytics/*。未注入服务时 404。
      // 它们自己校验方法（POST / GET），这里不能再包一层 405。
      if (ctx.telemetry && (path === '/telemetry' || path.startsWith('/analytics/'))) {
        if (await ctx.telemetry.handle(req, res, path)) return;
      }
      if (path === '/rooms') {
        if (readOnly(req, res)) return;
        json(res, 200, { rooms: ctx.roomPublicList(), total: ctx.rooms.size });
        return;
      }
      if (path.startsWith('/rooms/')) {
        if (readOnly(req, res)) return;
        // 非法 % 序列（如 /rooms/%E0%A4%A）会让 decodeURIComponent 抛 URIError。
        // 这是客户端错误，必须回 400；落到外层 catch 会变成误导性的 500。
        const decoded = safeDecode(path.slice('/rooms/'.length));
        if (decoded == null) { text(res, 400, 'Bad request'); return; }
        const code = decoded.toUpperCase();
        const room = ctx.rooms.get(code);
        if (!room) { json(res, 404, { error: 'not_found', code }); return; }
        json(res, 200, { room: ctx.roomSummary(room) });
        return;
      }
      await serveStatic(req, res, path);
    } catch (err) {
      try { text(res, 500, `Internal error: ${err?.message || err}`); } catch { /* 连接已断开 */ }
    }
  };
}

export { SECURITY_HEADERS, cacheControl, etagOf, parseRange };
export async function distExists(root) {
  try { await stat(new URL('index.html', root)); return true; } catch { return false; }
}
