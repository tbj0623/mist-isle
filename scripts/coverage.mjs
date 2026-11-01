// 雾岛突围 / MIST ISLE — 覆盖率入口（npm run test:coverage）
//
// 为什么要这层包装：
//   1) Node 内置的 `--test-reporter=lcov --test-reporter-destination=coverage/lcov.info`
//      **不会**自动创建目录，目录不存在时 worker 直接 ENOENT 崩溃（实测 Node 22/24 都会）；
//   2) Windows 的 cmd 不会展开 `tests/*.test.mjs`，npm script 里写通配符只有 *nix 能用。
//      这里用 Node 自己读目录生成文件列表，三平台行为一致。
//
// 用法：
//   npm run test:coverage            # 全部单测 + 文本报告 + coverage/lcov.info
//
// 输出：
//   · stdout：Node 自带的文本覆盖率表（行/分支/函数 + 未覆盖行号）
//   · coverage/lcov.info：给 Codecov / IDE / genhtml 用的标准 lcov
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../coverage/', import.meta.url));
const LCOV = fileURLToPath(new URL('../coverage/lcov.info', import.meta.url));

mkdirSync(OUT_DIR, { recursive: true });

// 与 `npm test` 的 tests/*.test.mjs 等价：只收 *.test.mjs，排除 _ 前缀的临时脚本
const tests = readdirSync(new URL('../tests/', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `tests/${name}`);

if (tests.length === 0) {
  console.error('未找到任何 tests/*.test.mjs');
  process.exit(1);
}

const args = [
  '--test',
  '--experimental-test-coverage',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=lcov',
  `--test-reporter-destination=${LCOV}`,
  ...tests,
];

console.log(`▶ node ${args.join(' ')}\n`);
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
process.exitCode = result.status ?? 1;
