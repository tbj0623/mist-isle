// 基线对比门禁（owner: perf）— 当前 vs 上次，任一指标劣化 > 10% 退出码非 0
// 用法：
//   node scripts/perf-compare.mjs                          # baseline.json vs baseline.prev.json
//   node scripts/perf-compare.mjs --cur a.json --prev b.json
//   node scripts/perf-compare.mjs --threshold 0.15          # 放宽到 15%
// 劣化定义：越大越差的指标 cur > prev*(1+t)；越大越好的指标（fps）cur < prev*(1-t)。
// 只在两边都有有效数字且 prev > 0 时比较；缺失指标跳过（不误报）。
import { readFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const CUR = argOf('cur', 'artifacts/perf/baseline.json');
const PREV = argOf('prev', 'artifacts/perf/baseline.prev.json');
const TH = Number(argOf('threshold', '0.10'));

for (const p of [CUR, PREV]) {
  if (!existsSync(p)) {
    console.error(`缺少基线文件：${p}`);
    process.exit(2);
  }
}
const cur = JSON.parse(readFileSync(CUR, 'utf8'));
const prev = JSON.parse(readFileSync(PREV, 'utf8'));

// [key, 中文名, 方向] —— 方向 'up' 表示数值变大是劣化，'down' 表示变小是劣化
const METRICS = [
  ['boot.readyMs', 'boot 就绪 (ms)', 'up'],
  ['boot.firstFrameMs', '首帧 (ms)', 'up'],
  ['dtMs.p50', 'dt p50 (ms)', 'up'],
  ['dtMs.p95', 'dt p95 (ms)', 'up'],
  ['dtMs.p99', 'dt p99 (ms)', 'up'],
  ['dtMs.max', 'dt max (ms)', 'up'],
  ['fps', '平均 fps', 'down'],
  ['stutterPct', '卡顿帧占比 (%)', 'up'],
  ['severePct', '严重卡顿占比 (%)', 'up'],
  ['drawCalls.p50', 'drawCalls p50', 'up'],
  ['drawCalls.max', 'drawCalls max', 'up'],
  ['triangles.p50', 'triangles p50', 'up'],
  ['heapMB.p50', 'heap p50 (MB)', 'up'],
  ['heapMB.max', 'heap max (MB)', 'up'],
  ['gcDrops', 'GC 回落次数', 'up'],
  ['layoutDelta', 'layout 增量', 'up'],
  ['styleDelta', 'recalcStyle 增量', 'up'],
];

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? null : o[k]), obj);
const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

let failures = 0;
let compared = 0;
let worst = null;
const rows = [];
for (const [key, name, dir] of METRICS) {
  for (const label of Object.keys(cur.profiles || {})) {
    const c = get(cur.profiles?.[label]?.median, key);
    const p = get(prev.profiles?.[label]?.median, key);
    if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) continue;
    compared++;
    const delta = (c - p) / Math.abs(p);           // 正 = 数值上升
    const regressed = dir === 'up' ? delta > TH : -delta > TH;
    if (regressed) {
      failures++;
      const sev = Math.abs(delta);
      if (!worst || sev > worst.sev) worst = { label, name, sev, c, p, delta };
    }
    rows.push({ label, name, prev: p, cur: c, delta, regressed });
  }
}

// 相同指标跨配置打印
console.log(`对比 ${PREV} → ${CUR}（门禁 ${(TH * 100).toFixed(0)}%，比较 ${compared} 个指标）\n`);
console.log(`${'配置'.padEnd(22)}${'指标'.padEnd(20)}${'上次'.padStart(10)}${'本次'.padStart(10)}${'变化'.padStart(10)}  判定`);
console.log('─'.repeat(84));
for (const r of rows) {
  const pct = `${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`;
  const verdict = r.regressed ? '!! 劣化' : (Math.abs(r.delta) <= TH ? 'ok' : (r.delta > 0 ? '↑' : '↓ 更好'));
  console.log(`${r.label.padEnd(22)}${r.name.padEnd(20)}${fmt(r.prev).padStart(10)}${fmt(r.cur).padStart(10)}${pct.padStart(10)}  ${verdict}`);
}

console.log('─'.repeat(84));
if (failures) {
  console.log(`\n!! ${failures} 项劣化超过 ${(TH * 100).toFixed(0)}%`);
  if (worst) console.log(`   最严重：${worst.label} / ${worst.name}  ${fmt(worst.p)} → ${fmt(worst.c)}（${(worst.delta * 100).toFixed(1)}%）`);
  process.exit(1);
}
console.log(`\n✔ 无超过 ${(TH * 100).toFixed(0)}% 的劣化（比较 ${compared} 个指标）`);
