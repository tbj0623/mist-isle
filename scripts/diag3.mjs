import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1500);
const dom = await page.evaluate(() => {
  const root = document.getElementById('screen-root');
  return [...root.children].map(c => ({ tag: c.tagName, cls: c.className, data: c.dataset.screen || null, id: c.id || null, w: c.offsetWidth, h: c.offsetHeight }));
});
console.log('screen-root children:', JSON.stringify(dom, null, 1));
const homeLayout = await page.evaluate(() => {
  const h = document.querySelector('[data-screen="home"]');
  if (!h) return null;
  const kids = [...h.querySelectorAll('*')].slice(0, 40).map(n => {
    const r = n.getBoundingClientRect();
    return { tag: n.tagName, id: n.id || '', cls: (n.className || '').toString().slice(0, 46), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return kids;
});
console.log(JSON.stringify(homeLayout, null, 0).slice(0, 3000));
await browser.close();
