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
  const scr = document.querySelector('[data-screen="play"]');
  const walk = (el, path='') => out2.push({ path, tag: el.tagName, cls: (el.className||'').toString().slice(0,50), id: el.id||'', kids: el.children.length, txt: (el.childElementCount===0 ? (el.textContent||'').trim().slice(0,20) : '') });
  const out2 = [];
  const visit = (el, depth=0, path='') => {
    if (depth > 5) return;
    walk(el, path + '/' + el.tagName + (el.className ? '.' + (el.className||'').toString().split(' ')[0] : ''));
    for (const c of el.children) visit(c, depth+1, path);
  };
  visit(scr);
  return out2.filter(x => /你|等待加入|战场情报|青岚岛|赤砂/.test(x.txt) || /mode|map-row|play-main|squad/.test(x.cls));
});
console.log(JSON.stringify(out.slice(0,40), null, 0));
await browser.close();
