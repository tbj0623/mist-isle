// scripts/css-shots.mjs — 设计截图：1280×720 / 844×390 / 640×360 × 8 屏 + 弹窗 + 局内
// 用法：node scripts/css-shots.mjs [url] [outDir]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const outDir = process.argv[3] || 'artifacts/css-final';
await mkdir(outDir, { recursive: true });

const VIEWS = [
  { name: '1280x720', width: 1280, height: 720, touch: false },
  { name: '844x390', width: 844, height: 390, touch: true },
  { name: '640x360', width: 640, height: 360, touch: true },
];
const SCREENS = ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings'];

const browser = await chromium.launch();
const errors = [];

for (const view of VIEWS) {
  const ctx = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    hasTouch: view.touch,
    isMobile: view.touch,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${view.name} PAGEERROR ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${view.name} CONSOLE ${m.text()}`); });
  await page.addInitScript(() => {
    try { localStorage.setItem('mist-isle-settings-v2', JSON.stringify({ quality: 'low', sfx: 0, music: 0 })); } catch { /* noop */ }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1800);

  for (const s of SCREENS) {
    if (s !== 'home') {
      await page.evaluate((name) => document.querySelector(`#nav-${name}`)?.click(), s);
      await page.waitForTimeout(450);
    }
    await page.screenshot({ path: `${outDir}/${view.name}-${s}.png` });
  }

  await page.evaluate(() => document.querySelector('#nav-play')?.click());
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('#btn-online')?.click());
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/${view.name}-dialog-online.png` });
  await page.evaluate(() => {
    const d = document.querySelector('#online-dialog');
    if (d) { d.classList.remove('open'); d.removeAttribute('open'); }
  });

  await page.evaluate(() => document.querySelector('#btn-offline')?.click());
  await page.waitForFunction(() => window.mistIsle?.getStatus?.().mode === 'match', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${outDir}/${view.name}-battle.png` });

  await ctx.close();
}

await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.slice(0, 10).join('\n')}` : 'no console errors');
