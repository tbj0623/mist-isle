import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.click('#nav-play');
await page.waitForTimeout(1500);
const out = await page.evaluate(() => {
  const scr = document.querySelector('[data-screen="play"]');
  const res = { screenOpacity: getComputedStyle(scr).opacity, screenTransform: getComputedStyle(scr).transform, anim: getComputedStyle(scr).animationName };
  const walk = (el, depth=0) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (depth <= 3) res[`d${depth}:${el.tagName}.${(el.className||'').toString().split(' ').slice(0,2).join('.')}`] = {
      pos: cs.position, z: cs.zIndex, op: cs.opacity, disp: cs.display, of: cs.overflow,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    };
    for (const c of el.children) walk(c, depth+1);
  };
  walk(scr);
  return res;
});
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
await browser.close();
