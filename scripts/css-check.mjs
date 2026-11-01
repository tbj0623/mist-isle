// scripts/css-check.mjs — 设计回归：输出各屏幕元素 boundingBox、横向溢出与 HUD 重叠
// 用法：node scripts/css-check.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const VIEWS = [
  { name: 'desktop-1280x720', width: 1280, height: 720, touch: false },
  { name: 'phone-844x390', width: 844, height: 390, touch: true },
  { name: 'phone-640x360', width: 640, height: 360, touch: true },
];
const SCREENS = ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings'];
const SEL = [
  '.screen-body', '.home-hero', '.home-nav', '.player-card', '.home-foot',
  '.app-bar', '.screen-head', '.screen-main', '.mode-grid', '.map-row',
  '.play-actions', '.play-side', '.store-grid', '.codex-grid', '.mission-list',
  '.career-head', '.stat-grid', '.ach-grid', '.settings-columns',
];

const browser = await chromium.launch();
const report = {};

for (const view of VIEWS) {
  const ctx = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    hasTouch: view.touch,
    isMobile: view.touch,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  report[view.name] = {};

  for (const s of SCREENS) {
    if (s !== 'home') {
      await page.evaluate((name) => document.querySelector(`#nav-${name}`)?.click(), s);
      await page.waitForTimeout(350);
    }
    report[view.name][s] = await page.evaluate((sels) => {
      const vw = innerWidth;
      const active = document.querySelector('#screen-root .screen.active');
      const res = { screen: active?.dataset.screen, items: {}, overflowX: [] };
      if (!active) return res;
      const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      for (const sel of sels) {
        const el = active.querySelector(sel);
        if (el) res.items[sel] = round(el.getBoundingClientRect());
      }
      for (const el of active.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.right > vw + 1 || r.left < -1) {
          const cls = (typeof el.className === 'string' ? el.className : '').split(' ')[0] || el.tagName.toLowerCase();
          res.overflowX.push(`${cls}[${Math.round(r.left)}..${Math.round(r.right)}]`);
        }
      }
      res.overflowX = [...new Set(res.overflowX)].slice(0, 8);
      const body = active.querySelector('.screen-body');
      if (body) res.bodyScroll = { scrollH: body.scrollHeight, clientH: body.clientHeight };
      return res;
    }, SEL);
  }

  // HUD：进一场离线对局后测量
  await page.evaluate(() => document.querySelector('#nav-play')?.click());
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('#btn-offline')?.click());
  await page.waitForFunction(() => window.mistIsle?.getStatus?.().mode === 'match', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  report[view.name].hud = await page.evaluate(() => {
    const ids = ['#health-panel', '#weapon-panel', '#squad-panel', '#minimap', '#killfeed',
      '#zone-status', '#game-menu', '#action-buttons', '#move-stick', '#aim-stick'];
    const out = { boxes: {}, overlaps: [] };
    const live = [];
    for (const id of ids) {
      const el = document.querySelector(id);
      if (!el) { out.boxes[id] = 'MISSING'; continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0) { out.boxes[id] = 'HIDDEN'; continue; }
      out.boxes[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      live.push({ id, r });
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (a.id === '#minimap' || b.id === '#minimap') continue; // 小地图容器内含 canvas
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 4 && oy > 4) out.overlaps.push(`${a.id} × ${b.id} (${Math.round(ox)}×${Math.round(oy)})`);
      }
    }
    return out;
  });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 1));
