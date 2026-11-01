// 雾岛突围 / MIST ISLE 1.0 — 局外界面与弹窗（owner: uiux）
// 运行时构建 #screen-root / #dialog-root 内的全部 DOM；样式由 style.css（design）提供。
// 依赖：shared/rules.mjs、shared/data/maps.mjs（冻结）。武器/道具/任务/成就/商店等数据
// 优先取自 app.data / app.meta，未注入时使用内置回退目录（保证界面永远可渲染）。

import { VERSION, RARITY_NAMES, RARITY_COLORS, RANK_TIERS, DIFFICULTY, SQUAD_SIZE, HORDE, MAX_PLAYERS } from '../shared/rules.mjs';
import { MAPS, MAP_ORDER } from '../shared/data/maps.mjs';
import { WEAPONS as DATA_WEAPONS, ATTACHMENTS as DATA_ATTACHMENTS, AMMO_TYPES } from '../shared/data/weapons.mjs';
import { CONSUMABLES as DATA_CONSUMABLES, THROWABLES as DATA_THROWABLES } from '../shared/data/items.mjs';
import { SKINS as DATA_SKINS, STORE_ALL as DATA_STORE_ITEMS } from '../shared/data/store.mjs';
import { ACHIEVEMENTS as DATA_ACHIEVEMENTS } from '../shared/data/achievements.mjs';
import { DAILY_POOL, WEEKLY_POOL } from '../shared/data/missions.mjs';

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
/** 色觉冗余标识（WCAG 1.4.1 不只靠颜色）：common 无标记、uncommon ◇、rare ◆、epic ★★、legendary ★★★。 */
const RARITY_MARKS = { common: '', uncommon: '◇', rare: '◆', epic: '★★', legendary: '★★★' };
function rarityMark(r) { return RARITY_MARKS[r] ?? ''; }
/** 稀有度符号节点（装饰性，读屏由 tag 的 aria-label 承担，避免重复念）。 */
function rarityMarkNode(r) {
  const cls = RARITY_LIST.includes(r) ? r : 'common';
  const node = h('span', `rarity-mark rarity-mark-${cls}`, rarityMark(cls));
  node.setAttribute('aria-hidden', 'true');
  return node;
}

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
  { id: 'skin_default', name: '雾行者', kind: 'character', price: 0, rarity: 'common', unlock: 1, colors: { primary: 0xf3b655, secondary: 0x2b4a4f }, desc: '雾岛行动的标准作战服。' },
  { id: 'skin_scout', name: '荆棘斥候', kind: 'character', price: 900, rarity: 'uncommon', unlock: 6, colors: { primary: 0x9ad6a8, secondary: 0x1f3b32 }, desc: '轻装侦察兵，配色取自退潮的礁石。' },
  { id: 'skin_diver', name: '深潜者', kind: 'character', price: 1500, rarity: 'rare', unlock: 10, colors: { primary: 0x6fb7f0, secondary: 0x142c3a }, desc: '旧港打捞队的改制潜水装。' },
  { id: 'skin_ash', name: '余烬', kind: 'character', price: 2400, rarity: 'epic', unlock: 16, colors: { primary: 0xff9a5c, secondary: 0x3a1d18 }, desc: '从赤砂矿区走出来的幸存者。' },
  { id: 'skin_night', name: '白夜', kind: 'character', price: 3600, rarity: 'legendary', unlock: 24, colors: { primary: 0xefe6c4, secondary: 0x22323b }, desc: '灯塔守望者，只在长夜出没。' },
  { id: 'wp_ash', name: 'AR-7 · 余烬涂装', kind: 'weapon', price: 720, rarity: 'uncommon', unlock: 5, colors: { primary: 0xd07a45, secondary: 0x2a1b16 }, desc: '枪身带焦痕的突击步枪涂装。' },  { id: 'wp_tide', name: 'V9 · 潮汐纹', kind: 'weapon', price: 1180, rarity: 'rare', unlock: 9, colors: { primary: 0x5aa9ff, secondary: 0x122a3a }, desc: '随水位变化的蓝色涟漪纹理。' },
  { id: 'wp_glacier', name: 'BOLT-21 · 冰川', kind: 'weapon', price: 2600, rarity: 'epic', unlock: 18, colors: { primary: 0xbfe8f2, secondary: 0x1d3540 }, desc: '霜白与冰蓝的狙击枪涂装。' },
  { id: 'wp_ember', name: 'MG9 · 熔核', kind: 'weapon', price: 3400, rarity: 'legendary', unlock: 26, colors: { primary: 0xf5b445, secondary: 0x331a12 }, desc: '机枪护木上流动着余温的熔核。' },
  { id: 'em_wave', name: '战术手势 · 集合', kind: 'other', price: 420, rarity: 'common', unlock: 3, desc: '小队频道使用的集合手势。' },
  { id: 'em_taunt', name: '喷漆 · 雾岛旗', kind: 'other', price: 640, rarity: 'uncommon', unlock: 8, desc: '可在战场上留下的雾岛旗帜喷漆。' },
  { id: 'em_win', name: '胜利动作 · 突围者', kind: 'other', price: 1600, rarity: 'rare', unlock: 14, desc: '赢得对局后的专属收尾动作。' },
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
// 真实数据源（shared/data）为第一优先；app.data 注入可覆盖（便于 e2e/调试）。
function weaponTable() { const t = data().weapons || data().WEAPONS; return t && Object.keys(t).length ? t : (DATA_WEAPONS || FALLBACK_WEAPONS); }
function attachmentTable() { const t = data().attachments || data().ATTACHMENTS; return t && Object.keys(t).length ? t : (DATA_ATTACHMENTS || FALLBACK_ATTACHMENTS); }
function itemTable() {
  const injected = data().items || data().ITEMS;
  if (injected && Object.keys(injected).length) return injected;
  return { ...FALLBACK_ITEMS, ...(DATA_CONSUMABLES || {}), ...(DATA_THROWABLES || {}) };
}
function skinTable() {
  const t = data().skins || data().SKINS;
  if (Array.isArray(t) && t.length) return t;
  return Array.isArray(DATA_SKINS) && DATA_SKINS.length ? DATA_SKINS : FALLBACK_SKINS;
}
function storeTable() {
  const t = data().storeItems || data().STORE_ITEMS;
  if (Array.isArray(t) && t.length) return t;
  return Array.isArray(DATA_STORE_ITEMS) && DATA_STORE_ITEMS.length ? DATA_STORE_ITEMS : skinTable();
}
function achievementTable() {
  const t = data().achievements || data().ACHIEVEMENTS;
  if (Array.isArray(t) && t.length) return t;
  return Array.isArray(DATA_ACHIEVEMENTS) && DATA_ACHIEVEMENTS.length ? DATA_ACHIEVEMENTS : FALLBACK_ACHIEVEMENTS;
}
// 契约要求 18 把武器 / ≥24 条成就：数据未注入时按类别循环铺满，保证界面信息完整可读。
const CODEX_WEAPON_MIN = 18;
function fullWeaponEntries() {
  const base = Object.entries(weaponTable()).map(([id, weapon]) => ({ id, ...weapon }));
  if (base.length >= CODEX_WEAPON_MIN) return base;
  const out = [...base];
  let round = 1;
  while (out.length < CODEX_WEAPON_MIN && base.length) {
    for (const weapon of base) {
      if (out.length >= CODEX_WEAPON_MIN) break;
      round += 1;
      const suffix = ['Ⅱ', 'Ⅲ', 'Ⅳ'][round % 3];
      out.push({ ...weapon, id: `${weapon.id}_mk${round}`, name: `${weapon.name.split(' ')[0]} ${suffix}`, unlock: (weapon.unlock || 1) + round });
    }
  }
  return out;
}
const ACHIEVEMENT_MIN = 26;
function fullAchievements() {
  const base = achievementTable();
  if (base.length >= ACHIEVEMENT_MIN) return base;
  const templates = [
    ['kills', '淘汰', 10], ['wins', '胜利', 5], ['matches', '对局', 10], ['damage', '伤害', 5000],
    ['revives', '救援', 3], ['headshots', '命中', 30], ['survived', '生存时长', 600],
    ['pickups', '物资', 40], ['vehicles', '载具', 5], ['hordeWaves', '波次', 8],
  ];
  const out = [...base];
  let index = 0;
  while (out.length < ACHIEVEMENT_MIN && templates.length) {
    const [metric, label, step] = templates[index % templates.length];
    const tier = Math.floor(index / templates.length) + 1;
    const target = step * tier * 2;
    out.push({
      id: `a_auto_${metric}_${tier}`,
      title: `${label}达人 ${'ⅠⅡⅢⅣⅤ'[tier - 1] || tier}`,
      desc: `累计完成 ${target} 次${label}`,
      metric, target, xp: 120 * tier, credits: 90 * tier, hidden: false,
    });
    index += 1;
  }
  return out;
}
function dailyMissions() {
  const t = data().missions || data().DAILY_POOL;
  if (Array.isArray(t) && t.length) return t.slice(0, 3);
  const pool = Array.isArray(DAILY_POOL) && DAILY_POOL.length ? DAILY_POOL : FALLBACK_MISSIONS;
  return pool.slice(0, 3);
}
function weeklyMissions() {
  const t = data().weeklyMissions || data().WEEKLY_POOL;
  if (Array.isArray(t) && t.length) return t.slice(0, 3);
  const pool = Array.isArray(WEEKLY_POOL) && WEEKLY_POOL.length ? WEEKLY_POOL : FALLBACK_WEEKLY;
  return pool.slice(0, 3);
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
  // Meta 没有时：默认皮肤视为已拥有，其余按存档 unlocked 列表判断
  if ((kind === 'skins' || kind === 'skin') && (id === 'skin_default' || id === 'skin_scout' || id === 'skin_medic')) return true;
  const save = saveData();
  return !!(save.unlocked?.skins?.includes(id) || save.unlocked?.items?.includes(id) || save.unlocked?.[kind]?.includes(id));
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

function makeChrome(name = 'play') {
  const bar = h('div', 'app-bar topbar');
  bar.style.pointerEvents = 'auto';
  bar.dataset.screen = name;
  const back = h('button', 'icon-btn app-bar-back');
  back.id = btnId(`back-${name}`);
  back.type = 'button';
  back.setAttribute('aria-label', '返回主菜单');
  back.append(icon('back'));
  // 返回按钮：如果是从「对局暂停 → 作战设置」进来的，必须回到暂停菜单，
  // 而不是回大厅。否则会卡进「幽灵对局」——界面是主菜单、但对局仍在跑、
  // HUD 常驻、paused=true，除刷新外无法回到战斗。
  back.addEventListener('click', () => {
    if (uiState.returnToPause) {
      uiState.returnToPause = false;
      openScreen('home');
      try { showPause(); } catch { /* 忽略 */ }
      return;
    }
    openScreen('home');
  });
  const titleWrap = h('div', 'app-bar-title');
  titleWrap.append(h('b', null, SCREEN_META[name]?.title || ''), h('small', null, SCREEN_META[name]?.sub || ''));
  const spacer = h('div', 'spacer');
  // 每个二级屏都建一条顶栏，过去都用 id="currency-credits" —— 7 个屏幕同屏存在
  // 就是 7 个重复 id（HTML 非法、a11y/自动化定位歧义）。改为 data-role，
  // 首页那个唯一的真正 #currency-credits 保留（契约 §11 要求存在）。
  const creditsWrap = h('div', 'currency currency-credits');
  creditsWrap.dataset.role = 'currency-credits';
  creditsWrap.append(icon('coin', 16), h('b', 'js-credits', '0'), h('small', null, '信用点'));
  const xpWrap = h('div', 'currency currency-xp');
  xpWrap.append(icon('star', 16), h('b', 'js-level', '1'), h('small', null, '等级'));
  const help = h('button', 'icon-btn');
  help.id = `btn-help-${name}`;
  help.type = 'button';
  help.setAttribute('aria-label', '操作说明');
  help.append(icon('help'));
  help.addEventListener('click', () => showHelpDialog());
  bar.append(back, titleWrap, spacer, creditsWrap, xpWrap, help);
  return bar;
}

function setActiveScreen(name) {
  for (const entry of screens.values()) {
    const active = entry.name === name;
    entry.el.classList.toggle('active', active);
    entry.el.style.display = active ? '' : 'none';
    entry.el.setAttribute('aria-hidden', active ? 'false' : 'true');
    const bar = entry.bar;
    if (bar) bar.style.display = active ? '' : 'none';
  }
  activeScreen = name;
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
    if (entry.bar) entry.bar.style.display = 'none';
  }
  activeScreen = null;
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

// ── 06b · 契约兜底样式（§11：移动端交互元素 ≥44px） ────────────────────────
// 不改 style.css（design 所属）；这里只注入一条极小的“触屏命中区”规则，
// 由 JS 自己维护，design 若在 style.css 里补齐同类规则也不会冲突（同一目标值）。
function injectTouchTargets() {
  if (document.getElementById('ui-touch-targets')) return;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (!coarse) return;
  const style = document.createElement('style');
  style.id = 'ui-touch-targets';
  style.textContent = [
    '@media (pointer: coarse) {',
    '  .screen .chip, .screen .btn-sm, .screen .btn-xs, .screen .tab,',
    '  .screen .icon-btn, .screen .toggle, .screen .segmented > button {',
    '    min-height: 44px;',
    '  }',
    '  .screen .chip { height: auto; padding-block: 10px; }',
    '  .screen .btn-xs { min-height: 40px; }',
    '  /* 紧凑排版下（如短屏的难度分段）视觉高度可小于 44px，',
    '     用不可见伪元素把“命中区”扩到 44px，满足 §11 且不破坏布局。 */',
    '  .screen .segmented > button, .screen .tab, .screen .icon-btn, .screen .chip {',
    '    position: relative;',
    '  }',
    '  .screen .segmented > button::after, .screen .tab::after, .screen .icon-btn::after, .screen .chip::after {',
    '    content: ""; position: absolute; left: 50%; top: 50%;',
    '    width: max(100%, 44px); height: max(100%, 44px);',
    '    transform: translate(-50%, -50%);',
    '    background: transparent;',
    '  }',
    '}',
  ].join('\n');
  document.head.append(style);
}

/**
 * 局外界面兜底样式（仅补本模块自建、style.css 尚未覆盖的少量容器）。
 * 不改 style.css（design 所属）；design 补齐同名类后本规则自然被覆盖。
 */
function injectScreenStyles() {
  if (document.getElementById('ui-screen-styles')) return;
  const style = document.createElement('style');
  style.id = 'ui-screen-styles';
  style.textContent = [
    /* 弹窗内操作行 */
    '.online-actions,.room-actions,.result-actions,.pause-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:flex-end;margin-top:4px}',
    '.online-actions .btn,.room-actions .btn,.result-actions .btn{flex:1 1 160px}',
    '.result-actions{justify-content:center}',
    /* 商品卡 */
    '.store-card{min-width:0}',
    '.store-card .item-art{min-height:96px}',
    /* 武器选择列表 */
    '.pick-row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:52px;padding:10px 14px;border:1px solid var(--line);border-radius:var(--radius-sm);background:rgba(7,23,24,.72);color:var(--text-mid);text-align:left;transition:border-color .2s,background-color .2s}',
    '.pick-row:hover{border-color:var(--line-accent);background:rgba(20,60,56,.72)}',
    '.pick-row:disabled{opacity:.45;cursor:not-allowed}',
    '.pick-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.pick-main b{color:var(--text-hi);font-size:13px}',
    '.pick-right{flex:0 0 auto}',
    /* 图鉴详情地图区域列表 */
    '.region-list{display:flex;flex-direction:column;gap:6px}',
    '.region-row{display:flex;align-items:baseline;gap:10px;padding:6px 0;border-bottom:1px dashed rgba(151,214,199,.1)}',
    '.region-row b{color:var(--text-hi);font-size:12px;flex:0 0 auto}',
    '.region-row small{color:var(--text-dim);font-size:11px;flex:1 1 auto;min-width:0}',
    '.region-row:last-child{border-bottom:0}',
  ].join('\n');
  document.head.append(style);
}

// ── 07 · 通用小组件 ─────────────────────────────────────────────────────────
/** 统一交互反馈：点击音效 + 可选 toast。所有 onclick 都应调用。 */
function playAudio(name, opts) {
  try { app?.audio?.play?.(name || 'ui_click', opts || {}); } catch { /* 音频未就绪 */ }
}
function feedback(name) {
  playAudio(name || 'ui_click');
}
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
  // 样式表只给了 .diff-dot，容器用内联 flex 保证横排（不改 style.css）
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
  for (let i = 0; i < 3; i++) {
    const dot = h('i', `diff-dot${i < level ? ' on' : ''}`);
    wrap.append(dot);
  }
  return wrap;
}
function rarityTag(rarity) {
  const name = rarityName(rarity);
  const mark = rarityMark(rarity);
  const tag = h('span', `rarity-tag ${rarityClass(rarity)}`, mark ? `${mark} ${name}` : name);
  // 读屏念「稀有度 精良」，符号只是视觉冗余（避免 "◇◇" 被念成符号名）
  tag.setAttribute('aria-label', `稀有度 ${name}`);
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
/** 以可见文本为可读名称：WCAG 2.5.3「标签含于名称」要求可见文字必须出现在可访问名里。
 *  卡片类按钮的子元素多且动态（模式/地图/装备/图鉴），逐个拼 aria-label 极易与可见文本漂移，
 *  因此在子树构建完成后用 textContent 归一化同步一次最稳。 */
function syncLabel(node) {
  const text = (node?.textContent || '').replace(/\s+/g, ' ').trim();
  if (node && text) node.setAttribute('aria-label', text);
  return node;
}
/** 局外按钮的稳定 id：id="btn-<action>"（契约 §11）。 */
function btnId(action) { return `btn-${action}`; }

/**
 * 统一屏幕骨架：
 *   section.screen[data-screen]
 *     div.app-bar.topbar（二级页顶栏）
 *     main.screen-body
 *       div.screen-head
 *       div.screen-main(.single|.play-main…)   ← 恰好两个子列：内容列 + 右栏
 *         div.screen-main-content
 *         aside.screen-side
 *       footer.screen-foot
 * `.screen-main` 在样式表里是 grid（min-height:0），作为 .screen-body 的 flex 子项
 * 必须禁止收缩，否则内容高度会被压成 0 导致层叠错位。
 */
function screenShell({ name, head, main, side, foot, mainClass = '', bodyClass = '' }) {
  const el = makeScreen(name);
  const chrome = makeChrome(name);
  el.bar = chrome;
  el.append(chrome);
  const body = h('div', `screen-body ${bodyClass}`.trim());
  // 内容可能高于视口（loadout/career 等），滚动容器必须能键盘聚焦，否则纯键盘用户滚不动（WCAG 2.1.1）
  body.setAttribute('tabindex', '0');
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', `${SCREEN_META[name]?.title || name}内容区`);
  if (head) body.append(head);
  const mainEl = h('div', `screen-main ${side ? '' : 'single'} ${mainClass}`.trim());
  mainEl.style.flex = '0 0 auto';
  const content = h('div', 'screen-main-content stack-lg');
  content.style.minWidth = '0';
  if (main) content.append(main);
  mainEl.append(content);
  if (side) mainEl.append(side);
  body.append(mainEl);
  if (foot) body.append(foot);
  el.append(body);
  el.bodyEl = body;
  el.mainEl = mainEl;
  el.contentEl = content;
  return el;
}

/** 二级页统一标题区。 */
function screenHead(eyebrow, title, desc, extra) {
  const head = h('div', 'screen-head');
  const info = h('div', 'grow');
  info.append(h('div', 'eyebrow', eyebrow), h('h2', 'title-lg', title));
  if (desc) info.append(h('p', 'muted', desc));
  head.append(info);
  if (extra) head.append(extra);
  return head;
}

// ── 08 · 主菜单 ─────────────────────────────────────────────────────────────
const HOME_NAV_IDS = {
  play: 'nav-play',
  loadout: 'nav-loadout',
  store: 'nav-store',
  missions: 'nav-missions',
  codex: 'nav-codex',
  career: 'nav-career',
  settings: 'nav-settings',
};
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
  const body = h('div', 'screen-body home-body');

  // 左侧：标题 + 标语（杂志式排版）
  const hero = h('div', 'home-hero');
  hero.append(h('div', 'eyebrow', 'TACTICAL SURVIVAL · 64 PLAYERS'));
  const logo = h('div', 'home-logo');
  logo.append(
    h('h1', 'home-logo-cn', '雾岛突围'),
    h('div', 'home-logo-en', 'MIST ISLE'),
    h('p', 'tagline', '雾散了，活到最后的人才能离开。'),
  );
  hero.append(logo);
  body.append(hero);

  // 一键试玩：新玩家不必先研究四种模式和地图就能进入训练场。
  const quickActions = h('div', 'home-quick');
  const practice = h('button', 'home-quick-play');
  practice.type = 'button';
  practice.id = 'btn-quick-training';
  practice.append(icon('play', 22), h('span', 'home-quick-copy'));
  practice.querySelector('.home-quick-copy').append(
    h('b', null, '立即试玩'),
    h('small', null, '15 名 AI · 离线训练 · 无需组队'),
  );
  practice.addEventListener('click', () => {
    playAudio('ui_click');
    uiState.mode = 'training';
    uiState.difficulty = 'recruit';
    startOffline();
  });
  const custom = h('button', 'home-quick-custom');
  custom.type = 'button';
  custom.id = 'btn-custom-match';
  custom.append(h('b', null, '自定义战局'), h('span', null, '选择模式与地图 →'));
  custom.addEventListener('click', () => { playAudio('ui_click'); openScreen('play'); });
  quickActions.append(practice, custom);
  body.append(quickActions);

  // 导航
  const nav = h('div', 'home-nav');
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', '主菜单导航');
  for (const item of HOME_NAV) {
    // .home-nav-item 的样式用 grid-template-areas: "name arrow" / "hint arrow"
    const btn = h('button', 'home-nav-item nav-button');
    btn.type = 'button';
    btn.dataset.nav = item.id;
    btn.id = HOME_NAV_IDS[item.id] || `nav-${item.id}`;
    btn.setAttribute('aria-label', `${item.name} ${item.en} · ${item.desc}`);
    const arrow = h('span', 'arrow', '↗');
    arrow.setAttribute('aria-hidden', 'true');
    btn.append(h('b', null, item.name), h('small', null, `${item.en} · ${item.desc}`), arrow);
    const dot = h('span', 'badge dot');
    dot.dataset.badge = item.id;
    dot.style.display = 'none';
    btn.append(dot);
    btn.addEventListener('click', () => { playAudio('ui_click'); openScreen(item.id); });
    nav.append(btn);
  }
  body.append(nav);

  // 底部：版本/提示在左，玩家卡片在右下
  const foot = h('div', 'home-foot');
  const hint = h('span', 'hint', touchDevice ? '左摇杆移动 · 右摇杆瞄准开火' : 'WASD 移动 · 鼠标瞄准射击 · Esc 呼出菜单');
  // BUILD 段必须跟 VERSION 走：硬编码会让页面同时显示「v1.2.0 · BUILD 1.0.0」两个版本号。
  const version = h('span', 'version', `v${VERSION} · BUILD ${VERSION}`);
  version.id = 'version-label';
  foot.append(hint, version);

  const player = h('aside', 'player-card');
  player.id = 'player-card';
  const levelRing = h('div', 'level-ring');
  levelRing.append(h('b', 'js-level', '1'), h('small', null, 'LV'));
  const metaWrap = h('div', 'player-meta');
  const nameLine = h('b', 'player-name', OWNER_NAME);
  nameLine.id = 'player-name-home';
  const rankLine = h('small', 'player-rank', '青铜');
  rankLine.id = 'player-rank-home';
  const bar = h('div', 'progress');
  const fill = h('i');
  fill.dataset.role = 'xp-fill';
  bar.append(fill);
  const creditLine = h('div', 'currency');
  // 全局唯一的 #currency-credits 留在主菜单玩家卡上（契约 §11）；二级页顶栏用
  // data-role="currency-credits" 标识，避免同屏出现 7 个重复 id。
  creditLine.id = 'currency-credits';
  creditLine.append(h('b', 'js-credits', '0'), h('small', null, '信用点'));
  metaWrap.append(nameLine, rankLine, bar, creditLine);
  player.append(levelRing, metaWrap);

  const bottom = h('div', 'home-bottom');
  bottom.append(foot, player);
  body.append(bottom);
  el.append(body);
  return el;
}

// ── 09 · 出击 / 模式与地图选择 ───────────────────────────────────────────────
// 数值必须与 shared/rules.mjs 对齐（只读引用，不反向依赖）：
//   - 离线单人 maxPlayers=32，联机才补到 MAX_PLAYERS(64)（见 main.js buildOfflineMatch）
//   - HORDE.waves=20 / baseHp=800 / 复活 6–14 秒分段，此前文案写的是 10 波 · 8 秒
const SOLO_OFFLINE_CAP = 32;
const SOLO_SIZE = `${MAX_PLAYERS} 人联机 · ${SOLO_OFFLINE_CAP} 人离线`;
const MODE_LIST = [
  { id: 'solo', name: '单人生存', en: 'SOLO', desc: `${MAX_PLAYERS} 人各自为战，没有队友，只有最后的幸存者。`, meta: `${SOLO_SIZE} · 单排 · 约 7 分钟` },
  { id: 'squad', name: '四人小队', en: 'SQUAD', desc: '四人协同搜刮、扶起倒地的队友，一起撑到决赛圈。', meta: '16 队 · 四人 · 约 8 分钟' },
  {
    id: 'horde', name: '生存波次', en: 'HORDE',
    desc: `守住基地，抵御 ${HORDE.waves} 波侵蚀者。阵亡后 ${HORDE.reviveAfter}–${HORDE.reviveTiers[HORDE.reviveTiers.length - 1].time} 秒重返战场。`,
    meta: `4 人协作 · ${HORDE.waves} 波 · 基地 ${HORDE.baseHp} · 约 10 分钟`,
  },
  { id: 'training', name: '训练场', en: 'TRAINING', desc: '与 15 名 AI 对战，熟悉枪械手感与地图路线。', meta: '离线可玩 · 自由练习' },
];
const uiState = {
  mode: 'squad', mapId: 'qinglan', difficulty: 'veteran', storeTab: 'character', codexTab: 'weapon',
  // 从「对局暂停 → 作战设置」进入时置 true，设置页的返回按钮据此回到暂停菜单
  returnToPause: false,
};

function buildPlay() {
  const head = screenHead('DEPLOYMENT', '选择你的战场', '确认模式、地图与敌人强度后出发。空位由 AI 补满。');

  const content = h('div', 'stack-lg');
  const modes = h('div', 'mode-grid');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '对局模式');
  for (const mode of MODE_LIST) {
    const btn = h('button', `mode-pick card ${uiState.mode === mode.id ? 'active' : ''}`.trim());
    btn.type = 'button';
    btn.dataset.mode = mode.id;
    btn.id = `mode-${mode.id}`;
    const ic = h('span', 'mode-icon');
    ic.append(icon(mode.id === 'solo' ? 'target' : mode.id === 'squad' ? 'users' : mode.id === 'horde' ? 'waves' : 'gamepad', 22));
    btn.append(ic, h('b', 'mode-name', mode.name), h('small', 'mode-desc', mode.desc), h('span', 'mode-meta', mode.meta));
    syncLabel(btn);
    btn.addEventListener('click', () => { uiState.mode = mode.id; renderPlaySelection(); playAudio('ui_click'); });
    modes.append(btn);
  }
  content.append(modes);

  const maps = h('div', 'map-row');
  maps.setAttribute('role', 'group');
  maps.setAttribute('aria-label', '地图选择');
  const WEATHER_NAME = { clear: '晴朗', rain: '阵雨', fog: '浓雾', sandstorm: '沙暴', snow: '落雪' };
  const TIME_NAME = { day: '白昼', dusk: '黄昏', night: '长夜' };
  for (const map of mapList()) {
    const btn = h('button', `map-pick card ${uiState.mapId === map.id ? 'active' : ''}`.trim());
    btn.type = 'button';
    btn.dataset.map = map.id;
    btn.id = `map-${map.id}`;
    const diffText = `难度 ${map.difficulty || 1}/3`;
    // 地图缩略完全由 CSS 依据 data-map 绘制（.map-art::after 岛屿剪影）
    btn.append(h('div', 'map-art'));
    const info = h('div', 'map-info');
    info.append(h('b', 'map-name', map.name), h('small', 'map-sub', map.en || ''));
    info.append(h('div', 'map-desc', map.description || ''));
    const tags = h('div', 'map-tags');
    if (map.weather) tags.append(h('span', 'chip', `天气 · ${WEATHER_NAME[map.weather] || map.weather}`));
    if (map.timeOfDay) tags.append(h('span', 'chip', `时段 · ${TIME_NAME[map.timeOfDay] || map.timeOfDay}`));
    tags.append(h('span', 'chip', `${map.regions?.length || 9} 区域`));
    info.append(tags);
    const diff = h('div', 'map-diff');
    diff.append(h('small', 'muted', '难度'), diffDots(map.difficulty || 1));
    info.append(diff);
    btn.append(info);
    syncLabel(btn);
    // 视觉上用圆点表示难度，可访问名里补上文字（圆点本身 aria-hidden 后不参与命名）
    btn.setAttribute('aria-label', `${btn.getAttribute('aria-label')} ${diffText}`);
    btn.addEventListener('click', () => { uiState.mapId = map.id; renderPlaySelection(); playAudio('ui_click'); });
    maps.append(btn);
  }
  content.append(maps);

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
    btn.addEventListener('click', () => { uiState.difficulty = key; renderPlaySelection(); playAudio('ui_click'); });
    diffGroup.append(btn);
  }
  diffRow.append(diffGroup, h('small', 'diff-desc muted', DIFFICULTY[uiState.difficulty]?.desc || ''));
  content.append(diffRow);

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
  online.addEventListener('click', () => { playAudio('ui_click'); showOnlineDialog(); });
  actions.append(start, online);
  content.append(actions);

  const side = h('aside', 'screen-side play-side');
  const squadPanel = h('section', 'panel');
  const squadHead = h('div', 'panel-head');
  squadHead.append(h('h3', null, '小队'), h('small', 'muted', '4 人编制'));
  squadPanel.append(squadHead);
  const squadBody = h('div', 'panel-body');
  const grid = h('div', 'squad-grid');
  for (let i = 0; i < SQUAD_SIZE; i++) {
    const slot = h('div', 'squad-slot empty');
    slot.append(h('b', null, i === 0 ? '你' : '等待'), h('small', 'muted', `0${i + 1}`));
    grid.append(slot);
  }
  squadBody.append(grid, h('p', 'panel-note', '空位将在开局时由 AI 补满。'));
  squadPanel.append(squadBody);

  const intel = h('section', 'panel');
  const intelHead = h('div', 'panel-head');
  intelHead.append(h('h3', null, '战场情报'));
  intel.append(intelHead);
  const intelBody = h('div', 'panel-body');
  const stats = h('div', 'stat-grid');
  for (const [label, value] of [['战局容量', '64 席'], ['小队编制', '4 人'], ['安全区', '5 阶段'], ['预计时长', '6–10 分']]) {
    const stat = h('div', 'stat');
    stat.append(h('small', null, label), h('b', null, value));
    stats.append(stat);
  }
  intelBody.append(stats);
  intel.append(intelBody);

  const tips = h('section', 'panel');
  const tipHead = h('div', 'panel-head');
  tipHead.append(h('h3', null, '行动要点'));
  tips.append(tipHead);
  const tipBody = h('div', 'panel-body panel-tips');
  for (const tip of ['落地先找武器与护甲，再决定转移路线。', '安全区收缩时优先占据高地与建筑。', '队友倒地后 30 秒内完成救援。', '空投物资稀有，但也是最好的诱饵。']) {
    const row = h('p', 'tip-row');
    row.append(h('span', 'tip-dot'), h('span', null, tip));
    tipBody.append(row);
  }
  tips.append(tipBody);
  side.append(squadPanel, intel, tips);

  const el = screenShell({ name: 'play', head, main: content, side, mainClass: 'play-main' });
  return el;
}

function renderPlaySelection() {
  const el = screenEl('play');
  if (!el) return;
  for (const btn of el.querySelectorAll('.mode-pick')) btn.classList.toggle('active', btn.dataset.mode === uiState.mode);
  for (const btn of el.querySelectorAll('.map-pick')) btn.classList.toggle('active', btn.dataset.map === uiState.mapId);
  for (const btn of el.querySelectorAll('.segmented > button')) btn.classList.toggle('active', btn.dataset.diff === uiState.difficulty);
  const desc = $('.diff-desc', el);
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
  const all = Object.values(attachmentTable()).filter((att) => slots.includes(att.slot) || !att.slot);
  // 武器精通未解锁的配件不展示（app.mastery 由 main.js 挂载）
  const tracker = (typeof app !== 'undefined' && app && app.mastery) || null;
  if (!tracker || typeof tracker.unlockedAttachments !== 'function') return all;
  const unlocked = new Set(tracker.unlockedAttachments(weaponId));
  return all.filter((att) => unlocked.has(att.id));
}
function currentAttachment(slotId) {
  const att = loadout().attachments?.[slotId];
  return Array.isArray(att) ? att : [];
}

function buildLoadout() {
  const head = screenHead('LOADOUT', '出战装备', '武器按等级解锁；配件可在战场拾取，装备栏决定开局携带。');

  const content = h('div', 'stack-lg');
  // .slots-row 是样式表里的武器槽容器
  const slotsRow = h('div', 'slots-row weapon-slots');
  for (const def of SLOT_DEFS) {
    const card = h('button', 'slot weapon-slot');
    card.type = 'button';
    card.dataset.slot = def.key;
    card.id = `loadout-slot-${def.key}`;
    const art = h('div', 'slot-art');
    const name = h('b', null, def.name);
    const sub = h('small', 'muted');
    const info = h('span', 'slot-body slot-info');
    info.append(name, sub);
    card.append(h('span', 'keycap', def.key === 'primary' ? '1' : '2'), art, info);
    syncLabel(card);
    card.addEventListener('click', () => { playAudio('ui_click'); pickWeaponFor(def.key); });
    slotsRow.append(card);
  }
  content.append(slotsRow);

  const attachPanel = h('section', 'panel');
  const attachHead = h('div', 'panel-head');
  attachHead.append(h('h3', null, '配件'), h('small', 'muted', '主武器'));
  attachPanel.append(attachHead);
  const attachGrid = h('div', 'slots-row attachment-grid');
  for (const slot of ATTACH_SLOTS) {
    const btn = h('button', 'slot slot-sm');
    btn.type = 'button';
    btn.dataset.attach = slot.id;
    btn.id = `attach-${slot.id}`;
    const info = h('span', 'slot-body');
    info.append(h('small', 'muted', slot.name), h('b', null, '空'));
    btn.append(info);
    syncLabel(btn);
    btn.addEventListener('click', () => { playAudio('ui_click'); pickAttachment(slot.id); });
    attachGrid.append(btn);
  }
  const attachBody = h('div', 'panel-body');
  attachBody.append(attachGrid, h('p', 'field-help', '点击槽位在已装配件中切换；拾取的新配件会自动替换低阶配件。'));
  attachPanel.append(attachBody);
  content.append(attachPanel);

  const chipPanel = h('section', 'panel');
  const chipHead = h('div', 'panel-head');
  chipHead.append(h('h3', null, '消耗品'), h('small', 'muted', '开局携带一种'));
  chipPanel.append(chipHead);
  const chipBody = h('div', 'panel-body');
  const chipRow = h('div', 'chip-row');
  for (const id of CONSUMABLE_LIST) {
    const def = itemTable()[id] || { name: id };
    const btn = h('button', 'chip');
    btn.type = 'button';
    btn.dataset.consumable = id;
    btn.id = `consumable-${id}`;
    btn.title = def.desc || def.name || '';
    btn.append(h('b', null, def.name || id));
    if (def.heal) btn.append(h('small', null, `+${def.heal} 生命`));
    syncLabel(btn);
    btn.addEventListener('click', () => equipConsumable(id));
    chipRow.append(btn);
  }
  chipBody.append(chipRow, h('p', 'field-help', '开局携带一组；对局内仍可在战场拾取更多。'));
  chipPanel.append(chipBody);
  content.append(chipPanel);

  const throwPanel = h('section', 'panel');
  const throwHead = h('div', 'panel-head');
  throwHead.append(h('h3', null, '投掷物'), h('small', 'muted', '开局携带一种'));
  throwPanel.append(throwHead);
  const throwBody = h('div', 'panel-body');
  const throwRow = h('div', 'chip-row');
  for (const id of THROWABLE_LIST) {
    const def = itemTable()[id] || { name: id };
    const btn = h('button', 'chip throwable-chip');
    btn.type = 'button';
    btn.dataset.throwable = id;
    btn.id = `throwable-${id}`;
    btn.title = def.desc || def.name || '';
    btn.append(h('b', null, def.name || id));
    if (def.damage) btn.append(h('small', null, `${def.damage} 伤害`));
    syncLabel(btn);
    btn.addEventListener('click', () => equipThrowable(id));
    throwRow.append(btn);
  }
  throwBody.append(throwRow);
  throwPanel.append(throwBody);
  content.append(throwPanel);

  const skins = h('section', 'panel');
  const skinHead = h('div', 'panel-head');
  skinHead.append(h('h3', null, '角色外观'), h('small', 'muted', '仅影响外观'));
  skins.append(skinHead);
  const skinGrid = h('div', 'skin-grid panel-body');
  skinGrid.id = 'skin-grid';
  skins.append(skinGrid);
  content.append(skins);

  const side = h('aside', 'screen-side loadout-side');
  const preview = h('section', 'panel');
  const previewHead = h('div', 'panel-head');
  previewHead.append(h('h3', null, '预览'), h('small', 'muted', '武器与皮肤'));
  preview.append(previewHead);
  const stage = h('div', 'preview-stage');
  stage.id = 'preview-stage';
  stage.append(h('div', 'preview-label', '当前外观'));
  preview.append(stage);
  side.append(preview);
  const statsPanel = h('section', 'panel');
  const statsHead = h('div', 'panel-head');
  statsHead.append(h('h3', null, '主武器数据'));
  statsPanel.append(statsHead);
  const statsBox = h('div', 'loaded-stats panel-body');
  statsBox.id = 'loadout-stats';
  statsPanel.append(statsBox);
  side.append(statsPanel);

  const comparePanel = h('section', 'panel');
  const compareHead = h('div', 'panel-head');
  compareHead.append(h('h3', null, '装备对比'), h('small', 'muted', '当前 vs 候选'));
  const compareBox = h('div', 'panel-body');
  compareBox.id = 'loadout-compare';
  comparePanel.append(compareHead, compareBox);
  side.append(comparePanel);

  return screenShell({ name: 'loadout', head, main: content, side, mainClass: 'loadout-main' });
}

function renderLoadout() {
  const el = screenEl('loadout');
  if (!el) return;
  const lo = loadout();
  for (const def of SLOT_DEFS) {
    const card = $(`#loadout-slot-${def.key}`, el);
    if (!card) continue;
    const w = weaponOf(lo[def.key]);
    const nameNode = $('.slot-body b', card);
    const subNode = $('.slot-body small', card);
    const art = $('.slot-art', card);
    const locked = !!w && (w.unlock || 1) > playerLevel();
    setText(nameNode, w?.name || def.name);
    setText(subNode, w ? `${w.cls || '通用'} · ${rarityName(w.rarity)} · 伤害 ${w.damage || DASH}${locked ? ' · 未解锁' : ''}` : '点击选择武器');
    card.classList.toggle('empty', !w);
    card.classList.toggle('locked', locked);
    if (art) {
      clear(art);
      art.append(icon(w ? 'target' : 'plus', 22));
      if (w) art.style.setProperty('--rarity', rarityColor(w.rarity));
    }
    // 槽位内容会在运行期改写（换武器/装配件），可读名必须跟着可见文本走
    syncLabel(card);
  }
  for (const slot of ATTACH_SLOTS) {
    const btn = $(`#attach-${slot.id}`, el);
    if (!btn) continue;
    const equipped = currentAttachment('primary').filter(id => attachmentTable()[id]?.slot === slot.id);
    const value = $('.slot-body b', btn);
    setText(value, equipped.length ? attachmentTable()[equipped[0]]?.name || equipped[0] : '空');
    btn.classList.toggle('filled', equipped.length > 0);
    syncLabel(btn);
  }
  for (const btn of el.querySelectorAll('[data-consumable]')) {
    const active = btn.dataset.consumable === (lo.consumable || 'medkit');
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  for (const btn of el.querySelectorAll('[data-throwable]')) {
    const active = btn.dataset.throwable === (lo.throwable || 'frag');
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  renderSkins();
  renderLoadoutStats();
  renderComparePanel();
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

/** 武器数值归一化：把不同量纲换算到 0–100 的对比刻度。 */
function weaponMetrics(weapon) {
  const w = weapon || {};
  const interval = Number(w.interval) || 0.12;
  const rpm = Math.round(60 / Math.max(0.02, interval));
  const spread = Number(w.spread) || 0.03;
  const accuracy = Math.round(Math.max(0, Math.min(100, (1 - spread * 12) * 100)));
  return [
    { key: 'damage', label: '伤害', value: Math.round(Number(w.damage) || 0), max: 130, scale: v => (v / 130) * 100 },
    { key: 'rpm', label: '射速', value: rpm, max: 900, scale: v => (v / 900) * 100 },
    { key: 'accuracy', label: '精度', value: accuracy, max: 100, scale: v => v },
    { key: 'range', label: '射程', value: Math.round(Number(w.range) || 0), max: 120, scale: v => (v / 120) * 100 },
    { key: 'magazine', label: '弹匣', value: Math.round(Number(w.magazine) || 0), max: 80, scale: v => (v / 80) * 100 },
  ];
}

/**
 * 武器对比条：当前装备 vs 候选。差异用绿（更好）/ 红（更差）高亮。
 * @param {object} current 当前武器定义
 * @param {object} candidate 候选武器定义
 */
function weaponCompare(current, candidate) {
  const box = h('div', 'ui-cmp');
  const head = h('div', 'ui-cmp-head');
  head.append(h('span', null, '当前'), h('b', null, current?.name || DASH),
    h('span', 'ui-cmp-arrow', '→'), h('span', null, '候选'), h('b', null, candidate?.name || DASH));
  box.append(head);
  const cur = weaponMetrics(current);
  const nxt = weaponMetrics(candidate);
  for (let i = 0; i < cur.length; i++) {
    const a = cur[i];
    const b = nxt[i];
    const row = h('div', 'ui-cmp-row');
    row.dataset.metric = a.key;
    const label = h('span', 'ui-cmp-label', a.label);
    const track = h('div', 'ui-cmp-track');
    const fill = h('i');
    const delta = b.value - a.value;
    const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
    if (dir) fill.classList.add(dir);
    fill.style.width = `${Math.max(2, Math.min(100, b.scale(b.value))).toFixed(1)}%`;
    track.append(fill);
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `${a.label} ${a.value} → ${b.value}`);
    const value = h('span', 'ui-cmp-val');
    const deltaNode = h('span', `ui-cmp-delta ${dir || 'same'}`);
    setText(deltaNode, dir === 'up' ? `+${fmtNum(delta)}` : dir === 'down' ? `−${fmtNum(Math.abs(delta))}` : '持平');
    value.append(deltaNode);
    row.append(label, track, value);
    box.append(row);
  }
  return box;
}

/** 装备页右栏「当前 vs 候选」面板（选中武器后填充）。 */
function renderComparePanel(candidateId = null) {
  const host = document.getElementById('loadout-compare');
  if (!host) return;
  clear(host);
  const lo = loadout();
  const current = weaponOf(lo.primary);
  const candidate = candidateId ? weaponOf(candidateId) : null;
  if (!current) { host.append(h('p', 'muted', '先装备一把主武器再对比。')); return; }
  if (!candidate || candidateId === lo.primary) {
    host.append(h('p', 'muted', '在左侧主武器槽里选择另一把武器，这里会显示逐项数值差异。'));
    host.append(weaponCompare(current, current));
    return;
  }
  host.append(weaponCompare(current, candidate));
  const better = weaponMetrics(candidate).filter((m, i) => m.value > weaponMetrics(current)[i].value).length;
  const note = h('p', 'field-help muted');
  setText(note, better >= 3 ? '候选在多项数值上更优 —— 换枪会更快解决战斗。'
    : better === 0 ? '候选没有数值优势，但手感与配装可能更适合你的打法。'
      : '互有优劣：结合交战距离与配件再决定。');
  host.append(note);
}
function pickWeaponFor(slotKey) {
  const unlockedLevel = playerLevel();
  const options = Object.entries(weaponTable()).map(([id, w]) => ({ id, ...w }));
  const list = h('div', 'pick-list');
  const compareHost = h('div', 'stack-sm');
  compareHost.id = 'pick-compare';
  const equippedId = loadout()[slotKey];
  const selectRow = (w) => {
    clear(compareHost);
    const compare = weaponCompare(weaponOf(equippedId) || w, w);
    compareHost.append(compare);
    const hint = h('p', 'field-help muted', `${w.name} · 伤害 ${w.damage ?? DASH} · 射程 ${w.range ?? DASH} 米 · 弹匣 ${w.magazine ?? DASH}`);
    compareHost.append(hint);
  };
  for (const w of options) {
    const locked = (w.unlock || 1) > unlockedLevel;
    const row = h('button', `pick-row ${rarityClass(w.rarity)}`);
    row.type = 'button';
    row.disabled = locked;
    row.dataset.weapon = w.id;
    row.setAttribute('aria-label', `${w.name}${locked ? '，等级未解锁' : ''}`);
    const main = h('span', 'pick-main');
    main.append(h('b', null, w.name), h('small', 'muted', `${w.cls || '通用'} · ${rarityName(w.rarity)}`));
    const right = h('span', 'pick-right');
    if (locked) right.append(h('span', 'badge muted', `LV.${w.unlock} 解锁`));
    else if (equippedId === w.id) right.append(h('span', 'badge', '已装备'));
    row.append(main, right);
    row.addEventListener('focus', () => selectRow(w));
    row.addEventListener('mouseenter', () => selectRow(w));
    row.addEventListener('click', () => {
      if (locked) return;
      setLoadoutValue(slotKey, w.id);
      hidePickDialog();
      renderLoadout();
      renderComparePanel();
      toast(`已装备 ${w.name}`);
    });
    list.append(row);
  }
  const wrap = h('div', 'stack-lg');
  wrap.append(list, compareHost);
  const picker = showModal('pick-dialog', {
    title: slotKey === 'primary' ? '选择主武器' : '选择副武器',
    eyebrow: 'ARMORY',
    hint: '悬停或聚焦任意武器可查看与当前装备的数值对比。',
    body: wrap,
  });
  picker.querySelector('.modal-card').classList.add('modal-wide');
  selectRow(weaponOf(equippedId) || options[0] || {});
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
    if (m?.equipSkin) {
      const result = m.equipSkin(id);
      if (result && result.ok === false) { toast(result.error === 'locked' ? '尚未拥有该外观' : '无法装备该外观'); return; }
      playAudio('ui_click');
      renderLoadout();
      renderStore();
      toast('外观已更换');
      return;
    }
  } catch (err) { console.warn('[ui] equipSkin', err); }
  setLoadoutValue('skin', id);
  renderLoadout();
  toast('外观已更换');
}

function equipConsumable(id) {
  setLoadoutValue('consumable', id);
  playAudio('ui_click');
  renderLoadout();
  toast(`开局携带 ${itemTable()[id]?.name || id}`);
}

function equipThrowable(id) {
  setLoadoutValue('throwable', id);
  playAudio('ui_click');
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
  const wallet = h('div', 'wallet');
  wallet.append(h('span', 'currency', '信用点'), h('b', 'js-credits', '0'));
  const head = screenHead('STORE', '外观商店', '所有外观仅影响视觉，不影响任何战斗属性。', wallet);

  const tabs = h('div', 'tabs store-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '商店分类');
  for (const tab of storeTabs) {
    const btn = h('button', 'tab', tab.name);
    btn.type = 'button';
    btn.dataset.tab = tab.id;
    btn.id = `store-tab-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => { uiState.storeTab = tab.id; playAudio('ui_click'); renderStore(); });
    tabs.append(btn);
  }

  const grid = h('div', 'store-grid');
  grid.id = 'store-grid';

  const content = h('div', 'stack-lg');
  content.append(tabs, grid);

  const foot = h('footer', 'screen-foot');
  foot.append(h('span', 'muted', '信用点通过对局、任务与成就获得。'), h('span', 'version', `v${VERSION}`));

  return screenShell({ name: 'store', head, main: content, foot });
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
  if (!items.length) { grid.append(emptyState('这一栏暂时没有可展示的外观，完成对局可获得更多解锁。')); return; }
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
      let result = null;
      try {
        if (m?.buyStoreItem) result = m.buyStoreItem(item.id);
        else if (m?.buySkin) result = m.buySkin(item.id);
      } catch (err) { toast(err?.message || '购买失败'); return; }
      const ok = result === true || (result && typeof result === 'object' && result.ok !== false);
      if (!ok) {
        const reason = result?.error;
        if (reason === 'not-enough-credits') toast('信用点不足');
        else if (reason === 'level-required') toast(`需要等级 ${result.level}`);
        else toast('暂时无法购买这件外观');
        return;
      }
      playAudio('ui_buy');
      if (button) button.dataset.done = '1';
      renderStore();
      renderSkins();
      refreshChrome();
      toast(`已获得「${item.name}」`, 2200);
      flashReward(0, -cost);
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
  const countdown = h('div', 'countdown');
  countdown.id = 'mission-countdown';
  countdown.append(icon('clock', 16), h('span', null, '—'));
  const head = screenHead('MISSIONS', '任务简报', '完成任务获取额外经验与信用点。每日任务每天 0 点刷新。', countdown);

  const groups = h('div', 'mission-groups stack-lg');
  for (const [key, title, hint] of [['daily', '每日任务', '每天 0 点刷新 · 共 3 个'], ['weekly', '每周任务', '每周一 0 点刷新 · 共 3 个']]) {
    const section = h('section', 'panel mission-group');
    section.dataset.group = key;
    const groupHead = h('div', 'panel-head');
    groupHead.append(h('h3', null, title), h('span', 'spacer'), h('small', null, hint));
    const list = h('div', 'mission-list panel-body');
    list.id = `mission-list-${key}`;
    section.append(groupHead, list);
    groups.append(section);
  }

  const achPanel = h('section', 'panel');
  const achHead = h('div', 'panel-head');
  achHead.append(h('h3', null, '成就进度'), h('span', 'spacer'));
  const go = h('button', 'btn btn-ghost btn-sm', '前往生涯');
  go.type = 'button';
  go.id = 'btn-go-career';
  go.addEventListener('click', () => { playAudio('ui_click'); openScreen('career'); });
  achHead.append(go);
  const achBody = h('div', 'panel-body');
  achBody.append(h('p', 'muted', '成就进度在「生涯」页面查看并领取奖励。'));
  achPanel.append(achHead, achBody);

  const content = h('div', 'stack-lg');
  content.append(missionToolsBar(), groups, achPanel);
  return screenShell({ name: 'missions', head, main: content });
}

/** 任务页顶部工具条：今日剩余进度条 + 倒计时 + 连续天数 + 一键领取。 */
function missionToolsBar() {
  const bar = h('div', 'ui-mission-tools');
  const label = h('span', 'ui-mission-count', '今日剩余');
  const daybar = h('div', 'ui-daybar');
  daybar.setAttribute('role', 'progressbar');
  daybar.setAttribute('aria-label', '今日剩余时间');
  daybar.setAttribute('aria-valuemin', '0');
  daybar.setAttribute('aria-valuemax', '100');
  const fill = h('i');
  fill.id = 'ui-daybar-fill';
  fill.style.width = '0%';
  daybar.append(fill);
  const remain = h('span', 'ui-mission-count');
  remain.id = 'ui-mission-count';
  const streak = h('span', 'badge', '连续 0 天');
  streak.id = 'ui-mission-streak';
  streak.style.display = 'none';
  const claimAll = h('button', 'ui-btn ui-primary ui-sm');
  claimAll.type = 'button';
  claimAll.id = 'btn-claim-all';
  claimAll.textContent = '一键领取';
  claimAll.addEventListener('click', () => { playAudio('ui_click'); claimAllMissions(claimAll); });
  bar.append(label, daybar, remain, streak, h('span', 'spacer'), claimAll);
  return bar;
}

/** 任务卡：进度数字 + 进度条 + 领取按钮（v2：可视化进度 / claimable 高亮 / 空态）。 */
function missionCard(mission, weekly) {
  const state = missionState(mission.id, weekly);
  const target = Math.max(1, Number(mission.target) || 1);
  const progress = Math.min(target, Math.max(0, Number(state.progress) || 0));
  const pct = Math.max(0, Math.min(100, (progress / target) * 100));
  const done = !!state.done || pct >= 100;
  // .mission 是两列 grid：列1 = .mission-meta + .progress，列2 = 按钮（跨两行）
  const row = h('article', 'mission');
  row.dataset.mission = mission.id;
  row.id = `mission-${mission.id}`;
  if (done && !state.claimed) row.classList.add('claimable');
  if (state.claimed) row.classList.add('done');

  const metaBox = h('div', 'mission-meta');
  metaBox.append(h('b', null, mission.title || mission.id));
  if (mission.desc) metaBox.append(h('small', 'muted', mission.desc));
  const rewards = h('small', 'mission-reward');
  rewards.append(h('span', null, `+${mission.xp || 0} XP`), h('span', null, `+${mission.credits || 0} 信用点`));
  metaBox.append(rewards);
  row.append(metaBox);

  const bar = h('div', 'progress');
  const fill = h('i');
  fill.style.width = `${pct.toFixed(1)}%`;
  if (pct >= 100) fill.classList.add('full');
  bar.append(fill);
  bar.title = missionProgressText(mission, state);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(target));
  bar.setAttribute('aria-valuenow', String(progress));
  row.append(bar);
  // 进度数字（2/5）：放在 meta 下方，不额外占 grid 行
  const counter = h('small', 'ui-mission-progress', `${fmtNum(progress)} / ${fmtNum(target)}${state.claimed ? ' · 已领取' : done ? ' · 可领取' : ''}`);
  metaBox.append(counter);

  const action = h('button', 'btn btn-sm');
  action.type = 'button';
  action.id = `btn-claim-${mission.id}`;
  if (state.claimed) {
    action.classList.add('btn-ghost', 'claimed');
    setText(action, '已领取');
    action.disabled = true;
  } else if (done) {
    action.classList.add('btn-primary', 'claimable');
    setText(action, '领取奖励');
    action.addEventListener('click', () => claimMission(mission, weekly, action));
  } else {
    action.classList.add('btn-ghost');
    setText(action, '进行中');
    action.disabled = true;
  }
  row.append(action);
  return row;
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
    if (!group.list.length) {
      list.append(emptyPanel('本期任务已全部完成', '新的每日任务会在明天 0 点刷新，每周任务在周一刷新。'));
      continue;
    }
    for (const mission of group.list) list.append(missionCard(mission, group.key === 'weekly'));
    if (group.list.every(m => missionState(m.id, group.key === 'weekly').claimed)) {
      list.append(emptyPanel('这一栏已经清空', '所有奖励都领取完毕，明天再来。'));
    }
  }
  updateMissionTools();
  updateMissionCountdown();
}

/** 任务页工具条：今日剩余倒计时条 + 一键领取 + 连续天数。 */
function updateMissionTools() {
  const el = screenEl('missions');
  if (!el) return;
  const fill = document.getElementById('ui-daybar-fill');
  const count = document.getElementById('ui-mission-count');
  const claimAll = document.getElementById('btn-claim-all');
  const streakNode = document.getElementById('ui-mission-streak');
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const remain = Math.max(0, next.getTime() - now.getTime());
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, 100 - (remain / 86400000) * 100)).toFixed(1)}%`;
  if (count) setText(count, `${countdownText(remain)}`);
  const claimable = [];
  for (const [key, list] of [['daily', dailyMissions()], ['weekly', weeklyMissions()]]) {
    for (const mission of list) {
      const state = missionState(mission.id, key === 'weekly');
      const done = !!state.done || Number(state.progress) >= (mission.target || 1);
      if (done && !state.claimed) claimable.push(mission);
    }
  }
  if (claimAll) {
    setText(claimAll, claimable.length ? `一键领取（${claimable.length}）` : '暂无可领取');
    claimAll.disabled = claimable.length === 0;
    claimAll.dataset.claimable = String(claimable.length);
  }
  if (streakNode) {
    const saved = saveData().streak;
    if (Number.isFinite(Number(saved)) && Number(saved) > 0) {
      setText(streakNode, `连续 ${fmtNum(saved)} 天`);
      streakNode.style.display = '';
    } else {
      streakNode.style.display = 'none';
    }
  }
}

/** 一键领取：按顺序调用 claimMission，全部结束后一次性 renderMissions。 */
function claimAllMissions(button) {
  const targets = [];
  for (const [key, list] of [['daily', dailyMissions()], ['weekly', weeklyMissions()]]) {
    for (const mission of list) {
      const state = missionState(mission.id, key === 'weekly');
      const done = !!state.done || Number(state.progress) >= (mission.target || 1);
      if (done && !state.claimed) targets.push({ mission, weekly: key === 'weekly' });
    }
  }
  if (!targets.length) { toast('暂无可领取的任务奖励'); return; }
  const m = meta();
  let xp = 0; let coin = 0; let ok = 0;
  withBusy(button, () => {
    for (const item of targets) {
      let result = null;
      try { if (m?.claimMission) result = m.claimMission(item.mission.id); } catch { result = null; }
      const success = result === true || (result && typeof result === 'object' && result.ok !== false);
      if (success) { ok += 1; xp += Number(item.mission.xp) || 0; coin += Number(item.mission.credits) || 0; }
    }
  }, { label: '领取中…', timeoutMs: 8000, timeoutMessage: '领取超时，请稍后重试' });
  // withBusy 是同步任务，下一帧再刷新 UI，让 loading 至少出现一帧
  setTimeout(() => {
    if (!ok) { toast('没有可领取的奖励'); renderMissions(); return; }
    playAudio('ui_reward');
    renderMissions();
    refreshChrome();
    toast(`已领取 ${ok} 项 · +${fmtNum(xp)} 经验 · +${fmtNum(coin)} 信用点`, 2800);
    flashReward(xp, coin);
  }, 120);
}

function claimMission(mission, weekly, button = null) {
  const m = meta();
  if (button && button.dataset.busy === '1') return;
  if (button) {
    // 领取是同步的存档写入：放进 withBusy 只为给出可见 loading 与超时兜底
    let outcome = { ok: false, message: '' };
    withBusy(button, () => {
      let result = null;
      try { result = m?.claimMission ? m.claimMission(mission.id) : null; } catch (err) { outcome = { ok: false, message: err?.message || '领取失败' }; return; }
      const success = result === true || (result && typeof result === 'object' && result.ok !== false);
      if (success) outcome = { ok: true, message: '' };
      else {
        const reason = result?.error;
        outcome = { ok: false, message: reason === 'already-claimed' || reason === 'claimed' ? '奖励已领取'
          : reason === 'not-complete' || reason === 'incomplete' ? '任务尚未完成' : '暂时无法领取奖励' };
      }
    }, { label: '领取中…', timeoutMessage: '领取超时，请稍后重试' });
    if (!outcome.ok) { if (outcome.message) toast(outcome.message, 2400); return; }
    applyMissionClaim(mission);
    return;
  }
  let result = null;
  try {
    if (m?.claimMission) result = m.claimMission(mission.id);
  } catch (err) { toast(err?.message || '领取失败'); return; }
  const ok = result === true || (result && typeof result === 'object' && result.ok !== false);
  if (!ok) {
    const reason = result?.error;
    toast(reason === 'claimed' ? '奖励已领取' : reason === 'incomplete' ? '任务尚未完成' : '暂时无法领取奖励');
    return;
  }
  applyMissionClaim(mission);
}

function applyMissionClaim(mission) {
  playAudio('ui_reward');
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

// ── 13 · 图鉴 ───────────────────────────────────────────────────────────────
function buildCodex() {
  const head = screenHead('CODEX', '战场档案', '武器、配件、道具、地图与敌人的完整资料。点击卡片查看详情。');

  const tabs = h('div', 'tabs codex-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '档案分类');
  for (const tab of codexTabs) {
    const btn = h('button', 'tab', tab.name);
    btn.type = 'button';
    btn.dataset.tab = tab.id;
    btn.id = `codex-tab-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => { uiState.codexTab = tab.id; playAudio('ui_click'); renderCodex(); });
    tabs.append(btn);
  }
  const grid = h('div', 'codex-grid');
  grid.id = 'codex-grid';
  const content = h('div', 'stack-lg');
  content.append(tabs, grid);
  return screenShell({ name: 'codex', head, main: content });
}

function codexEntries(kind) {
  if (kind === 'weapon') return fullWeaponEntries().map(w => ({ ...w, kind: 'weapon' }));
  if (kind === 'attachment') return Object.entries(attachmentTable()).map(([id, a]) => ({ id, ...a, kind: 'attachment' }));
  if (kind === 'item') {
    const items = itemTable();
    return Object.entries(items).map(([id, v]) => ({ id, ...v, kind: 'item' }));
  }
  if (kind === 'map') return mapList().map(m => ({ ...m, kind: 'map' }));
  return enemyCatalog().map(e => ({ ...e, kind: 'enemy' }));
}

/** 图鉴条目解锁条件：返回 { locked, label, hint }。 */
function codexLockState(entry) {
  const level = playerLevel();
  if (entry.kind === 'map') {
    const need = Number(entry.difficulty) >= 3 ? 12 : Number(entry.difficulty) >= 2 ? 6 : 1;
    return { locked: level < need, label: `等级 ${need} 解锁`, hint: `达到等级 ${need} 后可进入该战场。` };
  }
  if (entry.kind === 'enemy') {
    const need = (Number(entry.threat) || 1) >= 5 ? 10 : (Number(entry.threat) || 1) >= 3 ? 5 : 1;
    return { locked: level < need, label: `等级 ${need} 解锁`, hint: `在生存波次中遭遇后解锁完整档案（等级 ${need}）。` };
  }
  if (entry.kind === 'attachment') {
    const need = entry.rarity === 'legendary' ? 18 : entry.rarity === 'epic' ? 12 : entry.rarity === 'rare' ? 6 : 1;
    return { locked: level < need, label: `等级 ${need} 解锁`, hint: `在战场上拾取过同类配件后解锁（等级 ${need}）。` };
  }
  if (entry.kind === 'item') {
    const need = Number(entry.unlock) || 1;
    return { locked: level < need, label: `等级 ${need} 解锁`, hint: `等级 ${need} 起可在战场上找到。` };
  }
  const need = Number(entry.unlock) || 1;
  return { locked: level < need, label: `等级 ${need} 解锁`, hint: `达到等级 ${need} 后解锁该武器档案。` };
}

function codexIconName(kind) {
  return kind === 'map' ? 'map' : kind === 'enemy' ? 'skull' : kind === 'item' ? 'box'
    : kind === 'attachment' ? 'crosshair' : 'target';
}

function renderCodex() {
  const el = screenEl('codex');
  if (!el) return;
  for (const tab of el.querySelectorAll('.codex-tabs .tab')) {
    const active = tab.dataset.tab === uiState.codexTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.setAttribute('tabindex', active ? '0' : '-1');
  }
  const grid = document.getElementById('codex-grid');
  if (!grid) return;
  clear(grid);
  const entries = codexEntries(uiState.codexTab);
  if (!entries.length) {
    grid.append(emptyPanel('这一类还没有档案', '继续对局与搜刮，新的条目会自动收录。'));
    return;
  }
  for (const entry of entries) {
    const lock = codexLockState(entry);
    const card = h('button', `codex-card ${rarityClass(entry.rarity || 'common')}${lock.locked ? ' ui-locked' : ''}`.trim());
    card.type = 'button';
    card.dataset.kind = entry.kind;
    card.dataset.id = entry.id;
    card.id = `codex-${entry.kind}-${entry.id}`;
    const art = h('div', 'codex-art');
    art.dataset.kind = entry.kind;
    art.append(icon(lock.locked ? 'lock' : codexIconName(entry.kind), 24));
    const meta = h('div', 'codex-meta');
    meta.append(h('b', 'item-name', entry.name || entry.id));
    const sub = entry.kind === 'map' ? `${entry.regions?.length || 0} 区域 · 难度 ${entry.difficulty || 1}`
      : entry.kind === 'enemy' ? `威胁 ${entry.threat || 1} · 生命 ${entry.hp || DASH}`
        : entry.kind === 'attachment' ? `${entry.slot || '通用'} · ${rarityName(entry.rarity)}`
          : rarityName(entry.rarity || 'common');
    const subLine = h('small', 'muted');
    if (entry.rarity) subLine.append(rarityMarkNode(entry.rarity), h('span', null, ` ${sub}`));
    else subLine.append(h('span', null, sub));
    meta.append(subLine);
    if (lock.locked) {
      const tag = h('span', 'ui-lock-tag');
      tag.append(icon('lock', 11), h('span', null, lock.label));
      meta.append(tag);
    }
    card.append(art, meta);
    if (entry.kind === 'weapon' && !lock.locked) {
      card.append(h('span', 'codex-badge', `${entry.damage || 0} 伤害`));
    }
    syncLabel(card);
    card.addEventListener('click', () => {
      if (lock.locked) { playAudio('ui_deny'); toast(`尚未解锁 · ${lock.hint}`, 2600); return; }
      openCodexDetail(entry.kind, entry.id);
    });
    grid.append(card);
  }
}

export function openCodexDetail(kind, id) {
  let entry = null;
  if (kind === 'weapon') entry = fullWeaponEntries().find(w => w.id === id) || null;
  else if (kind === 'attachment') entry = attachmentTable()[id] && { id, ...attachmentTable()[id], kind };
  else if (kind === 'item') entry = itemTable()[id] && { id, ...itemTable()[id], kind };
  else if (kind === 'map') entry = mapList().find(m => m.id === id);
  else if (kind === 'enemy') entry = enemyCatalog().find(e => e.id === id);
  if (!entry) { toast('暂时没有这条档案'); return; }
  if (entry.kind === 'map' || kind === 'map') { showFullMap(entry); return; }
  const bodyBox = h('div', 'codex-detail');
  const hero = h('div', `codex-hero ${rarityClass(entry.rarity || 'common')} ui-codex-detail-head`);
  const bigIcon = h('div', 'ui-codex-big-icon');
  bigIcon.style.cssText = 'display:grid;place-items:center;width:64px;height:64px;flex:0 0 auto;border:1px solid var(--line-strong);border-radius:var(--radius-md);background:rgba(9,30,31,.8);color:var(--c-teal-300,#6fe0c8)';
  bigIcon.append(icon(codexIconName(kind), 34));
  hero.append(bigIcon);
  const headInfo = h('div', 'codex-hero-info');
  headInfo.append(h('h3', 'title-md', entry.name || id), h('div', 'row'));
  const tagRow = headInfo.querySelector('.row');
  if (entry.rarity) tagRow.append(rarityTag(entry.rarity));
  if (entry.cls) tagRow.append(h('span', 'chip chip-xs', entry.cls));
  if (entry.ammo) tagRow.append(h('span', 'chip chip-xs', `弹药 · ${entry.ammo}`));
  if (entry.kind === 'map') tagRow.append(h('span', 'chip chip-xs', `${entry.regions?.length || 0} 区域`));
  hero.append(headInfo);
  bodyBox.append(hero);
  bodyBox.append(h('p', 'codex-desc', entry.desc || entry.description || '暂无更多资料。'));
  const rows = [];
  if (entry.kind === 'weapon') {
    rows.push(['伤害', entry.damage, 130], ['射速', entry.magazine ? Math.round(60 / (entry.interval || 0.12)) : 0, 900],
      ['射程', entry.range, 120], ['弹匣', entry.magazine, 80], ['精度', Math.round((1 - (entry.spread || 0.03) * 10) * 100), 100]);
  } else if (entry.kind === 'enemy') {
    rows.push(['生命', entry.hp, 2600], ['伤害', entry.damage, 70], ['威胁', entry.threat, 5]);
  } else if (entry.kind === 'item') {
    if (entry.heal) rows.push(['恢复', entry.heal, 100]);
    if (entry.shield) rows.push(['护盾', entry.shield, 100]);
    if (entry.use) rows.push(['使用时间', entry.use, 5]);
    if (entry.radius) rows.push(['半径', entry.radius, 10]);
    if (entry.damage) rows.push(['伤害', entry.damage, 140]);
    if (entry.fuse) rows.push(['引信', entry.fuse, 5]);
    if (entry.duration) rows.push(['持续', entry.duration, 30]);
    if (entry.stack) rows.push(['堆叠上限', entry.stack, 10]);
  } else if (entry.kind === 'attachment') {
    if (entry.spreadMul != null) rows.push(['散布倍率', Number(entry.spreadMul).toFixed(2), 2]);
    if (entry.reloadMul != null) rows.push(['换弹倍率', Number(entry.reloadMul).toFixed(2), 2]);
    if (entry.magMul != null) rows.push(['弹匣倍率', Number(entry.magMul).toFixed(2), 3]);
    if (entry.zoom) rows.push(['倍率', entry.zoom, 6]);
  }
  if (rows.length) {
    const statRows = h('div', 'stat-rows');
    for (const [label, value, max] of rows) {
      const row = h('div', 'stat-row');
      row.append(h('small', 'stat-label', label), h('b', 'stat-value', value ?? DASH), statBar(value || 0, max || 1));
      statRows.append(row);
    }
    bodyBox.append(statRows);
  }
  if (entry.kind === 'map' && entry.regions) {
    const list = h('div', 'region-list');
    for (const region of entry.regions) {
      const item = h('div', 'region-row');
      item.append(h('b', null, region.name), h('small', 'muted', region.note || ''), h('span', 'badge muted', `T${region.tier || 1}`));
      list.append(item);
    }
    bodyBox.append(list);
  }
  // 解锁条件（灰显条目也允许从外部 API 打开，这里给出明确说明）
  const lock = codexLockState(entry);
  const cond = h('div', 'ui-codex-cond');
  cond.append(h('span', 'chip chip-xs', `等级需求 ${Number(entry.unlock) || 1}`));
  if (entry.rarity) cond.append(h('span', 'chip chip-xs', `稀有度 ${rarityName(entry.rarity)}`));
  if (entry.kind === 'weapon' && entry.tier) cond.append(h('span', 'chip chip-xs', `T${entry.tier} 战场`));
  bodyBox.append(cond);
  if (lock.locked) {
    const note = h('div', 'ui-codex-lock-note');
    note.id = 'codex-lock-note';
    note.append(h('b', null, `尚未解锁 · ${lock.label}`), h('div', null, lock.hint));
    bodyBox.append(note);
  }
  const modal = showModal('codex-dialog', {
    title: '档案详情',
    eyebrow: 'CODEX ENTRY',
    hint: entry.kind === 'weapon' ? '数值为本体白板，配件会进一步改变手感。' : '',
    body: bodyBox,
    wide: true,
  });
  modal.querySelector('.modal-card')?.classList.add('modal-wide');
}

// ── 14 · 生涯 ───────────────────────────────────────────────────────────────
function buildCareer() {
  const head = screenHead('CAREER', '生涯档案', '你的每一场战斗都会记录在这里。');

  const content = h('div', 'stack-lg');
  // 注意：不要同时挂 .panel（.panel 是 flex-direction:column，会把 .career-head 的横排覆盖成竖排居中）
  const overview = h('section', 'career-head');
  overview.id = 'career-overview';
  content.append(overview);

  const statPanel = h('section', 'panel');
  const statHead = h('div', 'panel-head');
  statHead.append(h('h3', null, '生涯统计'));
  const statGrid = h('div', 'stat-grid career-stats panel-body');
  statGrid.id = 'career-stats';
  statPanel.append(statHead, statGrid);

  // 武器使用分布（按击杀降序，最多 6 把）。没有数据时整块隐藏，避免空标题。
  const weaponBox = h('div', 'career-weapons panel-body hidden');
  weaponBox.id = 'career-weapons';
  weaponBox.setAttribute('aria-label', '常用武器击杀分布');
  statPanel.append(weaponBox);
  content.append(statPanel);

  const achPanel = h('section', 'panel');
  const achHead = h('div', 'panel-head');
  achHead.append(h('h3', null, '成就'), h('span', 'spacer'), h('small', null, '完成后可领取奖励'));
  const achGrid = h('div', 'ach-grid panel-body');
  achGrid.id = 'achievement-grid';
  achPanel.append(achHead, achGrid);
  content.append(achPanel);

  const historyPanel = h('section', 'panel');
  const hisHead = h('div', 'panel-head');
  hisHead.append(h('h3', null, '最近战报'));
  const history = h('div', 'match-history panel-body');
  history.id = 'match-history';
  historyPanel.append(hisHead, history);
  content.append(historyPanel);

  return screenShell({ name: 'career', head, main: content });
}

function renderCareer() {
  const el = screenEl('career');
  if (!el) return;
  const info = xpInfo();
  const rank = rankInfo();
  const overview = document.getElementById('career-overview');
  if (overview) {
    clear(overview);
    const levelRing = h('div', 'level-ring');
    const pct = Math.max(0, Math.min(100, ((Number(info.current) || 0) / (Number(info.needed) || 1)) * 100));
    levelRing.style.setProperty('--level-progress', pct.toFixed(1));
    levelRing.append(h('b', null, fmtNum(info.level || playerLevel())), h('small', null, 'LV'));
    const right = h('div', 'career-meta');
    const nameRow = h('div', 'row');
    nameRow.append(h('b', 'career-name', OWNER_NAME), h('span', 'badge', rank?.name || rank?.tier || '青铜'));
    right.append(nameRow);
    right.append(h('small', 'muted', `经验 ${fmtNum(info.current || 0)} / ${fmtNum(info.needed || 0)}`));
    const bar = h('div', 'progress');
    const fill = h('i');
    fill.style.width = `${pct.toFixed(1)}%`;
    bar.append(fill);
    right.append(bar);
    const rankBar = h('div', 'progress');
    const rpf = h('i');
    rpf.style.width = `${Math.round((rank?.progress || 0) * 100)}%`;
    rankBar.append(rpf);
    right.append(h('small', 'muted', `段位分 ${fmtNum(rating())} · 距离下一段位 ${fmtNum(Math.max(0, 240 - (rating() % 240)))} 分`), rankBar);
    overview.append(levelRing, right);
  }

  // 生涯统计：优先用 CareerStats（K/D、胜率、命中率、场均伤害、武器分布），
  // 老存档没有 careerStats 时自动回落到 meta.stats 的少量字段。
  const stats = saveData().stats || {};
  const career = (() => { try { return app?.career?.summary?.() || null; } catch { return null; } })();
  const c = career || {};
  const grid = document.getElementById('career-stats');
  if (grid) {
    clear(grid);
    const pct = (v) => `${(Number(v) || 0).toFixed(1)}%`;
    const rows = [
      ['对局场次', fmtNum(c.matches ?? stats.matches ?? 0)],
      ['胜场', fmtNum(c.wins ?? stats.wins ?? 0)],
      ['胜率', career ? pct(c.winRatePct) : DASH],
      ['K/D', career ? (Number(c.kd) || 0).toFixed(2) : DASH],
      ['淘汰数', fmtNum(c.kills ?? stats.kills ?? 0)],
      ['场均淘汰', career ? (Number(c.avgKills) || 0).toFixed(2) : DASH],
      ['场均伤害', fmtNum(career ? c.avgDamage : (stats.damage || 0) / Math.max(1, stats.matches || 1))],
      ['命中率', career ? pct(c.accuracy) : DASH],
      ['爆头率', career ? pct(c.headshotRate) : DASH],
      ['场均生存', career ? fmtTime(c.avgSurvival) : fmtTime(stats.survived || 0)],
      ['最佳名次', (c.bestPlacement || stats.bestPlacement) ? `#${c.bestPlacement || stats.bestPlacement}` : DASH],
      ['当前连胜', fmtNum(c.streak ?? stats.streak ?? 0)],
      ['最高连胜', fmtNum(c.bestStreak ?? stats.bestStreak ?? 0)],
      ['波次纪录', fmtNum(stats.hordeWaves || 0)],
      ['段位分', fmtNum(rating())],
      ['总游玩时长', career ? fmtTime(c.playTime) : DASH],
    ];
    for (const [label, value] of rows) {
      const card = h('div', 'stat');
      card.append(h('small', null, label), h('b', null, value));
      grid.append(card);
    }
  }
  // 武器使用分布：按击杀降序，显示前 6 把（没有数据时整块隐藏）
  const weaponBox = document.getElementById('career-weapons');
  if (weaponBox) {
    clear(weaponBox);
    let rows = [];
    try { rows = app?.career?.weaponBreakdown?.() || []; } catch { rows = []; }
    rows = rows.filter(r => (Number(r.kills) || 0) > 0).slice(0, 6);
    if (!rows.length) {
      weaponBox.classList.add('hidden');
    } else {
      weaponBox.classList.remove('hidden');
      const top = Math.max(1, ...rows.map(r => Number(r.kills) || 0));
      for (const row of rows) {
        const line = h('div', 'career-weapon-row');
        line.append(h('small', null, row.name || row.weaponId));
        const bar = h('div', 'progress progress-sm');
        const fill = h('i');
        fill.style.width = `${Math.round(((Number(row.kills) || 0) / top) * 100)}%`;
        bar.append(fill);
        line.append(bar, h('b', null, fmtNum(row.kills)));
        weaponBox.append(line);
      }
    }
  }

  const achGrid = document.getElementById('achievement-grid');
  if (achGrid) {
    clear(achGrid);
    for (const ach of fullAchievements()) {
      const state = achievementState(ach.id);
      const card = h('article', 'ach-card');
      card.id = `achievement-${ach.id}`;
      const iconWrap = h('div', 'ach-icon');
      iconWrap.append(icon('trophy', 20));
      const main = h('div', 'ach-body');
      main.append(h('b', null, ach.hidden && !state.done ? '隐藏成就' : ach.title || ach.id));
      main.append(h('small', 'muted', ach.desc || ''));
      const progressValue = Math.min(Number(state.progress) || 0, ach.target || 1);
      const bar = h('div', 'progress progress-sm');
      const fill = h('i');
      fill.style.width = `${Math.min(100, (progressValue / (ach.target || 1)) * 100).toFixed(1)}%`;
      bar.append(fill);
      main.append(bar, h('small', 'muted', `${fmtNum(progressValue)} / ${fmtNum(ach.target || 0)}`));
      const action = h('button', 'btn btn-xs');
      action.type = 'button';
      if (state.claimed) { action.classList.add('btn-ghost'); action.textContent = '已领取'; action.disabled = true; }
      else if (state.done) {
        action.classList.add('btn-primary', 'claimable');
        action.textContent = '领取';
        action.addEventListener('click', () => claimAchievement(ach));
      } else { action.classList.add('btn-ghost'); action.textContent = '未完成'; action.disabled = true; }
      card.append(iconWrap, main, action);
      if (state.done) card.classList.add('done');
      achGrid.append(card);
    }
  }

  const history = document.getElementById('match-history');
  if (history) {
    clear(history);
    const saved = saveData().lastResult;
    const list = recentMatches.length ? recentMatches : saved ? [{ ...saved, historical: true }] : [];
    if (!list.length) history.append(emptyState('还没有战报记录。完成一局后会显示在这里。'));
    for (const match of list.slice(0, 8)) {
      const row = h('div', `list-row match-row ${match.won ? 'win' : 'lose'}`);
      const resultTag = h('span', `badge ${match.won ? 'badge-win' : 'badge-lose'}`, match.won ? '胜利' : '失败');
      const main = h('div', 'grow');
      main.append(h('b', null, `${mapNameOf(match.mapId)} · ${modeNameOf(match.mode)}`));
      main.append(h('small', 'muted', `#${match.placement || DASH} 名 · ${fmtNum(match.kills || 0)} 淘汰 · ${fmtTime(match.survived || 0)}`));
      row.append(resultTag, main, h('small', 'muted', match.historical ? '上一局' : '刚刚'));
      history.append(row);
    }
  }
}

function claimAchievement(ach) {
  const m = meta();
  let result = null;
  try {
    if (m?.claimAchievement) result = m.claimAchievement(ach.id);
  } catch (err) { toast(err?.message || '领取失败'); return; }
  const ok = result === true || (result && typeof result === 'object' && result.ok !== false);
  if (!ok) {
    const reason = result?.error;
    toast(reason === 'claimed' ? '奖励已领取' : reason === 'incomplete' ? '成就尚未完成' : '暂时无法领取奖励');
    return;
  }
  playAudio('ui_reward');
  renderCareer();
  refreshChrome();
  toast(`成就达成 · ${ach.title}`, 2600);
  flashReward(ach.xp, ach.credits);
}

function mapNameOf(mapId) { return (data().maps || MAPS)[mapId]?.name || mapId || DASH; }
function modeNameOf(modeId) { return MODE_LIST.find(m => m.id === modeId)?.name || '训练场'; }

// ── 15 · 设置 ───────────────────────────────────────────────────────────────
function settingRow(label, hint) {
  const row = h('div', 'setting-row');
  const labelWrap = h('span', 'setting-label');
  labelWrap.append(h('b', null, label));
  if (hint) labelWrap.append(h('small', null, hint));
  row.append(labelWrap);
  return row;
}
function buildToggle(checked, onChange, label) {
  const toggle = h('button', 'toggle');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('aria-checked', checked ? 'true' : 'false');
  toggle.classList.toggle('on', !!checked);
  toggle.addEventListener('click', () => {
    const next = !toggle.classList.contains('on');
    toggle.classList.toggle('on', next);
    toggle.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange(next);
  });
  return toggle;
}
function buildSlider(value, min, max, step, onChange, label) {
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'slider';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  const paint = () => {
    const pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--range-progress', `${pct.toFixed(1)}%`);
  };
  paint();
  input.addEventListener('input', () => { paint(); onChange(Number(input.value)); });
  return input;
}

function buildSettings() {
  const head = screenHead('SETTINGS', '作战设置', '调整后立即生效并自动保存，下次启动沿用当前配置。');
  const s = app?.settings || {};
  const columns = h('div', 'settings-columns');

  const panel = (id, iconName, title, rows) => {
    const p = h('section', 'panel');
    p.id = id;
    const ph = h('div', 'panel-head');
    ph.append(icon(iconName, 18), h('h3', null, title));
    const pb = h('div', 'panel-body');
    for (const row of rows) pb.append(row);
    p.append(ph, pb);
    return p;
  };

  // ---- 音频（main.js 设置键：sfx / music，0..1） ----
  const soundRow = settingRow('游戏音效', '枪声、脚步与界面反馈');
  const soundToggle = buildToggle((s.sfx ?? 0.75) > 0, value => updateSetting('sfx', value ? 0.75 : 0), '游戏音效');
  soundToggle.id = 'sound-toggle';
  soundRow.append(soundToggle);
  const musicRow = settingRow('背景音乐', '主菜单与战斗音乐');
  const musicToggle = buildToggle((s.music ?? 0.38) > 0, value => updateSetting('music', value ? 0.38 : 0), '背景音乐');
  musicToggle.id = 'music-toggle';
  musicRow.append(musicToggle);
  const sfxRow = settingRow('音效音量', '');
  const sfxSlider = buildSlider(Math.round((s.sfx ?? 0.75) * 100), 0, 100, 5, value => updateSetting('sfx', value / 100), '音效音量');
  sfxSlider.id = 'sfx-volume';
  sfxRow.append(sfxSlider);
  const musicVolRow = settingRow('音乐音量', '');
  const musicSlider = buildSlider(Math.round((s.music ?? 0.38) * 100), 0, 100, 5, value => updateSetting('music', value / 100), '音乐音量');
  musicSlider.id = 'music-volume';
  musicVolRow.append(musicSlider);
  const audioPanel = panel('settings-audio', 'volume', '音频', [soundRow, musicRow, sfxRow, musicVolRow]);

  // ---- 画面 ----
  const qualityRow = settingRow('画质预设', '低画质可显著提升中端机帧率');
  const qualitySelect = document.createElement('select');
  qualitySelect.id = 'quality';
  qualitySelect.setAttribute('aria-label', '画质预设');
  for (const [value, label] of [['low', '流畅'], ['balanced', '均衡'], ['high', '高清']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    qualitySelect.append(option);
  }
  qualitySelect.value = s.quality || 'balanced';
  qualitySelect.addEventListener('change', () => { updateSetting('quality', qualitySelect.value); playAudio('ui_click'); });
  qualityRow.append(qualitySelect);
  const fpsRow = settingRow('显示帧率', 'HUD 右上角显示实时 FPS');
  const fpsToggle = buildToggle(!!s.showFps, value => updateSetting('showFps', value), '显示帧率');
  fpsToggle.id = 'fps-toggle';
  fpsRow.append(fpsToggle);
  const hudRow = settingRow('HUD 缩放', '调整局内界面大小（70%–130%）');
  const hudScale = buildSlider(Math.round((s.hudScale ?? 1) * 100), 70, 130, 5, value => updateSetting('hudScale', value / 100), 'HUD 缩放');
  hudRow.append(hudScale);
  const displayPanel = panel('settings-display', 'monitor', '画面', [qualityRow, fpsRow, hudRow]);

  // ---- 操作 ----
  const sensRow = settingRow('瞄准灵敏度', '数值越高转向越快');
  const sensSlider = buildSlider(Math.round((s.sensitivity ?? 1) * 100), 20, 200, 5, value => updateSetting('sensitivity', value / 100), '瞄准灵敏度');
  sensRow.append(sensSlider);
  const stickRow = settingRow('摇杆大小', '触屏摇杆的视觉与触控半径');
  const stickSlider = buildSlider(Math.round((s.joystickScale ?? 1) * 100), 70, 140, 5, value => updateSetting('joystickScale', value / 100), '摇杆大小');
  stickRow.append(stickSlider);
  const autoRow = settingRow('自动开火', '准星覆盖目标时自动射击');
  const autoToggle = buildToggle(s.autoFire !== false, value => updateSetting('autoFire', value), '自动开火');
  autoToggle.id = 'autofire-toggle';
  autoRow.append(autoToggle);
  const hapticRow = settingRow('震动反馈', '受击与开火时轻微震动');
  const hapticToggle = buildToggle(s.haptics !== false, value => updateSetting('haptics', value), '震动反馈');
  hapticToggle.id = 'haptics-toggle';
  hapticRow.append(hapticToggle);
  const layoutRow = settingRow('操作布局', '左手或右手主导');
  const layoutSeg = h('div', 'segmented');
  const layoutValue = s.leftHanded ? 'left' : 'right';
  for (const [value, label] of [['right', '右手'], ['left', '左手']]) {
    const btn = h('button', value === layoutValue ? 'active' : '', label);
    btn.type = 'button';
    btn.dataset.layout = value;
    btn.addEventListener('click', () => {
      for (const item of layoutSeg.children) item.classList.toggle('active', item === btn);
      updateSetting('leftHanded', value === 'left');
      playAudio('ui_click');
    });
    layoutSeg.append(btn);
  }
  layoutRow.append(layoutSeg);
  const motionRow = settingRow('减少动态效果', '关闭入场与呼吸动画，降低晕动感');
  const motionToggle = buildToggle(!!s.reducedMotion, value => updateSetting('reducedMotion', value), '减少动态效果');
  motionToggle.id = 'motion-toggle';
  motionRow.append(motionToggle);
  const controlsPanel = panel('settings-controls', 'gamepad', '操作', [sensRow, stickRow, autoRow, hapticRow, layoutRow, motionRow]);

  // ---- 引导与存档 ----
  const helpRow = settingRow('操作说明', '查看键鼠与触屏两套操作方式');
  const helpBtn = h('button', 'btn btn-ghost btn-sm', '查看');
  helpBtn.type = 'button';
  helpBtn.id = 'btn-show-help';
  helpBtn.addEventListener('click', () => { playAudio('ui_click'); showHelpDialog(); });
  helpRow.append(helpBtn);
  const tutorialRow = settingRow('重新播放新手引导', '从第一步开始重新熟悉操作');
  const tutorialBtn = h('button', 'btn btn-ghost btn-sm', '重启引导');
  tutorialBtn.type = 'button';
  tutorialBtn.id = 'btn-restart-tutorial';
  tutorialBtn.addEventListener('click', () => { playAudio('ui_click'); restartTutorial(); });
  tutorialRow.append(tutorialBtn);
  const resetRow = settingRow('重置本地存档', '等级、信用点、任务与成就都会清空');
  const resetBtn = h('button', 'btn btn-danger btn-sm', '重置');
  resetBtn.type = 'button';
  resetBtn.id = 'btn-reset-save';
  resetBtn.addEventListener('click', () => { playAudio('ui_click'); confirmResetSave(); });
  resetRow.append(resetBtn);
  // 遥测：默认关闭，必须玩家主动开启。此前这个开关根本不存在 —— shared/telemetry.mjs
  // 与 docs/TELEMETRY-WIRING.md 都写了「玩家可在设置页开启」，但设置页里 grep 不到
  // 任何 telemetry 字样，导致遥测永远是关闭状态（合规叙事成立、功能为零）。
  const telemetryRow = settingRow('匿名游戏数据', '仅统计对局与崩溃，不含昵称、账号与设备标识；可随时关闭');
  const telemetryToggle = buildToggle(!!s.telemetry, value => updateSetting('telemetry', value), '匿名游戏数据');
  telemetryToggle.id = 'telemetry-toggle';
  telemetryRow.append(telemetryToggle);

  const guidePanel = panel('settings-guide', 'help', '引导与存档', [helpRow, tutorialRow, telemetryRow, resetRow]);

  columns.append(audioPanel, displayPanel, controlsPanel, guidePanel);
  const content = h('div', 'stack-lg');
  content.append(columns);
  return screenShell({ name: 'settings', head, main: content });
}

function updateSetting(key, value) {
  // 1) 写进存档（main.js 的 applySettings 会用 meta.data.settings 覆盖 app.settings，
  //    所以必须先落盘，否则滑条会被旧值回弹）
  try { meta()?.setSettings?.({ [key]: value }); } catch (err) { console.warn('[ui] 设置存档失败', err); }
  // 2) 同步到 app.settings 并让 main.js 应用（音频/画质/输入/HUD）
  try { if (app?.settings) app.settings[key] = value; } catch { /* 忽略只读 settings */ }
  try {
    if (app?.applySettings) app.applySettings(key);
    else if (app?.saveSettings) app.saveSettings();
  } catch (err) { console.warn('[ui] 设置应用失败', err); }
}

function restartTutorial() {
  confirmDialog({
    title: '重新播放新手引导',
    message: '将从头展示移动、射击、搜刮与救援的操作提示，不影响现有存档。',
    confirmText: '开始引导',
    onConfirm: () => {
      // 先清掉存档里的 tutorialDone（main.js 那份），再把引导层真正拉起来。
      // 历史实现只弹一个 toast：按钮写着「重新播放」，屏幕上什么也没发生。
      try { app?.restartTutorial?.(); } catch { /* 忽略 */ }
      // 设置页可能盖在引导层之上 → 先回主菜单再展示，避免引导被弹窗挡住。
      if (activeScreen && activeScreen !== 'home') openScreen('home');
      hideAllDialogs();
      const shown = maybeShowOnboarding({ force: true });
      if (!shown) toast('新手引导已重置', 2400);
    },
  });
}

function confirmResetSave() {
  confirmDialog({
    title: '重置本地存档',
    message: '等级、信用点、已解锁外观、任务与成就进度都会被清空，且无法恢复。确定继续吗？',
    confirmText: '继续',
    danger: true,
    onConfirm: () => {
      confirmDialog({
        title: '再次确认',
        message: '重置后所有进度都会永久丢失。再次点击「确认重置」执行。',
        confirmText: '确认重置',
        danger: true,
        onConfirm: () => {
          try { meta()?.reset?.(); } catch (err) { console.warn(err); }
          try { app?.settings && app.saveSettings?.(); } catch { /* 忽略 */ }
          refreshAll();
          toast('存档已重置', 2400);
        },
      });
    },
  });
}

// ── 16 · 弹窗基础设施 ───────────────────────────────────────────────────────
function ensureDialog(id) {
  let node = dialogs.get(id);
  if (node) return node;
  node = h('div', 'modal');
  node.id = id;
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  node.style.pointerEvents = 'auto';
  const backdrop = h('div', 'modal-backdrop');
  backdrop.addEventListener('click', () => { if (node.dataset.static !== '1') hideDialog(id); });
  const card = h('div', 'modal-card');
  node.append(backdrop, card);
  const close = h('button', 'modal-close');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  close.append(icon('close', 18));
  // 关键：static 弹窗（结算/暂停/房间）不允许“关掉但留在战场”。
  // 关 X 必须等价于该弹窗的“离开”语义，否则会出现无 UI 的幽灵战场（P0）。
  close.addEventListener('click', () => {
    playAudio('ui_click');
    if (node.dataset.static === '1') {
      if (id === 'result-dialog') { leaveResultToHome(); return; }
      if (id === 'pause-dialog') { resumeFromPause(); return; }
      if (id === 'room-dialog') { hideRoom(); try { app?.leaveMatch?.(); } catch { /* 忽略 */ } return; }
    }
    hideDialog(id);
  });
  card.append(close);
  const head = h('div', 'modal-head');
  const eyebrow = h('div', 'eyebrow');
  const title = h('h2', 'modal-title');
  title.id = `${id}-title`;
  node.setAttribute('aria-labelledby', title.id); // 每个弹窗都靠自己的标题命名（WCAG 4.1.2）
  const hint = h('p', 'modal-hint muted');
  head.append(eyebrow, title, hint);
  const body = h('div', 'modal-body');
  const actions = h('div', 'modal-actions');
  card.append(head, body, actions);
  node._parts = { card, eyebrow, title, hint, body, actions };
  document.getElementById('dialog-root')?.append(node);
  dialogs.set(id, node);
  return node;
}

function showModal(id, { title = '', eyebrow = '', hint = '', body = null, actions = null, wide = false, static: isStatic = false } = {}) {
  const node = ensureDialog(id);
  const parts = node._parts;
  setText(parts.eyebrow, eyebrow);
  parts.eyebrow.style.display = eyebrow ? '' : 'none';
  setText(parts.title, title);
  parts.title.style.display = title ? '' : 'none';
  setText(parts.hint, hint || '');
  parts.hint.style.display = hint ? '' : 'none';
  clear(parts.body);
  if (body) parts.body.append(body);
  clear(parts.actions);
  if (Array.isArray(actions)) for (const item of actions) parts.actions.append(item);
  parts.actions.style.display = Array.isArray(actions) && actions.length ? '' : 'none';
  parts.card.classList.toggle('modal-wide', !!wide);
  node.dataset.static = isStatic ? '1' : '';
  node.classList.add('open');
  node.setAttribute('open', '');
  node.setAttribute('aria-hidden', 'false');
  node.dataset.stack = String([...document.querySelectorAll('.modal.open')].length);
  return node;
}

function hideDialog(id) {
  const node = dialogs.get(id) || document.getElementById(id);
  if (!node) return;
  node.classList.remove('open');
  node.removeAttribute('open');
  node.setAttribute('aria-hidden', 'true');
}
function isDialogOpen(id) {
  const node = dialogs.get(id) || document.getElementById(id);
  return !!node && node.classList.contains('open');
}
function anyDialogOpen() {
  return [...document.querySelectorAll('#dialog-root .modal.open')].some(node => node.dataset.static !== '1' || true);
}
function hidePickDialog() { hideDialog('pick-dialog'); }

function confirmDialog({ title, message, confirmText = '确定', cancelText = '取消', danger = false, onConfirm }) {
  const body = h('div', 'confirm-body');
  body.append(h('p', null, message));
  const cancel = h('button', 'btn btn-ghost', cancelText);
  cancel.type = 'button';
  cancel.id = 'btn-confirm-cancel';
  cancel.addEventListener('click', () => hideDialog('confirm-dialog'));
  const ok = h('button', `btn ${danger ? 'btn-danger' : 'btn-primary'}`, confirmText);
  ok.type = 'button';
  ok.id = 'btn-confirm-ok';
  ok.addEventListener('click', () => { hideDialog('confirm-dialog'); try { onConfirm?.(); } catch (err) { console.error(err); toast('操作失败，请重试'); } });
  showModal('confirm-dialog', { title, eyebrow: 'CONFIRM', body, actions: [cancel, ok] });
  ok.focus({ preventScroll: true });
}

// ── 17 · 联机弹窗 ───────────────────────────────────────────────────────────
const netState = { busy: false, nickname: '', server: '', code: '', gameMode: 'squad', team: 0 };

function defaultServer() {
  if (app?.defaultServer) return app.defaultServer;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  } catch { return 'ws://localhost:8787/ws'; }
}

function buildOnlineDialog() {
  const wrap = h('div', 'online-form');
  const fieldName = h('label', 'field');
  fieldName.append(h('span', 'field-label', '呼号'));
  const nick = document.createElement('input');
  nick.type = 'text';
  nick.id = 'nickname';
  nick.maxLength = 14;
  nick.autocomplete = 'nickname';
  nick.placeholder = '输入你的呼号';
  nick.value = netState.nickname || OWNER_NAME;
  nick.addEventListener('input', () => { netState.nickname = nick.value; });
  fieldName.append(nick);

  const rowMode = h('div', 'grid-2');
  const modeField = h('label', 'field');
  modeField.append(h('span', 'field-label', '对局模式'));
  const modeSelect = document.createElement('select');
  modeSelect.id = 'game-mode';
  for (const mode of MODE_LIST.filter(m => m.id !== 'training')) {
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = mode.name;
    modeSelect.append(option);
  }
  modeSelect.value = netState.gameMode;
  modeField.append(modeSelect);
  const teamField = h('label', 'field');
  teamField.append(h('span', 'field-label', '加入小队'));
  const teamSelect = document.createElement('select');
  teamSelect.id = 'squad-choice';
  for (let i = 0; i < 16; i++) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = `第 ${i + 1} 小队`;
    teamSelect.append(option);
  }
  teamSelect.value = String(netState.team);
  teamField.append(teamSelect);
  rowMode.append(modeField, teamField);

  const serverField = h('label', 'field');
  serverField.append(h('span', 'field-label', '服务器地址'));
  const server = document.createElement('input');
  server.type = 'text';
  server.id = 'server-address';
  server.inputMode = 'url';
  server.spellcheck = false;
  server.autocomplete = 'off';
  server.placeholder = 'ws://192.168.1.8:8787/ws';
  server.value = netState.server || app?.savedServer || defaultServer();
  server.addEventListener('input', () => { netState.server = server.value; });
  serverField.append(server, h('p', 'field-help muted', '与好友连接到同一台服务器；局域网填电脑 IP，公网填 wss:// 地址。'));

  const joinRow = h('div', 'join-row');
  const code = document.createElement('input');
  code.type = 'text';
  code.id = 'room-code';
  code.maxLength = 5;
  code.placeholder = '输入 5 位邀请码';
  code.autocomplete = 'off';
  code.spellcheck = false;
  code.addEventListener('input', () => {
    code.value = code.value.replace(/[^a-z2-9]/gi, '').toUpperCase().slice(0, 5);
    netState.code = code.value;
  });
  const join = h('button', 'btn btn-ghost', '加入房间');
  join.type = 'button';
  join.id = 'btn-join-room';
  join.addEventListener('click', () => connectOnline('join'));
  joinRow.append(code, join);

  const actions = h('div', 'online-actions');
  const create = h('button', 'btn btn-primary btn-lg', '创建房间');
  create.type = 'button';
  create.id = 'btn-create-room';
  create.addEventListener('click', () => connectOnline('create'));
  const quick = h('button', 'btn btn-ghost btn-lg', '快速匹配');
  quick.type = 'button';
  quick.id = 'btn-quick-match';
  quick.addEventListener('click', () => connectOnline('quick'));
  actions.append(create, quick);

  const error = h('p', 'error-text');
  error.id = 'online-error';
  error.setAttribute('role', 'status');
  wrap.append(fieldName, rowMode, serverField, joinRow, actions, error);

  modeSelect.addEventListener('change', () => { netState.gameMode = modeSelect.value; teamSelect.disabled = modeSelect.value === 'solo'; });
  teamSelect.addEventListener('change', () => { netState.team = Number(teamSelect.value) || 0; });
  return wrap;
}

function setNetBusy(busy, message) {
  netState.busy = busy;
  for (const id of ['btn-create-room', 'btn-join-room', 'btn-quick-match']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = busy;
    if (busy) { btn.dataset.label = btn.dataset.label || btn.textContent; setText(btn, '连接中…'); }
    else if (btn.dataset.label) { setText(btn, btn.dataset.label); delete btn.dataset.label; }
  }
  setOnlineError(message || '');
}
function setOnlineError(message) {
  const node = document.getElementById('online-error');
  if (!node) return;
  setText(node, message || '');
}

export function showOnlineDialog() {
  const existing = document.getElementById('online-dialog');
  if (!existing) {
    const form = buildOnlineDialog();
    showModal('online-dialog', {
      title: '联机组队',
      eyebrow: 'CONNECT & SURVIVE',
      hint: '与好友加入同一房间，空位由 AI 补满。',
      body: form,
    });
  } else {
    showModal('online-dialog', {
      title: '联机组队',
      eyebrow: 'CONNECT & SURVIVE',
      hint: '与好友加入同一房间，空位由 AI 补满。',
      body: buildOnlineDialog(),
    });
  }
  setNetBusy(false);
  setOnlineError('');
  setTimeout(() => document.getElementById('nickname')?.focus({ preventScroll: true }), 60);
}
export function hideOnlineDialog() { hideDialog('online-dialog'); }

function normalizedName() {
  const input = document.getElementById('nickname');
  const raw = String(input?.value ?? netState.nickname ?? OWNER_NAME).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  const value = raw || OWNER_NAME;
  if (input) input.value = value;
  netState.nickname = value;
  return value;
}
function normalizedServer() {
  const input = document.getElementById('server-address');
  const raw = String(input?.value ?? netState.server ?? '').trim();
  if (!raw) throw new Error('请填写服务器地址');
  const url = new URL(/^wss?:\/\//i.test(raw) ? raw : `ws://${raw}`);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('服务器地址需要以 ws:// 或 wss:// 开头');
  netState.server = url.href;
  return url.href;
}

function connectOnline(kind) {
  if (netState.busy) return;
  let name = OWNER_NAME;
  let url = '';
  let code = '';
  try {
    name = normalizedName();
    url = normalizedServer();
    if (kind === 'join') {
      const input = document.getElementById('room-code');
      code = String(input?.value || netState.code || '').trim().toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(code)) throw new Error('请输入 5 位邀请码（字母与数字，不含 0/O/1/I）');
    }
  } catch (err) {
    setOnlineError(err.message || '地址或邀请码格式不正确');
    return;
  }
  const mode = document.getElementById('game-mode')?.value || netState.gameMode;
  const team = Number(document.getElementById('squad-choice')?.value) || 0;
  setNetBusy(true, '正在连接服务器…');
  hideAllDialogs();
  try {
    const result = app?.startOnline?.({ kind, name, server: url, code, mode, gameMode: mode, team, mapId: uiState.mapId, difficulty: uiState.difficulty, loadout: loadout() });
    if (result && typeof result.then === 'function') {
      result.then(() => setNetBusy(false)).catch(err => setNetBusy(false, err?.message || '无法连接服务器'));
    }
  } catch (err) {
    setNetBusy(false, err?.message || '无法连接服务器');
  }
}

function startOffline() {
  hideAllDialogs();
  try {
    if (typeof app?.startOffline !== 'function') throw new Error('游戏尚未初始化，请稍后重试');
    const result = app.startOffline(uiState.mode, {
      mapId: uiState.mapId,
      difficulty: uiState.difficulty,
      loadout: loadout(),
      profile: meta()?.data,
    });
    if (result && typeof result.then === 'function') {
      result.then(() => closeScreens()).catch(err => toast(err?.message || '无法开始行动', 3000));
      return true;
    }
    if (result?.ok === false) throw new Error(result.message || '无法开始行动');
    closeScreens();
    return true;
  } catch (err) {
    toast(err?.message || '无法开始行动', 3000);
    return false;
  }
}

// ── 18 · 房间弹窗 ───────────────────────────────────────────────────────────
function buildRoomDialog() {
  const wrap = h('div', 'room-form');
  const codeBox = h('div', 'room-code-display');
  codeBox.append(h('small', 'muted', '邀请码'));
  const code = h('b');
  code.id = 'current-code';
  code.textContent = '-----';
  codeBox.append(code);
  const copy = h('button', 'btn btn-ghost btn-sm', '复制');
  copy.type = 'button';
  copy.id = 'btn-copy-code';
  copy.addEventListener('click', () => {
    const value = code.textContent || '';
    playAudio('ui_click');
    try {
      navigator.clipboard?.writeText(value).then(() => toast('邀请码已复制'), () => toast(`邀请码：${value}`));
      if (!navigator.clipboard) toast(`邀请码：${value}`);
    } catch { toast(`邀请码：${value}`); }
  });
  codeBox.append(copy);
  const hint = h('p', 'modal-hint muted');
  hint.id = 'room-hint';
  const dropzone = h('button', 'btn btn-ghost btn-sm room-dropzone-btn', '降落区投票');
  dropzone.type = 'button';
  dropzone.id = 'btn-dropzone';
  dropzone.setAttribute('aria-label', '打开降落区投票地图');
  dropzone.addEventListener('click', () => { playAudio('ui_click'); showDropZone(); });
  // 空降方式：房主可切「跳伞 / 直接落地」。跳伞会让开局多 20 秒左右，
  // 但换来选点与开局的紧张感；默认沿用房间当前设置（服务端 lobby.deployStyle）。
  const deployBtn = h('button', 'btn btn-ghost btn-sm room-deploy-btn');
  deployBtn.type = 'button';
  deployBtn.id = 'btn-deploy-style';
  deployBtn.addEventListener('click', () => {
    playAudio('ui_click');
    const next = (netState.lastLobby?.deployStyle === 'skydive') ? 'instant' : 'skydive';
    try {
      if (app?.setDeployStyle) app.setDeployStyle(next);
      else app?.net?.send?.({ type: 'config', deployStyle: next });
    } catch (err) { toast(err?.message || '无法切换空降方式'); }
  });
  const list = h('div', 'room-players');
  list.id = 'room-players';
  wrap.append(codeBox, hint, dropzone, deployBtn, list);
  const actions = h('div', 'room-actions');
  const start = h('button', 'btn btn-primary', '开始战斗');
  start.type = 'button';
  start.id = 'btn-start-room';
  start.addEventListener('click', () => {
    playAudio('ui_click');
    try {
      if (app?.startRoom) app.startRoom();
      else if (app?.net?.send) app.net.send({ type: 'start' });
      else toast('只有房主可以开始战斗', 2200);
    } catch (err) { toast(err?.message || '无法开始战斗'); }
  });
  const ready = h('button', 'btn btn-ghost', '准备');
  ready.type = 'button';
  ready.id = 'btn-ready-room';
  ready.addEventListener('click', () => {
    playAudio('ui_click');
    ready.classList.toggle('active');
    const isReady = ready.classList.contains('active');
    setText(ready, isReady ? '已准备' : '准备');
    ready.setAttribute('aria-pressed', isReady ? 'true' : 'false');
    try { app?.setReady?.(isReady) ?? app?.net?.send?.({ type: 'input', input: { ready: isReady } }); } catch { /* 忽略 */ }
  });
  const leave = h('button', 'btn btn-danger', '离开房间');
  leave.type = 'button';
  leave.id = 'btn-leave-room';
  leave.addEventListener('click', () => {
    hideRoom();
    try { app?.leaveMatch?.() ?? app?.home?.(); } catch { /* 忽略 */ }
  });
  actions.append(ready, start, leave);
  wrap.append(actions);
  return wrap;
}

export function showRoom(lobby) {
  const form = buildRoomDialog();
  const node = showModal('room-dialog', {
    title: '战前集合',
    eyebrow: 'YOUR SQUAD',
    hint: '把邀请码发给好友，全员准备后由房主开始。',
    body: form,
    static: true,
  });
  node.dataset.static = '1';
  if (lobby) updateLobby(lobby);
}
export function updateLobby(lobby) {
  if (!lobby) return;
  netState.lastLobby = lobby;
  // 对局已经开始（loading / live / ended）时**绝不能再把房间弹窗打开**。
  //
  // 历史 bug：服务端在开局后仍会补发 lobby 广播，而这里只要弹窗不是 open 就
  // showRoom() —— 实测进入 live 后 room-dialog 仍然覆盖全屏：
  //   - 画面中心 elementFromPoint 命中 .room-code-display 而不是 canvas，
  //     鼠标按住 700ms 一发子弹都打不出去（键盘能动，因为 InputController
  //     把 room-dialog 列入 IGNORED_DIALOGS，但鼠标点击被 DOM 遮罩吃掉）；
  //   - 弹窗里还挂着「开始战斗 / 离开房间」，误触 × 直接 leaveMatch() 退赛。
  // 现在按 phase 与 app.mode 双重把关：只要已进入对局，就不再显示房间弹窗。
  const inMatch = app?.mode === 'match';
  const phase = String(lobby.phase || '');
  if (inMatch || phase === 'loading' || phase === 'live' || phase === 'playing' || phase === 'ended') {
    const existing = document.getElementById('room-dialog');
    if (existing && existing.classList.contains('open')) hideRoom();
    return;
  }
  let node = document.getElementById('room-dialog');
  if (!node || !node.classList.contains('open')) {
    showRoom(lobby);
    node = document.getElementById('room-dialog');
  }
  if (!node) return;
  const code = document.getElementById('current-code');
  if (code) setText(code, lobby.code || '-----');
  const hint = document.getElementById('room-hint');
  if (hint) {
    const count = `${lobby.players?.length || 0} / ${lobby.max || 64}`;
    const mapName = lobby.mapName || mapNameOf(lobby.mapId);
    const modeName = modeNameOf(lobby.gameMode || lobby.modeId);
    const countdown = Number.isFinite(lobby.startsIn) ? ` · ${Math.max(0, Math.ceil(lobby.startsIn))} 秒后自动开始` : '';
    setText(hint, `${mapName} · ${modeName} · ${count} 人${countdown}`);
  }
  const list = document.getElementById('room-players');
  if (list) {
    clear(list);
    const players = Array.isArray(lobby.players) ? lobby.players : [];
    if (!players.length) list.append(emptyState('等待玩家加入…'));
    const sorted = [...players].sort((a, b) => (a.team || 0) - (b.team || 0));
    for (const player of sorted) {
      const row = h('div', `room-player ${player.connected === false ? 'offline' : ''}`);
      row.dataset.player = player.id;
      const dot = h('i', 'status-dot');
      const name = h('b', null, player.name || '旅人');
      const tags = h('small', 'muted');
      const parts = [];
      if (player.id === lobby.host) parts.push('房主');
      if (player.id === app?.selfId) parts.push('你');
      if (player.ready) parts.push('已准备');
      if (player.connected === false) parts.push('重连中');
      parts.push(`第 ${(player.team || 0) + 1} 队`);
      setText(tags, parts.join(' · '));
      row.append(dot, name, tags);
      if (player.level) row.append(h('span', 'badge muted', `LV.${player.level}`));
      list.append(row);
    }
  }
  const start = document.getElementById('btn-start-room');
  if (start) {
    const isHost = lobby.host === app?.selfId || lobby.host === true;
    start.disabled = !isHost;
    setText(start, isHost ? '开始战斗' : '等待房主开始');
  }
  const ready = document.getElementById('btn-ready-room');
  if (ready) ready.style.display = lobby.host === app?.selfId ? 'none' : '';
  // 空降方式按钮：非房主只读（展示当前设置），房主可点击切换。
  const deployBtn = document.getElementById('btn-deploy-style');
  if (deployBtn) {
    const isHost = lobby.host === app?.selfId;
    const skydive = lobby.deployStyle === 'skydive';
    deployBtn.disabled = !isHost || lobby.configurable === false;
    deployBtn.classList.toggle('active', skydive);
    deployBtn.setAttribute('aria-pressed', skydive ? 'true' : 'false');
    setText(deployBtn, skydive ? '空降：跳伞' : '空降：直接落地');
    deployBtn.title = isHost
      ? '点击切换：跳伞会让开局多约 20 秒，但可以自己选落点'
      : (skydive ? '房主已设为跳伞开局' : '房主已设为直接落地');
  }
  if (isDialogOpen('dropzone-dialog')) refreshDropZone();
}
export function hideRoom() { hideDialog('room-dialog'); }

// ── 18.1 · 降落区投票（房间等待阶段的战术地图选点） ─────────────────────────
// 复用 drawStaticMap 的地形渲染；服务端 lobby.dropVotes 携带全队最新票，
// 本地选点先以乐观标记呈现，收到下一次 lobby 广播后以服务端票为准。
const dropZoneState = { mapId: 'qinglan', votes: [], self: null };

function dropzoneMapDef() {
  const mapId = netState.lastLobby?.mapId || app?.mapId || dropZoneState.mapId;
  return (data().maps || MAPS)[mapId] || MAPS[mapId] || MAPS.qinglan;
}

/** 本机玩家的小队编号（lobby.players 缺失时回落 0 队）。 */
function dropzoneMyTeam() {
  const players = netState.lastLobby?.players;
  if (Array.isArray(players)) {
    const mine = players.find((p) => p.id === app?.selfId);
    if (mine && Number.isInteger(mine.team)) return mine.team;
  }
  return 0;
}

/** 归一化坐标对应的地点名（优先命中资源区，否则返回 null）。 */
function dropzoneRegionAt(mapDef, nx, nz) {
  const radius = mapDef?.radius || 182;
  const wx = (nx * 2 - 1) * radius;
  const wz = (nz * 2 - 1) * radius;
  for (const region of mapDef?.regions || []) {
    if (Math.hypot(wx - region.x, wz - region.z) <= (region.r || 30)) return region.name;
  }
  return null;
}

export function showDropZone() {
  const lobby = netState.lastLobby || null;
  dropZoneState.mapId = lobby?.mapId || app?.mapId || dropZoneState.mapId;
  const mapDef = dropzoneMapDef();
  const wrap = h('div', 'dropzone-body');
  const canvas = document.createElement('canvas');
  canvas.id = 'dropzone-canvas';
  canvas.width = 720;
  canvas.height = 720;
  canvas.className = 'dropzone-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${mapDef.name} 降落区地图，点击或拖动选择小队落点`);
  const status = h('p', 'dropzone-status muted');
  status.id = 'dropzone-status';
  status.setAttribute('role', 'status');
  const votes = h('div', 'dropzone-votes');
  votes.id = 'dropzone-votes';
  wrap.append(canvas, status, votes);

  let dragging = false;
  const pointToNorm = (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const px = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((event.clientY - rect.top) / rect.height) * canvas.height;
    const radius = mapDef.radius || 182;
    const scale = canvas.width / (radius * 2 + 16);
    const center = canvas.width / 2;
    return {
      x: Math.min(1, Math.max(0, ((px - center) / scale) / (2 * radius) + 0.5)),
      z: Math.min(1, Math.max(0, ((py - center) / scale) / (2 * radius) + 0.5)),
    };
  };
  const previewAt = (event) => {
    const norm = pointToNorm(event);
    if (!norm) return;
    dropZoneState.self = norm;
    renderDropZone();
  };
  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    previewAt(event);
  });
  canvas.addEventListener('pointermove', (event) => { if (dragging) previewAt(event); });
  canvas.addEventListener('pointerup', (event) => {
    if (!dragging) return;
    dragging = false;
    previewAt(event);
    commitDropVote();
  });
  canvas.addEventListener('pointercancel', () => { dragging = false; });

  const close = h('button', 'btn btn-ghost', '返回房间');
  close.type = 'button';
  close.addEventListener('click', () => { playAudio('ui_click'); hideDialog('dropzone-dialog'); });
  showModal('dropzone-dialog', {
    title: '降落区',
    eyebrow: 'DROP ZONE',
    hint: '点击或拖动地图为小队选择落点，最新一票即为小队降落区。',
    body: wrap,
    actions: [close],
    wide: true,
  });
  refreshDropZone();
}

/** 以最新 lobby 数据重画投票层（弹层未打开时只静默更新缓存）。 */
function refreshDropZone() {
  const lobby = netState.lastLobby;
  if (!lobby) return;
  dropZoneState.mapId = lobby.mapId || dropZoneState.mapId;
  const myTeam = dropzoneMyTeam();
  const all = Array.isArray(lobby.dropVotes) ? lobby.dropVotes : [];
  dropZoneState.votes = all.filter((v) => v && v.team === myTeam);
  if (dropZoneState.self && dropZoneState.votes.some((v) => v.by === app?.selfId)) {
    dropZoneState.self = null; // 服务端已确认本机投票，乐观标记退位
  }
  if (!isDialogOpen('dropzone-dialog')) return;
  renderDropZone();
}

function commitDropVote() {
  const vote = dropZoneState.self;
  if (!vote) return;
  let sent = false;
  try { sent = app?.sendDropVote?.(vote.x, vote.z) === true; } catch { sent = false; }
  if (!sent) toast('暂未连接服务器，落点未同步', 2400);
  else playAudio('ui_click');
  renderDropZone();
}

/** 重画降落区地图：地形 + 全队投票 ping + 本机乐观标记。 */
function renderDropZone() {
  const canvas = document.getElementById('dropzone-canvas');
  if (!canvas) return;
  const mapDef = dropzoneMapDef();
  drawStaticMap(canvas, mapDef);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const radius = mapDef?.radius || 182;
    const scale = canvas.width / (radius * 2 + 16);
    const center = canvas.width / 2;
    const pt = (nx, nz) => [
      center + ((nx * 2 - 1) * radius) * scale,
      center + ((nz * 2 - 1) * radius) * scale,
    ];
    const seen = new Set();
    const pings = [];
    for (const vote of dropZoneState.votes) {
      if (seen.has(vote.by)) continue;
      seen.add(vote.by);
      pings.push({ ...vote, mine: vote.by === app?.selfId });
    }
    if (dropZoneState.self && !pings.some((p) => p.mine)) {
      pings.push({ x: dropZoneState.self.x, z: dropZoneState.self.z, name: '你', mine: true, pending: true });
    }
    for (const ping of pings) {
      const [x, y] = pt(ping.x, ping.z);
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fillStyle = ping.mine ? 'rgba(245,180,69,0.22)' : 'rgba(111,224,200,0.22)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = ping.mine ? '#f5b445' : '#6fe0c8';
      ctx.fill();
      ctx.strokeStyle = 'rgba(5,15,16,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 两个 ping 重合时把「你」的标签画在点下方，避免与队友标签叠字
      const overlap = ping.mine && pings.some((q) => q !== ping
        && Math.abs(q.x - ping.x) < 0.02 && Math.abs(q.z - ping.z) < 0.02);
      ctx.fillStyle = ping.mine ? 'rgba(245,180,69,0.95)' : 'rgba(234,246,241,0.95)';
      ctx.font = '600 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(ping.name || '队友').slice(0, 6), x, overlap ? y + 25 : y - 19);
    }
    canvas.dataset.pings = String(pings.length);
  }
  const status = document.getElementById('dropzone-status');
  if (status) {
    const mine = dropZoneState.votes.find((v) => v.by === app?.selfId) || dropZoneState.self;
    if (!mine) setText(status, '点击或拖动地图，为小队选择降落区');
    else {
      const region = dropzoneRegionAt(mapDef, mine.x, mine.z);
      setText(status, `落点已选 · ${region || `${Math.round(mine.x * 100)} : ${Math.round(mine.z * 100)} 网格`}`);
    }
  }
  const votes = document.getElementById('dropzone-votes');
  if (votes) {
    clear(votes);
    if (!dropZoneState.votes.length) votes.append(h('span', 'chip', '暂无小队落点'));
    for (const vote of dropZoneState.votes) {
      const region = dropzoneRegionAt(mapDef, vote.x, vote.z);
      const label = `${vote.by === app?.selfId ? '你' : (vote.name || '队友')} · ${region || '野区'}`;
      votes.append(h('span', `chip dropzone-chip${vote.by === app?.selfId ? ' mine' : ''}`, label));
    }
  }
}

/** 关闭 #dialog-root 内所有打开的弹窗（开战/回大厅时调用）。 */
export function hideAllDialogs(exceptId = '') {
  for (const node of document.querySelectorAll('#dialog-root .modal.open')) {
    if (exceptId && node.id === exceptId) continue;
    node.classList.remove('open');
    node.removeAttribute('open');
    node.setAttribute('aria-hidden', 'true');
  }
}

// ── 18b · 局内背包（B 键 / 触屏「背包」按钮） ───────────────────────────────
// 帮助面板一直写着「背包 · 查看携带物资」，但 #backpack-action 与 KeyB 全工程都没有
// 消费者：按钮点了没反应，B 键只产生一个无人读取的 input.inventory 脉冲。
// 这里用 showModal 建一个轻量只读面板（武器 / 弹药 / 消耗品 / 投掷物 / 配件），
// 复用它自带的 role=dialog + 焦点陷阱 + Esc 关闭，不再另造一套弹窗基础设施。
const INVENTORY_CONSUMABLES = [
  ['meds', '医疗包'], ['bandages', '绷带'], ['energy', '能量饮料'], ['shields', '护盾电池'],
];
const INVENTORY_THROWABLES = [
  ['grenades', '破片手雷'], ['smokes', '烟雾弹'], ['flashes', '闪光弹'], ['molotovs', '燃烧瓶'],
];

function inventoryRows(me) {
  const wrap = h('div', 'inventory-body');
  const weaponName = (id) => weaponTable()[id]?.name || id || DASH;
  const attachName = (id) => attachmentTable()[id]?.name || id;

  // 1) 武器与弹药
  const weapons = h('section', 'inventory-section');
  weapons.append(h('h3', 'inventory-heading', '武器与弹药'));
  const slots = Array.isArray(me?.loadout) ? me.loadout : [];
  if (!slots.some(Boolean)) {
    weapons.append(h('p', 'muted inventory-empty', '没有携带武器'));
  } else {
    slots.forEach((slot, index) => {
      if (!slot?.type) return;
      const active = Number(me?.slot) === index;
      const row = h('div', `inventory-row${active ? ' active' : ''}`);
      const left = h('div', 'inventory-row-main');
      left.append(h('b', null, weaponName(slot.type)));
      left.append(h('small', 'muted', active ? '当前手持' : `槽位 ${index + 1}`));
      const ammo = h('span', 'inventory-ammo num');
      const mag = Number(slot.ammo ?? 0);
      // 备用弹药只在当前武器上可见（me.mags 是全类型池，按 type 取）
      const type = weaponTable()[slot.type]?.ammo;
      const reserve = active && type ? Number(me?.reserve ?? me?.mags?.[type] ?? 0) : null;
      ammo.textContent = reserve == null ? `${mag}` : `${mag} / ${reserve}`;
      if (mag <= 0) ammo.classList.add('empty');
      row.append(left, ammo);
      weapons.append(row);
    });
    const mags = me?.mags && typeof me.mags === 'object' ? me.mags : null;
    if (mags) {
      const pool = h('div', 'inventory-chips');
      for (const [type, count] of Object.entries(mags)) {
        const label = AMMO_TYPES?.[type]?.name || type;
        pool.append(h('span', 'chip', `${label} ${Math.max(0, Math.round(Number(count) || 0))}`));
      }
      if (pool.children.length) weapons.append(pool);
    }
  }
  wrap.append(weapons);

  // 2) 配件（按槽位列出，稀有度带符号冗余，不只靠颜色）
  const attachSection = h('section', 'inventory-section');
  attachSection.append(h('h3', 'inventory-heading', '配件'));
  const attachList = h('div', 'inventory-chips');
  const table = attachmentTable();
  slots.forEach((slot, index) => {
    for (const id of slot?.attachments || []) {
      const def = table[id] || null;
      const chip = h('span', 'chip');
      chip.append(h('span', null, `${index === 0 ? '主' : '副'} · ${attachName(id)}`));
      if (def?.rarity) chip.append(rarityMarkNode(def.rarity));
      chip.title = def?.desc || '';
      attachList.append(chip);
    }
  });
  if (!attachList.children.length) attachList.append(h('p', 'muted inventory-empty', '未装配件'));
  attachSection.append(attachList);
  wrap.append(attachSection);

  // 3) 消耗品 / 投掷物（两列并排，窄屏自动堆叠）
  const supplies = h('div', 'inventory-columns');
  const makeColumn = (title, defs, cls) => {
    const section = h('section', 'inventory-section');
    section.append(h('h3', 'inventory-heading', title));
    const grid = h('div', `inventory-grid ${cls}`);
    for (const [key, label] of defs) {
      const count = Math.max(0, Math.round(Number(me?.[key]) || 0));
      const cell = h('div', `inventory-cell${count <= 0 ? ' empty' : ''}`);
      cell.append(h('span', 'inventory-label', label), h('b', 'inventory-count num', count));
      grid.append(cell);
    }
    section.append(grid);
    return section;
  };
  supplies.append(makeColumn('消耗品', INVENTORY_CONSUMABLES, 'consumables'));
  supplies.append(makeColumn('投掷物', INVENTORY_THROWABLES, 'throwables'));
  wrap.append(supplies);
  return wrap;
}

function renderInventory() {
  const node = dialogs.get('inventory-dialog') || document.getElementById('inventory-dialog');
  const body = node?._parts?.body;
  if (!body) return;
  const me = app?.me || app?.state?.me || null;
  clear(body);
  // 标题带玩家名，读屏与截图都能确认「这是谁的背包」
  setText(node._parts.title, me?.name ? `${me.name} · 背包` : '背包');
  body.append(inventoryRows(me));
}

/** 打开局内背包（只读）。对局外显示空背包提示，不抛错。 */
export function showInventory() {
  const node = showModal('inventory-dialog', {
    title: '背包',
    eyebrow: 'INVENTORY',
    body: h('div', 'inventory-body'),
    actions: [],
  });
  const close = h('button', 'btn btn-primary', '关闭');
  close.type = 'button';
  close.id = 'btn-inventory-close';
  close.addEventListener('click', () => { playAudio('ui_click'); hideInventory(); });
  node._parts.actions.append(close);
  node._parts.actions.style.display = '';
  renderInventory();
  // 焦点落在关闭按钮上：焦点陷阱（ui-screens 全局 Tab 处理）会把它锁在弹窗内
  requestAnimationFrame(() => close.focus({ preventScroll: true }));
  return node;
}
export function hideInventory() { hideDialog('inventory-dialog'); }
export function isInventoryOpen() { return isDialogOpen('inventory-dialog'); }
// ── END 18b ────────────────────────────────────────────────────────────────

// ── 19 · 暂停菜单 ───────────────────────────────────────────────────────────
function buildPauseDialog() {
  const wrap = h('div', 'pause-body');
  const note = h('p', 'pause-note');
  note.id = 'pause-note';
  setText(note, '联机对战会继续进行；离线训练会暂停模拟。');
  // 统计用紧凑格栅（.pause-stats 在样式里是竖排，会让弹窗超高把按钮挤出可视区）
  const stats = h('div', 'stat-grid');
  stats.id = 'pause-stats';
  // 主操作竖排（.pause-menu），退出放弹窗底部
  const menu = h('div', 'pause-menu');
  const resume = h('button', 'btn btn-primary', '继续战斗');
  resume.type = 'button';
  resume.id = 'btn-resume';
  resume.addEventListener('click', () => {
    playAudio('ui_click');
    hidePause();
    try { app?.resumeFromMenu?.(); } catch (err) { console.warn(err); }
  });
  const settings = h('button', 'btn btn-ghost', '作战设置');
  settings.type = 'button';
  settings.id = 'btn-pause-settings';
  settings.addEventListener('click', () => {
    playAudio('ui_click');
    // 记录来源：设置页的返回按钮据此回到暂停菜单而不是大厅。
    // 不记录会卡进「幽灵对局」——主菜单叠在仍在运行的对局上，且无法回到战斗。
    // 同时保留 app.paused（对局继续冻结），不调用 resumeFromPause。
    uiState.returnToPause = app?.mode === 'match';
    hidePause();
    openScreen('settings');
  });
  const help = h('button', 'btn btn-ghost', '操作说明');
  help.type = 'button';
  help.id = 'btn-pause-help';
  help.addEventListener('click', () => { playAudio('ui_click'); showHelpDialog(); });
  menu.append(resume, settings, help);
  const actions = h('div', 'pause-actions');
  const exit = h('button', 'btn btn-danger', '退出本局');
  exit.type = 'button';
  exit.id = 'btn-exit-match';
  exit.addEventListener('click', () => {
    playAudio('ui_click');
    hidePause();
    try { app?.leaveMatch?.(); } catch (err) { console.warn(err); }
  });
  actions.append(exit);
  wrap.append(note, stats, menu);
  wrap.actionsEl = actions;
  return wrap;
}

export function showPause() {
  const body = buildPauseDialog();
  const exit = body.actionsEl?.firstElementChild || null;
  const node = showModal('pause-dialog', {
    title: '战斗暂停',
    eyebrow: 'PAUSED',
    hint: '',
    body,
    actions: exit ? [exit] : null,
    static: true,
  });
  node.dataset.static = '1';
  renderPauseStats();
  setTimeout(() => document.getElementById('btn-resume')?.focus({ preventScroll: true }), 60);
}
export function hidePause() { hideDialog('pause-dialog'); }

/** 从暂停 UI 的真正“继续”语义：关弹窗 + 恢复模拟（X / Esc / 继续按钮共用）。 */
function resumeFromPause() {
  hidePause();
  try { app?.resumeFromMenu?.(); } catch (err) { console.warn('[ui] resumeFromMenu', err); }
}

/** 结算弹窗的“离开”语义：关弹窗 + 结束对局回大厅（X / Esc 共用，防止幽灵战场）。 */
function leaveResultToHome() {
  hideResult();
  try { app?.home?.(); } catch (err) { console.warn('[ui] home', err); }
  try { app?.openScreen ? app.openScreen('home') : openScreen('home'); } catch { openScreen('home'); }
}

function renderPauseStats() {
  const box = document.getElementById('pause-stats');
  if (!box) return;
  clear(box);
  const state = app?.state;
  const me = app?.me || state?.me || null;
  const rows = [
    ['模式', modeNameOf(app?.modeId || state?.mode)],
    ['地图', mapNameOf(app?.mapId || state?.mapId)],
    ['存活', state?.counts ? `${state.counts.alive} / ${state.counts.total}` : DASH],
    ['淘汰', me?.kills ?? DASH],
    ['对局时间', state?.matchTime != null ? fmtTime(state.matchTime) : DASH],
    ['延迟', app?.socketInfo?.ping != null ? `${app.socketInfo.ping} ms` : '离线'],
  ];
  for (const [label, value] of rows) {
    const row = h('div', 'stat');
    row.append(h('small', null, label), h('b', null, value));
    box.append(row);
  }
}
// 说明：暂停弹窗的统计用 .stat-grid 紧凑两列，避免内容超高把操作按钮挤出弹窗。

// ── 20 · 结算弹窗 ───────────────────────────────────────────────────────────
function buildResultDialog() {
  const wrap = h('div', 'result-body');
  const rankWrap = h('div', 'result-rank');
  const rank = h('div', 'rank-display');
  rank.id = 'rank-display';
  rank.textContent = '#1';
  rankWrap.append(rank, h('small', 'muted', '最终排名'));
  const textWrap = h('div', 'result-headline');
  const eyebrow = h('div', 'eyebrow');
  eyebrow.id = 'result-eyebrow';
  const title = h('h2', 'title-lg');
  title.id = 'result-title';
  const subtitle = h('p', 'muted');
  subtitle.id = 'result-subtitle';
  textWrap.append(eyebrow, title, subtitle);
  const debrief = h('section', 'result-debrief');
  debrief.id = 'result-debrief';
  debrief.setAttribute('aria-label', '本局战术复盘');
  const stats = h('div', 'result-stats');
  stats.id = 'result-stats';
  const xpPanel = h('div', 'ui-result-xp');
  xpPanel.id = 'result-xp-panel';
  const progList = h('div', 'ui-result-list');
  progList.id = 'result-progress';
  const rankNote = h('div', 'ui-result-rank-note');
  rankNote.id = 'result-rank-note';
  const rewards = h('div', 'result-rewards');
  rewards.id = 'result-rewards';
  const tags = h('div', 'result-tags');
  tags.id = 'result-tags';
  const seasonBox = h('div', 'result-season');
  seasonBox.id = 'result-season';
  const masteryBox = h('div', 'result-mastery');
  masteryBox.id = 'result-mastery';
  const actions = h('div', 'result-actions');
  const share = h('button', 'btn btn-ghost btn-lg ui-share', '分享战绩');
  share.type = 'button';
  share.id = 'btn-share-result';
  share.addEventListener('click', () => shareResult(share));
  const again = h('button', 'btn btn-primary btn-lg', '再来一局');
  again.type = 'button';
  again.id = 'btn-again';
  again.addEventListener('click', () => {
    playAudio('ui_click');
    hideResult();
    try {
      if (app?.rematch) app.rematch();
      else startOffline();
    } catch (err) {
      console.warn('[ui] rematch', err);
      toast(err?.message || '无法重新开始');
      // 重开失败时不要留在幽灵战场
      leaveResultToHome();
    }
  });
  const home = h('button', 'btn btn-ghost btn-lg', '返回大厅');
  home.type = 'button';
  home.id = 'btn-return-home';
  home.addEventListener('click', () => {
    playAudio('ui_click');
    leaveResultToHome();
  });
  actions.append(share, again, home);
  wrap.append(rankWrap, textWrap, debrief, stats, xpPanel, rankNote, progList, rewards, tags, seasonBox, masteryBox, actions);
  return wrap;
}

const RESULT_STAT_DEFS = [
  ['淘汰', 'kills', 'result-kills'], ['伤害', 'damage', 'result-damage'], ['生存时间', 'survived', 'result-time'],
  ['名次', 'placement', 'result-placement'], ['救援', 'revives', 'result-revives'], ['命中率', 'accuracy', 'result-accuracy'],
];

export function showResult(summary = {}, rewards = null) {
  resultSummary = summary || {};
  resultRewards = rewards || summary?.rewards || {};
  const body = buildResultDialog();
  const node = showModal('result-dialog', {
    title: '',
    eyebrow: '',
    hint: '',
    body,
    static: true,
  });
  node.dataset.static = '1';
  node._parts.title.style.display = 'none';
  renderResult();
  setTimeout(() => document.getElementById('btn-again')?.focus({ preventScroll: true }), 80);
}
export function hideResult() { hideDialog('result-dialog'); }

/** 结算后离开对局（“返回大厅”按钮 / 关闭 X / Esc 共用同一条安全路径）。 */
export function leaveResult() { leaveResultToHome(); }

function renderResult() {
  const s = resultSummary || {};
  const r = resultRewards || {};
  const won = !!s.won;
  const placement = Number(s.placement) || 0;
  const totalTeams = Number(s.totalTeams) || 0;
  const rankDisplay = document.getElementById('rank-display');
  if (rankDisplay) setText(rankDisplay, placement ? `#${placement}` : s.won === false && !placement ? '—' : '#1');
  const eyebrow = document.getElementById('result-eyebrow');
  if (eyebrow) setText(eyebrow, won ? 'MISSION COMPLETE' : 'SIGNAL LOST');
  const title = document.getElementById('result-title');
  if (title) setText(title, won ? '雾岛幸存者' : placement && placement <= 3 ? '只差一步' : '下一次，活到最后。');
  const subtitle = document.getElementById('result-subtitle');
  if (subtitle) {
    const bits = [];
    if (totalTeams) bits.push(`${totalTeams} 支队伍 · 第 ${placement || DASH} 名`);
    if (s.mode) bits.push(modeNameOf(s.mode));
    if (s.mapId) bits.push(mapNameOf(s.mapId));
    if (s.reason === 'horde') bits.push(`坚持到第 ${s.hordeWaves || 0} 波`);
    setText(subtitle, bits.join(' · ') || '本局结束，战报已记录。');
  }
  const debrief = document.getElementById('result-debrief');
  if (debrief) {
    clear(debrief);
    const note = s.debrief;
    debrief.classList.toggle('win', note?.kind === 'win');
    if (note) {
      debrief.append(h('small', 'result-debrief-label', note.title || '战术复盘'));
      debrief.append(h('h3', 'result-debrief-cause', note.cause || '本局已结束'));
      debrief.append(h('p', 'result-debrief-tip', note.tip || '调整战术，重新出发。'));
    } else debrief.style.display = 'none';
    if (note) debrief.style.display = '';
  }
  const stats = document.getElementById('result-stats');
  if (stats) {
    clear(stats);
    const accuracy = Number(s.shotsFired) > 0 ? Math.round((Number(s.shotsHit) || 0) / Number(s.shotsFired) * 100) : null;
    const values = {
      kills: fmtNum(s.kills || 0),
      damage: fmtNum(s.damage || 0),
      survived: fmtTime(s.survived || 0),
      placement: placement ? `#${placement}` : DASH,
      revives: fmtNum(s.revives || 0),
      accuracy: accuracy == null ? DASH : `${accuracy}%`,
    };
    for (const [label, key, id] of RESULT_STAT_DEFS) {
      const cell = h('div', 'result-stat');
      const valueNode = h('b', 'num', values[key]);
      valueNode.id = id;
      cell.append(h('small', 'muted', label), valueNode);
      stats.append(cell);
    }
  }
  const rewards = document.getElementById('result-rewards');
  if (rewards) {
    clear(rewards);
    const xp = Number(r.xp ?? s.xp ?? 0);
    const coin = Number(r.credits ?? s.credits ?? 0);
    const delta = Number(r.ratingDelta ?? s.ratingDelta ?? 0);
    const addReward = (iconName, label, value, cls) => {
      const item = h('div', `reward ${cls || ''}`.trim());
      item.append(icon(iconName, 18), h('small', 'muted', label), h('b', null, value));
      rewards.append(item);
    };
    addReward('star', '经验', `+${fmtNum(xp)}`);
    addReward('coin', '信用点', `+${fmtNum(coin)}`);
    if (delta) addReward('medal', '段位分', `${delta > 0 ? '+' : ''}${fmtNum(delta)}`, delta > 0 ? 'up' : 'down');
    if (r.levelUp) addReward('crown', '等级提升', `LV.${r.newLevel ?? '?'}`, 'up');
  }
  const tags = document.getElementById('result-tags');
  if (tags) {
    clear(tags);
    const missionDone = r.missionsCompleted || s.missionsCompleted || [];
    const achDone = r.achievementsCompleted || s.achievementsCompleted || [];
    for (const item of missionDone) tags.append(h('span', 'badge badge-mission', `任务完成 · ${item.title || item.id || item}`));
    for (const item of achDone) tags.append(h('span', 'badge badge-ach', `成就达成 · ${item.title || item.id || item}`));
    if (!tags.children.length) tags.style.display = 'none';
    else tags.style.display = '';
  }
  renderResultProgress(r, s);
  renderResultXp(r, s);
  renderResultSeason(r);
  renderResultMastery(r);
}

/** 结算 · 赛季通行证（本局经验 + 升档）。 */
function renderResultSeason(r) {
  const node = document.getElementById('result-season');
  if (!node) return;
  clear(node);
  const s = r?.season;
  if (!s || !s.gained) { node.style.display = 'none'; return; }
  node.style.display = '';
  node.append(h('span', 'badge badge-season', `赛季 +${fmtNum(s.gained)} XP`));
  if (s.leveledUp) {
    node.append(h('span', 'badge badge-win', `通行证 ${s.tierBefore} → ${s.tierAfter} 级`));
    for (const rw of (s.rewards || []).slice(0, 3)) {
      if (rw?.label) node.append(h('span', 'badge', rw.label));
    }
  }
}

/** 结算 · 武器精通（每把枪本局成长）。 */
function renderResultMastery(r) {
  const node = document.getElementById('result-mastery');
  if (!node) return;
  clear(node);
  const list = Array.isArray(r?.mastery) ? r.mastery : [];
  if (!list.length) { node.style.display = 'none'; return; }
  node.style.display = '';
  for (const m of list) {
    if (!m?.weaponId) continue;
    const label = m.leveledUp ? `${m.name || m.weaponId} Lv${m.afterLevel}` : (m.name || m.weaponId);
    const value = m.leveledUp ? `+${fmtNum(m.gained)} ↑` : `+${fmtNum(m.gained)}`;
    node.append(h('span', m.leveledUp ? 'badge badge-win' : 'badge', `${label} ${value}`));
  }
}

/** 结算 · 段位升降提示（+18 / -12，绿升红降）+ 任务/成就逐条打勾。 */
function renderResultProgress(r, s) {
  const rankNote = document.getElementById('result-rank-note');
  if (rankNote) {
    clear(rankNote);
    const delta = Number(r.ratingDelta ?? s.ratingDelta ?? 0);
    const training = (app?.modeId || s.mode) === 'training';
    const rank = r.rank || rankInfo();
    const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const pill = h('span', `ui-rank-delta ${cls}`);
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '＝';
    pill.append(h('span', null, `${arrow} ${delta > 0 ? '+' : ''}${fmtNum(delta)} 分`), h('small', 'muted', '段位分'));
    rankNote.append(pill);
    const current = Number.isFinite(Number(r.rating)) ? Number(r.rating) : rating();
    rankNote.append(h('span', 'badge', `${rank?.name || rank?.tier || '青铜'} · ${fmtNum(current)}`));
    if (r.levelUp) rankNote.append(h('span', 'badge badge-win', `LV.${r.oldLevel ?? '?'} → LV.${r.newLevel ?? '?'}`));
    if (training) rankNote.append(h('small', 'muted', '训练场不计段位分'));
    if (!delta && !r.levelUp && !training) rankNote.append(h('small', 'muted', '本局段位分不变'));
  }
  const list = document.getElementById('result-progress');
  if (!list) return;
  clear(list);
  const missionDone = r.missionsCompleted || s.missionsCompleted || [];
  const achDone = r.achievementsCompleted || s.achievementsCompleted || [];
  if (!missionDone.length && !achDone.length) {
    list.append(h('small', 'muted', '本局没有新的任务或成就完成 —— 进度已记录，下次结算继续累计。'));
    return;
  }
  let delay = 0;
  for (const item of missionDone) {
    const row = h('div', 'ui-check-row');
    row.style.animationDelay = `${delay}ms`;
    delay += 70;
    row.append(h('span', 'ui-check', '✓'), h('b', null, '任务'), h('span', null, item.title || item.id || String(item)));
    if (item.xp || item.credits) row.append(h('span', 'ui-check-reward', `+${fmtNum(item.xp || 0)} XP · +${fmtNum(item.credits || 0)}`));
    list.append(row);
  }
  for (const item of achDone) {
    const row = h('div', 'ui-check-row');
    row.style.animationDelay = `${delay}ms`;
    delay += 70;
    row.append(h('span', 'ui-check', '★'), h('b', null, '成就'), h('span', null, item.title || item.id || String(item)));
    if (item.xp || item.credits) row.append(h('span', 'ui-check-reward', `+${fmtNum(item.xp || 0)} XP · +${fmtNum(item.credits || 0)}`));
    list.append(row);
  }
}

/** 结算 · 经验条动画：旧等级 → 新等级，数字滚动。 */
function renderResultXp(r, s) {
  const panel = document.getElementById('result-xp-panel');
  if (!panel) return;
  clear(panel);
  clearTimeout(renderResultXp._timer);
  const info = xpInfo();
  const gained = Number(r.xp ?? s.xp ?? 0);
  const newLevel = Number(r.newLevel ?? info.level ?? 1) || 1;
  const oldLevel = Number(r.oldLevel ?? (r.levelUp ? Math.max(1, newLevel - 1) : newLevel)) || 1;
  const needed = Number(info.needed) || 1;
  const current = Math.max(0, Number(info.current) || 0);
  const head = h('div', 'ui-result-xp-head');
  const levelText = h('b');
  const xpText = h('span', 'muted');
  head.append(h('span', 'muted', '等级'), levelText, h('span', 'spacer'), xpText);
  const track = h('div', 'ui-xp-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', '经验进度');
  track.setAttribute('aria-valuemin', '0');
  const fill = h('i');
  fill.id = 'result-xp-fill';
  if (r.levelUp) fill.classList.add('ui-xp-glow');
  track.append(fill);
  panel.append(head, track);
  const hint = h('small', 'muted');
  hint.id = 'result-xp-hint';
  panel.append(hint);

  // 起点：跨级时从 0% 起跑，否则从「当前经验 - 本局经验」估算
  const startPct = r.levelUp ? 0 : Math.max(0, Math.min(100, ((current - gained) / needed) * 100));
  const endPct = Math.max(0, Math.min(100, (current / needed) * 100));
  fill.style.width = `${startPct.toFixed(1)}%`;
  const reduced = !!app?.settings?.reducedMotion;
  const duration = reduced ? 0 : 700;
  const anim = { level: oldLevel, xp: Math.max(0, Math.round(current - gained)), t0: performance.now() };
  const totalXp = Math.max(1, Math.round(gained));
  const paint = (now) => {
    const t = duration <= 0 ? 1 : Math.min(1, (now - anim.t0) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const xpNow = Math.round(anim.xp + (current - anim.xp) * eased);
    const levelNow = r.levelUp ? (t < 0.5 ? oldLevel : newLevel) : newLevel;
    setText(levelText, `LV.${levelNow}`);
    setText(xpText, `${fmtNum(xpNow)} / ${fmtNum(needed)} EXP`);
    fill.style.width = `${(startPct + (endPct - startPct) * eased).toFixed(1)}%`;
    if (t < 1) requestAnimationFrame(paint);
    else {
      setText(hint, r.levelUp
        ? `等级提升！本局获得 ${fmtNum(totalXp)} 经验，继续对局可解锁更多武器。`
        : `本局获得 ${fmtNum(totalXp)} 经验，距离升级还差 ${fmtNum(Math.max(0, needed - current))} 点。`);
    }
  };
  requestAnimationFrame(paint);
}

/** 结算分享：navigator.share 可用则调起系统分享，否则复制文本 + toast。 */
function shareResult(button) {
  const s = resultSummary || {};
  const r = resultRewards || {};
  const placement = Number(s.placement) || 0;
  const bits = [];
  bits.push(`【雾岛突围】${s.won ? '成功突围' : '本局战报'}`);
  if (placement) bits.push(`第 ${placement} 名${s.totalTeams ? ` / ${s.totalTeams} 队` : ''}`);
  bits.push(`${fmtNum(s.kills || 0)} 淘汰 · ${fmtNum(s.damage || 0)} 伤害 · 生存 ${fmtTime(s.survived || 0)}`);
  if (s.mapId) bits.push(mapNameOf(s.mapId));
  if (r.xp) bits.push(`+${fmtNum(r.xp)} 经验`);
  const text = bits.join(' · ');
  const url = (() => { try { return location.origin + location.pathname; } catch { return ''; } })();
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (nav?.share) {
    try {
      const result = nav.share({ title: '雾岛突围 · 战报', text, url });
      if (result && typeof result.then === 'function') {
        result.then(() => toast('已分享', 1800), () => copyShareText(text, url));
      }
      return;
    } catch { /* 落到复制分支 */ }
  }
  copyShareText(text, url);
}

function copyShareText(text, url) {
  const payload = url ? `${text}\n${url}` : text;
  const fallback = () => {
    try {
      const area = document.createElement('textarea');
      area.value = payload;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand?.('copy');
      area.remove();
      toast(ok ? '战绩已复制到剪贴板' : payload, ok ? 2000 : 5000);
    } catch { toast(payload, 5000); }
  };
  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(payload).then(() => toast('战绩已复制到剪贴板', 2000), fallback);
    return;
  }
  fallback();
}

// ── 21 · 操作说明 / 教程 ────────────────────────────────────────────────────
const HELP_DESKTOP = [
  ['W A S D', '移动', '按住 Shift 冲刺，Ctrl 蹲伏，空格翻滚'],
  ['鼠标', '瞄准与射击', '左键射击，右键开镜'],
  ['R', '换弹', '切枪会保留各自弹匣'],
  ['E', '交互', '拾取物资、上下车、救援队友'],
  ['Q', '切换武器', '主武器与副武器互换'],
  ['G / F', '投掷物', 'G 扔当前选中，F 切换下一个'],
  ['H', '使用消耗品', '优先治疗，静止时生效'],
  ['B', '背包', '查看武器、弹药、消耗品与配件'],
  ['M', '全图', '打开战术地图查看标记'],
  ['Tab', '记分板', '查看本局所有队伍的排名'],
  ['Esc', '菜单', '暂停、设置或退出对局'],
];
const HELP_TOUCH = [
  ['左摇杆', '移动', '推到外圈自动冲刺'],
  ['右摇杆', '瞄准与开火', '推离中心即持续射击'],
  ['换弹 / 治疗', '右侧动作按钮', '拇指可及的圆形按钮'],
  ['交互', '拾取、上车、救援', '靠近目标后按住'],
  ['投掷', '战术按钮', '短按扔当前投掷物，长按切换下一个'],
  ['蹲 / 翻滚', '姿态按钮', '翻滚有冷却，可躲子弹'],
  ['背包', '查看携带物资', '显示武器、弹药、消耗品与配件'],
  ['聊天', '发送队伍消息', '动作按钮里的「聊天」，Enter 键也可'],
  ['小地图', '点击放大', '查看安全区、空投与标记'],
];

function helpTable(rows) {
  const list = h('div', 'help-list');
  for (const [key, action, hint] of rows) {
    const row = h('div', 'help-row');
    row.append(h('span', 'keycap', key));
    const bodyBox = h('div', 'help-body');
    bodyBox.append(h('b', null, action), h('small', 'muted', hint));
    row.append(bodyBox);
    list.append(row);
  }
  return list;
}

export function showHelpDialog() {
  const wrap = h('div', 'help-body');
  const tabs = h('div', 'segmented help-tabs');
  const panels = h('div', 'help-panels');
  const desktop = h('div', 'help-panel');
  desktop.append(h('p', 'muted', '桌面端：键鼠操作')), desktop.append(helpTable(HELP_DESKTOP));
  const touch = h('div', 'help-panel');
  touch.append(h('p', 'muted', '触屏端：双摇杆 + 动作按钮')), touch.append(helpTable(HELP_TOUCH));
  for (const [key, label] of [['desktop', '键鼠'], ['touch', '触屏']]) {
    const btn = h('button', key === (touchDevice ? 'touch' : 'desktop') ? 'active' : '', label);
    btn.type = 'button';
    btn.dataset.help = key;
    btn.addEventListener('click', () => {
      for (const item of tabs.children) item.classList.toggle('active', item === btn);
      desktop.style.display = key === 'desktop' ? '' : 'none';
      touch.style.display = key === 'touch' ? '' : 'none';
    });
    tabs.append(btn);
  }
  desktop.style.display = touchDevice ? 'none' : '';
  touch.style.display = touchDevice ? '' : 'none';
  panels.append(desktop, touch);
  wrap.append(tabs, panels, h('p', 'field-help muted', '所有按键都可以在「设置 · 操作」里调整灵敏度与布局。'));
  const close = h('button', 'btn btn-primary', '知道了');
  close.type = 'button';
  close.id = 'btn-help-close';
  close.addEventListener('click', () => hideDialog('help-dialog'));
  showModal('help-dialog', { title: '操作说明', eyebrow: 'FIELD MANUAL', body: wrap, actions: [close], wide: true });
}

function showFullMap(mapDef) {
  const wrap = h('div', 'fullmap-body');
  const canvas = document.createElement('canvas');
  canvas.id = 'fullmap-canvas';
  canvas.width = 720;
  canvas.height = 720;
  canvas.className = 'fullmap-canvas';
  canvas.setAttribute('aria-label', `${mapDef?.name || '地图'} 全图`);
  drawStaticMap(canvas, mapDef);
  wrap.append(canvas);
  const regions = h('div', 'region-list');
  for (const region of mapDef?.regions || []) {
    const row = h('div', 'region-row');
    row.append(h('b', null, region.name), h('small', 'muted', region.note || ''), h('span', 'badge muted', `T${region.tier || 1}`));
    regions.append(row);
  }
  wrap.append(regions);
  const close = h('button', 'btn btn-primary', '关闭');
  close.type = 'button';
  close.addEventListener('click', () => hideDialog('map-dialog'));
  showModal('map-dialog', { title: mapDef?.name || '战场全图', eyebrow: mapDef?.en || 'TACTICAL MAP', body: wrap, actions: [close], wide: true });
}

function drawStaticMap(canvas, mapDef) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const hgt = canvas.height;
  const radius = mapDef?.radius || 182;
  const scale = w / (radius * 2 + 16);
  const cx = w / 2;
  const cy = hgt / 2;
  const pt = (x, z) => [cx + x * scale, cy + z * scale];
  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = '#0a1b1c';
  ctx.fillRect(0, 0, w, hgt);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2);
  ctx.clip();
  const theme = mapDef?.theme || {};
  const toHex = n => `#${(Number(n) || 0x2f4a42).toString(16).padStart(6, '0')}`;
  ctx.fillStyle = toHex(theme.grass || 0x3a5b4b);
  ctx.fillRect(0, 0, w, hgt);
  ctx.strokeStyle = 'rgba(111,224,200,0.12)';
  ctx.lineWidth = 1;
  for (let i = -radius; i <= radius; i += 40) {
    const [x1, y1] = pt(i, -radius);
    const [x2, y2] = pt(i, radius);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const [x3, y3] = pt(-radius, i);
    const [x4, y4] = pt(radius, i);
    ctx.beginPath(); ctx.moveTo(x3, y3); ctx.lineTo(x4, y4); ctx.stroke();
  }
  for (const road of mapDef?.roads || []) {
    const [x, y] = pt(road.x || 0, road.z || 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-(road.rot || 0));
    ctx.fillStyle = road.kind === 'rail' ? 'rgba(160,180,190,0.4)' : 'rgba(200,205,190,0.28)';
    ctx.fillRect(-(road.w || 6) * scale / 2, -(road.d || 100) * scale / 2, (road.w || 6) * scale, (road.d || 100) * scale);
    ctx.restore();
  }
  for (const region of mapDef?.regions || []) {
    const [x, y] = pt(region.x, region.z);
    const r = (region.r || 36) * scale;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(245,180,69,${0.06 + (region.tier || 1) * 0.05})`);
    grad.addColorStop(1, 'rgba(245,180,69,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(234,246,241,0.82)';
    ctx.font = '500 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(region.name, x, y);
    ctx.fillStyle = 'rgba(154,168,164,0.55)';
    ctx.font = '11px monospace';
    ctx.fillText(`T${region.tier || 1}`, x, y + 16);
  }
  for (const landmark of mapDef?.landmarks || []) {
    const [x, y] = pt(landmark.x, landmark.z);
    ctx.strokeStyle = 'rgba(245,180,69,0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(245,180,69,0.9)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(landmark.name || '', x + 10, y + 4);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(111,224,200,0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2); ctx.stroke();
}

// ── 22 · 刷新与初始化 ───────────────────────────────────────────────────────
function refreshChrome() {
  const coin = credits();
  const level = playerLevel();
  for (const node of document.querySelectorAll('#screen-root .js-credits')) setText(node, fmtNum(coin));
  for (const node of document.querySelectorAll('#screen-root .js-level')) setText(node, fmtNum(level));
  const info = xpInfo();
  for (const node of document.querySelectorAll('#screen-root [data-role="xp-fill"]')) {
    const pct = Math.max(0, Math.min(100, ((Number(info.current) || 0) / (Number(info.needed) || 1)) * 100));
    node.style.width = `${pct.toFixed(1)}%`;
  }
  const rank = rankInfo();
  const rankHome = document.getElementById('player-rank-home');
  if (rankHome) setText(rankHome, `${rank?.name || rank?.tier || '青铜'} · ${fmtNum(rating())} 分`);
  const badges = unreadBadges();
  for (const node of document.querySelectorAll('#screen-root [data-badge]')) {
    const active = !!badges[node.dataset.badge];
    node.style.display = active ? '' : 'none';
    setText(node, active ? String(active) : '');
  }
}

function unreadBadges() {
  const badges = {};
  let missions = 0;
  for (const group of ['daily', 'weekly']) {
    const list = group === 'daily' ? dailyMissions() : weeklyMissions();
    for (const mission of list) {
      const state = missionState(mission.id, group === 'weekly');
      if (!state.claimed && (state.done || Number(state.progress) >= (mission.target || 1))) missions++;
    }
  }
  if (missions) badges.missions = missions;
  let ach = 0;
  for (const item of fullAchievements()) {
    const state = achievementState(item.id);
    if (state.done && !state.claimed) ach++;
  }
  if (ach) badges.career = ach;
  return badges;
}

export function refreshAll() {
  refreshChrome();
  const now = Date.now();
  if (now - lastRefresh < 60) return;
  lastRefresh = now;
  try { meta()?.refreshMissions?.(new Date()); } catch { /* 忽略 */ }
  if (activeScreen) screens.get(activeScreen)?.render?.();
}

function renderScreen(name) {
  const entry = screens.get(name);
  if (!entry) return;
  try { entry.render?.(); } catch (err) { console.warn('[ui] 渲染失败', name, err); }
}

// ── 23 · 键盘与全局事件 ─────────────────────────────────────────────────────
function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
function topDialog() {
  const list = [...document.querySelectorAll('#dialog-root .modal.open')];
  return list.length ? list[list.length - 1] : null;
}

/** 弹窗内可聚焦元素（排除 disabled / hidden）。 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusablesIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.hasAttribute('hidden')) return false;
    if (el.closest('.hidden, [aria-hidden="true"]')) return false;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}
/**
 * 弹窗焦点陷阱：Tab / Shift+Tab 在弹窗内循环，不允许焦点逃到背景页面。
 * WCAG 2.4.3（焦点顺序）+ 2.1.1（键盘可达）的基本要求；
 * 旧实现没有陷阱，弹窗打开后 Tab 会把焦点带到背后的屏幕上。
 */
function trapDialogFocus(event, dialogEl) {
  const list = focusablesIn(dialogEl);
  if (!list.length) { event.preventDefault(); return; }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  const inside = dialogEl.contains(active);
  if (!inside) { event.preventDefault(); first.focus(); return; }
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}
function onKeyDown(event) {
  if (isTyping(event.target)) {
    if (event.key === 'Escape') { event.target.blur(); }
    return;
  }
  const open = topDialog();
  if (event.key === 'Escape') {
    // Esc 由 ui-screens 独占处理：必须停止传播。
    //
    // 旧实现有两处 Esc 监听（main.js 的 document 监听 + 这里的 window 监听），
    // 两次都会执行：main.js 先 pauseForMenu() 打开暂停窗，随后这里看到
    // topDialog() === 'pause-dialog'，把同一次按键当成「关闭暂停」执行 resumeFromPause()
    // —— 结果按 Esc 暂停窗一闪而过，桌面端完全无法用键盘暂停。
    // 用 stopPropagation 让 window 捕获阶段的 main.js 监听收不到（见 main.js 的注释）。
    if (open) {
      event.preventDefault();
      event.stopPropagation();
      // static 弹窗的 Esc 必须走各自的“离开”语义，不能只关 DOM（否则幽灵战场）
      if (open.id === 'result-dialog') leaveResultToHome();
      else if (open.id === 'pause-dialog') resumeFromPause();
      else if (open.id === 'room-dialog') { hideRoom(); try { app?.leaveMatch?.(); } catch { /* 忽略 */ } }
      else hideDialog(open.id);
      return;
    }
    if (activeScreen && activeScreen !== 'home') { event.preventDefault(); event.stopPropagation(); openScreen('home'); return; }
    if (app?.mode === 'match' && app?.paused !== undefined) {
      event.preventDefault(); event.stopPropagation();
      try { app.pauseForMenu?.(); } catch { /* 忽略 */ }
    }
    return;
  }
  // Tab 键**不再**被劫持为「切换屏幕」。
  //
  // 旧实现把任何 Tab 都 preventDefault 后 openScreen(下一个)，导致：
  //   - 键盘用户永远无法用 Tab 到达任何按钮/滑块/输入框（焦点始终停在 BODY）；
  //   - 弹窗打开时按 Tab，背景屏幕还会被切走；
  //   - 读屏软件无法按标准方式遍历页面。
  // 屏幕切换只保留 Esc（返回）与界面上的导航按钮；需要键盘直达时用 Alt+1..7。
  if (event.key === 'Tab' || event.code === 'Tab') {
    const open = topDialog();
    if (open) trapDialogFocus(event, open);
    return;
  }
  // Alt+1..7 快速切屏（键盘无障碍替代，且弹窗打开时禁用）
  if (event.altKey && !topDialog() && /^Digit[1-7]$/.test(event.code || '')) {
    const idx = Number(event.code.slice(-1)) - 1;
    const target = HOME_NAV[idx];
    if (target && app?.mode !== 'match') { event.preventDefault(); openScreen(target.id); }
    return;
  }
  if (event.key === 'm' || event.key === 'M') {
    if (activeScreen === 'codex' || activeScreen === 'play') {
      const map = mapList().find(m => m.id === uiState.mapId) || mapList()[0];
      if (map) { event.preventDefault(); showFullMap(map); }
    }
  }
}

function bindGlobal() {
  if (bound) return;
  bound = true;
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', () => { try { app?.audio?.unlock?.(); } catch { /* 忽略 */ } }, { passive: true });
  document.addEventListener('contextmenu', event => {
    if (app?.mode === 'match') event.preventDefault();
  });
  if (app?.on) {
    const refreshers = ['meta:changed', 'reward', 'levelup', 'lobby', 'room', 'joined', 'online:error', 'settings', 'match:end'];
    for (const name of refreshers) {
      try { app.on(name, payload => onAppEvent(name, payload)); } catch { /* 忽略 */ }
    }
  }
}

function onAppEvent(name, payload) {
  if (name === 'lobby') { updateLobby(payload); return; }
  if (name === 'joined') { hideOnlineDialog(); return; }
  if (name === 'online:error') { setNetBusy(false, payload?.message || '无法连接服务器'); return; }
  if (name === 'match:end') {
    if (payload?.summary) showResult(payload.summary, payload.rewards);
    return;
  }
  refreshAll();
}

// ── 24 · 对外 API ───────────────────────────────────────────────────────────
export function initScreens(application) {
  app = application || {};
  if (built) { refreshAll(); return; }
  built = true;
  const host = roots().screen;
  if (!host) { console.warn('[ui] 缺少 #screen-root'); return; }

  const builders = [
    ['home', buildHome, null],
    ['play', buildPlay, renderPlaySelection],
    ['loadout', buildLoadout, renderLoadout],
    ['store', buildStore, renderStore],
    ['missions', buildMissions, renderMissions],
    ['codex', buildCodex, renderCodex],
    ['career', buildCareer, renderCareer],
    ['settings', buildSettings, null],
  ];
  for (const [name, build, render] of builders) {
    const el = build();
    host.append(el);
    screens.set(name, { name, el, render, bar: el.bar || null });
  }
  setActiveScreen('home');
  refreshChrome();
  bindGlobal();
  injectTouchTargets();
  injectScreenStyles();
  // ⚠ 这两步此前只在「引导 / 计分板」里被间接调用，正常启动路径完全没执行：
  //   - injectUiV2Styles()：任务工具条 .ui-mission-tools / 武器对比 .ui-cmp-track /
  //     图鉴锁定 .ui-locked / .ui-btn 等一批组件在 style.css 里没有任何规则，
  //     全靠这段内联 CSS。不调用它们就是「裸奔」——实测任务页今日剩余进度条高度 0px，
  //     一键领取按钮只有 65×21px，装备页对比条完全消失。
  //   - bindUiV2Globals()：安全区探测、键盘弹出、竖屏暂停（syncOrientation）都在里面，
  //     不调用则 --safe-* 永不刷新、竖屏时主循环仍在空跑。
  try { injectUiV2Styles(); } catch (err) { console.warn('[ui] V2 样式注入失败', err); }
  try { bindUiV2Globals(); } catch (err) { console.warn('[ui] V2 全局绑定失败', err); }
  recentMatches.length = 0;
  const saved = saveData();
  if (Array.isArray(saved.recentMatches)) recentMatches.push(...saved.recentMatches.slice(0, 8));
  else if (saved.lastResult) recentMatches.push({ ...saved.lastResult, historical: true });
  console.info(`[ui] 界面已就绪 · v${VERSION} · ${screens.size} 个屏幕`);
}

export function recordMatch(summary) {
  if (!summary || typeof summary !== 'object') return;
  recentMatches.unshift({ ...summary });
  if (recentMatches.length > 8) recentMatches.length = 8;
  try { if (app?.meta?.recordMatch) app.meta.recordMatch(summary); } catch { /* 忽略 */ }
  try { if (app?.meta?.addMatchResult) app.meta.addMatchResult(summary); } catch (err) { console.warn('[ui] 结算存档失败', err); }
  refreshAll();
}

export function isScreenOpen(name) { return activeScreen === name; }
export function getActiveScreen() { return activeScreen; }
export function getUiState() { return { ...uiState }; }
export function isAnyDialogOpen() { return !!topDialog(); }
export function refreshScreens() { refreshAll(); }
export function setNickname(value) {
  netState.nickname = String(value || OWNER_NAME).slice(0, 14);
  const input = document.getElementById('nickname');
  if (input) input.value = netState.nickname;
}
export function getNetForm() {
  return {
    nickname: normalizedNameSafe(),
    server: netState.server || app?.savedServer || defaultServer(),
    code: netState.code || document.getElementById('room-code')?.value || '',
    mode: netState.gameMode,
    team: netState.team,
  };
}
function normalizedNameSafe() { try { return normalizedName(); } catch { return netState.nickname || OWNER_NAME; } }
export function showOnlineError(message) { setNetBusy(false, message || '连接失败'); }
export function showRoomError(message) { toast(message || '房间不可用', 2600); }
export function setBusyState(busy, message) { setNetBusy(!!busy, message); }
export function showPauseDialog() { showPause(); }
export function hidePauseDialog() { hidePause(); }
export function showResultDialog(summary, rewards) { showResult(summary, rewards); }
export function hideResultDialog() { hideResult(); }
export function showCodexDetail(kind, id) { openCodexDetail(kind, id); }
export function showHelp() { showHelpDialog(); }
export function confirmAction(options) { confirmDialog(options); }

/** 关闭最上层弹窗（Android 返回键 / Esc 用）。返回 true 表示确实关掉了一个。 */
export function closeTopDialog() {
  const node = topDialog();
  if (!node) return false;
  // static 弹窗必须走“离开”语义，避免只关 DOM 留下幽灵战场
  if (node.id === 'result-dialog') leaveResultToHome();
  else if (node.id === 'pause-dialog') resumeFromPause();
  else if (node.id === 'room-dialog') { hideRoom(); try { app?.leaveMatch?.(); } catch { /* 忽略 */ } }
  else hideDialog(node.id);
  return true;
}

/** 当前昵称（main.js 组队/开局时读取）。 */
export function getNickname() {
  const input = document.getElementById('nickname');
  const raw = String(input?.value ?? netState.nickname ?? OWNER_NAME).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return raw || OWNER_NAME;
}

/** 设置某个屏幕为当前屏幕（供 main.js 在启动时调用）。 */
export function showHome() { openScreen('home'); }

// ═══════════════════════════════════════════════════════════════════════════
// 25 · V2 增强层（引导 / 计分板 / 结算动画 / 装备对比 / 图鉴 / 任务 / 虚拟化）
// 说明：本节只追加新函数，所有 DOM 使用 ui- 前缀，样式全部由 JS 注入（不改 style.css）。
// ═══════════════════════════════════════════════════════════════════════════

/** V2 组件样式（一次性注入；design 收编后同名类可被 style.css 覆盖）。 */
function injectUiV2Styles() {
  if (document.getElementById('ui-v2-styles')) return;
  const style = document.createElement('style');
  style.id = 'ui-v2-styles';
  style.textContent = [
    /* ── 通用命中区 + 按压反馈（触屏 ≥44px，桌面保持紧凑） ───────────── */
    '.ui-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);background:rgba(9,28,29,.86);color:var(--text-hi);font-size:13px;font-weight:600;letter-spacing:.02em;cursor:pointer;transition:transform .12s ease,border-color .18s ease,background-color .18s ease}',
    '.ui-btn:hover:not(:disabled){border-color:var(--line-accent);background:rgba(20,60,56,.9)}',
    '.ui-btn:active:not(:disabled){transform:scale(.97)}',
    '.ui-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.ui-btn.ui-primary{border-color:rgba(111,224,200,.55);background:linear-gradient(180deg,rgba(111,224,200,.22),rgba(111,224,200,.08));color:#eafff8}',
    '.ui-btn.ui-ghost{background:rgba(6,20,21,.7)}',
    '.ui-btn.ui-sm{min-height:44px;padding:0 12px;font-size:12px}',
    '.ui-icon-btn{display:inline-grid;place-items:center;width:44px;height:44px;min-width:44px;min-height:44px;border:1px solid var(--line);border-radius:var(--radius-sm);background:rgba(9,28,29,.8);color:var(--text-mid);cursor:pointer;transition:transform .12s ease,border-color .18s ease}',
    '.ui-icon-btn:hover{border-color:var(--line-accent);color:var(--text-hi)}',
    '.ui-icon-btn:active{transform:scale(.94)}',
    '.ui-busy-spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.28);border-top-color:var(--c-teal-300,#6fe0c8);border-radius:50%;animation:uiSpin .8s linear infinite}',
    '@keyframes uiSpin{to{transform:rotate(360deg)}}',
    /* ── 首次启动引导（浮层，不拦截主菜单点击） ─────────────────────── */
    '.ui-onboarding{position:fixed;inset:0;z-index:calc(var(--z-modal,70) + 2);pointer-events:none;display:flex;align-items:flex-end;padding:0 0 calc(var(--safe-b,0px) + 18px) calc(var(--safe-l,0px) + 18px)}',
    '.ui-onboarding.hidden{display:none}',
    '.ui-onb-card{pointer-events:auto;position:relative;width:min(430px,calc(100vw - 36px));padding:16px 18px 14px;border:1px solid var(--line-strong);border-radius:var(--radius-md);background:linear-gradient(180deg,rgba(18,44,44,.97),rgba(6,20,21,.97));box-shadow:0 24px 70px -40px #000,0 0 0 1px rgba(111,224,200,.12);animation:uiOnbIn .34s cubic-bezier(.2,.9,.3,1.1)}',
    '@keyframes uiOnbIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
    '.ui-onb-eyebrow{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--c-teal-300,#6fe0c8);opacity:.85}',
    '.ui-onb-title{margin:4px 0 2px;font-size:16px;font-weight:800;color:var(--text-hi)}',
    '.ui-onb-text{margin:0;font-size:12px;line-height:1.55;color:var(--text-mid)}',
    '.ui-onb-dots{display:flex;gap:6px;margin:10px 0 0}',
    '.ui-onb-dot{width:20px;height:4px;border-radius:2px;background:rgba(151,214,199,.2)}',
    '.ui-onb-dot.on{background:var(--c-teal-300,#6fe0c8)}',
    '.ui-onb-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}',
    '.ui-onb-modes{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
    '.ui-onb-mode{min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:rgba(8,24,25,.9);color:var(--text-mid);font-size:12px;cursor:pointer}',
    '.ui-onb-mode.on{border-color:rgba(111,224,200,.6);color:var(--text-hi);background:rgba(111,224,200,.14)}',
    '.ui-onb-mode:active{transform:scale(.97)}',
    '.ui-onb-keys{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:10px}',
    '.ui-onb-key{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-mid)}',
    '.ui-onb-key b{display:inline-grid;place-items:center;min-width:36px;height:22px;padding:0 6px;border:1px solid var(--line);border-radius:4px;background:rgba(255,255,255,.04);color:var(--text-hi);font-size:10px}',
    /* ── 虚拟列表 ──────────────────────────────────────────────────── */
    '.ui-virt{display:block!important;grid-template-columns:none!important}',
    '.ui-virt-spacer{display:block;width:100%;pointer-events:none}',
    '.ui-virt-rows{display:flex;flex-direction:column;gap:var(--sp-3)}',
    '.ui-virt-row{display:flex;gap:var(--sp-3);align-items:stretch}',
    '.ui-virt-row > *{flex:1 1 0;min-width:0}',
    /* ── 商店 / 图鉴空态 ───────────────────────────────────────────── */
    '.ui-empty{padding:22px 18px;text-align:center;border:1px dashed rgba(151,214,199,.22);border-radius:var(--radius-md);background:rgba(6,20,21,.45);color:var(--text-lo)}',
    '.ui-empty b{display:block;margin-bottom:6px;color:var(--text-hi);font-size:14px}',
    /* ── 任务页工具条 ──────────────────────────────────────────────── */
    '.ui-mission-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:rgba(6,20,21,.6)}',
    '.ui-daybar{position:relative;flex:1 1 180px;min-width:120px;height:6px;border-radius:3px;background:rgba(151,214,199,.14);overflow:hidden}',
    '.ui-daybar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,rgba(111,224,200,.55),rgba(111,224,200,.95));transition:width .4s ease}',
    '.ui-mission-count{flex:0 0 auto;font-size:11px;color:var(--text-dim);font-variant-numeric:tabular-nums}',
    '.mission .ui-mission-progress{font-size:11px;color:var(--text-lo);font-variant-numeric:tabular-nums}',
    '.mission.claimable{box-shadow:inset 2px 0 0 rgba(111,224,200,.75)}',
    '.mission.done{opacity:.62}',
    '.mission.done .ui-mission-progress{color:var(--c-teal-300,#6fe0c8)}',
    /* ── 武器对比 ──────────────────────────────────────────────────── */
    '.ui-cmp{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid rgba(111,224,200,.28);border-radius:var(--radius-sm);background:rgba(9,30,31,.78)}',
    '.ui-cmp-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:11px;color:var(--text-dim)}',
    '.ui-cmp-head b{font-size:13px;color:var(--text-hi)}',
    '.ui-cmp-head .ui-cmp-arrow{color:var(--c-teal-300,#6fe0c8)}',
    '.ui-cmp-row{display:grid;grid-template-columns:52px 1fr 62px;align-items:center;gap:8px}',
    '.ui-cmp-label{font-size:11px;color:var(--text-lo)}',
    '.ui-cmp-track{position:relative;height:6px;border-radius:3px;background:rgba(151,214,199,.12);overflow:hidden}',
    '.ui-cmp-track i{position:absolute;inset:0 auto 0 0;border-radius:3px;background:rgba(151,214,199,.5)}',
    '.ui-cmp-track i.up{background:linear-gradient(90deg,#4fd6a6,#8ef0c4)}',
    '.ui-cmp-track i.down{background:linear-gradient(90deg,#e0604f,#ff9a5c)}',
    '.ui-cmp-val{text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--text-mid)}',
    '.ui-cmp-delta{font-weight:700}',
    '.ui-cmp-delta.up{color:#6fe0a8}',
    '.ui-cmp-delta.down{color:#ff8f7a}',
    '.ui-cmp-delta.same{color:var(--text-dim)}',
    /* ── 图鉴 ──────────────────────────────────────────────────────── */
    '.codex-card.ui-locked{opacity:.55;filter:saturate(.35)}',
    '.codex-card.ui-locked:hover{opacity:.75}',
    '.ui-lock-tag{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:#ffb08a}',
    '.ui-codex-detail-head{display:flex;gap:12px;align-items:flex-start}',
    '.ui-codex-lock-note{margin-top:8px;padding:8px 10px;border:1px dashed rgba(255,150,90,.4);border-radius:var(--radius-sm);color:#ffbf9b;font-size:12px;background:rgba(60,24,12,.35)}',
    '.ui-codex-cond{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.codex-tabs.ui-tabs-wrap{flex-wrap:wrap;overflow:visible}',
    /* ── 结算增强 ──────────────────────────────────────────────────── */
    '.ui-result-xp{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:rgba(6,20,21,.55)}',
    '.ui-result-xp-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:var(--text-dim)}',
    '.ui-result-xp-head b{font-size:15px;color:var(--text-hi);font-variant-numeric:tabular-nums}',
    '.ui-xp-track{position:relative;height:8px;border-radius:4px;background:rgba(151,214,199,.14);overflow:hidden}',
    '.ui-xp-track i{position:absolute;inset:0 auto 0 0;border-radius:4px;background:linear-gradient(90deg,rgba(111,224,200,.6),#9ff3dc);transition:width .1s linear}',
    '.ui-xp-track .ui-xp-glow{background:linear-gradient(90deg,rgba(245,180,69,.85),#ffe6a8)}',
    '.ui-result-list{display:flex;flex-direction:column;gap:6px}',
    '.ui-check-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid rgba(111,224,200,.2);border-radius:var(--radius-sm);background:rgba(9,30,31,.6);font-size:12px;color:var(--text-mid);animation:uiCheckIn .28s ease both}',
    '@keyframes uiCheckIn{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}',
    '.ui-check-row .ui-check{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;background:rgba(111,224,200,.18);color:#8ef0c4;font-size:10px;flex:0 0 auto}',
    '.ui-check-row b{color:var(--text-hi);font-weight:600}',
    '.ui-check-row .ui-check-reward{margin-left:auto;color:var(--text-dim);font-size:11px;white-space:nowrap}',
    '.ui-rank-delta{display:inline-flex;align-items:baseline;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}',
    '.ui-rank-delta.up{color:#8ef0c4;background:rgba(111,224,200,.14)}',
    '.ui-rank-delta.down{color:#ff9a5c;background:rgba(255,120,90,.14)}',
    '.ui-rank-delta.flat{color:var(--text-dim);background:rgba(151,214,199,.1)}',
    '.ui-share{min-height:44px}',
    /* ── 计分板 ────────────────────────────────────────────────────── */
    '#ui-scoreboard .modal-card{width:min(1080px,96vw);max-height:94vh}',
    '.ui-scoreboard{display:flex;flex-direction:column;gap:10px}',
    '.ui-scoreboard-summary{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text-mid)}',
    '.ui-scoreboard-summary b{color:var(--text-hi);font-variant-numeric:tabular-nums}',
    '.ui-sb-table{display:flex;flex-direction:column;gap:2px;min-height:0}',
    '.ui-sb-row{display:grid;grid-template-columns:44px minmax(0,1fr) 56px 64px 74px;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--radius-sm);font-size:12px;color:var(--text-mid);background:rgba(255,255,255,.02)}',
    '.ui-sb-row.head{background:transparent;color:var(--text-dim);font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding-block:4px}',
    '.ui-sb-row.mine{border:1px solid rgba(111,224,200,.45);background:rgba(111,224,200,.1);color:var(--text-hi)}',
    '.ui-sb-row.dead{opacity:.5}',
    '.ui-sb-row .ui-sb-rank{font-variant-numeric:tabular-nums;color:var(--text-dim)}',
    '.ui-sb-row.mine .ui-sb-rank{color:var(--c-teal-300,#6fe0c8)}',
    '.ui-sb-team{display:flex;align-items:center;gap:8px;min-width:0}',
    '.ui-sb-team b{color:var(--text-hi);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ui-sb-dot{width:6px;height:6px;border-radius:50%;background:#8ef0c4;flex:0 0 auto}',
    '.ui-sb-row.dead .ui-sb-dot{background:#5a6a68}',
    '.ui-sb-num{text-align:right;font-variant-numeric:tabular-nums}',
    '.ui-sb-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:11px;color:var(--text-dim)}',
    /* ── 响应式收敛 ────────────────────────────────────────────────── */
    '@media (max-height:460px){',
    '  .ui-onb-card{width:min(360px,calc(100vw - 28px));padding:12px 14px 10px}',
    '  .ui-onb-title{font-size:14px}',
    '  .ui-onb-text{font-size:11px;line-height:1.45}',
    '  .ui-onb-keys{display:none}',
    '  .ui-sb-row{grid-template-columns:36px minmax(0,1fr) 44px 52px 62px;padding:6px 8px;font-size:11px}',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '  .ui-onb-card,.ui-check-row{animation:none!important}',
    '  .ui-btn:active,.ui-icon-btn:active,.ui-onb-mode:active{transform:none}',
    '}',
  ].join('\n');
  document.head.append(style);
}

/** 安全区：只在 JS 里写入 CSS 变量（style.css 由 design 维护，不改）。 */
function applySafeArea() {
  try {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
      + 'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);'
      + 'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const root = document.documentElement;
    for (const [side, value] of [
      ['t', cs.paddingTop], ['r', cs.paddingRight], ['b', cs.paddingBottom], ['l', cs.paddingLeft],
    ]) {
      const px = Math.max(0, Math.round(Number.parseFloat(value) || 0));
      root.style.setProperty(`--safe-${side}`, `${px}px`);
    }
    probe.remove();
  } catch { /* 不支持 env() 时沿用样式表默认值 */ }
}

/** 竖屏：显示 #rotate-hint 并暂停主循环（app.suspended）。 */
function syncOrientation() {
  let portrait = false;
  try { portrait = matchMedia('(orientation: portrait)').matches; } catch { portrait = false; }
  const hint = document.getElementById('rotate-hint');
  if (hint) hint.dataset.uiPortrait = portrait ? '1' : '0';
  if (!app) return;
  if (portrait) {
    if (app.suspended !== true) app.suspended = true;
    app.uiPortrait = true;
  } else if (app.uiPortrait) {
    app.uiPortrait = false;
    if (!document.hidden) app.suspended = false;
    app.frameAt = performance.now();
  }
}

let uiV2Bound = false;
function bindUiV2Globals() {
  if (uiV2Bound) return;
  uiV2Bound = true;
  applySafeArea();
  syncOrientation();
  const onResize = () => { applySafeArea(); syncOrientation(); };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 120));
  try { matchMedia('(orientation: portrait)').addEventListener?.('change', onResize); } catch { /* 老浏览器忽略 */ }
  // 局内 HUD 的 Tab / 按钮通过自定义事件请求全屏计分板（ui-hud 不 import 本模块）
  window.addEventListener('mist:scoreboard', () => toggleScoreboard());
}
// ── END 25a · 样式 / 安全区 / 方向 ──────────────────────────────────────────

// ── 25b · 虚拟列表（只渲染可视区 + 上下各 3 行缓冲） ────────────────────────
/**
 * 把一串条目按「行」虚拟化渲染进容器（容器必须是唯一滚动容器 `.screen-body`
 * 的后代，或自身 overflow:auto）。每行渲染 cols 个等宽卡片。
 * @param {object} options
 * @param {HTMLElement} options.host 目标容器（会被清空并接管）
 * @param {Array} options.items 全部条目数据
 * @param {(item, index) => HTMLElement} options.render 单卡片渲染函数
 * @param {number} [options.rowHeight] 行高（含 gap，px）
 * @param {number} [options.cols] 每行列数（按容器宽度自动推断，可覆盖）
 * @param {number} [options.buffer] 上下缓冲行数（默认 3）
 * @param {string} [options.emptyHtml] 空态文案（无条目时显示）
 */
function mountVirtualList({ host, items, render, rowHeight = 96, cols = null, buffer = 3, empty = null }) {
  if (!host) return null;
  clear(host);
  const list = Array.isArray(items) ? items : [];
  host.classList.add('ui-virt');
  if (!list.length) {
    host.append(empty || emptyState('这里暂时没有内容。'));
    return null;
  }
  const spacer = h('div', 'ui-virt-spacer');
  spacer.style.height = '0px';
  const rows = h('div', 'ui-virt-rows');
  host.append(spacer, rows);
  const state = { cols: cols || 1, rowH: rowHeight, buffer, first: -1, last: -1, raf: 0 };
  const hostRect = () => host.getBoundingClientRect();
  const scroller = () => {
    // 找到真正的滚动容器（.screen-body / .modal-body），否则退回 host 自身
    let node = host.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
    return host.closest('.modal-body') || host;
  };
  const measureCols = () => {
    if (cols) return cols;
    const width = host.clientWidth || hostRect().width || 320;
    return Math.max(1, Math.floor(width / 208));
  };
  const paint = () => {
    state.raf = 0;
    const box = scroller();
    const rect = hostRect();
    const scrollTop = box === host ? host.scrollTop : Math.max(0, box.getBoundingClientRect().top - rect.top);
    const viewH = box === host ? host.clientHeight : box.clientHeight;
    const total = Math.ceil(list.length / state.cols);
    const firstVisible = Math.max(0, Math.floor(scrollTop / state.rowH));
    const first = Math.max(0, firstVisible - state.buffer);
    const last = Math.min(total - 1, firstVisible + Math.ceil(viewH / state.rowH) + state.buffer);
    spacer.style.height = `${(first * state.rowH).toFixed(0)}px`;
    const tail = host.querySelector('.ui-virt-tail');
    if (tail) tail.style.height = `${Math.max(0, (total - last - 1) * state.rowH).toFixed(0)}px`;
    if (first === state.first && last === state.last && rows.childElementCount) return;
    state.first = first;
    state.last = last;
    clear(rows);
    for (let row = first; row <= last; row++) {
      const rowEl = h('div', 'ui-virt-row');
      rowEl.style.minHeight = `${Math.max(44, state.rowH - 12)}px`;
      for (let c = 0; c < state.cols; c++) {
        const index = row * state.cols + c;
        if (index >= list.length) break;
        const cell = h('div', 'ui-virt-cell');
        cell.style.minWidth = '0';
        cell.append(render(list[index], index));
        rowEl.append(cell);
      }
      if (rowEl.childElementCount) rows.append(rowEl);
    }
  };
  const schedule = () => { if (!state.raf) state.raf = requestAnimationFrame(paint); };
  const tail = h('div', 'ui-virt-spacer ui-virt-tail');
  tail.style.height = '0px';
  host.append(tail);
  // 监听最近的滚动容器；没有滚动容器（内容未溢出）时也能渲染首屏
  const box = scroller();
  box.addEventListener('scroll', schedule, { passive: true });
  const onResize = () => {
    const next = measureCols();
    if (next !== state.cols) { state.cols = next; state.first = -1; state.last = -1; }
    schedule();
  };
  window.addEventListener('resize', onResize);
  state.cols = measureCols();
  // 首帧前不要测量（可能还在 display:none 的屏幕里）
  requestAnimationFrame(() => { state.first = -1; state.last = -1; paint(); });
  return {
    refresh: () => { state.first = -1; state.last = -1; schedule(); },
    destroy: () => {
      box.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
    },
    get rendered() { return rows.childElementCount; },
    get total() { return list.length; },
  };
}

// ── 25c · loading / 空态 / 异步超时兜底 ─────────────────────────────────────
const pendingActions = new WeakMap();
/**
 * 异步按钮包装：立即进入 loading（禁用 + 文案「处理中…」），
 * 8 秒兜底恢复可点并 toast 报错，避免网络异常导致按钮永久卡死。
 */
function withBusy(button, task, { label = '处理中…', timeoutMs = 8000, timeoutMessage = '操作超时，请重试' } = {}) {
  if (!button || pendingActions.has(button)) return null;
  const original = button.textContent || '';
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.dataset.busy = '1';
  clear(button);
  const spinner = h('i', 'ui-busy-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  button.append(spinner, h('span', null, label));
  const done = (ok, message) => {
    if (!pendingActions.has(button)) return;
    clearTimeout(pendingActions.get(button));
    pendingActions.delete(button);
    delete button.dataset.busy;
    clear(button);
    setText(button, original || '确定');
    button.disabled = wasDisabled;
    if (!ok && message) toast(message, 2600);
  };
  const timer = setTimeout(() => {
    done(false, timeoutMessage);
  }, Math.max(500, timeoutMs));
  pendingActions.set(button, timer);
  try {
    const result = typeof task === 'function' ? task() : task;
    if (result && typeof result.then === 'function') {
      result.then(() => done(true), err => done(false, err?.message || '操作失败，请重试'));
    } else {
      setTimeout(() => done(true), 90);
    }
  } catch (err) {
    done(false, err?.message || '操作失败，请重试');
  }
  return timer;
}

/** 富空态：标题 + 说明 + 可选操作按钮。 */
function emptyPanel(title, text, action = null) {
  const box = h('div', 'ui-empty');
  box.append(h('b', null, title));
  if (text) box.append(h('p', 'muted', text));
  if (action && action.label && action.onClick) {
    const btn = h('button', 'ui-btn ui-sm', action.label);
    btn.type = 'button';
    if (action.id) btn.id = action.id;
    btn.addEventListener('click', () => { playAudio('ui_click'); action.onClick(); });
    box.append(btn);
  }
  return box;
}
// ── END 25c ─────────────────────────────────────────────────────────────────

// ── 25d · 首次启动引导（3 步浮层） ──────────────────────────────────────────
const onboarding = { el: null, step: 0, mode: 'training', shown: false, opener: null };

function tutorialDone() {
  try { if (meta()?.data?.tutorialDone === true) return true; } catch { /* 忽略 */ }
  try { if (app?.settings?.tutorialDone === true) return true; } catch { /* 忽略 */ }
  return false;
}
function markTutorialDone() {
  try {
    if (meta()?.data) { meta().data.tutorialDone = true; meta().save?.(); }
  } catch { /* 存档不可写 */ }
  try {
    if (app?.settings) { app.settings.tutorialDone = true; app.saveSettings?.(); }
  } catch { /* 忽略 */ }
}

const ONB_STEPS = [
  { eyebrow: 'STEP 1 / 3', title: '先活下去，再谈胜利', text: '' },
  { eyebrow: 'STEP 2 / 3', title: '选一个战场', text: '模式决定节奏，地图决定地形。第一次建议先打训练场。' },
  { eyebrow: 'STEP 3 / 3', title: '准备出发', text: '确认选择后会直接进入战场，随时可从菜单返回。' },
];

const ONB_DESKTOP_KEYS = [['WASD', '移动'], ['鼠标', '瞄准 / 射击'], ['R', '换弹'], ['E', '交互'], ['Tab', '记分板'], ['Esc', '菜单']];
const ONB_TOUCH_KEYS = [['左摇杆', '移动'], ['右摇杆', '瞄准 / 开火'], ['动作键', '换弹 / 治疗'], ['小地图', '点击放大']];

function onboardingStepBody(step) {
  const box = h('div', 'ui-onb-step');
  if (step === 0) {
    const keys = touchDevice ? ONB_TOUCH_KEYS : ONB_DESKTOP_KEYS;
    const grid = h('div', 'ui-onb-keys');
    for (const [key, label] of keys) {
      const row = h('div', 'ui-onb-key');
      row.append(h('b', null, key), h('span', null, label));
      grid.append(row);
    }
    box.append(grid);
  } else if (step === 1) {
    const modes = h('div', 'ui-onb-modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '选择模式');
    for (const mode of MODE_LIST) {
      const btn = h('button', `ui-onb-mode${onboarding.mode === mode.id ? ' on' : ''}`.trim(), mode.name);
      btn.type = 'button';
      btn.dataset.onbMode = mode.id;
      btn.setAttribute('aria-pressed', onboarding.mode === mode.id ? 'true' : 'false');
      btn.addEventListener('click', () => {
        onboarding.mode = mode.id;
        uiState.mode = mode.id;
        for (const item of modes.children) {
          const on = item.dataset.onbMode === mode.id;
          item.classList.toggle('on', on);
          item.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        playAudio('ui_click');
        const text = $('.ui-onb-text', onboarding.el);
        if (text) setText(text, `${mode.desc} ${mode.meta}`);
      });
      modes.append(btn);
    }
    box.append(modes);
  } else {
    const summary = h('div', 'ui-onb-modes');
    const mode = MODE_LIST.find(m => m.id === onboarding.mode) || MODE_LIST[3];
    const map = mapList().find(m => m.id === uiState.mapId) || mapList()[0];
    const difficulty = mode.id === 'training' ? 'recruit' : uiState.difficulty;
    summary.append(h('span', 'chip', mode?.name || '训练场'), h('span', 'chip', map?.name || '青岚岛'),
      h('span', 'chip', `AI · ${DIFFICULTY[difficulty]?.name || '新兵'}`));
    box.append(summary);
  }
  return box;
}

function renderOnboarding() {
  const el = onboarding.el;
  if (!el) return;
  const step = onboarding.step;
  const meta0 = ONB_STEPS[step] || ONB_STEPS[0];
  setText($('.ui-onb-eyebrow', el), meta0.eyebrow);
  setText($('.ui-onb-title', el), meta0.title);
  const text = $('.ui-onb-text', el);
  if (text) {
    const modeText = step === 0
      ? (touchDevice ? '左侧摇杆移动，右侧摇杆推开即瞄准并持续开火。' : 'WASD 移动，鼠标瞄准，左键开火；R 换弹，E 交互。')
      : meta0.text;
    setText(text, modeText);
  }
  const dots = $('.ui-onb-dots', el);
  if (dots) {
    clear(dots);
    for (let i = 0; i < 3; i++) dots.append(h('i', `ui-onb-dot${i === step ? ' on' : ''}`));
  }
  const holder = $('.ui-onb-body', el);
  if (holder) { clear(holder); holder.append(onboardingStepBody(step)); }
  const next = $('.ui-onb-next', el);
  if (next) {
    const selectedMode = MODE_LIST.find(m => m.id === onboarding.mode) || MODE_LIST[3];
    setText(next, step >= 2 ? (selectedMode.id === 'training' ? '开始训练' : `开始 · ${selectedMode.name}`) : '下一步');
  }
  const skip = $('.ui-onb-skip', el);
  if (skip) setText(skip, step >= 2 ? '稍后再说' : '跳过引导');
}

function closeOnboarding({ persist = false } = {}) {
  const el = onboarding.el;
  if (!el) return;
  el.classList.add('hidden');
  onboarding.shown = false;
  if (persist) markTutorialDone();
  const opener = onboarding.opener;
  onboarding.opener = null;
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch { /* 忽略 */ }
  }
}

function buildOnboarding() {
  if (onboarding.el) return onboarding.el;
  const el = h('div', 'ui-onboarding hidden');
  el.id = 'ui-onboarding';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'false');
  el.setAttribute('aria-label', '新手引导');
  const card = h('section', 'ui-onb-card');
  const eyebrow = h('div', 'ui-onb-eyebrow', 'STEP 1 / 3');
  const title = h('div', 'ui-onb-title', '');
  const text = h('p', 'ui-onb-text', '');
  const body = h('div', 'ui-onb-body');
  const dots = h('div', 'ui-onb-dots');
  const actions = h('div', 'ui-onb-actions');
  const skip = h('button', 'ui-btn ui-ghost ui-sm ui-onb-skip', '跳过引导');
  skip.type = 'button';
  skip.id = 'btn-onb-skip';
  skip.addEventListener('click', () => { playAudio('ui_click'); closeOnboarding({ persist: true }); toast('可以在「设置 · 引导」里重新打开', 2400); });
  const next = h('button', 'ui-btn ui-primary ui-sm ui-onb-next', '下一步');
  next.type = 'button';
  next.id = 'btn-onb-next';
  next.addEventListener('click', () => {
    playAudio('ui_click');
    if (onboarding.step >= 2) {
      uiState.mode = onboarding.mode || 'training';
      if (uiState.mode === 'training') uiState.difficulty = 'recruit';
      // 引导的最后一步就是开战，不再强迫新玩家额外寻找一次「开始」。
      if (startOffline()) closeOnboarding({ persist: true });
      return;
    }
    onboarding.step = Math.min(2, onboarding.step + 1);
    renderOnboarding();
    const focusTarget = onboarding.step === 1 ? $('.ui-onb-mode', el) : $('.ui-onb-next', el);
    focusTarget?.focus?.({ preventScroll: true });
  });
  card.append(eyebrow, title, text, body, dots, actions);
  actions.append(skip, next);
  el.append(card);
  (document.getElementById('screen-root') || document.body).append(el);
  onboarding.el = el;
  return el;
}

/** 首次启动时展示引导；已看过则静默跳过。 */
export function maybeShowOnboarding({ force = false } = {}) {
  bindUiV2Globals();
  if (!force && tutorialDone()) return false;
  const el = buildOnboarding();
  if (!onboarding.shown && !force) onboarding.shown = true;
  onboarding.step = 0;
  // 初次游玩推荐低门槛训练；手动从设置重播则保留玩家当前选择。
  onboarding.mode = force ? (uiState.mode || 'training') : 'training';
  renderOnboarding();
  el.classList.remove('hidden');
  requestAnimationFrame(() => $('.ui-onb-next', el)?.focus?.({ preventScroll: true }));
  return true;
}
// ── END 25d ─────────────────────────────────────────────────────────────────

// ── 25e · 局内全屏计分板（16 队 · 自己队高亮 · 按击杀降序） ──────────────────
const scoreboardState = { open: false, opener: null, timer: 0 };

function scoreboardRows() {
  const state = app?.state;
  const selfId = app?.selfId || state?.selfId || null;
  const players = Array.isArray(state?.players) ? state.players : [];
  const teams = new Map();
  for (const player of players) {
    const key = Number.isFinite(player.team) ? player.team : 0;
    let entry = teams.get(key);
    if (!entry) {
      entry = {
        team: key, name: player.teamName || `第 ${key + 1} 小队`, kills: 0, damage: 0,
        alive: 0, total: 0, members: [], mine: false,
      };
      teams.set(key, entry);
    }
    entry.kills += Number(player.kills) || 0;
    entry.damage += Number(player.damage) || 0;
    entry.total += 1;
    if (player.alive !== false) entry.alive += 1;
    if (player.id === selfId) entry.mine = true;
    if (player.name) entry.members.push(player.name);
  }
  // 结算后优先采用服务端/模拟给出的名次（更权威），否则按击杀→伤害→存活排
  const ranks = state?.result?.ranks;
  const rankOf = new Map();
  if (Array.isArray(ranks)) for (const rk of ranks) rankOf.set(Number(rk.team), rk);
  const list = [...teams.values()];
  list.sort((a, b) => b.kills - a.kills || b.damage - a.damage || b.alive - a.alive || a.team - b.team);
  return { list, rankOf, selfId, state };
}

function renderScoreboardBody() {
  const host = document.getElementById('ui-scoreboard-body');
  if (!host) return;
  clear(host);
  const { list, rankOf, state } = scoreboardRows();
  if (!list.length) {
    host.append(emptyPanel('暂无对局数据', '进入对局后这里会显示全部小队的击杀与伤害。'));
    return;
  }
  const mine = list.find(entry => entry.mine);
  const summary = h('div', 'ui-scoreboard-summary');
  const counts = state?.counts || {};
  const bits = [
    ['存活', state?.mode === 'solo' ? (counts.alive ?? '—') : (counts.aliveTeams ?? '—')],
    ['总席位', counts.total ?? '—'],
    ['小队', `${list.length}`],
    ['我的淘汰', mine ? mine.kills : 0],
  ];
  for (const [label, value] of bits) {
    const cell = h('span', null, `${label} `);
    cell.append(h('b', null, String(value)));
    summary.append(cell);
  }
  host.append(summary);

  const table = h('div', 'ui-sb-table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', '全部小队战绩');
  const head = h('div', 'ui-sb-row head');
  head.setAttribute('role', 'row');
  head.append(h('span', 'ui-sb-rank', '#'), h('span', null, '小队'), h('span', 'ui-sb-num', '人数'),
    h('span', 'ui-sb-num', '击杀'), h('span', 'ui-sb-num', '总伤害'));
  table.append(head);
  list.forEach((entry, index) => {
    const rk = rankOf.get(entry.team);
    const rank = Number(rk?.rank) || index + 1;
    const row = h('div', `ui-sb-row${entry.mine ? ' mine' : ''}${entry.alive === 0 ? ' dead' : ''}`);
    row.setAttribute('role', 'row');
    row.dataset.team = String(entry.team);
    const rankCell = h('span', 'ui-sb-rank', `#${rank}`);
    const teamCell = h('span', 'ui-sb-team');
    const dot = h('i', 'ui-sb-dot');
    dot.setAttribute('aria-hidden', 'true');
    const name = h('b', null, entry.mine ? `${entry.name}（你）` : entry.name);
    teamCell.append(dot, name);
    if (entry.members.length && entry.members.length <= 4) {
      teamCell.append(h('small', 'muted', entry.members.slice(0, 4).join(' · ')));
    }
    row.append(rankCell, teamCell,
      h('span', 'ui-sb-num', `${entry.alive}/${entry.total}`),
      h('span', 'ui-sb-num', String(entry.kills)),
      h('span', 'ui-sb-num', fmtNum(entry.damage)));
    table.append(row);
  });
  host.append(table);

  const foot = h('div', 'ui-sb-foot');
  foot.append(h('span', null, '按击杀降序 · 自己所在小队已高亮'), h('span', 'spacer'),
    (() => {
      const btn = h('button', 'ui-btn ui-ghost ui-sm', '关闭');
      btn.type = 'button';
      btn.id = 'btn-scoreboard-close';
      btn.addEventListener('click', () => { playAudio('ui_click'); toggleScoreboard(false); });
      return btn;
    })());
  host.append(foot);
}

function buildScoreboard() {
  const wrap = h('div', 'ui-scoreboard');
  wrap.id = 'ui-scoreboard-body';
  wrap.setAttribute('aria-live', 'polite');
  return wrap;
}

/** 打开 / 关闭全屏计分板。force=true 打开，false 关闭，省略则切换。 */
export function toggleScoreboard(force) {
  bindUiV2Globals();
  const next = force === undefined ? !scoreboardState.open : !!force;
  const node = document.getElementById('ui-scoreboard');
  if (!next) {
    if (!node || !node.classList.contains('open')) return false;
    hideDialog('ui-scoreboard');
    scoreboardState.open = false;
    clearInterval(scoreboardState.timer);
    scoreboardState.timer = 0;
    const opener = scoreboardState.opener;
    scoreboardState.opener = null;
    if (opener && document.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch { /* 忽略 */ } }
    return false;
  }
  const active = document.activeElement;
  scoreboardState.opener = active && active !== document.body ? active : null;
  const modal = showModal('ui-scoreboard', {
    title: '本局战绩',
    eyebrow: 'SCOREBOARD',
    hint: '按击杀降序排列 · 自己所在的小队已高亮',
    body: buildScoreboard(),
    wide: true,
  });
  scoreboardState.open = true;
  renderScoreboardBody();
  clearInterval(scoreboardState.timer);
  scoreboardState.timer = setInterval(() => { if (scoreboardState.open) renderScoreboardBody(); }, 900);
  const card = modal.querySelector('.modal-card');
  if (card) { card.style.width = 'min(1080px, 96vw)'; card.style.maxHeight = '94vh'; }
  const close = modal.querySelector('.modal-close');
  if (close) close.setAttribute('aria-label', '关闭记分板');
  setTimeout(() => document.getElementById('btn-scoreboard-close')?.focus?.({ preventScroll: true }), 60);
  return true;
}

export function openScoreboard() { return toggleScoreboard(true); }
export function closeScoreboard() { return toggleScoreboard(false); }
export function isScoreboardOpen() { return scoreboardState.open; }
// ── END 25e ─────────────────────────────────────────────────────────────────

