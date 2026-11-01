// v1.3.1 · 首页一键试玩与首次引导的真实浏览器回归。
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeAll(() => mkdir('artifacts/release', { recursive: true }));

test.use({ viewport: { width: 1280, height: 720 } });

async function boot(page, tutorialDone) {
  await page.addInitScript((done) => {
    localStorage.setItem(
      'mist-isle-settings-v2',
      JSON.stringify({
        quality: 'low',
        sfx: 0,
        music: 0,
        hint: 0,
        tutorialDone: done,
      }),
    );
  }, tutorialDone);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 });
  await expect(page.locator('#boot')).toBeHidden({ timeout: 20000 });
}

async function expectOfflineMode(page, mode) {
  await expect.poll(() => page.evaluate(() => window.mistIsle.getStatus().mode), { timeout: 20000 }).toBe('match');
  await expect.poll(() => page.evaluate(() => window.mistIsle.getStatus().modeId), { timeout: 20000 }).toBe(mode);
  await expect(page.locator('#hud')).toBeVisible();
}

test('首页：一键试玩直接进入离线训练场', async ({ page }) => {
  await boot(page, true);
  const quick = page.locator('#btn-quick-training');
  await expect(quick).toBeVisible();
  await expect(quick).toContainText('立即试玩');
  await page.waitForTimeout(1100); // 等待主界面入场动效完成后记录正式截图
  await page.screenshot({ path: 'artifacts/release/home-desktop.png' });
  await page.locator('#btn-quick-training').click();
  await expectOfflineMode(page, 'training');
});

test('首次引导：默认推荐训练场，最后一步直接开战', async ({ page }) => {
  await boot(page, false);
  const guide = page.locator('#ui-onboarding');
  await expect(guide).toBeVisible();
  await page.locator('#btn-onb-next').click();
  await expect(page.locator('[data-onb-mode="training"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#btn-onb-next').click();
  await expect(page.locator('#btn-onb-next')).toHaveText('开始训练');
  await page.locator('#btn-onb-next').click();
  await expect(guide).toBeHidden();
  await expectOfflineMode(page, 'training');
});

test('首次引导：选择单人生存时按钮与实际模式一致', async ({ page }) => {
  await boot(page, false);
  await page.locator('#btn-onb-next').click();
  await page.locator('[data-onb-mode="solo"]').click();
  await page.locator('#btn-onb-next').click();
  await expect(page.locator('#btn-onb-next')).toContainText('单人生存');
  await page.locator('#btn-onb-next').click();
  await expectOfflineMode(page, 'solo');
});

test('移动端首页：试玩入口可触控、没有横向溢出', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await boot(page, true);
    const quick = page.locator('#btn-quick-training');
    await expect(quick).toBeVisible();
    const metrics = await page.evaluate(() => {
      const button = document.querySelector('#btn-quick-training').getBoundingClientRect();
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        buttonWidth: button.width,
        buttonHeight: button.height,
        buttonRight: button.right,
        buttonBottom: button.bottom,
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
    expect(metrics.buttonWidth).toBeGreaterThan(90);
    expect(metrics.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.buttonRight).toBeLessThanOrEqual(metrics.width);
    expect(metrics.buttonBottom).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'artifacts/release/home-mobile.png' });
    await quick.tap();
    await expectOfflineMode(page, 'training');
  } finally {
    await context.close();
  }
});
