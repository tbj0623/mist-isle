import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.click('#nav-loadout');
await page.waitForTimeout(1500);
const out = await page.evaluate(() => {
  const body = document.querySelector('[data-screen="loadout"] .screen-body');
  const walk = (el, depth=0) => {
    if (depth > 2) return [];
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const self = [{ depth, tag: el.tagName, cls: (el.className||'').toString().slice(0,44), pos: cs.position, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }];
    return self.concat(...[...el.children].map(c => walk(c, depth+1)));
  };
  return walk(body);
});
console.log(JSON.stringify(out, null, 0));
await browser.close();
