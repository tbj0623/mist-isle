// 临时截图脚本（不入库）：把 8 个屏幕 + 弹窗 + HUD 截到 artifacts/ui/
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'artifacts/ui');
mkdirSync(outDir, { recursive: true });

const entry = `
import * as screens from './client/ui-screens.js';
import * as hud from './client/ui-hud.js';
window.__ui = { screens, hud };
`;
const out = buildSync({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'ui-shot.js' },
  bundle: true, write: false, format: 'iife', target: ['es2022'], external: ['three'], logLevel: 'silent',
}).outputFiles[0].text;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="/style.css">
<style>*,*::before,*::after{animation:none!important;transition:none!important}#boot{display:none!important}
canvas#world{background:radial-gradient(120% 90% at 30% 20%,#123c3a,#05100f 70%)}</style>
</head><body>
<canvas id="world"></canvas><div id="boot"></div><div id="screen-root"></div>
<div id="hud" class="hidden"></div><div id="dialog-root"></div>
<div id="fx-overlay"></div><div id="toast-root"></div><div id="rotate-hint"></div>
<script src="/bundle.js"></script></body></html>`;

const files = {
  '/': { type: 'text/html', body: html },
  '/bundle.js': { type: 'text/javascript', body: out },
  '/style.css': { type: 'text/css', body: readFileSync(resolve(root, 'client/style.css')) },
  '/icon.svg': { type: 'image/svg+xml', body: readFileSync(resolve(root, 'client/icon.svg')) },
};
const server = createServer((req, res) => {
  const f = files[req.url.split('?')[0]] || files['/'];
  res.writeHead(200, { 'content-type': f.type });
  res.end(f.body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();

async function setup(width = 1440, height = 900) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !!window.__ui);
  await page.evaluate(() => {
    const save = {
      version: 1, xp: 2260, level: 12, credits: 8420, rating: 1180,
      stats: { matches: 86, wins: 21, kills: 236, damage: 62450, survived: 2200, bestPlacement: 1, streak: 3, bestStreak: 6, hordeWaves: 9 },
      unlocked: { skins: ['skin_default', 'skin_scout'] },
      loadout: { primary: 'ar7', secondary: 'p9', attachments: { primary: ['red_dot', 'suppressor'], secondary: [] }, skin: 'skin_scout', throwable: 'frag', consumable: 'medkit' },
      missions: { day: '2026-10-18', daily: { d_kill10: { progress: 10, done: true, claimed: false }, d_play3: { progress: 2, done: false, claimed: false }, d_dmg1200: { progress: 1200, done: true, claimed: true } }, week: '2026-W42', weekly: { w_win3: { progress: 2, done: false, claimed: false } } },
      achievements: { a_first_win: { progress: 1, done: true, claimed: false }, a_kill100: { progress: 64, done: false, claimed: false } },
      lastResult: { won: true, placement: 1, mode: 'squad', mapId: 'qinglan', kills: 6, survived: 366, totalTeams: 16 },
    };
    window.__app = {
      mode: 'home', offline: true, state: null, selfId: 'me', mapId: 'qinglan', modeId: 'squad',
      settings: { sound: true, music: true, quality: 'balanced', sensitivity: 1, autoFire: false, joystickScale: 1, showFps: true, haptics: true },
      meta: { data: save, level: 12, credits: 8420, rating: 1180, loadout: save.loadout,
        isUnlocked: (k, id) => k === 'skins' ? ['skin_default', 'skin_scout'].includes(id) : false,
        buySkin: () => true, claimMission: () => true, claimAchievement: () => true,
        setLoadout: lo => { save.loadout = lo; window.__app.meta.loadout = lo; }, equipSkin: () => true,
        refreshMissions: () => {}, reset: () => {} },
      startOffline: () => {}, startOnline: () => true, leaveMatch: () => {}, home: () => {}, applySettings: () => {}, saveSettings: () => {}, emit: () => {}, on: () => {},
    };
    window.__ui.screens.initScreens(window.__app);
  });
  return page;
}

const page = await setup();
const shots = ['home', 'play', 'loadout', 'store', 'missions', 'codex', 'career', 'settings'];
for (const name of shots) {
  await page.evaluate(n => window.__ui.screens.openScreen(n), name);
  await page.waitForTimeout(120);
  await page.screenshot({ path: resolve(outDir, `screen-${name}.png`) });
}
await page.evaluate(() => window.__ui.screens.openScreen('home'));
await page.evaluate(() => window.__ui.screens.showOnlineDialog());
await page.waitForTimeout(100);
await page.screenshot({ path: resolve(outDir, 'dialog-online.png') });
await page.evaluate(() => { window.__ui.screens.hideOnlineDialog(); window.__ui.screens.showRoom({ code: 'K7M2Q', host: 'me', players: [{ id: 'me', name: '旅人', team: 0, host: true, ready: true, level: 12 }, { id: 'p2', name: '林间风', team: 0, ready: true, level: 9 }, { id: 'p3', name: '拾荒者', team: 0, ready: false, level: 7 }, { id: 'p4', name: '白夜', team: 1, ready: true, connected: false, level: 15 }], max: 64, mapName: '青岚岛', gameMode: 'squad' }); });
await page.waitForTimeout(100);
await page.screenshot({ path: resolve(outDir, 'dialog-room.png') });
await page.evaluate(() => { window.__ui.screens.hideRoom(); window.__ui.screens.showResult({ won: true, placement: 1, totalTeams: 16, mode: 'squad', mapId: 'qinglan', kills: 7, damage: 942, survived: 372, revives: 2, shotsFired: 121, shotsHit: 68 }, { xp: 386, credits: 214, ratingDelta: 28, levelUp: true, newLevel: 13, missionsCompleted: [{ title: '清除 10 名敌人' }], achievementsCompleted: [{ title: '百人斩' }] }); });
await page.waitForTimeout(100);
await page.screenshot({ path: resolve(outDir, 'dialog-result.png') });
await page.evaluate(() => { window.__ui.screens.hideResult(); window.__ui.screens.closeScreens(); window.__ui.hud.initHud(window.__app); window.__ui.hud.showHud(true); });
const state = await page.evaluate(() => {
  const players = [
    { id: 'me', name: '旅人', team: 0, teamName: '曙光小队', hp: 68, armor: 92, alive: true, downed: false, kills: 4, x: 10, z: 12, angle: 0.6, weapon: 'ar7', ammo: 21, reserve: 120, slot: 0, stamina: 54, bandages: 3, meds: 1, energy: 2, shields: 1, grenades: 2, smokes: 1, flashes: 1, molotovs: 0 },
    { id: 't2', name: '林间风', team: 0, hp: 100, armor: 40, alive: true, x: 24, z: 8 },
    { id: 't3', name: '拾荒者', team: 0, hp: 0, alive: true, downed: true, bleedout: 18, reviveProgress: 2.6, x: 6, z: 20 },
    { id: 't4', name: '白夜', team: 0, hp: 0, alive: false, x: 0, z: 0 },
  ];
  return { v: 3, mode: 'squad', mapId: 'qinglan', mapName: '青岚岛', weather: 'rain', phase: 'playing', time: 62, matchTime: 96, duration: 420, selfId: 'me',
    zone: { x: 4, z: 4, r: 120, target: { x: 14, z: -10, r: 72 }, closing: true, damage: 9, phase: 2, nextIn: 18.4 },
    counts: { alive: 41, total: 64, teams: 16, aliveTeams: 9 }, me: players[0], players, teammates: players,
    loot: [], cars: [{ id: 'c1', type: 'buggy', x: 30, z: 30, hp: 100, seats: [null, null] }],
    drops: [{ id: 'd1', x: -20, z: 10, opened: false }], pings: [{ id: 'p1', x: 0, z: 0, kind: 'enemy' }],
    markers: [{ id: 'm1', kind: 'boss', x: 40, z: -30, r: 8, label: '首领' }], grenades: [], smokes: [], fires: [], horde: null,
    events: [{ id: 1, type: 'kill', player: 'x', attacker: 'me', name: '敌人甲', attackerName: '旅人', weapon: 'AR-7', kill: true }],
    result: null };
});
await page.evaluate(s => { window.__app.state = s; window.__app.mode = 'match'; window.__app.touch = true; window.__ui.hud.updateHud(window.__app, s, 0.016); }, state);
await page.waitForTimeout(200);
await page.evaluate(s => window.__ui.hud.updateHud(window.__app, s, 0.016), state);
await page.waitForTimeout(150);
await page.screenshot({ path: resolve(outDir, 'hud-desktop.png') });
await page.evaluate(() => window.__ui.hud.openHudMap());
await page.waitForTimeout(150);
await page.screenshot({ path: resolve(outDir, 'hud-fullmap.png') });

const mobile = await setup(844, 390);
await mobile.evaluate(() => { window.__ui.screens.closeScreens(); window.__ui.hud.initHud(window.__app); });
await mobile.evaluate(s => { window.__app.state = s; window.__app.mode = 'match'; window.__app.touch = true; window.__ui.hud.showHud(true); window.__ui.hud.updateHud(window.__app, s, 0.016); }, state);
await mobile.evaluate(s => { window.__app.touch = true; window.__ui.hud.updateHud(window.__app, s, 0.016); }, state);
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: resolve(outDir, 'hud-mobile.png') });
await mobile.evaluate(() => window.__ui.screens.openScreen('play'));
await mobile.waitForTimeout(120);
await mobile.screenshot({ path: resolve(outDir, 'mobile-play.png') });

await browser.close();
server.close();
console.log('shots →', outDir);
