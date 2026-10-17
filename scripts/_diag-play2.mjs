import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1500);
await page.click('#nav-play');
await page.waitForTimeout(3000);
await page.screenshot({ path: 'artifacts/v4-play.png' });
// 滚动到底部看完整内容
await page.evaluate(() => { const b = document.querySelector('[data-screen="play"] .screen-body'); if (b) b.scrollTop = b.scrollHeight; });
await page.waitForTimeout(600);
await page.screenshot({ path: 'artifacts/v4-play-bottom.png' });
await browser.close();
