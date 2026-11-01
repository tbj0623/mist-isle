// 雾岛突围 / MIST ISLE — 提交前快速自检（不依赖 husky，纯 Node 脚本）
//
// 用法：
//   node scripts/precommit.mjs        # 或 npm run precommit
//
// 做两件事，总耗时约 5–10 秒（本机实测 lint ~5s + 测试 ~4s）：
//   1) npm run lint      —— oxlint 全仓库扫描（error 级必须为 0，warning 不阻塞）
//   2) node --test tests/render-static.test.mjs tests/data.test.mjs
//      —— 覆盖「bundle 能否构建/能否被 import」与「数据表契约」的最快子集
//
// 不跑全家桶（211 项约 72 秒）是对的：pre-commit 的价值是「几秒内拦住低级错误」，
// 完整测试 + e2e 交给 CI。需要装成 git hook 时执行：
//   git config core.hooksPath .githooks      （.githooks/pre-commit 已提供）
// 或者手动 `npm run precommit`。
//
// 退出码：0 = 通过；1 = 有检查失败（git commit 会被拦下）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// 直接调用本地 node 运行 oxlint 的入口，而不是 `npm run lint`：
//   · Windows 上 node 拒绝无 shell 地 spawn .cmd（CVE-2024-27980 的缓解），
//     加 shell:true 又会触发 Node 24 的 DEP0190 并拆坏带空格的 node.exe 路径；
//   · 直接用 process.execPath 跑 node_modules 里的 JS 入口，三平台行为完全一致。
const OXLINT_BIN = fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url));

const run = (label, command, args) => {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return { label, ok: result.status === 0, seconds, status: result.status };
};

const steps = [
  // 1) 静态检查：未定义变量、不可达代码、== 误用、debugger、eval、重复键
  ['静态检查 (oxlint)', process.execPath, [OXLINT_BIN, '.']],
  // 2) 快速测试子集：bundle 可构建 + 数据表契约
  [
    '快速测试 (render-static + data)',
    process.execPath,
    ['--test', 'tests/render-static.test.mjs', 'tests/data.test.mjs'],
  ],
];

console.log('── MIST ISLE 提交前检查 ─────────────────────────────');
const results = [];
for (const [label, command, args] of steps) {
  console.log(`\n▶ ${label}`);
  results.push(run(label, command, args));
}

console.log('\n── 结果 ─────────────────────────────────────────────');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(34)} ${r.seconds}s`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n✗ ${failed.length} 项未通过，提交已中止。修正后重试，或用 git commit --no-verify 跳过（不建议）。`);
  process.exitCode = 1;
} else {
  console.log('\n✓ 全部通过，可以提交。');
}
