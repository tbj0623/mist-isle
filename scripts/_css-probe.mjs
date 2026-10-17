// scripts/_css-probe.mjs — 定位单个屏内某组件的实际盒子与关键计算样式
// 用法：node scripts/_css-probe.mjs <url> <screen> <selector>
import { chromium } from 'playwright';

const [url = 'http://127.0.0.1:8787/', screen = 'play', selector = '.mode-pick'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1200);
if (screen !== 'home') {
  await page.evaluate((s) => document.querySelector(`#nav-${s}`)?.click(), screen);
  await page.waitForTimeout(500);
}
const out = await page.evaluate((sel) => {
  const el = document.querySelector(`#screen-root .screen.active ${sel}`);
  if (!el) return { error: `not found: ${sel}` };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const kids = [...el.children].map((c) => {
    const cr = c.getBoundingClientRect();
    const ccs = getComputedStyle(c);
    return {
      tag: c.tagName.toLowerCase(),
      cls: c.className,
      box: [Math.round(cr.x), Math.round(cr.y), Math.round(cr.width), Math.round(cr.height)],
      display: ccs.display,
      gridArea: ccs.gridArea,
      flex: ccs.flex,
      fontSize: ccs.fontSize,
      whiteSpace: ccs.whiteSpace,
      writingMode: ccs.writingMode,
    };
  });
  return {
    cls: el.className,
    box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    display: cs.display,
    gridTemplateColumns: cs.gridTemplateColumns,
    gridTemplateRows: cs.gridTemplateRows,
    flexDirection: cs.flexDirection,
    gap: cs.gap,
    kids,
  };
}, selector);
await browser.close();
console.log(JSON.stringify(out, null, 1));
