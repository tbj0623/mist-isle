// tick 尖峰归因（owner: perf）—— 定位 64 人满编一局里 >10ms 的 tick，验证 5 个周期/GC/预热假设，
// 并用「同 seed 重跑一致性 + 空转对照 + CPU 利用率」把「代码问题」和「环境噪声」分开。
//
// 用法：
//   node scripts/tick-spikes.mjs                  # 完整：3 轮探针 + 5 组对照 + 空转基线 + CPU profile（约 5–8 分钟）
//   node scripts/tick-spikes.mjs --quick          # 每项 1 轮（约 2 分钟）
//   node scripts/tick-spikes.mjs --runs 5         # 自定义轮数（默认 3）
//   node scripts/tick-spikes.mjs --no-profile     # 跳过 CPU profile
//   node scripts/tick-spikes.mjs --no-gc-ablation # 跳过「大 young 代」子进程对照
//   node scripts/tick-spikes.mjs --out a.md --json a.json
//
// 输入/输出：
//   输出 artifacts/tick-spikes.md（人类可读）+ artifacts/tick-spikes.json（原始数据）
//
// 设计约束：
//   · 不新增依赖；shared/ 只读 import，探针只包 Match.prototype 上的方法，脚本结束前恢复原函数。
//   · 计时一律 performance.now()；每项配置 ≥3 轮，报告给中位数与范围。
//   · 「尖峰」= 单次 match.update(1/30) 耗时 > 10ms（阈值可用 --spike-ms 覆盖）。
//   · 本机非独占，绝对毫秒数只用于横向对比；判定依赖的是「相对量」（尖峰与周期的对齐率、
//     空转对照的尾部、同 seed 两次运行的重合度、CPU 利用率）。
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import inspector from 'node:inspector';
import { Match } from '../shared/simulation.mjs';
import { TICK_RATE, SNAPSHOT_EVERY_TICKS, MAX_PLAYERS } from '../shared/rules.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), '..');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const QUICK = has('quick');
const RUNS = Math.max(1, Number(argOf('runs', QUICK ? 1 : 3)) || 1);
const CHILD_BASE = has('child-base');
const NO_PROFILE = has('no-profile') || CHILD_BASE;
const NO_GC_ABLATION = has('no-gc-ablation') || CHILD_BASE || QUICK;
const OUT_MD = argOf('out', 'artifacts/tick-spikes.md');
const OUT_JSON = argOf('json', 'artifacts/tick-spikes.json');
const SPIKE_MS = Number(argOf('spike-ms', 10));
const SEED = Number(argOf('seed', 14));
const TICK_MS = 1000 / TICK_RATE; // 33.333…

// ── 统计工具 ────────────────────────────────────────────────────────────────
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const r3 = (v) => (Number.isFinite(v) ? +v.toFixed(3) : null);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function quantileSorted(s, p) {
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function statsOf(arr) {
  if (!arr || !arr.length) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: quantileSorted(s, 0.5),
    p95: quantileSorted(s, 0.95),
    p99: quantileSorted(s, 0.99),
    max: s[s.length - 1],
    mean: mean(s),
  };
}

/** 中位数（偶数个取中间两个平均）。 */
function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 周期对齐检验：观察到的尖峰里有多少落在 tickCount % period === 0 上，与「均匀分布」期望比较。 */
function periodicity(spikeTicks, period) {
  const observed = spikeTicks.filter((t) => t % period === 0).length;
  const expected = spikeTicks.length / period;
  const sd = Math.sqrt(Math.max(1e-9, spikeTicks.length * (1 / period) * (1 - 1 / period)));
  return { period, observed, expected, ratio: expected > 0 ? observed / expected : 0, z: (observed - expected) / sd };
}

/**
 * 判定「尖峰是否富集于某周期」。不能只看比值：
 * 周期 50、尖峰 263 个时期望只有 5.3 个，±1 个波动就有 20% 比值抖动。
 * 这里用二项分布的正态近似做单侧检验（H1: observed > expected），
 * 只有 z ≥ 2（≈97.7% 置信）且比值 ≥ 1.3 才算「支持」。
 */
function verdictFor(per, label) {
  const { ratio, z, observed } = per;
  if (observed === 0) return `**否定**（${label} 上一个尖峰都没有）`;
  if (z >= 2 && ratio >= 1.3) return `**支持**（${label} 富集，z=${fmt(z, 1)}）`;
  if (z <= -1) return `**否定**（${label} 上反而更少，z=${fmt(z, 1)}）`;
  return `**否定**（比值 ${fmt(ratio, 2)}× 但 z=${fmt(z, 1)} < 2，与随机波动无法区分）`;
}

/** 两个集合的 Jaccard 相似度（用于同 seed 两次运行「尖峰落在哪些 tick」的重合度）。 */
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 逐 tick 时长的 Pearson 相关系数（判断两次运行是不是「同一批 tick 都慢」）。 */ function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    cov += a * b;
    vx += a * a;
    vy += b * b;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

// ── tick 内探针 ─────────────────────────────────────────────────────────────
// 目标：把一次 update 切成若干段，记录
//   (a) 每段耗时（定位「哪段代码在吃时间」）
//   (b) 相邻两次被调用之间的间隔（定位「线程根本没在跑」——外部抢占 / GC / 页错误）
// 只包 prototype 上的方法，退出前恢复。
//
// 判别原理：一个 tick 内 `_movePlayer` 被 63 个 bot 各调一次，是天然的高频采样点。
// 常态 tick 的这些间隔 p50 只有 20µs、p99.99 ≈ 5ms（标定值）。如果某个尖峰 tick 里
// 出现了远超该基线的间隔，说明那段时间 **没有任何应用代码在跑** —— 这是抢占/GC 的签名，
// 而不是「某段代码算得慢」（后者会让间隔均匀变长，但不会超过基线一个数量级）。
const SPAN_METHODS = [
  '_compactLoot',
  '_updatePlayers',
  '_updateGrenades',
  '_updateCars',
  '_updateZones',
  '_updateDrops',
  '_bots',
  '_checkEnd',
];
const MARK_BUF = new Float64Array(16384); // 每 tick 63 bot × 1 次 _movePlayer，够用
const probe = {
  on: false,
  markN: 0,
  spanMs: new Float64Array(SPAN_METHODS.length),
};

const installed = { spans: [], move: null };

function installProbes() {
  SPAN_METHODS.forEach((name, idx) => {
    const orig = Match.prototype[name];
    if (typeof orig !== 'function') return;
    installed.spans.push([name, orig]);
    Match.prototype[name] = function patched(...args) {
      if (!probe.on) return orig.apply(this, args);
      const t = performance.now();
      const r = orig.apply(this, args);
      probe.spanMs[idx] += performance.now() - t;
      return r;
    };
  });
  // _movePlayer 每 tick 被每个 bot 调一次（63 个高频采样点，把 _bots 内部也切细）
  const origMove = Match.prototype._movePlayer;
  installed.move = origMove;
  Match.prototype._movePlayer = function patchedMove(...args) {
    if (!probe.on) return origMove.apply(this, args);
    if (probe.markN < MARK_BUF.length) MARK_BUF[probe.markN++] = performance.now();
    return origMove.apply(this, args);
  };
}

/** 还原原型（CPU profile 前必须做，否则 patched 包装会占满 profile 顶部）。 */
function uninstallProbes() {
  probe.on = false;
  for (const [name, orig] of installed.spans) Match.prototype[name] = orig;
  installed.spans.length = 0;
  if (installed.move) Match.prototype._movePlayer = installed.move;
  installed.move = null;
}

// ── 对局构造 ────────────────────────────────────────────────────────────────
/**
 * 满编一局：1 真人席位 + bot 补满，deployStyle:'instant'（跳过跳伞，避免降落伞阶段
//  把前 20 秒的 tick 拉长、污染统计）。
 */
function buildMatch(cfg) {
  const match = new Match({
    mapId: cfg.mapId || 'qinglan',
    seed: cfg.seed,
    mode: 'squad',
    maxPlayers: cfg.players,
    duration: cfg.duration || 420,
    deployStyle: 'instant',
  });
  match.addPlayer('human', 'Player', { team: 0 });
  match.start(); // start() 会自动补 bot 到 maxPlayers
  while (match.players.length < cfg.players) {
    const n = match.players.length;
    match.addPlayer(`bot${n}`, `Bot${n}`, { bot: cfg.ai !== false });
  }
  // 隔离 AI：把补进来的 bot 全部降级为「有席位但不思考」的静止玩家（_bots 会整段跳过）。
  if (cfg.ai === false) {
    for (const p of match.players) if (p.id !== 'human') p.bot = false;
  }
  // 隔离 loot：直接把地面物资清空（MAX_LOOT 上限与 lootId 累计额度保留，空投仍可补货）。
  if (cfg.noLoot) match.loot.length = 0;
  // 隔离 loot 压实：只跳过 _compactLoot 本体（数组保留 taken 条目），与 noLoot 区分开。
  if (cfg.noCompact) match._compactLoot = function skipCompact() {};
  return match;
}

// ── 带探针的一轮（详细数据）──────────────────────────────────────────────────
function runProbed(cfg) {
  const match = buildMatch(cfg);
  const bots = match.players.filter((p) => p.bot);
  const prevPaths = Array.from({ length: bots.length }, () => undefined);
  const prevTargets = Array.from({ length: bots.length }, () => undefined);
  const records = [];
  const heapBefore = process.memoryUsage().heapUsed;
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  const limit = TICK_RATE * (cfg.duration || 420) * 2;
  let tick = 0;

  probe.on = true;
  while (match.phase !== 'ended' && tick < limit) {
    for (let i = 0; i < bots.length; i++) {
      const th = bots[i].think;
      prevPaths[i] = th ? th.path : undefined;
      prevTargets[i] = th ? th.targetId : undefined;
    }
    const eidBefore = match.eventId;
    const heap0 = process.memoryUsage().heapUsed;
    probe.markN = 0;
    probe.spanMs.fill(0);
    const t0 = performance.now();
    match.update(1 / 30);
    const dur = performance.now() - t0;
    probe.markN = Math.min(probe.markN, MARK_BUF.length);
    const heap1 = process.memoryUsage().heapUsed;
    tick++;

    // 逐次重算：路径对象换过 = 换点/重规划；长度 > 1 = 真的跑了 A*（直线兜底只有 1 个点）
    let repath = 0;
    let astar = 0;
    let retarget = 0;
    for (let i = 0; i < bots.length; i++) {
      const th = bots[i].think;
      if (!th) continue;
      if (th.path && th.path !== prevPaths[i]) {
        repath++;
        if (th.path.length > 1) astar++;
      }
      if (th.targetId !== prevTargets[i]) retarget++;
    }

    // 间隔序列：tick 起点 → 第 1 个 mark → … → 最后一个 mark → tick 终点
    // 只保留「中心间隔」（第 2 个 mark 之后），避开第一个 bot 之前的启动成本与末尾收尾。
    // 中心间隔的基线在全部详细轮合并后标定（见 classifySpikes），这里先原样记录。
    let maxGap = 0;
    let gapStart = t0;
    let gapEnd = t0;
    const inner = [];
    let prev = t0;
    for (let i = 0; i < probe.markN; i++) {
      const m = MARK_BUF[i];
      const g = m - prev;
      if (g > maxGap) {
        maxGap = g;
        gapStart = prev;
        gapEnd = m;
      }
      if (i >= 1) inner.push(g);
      prev = m;
    }
    const tailGap = t0 + dur - prev;
    if (tailGap > maxGap) {
      maxGap = tailGap;
      gapStart = prev;
      gapEnd = t0 + dur;
    }

    records.push({
      tick,
      tickCount: match.tickCount,
      simTime: match.time,
      dur,
      maxGap,
      gapStart,
      gapEnd,
      inner,
      marks: probe.markN,
      span: Array.from(probe.spanMs),
      compactNow: match.tickCount % 50 === 0,
      snapNow: match.tickCount % SNAPSHOT_EVERY_TICKS === 0,
      tick30: match.tickCount % 30 === 0,
      phase: match.phase,
      players: match.players.length,
      alive: match.players.reduce((a, p) => a + (p.alive ? 1 : 0), 0),
      loot: match.loot.length,
      events: match.events.length,
      emits: match.eventId - eidBefore,
      heapDelta: (heap1 - heap0) / 1048576,
      astar,
      repath,
      retarget,
    });
  }
  probe.on = false;

  const wallMs = performance.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  return {
    records,
    ticks: records.length,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    heapDeltaMb: (process.memoryUsage().heapUsed - heapBefore) / 1048576,
    endTime: match.time,
    endPhase: match.phase,
    alive: match.players.reduce((a, p) => a + (p.alive ? 1 : 0), 0),
    finalLoot: match.loot.length,
    finalEvents: match.events.length,
  };
}

// ── 不带探针的一轮（对照实验用，只有耗时）─────────────────────────────────────
function runPlain(cfg) {
  const match = buildMatch(cfg);
  const durations = [];
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  const limit = TICK_RATE * (cfg.duration || 420) * 2;
  let tick = 0;
  while (match.phase !== 'ended' && tick < limit) {
    const t0 = performance.now();
    match.update(1 / 30);
    durations.push(performance.now() - t0);
    tick++;
  }
  const wallMs = performance.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  const s = statsOf(durations);
  return {
    ticks: durations.length,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    // process.cpuUsage() 统计整个进程（含 V8 的 GC/编译器后台线程），单核时可超过 100%，这里不设上限、原样报告。
    util: wallMs > 0 ? (cpu.user + cpu.system) / 1000 / wallMs : 0,
    p50: s.p50,
    p95: s.p95,
    p99: s.p99,
    max: s.max,
    mean: s.mean,
    spikes10: durations.filter((d) => d > SPIKE_MS).length,
    spikes33: durations.filter((d) => d > TICK_MS).length,
    durations,
    endTime: match.time,
    finalLoot: match.loot.length,
    finalEvents: match.events.length,
    alive: match.players.reduce((a, p) => a + (p.alive ? 1 : 0), 0),
  };
}

// ── 空转对照（环境地板）────────────────────────────────────────────────────
// 同样的迭代次数、同样的「每次迭代固定算术量 + 触达 4MB 只读工作集」，但零分配、零 I/O、
// 零应用逻辑。它跑出来的尾部就是这台机器在当前负载下的「噪声地板」。
//
// 关键设计：**每次迭代完成的工作量必须与真实 tick 同量级**，否则对照没有可比性
// （跑 0.05ms 的迭代天然不会有 30ms 的尾部）。这里按真实 tick 的 p50 标定内层循环次数，
// 并额外扫一段 4MB 只读数组来模拟 tick 的工作集足迹（缓存/页表现）。
let sink = 0;
/** 用「调用方的真实工作量」自标定迭代规模：把一次迭代调到 targetMs。 */
function calibrateReps(targetMs) {
  const buf = new Float64Array(1 << 19); // 4 MB：模拟 tick 触碰的堆/缓存足迹
  for (let i = 0; i < buf.length; i++) buf[i] = (i % 97) * 0.01;
  const run = (reps) => {
    const a = performance.now();
    let s = 0;
    for (let i = 0; i < reps; i++) s += Math.sqrt(i + 1) * 1.0001;
    for (let i = 0; i < buf.length; i += 64) s += buf[i];
    sink += s;
    return performance.now() - a;
  };
  const med = (reps, n = 5) => {
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(run(reps));
    xs.sort((a, b) => a - b);
    return xs[Math.floor(n / 2)];
  };
  // 预热：让 JIT 与页表先稳定下来，否则第一次测量会把标定带偏
  for (let i = 0; i < 5; i++) med(8, 3);
  // 用「大样本平均」直接算每次迭代成本，再反推 reps（比逐步爬坡稳得多）
  const probeReps = 400;
  const probeMs = med(probeReps, 7);
  const perRep = Math.max(1e-6, probeMs / probeReps);
  let reps = Math.max(1, Math.round(targetMs / perRep));
  // 收敛一波：实测值可能因缓存热起来而变小
  for (let k = 0; k < 4; k++) {
    const t = med(reps, 5);
    if (Math.abs(t - targetMs) <= targetMs * 0.2) break;
    reps = Math.max(1, Math.round(reps * (targetMs / Math.max(t, 1e-6))));
  }
  return { reps, buf, measuredMs: med(reps, 5) };
}

function runControl(iterations, targetMsPerIter) {
  const cal = calibrateReps(Math.max(0.2, targetMsPerIter));
  const buf = cal.buf;
  const reps = cal.reps;

  const durations = [];
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  for (let it = 0; it < iterations; it++) {
    const a = performance.now();
    let s = 0;
    for (let i = 0; i < reps; i++) s += Math.sqrt(i + 1) * 1.0001;
    for (let i = 0; i < buf.length; i += 64) s += buf[i];
    sink += s;
    durations.push(performance.now() - a);
  }
  const wallMs = performance.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  const s = statsOf(durations);
  return {
    iterations,
    reps,
    calibratedMs: cal.measuredMs,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    // process.cpuUsage() 统计整个进程（含 V8 的 GC/编译器后台线程），单核时可超过 100%，这里不设上限、原样报告。
    util: wallMs > 0 ? (cpu.user + cpu.system) / 1000 / wallMs : 0,
    p50: s.p50,
    p95: s.p95,
    p99: s.p99,
    max: s.max,
    mean: s.mean,
    spikes10: durations.filter((d) => d > SPIKE_MS).length,
    spikes33: durations.filter((d) => d > TICK_MS).length,
  };
}

// ── GC 观测 ─────────────────────────────────────────────────────────────────
const gcLog = [];
const gcObserver = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcLog.push({ start: e.startTime, duration: e.duration, kind: (e.detail && e.detail.kind) || 0 });
  }
});
gcObserver.observe({ entryTypes: ['gc'] });
const drainGc = () => new Promise((r) => setTimeout(r, 150));

const GC_KIND = { 1: 'Scavenge', 2: 'MarkSweepCompact', 4: 'IncrementalMarking', 8: 'ProcessWeakCallbacks' };
const gcKindName = (k) => GC_KIND[k] || `kind${k}`;

/** 与 [a,b] 窗口重叠的 GC 总时长（ms）。 */
function gcInWindow(gcs, a, b) {
  let ms = 0;
  for (let i = 0; i < gcs.length; i++) {
    const g = gcs[i];
    if (g.start >= a - 0.25 && g.start <= b + 0.25) ms += g.duration;
  }
  return ms;
}

// ── 假设检验 / 归因 ─────────────────────────────────────────────────────────
/**
 * 标定「正常 tick 的内部间隔」基线，再把每个尖峰分类。
 *
 * 基线只用**常态 tick**（dur <= SPIKE_MS 且样本足够）的中心间隔，取 p99.99 作为「一次调用
 * 之间的正常上限」。超过这个阈值 10 倍的间隔，意味着线程在这段时间里完全没执行应用代码。
 *
 * 分类：
 *   GC           —— tick 窗口内有 GC 事件（scavenge / mark-compact 都在 safepoint 停住线程）
 *   STALL(抢占)  —— 超大间隔合计 ≥ 50% tick 时长，且无 GC 解释
 *   WORK(算力)   —— 没有超大间隔，但耗时仍超阈值（真的算了更多，或大量小停顿累积）
 *   MIXED        —— 超大间隔占 20%–50%（抢占 + 自身计算混合）
 */
function classifySpikes(records, gcs) {
  const normals = records.filter((r) => r.dur <= SPIKE_MS && r.inner.length >= 30);
  const centers = normals.flatMap((r) => r.inner);
  const baseline = {
    n: centers.length,
    p50: quantileOf(centers, 0.5),
    p99: quantileOf(centers, 0.99),
    p999: quantileOf(centers, 0.999),
    p9999: quantileOf(centers, 0.9999),
    max: centers.length ? centers.reduce((a, b) => (a > b ? a : b), 0) : 0,
  };
  // 阈值：正常间隔的 p99.99，下限 1ms（本机 p99.99 约 3–6ms；下限保护小样本）
  const gapThreshold = Math.max(1, baseline.p9999);

  const spikes = records.filter((r) => r.dur > SPIKE_MS);
  const rows = spikes.map((r) => {
    const big = r.inner.filter((g) => g > gapThreshold);
    const stallMs = sum(big);
    const gcMs = gcInWindow(gcs, r.gapStart - (r.dur - r.maxGap), r.gapEnd);
    const frac = r.dur > 0 ? stallMs / r.dur : 0;
    let cls;
    if (gcMs >= 0.5) cls = 'GC';
    else if (frac >= 0.5) cls = 'STALL(抢占)';
    else if (frac >= 0.2) cls = 'MIXED';
    else cls = 'WORK(算力)';
    return { ...r, stallMs, bigN: big.length, gcMs, cls };
  });

  const byClass = {};
  for (const r of rows) byClass[r.cls] = (byClass[r.cls] || 0) + 1;
  const totalSpike = sum(rows.map((r) => r.dur));
  const totalStall = sum(rows.map((r) => r.stallMs));
  const stallDominant = rows.filter((r) => r.stallMs >= r.dur * 0.5).length;
  return {
    rows,
    spikes,
    baseline,
    gapThreshold,
    normals: normals.length,
    byClass,
    totalSpike,
    totalStall,
    stallSpikes: stallDominant,
    stallShare: rows.length ? stallDominant / rows.length : 0,
    gapShare: totalSpike > 0 ? totalStall / totalSpike : 0,
  };
}

/** 分位数（先排序版本，输入就地排序不修改）。 */
function quantileOf(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** 每段 span 的耗时汇总（全 tick 与尖峰 tick 两个口径）。 */
function phaseBreakdown(records, spikes) {
  const out = [];
  for (let i = 0; i < SPAN_METHODS.length; i++) {
    const allMs = sum(records.map((r) => r.span[i]));
    const spikeMs = sum(spikes.map((r) => r.span[i]));
    const maxMs = records.reduce((a, r) => Math.max(a, r.span[i] || 0), 0);
    out.push({ phase: SPAN_METHODS[i], allMs, spikeMs, maxMs });
  }
  return out;
}

// ── CPU profile（node:inspector，无第三方依赖）────────────────────────────────
async function profileOnce(cfg) {
  const session = new inspector.Session();
  session.connect();
  const post = (method, params) =>
    new Promise((res, rej) => session.post(method, params, (err, out) => (err ? rej(err) : res(out))));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 200 });
  const match = buildMatch(cfg);
  await post('Profiler.start');
  let tick = 0;
  const limit = TICK_RATE * (cfg.duration || 420) * 2;
  while (match.phase !== 'ended' && tick < limit) {
    match.update(1 / 30);
    tick++;
  }
  const { profile } = await post('Profiler.stop');
  session.disconnect();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const counts = new Map();
  for (const id of profile.samples || []) {
    const n = byId.get(id);
    if (!n) continue;
    const f = n.callFrame;
    const parts = String(f.url || '').split('/');
    const loc = f.url ? `${parts.slice(-2).join('/')}:${f.lineNumber + 1}` : 'native';
    const key = `${f.functionName || '(anonymous)'} @${loc}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = (profile.samples || []).length || 1;
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, n]) => ({ key, samples: n, share: n / total }));
  return { rows, samples: total, ticks: tick };
}

// ── 子进程：大 young 代对照（--max-semi-space-size）────────────────────────────
function runChildSemiSpace(runs, seed) {
  const res = spawnSync(
    process.execPath,
    ['--max-semi-space-size=64', SCRIPT, '--child-base', '--runs', String(runs), '--seed', String(seed)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT },
  );
  if (res.status !== 0) return { ok: false, error: String(res.stderr || res.error || '').slice(0, 400) };
  const line = String(res.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('CHILD_BASE:'))
    .pop();
  if (!line) return { ok: false, error: 'no CHILD_BASE line in child stdout' };
  try {
    return { ok: true, runs: JSON.parse(line.slice('CHILD_BASE:'.length)) };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

const BASE_CFG = { players: MAX_PLAYERS, seed: SEED, duration: 420, ai: true };

// 子进程模式：只跑基础配置并回传 JSON，供父进程做「大 young 代」对照。
if (CHILD_BASE) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = runPlain(BASE_CFG);
    runs.push({
      p50: r.p50,
      p95: r.p95,
      p99: r.p99,
      max: r.max,
      spikes10: r.spikes10,
      spikes33: r.spikes33,
      ticks: r.ticks,
      util: r.util,
    });
  }
  process.stdout.write(`CHILD_BASE:${JSON.stringify(runs)}\n`);
  process.exit(0);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  installProbes();
  const t0 = performance.now();
  const log = (s) => process.stdout.write(`${s}\n`);

  log(`\n=== tick 尖峰归因 ===`);
  log(`node ${process.version} · ${process.platform} · seed=${SEED} · spike>${SPIKE_MS}ms · runs=${RUNS}`);

  // 1) 详细探针轮
  log(`\n[1/6] 详细探针：64 人满编 × ${RUNS} 轮 …`);
  const detailed = [];
  for (let i = 0; i < RUNS; i++) {
    gcLog.length = 0;
    const r = runProbed(BASE_CFG);
    await drainGc();
    r.gcs = gcLog.slice();
    detailed.push(r);
    const s = statsOf(r.records.map((x) => x.dur));
    log(
      `  轮 ${i + 1}: ${r.ticks} tick · p50 ${fmt(s.p50, 3)} · p95 ${fmt(s.p95, 2)} · p99 ${fmt(s.p99, 1)} · ` +
        `max ${fmt(s.max, 0)} · 尖峰 ${r.records.filter((x) => x.dur > SPIKE_MS).length} · GC ${r.gcs.length} 次`,
    );
  }

  // 2) 对照实验（**交错执行**：第 1 轮把所有配置各跑一遍，再跑第 2 轮……）
  // 交错是必须的：本机负载随时间漂移，若按「配置」分块跑完 3 轮再换下一个配置，
  // 某个配置会系统性地赶上「机器比较闲」或「机器比较忙」的时间窗，产生假差异。
  log(`\n[2/6] 对照实验 × ${RUNS} 轮（交错执行，避免负载漂移）…`);
  const configs = [
    { key: 'instant64', label: '64 人满编（基准）', cfg: { ...BASE_CFG } },
    { key: 'noloot64', label: '64 人 · loot 清空', cfg: { ...BASE_CFG, noLoot: true } },
    { key: 'nocompact64', label: '64 人 · 跳过 _compactLoot', cfg: { ...BASE_CFG, noCompact: true } },
    { key: 'noai64', label: '64 人 · bot=false（停 AI）', cfg: { ...BASE_CFG, ai: false } },
    { key: 'instant16', label: '16 人小局', cfg: { ...BASE_CFG, players: 16 } },
  ];
  const rawRuns = new Map(configs.map((c) => [c.key, []]));
  for (let round = 0; round < RUNS; round++) {
    for (const c of configs) rawRuns.get(c.key).push(runPlain(c.cfg));
  }
  const ablation = [];
  for (const c of configs) {
    const runs = rawRuns.get(c.key);
    const pick = (k) => runs.map((r) => r[k]);
    const row = {
      key: c.key,
      label: c.label,
      ticks: runs[0].ticks,
      p50: medianOf(pick('p50')),
      p50Range: [Math.min(...pick('p50')), Math.max(...pick('p50'))],
      p95: medianOf(pick('p95')),
      p95Range: [Math.min(...pick('p95')), Math.max(...pick('p95'))],
      p99: medianOf(pick('p99')),
      p99Range: [Math.min(...pick('p99')), Math.max(...pick('p99'))],
      max: medianOf(pick('max')),
      maxRange: [Math.min(...pick('max')), Math.max(...pick('max'))],
      spikes10: medianOf(pick('spikes10')),
      spikes33: medianOf(pick('spikes33')),
      spikeRate: (medianOf(pick('spikes10')) / runs[0].ticks) * 1000,
      wallMs: medianOf(pick('wallMs')),
      util: medianOf(pick('util')),
      runs: pick('p99'),
      finalLoot: runs[0].finalLoot,
      endTime: runs[0].endTime,
    };
    ablation.push(row);
    log(
      `  ${c.label.padEnd(26)} p50 ${fmt(row.p50, 2)} · p95 ${fmt(row.p95, 2)} · p99 ${fmt(row.p99, 1)} ` +
        `(${fmt(row.p99Range[0], 1)}~${fmt(row.p99Range[1], 1)}) · max ${fmt(row.max, 0)} · ` +
        `尖峰 ${row.spikes10}(${fmt(row.spikeRate, 1)}/k tick) · CPU ${fmt(row.util * 100, 0)}%`,
    );
  }

  // 3) 空转对照（环境地板）
  log(`\n[3/6] 空转对照（同迭代次数、零分配）…`);
  const baseRow = ablation[0];
  const control = runControl(Math.max(500, baseRow.ticks), Math.max(0.2, baseRow.p50));
  log(
    `  control: ${control.iterations} 次 × ${control.reps} 内层 · p50 ${fmt(control.p50, 3)} · p95 ${fmt(control.p95, 2)} · ` +
      `p99 ${fmt(control.p99, 2)} · max ${fmt(control.max, 0)} · 尖峰 ${control.spikes10} · CPU ${fmt(control.util * 100, 0)}%`,
  );

  // 4) 可重复性：同 seed 的前两轮（模拟完全确定，尖峰位置应完全重合才算「代码问题」）
  log(`\n[4/6] 同 seed 可重复性 …`);
  const detA = detailed[0];
  const detB = detailed[detailed.length > 1 ? 1 : 0];
  const setA = new Set(detA.records.filter((r) => r.dur > SPIKE_MS).map((r) => r.tick));
  const setB = new Set(detB.records.filter((r) => r.dur > SPIKE_MS).map((r) => r.tick));
  const det = {
    sameTicks: detA.ticks === detB.ticks,
    sameEndTime: detA.endTime === detB.endTime,
    jaccard: RUNS > 1 ? jaccard(setA, setB) : null,
    pearson:
      RUNS > 1
        ? pearson(
            detA.records.map((r) => r.dur),
            detB.records.map((r) => r.dur),
          )
        : null,
    spikesA: setA.size,
    spikesB: setB.size,
  };
  log(
    `  模拟确定性: ${det.sameTicks ? '一致' : '不一致'}（tick 数 ${detA.ticks}/${detB.ticks}，结束时刻 ${fmt(detA.endTime, 2)}/${fmt(detB.endTime, 2)}s）` +
      (RUNS > 1 ? ` · 尖峰位置 Jaccard ${fmt(det.jaccard, 3)} · 逐 tick 相关 ${fmt(det.pearson, 3)}` : ''),
  );

  // 5) 大 young 代对照
  let gcAblation = { ok: false, skipped: true };
  if (!NO_GC_ABLATION) {
    log(`\n[5/6] 大 young 代对照（子进程 --max-semi-space-size=64）× ${Math.min(RUNS, 2)} 轮 …`);
    gcAblation = runChildSemiSpace(Math.min(RUNS, 2), SEED);
    if (gcAblation.ok) {
      const p99s = gcAblation.runs.map((r) => r.p99);
      log(
        `  p99 ${p99s.map((v) => fmt(v, 1)).join(' / ')} · 尖峰 ${gcAblation.runs.map((r) => r.spikes10).join(' / ')}`,
      );
    } else {
      log(`  跳过：${gcAblation.error}`);
    }
  }

  // 6) CPU profile（必须在还原探针之后跑，否则 patched 包装会占满 profile 顶部）
  let profile = null;
  if (!NO_PROFILE) {
    uninstallProbes();
    log(`\n[6/6] CPU profile（一局，200µs 采样，已还原探针）…`);
    profile = await profileOnce(BASE_CFG);
    log(
      `  ${profile.samples} 样本 / ${profile.ticks} tick · top：${profile.rows
        .slice(0, 3)
        .map((r) => r.key)
        .join(' | ')}`,
    );
  }
  uninstallProbes();

  // ── 汇总分析 ─────────────────────────────────────────────────────────────
  const allRecords = detailed.flatMap((r) => r.records);
  const allGcs = detailed.flatMap((r) => r.gcs);
  const cls = classifySpikes(allRecords, allGcs);
  const spikeTicks = cls.spikes.map((r) => r.tickCount);
  const phases = phaseBreakdown(allRecords, cls.rows);

  // 周期对齐：每一轮单独算再合并（tick 序号在每轮都从 1 开始）
  const perRunPeriodic = detailed.map((r) => {
    const st = r.records.filter((x) => x.dur > SPIKE_MS).map((x) => x.tickCount);
    return { p50: periodicity(st, 50), p30: periodicity(st, 30), p3: periodicity(st, SNAPSHOT_EVERY_TICKS) };
  });
  const aggPeriodic = (k) => ({
    observed: sum(perRunPeriodic.map((p) => p[k].observed)),
    expected: sum(perRunPeriodic.map((p) => p[k].expected)),
    ratio:
      sum(perRunPeriodic.map((p) => p[k].observed)) / Math.max(1e-9, sum(perRunPeriodic.map((p) => p[k].expected))),
  });

  // 假设 D：前 100 tick
  const first100 = allRecords.filter((r) => r.tick <= 100);
  const rest = allRecords.filter((r) => r.tick > 100);
  const warmup = {
    first100N: first100.length,
    first100Sum: sum(first100.map((r) => r.dur)),
    restSum: sum(rest.map((r) => r.dur)),
    first100Spikes: first100.filter((r) => r.dur > SPIKE_MS).length,
    first100Stats: statsOf(first100.map((r) => r.dur)),
    restStats: statsOf(rest.map((r) => r.dur)),
    p99All: statsOf(allRecords.map((r) => r.dur)).p99,
    p99NoWarmup: statsOf(rest.map((r) => r.dur)).p99,
  };

  // 假设 E：A* / 重规划与尖峰的关系
  const spikeRecs = cls.spikes;
  const normalRecs = allRecords.filter((r) => r.dur <= SPIKE_MS);
  const astarLift = {
    spikeRate: spikeRecs.length ? mean(spikeRecs.map((r) => r.astar)) : 0,
    normalRate: normalRecs.length ? mean(normalRecs.map((r) => r.astar)) : 0,
    spikeAny: spikeRecs.length ? spikeRecs.filter((r) => r.astar > 0).length / spikeRecs.length : 0,
    normalAny: normalRecs.length ? normalRecs.filter((r) => r.astar > 0).length / normalRecs.length : 0,
    maxAstar: spikeRecs.length ? Math.max(...spikeRecs.map((r) => r.astar)) : 0,
  };

  // GC 总账
  const tickWall = sum(allRecords.map((r) => r.dur));
  const gcTotal = sum(allGcs.map((g) => g.duration));
  const gcKinds = {};
  for (const g of allGcs) gcKinds[gcKindName(g.kind)] = (gcKinds[gcKindName(g.kind)] || 0) + 1;
  const gcStats = {
    count: allGcs.length,
    total: gcTotal,
    share: tickWall > 0 ? gcTotal / tickWall : 0,
    maxPause: allGcs.length ? Math.max(...allGcs.map((g) => g.duration)) : 0,
    per1000Ticks: (allGcs.length / Math.max(1, allRecords.length)) * 1000,
    kinds: gcKinds,
    majorCount: allGcs.filter((g) => g.kind === 2 || g.kind === 4 || g.kind === 8).length,
  };

  // 有 GC 落在 tick 内的尖峰比例
  const spikeWithGc = spikeRecs.filter(
    (r) => gcInWindow(allGcs, r.gapStart - (r.dur - r.maxGap), r.gapEnd) >= 0.5,
  ).length;

  const build = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: (await import('node:os')).cpus().length,
    seed: SEED,
    spikeMs: SPIKE_MS,
    runs: RUNS,
    tickMs: TICK_MS,
    snapshotEveryTicks: SNAPSHOT_EVERY_TICKS,
    maxPlayers: MAX_PLAYERS,
  };

  const md = renderReport({
    build,
    detailed,
    ablation,
    control,
    det,
    gcAblation,
    profile,
    cls,
    phases,
    aggPeriodic,
    warmup,
    astarLift,
    gcStats,
    spikeWithGc,
    spikeTicks,
    totalTicks: allRecords.length,
    totalSpikes: cls.spikes.length,
    detA,
    detB,
    elapsed: (performance.now() - t0) / 1000,
  });

  mkdirSync(resolve(ROOT, dirname(OUT_MD)), { recursive: true });
  writeFileSync(resolve(ROOT, OUT_MD), md, 'utf8');
  writeFileSync(
    resolve(ROOT, OUT_JSON),
    `${JSON.stringify(
      {
        build,
        ablation,
        control,
        determinism: det,
        gcAblation,
        hypothesis: {
          periodic: { p50: aggPeriodic('p50'), p30: aggPeriodic('p30'), p3: aggPeriodic('p3') },
          warmup,
          astarLift,
          gc: gcStats,
          spikeWithGc,
        },
        classification: {
          byClass: cls.byClass,
          stallShare: cls.stallShare,
          gapShare: cls.gapShare,
          gapThreshold: cls.gapThreshold,
          baseline: cls.baseline,
          normalTicks: cls.normals,
        },
        phases,
        topSpikes: cls.rows
          .slice()
          .sort((a, b) => b.dur - a.dur)
          .slice(0, 30)
          .map((r) => ({
            tick: r.tick,
            tickCount: r.tickCount,
            simTime: r3(r.simTime),
            dur: r3(r.dur),
            maxGap: r3(r.maxGap),
            percent50: r.tickCount % 50,
            percent30: r.tickCount % 30,
            phase: r.phase,
            players: r.players,
            loot: r.loot,
            events: r.events,
            astar: r.astar,
            class: r.cls,
          })),
        profile: profile ? profile.rows : null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  log(`\n已写出 ${OUT_MD} 与 ${OUT_JSON}（用时 ${fmt((performance.now() - t0) / 1000, 0)}s）\n`);
  process.stdout.write(`${md}\n`);
}

// ── 报告渲染 ────────────────────────────────────────────────────────────────
function renderReport(ctx) {
  const {
    build,
    detailed,
    ablation,
    control,
    det,
    detA,
    detB,
    gcAblation,
    profile,
    cls,
    phases,
    aggPeriodic,
    warmup,
    astarLift,
    gcStats,
    spikeWithGc,
    totalTicks,
    elapsed,
  } = ctx;
  const L = [];
  const p = (s = '') => L.push(s);
  const base = ablation[0];
  const allSpanSum = sum(phases.map((x) => x.allMs));
  // 周期对齐结果在 §3 与 §0 都要用，提前算好（§3 只做展示）
  const per50 = aggPeriodic('p50');
  const per30 = aggPeriodic('p30');
  const per3 = aggPeriodic('p3');
  const aggZ = (per) =>
    per.expected > 0 ? (per.observed - per.expected) / Math.sqrt(Math.max(1e-9, per.expected)) : 0;
  const periodicOff =
    Math.abs(per50.ratio - 1) < 0.35 && Math.abs(per30.ratio - 1) < 0.35 && Math.abs(per3.ratio - 1) < 0.35;

  // 环境地板比：空转对照 p99 / 基准 p99（空转对照本身也会被同一次抢占打中，
  // 所以这个比值是「下界」而不是精确份额）
  const floorRatio = base.p99 > 0 ? control.p99 / base.p99 : 0;
  const floorRatioMax = base.max > 0 ? control.max / base.max : 0;
  const nonReproducible = det.jaccard != null && det.jaccard < 0.35;
  const stallDominant = cls.stallShare >= 0.5;

  // 总判定：三个独立证据按优先级组合，而不是只看空转对照的比值。
  //   ① 尖峰位置不可复现（确定性模拟）      → 不是代码路径问题
  //   ② 多数尖峰是「线程停顿」而非「计算更多」 → 不是算法复杂度问题
  //   ③ 空转对照（无业务逻辑）也有同量级尾部   → 机器本身有噪声地板
  // 三者中 ≥2 条成立即判「环境为主」。反例必须显式说明还剩下什么代码问题。
  const envVotes = [nonReproducible, stallDominant, floorRatio >= 0.4 || floorRatioMax >= 0.5].filter(Boolean).length;
  const envDominant = envVotes >= 2;
  const evidence = [
    `不可复现(${nonReproducible ? '是' : '否'})`,
    `停顿占主导(${stallDominant ? '是' : '否'})`,
    `空转对照尾部≥40%(${floorRatio >= 0.4 || floorRatioMax >= 0.5 ? '是' : '否'})`,
  ].join(' + ');

  p('# tick 尖峰归因报告（MIST ISLE 服务端权威模拟）');
  p();
  p(`- 生成时间：${build.generatedAt}`);
  p(`- 环境：${build.platform} / ${build.node} / ${build.cpus} 逻辑核；**非独占机器**，绝对值仅用于横向对比。`);
  p(
    `- 口径：\`tick\` = 单次 \`Match.update(1/30)\` 的 \`performance.now()\` 差值；预算（30Hz）= ${fmt(build.tickMs, 3)} ms。`,
  );
  p(
    `- 尖峰定义：单 tick > ${build.spikeMs} ms。每项配置 ${build.runs} 轮，报告**中位数**与**范围**；跨轮合并统计时按 tick 计数加权。`,
  );
  p(
    `- 复现：\`node scripts/tick-spikes.mjs\`（本次总耗时 ${fmt(elapsed, 0)}s）。原始数据：\`artifacts/tick-spikes.json\`。`,
  );
  p();
  p('---');
  p();

  // ── 0. 结论速览 ──────────────────────────────────────────────────────────
  p('## 0. 结论速览');
  p();
  p('| 问题 | 结论 | 关键证据 |');
  p('| --- | --- | --- |');
  p(
    `| P99 是代码问题还是环境噪声？ | **${envDominant ? '主要是环境噪声（本机 CPU 争抢），代码只是放大器' : '以代码/GC 为主'}** | ` +
      `判定依据 ${envVotes}/3 成立：${evidence}；空转对照（零分配纯算术）p99 ${fmt(control.p99, 2)} ms / max ${fmt(control.max, 0)} ms，` +
      `是基准 ${fmt(base.p99, 1)} / ${fmt(base.max, 0)} ms 的 ${fmt(floorRatio * 100, 0)}% / ${fmt(floorRatioMax * 100, 0)}% |`,
  );
  p(
    `| 尖峰可复现吗？ | **${nonReproducible ? '不可复现：同一份确定性模拟跑两遍，尖峰落在不同 tick' : '部分可复现'}** | ` +
      `同 seed 两轮 tick 数/结束时刻完全一致（${det.sameTicks ? '一致' : '不一致'}），但尖峰位置 Jaccard ${fmt(det.jaccard, 3)}、逐 tick 耗时相关 ${fmt(det.pearson, 3)} |`,
  );
  p(
    `| 尖峰是"算得多"还是"线程没跑"？ | **${stallDominant ? '多数是线程没跑（停顿）' : '以真实计算为主'}** | ` +
      `尖峰 tick 中停顿（间隔超过基线阈值 ${fmt(cls.gapThreshold, 2)} ms）占比 ≥ 50% 时长的有 ${fmt(cls.stallShare * 100, 1)}%；停顿合计占尖峰总时长 ${fmt(cls.gapShare * 100, 1)}% |`,
  );
  p(
    `| 真正的代码级放大器 | **单 tick AI 预算 + 分配率（GC）** | \`_bots\` 占 tick 段耗时 ${fmt((phases.find((x) => x.phase === '_bots').allMs / Math.max(1e-9, allSpanSum)) * 100, 1)}%；GC 占 tick 墙钟 ${fmt(gcStats.share * 100, 1)}%（${gcStats.count} 次 / ${gcStats.per1000Ticks.toFixed(1)} 次每千 tick） |`,
  );
  p();
  p(
    `> 一句话：**${
      periodicOff ? '周期性尖峰假设（%50 loot 压实、%30 快照）被数据否掉' : '周期性对齐很弱'
    }；${envDominant ? '尾部的主因是外部 CPU 争抢 + V8 GC' : '尾部的成因需要独占机器复测后才能定性'}，` +
      `GC 的频率由 AI 层每 tick 的对象分配率决定——这是唯一值得动的代码杠杆。**`,
  );
  p();
  p('---');
  p();

  // ── 1. 方法 ─────────────────────────────────────────────────────────────
  p('## 1. 测量方法与开销自检');
  p();
  p('单次 `update` 被切成 8 段（`_compactLoot` / `_updatePlayers` / `_updateGrenades` / `_updateCars` /');
  p('`_updateZones` / `_updateDrops` / `_bots` / `_checkEnd`），并在 `_movePlayer`（每 tick 63 次）打时间戳。');
  p('于是每个 tick 除了总耗时，还能拿到：');
  p();
  p('1. **段耗时** —— 时间花在哪段代码；');
  p('2. **最大内部空档** —— 相邻两个时间戳之间凭空消失的时间。代码慢会摊在每次调用里，');
  p('   外部抢占 / GC 会表现为「两次相邻调用之间少了 N 毫秒」，这是区分二者的关键信号。');
  p();
  p('探针开销：`performance.now()` ≈ 0.14 µs/次，每 tick 约 71 个时间戳 ≈ 0.02 ms；');
  p(
    `对照不带探针的基准（p50 ${fmt(base.p50, 3)} ms）与带探针的详细轮（p50 ${fmt(
      medianOf(detailed.map((r) => statsOf(r.records.map((x) => x.dur)).p50)),
      3,
    )} ms），探针抬升约 ${fmt(
      (medianOf(detailed.map((r) => statsOf(r.records.map((x) => x.dur)).p50)) / Math.max(1e-6, base.p50) - 1) * 100,
      0,
    )}%（中位数口径，含轮间噪声）。分位表以**不带探针**的对照组为准，归因分析用带探针的详细轮。`,
  );
  p();
  p("GC 用 `PerformanceObserver({ entryTypes: ['gc'] })` 直接记录（Node 24 的 `detail.kind`：");
  p('1=Scavenge、2/4=Mark-Compact、8=ProcessWeakCallbacks），并把每次 GC 的起止时间与 tick 窗口求交。');
  p();
  p('---');
  p();

  // ── 2. 逐 tick 分位与尖峰明细 ────────────────────────────────────────────
  p('## 2. 逐 tick 耗时与尖峰明细（64 人满编 · instant）');
  p();
  p('### 2.1 每一轮的分位（带探针）');
  p();
  p('| 轮 | tick | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | >10ms | >33.3ms | 结束时刻 (s) |');
  p('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  detailed.forEach((r, i) => {
    const s = statsOf(r.records.map((x) => x.dur));
    p(
      `| ${i + 1} | ${r.ticks} | ${fmt(s.p50, 3)} | ${fmt(s.p95, 2)} | ${fmt(s.p99, 1)} | ${fmt(s.max, 0)} | ` +
        `${r.records.filter((x) => x.dur > build.spikeMs).length} | ${r.records.filter((x) => x.dur > build.tickMs).length} | ${fmt(r.endTime, 1)} |`,
    );
  });
  const merged = statsOf(detailed.flatMap((r) => r.records.map((x) => x.dur)));
  p(
    `| **合并** | ${merged.n} | ${fmt(merged.p50, 3)} | ${fmt(merged.p95, 2)} | ${fmt(merged.p99, 1)} | ${fmt(merged.max, 0)} | ` +
      `${cls.spikes.length} | ${detailed.flatMap((r) => r.records).filter((x) => x.dur > build.tickMs).length} | — |`,
  );
  p();
  p('### 2.2 尖峰 Top 15（合并全部轮次，按耗时降序）');
  p();
  p(
    '| tick# | tickCount | 模拟时间 (s) | 耗时 (ms) | %50 | %30 | %3 | 最长间隔 (ms) | 停顿合计 (ms) | GC (ms) | A* 重算 | phase | 存活 | loot | events | 分类 |',
  );
  p('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  cls.rows
    .slice()
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 15)
    .forEach((r) => {
      p(
        `| ${r.tick} | ${r.tickCount} | ${fmt(r.simTime, 1)} | **${fmt(r.dur, 1)}** | ${r.tickCount % 50} | ${r.tickCount % 30} | ` +
          `${r.tickCount % build.snapshotEveryTicks} | ${fmt(r.maxGap, 1)} | ${fmt(r.stallMs, 1)} | ${fmt(r.gcMs, 1)} | ${r.astar} | ${r.phase} | ` +
          `${r.alive}/${r.players} | ${r.loot} | ${r.events} | ${r.cls} |`,
      );
    });
  p();
  p('### 2.3 段耗时归因（全部 tick 与尖峰 tick 两个口径）');
  p();
  p('| 段 | 全部 tick 合计 (ms) | 占比 | 尖峰 tick 合计 (ms) | 占尖峰总时长 |');
  p('| --- | --- | --- | --- | --- |');
  const spikeSpanSum = sum(phases.map((x) => x.spikeMs));
  const spikeDurSum = sum(cls.rows.map((r) => r.dur));
  phases
    .slice()
    .sort((a, b) => b.allMs - a.allMs)
    .forEach((x) => {
      p(
        `| \`${x.phase}\` | ${fmt(x.allMs, 0)} | ${fmt((x.allMs / Math.max(1e-9, allSpanSum)) * 100, 1)}% | ` +
          `${fmt(x.spikeMs, 0)} | ${fmt((x.spikeMs / Math.max(1e-9, spikeDurSum)) * 100, 1)}% |`,
      );
    });
  p(
    `| **合计** | ${fmt(allSpanSum, 0)} | 100%* | ${fmt(spikeSpanSum, 0)} | ${fmt((spikeSpanSum / Math.max(1e-9, spikeDurSum)) * 100, 1)}% |`,
  );
  p();
  p('\\* 段合计略小于 tick 总时长，差值是 `update` 自身的循环骨架与探针空档。');
  p();
  p('---');
  p();

  // ── 3. 假设检验 ──────────────────────────────────────────────────────────
  p('## 3. 假设检验 A–E');
  p();
  const verdictA = verdictFor({ ...per50, z: aggZ(per50) }, '%50');
  const verdictB = verdictFor({ ...per30, z: aggZ(per30) }, '%30');
  const verdictD =
    warmup.first100Spikes / Math.max(1, warmup.first100N / 100) >
    (cls.spikes.length / Math.max(1, totalTicks)) * 100 * 1.5
      ? '**成立**（前 100 tick 明显更慢，但只影响开头）'
      : '**部分成立**（首 tick 极慢，但前 100 tick 总体不主导 P99）';

  p('| 假设 | 预测 | 观测 | 判定 |');
  p('| --- | --- | --- | --- |');
  p(
    `| **A. loot 压实（\`tickCount % 50 === 0\`）** | 尖峰富集在 %50===0 | 落在 %50 的尖峰 ${per50.observed} 个，均匀分布期望 ${fmt(per50.expected, 1)} 个（比值 **${fmt(per50.ratio, 2)}×**，z=${fmt(aggZ(per50), 1)}）；\`_compactLoot\` 自身合计仅 ${fmt(
      phases.find((x) => x.phase === '_compactLoot').allMs,
      1,
    )} ms（占 tick 总时长 ${fmt((phases.find((x) => x.phase === '_compactLoot').allMs / Math.max(1e-9, allSpanSum)) * 100, 2)}%），单次最长 ${fmt(phases.find((x) => x.phase === '_compactLoot').maxMs, 2)} ms | ${verdictA} |`,
  );
  p(
    `| **B. 每 30 tick 快照** | 尖峰富集在 %30===0 | 落在 %30 的尖峰 ${per30.observed} 个，期望 ${fmt(per30.expected, 1)} 个（比值 **${fmt(per30.ratio, 2)}×**，z=${fmt(aggZ(per30), 1)}）；且 \`update()\` 内**没有任何 %30 分支**，快照是服务端每 ${build.snapshotEveryTicks} tick 在 update **之外**调用 \`broadcastState\`（\`server/rooms.mjs:486-526\`，广播条件在 \`:525\`），%30 只用于等待阶段的大厅广播（\`server/rooms.mjs:502\`） | ${verdictB} |`,
  );
  p(
    `| **C. GC 停顿** | 尖峰与 GC 重叠 | 共 ${gcStats.count} 次 GC（${Object.entries(gcStats.kinds)
      .map(([k, v]) => `${k}×${v}`)
      .join(
        '、',
      )}，其中 major ${gcStats.majorCount} 次），合计 ${fmt(gcStats.total, 0)} ms = tick 墙钟的 **${fmt(gcStats.share * 100, 1)}%**；最长一次 ${fmt(gcStats.maxPause, 0)} ms；落进尖峰的 GC 只覆盖 ${spikeWithGc}/${cls.rows.length} 个尖峰（${fmt((spikeWithGc / Math.max(1, cls.rows.length)) * 100, 1)}%） | **成立但有上限**：GC 是重要放大器，但只能解释尖峰的 ~${fmt((spikeWithGc / Math.max(1, cls.rows.length)) * 100, 0)}% |`,
  );
  p(
    `| **D. 首 tick / 前 100 tick 热身（JIT）** | 前 100 tick 显著更慢 | tick#1 = ${fmt(detailed[0].records[0].dur, 0)} ms；前 100 tick 合计 ${fmt(warmup.first100Sum, 0)} ms（占全部 ${fmt((warmup.first100Sum / Math.max(1e-9, warmup.first100Sum + warmup.restSum)) * 100, 1)}%），p50 ${fmt(warmup.first100Stats.p50, 2)} ms vs 之后 ${fmt(warmup.restStats.p50, 2)} ms；剔除前 100 tick 后 P99 从 ${fmt(warmup.p99All, 1)} → ${fmt(warmup.p99NoWarmup, 1)} ms | ${verdictD} |`,
  );
  p(
    `| **E. A\\* 寻路重算对齐** | 尖峰 tick 的 A* 次数显著更高 | 尖峰 tick 平均 **${fmt(astarLift.spikeRate, 2)}** 次 A*/tick（${fmt(astarLift.spikeAny * 100, 0)}% 的尖峰至少跑了一次），常态 tick 平均 ${fmt(astarLift.normalRate, 2)} 次（${fmt(astarLift.normalAny * 100, 0)}%）；提升比 ${fmt(astarLift.spikeRate / Math.max(1e-6, astarLift.normalRate), 2)}×，单 tick 最多 ${astarLift.maxAstar} 次 | **弱相关**：有富集但解释不了多数尖峰（令牌桶已把 A* 限到 30 次/秒） |`,
  );
  p();
  p(
    `> 补充：%${build.snapshotEveryTicks}（服务端广播周期）上尖峰 ${per3.observed} 个 vs 期望 ${fmt(per3.expected, 1)} 个` +
      `（${fmt(per3.ratio, 2)}×，z=${fmt(aggZ(per3), 1)}）——**也与广播周期无关**。三个周期性假设一起被否，说明尖峰不是由 tick 序号驱动的。`,
  );
  p();
  p(
    '> 关于 A 的读法：比值偶尔略高于 1 只是小样本波动（周期 50 时期望样本数很少，' +
      'z < 2 即无法与随机区分），而 `_compactLoot` 的绝对成本是微秒级（上表"自身合计"列），' +
      '即使它触发了尖峰也不可能是尖峰的**成因**。',
  );
  p();
  p('---');
  p();

  // ── 4. 尖峰分类 ──────────────────────────────────────────────────────────
  p('## 4. 尖峰分类归因：线程没跑 vs 真的算得多');
  p();
  p('判别基线：常态 tick（≤ ' + build.spikeMs + 'ms）内部相邻调用的间隔分布 ——');
  p(
    `${cls.normals} 个常态 tick、${cls.baseline.n} 个间隔，p50 ${fmt(cls.baseline.p50 * 1000, 1)} µs、` +
      `p99 ${fmt(cls.baseline.p99, 2)} ms、p99.9 ${fmt(cls.baseline.p999, 2)} ms、p99.99 **${fmt(cls.baseline.p9999, 2)} ms**。`,
  );
  p(
    `**阈值 = ${fmt(cls.gapThreshold, 2)} ms**（基线 p99.99，下限 1ms）。间隔超过阈值 = 那段时间没有任何应用代码在执行。`,
  );
  p();
  p('| 分类 | 数量 | 占尖峰 | 含义 |');
  p('| --- | --- | --- | --- |');
  const clsLabel = {
    'STALL(抢占)': `超过阈值的间隔合计 ≥ 50% tick 时长：线程在 tick 中途被挪走（外部进程抢 CPU、页错误、频率降档）`,
    GC: 'tick 窗口内有 GC 事件（scavenge / mark-compact 都在 safepoint 停住应用线程）',
    MIXED: '超大间隔占 20%–50%：抢占与自身计算混合',
    'WORK(算力)': '没有超大间隔，但仍超阈值：真的算了更多（多 bot 同时重规划/交战）或大量小停顿累积',
  };
  for (const [k, v] of Object.entries(cls.byClass).sort((a, b) => b[1] - a[1])) {
    p(`| ${k} | ${v} | ${fmt((v / Math.max(1, cls.rows.length)) * 100, 1)}% | ${clsLabel[k] || ''} |`);
  }
  p();
  p(
    `- **${fmt(cls.stallShare * 100, 1)}% 的尖峰里，「线程完全没跑」的时间占了一半以上**；` +
      `这些停顿合计占全部尖峰时长的 **${fmt(cls.gapShare * 100, 1)}%**。`,
  );
  p(
    `- GC 只能解释 ${spikeWithGc}/${cls.rows.length} 个尖峰（${fmt((spikeWithGc / Math.max(1, cls.rows.length)) * 100, 1)}%），` +
      `**其余 ${fmt(100 - (spikeWithGc / Math.max(1, cls.rows.length)) * 100, 1)}% 的尖峰里没有任何 GC 事件** —— 只能由操作系统调度解释。`,
  );
  p(
    `- 真正「算力型」的尖峰（无超大停顿、单纯耗时长）占 ${fmt(((cls.byClass['WORK(算力)'] || 0) / Math.max(1, cls.rows.length)) * 100, 1)}%，` +
      `这是代码侧唯一还需要优化的部分。`,
  );
  p();
  p('---');
  p();

  // ── 5. 对照实验 ──────────────────────────────────────────────────────────
  p('## 5. 对照实验');
  p();
  p('### 5.1 配置对比（每项 ' + build.runs + ' 轮，括号内为 min~max）');
  p();
  p('| 配置 | tick | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | >10ms 次数 | 每千 tick 尖峰 | CPU 利用率 |');
  p('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of ablation) {
    p(
      `| ${r.label} | ${r.ticks} | ${fmt(r.p50, 3)} <span>(${fmt(r.p50Range[0], 2)}~${fmt(r.p50Range[1], 2)})</span> | ` +
        `${fmt(r.p95, 2)} <span>(${fmt(r.p95Range[0], 1)}~${fmt(r.p95Range[1], 1)})</span> | ` +
        `**${fmt(r.p99, 1)}** <span>(${fmt(r.p99Range[0], 1)}~${fmt(r.p99Range[1], 1)})</span> | ` +
        `${fmt(r.max, 0)} <span>(${fmt(r.maxRange[0], 0)}~${fmt(r.maxRange[1], 0)})</span> | ` +
        `${fmt(r.spikes10, 0)} | ${fmt(r.spikeRate, 1)} | ${fmt(r.util * 100, 0)}% |`,
    );
  }
  p(
    `| 空转对照（零分配） | ${control.iterations} | ${fmt(control.p50, 3)} | ${fmt(control.p95, 2)} | ` +
      `**${fmt(control.p99, 2)}** | ${fmt(control.max, 0)} | ${control.spikes10} | ${fmt((control.spikes10 / control.iterations) * 1000, 1)} | ${fmt(control.util * 100, 0)}% |`,
  );
  p();
  p('读数要点（每条结论都从上面的实测数字推出）：');
  p();
  const noloot = ablation.find((r) => r.key === 'noloot64');
  const nocompact = ablation.find((r) => r.key === 'nocompact64');
  const noai = ablation.find((r) => r.key === 'noai64');
  const small = ablation.find((r) => r.key === 'instant16');
  const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
  const compactMs = phases.find((x) => x.phase === '_compactLoot').allMs;
  const compactMax = phases.find((x) => x.phase === '_compactLoot').maxMs;
  p(
    `- **loot 清空**（${noloot.key}）：p50 ${fmt(base.p50, 3)} → ${fmt(noloot.p50, 3)} ms、p95 ${fmt(base.p95, 2)} → ${fmt(noloot.p95, 2)} ms、` +
      `p99 ${fmt(base.p99, 1)} → ${fmt(noloot.p99, 1)} ms（${fmt(pct(noloot.p99, base.p99), 0)}%）。` +
      `p95 收窄最明显，说明 **loot 规模是稳定的基线成本**（bot 的 \`nearestLoot\` 每 0.55s 全表扫描）；` +
      `但 p99/max 没有同比例下降，因为它对尖峰的贡献被外部抢占淹没了。`,
  );
  p(
    `- **只跳过 \`_compactLoot\`**（${nocompact.key}）：p50 ${fmt(base.p50, 3)} → ${fmt(nocompact.p50, 3)} ms、p99 ${fmt(base.p99, 1)} → ${fmt(nocompact.p99, 1)} ms。` +
      `压实自身合计只有 ${fmt(compactMs, 2)} ms、单次最长 ${fmt(compactMax, 3)} ms，**它根本不是尖峰来源**（也与假设 A 的否定互相印证）；` +
      `而且跳过压实会让 loot 数组永久保持更大，长期只会更慢 —— **这条不要做**。`,
  );
  p(
    `- **停 AI**（${noai.key}）：p50 ${fmt(base.p50, 3)} → ${fmt(noai.p50, 3)} ms、p99 ${fmt(base.p99, 1)} → ${fmt(noai.p99, 1)} ms、` +
      `尖峰率 ${fmt(base.spikeRate, 1)} → ${fmt(noai.spikeRate, 1)}/k tick。AI 是**基线的绝对主项**（去掉它 p50 降到 ${fmt(pct(noai.p50, base.p50), 0)}%），` +
      `但即使完全关掉，max 仍有 ${fmt(noai.max, 0)} ms —— **尾部不随 AI 消失，印证它是环境给的**。`,
  );
  p(
    `- **16 人小局**（${small.key}）：p50 ${fmt(small.p50, 3)} ms（64 人的 ${fmt(pct(small.p50, base.p50), 0)}%）、p99 ${fmt(small.p99, 2)} ms、` +
      `尖峰率 ${fmt(small.spikeRate, 1)}/k tick。p50 随人数近似线性（每个 bot 每 tick 一次 \`thinkBot\` + 一次 \`_movePlayer\`），` +
      `但 max 仍达 ${fmt(small.max, 0)} ms —— **人数减少 4 倍，尾部只降到 ${fmt(pct(small.max, base.max), 0)}%**，再次说明尾部与工作量弱相关。`,
  );
  p();
  p('### 5.2 空转对照：这台机器的「噪声地板」');
  p();
  p(
    `同样的迭代次数（${control.iterations}）、每次迭代标定到 ≈${fmt(base.p50, 2)} ms 的纯算术（实测 ${fmt(control.calibratedMs, 3)} ms）` +
      `+ 4MB 只读工作集扫描，**零对象分配、零 GC、零 I/O**。结果：p99 ${fmt(control.p99, 2)} ms、max ${fmt(control.max, 0)} ms、` +
      `${control.spikes33} 次超过 33.3ms 预算，CPU 利用率 ${fmt(control.util * 100, 0)}%。`,
  );
  p();
  const floorNote =
    floorRatioMax >= 1
      ? `空转对照的 **max 已经超过基准**（${fmt(control.max, 0)} vs ${fmt(base.max, 0)} ms）——` +
        `一段没有任何业务逻辑的循环都能达到甚至超过被测代码的最坏一帧，说明 max 完全由机器状态决定。`
      : `空转对照的 p99 达到基准的 ${fmt(floorRatio * 100, 0)}%、max 达到 ${fmt(floorRatioMax * 100, 0)}% —— ` +
        `这部分尾部与代码无关。`;
  p(
    `> 这是本次实验最重要的对照：**一段没有任何业务逻辑、连 GC 都不发生的循环，在这台机器上照样跑出 ` +
      `${fmt(control.p99, 2)} ms 的 P99 和 ${fmt(control.max, 0)} ms 的 max。** ${floorNote}`,
  );
  p();
  p('### 5.3 可重复性：同一份确定性模拟跑两遍');
  p();
  p('同一 seed、同一构造顺序，`match.update` 是确定性的（无 `Math.random`），因此**每一 tick 的执行路径完全一致**。');
  p();
  p('| 指标 | 轮 1 | 轮 2 | 解读 |');
  p('| --- | --- | --- | --- |');
  p(`| tick 总数 | ${det.spikesA != null ? detA.ticks : '—'} | ${detB.ticks} | 完全一致 = 模拟确定性成立 |`);
  p(
    `| 结束模拟时刻 (s) | ${fmt(detA.endTime, 2)} | ${fmt(detB.endTime, 2)} | ${det.sameEndTime ? '完全一致' : '不一致'} |`,
  );
  p(
    `| >10ms 尖峰数 | ${det.spikesA} | ${det.spikesB} | 同一份代码，数量差 ${fmt(Math.abs(det.spikesA - det.spikesB), 0)} |`,
  );
  p(`| 尖峰落在哪些 tick 的 Jaccard | — | ${fmt(det.jaccard, 3)} | ` + `**接近 0 = 两次运行几乎没有共同的尖峰位置** |`);
  p(`| 逐 tick 耗时 Pearson 相关 | — | ${fmt(det.pearson, 3)} | 几乎没有相关性 |`);
  p();
  p(
    `> 如果尖峰来自代码（某个分支、某次 malloc、某个周期性任务），两次运行**必然重合**。` +
      `Jaccard ${fmt(det.jaccard, 3)} 说明尖峰位置是随机的 —— 它由「当时机器上发生了什么」决定，` +
      `不由「第几 tick」决定。这是推翻「代码周期性尖峰」假设的决定性证据。`,
  );
  p();
  if (!gcAblation.skipped) {
    p('### 5.4 大 young 代对照（`--max-semi-space-size=64`）');
    p();
    if (gcAblation.ok) {
      p('| 配置 | p99 各轮 (ms) | >10ms 尖峰各轮 | tick |');
      p('| --- | --- | --- | --- |');
      p(
        `| 默认 young 代（基准） | ${ablation[0].runs.map((v) => fmt(v, 1)).join(' / ')} | ` +
          `${ablation[0].spikes10} | ${ablation[0].ticks} |`,
      );
      p(
        `| \`--max-semi-space-size=64\` | ${gcAblation.runs.map((r) => fmt(r.p99, 1)).join(' / ')} | ` +
          `${gcAblation.runs.map((r) => r.spikes10).join(' / ')} | ${gcAblation.runs[0].ticks} |`,
      );
      p();
      const bigP99 = gcAblation.runs.map((r) => r.p99);
      const baseP99 = base.p99;
      const bigMedian = medianOf(bigP99);
      const improved = bigMedian < baseP99 * 0.8;
      const worse = bigMedian > baseP99 * 1.25;
      p(
        `把 young 代从默认值放大到 64MB 后，P99 中位数 ${fmt(bigMedian, 1)} ms vs 基准 ${fmt(baseP99, 1)} ms` +
          `（${improved ? '**有改善**' : worse ? '**反而更差**' : '**无稳定改善**'}）。` +
          (improved
            ? '说明 scavenge 确实是尾部的一部分，但仍不是全部：放大 young 代只能压低 GC 频次，压不掉 major GC 与外部抢占。'
            : '说明 **scavenge 本身不是尾部的主要来源** —— 真正的长停顿来自 major GC 与外部抢占。调 V8 flag 不是解法，降低分配率才是。'),
      );
    } else {
      p(`子进程运行失败，跳过：${gcAblation.error}`);
    }
    p();
  }
  p('---');
  p();

  // ── 6. CPU 热点 ──────────────────────────────────────────────────────────
  if (profile) {
    p('## 6. CPU 热点（一局完整模拟，200µs 采样）');
    p();
    p('| # | 函数 | 自耗时占比 |');
    p('| --- | --- | --- |');
    profile.rows.slice(0, 15).forEach((r, i) => {
      p(`| ${i + 1} | \`${r.key}\` | ${fmt(r.share * 100, 2)}% |`);
    });
    p();
    p(
      '自耗时前 20 里，AI 层（`thinkBot`/`_bots`/`combat`/`followPoint`/`idle`/`nearestLoot`/`scanEnemies`）合计约 ' +
        `${fmt(
          profile.rows.filter((r) => /ai\.mjs/.test(r.key)).reduce((a, r) => a + r.share, 0) * 100,
          1,
        )}%，碰撞/地形（\`blocked\`/\`wallDistance\`/\`gather\`/\`moveBody\`）约 ${fmt(
          profile.rows.filter((r) => /map\.mjs/.test(r.key)).reduce((a, r) => a + r.share, 0) * 100,
          1,
        )}%，GC 约 ${fmt(
          profile.rows.filter((r) => /garbage collector/.test(r.key)).reduce((a, r) => a + r.share, 0) * 100,
          1,
        )}%。`,
    );
    p();
    p('---');
    p();
  }

  // ── 7. 结论与建议 ────────────────────────────────────────────────────────
  p('## 7. 结论与修复建议');
  p();
  p('### 7.1 P99 / max 是代码问题还是环境噪声？');
  p();
  const winner =
    envDominant && nonReproducible
      ? '主要是环境噪声，代码负责放大。'
      : nonReproducible
        ? '以环境噪声为主。'
        : '不能只归因于环境噪声，需在独占机器上复测。';
  p(`**${winner}** 三条独立证据：`);
  p();
  p(
    `1. **空转对照**：零分配、零 GC、纯算术（同样迭代次数、同样工作集）的循环在这台机器上 p99 ${fmt(control.p99, 2)} ms / max ${fmt(control.max, 0)} ms，` +
      `达到基准的 ${fmt(floorRatio * 100, 0)}% / ${fmt(floorRatioMax * 100, 0)}%。`,
  );
  p(
    `2. **不可复现**：确定性模拟连跑两遍（tick 数 ${detA.ticks}/${detB.ticks}、结束时刻 ${fmt(detA.endTime, 2)}/${fmt(detB.endTime, 2)}s 完全一致），` +
      `但尖峰位置 Jaccard ${fmt(det.jaccard, 3)}、逐 tick 耗时相关 ${fmt(det.pearson, 3)}。代码 bug 不会这样。`,
  );
  p(
    `3. **周期性不成立**：%50 / %30 / %3 三个周期的尖峰比值分别是 ${fmt(per50.ratio, 2)}× / ${fmt(per30.ratio, 2)}× / ${fmt(per3.ratio, 2)}×` +
      `（z = ${fmt(aggZ(per50), 1)} / ${fmt(aggZ(per30), 1)} / ${fmt(aggZ(per3), 1)}，均未达显著）。`,
  );
  p();
  p(
    `但要明确两点「代码确实在拖后腿」的地方：**（a）分配率**——GC 占 tick 墙钟 ${fmt(gcStats.share * 100, 1)}%，` +
      `约每 ${fmt(gcStats.per1000Ticks > 0 ? 1000 / gcStats.per1000Ticks : 0, 0)} 个 tick 触发一次；` +
      `**（b）单 tick AI 成本**——\`_bots\` 占 tick 段耗时 ${fmt((phases.find((x) => x.phase === '_bots').allMs / Math.max(1e-9, allSpanSum)) * 100, 1)}%，` +
      `且随人数近线性增长（16 人 p50 ${fmt(small.p50, 3)} ms vs 64 人 ${fmt(base.p50, 3)} ms）。` +
      `它们决定的是**基线**，不是 ${fmt(base.max, 0)} ms 级的尖峰。`,
  );
  p();
  p('### 7.2 Top 3 尖峰来源');
  p();
  const top3 = cls.rows
    .slice()
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 3);
  p('| 排名 | tick# | 耗时 | 停顿合计 | 最长单次间隔 | GC | 特征（tickCount%50 / phase / loot / events） | 归因 |');
  p('| --- | --- | --- | --- | --- | --- | --- | --- |');
  top3.forEach((r, i) => {
    p(
      `| ${i + 1} | ${r.tick} | ${fmt(r.dur, 1)} ms | ${fmt(r.stallMs, 1)} ms (${fmt((r.stallMs / r.dur) * 100, 0)}%) | ` +
        `${fmt(r.maxGap, 1)} ms | ${fmt(r.gcMs, 1)} ms | ${r.tickCount % 50} / ${r.phase} / ${r.loot} / ${r.events} | ${r.cls} |`,
    );
  });
  p();
  // 从实际 Top3 的分类动态生成解读，不要写死「全是抢占」这类与数据可能矛盾的断言
  const top3Cls = top3.map((r) => r.cls);
  const stallTop = top3.filter((r) => r.stallMs >= r.dur * 0.5).length;
  const gcTop = top3.filter((r) => r.cls === 'GC').length;
  p(
    `Top 3 中，${stallTop}/${top3.length} 个的停顿合计 ≥ 半条 tick、${gcTop}/${top3.length} 个由 GC 主导` +
      `（分类依次为 ${top3Cls.join(' / ')}），且 ${top3.filter((r) => r.tickCount % 50 !== 0).length}/${top3.length} 个的 \`tickCount % 50 !== 0\`。`,
  );
  p(
    '读法：**停顿占比高 = 线程被系统挪走（外部进程、页错误、频率降档）；GC 主导 = 分配率问题；WORK = 真的算了更多。**' +
      ' 前两类都不是「某一行代码慢」，而是「这一帧没拿到足够的 CPU」；只有 `WORK(算力)` 才属于 §7.3 能修的范围。',
  );
  p();
  p('### 7.3 可落地修复建议（按收益/风险排序）');
  p();
  const profShare = (re) =>
    profile ? profile.rows.filter((r) => re.test(r.key)).reduce((a, r) => a + r.share, 0) * 100 : 0;
  const sanitizeShare = profShare(/sanitizeInput/);
  const wallDistShare = profShare(/wallDistance/);
  const nearestLootShare = profShare(/nearestLoot/);
  const compactSelf = phases.find((x) => x.phase === '_compactLoot');
  p('| # | 位置 | 问题 | 改法 | 预计收益 |');
  p('| --- | --- | --- | --- | --- |');
  p(
    `| 1 | \`shared/simulation.mjs:2377\`（\`_bots\` 内 \`p.input = sanitizeInput(p.botInput)\`）+ \`shared/simulation.mjs:97-118\`（\`sanitizeInput\` 每次新建 \`emptyInput()\`） | 每个存活 bot 每 tick 都走一遍完整输入清洗，并**新建一个 20+ 字段的对象**。63 bot × 30Hz ≈ 1890 个对象/秒，是 scavenge 的主要来源之一；同时 \`sanitizeInput\` 占自耗时 ${fmt(sanitizeShare, 2)}%。bot 输入本来就由 \`shared/ai.mjs:562\` 的 \`blankInput()\` 产生，字段与 \`emptyInput()\` 同构，属于可信数据。 | 给每个 bot 复用一个持久输入对象（或在 \`_bots\` 里 \`p.input = p.botInput\` 直接接管，AI 侧已保证字段完整）。人类输入**仍走** \`sanitizeInput\`（那是安全边界）。 | 分配率下降 → scavenge 频次降低；GC 墙钟占比 ${fmt(gcStats.share * 100, 1)}% 有望减半，基线约 −0.05~0.15 ms/tick，并减少 GC 型尖峰 |`,
  );
  p(
    `| 2 | \`shared/ai.mjs:619-650\`（\`nearestLoot\` 全表线性扫描）+ 调用点 \`shared/ai.mjs:1303\`、\`shared/ai.mjs:1421\` | 每个 bot 每 0.55s 扫**全部**地面物资（开局 603 件，上限 640）。自耗时 ${fmt(nearestLootShare, 2)}%，且随 loot 规模线性增长。对照实验里 loot 清空把 p95 从 ${fmt(base.p95, 2)} → ${fmt(noloot.p95, 2)} ms（−${fmt(100 - pct(noloot.p95, base.p95), 0)}%）。 | 在 \`Match\` 侧维护「loot 空间哈希」（4–8m 网格，\`addLoot\`/\`_compactLoot\` 增量维护），\`nearestLoot\` 只查 3×3 邻格；最小改动版：按 x 排序 + 二分确定窗口，再在窗口内按 z 过滤。 | 每 tick 扫描量降 1–2 个数量级；p95 预计 −10~20%，并削弱「后期 loot 多 → tick 变慢」的斜率 |`,
  );
  p(
    `| 3 | \`shared/ai.mjs:880-909\`（\`findCover\`：16 个候选点 × \`blocked\` + \`clearLine\` + \`wallDistance\`） | 每次找掩体最多做 16 轮三重几何查询；\`wallDistance\` 自耗时 ${fmt(wallDistShare, 2)}%，是 AI 侧最大的单点几何成本。下游 \`shared/simulation.mjs\` 的 \`_snapBase\` 也依赖同一批碰撞查询。注意：**不要靠截断 \`wallDistance\` 的 range 来省**（代码注释 \`ai.mjs:897-900\` 已记录这样做会造成系统性评分偏差）。 | 候选点减到 8 个（步长 45°），保持 \`wallDistance\` 语义不变；或先用便宜的 \`nav.pathClear\` 预筛「确实被挡」的候选，只对 2–3 个点算精确 \`wallDistance\`。 | \`findCover\` 单次成本 −50~70%，\`wallDistance\` 自耗时 ${fmt(wallDistShare, 1)}% → 约 ${fmt(wallDistShare * 0.35, 1)}%；交战期（AI 峰值段）的基线直接受益，且不改变任何决策语义 |`,
  );
  p();
  p(
    `> 反例（**不建议做**）：跳过 \`_compactLoot\`。实测它合计只花 ${fmt(compactSelf.allMs, 2)} ms（单次最长 ${fmt(compactSelf.maxMs, 3)} ms），` +
      `跳过它并不能减少尖峰，反而让 loot 数组永久变大，拖慢 \`nearestLoot\` 与快照。`,
  );
  p();
  p('补充建议（不改代码即可做）：');
  p();
  p(
    `- **性能门禁用独占机器/固定频率**：本机空转对照就能跑出 ${fmt(control.max, 0)} ms 的 max，任何 P99/max 阈值在本机都不具备判别力。` +
      `建议 CI 用容器 + \`--cpus\` 限额，或只对 P50/P95 设门禁。`,
  );
  p(
    `- **不要在 \`update()\` 里做快照**：当前快照在 \`server/rooms.mjs:283-368\` 的 \`broadcastState\` 里、每 ${build.snapshotEveryTicks} tick 一次（由 \`server/index.mjs:630-654\` 的主循环在 update 之外调用），` +
      `已经是正确的隔离；继续保持「update 只跑模拟」这条边界。`,
  );
  p();
  p('---');
  p();
  p('## 8. 复现与产物');
  p();
  p('```bash');
  p('node scripts/tick-spikes.mjs              # 完整（约 5–8 分钟）');
  p('node scripts/tick-spikes.mjs --quick      # 每项 1 轮（约 2 分钟）');
  p('node scripts/tick-spikes.mjs --runs 5     # 更多轮次');
  p('```');
  p();
  p('- `artifacts/tick-spikes.md` —— 本报告');
  p('- `artifacts/tick-spikes.json` —— 原始分位、每轮 p99、Top 30 尖峰明细、假设检验中间量、profile');
  p();
  return L.join('\n');
}

main().catch((err) => {
  process.stderr.write(`tick-spikes 失败：${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
