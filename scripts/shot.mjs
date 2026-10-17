// 截图/冒烟脚本：自己启动 Chromium，不依赖共享浏览器会话。
// 用法：node scripts/shot.mjs [url] [outPrefix]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const prefix = process.argv[3] || 'artifacts/shot';
await mkdir('artifacts', { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text());
});
await page.addInitScript(() => {
  try {
    localStorage.setItem('mist-isle-settings-v2', JSON.stringify({ quality: 'balanced', sfx: 0, music: 0 }));
    localStorage.setItem('mist-isle-save-v1', JSON.stringify({ settings: { music: 0.3, sfx: 0.7 } }));
  } catch { /* 忽略 */ }
});

await page.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
} catch {
  console.log('!! window.mistIsle missing');
}
await page.waitForTimeout(2500);
await page.screenshot({ path: `${prefix}-home.png` });
console.log('status:', JSON.stringify(await page.evaluate(() => window.mistIsle?.getStatus?.() || null)));
console.log('screens:', await page.evaluate(() => [...document.querySelectorAll('#screen-root [data-screen]')].map((n) => `${n.dataset.screen}${n.classList.contains('active') ? '*' : ''}`).join(',')));

// 进入出击页
try {
  await page.click('#nav-play', { timeout: 4000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${prefix}-play.png` });
  console.log('play-screen ok');
} catch (e) { console.log('!! nav-play:', e.message); }

// 开始离线对局
try {
  await page.click('#btn-offline', { timeout: 4000 });
  await page.waitForFunction(() => window.mistIsle.getStatus().mode === 'match', { timeout: 12000 });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${prefix}-battle.png` });
  const st = await page.evaluate(() => window.mistIsle.getStatus());
  const state = await page.evaluate(() => {
    const s = window.mistIsle.getState();
    return s ? { phase: s.phase, alive: s.counts.alive, players: s.players.length, loot: s.loot.length, cars: s.cars.length, me: !!s.me, map: s.mapId } : null;
  });
  console.log('battle status:', JSON.stringify(st));
  console.log('battle state:', JSON.stringify(state));
} catch (e) { console.log('!! offline match:', e.message); }

console.log('errors:', errors.length ? JSON.stringify(errors.slice(0, 8), null, 1) : 'none');
await browser.close();
