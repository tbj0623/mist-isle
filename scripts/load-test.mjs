#!/usr/bin/env node
// 雾岛突围 / MIST ISLE 1.0 — 联机压测（owner: netserver · scripts/load-test.mjs）
// 用法：node scripts/load-test.mjs --clients 64 --seconds 20 --mode squad
// 用子进程起真实服务端（node server/index.mjs），避免 in-process 计时失真。
// 产物：artifacts/load-test.json；失败时以非零码退出。
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, SQUAD_SIZE } from '../shared/rules.mjs';

const ROOT = new URL('../', import.meta.url);
const ARTIFACTS = new URL('artifacts/', ROOT);
const args = parseArgs(process.argv.slice(2));
const CLIENTS = clampInt(args.clients, 64, 1, 256);
const SECONDS = clampInt(args.seconds, 20, 3, 600);
const MODE = ['squad', 'solo', 'horde', 'training'].includes(args.mode) ? args.mode : 'squad';
const PORT = clampInt(args.port, 0, 0, 65535) || (20000 + Math.floor(Math.random() * 20000));
const INPUT_HZ = clampInt(args.inputHz, 25, 1, 60);
const VERBOSE = args.verbose === 'true' || args.verbose === true;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[name] = next; i++; } else out[name] = true;
  }
  return out;
}
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

/** 起子进程服务端，等 /health 就绪。 */
async function startServer() {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: fileURLToPath(ROOT),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MAX_ROOMS: '24',
      MAX_CONN_PER_IP: String(Math.max(8, CLIENTS + 8)),
      NODE_ENV: 'loadtest',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d).trim()));
  child.stderr.on('data', (d) => logs.push(String(d).trim()));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`服务端提前退出：\n${logs.join('\n')}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return { child, logs };
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  try { child.kill(); } catch { /* ignore */ }
  throw new Error(`服务端 15s 内未就绪：\n${logs.join('\n')}`);
}

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });
  const startedAt = Date.now();
  const errors = [];
  const uncaught = [];
  process.on('uncaughtException', (err) => uncaught.push(String(err?.stack || err)));
  process.on('unhandledRejection', (err) => uncaught.push(String(err?.stack || err)));

  const { child, logs } = await startServer();
  const url = `ws://127.0.0.1:${PORT}/ws`;
  const http = `http://127.0.0.1:${PORT}`;
  const clients = [];
  let snapshots = 0;
  let stateBytes = 0;
  const rtts = [];
  let errorMessages = 0;

  /** 建连 + 加入房间；返回 { ws, joined, rtt } */
  const spawnClient = (index, roomCode = null, team = 0) => new Promise((resolve) => {
    const record = { index, ws: null, id: null, code: roomCode, joinedAt: 0, snapshots: 0, ok: false };
    const ws = new WebSocket(url);
    record.ws = ws;
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(record); } };
    const timer = setTimeout(done, 12000);
    ws.on('open', () => {
      // 第一个客户端建房，其余按小队加入同一房间。
      ws.send(JSON.stringify({
        type: 'join', mode: roomCode ? 'join' : 'create',
        code: roomCode || undefined, name: `bot-${index}`, team,
        gameMode: MODE, mapId: 'qinglan', difficulty: 'veteran', protocol: PROTOCOL_VERSION,
      }));
      ws.send(JSON.stringify({ type: 'ping', sent: performance.now() }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'pong') {
        const rtt = Math.max(0, performance.now() - (Number(msg.sent) || performance.now()));
        rtts.push(rtt);
        record.rtt = rtt;
      } else if (msg.type === 'joined') {
        record.id = msg.id; record.code = msg.code; record.joinedAt = Date.now();
        // 其他客户端需要用到房间号，交给主流程统一广播。
        record.ok = true;
        clearTimeout(timer); done();
      } else if (msg.type === 'state') {
        record.snapshots++;
        snapshots++;
        stateBytes += raw.length;
        if (msg.state?.phase === 'loading') ws.send(JSON.stringify({ type: 'ready', ready: true }));
      } else if (msg.type === 'error') {
        errors.push(`${record.index}: ${msg.message}`);
        if (msg.code) errorMessages++;
      }
    });
    ws.on('error', (err) => { errors.push(`${index}: ${err.message}`); clearTimeout(timer); done(); });
    ws.on('close', () => { clearTimeout(timer); done(); });
  });

  // 1) 建首房，拿到 code
  const first = await spawnClient(0);
  if (!first.ok) throw new Error(`房主建连失败：${errors.join('; ')}`);
  const code = first.code;
  clients.push(first);

  // 2) 并发加入（分小队，避免超出 SQUAD_SIZE 被拒）
  const perTeam = MODE === 'solo' || MODE === 'training' ? 1 : SQUAD_SIZE;
  const batch = [];
  for (let i = 1; i < CLIENTS; i++) {
    const team = perTeam === 1 ? 0 : Math.floor(i / perTeam);
    const client = await spawnClient(i, code, team);
    clients.push(client);
    batch.push(client);
    if (i % 8 === 0) await sleep(20);
  }
  const connected = clients.filter((c) => c.ok).length;
  const connectRate = clients.length ? clients.filter((c) => c.ok).length / clients.length : 0;

  // 3) 开始对局：房主发 start（全员 ready 由客户端消息处理）
  await sleep(300);
  for (const c of clients) if (c.ok && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'ready', ready: true }));
  await sleep(200);
  first.ws.send(JSON.stringify({ type: 'start' }));

  // 4) 持续发包 + 统计
  const inputTimer = setInterval(() => {
    for (const c of clients) {
      if (!c.ok || c.ws.readyState !== WebSocket.OPEN) continue;
      c.seq = (c.seq || 0) + 1;
      c.ws.send(JSON.stringify({ type: 'input', input: { mx: 1, mz: 0, aim: 0, seq: c.seq } }));
    }
  }, Math.max(8, Math.round(1000 / INPUT_HZ)));

  const sampleTimer = setInterval(async () => {
    try {
      const res = await fetch(`${http}/health`);
      const health = await res.json();
      if (Number.isFinite(health.tick)) rtts.length > 0 && (lastTick = health.tick);
    } catch { /* ignore */ }
  }, 1000);
  let lastTick = 0;

  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(200);
    for (const c of clients) {
      if (!c.ok || c.ws.readyState !== WebSocket.OPEN) continue;
      c.ws.send(JSON.stringify({ type: 'ping', sent: performance.now() }));
    }
  }
  clearInterval(inputTimer);
  clearInterval(sampleTimer);

  // 5) 收尾：取服务端指标
  let health = {};
  let metricsText = '';
  let roomsJson = {};
  try { health = await (await fetch(`${http}/health`)).json(); } catch (err) { errors.push(`health: ${err.message}`); }
  try { metricsText = await (await fetch(`${http}/metrics`)).text(); } catch (err) { errors.push(`metrics: ${err.message}`); }
  try { roomsJson = await (await fetch(`${http}/rooms`)).json(); } catch (err) { errors.push(`rooms: ${err.message}`); }

  for (const c of clients) { try { c.ws.close(1000, 'done'); } catch { /* ignore */ } }
  await sleep(300);
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 12000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve(signal || code); });
  });
  if (exit === 'timeout') { try { child.kill('SIGKILL'); } catch { /* ignore */ } errors.push('服务端优雅关闭超时'); }

  // 6) 指标解析
  const metric = (name, label = null) => {
    const re = label
      ? new RegExp(`^${name}\\{${label}\\} ([\\d.]+)$`, 'm')
      : new RegExp(`^${name} ([\\d.]+)$`, 'm');
    const hit = metricsText.match(re);
    return hit ? Number(hit[1]) : null;
  };
  const bucketOf = (le) => metric('mist_tick_ms_bucket', `le="${le}"`);
  const tickCount = metric('mist_tick_ms_count') || 0;
  const tickBuckets = [1, 2, 4, 8, 12, 16, 22, 33, 50, 100].map((le) => ({ le, count: bucketOf(le) || 0 }));
  const tickP = (p) => {
    if (!tickCount) return health.tick || 0;
    const target = Math.ceil(tickCount * p);
    for (const b of tickBuckets) if (b.count >= target) return b.le;
    return 100;
  };

  const sortedRtt = [...rtts].sort((a, b) => a - b);
  const heap = process.memoryUsage().heapUsed;
  const serverHeapHit = metricsText.match(/^mist_heap_bytes ([\d.]+)$/m);
  const snapshotRate = snapshots / SECONDS;

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    config: { clients: CLIENTS, seconds: SECONDS, mode: MODE, port: PORT, inputHz: INPUT_HZ },
    connect: {
      attempted: clients.length,
      succeeded: connected,
      rate: Number(connectRate.toFixed(4)),
      failed: clients.length - connected,
    },
    rtt: {
      samples: sortedRtt.length,
      avg: sortedRtt.length ? Math.round(sortedRtt.reduce((a, b) => a + b, 0) / sortedRtt.length) : 0,
      p50: Math.round(percentile(sortedRtt, 0.5)),
      p95: Math.round(percentile(sortedRtt, 0.95)),
      p99: Math.round(percentile(sortedRtt, 0.99)),
      max: sortedRtt.length ? sortedRtt.at(-1) : 0,
    },
    snapshots: {
      total: snapshots,
      perSecond: Number(snapshotRate.toFixed(2)),
      avgBytes: snapshots ? Math.round(stateBytes / snapshots) : 0,
    },
    tick: {
      samples: tickCount,
      p50: tickP(0.5),
      p95: tickP(0.95),
      p99: tickP(0.99),
      buckets: tickBuckets,
      liveP99: health.tick ?? lastTick,
      samplesHeap: 240,
    },
    server: {
      rooms: health.rooms ?? roomsJson.total ?? null,
      connections: health.connections ?? null,
      players: health.players ?? null,
      maxPlayers: health.maxPlayers ?? null,
      uptime: health.uptime ?? null,
      wsConnections: metric('mist_ws_connections'),
      playersOnline: metric('mist_players_online'),
      roomsTotal: metric('mist_rooms_total'),
      msgsJoin: metric('mist_msgs_total', 'type="join"') ?? 0,
      msgsInput: metric('mist_msgs_total', 'type="input"') ?? 0,
      rateDropped: metric('mist_rate_dropped_total') ?? 0,
      heapBytes: serverHeapHit ? Number(serverHeapHit[1]) : null,
      heapMb: serverHeapHit ? Number((Number(serverHeapHit[1]) / 1024 / 1024).toFixed(1)) : null,
    },
    clientHeapMb: Number((heap / 1024 / 1024).toFixed(1)),
    errors: { count: errors.length, messages: errors.slice(0, 10) },
    uncaught,
    serverLogTail: logs.slice(-8),
    assertions: {},
  };

  report.assertions = {
    connectRate100: report.connect.rate === 1,
    tickP99Under33: report.tick.p99 < 33,
    noUncaught: uncaught.length === 0,
    noErrors: errors.length === 0,
    snapshotsFlowing: snapshots > 0,
  };
  const passed = Object.values(report.assertions).every(Boolean);

  const outFile = new URL('load-test.json', ARTIFACTS);
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(new URL('load-test.md', ARTIFACTS), summaryMarkdown(report), 'utf8');

  console.log(`connections ${connected}/${clients.length} (${(connectRate * 100).toFixed(1)}%)`);
  console.log(`snapshots  ${snapshots} total · ${report.snapshots.perSecond}/s · ${report.snapshots.avgBytes}B avg`);
  console.log(`rtt        avg ${report.rtt.avg}ms · p50 ${report.rtt.p50} · p95 ${report.rtt.p95} · p99 ${report.rtt.p99}`);
  console.log(`tick       p50 ${report.tick.p50}ms · p95 ${report.tick.p95}ms · p99 ${report.tick.p99}ms (${tickCount} samples)`);
  console.log(`memory     server ${report.server.heapMb ?? '?'}MB · client ${report.clientHeapMb}MB`);
  console.log(`errors     ${errors.length} · uncaught ${uncaught.length}`);
  console.log(`report     ${fileURLToPath(outFile)}`);
  if (!passed) {
    console.error('✖ load test failed:', JSON.stringify(report.assertions));
    process.exit(1);
  }
  console.log('✔ load test passed');
}

function summaryMarkdown(r) {
  return [
    '# MIST ISLE 压测报告', '',
    `- 时间：${r.generatedAt}`,
    `- 规模：${r.config.clients} 客户端 · ${r.config.seconds}s · ${r.config.mode} · 输入 ${r.config.inputHz}Hz`,
    `- 连接成功率：**${(r.connect.rate * 100).toFixed(1)}%** (${r.connect.succeeded}/${r.connect.attempted})`,
    `- RTT：avg ${r.rtt.avg}ms / p50 ${r.rtt.p50} / p95 ${r.rtt.p95} / p99 ${r.rtt.p99} / max ${r.rtt.max}`,
    `- 快照：${r.snapshots.total} 条（${r.snapshots.perSecond}/s，平均 ${r.snapshots.avgBytes}B）`,
    `- 服务端 tick：p50 ${r.tick.p50}ms / p95 ${r.tick.p95}ms / p99 ${r.tick.p99}ms（${r.tick.samples} 样本）`,
    `- 堆内存：服务端 ${r.server.heapMb ?? '?'}MB · 压测进程 ${r.clientHeapMb}MB`,
    `- 错误：${r.errors.count} 条（未捕获 ${r.uncaught.length}）`, '',
    '| 断言 | 结果 |', '| --- | --- |',
    ...Object.entries(r.assertions).map(([k, v]) => `| ${k} | ${v ? '✔' : '✖'} |`),
    '', '```', ...(r.serverLogTail || []), '```', '',
  ].join('\n');
}

main().catch(async (err) => {
  console.error('[load-test] fatal', err);
  try {
    await mkdir(ARTIFACTS, { recursive: true });
    await writeFile(new URL('load-test.json', ARTIFACTS), `${JSON.stringify({ ok: false, error: String(err?.stack || err) }, null, 2)}\n`, 'utf8');
  } catch { /* ignore */ }
  process.exit(1);
});

// 兼容旧 Node 的 Array.prototype.at
if (!Array.prototype.at) Array.prototype.at = function at(n) { return this[n < 0 ? this.length + n : n]; };
// 未使用但保留：读取上一次报告做对比
export async function previousReport() {
  try { return JSON.parse(await readFile(new URL('load-test.json', ARTIFACTS), 'utf8')); } catch { return null; }
}
