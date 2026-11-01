// 雾岛突围 / MIST ISLE 1.0 — 应用装配与主循环（owner: Lead · client/main.js）
// 职责：启动、状态机、渲染循环、把 scene/input/audio/ui/net/meta 组装起来。
// 其它模块不 import 本文件；本文件通过 app 对象（契约 §10）注入依赖。

import { GameScene } from './scene.js';
import { Fx } from './fx.js';
import { GameAudio } from './audio.js';
import { InputController } from './input.js';
import { FeelDirector } from './feel.js';
import { Killcam } from './killcam.js';
import { ReplayRecorder } from '../shared/replay.mjs';
import { NetClient } from './net.js';
import { SocialClient } from './social.js';
import { registerSocialHooks } from './ui-social.js';
import { Meta } from './meta.js';
import { SeasonTracker } from './season.js';
import { MasteryTracker } from './mastery.js';
import { CareerStats } from './stats.js';
import { createTelemetry } from './telemetry.js';
import { resetFeedbackLayer } from './ui-feedback.js';
import * as UI from './ui-screens.js';
import * as HUD from './ui-hud.js';
import { Match, emptyInput } from '../shared/simulation.mjs';
import { PROTOCOL_VERSION, VERSION, TICK_RATE, MATCH_MODES } from '../shared/rules.mjs';
import { MAPS } from '../shared/data/maps.mjs';
import { matchSummaryFromState } from './meta.js';

const $ = (id) => document.getElementById(id);
const NATIVE = location.hostname === 'appassets.androidplatform.net';
const SAVE_KEY = 'mist-isle-settings-v2';
// 重连凭据的持久化槽位：页面重载 / WebView 渲染进程被回收后仍能找回席位。
const RESUME_KEY = 'mist-isle-resume-v1';
const RESUME_TTL_MS = 240000;   // 4 分钟内可自动恢复（服务端席位保留 20s，留足重载时间）
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const DEFAULT_SETTINGS = {
  sfx: 0.75, music: 0.38, quality: 'balanced', sensitivity: 1, joystickScale: 1,
  autoFire: true, haptics: true, showFps: false, leftHanded: false, reducedMotion: false,
  hint: 1, tutorialDone: false, combatGuideDone: false,
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
  feel: null,
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

/**
 * 把存档里的 settings 合并进 app.settings。
 *
 * ⚠ 两套 schema 历史上共存过：
 *   - client/main.js 的 DEFAULT_SETTINGS 用数值 `sfx/music`（0..1 音量）
 *   - shared/progression.mjs 的 DEFAULT_SETTINGS 曾用布尔 `sound/music`
 * 直接 `{...app.settings, ...meta.settings}` 会让 `music` 被布尔 true 覆盖，
 * 而 `Number(true) === 1` → 音乐总线被钳到满音量，设置页滑条显示 100%。
 * 这里做类型归一化：布尔转为 1/0，非法值一律丢弃（保留本地默认）。
 */
function mergeStoredSettings(base, stored) {
  const out = { ...base };
  if (!stored || typeof stored !== 'object') return out;
  for (const [key, value] of Object.entries(stored)) {
    if (value === undefined || value === null) continue;
    if (key === 'music' || key === 'sfx') {
      // 布尔 → 音量 0/1（旧存档兼容）；数值必须是 0..1 的有限数
      if (typeof value === 'boolean') { out[key] = value ? 1 : 0; continue; }
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = clamp(n, 0, 1);
      continue;
    }
    if (key === 'sound') { out.sound = value !== false; continue; }
    out[key] = value;
  }
  return out;
}

app.applySettings = function applySettings(changed) {
  app.settings = mergeStoredSettings(app.settings, app.meta?.data?.settings);
  // 总开关：sound === false 等价于两个音量都归零（旧存档只有 sound 键）
  const sfx = app.settings.sound === false ? 0 : app.settings.sfx;
  const music = app.settings.sound === false ? 0 : app.settings.music;
  app.audio?.setVolume?.({ sfx, music });
  app.audio?.mute?.(!sfx && !music);
  app.scene?.setQuality?.(app.settings.quality);
  // 画质档联动到 CSS：low 档关闭 HUD 的 clip-path（会强制独立合成层）
  document.body.classList.toggle('quality-low', app.settings.quality === 'low');
  app.input?.setSensitivity?.(app.settings.sensitivity);
  app.input?.setJoystickScale?.(app.settings.joystickScale);
  app.input?.setAutoFire?.(app.settings.autoFire);
  // HUD 缩放与左右手布局此前只在 initHud 时读一次，玩家改完必须重启才生效。
  // 这两个 setter 早就存在（ui-hud.js 的 setHudScale/setHudLayout），只是没接线。
  try { HUD.setHudScale?.(Number(app.settings.hudScale) || 1); } catch (e) { console.warn('hudScale', e); }
  try { HUD.setHudLayout?.(!!app.settings.leftHanded); } catch (e) { console.warn('hudLayout', e); }
  document.body.classList.toggle('reduced-motion', !!app.settings.reducedMotion);
  document.body.classList.toggle('show-fps', !!app.settings.showFps);
  // 遥测开关：默认关闭。开启/关闭都走 setEnabled（内部会重建 tracker 或停采）。
  try { app.telemetry?.setEnabled?.(!!app.settings.telemetry); } catch (e) { console.warn('telemetry', e); }
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

// ── 面板入口（ui-hud 通过 app.ui 调用） ──────────────────────────────────────
// 历史 bug：ui-hud 的「小地图放大」「暂停」按钮写的是 app?.ui?.showFullMap?.() /
// app?.ui?.showPause?.()，而 main.js 从未定义 app.ui —— 桌面端还有 M 键与 Esc 兜底，
// 移动端没有键盘，全图与暂停菜单实际完全不可达。这里把 UI / HUD 的导出接上。
app.ui = {
  showFullMap: () => HUD.showFullMap(),
  hideFullMap: () => HUD.hideFullMap(),
  isFullMapOpen: () => HUD.isFullMapOpen(),
  openHudMap: () => HUD.openHudMap(),
  closeHudMap: () => HUD.closeHudMap(),
  showPause: () => app.pauseForMenu(),
  showInventory: () => UI.showInventory?.(),
  hideInventory: () => UI.hideInventory?.(),
  isInventoryOpen: () => UI.isInventoryOpen?.() === true,
  showHelp: () => UI.showHelpDialog?.(),
  toast: (message, ms) => UI.toast(message, ms),
};

// ── 聊天 ────────────────────────────────────────────────────────────────────
// ui-hud 的发送逻辑是 `app?.sendChat?.(text) ?? app?.net?.send?.(...)`；
// app.sendChat 从未定义，离线时 net===null，玩家发出的消息被静默丢弃。
// 现在：有连接就上行到服务器；离线则往 HUD 聊天区写一条本地系统消息 + HUD 提示，
// 让玩家明确知道「消息没有发出去」，而不是以为服务器吞了。
app.sendChat = function sendChat(text) {
  const clean = String(text ?? '').trim().slice(0, 80);
  if (!clean) return false;
  if (!app.offline && app.net) {
    try {
      if (typeof app.net.chat === 'function') { app.net.chat(clean, 'team'); return true; }
      app.net.send({ type: 'chat', text: clean, channel: 'team' });
      return true;
    } catch (err) { console.warn('[chat]', err); }
  }
  // 离线：本地回显，明确标注「未发送」
  try {
    HUD.hudChat?.(app, { name: '系统', text: '离线模式 · 消息仅本地显示', channel: 'system', team: null });
    HUD.hudToast?.(app, '离线模式不支持联机聊天', 2000);
  } catch { /* HUD 未就绪时忽略 */ }
  return true;
};

// ── 离线对局 ────────────────────────────────────────────────────────────────
function buildOfflineMatch(modeId, opts) {
  const mode = MATCH_MODES.includes(modeId) ? modeId : 'squad';
  const mapId = MAPS[opts.mapId] ? opts.mapId : 'qinglan';
  const maxPlayers = mode === 'training' ? 16 : mode === 'solo' ? 32 : 64;
  const match = new Match({
    mapId, seed: (Math.random() * 2 ** 30) | 0, mode,
    maxPlayers, difficulty: opts.difficulty || 'veteran',
    // 训练场保持瞬时部署（新手先学枪法，不该先学跳伞）；
    // solo/squad 走完整航线 + 跳伞，与服务端默认一致。
    deployStyle: mode === 'training' || mode === 'horde' ? 'instant' : 'skydive',
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
    .then(() => {
      // resume：带着房间码 + token 直接恢复席位。缺一不可，否则服务端会当成新加入。
      if (options.mode === 'resume' || options.kind === 'resume') {
        if (!options.code || !options.token) throw new Error('恢复对局缺少房间码或令牌');
        return net.join({ mode: 'resume', code: options.code, token: options.token, protocol: PROTOCOL_VERSION });
      }
      return net.join({
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
      });
    })
    .catch((err) => {
      app.mode = 'home';
      closeNet();
      throw err;
    });
};

function closeNet() {
  if (app.net) { try { app.net.close(); } catch { /* 忽略 */ } }
  app.net = null;
  // 社交层有在途请求表：断线时不清，UI 会卡在「请求中」直到 6 秒超时
  // （审计 docs/AUDIT-WIRING.md 抓到的 missing wiring）。
  try { app.social?.reset?.(); } catch { /* 社交层未初始化时忽略 */ }
}

app.startRoom = function startRoom() {
  if (app.net) app.net.send({ type: 'start' });
};
/** 空降方式（房间等待阶段，房主）：'skydive' 完整航线跳伞 / 'instant' 直接落地。 */
app.setDeployStyle = function setDeployStyle(style) {
  const want = style === 'skydive' ? 'skydive' : 'instant';
  if (app.net) app.net.send({ type: 'config', deployStyle: want });
  else app.offlineDeployStyle = want;
  return want;
};
app.setReady = function setReady(ready) {
  if (app.net) app.net.send({ type: 'ready', ready: !!ready });
};
/** 降落区投票（房间等待阶段）：坐标归一化 0-1，由 NetClient 再做一次 clamp。 */
app.sendDropVote = function sendDropVote(x, z) {
  app.lastDropVoteAt = performance.now();
  return app.net ? app.net.dropVote(x, z) : false;
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
  } else if (status === 'resume-failed') {
    // 服务端明确拒绝恢复（房间已回收 / 席位已被顶替 / 协议不符）：
    // 不要再空转等待，直接把玩家送回大厅并说明原因。
    // 战斗中止的令牌失效意味着服务端已释放席位，重连上去也拿不到同一局。
    app.socketInfo.reconnecting = false;
    UI.toast(detail?.message || '对局已结束，无法恢复连接', 3000);
    try { goHome(); } catch { /* 忽略 */ }
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
      // 把房间码与重连 token 交给 NetClient 保管 —— 断线后 _open(true) 会自动补发
      // {type:'join', mode:'resume', code, token}。此前这一步从未接上：net.js 里的
      // joinMessage 在首次 join 后会被覆写成空 code/token 的 resume 帧，断线重连
      // 永远收到 RESUME_EXPIRED，而错误又被 `joined === true` 静默吞掉，
      // 客户端只能空转 20 秒后提示「重连超时」。
      try { app.net?.setResume?.({ code: msg.code, token: msg.token, protocol: PROTOCOL_VERSION }); } catch { /* 忽略 */ }
      // 持久化重连凭据：Android WebView 的渲染进程被系统回收（4GB 机型很常见）
      // 或进程被杀后，页面会重新加载、内存里的 token 全丢 —— 玩家直接回主菜单，
      // 队友看到的是挂机。写进 localStorage 后，boot 时可在席位保留窗口内自动恢复。
      try {
        if (msg.token && msg.code) {
          localStorage.setItem(RESUME_KEY, JSON.stringify({
            code: msg.code, token: msg.token, server: app.savedServer || null, at: Date.now(),
          }));
        }
      } catch { /* 隐私模式 / 配额满：忽略 */ }
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
      // 只在「还没开战」时显示房间弹窗。一旦进入 match，服务端仍可能补发一次
      // lobby 广播（例如开局瞬间的同步消息），无条件 showRoom 会把刚关掉的
      // room-dialog 重新打开 —— 而 InputController._playing() 见到任何 open
      // 弹窗就返回 false，整个对局输入（移动/开火/救援）会全部失效。
      if (app.mode !== 'match' && msg.phase !== 'live' && msg.phase !== 'ended') {
        UI.showRoom(msg);
      } else if (typeof UI.updateLobby === 'function' && document.getElementById('room-dialog')?.classList.contains('open')) {
        UI.updateLobby(msg);
      }
      app.emit('lobby', msg);
      break;
    case 'state':
      if (msg.state) acceptSnapshot(msg.state);
      break;
    case 'chat':
      HUD.hudChat?.(app, msg);
      app.emit('chat', msg);
      break;
    case 'social': app.social?.handleMessage(msg); break;
    case 'emote': app.social?.handleMessage({ ...msg, type: 'social', action: 'emote' }); break;
    case 'error':
      // 降落区投票投到尚未接线 dropvote 的服务器（UNKNOWN_TYPE）：只提示一次，
      // 不刷 toast、更不能走断线分支 —— 房间等待阶段 app.mode 仍是
      // 'online-connecting'，这条分支必须排在断线判断之前（4s 内刚投过票才命中）。
      if (msg.code === 'UNKNOWN_TYPE' && performance.now() - (app.lastDropVoteAt || 0) < 4000) {
        if (!app.dropVoteUnsupported) {
          app.dropVoteUnsupported = true;
          UI.toast('当前服务器版本不支持降落区投票', 3000);
        }
      }
      else if (app.mode === 'online-connecting') { UI.showOnlineError(msg.message); closeNet(); goHome(); }
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
    case 'killcam':
      if (msg.data && app.killcam) {
        app.suspended = true;
        app.killcam.play(msg.data).finally(() => { app.suspended = false; });
      }
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
  // 每局重建录像器：否则上一局的帧会混进本局的死亡回放。
  if (app.replayRecorder) { try { app.replayRecorder = new ReplayRecorder(); } catch { /* 忽略 */ } }
  UI.hideRoom();
  UI.hideOnlineDialog();
  UI.closeScreens();
  // 兜底：把 #dialog-root 里所有残留的 .open 弹窗统统关掉。
  // 之前只 hideRoom/hideOnlineDialog，如果服务端在开战后还推一次 lobby 广播，
  // updateLobby() 会把 room-dialog 重新打开 —— 而 InputController._playing()
  // 见到任何 .open 弹窗就返回 false，导致整个对局输入（移动/开火/交互）全部失效。
  // 这是"游戏能看见但完全动不了"的 P0 级故障，必须在这里清干净。
  UI.hideAllDialogs?.();
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
  // 遥测（默认关闭：只有 settings.telemetry === true 时才存在对象）
  try {
    app.telemetry?.startMatch?.({ mode: app.modeId, mapId: app.mapId, difficulty: app.difficulty, offline: !!app.offline });
    app.telemetry?.funnel?.('live', true);
  } catch { /* 遥测失败不影响开局 */ }
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
  // 离线死亡回放：联机由服务端单播 {type:'killcam'}，离线没有那条链路，
  // 于是**离线模式永远看不到回放**（审计 docs/AUDIT-WIRING.md 第 2 节）。
  // 这里用同一个 ReplayRecorder + killcam.play 在本地补齐，数据结构与服务端一致。
  if (app.offline && app.match && app.replayRecorder) {
    try { app.replayRecorder.sample(app.match); } catch { /* 采样失败不影响主循环 */ }
  }
  if (state.phase === 'ended' && !app.resultSent) { app.resultSent = true; finishMatch(state); }
  // phase 判定：模拟层（shared/simulation.mjs）发的是 'live'，而旧代码写的是
  // 'playing' —— 全项目只有这一处用 'playing'，于是这段**从未执行过**：
  // 「你已淘汰」提示与死亡回放在离线/联机都永远不触发（1.3.0 实测确认）。
  else if (app.me && !app.me.alive && !app.deathShown
    && (state.phase === 'live' || state.phase === 'playing')) {
    app.deathShown = true;
    HUD.hudToast?.(app, '你已淘汰 · 可以继续观战', 3200);
    if (app.offline && app.killcam && app.replayRecorder) {
      try {
        const data = app.replayRecorder.aroundDeath(app.selfId, null, 4.5);
        if (data) {
          app.suspended = true;
          Promise.resolve(app.killcam.play(data)).finally(() => { app.suspended = false; });
        }
      } catch (e) { console.warn('killcam', e); }
    }
  }
}

/** 事件是否发生在本机玩家 radius 米内（用于「世界音」的距离门槛）。 */
function nearSelf(ev, radius) {
  const me = app.me;
  if (!me) return false;
  const dx = Number(ev.x) - Number(me.x);
  const dz = Number(ev.z) - Number(me.z);
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
  return dx * dx + dz * dz <= radius * radius;
}

function processEvents(state, events) {
  for (const ev of events) {
    if (!ev || (ev.id && ev.id <= app.eventAt)) continue;
    if (ev.id) app.eventAt = Math.max(app.eventAt, ev.id);
    switch (ev.type) {
      case 'shot': {
        // 空间音：事件自带 x/z，必须走 playAt 才会建 Panner、做距离衰减与低通闷化。
        // 历史实现只传了 {dist, pan}，而服务端事件里没有这两个字段 —— hasPos 恒 false，
        // 于是「地图另一端的爆炸和贴脸枪声一样响、一样亮、没有左右」，
        // 238 行的 SpatialRig 实际是死代码。同时把射手 id 传下去做节流分桶
        // （旧实现按声音名全局 70ms 节流，团战 30 发只会响 1 声）。
        app.audio?.playAt?.('shot:' + (ev.weapon || 'rifle'), {
          x: ev.x, z: ev.z, weapon: ev.weapon, src: ev.player, vol: 0.9,
        });
        // 命中反馈分层：hit 可能是布尔（现行模拟）也可能是目标 id（契约 §3.1），两者都兼容
        const me = app.me;
        const hitId = typeof ev.hit === 'string' ? ev.hit : null;
        const didHit = !!ev.hit || (ev.hits || 0) > 0;
        if (ev.player === app.selfId && didHit) {
          const head = (ev.headshots || 0) > 0 || ev.headshot === true;
          app.audio?.play?.(head ? 'headshot' : 'hit', {});
          app.input?.haptics?.([head ? 14 : 8]);
        } else if (me && didHit && (hitId === app.selfId || ev.target === app.selfId)) {
          // 被命中（新式事件带目标 id）：受击方向 + 镜头轻抖
          HUD.hudDamage?.(app, { from: Math.atan2((ev.x || 0) - (me.x || 0), (ev.z || 0) - (me.z || 0)) });
          app.scene?.shake?.(0.2);
        } else if (me && didHit && hitId == null && ev.target == null
          && Number.isFinite(ev.tx) && Number.isFinite(ev.tz)) {
          // 旧式事件只有弹道落点：落点贴身（≈打在我身上）时兜底触发方向指示
          const dx = (ev.tx || 0) - (me.x || 0);
          const dz = (ev.tz || 0) - (me.z || 0);
          if (dx * dx + dz * dz < 3.2) {
            HUD.hudDamage?.(app, { from: Math.atan2((ev.x || 0) - (me.x || 0), (ev.z || 0) - (me.z || 0)) });
            app.scene?.shake?.(0.2);
          }
        }
        break;
      }
      case 'headshot':
        // 现行模拟的独立要害事件：只给攻击者本人加成音效/震动（DOM 标记由 ui-hud 处理）
        if (ev.player === app.selfId) { app.audio?.play?.('headshot', {}); app.input?.haptics?.([14]); }
        break;
      case 'hit':
        if (ev.player === app.selfId || ev.attacker === app.selfId) {
          HUD.hudHit?.(app, ev); app.audio?.play?.(ev.headshot ? 'headshot' : 'hit', {}); app.input?.haptics?.([ev.headshot ? 14 : 8]);
          app.feel?.onHit({ kind: ev.headshot ? 'headshot' : 'hit', damage: ev.damage, distance: ev.dist, headshot: !!ev.headshot, killed: !!ev.killed, targetX: ev.x, targetZ: ev.z });
        }
        if (ev.target === app.selfId) {
          HUD.hudDamage?.(app, ev); app.scene.shake(0.25);
          app.feel?.onDamage({ damage: ev.damage, fromAngle: Number.isFinite(ev.from) ? ev.from : Math.atan2((ev.x || 0) - (app.me?.x || 0), (ev.z || 0) - (app.me?.z || 0)), heavy: !!ev.heavy || (ev.damage || 0) >= 35 });
        }
        break;
      case 'damage':
        if (ev.target === app.selfId || ev.player === app.selfId) app.feel?.onDamage({ damage: ev.damage, fromAngle: ev.from ?? ev.angle ?? 0, heavy: !!ev.heavy });
        break;
      case 'down':
        // 世界音：按位置播放，30m 内才听得见（旧实现全图满音量，后期 AI 混战时持续轰炸）
        if (ev.player === app.selfId || nearSelf(ev, 30)) app.audio?.playAt?.('down', { x: ev.x, z: ev.z });
        break;
      case 'kill':
        app.audio?.play?.('kill', {});
        // ev.by = 击杀者，ev.player = 被击杀者（shared/simulation.mjs kill）
        if (ev.by === app.selfId && ev.player !== app.selfId) app.feel?.onKill({ targetName: ev.name, headshot: !!ev.headshot });
        if (ev.player === app.selfId) app.feel?.onDeath();
        break;
      case 'revive': if (nearSelf(ev, 30)) app.audio?.playAt?.('revive', { x: ev.x, z: ev.z }); break;
      // pickup / reload / heal 之前只播音频，feel.js 里对应的三个反馈入口
      // （onPickup 的稀有度推镜、onReload 的镜头下沉、onHealDone 的治疗脉冲）
      // 无人调用 —— 是审计 docs/AUDIT-WIRING.md 抓到的真实断线。
      case 'pickup':
        if (ev.player === app.selfId) {
          app.audio?.play?.('pickup', {});
          // 稀有度从当前快照的物资表反查（事件里没有 rarity 字段，
          // 而改协议只为一段推镜不值当）。
          const loot = app.state?.loot?.find?.((l) => l.item === ev.item);
          app.feel?.onPickup({ rarity: loot?.rarity || 'common' });
          HUD.hudToast(app, `拾取 ${ev.name || ev.item}`);
        }
        break;
      case 'heal': if (ev.player === app.selfId) app.audio?.play?.('heal', {}); break;
      // 治疗完成：服务端在 healTime 归零时发 healed（携带 kind），
      // 这里接 feel 的脉冲反馈；兜底用 heal 事件的完成态。
      case 'healed': if (ev.player === app.selfId) app.feel?.onHealDone?.(); break;
      // 换弹 / 投掷 / 闪光：引擎里都有配方，但事件从未接线 ——
      // 换弹声是战术射击里最关键的「对方在换弹」信息，闪光起爆则是公平性问题。
      case 'reload':
        if (ev.player === app.selfId) { app.audio?.play?.('reload', {}); app.feel?.onReload?.(); }
        break;
      case 'reloaded': if (ev.player === app.selfId) app.audio?.play?.('reload_bolt', {}); break;
      case 'throw': if (nearSelf(ev, 40)) app.audio?.playAt?.('throw', { x: ev.x, z: ev.z }); break;
      case 'flash': if (ev.target === app.selfId) HUD.hudFlash?.(app, ev.duration || 2.6); if (nearSelf(ev, 35)) app.audio?.playAt?.('flash_bang', { x: ev.x, z: ev.z }); break;
      case 'explosion': app.fx?.spawn('explosion', { x: ev.x, z: ev.z, r: ev.r || 8 }); app.audio?.playAt?.('explosion', { x: ev.x, z: ev.z }); app.scene.shake(0.6); break;
      case 'smoke': app.fx?.spawn('smokeBurst', { x: ev.x, z: ev.z, r: ev.r || 7 }); app.audio?.playAt?.('smoke', { x: ev.x, z: ev.z }); break;
      case 'fire': app.fx?.spawn('fireStart', { x: ev.x, z: ev.z, r: ev.r || 6 }); app.audio?.playAt?.('fire', { x: ev.x, z: ev.z }); break;
      case 'zone': HUD.hudZone?.(app, ev); app.audio?.play?.('storm', {}); break;
      // ── 空降（skydive）：舱门 / 跳伞 / 开伞 / 落地 ─────────────────────
      case 'doorOpen': HUD.hudToast(app, '舱门已开 · 按空格跳伞', 2600); break;
      case 'doorClose': HUD.hudToast(app, '舱门已关，剩余队员被自动投放', 2600); break;
      case 'jump':
        if (ev.player === app.selfId) { app.audio?.play?.('chute_open', {}); app.scene.shake(0.2); }
        break;
      case 'chute':
        if (ev.player === app.selfId) app.audio?.play?.('chute_open', {});
        else if (nearSelf(ev, 60)) app.audio?.playAt?.('chute_open', { x: ev.x, z: ev.z });
        break;
      case 'land':
        if (ev.player === app.selfId) { app.audio?.play?.('land', {}); app.scene.shake(0.28); }
        else if (nearSelf(ev, 45)) app.audio?.playAt?.('land', { x: ev.x, z: ev.z });
        break;
      case 'landAll': HUD.hudToast(app, '全员落地 · 开始搜刮', 2400); break;
      case 'airdrop': HUD.hudToast(app, '补给空投正在降落', 3000); break;
      case 'vehicle':
        if (nearSelf(ev, 45)) app.audio?.playAt?.(ev.action === 'destroy' ? 'vehicle_destroy' : 'vehicle', { x: ev.x, z: ev.z });
        break;
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

  // ── 赛季通行证 + 武器精通 ──────────────────────────────────────────────
  // 两者都在 meta 上写自己的子对象，与 addMatchResult 互不影响。
  // 任何一环出错都不能影响结算流程，所以各自 try/catch。
  try {
    if (app.season) {
      const s = app.season.addMatchXp(summary);
      if (s) rewards = { ...(rewards || {}), season: s };
      // 周挑战与赛季主线必须每局推进 —— 审计 docs/AUDIT-WIRING.md 发现这两个
      // 方法全项目零调用：玩家打满一整季，周挑战进度恒 0、3 章 12 条主线永远停在 0。
      // 两者都只写 meta，不依赖 UI，所以直接在这里推进。
      app.season.challengeProgress?.(summary);
      app.season.missionProgress?.(summary);
    }
  } catch (e) { console.warn('season', e); }
  try {
    if (app.mastery) {
      const m = app.mastery.recordMatch(summary, app.meta?.data?.loadout);
      if (m && m.updates?.length) rewards = { ...(rewards || {}), mastery: m.updates };
    }
  } catch (e) { console.warn('mastery', e); }
  // 生涯统计（K/D、胜率、命中率、武器分布、最近战绩）。与 mastery 一样，
  // 写 meta.data.careerStats，失败不影响结算。
  try { app.career?.recordMatch?.(summary); } catch (e) { console.warn('career', e); }
  try {
    app.telemetry?.track?.('match_end', {
      mode: app.modeId, mapId: app.mapId, placement: summary.placement,
      kills: summary.kills, damage: summary.damage,
      survived: Math.round(summary.survived), won: !!summary.won,
    });
  } catch { /* 遥测失败不影响游戏 */ }

  HUD.showHud(false);
  app.audio?.setMusic?.('result');
  app.audio?.play?.(summary.won ? 'victory' : 'defeat', {});
  UI.showResult(summary, rewards);
  app.emit('match:end', { summary, rewards });
  app.emit('meta:changed', null);
}

app.leaveMatch = function leaveMatch() {
  const wasOffline = app.offline;
  // 玩家主动离开（含结算后返回大厅）：清掉持久化的重连凭据，
  // 否则下次启动会尝试「恢复」一个已经结束的对局，白等一轮握手。
  try { clearResume(); } catch { /* 忽略 */ }
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
  // 反馈层（伤害数字 / 低血晕影 / 死亡去色 / 慢动作环）是跨局复用的 DOM 单例，
  // 不重置会把上一局的状态带进下一局（例如死亡去色残留、屏幕一直灰）。审计
  // docs/AUDIT-WIRING.md 指出 resetFeedbackLayer 全项目零调用。
  try { resetFeedbackLayer(); } catch { /* DOM 未就绪时忽略 */ }
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
  app.settings.combatGuideDone = false;
  app.settings.hint = 1;
  // meta 存档里也有一份 tutorialDone；只清 settings 的话 maybeShowOnboarding()
  // 仍会被 meta 那份判成「已看过」直接跳过。
  try {
    if (app.meta?.data) { app.meta.data.tutorialDone = false; app.meta.save?.(); }
  } catch { /* 存档不可写时忽略 */ }
  saveSettings();
  // 真正的展示由 ui-screens 的 restartTutorial() 调 maybeShowOnboarding({ force: true }) 完成，
  // 这里只负责清状态（force 路径不依赖本函数的 toast）。
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
        // input.update 每次返回新对象，直接写 seq，避免 {...} 展开再分配一份
        const input = app.input ? app.input.update(1 / TICK_RATE) : {};
        input.seq = ++app.sequence;
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
      const input = app.input ? app.input.update(dt) : {};
      input.seq = ++app.sequence;
      if (app.net.sendInput(input)) {
        app.scene.predictInput?.(input, Math.min(0.08, (now - (app.lastSent || now)) / 1000));
      }
      app.lastSent = now;
    }
    if (now - app.lastPing >= 2000) {
      app.lastPing = now;
      try { app.net.ping(); } catch (err) { console.warn('[net] ping', err); }
    }
    if (app.state?.phase === 'loading') {
      app.readyFrames++;
      if (!app.readySent && app.readyFrames >= 3) { app.readySent = true; app.net.send({ type: 'ready' }); }
    }
  }
}

function frame(now) {
  const dt = Math.min(0.1, Math.max(0.0001, (now - (app.frameAt || now)) / 1000));
  app.frameAt = now;
  app.lastDt = dt * 1000;
  app.frames++;
  if (now - app.fpsAt >= 500) { app.fps = Math.round((app.frames * 1000) / Math.max(1, now - app.fpsAt)); app.frames = 0; app.fpsAt = now; }
  // 关键：整个帧逻辑必须包在 try/catch 里。任何一处异常（网络、输入、模拟、
  // 第三方库）冒泡出 rAF 回调都会让下面的 requestAnimationFrame(frame) 不再执行，
  // 主循环永久停死——表现为画面定格、HUD 冻结、控制台每帧刷同一条错误。
  try {
    app.input?.updateUi?.(dt);
    step(dt, now);                       // 模拟/网络永远吃原始 dt：hitstop 只影响观感，不影响输入发送频率
    const vdt = app.feel ? app.feel.update(dt) : dt;  // 视觉 dt：hitstop / 慢动作只缩放渲染与插值
    if (!document.hidden && !app.suspended) {
      // 听者跟随本机玩家：没有这一步，3D 空间音全部以原点为听者，
      // 玩家走到地图另一端时声像仍从出生点发出（SpatialRig 内部有 100ms 节流）。
      // 朝向优先用相机 yaw —— 俯视角下玩家听到的「前方」是屏幕上方，不是角色朝向。
      if (app.me && app.audio?.updateListener) {
        try {
          const yaw = (typeof app.scene?.camYaw === 'number') ? app.scene.camYaw : (app.me.angle || 0);
          app.audio.updateListener(app.me.x || 0, app.me.z || 0, yaw);
        } catch { /* 音频层失败不影响渲染 */ }
      }
      try {
        app.scene.render(vdt, now / 1000);
        app.fx?.update(vdt);
      } catch (err) { console.error('[render]', err); }
      if (app.mode === 'match' && app.state) {
        try { HUD.updateHud(app, app.state, vdt); } catch (err) { console.error('[hud]', err); }
      }
    }
  } catch (err) {
    app.frameErrors = (app.frameErrors || 0) + 1;
    // 前 20 次打印完整栈，之后只计数，避免卡死时刷爆控制台与磁盘
    if (app.frameErrors <= 20) console.error('[frame]', err);
    else if (app.frameErrors === 21) console.error('[frame] 后续同类错误已静默，仅计数');
  }
  requestAnimationFrame(frame);
}

// ── 启动 ────────────────────────────────────────────────────────────────────
function boot() {
  loadSettings();
  try { app.meta = new Meta(); } catch (e) { console.warn('meta', e); app.meta = null; }
  if (app.meta?.data?.settings) app.settings = { ...app.settings, ...app.meta.data.settings };
  // 赛季通行证 + 武器精通：都是挂在 meta 上的独立追踪器，初始化失败不影响主流程
  try { app.season = app.meta ? new SeasonTracker(app.meta) : null; } catch (e) { console.warn('season', e); app.season = null; }
  try { app.mastery = app.meta ? new MasteryTracker(app.meta) : null; } catch (e) { console.warn('mastery', e); app.mastery = null; }
  // 生涯统计：K/D、胜率、命中率、场均伤害、武器击杀分布、最近战绩。
  // client/stats.js 之前是完全未接线的死代码 —— 「生涯」页只能读到 meta.stats 里
  // 少量老字段，没有 K/D、命中率、武器分布与趋势。这里补上装配。
  try { app.career = app.meta ? new CareerStats(app.meta) : null; } catch (e) { console.warn('career', e); app.career = null; }
  // 遥测：默认关闭（settings.telemetry 默认 false）。创建失败不影响任何功能。
  try {
    const T = createTelemetry(app);
    app.telemetry = T;
    if (T) T.boot({ version: VERSION, quality: app.settings.quality });
  } catch (e) { console.warn('telemetry', e); app.telemetry = null; }

  const canvas = $('world');
  if (!canvas) throw new Error('缺少 #world 画布');
  let scene = null;
  try { scene = new GameScene(canvas); } catch (err) {
    console.error('[scene]', err);
    $('boot').replaceChildren();
    const box = document.createElement('div');
    box.className = 'boot-error';
    // 用 createElement 而不是 innerHTML：全站统一走 textContent 构建，杜绝以后
    // 有人把动态内容拼进这段字符串时引入 XSS。
    const title1 = document.createElement('strong');
    title1.textContent = '图形引擎启动失败';
    const desc1 = document.createElement('p');
    desc1.textContent = '需要支持 WebGL 2 的浏览器或安卓系统 WebView。请更新系统组件后重启游戏。';
    box.append(title1, desc1);
    $('boot').append(box);
    return;
  }
  app.scene = scene;
  app.fx = new Fx(scene.scene || scene.threeScene || null);
  try { app.killcam = new Killcam(scene); } catch (e) { console.warn('killcam', e); app.killcam = null; }
  // 离线死亡回放的录像器（联机由服务端 ReplayRecorder 代劳，这里只服务离线对局）。
  // 900 帧 / 每 3 tick 采样 ≈ 90 秒回看窗口，与 server/index.mjs 的默认一致。
  try { app.replayRecorder = new ReplayRecorder(); } catch (e) { console.warn('replay', e); app.replayRecorder = null; }
  app.audio = new GameAudio();
  try { app.audio.init?.(app); } catch (e) { console.warn('audio', e); }
  app.input = new InputController(canvas, app);
  // 手感调度器：统一管理 hitstop / 方向性震动 / 击杀确认（settings 用 getter 保证热改生效）
  try {
    app.feel = new FeelDirector({
      scene, audio: app.audio, input: app.input, hud: HUD,
      settings: () => app.settings,
    });
    window.__mistFeel = app.feel;
  } catch (e) { console.warn('feel', e); app.feel = null; }

  UI.initScreens(app);
  HUD.initHud(app);
  // 社交：net 用 getter 传，重连换 socket 后 social 自动跟着新连接走。
  app.social = new SocialClient(() => app.net, () => app.selfId);
  try { registerSocialHooks(app); } catch (e) { console.warn('[social]', e); }
  app.applySettings(null);
  // 首次启动引导：ui-screens 导出了 maybeShowOnboarding()，但 boot() 从未调用它 ——
  // 全新存档（无 tutorialDone）永远看不到引导层。放在 initScreens + applySettings 之后，
  // 保证样式已注入、设置已生效；已看过的存档会静默返回 false。
  try {
    if (UI.maybeShowOnboarding?.()) app.emit('onboarding:shown', null);
  } catch (err) { console.warn('[onboarding]', err); }

  // 交互语音解锁 + 首次点击
  const unlock = () => { app.audio?.unlock?.(); };
  document.addEventListener('pointerdown', unlock, { passive: true, once: false });
  document.addEventListener('keydown', unlock, { passive: true, once: false });

  // 全局按键：Esc → 菜单
  //
  // 用**冒泡阶段**监听，且在 ui-screens 的 window 监听之后才轮到它？
  // 不行 —— document 是 window 的子节点，冒泡时 document 先于 window 触发，
  // 所以历史上 main.js 总是先执行 pauseForMenu()，而 ui-screens 随后把同一次 Esc
  // 当成「关闭暂停」执行 resumeFromPause()，两相抵消，键盘暂停完全失效。
  //
  // 现在的分工：ui-screens 的 window 监听独占 Esc（打开/关闭各类弹窗、返回大厅），
  // 只有它没有消费（即没有弹窗、也不在二级页面）时，才由这里补一个「对局中开菜单」。
  // 判据是 defaultPrevented —— ui-screens 消费时都会 preventDefault + stopPropagation。
  //
  // ⚠ 必须用**捕获阶段**（第三个参数 true）。
  //
  // document 是 window 的子节点，冒泡时 document 总是先于 window 触发 ——
  // 旧实现（冒泡 + defaultPrevented 判据）因此永远抢在 ui-screens 之前执行：
  // main 先 pauseForMenu() 打开暂停窗，ui-screens 随后把同一次 Esc 当成
  // 「关闭暂停」执行 resumeFromPause()，暂停窗一闪而过（实测 2ms 后即关闭）。
  // 捕获阶段会从 window → document 自上而下传播，这里先跑，先决定并在
  // 「已消费」时 stopPropagation，ui-screens 就不会再看到这次按键。
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code !== 'Escape') return;
    if (app.mode !== 'match') return;
    if (app.paused) return;
    // 有其他弹窗（结算/房间/设置）时交给 ui-screens 处理
    if (UI.isAnyDialogOpen?.()) return;
    e.preventDefault();
    e.stopPropagation();
    app.pauseForMenu();
  }, true);
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
      // e2e / QA 用：屏幕栈与弹窗栈（uiux 建议补，避免测试靠猜 DOM 结构）
      getUi: () => ({
        screen: UI.getActiveScreen?.() ?? null,
        dialogs: Array.from(document.querySelectorAll('#dialog-root .modal.open'))
          .map((n) => n.id).filter(Boolean),
        anyDialogOpen: !!UI.isAnyDialogOpen?.(),
        topDialog: document.querySelector('#dialog-root .modal.open:last-of-type')?.id ?? null,
        hudVisible: !$('hud')?.classList.contains('hidden'),
        toastText: $('toast-root')?.textContent?.trim()?.slice(0, 200) || '',
        screenRootChildren: $('screen-root')?.querySelectorAll('*').length ?? 0,
      }),
      // 帧循环健康度：frameErrors 持续增长说明有异常在被兜底吞掉（应视为 bug）
      getHealth: () => ({
        fps: Math.round(app.fps),
        frameErrors: app.frameErrors || 0,
        lastFrameDtMs: +(app.lastDt || 0).toFixed(1),
        renderCalls: app.scene?.renderer?.info?.render?.calls ?? 0,
        drawCalls: app.scene?.renderer?.info?.render?.calls ?? 0,
        triangles: app.scene?.renderer?.info?.render?.triangles ?? 0,
        geometries: app.scene?.renderer?.info?.memory?.geometries ?? 0,
        textures: app.scene?.renderer?.info?.memory?.textures ?? 0,
        heapMB: (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null),
        audioVoices: app.audio?.voices?.length ?? null,
      }),
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
  // 自动恢复上一局（页面重载 / WebView 渲染进程被回收）。
  // 只在 4 分钟内、且有完整凭据时才尝试；失败会走 net 的 resume-failed 流程回大厅，
  // 不会把玩家卡在加载态。
  try { maybeResumeLastMatch(); } catch (err) { console.warn('[resume]', err); }
}

/**
 * 尝试恢复上次未结束的联机对局。
 *
 * 场景：Android 低内存机型切后台后 WebView 渲染进程被系统回收（页面无提示地重载），
 * 或用户误触刷新。若不做这一步，玩家会直接回主菜单，而服务端仍为他保留 20 秒席位
 * —— 队友看到的是「挂机」，本局也拿不到结算。
 */
function maybeResumeLastMatch() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch { return; }
  if (!saved || !saved.code || !saved.token) return;
  const age = Date.now() - (Number(saved.at) || 0);
  if (!(age >= 0 && age < RESUME_TTL_MS)) { clearResume(); return; }
  // 用户主动退出的标志：离开对局时会清理，所以此刻存在就说明是「非正常中断」
  //
  // 服务器地址兜底顺序：存档里记的 → 当前保存的 → 同源默认值。
  // 缺了兜底会在「换网络后 WebSocket 地址失效」时抛「请填写服务器地址」，
  // 而错误被 boot 的 try/catch 吞掉，玩家只会看到「莫名没恢复」。
  const server = saved.server || app.savedServer || app.defaultServer || undefined;
  if (!server) { clearResume(); return; }
  app.startOnline({ server, mode: 'resume', code: saved.code, token: saved.token })
    .catch((err) => {
      // 恢复失败（席位已过期 / 服务端拒绝）不算异常：关掉半开的连接、清凭据、回大厅。
      // 必须 closeNet()，否则残留的 NetClient 会在后台继续重连，与玩家后续手动
      // 进入联机的连接打架（两个 socket 抢同一个席位，触发 RESUME_CONFLICT）。
      console.warn('[resume] 恢复失败', err?.message || err);
      clearResume();
      try { closeNet(); } catch { /* 忽略 */ }
      try { goHome(); } catch { /* 忽略 */ }
    });
}

function clearResume() {
  try { localStorage.removeItem(RESUME_KEY); } catch { /* 忽略 */ }
}
app.clearResume = clearResume;

try { boot(); } catch (err) {
  console.error('[boot]', err);
  const bootEl = $('boot');
  if (bootEl) {
    bootEl.replaceChildren();
    const box = document.createElement('div');
    box.className = 'boot-error';
    const title2 = document.createElement('strong');
    title2.textContent = '启动失败';
    const desc2 = document.createElement('p');
    desc2.textContent = String(err?.message || err);
    box.append(title2, desc2);
    bootEl.append(box);
  }
}
