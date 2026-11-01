// 性能基线采集（owner: perf）— 开局加载 + 对战稳态逐帧采样
// 用法：
//   node scripts/perf-baseline.mjs                          # 桌面 + 移动模拟，各 3 轮取中位数，每轮 60s
//   node scripts/perf-baseline.mjs --runs 1 --seconds 10    # 快速冒烟
//   node scripts/perf-baseline.mjs --only desktop --profile # 只跑桌面 + 抓 CPU profile
// 输出：artifacts/perf/baseline.json（旧文件 → baseline.prev.json，供 _perf-compare.mjs）
//       artifacts/perf/cpuprofile.json（--profile 时）
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const BASE = argOf('base', 'http://127.0.0.1:8787/');
const RUNS = Math.max(1, Number(argOf('runs', '3')));
const SECONDS = Math.max(3, Number(argOf('seconds', '60')));
const QUALITY = argOf('quality', 'high');
const ONLY = argOf('only', '');
const OUT = 'artifacts/perf';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 统计 ────────────────────────────────────────────────────────────────────
const quant = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
function stats(arr, digits = 2) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const r = (v) => +v.toFixed(digits);
  return {
    n: a.length, min: r(a[0]), p50: r(quant(a, 0.5)), p95: r(quant(a, 0.95)),
    p99: r(quant(a, 0.99)), max: r(a[a.length - 1]), mean: r(a.reduce((s, v) => s + v, 0) / a.length),
  };
}
const median = (arr) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return +(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2).toFixed(2);
};

// 844×390 = iPhone 12/13 横屏逻辑分辨率；4x CPU 降速 ≈ 中端安卓单核水平
const PRESETS = {
  desktop: { label: 'desktop-1280x720', viewport: { width: 1280, height: 720 }, cpuThrottle: 1 },
  mobile: { label: 'mobile-844x390-4x', viewport: { width: 844, height: 390 }, cpuThrottle: 4 },
};

async function bootAndEnterMatch(browser, preset) {
  const context = await browser.newContext({ viewport: preset.viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
  // 埋点必须早于 app.js：t0 → mistIsle 就绪 → 首个 rAF（游戏首帧）
  await page.addInitScript(({ quality }) => {
    localStorage.setItem('mist-isle-settings-v2', JSON.stringify({
      quality, sfx: 0, music: 0, tutorialDone: true, hint: 0, showFps: false,
    }));
    const t0 = performance.now();
    const boot = { t0 };
    window.__perfBoot = boot;
    const poll = () => {
      if (window.mistIsle) {
        boot.ready = performance.now();
        requestAnimationFrame(() => { boot.firstFrame = performance.now(); });
        return;
      }
      setTimeout(poll, 2);
    };
    poll();
  }, { quality: QUALITY });
  const t = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__perfBoot?.firstFrame > 0, null, { timeout: 60000 });
  const boot = await page.evaluate(() => ({
    readyMs: +(window.__perfBoot.ready - window.__perfBoot.t0).toFixed(1),
    firstFrameMs: +(window.__perfBoot.firstFrame - window.__perfBoot.t0).toFixed(1),
    navMs: +(performance.getEntriesByType('navigation')[0]?.duration || 0).toFixed(1),
  }));
  // 大厅 → 训练场：只有对局里才有 ~70 drawCalls 的真实负载
  await page.evaluate(() => document.getElementById('nav-play')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('mode-training')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('btn-offline')?.click());
  await page.waitForFunction(() => {
    const s = window.mistIsle?.getStatus?.();
    return s && s.mode === 'match' && s.phase && s.phase !== 'deploying';
  }, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  return { context, page, errors, boot, wallMs: Date.now() - t };
}

/** 页面内 rAF 采样：每帧 dt / drawCalls / triangles / heapMB（不受 Node 端定时抖动影响）。 */
async function sampleFrames(page, seconds) {
  await page.evaluate(() => {
    const s = { dt: [], calls: [], tris: [], heap: [] };
    window.__s = s;
    window.__stop = false;
    let prev = 0;
    const tick = (now) => {
      if (window.__stop) return;
      const h = window.mistIsle?.getHealth?.() || {};
      if (prev) s.dt.push(now - prev);
      prev = now;
      s.calls.push(h.drawCalls); s.tris.push(h.triangles); s.heap.push(h.heapMB);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await sleep(seconds * 1000);
  return page.evaluate(() => { window.__stop = true; return window.__s; });
}

function summarize(raw, seconds) {
  const dt = raw.dt.filter((n) => n > 0 && n < 2000);
  const heap = raw.heap.filter(Number.isFinite);
  const pct = (n) => (dt.length ? +((n / dt.length) * 100).toFixed(2) : null);
  let gcDrops = 0;
  for (let i = 1; i < heap.length; i++) if (heap[i - 1] - heap[i] > 1) gcDrops++; // 单帧回落 >1MB 视为一次回收
  return {
    seconds, frames: dt.length,
    dtMs: stats(dt),
    fps: dt.length ? +(1000 / (dt.reduce((s, v) => s + v, 0) / dt.length)).toFixed(1) : null,
    drawCalls: stats(raw.calls), triangles: stats(raw.tris), heapMB: stats(heap, 3),
    stutterPct: pct(dt.filter((d) => d > 33).length),  // <30fps 的单帧
    severePct: pct(dt.filter((d) => d > 50).length),
    gcDrops, heapDeltaMB: heap.length ? +(heap[heap.length - 1] - heap[0]).toFixed(2) : null,
  };
}

/** CPU profile 热点（self time，按 函数+文件+行 合并）。 */
function topFunctions(profile, base, limit = 18) {
  if (!profile?.nodes) return [];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (const id of profile.samples || []) self.set(id, (self.get(id) || 0) + 1);
  const total = profile.samples?.length || 1;
  const merged = new Map();
  for (const [id, hits] of self) {
    const f = byId.get(id)?.callFrame;
    if (!f) continue;
    const url = (f.url || '').replace(base, '').replace(/^.*\//, '');
    const key = `${f.functionName || '(anon)'}|${url}|${(f.lineNumber ?? -1) + 1}`;
    const prev = merged.get(key);
    if (prev) prev.hits += hits;
    else merged.set(key, { fn: f.functionName || '(anon)', url, line: (f.lineNumber ?? -1) + 1, hits });
  }
  return [...merged.values()].map((r) => ({ ...r, selfPct: +((r.hits / total) * 100).toFixed(2) }))
    .sort((a, b) => b.selfPct - a.selfPct).slice(0, limit);
}

async function measure(browser, preset, profile = false) {
  const { context, page, errors, boot, wallMs } = await bootAndEnterMatch(browser, preset);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable').catch(() => {});
  if (preset.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: preset.cpuThrottle });
  const grab = async () => Object.fromEntries(
    (await cdp.send('Performance.getMetrics').then((r) => r.metrics).catch(() => [])).map((m) => [m.name, m.value]));
  const m0 = await grab();
  if (profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
    await cdp.send('Profiler.start');
  }
  const raw = await sampleFrames(page, SECONDS);
  const prof = profile ? (await cdp.send('Profiler.stop')).profile : null;
  const m1 = await grab();
  const health = await page.evaluate(() => window.mistIsle.getHealth());
  const status = await page.evaluate(() => window.mistIsle.getStatus());
  await context.close();
  return {
    label: preset.label, viewport: preset.viewport, cpuThrottle: preset.cpuThrottle,
    boot, wallMs, ...summarize(raw, SECONDS), health, status,
    layoutDelta: +((m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)).toFixed(0) || 0,
    styleDelta: +((m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0)).toFixed(0) || 0,
    nodeDelta: +((m1.Nodes ?? 0) - (m0.Nodes ?? 0)).toFixed(0) || 0,
    errors: errors.slice(0, 10),
    topFunctions: profile ? topFunctions(prof, BASE) : undefined,
  };
}

// ── 跨轮中位数 ──────────────────────────────────────────────────────────────
const SKIP = new Set(['topFunctions', 'errors', 'health', 'status']);
function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, `${prefix}${k}.`, out);
    else if (typeof v === 'number' && Number.isFinite(v)) out[`${prefix}${k}`] = v;
  }
  return out;
}
function medianBlock(runs) {
  const flat = runs.map((r) => flatten(r));
  const out = {};
  for (const k of Object.keys(flat[0] || {})) out[k] = median(flat.map((f) => f[k]));
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
const chosen = ONLY ? [PRESETS[ONLY]].filter(Boolean) : [PRESETS.desktop, PRESETS.mobile];
if (!chosen.length) { console.error(`未知 --only：${ONLY}（可选 desktop / mobile）`); process.exit(2); }
const browser = await chromium.launch({
  args: ['--use-angle=d3d11', '--enable-precise-memory-info', '--enable-unsafe-swiftshader'],
});
const result = { name: 'baseline', base: BASE, startedAt: new Date().toISOString(), quality: QUALITY, seconds: SECONDS, runs: RUNS, profiles: {} };

for (const preset of chosen) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`[${preset.label}] run ${i + 1}/${RUNS} … `);
    const r = await measure(browser, preset, has('profile') && i === 0);
    runs.push(r);
    console.log(`boot ${r.boot.readyMs}ms | dt p50 ${r.dtMs.p50} p99 ${r.dtMs.p99} max ${r.dtMs.max} | fps ${r.fps} | calls ${r.drawCalls.p50} | tris ${Math.round(r.triangles.p50 / 1000)}K | heap ${r.heapMB.p50}MB | 卡顿 ${r.stutterPct}%`);
  }
  result.profiles[preset.label] = { preset, runs, median: medianBlock(runs) };
  const hot = runs[0].topFunctions;
  if (hot) {
    console.log(`  CPU 热点 top ${hot.length}:`);
    for (const f of hot.slice(0, 12)) console.log(`   ${String(f.selfPct).padStart(5)}%  ${f.fn}  (${f.url}:${f.line})`);
    writeFileSync(`${OUT}/cpuprofile.json`, JSON.stringify({ label: preset.label, top: hot }, null, 2));
  }
}
await browser.close();
result.finishedAt = new Date().toISOString();

const cur = `${OUT}/baseline.json`;
if (existsSync(cur)) copyFileSync(cur, `${OUT}/baseline.prev.json`); // 归档供 compare 用
writeFileSync(cur, JSON.stringify(result, null, 2));

// ── 表格 ────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const n2 = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
const ROWS = [
  ['boot ready (ms)', (m) => n2(m['boot.readyMs'], 1)],
  ['首帧 (ms)', (m) => n2(m['boot.firstFrameMs'], 1)],
  ['dt p50 (ms)', (m) => n2(m['dtMs.p50'])],
  ['dt p95 (ms)', (m) => n2(m['dtMs.p95'])],
  ['dt p99 (ms)', (m) => n2(m['dtMs.p99'])],
  ['dt max (ms)', (m) => n2(m['dtMs.max'])],
  ['dt mean (ms)', (m) => n2(m['dtMs.mean'])],
  ['avg fps', (m) => n2(m.fps, 1)],
  ['卡顿帧 >33ms', (m) => `${n2(m.stutterPct)}%`],
  ['严重 >50ms', (m) => `${n2(m.severePct)}%`],
  ['drawCalls p50', (m) => n2(m['drawCalls.p50'], 1)],
  ['drawCalls max', (m) => n2(m['drawCalls.max'], 1)],
  ['triangles p50 (K)', (m) => n2((m['triangles.p50'] || 0) / 1000, 1)],
  ['heap p50 (MB)', (m) => n2(m['heapMB.p50'])],
  ['heap max (MB)', (m) => n2(m['heapMB.max'])],
  ['heap 增量 (MB)', (m) => n2(m.heapDeltaMB)],
  ['GC 回落次数', (m) => m.gcDrops ?? '—'],
  ['layout 增量', (m) => m.layoutDelta ?? '—'],
  ['recalcStyle 增量', (m) => m.styleDelta ?? '—'],
];
console.log(`\n${'═'.repeat(96)}`);
console.log(`${pad('指标', 22)}${chosen.map((p) => pad(p.label, 34)).join('')}`);
console.log('─'.repeat(96));
for (const [label, get] of ROWS) {
  console.log(`${pad(label, 22)}${chosen.map((p) => pad(get(result.profiles[p.label].median), 34)).join('')}`);
}
console.log('═'.repeat(96));
console.log(`\n写出 ${cur}（上一份 → baseline.prev.json）`);
