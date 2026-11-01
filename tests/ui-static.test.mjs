// 雾岛突围 / MIST ISLE 1.0 — UI 静态契约测试（owner: uiux）
// 运行：node --test tests/ui-static.test.mjs
// 覆盖：打包成功、体积合理、无大量 innerHTML 拼接、契约 DOM id 存在、导出 API 完整。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildSync } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = 'client/ui-screens.js';
const HUD = 'client/ui-hud.js';

function read(file) { return readFileSync(resolve(root, file), 'utf8'); }

function bundle(file, { minify = false } = {}) {
  const result = buildSync({
    entryPoints: [resolve(root, file)],
    bundle: true,
    write: false,
    format: 'esm',
    target: ['es2022'],
    external: ['three', 'lucide', 'ws'],
    minify,
    legalComments: 'none',
    logLevel: 'silent',
  });
  assert.ok(result.outputFiles?.length, `${file} 应产出 bundle`);
  return result.outputFiles[0].text;
}

// ── 1. 打包 ────────────────────────────────────────────────────────────────
test('两个 UI 模块都能被 esbuild 打包', () => {
  for (const file of [SCREENS, HUD]) {
    const out = bundle(file);
    assert.ok(out.length > 2000, `${file} 打包结果不应为空`);
    assert.match(out, /export\s*\{/, `${file} 应保留 ESM 导出`);
  }
});

test('bundle 体积在合理区间（未压缩 < 400KB，压缩后 > 8KB）', () => {
  for (const file of [SCREENS, HUD]) {
    const raw = bundle(file).length;
    const min = bundle(file, { minify: true }).length;
    assert.ok(raw < 400 * 1024, `${file} 未压缩 bundle 过大：${raw}`);
    assert.ok(min > 8 * 1024, `${file} 压缩后 bundle 过小，疑似内容缺失：${min}`);
    assert.ok(min < raw, `${file} 压缩应减小体积`);
  }
});

// ── 2. 不用 innerHTML 拼 DOM ────────────────────────────────────────────────
test('禁用 innerHTML 赋值（允许 0 处）', () => {
  // main.js 也纳入扫描：它是首个渲染入口，启动失败时的错误面板最容易
  // 为了省事写成 innerHTML 拼串（历史上确实有 2 处）。
  for (const file of [SCREENS, HUD, 'client/main.js']) {
    const src = read(file);
    const assignments = [...src.matchAll(/\.innerHTML\s*=/g)].length;
    const outer = [...src.matchAll(/\.outerHTML\s*=/g)].length;
    const docWrite = [...src.matchAll(/document\.write\s*\(/g)].length;
    assert.equal(assignments, 0, `${file} 不应使用 innerHTML 赋值`);
    assert.equal(outer, 0, `${file} 不应使用 outerHTML 赋值`);
    assert.equal(docWrite, 0, `${file} 不应使用 document.write`);
  }
});

test('使用 textContent 与 createElement 构建内容', () => {
  for (const file of [SCREENS, HUD]) {
    const src = read(file);
    assert.ok(src.includes('textContent'), `${file} 应使用 textContent`);
    assert.ok(/createElement|createElementNS/.test(src), `${file} 应使用 createElement`);
    // 禁止把 HTML 片段当字符串模板塞进 DOM
    const htmlLiterals = [...src.matchAll(/`[^`]*<div[^`]*<[^`]*`/g)].length;
    assert.equal(htmlLiterals, 0, `${file} 不应拼接 HTML 字符串模板`);
  }
});

// ── 3. 契约 DOM id（§10.4 / §11） ───────────────────────────────────────────
const SCREEN_IDS = [
  'screen-root', 'dialog-root', 'toast-root',
  'nav-play', 'nav-loadout', 'nav-store', 'nav-missions', 'nav-codex', 'nav-career', 'nav-settings',
  'btn-offline', 'btn-online',
  'online-dialog', 'nickname', 'server-address', 'room-code', 'online-error',
  'btn-create-room', 'btn-quick-match', 'btn-join-room',
  'room-dialog', 'room-players', 'current-code', 'btn-start-room', 'btn-leave-room',
  'pause-dialog', 'btn-resume', 'btn-exit-match',
  'result-dialog', 'result-title', 'result-kills', 'rank-display', 'btn-again', 'btn-return-home',
  'codex-dialog', 'help-dialog', 'confirm-dialog',
  'quality', 'sound-toggle', 'btn-reset-save',
  'currency-credits', 'player-card', 'version-label',
];
const HUD_IDS = [
  'hud', 'minimap', 'game-menu', 'move-stick', 'aim-stick',
  'reload-action', 'heal-action', 'interact-action', 'throw-action', 'swap-action',
  'sprint-action', 'crouch-action', 'dodge-action', 'backpack-action', 'ping-action',
  'squad-panel', 'squad-members', 'health-panel', 'health-bar', 'armor-bar', 'shield-bar', 'stamina-bar',
  'weapon-panel', 'weapon-name', 'ammo', 'reserve', 'reload-progress', 'throwables',
  'killfeed', 'phase-banner', 'crosshair', 'hitmarker', 'damage-vignette',
  'interact-prompt', 'revive-prompt', 'zone-status', 'alive-count', 'kill-count',
  'scoreboard', 'horde-panel', 'fps-meter', 'net-status', 'consumables',
  'touch-controls', 'action-buttons', 'fullmap-dialog', 'fullmap-canvas',
];

function assertIds(file, ids) {
  const src = read(file);
  const missing = ids.filter(id => !src.includes(id));
  assert.deepEqual(missing, [], `${file} 缺少契约 id：${missing.join(', ')}`);
  return src;
}

test('ui-screens 包含 §11 契约 id', () => {
  assertIds(SCREENS, SCREEN_IDS);
});

test('ui-hud 包含 §10.4/§11 契约 id', () => {
  assertIds(HUD, HUD_IDS);
});

test('动态 id 生成保持前缀（nav-/btn-/mode-/map-）', () => {
  const src = read(SCREENS);
  assert.ok(src.includes('HOME_NAV_IDS'), 'nav 按钮 id 应有稳定表');
  for (const id of ['nav-play', 'nav-loadout', 'nav-store', 'nav-missions', 'nav-codex', 'nav-career', 'nav-settings']) {
    assert.ok(src.includes(`'${id}'`), `缺少导航 id ${id}`);
  }
  assert.match(src, /id = `mode-\$\{mode\.id\}`/, 'mode 卡片 id 应动态生成');
  assert.match(src, /id = `map-\$\{map\.id\}`/, 'map 卡片 id 应动态生成');
  assert.ok(src.includes('`btn-${action}`'), '应有 btn- 前缀工具函数');
});

// ── 4. 导出 API ─────────────────────────────────────────────────────────────
test('ui-screens 导出契约 API', async () => {
  const mod = await import(`../${SCREENS}`);
  const required = [
    'initScreens', 'openScreen', 'closeScreens', 'refreshAll', 'toast',
    'showOnlineDialog', 'hideOnlineDialog', 'showRoom', 'updateLobby', 'hideRoom',
    'showResult', 'hideResult', 'showPause', 'hidePause', 'openCodexDetail',
  ];
  for (const name of required) assert.equal(typeof mod[name], 'function', `缺少导出 ${name}`);
  // 不该把内部实现漏出去
  assert.equal(mod.default, undefined, '不应有 default 导出');
});

test('ui-hud 导出契约 API', async () => {
  const mod = await import(`../${HUD}`);
  const required = [
    'initHud', 'updateHud', 'showHud', 'hudKillfeed', 'hudToast',
    'drawMinimap', 'drawFullMap', 'setHudScale',
  ];
  for (const name of required) assert.equal(typeof mod[name], 'function', `缺少导出 ${name}`);
  assert.equal(mod.default, undefined, '不应有 default 导出');
});

test('ui-hud 导出 main.js 消费的事件级 API（hudChat/hudHit/hudDamage/hudFlash/hudZone/hudBase）', async () => {
  const mod = await import(`../${HUD}`);
  for (const name of ['hudChat', 'hudHit', 'hudDamage', 'hudFlash', 'hudZone', 'hudBase']) {
    assert.equal(typeof mod[name], 'function', `main.js 调用但缺少导出：${name}`);
  }
  // 事件级 API 必须内部 try/catch 容错（不能把异常抛给主循环）
  const src = read(HUD);
  for (const name of ['hudChat', 'hudHit', 'hudDamage', 'hudFlash', 'hudZone', 'hudBase']) {
    const start = src.indexOf(`export function ${name}`);
    assert.ok(start > 0, `未找到 ${name} 定义`);
    // 取样窗口取到「下一个 export 或文件末尾」为止，而不是写死 1600 字符。
    // 写死长度会让「函数体正常增长」变成「看起来没有 try/catch」的假失败
    // （1.3.0 给 hudChat 补聊天面板历史后就踩到了）。
    const nextExport = src.indexOf('\nexport ', start + 1);
    const end = nextExport > start ? nextExport : Math.min(src.length, start + 8000);
    const block = src.slice(start, end);
    assert.match(block, /catch\s*\(/, `${name} 应用 try/catch 容错`);
  }
});

test('ui-screens 导出 main.js 使用的辅助 API', async () => {
  const mod = await import(`../${SCREENS}`);
  for (const name of ['closeTopDialog', 'getNickname', 'hideAllDialogs', 'isAnyDialogOpen', 'getActiveScreen']) {
    assert.equal(typeof mod[name], 'function', `缺少导出 ${name}`);
  }
});

// ── 5. 代码风格与性能约定 ───────────────────────────────────────────────────
test('节流常量存在（文字 100ms / 小地图 120ms）', () => {
  const hud = read(HUD);
  assert.match(hud, /TEXT_MS\s*=\s*100/, 'HUD 文字应 100ms 节流');
  assert.match(hud, /MAP_MS\s*=\s*120/, '小地图应 120ms 重绘');
  assert.match(hud, /SQUAD_MS\s*=\s*200/, '小队面板应 200ms 刷新');
});

test('血条更新只改 style（不重建 DOM）', () => {
  const hud = read(HUD);
  assert.match(hud, /setStyle\(R\.hpBar,\s*'width'/, '血条应直接改 width');
  assert.match(hud, /setStyle\(R\.armorBar,\s*'width'/, '护甲条应直接改 width');
});

test('无 Math.random / 无外部依赖 import', () => {
  for (const file of [SCREENS, HUD]) {
    const src = read(file);
    assert.equal([...src.matchAll(/Math\.random\s*\(/g)].length, 0, `${file} 不应使用 Math.random`);
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith('.') || spec.startsWith('node:'), `${file} 不应 import 第三方包：${spec}`);
    }
  }
});

test('中文文案不出现「开发中 / 原型 / TODO」占位', () => {
  for (const file of [SCREENS, HUD]) {
    const src = read(file);
    for (const word of ['开发中', '原型', 'TODO', 'FIXME', '占位文本']) {
      assert.equal(src.includes(word), false, `${file} 不应包含占位文案「${word}」`);
    }
  }
});

test('可交互元素带 aria-label（抽检关键按钮）', () => {
  const screens = read(SCREENS);
  const hud = read(HUD);
  assert.match(screens, /setAttribute\('aria-label', '返回主菜单'\)/);
  assert.match(screens, /setAttribute\('aria-label', '关闭'\)/);
  assert.match(hud, /setAttribute\('aria-label', '暂停菜单'\)/);
  assert.match(hud, /setAttribute\('aria-label', '移动摇杆'\)/);
  assert.match(hud, /setAttribute\('aria-label', '瞄准与射击摇杆'\)/);
  for (const id of ['reload', 'heal', 'interact', 'throw', 'swap', 'sprint', 'crouch', 'dodge']) {
    assert.ok(hud.includes(`id: '${id}-action'`) || hud.includes(`'${id}-action'`), `缺少动作按钮 ${id}-action`);
  }
});

test('触控按钮最小 44px 由 class 承担，同时代码标注尺寸', () => {
  const hud = read(HUD);
  assert.match(hud, /touch-btn/);
  // 至少 10 个动作按钮定义
  const actions = [...hud.matchAll(/id: '([a-z]+-action)'/g)].map(m => m[1]);
  assert.ok(actions.length >= 9, `动作按钮数量不足：${actions.length}`);
});
