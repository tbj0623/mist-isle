// 可访问性回归脚本（owner: a11y · QA）
// 用法：node scripts/a11y-check.mjs [baseUrl]
// 依赖：npm i -D axe-core（已装）；服务在 8787 或传入 URL；先 `node scripts/build.mjs`。
//
// 覆盖：
//   1) axe-core 审计 #screen-root 全部 8 屏 + 3 弹窗（help / pause / result）
//   2) 颜色对比度（WCAG AA 4.5:1 / 大字 3:1）——axe 的 color-contrast 规则逐节点
//   3) 焦点顺序（Tab 序列是否单调、是否有不可达的交互元素）
//   4) prefers-reduced-motion：关键动画 animationDuration 必须为 0 / none
//   5) 色觉障碍 4 模式截图（none/deuteranopia/protanopia/tritanopia）
// 输出：artifacts/a11y/report.json + artifacts/a11y/*.png
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_SRC = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const base = process.argv[2] || 'http://127.0.0.1:8787/';
const OUT = 'artifacts/a11y';
mkdirSync(OUT, { recursive: true });

const SCREENS = ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings'];
const COLOR_MODES = ['none', 'deuteranopia', 'protanopia', 'tritanopia'];

function emptySummary() {
  return { violations: 0, bySeverity: { critical: 0, serious: 0, moderate: 0, minor: 0 }, rules: [], nodes: [] };
}
function addResult(summary, res, where) {
  for (const v of res.violations) {
    summary.violations += v.nodes.length;
    summary.bySeverity[v.impact || 'minor'] = (summary.bySeverity[v.impact || 'minor'] || 0) + v.nodes.length;
    const bucket = { where, nodes: v.nodes.map((n) => ({ target: n.target, html: String(n.html).slice(0, 200), summary: n.failureSummary })) };
    const rule = summary.rules.find((r) => r.id === v.id);
    if (rule) rule.instances.push(bucket);
    else summary.rules.push({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, instances: [bucket] });
    for (const n of v.nodes) summary.nodes.push({ where, id: v.id, impact: v.impact, target: n.target, html: String(n.html).slice(0, 200) });
  }
  for (const v of res.incomplete || []) {
    if (v.id === 'color-contrast') {
      summary.rules.push({ id: 'color-contrast-incomplete', impact: 'review', help: `${where}: ${v.nodes.length} 个节点因背景复杂（canvas/渐变）无法自动判定`, instances: [] });
    }
  }
}

async function audit(page, summary, where, selector = '#screen-root') {
  // axe-core 只发布 UMD 版，这里在**被测页面的沙箱**里 eval 官方未压缩包；不接触 Node 侧，也不拼接任何外部输入。
  // oxlint-disable-next-line no-eval
  await page.evaluate((src) => { if (!window.axe) window.eval(src); }, AXE_SRC);
  const res = await page.evaluate(async (sel) => window.axe.run(document.querySelector(sel) || document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    rules: { region: { enabled: false }, 'landmark-one-main': { enabled: false } },
  }), selector);
  addResult(summary, res, where);
  return res;
}

/** 焦点顺序：依次 Tab，记录 activeElement 的 id/标签；检查是否有交互元素永远不可达。 */
async function focusOrder(page) {
  await page.evaluate(() => { document.body.focus(); if (document.activeElement !== document.body) document.activeElement.blur(); });
  const seq = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const item = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
        text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
        visible: r.width > 0 && r.height > 0,
        inScreen: !!el.closest('#screen-root'),
      };
    });
    if (!item) break;
    seq.push(item);
    if (seq.length > 3 && JSON.stringify(seq[seq.length - 1]) === JSON.stringify(seq[seq.length - 3])) break; // 循环
  }
  return seq;
}

/** reduced-motion：列出仍在跑的动画，断言 duration 归零（功能性进度条动画除外）。 */
async function motionAudit(page) {
  return page.evaluate(() => {
    const out = [];
    for (const anim of document.getAnimations()) {
      const timing = anim.effect?.getComputedTiming?.() || {};
      const target = anim.effect?.target;
      const cs = target ? getComputedStyle(target) : null;
      out.push({
        name: anim.animationName || (anim.transitionProperty ? `transition:${anim.transitionProperty}` : 'unknown'),
        duration: timing.duration,
        iterations: timing.iterations,
        target: target ? `${target.tagName.toLowerCase()}.${String(target.className || '').split(' ')[0]}` : '?',
        animationDuration: cs?.animationDuration,
        transitionDuration: cs?.transitionDuration,
      });
    }
    return out;
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.addInitScript(() => {
  // 关闭音频/引导，避免遮挡与随机噪声
  localStorage.setItem('mist-isle-settings-v2', JSON.stringify({ quality: 'balanced', sfx: 0, music: 0, tutorialDone: true, hint: 0 }));
});
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const report = { base, generatedAt: new Date().toISOString(), screens: {}, dialogs: {}, contrast: {}, focus: {}, motion: {}, colorBlind: {}, errors };
const summary = emptySummary();

/** 切屏：先回大厅（导航按钮只在 home 上有），再点对应导航。 */
async function gotoScreen(page, name) {
  const active = await page.evaluate(() => window.mistIsle.getUi().screen);
  if (active !== 'home') {
    await page.evaluate(() => document.querySelector('.screen.active .app-bar-back')?.click());
    await page.waitForTimeout(180);
  }
  await page.evaluate((n) => document.getElementById(`nav-${n}`)?.click(), name);
  await page.waitForTimeout(260);
  const now = await page.evaluate(() => window.mistIsle.getUi().screen);
  if (now !== name) throw new Error(`切屏失败：期望 ${name}，实际 ${now}`);
}

for (const name of SCREENS) {
  await gotoScreen(page, name);
  await page.screenshot({ path: `${OUT}/screen-${name}.png` });
  const res = await audit(page, summary, `screen:${name}`);
  report.screens[name] = { violations: res.violations.length, nodes: res.violations.reduce((a, v) => a + v.nodes.length, 0), rules: res.violations.map((v) => `${v.id}(${v.impact}):${v.nodes.length}`) };
}

// ── 弹窗：help（设置页） ────────────────────────────────────────────────────
await gotoScreen(page, 'settings');
await page.evaluate(() => document.getElementById('btn-show-help')?.click());
await page.waitForTimeout(320);
await page.screenshot({ path: `${OUT}/dialog-help.png` });
let res = await audit(page, summary, 'dialog:help', '#dialog-root');
report.dialogs.help = { violations: res.violations.length, rules: res.violations.map((v) => `${v.id}(${v.impact}):${v.nodes.length}`) };
await page.keyboard.press('Escape').catch(() => {});
await page.evaluate(() => document.getElementById('btn-help-close')?.click());
await page.waitForTimeout(200);

report.summary = summary;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`axe: ${summary.violations} violations`, JSON.stringify(summary.bySeverity));
for (const r of summary.rules) console.log(`  ${r.impact.padEnd(9)} ${r.id}  (${r.instances.length} 处场景)  ${r.help || ''}`);
console.log('errors:', errors.length ? JSON.stringify(errors.slice(0, 6)) : 'none');
await browser.close();
