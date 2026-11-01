// 验证各屏幕在 720p / 390p 下「关键 CTA 是否首屏可见」+ .screen-body 是否真的可滚动。
import { chromium } from 'playwright';

const VIEWS = [[1280, 720], [844, 390]];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });

for (const [w, h] of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, { timeout: 20000 });
  await page.waitForTimeout(600);
  const screens = [
    ['play', '#nav-play', '#btn-offline'],
    ['loadout', '#nav-loadout', '#nav-loadout'],
    ['store', '#nav-store', '#store-grid'],
    ['missions', '#nav-missions', '#mission-list-daily'],
    ['codex', '#nav-codex', '#nav-codex'],
    ['career', '#nav-career', '#nav-career'],
    ['settings', '#nav-settings', '#nav-settings'],
  ];
  for (const [name, nav, cta] of screens) {
    await page.evaluate(() => { const b = document.querySelector('.app-bar-back'); if (b) b.click(); });
    await page.waitForTimeout(250);
    await page.click(nav).catch(() => {});
    await page.waitForTimeout(600);
    const r = await page.evaluate((ctaSel) => {
      const body = document.querySelector('.screen.active .screen-body');
      const el = document.querySelector(ctaSel);
      const box = el ? el.getBoundingClientRect() : null;
      const bs = body ? { sh: body.scrollHeight, ch: body.clientHeight, canScroll: body.scrollHeight > body.clientHeight + 1, ovY: getComputedStyle(body).overflowY } : null;
      const ctaInView = box ? (box.top >= 0 && box.bottom <= innerHeight && box.height > 0) : null;
      return { body: bs, ctaInView, ctaBox: box ? { top: Math.round(box.top), bottom: Math.round(box.bottom) } : null };
    }, cta);
    console.log(`${w}x${h} ${name.padEnd(9)} ctaInView=${r.ctaInView} body=${JSON.stringify(r.body)} cta=${JSON.stringify(r.ctaBox)}`);
  }
  await ctx.close();
}
await browser.close();
