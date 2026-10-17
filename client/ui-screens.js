// 雾岛突围 / MIST ISLE 1.0 — 局外界面与弹窗（owner: uiux）
// 运行时构建 #screen-root / #dialog-root 内的全部 DOM；样式由 style.css（design）提供。
// 依赖：shared/rules.mjs、shared/data/maps.mjs（冻结）。武器/道具/任务/成就/商店等数据
// 优先取自 app.data / app.meta，未注入时使用内置回退目录（保证界面永远可渲染）。

import { VERSION, RARITY_NAMES, RARITY_COLORS, RANK_TIERS, DIFFICULTY, SQUAD_SIZE } from '../shared/rules.mjs';
import { MAPS, MAP_ORDER } from '../shared/data/maps.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const RARITY_LIST = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const DASH = '—';
const touchDevice = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

let app = null;
const screens = new Map();
const dialogs = new Map();
const recentMatches = [];
let activeScreen = null;
let resultSummary = null;
let resultRewards = null;
let built = false;
let bound = false;
let lastRefresh = 0;

// ── 01 · 极小 DOM 工具 ────────────────────────────────────────────────────────
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function clear(node) { if (node) node.replaceChildren(); return node; }
function setText(node, text) { const next = String(text); if (node && node.textContent !== next) node.textContent = next; }
function fmtNum(n) { return Math.round(Number(n) || 0).toLocaleString('zh-CN'); }
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function rarityName(r) { return RARITY_NAMES?.[r] || '普通'; }
function rarityClass(r) { return RARITY_LIST.includes(r) ? `rarity-${r}` : 'rarity-common'; }
function rarityColor(r) { return RARITY_COLORS?.[r] || '#c9d2cb'; }

// ── 02 · 图标（内联 SVG，不引入 lucide 整包） ───────────────────────────────
const ICONS = {
  play: ['M7 4.6v14.8L20 12 7 4.6z'],
  users: ['M8.2 11.4a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z', 'M2.2 20.4c0-3.4 2.7-6.2 6-6.2s6 2.8 6 6.2', 'M16.4 4.6a3.4 3.4 0 0 1 0 6.4', 'M17.6 14.1c2.5.6 4.2 2.9 4.2 5.4'],
  waves: ['M3 8.2c2.4 0 2.4-2.6 4.8-2.6s2.4 2.6 4.8 2.6 2.4-2.6 4.8-2.6 2.4 2.6 3.6 2.6', 'M3 13.2c2.4 0 2.4-2.6 4.8-2.6s2.4 2.6 4.8 2.6 2.4-2.6 4.8-2.6 2.4 2.6 3.6 2.6', 'M3 18.2c2.4 0 2.4-2.6 4.8-2.6s2.4 2.6 4.8 2.6 2.4-2.6 4.8-2.6 2.4 2.6 3.6 2.6'],
  target: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'M12 12h.01'],
  bag: ['M4 8h16l-1.2 12H5.2L4 8z', 'M8.5 8V6.2A3.5 3.5 0 0 1 12 2.7a3.5 3.5 0 0 1 3.5 3.5V8'],
  list: ['M8 6h13M8 12h13M8 18h13', 'M3.5 6h.01M3.5 12h.01M3.5 18h.01'],
  book: ['M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22V4.5z', 'M8 7h8M8 11h6'],
  chart: ['M3.5 20.5h17', 'M6.5 20.5V12M11 20.5V6.5M15.5 20.5v-5M20 20.5V9.5'],
  gear: ['M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49 1z'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.4 9.4a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.2-2.6 4', 'M12 17.4h.01'],
  back: ['M15 5l-7 7 7 7'],
  forward: ['M9 5l7 7-7 7'],
  close: ['M6 6l12 12M18 6L6 18'],
  check: ['M4.5 12.5l5 5L20 6.5'],
  plus: ['M12 5v14M5 12h14'],
  lock: ['M6 10.5h12V21H6z', 'M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9 9.5h3.6a2.2 2.2 0 0 1 0 4.4H9.4', 'M12 7v10'],
  star: ['M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.2 6.6 20.1l1-6.1L3.2 9.7l6.1-.9L12 3.2z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5.4l3.4 2'],
  trophy: ['M7 4h10v4.5a5 5 0 0 1-10 0V4z', 'M7 5H4v2.5a3 3 0 0 0 3 3M17 5h3v2.5a3 3 0 0 1-3 3', 'M12 13.5V18M8.5 21h7'],
  shield: ['M12 21s7-3.2 7-9V5.6L12 3 5 5.6V12c0 5.8 7 9 7 9z'],
  heart: ['M12 20.4s-7.6-4.6-7.6-9.6A4.3 4.3 0 0 1 12 7.9a4.3 4.3 0 0 1 7.6 2.9c0 5-7.6 9.6-7.6 9.6z'],
  bolt: ['M13.2 2.5L5 13.4h6L10.8 21.5 19 10.6h-6l.2-8.1z'],
  fire: ['M12 21.5c3.6 0 6-2.4 6-5.6 0-4.2-4.2-5.4-3.4-10.4-2.6.8-4.6 3-4.6 5.6 0 1.4-.8 2.2-1.8 2.2-1 0-1.7-.8-1.7-2-1.6 1.4-2.5 3.4-2.5 5.4 0 3.2 2.4 4.8 6 4.8z'],
  volume: ['M5 9.5h3.5L13 6v12L8.5 14.5H5v-5z', 'M16.5 9a4 4 0 0 1 0 6', 'M19 6.5a8 8 0 0 1 0 11'],
  music: ['M9 18.5V6l10-2v12.5', 'M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z', 'M19 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  monitor: ['M3.5 4.5h17v11h-17z', 'M9 20h6M12 15.5V20'],
  gamepad: ['M7.6 8.5h8.8a4 4 0 0 1 3.9 3.1l.8 4a2.6 2.6 0 0 1-4.7 1.7l-1.1-1.6H8.7l-1.1 1.6a2.6 2.6 0 0 1-4.7-1.7l.8-4a4 4 0 0 1 3.9-3.1z', 'M7.5 12.6h2M8.5 11.6v2', 'M15.6 12.1h.01M17.6 13.4h.01'],
  vibrate: ['M8 5.5h8v13H8z', 'M4.5 9v6M19.5 9v6', 'M12 8h.01M12 16h.01'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13', 'M10.5 11v6M13.5 11v6'],
  flag: ['M6 21V4', 'M6 4.5h11l-1.8 4 1.8 4H6'],
  skull: ['M12 21a7 7 0 0 0 7-7v-2.4A5.6 5.6 0 0 0 13.4 6h-2.8A5.6 5.6 0 0 0 5 11.6V14a7 7 0 0 0 7 7z', 'M9.4 12.4h.01M14.6 12.4h.01', 'M10 21v-3M14 21v-3'],
  crosshair: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4'],
  reload: ['M19.5 12a7.5 7.5 0 1 1-2.4-5.5', 'M19.8 4.5v5h-5'],
  swap: ['M4 8h13l-3.2-3.2', 'M20 16H7l3.2 3.2'],
  hand: ['M8.5 12.5V5.6a1.7 1.7 0 0 1 3.4 0V11', 'M11.9 10.6V4.8a1.7 1.7 0 0 1 3.4 0v5.8', 'M15.3 11V7a1.7 1.7 0 0 1 3.4 0v7.4A6 6 0 0 1 12.7 20h-1.2a5 5 0 0 1-3.9-1.9L4.9 14.6a1.8 1.8 0 0 1 2.6-2.5l1 1'],
  map: ['M9 4.5l6 2 5.5-2v15l-5.5 2-6-2-5.5 2v-15l5.5-2z', 'M9 4.5v15M15 6.5v15'],
  zoom: ['M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z', 'M16.4 16.4L21 21', 'M8.2 11h5.6M11 8.2v5.6'],
  menu: ['M4 7h16M4 12h16M4 17h16'],
  pause: ['M9 5v14M15 5v14'],
  crown: ['M4 18l-1-9 5 3 4-7 4 7 5-3-1 9H4z'],
  wifi: ['M4 9.5a12 12 0 0 1 16 0', 'M7 13a8 8 0 0 1 10 0', 'M10 16.4a3.6 3.6 0 0 1 4 0', 'M12 20h.01'],
  medal: ['M8 3l2.5 5.5M16 3l-2.5 5.5', 'M12 21a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M12 7.5v2'],
  box: ['M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5v-9z', 'M3.5 7.5L12 12l8.5-4.5M12 12v9'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
};
function icon(name, size = 20) {
  const paths = ICONS[name] || ICONS.target;
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

// ── 03 · 数据目录（优先用 app.data 注入的真实数据，缺省用回退目录） ─────────
const FALLBACK_WEAPONS = {
  p9: { name: 'P9 手枪', cls: 'pistol', ammo: 'light', damage: 26, magazine: 15, range: 34, rarity: 'common', unlock: 1, desc: '可靠的制式手枪，弹药随处可见。' },
  v9: { name: 'V9 冲锋枪', cls: 'smg', ammo: 'light', damage: 18, magazine: 32, range: 22, rarity: 'common', unlock: 1, desc: '射速极快的量产冲锋枪，近距离压制力惊人。' },
  ar7: { name: 'AR-7 突击步枪', cls: 'rifle', ammo: 'medium', damage: 31, magazine: 30, range: 52, rarity: 'rare', unlock: 4, desc: '全能型突击步枪，从落地到决赛圈都值得信赖。' },
  m4x: { name: 'M4X 战术步枪', cls: 'rifle', ammo: 'medium', damage: 29, magazine: 30, range: 56, rarity: 'rare', unlock: 7, desc: '加装导轨的精确步枪，中距离点射极稳。' },
  s12: { name: 'S12 霰弹枪', cls: 'shotgun', ammo: 'shell', damage: 96, magazine: 6, range: 14, rarity: 'uncommon', unlock: 2, desc: '室内近战的绝对王者，一发决定生死。' },
  lmg9: { name: 'MG9 轻机枪', cls: 'lmg', ammo: 'heavy', damage: 27, magazine: 75, range: 48, rarity: 'epic', unlock: 12, desc: '弹链供弹的火力压制者，适合守楼与掩护。' },
  dmr: { name: 'DMR-5 精确射手', cls: 'marksman', ammo: 'medium', damage: 52, magazine: 20, range: 78, rarity: 'epic', unlock: 16, desc: '半自动精确射手步枪，两枪打穿护甲。' },
  bolt: { name: 'BOLT-21 狙击枪', cls: 'sniper', ammo: 'bolt', damage: 118, magazine: 5, range: 110, rarity: 'legendary', unlock: 22, desc: '一击致命的栓动狙击枪，远距离点名。' },
  gas: { name: 'GAS-9 毒气枪', cls: 'special', ammo: 'light', damage: 12, magazine: 24, range: 26, rarity: 'legendary', unlock: 30, desc: '发射腐蚀弹丸的特殊武器，持续灼烧目标。' },
  cross: { name: '猎手弩', cls: 'special', ammo: 'bolt', damage: 88, magazine: 1, range: 60, rarity: 'rare', unlock: 18, desc: '几乎无声的猎杀工具，命中即为重伤。' },
};
const FALLBACK_ATTACHMENTS = {
  red_dot: { name: '红点镜', slot: 'optic', rarity: 'common', desc: '开镜更快，视觉更清晰。' },
  holo: { name: '全息镜', slot: 'optic', rarity: 'uncommon', desc: '中距离瞄准更精准。' },
  scope2: { name: '2 倍镜', slot: 'optic', rarity: 'rare', desc: '中远距离作战的首选。' },
  scope4: { name: '4 倍镜', slot: 'optic', rarity: 'epic', desc: '远程狙击的标配。' },
  suppressor: { name: '消音器', slot: 'muzzle', rarity: 'rare', desc: '降低枪声传播距离。' },
  compensator: { name: '补偿器', slot: 'muzzle', rarity: 'uncommon', desc: '显著降低后坐力。' },
  extended: { name: '扩容弹匣', slot: 'mag', rarity: 'uncommon', desc: '弹匣容量 +60%。' },
  quickdraw: { name: '快拔弹匣', slot: 'mag', rarity: 'rare', desc: '换弹速度 +35%。' },
  grip: { name: '垂直握把', slot: 'grip', rarity: 'uncommon', desc: '连射时枪口上跳更小。' },
  laser: { name: '激光指示器', slot: 'grip', rarity: 'rare', desc: '腰射散布明显降低。' },
};
const FALLBACK_ITEMS = {
  bandage: { name: '绷带', use: 2.0, heal: 22, desc: '快速包扎，恢复少量生命。' },
  medkit: { name: '医疗包', use: 4.0, heal: 75, desc: '大幅度恢复生命，需要撤离交火。' },
  energy: { name: '能量饮料', use: 1.2, heal: 35, desc: '短时间提升移动速度。' },
  shield: { name: '护盾电池', use: 3.0, shield: 60, desc: '为护盾充能，优先级极高。' },
  frag: { name: '破片手雷', desc: '延迟引信，可穿墙造成溅射伤害。' },
  smoke: { name: '烟雾弹', desc: '制造大片遮蔽烟幕，掩护转移。' },
  flash: { name: '闪光弹', desc: '短时间致盲正对方向的敌人。' },
  molotov: { name: '燃烧瓶', desc: '在地面制造持续燃烧区域。' },
};
const FALLBACK_MISSIONS = [
  { id: 'd_kill10', title: '清除 10 名敌人', metric: 'kills', target: 10, xp: 120, credits: 80 },
  { id: 'd_play3', title: '完成 3 场对局', metric: 'matches', target: 3, xp: 90, credits: 60 },
  { id: 'd_dmg1200', title: '累计造成 1200 点伤害', metric: 'damage', target: 1200, xp: 140, credits: 90 },
];
const FALLBACK_WEEKLY = [
  { id: 'w_win3', title: '本周赢得 3 场对局', metric: 'wins', target: 3, xp: 600, credits: 420 },
  { id: 'w_revive5', title: '救援队友 5 次', metric: 'revives', target: 5, xp: 420, credits: 260 },
  { id: 'w_horde10', title: '在生存波次中存活 10 波', metric: 'hordeWaves', target: 10, xp: 520, credits: 300 },
];
const FALLBACK_ACHIEVEMENTS = [
  { id: 'a_first_win', title: '初次突围', desc: '赢得第一场对局', metric: 'wins', target: 1, xp: 200, credits: 150 },
  { id: 'a_kill100', title: '百人斩', desc: '累计淘汰 100 名敌人', metric: 'kills', target: 100, xp: 400, credits: 300 },
  { id: 'a_dmg50k', title: '火力全开', desc: '累计造成 50000 点伤害', metric: 'damage', target: 50000, xp: 600, credits: 450 },
  { id: 'a_match50', title: '老兵不死', desc: '完成 50 场对局', metric: 'matches', target: 50, xp: 500, credits: 380 },
];
const FALLBACK_SKINS = [
  { id: 'skin_default', name: '雾行者', kind: 'character', price: 0, rarity: 'common', unlock: 1, desc: '雾岛行动的标准作战服。' },
  { id: 'skin_scout', name: '荆棘斥候', kind: 'character', price: 900, rarity: 'uncommon', unlock: 6, desc: '轻装侦察兵，配色取自退潮的礁石。' },
  { id: 'skin_diver', name: '深潜者', kind: 'character', price: 1500, rarity: 'rare', unlock: 10, desc: '旧港打捞队的改制潜水装。' },
  { id: 'skin_ash', name: '余烬', kind: 'character', price: 2400, rarity: 'epic', unlock: 16, desc: '从赤砂矿区走出来的幸存者。' },
  { id: 'skin_night', name: '白夜', kind: 'character', price: 3600, rarity: 'legendary', unlock: 24, desc: '灯塔守望者，只在长夜出没。' },
];
const storeTabs = [
  { id: 'character', name: '角色皮肤' },
  { id: 'weapon', name: '武器皮肤' },
  { id: 'other', name: '其他物品' },
];
const codexTabs = [
  { id: 'weapon', name: '武器' },
  { id: 'attachment', name: '配件' },
  { id: 'item', name: '道具' },
  { id: 'map', name: '地图' },
  { id: 'enemy', name: '敌人' },
];

function data() { return app?.data || {}; }
function weaponTable() { const t = data().weapons || data().WEAPONS; return t && Object.keys(t).length ? t : FALLBACK_WEAPONS; }
function attachmentTable() { const t = data().attachments || data().ATTACHMENTS; return t && Object.keys(t).length ? t : FALLBACK_ATTACHMENTS; }
function itemTable() { const t = data().items || data().ITEMS; return t && Object.keys(t).length ? t : FALLBACK_ITEMS; }
function skinTable() { const t = data().skins || data().SKINS; return Array.isArray(t) && t.length ? t : FALLBACK_SKINS; }
function storeTable() {
  const t = data().storeItems || data().STORE_ITEMS;
  if (Array.isArray(t) && t.length) return t;
  return skinTable();
}
function achievementTable() {
  const t = data().achievements || data().ACHIEVEMENTS;
  return Array.isArray(t) && t.length ? t : FALLBACK_ACHIEVEMENTS;
}
function dailyMissions() {
  const t = data().missions || data().DAILY_POOL;
  const list = Array.isArray(t) ? t : FALLBACK_MISSIONS;
  return list.slice(0, 3);
}
function weeklyMissions() {
  const t = data().weeklyMissions || data().WEEKLY_POOL;
  const list = Array.isArray(t) ? t : FALLBACK_WEEKLY;
  return list.slice(0, 3);
}
function enemyCatalog() {
  const t = data().enemies;
  if (Array.isArray(t) && t.length) return t;
  return [
    { id: 'walker', name: '游荡者', desc: '被信号风暴侵蚀的岛民，成群出现，动作迟缓。', hp: 90, damage: 12, threat: 1 },
    { id: 'runner', name: '疾行者', desc: '行动极快，会绕开正面火力扑向后方。', hp: 70, damage: 16, threat: 2 },
    { id: 'brute', name: '重装者', desc: '披挂废钢的重型敌人，需要持续输出才能击倒。', hp: 320, damage: 34, threat: 3 },
    { id: 'stalker', name: '潜猎者', desc: '在雾中隐身接近，靠近后才会暴露轮廓。', hp: 140, damage: 26, threat: 3 },
    { id: 'boss', name: '潮汐之影', desc: '波次首领。释放冲击波并召唤游荡者，弱点在背部。', hp: 2400, damage: 58, threat: 5 },
  ];
}
function mapList() {
  const maps = data().maps || MAPS;
  const order = Array.isArray(data().mapOrder) ? data().mapOrder : MAP_ORDER;
  return order.filter(id => maps[id]).map(id => maps[id]);
}

// ── 04 · 存档访问（app.meta 由 metacontent 提供；全部可选链容错） ────────────
function meta() { return app?.meta || null; }
function saveData() {
  const m = meta();
  if (!m) return {};
  try { if (m.data) return m.data; } catch { /* 忽略损坏存档 */ }
  return {};
}
function playerLevel() {
  const m = meta();
  if (m?.level != null) return m.level;
  return saveData().level || 1;
}
function credits() {
  const m = meta();
  if (m?.credits != null) return m.credits;
  return saveData().credits || 0;
}
function rating() {
  const m = meta();
  if (m?.rating != null) return m.rating;
  return saveData().rating || 0;
}
function xpInfo() {
  const m = meta();
  try { if (m?.xpInfo) return m.xpInfo(); } catch { /* 回退 */ }
  const bg = data().progression;
  const save = saveData();
  const xp = save.xp || 0;
  if (bg?.levelFromXp) { try { return bg.levelFromXp(xp); } catch { /* 回退 */ } }
  const level = save.level || 1;
  const needed = 400 + level * 120;
  return { level, current: xp % needed, needed };
}
function rankInfo() {
  const r = rating();
  const bg = data().progression || {};
  if (bg.rankFor) { try { return bg.rankFor(r); } catch { /* 回退 */ } }
  let tier = RANK_TIERS[0];
  for (const t of RANK_TIERS) if (r >= t.min) tier = t;
  return { tier: tier.name, name: tier.name, color: tier.color, division: 1, progress: 0.4 };
}
function loadout() {
  const m = meta();
  try { if (m?.loadout) return m.loadout; } catch { /* 回退 */ }
  const save = saveData();
  if (save.loadout) return save.loadout;
  return { primary: 'ar7', secondary: 'p9', attachments: { primary: ['red_dot'], secondary: [] }, skin: 'skin_default', throwable: 'frag', consumable: 'medkit' };
}
function isUnlocked(kind, id) {
  const m = meta();
  try { if (m?.isUnlocked) return !!m.isUnlocked(kind, id); } catch { /* 回退 */ }
  const save = saveData();
  return !!save.unlocked?.[kind]?.includes(id);
}
function missionState(id, weekly) {
  const m = saveData().missions || {};
  const bucket = weekly ? m.weekly : m.daily;
  return bucket?.[id] || { progress: 0, done: false, claimed: false };
}
function achievementState(id) {
  return saveData().achievements?.[id] || { progress: 0, done: false, claimed: false };
}

// ── 05 · 外壳：根容器 / 导航 / 屏幕注册 / toast ─────────────────────────────
const SCREEN_META = {
  home: { title: '主菜单', sub: 'MIST ISLE' },
  play: { title: '出击', sub: 'DEPLOYMENT' },
  loadout: { title: '装备', sub: 'LOADOUT' },
  store: { title: '商店', sub: 'STORE' },
  missions: { title: '任务', sub: 'MISSIONS' },
  codex: { title: '图鉴', sub: 'CODEX' },
  career: { title: '生涯', sub: 'CAREER' },
  settings: { title: '设置', sub: 'SETTINGS' },
};
const OWNER_NAME = '旅人';

function roots() {
  return {
    screen: document.getElementById('screen-root'),
    dialog: document.getElementById('dialog-root'),
    toast: document.getElementById('toast-root'),
  };
}
function screenEl(name) { return screens.get(name)?.el || null; }

function makeScreen(name) {
  const el = h('section', 'screen');
  el.dataset.screen = name;
  el.style.pointerEvents = 'auto';
  el.style.display = 'none';
  const bg = h('div', 'screen-bg');
  bg.setAttribute('aria-hidden', 'true');
  el.append(bg);
  if (name !== 'home') el.append(h('div', 'screen-scrim'));
  return el;
}

function makeChrome() {
  const bar = h('div', 'app-bar');
  bar.style.pointerEvents = 'auto';
  const back = h('button', 'icon-btn app-bar-back');
  back.id = 'btn-home-back';
  back.type = 'button';
  back.setAttribute('aria-label', '返回主菜单');
  back.append(icon('back'));
  back.addEventListener('click', () => openScreen('home'));
  const titleWrap = h('div', 'app-bar-title');
  const title = h('b', null, SCREEN_META.play.title);
  title.id = 'app-bar-title';
  const sub = h('small', null, SCREEN_META.play.sub);
  sub.id = 'app-bar-sub';
  titleWrap.append(title, sub);
  const spacer = h('div', 'spacer');
  const creditsWrap = h('div', 'currency currency-credits');
  creditsWrap.append(icon('coin', 16), h('b', 'js-credits', '0'), h('small', null, '信用点'));
  const xpWrap = h('div', 'currency currency-xp');
  xpWrap.append(icon('star', 16), h('b', 'js-level', '1'), h('small', null, '等级'));
  const help = h('button', 'icon-btn');
  help.id = 'btn-help';
  help.type = 'button';
  help.setAttribute('aria-label', '操作说明');
  help.append(icon('help'));
  help.addEventListener('click', () => showHelpDialog());
  bar.append(back, titleWrap, spacer, creditsWrap, xpWrap, help);
  return bar;
}

function setActiveScreen(name) {
  for (const [key, entry] of screens) {
    const active = key === name;
    entry.el.classList.toggle('active', active);
    entry.el.style.display = active ? '' : 'none';
    entry.el.setAttribute('aria-hidden', active ? 'false' : 'true');
  }
  activeScreen = name;
  const bar = document.getElementById('app-bar');
  if (bar) bar.style.display = name === 'home' ? 'none' : '';
  const title = $('#app-bar-title');
  const sub = $('#app-bar-sub');
  if (title) setText(title, SCREEN_META[name]?.title || '');
  if (sub) setText(sub, SCREEN_META[name]?.sub || '');
  const root = document.getElementById('screen-root');
  if (root) root.dataset.active = name;
}

export function openScreen(name) {
  if (!screens.has(name)) return;
  setActiveScreen(name);
  screens.get(name)?.render?.();
  refreshChrome();
}
export function closeScreens() {
  for (const entry of screens.values()) {
    entry.el.classList.remove('active');
    entry.el.style.display = 'none';
    entry.el.setAttribute('aria-hidden', 'true');
  }
  activeScreen = null;
  const bar = document.getElementById('app-bar');
  if (bar) bar.style.display = 'none';
  const root = document.getElementById('screen-root');
  if (root) root.dataset.active = '';
}

// ── 06 · toast ──────────────────────────────────────────────────────────────
const toastTimers = new WeakMap();
export function toast(message, ms = 2400) {
  const text = String(message ?? '').trim();
  if (!text) return;
  const host = document.getElementById('toast-root');
  if (!host) return;
  let node = [...host.children].find(el => el.dataset.msg === text && !el.dataset.leaving);
  if (node) {
    node.dataset.leaving = '1';
    setTimeout(() => node.remove(), 200);
  }
  node = h('div', 'toast', text);
  node.dataset.msg = text;
  node.setAttribute('role', 'status');
  host.append(node);
  while (host.children.length > 3) host.firstElementChild?.remove();
  requestAnimationFrame(() => node.classList.add('show'));
  const timer = setTimeout(() => {
    node.classList.remove('show');
    node.dataset.leaving = '1';
    setTimeout(() => node.remove(), 260);
  }, Math.max(700, Number(ms) || 2400));
  toastTimers.set(node, timer);
}

// ── 07 · 通用小组件 ─────────────────────────────────────────────────────────
function iconBtn(label, iconName, handler, extraClass = '') {
  const btn = h('button', `icon-btn ${extraClass}`.trim());
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.append(icon(iconName));
  if (handler) btn.addEventListener('click', handler);
  return btn;
}
function diffDots(level) {
  const wrap = h('span', 'diff-dots');
  wrap.setAttribute('aria-label', `难度 ${level} / 3`);
  for (let i = 0; i < 3; i++) {
    const dot = h('i', i < level ? 'on' : '');
    wrap.append(dot);
  }
  return wrap;
}
function rarityTag(rarity) {
  const tag = h('span', `rarity-tag ${rarityClass(rarity)}`, rarityName(rarity));
  return tag;
}
function statBar(value, max, color) {
  const track = h('div', 'stat-bar');
  const fill = h('i');
  const pct = Math.max(0, Math.min(100, (Number(value) / (Number(max) || 1)) * 100));
  fill.style.width = `${pct.toFixed(1)}%`;
  if (color) fill.style.background = color;
  track.append(fill);
  return track;
}
function emptyState(text) {
  const box = h('div', 'empty-state');
  box.append(icon('box', 28), h('p', 'muted', text));
  return box;
}

// ── 08 · 主菜单 ─────────────────────────────────────────────────────────────
const HOME_NAV = [
  { id: 'play', name: '出击', en: 'DEPLOY', desc: '选择模式与战场' },
  { id: 'loadout', name: '装备', en: 'LOADOUT', desc: '武器、配件与外观' },
  { id: 'store', name: '商店', en: 'STORE', desc: '解锁新的外观' },
  { id: 'missions', name: '任务', en: 'MISSIONS', desc: '每日与每周目标' },
  { id: 'codex', name: '图鉴', en: 'CODEX', desc: '武器、道具与地图档案' },
  { id: 'career', name: '生涯', en: 'CAREER', desc: '段位、统计与成就' },
  { id: 'settings', name: '设置', en: 'SETTINGS', desc: '音画与操作偏好' },
];

function buildHome() {
  const el = makeScreen('home');
  const hero = h('div', 'home-hero');
  const eyebrow = h('div', 'eyebrow', 'TACTICAL SURVIVAL · 64 PLAYERS');
  const logo = h('div', 'home-logo');
  const cn = h('h1', 'title-xl home-logo-cn', '雾岛突围');
  const en = h('div', 'home-logo-en', 'MIST ISLE');
  const tag = h('p', 'home-tagline', '雾散了，活到最后的人才能离开。');
  logo.append(cn, en, tag);
  hero.append(eyebrow, logo);

  const nav = h('div', 'home-nav');
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', '主菜单导航');
  for (const item of HOME_NAV) {
    const btn = h('button', 'home-nav-item');
    btn.type = 'button';
    btn.dataset.nav = item.id;
    btn.id = `nav-${item.id}`;
    btn.setAttribute('aria-label', `${item.name} · ${item.desc}`);
    const ic = h('span', 'home-nav-icon');
    ic.append(icon(item.id === 'play' ? 'play' : item.id, 22));
    const text = h('span', 'home-nav-text');
    text.append(h('b', null, item.name), h('small', null, item.en));
    const dot = h('span', 'badge dot');
    dot.dataset.badge = item.id;
    dot.style.display = 'none';
    btn.append(ic, text, dot);
    btn.addEventListener('click', () => openScreen(item.id));
    nav.append(btn);
  }

  const player = h('aside', 'player-card');
  player.id = 'player-card';
  const avatar = h('div', 'avatar');
  avatar.append(icon('user' in ICONS ? 'user' : 'shield', 24));
  const levelRing = h('div', 'level-ring');
  const levelNum = h('b', 'js-level', '1');
  levelRing.append(levelNum, h('small', null, 'LV'));
  const metaWrap = h('div', 'player-meta');
  const nameLine = h('b', 'player-name', OWNER_NAME);
  nameLine.id = 'player-name-home';
  const rankLine = h('small', 'player-rank', '青铜');
  rankLine.id = 'player-rank-home';
  const bar = h('div', 'progress');
  const fill = h('i');
  fill.dataset.role = 'xp-fill';
  bar.append(fill);
  const creditLine = h('div', 'player-credits');
  creditLine.append(icon('coin', 14), h('b', 'js-credits', '0'), h('small', null, '信用点'));
  metaWrap.append(nameLine, rankLine, bar, creditLine);
  player.append(levelRing, metaWrap);

  const foot = h('footer', 'home-foot');
  const hint = h('span', 'home-hint muted', touchDevice ? '触屏操作 · 左摇杆移动 · 右摇杆瞄准开火' : 'WASD 移动 · 鼠标瞄准射击 · Esc 呼出菜单');
  const version = h('span', 'version', `v${VERSION} · BUILD 1.0.0`);
  version.id = 'version-label';
  foot.append(hint, version);
  el.append(hero, nav, player, foot);
  return el;
}

// ── 09 · 出击 / 模式与地图选择 ───────────────────────────────────────────────
const MODE_LIST = [
  { id: 'solo', name: '单人生存', en: 'SOLO', desc: '64 人各自为战，没有队友，只有最后的幸存者。', meta: '64 人 · 单排 · 约 7 分钟' },
  { id: 'squad', name: '四人小队', en: 'SQUAD', desc: '四人协同搜刮、扶起倒地的队友，一起撑到决赛圈。', meta: '16 队 · 四人 · 约 8 分钟' },
  { id: 'horde', name: '生存波次', en: 'HORDE', desc: '守住基地，抵御十波侵蚀者。阵亡后 8 秒重返战场。', meta: '4 人协作 · 10 波 · 约 10 分钟' },
  { id: 'training', name: '训练场', en: 'TRAINING', desc: '与 15 名 AI 对战，熟悉枪械手感与地图路线。', meta: '离线可玩 · 自由练习' },
];
const uiState = { mode: 'squad', mapId: 'qinglan', difficulty: 'veteran', storeTab: 'character', codexTab: 'weapon' };

function buildPlay() {
  const el = makeScreen('play');
  el.append(makeChrome());
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head');
  head.append(h('div', 'eyebrow', 'DEPLOYMENT'), h('h2', 'title-lg', '选择你的战场'), h('p', 'muted', '行动开始前，确认模式、地图与敌人强度。'));
  body.append(head);

  const main = h('div', 'screen-main play-main');
  const modes = h('div', 'mode-grid');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '对局模式');
  for (const mode of MODE_LIST) {
    const btn = h('button', 'mode-pick');
    btn.type = 'button';
    btn.dataset.mode = mode.id;
    btn.id = `mode-${mode.id}`;
    btn.setAttribute('aria-label', `${mode.name}，${mode.meta}`);
    const ic = h('span', 'mode-icon');
    ic.append(icon(mode.id === 'solo' ? 'target' : mode.id === 'squad' ? 'users' : mode.id === 'horde' ? 'waves' : 'gamepad', 22));
    const info = h('span', 'mode-body');
    info.append(h('b', 'mode-name', mode.name), h('span', 'mode-en', mode.en), h('small', 'mode-desc', mode.desc));
    btn.append(ic, info, h('span', 'mode-meta muted', mode.meta));
    btn.addEventListener('click', () => { uiState.mode = mode.id; renderPlaySelection(); });
    modes.append(btn);
  }
  main.append(modes);

  const maps = h('div', 'map-row');
  maps.setAttribute('role', 'group');
  maps.setAttribute('aria-label', '地图选择');
  for (const map of mapList()) {
    const btn = h('button', 'map-pick');
    btn.type = 'button';
    btn.dataset.map = map.id;
    btn.id = `map-${map.id}`;
    btn.setAttribute('aria-label', `${map.name}，难度 ${map.difficulty}/3`);
    const art = h('div', `map-art map-art-${map.id}`);
    art.append(h('span', 'map-art-grid'));
    const body2 = h('div', 'map-body');
    const titleRow = h('div', 'row');
    titleRow.append(h('b', 'map-name', map.name), diffDots(map.difficulty || 1));
    body2.append(titleRow, h('small', 'map-sub muted', map.subtitle || map.en || ''));
    const desc = h('p', 'map-desc', map.description || '');
    const tags = h('div', 'map-tags');
    if (map.weather) tags.append(h('span', 'chip chip-xs', `天气 · ${map.weather}`));
    if (map.timeOfDay) tags.append(h('span', 'chip chip-xs', `时段 · ${map.timeOfDay}`));
    tags.append(h('span', 'chip chip-xs', `${map.regions?.length || 9} 个区域`));
    body2.append(desc, tags);
    btn.append(art, body2);
    btn.addEventListener('click', () => { uiState.mapId = map.id; renderPlaySelection(); });
    maps.append(btn);
  }
  main.append(maps);

  const diffRow = h('div', 'difficulty-row');
  diffRow.append(h('span', 'field-label', '敌人强度'));
  const diffGroup = h('div', 'segmented');
  diffGroup.setAttribute('role', 'group');
  diffGroup.setAttribute('aria-label', '敌人强度');
  for (const [key, def] of Object.entries(DIFFICULTY)) {
    const btn = h('button', null, def.name);
    btn.type = 'button';
    btn.dataset.diff = key;
    btn.id = `diff-${key}`;
    btn.title = def.desc || '';
    btn.addEventListener('click', () => { uiState.difficulty = key; renderPlaySelection(); });
    diffGroup.append(btn);
  }
  diffRow.append(diffGroup, h('small', 'diff-desc muted', DIFFICULTY[uiState.difficulty]?.desc || ''));
  main.append(diffRow);

  const actions = h('div', 'play-actions');
  const start = h('button', 'btn btn-primary btn-lg');
  start.type = 'button';
  start.id = 'btn-offline';
  start.append(icon('play'), h('span', null, '开始行动'));
  start.addEventListener('click', () => startOffline());
  const online = h('button', 'btn btn-ghost btn-lg');
  online.type = 'button';
  online.id = 'btn-online';
  online.append(icon('wifi'), h('span', null, '联机组队'));
  online.addEventListener('click', () => showOnlineDialog());
  actions.append(start, online);
  main.append(actions);
  body.append(main);

  const side = h('aside', 'screen-side play-side');
  const squadPanel = h('section', 'panel');
  squadPanel.append(h('div', 'panel-head', '小队'), h('p', 'muted panel-note', '空位将在开局时由 AI 补满。'));
  const grid = h('div', 'squad-grid');
  for (let i = 0; i < SQUAD_SIZE; i++) {
    const slot = h('div', 'squad-slot empty');
    slot.append(h('span', 'squad-slot-idx', `0${i + 1}`), h('span', 'squad-slot-name', i === 0 ? '你' : '等待加入'));
    grid.append(slot);
  }
  squadPanel.append(grid);
  const intel = h('section', 'panel');
  intel.append(h('div', 'panel-head', '战场情报'));
  const stats = h('div', 'stat-grid');
  for (const [label, value] of [['战局容量', '64 席'], ['小队编制', '4 人'], ['安全区阶段', '5 阶段'], ['预计时长', '6 – 10 分钟']]) {
    const stat = h('div', 'stat');
    stat.append(h('small', null, label), h('b', null, value));
    stats.append(stat);
  }
  intel.append(stats);
  const rules = h('section', 'panel panel-tips');
  rules.append(h('div', 'panel-head', '行动要点'));
  const ul = h('ul', 'tip-list');
  for (const tip of ['落地先找武器与护甲，再决定转移路线。', '安全区收缩时优先占据高地与建筑。', '队友倒地后 30 秒内完成救援。', '空投物资稀有，但也是最好的诱饵。']) {
    ul.append(h('li', null, tip));
  }
  rules.append(ul);
  side.append(squadPanel, intel, rules);
  body.append(side);
  el.append(body);
  return el;
}

function renderPlaySelection() {
  const el = screenEl('play');
  if (!el) return;
  for (const btn of el.querySelectorAll('.mode-pick')) btn.classList.toggle('active', btn.dataset.mode === uiState.mode);
  for (const btn of el.querySelectorAll('.map-pick')) btn.classList.toggle('active', btn.dataset.map === uiState.mapId);
  for (const btn of el.querySelectorAll('.segmented > button')) btn.classList.toggle('active', btn.dataset.diff === uiState.difficulty);
  const desc = $('#play .diff-desc');
  if (desc) setText(desc, DIFFICULTY[uiState.difficulty]?.desc || '');
  const start = $('#btn-offline');
  if (start) {
    const modeName = MODE_LIST.find(m => m.id === uiState.mode)?.name || '行动';
    setText(start.querySelector('span'), `${modeName} · 开始`);
  }
}

// ── 10 · 装备 ───────────────────────────────────────────────────────────────
const SLOT_DEFS = [
  { key: 'primary', name: '主武器', hint: '决定中远距离作战方式' },
  { key: 'secondary', name: '副武器', hint: '主武器弹尽时的保命选择' },
];
const ATTACH_SLOTS = [
  { id: 'optic', name: '瞄具' },
  { id: 'muzzle', name: '枪口' },
  { id: 'mag', name: '弹匣' },
  { id: 'grip', name: '握把' },
];
const CONSUMABLE_LIST = ['bandage', 'medkit', 'energy', 'shield'];
const THROWABLE_LIST = ['frag', 'smoke', 'flash', 'molotov'];

function weaponOf(id) { return weaponTable()[id] || null; }
function attachmentsForWeapon(weaponId) {
  const weapon = weaponOf(weaponId);
  const slots = weapon?.slots || ['optic', 'muzzle', 'mag', 'grip'];
  return Object.values(attachmentTable()).filter(att => slots.includes(att.slot) || !att.slot);
}
function currentAttachment(slotId) {
  const att = loadout().attachments?.[slotId];
  return Array.isArray(att) ? att : [];
}

function buildLoadout() {
  const el = makeScreen('loadout');
  el.append(makeChrome());
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head');
  head.append(h('div', 'eyebrow', 'LOADOUT'), h('h2', 'title-lg', '出战装备'), h('p', 'muted', '武器按等级解锁；配件可从战场拾取，装备栏决定开局携带。'));
  body.append(head);

  const main = h('div', 'screen-main loadout-main');
  const slotsRow = h('div', 'weapon-slots');
  for (const def of SLOT_DEFS) {
    const card = h('button', 'slot weapon-slot');
    card.type = 'button';
    card.dataset.slot = def.key;
    card.id = `loadout-slot-${def.key}`;
    card.setAttribute('aria-label', `${def.name}选择`);
    const art = h('div', 'slot-art');
    const name = h('b', 'item-name');
    const sub = h('small', 'muted');
    const info = h('span', 'slot-info');
    info.append(name, sub);
    card.append(h('span', 'slot-label', def.name), art, info);
    card.addEventListener('click', () => pickWeaponFor(def.key));
    slotsRow.append(card);
  }
  main.append(slotsRow);

  const attachPanel = h('section', 'panel');
  attachPanel.append(h('div', 'panel-head', '配件'));
  const attachGrid = h('div', 'attachment-grid');
  for (const slot of ATTACH_SLOTS) {
    const btn = h('button', 'slot slot-sm');
    btn.type = 'button';
    btn.dataset.attach = slot.id;
    btn.id = `attach-${slot.id}`;
    btn.setAttribute('aria-label', `${slot.name}槽`);
    btn.append(h('small', 'muted', slot.name));
    const value = h('b', null, '空');
    btn.append(value);
    btn.addEventListener('click', () => pickAttachment(slot.id));
    attachGrid.append(btn);
  }
  attachPanel.append(attachGrid, h('p', 'field-help muted', '点击槽位在已装配件中切换；拾取的新配件会自动替换低阶配件。'));
  main.append(attachPanel);

  const consumables = h('section', 'panel');
  consumables.append(h('div', 'panel-head', '消耗品'));
  const chipRow = h('div', 'chip-row');
  for (const id of CONSUMABLE_LIST) {
    const def = itemTable()[id] || { name: id };
    const btn = h('button', 'chip');
    btn.type = 'button';
    btn.dataset.consumable = id;
    btn.id = `consumable-${id}`;
    btn.setAttribute('aria-label', `${def.name}，开局携带`);
    btn.append(h('b', null, def.name), h('small', 'muted', def.desc || ''));
    btn.addEventListener('click', () => equipConsumable(id));
    chipRow.append(btn);
  }
  consumables.append(chipRow);
  main.append(consumables);

  const throwables = h('section', 'panel');
  throwables.append(h('div', 'panel-head', '投掷物'));
  const throwRow = h('div', 'chip-row');
  for (const id of THROWABLE_LIST) {
    const def = itemTable()[id] || { name: id };
    const btn = h('button', 'chip throwable-chip');
    btn.type = 'button';
    btn.dataset.throwable = id;
    btn.id = `throwable-${id}`;
    btn.setAttribute('aria-label', `${def.name}，开局携带`);
    btn.append(icon('fire', 16), h('b', null, def.name), h('small', 'muted', def.desc || ''));
    btn.addEventListener('click', () => equipThrowable(id));
    throwRow.append(btn);
  }
  throwables.append(throwRow);
  main.append(throwables);

  const skins = h('section', 'panel');
  skins.append(h('div', 'panel-head', '角色外观'));
  const skinGrid = h('div', 'skin-grid');
  skinGrid.id = 'skin-grid';
  skins.append(skinGrid);
  main.append(skins);
  body.append(main);

  const side = h('aside', 'screen-side loadout-side');
  const preview = h('section', 'panel preview-panel');
  preview.append(h('div', 'panel-head', '预览'));
  const stage = h('div', 'preview-stage');
  stage.id = 'preview-stage';
  const stageHint = h('div', 'preview-hint');
  stageHint.append(icon('eye', 26), h('small', 'muted', '武器与皮肤实时预览'));
  stage.append(stageHint);
  preview.append(stage, h('div', 'preview-label', '当前外观'));
  side.append(preview);
  const statsPanel = h('section', 'panel');
  statsPanel.append(h('div', 'panel-head', '主武器数据'));
  const statsBox = h('div', 'stat-rows');
  statsBox.id = 'loadout-stats';
  statsPanel.append(statsBox);
  side.append(statsPanel);
  body.append(side);
  el.append(body);
  return el;
}

function renderLoadout() {
  const el = screenEl('loadout');
  if (!el) return;
  const lo = loadout();
  for (const def of SLOT_DEFS) {
    const card = $(`#loadout-slot-${def.key}`, el);
    if (!card) continue;
    const w = weaponOf(lo[def.key]);
    const name = $('.item-name', card);
    const sub = $('.slot-info small', card);
    const art = $('.slot-art', card);
    setText(name, w?.name || '未装备');
    setText(sub, w ? `${w.cls || '通用'} · ${rarityName(w.rarity)} · 伤害 ${w.damage || DASH}` : '点击选择武器');
    card.classList.toggle('empty', !w);
    card.classList.toggle('locked', !!w && !isUnlocked('weapons', lo[def.key]) && (w.unlock || 1) > playerLevel());
    if (art) {
      clear(art);
      const gun = h('i', 'slot-art-gun');
      art.append(gun);
      if (w) art.style.setProperty('--rarity', rarityColor(w.rarity));
    }
  }
  for (const slot of ATTACH_SLOTS) {
    const btn = $(`#attach-${slot.id}`, el);
    if (!btn) continue;
    const equipped = currentAttachment('primary').filter(id => attachmentTable()[id]?.slot === slot.id);
    const value = $('b', btn);
    setText(value, equipped.length ? attachmentTable()[equipped[0]]?.name || equipped[0] : '空');
    btn.classList.toggle('filled', equipped.length > 0);
  }
  for (const btn of el.querySelectorAll('[data-consumable]')) btn.classList.toggle('active', btn.dataset.consumable === (lo.consumable || 'medkit'));
  for (const btn of el.querySelectorAll('[data-throwable]')) btn.classList.toggle('active', btn.dataset.throwable === (lo.throwable || 'frag'));
  renderSkins();
  renderLoadoutStats();
}

function renderSkins() {
  const grid = document.getElementById('skin-grid');
  if (!grid) return;
  clear(grid);
  const lo = loadout();
  for (const skin of skinTable()) {
    const card = h('button', 'skin-card');
    card.type = 'button';
    card.dataset.skin = skin.id;
    card.id = `skin-${skin.id}`;
    card.setAttribute('aria-label', `${skin.name}，${rarityName(skin.rarity)}`);
    const art = h('div', 'skin-art');
    art.style.setProperty('--primary', skin.colors?.primary ? `#${skin.colors.primary.toString(16).padStart(6, '0')}` : '#4a6b6d');
    art.style.setProperty('--secondary', skin.colors?.secondary ? `#${skin.colors.secondary.toString(16).padStart(6, '0')}` : '#26464a');
    const info = h('div', 'item-meta');
    info.append(h('b', 'item-name', skin.name), h('small', `muted ${rarityClass(skin.rarity)}`, rarityName(skin.rarity)));
    card.append(art, info);
    const equipped = lo.skin === skin.id;
    if (equipped) {
      card.classList.add('equipped');
      card.append(h('span', 'badge', '已装备'));
    }
    const unlocked = isUnlocked('skins', skin.id);
    if (!unlocked) {
      card.classList.add('locked');
      card.append(h('span', 'badge muted', '未解锁'));
    }
    card.addEventListener('click', () => { if (unlocked) equipSkin(skin.id); });
    grid.append(card);
  }
  const stage = document.getElementById('preview-stage');
  if (stage) stage.dataset.skin = lo.skin || 'skin_default';
}

function renderLoadoutStats() {
  const box = document.getElementById('loadout-stats');
  if (!box) return;
  clear(box);
  const w = weaponOf(loadout().primary) || {};
  const rows = [
    ['伤害', w.damage || 0, 130],
    ['射速', w.magazine ? Math.round(60 / (w.interval || 0.12)) : 0, 900],
    ['射程', w.range || 0, 120],
    ['弹匣', w.magazine || 0, 80],
    ['稳定性', Math.round((1 - (w.spread || 0.03) * 10) * 100), 100],
  ];
  for (const [label, value, max] of rows) {
    const row = h('div', 'stat-row');
    row.append(h('small', 'stat-label', label), h('b', 'stat-value', value), statBar(value, max, 'var(--c-teal-400)'));
    box.append(row);
  }
}

function pickWeaponFor(slotKey) {
  const unlockedLevel = playerLevel();
  const options = Object.entries(weaponTable()).map(([id, w]) => ({ id, ...w }));
  const list = h('div', 'pick-list');
  for (const w of options) {
    const locked = (w.unlock || 1) > unlockedLevel;
    const row = h('button', `pick-row ${rarityClass(w.rarity)}`);
    row.type = 'button';
    row.disabled = locked;
    row.setAttribute('aria-label', `${w.name}${locked ? '，等级未解锁' : ''}`);
    const main = h('span', 'pick-main');
    main.append(h('b', null, w.name), h('small', 'muted', `${w.cls || '通用'} · ${rarityName(w.rarity)}`));
    const right = h('span', 'pick-right');
    if (locked) right.append(h('span', 'badge muted', `LV.${w.unlock} 解锁`));
    else if (loadout()[slotKey] === w.id) right.append(h('span', 'badge', '已装备'));
    row.append(main, right);
    row.addEventListener('click', () => {
      if (locked) return;
      setLoadoutValue(slotKey, w.id);
      hidePickDialog();
      renderLoadout();
      toast(`已装备 ${w.name}`);
    });
    list.append(row);
  }
  const picker = showModal('pick-dialog', {
    title: slotKey === 'primary' ? '选择主武器' : '选择副武器',
    eyebrow: 'ARMORY',
    body: list,
  });
  picker.querySelector('.modal-card').classList.add('modal-wide');
}

function setLoadoutValue(key, value) {
  const m = meta();
  const lo = { ...loadout(), [key]: value };
  try { if (m?.setLoadout) { m.setLoadout(lo); return; } } catch { /* 回退 */ }
  app?.setLoadout?.(lo);
}

function equipSkin(id) {
  const m = meta();
  try {
    if (m?.equipSkin) { m.equipSkin(id); renderLoadout(); toast('外观已更换'); return; }
  } catch { /* 回退 */ }
  setLoadoutValue('skin', id);
  renderLoadout();
  toast('外观已更换');
}

function equipConsumable(id) {
  setLoadoutValue('consumable', id);
  renderLoadout();
  toast(`开局携带 ${itemTable()[id]?.name || id}`);
}

function equipThrowable(id) {
  setLoadoutValue('throwable', id);
  renderLoadout();
  toast(`开局携带 ${itemTable()[id]?.name || id}`);
}

function pickAttachment(slotId) {
  const options = attachmentsForWeapon(loadout().primary).filter(att => att.slot === slotId);
  if (!options.length) { toast('该武器没有此类配件槽'); return; }
  const list = h('div', 'pick-list');
  for (const att of options) {
    const row = h('button', `pick-row ${rarityClass(att.rarity)}`);
    row.type = 'button';
    row.setAttribute('aria-label', att.name);
    const main = h('span', 'pick-main');
    main.append(h('b', null, att.name), h('small', 'muted', att.desc || ''));
    row.append(main, h('span', 'badge', rarityName(att.rarity)));
    row.addEventListener('click', () => {
      setAttachment(slotId, att.id);
      hidePickDialog();
      renderLoadout();
      toast(`已装配 ${att.name}`);
    });
    list.append(row);
  }
  const picker = showModal('pick-dialog', { title: '装配配件', eyebrow: 'ATTACHMENT', body: list });
  picker.querySelector('.modal-card').classList.add('modal-wide');
}

function setAttachment(slotId, attachmentId) {
  const lo = loadout();
  const primary = [...(lo.attachments?.primary || [])];
  const slot = attachmentTable()[attachmentId]?.slot;
  const filtered = primary.filter(id => attachmentTable()[id]?.slot !== slot);
  filtered.push(attachmentId);
  const next = { ...lo, attachments: { ...(lo.attachments || {}), primary: filtered } };
  const m = meta();
  try { if (m?.setLoadout) { m.setLoadout(next); return; } } catch { /* 回退 */ }
  app?.setLoadout?.(next);
}

// ── 11 · 商店 ───────────────────────────────────────────────────────────────
function buildStore() {
  const el = makeScreen('store');
  el.append(makeChrome());
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head row');
  const headText = h('div', 'grow');
  headText.append(h('div', 'eyebrow amber', 'STORE'), h('h2', 'title-lg', '外观商店'), h('p', 'muted', '所有外观仅影响视觉，不影响任何战斗属性。'));
  head.append(headText);
  const wallet = h('div', 'wallet');
  wallet.append(icon('coin', 18), h('b', 'js-credits', '0'), h('small', 'muted', '信用点'));
  head.append(wallet);
  body.append(head);

  const tabs = h('div', 'tabs store-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const tab of storeTabs) {
    const btn = h('button', 'tab', tab.name);
    btn.type = 'button';
    btn.dataset.tab = tab.id;
    btn.id = `store-tab-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => { uiState.storeTab = tab.id; renderStore(); });
    tabs.append(btn);
  }
  body.append(tabs);

  const grid = h('div', 'store-grid');
  grid.id = 'store-grid';
  body.append(grid);

  const note = h('footer', 'screen-foot');
  note.append(h('span', 'muted', '信用点通过对局、任务与成就获得。'), h('span', 'version', `v${VERSION}`));
  body.append(note);
  el.append(body);
  return el;
}

function skinKind(skin) {
  if (skin.kind === 'weapon' || skin.weapon) return 'weapon';
  if (skin.kind === 'other' || skin.kind === 'emote' || skin.kind === 'spray') return 'other';
  return 'character';
}

function renderStore() {
  const el = screenEl('store');
  if (!el) return;
  for (const tab of el.querySelectorAll('.store-tabs .tab')) {
    const active = tab.dataset.tab === uiState.storeTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  const grid = document.getElementById('store-grid');
  if (!grid) return;
  clear(grid);
  const wallet = credits();
  const items = storeTable().filter(item => skinKind(item) === uiState.storeTab);
  if (!items.length) { grid.append(emptyState('这一类外观还在准备中，先去打一局吧。')); return; }
  for (const item of items) {
    const owned = isUnlocked('skins', item.id);
    const equipped = loadout().skin === item.id;
    const canBuy = !owned && wallet >= (item.price || 0);
    const card = h('article', `card store-card ${rarityClass(item.rarity)}`);
    card.dataset.item = item.id;
    card.id = `store-item-${item.id}`;
    const art = h('div', 'item-art');
    art.style.setProperty('--primary', item.colors?.primary ? `#${item.colors.primary.toString(16).padStart(6, '0')}` : '#3d6668');
    art.append(h('span', 'item-art-grid'));
    const metaBox = h('div', 'item-meta');
    const titleRow = h('div', 'row');
    titleRow.append(h('b', 'item-name', item.name || item.id), rarityTag(item.rarity));
    metaBox.append(titleRow);
    metaBox.append(h('p', 'item-desc muted', item.desc || item.description || '外观物品。'));
    const foot = h('div', 'item-foot');
    const price = h('div', 'price');
    if (owned) {
      price.append(h('span', 'owned-tag', '已拥有'));
    } else {
      price.append(icon('coin', 15), h('b', null, fmtNum(item.price || 0)));
    }
    const action = h('button', `btn btn-sm ${equipped ? 'btn-ghost' : owned ? 'btn-ghost' : 'btn-primary'}`);
    action.type = 'button';
    if (owned) {
      setText(action, equipped ? '已装备' : '装备');
      action.disabled = equipped;
      action.addEventListener('click', () => { equipSkin(item.id); renderStore(); });
    } else {
      setText(action, (item.price || 0) > wallet ? '信用点不足' : '购买');
      action.disabled = !canBuy;
      action.addEventListener('click', () => buySkinItem(item, action));
    }
    foot.append(price, action);
    metaBox.append(foot);
    card.append(art, metaBox);
    if (equipped) card.classList.add('equipped');
    if (!owned) card.classList.add('locked');
    grid.append(card);
  }
}

function buySkinItem(item, button) {
  const m = meta();
  const cost = item.price || 0;
  confirmDialog({
    title: '确认购买',
    message: `花费 ${fmtNum(cost)} 信用点购买「${item.name}」？当前余额 ${fmtNum(credits())}。`,
    confirmText: '确认购买',
    onConfirm: () => {
      let ok = false;
      try {
        if (m?.buySkin) ok = m.buySkin(item.id) !== false;
        else if (m?.buy) ok = m.buy('skin', item.id) !== false;
      } catch (err) { toast(err?.message || '购买失败'); return; }
      if (!ok) { toast('信用点不足或已拥有该外观'); return; }
      if (button) button.dataset.done = '1';
      renderStore();
      refreshChrome();
      toast(`已获得「${item.name}」`, 2200);
    },
  });
}

// ── 12 · 任务 ───────────────────────────────────────────────────────────────
function missionProgressText(mission, state) {
  const progress = Math.min(Number(state.progress) || 0, mission.target || 1);
  return `${fmtNum(progress)} / ${fmtNum(mission.target || 0)}`;
}
function countdownText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '即将刷新';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} 小时 ${mins} 分后刷新`;
  return `${mins} 分 ${String(secs).padStart(2, '0')} 秒后刷新`;
}

function buildMissions() {
  const el = makeScreen('missions');
  el.append(makeChrome());
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head row');
  const headText = h('div', 'grow');
  headText.append(h('div', 'eyebrow', 'MISSIONS'), h('h2', 'title-lg', '任务简报'), h('p', 'muted', '完成任务获取额外经验与信用点。每日任务每天 0 点刷新。'));
  head.append(headText);
  const countdown = h('div', 'countdown');
  countdown.id = 'mission-countdown';
  countdown.append(icon('clock', 16), h('span', null, '—'));
  head.append(countdown);
  body.append(head);

  const groups = h('div', 'mission-groups');
  for (const [key, title, hint] of [['daily', '每日任务', '每天 0 点刷新 · 共 3 个'], ['weekly', '每周任务', '每周一 0 点刷新 · 共 3 个']]) {
    const section = h('section', 'panel mission-group');
    section.dataset.group = key;
    const groupHead = h('div', 'panel-head row');
    groupHead.append(h('b', null, title), h('span', 'spacer'), h('small', 'muted', hint));
    const list = h('div', 'mission-list');
    list.id = `mission-list-${key}`;
    section.append(groupHead, list);
    groups.append(section);
  }
  body.append(groups);

  const achTeaser = h('section', 'panel');
  achTeaser.append(h('div', 'panel-head', '成就进度'));
  const teaser = h('p', 'muted', '成就进度在「生涯」页面查看并领取奖励。');
  const go = h('button', 'btn btn-ghost btn-sm', '前往生涯');
  go.type = 'button';
  go.id = 'btn-go-career';
  go.addEventListener('click', () => openScreen('career'));
  achTeaser.append(teaser, go);
  body.append(achTeaser);
  el.append(body);
  return el;
}

function renderMissions() {
  const el = screenEl('missions');
  if (!el) return;
  const groups = [
    { key: 'daily', list: dailyMissions() },
    { key: 'weekly', list: weeklyMissions() },
  ];
  for (const group of groups) {
    const list = document.getElementById(`mission-list-${group.key}`);
    if (!list) continue;
    clear(list);
    for (const mission of group.list) {
      const state = missionState(mission.id, group.key === 'weekly');
      const row = h('article', 'mission');
      row.dataset.mission = mission.id;
      row.id = `mission-${mission.id}`;
      const iconWrap = h('div', 'mission-icon');
      iconWrap.append(icon(group.key === 'weekly' ? 'trophy' : 'flag', 20));
      const bodyBox = h('div', 'mission-meta');
      const top = h('div', 'row');
      top.append(h('b', 'mission-title', mission.title || mission.id));
      const reward = h('span', 'mission-reward');
      reward.append(h('small', null, `+${mission.xp || 0} 经验`), h('small', null, `+${mission.credits || 0} 信用点`));
      top.append(reward);
      bodyBox.append(top);
      const progress = h('div', 'mission-progress');
      progress.append(h('small', 'muted', missionProgressText(mission, state)));
      const bar = h('div', 'progress');
      const fill = h('i');
      const pct = Math.max(0, Math.min(100, ((Number(state.progress) || 0) / (mission.target || 1)) * 100));
      fill.style.width = `${pct.toFixed(1)}%`;
      if (pct >= 100) fill.classList.add('full');
      bar.append(fill);
      progress.append(bar);
      bodyBox.append(progress);
      row.append(iconWrap, bodyBox);
      const action = h('button', 'btn btn-sm');
      action.type = 'button';
      const done = !!state.done || pct >= 100;
      if (state.claimed) {
        action.classList.add('btn-ghost', 'claimed');
        setText(action, '已领取');
        action.disabled = true;
      } else if (done) {
        action.classList.add('btn-primary', 'claimable');
        setText(action, '领取奖励');
        action.addEventListener('click', () => claimMission(mission, group.key === 'weekly'));
      } else {
        action.classList.add('btn-ghost');
        setText(action, '进行中');
        action.disabled = true;
      }
      row.append(action);
      list.append(row);
    }
  }
  updateMissionCountdown();
}

function claimMission(mission, weekly) {
  const m = meta();
  let ok = false;
  try {
    if (m?.claimMission) ok = m.claimMission(mission.id) !== false;
  } catch (err) { toast(err?.message || '领取失败'); return; }
  if (!ok) { toast('任务尚未完成'); return; }
  renderMissions();
  refreshChrome();
  toast(`任务完成 · +${mission.xp || 0} 经验 · +${mission.credits || 0} 信用点`, 2800);
  flashReward(mission.xp, mission.credits);
}

function updateMissionCountdown() {
  const node = document.getElementById('mission-countdown');
  if (!node) return;
  const span = node.querySelector('span');
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  setText(span, countdownText(next.getTime() - now.getTime()));
}

function flashReward(xp, coin) {
  const host = document.getElementById('toast-root');
  if (!host) return;
  const node = h('div', 'toast reward-toast');
  node.append(h('b', null, `+${fmtNum(xp)} 经验`), h('span', null, `+${fmtNum(coin)} 信用点`));
  host.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => { node.classList.remove('show'); setTimeout(() => node.remove(), 300); }, 2400);
}

// @@NEXT@@
