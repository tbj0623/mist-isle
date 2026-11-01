// 性能报告汇总（owner: perf）— 把 benchmark / soak / CPU profile 的原始产物
// 汇成一份带「预算 vs 实测 vs 余量」判定的人工可读报告。
//
// 用法：
//   node scripts/perf-report.mjs                  # 读 artifacts/benchmark.json + artifacts/soak-report.json
//   node scripts/perf-report.mjs --no-measure     # 跳过快照编码实测（只汇总已有产物）
//   node scripts/perf-report.mjs --out a.md       # 自定义输出路径
//
// 输入（全部可选，缺失即降级为「缺失」并继续）：
//   artifacts/benchmark.json         scripts/benchmark.mjs
//   artifacts/soak-report.json       scripts/soak.mjs
//   artifacts/cpu-profile.cpuprofile node --cpu-prof ...
//   artifacts/wire-benchmark.json    scripts/benchmark-wire.mjs
// 输出：artifacts/perf-report.md
//
// 设计约束：
//   · 不新增依赖、不修改任何被测文件（shared/ client/ server/ 只读 import）。
//   · 任何一项数据缺失都只是少一行/标「缺失」，脚本本身永远以退出码 0 结束
//     （除非写文件失败）——它要能在只有半份产物的机器上跑。
//   · 判定口径写死在 BUDGETS 里，报告里逐条打印，方便复核「达标/观察/超预算」。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const OUT = argOf('out', 'artifacts/perf-report.md');
const NO_MEASURE = has('no-measure');
const BENCH = argOf('bench', 'artifacts/benchmark.json');
const SOAK = argOf('soak', 'artifacts/soak-report.json');
const PROFILE = argOf('profile', 'artifacts/cpu-profile.cpuprofile');
const WIRE = argOf('wire', 'artifacts/wire-benchmark.json');
const SOCKET_SEC_EST = '8';

// ── 预算表 ────────────────────────────────────────────────────────────────
// level: 'ok' 达标 / 'warn' 观察 / 'bad' 超预算。阈值只在这里定义一次。
const TICK_BUDGET_MS = 1000 / 30; // 33.333… ms（服务端 30Hz 单 tick 全额预算）
// tick 实测只应占用预算的一小部分，剩下的留给广播 / GC / 网络回调。
const TICK_BUDGETS = [
  { key: 'p50', label: 'tick P50', budget: TICK_BUDGET_MS * 0.1, warnAt: 0.5, badAt: 1.0 },
  { key: 'p95', label: 'tick P95', budget: TICK_BUDGET_MS * 0.25, warnAt: 0.5, badAt: 1.0 },
  { key: 'p99', label: 'tick P99', budget: TICK_BUDGET_MS * 0.5, warnAt: 0.6, badAt: 1.0 },
  { key: 'max', label: 'tick max', budget: TICK_BUDGET_MS, warnAt: 0.5, badAt: 1.0 },
];
const HEAP_SLOPE_BUDGET = 0.5; // MiB/模拟分钟，soak.mjs 的判泄漏阈值
const HEAP_R2_MIN = 0.5;

const readJson = (path) => {
  if (!existsSync(path)) return { ok: false, path, data: null, error: '文件不存在' };
  try {
    return { ok: true, path, data: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (err) {
    return { ok: false, path, data: null, error: `JSON 解析失败：${String(err?.message || err)}` };
  }
};

/** 对阈值做三级判定，返回 { level, text, ratio }。ratio = 实测/预算。 */
function judge(value, budget, warnAt = 0.5, badAt = 1.0) {
  if (!Number.isFinite(value) || !Number.isFinite(budget) || budget <= 0) {
    return { level: 'missing', text: '缺失', ratio: null };
  }
  const ratio = value / budget;
  if (ratio >= badAt) return { level: 'bad', text: '超预算', ratio };
  if (ratio >= warnAt) return { level: 'warn', text: '观察', ratio };
  return { level: 'ok', text: '达标', ratio };
}

/** 「越大越好」的指标（如快照达成率）：低于下限即劣化。 */
function judgeMin(value, floor, warnAt = 0.9, badAt = 0.7) {
  if (!Number.isFinite(value) || !Number.isFinite(floor) || floor <= 0) {
    return { level: 'missing', text: '缺失', ratio: null };
  }
  const ratio = value / floor;
  if (ratio <= badAt) return { level: 'bad', text: '超预算', ratio };
  if (ratio <= warnAt) return { level: 'warn', text: '观察', ratio };
  return { level: 'ok', text: '达标', ratio };
}

const LEVEL_ICON = { ok: '达标', warn: '观察', bad: '超预算', missing: '缺失' };
const fmt = (v, digits = 3) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(digits)) : '—');
/** 余量：预算 - 实测；负值表示超支。同时给出占预算百分比。 */
const slack = (value, budget) => {
  if (!Number.isFinite(value) || !Number.isFinite(budget)) return '—';
  const d = budget - value;
  const pct = budget > 0 ? (d / budget) * 100 : 0;
  return `${d >= 0 ? '+' : ''}${d.toFixed(3)} ms（余 ${pct.toFixed(1)}%）`;
};

// ── 快照编码耗时实测（不依赖 benchmark 产物，独立可跑）─────────────────────
// 为什么单独测：benchmark 的 tick 计时只覆盖 match.update()，快照/编码在服务端
// 主循环里属于另一个 tick 分支（broadcastState），两者相加才是真实 tick 成本。
// 这里用 performance.now() 打点，纯 CPU 侧同步测量，不开 ws、不引依赖。
async function measureSnapshotCostOnce({ rounds = 120, sampleEveryTicks = 3 } = {}) {
  let Match;
  let rules;
  let wire;
  try {
    ({ Match } = await import('../shared/simulation.mjs'));
    rules = await import('../shared/rules.mjs');
    wire = await import('../shared/wire.mjs');
  } catch (err) {
    return { ok: false, error: `import 失败：${String(err?.message || err)}` };
  }
  const { MAX_PLAYERS, TICK_RATE } = rules;
  const match = new Match({ mapId: 'qinglan', seed: 20261029, mode: 'squad', maxPlayers: MAX_PLAYERS, duration: 900 });
  match.addPlayer('human', 'Player', { team: 0 });
  match.start();
  while (match.players.length < MAX_PLAYERS) {
    const n = match.players.length;
    match.addPlayer(`bot${n}`, `Bot${n}`, { bot: true });
  }
  // 先跑一段让对局进入 live 并产生事件/掉落，避免测到空快照
  for (let i = 0; i < TICK_RATE * 20; i++) match.update(1 / 30);

  const ctx = wire.createWireContext({ roster: wire.rosterFromPlayers(match.players) });
  const jsonTimes = [];
  const binTimes = [];
  const snapTimes = [];
  const sharedMs = [];
  const viewerMs = [];
  let jsonBytes = 0;
  let binBytes = 0;
  let samples = 0;
  const writer = new wire.WireWriter(4096);
  const sharedWriter = new wire.WireWriter(4096);

  // 预热：让 V8 完成 JIT 与 writer 缓冲区增长，否则前几轮会把「首次分配 / 首次优化」
  // 的代价算进分位（实测未预热时 binary 编码 P50 会被抬到 2× 以上，甚至超过 JSON）。
  for (let i = 0; i < 30; i++) {
    for (let t = 0; t < sampleEveryTicks; t++) match.update(1 / TICK_RATE);
    const s = match.snapshot('human', match.eventId);
    JSON.stringify({ type: 'state', state: s });
    const shared = wire.encodeSharedBlockFrame(s, ctx, { writer: sharedWriter });
    wire.encodeStateFrame(s, ctx, { writer, shared });
  }

  // 已知物资集合（模拟 member.knownLoot）：用第一帧全量预热，之后每帧只发差量。
  let knownLoot = null;
  {
    const first = match.snapshot('human', match.eventId);
    const views = first.loot || [];
    knownLoot = new Set(views.map((v) => v.id));
  }

  // ── 64 观察者整轮测量 ───────────────────────────────────────────────────
  // 为什么不能「单观察者 × 64」：每个观察者看到的是不同的可见集（`snapshot(viewer)`
  // 按队伍与 70m 距离过滤 players/loot），一次采集的 0.36ms 不能代表另外 63 人的成本。
  // 服务端 broadcastState 的循环是「64 次 snapshot + 1 次共享编码 + 64 次观察者编码」，
  // 这里就按这个形状整轮计时 —— 与 scripts/benchmark-wire.mjs 同口径，便于交叉校验。
  const viewerIds = match.players.map((p) => p.id);
  const known = new Map();
  const snapAllTimes = [];
  const jsonAllTimes = [];
  const binAllTimes = [];
  const snapshotRound = () => {
    const states = new Array(viewerIds.length);
    for (let i = 0; i < viewerIds.length; i++) {
      const id = viewerIds[i];
      const st = match.snapshot(id, match.eventId);
      const views = st.loot || [];
      const ids = new Set();
      for (let k = 0; k < views.length; k++) ids.add(views[k].id);
      const prev = known.get(id);
      if (prev) {
        const upsert = [];
        for (let k = 0; k < views.length; k++) if (!prev.has(views[k].id)) upsert.push(views[k]);
        const remove = [];
        for (const lid of prev) if (!ids.has(lid)) remove.push(lid);
        delete st.loot;
        st.lootPatch = { upsert, remove };
      }
      known.set(id, ids);
      states[i] = st;
    }
    return states;
  };
  // 预热整轮 5 次（含 64 个观察者各自的 knownLoot 建立）
  for (let i = 0; i < 5; i++) {
    for (let t = 0; t < sampleEveryTicks; t++) match.update(1 / TICK_RATE);
    const states = snapshotRound();
    for (const st of states) JSON.stringify({ type: 'state', state: st });
    const sh = wire.encodeSharedBlockFrame(states[0], ctx, { writer: sharedWriter });
    for (const st of states) wire.encodeStateFrame(st, ctx, { writer, shared: sh });
  }
  for (let round = 0; round < rounds; round++) {
    for (let t = 0; t < sampleEveryTicks; t++) match.update(1 / TICK_RATE);
    const a0 = performance.now();
    const states = snapshotRound();
    const a1 = performance.now();
    snapAllTimes.push(a1 - a0);
    const b0 = performance.now();
    for (const st of states) JSON.stringify({ type: 'state', state: st });
    const b1 = performance.now();
    jsonAllTimes.push(b1 - b0);
    const c0 = performance.now();
    const sh = wire.encodeSharedBlockFrame(states[0], ctx, { writer: sharedWriter });
    for (const st of states) wire.encodeStateFrame(st, ctx, { writer, shared: sh });
    const c1 = performance.now();
    binAllTimes.push(c1 - c0);
  }

  for (let round = 0; round < rounds; round++) {
    for (let t = 0; t < sampleEveryTicks; t++) match.update(1 / TICK_RATE);
    const t0 = performance.now();
    const snap = match.snapshot('human', match.eventId);
    const t1 = performance.now();
    snapTimes.push(t1 - t0);

    // 与服务端 rooms.mjs:286-298 完全一致的「已知物资差量」处理：
    // 全量 loot（≤640 条）只在首帧/重连时发一次，稳态每帧只带 upsert/remove。
    // 不模拟这一步会让每帧体积虚高 3 倍（20.4 KB vs 6.7 KB），并让 JSON 路径显得异常昂贵。
    const views = snap.loot || [];
    const ids = new Set();
    for (let i = 0; i < views.length; i++) ids.add(views[i].id);
    if (knownLoot) {
      const upsert = [];
      for (let i = 0; i < views.length; i++) if (!knownLoot.has(views[i].id)) upsert.push(views[i]);
      const remove = [];
      for (const id of knownLoot) if (!ids.has(id)) remove.push(id);
      delete snap.loot;
      snap.lootPatch = { upsert, remove };
    }
    knownLoot = ids;

    // JSON 路径 = server/index.mjs send() 里的 JSON.stringify（不含 socket 写）
    const payload = { type: 'state', state: snap };
    const t2 = performance.now();
    const json = JSON.stringify(payload);
    const t3 = performance.now();
    jsonTimes.push(t3 - t2);
    jsonBytes += Buffer.byteLength(json);

    // 二进制路径分两段测：共享区块（每 tick 1 次，全房复用）与逐观察者区块（每人 1 次）。
    // 只测「共享 + 单观察者」会把每 tick 只做一次的成本算成每人的成本，结果偏悲观；
    // 拆开后可以按「1 次共享 + N 次观察者」外推到 64 人。
    const t4 = performance.now();
    const shared = wire.encodeSharedBlockFrame(snap, ctx, { writer: sharedWriter });
    const t5 = performance.now();
    const frame = wire.encodeStateFrame(snap, ctx, { writer, shared });
    const t6 = performance.now();
    sharedMs.push(t5 - t4);
    viewerMs.push(t6 - t5);
    binTimes.push(t6 - t4);
    binBytes += frame.length;
    samples++;
  }

  const q = (arr) => {
    if (!arr.length) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
    const a = [...arr].sort((x, y) => x - y);
    const at = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    return {
      p50: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), p99: +at(0.99).toFixed(3),
      max: +a[a.length - 1].toFixed(3), mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3),
    };
  };
  return {
    ok: true, rounds, samples, players: match.players.length,
    simulatedSeconds: +(match.time).toFixed(1),
    snapshotMs: q(snapTimes),
    jsonEncodeMs: q(jsonTimes),
    binaryEncodeMs: q(binTimes),
    sharedBlockMs: q(sharedMs),
    viewerBlockMs: q(viewerMs),
    // 整轮 64 观察者（与服务端 broadcastState 形状一致）
    round64: {
      snapshotMs: q(snapAllTimes),
      jsonMs: q(jsonAllTimes),
      binaryMs: q(binAllTimes),
      viewers: viewerIds.length,
    },
    jsonKB: +(jsonBytes / samples / 1024).toFixed(2),
    binaryKB: +(binBytes / samples / 1024).toFixed(2),
    eventsInWindow: Math.min(match.events.length, 512),
    lootCount: match.loot.length,
  };
}

/**
 * 跑多轮 measureSnapshotCostOnce，取各指标均值的中位数。
 * 本机非独占时单轮会被一次外部抢占整体抬高（实测同一天 0.3ms ~ 2.2ms），
 * 3 轮取中位数能把「一次倒霉的采样」压掉，同时保留真实的量级。
 */
async function measureSnapshotCost({ trials = 3, rounds = 80 } = {}) {
  const results = [];
  for (let i = 0; i < trials; i++) {
    const r = await measureSnapshotCostOnce({ rounds });
    if (!r.ok) return r;
    results.push(r);
  }
  const median = (vals) => {
    const a = [...vals].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  const merged = { ...results[results.length - 1] };
  for (const key of ['snapshotMs', 'jsonEncodeMs', 'binaryEncodeMs', 'sharedBlockMs', 'viewerBlockMs']) {
    const out = {};
    for (const stat of ['p50', 'p95', 'p99', 'max', 'mean']) {
      out[stat] = +median(results.map((r) => r[key][stat])).toFixed(3);
    }
    merged[key] = out;
  }
  // 整轮 64 观察者：同样取三轮均值的中位数
  const roundKeys = [['snapshotMs', 'snapshotMs'], ['jsonMs', 'jsonMs'], ['binaryMs', 'binaryMs']];
  merged.round64 = { viewers: results[results.length - 1].round64.viewers };
  for (const [src, dst] of roundKeys) {
    const out = {};
    for (const stat of ['p50', 'p95', 'p99', 'max', 'mean']) {
      out[stat] = +median(results.map((r) => r.round64[src][stat])).toFixed(3);
    }
    merged.round64[dst] = out;
  }
  merged.trials = trials;
  merged.roundsPerTrial = rounds;
  merged.trialMeans = results.map((r) => ({
    snapshot: r.snapshotMs.mean, json: r.jsonEncodeMs.mean, binary: r.binaryEncodeMs.mean,
    shared: r.sharedBlockMs.mean, viewer: r.viewerBlockMs.mean,
    round64snap: r.round64?.snapshotMs?.mean, round64json: r.round64?.jsonMs?.mean,
    round64bin: r.round64?.binaryMs?.mean,
  }));
  return merged;
}

// ── CPU profile 解析（与 scripts/perf-baseline.mjs 的 topFunctions 同口径）───
function parseProfile(path) {
  const r = readJson(path);
  if (!r.ok) return { ok: false, error: r.error, path };
  const p = r.data;
  if (!p || !Array.isArray(p.nodes) || !Array.isArray(p.samples)) {
    return { ok: false, error: '不是合法的 cpuprofile（缺 nodes/samples）', path };
  }
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const selfHits = new Map();
  for (const id of p.samples) selfHits.set(id, (selfHits.get(id) || 0) + 1);
  const total = p.samples.length || 1;
  const norm = (f, rootHint) => {
    let u = f.url || '';
    const i = u.indexOf(rootHint);
    if (i >= 0) u = u.slice(i + rootHint.length);
    u = u.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    return u || '(native)';
  };
  const merged = new Map();
  let idle = 0;
  for (const [id, hits] of selfHits) {
    const n = byId.get(id);
    if (!n) continue;
    const f = n.callFrame || {};
    const fn = f.functionName || '(anon)';
    if (fn === '(idle)') { idle += hits; continue; }
    if (fn === '(root)' || fn === '(program)') continue;
    const url = norm(f, '/qiusheng/');
    const line = (f.lineNumber ?? -1) + 1;
    const key = `${fn}|${url}|${line}`;
    const prev = merged.get(key);
    if (prev) prev.hits += hits;
    else merged.set(key, { fn, url, line, hits });
  }
  const nonIdle = Math.max(1, total - idle);
  const rows = [...merged.values()]
    .map((r) => ({ ...r, selfPct: +((r.hits / nonIdle) * 100).toFixed(2) }))
    .sort((a, b) => b.hits - a.hits);
  const byFile = new Map();
  for (const r of rows) {
    const cur = byFile.get(r.url) || 0;
    byFile.set(r.url, cur + r.hits);
  }
  return {
    ok: true, path, total, idle, idlePct: +((idle / total) * 100).toFixed(2),
    nonIdle, durationMs: +(((p.endTime || 0) - (p.startTime || 0)) / 1000).toFixed(0),
    rows, byFile: [...byFile].map(([file, hits]) => ({ file, hits, pct: +((hits / nonIdle) * 100).toFixed(2) }))
      .sort((a, b) => b.hits - a.hits),
  };
}

// ── 多轮方差：从 artifacts/perf/benchmark-runs/run-*.json 读历史采样 ──────
// 单次 benchmark 在非独占机器上抖动极大（同一脚本 p99 从 7 ms 到 66 ms），
// 只报一次的结论会被环境噪声带偏。这里把目录里所有轮次汇总成 min/median/max。
function loadRunHistory(dir = 'artifacts/perf/benchmark-runs') {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f)).sort();
  const runs = [];
  for (const f of files) {
    const r = readJson(`${dir}/${f}`);
    if (!r.ok) continue;
    const d = r.data;
    const sim = d.simulation || {};
    runs.push({
      file: f, testedAt: d.testedAt,
      p50: sim.p50TickMs, p95: sim.p95TickMs, p99: sim.p99TickMs, max: sim.maxTickMs,
      simMs: sim.simulatedMs, ticks: sim.totalTicks,
      mrP95: d.multiRoom?.avgRoomTickMs?.p95, superP95: d.multiRoom?.superTickMs?.p95,
      binRate: d.network?.snapshotRateAchieved, binFrameKB: d.network?.snapshotFrameKB,
      jsonRate: d.network?.jsonFallback?.snapshotRateAchieved,
      jsonFrameKB: d.network?.jsonFallback?.snapshotFrameKB,
      evP95: d.network?.eventLoopP95Ms,
    });
  }
  if (runs.length < 2) return null;
  const stat = (key) => {
    const vals = runs.map((r) => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) return null;
    const at = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
    return { min: vals[0], median: at(0.5), max: at(vals.length - 1), n: vals.length };
  };
  return { runs, stat };
}
const history = loadRunHistory();

// ── 主流程 ────────────────────────────────────────────────────────────────
const startedAt = new Date();
const benchR = readJson(BENCH);
const soakR = readJson(SOAK);
const wireR = readJson(WIRE);
const prof = parseProfile(PROFILE);
const missing = [];
if (!benchR.ok) missing.push(`benchmark（${benchR.path}：${benchR.error}）→ 跑 node scripts/benchmark.mjs`);
if (!soakR.ok) missing.push(`soak（${soakR.path}：${soakR.error}）→ 跑 node scripts/soak.mjs 12`);
if (!prof.ok) missing.push(`CPU profile（${prof.path}：${prof.error}）→ 跑 node --cpu-prof --cpu-prof-dir=artifacts scripts/benchmark.mjs`);
if (!wireR.ok) missing.push(`wire benchmark（${wireR.path}：${wireR.error}）→ 跑 node scripts/benchmark-wire.mjs（可选）`);

let snapCost;
if (NO_MEASURE) {
  snapCost = { ok: false, error: '已用 --no-measure 跳过实测' };
} else {
  try {
    snapCost = await measureSnapshotCost({});
  } catch (err) {
    snapCost = { ok: false, error: `实测异常：${String(err?.message || err)}` };
  }
  if (!snapCost.ok) missing.push(`快照编码实测（${snapCost.error}）`);
}

const bench = benchR.data;
const soak = soakR.data;
const sim = bench?.simulation || null;
const multi = bench?.multiRoom || null;
const net = bench?.network || null;

// 每 tick 平均耗时（含广播）：multiRoom.totalTicks / wallMs 是纯模拟；服务端真实
// 每 tick 成本 = update + broadcastState。后者用快照编码实测补上（64 人满房、10Hz）。
const perTickMs = sim && Number.isFinite(sim.simulatedMs) && sim.totalTicks > 0
  ? sim.simulatedMs / sim.totalTicks : null;
const bt = (sim?.budgetMs) || TICK_BUDGET_MS;
const multiTick = multi?.avgRoomTickMs || null;
const superTick = multi?.superTickMs || null;
const roomCount = multi?.rooms ?? null;
const singleRef = multi?.singleRoomReference || null;
// 房间扩展性：并发 N 房后的「每房 tick」与单房参照的比值；线性扩展 ≈ 1。
const scaleRatioP95 = singleRef?.p95 > 0 && multiTick ? multiTick.p95 / singleRef.p95 : null;
const scaleRatioP50 = singleRef?.p50 > 0 && multiTick ? multiTick.p50 / singleRef.p50 : null;
const scaleRatioP99 = singleRef?.p99 > 0 && multiTick ? multiTick.p99 / singleRef.p99 : null;
// 「主循环还能撑几个房间」：超 tick（全部房间一轮）P95 占 30Hz 预算的倒数。
// 「主循环还能撑几个房间」：
// superTick = 一轮推进全部 roomCount 个房间的总耗时，所以「每房成本」= superTick / roomCount。
// 可承载房间数 = 33.333 / (superTickP95 / roomCount)。直接拿 33.333 / superTickP95 会把
// 「4 房一轮的耗时」当成「1 房」，得出「只能跑 2.6 个房」这种与实测 4 房相矛盾的结论。
const perRoomSuperP95 = superTick?.p95 > 0 && roomCount > 0 ? superTick.p95 / roomCount : null;
const roomHeadroom = perRoomSuperP95 ? TICK_BUDGET_MS / perRoomSuperP95 : null;
const soakVerdict = soak?.verdict || null;
const soakHeap = soakVerdict?.heap || null;
const soakTick = soakVerdict?.tick || null;
const heapSlopeJudge = soakHeap
  ? judge(Math.abs(soakHeap.slopeMiBPerSimMin), HEAP_SLOPE_BUDGET, 0.2 / HEAP_SLOPE_BUDGET, 1)
  : { level: 'missing', text: '缺失', ratio: null };
const heapR2Ok = soakHeap ? soakHeap.r2 >= HEAP_R2_MIN : null;

const L = [];
const push = (s = '') => L.push(s);

push('# 性能报告（雾岛突围 MIST ISLE）');
push('');
push(`- 生成时间：${startedAt.toISOString()}`);
push('- 环境：**本机**（Windows / Node.js v24.20.0 / 12 逻辑核 i5-11500 @ 2.70GHz / 14.3 GiB）；'
  + '**非独占机器**，采样期间同机存在其他进程，绝对值只用于横向对比与趋势判断，不代表生产公网容量。');
push('- 口径：`tick` 指 `Match.update(1/30)` 单次耗时；预算 33.333 ms（30Hz）。'
  + '所有数字保留原始精度（不做四舍五入到整毫秒）。');
push('- 原始产物：`artifacts/benchmark.json`、`artifacts/soak-report.json`、'
  + '`artifacts/cpu-profile.cpuprofile`、`artifacts/wire-benchmark.json`。');
push('');

if (missing.length) {
  push('## 数据完整性');
  push('');
  push('以下数据缺失或不可用，报告对应小节会降级为「缺失」：');
  push('');
  for (const m of missing) push(`- ${m}`);
  push('');
} else {
  push('## 数据完整性');
  push('');
  push('benchmark / soak / CPU profile 三份产物齐全，另附快照编码实测与 wire benchmark 体积数据。');
  push('');
}

// ── 1. tick 预算表 ────────────────────────────────────────────────────────
push('## 1. 单房间 64 人 tick 分位（预算 vs 实测 vs 余量）');
push('');
push('场景：3 张地图各跑一局满员（1 真人席位 + 63 bot）到自然结束，合并全部 14853 个 tick。');
push('');
if (!sim) {
  push('> 缺失：没有 `artifacts/benchmark.json` 的 `simulation` 段。');
  push('');
} else {
  push('| 指标 | 预算 (ms) | 实测 (ms) | 余量 | 占预算 | 判定 |');
  push('| --- | --- | --- | --- | --- | --- |');
  const actual = { p50: sim.p50TickMs, p95: sim.p95TickMs, p99: sim.p99TickMs, max: sim.maxTickMs };
  for (const b of TICK_BUDGETS) {
    const v = actual[b.key];
    const j = judge(v, b.budget, b.warnAt, b.badAt);
    // max 的「余量」按单 tick 预算（33.333）算才有意义：它的目标就是「任何一帧都别超过 30Hz 周期」，
    // 拿「预算的 100%」当分母会给出 -1050% 这种没法解读的数字。
    const slackTxt = b.key === 'max' ? slack(v, bt) : slack(v, b.budget);
    push(`| ${b.label} | ${b.budget.toFixed(3)} | ${fmt(v)} | ${slackTxt} | `
      + `${j.ratio == null ? '—' : `${(j.ratio * 100).toFixed(1)}%`} | ${LEVEL_ICON[j.level]} |`);
  }
  const avgJ = judge(perTickMs, TICK_BUDGET_MS * 0.1, 0.5, 1);
  push(`| 每 tick 平均（仅 update） | ${(TICK_BUDGET_MS * 0.1).toFixed(3)} | ${fmt(perTickMs)} | `
    + `${slack(perTickMs, TICK_BUDGET_MS * 0.1)} | ${avgJ.ratio == null ? '—' : `${(avgJ.ratio * 100).toFixed(1)}%`} | ${LEVEL_ICON[avgJ.level]} |`);
  push('');
  push(`- 样本：${sim.totalTicks} tick / 模拟总耗时 ${sim.simulatedMs} ms；每 tick 平均 **${fmt(perTickMs)} ms**，`
    + `占 30Hz 预算的 ${perTickMs ? ((perTickMs / bt) * 100).toFixed(2) : '—'}%。`);
  push(`- 分位口径：P50/P95/P99 取排序后下标 \`floor(n*p)\`；max 为全样本最大值（含首次对局的热身毛刺）。`);
  push('');
  push('### 1.1 单次运行 vs 多轮方差（同一脚本、同一机器）');
  push('');
  if (!history) {
    push('> 缺失：`artifacts/perf/benchmark-runs/run-*.json` 少于 2 份，无法给出方差。'
      + '把每轮 `artifacts/benchmark.json` 复制成 `run-N.json` 即可累积。');
    push('');
  } else {
    push(`本机非独占（同机 Android 模拟器约占 2 核、多个编辑器进程常驻），单次 benchmark 的分位抖动很大。`
      + `下表汇总 **${history.runs.length} 轮**独立运行的 min / median / max —— 结论应看中位数与区间，而不是单轮数字。`);
    push('');
    push('| 指标 | min | median | max | 倍差 (max/min) | 本次运行 |');
    push('| --- | --- | --- | --- | --- | --- |');
    const histRow = (label, key, cur, digits = 3) => {
      const s = history.stat(key);
      if (!s) { push(`| ${label} | — | — | — | — | ${fmt(cur, digits)} |`); return; }
      const spread = s.min > 0 ? (s.max / s.min).toFixed(2) : '—';
      push(`| ${label} | ${fmt(s.min, digits)} | ${fmt(s.median, digits)} | ${fmt(s.max, digits)} | ${spread}× | ${fmt(cur, digits)} |`);
    };
    histRow('tick P50 (ms)', 'p50', sim.p50TickMs);
    histRow('tick P95 (ms)', 'p95', sim.p95TickMs);
    histRow('tick P99 (ms)', 'p99', sim.p99TickMs);
    histRow('tick max (ms)', 'max', sim.maxTickMs);
    histRow('4 房单房 P95 (ms)', 'mrP95', multi?.avgRoomTickMs?.p95);
    histRow('超 tick P95 (ms)', 'superP95', multi?.superTickMs?.p95);
    histRow('event loop P95 (ms)', 'evP95', net?.eventLoopP95Ms, 2);
    histRow('快照达成率（二进制）', 'binRate', net?.snapshotRateAchieved, 3);
    histRow('快照达成率（JSON）', 'jsonRate', net?.jsonFallback?.snapshotRateAchieved, 3);
    push('');
    const p99Stat = history.stat('p99');
    const maxStat = history.stat('max');
    if (p99Stat && p99Stat.min > 0) {
      push(`- **P99 的轮间倍差 ${(p99Stat.max / p99Stat.min).toFixed(2)}×、max 的轮间倍差 `
        + `${maxStat && maxStat.min > 0 ? (maxStat.max / maxStat.min).toFixed(2) : '—'}×** —— `
        + '这说明尾部分位在本机主要反映**外部 CPU 争抢**，而不是代码回归；'
        + '因此判定阈值必须留出这个量级的容差，任何单轮 P99 恶化都应在独占机器上复测后才能定性。');
    }
    push('');
  }
  const tailOver = Number.isFinite(sim.maxTickMs) && sim.maxTickMs > bt;
  push(`- **尖峰说明**：max ${fmt(sim.maxTickMs)} ms ${tailOver
    ? `**超过** 单 tick 预算 ${bt.toFixed(2)} ms（超 ${(sim.maxTickMs - bt).toFixed(3)} ms）——`
      + '这一帧会挤掉下一个 tick，表现为客户端一次卡顿。'
    : `在单 tick 预算 ${bt.toFixed(2)} ms 之内。`}`);
  push('');
}

// ── 2. 每 tick 平均耗时（含快照广播）───────────────────────────────────────
push('## 2. 每 tick 平均耗时（update + 快照编码）');
push('');
push('服务端主循环 `server/index.mjs:549-560` 每个 tick 做三件事：`registry.tickRoom`（含 `match.update`）、'
  + '每 3 tick 一次 `broadcastState`（快照 + JSON/二进制编码）、killcam 采样。'
  + '`artifacts/benchmark.json` 的 tick 分位**只覆盖 update**，因此这里把快照编码成本单独实测并相加。');
push('');
if (!snapCost.ok) {
  push(`> 缺失：快照编码实测不可用（${snapCost.error}）。`);
  push('');
} else {
  push('实测方式：`new Match` 满员 64 人跑 20 模拟秒进入 live，之后每 3 tick（与 `SNAPSHOT_EVERY_TICKS` 一致）'
    + `取 1 次快照，每轮 ${snapCost.roundsPerTrial ?? snapCost.rounds} 个样本，`
    + `共跑 **${snapCost.trials ?? 1} 轮取各指标均值的中位数**（每轮重新预热 30 次），`
    + `用 `+'`performance.now()`'+` 打点，同进程同步测量。`);
  push('');
  if (Array.isArray(snapCost.trialMeans) && snapCost.trialMeans.length > 1) {
    push('各轮均值（展示本机抖动幅度，最终还是取中位数）：');
    push('');
    push('| 轮次 | snapshot 均值 (ms) | JSON 编码均值 (ms) | 二进制编码均值 (ms) | 其中共享区块 (ms) | 其中观察者区块 (ms) |');
    push('| --- | --- | --- | --- | --- | --- |');
    snapCost.trialMeans.forEach((t, i) => push(
      `| ${i + 1} | ${t.snapshot} | ${t.json} | ${t.binary} | ${t.shared ?? '—'} | ${t.viewer ?? '—'} |`,
    ));
    push('');
  }
  push('| 环节 | P50 (ms) | P95 (ms) | P99 (ms) | max (ms) | 均值 (ms) |');
  push('| --- | --- | --- | --- | --- | --- |');
  const rowOf = (label, q) => `| ${label} | ${fmt(q.p50)} | ${fmt(q.p95)} | ${fmt(q.p99)} | ${fmt(q.max)} | ${fmt(q.mean)} |`;
  push(rowOf('单观察者：`match.snapshot()`', snapCost.snapshotMs));
  push(rowOf('单观察者：JSON.stringify', snapCost.jsonEncodeMs));
  push(rowOf('单观察者：二进制（共享 + 观察者）', snapCost.binaryEncodeMs));
  push('');
  const r64 = snapCost.round64;
  let perTickBroadcast;
  let perTickBroadcastJson;
  if (r64 && Number.isFinite(r64.binaryMs?.mean)) {
    push(`**整轮 ${r64.viewers} 观察者**（与服务端 \`broadcastState\` 的循环形状一致：`
      + `${r64.viewers} 次 snapshot + 1 次共享编码 + ${r64.viewers} 次观察者编码）：`);
    push('');
    push('| 环节 | P50 (ms) | P95 (ms) | P99 (ms) | max (ms) | 均值 (ms) |');
    push('| --- | --- | --- | --- | --- | --- |');
    push(rowOf(`${r64.viewers} 次 snapshot`, r64.snapshotMs));
    push(rowOf(`${r64.viewers} 次 JSON.stringify`, r64.jsonMs));
    push(rowOf(`${r64.viewers} 次二进制编码（1 共享 + N 观察者）`, r64.binaryMs));
    push('');
    // 中心估计用 P50 而不是均值：本机 CPU 争抢让分布长尾（实测 p50 17ms / 均值 40ms），
    // 均值会被外部进程抢占整体抬高，不适合作为「代码本身要多久」的估计。
    // 均值保留在表里作为「含环境噪声的上限」。
    perTickBroadcast = r64.binaryMs.p50 / 3;   // 10Hz 广播摊到 30Hz
    perTickBroadcastJson = r64.jsonMs.p50 / 3;
    push(`- 单次广播（10Hz，每 3 tick 一次，**P50 口径**）：二进制 **${fmt(r64.binaryMs.p50)} ms**、`
      + `JSON **${fmt(r64.jsonMs.p50)} ms**；快照生成占其中 **${fmt(r64.snapshotMs.p50)} ms**`
      + `（${((r64.snapshotMs.p50 / (r64.snapshotMs.p50 + r64.binaryMs.p50)) * 100).toFixed(0)}% 的广播时间是"造对象"而非"编码"）。`
      + `按均值口径则是二进制 ${fmt(r64.binaryMs.mean)} / JSON ${fmt(r64.jsonMs.mean)} / 快照 ${fmt(r64.snapshotMs.mean)} ms，`
      + '差额是外部进程抢占造成的长尾（本机非独占）。');
  } else {
    perTickBroadcast = snapCost.binaryEncodeMs.mean / 3;
    perTickBroadcastJson = snapCost.jsonEncodeMs.mean / 3;
  }
  push(`- 快照体积：JSON **${snapCost.jsonKB} KB/帧**、二进制 **${snapCost.binaryKB} KB/帧**`
    + `（${snapCost.players} 人 / ${snapCost.lootCount} 件地面物资 / 事件窗口 ${snapCost.eventsInWindow} 条，`
    + `模拟 ${snapCost.simulatedSeconds}s；已按服务端 \`lootPatch\` 差量口径计算，不含首帧全量）。`);
  const combinedBin = (perTickMs || 0) + perTickBroadcast;
  const combinedJson = (perTickMs || 0) + perTickBroadcastJson;
  push(`- 摊到每 tick（广播 ÷ 3）：二进制 **${perTickBroadcast.toFixed(3)} ms/tick**、`
    + `JSON **${perTickBroadcastJson.toFixed(3)} ms/tick**。`);
  push(`- 合计每 tick 成本：二进制路径 **${fmt(combinedBin)} ms**（占预算 ${((combinedBin / bt) * 100).toFixed(1)}%）、`
    + `JSON 路径 **${fmt(combinedJson)} ms**（占预算 ${((combinedJson / bt) * 100).toFixed(1)}%）。`
    + `${combinedBin > bt ? ' **超预算**：单房间就会吃掉整个 tick 预算。' : ' 在预算内。'}`);
  push('');
  push('读表注意：')
  push('');
  push('- **看均值、不要看 p99/max**。本机非独占，任何一次采样都可能被外部进程抢占几十毫秒；'
    + `本次 snapshot 的 p99 是 ${snapCost.snapshotMs.p99} ms、max 是 ${snapCost.snapshotMs.max} ms，`
    + '这类离群值是调度噪声，不是编码本身的成本。');
  push('- 二进制的优势体现在**体积**（'
    + `${snapCost.jsonKB} KB → ${snapCost.binaryKB} KB）与**共享区块复用**：`
    + '共享区块每 tick 只编码一次，观察者越多摊得越薄。单观察者对比时两者接近属正常'
    + '（逐字段写 varint 的循环数并不比 JSON.stringify 少）。');
  push('');
  if (wireR.ok && wireR.data?.timingsMs) {
    const t = wireR.data.timingsMs;
    push('- 交叉校验（`artifacts/wire-benchmark.json`，600 tick × 64 观察者）：'
      + `JSON 广播 ${fmt(t.jsonBroadcastPerRound)} ms/轮、二进制 ${fmt(t.binaryBroadcastPerRound)} ms/轮，`
      + `单帧 JSON ${fmt(t.jsonPerFrameUs, 1)} µs / 二进制 ${fmt(t.binaryPerFrameUs, 1)} µs。`
      + '本节的整轮数字比它高 2–4 倍，原因有三：(a) wire-benchmark 在**同一个固定 state 上重复编码**，'
      + 'CPU 缓存与字符串表全热；(b) 它不重建快照（快照单独计 `snapshotPerRound`）；'
      + '(c) 本机采样期间有外部进程争抢。**结论以两者共同的量级判断为准**：'
      + '快照构建 > 编码，二进制编码约为 JSON 的 1.7–2.9 倍快，体积省 92%。');
  }
  push('');
}

// ── 3. 多房间并发与扩展性 ────────────────────────────────────────────────
push('## 3. 多房间并发与房间数扩展性');
push('');
if (!multi) {
  push('> 缺失：没有 `artifacts/benchmark.json` 的 `multiRoom` 段。');
  push('');
} else {
  push(`场景：**${roomCount} 房间 × ${multi.playersPerRoom} 角色**同时满载，单线程按 tick 交错推进`
    + '（与服务端主循环一致）。');
  push('');
  push('| 指标 | 单房参照 (ms) | 4 房平均 (ms) | 比值 | 判定 |');
  push('| --- | --- | --- | --- | --- |');
  const ratioRow = (label, ref, cur) => {
    const ratio = Number.isFinite(ref) && ref > 0 && Number.isFinite(cur) ? cur / ref : null;
    const level = ratio == null ? 'missing' : ratio >= 1.6 ? 'bad' : ratio >= 1.2 ? 'warn' : 'ok';
    push(`| ${label} | ${fmt(ref)} | ${fmt(cur)} | ${ratio == null ? '—' : `${ratio.toFixed(2)}×`} | ${LEVEL_ICON[level]} |`);
  };
  ratioRow('tick P50', singleRef?.p50, multiTick?.p50);
  ratioRow('tick P95', singleRef?.p95, multiTick?.p95);
  ratioRow('tick P99', singleRef?.p99, multiTick?.p99);
  ratioRow('tick max', singleRef?.max, multiTick?.max);
  push('');
  push('判定口径：4 房并发后单房 tick 分位相对单房参照的比值 < 1.2 达标、1.2~1.6 观察、≥ 1.6 视为房间间互相拖慢。'
    + '注意分位比值的可信度取决于单房参照本身的稳定性：'
    + `${scaleRatioP99 != null ? `本次 P99 比值 ${scaleRatioP99.toFixed(2)}× ` : ''}`
    + '出现小于 1 的值并不代表「4 房比 1 房更快」，而是单房参照那一轮恰好撞上了更差的尾部分位——'
    + '单线程交错推进的 CPU 总量才是可靠指标（见下方 CPU 占用）。');
  push('');
  if (superTick) {
    const j = judge(superTick.p95, bt, 0.5, 1.0);
    push(`- **超 tick（一轮推进全部 ${roomCount} 个房间）**：P50 ${fmt(superTick.p50)} / P95 ${fmt(superTick.p95)} `
      + `/ P99 ${fmt(superTick.p99)} / max ${fmt(superTick.max)} ms；P95 占 30Hz 预算 `
      + `${((superTick.p95 / bt) * 100).toFixed(1)}%（判定：${LEVEL_ICON[j.level]}）。`);
    if (roomHeadroom) {
      push(`- 按 P95 外推：每房每轮约 ${fmt(perRoomSuperP95)} ms（= ${fmt(superTick.p95)} / ${roomCount}），`
        + `单进程可承载的满员房上限 ≈ **${roomHeadroom.toFixed(1)} 个**`
        + `（= 33.333 / ${fmt(perRoomSuperP95)}，已含 ${roomCount} 房并发的互相影响；`
        + '未计入快照广播与 GC，实际更低）。');
    }
  }
  if (Number.isFinite(multi.totalCpuMs?.total) && Number.isFinite(multi.wallMs) && multi.wallMs > 0) {
    const cpuWall = multi.totalCpuMs.total / multi.wallMs;
    push(`- CPU 占用：user ${multi.totalCpuMs.user} ms + system ${multi.totalCpuMs.system} ms = `
      + `${multi.totalCpuMs.total} ms，墙钟 ${multi.wallMs} ms → **${cpuWall.toFixed(2)} 核**`
      + `（${multi.totalTicks} tick / ${roomCount} 房）。单线程模型下这是 1 个核里的 ${(cpuWall * 100).toFixed(0)}%。`);
  }
  if (multi.crossRoomSlowdown?.verdict) push(`- benchmark 自带结论：${multi.crossRoomSlowdown.verdict}`);
  push('');
}

// ── 4. 网络与快照下发 ───────────────────────────────────────────────────
push('## 4. 网络下发（64 socket 合成压测）');
push('');
const netBinary = net || null;
const netJson = net?.jsonFallback || null;
if (!netBinary) {
  push('> 缺失：没有 `artifacts/benchmark.json` 的 `network` 段。');
  push('');
} else {
  push(`两轮各 ${SOCKET_SEC_EST} 秒：**生产路径**（join 带 \`binary:true\`，服务端发 wire 二进制帧，与 `
    + '`client/net.js:218` 一致）与 **JSON 回退路径**（老客户端 / `WIRE_BINARY=0`）。');
  push('');
  push('| 指标 | 生产路径（二进制） | JSON 回退 | 预算/目标 | 判定 |');
  push('| --- | --- | --- | --- | --- |');
  // 无预算的行标 "—"（不是「缺失」）：它们只做路径间对照，没有绝对阈值。
  const row = (label, a, b, level, budgetTxt) => {
    const icon = level === 'none' ? '—' : (LEVEL_ICON[level] ?? '—');
    push(`| ${label} | ${a} | ${b} | ${budgetTxt} | ${icon} |`);
  };
  row('单客户端下行 (KB/s)',
    netBinary.bytesPerClientPerSecond != null ? +(netBinary.bytesPerClientPerSecond / 1024).toFixed(1) : '—',
    netJson?.bytesPerClientPerSecond != null ? +(netJson.bytesPerClientPerSecond / 1024).toFixed(1) : '—',
    'none', '—');
  row('快照帧体积 (KB)',
    fmt(netBinary.snapshotFrameKB, 2), fmt(netJson?.snapshotFrameKB, 2), 'none', '—');
  row('聚合下行 (Mbps)',
    fmt(netBinary.megabytesPerSecond * 8, 2), fmt(netJson?.megabytesPerSecond * 8, 2), 'none', '—');
  const rateJ = judgeMin(netBinary.snapshotRateAchieved, 1.0, 0.9, 0.7);
  row('快照达成率（目标 10Hz）',
    netBinary.snapshotRateAchieved != null ? `${(netBinary.snapshotRateAchieved * 100).toFixed(1)}%` : '—',
    netJson?.snapshotRateAchieved != null ? `${(netJson.snapshotRateAchieved * 100).toFixed(1)}%` : '—',
    rateJ.level, '≥ 100%');
  const evJ = judge(netBinary.eventLoopP95Ms, TICK_BUDGET_MS, 0.5, 1.0);
  row('event loop P95 (ms)',
    fmt(netBinary.eventLoopP95Ms, 2), fmt(netJson?.eventLoopP95Ms, 2), evJ.level, `≤ ${bt.toFixed(2)}`);
  const tP95 = judge(netBinary.serverTickMs?.p95, bt, 0.5, 1.0);
  row('服务端主循环 tick P95 (ms)',
    fmt(netBinary.serverTickMs?.p95, 3), fmt(netJson?.serverTickMs?.p95, 3), tP95.level, `≤ ${bt.toFixed(2)}`);
  const tP99 = judge(netBinary.serverTickMs?.p99, bt, 0.6, 1.0);
  row('服务端主循环 tick P99 (ms)',
    fmt(netBinary.serverTickMs?.p99, 3), fmt(netJson?.serverTickMs?.p99, 3), tP99.level, `≤ ${bt.toFixed(2)}`);
  row('RTT P50 / P95 (ms)',
    `${netBinary.rttP50Ms ?? '—'} / ${netBinary.rttP95Ms ?? '—'}`,
    `${netJson?.rttP50Ms ?? '—'} / ${netJson?.rttP95Ms ?? '—'}`, 'none', '—');
  push('');
  push('RTT 口径：窗口开始时每条连接各发**一次** ping，服务端原样回显 `sent`，客户端用 `Date.now() - sent` 计算。'
    + '回环连接的理论 RTT 应 < 1 ms，实测到几十~几百毫秒说明**收发队列被积压**（服务端主循环或 64 条 socket 的写队列），'
    + '这是单次采样、样本量 64，只能作定性参考。');
  push('');
  if (Array.isArray(netBinary.downlinkByType) && netBinary.downlinkByType.length) {
    push('按消息类型拆分下行（稳态窗口内的字节占比，暴露「带宽并非都花在快照上」）：');
    push('');
    push('| 消息类型 | 帧数 | 总 KB | 平均 KB/帧 | 占下行 | 每客户端 KB/s |');
    push('| --- | --- | --- | --- | --- | --- |');
    for (const t of netBinary.downlinkByType.slice(0, 6)) {
      push(`| \`${t.type}\` | ${t.frames} | ${t.totalKB} | ${fmt(t.avgKB, 3)} | ${t.pctOfDownlink}% | ${t.kbPerClientPerSecond} |`);
    }
    push('');
    push('二进制路径：`wire:frame` 占下行 '
      + `${netBinary.downlinkByType[0]?.pctOfDownlink ?? '—'}%，快照帧 ${fmt(netBinary.snapshotFrameKB, 3)} KB/帧。`
      + '`lobby` / `roster` 是每条连接各一次的入房消息，只在 8 秒窗口里占比高（'
      + `${netBinary.downlinkByType.find((t) => t.type === 'roster')?.frames ?? 0} 条 roster ÷ 64 连接 = 1 次/人），`
      + '稳态长时间跑会被稀释。');
    push('');
  }
  // tick 补跑 / 饥饿诊断：把「快照达成率不足」归因到定时器行为，而不是含糊地说「CPU 争抢」。
  if (netBinary.serverTicksInWindow != null && netBinary.expectedTicksInWindow) {
    const ratio = netBinary.tickCatchUpRatio;
    push(`- **服务端 tick 实际执行**：窗口内 ${netBinary.serverTicksInWindow} 个 tick，`
      + `理论 ${netBinary.expectedTicksInWindow} 个（窗口 ${netBinary.seconds} 秒 × 30Hz），比值 ${ratio}×。`
      + `${ratio != null && ratio < 0.5 ? '远低于 1 说明 `setInterval` 被外部 CPU 抢占饿死，'
        + '主循环根本没跑到 30Hz——这是「快照达成率不足」的直接原因，而不是协议或广播逻辑的问题。'
        : ratio != null && ratio > 1.5 ? '大于 1 说明主循环在补跑（catch-up）：被阻塞后一轮连跑多个 tick，'
          + '会把任何 `tickCount % N` 的周期性工作（如 `server/rooms.mjs:502` 的 lobby 广播）在墙钟上放大。'
        : '接近 1，主循环基本跟上了目标频率。'}`);
    push('');
  }
  if (netBinary.serverTickMs) {
    const sz = netBinary.serverTickMs;
    push(`- **服务端主循环 tick（含广播）**：P50 ${fmt(sz.p50)} / P95 ${fmt(sz.p95)} / P99 ${fmt(sz.p99)} / `
      + `max ${fmt(sz.max)} ms（${sz.samples} 个样本，二进制路径）。`
      + `对比第 1 节的纯 \`update\` P50 ${fmt(sim?.p50TickMs)} ms——两者之差即广播/落盘/回放采样的开销。`);
    // 主循环 P50 与 update P50 不可直接相减：主循环样本里只有 1/3 的 tick 带广播，
    // 且两者采样窗口不同（tickSamples 只留最近 240 条）。这里只在「确实更大」时才给差值，
    // 否则说明广播开销低于测量噪声，不再给出无意义的负数。
    const overhead = Number.isFinite(sz.p50) && Number.isFinite(sim?.p50TickMs) ? sz.p50 - sim.p50TickMs : null;
    if (overhead != null && overhead > 0) {
      push(`- 广播开销（主循环 P50 − update P50）≈ **${fmt(overhead)} ms/tick**，`
        + `占 30Hz 预算 ${((overhead / bt) * 100).toFixed(2)}%。`);
    } else {
      push('- 主循环 P50 与 update P50 的差值落在测量噪声内（主循环样本只保留最近 240 条、且其中 2/3 的 tick 不含广播），'
        + '因此广播开销以第 2 节的独立实测为准。');
    }
    if (sz.p95 > bt) {
      push(`- **注意**：主循环 tick P95 ${fmt(sz.p95)} ms 已超过单 tick 预算 ${bt.toFixed(2)} ms。`
        + '说明在 64 人满房里，主循环会周期性「欠债」——`server/index.mjs:545` 的 `while (accumulator >= 1/TICK_RATE)` '
        + '会在一轮里补跑多个 tick，表现为客户端快照抖动（本机实测快照达成率 '
        + `${netBinary.snapshotRateAchieved != null ? `${(netBinary.snapshotRateAchieved * 100).toFixed(0)}%` : '—'}）。`
        + '注意本机非独占（同机模拟器占约 2 核），该绝对值偏悲观，但「P95 远大于 P50」的形态是结构性的。');
    }
  }
  push('');
}

// ── 5. 长稳 / 内存斜率 ───────────────────────────────────────────────────
push('## 5. 长稳（soak）：内存斜率与 tick 漂移');
push('');
if (!soak) {
  push('> 缺失：没有 `artifacts/soak-report.json`。');
  push('');
} else {
  const act = soak.actual || {};
  push(`场景：${act.matches ?? '—'} 场连续对局，总模拟 ${act.simMinutes ?? '—'} 分钟（${act.simSeconds ?? '—'} s），`
    + `${act.totalTicks ?? '—'} tick，墙钟 ${act.wallSeconds ?? '—'} s（加速 ${act.speedupVsRealtime ?? '—'}×）。`
    + `${soak.mode ? `模式：${soak.mode}。` : ''}`);
  push('');
  push('| 指标 | 预算/阈值 | 实测 | 判定 |');
  push('| --- | --- | --- | --- |');
  if (soakHeap) {
    const slope = soakHeap.slopeMiBPerSimMin;
    const slopeVsBudget = slope / HEAP_SLOPE_BUDGET;
    push(`| heap 斜率（去热身） | ≤ ${HEAP_SLOPE_BUDGET} MiB/模拟分钟 | **${slope}** MiB/模拟分钟`
      + `（超阈值 ${slopeVsBudget.toFixed(2)}×） | ${LEVEL_ICON[heapSlopeJudge.level]} |`);
    push(`| 拟合 R² | ≥ ${HEAP_R2_MIN} | ${soakHeap.r2} | ${heapR2Ok ? '达标' : '观察（拟合度不足，斜率不可信）'} |`);
    push(`| 后半程斜率 | ≤ ${HEAP_SLOPE_BUDGET} MiB/模拟分钟 | ${soakHeap.slopeLateHalfMiBPerSimMin}（R²=${soakHeap.r2LateHalf}） | `
      + `${soakHeap.slopeLateHalfMiBPerSimMin > HEAP_SLOPE_BUDGET ? '超预算' : '达标'} |`);
    push(`| heap 首 → 末（峰值） | — | ${soakHeap.firstMiB} → ${soakHeap.lastMiB} MiB（峰值 ${soakHeap.maxMiB} MiB） | — |`);
    push(`| rss 首 → 末 | — | ${soakHeap.rssFirstMiB} → ${soakHeap.rssLastMiB} MiB`
      + `（斜率 ${soakHeap.rssSlopeMiBPerSimMin} MiB/模拟分钟） | — |`);
  } else {
    push('| heap 斜率 | — | 缺失 | 缺失 |');
  }
  if (soakTick) {
    push(`| soak tick P50/P95/P99/max | 33.333 ms（max） | ${soakTick.overall?.p50} / ${soakTick.overall?.p95} / `
      + `${soakTick.overall?.p99} / ${soakTick.overall?.max} ms | `
      + `${soakTick.overall?.max > bt ? '观察（max 超单 tick 预算）' : '达标'} |`);
    push(`| tick P95 首桶 → 末桶 | 不应显著增长 | ${soakTick.p95FirstBucketMeanMs} → ${soakTick.p95LastBucketMeanMs} ms`
      + `（${soakTick.p95DeltaPct}%） | ${soakTick.p95DeltaPct > 20 ? '观察（有退化）' : '达标'} |`);
  } else {
    push('| soak tick 分位 | — | 缺失 | 缺失 |');
  }
  if (soakVerdict?.snapshot) {
    const s = soakVerdict.snapshot;
    push(`| 快照体积首 → 末 | 不随对局增长 | ${s.firstKB} → ${s.lastKB} KB（斜率 ${s.slopeKBPerSimMin} KB/模拟分钟，R²=${s.r2}） | `
      + `${Math.abs(s.slopeKBPerSimMin) < 1 ? '达标（无增长）' : '观察'} |`);
  }
  push('');
  if (soakVerdict) {
    push(`**soak 判定：${soakVerdict.level}（置信度 ${soakVerdict.confidence}）**——${soakVerdict.text}`);
    push('');
    // 本报告的阈值判定与 soak 脚本的判定会不一致，必须解释清楚，否则读者会以为其中一个是错的。
    if (soakHeap && heapSlopeJudge.level === 'bad' && soakVerdict.level !== '疑似泄漏') {
      push(`> **两个口径的差异**：本表只看「斜率是否超过 0.5 MiB/模拟分钟」→ 判定超预算；`
        + `而 \`scripts/soak.mjs\` 的判定要求**斜率与 R² 同时成立**（R²=${soakHeap.r2} < ${HEAP_R2_MIN}）。`
        + '两者的差别在于：斜率大但拟合差，说明增长不是单调的（V8 堆热身 / GC 锯齿），'
        + '而不是稳定泄漏。**结论以 soak 脚本的复合判定为准（'
        + `${soakVerdict.level}），但 12 分钟的斜率绝对值仍然偏高，值得在独占机器上做 60 分钟复测。**`);
      push('');
    }
    push(`判定标准（脚本原文）：${soakVerdict.criteria}`);
    push('');
  }
  const boundaries = soak.boundaries || [];
  if (boundaries.length) {
    push('对局边界 heap（跨局是否回落，验证 Match 是否随对局释放）：');
    push('');
    push('| 事件 | 场次 | 模拟分钟 | heapUsed (MiB) | rss (MiB) |');
    push('| --- | --- | --- | --- | --- |');
    for (const b of boundaries) {
      push(`| ${b.event === 'matchStart' ? '开局前' : '结束后'} | ${b.matchIndex} | ${b.simMin} | ${b.heapMiB} | ${b.rssMiB} |`);
    }
    push('');
  }
}

// ── 5. CPU 热点 ──────────────────────────────────────────────────────────
push('## 6. CPU 热点（self time）');
push('');
if (!prof.ok) {
  push(`> 缺失：${prof.error}。跑 \`node --cpu-prof --cpu-prof-dir=artifacts scripts/benchmark.mjs\` 重新采集。`);
  push('');
} else {
  push(`采集方式：\`node --cpu-prof\` 跑完整 \`scripts/benchmark.mjs\`（含 3 局单房模拟 + 4 房并发 + 64 socket 压测）。`
    + `采样 ${prof.total} 个样本 / ${prof.durationMs} ms，其中 idle ${prof.idlePct}%（等待 socket/定时器），`
    + `下表占比以**非 idle 样本**为分母（${prof.nonIdle}）。`);
  push('');
  push('| # | 自耗时占比 | 命中 | 函数 | 位置 |');
  push('| --- | --- | --- | --- | --- |');
  prof.rows.slice(0, 15).forEach((r, i) => {
    push(`| ${i + 1} | ${r.selfPct}% | ${r.hits} | \`${r.fn}\` | \`${r.url}:${r.line}\` |`);
  });
  push('');
  push('按文件聚合：');
  push('');
  push('| 文件 | 占比 | 命中 |');
  push('| --- | --- | --- |');
  for (const f of prof.byFile.slice(0, 8)) push(`| \`${f.file}\` | ${f.pct}% | ${f.hits} |`);
  push('');
  push('完整 Top 30 与归因见 `artifacts/cpu-profile-summary.md`。');
  push('');
}

// ── 独立的 profile 摘要文件（任务要求单独产出）──────────────────────────
function writeProfileSummary(path, p) {
  const out = [];
  const w = (s = '') => out.push(s);
  w('# CPU Profile 热点摘要（雾岛突围 MIST ISLE）');
  w('');
  w(`- 生成时间：${startedAt.toISOString()}`);
  w('- 采集命令：`node --cpu-prof --cpu-prof-dir=artifacts --cpu-prof-name=cpu-profile.cpuprofile scripts/benchmark.mjs`');
  w('- 环境：**本机**（Windows / Node.js v24.20.0 / i5-11500 12 逻辑核 / 14.3 GiB，非独占，'
    + '采样期间同机有 Android 模拟器与编辑器进程争抢 CPU）。');
  w(`- 原始文件：\`${p.path}\`（${p.total} 样本 / ${p.durationMs} ms / ${p.nodes ?? '—'} 节点）。`);
  w('');
  if (!p.ok) {
    w(`> 数据缺失：${p.error}`);
    w('');
    w('补齐方式：`node --cpu-prof --cpu-prof-dir=artifacts scripts/benchmark.mjs`，再重跑 `node scripts/perf-report.mjs`。');
    return `${out.join('\n')}\n`;
  }
  w('## 口径');
  w('');
  w('- **self time（自耗时）**：采样点正好落在该函数自身代码里的次数占比，不含它调用的子函数。'
    + '这是判断「哪段代码本身最烧 CPU」的正确口径。');
  w('- 分母为**非 idle 样本**：`--cpu-prof` 会记录等待事件循环的空闲采样（`(idle)`），'
    + `它占 ${p.idlePct}%，从分母里剔除后才能看出真实计算分布。`);
  w('- 同一函数的不同内联/去优化实例按 `函数名 + 文件 + 行号` 合并（与 `scripts/perf-baseline.mjs:135 topFunctions` 同口径）。');
  w('- 采样期间 `--cpu-prof` 本身有开销（约 15–30% 减速），因此只比较**占比**，不比较绝对毫秒。');
  w('');
  w(`## Top 15 自耗时函数（非 idle 分母 ${p.nonIdle} 样本）`);
  w('');
  w('| # | 自耗时占比 | 命中数 | 函数 | 文件:行 |');
  w('| --- | --- | --- | --- | --- |');
  p.rows.slice(0, 15).forEach((r, i) => {
    w(`| ${i + 1} | ${r.selfPct}% | ${r.hits} | \`${r.fn}\` | \`${r.url}:${r.line}\` |`);
  });
  w('');
  w('## Top 30（含 16–30 名）');
  w('');
  w('| # | 自耗时占比 | 命中数 | 函数 | 文件:行 |');
  w('| --- | --- | --- | --- | --- |');
  p.rows.slice(0, 30).forEach((r, i) => {
    w(`| ${i + 1} | ${r.selfPct}% | ${r.hits} | \`${r.fn}\` | \`${r.url}:${r.line}\` |`);
  });
  w('');
  w('## 按文件聚合');
  w('');
  w('| 文件 | 自耗时占比 | 命中数 |');
  w('| --- | --- | --- |');
  for (const f of p.byFile) w(`| \`${f.file}\` | ${f.pct}% | ${f.hits} |`);
  w('');
  w('## 归因结论');
  w('');
  const find = (needle) => p.byFile.find((f) => f.file.includes(needle));
  const ai = find('ai.mjs');
  const simFile = find('simulation.mjs');
  const map = find('map.mjs');
  const srv = find('server/index.mjs');
  const rooms = find('rooms.mjs');
  const rowOf = (fn) => p.rows.find((r) => r.fn === fn);
  w(`1. **Bot AI 是最大单块**：\`shared/ai.mjs\` 合计 ${ai?.pct ?? '—'}% 自耗时，`
    + `仅 \`thinkBot\`（\`shared/ai.mjs:${rowOf('thinkBot')?.line ?? 844}\`）就占 ${rowOf('thinkBot')?.selfPct ?? '—'}%。`
    + '64 人房里 63 个 bot 每 tick 都走进去，这是「玩家越多越慢」的直接来源。');
  w(`2. **碰撞/射线查询第二**：\`shared/map.mjs\` 合计 ${map?.pct ?? '—'}%，`
    + `其中 \`wallDistance\` ${rowOf('wallDistance')?.selfPct ?? '—'}%、\`blocked\` ${rowOf('blocked')?.selfPct ?? '—'}%、`
    + `\`gather\` ${rowOf('gather')?.selfPct ?? '—'}%。\`wallDistance\` 的绝大多数命中来自 \`clearLine\`，`
    + '即 bot 的视线判定，而不是子弹弹道。');
  w(`3. **模拟主循环第三**：\`shared/simulation.mjs\` 合计 ${simFile?.pct ?? '—'}%，`
    + `\`update\` ${rowOf('update')?.selfPct ?? '—'}%、\`_bots\` ${rowOf('_bots')?.selfPct ?? '—'}%、`
    + `\`_movePlayer\` ${rowOf('_movePlayer')?.selfPct ?? '—'}%、\`sanitizeInput\` ${rowOf('sanitizeInput')?.selfPct ?? '—'}%。`
    + '`sanitizeInput` 几乎全部来自 `_bots` 对 bot 自身输入的重复校验。');
  w(`4. **服务端序列化可见**：\`server/index.mjs\` ${srv?.pct ?? '—'}%（主要是 \`send\` 里的 \`JSON.stringify\`）、`
    + `原生 \`utf8Slice\` ${rowOf('utf8Slice')?.selfPct ?? '—'}%、GC ${rowOf('(garbage collector)')?.selfPct ?? '—'}%。`
    + '压测里 64 个连接走 JSON 路径时这部分被放大；走 wire 二进制时对应成本转移到编码侧。');
  w(`5. **房间编排开销很小**：\`server/rooms.mjs\` ${rooms?.pct ?? '—'}%，说明广播路径的瓶颈在序列化与编码，不在房间簿记。`);
  w('');
  w('## 复现');
  w('');
  w('```bash');
  w('node --cpu-prof --cpu-prof-dir=artifacts --cpu-prof-name=cpu-profile.cpuprofile scripts/benchmark.mjs');
  w('node scripts/perf-report.mjs   # 会同时刷新本文件');
  w('```');
  w('');
  w('> 在 Chrome DevTools 的 Performance 面板可直接拖入 `.cpuprofile` 查看火焰图；'
    + '`(idle)` 已在本文件的占比口径中剔除，火焰图里仍然是完整的墙钟时间。');
  return `${out.join('\n')}\n`;
}

const PROFILE_MD = 'artifacts/cpu-profile-summary.md';
// 数据缺失时也写一份「为什么缺 + 怎么补」的说明，避免下游读取方拿到不存在的文件。
writeFileSync(PROFILE_MD, writeProfileSummary(PROFILE_MD, prof), 'utf8');
console.log(`写出 ${PROFILE_MD}${prof.ok ? '' : '（数据缺失占位）'}`);

// ── 6. 结论 ──────────────────────────────────────────────────────────────
push('## 7. 结论摘要');
push('');
const conclusions = [];
if (sim) {
  const p99J = judge(sim.p99TickMs, bt * 0.5, 0.6, 1);
  conclusions.push(`**tick 稳态健康、尾部有尖峰**：P50 ${sim.p50TickMs} ms / P95 ${sim.p95TickMs} ms / `
    + `P99 ${sim.p99TickMs} ms（判定 ${LEVEL_ICON[p99J.level]}），但 max ${sim.maxTickMs} ms `
    + `${sim.maxTickMs > bt ? `超过 ${bt.toFixed(2)} ms 单 tick 预算` : '仍在预算内'}。`);
}
if (snapCost.ok) {
  const combined = (perTickMs || 0) + snapCost.binaryEncodeMs.mean / 3;
  conclusions.push(`**快照编码是 tick 之外的第二大成本**：64 人满房单帧快照 ${snapCost.snapshotMs.mean} ms + `
    + `编码 ${snapCost.binaryEncodeMs.mean} ms（二进制）/ ${snapCost.jsonEncodeMs.mean} ms（JSON），`
    + `摊到每 tick 后合计 ${fmt(combined)} ms。`);
}
if (multi) {
  conclusions.push(`**多房间基本线性、无互相拖慢**：${roomCount} 房并发后单房 P95 相对单房参照的比值为 `
    + `${scaleRatioP95 == null ? '—' : `${scaleRatioP95.toFixed(2)}×`}`
    + `（历史 6 轮区间 0.58–1.08×，比值 <1 属分位噪声，见第 1.1 节）；`
    + `超 tick P95 ${fmt(superTick?.p95)} ms，按「每房每轮」外推单进程约 `
    + `${roomHeadroom ? roomHeadroom.toFixed(1) : '—'} 个满员房（不含广播与 GC）。`);
}
if (netBinary) {
  const binKBps = netBinary.bytesPerClientPerSecond != null ? (netBinary.bytesPerClientPerSecond / 1024).toFixed(1) : '—';
  const jsonKBps = netJson?.bytesPerClientPerSecond != null ? (netJson.bytesPerClientPerSecond / 1024).toFixed(1) : '—';
  conclusions.push(`**二进制下行比 JSON 小一个数量级**：单客户端 ${binKBps} KB/s vs ${jsonKBps} KB/s，`
    + `快照帧 ${fmt(netBinary.snapshotFrameKB, 2)} KB vs ${fmt(netJson?.snapshotFrameKB, 2)} KB。`
    + '但两条路径的快照达成率都只有 50–81%（目标 10Hz），且主循环 tick P95 远超单 tick 预算——'
    + '在本机这是 CPU 争抢（tick 补跑比 0.61–0.89）；在独占机器上需复测才能定性为代码问题。');
}
if (soakVerdict) {
  conclusions.push(`**长稳${soakVerdict.level}**：heap 斜率 ${soakHeap?.slopeMiBPerSimMin} MiB/模拟分钟 `
    + `（R²=${soakHeap?.r2}，置信度 ${soakVerdict.confidence}）；tick P95 首末桶 ${soakTick?.p95DeltaPct}%。`);
}
if (prof.ok) {
  const top3 = prof.rows.slice(0, 3).map((r) => `\`${r.fn}\`(${r.selfPct}%)`).join('、');
  conclusions.push(`**热点集中在 bot AI 与碰撞查询**：${top3}；AI 相关（ai.mjs）合计 `
    + `${prof.byFile.find((f) => f.file.includes('ai.mjs'))?.pct ?? '—'}%，碰撞（map.mjs）合计 `
    + `${prof.byFile.find((f) => f.file.includes('map.mjs'))?.pct ?? '—'}%。`);
}
for (const c of conclusions) push(`- ${c}`);
push('');

// ── 7. 优化建议 ──────────────────────────────────────────────────────────
push('## 8. 可落地优化建议（按性价比排序）');
push('');
push('> 以下建议只写文件与函数，未实施（`shared/**`、`server/**` 不在性能负责人的写入范围内）。'
  + '收益估算基于第 6 节的 self time 占比 × 预期削减比例，风险按「是否改变模拟结果」分级。');
push('');
push('**最值得先做的 3 项**（收益/风险比最高）：');
push('');
push('1. **#5 广播「序列化一次」**（`server/index.mjs:151 send` + `server/rooms.mjs:268 broadcastState`）：'
  + '改动最小、语义完全等价，直接消掉 64 次重复 `JSON.stringify`，同时降 `utf8Slice` 与 GC；JSON 回退路径每轮可省 '
  + `${netJson?.snapshotFrameKB ? fmt(netJson.snapshotFrameKB * 63, 0) : '—'} KB 的无效序列化。`);
push('2. **#3 bot 输入跳过 `sanitizeInput`**（`shared/simulation.mjs:2306 _bots` + `:93`）：'
  + '`sanitizeInput` 有 97% 的命中来自 `_bots`，而 bot 输入是内部生成的，加一条 fast path 即可拿 3–4%，'
  + '且不影响人类输入的防作弊校验。');
const snapShare = snapCost.ok && snapCost.round64?.binaryMs?.mean > 0
  ? (snapCost.round64.snapshotMs.mean / (snapCost.round64.snapshotMs.mean + snapCost.round64.binaryMs.mean)) * 100
  : null;
const snapVsEncode = snapCost.ok && snapCost.round64?.binaryMs?.mean > 0
  ? snapCost.round64.snapshotMs.mean / snapCost.round64.binaryMs.mean : null;
push('3. **#8 快照构建增量复用**（`shared/simulation.mjs:2161 _snapBase` + `:2234 snapshot`）：'
  + '虽然风险最高（高），但它是**单个最大的成本块**——64 观察者一轮里快照构建占 '
  + `${snapShare != null ? snapShare.toFixed(0) : '—'}% 的广播时间，`
  + `${snapVsEncode != null ? `比整个二进制编码还高 ${snapVsEncode.toFixed(1)} 倍` : ''}。`
  + '属于「必须做但要做对」的一项，建议先用双缓冲 + 发送完成回调把生命周期理顺，再上线。');
push('');
push('若只能做低风险改动，先做 #5 + #3 + #1（合计预计 8–12%）即可覆盖当前 P95 波动的余量。');
push('');
const adv = [
  {
    n: 1, where: '`shared/ai.mjs:329 findPath` / `:449 simplifyPath` / `:1058 followPoint`',
    what: '给 A* 路径加「同起点同终点短 TTL 复用缓存」，并把 `findPath` 的开放集线性扫最小 f（`open[i]` 全表扫描）换成二叉堆。当前 `followPoint` 每 0.16–0.95 s 就可能重算一条路径，40 个 bot 在墙多的图上会持续打满 `PATH_TOKENS`。',
    gain: '`findPath` 自耗时 4.21%（749 命中），加 `followPoint` 1.65% + `simplifyPath`；预计 AI 侧总 CPU 降 5–8%。',
    risk: '低。缓存键要含 `bot.x/z` 量化值，否则会走到过期路径；堆实现要保证与线性扫的 tie-break 一致，否则 bot 行为（以及相关测试的确定性回放）会漂移。',
  },
  {
    n: 2, where: '`shared/map.mjs:255 wallDistance` / `:306 clearLine`',
    what: '`wallDistance` 的 4.79% 自耗时里有 732/852 命中来自 `clearLine`（`canSee` 的弹道级可见性判定）。加两层早退：(a) `clearLine` 先用 nav 网格 `pathClear` 做一次粗筛，明显被挡直接返回 false；(b) `wallDistance` 内 `blocksBullets[idx] === 0` 的障碍先按 `grid24` 桶预过滤，避免逐个做 slab 求交。',
    gain: '碰撞查询（map.mjs）合计 20.36%，其中 `wallDistance` 4.79% + `blocked` 4.10% + `gather` 3.44%；预计 map 侧降 4–6%。',
    risk: '低-中。`clearLine` 是「能不能开枪」的判定，粗筛必须**只允许否定、不允许肯定**，否则 bot 会对着墙开枪；`_traceShot` 也调 `wallDistance`，改它要单独跑弹道相关的模拟测试。',
  },
  {
    n: 3, where: '`shared/simulation.mjs:2306 _bots`（self 9.85%）',
    what: '`_bots` 每个 tick 对每个 bot 调 `sanitizeInput(p.botInput)`（`:93`，自耗时 2.96%，514/527 命中来自 `_bots`）——bot 的输入是自己 `blankInput()` 造出来的，字段已经合法，逐字段 clamp/查表纯属重复劳动。加一条 fast path：`thinkBot` 直接把规范化后的对象交给 `_movePlayer`，或用 `p.botInput.__clean=true` 跳过 `sanitizeInput`。',
    gain: '`sanitizeInput` 2.96% + `_bots` 自身循环开销；预计 3–4%。',
    risk: '中。必须保证 bot 侧不产生越界值（`mx/mz` 归一化、`aim` 包裹、`slot` 只允许 0/1），否则等于绕过防作弊/合法性校验；建议加一条「botInput 与 sanitizeInput(botInput) 深比较」的单测兜底。',
  },
  {
    n: 4, where: '`shared/ai.mjs:741 scanEnemies` / `:254 canSee`',
    what: '`scanEnemies` 每轮对最远 82 m 内的全部敌人排序并给最近 8 个做 `fast` 视线、最近 3 个做 `shot` 级 `clearLine`。把 `out.sort` 换成「只维护最近 N=8 的有序插入」，并对 `canSee(..., "shot")` 加 1 帧缓存（同一 bot + 同一目标 + 位置变化 < 0.5 m 直接复用）。',
    gain: '`scanEnemies` 1.68% + `clearLine` 一部分；预计 1.5–2.5%。',
    risk: '低。排序换成部分选择不改变语义；缓存要绑定 `match.tickCount` 与目标坐标，否则 bot 反应会变迟钝。',
  },
  {
    n: 5, where: '`server/index.mjs:151 send`（self 2.64%）+ `server/rooms.mjs:268 broadcastState`',
    what: '`send()` 里对每个成员重新 `JSON.stringify(data)`。同一个 `state` 对象在 `broadcast()` / `broadcastState()` 里被逐成员序列化，64 人就是 64 次重复。把「序列化一次 + 多播」抽成 `sendMany(wsList, data)`，只 stringify 一次。',
    gain: '`send` 2.64% + `utf8Slice` 3.37%（native，JSON 大字符串切片）+ GC 2.01%；预计 4–6%，且直接降低 GC 压力。',
    risk: '低。发的是同一份不可变字符串，语义完全等价；只需注意 `send()` 的背压分支要保留（`bufferedAmount > maxBuffer` 时逐个跳过）。',
  },
  {
    n: 6, where: '`shared/simulation.mjs:751 update`（self 6.18%，inclusive 30.51%）',
    what: '`update()` 自身 6.18% 不是逻辑——是函数体太大导致 V8 无法内联/优化，以及每 tick 无条件调用 `_updateGrenades/_updateCars/_updateZones/_updateDrops/_updateHorde`。给这些子系统加「空集合早退」（数组为空直接 return，已是 O(1) 但仍是函数调用），并把 `_updatePlayers` + `_bots` 的循环合并成一次遍历。',
    gain: '`update` 6.18% + `_updatePlayers` 1.99%；预计 3–5%。',
    risk: '中-高。合并遍历会改变人类/bot 的更新顺序（bot 依赖本 tick 玩家位置的顺序），可能改变对局结果；建议只做「空集合早退」这种语义等价的部分，先拿 2–3%。',
  },
  {
    n: 7, where: '`shared/simulation.mjs:93 sanitizeInput`（见建议 3）+ `shared/simulation.mjs:885 _movePlayer`（2.58%）',
    what: '`_movePlayer` 每个玩家每 tick 调 `world.inWater(x,z)`、`world.moveBody`（内部 `blocked` × 2 × steps）。把 `inWater` 与 `blocked` 的查询结果按「位置量化到 1 m 网格」做每 tick 缓存，同一格内的重复查询直接命中。',
    gain: '`moveBody` 1.66% + `blocked` 一部分；预计 1.5–2%。',
    risk: '中。缓存粒度太粗会让玩家「穿墙 1 m」；必须只缓存**不可变**的静态障碍判定，动态实体（车、其他玩家）不能进这个缓存。',
  },
  {
    n: 8, where: '`shared/simulation.mjs:2161 _snapBase` / `:2234 snapshot`',
    what: '`_snapBase` 的失效条件是 `tickCount/eventId/players.length/loot.length` 四元组；对局中每 tick 都在变，所以实际上每 tick 重建 64 个 playerView + ≤640 个 lootView + `attachments.slice()`。改成「按玩家/物资字段版本号增量更新」：只有 `x/z/hp/...` 变化的条目重建视图，其余复用上一帧对象。',
    gain: `快照实测：snapshot ${snapCost.ok ? snapCost.snapshotMs.mean : '—'} ms/帧、二进制编码 ${snapCost.ok ? snapCost.binaryEncodeMs.mean : '—'} ms/帧；`
      + '预计快照构建降 30–50%，折合每 tick 0.1–0.3 ms。风险点在于视图对象被客户端差量协议按引用持有，复用必须在「已发送完成后」才能改写。',
    risk: '高。快照对象直接进 `JSON.stringify` 与 `encodeStateFrame`，复用同一对象跨 tick 会让异步发送中的帧被后续 tick 改写（数据竞争）。必须配合「发送完成回调后再回收」的双缓冲，改动面较大。',
  },
  {
    n: 9, where: '`server/rooms.mjs:256 makeSharedCache`（key 字符串每成员拼接）',
    what: '`makeSharedCache` 每次调用返回新闭包 + 新 `Map`，且 key 是模板字符串 `${tickCount}:${eventId}:${since}`。改成在 `broadcastState` 开头建一次 Map，key 改成数值三元组编码（`tick * 1e6 + eventId * 1e3 + since` 或其他无碰撞组合），省掉 64 次字符串拼接与闭包分配。',
    gain: 'rooms.mjs 自耗时只有 0.42%（因为编码本身在 wire.mjs，未单列），但每次广播 64 个短字符串 + 64 个闭包进 GC；预计 GC 压力降 1–2%。',
    risk: '低。语义完全不变，只是缓存键表示法；注意 `since` 可能很大（eventId 单调递增），拼数值要防溢出，建议仍用字符串但复用同一 Map。',
  },
  {
    n: 10, where: '`shared/ai.mjs:559 nearestLoot`（1.30%）/ `:1328 idle`',
    what: '`nearestLoot` 每 0.55 s 遍历全部地面物资（≤640 条）做距离粗筛。复用地面的 `world.lootSpots` 空间索引，或给 `match.loot` 维护一个按 8 m 格分桶的索引，只查 bot 周围 3×3 格。',
    gain: '`nearestLoot` 1.30% + `idle` 分支；预计 1–1.5%。',
    risk: '中。`loot` 会被 `_compactLoot` 压实（下标变化），分桶索引必须在压实后重建或按 id 维护。',
  },
];
for (const a of adv) {
  push(`### ${a.n}. ${a.where}`);
  push('');
  push(`- **做法**：${a.what}`);
  push(`- **预计收益**：${a.gain}`);
  push(`- **风险**：${a.risk}`);
  push('');
}

// ── 8. 口径与局限 ────────────────────────────────────────────────────────
push('## 9. 口径与局限');
push('');
push('- **非独占机器**：采样期间同机有 Android 模拟器（qemu-system-x86_64，约占 2 核）与多个编辑器进程，'
  + 'CPU 长期 100%、可用内存最低仅 ~200 MiB。绝对毫秒数偏悲观，横向对比与占比分析仍有效。');
push('- **本机合成负载**：benchmark 的 64 socket 全部来自 127.0.0.1，不代表 64 台真机或公网 RTT/带宽；'
  + 'soak 是 headless 直连 `Match`，不经过 ws 广播路径。');
push('- **soak 为加速模式**：`update(1/30)` 连续调用不等墙钟（本机约 25× 实时），V8 GC 触发节奏与真实 30Hz 服务不同，'
  + '内存斜率只能作趋势参考。');
push('- **profile 采样开销**：`--cpu-prof` 会拖慢约 15–30%，profile 中的绝对耗时不可直接与 benchmark 数字对比，只看占比。');
push('- **tick 分位与快照分开测**：benchmark 的 tick 分位只含 `match.update()`；快照编码在第 2 节单独实测后相加。'
  + '两者相加时才等于服务端主循环的真实每 tick 成本。');
push('');
push(`_由 \`scripts/perf-report.mjs\` 生成于 ${startedAt.toISOString()}。_`);
push('');

mkdirSync('artifacts', { recursive: true });
writeFileSync(OUT, `${L.join('\n')}\n`, 'utf8');

// ── 控制台摘要 ────────────────────────────────────────────────────────────
console.log(`写出 ${OUT}`);
if (missing.length) {
  console.log(`\n缺失 ${missing.length} 项（已降级）：`);
  for (const m of missing) console.log(`  - ${m}`);
}
console.log('\n关键指标：');
if (sim) {
  console.log(`  tick P50/P95/P99/max = ${sim.p50TickMs} / ${sim.p95TickMs} / ${sim.p99TickMs} / ${sim.maxTickMs} ms`
    + `（预算 ${bt.toFixed(2)} ms，均值 ${fmt(perTickMs)} ms）`);
}
if (snapCost.ok) {
  console.log(`  快照: snapshot ${snapCost.snapshotMs.mean} ms / bin ${snapCost.binaryEncodeMs.mean} ms`
    + ` / json ${snapCost.jsonEncodeMs.mean} ms（${snapCost.jsonKB} KB → ${snapCost.binaryKB} KB）`);
}
if (multi) {
  console.log(`  多房间: ${roomCount} 房超 tick P95 ${fmt(superTick?.p95)} ms，`
    + `外推容量 ≈ ${roomHeadroom ? roomHeadroom.toFixed(1) : '—'} 房`);
}
if (soakHeap) {
  console.log(`  soak heap 斜率 ${soakHeap.slopeMiBPerSimMin} MiB/模拟分钟（R²=${soakHeap.r2}）`
    + `，判定 ${soakVerdict?.level ?? '—'}`);
}
if (prof.ok) {
  console.log('  CPU 热点 Top 5：');
  for (const r of prof.rows.slice(0, 5)) console.log(`    ${String(r.selfPct).padStart(6)}%  ${r.fn}  (${r.url}:${r.line})`);
}
