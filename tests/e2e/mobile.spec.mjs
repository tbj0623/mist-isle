// MIST ISLE 1.0 · 移动端（844×390 横屏触控）E2E
// 触屏层 #touch-controls 仅在 (pointer: coarse) 或 app.touch=true 时显示，因此必须用真实触摸上下文。
import { test, expect } from '@playwright/test';
import { VERSION } from '../../shared/rules.mjs';
import { mkdir } from 'node:fs/promises';

const SHOTS = 'artifacts/e2e';
const MOBILE = { width: 844, height: 390 };

test.beforeAll(async () => { await mkdir(SHOTS, { recursive: true }); });

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return errors;
}

const status = (page) => page.evaluate(() => window.mistIsle.getStatus());
const meOf = (page) => page.evaluate(() => {
  const state = window.mistIsle.getState();
  const info = window.mistIsle.getStatus();
  return state?.players?.find((p) => p.id === info.selfId) || null;
});

async function mobileContext(browser) {
  const context = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('mist-isle-settings-v2', JSON.stringify({ quality: 'low', music: false, sound: false, tutorialDone: true, hint: 0 })));
  return context;
}

async function boot(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const node = document.getElementById('boot');
    return !node || node.classList.contains('hidden');
  }, null, { timeout: 15000 });
}

/** 触摸摇杆：按住中心后向上拖动（负 y = 前进）。 */
async function dragStick(context, page, selector, dy, holdMs = 1100) {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} 不可见`).not.toBeNull();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy, id: 1, radiusX: 5, radiusY: 5, force: 1 }] });
  await page.waitForTimeout(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return { x, y, w: box.width, h: box.height };
}

test('mobile · 首页无横向溢出，出击 → 训练场开局，HUD 触控层完整', async ({ browser }) => {
  // 这条用例串了「首屏 → 开局 → HUD 断言 → 拖摇杆 → 暂停 → 返回」整条链路，
  // 默认 90s 在 CI/满载机器上会踩线（拖摇杆本身要 1.2s，还有 3 个 poll 与 4 张截图）。
  test.setTimeout(180000);
  const context = await mobileContext(browser);
  const page = await context.newPage();
  const errors = watch(page);
  try {
    await page.setViewportSize(MOBILE);
    await boot(page);

    // 无横向溢出
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    expect(await page.locator('#screen-root')).toHaveAttribute('data-active', 'home');
    await page.screenshot({ path: `${SHOTS}/mobile-01-home.png` });

    await page.locator('#nav-play').tap();
    await expect(page.locator('#screen-root')).toHaveAttribute('data-active', 'play');
    await page.locator('#mode-training').tap();
    await page.locator('#btn-offline').tap();
    await expect.poll(async () => (await status(page)).mode, { timeout: 20000 }).toBe('match');
    // 开局要经过 loading → deploying(2.5s) → live；满载机器上留足余量
    await expect.poll(async () => (await status(page)).phase, { timeout: 60000 }).toMatch(/live|playing/);
    await page.waitForTimeout(1500);

    // HUD 可见：摇杆 / 开火（瞄准摇杆） / 生命 / 小地图
    await expect(page.locator('#hud')).toBeVisible();
    await expect(page.locator('#touch-controls')).toBeVisible();
    for (const id of ['move-stick', 'aim-stick', 'health-panel', 'minimap']) {
      await expect(page.locator(`#${id}`), `HUD ${id} 不可见`).toBeVisible();
    }
    const hudBoxes = await page.evaluate(() => {
      const box = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return { move: box('move-stick'), aim: box('aim-stick'), health: box('health-panel'), minimap: box('minimap'), actions: box('action-buttons') };
    });
    for (const [key, rect] of Object.entries(hudBoxes)) {
      expect(rect, `${key} 缺失`).not.toBeNull();
      expect(rect.w, `${key} 宽度`).toBeGreaterThan(20);
      expect(rect.h, `${key} 高度`).toBeGreaterThan(10);
    }
    // 左摇杆在左下、右摇杆在右下（横屏布局）
    expect(hudBoxes.move.x).toBeLessThan(MOBILE.width / 2);
    expect(hudBoxes.aim.x).toBeGreaterThan(MOBILE.width / 2);
    expect(hudBoxes.move.y).toBeGreaterThan(MOBILE.height / 2);

    // 画布非纯色
    const len = await page.evaluate(() => document.getElementById('world').toDataURL('image/png').length);
    expect(len).toBeGreaterThan(10000);

    // 触屏移动：拖左摇杆 → 坐标变化
    const before = await meOf(page);
    await dragStick(context, page, '#move-stick', -30, 1200);
    await page.waitForTimeout(250);
    const after = await meOf(page);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    expect(moved, `摇杆移动距离 ${moved.toFixed(2)}m`).toBeGreaterThan(1.5);

    await page.screenshot({ path: `${SHOTS}/mobile-02-battle.png` });

    // 触屏暂停 + 返回菜单。
    // 这里必须用真实 tap（不加 force）：它正是「#touch-controls 全屏透明层是否
    // 吞掉 HUD 点击」的回归守卫 —— 一旦有人再给触控容器加 pointer-events:auto，
    // 这一步会因为「touch-controls intercepts pointer events」而失败。
    await page.locator('#game-menu').tap();
    await expect(page.locator('#pause-dialog')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/mobile-03-pause.png` });
    await page.locator('#btn-exit-match').tap();
    await expect(page.locator('#screen-root')).toHaveAttribute('data-active', 'home');
    await expect.poll(async () => (await status(page)).hudVisible).toBe(false);
    await page.screenshot({ path: `${SHOTS}/mobile-04-home-back.png` });

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await context.close();
  }
});

test('mobile · 竖屏 390×844 显示横屏提示，内容层被隐藏', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('mist-isle-settings-v2', JSON.stringify({ quality: 'low', sound: false, tutorialDone: true })));
  const page = await context.newPage();
  const errors = watch(page);
  try {
    await boot(page);
    expect(await page.locator('#screen-root')).toHaveAttribute('data-active', 'home');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => matchMedia('(orientation: portrait)').matches)).toBe(true);

    // 竖屏：横屏提示遮罩可见，内容层 visibility:hidden（CSS 设计行为，不是缺陷）
    await expect(page.locator('#rotate-hint')).toBeVisible();
    const layer = await page.evaluate(() => ({
      screenRoot: getComputedStyle(document.getElementById('screen-root')).visibility,
      dialogRoot: getComputedStyle(document.getElementById('dialog-root')).visibility,
      rotate: getComputedStyle(document.getElementById('rotate-hint')).display,
      zIndex: getComputedStyle(document.getElementById('rotate-hint')).zIndex,
    }));
    expect(layer.rotate).toBe('flex');
    expect(layer.screenRoot).toBe('hidden');
    expect(layer.dialogRoot).toBe('hidden');
    expect(Number(layer.zIndex)).toBeGreaterThan(0);

    // 竖屏下 3D 画布仍在渲染（不阻塞后续横屏游玩）
    const status = await page.evaluate(() => window.mistIsle.getStatus());
  expect(status.version).toBe(VERSION);
    expect(status.mode).toBe('home');
    await page.screenshot({ path: `${SHOTS}/mobile-05-portrait-hint.png` });

    // 提示遮罩拦截点击：竖屏不能误触到被隐藏的主菜单
    const intercepted = await page.locator('#nav-settings').tap({ timeout: 2000 }).then(() => false).catch(() => true);
    expect(intercepted, '竖屏遮罩未拦截主菜单点击').toBe(true);
    expect(await page.locator('#screen-root')).toHaveAttribute('data-active', 'home');

    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await context.close();
  }
});

test('mobile · 竖屏 → 横屏旋转后主菜单恢复可交互', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('mist-isle-settings-v2', JSON.stringify({ quality: 'low', sound: false, tutorialDone: true })));
  const page = await context.newPage();
  const errors = watch(page);
  try {
    await boot(page);
    await expect(page.locator('#rotate-hint')).toBeVisible();
    await page.setViewportSize(MOBILE);
    await expect(page.locator('#rotate-hint')).toBeHidden();
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('screen-root')).visibility)).toBe('visible');
    await page.locator('#nav-settings').tap();
    await expect(page.locator('#screen-root')).toHaveAttribute('data-active', 'settings');
    await expect(page.locator('#quality')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/mobile-06-rotated-settings.png` });
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await context.close();
  }
});
