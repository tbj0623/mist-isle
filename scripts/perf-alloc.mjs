// 分配归因（owner: perf）— 用 CDP HeapProfiler 采样，找出稳态每帧在分配什么。
// 用法：node scripts/perf-alloc.mjs [--seconds 20] [--only mobile]
// 输出：artifacts/perf/alloc.json（按「函数+文件+行」聚合的自分配字节数 top 40）
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const BASE = argOf('base', 'http://127.0.0.1:8787/');
const SECONDS = Math.max(3, Number(argOf('seconds', '20')));
const PRESET = argOf('only', 'desktop');
const OUT = 'artifacts/perf';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESETS = {
  desktop: { viewport: { width: 1280, height: 720 }, cpuThrottle: 1 },
  mobile: { viewport: { width: 844, height: 390 }, cpuThrottle: 4 },
};
const preset = PRESETS[PRESET] || PRESETS.desktop;

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-precise-memory-info'] });
const context = await browser.newContext({ viewport: preset.viewport, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.addInitScript(() => {
  localStorage.setItem('mist-isle-settings-v2', JSON.stringify({
    quality: 'high', sfx: 0, music: 0, tutorialDone: true, hint: 0, showFps: false,
  }));
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 60000 });
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

const cdp = await context.newCDPSession(page);
if (preset.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: preset.cpuThrottle });
await cdp.send('HeapProfiler.enable');
// 采样模式：按 32KB 间隔抽样分配栈，开销量级很小，适合跑稳态 20s
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true });
await sleep(SECONDS * 1000);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const heap = await page.evaluate(() => window.mistIsle.getHealth().heapMB);
await context.close();
await browser.close();

// profile.head 是调用树；samples 里每个节点带 selfSize（该栈帧直接分配字节）
const rows = [];
const walk = (node, stack) => {
  const f = node.callFrame || {};
  const name = f.functionName || '(anon)';
  const url = (f.url || '').replace(BASE, '').replace(/^.*\//, '');
  const line = (f.lineNumber ?? -1) + 1;
  if (node.selfSize > 0) {
    rows.push({ fn: name, url, line: line > 0 ? line : null, selfKB: +(node.selfSize / 1024).toFixed(1), stack: stack.slice(-6).reverse().join(' < ') });
  }
  for (const child of node.children || []) walk(child, [...stack, `${name}:${line}`]);
};
walk(profile.head, []);
const totalKB = rows.reduce((s, r) => s + r.selfKB, 0);
rows.sort((a, b) => b.selfKB - a.selfKB);

// 按函数+位置合并，保留最热的一条调用栈作为归属线索
const merged = new Map();
for (const r of rows) {
  const key = `${r.fn}|${r.url}|${r.line}`;
  const prev = merged.get(key);
  if (prev) prev.selfKB = +(prev.selfKB + r.selfKB).toFixed(1);
  else merged.set(key, { ...r });
}
const top = [...merged.values()].sort((a, b) => b.selfKB - a.selfKB).slice(0, 40)
  .map((r) => ({ ...r, pct: +((r.selfKB / totalKB) * 100).toFixed(1) }));

const out = { preset: PRESET, seconds: SECONDS, heapMB: heap, sampledTotalMB: +(totalKB / 1024).toFixed(2), top };
writeFileSync(`${OUT}/alloc.json`, JSON.stringify(out, null, 2));
console.log(`采样 ${SECONDS}s（${PRESET}）heap=${heap?.toFixed?.(1)}MB 抽样分配总量 ${out.sampledTotalMB}MB\n`);
console.log(`${'KB'.padStart(9)}${'占比'.padStart(8)}  函数 (文件:行)`);
console.log('─'.repeat(88));
for (const r of top.slice(0, 25)) {
  console.log(`${String(r.selfKB).padStart(9)}${String(`${r.pct}%`).padStart(8)}  ${r.fn}  (${r.url}:${r.line})`);
}
console.log(`\n写出 ${OUT}/alloc.json`);
