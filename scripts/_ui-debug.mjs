// 临时布局诊断（不入库）：打印某屏 main 及其子元素的盒模型与计算样式。
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 20000 });
await page.waitForTimeout(300);

for (const screen of ['play', 'loadout', 'career']) {
  await page.evaluate((n) => document.querySelector(`#nav-${n}`)?.click(), screen);
  await page.waitForTimeout(120);
  const info = await page.evaluate((n) => {
    const root = document.querySelector(`#screen-root .screen[data-screen="${n}"]`);
    const pick = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        cls: el.className, tag: el.tagName,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display, position: cs.position, flex: cs.flex, height: cs.height, minHeight: cs.minHeight,
        overflow: cs.overflow, gridTemplateColumns: cs.gridTemplateColumns,
      };
    };
    return {
      body: pick(root.querySelector('.screen-body')),
      main: pick(root.querySelector('.screen-main')),
      mainKids: [...(root.querySelector('.screen-main')?.children || [])].map(pick),
      bodyKids: [...(root.querySelector('.screen-body')?.children || [])].map(pick),
    };
  }, screen);
  console.log('\n=== ' + screen + ' ===');
  console.log(JSON.stringify(info, null, 1));
}
await browser.close();
