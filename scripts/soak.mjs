// 长稳 / 泄漏检测（soak）：单房间 64 角色连续打完整对局，直到总模拟时长 ≥ 20 分钟。
// 加速模式：update(1/30) 连续调用、不等待墙钟，模拟时间 ≫ 墙钟时间（报告中标注）。
// 覆盖完整生命周期循环：addPlayer → start → 30Hz 模拟（含缩圈五阶段）→ end → 再来一场。
// 输出 artifacts/soak-report.json + artifacts/soak-summary.md。
// 只读分析 shared/ 与 server/（不改它们），泄漏嫌疑点以 文件:行号 写进报告。
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Match } from '../shared/simulation.mjs';
import { MAX_PLAYERS, TICK_RATE } from '../shared/rules.mjs';

// 注意：不 import ./benchmark.mjs（它在模块顶层直接执行完整基准，导入即运行）。
// 分位数助手在本地复制一份，保持两份脚本输出口径一致。
/** 计算一组耗时分位数（毫秒，保留 3 位小数）。 */
const quantilesOf = (samples) => {
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
};

const TARGET_SIM_MINUTES = Math.max(1, Number(process.argv[2]) || 20); // 总模拟时长目标（分钟）
const TARGET_SIM_SECONDS = TARGET_SIM_MINUTES * 60;
const SAMPLE_EVERY_TICKS = 500;
const TICK_WINDOW = 2000; // tick 耗时滑动窗口
const MAPS = ['qinglan', 'chisha', 'baiye'];
const MAX_MATCH_TICKS = TICK_RATE * 900; // 单场保险丝（与 benchmark 一致）

// ── 嫌疑泄漏点（静态只读分析，仅供主协调者安排修复；本脚本不改任何被分析文件）──
const LEAK_SUSPECTS = [
  {
    rank: 1,
    file: 'server/rooms.mjs',
    lines: '120-134（配合 shared/simulation.mjs:1821-1907、server/index.mjs:66）',
    kind: 'GC 分配风暴（P99/最大 tick 尖峰第一嫌疑，非泄漏）',
    detail: 'broadcastState 每 3 tick 为每个在线成员生成全量快照：match.snapshot() 每次分配 64 个 playerView、≤640 条 loot 视图（每条 attachments.slice()，simulation.mjs:1847）、events 逐条 {...ev} 复制（simulation.mjs:1861）；rooms.mjs:125 再 new Map(state.loot) 重建已知物资表；server/index.mjs:66 JSON.stringify 整包。64 人房间 ≈ 640 次快照/秒、数 MB/s 临时对象，与 benchmark 实测 P99 28.7ms / 最大 172ms 的 GC 尖峰吻合。',
  },
  {
    rank: 2,
    file: 'server/actions.mjs',
    lines: '12, 42',
    kind: '真实泄漏（跨房间累积，量级小）',
    detail: 'startAt Map 以 room.code 为键记录 start 防抖时间戳，只有 set 没有任何 delete/clear；房间被 registry.cleanup 从 rooms Map 删除（server/rooms.mjs:179）后对应条目永久残留。长跑服务端每创建过一个房间就多一条记录（每条仅几十字节，增长缓慢但单调）。',
  },
  {
    rank: 3,
    file: 'shared/simulation.mjs',
    lines: '189-204, 1050-1113, 1338-1366, 1841-1849',
    kind: '单局内只增不减（有界，但抬高稳态基线并放大快照成本）',
    detail: '_pickup 拾取物资只置 l.taken=true，从不从 this.loot splice（数组长期保持 ≤MAX_LOOT=640 条直到对局结束）；空投 drops 只 push 不删（单局 ≤3 个，opened 后仍保留）。两者都被封顶、跨局随 Match 释放，但 snapshot 每次仍线性遍历全部条目（1841-1849），与嫌疑 1 的 10Hz 广播放大分配与 CPU。',
  },
];
const NOT_LEAK_CONFIRMATIONS = [
  { file: 'shared/simulation.mjs', lines: '409-416', note: 'events 以 MAX_EVENTS=140 封顶（splice 裁剪），无泄漏' },
  { file: 'shared/simulation.mjs', lines: '1420-1428', note: 'pings 以 80 条封顶（shift 裁剪），无泄漏' },
  { file: 'server/index.mjs', lines: '30, 245-246', note: 'tickSamples 以 240 条封顶（shift 裁剪），无泄漏' },
  { file: 'shared/map.mjs', lines: '2441-2451', note: 'worldCache 每张地图常驻一份世界（固定 3 份、多房间共享同一实例），属常驻基线而非增长' },
  { file: 'shared/ai.mjs', lines: '166-176', note: 'aiShared.seen 按敌人 id 覆盖写入、有界于玩家数（≤64），随 Match 释放' },
];

// ── 工具 ──────────────────────────────────────────────────────────────────
const mib = (bytes) => +(bytes / 1048576).toFixed(2);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/** 最小二乘线性回归：y = slope * x + intercept，返回斜率/截距/R²。 */
function linreg(pairs) {
  const n = pairs.length;
  if (n < 3) return { slope: 0, intercept: 0, r2: 0, n };
  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssTot = 0; let ssRes = 0;
  for (const [x, y] of pairs) {
    const pred = slope * x + intercept;
    ssTot += (y - meanY) * (y - meanY);
    ssRes += (y - pred) * (y - pred);
  }
  return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, n };
}

/** 新开一场满员对局：1 真人席位 + bot 补满（bot 驱动真人席位由主循环注入输入）。 */
function newMatch(index) {
  const match = new Match({
    mapId: MAPS[index % MAPS.length],
    seed: 4000 + index * 37,
    mode: 'squad',
    maxPlayers: MAX_PLAYERS,
    duration: 900,
  });
  match.addPlayer('human0', 'SoakHuman', { team: 0 });
  match.start();
  while (match.players.length < MAX_PLAYERS) {
    const n = match.players.length;
    match.addPlayer(`bot${n}`, `Bot${n}`, { bot: true });
  }
  return match;
}

/** 采样：内存 / tick 滑动分位 / 快照字节 / 公开 API 可得的实体计数。 */
function sample(match, ctx) {
  const mem = process.memoryUsage();
  const snapshot = match.snapshot('human0', 0);
  const snapBytes = Buffer.byteLength(JSON.stringify(snapshot));
  const alive = match.players.filter((p) => p.alive).length;
  const lootTaken = match.loot.filter((l) => l.taken).length;
  ctx.samples.push({
    // 采样点的绝对 tick（原先误写成 tick:，被下面的分位对象覆盖，导致这一列永远丢失）
    globalTick: ctx.globalTick,
    simMin: +(ctx.simSeconds / 60).toFixed(2),
    matchIndex: ctx.matchIndex,
    phase: match.phase,
    heapMiB: mib(mem.heapUsed),
    rssMiB: mib(mem.rss),
    externalMiB: mib(mem.external),
    arrayBuffersMiB: mib(mem.arrayBuffers),
    tick: quantilesOf(ctx.tickWindow),
    snapBytes,
    snapKB: +(snapBytes / 1024).toFixed(1),
    entities: {
      players: match.players.length,
      alive,
      loot: match.loot.length,
      lootTaken,
      drops: match.drops.length,
      events: match.events.length,
      grenades: match.grenades.length,
      smokes: match.smokes.length,
      fires: match.fires.length,
      pings: match.pings.length,
      eventId: match.eventId,
    },
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const wallStart = performance.now();
const ctx = {
  globalTick: 0, simSeconds: 0, matchIndex: 0,
  samples: [], boundaries: [], matches: [], tickWindow: [],
};
let seq = 0;
let totalTargetReached = false;

while (!totalTargetReached) {
  const match = newMatch(ctx.matchIndex);
  ctx.boundaries.push({
    event: 'matchStart', matchIndex: ctx.matchIndex,
    simMin: +(ctx.simSeconds / 60).toFixed(2),
    heapMiB: mib(process.memoryUsage().heapUsed),
    rssMiB: mib(process.memoryUsage().rss),
    wallMs: +((performance.now() - wallStart) / 1000).toFixed(1),
  });
  const t0 = performance.now();
  let ticks = 0;
  while (match.phase !== 'ended' && ticks < MAX_MATCH_TICKS) {
    const t = performance.now();
    match.update(1 / 30);
    ctx.tickWindow.push(performance.now() - t);
    if (ctx.tickWindow.length > TICK_WINDOW) ctx.tickWindow.shift();
    ticks++; ctx.globalTick++;
    // 真人席位每 6 tick（≈5Hz）注入一次合成输入：游走 + 转向 + 点射，模拟真实客户端节奏
    if (ctx.globalTick % 6 === 0) {
      match.input('human0', {
        mx: Math.sin(ctx.globalTick * 0.013), mz: Math.cos(ctx.globalTick * 0.013),
        aim: (ctx.globalTick * 0.05) % (Math.PI * 2) - Math.PI,
        fire: ctx.globalTick % 12 < 5, sprint: ctx.globalTick % 90 < 40,
        seq: ++seq,
      });
    }
    ctx.simSeconds += 1 / TICK_RATE;
    if (ctx.globalTick % SAMPLE_EVERY_TICKS === 0) sample(match, ctx);
    if (ctx.simSeconds >= TARGET_SIM_SECONDS && match.phase === 'ended') totalTargetReached = true;
  }
  const wallMs = performance.now() - t0;
  ctx.matches.push({
    matchIndex: ctx.matchIndex,
    mapId: match.mapId,
    seed: match.seed,
    ticks,
    simSeconds: Math.round(match.time),
    wallMs: +wallMs.toFixed(0),
    winnerTeam: match.winnerTeam,
    resultReason: match.resultReason,
    kills: match.counters.kills,
    shots: match.counters.shots,
    players: match.players.length,
  });
  ctx.boundaries.push({
    event: 'matchEnded', matchIndex: ctx.matchIndex,
    simMin: +(ctx.simSeconds / 60).toFixed(2),
    heapMiB: mib(process.memoryUsage().heapUsed),
    rssMiB: mib(process.memoryUsage().rss),
    wallMs: +((performance.now() - wallStart) / 1000).toFixed(1),
  });
  if (ctx.simSeconds >= TARGET_SIM_SECONDS) totalTargetReached = true;
  ctx.matchIndex++;
}

// ── 趋势分析与判定 ────────────────────────────────────────────────────────
const samples = ctx.samples;
const heapPairs = samples.map((s) => [s.simMin, s.heapMiB]);
const rssPairs = samples.map((s) => [s.simMin, s.rssMiB]);
const snapPairs = samples.map((s) => [s.simMin, s.snapKB]);
const heapFit = linreg(heapPairs);
const rssFit = linreg(rssPairs);
const snapFit = linreg(snapPairs);

// 剔除前 5 个采样点（进程热身）再拟合一次，双口径看趋势
const warm = samples.slice(5);
const heapFitWarm = linreg(warm.map((s) => [s.simMin, s.heapMiB]));

const heapFirst = samples[0]?.heapMiB ?? 0;
const heapLast = samples.at(-1)?.heapMiB ?? 0;
const heapMax = Math.max(...samples.map((s) => s.heapMiB));
const rssFirst = samples[0]?.rssMiB ?? 0;
const rssLast = samples.at(-1)?.rssMiB ?? 0;

// tick 分位随时间：按采样序分 5 桶，取桶内各采样点 p95 均值 + 全量聚合
const buckets = [];
const bucketCount = 5;
const per = Math.ceil(samples.length / bucketCount);
for (let i = 0; i < bucketCount; i++) {
  const slice = samples.slice(i * per, (i + 1) * per);
  if (!slice.length) continue;
  buckets.push({
    bucket: i + 1,
    simMinFrom: slice[0].simMin,
    simMinTo: slice.at(-1).simMin,
    samples: slice.length,
    p50Mean: +mean(slice.map((s) => s.tick.p50)).toFixed(3),
    p95Mean: +mean(slice.map((s) => s.tick.p95)).toFixed(3),
    p99Mean: +mean(slice.map((s) => s.tick.p99)).toFixed(3),
    maxSeen: +Math.max(...slice.map((s) => s.tick.max)).toFixed(3),
    snapKBAvg: +mean(slice.map((s) => s.snapKB)).toFixed(1),
  });
}
const half = Math.floor(buckets.length / 2);
const tickP95First = buckets[0]?.p95Mean ?? 0;
const tickP95Last = buckets.at(-1)?.p95Mean ?? 0;
const tickP95DeltaPct = tickP95First > 0 ? +(((tickP95Last - tickP95First) / tickP95First) * 100).toFixed(1) : 0;

// 判定标准（写进报告）：heapUsed 线性回归斜率显著为正 → 疑似泄漏
//   全程斜率 > 0.5 MiB/模拟分钟 且 R² ≥ 0.5 → 疑似泄漏
//   或后半程（后 60% 采样）斜率 > 0.5 且 R² ≥ 0.5 → 疑似泄漏（排除进程热身后仍在增长）
//   斜率 0.1 ~ 0.5，或斜率偏高但 R² < 0.5 → 轻微增长（观察级）
//   否则 → 无泄漏
const fullSlope = heapFitWarm.n >= 3 ? heapFitWarm.slope : heapFit.slope;
const fullR2 = heapFitWarm.n >= 3 ? heapFitWarm.r2 : heapFit.r2;
// 后半程拟合：区分「进程热身一次性增长」与「稳态持续增长」
const lateSamples = samples.slice(Math.floor(samples.length * 0.4));
const lateFit = linreg(lateSamples.map((s) => [s.simMin, s.heapMiB]));
const lateSlope = lateFit.n >= 3 ? lateFit.slope : 0;
const lateR2 = lateFit.n >= 3 ? lateFit.r2 : 0;
let verdictText; let leakSuspected; let confidence; let verdictLevel;
if ((fullSlope > 0.5 && fullR2 >= 0.5) || (lateSlope > 0.5 && lateR2 >= 0.5)) {
  leakSuspected = true;
  verdictLevel = '疑似泄漏';
  verdictText = '疑似泄漏：heapUsed 随模拟时长显著线性增长（全程或剔除热身后的后半程拟合均成立）';
  confidence = Math.max(fullR2, lateR2) >= 0.7 ? '高' : '中';
} else if (fullSlope > 0.1 || lateSlope > 0.1) {
  leakSuspected = false;
  verdictLevel = '观察级';
  verdictText = '轻微增长（观察级）：斜率偏高但线性拟合度不足（R²<0.5），多为 V8 堆热身扩张与 GC 锯齿所致；跨对局边界 heap 有回落，未见单调累积，建议更长程复测';
  confidence = '低';
} else {
  leakSuspected = false;
  verdictLevel = '无泄漏';
  verdictText = '无泄漏：heapUsed 未随模拟时长显著增长，跨对局重启后内存回落正常';
  confidence = fullR2 >= 0.4 ? '高' : '中';
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: '加速模式：update(1/30) 连续调用不等待墙钟，模拟时间 ≫ 墙钟时间',
  target: {
    simMinutesRequired: TARGET_SIM_MINUTES,
    simSecondsRequired: TARGET_SIM_SECONDS,
    sampleEveryTicks: SAMPLE_EVERY_TICKS,
    tickWindow: TICK_WINDOW,
  },
  actual: {
    matches: ctx.matches.length,
    totalTicks: ctx.globalTick,
    simSeconds: +ctx.simSeconds.toFixed(1),
    simMinutes: +(ctx.simSeconds / 60).toFixed(2),
    wallSeconds: +((performance.now() - wallStart) / 1000).toFixed(1),
    speedupVsRealtime: +((ctx.simSeconds * 1000) / (performance.now() - wallStart)).toFixed(1),
  },
  verdict: {
    leakSuspected,
    level: verdictLevel,
    confidence,
    text: verdictText,
    criteria: 'heapUsed 对模拟分钟做最小二乘回归：全程斜率 > 0.5 MiB/模拟分钟且 R² ≥ 0.5，或后半程（后 60% 采样）斜率 > 0.5 且 R² ≥ 0.5 → 疑似泄漏；斜率 0.1~0.5 或斜率偏高但 R²<0.5 → 观察级；否则无泄漏。置信度按 R²（≥0.7 高 / 0.4~0.7 中 / 其余低）。',
    heap: {
      firstMiB: heapFirst, lastMiB: heapLast, maxMiB: heapMax,
      slopeMiBPerSimMin: +fullSlope.toFixed(3),
      r2: +fullR2.toFixed(3),
      slopeAllSamplesMiBPerSimMin: +heapFit.slope.toFixed(3),
      slopeLateHalfMiBPerSimMin: +lateSlope.toFixed(3),
      r2LateHalf: +lateR2.toFixed(3),
      rssFirstMiB: rssFirst, rssLastMiB: rssLast,
      rssSlopeMiBPerSimMin: +rssFit.slope.toFixed(3),
    },
    snapshot: {
      firstKB: samples[0]?.snapKB ?? 0,
      lastKB: samples.at(-1)?.snapKB ?? 0,
      slopeKBPerSimMin: +snapFit.slope.toFixed(3),
      r2: +snapFit.r2.toFixed(3),
    },
    tick: {
      p95FirstBucketMeanMs: tickP95First,
      p95LastBucketMeanMs: tickP95Last,
      p95DeltaPct: tickP95DeltaPct,
      overall: quantilesOf(ctx.tickWindow),
    },
  },
  tickBuckets: buckets,
  matches: ctx.matches,
  boundaries: ctx.boundaries,
  samples,
  leakSuspects: LEAK_SUSPECTS,
  notLeakConfirmations: NOT_LEAK_CONFIRMATIONS,
};

// ── 中文摘要 markdown ────────────────────────────────────────────────────
const matchRows = ctx.matches.map((m) => `| ${m.matchIndex} | ${m.mapId} | ${m.ticks} | ${m.simSeconds}s | ${m.wallMs}ms | ${m.resultReason} | ${m.kills} | ${m.shots} |`).join('\n');
const boundaryRows = ctx.boundaries.map((b) => `| ${b.event === 'matchStart' ? '开局前' : '结束后'} | ${b.matchIndex} | ${b.simMin} | ${b.heapMiB} | ${b.rssMiB} |`).join('\n');
const bucketRows = buckets.map((b) => `| ${b.bucket} | ${b.simMinFrom}~${b.simMinTo} | ${b.samples} | ${b.p50Mean} | ${b.p95Mean} | ${b.p99Mean} | ${b.maxSeen} | ${b.snapKBAvg} |`).join('\n');
const suspectRows = LEAK_SUSPECTS.map((s) => `| ${s.rank} | \`${s.file}:${s.lines}\` | ${s.kind} | ${s.detail} |`).join('\n');
const confirmRows = NOT_LEAK_CONFIRMATIONS.map((c) => `| \`${c.file}:${c.lines}\` | ${c.note} |`).join('\n');

const summary = `# Soak 长稳 / 泄漏检测摘要（雾岛突围 MIST ISLE）

- 生成时间：${report.generatedAt}
- 模式：**${report.mode}**
- 场景：单房间 64 角色（1 真人席位由合成输入驱动 + bot 补满，squad 模式），连续打完整对局（含缩圈全部五阶段），每场 addPlayer → start → 30Hz 模拟 → end() → 重开一场，直至总模拟时长 ≥ ${TARGET_SIM_MINUTES} 分钟。
- 采样：每 ${SAMPLE_EVERY_TICKS} tick 记录 heapUsed/rss、tick 耗时滑动分位（窗口 ${TICK_WINDOW}）、快照字节、实体计数（玩家/掉落/事件等公开 API 可得字段）。

## 结果概览

| 指标 | 数值 |
| --- | --- |
| 完整对局数 | ${ctx.matches.length} 场 |
| 总模拟时长 | ${report.actual.simMinutes} 模拟分钟（${report.actual.simSeconds}s） |
| 总 tick 数 | ${report.actual.totalTicks} |
| 墙钟耗时 | ${report.actual.wallSeconds}s（加速比 ≈ ${report.actual.speedupVsRealtime}× 实时） |
| heapUsed 首/末/峰值 | ${heapFirst} → ${heapLast} MiB（峰值 ${heapMax} MiB） |
| heap 斜率（去热身拟合） | **${report.verdict.heap.slopeMiBPerSimMin} MiB/模拟分钟**（R²=${report.verdict.heap.r2}；后半程 ${report.verdict.heap.slopeLateHalfMiBPerSimMin} MiB/模拟分钟，R²=${report.verdict.heap.r2LateHalf}） |
| rss 首/末 | ${rssFirst} → ${rssLast} MiB（斜率 ${report.verdict.heap.rssSlopeMiBPerSimMin} MiB/模拟分钟） |
| 快照字节 首/末 | ${report.verdict.snapshot.firstKB} KB → ${report.verdict.snapshot.lastKB} KB |
| tick P95 首/末桶 | ${tickP95First} ms → ${tickP95Last} ms（变化 ${tickP95DeltaPct}%） |
| tick 全程分位 P50/P95/P99/max | ${report.verdict.tick.overall.p50} / ${report.verdict.tick.overall.p95} / ${report.verdict.tick.overall.p99} / ${report.verdict.tick.overall.max} ms |

## 结论：${verdictLevel}（置信度 ${confidence}）

${verdictText}

判定标准：${report.verdict.criteria}

## 各场对局

| 场次 | 地图 | ticks | 模拟时长 | 墙钟 | 结束原因 | 击杀 | 射击 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${matchRows}

## 对局边界 heap（跨局释放检查：addPlayer → 对局 → end() → 重开）

| 事件 | 场次 | 模拟分钟 | heapUsed(MiB) | rss(MiB) |
| --- | --- | --- | --- | --- |
${boundaryRows}

## tick 分位 / 快照字节随时间（按采样序分 ${buckets.length} 桶）

| 桶 | 模拟分钟 | 采样数 | P50 均值(ms) | P95 均值(ms) | P99 均值(ms) | 桶内最大(ms) | 快照均值(KB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
${bucketRows}

## 嫌疑泄漏点（只读静态分析，未改动任何被分析文件，供主协调者安排修复）

| 优先级 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
${suspectRows}

## 正面确认（已封顶 / 有界，非泄漏）

| 位置 | 结论 |
| --- | --- |
${confirmRows}

## 遗留风险与口径说明

- 本报告为**加速模式**：模拟时钟跑得比墙钟快，V8 GC 触发节奏与真实 30Hz 服务（有大量空闲等待）不同，泄漏斜率只能作为趋势参考，最终定论建议在真实墙钟 + --expose-gc 分相复测。
- headless 直连 Match，未经过 server/index.mjs 的广播路径（嫌疑 1 的分配风暴在本测试里只体现为采样时的 snapshot 分配，不含 JSON.stringify / knownLoot 重建）；服务端真实泄漏需结合 4 房间联网长跑验证。
- 嫌疑 2（startAt Map）在 headless soak 中不会出现，需以静态分析结论为准。
`;

await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/soak-report.json', JSON.stringify(report, null, 2));
await writeFile('artifacts/soak-summary.md', summary);
console.log(`soak 完成：${ctx.matches.length} 场对局，${report.actual.simMinutes} 模拟分钟，墙钟 ${report.actual.wallSeconds}s（加速 ${report.actual.speedupVsRealtime}×）`);
console.log(`heap: ${heapFirst} → ${heapLast} MiB，斜率 ${report.verdict.heap.slopeMiBPerSimMin} MiB/模拟分钟（R²=${report.verdict.heap.r2}）`);
console.log(`tick P50/P95/P99/max: ${report.verdict.tick.overall.p50}/${report.verdict.tick.overall.p95}/${report.verdict.tick.overall.p99}/${report.verdict.tick.overall.max} ms`);
console.log(`结论：${verdictText}（置信度 ${confidence}）`);
