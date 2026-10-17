import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
// 手机横屏 HUD
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'artifacts/v7-mobile-home.png' });
await page.tap('#nav-play').catch(()=>{});
await page.waitForTimeout(900);
await page.screenshot({ path: 'artifacts/v7-mobile-play.png' });
await page.tap('#btn-offline').catch(()=>{});
await page.waitForFunction(() => window.mistIsle.getStatus().mode === 'match', { timeout: 12000 }).catch(()=>{});
await page.waitForTimeout(4000);
await page.screenshot({ path: 'artifacts/v7-mobile-battle.png' });
const st = await page.evaluate(() => window.mistIsle.getStatus());
console.log('mobile battle:', JSON.stringify({ mode: st.mode, fps: st.fps, calls: st.renderCalls }));
const touch = await page.evaluate(() => {
  const ids = ['move-stick','aim-stick','heal-action','reload-action','interact-action','game-menu','minimap'];
  return ids.map(id => { const el = document.getElementById(id); if (!el) return { id, missing: true };
    const r = el.getBoundingClientRect(); return { id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 }; });
});
console.log('touch controls:', JSON.stringify(touch));
console.log('errors', errors.slice(0,4));
await browser.close();
