import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.click('#nav-play');
await page.waitForTimeout(1600);
const out = await page.evaluate(() => {
  const n = document.querySelector('.mode-name');
  const card = document.querySelector('.mode-pick');
  const cs = getComputedStyle(n), cc = getComputedStyle(card);
  const scrim = document.querySelector('[data-screen="play"] .screen-scrim');
  const cs2 = scrim ? getComputedStyle(scrim) : null;
  return {
    nameColor: cs.color, nameOpacity: cs.opacity, nameFilter: cs.filter, nameVis: cs.visibility,
    cardOpacity: cc.opacity, cardFilter: cc.filter, cardAnim: cc.animationName,
    scrimBg: cs2 ? cs2.background.slice(0, 200) : 'none',
    scrimZ: cs2 ? cs2.zIndex : 'n/a',
    scrimOp: cs2 ? cs2.opacity : 'n/a',
    bodyZ: getComputedStyle(document.querySelector('[data-screen="play"] .screen-body')).zIndex,
    scrimBlend: cs2 ? cs2.mixBlendMode : 'n/a',
    scrimBackdrop: cs2 ? cs2.backdropFilter : 'n/a',
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
