// 雾岛突围 / MIST ISLE 1.0 — 应用装配与主循环（owner: Lead · client/main.js）
// 职责：启动、状态机、渲染循环、把 scene/input/audio/ui/net/meta 组装起来。
// 其它模块不 import 本文件；本文件通过 app 对象（契约 §10）注入依赖。

import { GameScene } from './scene.js';
import { Fx } from './fx.js';
import { GameAudio } from './audio.js';
import { InputController } from './input.js';
import { NetClient } from './net.js';
import { Meta } from './meta.js';
import * as UI from './ui-screens.js';
import * as HUD from './ui-hud.js';
import { Match, emptyInput } from '../shared/simulation.mjs';
import { PROTOCOL_VERSION, VERSION, TICK_RATE, QUALITY, MATCH_MODES } from '../shared/rules.mjs';
import { makeWorld } from '../shared/map.mjs';
import { MAPS } from '../shared/data/maps.mjs';
import { matchSummaryFromState } from './meta.js';

const $ = (id) => document.getElementById(id);
const NATIVE = location.hostname === 'appassets.androidplatform.net';
const SAVE_KEY = 'mist-isle-settings-v2';
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const DEFAULT_SETTINGS = {
  sfx: 0.75, music: 0.38, quality: 'balanced', sensitivity: 1, joystickScale: 1,
  autoFire: true, haptics: true, showFps: false, leftHanded: false, reducedMotion: false,
  hint: 1, tutorialDone: false,
};

// 简单事件总线：UI 订阅 app.on(name, fn)，核心逻辑 app.emit(name, payload)
class Bus {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.map.get(name)?.delete(fn);
  }
  emit(name, payload) {
    const set = this.map.get(name);
    if (set) for (const fn of [...set]) { try { fn(payload); } catch (e) { console.error('[bus]', name, e); } }
  }
}

const app = {
  version: VERSION,
  mode: 'home',                 // home | match
  offline: false,
  paused: false,
  suspended: false,
  state: null,
  selfId: null,
  me: null,
  modeId: 'squad',
  mapId: 'qinglan',
  difficulty: 'veteran',
  settings: { ...DEFAULT_SETTINGS },
  meta: null,
  scene: null,
  fx: null,
  audio: null,
  input: null,
  net: null,
  match: null,
  socketInfo: { code: null, token: null, host: false, ping: null, reconnecting: false },
  savedServer: '',
  defaultServer: '',
  bus: new Bus(),
  sequence: 0,
  accumulator: 0,
  snapshotTimer: 0,
  lastSent: 0,
  lastPing: 0,
  eventAt: 0,
  frameAt: 0,
  fps: 60,
  frames: 0,
  fpsAt: 0,
  resultSent: false,
  deathShown: false,
  readySent: false,
  readyFrames: 0,
  reconnectAt: 0,
  busy: false,
};
window.__mistApp = app;

// ── 设置与存档 ──────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[key] !== undefined) app.settings[key] = raw[key];
    }
    if (typeof raw.server === 'string') app.savedServer = raw.server;
  } catch { /* 存档损坏则用默认 */ }
  app.defaultServer = NATIVE ? '' : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  if (!app.savedServer) app.savedServer = app.defaultServer;
}
function saveSettings() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...app.settings, server: app.savedServer }));
  } catch { /* 隐私模式下忽略 */ }
}
app.saveSettings = saveSettings;

app.applySettings = function applySettings(changed) {
  app.settings = { ...app.settings, ...(app.meta?.data?.settings || {}) };
  app.audio?.setVolume?.({ sfx: app.settings.sfx, music: app.settings.music });
  app.audio?.mute?.(!app.settings.sfx && !app.settings.music);
  app.scene?.setQuality?.(app.settings.quality);
  app.input?.setSensitivity?.(app.settings.sensitivity);
  app.input?.setJoystickScale?.(app.settings.joystickScale);
  app.input?.setAutoFire?.(app.settings.autoFire);
  document.body.classList.toggle('reduced-motion', !!app.settings.reducedMotion);
  document.body.classList.toggle('show-fps', !!app.settings.showFps);
  saveSettings();
  app.emit('settings', changed || null);
};

app.setLoadout = function setLoadout(loadout) {
  try { app.meta?.setLoadout?.(loadout); } catch (e) { console.warn('setLoadout', e); }
  app.emit('meta:changed', null);
};

// ── 事件 ────────────────────────────────────────────────────────────────────
app.on = (name, fn) => app.bus.on(name, fn);
app.emit = (name, payload) => app.bus.emit(name, payload);
app.toast = (message, ms) => UI.toast(message, ms);

// ── 离线对局 ────────────────────────────────────────────────────────────────
function buildOfflineMatch(modeId, opts) {
  const mode = MATCH_MODES.includes(modeId) ? modeId : 'squad';
  const mapId = MAPS[opts.mapId] ? opts.mapId : 'qinglan';
  const maxPlayers = mode === 'training' ? 16 : mode === 'solo' ? 32 : 64;
  const match = new Match({
    mapId, seed: (Math.random() * 2 ** 30) | 0, mode,
    maxPlayers, difficulty: opts.difficulty || 'veteran',
  });
  const selfId = `me-${Math.random().toString(36).slice(2, 8)}`;
  const loadout = normalizeLoadout(opts.loadout);
  match.addPlayer(selfId, UI.getNickname?.() || '旅人', { team: 0, loadout });
  match.start();
  return { match, selfId };
}

function normalizeLoadout(loadout) {
  const fallback = { primary: 'ar7', secondary: 'p9', attachments: { primary: [], secondary: [] } };
  if (!loadout || typeof loadout !== 'object') return fallback;
  return {
    primary: loadout.primary || fallback.primary,
    secondary: loadout.secondary || fallback.secondary,
    attachments: {
      primary: Array.isArray(loadout.attachments?.primary) ? loadout.attachments.primary : [],
      secondary: Array.isArray(loadout.attachments?.secondary) ? loadout.attachments.secondary : [],
    },
    throwable: loadout.throwable || 'frag',
    consumable: loadout.consumable || 'medkit',
    skin: loadout.skin || app.meta?.loadout?.skin || 'skin_default',
  };
}

app.startOffline = function startOffline(modeId, opts = {}) {
  if (app.mode === 'match') app.leaveMatch();
  const { match, selfId } = buildOfflineMatch(modeId, opts);
  app.offline = true;
  app.match = match;
  app.selfId = selfId;
  app.modeId = match.mode;
  app.mapId = match.mapId;
  app.sequence = 0;
  app.accumulator = 0;
  app.snapshotTimer = 0;
  app.resultSent = false;
  app.deathShown = false;
  app.eventAt = 0;
  enterMatch();
  return { ok: true, selfId, mapId: match.mapId, mode: match.mode };
};

app.rematch = function rematch() {
  if (app.offline) {
    app.startOffline(app.modeId, { mapId: app.mapId, difficulty: app.difficulty });
  } else if (app.net) {
    app.net.send({ type: 'rematch' });
    app.toast('已请求重新开始');
  } else {
    app.startOffline(app.modeId, { mapId: app.mapId, difficulty: app.difficulty });
  }
};

// ── 联机 ────────────────────────────────────────────────────────────────────
function normalizeServer(raw) {
  let value = String(raw || '').trim();
  if (!value) throw new Error(NATIVE ? '填写电脑局域网 IP，例如 ws://192.168.1.8:8787' : '请填写服务器地址');
  value = value.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('地址应以 ws:// 或 wss:// 开头');
  if (url.username || url.password) throw new Error('地址中不能包含账号密码');
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws';
  if (!NATIVE && location.protocol === 'https:' && url.protocol === 'ws:') {
    throw new Error('HTTPS 网页需连接 wss:// 服务器');
  }
  return url.href;
}

app.startOnline = function startOnline(options = {}) {
  const url = normalizeServer(options.server);
  app.savedServer = url;
  saveSettings();
  app.offline = false;
  app.mode = 'online-connecting';
  app.match = null;
  app.state = null;
  app.selfId = null;
  app.resultSent = false;
  app.sequence = 0;
  closeNet();
  const net = new NetClient({
    onMessage: handleNetMessage,
    onStatus: handleNetStatus,
    onError: (err) => UI.showOnlineError(err?.message || '连接失败'),
  });
  app.net = net;
  app.socketInfo = { code: null, token: null, host: false, ping: null, reconnecting: false, url };
  return net.connect(url)
    .then(() => net.join({
      mode: options.kind || 'create',
      code: options.code || '',
      name: options.name || UI.getNickname?.() || '旅人',
      team: Number(options.team) || 0,
      gameMode: options.gameMode || options.mode || 'squad',
      mapId: options.mapId || 'qinglan',
      difficulty: options.difficulty || 'veteran',
      loadout: normalizeLoadout(options.loadout),
      protocol: PROTOCOL_VERSION,
      clientVersion: VERSION,
    }))
    .catch((err) => {
      app.mode = 'home';
      closeNet();
      throw err;
    });
};

function closeNet() {
  if (app.net) { try { app.net.close(); } catch { /* 忽略 */ } }
  app.net = null;
}

app.startRoom = function startRoom() {
  if (app.net) app.net.send({ type: 'start' });
};
app.setReady = function setReady(ready) {
  if (app.net) app.net.send({ type: 'ready', ready: !!ready });
};

function handleNetStatus(status, detail) {
  if (status === 'reconnecting') {
    app.socketInfo.reconnecting = true;
    app.mode = 'reconnecting';
    UI.toast(`连接中断，正在重连（${detail?.attempt || 1}）`, 2600);
    app.emit('net:reconnecting', detail);
  } else if (status === 'resumed') {
    app.socketInfo.reconnecting = false;
    app.readySent = true;
    UI.toast('已恢复连接', 1800);
    app.emit('net:resumed', null);
  } else if (status === 'failed') {
    app.socketInfo.reconnecting = false;
    UI.showOnlineError(detail?.message || '无法连接服务器');
    goHome();
  } else if (status === 'closed') {
    app.socketInfo.reconnecting = false;
  }
}

function handleNetMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      if (msg.protocol !== PROTOCOL_VERSION) {
        UI.showOnlineError(`客户端(${PROTOCOL_VERSION}) 与服务器(${msg.protocol}) 版本不一致`);
        closeNet();
        goHome();
      }
      break;
    case 'joined':
      app.selfId = msg.id;
      app.socketInfo.code = msg.code;
      app.socketInfo.token = msg.token;
      app.socketInfo.host = msg.host === true;
      app.socketInfo.team = msg.team;
      app.mapId = msg.mapId || 'qinglan';
      app.modeId = msg.gameMode || msg.mode || 'squad';
      app.resultSent = false;
      app.deathShown = false;
      app.emit('joined', msg);
      break;
    case 'lobby':
      app.selfId = app.selfId || null;
      app.socketInfo.host = msg.host === app.selfId;
      app.mapId = msg.mapId || app.mapId;
      UI.showRoom(msg);
      app.emit('lobby', msg);
      break;
    case 'state':
      if (msg.state) acceptSnapshot(msg.state);
      break;
    case 'chat':
      HUD.hudChat?.(app, msg);
      app.emit('chat', msg);
      break;
    case 'error':
      if (app.mode === 'online-connecting') { UI.showOnlineError(msg.message); closeNet(); goHome(); }
      else UI.toast(msg.message || '服务器返回错误', 2600);
      app.emit('online:error', msg);
      break;
    case 'pong':
      app.socketInfo.ping = Math.max(0, Math.round(performance.now() - (msg.sent || 0)));
      break;
    case 'rooms':
      app.emit('rooms', msg.rooms || []);
      break;
    case 'left':
    case 'expired':
      closeNet();
      goHome();
      break;
    case 'kicked':
      UI.toast(msg.reason || '已被移出房间', 2600);
      closeNet();
      goHome();
      break;
    default:
      break;
  }
}

// ── 对局生命周期 ────────────────────────────────────────────────────────────
function enterMatch() {
  app.mode = 'match';
  app.paused = false;
  app.resultSent = false;
  app.deathShown = false;
  app.readySent = false;
  app.readyFrames = 0;
  UI.hideRoom();
  UI.hideOnlineDialog();
  UI.closeScreens();
  if (app.offline) {
    app.scene.beginMatch({ mapId: app.mapId, selfId: app.selfId, mode: app.modeId });
    app.scene.setMap(app.mapId);
    acceptSnapshot(app.match.snapshot(app.selfId, 0));
  } else {
    app.scene.beginMatch({ mapId: app.mapId, selfId: app.selfId, mode: app.modeId });
    app.scene.setMap(app.mapId);
  }
  HUD.showHud(true);
  HUD.initHud(app);
  app.input?.clear?.();
  app.audio?.setMusic?.(app.modeId === 'horde' ? 'horde' : 'battle');
  app.audio?.setAmbience?.(MAPS[app.mapId]?.weather || 'clear', 0.6);
  app.emit('match:start', { mode: app.modeId, mapId: app.mapId, offline: app.offline });
}

function acceptSnapshot(state) {
  if (!state || !Array.isArray(state.players)) return;
  // 处理战利品增量
  if (!Array.isArray(state.loot) && state.lootPatch) {
    const map = new Map((app.state?.loot || []).map((l) => [l.id, l]));
    for (const id of state.lootPatch.remove || []) map.delete(id);
    for (const item of state.lootPatch.upsert || []) map.set(item.id, item);
    state.loot = [...map.values()];
  }
  if (!Array.isArray(state.loot)) state.loot = [];
  app.state = state;
  app.selfId = state.selfId || app.selfId;
  app.me = state.me || state.players.find((p) => p.id === app.selfId) || null;
  app.phase = state.phase;
  if (app.mode !== 'match') enterMatch();
  app.scene.setState(state, app.selfId);
  if (state.events?.length) processEvents(state, state.events);
  if (state.phase === 'ended' && !app.resultSent) { app.resultSent = true; finishMatch(state); }
  else if (app.me && !app.me.alive && !app.deathShown && state.phase === 'playing') {
    app.deathShown = true;
    HUD.hudToast?.(app, '你已淘汰 · 可以继续观战', 3200);
  }
}

function processEvents(state, events) {
  for (const ev of events) {
    if (!ev || (ev.id && ev.id <= app.eventAt)) continue;
    if (ev.id) app.eventAt = Math.max(app.eventAt, ev.id);
    const mine = ev.player === app.selfId || ev.target === app.selfId || ev.by === app.selfId;
    switch (ev.type) {
      case 'shot': app.audio?.play?.('shot:' + (ev.weapon || 'rifle'), { dist: ev.dist, pan: ev.pan }); break;
      case 'hit':
        if (mine) { HUD.hudHit?.(app, ev); app.audio?.play?.('hit', {}); app.input?.haptics?.([8]); }
        if (ev.target === app.selfId) { HUD.hudDamage?.(app, ev); app.scene.shake(0.25); }
        break;
      case 'down': HUD.hudKillfeed(ev); app.audio?.play?.('down', {}); break;
      case 'kill': HUD.hudKillfeed(ev); app.audio?.play?.('kill', {}); break;
      case 'revive': HUD.hudKillfeed(ev); app.audio?.play?.('revive', {}); break;
      case 'pickup': if (ev.player === app.selfId) { app.audio?.play?.('pickup', {}); HUD.hudToast(app, `拾取 ${ev.name || ev.item}`); } break;
      case 'heal': if (ev.player === app.selfId) app.audio?.play?.('heal', {}); break;
      case 'explosion': app.fx?.spawn('explosion', { x: ev.x, z: ev.z, r: ev.r || 8 }); app.audio?.play?.('explosion', { dist: ev.dist }); app.scene.shake(0.6); break;
      case 'smoke': app.fx?.spawn('smokeBurst', { x: ev.x, z: ev.z, r: ev.r || 7 }); app.audio?.play?.('smoke', {}); break;
      case 'fire': app.fx?.spawn('fireStart', { x: ev.x, z: ev.z, r: ev.r || 6 }); app.audio?.play?.('fire', {}); break;
      case 'flash': if (ev.target === app.selfId) HUD.hudFlash?.(app, ev.duration || 2.6); break;
      case 'zone': HUD.hudZone?.(app, ev); app.audio?.play?.('storm', {}); break;
      case 'airdrop': HUD.hudToast(app, '补给空投正在降落', 3000); HUD.hudKillfeed(ev); break;
      case 'vehicle': app.audio?.play?.(ev.action === 'destroy' ? 'vehicle_destroy' : 'vehicle', {}); break;
      case 'wave': HUD.hudToast(app, `第 ${ev.wave} 波来袭`, 2600); app.audio?.play?.('wave_start', {}); break;
      case 'boss': HUD.hudToast(app, '精英目标出现', 3000); app.audio?.play?.('boss', {}); break;
      case 'basehit': HUD.hudBase?.(app, ev); break;
      case 'levelup': app.audio?.play?.('levelup', {}); HUD.hudToast(app, '等级提升', 2600); break;
      case 'end': break;
      default: break;
    }
  }
}

function finishMatch(state) {
  const summary = matchSummaryFromState(state, app.selfId, {
    mode: app.modeId, mapId: app.mapId, offline: app.offline,
  });
  let rewards = null;
  try { rewards = app.meta?.addMatchResult?.(summary) || null; } catch (e) { console.warn('reward', e); }
  HUD.showHud(false);
  app.audio?.setMusic?.('result');
  app.audio?.play?.(summary.won ? 'victory' : 'defeat', {});
  UI.showResult(summary, rewards);
  app.emit('match:end', { summary, rewards });
  app.emit('meta:changed', null);
}

app.leaveMatch = function leaveMatch() {
  const wasOffline = app.offline;
  if (!wasOffline && app.net) { try { app.net.send({ type: 'leave' }); } catch { /* 忽略 */ } }
  closeNet();
  app.offline = false;
  app.match = null;
  app.state = null;
  app.me = null;
  app.selfId = null;
  app.mode = 'home';
  app.paused = false;
  app.resultSent = false;
  app.sequence = 0;
  app.input?.clear?.();
  HUD.showHud(false);
  UI.hideResult();
  UI.hidePause();
  UI.closeScreens();
  app.scene.showHome();
  app.audio?.setMusic?.('home');
  app.audio?.setAmbience?.('clear', 0.4);
  UI.openScreen('home');
  app.emit('match:leave', null);
};

app.home = () => app.leaveMatch();
function goHome() {
  app.mode = 'home';
  app.offline = false;
  app.match = null;
  app.state = null;
  app.selfId = null;
  HUD.showHud(false);
  UI.hideRoom();
  UI.hideResult();
  UI.hidePause();
  UI.closeScreens();
  app.scene.showHome();
  app.audio?.setMusic?.('home');
  UI.openScreen('home');
}
app.goHome = goHome;

app.pauseForMenu = function pauseForMenu() {
  if (app.mode !== 'match') return;
  app.paused = app.offline;
  app.input?.clear?.();
  UI.showPause();
};
app.resumeFromMenu = function resumeFromMenu() {
  app.paused = false;
  UI.hidePause();
  app.input?.clear?.();
  app.frameAt = performance.now();
};
app.setPaused = (v) => { app.paused = !!v; };

app.restartTutorial = function restartTutorial() {
  app.settings.tutorialDone = false;
  app.settings.hint = 1;
  saveSettings();
  UI.toast('新手引导已重置', 1800);
};

// ── 主循环 ──────────────────────────────────────────────────────────────────
function step(dt, now) {
  if (app.mode === 'match' && app.offline && app.match) {
    if (!app.paused && !app.suspended && !document.hidden) {
      app.accumulator += dt;
      const maxSteps = 5;
      let steps = 0;
      while (app.accumulator >= 1 / TICK_RATE && steps++ < maxSteps) {
        app.accumulator -= 1 / TICK_RATE;
        const input = { ...app.input?.update(1 / TICK_RATE), seq: ++app.sequence };
        app.match.input(app.selfId, input);
        app.match.update(1 / TICK_RATE);
      }
      app.snapshotTimer += dt;
      if (app.snapshotTimer >= 0.05) {
        app.snapshotTimer = 0;
        acceptSnapshot(app.match.snapshot(app.selfId, app.eventAt));
      }
    }
  } else if (app.mode === 'match' && !app.offline && app.net) {
    if (now - app.lastSent >= 40 && !app.socketInfo.reconnecting) {
      const input = { ...app.input?.update(dt), seq: ++app.sequence };
      if (app.net.sendInput(input)) {
        app.scene.predictInput?.(input, Math.min(0.08, (now - (app.lastSent || now)) / 1000));
      }
      app.lastSent = now;
    }
    if (now - app.lastPing >= 2000) { app.lastPing = now; app.net.ping(); }
    if (app.state?.phase === 'loading') {
      app.readyFrames++;
      if (!app.readySent && app.readyFrames >= 3) { app.readySent = true; app.net.send({ type: 'ready' }); }
    }
  }
}

function frame(now) {
  const dt = Math.min(0.1, Math.max(0.0001, (now - (app.frameAt || now)) / 1000));
  app.frameAt = now;
  app.frames++;
  if (now - app.fpsAt >= 500) { app.fps = Math.round((app.frames * 1000) / Math.max(1, now - app.fpsAt)); app.frames = 0; app.fpsAt = now; }
  app.input?.updateUi?.(dt);
  step(dt, now);
  if (!document.hidden && !app.suspended) {
    try {
      app.scene.render(dt, now / 1000);
      app.fx?.update(dt);
    } catch (err) { console.error('[render]', err); }
    if (app.mode === 'match' && app.state) {
      HUD.updateHud(app, app.state, dt);
    }
  }
  requestAnimationFrame(frame);
}

// ── 启动 ────────────────────────────────────────────────────────────────────
function boot() {
  loadSettings();
  try { app.meta = new Meta(); } catch (e) { console.warn('meta', e); app.meta = null; }
  if (app.meta?.data?.settings) app.settings = { ...app.settings, ...app.meta.data.settings };

  const canvas = $('world');
  if (!canvas) throw new Error('缺少 #world 画布');
  let scene = null;
  try { scene = new GameScene(canvas); } catch (err) {
    console.error('[scene]', err);
    $('boot').replaceChildren();
    const box = document.createElement('div');
    box.className = 'boot-error';
    box.innerHTML = '<strong>图形引擎启动失败</strong><p>需要支持 WebGL 2 的浏览器或安卓系统 WebView。请更新系统组件后重启游戏。</p>';
    $('boot').append(box);
    return;
  }
  app.scene = scene;
  app.fx = new Fx(scene.scene || scene.threeScene || null);
  app.audio = new GameAudio();
  try { app.audio.init?.(app); } catch (e) { console.warn('audio', e); }
  app.input = new InputController(canvas, app);

  UI.initScreens(app);
  HUD.initHud(app);
  app.applySettings(null);

  // 交互语音解锁 + 首次点击
  const unlock = () => { app.audio?.unlock?.(); };
  document.addEventListener('pointerdown', unlock, { passive: true, once: false });
  document.addEventListener('keydown', unlock, { passive: true, once: false });

  // 全局按键：Esc → 菜单
  document.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Escape' && app.mode === 'match' && !UI.isAnyDialogOpen?.()) {
      e.preventDefault();
      app.pauseForMenu();
    }
  });
  document.addEventListener('visibilitychange', () => {
    app.input?.clear?.();
    if (document.hidden) {
      app.audio?.suspend?.();
      if (app.mode === 'match' && !app.offline && app.net) {
        app.net.sendInput({ ...emptyInput(), seq: ++app.sequence });
      }
      if (app.mode === 'match' && !app.offline && !UI.isAnyDialogOpen?.()) app.pauseForMenu();
    } else {
      app.audio?.resume?.();
      app.frameAt = performance.now();
    }
  });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    UI.toast('图形上下文丢失，正在恢复', 4000);
    app.input?.clear?.();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try { app.scene.setQuality(app.settings.quality); } catch { /* 忽略 */ }
  });
  window.addEventListener('resize', () => app.scene.resize?.());
  window.addEventListener('blur', () => app.input?.clear?.());

  // 安卓 WebView 桥
  window.mistIsleBack = () => {
    if (UI.isAnyDialogOpen?.()) { UI.closeTopDialog?.(); return true; }
    if (app.mode === 'match') { app.pauseForMenu(); return true; }
    return false;
  };
  window.mistIsleVisibility = (visible) => {
    app.suspended = !visible;
    app.input?.clear?.();
    if (!visible) app.audio?.suspend?.(); else { app.audio?.resume?.(); app.frameAt = performance.now(); }
  };

  // 诊断接口（e2e 依赖）
  Object.defineProperty(window, 'mistIsle', {
    value: Object.freeze({
      getState: () => (app.state ? JSON.parse(JSON.stringify(app.state)) : null),
      getStatus: () => ({
        version: VERSION, mode: app.mode, offline: app.offline, phase: app.phase || null,
        selfId: app.selfId, mapId: app.mapId, modeId: app.modeId, paused: app.paused,
        reconnecting: !!app.socketInfo.reconnecting, code: app.socketInfo.code,
        ping: app.socketInfo.ping, fps: Math.round(app.fps),
        renderCalls: app.scene?.renderer?.info?.render?.calls ?? 0,
        geometries: app.scene?.renderer?.info?.memory?.geometries ?? 0,
        textures: app.scene?.renderer?.info?.memory?.textures ?? 0,
        screen: UI.getActiveScreen?.() ?? null,
        hudVisible: !$('hud')?.classList.contains('hidden'),
      }),
      getMeta: () => (app.meta?.data ? JSON.parse(JSON.stringify(app.meta.data)) : null),
      getSettings: () => ({ ...app.settings }),
    }),
  });

  app.scene.showHome();
  app.scene.setMap('qinglan');
  UI.openScreen('home');
  app.audio?.setMusic?.('home');
  $('boot')?.classList.add('hidden');
  setTimeout(() => $('boot')?.remove(), 700);
  app.fpsAt = performance.now();
  requestAnimationFrame(frame);
}

try { boot(); } catch (err) {
  console.error('[boot]', err);
  const bootEl = $('boot');
  if (bootEl) {
    bootEl.replaceChildren();
    const box = document.createElement('div');
    box.className = 'boot-error';
    box.innerHTML = '<strong>启动失败</strong><p></p>';
    box.querySelector('p').textContent = String(err?.message || err);
    bootEl.append(box);
  }
}
