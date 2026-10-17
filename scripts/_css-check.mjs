// scripts/_css-check.mjs — design 专用：输出各屏幕关键元素 boundingBox 与溢出诊断
// 用法：node scripts/_css-check.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const VIEWS = [
  { name: 'desktop-1280x720', width: 1280, height: 720 },
  { name: 'phone-844x390', width: 844, height: 390 },
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
  const page = await browser.newPage({ viewport: { width: view.width, height: view.height } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  report[view.name] = {};
  for (const s of SCREENS) {
    const navId = s === 'home' ? null : `#nav-${s}`;
    if (navId) {
      await page.evaluate((id) => document.querySelector(id)?.click(), navId);
      await page.waitForTimeout(350);
    } else {
      await page.evaluate(() => document.querySelector('#screen-root .screen[data-screen="home"]')?.classList.add('active'));
      await page.waitForTimeout(200);
    }
    const out = await page.evaluate((sels) => {
      const vw = innerWidth;
      const vh = innerHeight;
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const active = document.querySelector('#screen-root .screen.active');
      const res = { vw, vh, screen: active?.dataset.screen, items: {}, overflowX: [], overflowY: [] };
      if (!active) return res;
      for (const sel of sels) {
        const el = active.querySelector(sel);
        if (!el) continue;
        res.items[sel] = box(el);
      }
      // 溢出：子元素右边界超出视口 / 高度超出
      for (const el of active.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cls = (typeof el.className === 'string' ? el.className : '').split(' ')[0];
        if (r.right > vw + 1) res.overflowX.push(`${cls} right=${Math.round(r.right)}`);
        if (r.bottom > vh + 1 && !active.querySelector('.screen-body')?.contains(el.parentElement)) {
          res.overflowY.push(`${cls} bottom=${Math.round(r.bottom)}`);
        }
      }
      res.overflowX = [...new Set(res.overflowX)].slice(0, 8);
      res.overflowY = [...new Set(res.overflowY)].slice(0, 8);
      const body = active.querySelector('.screen-body');
      if (body) {
        res.bodyScroll = { scrollH: body.scrollHeight, clientH: body.clientHeight, scrollable: body.scrollHeight > body.clientHeight + 1 };
      }
      return res;
    }, SEL);
    report[view.name][s] = out;
  }
  await page.close();
}

// HUD 检查
for (const view of VIEWS) {
  const page = await browser.newPage({ viewport: { width: view.width, height: view.height } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('#nav-play')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#btn-offline')?.click());
  await page.waitForFunction(() => window.mistIsle?.getStatus?.().mode === 'match', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3500);
  report[view.name].hud = await page.evaluate(() => {
    const ids = ['#hud', '#health-panel', '#weapon-panel', '#squad-panel', '#minimap', '#killfeed', '#zone-status', '#game-menu', '#action-buttons', '#move-stick', '#aim-stick', '#touch-controls'];
    const out = { vw: innerWidth, vh: innerHeight, boxes: {}, overlaps: [] };
    const list = [];
    for (const id of ids) {
      const el = document.querySelector(id);
      if (!el) { out.boxes[id] = 'MISSING'; continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const hidden = cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0;
      out.boxes[id] = hidden ? 'HIDDEN' : { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      if (!hidden) list.push({ id, r });
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.id === '#hud' || b.id === '#hud' || a.id === '#touch-controls' || b.id === '#touch-controls') continue;
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 4 && oy > 4) out.overlaps.push(`${a.id} × ${b.id} (${Math.round(ox)}×${Math.round(oy)})`);
      }
    }
    return out;
  });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 1));
