// 雾岛突围 / MIST ISLE 1.0 — 局内 HUD（owner: uiux）
// 运行时构建 #hud 内全部 DOM；样式由 style.css（design）提供。
// 性能约定：文字类每 100ms 刷新、小地图每 120ms 重绘、血条每帧只改 style；
// 全程 textContent，不拼 innerHTML，不在每帧创建 DOM。

import { RARITY_NAMES, RARITY_COLORS, REVIVE_TIME, BLEEDOUT_TIME, HORDE } from '../shared/rules.mjs';
import { COMBAT_TASKS, createCombatGuide, observeCombatMovement, observeCombatEvent, combatGuideStatus } from './training-guide.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n) || 0));

const TEXT_MS = 100;
const MAP_MS = 120;
const SQUAD_MS = 200;
const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const RARITY_LIST = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

let app = null;
let built = false;
let visible = false;
let hudScale = 1;

// 缓存的 DOM 引用（避免每帧 querySelector）
const R = {};
const last = {
  text: 0, map: 0, squad: 0, events: 0, banner: 0, toast: 0, fps: 0,
  alive: -1, kills: -1, zone: '', stage: '', weapon: '', ammo: '', reserve: '', state: '', hp: -1, armor: -1, shield: -1, stamina: -1,
  squadSig: '', scoreboardSig: '', hordeSig: '',
};
let lastHudToast = { text: '', at: 0 };

// ── 01 · 基础工具 ────────────────────────────────────────────────────────────
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function clear(node) { if (node) node.replaceChildren(); return node; }
function setText(node, value) {
  if (!node) return;
  const next = String(value);
  if (node.textContent !== next) node.textContent = next;
}
function setStyle(node, prop, value) {
  if (!node) return;
  if (node.style[prop] !== value) node.style[prop] = value;
}
function toggle(node, cls, on) {
  if (!node) return;
  if (node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on);
}
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function rarityColor(r) { return RARITY_COLORS?.[r] || '#c9d2cb'; }
function rarityName(r) { return RARITY_NAMES?.[r] || '普通'; }
function rarityClass(r) { return RARITY_LIST.includes(r) ? `rarity-${r}` : ''; }
// 武器显示信息：优先 app.data.weapons（gamedata 注入），未注入时用内置简表兜底。
const WEAPON_FALLBACK = {
  p9: { name: 'P9 手枪', rarity: 'common', magazine: 15, reload: 1.25, ammo: 'LIGHT' },
  v9: { name: 'V9 冲锋枪', rarity: 'common', magazine: 32, reload: 1.8, ammo: 'LIGHT' },
  smg9: { name: 'SMG-9 冲锋枪', rarity: 'common', magazine: 35, reload: 1.9, ammo: 'LIGHT' },
  ar7: { name: 'AR-7 突击步枪', rarity: 'rare', magazine: 30, reload: 2.2, ammo: 'MEDIUM' },
  m4x: { name: 'M4X 战术步枪', rarity: 'rare', magazine: 30, reload: 2.1, ammo: 'MEDIUM' },
  ak: { name: 'AKM 突击步枪', rarity: 'uncommon', magazine: 30, reload: 2.4, ammo: 'MEDIUM' },
  s12: { name: 'S12 霰弹枪', rarity: 'uncommon', magazine: 6, reload: 2.8, ammo: 'SHELL' },
  lmg9: { name: 'MG9 轻机枪', rarity: 'epic', magazine: 75, reload: 3.6, ammo: 'HEAVY' },
  dmr: { name: 'DMR-5 精确射手', rarity: 'epic', magazine: 20, reload: 2.4, ammo: 'MEDIUM' },
  bolt: { name: 'BOLT-21 狙击枪', rarity: 'legendary', magazine: 5, reload: 3.1, ammo: 'BOLT' },
  gas: { name: 'GAS-9 毒气枪', rarity: 'legendary', magazine: 24, reload: 2.6, ammo: 'LIGHT' },
  cross: { name: '猎手弩', rarity: 'rare', magazine: 1, reload: 2.0, ammo: 'BOLT' },
};
function weaponInfo(id) {
  const table = app?.data?.weapons || app?.data?.WEAPONS || null;
  const hit = table?.[id];
  if (hit) {
    return { name: hit.name || id, rarity: hit.rarity || 'common', magazine: hit.magazine || 30, reload: hit.reload || 2, ammo: String(hit.ammo || '').toUpperCase() };
  }
  if (WEAPON_FALLBACK[id]) return WEAPON_FALLBACK[id];
  return { name: id || '—', rarity: 'common', magazine: 30, reload: 2, ammo: '' };
}
function meOf(state) { return state?.me || state?.players?.find(p => p.id === (state.selfId || app?.selfId)) || null; }
function selfPlayer(state) {
  const me = meOf(state);
  if (me) return me;
  return state?.players?.find(p => p.id === app?.selfId) || null;
}

// ── 02 · 图标（内联 SVG） ───────────────────────────────────────────────────
const ICONS = {
  menu: ['M4 7h16M4 12h16M4 17h16'],
  close: ['M6 6l12 12M18 6L6 18'],
  reload: ['M19.5 12a7.5 7.5 0 1 1-2.4-5.5', 'M19.8 4.5v5h-5'],
  heal: ['M12 20.4s-7.6-4.6-7.6-9.6A4.3 4.3 0 0 1 12 7.9a4.3 4.3 0 0 1 7.6 2.9c0 5-7.6 9.6-7.6 9.6z', 'M12 10.6v4.2M9.9 12.7h4.2'],
  hand: ['M8.5 12.5V5.6a1.7 1.7 0 0 1 3.4 0V11', 'M11.9 10.6V4.8a1.7 1.7 0 0 1 3.4 0v5.8', 'M15.3 11V7a1.7 1.7 0 0 1 3.4 0v7.4A6 6 0 0 1 12.7 20h-1.2a5 5 0 0 1-3.9-1.9L4.9 14.6a1.8 1.8 0 0 1 2.6-2.5l1 1'],
  fire: ['M12 21.5c3.6 0 6-2.4 6-5.6 0-4.2-4.2-5.4-3.4-10.4-2.6.8-4.6 3-4.6 5.6 0 1.4-.8 2.2-1.8 2.2-1 0-1.7-.8-1.7-2-1.6 1.4-2.5 3.4-2.5 5.4 0 3.2 2.4 4.8 6 4.8z'],
  swap: ['M4 8h13l-3.2-3.2', 'M20 16H7l3.2 3.2'],
  run: ['M13.5 5.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z', 'M9 21l2.6-5.4-2.2-3.4 1.2-4.2 3 2.6 3.4.8', 'M11.6 15.6L7.8 21', 'M16.8 10.4l1.8 4.2'],
  crouch: ['M12 5.6a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z', 'M12 8v4.6l-2.6 3.2L7 21', 'M12 12.6l3.4 2.2 1.4 6'],
  roll: ['M18.6 12a6.6 6.6 0 1 1-6.6-6.6', 'M18.6 5.4v6.6h-6.6'],
  bag: ['M4 8h16l-1.2 12H5.2L4 8z', 'M8.5 8V6.2A3.5 3.5 0 0 1 12 2.7a3.5 3.5 0 0 1 3.5 3.5V8'],
  ping: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z'],
  map: ['M9 4.5l6 2 5.5-2v15l-5.5 2-6-2-5.5 2v-15l5.5-2z', 'M9 4.5v15M15 6.5v15'],
  zoom: ['M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z', 'M16.4 16.4L21 21', 'M8.2 11h5.6M11 8.2v5.6'],
  heart: ['M12 20.4s-7.6-4.6-7.6-9.6A4.3 4.3 0 0 1 12 7.9a4.3 4.3 0 0 1 7.6 2.9c0 5-7.6 9.6-7.6 9.6z'],
  shield: ['M12 21s7-3.2 7-9V5.6L12 3 5 5.6V12c0 5.8 7 9 7 9z'],
  bolt: ['M13.2 2.5L5 13.4h6L10.8 21.5 19 10.6h-6l.2-8.1z'],
  skull: ['M12 21a7 7 0 0 0 7-7v-2.4A5.6 5.6 0 0 0 13.4 6h-2.8A5.6 5.6 0 0 0 5 11.6V14a7 7 0 0 0 7 7z', 'M9.4 12.4h.01M14.6 12.4h.01'],
  trophy: ['M7 4h10v4.5a5 5 0 0 1-10 0V4z', 'M7 5H4v2.5a3 3 0 0 0 3 3M17 5h3v2.5a3 3 0 0 1-3 3', 'M12 13.5V18M8.5 21h7'],
  chat: ['M4 5.5h16v11H9l-5 4v-15z'],
  mic: ['M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4z', 'M6.5 11.5a5.5 5.5 0 0 0 11 0', 'M12 17v3.5M9 20.5h6'],
  users: ['M8.2 11.4a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z', 'M2.2 20.4c0-3.4 2.7-6.2 6-6.2s6 2.8 6 6.2', 'M16.4 4.6a3.4 3.4 0 0 1 0 6.4', 'M17.6 14.1c2.5.6 4.2 2.9 4.2 5.4'],
  car: ['M3.5 15.5l1.6-5.2h13.8l1.6 5.2v3h-2.4', 'M3.5 15.5v3h2.4', 'M8.3 18.5h7.4', 'M6.5 12.5h11', 'M8 18.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM17 18.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z'],
  wave: ['M3 8.2c2.4 0 2.4-2.6 4.8-2.6s2.4 2.6 4.8 2.6 2.4-2.6 4.8-2.6 2.4 2.6 3.6 2.6', 'M3 13.2c2.4 0 2.4-2.6 4.8-2.6s2.4 2.6 4.8 2.6 2.4-2.6 4.8-2.6 2.4 2.6 3.6 2.6', 'M3 18.2c2.4 0 2.4-2.6 4.8-2.6s2.4 2.6 4.8 2.6 2.4-2.6 4.8-2.6 2.4 2.6 3.6 2.6'],
  base: ['M4 20.5V9l8-5.5L20 9v11.5', 'M4 20.5h16', 'M9.5 20.5v-6h5v6'],
  // 跳伞：伞盖 + 两条伞绳 + 吊着的人
  chute: ['M3.2 10.4a8.8 8.8 0 0 1 17.6 0z', 'M7.2 10.4L12 19M16.8 10.4L12 19', 'M12 19a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z'],
};
function icon(name, size = 20) {
  const paths = ICONS[name] || ICONS.ping;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// ── 03 · DOM 构建 ───────────────────────────────────────────────────────────
function buildTopBar(host) {
  const top = h('div', 'hud-top');
  const stats = h('div', 'hud-stats hud-panel');
  const alive = h('div', 'hud-alive');
  const aliveValue = h('b', 'num', '—');
  aliveValue.id = 'alive-count';
  alive.append(h('small', 'muted', '存活'), aliveValue, h('span', 'hud-alive-sub muted', '人'));
  const kill = h('div', 'hud-kills');
  const killValue = h('b', 'num', '0');
  killValue.id = 'kill-count';
  kill.append(h('small', 'muted', '淘汰'), killValue);
  stats.append(alive, h('span', 'divider vertical'), kill);

  const zone = h('div', 'zone-pill');
  zone.id = 'zone-status';
  zone.setAttribute('role', 'status');
  const zoneIcon = h('span', 'zone-icon');
  zoneIcon.append(icon('shield', 15));
  const zoneText = h('span', 'zone-text', '安全区稳定');
  zone.append(zoneIcon, zoneText);

  const stage = h('div', 'hud-stage hud-panel');
  stage.id = 'hud-stage';
  const stagePhase = h('b', 'num', '阶段 1');
  const stageTimer = h('span', 'num hud-stage-timer', '--:--');
  stage.append(stagePhase, stageTimer);

  const weather = h('div', 'hud-weather');
  weather.id = 'hud-weather';
  weather.append(h('span', 'hud-weather-icon', '☀'), h('small', 'muted', '—'));

  const right = h('div', 'hud-top-right');
  const fps = h('span', 'fps-meter num');
  fps.id = 'fps-meter';
  fps.textContent = '';
  const pause = h('button', 'icon-btn hud-menu-btn');
  pause.id = 'game-menu';
  pause.type = 'button';
  pause.setAttribute('aria-label', '暂停菜单');
  pause.title = '暂停菜单 (Esc)';
  pause.append(icon('menu', 20));
  right.append(fps, pause);
  top.append(stats, zone, stage, weather, right);
  host.append(top);
  R.top = top;
  R.alive = aliveValue;
  R.aliveSub = alive.querySelector('.hud-alive-sub');
  R.kills = killValue;
  R.zone = zone;
  R.zoneText = zoneText;
  R.stage = stage;
  R.stagePhase = stagePhase;
  R.stageTimer = stageTimer;
  R.weather = weather;
  R.weatherIcon = weather.querySelector('.hud-weather-icon');
  R.weatherText = weather.querySelector('small');
  R.fps = fps;
  R.pause = pause;
  pause.addEventListener('click', () => {
    try {
      if (app?.pauseForMenu) app.pauseForMenu();
      else app?.ui?.showPause?.();
    } catch (err) { console.warn(err); }
    emit('pause');
  });
}

function buildMinimap(host) {
  const wrap = h('div', 'hud-map minimap-wrap');
  const canvas = document.createElement('canvas');
  canvas.id = 'minimap';
  canvas.className = 'minimap-canvas';
  canvas.width = 200;
  canvas.height = 200;
  canvas.setAttribute('aria-label', '小地图 · 打开战术地图');
  // 小地图本身就是「放大」入口：桌面有 M 键，触屏没有键盘 —— 历史上只有右上角那个
  // 34px 的放大按钮能开全图，而它调用的 app.ui 从未定义，移动端因此完全够不到全图。
  canvas.setAttribute('role', 'button');
  canvas.setAttribute('tabindex', '0');
  canvas.style.cursor = 'zoom-in';
  const zoom = h('button', 'icon-btn minimap-zoom');
  zoom.id = 'btn-map-zoom';
  zoom.type = 'button';
  zoom.setAttribute('aria-label', '打开战术地图 (M)');
  zoom.title = '战术地图 (M)';
  zoom.style.minWidth = '44px';
  zoom.style.minHeight = '44px';
  zoom.append(icon('zoom', 16));
  // 历史 bug：这里只走 app.ui.showFullMap / emit('fullmap')，而 main.js 从未定义
  // app.ui、也没人订阅 hud:fullmap —— 点按钮完全没反应。现在直接调用本模块导出的
  // showFullMap（同一个函数，main.js 的 app.ui 只是另一条入口）。
  const openMap = () => { showFullMap(); };
  zoom.addEventListener('click', openMap);
  canvas.addEventListener('click', openMap);
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMap(); }
  });
  const meta = h('div', 'map-meta');
  const mapName = h('span', 'map-name', '—');
  const net = h('span', 'map-net muted', '离线');
  net.id = 'net-status';
  meta.append(mapName, net);
  wrap.append(canvas, zoom, meta);
  host.append(wrap);
  R.minimap = canvas;
  R.minimapMeta = meta;
  R.mapName = mapName;
  R.net = net;
}

function buildSquad(host) {
  const panel = h('div', 'squad-panel');
  panel.id = 'squad-panel';
  const head = h('div', 'squad-heading');
  const name = h('b', 'squad-name', '小队');
  const count = h('small', 'squad-count muted', '0 / 0');
  head.append(icon('users', 14), name, count);
  const list = h('div', 'squad-members');
  list.id = 'squad-members';
  panel.append(head, list);
  host.append(panel);
  R.squadPanel = panel;
  R.squadName = name;
  R.squadCount = count;
  R.squadList = list;
  R.squadRows = new Map();
}

function buildHealth(host) {
  const panel = h('div', 'health-panel hud-panel');
  panel.id = 'health-panel';
  const line = h('div', 'player-line');
  const name = h('b', 'player-name', '—');
  const values = h('span', 'health-value num');
  const hpText = h('b', 'num', '100');
  const shieldText = h('small', 'muted', '');
  values.append(hpText, shieldText);
  line.append(name, values);
  const tracks = h('div', 'health-tracks');
  const hpTrack = h('div', 'health-track');
  const hpFill = h('i');
  hpFill.id = 'health-bar';
  hpTrack.append(hpFill);
  const armorTrack = h('div', 'armor-track');
  const armorFill = h('i');
  armorFill.id = 'armor-bar';
  armorTrack.append(armorFill);
  const shieldTrack = h('div', 'shield-track');
  const shieldFill = h('i');
  shieldFill.id = 'shield-bar';
  shieldTrack.append(shieldFill);
  const staminaTrack = h('div', 'stamina-track');
  const staminaFill = h('i');
  staminaFill.id = 'stamina-bar';
  staminaTrack.append(staminaFill);
  tracks.append(hpTrack, armorTrack, shieldTrack, staminaTrack);
  const stateText = h('small', 'player-state muted', '');
  stateText.id = 'player-state';
  panel.append(line, tracks, stateText);
  host.append(panel);
  R.healthPanel = panel;
  R.playerName = name;
  R.hpText = hpText;
  R.shieldText = shieldText;
  R.hpBar = hpFill;
  R.armorBar = armorFill;
  R.shieldBar = shieldFill;
  R.staminaBar = staminaFill;
  R.hpTrack = hpTrack;
  R.armorTrack = armorTrack;
  R.shieldTrack = shieldTrack;
  R.staminaTrack = staminaTrack;
  R.stateText = stateText;
  R.consumables = buildConsumables(panel);
}

const CONSUMABLE_DEFS = [
  { key: 'bandages', item: 'bandage', label: '绷带', icon: 'heal' },
  { key: 'meds', item: 'medkit', label: '医疗包', icon: 'heal' },
  { key: 'energy', item: 'energy', label: '能量', icon: 'bolt' },
  { key: 'shields', item: 'shield', label: '护盾', icon: 'shield' },
];
function buildConsumables(panel) {
  const row = h('div', 'consumables');
  row.id = 'consumables';
  const buttons = {};
  for (const def of CONSUMABLE_DEFS) {
    const btn = h('button', 'touch-btn consumable-btn');
    btn.type = 'button';
    btn.dataset.item = def.item;
    btn.setAttribute('aria-label', `使用${def.label}`);
    btn.title = `使用${def.label}`;
    btn.append(icon(def.icon, 18));
    const count = h('span', 'count num', '0');
    btn.append(count, h('small', null, def.label));
    btn.addEventListener('click', () => useItem(def.item));
    row.append(btn);
    buttons[def.key] = { btn, count };
  }
  panel.append(row);
  R.consumableButtons = buttons;
  return row;
}

// ── 04 · 武器 / 投掷物 / 准星 / 提示 ────────────────────────────────────────
const THROWABLE_DEFS = [
  { key: 'grenades', kind: 'frag', label: '破片', icon: 'fire' },
  { key: 'smokes', kind: 'smoke', label: '烟雾', icon: 'wave' },
  { key: 'flashes', kind: 'flash', label: '闪光', icon: 'bolt' },
  { key: 'molotovs', kind: 'molotov', label: '燃烧', icon: 'fire' },
];

function buildWeapon(host) {
  const panel = h('div', 'weapon-panel hud-panel');
  panel.id = 'weapon-panel';
  const head = h('div', 'weapon-head');
  const nameWrap = h('div', 'weapon-name-wrap');
  const name = h('b', 'weapon-name', '—');
  name.id = 'weapon-name';
  const rarity = h('small', 'weapon-rarity', '普通');
  rarity.id = 'weapon-rarity';
  nameWrap.append(name, rarity);
  const slots = h('div', 'weapon-slots');
  const slotPrimary = h('button', 'slot-mini active', '1');
  slotPrimary.type = 'button';
  slotPrimary.id = 'slot-primary';
  slotPrimary.setAttribute('aria-label', '主武器');
  const slotSecondary = h('button', 'slot-mini', '2');
  slotSecondary.type = 'button';
  slotSecondary.id = 'slot-secondary';
  slotSecondary.setAttribute('aria-label', '副武器');
  slotPrimary.addEventListener('click', () => swapWeapon(0));
  slotSecondary.addEventListener('click', () => swapWeapon(1));
  slots.append(slotPrimary, slotSecondary);
  head.append(nameWrap, slots);
  const ammoRow = h('div', 'ammo-row');
  const ammo = h('b', 'ammo num', '0');
  ammo.id = 'ammo';
  const sep = h('span', 'ammo-sep', '/');
  const reserve = h('span', 'reserve num', '0');
  reserve.id = 'reserve';
  const ammoType = h('small', 'ammo-type muted', '');
  ammoRow.append(ammo, sep, reserve, ammoType);
  const reloadWrap = h('div', 'reload-bar');
  const reloadFill = h('i');
  reloadFill.id = 'reload-progress';
  reloadWrap.append(reloadFill);
  const throws = h('div', 'throwables');
  throws.id = 'throwables';
  const throwBtns = {};
  for (const def of THROWABLE_DEFS) {
    const btn = h('button', 'throw-btn touch-btn');
    btn.type = 'button';
    btn.dataset.kind = def.kind;
    btn.setAttribute('aria-label', `投掷${def.label}`);
    btn.append(icon(def.icon, 16), h('span', 'count num', '0'), h('small', null, def.label));
    btn.addEventListener('click', () => throwGrenade(def.kind));
    throws.append(btn);
    throwBtns[def.key] = { btn, count: btn.querySelector('.count') };
  }
  panel.append(head, ammoRow, reloadWrap, throws);
  host.append(panel);
  R.weaponPanel = panel;
  R.weaponName = name;
  R.weaponRarity = rarity;
  R.slotPrimary = slotPrimary;
  R.slotSecondary = slotSecondary;
  R.ammo = ammo;
  R.reserve = reserve;
  R.ammoType = ammoType;
  R.reloadWrap = reloadWrap;
  R.reloadFill = reloadFill;
  R.throwButtons = throwBtns;
}

function buildCenter(host) {
  const cross = h('div', 'crosshair');
  cross.id = 'crosshair';
  const dot = h('span', 'cross-dot');
  const ring = h('span', 'cross-ring');
  // 4 条可编程刻线：由 spread（弧度）驱动与中心距离，比纯 CSS 固定尺寸更真实
  const lines = [0, 1, 2, 3].map((i) => {
    const line = h('i', `cross-line line-${i}`);
    line.setAttribute('aria-hidden', 'true');
    return line;
  });
  cross.append(dot, ring, ...lines);
  const hit = h('div', 'hitmarker');
  hit.id = 'hitmarker';
  hit.append(h('i'), h('i'), h('i'), h('i'));
  const vignette = h('div', 'damage-vignette');
  vignette.id = 'damage-vignette';
  const dirWrap = h('div', 'damage-indicators');
  dirWrap.id = 'damage-indicators';
  const revive = h('div', 'revive-prompt hidden');
  revive.id = 'revive-prompt';
  const reviveRing = h('div', 'revive-ring');
  reviveRing.append(h('i'));
  const reviveText = h('span', 'revive-text', '救援中');
  revive.append(reviveRing, reviveText);
  const interact = h('div', 'interact-prompt hidden');
  interact.id = 'interact-prompt';
  const key = h('span', 'keycap', 'E');
  const interactText = h('span', 'interact-text', '交互');
  interact.append(key, interactText);
  const reloadPrompt = h('div', 'reload-prompt hidden');
  reloadPrompt.id = 'reload-prompt';
  reloadPrompt.append(h('span', 'keycap', 'R'), h('span', null, '换弹'));
  host.append(cross, hit, vignette, dirWrap, revive, interact, reloadPrompt);
  R.crosshair = cross;
  R.crossRing = ring;
  R.crossLines = lines;
  R.hitmarker = hit;
  R.vignette = vignette;
  R.damageDirs = dirWrap;
  R.revive = revive;
  R.reviveRing = reviveRing.querySelector('i');
  R.reviveText = reviveText;
  R.interact = interact;
  R.interactKey = key;
  R.interactText = interactText;
  R.reloadPrompt = reloadPrompt;
}

function buildFeed(host) {
  const feed = h('div', 'killfeed');
  feed.id = 'killfeed';
  feed.setAttribute('aria-live', 'polite');
  const banner = h('div', 'phase-banner hidden');
  banner.id = 'phase-banner';
  const bannerTitle = h('b', 'banner-title', '');
  const bannerSub = h('small', 'banner-sub muted', '');
  banner.append(bannerTitle, bannerSub);
  const toastBox = h('div', 'hud-toast');
  toastBox.id = 'hud-toast';
  toastBox.setAttribute('aria-live', 'polite');
  const chat = h('div', 'chat-panel hidden');
  chat.id = 'chat-panel';
  const chatLog = h('div', 'chat-log');
  const chatForm = h('form', 'chat-form');
  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.id = 'chat-input';
  chatInput.maxLength = 80;
  chatInput.placeholder = '按 Enter 发送消息 / 队伍频道';
  chatInput.setAttribute('aria-label', '聊天输入');
  // 触屏软键盘把回车键标成「发送」，避免玩家在小键盘上找不到发送方式
  chatInput.setAttribute('enterkeyhint', 'send');
  chatInput.setAttribute('autocomplete', 'off');
  chatForm.append(chatInput);
  chatForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = chatInput.value.trim().slice(0, 80);
    if (text) {
      // main.js 的 app.sendChat 负责区分联机/离线：联机上行到服务器，离线写本地系统消息。
      // 只有 main 完全没提供时才退回裸 socket（历史上离线时这里静默丢弃）。
      try {
        const handled = app?.sendChat?.(text);
        if (!handled) app?.net?.send?.({ type: 'chat', text, channel: 'team' });
      } catch { /* 忽略 */ }
      chatInput.value = '';
    }
    chat.classList.add('hidden');
  });
  chat.append(chatLog, chatForm);
  host.append(feed, banner, toastBox, chat);
  R.feed = feed;
  R.banner = banner;
  R.bannerTitle = bannerTitle;
  R.bannerSub = bannerSub;
  // 空降状态条（仅 skydive）：高度 + 阶段 + 可跳倒计时。放在横幅下方。
  const deploy = h('div', 'hud-deploy hidden');
  deploy.id = 'deploy-status';
  deploy.setAttribute('role', 'status');
  deploy.setAttribute('aria-live', 'polite');
  const deployStage = h('span', 'deploy-stage');
  deployStage.id = 'deploy-stage';
  const deployAlt = h('span', 'deploy-alt');
  deployAlt.id = 'deploy-alt';
  const deployBar = h('div', 'deploy-progress');
  const deployFill = h('i');
  deployBar.append(deployFill);
  deploy.append(deployStage, deployAlt, deployBar);
  host.append(deploy);
  R.deploy = deploy;
  R.deployStage = deployStage;
  R.deployAlt = deployAlt;
  R.deployFill = deployFill;
  R.toastBox = toastBox;
  R.chat = chat;
  R.chatLog = chatLog;
  R.chatInput = chatInput;
}

// ── 05 · 触屏控制层 ─────────────────────────────────────────────────────────
const ACTION_DEFS = [
  { id: 'reload-action', label: '换弹', icon: 'reload', action: 'reload', keyHint: 'R' },
  { id: 'heal-action', label: '治疗', icon: 'heal', action: 'heal', keyHint: 'H' },
  { id: 'interact-action', label: '交互', icon: 'hand', action: 'interact', keyHint: 'E' },
  { id: 'throw-action', label: '投掷', icon: 'fire', action: 'throwable', keyHint: 'G' },
  { id: 'swap-action', label: '切枪', icon: 'swap', action: 'swap', keyHint: 'Q' },
  { id: 'sprint-action', label: '冲刺', icon: 'run', action: 'sprint', keyHint: 'Shift' },
  { id: 'crouch-action', label: '蹲伏', icon: 'crouch', action: 'crouch', keyHint: 'Ctrl' },
  { id: 'dodge-action', label: '翻滚', icon: 'roll', action: 'dodge', keyHint: 'Space' },
  // 空降专用：在地面阶段隐藏（由 updateDeploy 控制），只在舱内/伞降时出现。
  { id: 'jump-action', label: '跳伞', icon: 'chute', action: 'jump', keyHint: 'Space' },
  { id: 'backpack-action', label: '背包', icon: 'bag', action: 'backpack', keyHint: 'B' },
  { id: 'ping-action', label: '标记', icon: 'ping', action: 'ping', keyHint: 'P' },
  // 触屏没有 Enter 键，聊天面板此前完全够不到（唯一入口是键盘 keydown）。
  { id: 'chat-action', label: '聊天', icon: 'chat', action: 'chat', keyHint: 'Enter' },
];

// 长按阈值：短按 = 扔当前投掷物，长按 = 切到下一个（与帮助面板文案一致）。
const THROW_HOLD_MS = 420;

function buildTouch(host) {
  const layer = h('div', 'touch-controls');
  layer.id = 'touch-controls';
  const move = h('div', 'joystick move-stick');
  move.id = 'move-stick';
  move.setAttribute('role', 'application');
  move.setAttribute('aria-label', '移动摇杆');
  const moveStick = h('span', 'stick');
  move.append(moveStick, h('small', 'stick-label', '移动'));
  const aim = h('div', 'joystick aim-stick');
  aim.id = 'aim-stick';
  aim.setAttribute('role', 'application');
  aim.setAttribute('aria-label', '瞄准与射击摇杆');
  const aimStick = h('span', 'stick');
  aim.append(aimStick, h('small', 'stick-label', '瞄准 / 开火'));
  const actions = h('div', 'action-buttons');
  actions.id = 'action-buttons';
  const buttons = {};
  for (const def of ACTION_DEFS) {
    const btn = h('button', 'touch-btn action-btn');
    btn.type = 'button';
    btn.id = def.id;
    btn.dataset.action = def.action;
    btn.setAttribute('aria-label', def.label);
    btn.title = `${def.label} (${def.keyHint})`;
    btn.append(icon(def.icon, 20), h('small', null, def.label));
    // 契约 §11：所有触屏交互元素点击区 ≥44px（样式表移动端断点会缩小，这里兜底）。
    btn.style.minWidth = '44px';
    btn.style.minHeight = '44px';
    bindActionButton(btn, def);
    actions.append(btn);
    buttons[def.action] = btn;
  }
  layer.append(move, aim, actions);
  host.append(layer);
  R.touch = layer;
  R.moveStick = move;
  R.moveStickInner = moveStick;
  R.aimStick = aim;
  R.aimStickInner = aimStick;
  R.actionButtons = buttons;
  bindJoystick(move, moveStick, 'move');
  bindJoystick(aim, aimStick, 'aim');
}

function bindActionButton(btn, def) {
  // 「投掷」按钮：短按 = 扔当前选中，长按 = 切换到下一个。
  // 历史实现是 press() 里先 cycleThrowable(1) 再立刻投掷 —— 手雷 3 / 烟雾 2 时
  // 点一下扔出去的是烟雾（切到下一个并立即扔），与帮助面板写的语义正好相反。
  // 因此投掷键必须在**松手**时才发 press，长按期间只切换选择。
  if (def.action === 'throwable') {
    let timer = 0;
    let longPressed = false;
    const start = event => {
      event.preventDefault();
      btn.classList.add('pressed');
      longPressed = false;
      timer = setTimeout(() => {
        longPressed = true;
        let kind = null;
        try { kind = app?.input?.cycleThrowable?.(1) || null; } catch { /* 忽略 */ }
        const name = THROWABLE_DEFS.find(d => d.kind === kind)?.label;
        hudToastEvent(app, name ? `已切换投掷物 · ${name}` : '已切换投掷物', 1200);
        if (navigator.vibrate && app?.settings?.haptics !== false) { try { navigator.vibrate(12); } catch { /* 忽略 */ } }
      }, THROW_HOLD_MS);
    };
    const end = () => {
      btn.classList.remove('pressed');
      if (timer) { clearTimeout(timer); timer = 0; }
      if (!longPressed) {
        try { app?.input?.press?.('throw'); } catch { /* 忽略 */ }
        if (navigator.vibrate && app?.settings?.haptics !== false) { try { navigator.vibrate(8); } catch { /* 忽略 */ } }
      }
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('pointerleave', end);
    btn.addEventListener('contextmenu', event => event.preventDefault());
    return;
  }
  // 背包 / 聊天是面板开关，不产生玩法输入（input.js 里没有对应消费者）。
  if (def.action === 'backpack') {
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', event => {
      event.preventDefault();
      if (!toggleInventoryPanel()) {
        hudToastEvent(app, '背包暂不可用', 1600);
      }
      if (navigator.vibrate && app?.settings?.haptics !== false) { try { navigator.vibrate(8); } catch { /* 忽略 */ } }
    });
    return;
  }
  if (def.action === 'chat') {
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', event => {
      event.preventDefault();
      openChat();
    });
    return;
  }
  const press = event => {
    event.preventDefault();
    btn.classList.add('pressed');
    try { app?.input?.press?.(def.action); } catch { /* 忽略 */ }
    try { app?.input?.hold?.(def.action, true); } catch { /* 忽略 */ }
    if (navigator.vibrate && app?.settings?.haptics !== false) { try { navigator.vibrate(8); } catch { /* 忽略 */ } }
  };
  const release = () => {
    btn.classList.remove('pressed');
    try { app?.input?.hold?.(def.action, false); } catch { /* 忽略 */ }
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('contextmenu', event => event.preventDefault());
}

// 摇杆：状态写入 app.input 的虚拟轴；输入层（feel）读取 app.hud.sticks
function bindJoystick(root, inner, kind) {
  const state = { id: null, x: 0, y: 0 };
  const radius = () => Math.max(36, (root.getBoundingClientRect().width || 128) * 0.34);
  const update = event => {
    if (state.id !== event.pointerId) return;
    const rect = root.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = event.clientX - cx;
    let dy = event.clientY - cy;
    const len = Math.hypot(dx, dy);
    const r = radius();
    if (len > r) { dx = (dx / len) * r; dy = (dy / len) * r; }
    state.x = dx / r;
    state.y = dy / r;
    inner.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    toggle(root, 'active', Math.hypot(state.x, state.y) > 0.06);
    syncStick(kind, state);
  };
  const start = event => {
    if (state.id !== null) return;
    event.preventDefault();
    state.id = event.pointerId;
    try { root.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    update(event);
  };
  const end = event => {
    if (state.id !== event.pointerId) return;
    state.id = null;
    state.x = 0;
    state.y = 0;
    inner.style.transform = '';
    root.classList.remove('active');
    syncStick(kind, state);
  };
  root.addEventListener('pointerdown', start);
  root.addEventListener('pointermove', update);
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('lostpointercapture', end);
  root.addEventListener('contextmenu', event => event.preventDefault());
  if (!R.stickState) R.stickState = {};
  R.stickState[kind] = state;
}

function syncStick(kind, state) {
  if (!app) return;
  if (!app.hud) app.hud = {};
  if (!app.hud.sticks) app.hud.sticks = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 } };
  const target = app.hud.sticks[kind] || (app.hud.sticks[kind] = { x: 0, y: 0 });
  target.x = state.x;
  target.y = state.y;
  target.mag = Math.hypot(state.x, state.y);
  try { app.input?.setStick?.(kind, state.x, state.y); } catch { /* 忽略 */ }
}

function emit(name, detail) {
  try { app?.emit?.(`hud:${name}`, detail); } catch { /* 忽略 */ }
  try { app?.input?.command?.(name); } catch { /* 忽略 */ }
}

/** 展开聊天输入框并聚焦（触屏「聊天」按钮 / 桌面 Enter 共用）。 */
function openChat() {
  if (!R.chat) return;
  R.chat.classList.remove('hidden');
  try { R.chatInput?.focus({ preventScroll: true }); } catch { /* 忽略 */ }
}

/** 背包面板由 ui-screens 提供（showModal + 焦点陷阱 + Esc），这里只做开关。 */
function isInventoryOpen() {
  return !!document.getElementById('inventory-dialog')?.classList.contains('open');
}
function toggleInventoryPanel() {
  if (!app?.ui) return false;
  if (isInventoryOpen()) { app.ui.hideInventory?.(); return false; }
  app.ui.showInventory?.();
  return true;
}
function useItem(item) {
  try { app?.input?.useItem?.(item); } catch { /* 忽略 */ }
  try { app?.emit?.('input:useItem', item); } catch { /* 忽略 */ }
  pulse(`consumable-${item}`);
}
function throwGrenade(kind) {
  try { app?.input?.throwable?.(kind); } catch { /* 忽略 */ }
  try { app?.emit?.('input:throwable', kind); } catch { /* 忽略 */ }
  pulse('throw-action');
}
function swapWeapon(slot) {
  try { app?.input?.swap?.(slot); } catch { /* 忽略 */ }
  try { app?.emit?.('input:swap', slot); } catch { /* 忽略 */ }
  pulse('swap-action');
}
function pulse(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.add('pulsed');
  setTimeout(() => node.classList.remove('pulsed'), 180);
}

// ── 06 · 记分板 / 波次面板 / 观战条 / 全图弹窗 ──────────────────────────────
function buildExtras(host) {
  const board = h('div', 'scoreboard hidden');
  board.id = 'scoreboard';
  board.setAttribute('role', 'table');
  board.setAttribute('aria-label', '记分板');
  const boardHead = h('div', 'scoreboard-head');
  boardHead.append(h('b', null, '记分板'), h('span', 'spacer'), h('small', 'muted', 'Tab 关闭'));
  const boardBody = h('div', 'scoreboard-body');
  board.append(boardHead, boardBody);
  const horde = h('div', 'horde-panel hud-panel hidden');
  horde.id = 'horde-panel';
  const hordeHead = h('div', 'horde-head');
  // 初始文案曾硬编码「波次 1 / 10」「基地 600 / 600」，与 shared/rules.mjs 的
  // HORDE（20 波 / 基地 800）不符 —— 开局前 100ms 内玩家看到的是错的数字。
  hordeHead.append(icon('wave', 15), h('b', null, `波次 1 / ${HORDE.waves}`), h('span', 'spacer'), h('small', 'muted', '准备中'));
  const baseTrack = h('div', 'base-track');
  const baseFill = h('i');
  baseTrack.append(baseFill);
  const hordeInfo = h('div', 'horde-info');
  hordeInfo.append(h('small', 'muted', `基地 ${HORDE.baseHp} / ${HORDE.baseHp}`), h('small', 'muted', '剩余 0'));
  horde.append(hordeHead, baseTrack, hordeInfo);
  const spectate = h('div', 'spectate-bar hidden');
  spectate.id = 'spectate-bar';
  spectate.append(h('small', 'muted', '你已淘汰 · 正在观战'), h('span', 'spacer'), h('small', 'muted', '按 Tab 查看记分板'));
  host.append(board, horde, spectate);
  R.scoreboard = board;
  R.scoreboardBody = boardBody;
  R.horde = horde;
  R.hordeHead = hordeHead.querySelector('b');
  R.hordeStatus = hordeHead.querySelector('small');
  R.baseFill = baseFill;
  R.hordeInfo = hordeInfo;
  R.spectate = spectate;
}

function toggleScoreboard(force) {
  if (!R.scoreboard) return;
  const next = force === undefined ? R.scoreboard.classList.contains('hidden') : !!force;
  R.scoreboard.classList.toggle('hidden', !next);
  if (next) renderScoreboard();
}

function buildFullMapModal() {
  const node = h('div', 'modal');
  node.id = 'fullmap-dialog';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  node.style.pointerEvents = 'auto';
  const backdrop = h('div', 'modal-backdrop');
  backdrop.addEventListener('click', () => hideFullMap());
  const card = h('div', 'modal-card modal-wide');
  const close = h('button', 'modal-close');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭地图');
  close.append(icon('close', 18));
  close.addEventListener('click', () => hideFullMap());
  const head = h('div', 'modal-head');
  head.append(h('div', 'eyebrow', 'TACTICAL MAP'), h('h2', 'modal-title', '战场全图'));
  const body = h('div', 'modal-body fullmap-body');
  const canvas = document.createElement('canvas');
  // 与 ui-screens 的「图鉴 · 地图全图」(#fullmap-canvas) 区分：两个弹窗同屏时
  // 过去会出现两个同 id 的 canvas，getElementById 只能拿到先出现的那个。
  canvas.id = 'hud-fullmap-canvas';
  canvas.width = 720;
  canvas.height = 720;
  canvas.className = 'fullmap-canvas';
  canvas.setAttribute('aria-label', '战场全图');
  body.append(canvas);
  const actions = h('div', 'modal-actions');
  const btn = h('button', 'btn btn-primary', '关闭');
  btn.type = 'button';
  btn.addEventListener('click', () => hideFullMap());
  actions.append(btn);
  card.append(close, head, body, actions);
  node.append(backdrop, card);
  document.getElementById('dialog-root')?.append(node);
  R.fullmap = node;
  R.fullmapCanvas = canvas;
}

export function showFullMap() {
  if (!R.fullmap) buildFullMapModal();
  R.fullmap?.classList.add('open');
  R.fullmap?.setAttribute('open', '');
  const state = app?.state;
  const me = selfPlayer(state);
  if (R.fullmapCanvas) drawFullMap(R.fullmapCanvas, state, me);
}
export function hideFullMap() {
  R.fullmap?.classList.remove('open');
  R.fullmap?.removeAttribute('open');
}
export function isFullMapOpen() { return !!R.fullmap?.classList.contains('open'); }

// ── 07 · 小地图绘制 ─────────────────────────────────────────────────────────
function mapDef() {
  const maps = app?.data?.maps || null;
  return maps?.[app?.mapId || app?.state?.mapId] || null;
}
function mapRadius() {
  return mapDef()?.radius || app?.state?.mapRadius || 182;
}

/**
 * 绘制小地图（也可被外部以任意 canvas 调用）。
 * @param {HTMLCanvasElement} canvas
 * @param {object} state snapshot
 * @param {object} me 本机玩家
 */
export function drawMinimap(canvas, state, me) {
  if (!canvas || !state) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const radius = mapRadius();
  const scale = (size * 0.92) / (radius * 2 + 20);
  const cx = size / 2;
  const cy = size / 2;
  const pt = (x, z) => [cx + (Number(x) || 0) * scale, cy + (Number(z) || 0) * scale];
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(3,12,13,0.86)';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
  ctx.clip();
  const theme = mapDef()?.theme || {};
  const toHex = (n, fallback) => `#${(Number(n) || fallback).toString(16).padStart(6, '0')}`;
  ctx.fillStyle = toHex(theme.grass, 0x2c4a3f);
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(111,224,200,0.1)';
  ctx.lineWidth = 1;
  const gridStep = Math.max(24, Math.round(radius / 4) * scale);
  for (let g = cx % gridStep; g < size; g += gridStep) {
    ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, size); ctx.stroke();
  }
  for (let g = cy % gridStep; g < size; g += gridStep) {
    ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(size, g); ctx.stroke();
  }
  const def = mapDef();
  for (const road of def?.roads || []) {
    const [x, y] = pt(road.x || 0, road.z || 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-(road.rot || 0));
    ctx.fillStyle = 'rgba(206,214,198,0.22)';
    ctx.fillRect(-((road.w || 6) * scale) / 2, -((road.d || 100) * scale) / 2, (road.w || 6) * scale, (road.d || 100) * scale);
    ctx.restore();
  }
  for (const region of def?.regions || []) {
    const [x, y] = pt(region.x, region.z);
    const r = Math.max(2, (region.r || 30) * scale);
    ctx.fillStyle = region.tier >= 3 ? 'rgba(245,180,69,0.1)' : 'rgba(111,224,200,0.06)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // 安全区与下一个圈
  const zone = state.zone;
  if (zone) {
    if (Number.isFinite(zone.target?.r)) {
      const [tx, ty] = pt(zone.target.x, zone.target.z);
      ctx.strokeStyle = 'rgba(245,180,69,0.65)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(tx, ty, Math.max(2, zone.target.r * scale), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    const [zx, zy] = pt(zone.x, zone.z);
    ctx.strokeStyle = zone.closing ? 'rgba(255,150,90,0.95)' : 'rgba(111,224,200,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(zx, zy, Math.max(3, (zone.r || 0) * scale), 0, Math.PI * 2); ctx.stroke();

    // 缩圈方向指示：人在圈外（红）或正在缩圈（琥珀）时，在自身旁画一枚指向圈心的箭头
    if (me && Number.isFinite(me.x) && Number.isFinite(me.z)) {
      const outside = Math.hypot(me.x - (zone.x || 0), me.z - (zone.z || 0)) > (zone.r || 0);
      if (outside || zone.closing) {
        const goalX = zone.closing && zone.target ? (zone.target.x ?? zone.x) : zone.x;
        const goalZ = zone.closing && zone.target ? (zone.target.z ?? zone.z) : zone.z;
        const [mx, my] = pt(me.x, me.z);
        const [gx, gy] = pt(goalX, goalZ);
        const ang = Math.atan2(gy - my, gx - mx);
        const near = Math.min(22, Math.max(12, Math.hypot(gx - mx, gy - my) * 0.4));
        ctx.save();
        ctx.translate(mx + Math.cos(ang) * near, my + Math.sin(ang) * near);
        ctx.rotate(ang);
        ctx.fillStyle = outside ? 'rgba(255,92,92,0.95)' : 'rgba(245,180,69,0.92)';
        ctx.strokeStyle = 'rgba(5,15,16,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(7, 0);
        ctx.lineTo(-4, 4.6);
        ctx.lineTo(-1.6, 0);
        ctx.lineTo(-4, -4.6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // 标记、空投、载具、队友
  for (const ping of state.pings || []) {
    const [x, y] = pt(ping.x, ping.z);
    ctx.fillStyle = ping.kind === 'enemy' ? '#ff5c5c' : ping.kind === 'help' ? '#f5b445' : '#6fe0c8';
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  for (const drop of state.drops || []) {
    if (drop.opened) continue;
    const [x, y] = pt(drop.x, drop.z);
    ctx.strokeStyle = '#f5b445';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 4, y - 4, 8, 8);
  }
  for (const marker of state.markers || []) {
    const [x, y] = pt(marker.x, marker.z);
    ctx.fillStyle = marker.kind === 'boss' ? '#ff5c5c' : '#c07cff';
    ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
  }
  for (const car of state.cars || []) {
    if ((car.hp ?? 1) <= 0) continue;
    const [x, y] = pt(car.x, car.z);
    ctx.fillStyle = '#e2bb5b';
    ctx.fillRect(x - 1.6, y - 1.6, 3.2, 3.2);
  }
  const myTeam = me?.team;
  for (const mate of state.teammates || state.players || []) {
    if (!mate || mate.id === me?.id) continue;
    if (myTeam !== undefined && mate.team !== myTeam && !state.teammates) continue;
    if (mate.alive === false) continue;
    const [x, y] = pt(mate.x, mate.z);
    ctx.fillStyle = mate.downed ? '#ff9a5c' : '#8ef0c4';
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
  }
  // 自己
  if (me) {
    const [x, y] = pt(me.x, me.z);
    const angle = Number(me.angle) || 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-angle);
    ctx.fillStyle = me.downed ? '#ff9a5c' : '#ffe09b';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(-4.2, 4.4);
    ctx.lineTo(0, 2.4);
    ctx.lineTo(4.2, 4.4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(5,20,20,0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    // 视野扇形
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-angle);
    ctx.fillStyle = 'rgba(255,224,155,0.14)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, size * 0.22, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // 边框
  ctx.strokeStyle = 'rgba(111,224,200,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
}

/**
 * 绘制全图（含自身移动路径）。
 */
export function drawFullMap(canvas, state, me) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = canvas.width;
  const radius = mapRadius();
  const scale = (size * 0.9) / (radius * 2 + 24);
  const cx = size / 2;
  const cy = size / 2;
  const pt = (x, z) => [cx + (Number(x) || 0) * scale, cy + (Number(z) || 0) * scale];
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#071617';
  ctx.fillRect(0, 0, size, size);
  const def = mapDef();
  const theme = def?.theme || {};
  const toHex = (n, fallback) => `#${(Number(n) || fallback).toString(16).padStart(6, '0')}`;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = toHex(theme.grass, 0x2c4a3f);
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = toHex(theme.sand, 0x5a5a46);
  ctx.globalAlpha = 0.25;
  ctx.beginPath(); ctx.arc(cx, cy, radius * scale * 0.96, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  for (const road of def?.roads || []) {
    const [x, y] = pt(road.x || 0, road.z || 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-(road.rot || 0));
    ctx.fillStyle = road.kind === 'rail' ? 'rgba(170,190,200,0.35)' : 'rgba(212,216,196,0.24)';
    ctx.fillRect(-((road.w || 6) * scale) / 2, -((road.d || 100) * scale) / 2, (road.w || 6) * scale, (road.d || 100) * scale);
    ctx.restore();
  }
  for (const region of def?.regions || []) {
    const [x, y] = pt(region.x, region.z);
    const r = Math.max(10, (region.r || 30) * scale);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(245,180,69,${0.05 + (region.tier || 1) * 0.045})`);
    grad.addColorStop(1, 'rgba(245,180,69,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(234,246,241,0.85)';
    ctx.font = '600 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(region.name, x, y);
    ctx.fillStyle = 'rgba(154,168,164,0.6)';
    ctx.font = '11px monospace';
    ctx.fillText(`T${region.tier || 1}`, x, y + 15);
  }
  for (const landmark of def?.landmarks || []) {
    const [x, y] = pt(landmark.x, landmark.z);
    ctx.strokeStyle = 'rgba(245,180,69,0.6)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(245,180,69,0.85)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(landmark.name || '', x + 11, y + 4);
  }
  ctx.restore();

  if (state?.zone) {
    const zone = state.zone;
    if (Number.isFinite(zone.target?.r)) {
      const [tx, ty] = pt(zone.target.x, zone.target.z);
      ctx.strokeStyle = 'rgba(245,180,69,0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath(); ctx.arc(tx, ty, Math.max(4, zone.target.r * scale), 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    const [zx, zy] = pt(zone.x, zone.z);
    ctx.strokeStyle = zone.closing ? 'rgba(255,150,90,0.95)' : 'rgba(111,224,200,0.9)';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(zx, zy, Math.max(6, (zone.r || 0) * scale), 0, Math.PI * 2); ctx.stroke();
  }

  // 自身路径（app.hud.path 由 main 每 0.5s 推入）
  const path = app?.hud?.path;
  if (Array.isArray(path) && path.length > 1) {
    ctx.strokeStyle = 'rgba(255,224,155,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    path.forEach(([px, pz], index) => {
      const [x, y] = pt(px, pz);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // 玩家、队友、标记、空投、载具
  const meId = me?.id;
  for (const car of state?.cars || []) {
    if ((car.hp ?? 1) <= 0) continue;
    const [x, y] = pt(car.x, car.z);
    ctx.fillStyle = '#e2bb5b';
    ctx.fillRect(x - 2.4, y - 2.4, 4.8, 4.8);
  }
  for (const drop of state?.drops || []) {
    if (drop.opened) continue;
    const [x, y] = pt(drop.x, drop.z);
    ctx.strokeStyle = '#f5b445';
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 6, y - 6, 12, 12);
  }
  for (const marker of state?.markers || []) {
    const [x, y] = pt(marker.x, marker.z);
    ctx.fillStyle = marker.kind === 'boss' ? '#ff5c5c' : '#c07cff';
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
  }
  for (const ping of state?.pings || []) {
    const [x, y] = pt(ping.x, ping.z);
    ctx.fillStyle = ping.kind === 'enemy' ? '#ff5c5c' : ping.kind === 'help' ? '#f5b445' : '#6fe0c8';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }
  for (const mate of state?.teammates || state?.players || []) {
    if (!mate || mate.id === meId) continue;
    if (state?.teammates && me?.team !== undefined && mate.team !== undefined && mate.team !== me.team) continue;
    if (mate.alive === false) continue;
    const [x, y] = pt(mate.x, mate.z);
    ctx.fillStyle = mate.downed ? '#ff9a5c' : '#8ef0c4';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(234,246,241,0.85)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(mate.name || '').slice(0, 8), x, y - 8);
  }
  if (me) {
    const [x, y] = pt(me.x, me.z);
    const angle = Number(me.angle) || 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-angle);
    ctx.fillStyle = '#ffe09b';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(-7, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(5,20,20,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(111,224,200,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2); ctx.stroke();
  // 比例尺
  ctx.fillStyle = 'rgba(154,168,164,0.75)';
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('100 m', 18, size - 18);
  ctx.fillRect(18, size - 32, 100 * scale, 3);
}

// ── 08 · 每帧更新 ───────────────────────────────────────────────────────────
function updateTop(state, me, now) {
  if (now - last.text < TEXT_MS) return;
  last.text = now;
  const counts = state.counts || {};
  const aliveValue = state.mode === 'solo' ? (counts.alive ?? 0) : (counts.aliveTeams ?? counts.teams ?? 0);
  if (aliveValue !== last.alive) {
    last.alive = aliveValue;
    setText(R.alive, aliveValue);
    setText(R.aliveSub, state.mode === 'solo' ? '人' : '队');
  }
  const kills = Number(me?.kills ?? 0);
  if (kills !== last.kills) { last.kills = kills; setText(R.kills, kills); }

  const zone = state.zone;
  let zoneLabel = '安全区稳定';
  let danger = false;
  // 空降阶段不显示圈外警告：玩家在飞机/伞上无法自由移动，圈也还没开始缩
  // （服务端 _applyZoneDamage 在 deploying 直接 return）。显示「圈外 0 点伤害」
  // 只会让人以为掉血了。
  const deploying = state.phase === 'deploying' && me?.deployStage && me.deployStage !== 'ground';
  if (zone && !deploying) {
    const dist = me ? Math.hypot((me.x || 0) - zone.x, (me.z || 0) - zone.z) : 0;
    const outside = me && dist > (zone.r || 0);
    danger = !!outside;
    if (outside) zoneLabel = `圈外 · 每秒 ${Math.round(zone.damage || 0)} 点伤害`;
    else if (zone.closing) zoneLabel = `安全区收缩中 · ${Math.max(0, Math.ceil(zone.nextIn || 0))}s`;
    else zoneLabel = `安全区稳定 · ${Math.max(0, Math.ceil(zone.nextIn || 0))}s`;
  } else if (deploying) {
    zoneLabel = '空降中 · 安全区待开启';
  }
  if (zoneLabel !== last.zone) { last.zone = zoneLabel; setText(R.zoneText, zoneLabel); }
  toggle(R.zone, 'danger', danger);
  toggle(R.zone, 'closing', !!zone?.closing);

  const phase = Number(zone?.phase || 1);
  const stageKey = `${phase}|${Math.ceil(zone?.nextIn ?? -1)}`;
  if (stageKey !== last.stage) {
    last.stage = stageKey;
    setText(R.stagePhase, `阶段 ${phase}`);
    setText(R.stageTimer, R.stageTimer && Number.isFinite(zone?.nextIn) ? fmtTime(zone.nextIn) : '--:--');
    toggle(R.stage, 'closing', !!zone?.closing);
  }
  if (R.mapName) {
    const name = state.mapName || mapDef()?.name || '战场';
    if (R.mapName.textContent !== name) setText(R.mapName, name);
  }
  const weather = state.weather || mapDef()?.weather;
  const WEATHER_NAMES = { clear: '晴朗', rain: '阵雨', fog: '浓雾', sandstorm: '沙暴', snow: '落雪' };
  const WEATHER_ICONS = { clear: '☀', rain: '☂', fog: '≋', sandstorm: '≋', snow: '❄' };
  if (weather && R.weatherText && R.weatherText.textContent !== (WEATHER_NAMES[weather] || weather)) {
    setText(R.weatherText, WEATHER_NAMES[weather] || weather);
    setText(R.weatherIcon, WEATHER_ICONS[weather] || '☀');
  }
  if (R.net) {
    const offline = app?.offline === true;
    const ping = app?.socketInfo?.ping;
    const code = app?.socketInfo?.code;
    const label = offline ? '离线训练' : code ? `房间 ${code} · ${Number.isFinite(ping) ? `${ping}ms` : '--'}` : '联机';
    setText(R.net, label);
  }
  const showFps = app?.settings?.showFps && Number.isFinite(app.fps);
  if (R.fps) {
    if (showFps) {
      const value = `${Math.round(app.fps)} FPS`;
      if (R.fps.textContent !== value) setText(R.fps, value);
      R.fps.style.display = '';
    } else R.fps.style.display = 'none';
  }
}

function updateHealth(state, me) {
  if (!R.healthPanel) return;
  const hp = clamp(me?.hp ?? 0, 0, 100);
  const armor = clamp(me?.armor ?? 0, 0, 150);
  const shield = clamp(me?.shield ?? 0, 0, 100);
  const stamina = clamp(me?.stamina ?? 100, 0, 100);
  if (hp !== last.hp) { last.hp = hp; setStyle(R.hpBar, 'width', `${hp}%`); }
  if (armor !== last.armor) { last.armor = armor; setStyle(R.armorBar, 'width', `${(armor / 150) * 100}%`); }
  if (shield !== last.shield) { last.shield = shield; setStyle(R.shieldBar, 'width', `${shield}%`); }
  if (stamina !== last.stamina) { last.stamina = stamina; setStyle(R.staminaBar, 'width', `${stamina}%`); }
  const downed = !!me?.downed;
  toggle(R.healthPanel, 'downed', downed);
  toggle(R.healthPanel, 'critical', !downed && hp <= 30);
  if (!me) return;
  const now = performance.now();
  if (now - (updateHealth._at || 0) < TEXT_MS) return;
  updateHealth._at = now;
  const bleed = Math.max(0, Math.ceil(me.bleedout ?? 0));
  setText(R.hpText, downed ? `${bleed}s` : Math.ceil(hp));
  setText(R.shieldText, shield > 0 ? `+${Math.ceil(shield)}` : '');
  setText(R.playerName, me.name || '旅人');
  let statusText = '';
  if (!me.alive) statusText = '已淘汰 · 观战模式';
  else if (downed) statusText = `倒地 · ${bleed} 秒后淘汰 · 等待队友救援`;
  else if (me.reviveTarget) statusText = '正在救援队友';
  else if (me.healTime > 0) statusText = `治疗中 · ${Number(me.healTime).toFixed(1)}s`;
  else if (me.reloadTime > 0) statusText = `换弹中 · ${Number(me.reloadTime).toFixed(1)}s`;
  else if (me.state === 'sprint') statusText = '冲刺中';
  else if (me.state === 'vehicle') statusText = '载具中';
  else if (armor <= 0 && shield <= 0) statusText = '无防护 · 优先寻找护甲';
  else if (hp <= 40) statusText = '生命值偏低 · 寻找掩体';
  else statusText = '状态良好';
  if (statusText !== last.state) { last.state = statusText; setText(R.stateText, statusText); }
  // 消耗品数量
  if (R.consumableButtons) {
    for (const def of CONSUMABLE_DEFS) {
      const entry = R.consumableButtons[def.key];
      if (!entry) continue;
      const count = Number(me[def.key] ?? 0);
      setText(entry.count, count);
      toggle(entry.btn, 'empty', count <= 0);
    }
  }
}

function updateWeapon(state, me) {
  if (!R.weaponPanel || !me) return;
  const info = weaponInfo(me.weapon);
  const weaponName = info.name;
  const rarity = info.rarity;
  const nameKey = `${me.weapon}|${rarity}`;
  if (nameKey !== last.weapon) {
    last.weapon = nameKey;
    setText(R.weaponName, weaponName);
    setText(R.weaponRarity, rarityName(rarity));
    if (R.weaponRarity) {
      R.weaponRarity.className = `weapon-rarity ${rarityClass(rarity)}`;
      R.weaponRarity.style.color = rarityColor(rarity);
    }
  }
  const ammo = Number(me.ammo ?? 0);
  const reserve = Number(me.reserve ?? 0);
  if (`${ammo}` !== last.ammo) { last.ammo = `${ammo}`; setText(R.ammo, ammo); }
  if (`${reserve}` !== last.reserve) { last.reserve = `${reserve}`; setText(R.reserve, reserve); }
  // 低弹药（琥珀）/ 空弹匣（红色闪烁）警告：20% 弹匣与 0 两档
  toggle(R.ammo, 'low', ammo > 0 && ammo <= Math.max(1, Math.round((info.magazine || 10) * 0.2)));
  toggle(R.ammo, 'empty', ammo <= 0);
  toggle(R.weaponPanel, 'dry', ammo <= 0 && reserve <= 0);
  const reloading = Number(me.reloadTime) > 0;
  toggle(R.reloadWrap, 'active', reloading);
  if (reloading) {
    const total = Number(info.reload) || 1.6;
    const pct = clamp(1 - Number(me.reloadTime) / total, 0, 1) * 100;
    setStyle(R.reloadFill, 'width', `${pct.toFixed(1)}%`);
    toggle(R.reloadPrompt, 'hidden', true);
  } else {
    setStyle(R.reloadFill, 'width', '0%');
    toggle(R.reloadPrompt, 'hidden', ammo > 0 || reserve <= 0);
  }
  setText(R.ammoType, info.ammo || '');
  if (R.slotPrimary && R.slotSecondary) {
    const activeSlot = Number(me.slot ?? 0);
    toggle(R.slotPrimary, 'active', activeSlot === 0);
    toggle(R.slotSecondary, 'active', activeSlot === 1);
  }
  if (R.throwButtons) {
    for (const def2 of THROWABLE_DEFS) {
      const entry = R.throwButtons[def2.key];
      if (!entry) continue;
      const count = Number(me[def2.key] ?? 0);
      setText(entry.count, count);
      toggle(entry.btn, 'empty', count <= 0);
    }
  }
}

function updateSquad(state, me, now) {
  if (!R.squadList) return;
  if (now - last.squad < SQUAD_MS) return;
  last.squad = now;
  const teammates = state.teammates || state.players?.filter(p => me && p.team === me.team) || [];
  const signature = teammates.map(p => `${p.id}:${p.alive ? 1 : 0}${p.downed ? 1 : 0}:${Math.ceil(p.hp ?? 0)}:${Math.ceil(p.bleedout ?? 0)}:${Math.round((p.reviveProgress || 0) * 10)}:${p.car || ''}:${p.connected === false ? 0 : 1}`).join('|');
  if (signature === last.squadSig) return;
  last.squadSig = signature;
  const aliveCount = teammates.filter(p => p.alive).length;
  setText(R.squadCount, `${aliveCount} / ${teammates.length || 4}`);
  const squadName = teammates.find(p => p.teamName)?.teamName || me?.teamName || '小队';
  setText(R.squadName, squadName);
  const seen = new Set();
  for (const mate of teammates) {
    seen.add(mate.id);
    let row = R.squadRows.get(mate.id);
    if (!row) {
      const el = h('div', 'squad-member');
      const dot = h('i', 'member-dot');
      const name = h('b', 'member-name');
      const info = h('small', 'member-info muted');
      const reviveBar = h('div', 'revive-bar');
      const reviveFill = h('i');
      reviveBar.append(reviveFill);
      el.append(dot, name, info, reviveBar);
      R.squadList.append(el);
      row = { el, name, info, reviveBar, reviveFill, dot };
      R.squadRows.set(mate.id, row);
    }
    const isSelf = mate.id === me?.id;
    toggle(row.el, 'self', isSelf);
    toggle(row.el, 'downed', !!mate.downed);
    toggle(row.el, 'eliminated', mate.alive === false);
    toggle(row.el, 'offline', mate.connected === false);
    setText(row.name, String(mate.name || '队友').slice(0, 10));
    const bits = [];
    if (mate.alive === false) bits.push('已淘汰');
    else if (mate.downed) bits.push(`倒地 ${Math.ceil(mate.bleedout ?? 0)}s`);
    else if (mate.car) bits.push('载具');
    else if (mate.connected === false) bits.push('断线');
    else bits.push(`${Math.ceil(mate.hp ?? 0)} HP`);
    if (!isSelf && me && Number.isFinite(mate.x) && Number.isFinite(mate.z)) {
      const dist = Math.round(Math.hypot((mate.x || 0) - (me.x || 0), (mate.z || 0) - (me.z || 0)));
      if (mate.alive !== false) bits.push(`${dist}m`);
    }
    setText(row.info, bits.join(' · '));
    toggle(row.el, 'is-bot', mate.bot === true);
    const progress = Math.max(0, Math.min(1, Number(mate.reviveProgress || 0) / REVIVE_TIME));
    toggle(row.el, 'reviving', progress > 0 && mate.downed);
    if (row.reviveFill) setStyle(row.reviveFill, 'width', `${(progress * 100).toFixed(0)}%`);
  }
  for (const [id, row] of R.squadRows) {
    if (seen.has(id)) continue;
    row.el.remove();
    R.squadRows.delete(id);
  }
}

function updateCenter(state, me) {
  if (!R.healthPanel) return;
  const downed = !!me?.downed;
  toggle(R.revive, 'hidden', !downed);
  if (downed) {
    // 倒计时环：剩余 bleedout 占比（同时给出总秒数，避免读成“救援进度”）
    const remain = Math.max(0, Number(me.bleedout) || BLEEDOUT_TIME);
    const total = Math.max(remain, Number(me.bleedoutTotal) || BLEEDOUT_TIME);
    const pct = clamp(remain / total, 0, 1);
    setStyle(R.reviveRing, 'background', `conic-gradient(#ff9a5c ${(pct * 100).toFixed(0)}%, rgba(255,255,255,0.12) 0)`);
    setText(R.reviveText, `倒地 · ${Math.ceil(remain)} 秒后淘汰`);
  }
  const label = me?.interactLabel;
  if (label) {
    R.interact.classList.remove('hidden');
    const keyLabel = app?.touch ? '按住' : 'E';
    setText(R.interactKey, keyLabel);
    setText(R.interactText, label);
  } else if (app?.nearbyLabel) {
    R.interact.classList.remove('hidden');
    setText(R.interactKey, app?.touch ? '按住' : 'E');
    setText(R.interactText, app.nearbyLabel);
  } else {
    toggle(R.interact, 'hidden', true);
  }
  // 准星扩散（契约：me.spread 为当前散布角·弧度；me.accuracy 为相对精度 0.05–1）
  // 两者量纲不同，绝不能混用：spread 只用于几何张开度，accuracy 只用于视觉等级。
  const spreadRad = Number(me?.spread) || 0;
  const spreadPx = clamp(spreadRad * 1400, 6, 46); // 0.005rad→7px，0.03rad→42px
  const accuracy = Number(me?.accuracy);
  setStyle(R.crossRing, 'width', `${spreadPx.toFixed(0)}px`);
  setStyle(R.crossRing, 'height', `${spreadPx.toFixed(0)}px`);
  // 4 条刻线位移（如果样式表用 .cross-line，这里也一并驱动，缺失就跳过）
  if (R.crossLines?.length) {
    const gap = Math.round(spreadPx / 2 + 2);
    setStyle(R.crossLines[0], 'transform', `translate(-50%, -50%) translate(0, ${-gap}px)`);
    setStyle(R.crossLines[1], 'transform', `translate(-50%, -50%) translate(0, ${gap}px)`);
    setStyle(R.crossLines[2], 'transform', `translate(-50%, -50%) translate(${-gap}px, 0)`);
    setStyle(R.crossLines[3], 'transform', `translate(-50%, -50%) translate(${gap}px, 0)`);
  }
  toggle(R.crosshair, 'wide', Number.isFinite(accuracy) && accuracy < 0.4);
  toggle(R.crosshair, 'tight', Number.isFinite(accuracy) && accuracy > 0.85);
  toggle(R.crosshair, 'downed', downed);
  toggle(R.crosshair, 'hidden', me?.alive === false || !!me?.car || me?.state === 'vehicle');
  // 受击方向
  updateDamageDirs(state, me);
}

let damageUntil = 0;
let lastHpSeen = null;
function updateDamageDirs(state, me) {
  if (!me) return;
  const hpNow = Number(me.hp ?? 0) + Number(me.armor ?? 0);
  const now = performance.now();
  if (lastHpSeen !== null && hpNow < lastHpSeen - 1) {
    damageUntil = now + 900;
    R.vignette?.classList.add('hit');
    spawnDamageArrow(me);
  }
  lastHpSeen = hpNow;
  if (now > damageUntil) R.vignette?.classList.remove('hit');
}

function spawnDamageArrow(me) {
  if (!R.damageDirs) return;
  if (R.damageDirs.children.length > 4) R.damageDirs.firstElementChild?.remove();
  const arrow = h('i', 'damage-dir');
  const angle = Number(app?.hud?.lastDamageAngle);
  arrow.style.transform = `rotate(${Number.isFinite(angle) ? angle : 0}deg)`;
  R.damageDirs.append(arrow);
  setTimeout(() => arrow.remove(), 1100);
}

// ── 09 · 事件、播报、横幅 ───────────────────────────────────────────────────
const PHASE_LABEL = { lobby: '等待开始', loading: '战场准备', deploying: '正在空降', playing: '战斗开始', ended: '本局结束' };
const DEPLOY_STAGE_LABEL = { plane: '舱内待命', freefall: '自由落体', chute: '伞降滑翔', ground: '已落地' };
function updateBanner(state) {
  if (!R.banner) return;
  const phase = state.phase;
  let title = '';
  let sub = '';
  if (phase === 'deploying') {
    // 空降的持续状态交给 #deploy-status（阶段/高度/倒计时）。
    // 中央横幅**不参与**空降播报：舱门开启改由 doorOpen 事件走 pushBanner()
    // （带 2 秒停留窗口）。这里曾经用「每帧比较 key + last.doorToast 标记」做一次性
    // 提示，实测只闪 16–26ms 就消失（下一帧 closeIn 变化 → key 变化 → 标题被置空），
    // 且 last.doorToast 只在 flight 键消失时才复位，重开一局后完全不再播报。
    title = ''; sub = '';
  }
  else if (phase === 'loading') { title = '战场准备'; sub = `已就绪 ${state.loading?.ready ?? 0} / ${state.loading?.total ?? '—'}`; }
  else if (state.horde?.prepTime > 0) { title = `第 ${state.horde.wave} 波`; sub = '准备阶段 · 布置防线'; }
  else if (phase === 'ended' && state.result) {
    const me = selfPlayer(state);
    const won = state.result.winnerTeam != null && me?.team === state.result.winnerTeam;
    title = won ? '胜利' : '战斗结束';
    sub = state.result.winnerName ? `${state.result.winnerName} 赢下本局` : '本局结束';
  }
  const key = `${title}|${sub}`;
  if (key !== last.banner) {
    last.banner = key;
    const show = !!title;
    toggle(R.banner, 'hidden', !show);
    if (show) {
      setText(R.bannerTitle, title);
      setText(R.bannerSub, sub);
      R.banner.classList.remove('show');
      void R.banner.offsetWidth;
      R.banner.classList.add('show');
    }
  }
}

/** 空降状态条：高度 / 阶段 / 可跳倒计时。instant 模式或已落地时整条隐藏。 */
function updateDeploy(state, me) {
  if (!R.deploy) return;
  const stage = me && me.deployStage;
  const flying = state.phase === 'deploying' && stage && stage !== 'ground';
  toggle(R.deploy, 'hidden', !flying);
  // 跳伞按钮只在「舱内且舱门开」时出现，避免玩家在地面/伞降时误触。
  if (R.actionButtons && R.actionButtons.jump) {
    const canJump = !!flying && stage === 'plane' && !!state.flight?.open;
    toggle(R.actionButtons.jump, 'hidden', !canJump);
    if (canJump) R.actionButtons.jump.classList.add('ready');
    else R.actionButtons.jump.classList.remove('ready');
  }
  if (!flying) return;
  const label = DEPLOY_STAGE_LABEL[stage] || '空降中';
  setText(R.deployStage, label);
  const y = Math.max(0, Math.round(me.y || 0));
  let right = `${y} m`;
  if (stage === 'plane' && state.flight?.open) right = `可跳 · ${Math.max(0, Math.ceil(state.flight.closeIn))}s`;
  else if (stage === 'plane') right = '舱门关闭中';
  setText(R.deployAlt, right);
  if (R.deployFill) {
    // 进度 = 高度比例（190 → 0），让玩家对「还有多久落地」有直觉
    const k = Math.max(0, Math.min(1, y / 190));
    R.deployFill.style.transform = `scaleX(${k.toFixed(3)})`;
  }
}

function updateHorde(state) {  if (!R.horde) return;
  const horde = state.horde;
  toggle(R.horde, 'hidden', !horde);
  if (!horde) return;
  const sig = `${horde.wave}|${horde.enemiesLeft}|${Math.ceil(horde.nextWaveIn ?? 0)}|${Math.ceil(horde.baseHp ?? 0)}`;
  if (sig === last.hordeSig) return;
  last.hordeSig = sig;
  setText(R.hordeHead, `波次 ${horde.wave} / ${horde.totalWaves}`);
  setText(R.hordeStatus, horde.prepTime > 0 ? `准备 ${Math.ceil(horde.prepTime)}s` : `剩余 ${horde.enemiesLeft} 个敌人`);
  const hp = clamp(horde.baseHp ?? 0, 0, horde.baseMaxHp || 1);
  setStyle(R.baseFill, 'width', `${((hp / (horde.baseMaxHp || 1)) * 100).toFixed(1)}%`);
  clear(R.hordeInfo);
  R.hordeInfo.append(h('small', 'muted', `基地 ${Math.ceil(hp)} / ${Math.ceil(horde.baseMaxHp || 0)}`), h('small', 'muted', `得分 ${horde.score ?? 0}`));
  if (horde.prepTime > 0) R.hordeStatus.textContent = `下一波 ${Math.ceil(horde.nextWaveIn ?? 0)}s`;
}

function processEvents(state) {
  const events = state.events || [];
  if (!events.length) return;
  const selfId = state.selfId || app?.selfId;
  for (const event of events) {
    if (event.id <= last.events) continue;
    last.events = Math.max(last.events, event.id ?? 0);
    trainingGuideEvent(event, selfId);
    switch (event.type) {
      case 'shot': {
        // 记录「谁最后用什么武器开火」→ kill feed 显示武器名
        if (event.weapon) { shotWeapon.set(event.player, event.weapon); mapCap(shotWeapon); }
        // 命中标记：hit 可能是布尔（现行模拟）也可能是目标 id（契约 §3.1），两者都兼容
        if (event.player === selfId && (!!event.hit || (event.hits || 0) > 0)) {
          showHitmarker((event.headshots || 0) > 0 || event.headshot === true ? 'headshot' : 'hit');
        }
        break;
      }
      case 'headshot': {
        // 要害命中（现行模拟的独立事件）：记录到目标身上，击杀播报据此加要害图标
        if (event.target) { headshotUntil.set(event.target, performance.now() + 2500); mapCap(headshotUntil); }
        if (event.player === selfId) showHitmarker('headshot');
        break;
      }
      case 'kill':
      case 'down': {
        hudKillfeed(event);
        // 现行模拟的击杀者字段是 by；契约写作 attacker —— 两者都认
        if ((event.attacker ?? event.by) === selfId) {
          if (event.type === 'kill') hudHit(app, { kind: 'kill', name: event.name });
          else showHitmarker('down');
        }
        break;
      }
      case 'revive':
        hudKillfeed(event);
        if (event.by === selfId) hudToastEvent(app, `已救起 ${event.name || '队友'}`, 1800);
        break;
      case 'hit':
        if (event.player === selfId) { showHitmarker(event.headshot ? 'headshot' : 'hit'); }
        break;
      case 'zone':
        pushBanner(`第 ${event.phase} 阶段`, '安全区开始收缩', 2200);
        break;
      // 空降：舱门开启/关闭走事件驱动的 pushBanner（带 2 秒停留），
      // 而不是塞进 updateBanner 的每帧状态比较 —— 后者实测只闪 16–26ms
      // 且重开一局后不再播报（详见 updateBanner 里的注释）。
      case 'doorOpen':
        pushBanner('舱门已开', '按空格离机 · 自己选落点', 2600);
        break;
      case 'doorClose':
        pushBanner('舱门已关', '未跳伞的队员被自动投放', 2200);
        break;
      case 'airdrop':
        pushBanner('空投补给', '地图上已标出落点', 2400);
        break;
      case 'wave':
        pushBanner(`第 ${event.wave} 波`, event.boss ? '首领来袭' : '敌人正在逼近', 2400);
        break;
      case 'boss':
        hudKillfeed({ type: 'boss', name: event.name, attackerName: '侵蚀' });
        pushBanner('首领出现', event.name || '潮汐之影', 3000);
        break;
      case 'explosion':
        if (Number.isFinite(event.x) && Number.isFinite(event.z)) flashExplosion(event);
        break;
      case 'levelup':
        hudToastEvent(app, `等级提升 · LV.${event.level}`, 2400);
        break;
      default:
        break;
    }
  }
}

let bannerTimer = 0;
// 客户端事件关联表：现行模拟的 kill 事件只带攻击者 id（by）不带武器名，
// 这里用最近的 shot/headshot 事件补齐 kill feed 的武器与要害标记。
const shotWeapon = new Map();
const headshotUntil = new Map();
function mapCap(map, cap = 64) {
  while (map.size > cap) map.delete(map.keys().next().value);
}
/** 从快照里按 id 找显示名（players / teammates / 自己兜底）。 */
function nameOf(id) {
  if (!id) return '';
  if (id === app?.selfId) return app?.me?.name || '你';
  const state = app?.state;
  const players = state?.players;
  if (players) { const p = players.find((q) => q.id === id); if (p) return p.name || id; }
  const mates = state?.teammates;
  if (mates) { const p = mates.find((q) => q.id === id); if (p) return p.name || id; }
  return '';
}
function pushBanner(title, sub, ms = 2000) {
  if (!R.banner) return;
  setText(R.bannerTitle, title);
  setText(R.bannerSub, sub || '');
  R.banner.classList.remove('hidden');
  R.banner.classList.remove('show');
  void R.banner.offsetWidth;
  R.banner.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { R.banner.classList.add('hidden'); R.banner.classList.remove('show'); last.banner = ''; }, ms);
}

function showHitmarker(kind) {
  if (!R.hitmarker) return;
  R.hitmarker.className = `hitmarker ${kind}`;
  R.hitmarker.classList.remove('show');
  void R.hitmarker.offsetWidth;
  R.hitmarker.classList.add('show');
  clearTimeout(showHitmarker._timer);
  showHitmarker._timer = setTimeout(() => R.hitmarker.classList.remove('show'), 260);
}

function flashExplosion(event) {
  const me = selfPlayer(app?.state);
  if (!me) return;
  const angle = Math.atan2(event.x - (me.x || 0), event.z - (me.z || 0));
  if (app) { app.hud = app.hud || {}; app.hud.lastDamageAngle = 180 - (angle * 180) / Math.PI; }
}

/** 击杀播报（供 main 直接调用）。行结构：[击杀者 b] [动作] [受害者] [武器] （要害加 .headshot 图标） */
export function hudKillfeed(event) {
  if (!R.feed || !event) return;
  const selfId = app?.selfId;
  const row = h('div', 'killfeed-row');
  if (event.type === 'revive') {
    row.classList.add('revive');
    row.append(h('span', 'feed-text',
      `${event.byName || nameOf(event.by) || '队友'} 救起了 ${event.name || nameOf(event.player) || '一名队友'}`));
  } else if (event.type === 'boss') {
    row.classList.add('boss');
    row.append(h('span', 'feed-text', `${event.name || '首领'} 出现`));
  } else if (event.type === 'down') {
    row.classList.add('down');
    const killer = event.attackerName || nameOf(event.attacker ?? event.by) || '风暴';
    const victim = event.name || nameOf(event.player) || '一名敌人';
    row.append(h('b', 'killer', killer), h('span', 'feed-text', '击倒了'), h('span', 'victim', victim));
    if ((event.attacker ?? event.by) === selfId) row.classList.add('mine');
    if (event.player === selfId) row.classList.add('you');
  } else {
    // kill（含空投等无主击杀 → 风暴）
    row.classList.add('kill');
    const killer = event.attackerName || nameOf(event.attacker ?? event.by) || '风暴';
    const victim = event.name || nameOf(event.player) || '一名敌人';
    row.append(h('b', 'killer', killer), h('span', 'feed-text', '淘汰了'), h('span', 'victim', victim));
    const weapon = event.weapon || shotWeapon.get(event.attacker ?? event.by) || '';
    if (weapon) row.append(h('span', 'weapon', String(weapon).toUpperCase()));
    // 要害图标：事件自带 headshot 字段（未来服务端）或客户端 headshot 事件关联（现行模拟）
    if (event.headshot === true || headshotUntil.get(event.player) > performance.now()) row.classList.add('headshot');
    if ((event.attacker ?? event.by) === selfId) row.classList.add('mine');
    if (event.player === selfId) row.classList.add('you');
  }
  R.feed.prepend(row);
  while (R.feed.children.length > 6) R.feed.lastElementChild?.remove();
  setTimeout(() => { row.classList.add('out'); setTimeout(() => row.remove(), 400); }, 5200);
}

/** HUD 内轻提示（区别于全局 toast）。 */
export function hudToast(application, message) {
  if (application && application !== app) app = application;
  hudToastEvent(app, message, 2000);
}
function hudToastEvent(application, message, ms = 2000) {
  if (!R.toastBox || !message) return;
  const text = String(message);
  const now = performance.now();
  if (text === lastHudToast.text && now - lastHudToast.at < 1200) return;
  lastHudToast = { text, at: now };
  const row = h('div', 'hud-toast-row', text);
  R.toastBox.append(row);
  while (R.toastBox.children.length > 3) R.toastBox.firstElementChild?.remove();
  requestAnimationFrame(() => row.classList.add('show'));
  setTimeout(() => { row.classList.remove('show'); setTimeout(() => row.remove(), 300); }, ms);
}

function renderScoreboard() {
  if (!R.scoreboardBody) return;
  const state = app?.state;
  const me = selfPlayer(state);
  clear(R.scoreboardBody);
  if (!state) return;
  const result = state.result;
  const header = h('div', 'score-row head');
  header.append(h('span', null, '排名'), h('span', 'grow', '队伍'), h('span', null, '淘汰'), h('span', null, '存活'));
  R.scoreboardBody.append(header);
  const rows = result?.ranks || state.teamSummary || [];
  if (result?.ranks) {
    for (const rank of result.ranks) {
      const row = h('div', 'score-row');
      row.append(h('span', 'num', `#${rank.rank}`), h('span', 'grow', rank.name || rank.team || '—'),
        h('span', 'num', String(rank.players?.reduce((sum, p) => sum + (p.kills || 0), 0) ?? 0)),
        h('span', 'num', String(rank.players?.filter(p => p.alive !== false).length ?? '—')));
      R.scoreboardBody.append(row);
    }
    return;
  }
  const teams = new Map();
  for (const player of state.players || []) {
    const key = player.team ?? 0;
    if (!teams.has(key)) teams.set(key, { name: player.teamName || `第 ${key + 1} 队`, kills: 0, alive: 0, players: 0 });
    const entry = teams.get(key);
    entry.kills += Number(player.kills || 0);
    entry.players += 1;
    if (player.alive) entry.alive += 1;
  }
  const myTeam = me?.team;
  const sorted = [...teams.entries()].sort((a, b) => b[1].kills - a[1].kills || b[1].alive - a[1].alive);
  sorted.forEach(([teamId, entry], index) => {
    const row = h('div', `score-row ${teamId === myTeam ? 'mine' : ''}`);
    row.append(h('span', 'num', `#${index + 1}`), h('span', 'grow', entry.name),
      h('span', 'num', String(entry.kills)), h('span', 'num', `${entry.alive}/${entry.players}`));
    R.scoreboardBody.append(row);
  });
}

// ── 10 · 键盘 / 全局 ────────────────────────────────────────────────────────
function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
function onKeyDown(event) {
  if (isTyping(event.target)) {
    if (event.key === 'Escape') { event.target.blur(); R.chat?.classList.add('hidden'); }
    return;
  }
  if (!visible) return;
  if (event.code === 'Tab') {
    event.preventDefault();
    toggleScoreboard();
    return;
  }
  if (!event.repeat && (event.key === 'm' || event.key === 'M')) {
    event.preventDefault();
    if (isFullMapOpen()) hideFullMap(); else showFullMap();
    return;
  }
  if (!event.repeat && event.key === 'Enter') {
    if (R.chat && R.chat.classList.contains('hidden')) {
      event.preventDefault();
      openChat();
    }
  }
  // B：背包。input.js 的 PULSE_KEYS 早就有 KeyB:'inventory'，但全工程无人消费 ——
  // 帮助面板承诺的「查看携带物资」因此从来打不开。Esc 关闭由 ui-screens 统一处理
  // （背包是 #dialog-root 里带 role=dialog 的弹窗，会进 topDialog()）。
  if (!event.repeat && (event.code === 'KeyB' || event.key === 'b' || event.key === 'B')) {
    if (isInventoryOpen()) return;
    event.preventDefault();
    toggleInventoryPanel();
    return;
  }
  if (event.key === 'Escape') {
    if (isFullMapOpen()) { event.preventDefault(); hideFullMap(); }
    else if (R.scoreboard && !R.scoreboard.classList.contains('hidden')) { event.preventDefault(); toggleScoreboard(false); }
  }
}
function bindGlobal() {
  window.addEventListener('keydown', onKeyDown);
}

// ── 11 · 对外 API ───────────────────────────────────────────────────────────
/**
 * 事件级 HUD 组件的本地兜底样式（chat / 命中 / 受击方向 / 闪光 / 据点）。
 * 只作用于本模块自建的节点，不改 style.css（design 所属）；design 补齐同名类后
 * 这里的规则会被 style.css 的更具体选择器覆盖，无冲突。
 */
function injectHudEventStyles() {
  if (document.getElementById('hud-event-styles')) return;
  const style = document.createElement('style');
  style.id = 'hud-event-styles';
  style.textContent = [
    '#hud-chat{position:absolute;left:calc(var(--safe-l,0px) + 14px);bottom:calc(var(--safe-b,0px) + 210px);width:min(34vw,300px);display:flex;flex-direction:column;gap:3px;pointer-events:none;z-index:4}',
    '#hud-chat .chat-line{display:flex;gap:6px;align-items:baseline;padding:3px 8px;border-left:2px solid rgba(111,224,200,.45);border-radius:2px;background:rgba(4,15,16,.55);color:#c2d6cf;font-size:12px;line-height:1.4;opacity:0;transform:translateX(-6px);transition:opacity .2s ease,transform .2s ease}',
    '#hud-chat .chat-line.in{opacity:1;transform:none}',
    '#hud-chat .chat-line.fade{opacity:0}',
    '#hud-chat .chat-scope{color:#64807a;font-family:monospace;font-size:10px}',
    '#hud-chat .chat-name{color:#6fe0c8;font-weight:700}',
    '#hud-chat .chat-text{color:#c2d6cf}',
    '#hud-damage-ring{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:4}',
    '#hud-damage-ring .dmg-arc{position:absolute;left:-90px;top:-90px;width:180px;height:180px;border-radius:50%;transform-origin:50% 50%;background:conic-gradient(from -14deg,rgba(255,92,92,.8),transparent 30deg);mask-image:radial-gradient(closest-side,transparent 56%,#000 58%,#000 80%,transparent 82%);-webkit-mask-image:radial-gradient(closest-side,transparent 56%,#000 58%,#000 80%,transparent 82%);animation:dmgFade .9s ease-out forwards}',
    '#hud-damage-ring .dmg-arc.heavy{background:conic-gradient(from -22deg,rgba(255,92,92,1),transparent 44deg)}',
    '.damage-vignette.hurt{opacity:1!important;transition:opacity .15s ease-out}',
    '#hud-flash{position:absolute;inset:0;z-index:9;background:#fff;opacity:0;pointer-events:none}',
    /* 准星刻线：位置/长度由 JS 按 spread(弧度) 驱动 */
    '#crosshair .cross-line{position:absolute;left:50%;top:50%;width:2px;height:9px;margin:0;border-radius:1px;background:rgba(233,251,244,.92);box-shadow:0 0 3px rgba(0,0,0,.9);transform:translate(-50%,-50%);transition:transform 90ms linear}',
    '#crosshair.wide .cross-line{height:12px;background:rgba(255,214,138,.95)}',
    '#crosshair.tight .cross-line{height:7px;background:rgba(255,255,255,.98)}',
    '#crosshair .cross-ring{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:1px solid rgba(233,251,244,.28);border-radius:50%;transition:width 90ms linear,height 90ms linear}',
    '@keyframes dmgFade{0%{opacity:0}12%{opacity:1}100%{opacity:0}}',
  ].join('\n');
  document.head.append(style);
}

// ── 训练场 · 目标式局内教学（首局默认显示，可跳过/重新播放） ─────────────
let combatGuide = null;
function buildCombatGuide(host) {
  const panel = h('section', 'combat-guide hud-panel hidden');
  panel.id = 'combat-guide';
  panel.setAttribute('aria-label', '训练场实战教学');
  const head = h('div', 'combat-guide-head');
  const eyebrow = h('span', 'combat-guide-eyebrow', '实战教学 · TRAINING');
  const skip = h('button', 'combat-guide-skip', '跳过教学');
  skip.type = 'button';
  skip.id = 'combat-guide-skip';
  skip.addEventListener('click', () => finishCombatGuide(false));
  head.append(eyebrow, skip);
  const progress = h('small', 'combat-guide-progress', `0 / ${COMBAT_TASKS.length}`);
  const title = h('b', 'combat-guide-task', '移动 5 米');
  const hint = h('p', 'combat-guide-hint', '按 WASD 移动');
  panel.append(head, progress, title, hint);
  host.append(panel);
  R.combatGuide = { panel, progress, title, hint };
}
function finishCombatGuide(completed) {
  if (!combatGuide) return;
  combatGuide = null;
  R.combatGuide?.panel.classList.add('hidden');
  if (app?.settings) app.settings.combatGuideDone = true;
  try { app?.saveSettings?.(); } catch { /* 浏览器禁用持久化也不应中断游戏 */ }
  hudToastEvent(app, completed ? '训练目标达成 · 继续探索战场！' : '已跳过教学 · 可以在设置中重新开启', 2400);
}
function refreshCombatGuide() {
  if (!combatGuide || !R.combatGuide) return;
  const status = combatGuideStatus(combatGuide);
  if (!status.next) { finishCombatGuide(true); return; }
  setText(R.combatGuide.progress, `${status.count} / ${status.total} 已完成`);
  setText(R.combatGuide.title, status.next.title);
  const touch = app?.touch === true || (app?.touch === undefined && COARSE_POINTER);
  setText(R.combatGuide.hint, touch ? status.next.touch : status.next.desktop);
  R.combatGuide.panel.classList.remove('hidden');
}
function resetCombatGuide() {
  combatGuide = app?.offline && app?.modeId === 'training' && !app?.settings?.combatGuideDone
    ? createCombatGuide() : null;
  R.combatGuide?.panel.classList.toggle('hidden', !combatGuide);
  refreshCombatGuide();
}
function trainingGuideEvent(event, selfId) {
  if (observeCombatEvent(combatGuide, event, selfId)) refreshCombatGuide();
}
function updateCombatGuide(state, me) {
  if (!combatGuide || state?.phase !== 'live' || !me) return;
  if (observeCombatMovement(combatGuide, me)) refreshCombatGuide();
}

export function initHud(application) {
  app = application || {};
  if (built) return;
  const host = document.getElementById('hud');
  if (!host) { console.warn('[hud] 缺少 #hud'); return; }
  built = true;
  injectHudEventStyles();
  host.replaceChildren();
  buildTopBar(host);
  buildMinimap(host);
  buildSquad(host);
  buildHealth(host);
  buildWeapon(host);
  buildCenter(host);
  buildFeed(host);
  buildExtras(host);
  buildCombatGuide(host);
  buildTouch(host);
  buildFullMapModal();
  bindGlobal();
  setHudScale(Number(app?.settings?.hudScale) || 1);
  if (app?.settings?.leftHanded) R.touch?.classList.add('left-handed');
  // 初始隐藏：只加 .hidden（唯一可见性机制），不调 showHud 以免清空外部状态
  host.classList.add('hidden');
  visible = false;
  console.info('[hud] 局内界面已就绪');
}

export function showHud(value = true) {
  const host = document.getElementById('hud');
  if (!host) return;
  visible = !!value;
  // 唯一可见性机制：.hidden class（样式表 #hud.hidden{display:none!important}）。
  // 不要再写 style.display，否则会出现 class 与 inline style 两条真相。
  host.classList.toggle('hidden', !visible);
  host.style.removeProperty('display');
  host.classList.toggle('on', visible);
  // 局内状态类必须同时挂在 #hud 与 body 上：
  //   - CSS 里 `#hud.in-match { pointer-events: auto }` 等规则选择的是 #hud；
  //   - 旧实现只挂 body，导致这些规则**永远不生效** —— #hud 整体 pointer-events:none，
  //     生命面板/消耗品按钮的点击会穿透到 canvas 变成「开枪」（实测点医疗包会走火）。
  // body 上的类保留给需要整页联动的样式。
  host.classList.toggle('in-match', visible);
  document.body.classList.toggle('in-match', visible);
  if (!visible) {
    toggleScoreboard(false);
    hideFullMap();
    if (R.feed) clear(R.feed);
    if (R.toastBox) clear(R.toastBox);
    last.events = 0;
    resetCache();
    combatGuide = null;
    R.combatGuide?.panel.classList.add('hidden');
  } else {
    const firstId = Number(app?.state?.events?.[0]?.id || 0);
    last.events = Math.max(0, firstId - 1);
    resetCombatGuide();
  }
}

export function setHudScale(scale) {
  hudScale = clamp(scale || 1, 0.7, 1.3);
  const host = document.getElementById('hud');
  if (host) host.style.setProperty('--hud-scale', String(hudScale));
  if (R.touch) {
    R.touch.style.setProperty('--stick-scale', String(hudScale));
  }
}

export function isHudVisible() { return visible; }
export function toggleScores() { toggleScoreboard(); }
export function getHudRefs() { return R; }

function resetCache() {
  last.alive = -1; last.kills = -1; last.zone = ''; last.stage = ''; last.weapon = '';
  last.ammo = ''; last.reserve = ''; last.state = ''; last.hp = -1; last.armor = -1;
  last.shield = -1; last.stamina = -1; last.squadSig = ''; last.hordeSig = '';
  last.banner = '';
  lastHpSeen = null;
  shotWeapon.clear();
  headshotUntil.clear();
  R.squadRows?.forEach(row => row.el.remove());
  R.squadRows?.clear();
}

/**
 * 每帧调用。内部节流：文字 100ms、小地图 120ms、小队 200ms。
 */
export function updateHud(application, state, dt) {
  if (application && application !== app) app = application;
  const host = document.getElementById('hud');
  if (!host) return;
  if (!state) {
    // 没有快照时绝不自行改可见性（可见性只由 main.js 的 showHud 决定）
    return;
  }
  if (host.classList.contains('hidden')) {
    // HUD 可见性唯一来源：main.js 的 showHud()。这里不再自动“复活”，
    // 否则结算/退出后残留的 state 会让已隐藏的 HUD 又弹出来（幽灵 HUD）。
    return;
  }
  const now = performance.now();
  const me = meOf(state);
  updateTop(state, me, now);
  updateHealth(state, me);
  updateWeapon(state, me);
  updateSquad(state, me, now);
  updateCenter(state, me);
  updateBanner(state);
  updateDeploy(state, me);
  updateHorde(state);
  processEvents(state);
  updateCombatGuide(state, me);
  if (now - last.map >= MAP_MS && R.minimap) {
    last.map = now;
    drawMinimap(R.minimap, state, me);
  }
  if (R.scoreboard && !R.scoreboard.classList.contains('hidden') && now - (updateHud._board || 0) > 400) {
    updateHud._board = now;
    renderScoreboard();
  }
  toggle(R.spectate, 'hidden', !(me && me.alive === false && state.phase !== 'ended'));
  const showTouch = app?.touch === true || (app?.touch === undefined && COARSE_POINTER);
  if (R.touch) R.touch.classList.toggle('hidden', !showTouch);
}

export function hudSetTouch(show) {
  if (R.touch) R.touch.classList.toggle('hidden', !show);
}
export function setHudLayout(leftHanded) {
  if (R.touch) R.touch.classList.toggle('left-handed', !!leftHanded);
}
export function showHit(kind = 'hit') { showHitmarker(kind); }
export function hudBanner(title, sub, ms) { pushBanner(title, sub, ms); }
export function openHudMap() { showFullMap(); }
export function closeHudMap() { hideFullMap(); }

// ── 12 · main.js 消费的事件级 HUD API（全部容错，不抛异常） ─────────────────
// 说明：这些是“事件驱动”的一次性反馈（不是每帧刷新），因此不参与节流。
// 样式类名清单已同步给 design（见交付消息）；此处只保证 DOM 结构稳定可降级。

/** 聊天行：main.js 收到 {type:'chat'} 时调用。 */
export function hudChat(application, msg) {
  try {
    if (application && application !== app && application.state) app = application;
    if (!msg) return;
    // 优先复用 buildChat() 建好的 R.chatLog（它在 #hud-chat 容器内）。
    // 旧实现无条件 `document.getElementById('hud-chat')` 再自建一个 —— 而不带 id 的
    // 聊天容器也是存在的，于是「建了 R.chatLog 却从不写入、另建一套 DOM 并存」，
    // 审计 docs/AUDIT-WIRING.md 把这条列为「局内聊天历史区永远空白」。
    let box = R.chatLog;
    if (!box || !box.isConnected) {
      box = document.getElementById('hud-chat');
      if (!box) {
        const host = document.getElementById('hud');
        if (!host) return;
        box = h('div', 'hud-chat chat-panel');
        box.id = 'hud-chat';
        box.setAttribute('aria-live', 'polite');
        host.append(box);
      }
    }
    const line = h('div', 'chat-line');
    const team = msg.team != null ? `第 ${Number(msg.team) + 1} 队` : (msg.channel === 'all' ? '全体' : '队伍');
    const name = h('b', 'chat-name', String(msg.name || '队友'));
    const text = h('span', 'chat-text', String(msg.text || '').slice(0, 80));
    line.append(h('span', 'chat-scope', team), name, text);
    box.append(line);
    while (box.children.length > 6) box.firstElementChild?.remove();
    // 同时写进「聊天面板」的历史区（R.chatLog）。面板默认隐藏，但玩家按 Enter
    // 打开它时应该能看到刚过去的几条消息，而不是一片空白。
    const log = R.chatLog;
    if (log && log !== box && log.isConnected) {
      const row = h('div', 'chat-line');
      row.append(h('span', 'chat-scope', team), h('b', 'chat-name', String(msg.name || '队友')),
        h('span', 'chat-text', String(msg.text || '').slice(0, 80)));
      log.append(row);
      while (log.children.length > 40) log.firstElementChild?.remove();
      log.scrollTop = log.scrollHeight;
    }
    requestAnimationFrame(() => line.classList.add('in'));
    setTimeout(() => { line.classList.add('fade'); setTimeout(() => line.remove(), 420); }, 6500);
  } catch (err) { console.warn('[hud] hudChat', err); }
}

/** 命中标记：ev.kind ∈ hit|kill|headshot。视觉 only（音效/震动由 main.js 负责）。 */
export function hudHit(application, ev) {
  try {
    if (application && application !== app && application.state) app = application;
    const kind = ev?.kind || (ev?.kill ? 'kill' : ev?.headshot ? 'headshot' : 'hit');
    if (!R.hitmarker) {
      const host = document.getElementById('hud');
      if (!host) return;
      R.hitmarker = h('div', 'hitmarker hud-hitmarker');
      R.hitmarker.id = 'hitmarker';
      host.append(R.hitmarker);
    }
    showHitmarker(kind);
    // 自己的击杀：屏幕上方短暂吐一条“击杀”横幅，强化反馈
    if (kind === 'kill') {
      const name = ev?.name || ev?.targetName || '';
      hudBanner('击杀', name ? `+1 · ${name}` : '+1', 1100);
    }
  } catch (err) { console.warn('[hud] hudHit', err); }
}

/** 受击方向：ev.from 为指向攻击者的角度（弧度，0=+Z，契约 §3 语义）。
 *  屏幕扇形从 12 点方向顺时针旋转，而屏幕上方对应世界 -Z，所以屏幕角 = π − from。 */
export function hudDamage(application, ev) {
  try {
    if (application && application !== app && application.state) app = application;
    const host = document.getElementById('hud');
    if (!host) return;
    let ring = R.damageRing;
    if (!ring) {
      ring = h('div', 'hud-damage-ring damage-indicators');
      ring.id = 'hud-damage-ring';
      host.append(ring);
      R.damageRing = ring;
    }
    const from = Number(ev?.from ?? ev?.angle ?? 0) || 0;
    const rad = Math.PI - from;
    const arc = h('i', 'dmg-arc');
    arc.style.transform = `rotate(${rad.toFixed(3)}rad)`;
    if (ev?.heavy) arc.classList.add('heavy');
    ring.append(arc);
    while (ring.children.length > 5) ring.firstElementChild?.remove();
    setTimeout(() => arc.remove(), 900);
    // 屏幕边缘红色 vignette：短促 150ms
    if (R.vignette) {
      R.vignette.classList.add('hurt');
      setTimeout(() => R.vignette?.classList.remove('hurt'), 150);
    }
    if (app) { app.hud = app.hud || {}; app.hud.lastDamageAngle = (rad * 180) / Math.PI; }
  } catch (err) { console.warn('[hud] hudDamage', err); }
}

/** 闪光弹白屏：seconds 为完全恢复时间（默认 2.6s）。 */
export function hudFlash(application, seconds) {
  try {
    if (application && application !== app && application.state) app = application;
    const host = document.getElementById('hud');
    if (!host) return;
    let veil = R.flash;
    if (!veil) {
      veil = h('div', 'hud-flash');
      veil.id = 'hud-flash';
      host.append(veil);
      R.flash = veil;
    }
    const duration = Math.max(0.2, Math.min(6, Number(seconds) || 2.6));
    veil.style.transition = `opacity ${duration}s ease-out`;
    veil.style.opacity = '1';
    veil.classList.add('on');
    // 两帧后开始淡出，确保 transition 生效
    requestAnimationFrame(() => requestAnimationFrame(() => { veil.style.opacity = '0'; }));
    setTimeout(() => veil.classList.remove('on'), duration * 1000 + 200);
  } catch (err) { console.warn('[hud] hudFlash', err); }
}

/** 缩圈事件：ev = { phase, closing, closingIn, x, z, r }。 */
export function hudZone(application, ev) {
  try {
    if (application && application !== app && application.state) app = application;
    const phase = Number(ev?.phase ?? 0);
    const closing = ev?.closing !== false;
    const title = phase > 0 ? `第 ${phase} 圈` : '风暴';
    const sub = closing
      ? (Number.isFinite(ev?.closingIn) ? `安全区正在收缩 · ${Math.max(0, Math.ceil(ev.closingIn))}s` : '安全区正在收缩')
      : '安全区已稳定';
    pushBanner(title, sub, 2400);
    // 驱动态栏文本（若可见）
    if (R.zoneText) setText(R.zoneText, `${title} · ${closing ? '收缩中' : '稳定'}`);
    // 正在缩圈时给 zone-pill 一个 closing 态，强化视觉
    if (R.zone) R.zone.classList.toggle('closing', !!closing);
    if (R.stagePhase && phase > 0) setText(R.stagePhase, `阶段 ${phase}`);
  } catch (err) { console.warn('[hud] hudZone', err); }
}

/** 据点/基地受击（horde 模式）：ev = { hp, maxHp, name }。 */
export function hudBase(application, ev) {
  try {
    if (application && application !== app && application.state) app = application;
    const hp = Number(ev?.hp);
    const maxHp = Number(ev?.maxHp) || 600;
    const name = String(ev?.name || '基地');
    if (Number.isFinite(hp) && R.horde && R.baseFill) {
      const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
      R.horde.classList.remove('hidden');
      setStyle(R.baseFill, 'width', `${pct.toFixed(1)}%`);
      if (R.hordeInfo) {
        clear(R.hordeInfo);
        R.hordeInfo.append(h('small', 'muted', `${name} ${Math.max(0, Math.ceil(hp))} / ${Math.ceil(maxHp)}`));
        const lost = maxHp - hp;
        if (lost > 0) R.hordeInfo.append(h('small', 'danger', `受损 ${Math.ceil(lost)}`));
      }
      R.horde.classList.toggle('critical', pct <= 25);
      if (pct <= 25) pushBanner(`${name}告急`, `结构仅剩 ${Math.round(pct)}%`, 1800);
      return;
    }
    // 无据点 UI：降级为一条 banner
    if (Number.isFinite(hp)) {
      pushBanner('据点受击', `${name} ${Math.max(0, Math.ceil(hp))} / ${Math.ceil(maxHp)}`, 1600);
    }
  } catch (err) { console.warn('[hud] hudBase', err); }
}


