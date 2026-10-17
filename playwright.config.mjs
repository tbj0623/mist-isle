import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 90000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:8787',
    launchOptions: { args: process.platform === 'win32' && process.env.WEBGL_SOFTWARE !== '1' ? ['--use-angle=d3d11'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  reporter: [['list']],
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:8787/health', reuseExistingServer: true, timeout: 30000 },
});
