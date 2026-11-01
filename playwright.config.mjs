import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 90000,
  expect: { timeout: 10000 },
  // trace 默认 off：多个 Playwright 实例并发跑时会争用 test-results/.playwright-artifacts
  // 目录，报 ENOENT recording2.trace 这种假失败（游戏本身没问题）。
  // 需要排查时用 PW_TRACE=1 npx playwright test。
  use: {
    baseURL: 'http://127.0.0.1:8787',
    launchOptions: { args: process.platform === 'win32' && process.env.WEBGL_SOFTWARE !== '1' ? ['--use-angle=d3d11'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: process.env.PW_TRACE === '1' ? 'retain-on-failure' : 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:8787/health', reuseExistingServer: true, timeout: 90000, stdout: 'ignore', stderr: 'pipe' },
});
