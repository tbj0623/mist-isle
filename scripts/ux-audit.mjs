// UX 审计取证脚本（owner: uiux）
// 用法：node scripts/ux-audit.mjs [after|post] [baseUrl]
// 产出：artifacts/ux-audit/<prefix>-<w>x<h>-<screen|dialog>.png + metrics-<prefix>.json
// 采集：滚动溢出、横向溢出、首个可交互元素位置、触控目标尺寸分布、文本截断、
//       字号层级数、主 CTA 是否首屏、文本对比度（近似：向上找不透明背景色混合）。
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PREFIX = (process.argv[2] || 'after').replace(/[^a-z]/gi, '') || 'after';
const BASE = process.argv[3] || 'http://127.0.0.1:8787/';
const OUT = 'artifacts/ux-audit';
mkdirSync(OUT, { recursive: true });

const VIEWS = [
  { w: 1280, h: 720, mobile: false },
  { w: 844, h: 390, mobile: true },
  { w: 1920, h: 1080, mobile: false },
];
const SCREENS = ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings'];

// ── 页面内度量（序列化后注入浏览器执行） ───────────────────────────────────
function collect(sel) {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return { missing: true };
  const r2 = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) };
  };
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > -80 && r.top < innerHeight + 80;
  };
  const out = { selector: sel };
  const docEl = document.documentElement;
  out.overflowX = docEl.scrollWidth - innerWidth;
  const scroller = root.querySelector('.screen-body, .modal-body');
  out.scroller = scroller ? {
    cls: scroller.className,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    hiddenPx: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    overflowY: getComputedStyle(scroller).overflowY,
  } : null;
  out.doc = { scrollHeight: docEl.scrollHeight, clientHeight: docEl.clientHeight };
  if (root.classList?.contains('modal-card')) {
    const r = root.getBoundingClientRect();
    out.card = { ...r2(root), fits: r.top >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 };
  }

  const iSel = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  const ints = [...root.querySelectorAll(iSel)].filter(isVis);
  // 有效命中区：视觉尺寸 <44 时，实测四向 ±22px 是否仍落到该元素（允许透明伪元素扩展）
  const hitOk = (el, dx, dy) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2 + dx);
    const y = Math.round(r.y + r.height / 2 + dy);
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || el.contains(hit.parentElement));
  };
  const sizes = ints.map((el) => {
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 26);
    const visual = Math.round(Math.min(r.width, r.height));
    let effective = visual;
    if (visual < 44 && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA'
        && hitOk(el, -21, 0) && hitOk(el, 21, 0) && hitOk(el, 0, -21) && hitOk(el, 0, 21)) effective = 44;
    return { id: el.id || '', tag: el.tagName.toLowerCase(), label, w: Math.round(r.width), h: Math.round(r.height), min: effective, visual, top: Math.round(r.top) };
  });
  out.interactive = {
    count: sizes.length,
    under44: sizes.filter((s) => s.min < 44).length,
    under32: sizes.filter((s) => s.min < 32).length,
    min: sizes.length ? Math.min(...sizes.map((s) => s.min)) : null,
  };
  out.smallTargets = sizes.filter((s) => s.min < 44).sort((a, b) => a.min - b.min).slice(0, 10);
  const first = sizes.slice().sort((a, b) => a.top - b.top)[0];
  out.firstInteractive = first ? { ...first, inViewport: first.top >= 0 && first.top + first.h <= innerHeight } : null;

  const prims = [...root.querySelectorAll('.btn-primary')].filter(isVis);
  out.primaryCtas = prims.map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id || '', text: (el.textContent || '').trim().slice(0, 20), ...r2(el), inViewport: r.top >= 0 && r.bottom <= innerHeight };
  });
  const others = [...root.querySelectorAll('.btn:not(.btn-primary)')].filter(isVis);
  out.secondaryCtCount = others.length;

  // 文本截断：自身宽超出且仍有文本的叶子
  const trunc = [];
  for (const el of root.querySelectorAll('h1,h2,h3,h4,p,span,b,small,button,strong,label,div')) {
    if (el.children.length > 1) continue;
    if (!isVis(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis') continue;
    const txt = (el.textContent || '').trim();
    if (!txt || !el.clientWidth) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      trunc.push({ cls: String(el.className || '').slice(0, 44), tag: el.tagName.toLowerCase(), text: txt.replace(/\s+/g, ' ').slice(0, 44), over: el.scrollWidth - el.clientWidth });
    }
  }
  out.truncated = trunc.slice(0, 12);

  // 字号层级（去重后的 px → 出现次数）
  const fsMap = new Map();
  for (const el of root.querySelectorAll('h1,h2,h3,h4,p,span,b,small,button,strong,label')) {
    if (!isVis(el) || el.children.length) continue;
    if (!(el.textContent || '').trim()) continue;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize));
    fsMap.set(px, (fsMap.get(px) || 0) + 1);
  }
  out.fontScale = [...fsMap.entries()].sort((a, b) => b[1] - a[1]).map(([px, n]) => ({ px, n }));

  // 对比度：文本色 vs 最近不透明祖先背景（近似）
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bgOf = (el) => {
    // 背景色逐层叠加；渐变/图片视为装饰，继续向内找实色底。
    // 祖先若处于入场动画中途（opacity < 1），测得的是过渡态 → 返回 null 跳过。
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if (Number(cs.opacity) < 0.99) return null;
      // 渐变/图片底（主按钮、chip、毛玻璃）：单一底色近似不成立，跳过
      if (node !== el && (cs.backgroundImage || 'none') !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.02) acc = acc ? over(acc, c) : c;
      if (acc && acc.a >= 0.95) return acc;
      node = node.parentElement;
    }
    const base = { r: 8, g: 18, b: 20, a: 1 };
    return acc ? over(acc, base) : base;
  };
  const low = [];
  for (const el of root.querySelectorAll('h1,h2,h3,h4,p,span,b,small,strong,label,button')) {
    if (!isVis(el) || el.children.length) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    // 元素自身是渐变/图片底（主按钮、chip）→ 文字压在多色背景上，单一近似不可靠
    if ((cs.backgroundImage || 'none') !== 'none') continue;
    const bg = bgOf(el);
    if (!bg) continue; // 渐变/毛玻璃背景：无法近似，跳过（不误报）
    const f = fg.a < 0.99 ? over(fg, bg) : fg;
    const L1 = lum(f), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      low.push({ cls: String(el.className || '').slice(0, 40), tag: el.tagName.toLowerCase(), text: txt.replace(/\s+/g, ' ').slice(0, 34), px: Math.round(px), ratio: +ratio.toFixed(2), need, fg: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})` });
    }
  }
  out.lowContrast = low.sort((a, b) => a.ratio - b.ratio).slice(0, 14);
  out.lowContrastCount = low.length;
  return out;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  args: process.platform === 'win32' && process.env.WEBGL_SOFTWARE !== '1'
    ? ['--use-angle=d3d11']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const report = { base: BASE, prefix: PREFIX, at: new Date().toISOString(), views: [], errors: [], shots: [] };
const settle = async (page) => {
  // 结束有限动画，避免测量时 rect 还在移动
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try { if (a.effect?.getComputedTiming?.().iterations !== Infinity) a.finish(); } catch { /* noop */ }
    }
  }).catch(() => {});
  await page.waitForTimeout(80);
};

for (const view of VIEWS) {
  const ctx = await browser.newContext({
    viewport: { width: view.w, height: view.h },
    isMobile: view.mobile,
    hasTouch: view.mobile,
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(`${view.w}x${view.h}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${view.w}x${view.h}: ${m.text()}`); });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);

  const tag = `${view.w}x${view.h}`;
  const entry = { view: tag, screens: {}, dialogs: {} };

  for (const name of SCREENS) {
    if (name === 'home') {
      await page.evaluate(() => document.querySelector('.screen.active .app-bar-back')?.click());
    } else {
      await page.evaluate(() => document.querySelector('.screen.active .app-bar-back')?.click());
      await page.waitForTimeout(120);
      await page.evaluate((n) => document.getElementById(`nav-${n}`)?.click(), name);
    }
    await page.waitForTimeout(260);
    await settle(page);
    await page.screenshot({ path: `${OUT}/${PREFIX}-${tag}-${name}.png` });
    report.shots.push(`${PREFIX}-${tag}-${name}.png`);
    entry.screens[name] = await page.evaluate(collect, `#screen-root .screen[data-screen="${name}"]`);
    // 选中态/悬停态证据：主 CTA hover（仅桌面）
    if (!view.mobile && name !== 'home') {
      const cta = await page.$(`#screen-root .screen[data-screen="${name}"] .btn-primary`);
      if (cta) { await cta.hover().catch(() => {}); await page.waitForTimeout(120); }
    }
  }

  // ── 弹窗 1：online（出击 → 联机组队）────────────────────────────────────
  await page.evaluate(() => document.querySelector('.screen.active .app-bar-back')?.click());
  await page.waitForTimeout(120);
  await page.evaluate(() => document.getElementById('nav-play')?.click());
  await page.waitForTimeout(220);
  await page.evaluate(() => document.getElementById('mode-squad')?.click());
  await page.evaluate(() => document.getElementById('btn-online')?.click());
  await page.waitForTimeout(320);
  await settle(page);
  await page.screenshot({ path: `${OUT}/${PREFIX}-${tag}-online.png` });
  report.shots.push(`${PREFIX}-${tag}-online.png`);
  entry.dialogs.online = await page.evaluate(collect, '#online-dialog .modal-card');

  // ── 弹窗 2：room（建房，走真实联机链路）────────────────────────────────
  let roomOk = false;
  try {
    await page.fill('#nickname', 'UXAUDIT');
    await page.evaluate(() => document.getElementById('btn-create-room')?.click());
    await page.waitForFunction(() => document.getElementById('room-dialog')?.classList.contains('open'), null, { timeout: 8000 });
    await page.waitForTimeout(500);
    roomOk = true;
  } catch { /* 服务器不可用时跳过，记录原因 */ }
  if (roomOk) {
    await settle(page);
    await page.screenshot({ path: `${OUT}/${PREFIX}-${tag}-room.png` });
    report.shots.push(`${PREFIX}-${tag}-room.png`);
    entry.dialogs.room = await page.evaluate(collect, '#room-dialog .modal-card');
    await page.evaluate(() => document.getElementById('btn-leave-room')?.click());
    await page.waitForTimeout(400);
  } else {
    entry.dialogs.room = { skipped: '联机建房超时（服务端不可用）' };
  }
  await page.evaluate(() => {
    document.querySelectorAll('#dialog-root .modal.open .modal-close').forEach((b) => b.click());
    document.querySelector('.screen.active .app-bar-back')?.click();
  });
  await page.waitForTimeout(400);

  // ── 弹窗 3：help（顶栏 ? 按钮）─────────────────────────────────────────
  await page.evaluate(() => document.getElementById('nav-loadout')?.click());
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('btn-help-loadout')?.click());
  await page.waitForTimeout(320);
  await settle(page);
  await page.screenshot({ path: `${OUT}/${PREFIX}-${tag}-help.png` });
  report.shots.push(`${PREFIX}-${tag}-help.png`);
  entry.dialogs.help = await page.evaluate(collect, '#help-dialog .modal-card');
  await page.evaluate(() => document.getElementById('btn-help-close')?.click());
  await page.waitForTimeout(200);

  // ── 弹窗 4/5：pause + result（离线对局）────────────────────────────────
  let matchOk = false;
  try {
    await page.evaluate(() => document.querySelector('.screen.active .app-bar-back')?.click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('nav-play')?.click());
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('btn-offline')?.click());
    await page.waitForFunction(() => window.mistIsle?.getStatus?.().mode === 'match', null, { timeout: 25000 });
    await page.waitForTimeout(900);
    matchOk = true;
  } catch { /* 跳过 */ }
  if (matchOk) {
    await page.evaluate(() => document.getElementById('game-menu')?.click());
    await page.waitForFunction(() => document.getElementById('pause-dialog')?.classList.contains('open'), null, { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(320);
    await settle(page);
    await page.screenshot({ path: `${OUT}/${PREFIX}-${tag}-pause.png` });
    report.shots.push(`${PREFIX}-${tag}-pause.png`);
    entry.dialogs.pause = await page.evaluate(collect, '#pause-dialog .modal-card');
    await page.evaluate(() => document.getElementById('btn-resume')?.click());
    await page.waitForTimeout(300);

    const ended = await page.evaluate(() => {
      const m = window.__mistApp?.match;
      const me = m?.players?.find((p) => p.id === window.__mistApp.selfId);
      if (!m || !me) return false;
      try { m.kill(me, null, 'shot'); m.end('lastTeam', me.team); return true; } catch { return false; }
    });
    if (ended) {
      await page.waitForFunction(() => document.getElementById('result-dialog')?.classList.contains('open'), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(600);
      await settle(page);
      await page.screenshot({ path: `${OUT}/${PREFIX}-${tag}-result.png` });
      report.shots.push(`${PREFIX}-${tag}-result.png`);
      entry.dialogs.result = await page.evaluate(collect, '#result-dialog .modal-card');
    } else {
      entry.dialogs.result = { skipped: '无法结束对局' };
    }
  } else {
    entry.dialogs.pause = { skipped: '未能进入对局' };
    entry.dialogs.result = { skipped: '未能进入对局' };
  }

  report.views.push(entry);
  await ctx.close();
}

writeFileSync(`${OUT}/metrics-${PREFIX}.json`, JSON.stringify(report, null, 2));
console.log(`[ux-audit] ${PREFIX} · ${report.shots.length} 张截图 → ${OUT}/`);
for (const v of report.views) {
  const rows = Object.entries(v.screens).map(([k, s]) => {
    if (!s || s.missing) return `${k}:MISSING`;
    const ov = s.overflowX > 0 ? `ovX+${s.overflowX}` : '';
    const hid = s.scroller?.hiddenPx > 0 ? `hidden${s.scroller.hiddenPx}` : '';
    const tap = s.interactive?.under44 ? `tap<44:${s.interactive.under44}/${s.interactive.count}` : 'tap44✓';
    const trunc = s.truncated?.length ? `trunc:${s.truncated.length}` : '';
    const cta = s.primaryCtas?.length ? (s.primaryCtas.every((c) => c.inViewport) ? 'cta✓' : 'cta✗') : 'noCTA';
    const lc = s.lowContrastCount ? `lc:${s.lowContrastCount}` : '';
    return `${k}:${[ov, hid, tap, trunc, cta, lc].filter(Boolean).join(',')}`;
  });
  console.log(`\n${v.view}\n  ${rows.join('\n  ')}`);
  const dl = Object.entries(v.dialogs).map(([k, d]) => `${k}:${d?.missing ? 'MISSING' : d?.skipped ? `skip(${d.skipped})` : `${d.card?.fits ? 'fits' : 'OVERFLOW'} tap<44:${d.interactive?.under44 ?? '?'}`}`);
  console.log(`  dialogs → ${dl.join(' · ')}`);
}
if (report.errors.length) console.log(`\n页面错误 ${report.errors.length}:\n ` + [...new Set(report.errors)].slice(0, 8).join('\n '));
await browser.close();
process.exit(report.errors.length ? 2 : 0);
