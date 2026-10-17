import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.click('#nav-play');
await page.waitForTimeout(1200);
const out = await page.evaluate(() => {
  const card = document.querySelector('.mode-pick');
  const kids = [...card.querySelectorAll('*')].map(n => {
    const cs = getComputedStyle(n); const r = n.getBoundingClientRect();
    return { tag: n.tagName, cls: (n.className||'').toString().slice(0,40), pos: cs.position, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), txt: (n.textContent||'').trim().slice(0,24) };
  });
  return { card: { html: card.outerHTML.slice(0, 900) }, kids };
});
console.log(JSON.stringify(out, null, 1).slice(0, 3500));
await browser.close();
