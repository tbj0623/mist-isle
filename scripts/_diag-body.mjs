import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.click('#nav-play');
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const body = document.querySelector('[data-screen="play"] .screen-body');
  return [...body.children].map(c => { const cs = getComputedStyle(c), r = c.getBoundingClientRect();
    return { tag: c.tagName, cls: (c.className||'').toString(), pos: cs.position, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
