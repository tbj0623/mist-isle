// 雾岛突围 / MIST ISLE 1.0 — 局内 HUD（owner: uiux）
// 运行时构建 #hud 内全部 DOM；样式由 style.css（design）提供。
// 性能约定：文字类每 100ms 刷新、小地图每 120ms 重绘、血条每帧只改 style；
// 全程 textContent，不拼 innerHTML，不在每帧创建 DOM。

import { RARITY_NAMES, RARITY_COLORS, REVIVE_TIME, BLEEDOUT_TIME } from '../shared/rules.mjs';

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
  canvas.setAttribute('aria-label', '小地图');
  canvas.setAttribute('role', 'img');
  const zoom = h('button', 'icon-btn minimap-zoom');
  zoom.id = 'btn-map-zoom';
  zoom.type = 'button';
  zoom.setAttribute('aria-label', '打开战术地图 (M)');
  zoom.title = '战术地图 (M)';
  zoom.style.minWidth = '44px';
  zoom.style.minHeight = '44px';
  zoom.append(icon('zoom', 16));
  zoom.addEventListener('click', () => {
    if (app?.ui?.showFullMap) app.ui.showFullMap();
    else emit('fullmap');
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
  cross.append(dot, ring);
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
  chatForm.append(chatInput);
  chatForm.addEventListener('submit', event => {
    event.preventDefault();
    const text = chatInput.value.trim().slice(0, 80);
    if (text) {
      try { app?.sendChat?.(text) ?? app?.net?.send?.({ type: 'chat', text, channel: 'team' }); } catch { /* 忽略 */ }
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
  { id: 'backpack-action', label: '背包', icon: 'bag', action: 'backpack', keyHint: 'B' },
  { id: 'ping-action', label: '标记', icon: 'ping', action: 'ping', keyHint: 'P' },
];

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
  hordeHead.append(icon('wave', 15), h('b', null, '波次 1 / 10'), h('span', 'spacer'), h('small', 'muted', '准备中'));
  const baseTrack = h('div', 'base-track');
  const baseFill = h('i');
  baseTrack.append(baseFill);
  const hordeInfo = h('div', 'horde-info');
  hordeInfo.append(h('small', 'muted', '基地 600 / 600'), h('small', 'muted', '剩余 0'));
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
  canvas.id = 'fullmap-canvas';
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
  if (zone) {
    const dist = me ? Math.hypot((me.x || 0) - zone.x, (me.z || 0) - zone.z) : 0;
    const outside = me && dist > (zone.r || 0);
    danger = !!outside;
    if (outside) zoneLabel = `圈外 · 每秒 ${Math.round(zone.damage || 0)} 点伤害`;
    else if (zone.closing) zoneLabel = `安全区收缩中 · ${Math.max(0, Math.ceil(zone.nextIn || 0))}s`;
    else zoneLabel = `安全区稳定 · ${Math.max(0, Math.ceil(zone.nextIn || 0))}s`;
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
  toggle(R.ammo, 'low', ammo <= Math.max(1, Math.round((info.magazine || 10) * 0.2)));
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
    const total = Number(me.bleedout) || BLEEDOUT_TIME;
    const pct = clamp(total / (me.bleedoutTotal || BLEEDOUT_TIME), 0, 1);
    setStyle(R.reviveRing, 'background', `conic-gradient(#ff9a5c ${(pct * 100).toFixed(0)}%, rgba(255,255,255,0.12) 0)`);
    setText(R.reviveText, `${Math.ceil(total)} 秒后淘汰`);
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
  // 准星扩散
  const spread = Number(me?.spread ?? me?.accuracy ?? 0);
  const base = 8;
  const size = base + clamp(spread * 90, 0, 22) + (me?.state === 'sprint' ? 8 : 0);
  setStyle(R.crossRing, 'width', `${size.toFixed(0)}px`);
  setStyle(R.crossRing, 'height', `${size.toFixed(0)}px`);
  toggle(R.crosshair, 'downed', downed);
  toggle(R.crosshair, 'hidden', me?.alive === false);
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
function updateBanner(state) {
  if (!R.banner) return;
  const phase = state.phase;
  let title = '';
  let sub = '';
  if (phase === 'deploying') { title = '空降中'; sub = '选择落点，尽快武装自己'; }
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

function updateHorde(state) {
  if (!R.horde) return;
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
    switch (event.type) {
      case 'kill':
      case 'down': {
        hudKillfeed(event);
        if (event.attacker === selfId || event.player === selfId) {
          showHitmarker(event.type === 'kill' ? 'kill' : 'down');
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
  if (app) { app.hud = app.hud || {}; app.hud.lastDamageAngle = (angle * 180) / Math.PI; }
}

/** 击杀播报（供 main 直接调用） */
export function hudKillfeed(event) {
  if (!R.feed || !event) return;
  const row = h('div', 'killfeed-row');
  let text = '';
  let cls = 'killfeed-row';
  if (event.type === 'revive') {
    text = `${event.byName || '队友'} 救起了 ${event.name || '一名队友'}`;
    cls += ' revive';
  } else if (event.type === 'down') {
    text = `${event.attackerName || '风暴'} 击倒了 ${event.name || '一名敌人'}`;
    cls += ' down';
  } else if (event.type === 'boss') {
    text = `${event.name || '首领'} 出现`;
    cls += ' boss';
  } else {
    const weapon = event.weapon ? ` · ${event.weapon}` : '';
    text = `${event.attackerName || '风暴'} 淘汰了 ${event.name || '一名敌人'}${weapon}`;
    cls += ' kill';
  }
  const selfId = app?.selfId;
  if (event.attacker === selfId) cls += ' mine';
  if (event.player === selfId) cls += ' victim';
  row.className = cls;
  row.append(h('span', 'feed-text', text));
  R.feed.prepend(row);
  while (R.feed.children.length > 6) R.feed.lastElementChild?.remove();
  setTimeout(() => { row.classList.add('fade'); setTimeout(() => row.remove(), 400); }, 5200);
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
      R.chat.classList.remove('hidden');
      R.chatInput?.focus({ preventScroll: true });
    }
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
export function initHud(application) {
  app = application || {};
  if (built) return;
  const host = document.getElementById('hud');
  if (!host) { console.warn('[hud] 缺少 #hud'); return; }
  built = true;
  host.replaceChildren();
  buildTopBar(host);
  buildMinimap(host);
  buildSquad(host);
  buildHealth(host);
  buildWeapon(host);
  buildCenter(host);
  buildFeed(host);
  buildExtras(host);
  buildTouch(host);
  buildFullMapModal();
  bindGlobal();
  setHudScale(Number(app?.settings?.hudScale) || 1);
  if (app?.settings?.leftHanded) R.touch?.classList.add('left-handed');
  showHud(false);
  console.info('[hud] 局内界面已就绪');
}

export function showHud(value = true) {
  const host = document.getElementById('hud');
  if (!host) return;
  visible = !!value;
  host.classList.toggle('hidden', !visible);
  document.body.classList.toggle('in-match', visible);
  if (!visible) {
    toggleScoreboard(false);
    hideFullMap();
    if (R.feed) clear(R.feed);
    if (R.toastBox) clear(R.toastBox);
    last.events = 0;
    resetCache();
  } else {
    last.events = Math.max(0, Number(app?.state?.events?.[0]?.id || 0) - 1);
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
    if (!host.classList.contains('hidden') && !app?.state) showHud(false);
    return;
  }
  if (host.classList.contains('hidden')) {
    if (app?.mode === 'match' || app?.phase) showHud(true);
    else return;
  }
  const now = performance.now();
  const me = meOf(state);
  updateTop(state, me, now);
  updateHealth(state, me);
  updateWeapon(state, me);
  updateSquad(state, me, now);
  updateCenter(state, me);
  updateBanner(state);
  updateHorde(state);
  processEvents(state);
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





