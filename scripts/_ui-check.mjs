// 临时自测（不入库）：打开真实服务页面，逐屏截图 + 输出布局度量。
// 用法：node scripts/_ui-check.mjs [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:8787/';
const out = 'artifacts';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const results = [];

async function run(width, height, label, isMobile = false) {
  const context = await browser.newContext({
    viewport: { width, height }, isMobile, hasTouch: isMobile,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);

  const screens = ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings'];
  for (const name of screens) {
    await page.evaluate((n) => {
      const btn = document.querySelector(`#nav-${n}`);
      if (btn) btn.click();
      else window.__mistUI?.openScreen?.(n);
    }, name);
    await page.waitForTimeout(150);
    const file = `${out}/ui-${label}-${name}.png`;
    await page.screenshot({ path: file });
    const metrics = await page.evaluate((n) => {
      const doc = document.documentElement;
      const screen = document.querySelector(`#screen-root .screen[data-screen="${n}"]`);
      const box = (sel) => {
        const el = screen?.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const body = screen?.querySelector('.screen-body');
      const style = body ? getComputedStyle(body) : null;
      return {
        overflowX: doc.scrollWidth - window.innerWidth,
        overflowY: doc.scrollHeight - window.innerHeight,
        active: screen?.classList.contains('active') ?? false,
        body: body ? { x: Math.round(body.getBoundingClientRect().x), w: Math.round(body.getBoundingClientRect().width), pad: style.padding } : null,
        hero: box('.home-hero'),
        nav: box('.home-nav'),
        player: box('.player-card'),
        head: box('.screen-head'),
        main: box('.screen-main'),
        foot: box('.home-foot'),
        minBtn: (() => {
          const btns = [...(screen?.querySelectorAll('button') || [])];
          if (!btns.length) return null;
          const sizes = btns.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
          const small = sizes.filter(([w, h]) => w < 40 || h < 40);
          return { count: btns.length, small: small.length, sample: small.slice(0, 5) };
        })(),
      };
    }, name);
    results.push({ view: label, screen: name, ...metrics });
  }
  // 弹窗
  await page.evaluate(() => window.__mistUI?.showOnlineDialog?.());
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${out}/ui-${label}-online.png` });
  await page.evaluate(() => window.__mistUI?.hideOnlineDialog?.());
  await context.close();
  return errors;
}

const e1 = await run(1280, 720, 'desktop');
const e2 = await run(844, 390, 'mobile', true);
await browser.close();
console.log(JSON.stringify({ results, errors: [...e1, ...e2].slice(0, 12) }, null, 1));
