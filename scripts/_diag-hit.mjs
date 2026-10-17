import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.click('#nav-play');
await page.waitForTimeout(2000);
const out = await page.evaluate(() => {
  const points = [[60,221],[41,214],[175,470],[1080,300],[100,600]];
  return points.map(([x,y]) => {
    const el = document.elementFromPoint(x,y);
    return { x, y, tag: el?.tagName, cls: (el?.className||'').toString().slice(0,60), id: el?.id||'', txt: (el?.textContent||'').trim().slice(0,18) };
  });
});
console.log(JSON.stringify(out, null, 1));
// 检查是否有覆盖层
const layers = await page.evaluate(() => [...document.querySelectorAll('#screen-root *, body > *')].map(el => {
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  if (cs.position === 'fixed' || cs.position === 'absolute' || Number(cs.zIndex) >= 5) {
    if (r.width > 500 && r.height > 200) return { tag: el.tagName, cls: (el.className||'').toString().slice(0,40), pos: cs.position, z: cs.zIndex, op: cs.opacity, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bg: cs.background.slice(0,60) };
  }
  return null;
}).filter(Boolean));
console.log(JSON.stringify(layers, null, 0));
await browser.close();
