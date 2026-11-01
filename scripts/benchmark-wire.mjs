// 雾岛突围 / MIST ISLE — 二进制快照带宽基准（node scripts/benchmark-wire.mjs）
// ─────────────────────────────────────────────────────────────────────────────
// 对同一局 600 tick 的满员对局，逐帧比较三条路径的字节数与序列化耗时：
//   1. JSON（现行，含 lootPatch 差量与共享 _snapBase）
//   2. 二进制（wire v1，roster + 共享区块复用，与服务端 broadcastState 同路径）
//   3. 二进制「冷路径」（不传 shared，逐观察者独立编码；用于量化共享区块的收益）
// 同时给出：
//   - 每帧字节数（avg / p50 / p95 / max）与整局下行总量；
//   - 单帧编码耗时（μs/帧）、整轮广播耗时（64 观察者）、解码耗时；
//   - 单房间实测下行带宽（Mbps）与「64 人 × 10Hz」外推；
//   - 首次全量帧 / roster 一次性开销。
// 输出：artifacts/wire-benchmark.json（README 与 docs/CONTRACTS.md 引用其中数字）。
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { Match } from '../shared/simulation.mjs';
import { MAX_PLAYERS, PROTOCOL_VERSION, TICK_RATE, SNAPSHOT_EVERY_TICKS } from '../shared/rules.mjs';
import {
  createWireContext,
  rosterFromPlayers,
  encodeStateFrame,
  encodeSharedBlockFrame,
  decodeStateFrame,
} from '../shared/wire.mjs';
import { createGameServer } from '../server/index.mjs';

const TICKS = 600;
const SNAPSHOT_HZ = TICK_RATE / SNAPSHOT_EVERY_TICKS;
const HUMAN_SEATS = Math.min(MAX_PLAYERS, 64);
const OUTPUT = new URL('../artifacts/wire-benchmark.json', import.meta.url);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[at];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    samples: sorted.length,
    avg: +(sum / Math.max(1, sorted.length)).toFixed(2),
    p50: +percentile(sorted, 0.5).toFixed(2),
    p95: +percentile(sorted, 0.95).toFixed(2),
    max: +(sorted[sorted.length - 1] || 0).toFixed(2),
  };
}

/**
 * 建一局满员对局：第一个席位是「主观察者」，其余人类席位用于模拟 64 个真人
 * 各自不同的可见集（这样每帧的 bytes 统计才接近线上真实分布，而不是一个观众的复制）。
 */
function buildMatch() {
  const match = new Match({ mapId: 'qinglan', seed: 20261029, mode: 'squad', maxPlayers: MAX_PLAYERS, duration: 900 });
  const viewers = [];
  match.addPlayer('viewer0', '观察者0', { team: 0 });
  viewers.push('viewer0');
  for (let i = 1; i < HUMAN_SEATS; i++) {
    const id = `viewer${i}`;
    match.addPlayer(id, `观察者${i}`, { team: i % match.maxTeams });
    viewers.push(id);
  }
  match.start();
  while (match.players.length < MAX_PLAYERS) {
    const n = match.players.length;
    match.addPlayer(`bot${n}`, `机器人${n}`, { bot: true });
  }
  const roster = rosterFromPlayers(
    match.players.map((p) => ({
      id: p.id,
      name: p.name,
      bot: p.bot,
      team: p.team,
      teamName: match.teamName(p.team),
    })),
  );
  return { match, viewers, roster };
}

/** 跑完一局，逐帧重复 broadcastState 的差量逻辑（lootPatch），返回逐帧样本。 */
function measure() {
  const { match, viewers, roster } = buildMatch();
  // 每个观察者一份独立上下文：线上 roster 变化时才重建，这里用同一份静态 roster。
  const ctx = createWireContext({ roster });
  const known = new Map();
  const lastEvent = new Map();
  const frames = {
    jsonBytes: [],
    binBytes: [],
    coldBytes: [],
    jsonMs: [],
    binMs: [],
    coldMs: [],
    decodeMs: [],
  };
  let jsonTotal = 0;
  let binTotal = 0;
  let coldTotal = 0;
  let jsonBroadcastMs = 0;
  let binBroadcastMs = 0;
  let coldBroadcastMs = 0;
  let snapshotMs = 0;
  let snapshots = 0;
  let eventBearing = 0;
  let maxFrameBytes = 0;
  let firstJson = 0;
  let firstBin = 0;
  let sharedReuseHits = 0;

  const snapshotFor = (viewer) => {
    const since = lastEvent.get(viewer) || 0;
    const state = match.snapshot(viewer, since);
    const views = state.loot || [];
    const ids = new Set();
    for (let i = 0; i < views.length; i++) ids.add(views[i].id);
    const prev = known.get(viewer);
    if (prev) {
      const upsert = [];
      for (let i = 0; i < views.length; i++) if (!prev.has(views[i].id)) upsert.push(views[i]);
      const remove = [];
      for (const id of prev) if (!ids.has(id)) remove.push(id);
      delete state.loot;
      state.lootPatch = { upsert, remove };
    }
    known.set(viewer, ids);
    lastEvent.set(viewer, match.eventId);
    return state;
  };

  for (let tick = 1; tick <= TICKS; tick++) {
    match.update(1 / TICK_RATE);
    if (tick % SNAPSHOT_EVERY_TICKS !== 0) continue;
    // 先用「本帧开始前」的 since 切快照，再统一推进 lastEvent：
    // 快照里的 events 窗口与 shared 分桶键都基于同一个 since。
    const sinces = viewers.map((v) => lastEvent.get(v) || 0);
    // 快照生成单独计时：它是 JSON / 二进制两条路都逃不掉的公共成本，
    // 混进任何一侧都会让对比失真。
    let t0 = performance.now();
    const states = viewers.map((v) => snapshotFor(v));
    snapshotMs += performance.now() - t0;
    for (const state of states) if (state.events?.length) eventBearing++;

    // 与 server/rooms.mjs 的 makeSharedCache 同语义：同 since 的事件窗口只编码一次。
    const sharedBySince = new Map();
    t0 = performance.now();
    for (let i = 0; i < states.length; i++) {
      const since = sinces[i];
      let shared = sharedBySince.get(since);
      if (!shared) {
        shared = encodeSharedBlockFrame(states[i], ctx);
        sharedBySince.set(since, shared);
      } else sharedReuseHits++;
      const bin = encodeStateFrame(states[i], ctx, { shared });
      binTotal += bin.length;
      frames.binBytes.push(bin.length);
      if (!firstBin) firstBin = bin.length;
      if (bin.length > maxFrameBytes) maxFrameBytes = bin.length;
    }
    binBroadcastMs += performance.now() - t0;

    // JSON 路径：与 server/index.mjs 的 io.send(JSON.stringify({type:'state',state})) 同形。
    // 用 Buffer.byteLength 而不是 string.length：中文昵称/队名在 UTF-8 下占 3 字节，
    // 线上实际下行也是字节数，这样两条路径才可比。
    t0 = performance.now();
    for (const state of states) {
      const json = JSON.stringify({ type: 'state', state });
      const bytes = Buffer.byteLength(json);
      jsonTotal += bytes;
      frames.jsonBytes.push(bytes);
      if (!firstJson) firstJson = bytes;
    }
    jsonBroadcastMs += performance.now() - t0;

    // 冷路径（不传 shared、逐观察者独立编码）：量化共享区块复用的收益
    t0 = performance.now();
    for (const state of states) coldTotal += encodeStateFrame(state, ctx).length;
    coldBroadcastMs += performance.now() - t0;

    // 解码耗时（只取一名观察者的一帧，避免 bench 本身被解码拖慢）
    const sample = encodeStateFrame(states[0], ctx);
    t0 = performance.now();
    for (let k = 0; k < 5; k++) decodeStateFrame(sample, ctx);
    frames.decodeMs.push(((performance.now() - t0) * 1000) / 5);

    snapshots += states.length;
  }

  const rounds = frames.jsonBytes.length / viewers.length;
  const jsonFrames = frames.jsonBytes;
  const binFrames = frames.binBytes;

  return {
    config: {
      ticks: TICKS,
      players: MAX_PLAYERS,
      viewers: HUMAN_SEATS,
      snapshotHz: SNAPSHOT_HZ,
      mapId: match.mapId,
      mode: match.mode,
      seed: 20261029,
      snapshotEveryTicks: SNAPSHOT_EVERY_TICKS,
      rosterBytes: Buffer.byteLength(JSON.stringify({ type: 'roster', players: roster })),
      firstFrame: { jsonBytes: firstJson, binBytes: firstBin },
    },
    frames: { rounds, snapshots },
    bytes: {
      json: stats(jsonFrames),
      binary: stats(binFrames),
    },
    totals: {
      jsonBytes: jsonTotal,
      binaryBytes: binTotal,
      coldBinaryBytes: coldTotal,
      savingPct: +((1 - binTotal / jsonTotal) * 100).toFixed(2),
    },
    timingsMs: {
      snapshotPerRound: +(snapshotMs / rounds).toFixed(3),
      jsonBroadcastPerRound: +(jsonBroadcastMs / rounds).toFixed(3),
      binaryBroadcastPerRound: +(binBroadcastMs / rounds).toFixed(3),
      coldBinaryBroadcastPerRound: +(coldBroadcastMs / rounds).toFixed(3),
      jsonPerFrameUs: +((jsonBroadcastMs * 1000) / snapshots).toFixed(1),
      binaryPerFrameUs: +((binBroadcastMs * 1000) / snapshots).toFixed(1),
      decodePerFrameUs: +(frames.decodeMs.reduce((a, b) => a + b, 0) / frames.decodeMs.length).toFixed(1),
      sharedReuseHits,
    },
    bandwidth: {
      // 单房间、64 观察者、10Hz 快照：下行速率与 176 Mbps 的旧实测直接可比。
      seconds: TICKS / TICK_RATE,
      jsonMbps: +((jsonTotal * 8) / (TICKS / TICK_RATE) / 1e6).toFixed(2),
      binaryMbps: +((binTotal * 8) / (TICKS / TICK_RATE) / 1e6).toFixed(2),
      perViewerPerSecondBytes: +(binTotal / (TICKS / TICK_RATE) / HUMAN_SEATS).toFixed(0),
      perViewerPerSecondBytesJson: +(jsonTotal / (TICKS / TICK_RATE) / HUMAN_SEATS).toFixed(0),
    },
    notes: [
      'bytes.json 为 Buffer.byteLength(JSON.stringify({type:"state",state}))，即线上实际 UTF-8 下行字节数。',
      'bytes.binary 为 ws 直接发送的 Uint8Array 长度，含 4 字节帧头。',
      'timings 为同进程内相对比较，绝对值随机器变化；共享区块复用是 64 观察者时的主要优化。',
      'firstFrame 是新玩家/重连后的首帧（roster 之后），后续差量帧通常小得多。',
      'live 段同时挂二进制/JSON 客户端跑真实 WebSocket，统计稳态窗口内每人实际收到的字节数，与内存内测量互为校验。',
    ],
  };
}

/**
 * 真实 WebSocket A/B：同房间同时挂 N 个二进制客户端与 N 个 JSON 客户端，
 * 在 live 阶段统计窗口内每个客户端实际收到的下行字节数。
 * 与内存内测量互为校验（内存测 64 观察者全体，真实链路测协议往返与 ws 分帧开销）。
 */
async function measureLive({ perSide = 3, windowMs = 8000 } = {}) {
  const app = createGameServer({
    host: '127.0.0.1',
    port: 0,
    log: { level: 'error' },
    maxConnectionsPerIp: 32,
  });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const recs = [];
  let done = false;
  const open = (binary) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const rec = { ws, binary, bytes: 0, frames: 0, rosters: 0, ctx: null };
      ws.on('message', (data, isBinary) => {
        if (done) return;
        if (isBinary) {
          rec.bytes += data.length;
          rec.frames++;
          return;
        }
        const text = data.toString();
        rec.bytes += Buffer.byteLength(text);
        const msg = JSON.parse(text);
        if (msg.type === 'roster') {
          rec.rosters++;
          rec.ctx = createWireContext({ roster: msg.players || [] });
          return;
        }
        if (msg.type === 'state' && msg.state?.loading) ws.send(JSON.stringify({ type: 'ready', ready: true }));
      });
      recs.push(rec);
      ws.once('open', () => resolve(rec));
      ws.once('error', reject);
    });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const host = await open(true);
    host.ws.send(
      JSON.stringify({
        type: 'join',
        mode: 'create',
        name: '基准房主',
        team: 0,
        protocol: PROTOCOL_VERSION,
        binary: true,
      }),
    );
    await delay(300);
    const code = [...app.rooms.keys()][0];
    for (let i = 1; i < perSide; i++) {
      await delay(30);
      const c = await open(true);
      c.ws.send(
        JSON.stringify({
          type: 'join',
          mode: 'join',
          code,
          team: 0,
          name: `二进制${i}`,
          protocol: PROTOCOL_VERSION,
          binary: true,
        }),
      );
    }
    for (let i = 0; i < perSide; i++) {
      await delay(30);
      const c = await open(false);
      c.ws.send(
        JSON.stringify({
          type: 'join',
          mode: 'join',
          code,
          team: 1,
          name: `JSON${i}`,
          protocol: PROTOCOL_VERSION,
        }),
      );
    }
    await delay(500);
    for (const rec of recs) rec.ws.send(JSON.stringify({ type: 'ready', ready: true }));
    await delay(150);
    host.ws.send(JSON.stringify({ type: 'start' }));
    await delay(900);
    for (const rec of recs) rec.ws.send(JSON.stringify({ type: 'ready', ready: true }));
    // 等 loading → live（全员 ready 后服务端立即推进）
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const room = [...app.rooms.values()][0];
      if (room && room.match.phase === 'live') break;
      await delay(100);
    }
    await delay(1000);
    for (const rec of recs) {
      rec.bytes = 0;
      rec.frames = 0;
      rec.rosters = 0;
    }
    const t0 = Date.now();
    await delay(windowMs);
    const seconds = (Date.now() - t0) / 1000;
    const room = [...app.rooms.values()][0];
    const bin = recs.filter((r) => r.binary);
    const json = recs.filter((r) => !r.binary);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const binAvg = sum(bin.map((r) => r.bytes)) / Math.max(1, bin.length);
    const jsonAvg = sum(json.map((r) => r.bytes)) / Math.max(1, json.length);
    return {
      windowSeconds: +seconds.toFixed(2),
      phase: room?.match.phase || null,
      clientsPerSide: perSide,
      binary: {
        avgBytesPerClient: Math.round(binAvg),
        avgFramesPerClient: +(sum(bin.map((r) => r.frames)) / Math.max(1, bin.length)).toFixed(1),
        rosterMessages: sum(bin.map((r) => r.rosters)),
        downlinkMbps: +((sum(bin.map((r) => r.bytes)) * 8) / seconds / 1e6).toFixed(3),
      },
      json: {
        avgBytesPerClient: Math.round(jsonAvg),
        avgFramesPerClient: +(sum(json.map((r) => r.frames)) / Math.max(1, json.length)).toFixed(1),
        downlinkMbps: +((sum(json.map((r) => r.bytes)) * 8) / seconds / 1e6).toFixed(3),
      },
      savingPct: jsonAvg > 0 ? +((1 - binAvg / jsonAvg) * 100).toFixed(2) : 0,
    };
  } finally {
    done = true;
    for (const rec of recs) {
      try {
        rec.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    await app.close();
  }
}

const t0 = performance.now();
const result = measure();
result.live = await measureLive();
result.wallMs = Math.round(performance.now() - t0);
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);

const fmt = (n) => n.toLocaleString('en-US');
console.log('MIST ISLE · wire benchmark');
console.log(
  `  对局：${result.config.players} 人 × ${result.config.ticks} tick（10Hz 快照，${result.frames.rounds} 轮广播）`,
);
console.log(
  `  JSON   : 平均 ${fmt(result.bytes.json.avg)} B/帧（p95 ${fmt(result.bytes.json.p95)}，最大 ${fmt(result.bytes.json.max)}）`,
);
console.log(
  `  二进制 : 平均 ${fmt(result.bytes.binary.avg)} B/帧（p95 ${fmt(result.bytes.binary.p95)}，最大 ${fmt(result.bytes.binary.max)}）`,
);
console.log(`  节省   : ${result.totals.savingPct}%`);
console.log(`  单房间下行：JSON ${result.bandwidth.jsonMbps} Mbps → 二进制 ${result.bandwidth.binaryMbps} Mbps`);
console.log(
  `  广播耗时/轮（不含快照）：JSON ${result.timingsMs.jsonBroadcastPerRound} ms → 二进制 ${result.timingsMs.binaryBroadcastPerRound} ms（冷路径 ${result.timingsMs.coldBinaryBroadcastPerRound} ms；快照本身 ${result.timingsMs.snapshotPerRound} ms）`,
);
console.log(`  解码耗时：${result.timingsMs.decodePerFrameUs} μs/帧`);
console.log(
  `  首帧：JSON ${fmt(result.config.firstFrame.jsonBytes)} B → 二进制 ${fmt(result.config.firstFrame.binBytes)} B（roster 一次性 ${fmt(result.config.rosterBytes)} B）`,
);
if (result.live) {
  console.log(
    `  真实 WebSocket（${result.live.windowSeconds}s，每侧 ${result.live.clientsPerSide} 人）：JSON ${fmt(result.live.json.avgBytesPerClient)} B/人 → 二进制 ${fmt(result.live.binary.avgBytesPerClient)} B/人（-${result.live.savingPct}%）`,
  );
}
console.log(`  输出：${OUTPUT.pathname.replace(/^\//, '')}`);
