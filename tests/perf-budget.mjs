// 性能断言的时间预算倍率（被 tests/*.test.mjs 引用，自身不是测试文件）。
//
// 为什么需要：`npm test` 里有几条**真实计时**断言（地图生成 < 1500ms、64 人 600 tick
// < 8s 等）。它们在本机（Windows 开发机、热缓存、空闲 CPU）是稳定的，但 GitHub Actions
// 的共享 runner 主频更低、vCPU 更少、还和邻居抢 CPU，同一份代码可能慢 2–3 倍而误报。
//
// 约定：
//   · 本地（未设置 CI）倍率恒为 1，**不削弱任何本地断言**；
//   · 只有 CI 环境（GitHub Actions 会自动注入 CI=true）才放宽到 3 倍；
//   · 也可以用 MIST_PERF_MULT 显式覆盖，便于在弱机上复现 CI 行为。
const ci = process.env.CI === 'true' || process.env.CI === '1';
const override = Number(process.env.MIST_PERF_MULT);

/** 性能预算倍率：本地 1，CI 3，MIST_PERF_MULT 优先。 */
export const PERF_MULT = Number.isFinite(override) && override > 0 ? override : ci ? 3 : 1;

/** 把毫秒预算按当前环境放大。 */
export const budget = (ms) => Math.round(ms * PERF_MULT);
