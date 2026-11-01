import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.beforeAll(() => mkdir('artifacts/release', { recursive: true }));

async function boot(page) {
  await page.addInitScript(() => {
    localStorage.setItem('mist-isle-settings-v2', JSON.stringify({
      quality: 'low', sfx: 0, music: 0, hint: 0, tutorialDone: true, combatGuideDone: true,
    }));
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 });
  await expect(page.locator('#boot')).toBeHidden({ timeout: 20000 });
}

async function startSolo(page) {
  await page.evaluate(() => window.__mistApp.startOffline('solo'));
  await expect.poll(() => page.evaluate(() => window.mistIsle.getStatus().modeId)).toBe('solo');
  await expect(page.locator('#hud')).toBeVisible();
}

test('安全区导航：局内 HUD 展示带方向距离的圈外提示', async ({ page }) => {
  await boot(page);
  await startSolo(page);
  await page.evaluate(() => {
    const m = window.__mistApp.match;
    const me = m.players.find((p) => p.id === window.__mistApp.selfId);
    // 固定战斗阶段：不让软件渲染器帧率左右空降结束时间。
    m.phase = 'live';
    me.deployStage = 'ground';
    Object.assign(m.zone, { x: 0, z: 0, r: 20, damage: 8, closing: false, nextIn: 9999 });
    me.x = 42; me.z = 0; me.hp = 100;
  });
  await expect(page.locator('#zone-status')).toContainText('圈外', { timeout: 12000 });
  await expect(page.locator('#zone-status')).toContainText('向西');
  await expect(page.locator('#zone-status')).toHaveClass(/danger/);
});

test('真实淘汰与结算：毒圈死因被记录，赛后给出可操作建议', async ({ page }) => {
  await boot(page);
  await startSolo(page);
  await page.evaluate(() => {
    const app = window.__mistApp;
    const m = app.match;
    const me = m.players.find((p) => p.id === app.selfId);
    m.kill(me, null, 'zone');
    if (m.phase !== 'ended') m.end('timeout', m.players.find((p) => p.alive)?.team);
  });
  await expect(page.locator('#result-dialog')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#result-debrief')).toContainText('安全区外持续失血');
  await expect(page.locator('#result-debrief')).toContainText('提前进圈');
  await expect(page.locator('#btn-again')).toBeVisible();
  await page.screenshot({ path: 'artifacts/release/debrief-desktop.png' });
});

test('移动横屏结算：复盘不会突破屏幕宽度，继续游戏按钮可用', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await boot(page);
    await startSolo(page);
    await page.evaluate(() => {
      const app = window.__mistApp, m = app.match;
      m.kill(m.players.find((p) => p.id === app.selfId), null, 'zone');
      if (m.phase !== 'ended') m.end('timeout', m.players.find((p) => p.alive)?.team);
    });
    await expect(page.locator('#result-debrief')).toBeVisible({ timeout: 15000 });
    const size = await page.evaluate(() => {
      const r = document.getElementById('result-debrief').getBoundingClientRect();
      return { left: r.left, right: r.right, viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(size.left).toBeGreaterThanOrEqual(0);
    expect(size.right).toBeLessThanOrEqual(size.viewport + 1);
    expect(size.scrollWidth).toBeLessThanOrEqual(size.viewport);
    await page.screenshot({ path: 'artifacts/release/debrief-mobile.png' });
  } finally {
    await context.close();
  }
});
