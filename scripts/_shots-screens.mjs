import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=d3d11','--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:8787/', { waitUntil:'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1200);
const screens = ['loadout','store','missions','codex','career','settings'];
for (const s of screens) {
  await page.click(`#nav-${s}`).catch(()=>{});
  await page.waitForTimeout(900);
  await page.screenshot({ path: `artifacts/v5-${s}.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log(s, 'overflow', overflow);
  await page.click('#app-bar-back, .app-bar-back').catch(async () => { await page.evaluate(() => { const b = document.querySelector('.app-bar-back'); if (b) b.click(); }); });
  await page.waitForTimeout(400);
}
console.log('errors', errors.slice(0,5));
await browser.close();
