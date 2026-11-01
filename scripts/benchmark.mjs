// 性能基准：3 张地图各跑一局完整模拟 + 4 房间 × 64 角色并发模拟 + 64 socket 压力测试。
// 输出 artifacts/benchmark.json，README / ACCEPTANCE 引用其中数字。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Match } from '../shared/simulation.mjs';
import { MAX_PLAYERS, PROTOCOL_VERSION, SNAPSHOT_EVERY_TICKS, VERSION, TICK_RATE } from '../shared/rules.mjs';
import { createGameServer } from '../server/index.mjs';

const start = performance.now();
const tickTimes = [];
const simulations = [];

/** 计算一组耗时分位数（毫秒，保留 3 位小数）。 */
export function quantilesOf(samples) {
  if (!samples || !samples.length) return { p50: 0, p95: 0, p99: 0, max: 0, samples: 0 };
  const a = [...samples].sort((x, y) => x - y);
  const at = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    p50: +at(0.5).toFixed(3),
    p95: +at(0.95).toFixed(3),
    p99: +at(0.99).toFixed(3),
    max: +a[a.length - 1].toFixed(3),
    samples: a.length,
  };
}

/**
 * 单房间满员模拟：1 真人席位 + bot 补满，跑到自然结束。
 * 独立导出，供多房间场景与长稳脚本复用。
 */
export function simulateSingleRoom({ mapId, seed, duration = 900, mode = 'squad', maxPlayers = MAX_PLAYERS, tickTimes: sink = null } = {}) {
  const t0 = performance.now();
  const match = new Match({ mapId, seed, mode, maxPlayers, duration });
  match.addPlayer('human', 'Player', { team: 0 });
  match.start();
  while (match.players.length < maxPlayers) {
    const n = match.players.length;
    match.addPlayer(`bot${n}`, `Bot${n}`, { bot: true });
  }
  let ticks = 0;
  const limit = TICK_RATE * duration;
  while (match.phase !== 'ended' && ticks < limit) {
    const t = performance.now();
    match.update(1 / 30);
    if (sink) sink.push(performance.now() - t);
    ticks++;
  }
  return {
    mapId, seed, ticks,
    gameSeconds: Math.round(match.time),
    simulatedMs: Math.round(performance.now() - t0),
    alive: match.players.filter((p) => p.alive).length,
    winnerTeam: match.winnerTeam,
    worldStats: match.world && match.world.stats ? match.world.stats : {},
  };
}

/**
 * 多房间并发模拟：N 个房间同时满载，单线程按 tick 交错推进（与服务端
 * server/index.mjs 主循环一致：每超 tick 依次 update 所有存活房间）。
 * 返回各房间独立 tick 分位 + 整体超 tick 分位 + 总 CPU 时间。
 */
export function simulateMultiRoom({
  rooms = 4, mapIds = ['qinglan', 'chisha', 'baiye', 'qinglan'],
  seeds = [14, 77, 130, 3621], duration = 900, maxPlayers = MAX_PLAYERS,
} = {}) {
  const matches = [];
  const perRoom = [];
  for (let i = 0; i < rooms; i++) {
    const match = new Match({ mapId: mapIds[i], seed: seeds[i], mode: 'squad', maxPlayers, duration });
    match.addPlayer('human', 'Player', { team: 0 });
    match.start();
    while (match.players.length < maxPlayers) {
      const n = match.players.length;
      match.addPlayer(`bot${n}`, `Bot${n}`, { bot: true });
    }
    matches.push(match);
    perRoom.push({ room: i, mapId: mapIds[i], seed: seeds[i], ticks: 0, tickTimes: [], endedAtSuperTick: 0 });
  }
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  const superTicks = [];
  let live = matches.length;
  let superTick = 0;
  while (live > 0 && superTick < TICK_RATE * duration) {
    const t0 = performance.now();
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      if (match.phase === 'ended') continue;
      const t = performance.now();
      match.update(1 / 30);
      perRoom[i].tickTimes.push(performance.now() - t);
      perRoom[i].ticks++;
      if (match.phase === 'ended') {
        live--;
        perRoom[i].endedAtSuperTick = superTick;
      }
    }
    superTicks.push(performance.now() - t0);
    superTick++;
  }
  const cpuDelta = process.cpuUsage(cpu0);
  const wallMs = performance.now() - wall0;
  const roomStats = perRoom.map((r) => ({
    room: r.room, mapId: r.mapId, seed: r.seed, ticks: r.ticks,
    endedAtSuperTick: r.endedAtSuperTick || r.ticks,
    ...quantilesOf(r.tickTimes),
  }));
  const avg = (key) => +(roomStats.reduce((a, r) => a + r[key], 0) / roomStats.length).toFixed(3);
  return {
    rooms, playersPerRoom: maxPlayers, maps: mapIds,
    totalTicks: roomStats.reduce((a, r) => a + r.ticks, 0),
    wallMs: +wallMs.toFixed(0),
    totalCpuMs: {
      user: +(cpuDelta.user / 1000).toFixed(1),
      system: +(cpuDelta.system / 1000).toFixed(1),
      total: +((cpuDelta.user + cpuDelta.system) / 1000).toFixed(1),
    },
    perRoomTickMs: roomStats,
    avgRoomTickMs: { p50: avg('p50'), p95: avg('p95'), p99: avg('p99'), max: avg('max') },
    superTickMs: quantilesOf(superTicks),
  };
}

// ── 1. 三张地图各跑一局满员模拟 ──────────────────────────────────────────
for (const mapId of ['qinglan', 'chisha', 'baiye']) {
  const seed = mapId === 'qinglan' ? 14 : mapId === 'chisha' ? 77 : 130;
  simulations.push(simulateSingleRoom({ mapId, seed, tickTimes }));
}

tickTimes.sort((a, b) => a - b);
const simulatedMs = performance.now() - start;
const pct = (p) => tickTimes[Math.floor(tickTimes.length * p)] ?? tickTimes[tickTimes.length - 1];
const singleRoomRef = { p50: +pct(0.5).toFixed(3), p95: +pct(0.95).toFixed(3), p99: +pct(0.99).toFixed(3), max: +tickTimes[tickTimes.length - 1].toFixed(3) };

// ── 2. 4 房间 × 64 角色同时满载并发模拟 ──────────────────────────────────
const multi = simulateMultiRoom({});
const p95Ratio = singleRoomRef.p95 > 0 ? +(multi.avgRoomTickMs.p95 / singleRoomRef.p95).toFixed(2) : null;
const p50Ratio = singleRoomRef.p50 > 0 ? +(multi.avgRoomTickMs.p50 / singleRoomRef.p50).toFixed(2) : null;
const multiVerdict = p95Ratio != null && p95Ratio < 1.6
  ? `各房间 tick 分位与单房间基本持平（P95 比值 ${p95Ratio}），未见明显互相拖慢；超 tick 耗时约为 ${multi.rooms} 房间工作量之和，属单线程预期`
  : `房间 P95 相对单房间放大 ${p95Ratio} 倍，出现明显互相拖慢，需关注`;

// ── 3. 64 socket 并发压力（JSON 路径 + 二进制路径各跑一轮）─────────────────
// 本机合成压测的 64 个连接都来自 127.0.0.1，需显式放开单 IP 连接配额
// （guard.LIMITS.maxConnectionsPerIp 生产默认 8；压测等价于 64 台真机各自连接）。
//
// 为什么分两轮：真实浏览器客户端在 join 里带 binary:true（client/net.js:218），
// 服务端据此改发 wire 二进制帧。历史实现两轮压测共用一条纯 JSON 连接（每帧 ~6.7 KB），
// 测出来的下行带宽与 serverTick 都比生产路径悲观一个数量级。两轮都测才能回答
// 「生产路径到底占多少」以及「老客户端回退 JSON 时还剩多少余量」。
const SOCKET_PHASE_MS = 8000;

/** 一轮 64 socket 压测。binary=true 时按客户端真实能力位走 wire 帧。 */
async function runSocketLoad({ binary }) {
  const server = createGameServer({ port: 0, host: '127.0.0.1', maxConnectionsPerIp: MAX_PLAYERS });
  const address = await server.listen();
  const connections = [];
  const inputs = [];
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let code = null; let bytes = 0; let packets = 0; let errors = 0; let binaryFrames = 0;
  // 按消息类型拆分字节：单看「总下行 / 快照数」会被 killcam、roster、lobby 广播污染，
  // 算出几十 KB/帧的假数字。分开记才能判断带宽到底花在 state 还是别的大消息上。
  // 只统计稳态窗口（begin 之后）：join / start 阶段的一次性大包不参与。
  const windowBytesByType = Object.create(null);
  const windowCountByType = Object.create(null);
  const bump = (table, key, n) => { table[key] = (table[key] || 0) + n; };
  const sizeOf = (data) => (typeof data === 'string' ? Buffer.byteLength(data)
    : (data.byteLength ?? data.length ?? 0));
  try {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      ws.binaryType = 'arraybuffer';
      const connection = { ws, id: null, states: 0, lastTime: 0, rtts: [], serverMs: [], binary: false };
      const session = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Join timed out')), 10000);
        ws.on('error', reject);
        ws.on('message', (data, isBinary) => {
          // 二进制帧在 Node ws 里是 Buffer，浏览器/arraybuffer 模式下是 ArrayBuffer：
          // 两者都没有 `.length`（Buffer/ArrayBuffer 都有 byteLength），必须统一取 byteLength。
          // 历史实现用 data.length，二进制路径下恒为 undefined → 累计 bytes 变 NaN。
          const n = sizeOf(data);
          bytes += n;
          packets++;
          // 二进制帧（wire v1）不是 JSON，只能按帧计数；JSON 帧按 message.type 拆分。
          if (isBinary) {
            binaryFrames++;
            bump(windowBytesByType, 'wire:frame', n);
            bump(windowCountByType, 'wire:frame', 1);
            if (binary) connection.states++;
            return;
          }
          const message = JSON.parse(data.toString());
          const type = String(message.type || 'unknown');
          bump(windowBytesByType, type, n);
          bump(windowCountByType, type, 1);
          if (message.type === 'error') { errors++; reject(new Error(message.message)); }
          if (message.type === 'joined') {
            clearTimeout(timer);
            connection.id = message.id;
            connection.binary = message.binary === true;
            resolve(message);
          }
          if (message.type === 'state') {
            connection.states++;
            connection.lastTime = message.state.time;
            if (message.state.phase === 'loading') ws.send(JSON.stringify({ type: 'ready' }));
          }
          // 服务端 pong 回的是 { sent, time }（server/index.mjs:411），不是 t。
          // 历史实现读 message.t 导致 rtt 恒为 null；这里改用 sent 回显算往返。
          if (message.type === 'pong' && Number.isFinite(message.sent) && message.sent > 0) {
            connection.rtts.push(Date.now() - message.sent);
            connection.serverMs.push(message.time - message.sent);
          }
        });
        ws.on('open', () => ws.send(JSON.stringify({
          type: 'join', mode: i === 0 ? 'create' : 'join', code,
          team: Math.floor(i / 4), name: `Load-${i}`, protocol: PROTOCOL_VERSION,
          // 能力位：与 client/net.js 的 join 完全一致。
          binary,
        })));
      });
      const joined = await session;
      code ||= joined.code;
      connections.push(connection);
    }
    const negotiated = connections.filter((c) => c.binary).length;
    connections[0].ws.send(JSON.stringify({ type: 'start' }));
    await delay(4000);
    for (const [i, c] of connections.entries()) {
      let seq = 0;
      inputs.push(setInterval(() => {
        if (c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(JSON.stringify({
            type: 'input',
            input: { mx: Math.sin(i), mz: Math.cos(i), aim: i, fire: true, seq: ++seq },
          }));
        }
      }, 50));
      // 服务端 pong 原样回显 `sent`（server/index.mjs:411），因此 ping 必须把时间放在 `sent` 里，
      // 否则 rtt 永远拿不到数据（历史实现的 rttP50/rttP95 一直是 null）。
      c.ws.send(JSON.stringify({ type: 'ping', sent: Date.now() }));
    }
    const begin = performance.now();
    const bytesAt = bytes;
    const packetsAt = packets;
    const windowAt = { ...windowBytesByType };
    const windowCountAt = { ...windowCountByType };
    // 窗口起点的服务端状态：用于判断「tick 补跑」是否发生。
    // server/index.mjs:545 的 while (accumulator >= 1/TICK_RATE) 在被饿死时会连跑多个 tick，
    // 任何 tickCount % N 的周期性工作（如 rooms.mjs:502 的 lobby 广播）在墙钟上就会被放大 N 倍。
    const ticksAtStart = server.stats?.ticks ?? null;
    const phaseAtStart = server.rooms.get(code)?.match?.phase ?? null;
    await delay(SOCKET_PHASE_MS);
    const ticksAtEnd = server.stats?.ticks ?? null;
    const phaseAtEnd = server.rooms.get(code)?.match?.phase ?? null;
    const seconds = (performance.now() - begin) / 1000;
    assert.equal(errors, 0);
    // 快照是否在流动：协议层的底线是「每个客户端都收到了 state」。
    //
    // 历史实现硬断言「8 秒内 35+ 条」，本机实测会在 7~71 条之间大幅波动（同机模拟器 +
    // 编辑器把 CPU 占满，服务端 setInterval 被饿死），硬断言会把环境噪声当成功能回归，
    // 而且一旦在这个断言上抛出，后面的二进制压测就整段丢失。
    // 现在的口径：
    //   a) 只断言「真的在流」（> 0，协议没坏）；
    //   b) 把达成率（相对 10Hz 目标 = SNAPSHOT_EVERY_TICKS）写进报告，由 perf-report 判定；
    //   c) 每条连接都记录是否收过 state，避免个别连接被饿死却因均值达标而漏掉。
    const stateCounts = connections.map((c) => c.states);
    const minStates = Math.min(...stateCounts);
    const maxStates = Math.max(...stateCounts);
    const meanStates = +(stateCounts.reduce((a, b) => a + b, 0) / stateCounts.length).toFixed(1);
    const expectedStates = Math.floor(seconds * (TICK_RATE / SNAPSHOT_EVERY_TICKS));
    assert.ok(minStates > 0,
      `快照完全未下发（${binary ? 'binary' : 'json'}）：min=${minStates} max=${maxStates} mean=${meanStates}`
      + `（${seconds.toFixed(1)}s 内理论应有 ${expectedStates} 条）`);
    const room = server.rooms.get(code);
    const match = room.match;
    assert.equal(match.players.filter((p) => !p.bot).length, MAX_PLAYERS);

    const rtts = connections.flatMap((c) => c.rtts).sort((a, b) => a - b);
    // 服务端主循环的真实 tick 成本（含 broadcastState / killcam / 落盘）：
    // server/index.mjs 把每个 tick 的耗时压在 tickSamples（上限 240 条）里。
    // 这与上面 simulation.* 只覆盖 match.update() 的口径不同，两者相减即广播开销。
    const serverTicks = [...(server.stats?.tickSamples || [])];
    const serverTickPct = (p) => {
      if (!serverTicks.length) return null;
      const a = [...serverTicks].sort((x, y) => x - y);
      return +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(3);
    };
    // 窗口内按消息类型拆分（只看这 8 秒，不含 join/start 阶段的大包）
    const perType = Object.keys(windowBytesByType).map((type) => {
      const b = windowBytesByType[type] - (windowAt[type] || 0);
      const c = windowCountByType[type] - (windowCountAt[type] || 0);
      return {
        type,
        frames: c,
        totalKB: +(b / 1024).toFixed(1),
        avgKB: c > 0 ? +(b / c / 1024).toFixed(3) : null,
        pctOfDownlink: +(b / Math.max(1, bytes - bytesAt) * 100).toFixed(2),
        kbPerClientPerSecond: +((b / connections.length) / seconds / 1024).toFixed(2),
      };
    }).sort((a, b) => b.totalKB - a.totalKB);
    const stateEntry = perType.find((x) => x.type === 'state' || x.type === 'wire:frame');
    return {
      protocol: binary ? 'binary' : 'json',
      binaryNegotiated: negotiated,
      seconds: +seconds.toFixed(1),
      connections: connections.length,
      statesPerClient: connections.map((c) => c.states),
      statesPerClientPerSecond: +(connections.reduce((a, c) => a + c.states, 0) / connections.length / seconds).toFixed(3),
      expectedStatesPerClient: expectedStates,
      snapshotRateAchieved: expectedStates > 0 ? +(meanStates / expectedStates).toFixed(3) : null,
      binaryFrames,
      errors,
      megabytesPerSecond: +((bytes - bytesAt) / seconds / 1e6).toFixed(3),
      // 每客户端下行字节/秒：把 64 条连接的聚合带宽换算成单玩家视角
      bytesPerClientPerSecond: +(((bytes - bytesAt) / connections.length) / seconds).toFixed(1),
      // 单帧快照体积：只算 state/wire 帧，不含 killcam/roster/lobby 等大消息
      snapshotFrameKB: stateEntry?.avgKB ?? null,
      snapshotKBPerClientPerSecond: stateEntry?.kbPerClientPerSecond ?? null,
      // 全部下行 / 快照条数（会被其他消息污染，仅作对照）
      kilobytesPerState: meanStates > 0
        ? +(((bytes - bytesAt) / connections.length / meanStates) / 1024).toFixed(3)
        : null,
      downlinkByType: perType,
      // 窗口内服务端实际跑过的 tick 数：wall 8s 理论 240 个。
      // 远小于 240 = 定时器被饿死；远大于 = 补跑（catch-up）在放大周期性广播。
      serverTicksInWindow: ticksAtStart != null && ticksAtEnd != null ? ticksAtEnd - ticksAtStart : null,
      expectedTicksInWindow: +(seconds * TICK_RATE).toFixed(1),
      tickCatchUpRatio: ticksAtStart != null && ticksAtEnd != null && seconds > 0
        ? +(((ticksAtEnd - ticksAtStart) / (seconds * TICK_RATE))).toFixed(3) : null,
      matchPhaseStart: phaseAtStart,
      matchPhaseEnd: phaseAtEnd,
      eventLoopP95Ms: +(loop.percentile(95) / 1e6).toFixed(2),
      eventLoopMaxMs: +(loop.max / 1e6).toFixed(2),
      heapMiB: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
      packetsInWindow: packets - packetsAt,
      rttP50Ms: rtts.length ? rtts[Math.floor(rtts.length * 0.5)] : null,
      rttP95Ms: rtts.length ? rtts[Math.floor(rtts.length * 0.95)] : null,
      rttMaxMs: rtts.length ? rtts.at(-1) : null,
      serverTickMs: serverTicks.length ? {
        samples: serverTicks.length,
        p50: serverTickPct(0.5),
        p95: serverTickPct(0.95),
        p99: serverTickPct(0.99),
        max: +Math.max(...serverTicks).toFixed(3),
      } : null,
    };
  } finally {
    loop.disable();
    inputs.forEach(clearInterval);
    connections.forEach((c) => c.ws.terminate());
    // 兜底 race：server.close() 内部的 fallback 计时器均 unref，事件循环一旦清空，
    // 顶层 await 会以 exit 13（unsettled）收场。这个 ref 过的计时器保活循环，
    // 让 close 的 unref 兜底有机会触发；close 正常返回时本 race 立刻结束。
    await Promise.race([
      server.close(),
      new Promise((res) => { setTimeout(res, 10000); }),
    ]);
  }
}

// 生产路径先跑：即使后面的 JSON 回退轮因为环境噪声把事件循环拖垮，最关键的
// 生产路径数据也已经拿到（历史实现把所有压测放在同一个 try 里，一次断言失败全丢）。
const socketBinary = await runSocketLoad({ binary: true });
const socketJson = await runSocketLoad({ binary: false });

const report = {
  testedAt: new Date().toISOString(),
  version: VERSION,
  scope: '本机合成 socket 压测，不代表 64 台真机或公网',
  players: MAX_PLAYERS,
  simulation: {
    simulatedMs: Math.round(simulatedMs),
    totalTicks: tickTimes.length,
    p50TickMs: +pct(0.5).toFixed(3),
    p95TickMs: +pct(0.95).toFixed(3),
    p99TickMs: +pct(0.99).toFixed(3),
    maxTickMs: +tickTimes.at(-1).toFixed(3),
    budgetMs: +(1000 / 30).toFixed(2),
    matches: simulations,
  },
  multiRoom: {
    scope: '4 房间 × 64 角色同时满载，单线程按 tick 交错推进（与服务端主循环一致）',
    ...multi,
    singleRoomReference: singleRoomRef,
    crossRoomSlowdown: {
      p50Ratio,
      p95Ratio,
      verdict: multiVerdict,
    },
  },
  // network 保留「默认路径」= 生产路径（二进制），并附 JSON 回退路径做对照。
  // 历史字段（statesPerClient / megabytesPerSecond / rttP50Ms …）都从生产路径投影，
  // 保证既有读取方（README / ACCEPTANCE / perf-report）语义不变。
  network: {
    ...socketBinary,
    scope: '生产路径：join 带 binary:true，服务端下发 wire 二进制帧（与 client/net.js 一致）',
    jsonFallback: socketJson,
  },
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
