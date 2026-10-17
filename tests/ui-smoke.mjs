// UI 冒烟：用 esbuild 把两个 UI 模块打成 IIFE，在 Chromium 里真实建 DOM，
// 检查屏幕/弹窗/HUD 结构、契约 id、可点击性、小地图绘制与刷新节流。
// 运行：node tests/ui-smoke.mjs
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const entry = `
import * as screens from './client/ui-screens.js';
import * as hud from './client/ui-hud.js';
window.__ui = { screens, hud };
`;
const out = buildSync({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'ui-smoke-entry.js' },
  bundle: true, write: false, format: 'iife', target: ['es2022'],
  external: ['three'], logLevel: 'silent',
}).outputFiles[0].text;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="/style.css">
<style>*,*::before,*::after{animation:none!important;transition:none!important}#boot{display:none!important}</style>
</head><body>
<canvas id="world"></canvas><div id="boot"></div><div id="screen-root"></div>
<div id="hud" class="hidden"></div><div id="dialog-root"></div>
<div id="fx-overlay"></div><div id="toast-root"></div><div id="rotate-hint"></div>
<script src="/bundle.js"></script></body></html>`;

const files = {
  '/': { type: 'text/html', body: html },
  '/bundle.js': { type: 'text/javascript', body: out },
  '/style.css': { type: 'text/css', body: readFileSync(resolve(root, 'client/style.css')) },
};

const server = createServer((req, res) => {
  const file = files[req.url.split('?')[0]] || files['/'];
  res.writeHead(200, { 'content-type': file.type });
  res.end(file.body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => !!window.__ui);

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// 伪 app
await page.evaluate(() => {
  const save = {
    xp: 1240, level: 7, credits: 4200, rating: 880,
    stats: { matches: 42, wins: 9, kills: 118, damage: 28450, survived: 380, bestPlacement: 1, streak: 2, bestStreak: 4, hordeWaves: 7 },
    unlocked: { skins: ['skin_default'] },
    loadout: { primary: 'ar7', secondary: 'p9', attachments: { primary: ['red_dot'], secondary: [] }, skin: 'skin_default', throwable: 'frag', consumable: 'medkit' },
    missions: { daily: { d_kill10: { progress: 10, done: true, claimed: false } } },
    achievements: { a_first_win: { progress: 1, done: true, claimed: false } },
  };
  window.__app = {
    mode: 'home', offline: true, state: null, selfId: 'me', mapId: 'qinglan', modeId: 'squad',
    settings: { sound: true, music: true, quality: 'balanced', sensitivity: 1, autoFire: false, joystickScale: 1, showFps: true, haptics: true },
    meta: { data: save, level: 7, credits: 4200, rating: 880, loadout: save.loadout,
      isUnlocked: (kind, id) => (kind === 'skins' ? id === 'skin_default' : false),
      buySkin: () => true, claimMission: () => true, claimAchievement: () => true,
      setLoadout: lo => { save.loadout = lo; window.__app.meta.loadout = lo; },
      equipSkin: () => true, refreshMissions: () => {}, reset: () => {} },
    started: [], toasts: [],
    startOffline: (...args) => { window.__app.started.push(args); },
    startOnline: () => true, leaveMatch: () => {}, home: () => {},
    applySettings: () => {}, saveSettings: () => {},
    emit: () => {}, on: () => {},
  };
  window.__ui.screens.initScreens(window.__app);
});

// 1) 屏幕结构
const screens = await page.evaluate(() => [...document.querySelectorAll('#screen-root .screen')].map(el => el.dataset.screen));
check('8 个屏幕全部创建', screens.length === 8, screens.join(','));
check('home 默认激活', await page.evaluate(() => document.querySelector('#screen-root .screen[data-screen="home"]')?.classList.contains('active')));

// 2) 主菜单导航
await page.click('#nav-play');
check('nav-play 可点击并切屏', await page.evaluate(() => document.querySelector('[data-screen="play"]').classList.contains('active')));
await page.click('#map-chisha');
check('地图卡选中', await page.evaluate(() => document.querySelector('#map-chisha').classList.contains('active')));
await page.click('#mode-solo');
check('模式卡选中', await page.evaluate(() => document.querySelector('#mode-solo').classList.contains('active')));
await page.click('#btn-offline');
check('开始按钮调用 startOffline', await page.evaluate(() => window.__app.started.length === 1 && window.__app.started[0][0] === 'solo'),
  JSON.stringify(await page.evaluate(() => window.__app.started)));

// 3) 联机弹窗
await page.evaluate(() => window.__ui.screens.openScreen('play'));
await page.click('#btn-online');
check('联机弹窗打开', await page.evaluate(() => document.getElementById('online-dialog')?.classList.contains('open')));
const onlineFields = await page.evaluate(() => ['nickname', 'server-address', 'room-code', 'btn-create-room', 'btn-quick-match', 'btn-join-room', 'online-error'].every(id => !!document.getElementById(id)));
check('联机弹窗字段齐全', onlineFields);
await page.fill('#room-code', 'zzzzz');
check('邀请码自动大写过滤', (await page.inputValue('#room-code')) === 'ZZZZZ');
await page.evaluate(() => window.__ui.screens.hideOnlineDialog());

// 4) 房间弹窗
await page.evaluate(() => {
  window.__ui.screens.showRoom({ code: 'K7M2Q', host: 'p1', players: [
    { id: 'p1', name: '队长', team: 0, host: true, ready: true, level: 12 },
    { id: 'p2', name: '队友甲', team: 0, ready: false, level: 8 },
    { id: 'p3', name: '队友乙', team: 0, ready: true, connected: false, level: 6 },
    { id: 'p4', name: '队友丙', team: 1, ready: true, level: 4 },
  ], max: 64, mapName: '青岚岛', gameMode: 'squad' });
});
check('房间弹窗打开', await page.evaluate(() => document.getElementById('room-dialog')?.classList.contains('open')));
check('房间玩家列表 4 行', await page.evaluate(() => document.querySelectorAll('#room-players .room-player').length === 4));
check('邀请码展示', (await page.textContent('#current-code')) === 'K7M2Q');
await page.evaluate(() => window.__ui.screens.hideRoom());

// 5) 其余屏幕
for (const name of ['loadout', 'store', 'missions', 'codex', 'career', 'settings']) {
  await page.evaluate(n => window.__ui.screens.openScreen(n), name);
  const ok = await page.evaluate(n => document.querySelector(`[data-screen="${n}"]`).classList.contains('active'), name);
  check(`屏幕 ${name} 可切换`, ok);
}
const skinCount = await page.evaluate(() => document.querySelectorAll('#skin-grid .skin-card').length);
check('装备页皮肤卡渲染', skinCount >= 5, String(skinCount));
await page.evaluate(() => window.__ui.screens.openScreen('store'));
const storeCards = await page.evaluate(() => document.querySelectorAll('#store-grid .store-card').length);
check('商店卡片渲染', storeCards >= 5, String(storeCards));
await page.evaluate(() => { document.querySelector('#store-tab-weapon').click(); });
check('商店分页切换', await page.evaluate(() => document.querySelector('#store-tab-weapon').classList.contains('active')));
await page.evaluate(() => window.__ui.screens.openScreen('missions'));
const missions = await page.evaluate(() => document.querySelectorAll('#mission-list-daily .mission').length + document.querySelectorAll('#mission-list-weekly .mission').length);
check('任务 3+3 渲染', missions === 6, String(missions));
await page.evaluate(() => window.__ui.screens.openScreen('codex'));
const codexCards = await page.evaluate(() => document.querySelectorAll('#codex-grid .codex-card').length);
check('图鉴武器 ≥18', codexCards >= 18, String(codexCards));
await page.evaluate(() => document.querySelector('#codex-weapon-ar7').click());
check('图鉴详情弹窗', await page.evaluate(() => document.getElementById('codex-dialog')?.classList.contains('open')));
await page.evaluate(() => window.__ui.screens.openCodexDetail('map', 'qinglan'));
check('地图详情可打开', await page.evaluate(() => document.getElementById('map-dialog')?.classList.contains('open')));
await page.evaluate(() => window.__ui.screens.hideAllDialogs());
check('弹窗可全部关闭', await page.evaluate(() => document.querySelectorAll('#dialog-root .modal.open').length === 0));
await page.evaluate(() => window.__ui.screens.openScreen('career'));
const achCount = await page.evaluate(() => document.querySelectorAll('#achievement-grid .ach-card').length);
check('成就 ≥26 条', achCount >= 26, String(achCount));
await page.evaluate(() => window.__ui.screens.openScreen('settings'));
const settingRows = await page.evaluate(() => document.querySelectorAll('[data-screen="settings"] .setting-row').length);
check('设置项 ≥10 行', settingRows >= 10, String(settingRows));
await page.click('#fps-toggle');
check('设置开关可切换', await page.evaluate(() => window.__app.settings.showFps === false));
await page.click('#btn-reset-save');
check('重置存档二次确认', await page.evaluate(() => document.getElementById('confirm-dialog')?.classList.contains('open')));
await page.click('#btn-confirm-cancel');

// 6) 暂停 & 结算 & 帮助
await page.evaluate(() => window.__ui.screens.showPause());
check('暂停弹窗', await page.evaluate(() => document.getElementById('pause-dialog')?.classList.contains('open')));
await page.evaluate(() => window.__ui.screens.hidePause());
await page.evaluate(() => window.__ui.screens.showResult({ won: true, placement: 1, totalTeams: 16, mode: 'squad', mapId: 'qinglan', kills: 7, damage: 940, survived: 372, revives: 2, shotsFired: 120, shotsHit: 64 }, { xp: 320, credits: 180, ratingDelta: 24, levelUp: true, newLevel: 8, missionsCompleted: [{ title: '清除 10 名敌人' }] }));
const resultOpen = await page.evaluate(() => document.getElementById('result-dialog')?.classList.contains('open'));
check('结算弹窗', resultOpen);
check('结算击杀数渲染', (await page.textContent('#result-kills')) === '7');
check('结算奖励渲染', (await page.textContent('#result-rewards')).includes('320'));
await page.evaluate(() => window.__ui.screens.hideResult());
await page.evaluate(() => { const b = document.createElement('button'); b.id = 'test-help'; b.onclick = () => window.__ui.screens.showHelp?.(); document.body.append(b); });
await page.evaluate(() => window.__ui.screens.showHelp());
check('操作说明弹窗', await page.evaluate(() => document.getElementById('help-dialog')?.classList.contains('open')));
await page.evaluate(() => document.querySelector('#help-dialog .modal-close').click());

// 7) toast
await page.evaluate(() => window.__ui.screens.toast('测试提示', 800));
check('toast 出现', await page.evaluate(() => !!document.querySelector('#toast-root .toast')));
await page.waitForTimeout(1100);
check('toast 自动消失', await page.evaluate(() => document.querySelectorAll('#toast-root .toast').length === 0));

// 8) HUD
await page.evaluate(() => {
  window.__ui.hud.initHud(window.__app);
  window.__ui.hud.showHud(true);
});
const hudIds = ['minimap', 'game-menu', 'move-stick', 'aim-stick', 'reload-action', 'heal-action', 'interact-action',
  'throw-action', 'swap-action', 'sprint-action', 'crouch-action', 'dodge-action', 'squad-panel', 'health-panel',
  'weapon-panel', 'ammo', 'reserve', 'killfeed', 'phase-banner', 'crosshair', 'hitmarker', 'zone-status', 'alive-count', 'kill-count'];
const missing = await page.evaluate(ids => ids.filter(id => !document.getElementById(id)), hudIds);
check('HUD 契约 id 全部存在', missing.length === 0, missing.join(','));
check('HUD 可见', await page.evaluate(() => !document.getElementById('hud').classList.contains('hidden')));

// 假快照 → 更新 HUD
const fakeState = await page.evaluate(() => {
  const players = [
    { id: 'me', name: '旅人', team: 0, teamName: '曙光小队', hp: 78, armor: 62, alive: true, downed: false, kills: 3, x: 10, z: 12, angle: 0.6, weapon: 'ar7', ammo: 24, reserve: 120, slot: 0, stamina: 66, bandages: 3, meds: 1, energy: 2, shields: 0, grenades: 2, smokes: 1, flashes: 1, molotovs: 0 },
    { id: 't2', name: '队友甲', team: 0, hp: 100, armor: 0, alive: true, downed: false, x: 24, z: 8 },
    { id: 't3', name: '队友乙', team: 0, hp: 0, armor: 0, alive: true, downed: true, bleedout: 18, reviveProgress: 2.2, x: 6, z: 20 },
    { id: 't4', name: '队友丙', team: 0, hp: 0, alive: false, x: 0, z: 0 },
  ];
  return {
    v: 3, mode: 'squad', mapId: 'qinglan', mapName: '青岚岛', weather: 'rain', phase: 'playing',
    time: 62, matchTime: 88, duration: 420, selfId: 'me',
    zone: { x: 4, z: 4, r: 120, target: { x: 12, z: -8, r: 70 }, closing: true, damage: 9, phase: 2, nextIn: 18.4 },
    counts: { alive: 41, total: 64, teams: 16, aliveTeams: 9 },
    me: players[0], players, teammates: players,
    loot: [], cars: [{ id: 'c1', type: 'buggy', x: 30, z: 30, hp: 100, seats: [null, null] }],
    drops: [{ id: 'd1', x: -20, z: 10, opened: false }], pings: [{ id: 'p1', x: 0, z: 0, kind: 'enemy' }],
    markers: [], grenades: [], smokes: [], fires: [], horde: null,
    events: [{ id: 1, type: 'kill', player: 'x', attacker: 'me', name: '敌人甲', attackerName: '旅人', weapon: 'AR-7' }],
    result: null,
  };
});
await page.evaluate(s => { window.__app.state = s; window.__app.mode = 'match'; window.__ui.hud.updateHud(window.__app, s, 0.016); }, fakeState);
await page.waitForTimeout(140);
await page.evaluate(s => window.__ui.hud.updateHud(window.__app, s, 0.016), fakeState);
check('存活人数渲染', (await page.textContent('#alive-count')) === '9');
check('击杀数渲染', (await page.textContent('#kill-count')) === '3');
check('弹药渲染', (await page.textContent('#ammo')) === '24');
check('武器名渲染', (await page.textContent('#weapon-name')).includes('AR-7'));
check('安全区文字渲染', (await page.textContent('#zone-status')).includes('收缩'));
check('小队面板 4 人', await page.evaluate(() => document.querySelectorAll('#squad-members .squad-member').length === 4));
check('倒地队友标记', await page.evaluate(() => !!document.querySelector('#squad-members .squad-member.downed')));
check('击杀播报出现', await page.evaluate(() => document.querySelectorAll('#killfeed .killfeed-row').length >= 1));
check('小地图已绘制', await page.evaluate(() => {
  const c = document.getElementById('minimap');
  const ctx = c.getContext('2d');
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let nonEmpty = 0;
  for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) nonEmpty++;
  return nonEmpty > 100;
}));
check('血条宽度更新', await page.evaluate(() => document.getElementById('health-bar').style.width === '78%'));

// 记分板 / 全图 / 击杀播报 API
await page.keyboard.press('Tab');
check('Tab 打开记分板', await page.evaluate(() => !document.getElementById('scoreboard').classList.contains('hidden')));
await page.keyboard.press('Tab');
await page.keyboard.press('KeyM');
check('M 打开全图', await page.evaluate(() => document.getElementById('fullmap-dialog')?.classList.contains('open')));
check('全图已绘制', await page.evaluate(() => {
  const c = document.getElementById('fullmap-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4 * 401) if (d[i] > 0) n++;
  return n > 100;
}));
await page.keyboard.press('KeyM');
await page.evaluate(() => window.__ui.hud.hudKillfeed({ type: 'kill', attackerName: '旅人', name: '敌人乙', weapon: 'S12' }));
await page.evaluate(() => window.__ui.hud.hudToast(window.__app, '测试 HUD 提示'));
check('HUD toast', await page.evaluate(() => document.querySelectorAll('#hud-toast .hud-toast-row').length >= 1));

// 9) 触控按钮可点击
for (const id of ['reload-action', 'heal-action', 'swap-action', 'crouch-action']) {
  const box = await page.locator(`#${id}`).boundingBox();
  check(`${id} 尺寸 ≥44px`, box && box.width >= 44 && box.height >= 44, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'missing');
}
const stickBox = await page.locator('#move-stick').boundingBox();
check('move-stick 可交互', !!(stickBox && stickBox.width >= 44));

// 10) 关闭 HUD
await page.evaluate(() => window.__ui.hud.showHud(false));
check('HUD 可隐藏', await page.evaluate(() => document.getElementById('hud').classList.contains('hidden')));

// 11) 布局无横向溢出
for (const name of ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings']) {
  await page.evaluate(n => window.__ui.screens.openScreen(n), name);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${name} 无横向溢出`, overflow <= 1, `overflow=${overflow}`);
}

const failed = results.filter(r => !r.ok);
console.log(results.map(r => `${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? ` · ${r.detail}` : ''}`).join('\n'));
if (errors.length) console.log('\n页面错误:', errors.slice(0, 8));
console.log(`\n${results.length - failed.length} / ${results.length} 通过`);
await browser.close();
server.close();
if (failed.length || errors.length) process.exit(1);
