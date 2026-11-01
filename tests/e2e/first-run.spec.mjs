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


test('训练场局内教学：显示目标、允许跳过并记住选择', async ({ page }) => {
  await boot(page, true);
  await page.locator('#btn-quick-training').click();
  await expectOfflineMode(page, 'training');
  const guide = page.locator('#combat-guide');
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('移动 5 米');
  await expect(guide).toContainText('0 / 5');
  await page.locator('#combat-guide-skip').click();
  await expect(guide).toBeHidden();
  const saved = await page.evaluate(() => ({
    runtime: window.__mistApp.settings.combatGuideDone,
    storage: JSON.parse(localStorage.getItem('mist-isle-settings-v2')).combatGuideDone,
  }));
  expect(saved).toEqual({ runtime: true, storage: true });
  await page.evaluate(() => window.__mistApp.startOffline('training'));
  await expectOfflineMode(page, 'training');
  await expect(guide).toBeHidden();
});

test('非训练模式：不会显示实战教学卡片', async ({ page }) => {
  await boot(page, true);
  await page.evaluate(() => window.__mistApp.startOffline('solo'));
  await expectOfflineMode(page, 'solo');
  await expect(page.locator('#combat-guide')).toBeHidden();
});


test('横屏触控训练：教学卡片不遮挡摇杆，跳过按钮有足够触控面积', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await boot(page, true);
    await page.locator('#btn-quick-training').tap();
    await expectOfflineMode(page, 'training');
    await expect(page.locator('#combat-guide')).toBeVisible();
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const guide = rect('#combat-guide');
      const skip = rect('#combat-guide-skip');
      const move = rect('#move-stick');
      const aim = rect('#aim-stick');
      const intersects = (a, b) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
      return {
        guide, skip,
        hitsMove: intersects(guide, move),
        hitsAim: intersects(guide, aim),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(layout.guide.bottom).toBeLessThan(195);
    expect(layout.hitsMove).toBe(false);
    expect(layout.hitsAim).toBe(false);
    expect(layout.scrollWidth).toBeLessThanOrEqual(844);
    expect(layout.skip.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: 'artifacts/release/combat-guide-mobile.png' });
    await page.locator('#combat-guide-skip').tap();
    await expect(page.locator('#combat-guide')).toBeHidden();
  } finally {
    await context.close();
  }
});
