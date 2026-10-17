// UI 布局回归自测（owner: uiux）
// 用法：node scripts/_ui-check.mjs [baseUrl]
// 依赖服务在 8787 或传入 URL；先 `node scripts/build.mjs`。
// 输出：artifacts/ui-check.json + artifacts/ui-<view>-<screen>.png
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:8787/';
const outDir = 'artifacts';
mkdirSync(outDir, { recursive: true });

const SCREENS = ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings'];
const VIEWS = [
  { label: 'desktop', width: 1280, height: 720, mobile: false },
  { label: 'mobile', width: 844, height: 390, mobile: true },
];

// 页面内执行的通用布局度量
const measure = (screenNames) => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) };
  };
  const overlapArea = (a, b) => {
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
    return x * y;
  };
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const screens = {};
  for (const name of screenNames) {
    const root = document.querySelector(`#screen-root .screen[data-screen="${name}"]`);
    if (!root) { screens[name] = { missing: true }; continue; }
    const body = root.querySelector('.screen-body');
    const kids = body ? [...body.children].filter(visible) : [];
    const boxes = kids.map((el) => ({ cls: el.className, ...rect(el) }));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const area = overlapArea(boxes[i], boxes[j]);
        if (area > 64) overlaps.push({ a: boxes[i].cls, b: boxes[j].cls, area });
      }
    }
    // screen-main 内部两列不得重叠
    const main = root.querySelector('.screen-main');
    const mainKids = main ? [...main.children].filter(visible).map((el) => ({ cls: el.className, ...rect(el) })) : [];
    const mainOverlaps = [];
    for (let i = 0; i < mainKids.length; i++) {
      for (let j = i + 1; j < mainKids.length; j++) {
        const area = overlapArea(mainKids[i], mainKids[j]);
        if (area > 64) mainOverlaps.push({ a: mainKids[i].cls, b: mainKids[j].cls, area });
      }
    }
    // 关键按钮命中测试
    const buttons = [...root.querySelectorAll('button')].filter(visible).slice(0, 40);
    const blocked = [];
    for (const btn of buttons) {
      const r = btn.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit) continue;
      if (!(hit === btn || btn.contains(hit))) {
        blocked.push({ text: (btn.textContent || btn.id || '').trim().slice(0, 18), id: btn.id, hit: (hit.className || hit.id || hit.tagName).toString().slice(0, 40) });
      }
    }
    let minBtn = 999;
    for (const btn of buttons) {
      const r = btn.getBoundingClientRect();
      if (r.height > 2) minBtn = Math.min(minBtn, Math.round(Math.min(r.width, r.height)));
    }
    screens[name] = {
      active: root.classList.contains('active'),
      overflowX: document.documentElement.scrollWidth - innerWidth,
      bodyKids: boxes,
      overlaps,
      mainKids,
      mainOverlaps,
      blockedButtons: blocked.slice(0, 6),
      buttonCount: buttons.length,
      minButtonSize: Number.isFinite(minBtn) ? minBtn : null,
    };
  }
  return screens;
};

const browser = await chromium.launch();
const report = { base, views: [], errors: [] };

for (const view of VIEWS) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    isMobile: view.mobile,
    hasTouch: view.mobile,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(`${view.label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${view.label}: ${m.text()}`); });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);

  const shot = {};
  for (const name of SCREENS) {
    await page.evaluate((n) => {
      const btn = document.querySelector(`#nav-${n}`);
      if (btn) btn.click();
      else window.__mistUI?.openScreen?.(n);
    }, name);
    await page.waitForTimeout(220);
    await page.screenshot({ path: `${outDir}/ui-${view.label}-${name}.png` });
    const all = await page.evaluate(measure, SCREENS);
    shot[name] = all[name] || { missing: true };
  }
  // 弹窗截图
  await page.evaluate(() => window.__mistUI?.openScreen?.('home'));
  await page.evaluate(() => window.__mistUI?.showOnlineDialog?.());
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/ui-${view.label}-online.png` });
  const dialogMetrics = await page.evaluate(() => {
    const d = document.getElementById('online-dialog');
    if (!d) return { missing: true };
    const r = d.querySelector('.modal-card')?.getBoundingClientRect();
    return { open: d.classList.contains('open'), card: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null, fits: r ? r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 : false };
  });
  await page.evaluate(() => window.__mistUI?.hideOnlineDialog?.());
  await page.waitForTimeout(150);

  // HUD 检查：进训练模式
  const hud = { skipped: true };
  try {
    await page.evaluate(() => {
      const btn = document.querySelector('#btn-offline');
      if (btn) { btn.click(); return; }
      window.__mistApp?.startOffline?.('training', { mapId: 'qinglan', difficulty: 'recruit' });
    });
    await page.waitForFunction(() => !!window.mistIsle?.getState(), null, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/ui-${view.label}-hud.png` });
    hud.skipped = false;
    Object.assign(hud, await page.evaluate(() => {
      const doc = document.documentElement;
      const ids = ['health-panel', 'weapon-panel', 'squad-panel', 'minimap', 'game-menu', 'move-stick', 'aim-stick',
        'reload-action', 'heal-action', 'interact-action', 'throw-action', 'swap-action', 'sprint-action', 'crouch-action',
        'dodge-action', 'killfeed', 'phase-banner', 'alive-count', 'kill-count', 'ammo', 'reserve'];
      const missing = [];
      const boxes = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { missing.push(id); continue; }
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        boxes.push({ id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) });
      }
      const overlaps = [];
      const core = boxes.filter((b) => ['health-panel', 'weapon-panel', 'squad-panel', 'minimap'].includes(b.id));
      for (let i = 0; i < core.length; i++) {
        for (let j = i + 1; j < core.length; j++) {
          const a = core[i], b = core[j];
          const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
          const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
          if (x * y > 64) overlaps.push({ a: a.id, b: b.id, area: x * y });
        }
      }
      const offscreen = boxes.filter((b) => b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.x < -1 || b.y < -1).map((b) => b.id);
      const touch = ['move-stick', 'aim-stick', 'reload-action', 'heal-action', 'interact-action']
        .map((id) => { const el = document.getElementById(id); if (!el) return null; const r = el.getBoundingClientRect(); return { id, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 2 && r.height > 2 }; })
        .filter(Boolean);
      return {
        overflowX: doc.scrollWidth - innerWidth,
        missing,
        boxes,
        overlaps,
        offscreen,
        touch,
        hudVisible: !document.getElementById('hud')?.classList.contains('hidden'),
        touchHidden: !!document.getElementById('touch-controls')?.classList.contains('hidden'),
      };
    }));
    // 退出对局
    await page.evaluate(() => { window.__mistApp?.emit?.('hud:pause'); window.__mistApp?.leaveMatch?.(); });
    await page.waitForTimeout(400);
  } catch (err) {
    hud.error = String(err?.message || err).slice(0, 200);
  }

  report.views.push({ view: view.label, size: [view.width, view.height], screens: shot.home ? shot : {}, dialog: dialogMetrics, hud });
  await context.close();
}

await browser.close();

// ── 汇总 ──────────────────────────────────────────────────────────────
const problems = [];
for (const v of report.views) {
  for (const [name, m] of Object.entries(v.screens)) {
    if (!m || m.missing) { problems.push(`${v.view}/${name}: 屏幕缺失`); continue; }
    if (m.overflowX > 1) problems.push(`${v.view}/${name}: 横向溢出 ${m.overflowX}px`);
    if (m.overlaps?.length) problems.push(`${v.view}/${name}: screen-body 子元素重叠 ${m.overlaps.map((o) => `${o.a}×${o.b}`).join(', ')}`);
    if (m.mainOverlaps?.length) problems.push(`${v.view}/${name}: 主内容/侧栏重叠 ${m.mainOverlaps.map((o) => `${o.a}×${o.b}`).join(', ')}`);
    if (m.blockedButtons?.length) problems.push(`${v.view}/${name}: 按钮被遮挡 ${m.blockedButtons.map((b) => b.id || b.text).join(', ')}`);
    if (v.view === 'mobile' && m.minButtonSize !== null && m.minButtonSize < 32) problems.push(`${v.view}/${name}: 最小按钮 ${m.minButtonSize}px`);
    if (!m.active) problems.push(`${v.view}/${name}: 未激活`);
  }
  if (v.dialog && !v.dialog.missing && !v.dialog.fits) problems.push(`${v.view}/online-dialog: 弹窗超出视口`);
  const hud = v.hud || {};
  if (!hud.skipped) {
    if (hud.missing?.length) problems.push(`${v.view}/HUD: 缺少元素 ${hud.missing.join(', ')}`);
    if (hud.overlaps?.length) problems.push(`${v.view}/HUD: 面板重叠 ${hud.overlaps.map((o) => `${o.a}×${o.b}`).join(', ')}`);
    if (hud.offscreen?.length) problems.push(`${v.view}/HUD: 元素超出视口 ${hud.offscreen.join(', ')}`);
    if (hud.overflowX > 1) problems.push(`${v.view}/HUD: 横向溢出 ${hud.overflowX}px`);
    for (const t of hud.touch || []) {
      if (t.visible && (t.w < 44 || t.h < 44)) problems.push(`${v.view}/HUD: ${t.id} 点击区 ${t.w}×${t.h} < 44px`);
    }
  }
}

report.problems = problems;
writeFileSync(`${outDir}/ui-check.json`, JSON.stringify(report, null, 1), 'utf8');
console.log(problems.length ? `✖ ${problems.length} 个问题：\n` + problems.map((p) => '  - ' + p).join('\n') : '✔ 全部布局检查通过');
console.log(`\n截图与 JSON 输出到 ${outDir}/ui-*`);
if (report.errors.length) console.log('\n页面错误：\n  ' + [...new Set(report.errors)].slice(0, 8).join('\n  '));
process.exit(problems.length ? 1 : 0);
