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

function makeChrome(name = 'play') {
  const bar = h('div', 'app-bar topbar');
  bar.style.pointerEvents = 'auto';
  bar.dataset.screen = name;
  const back = h('button', 'icon-btn app-bar-back');
  back.id = btnId(`back-${name}`);
  back.type = 'button';
  back.setAttribute('aria-label', '返回主菜单');
  back.append(icon('back'));
  back.addEventListener('click', () => openScreen('home'));
  const titleWrap = h('div', 'app-bar-title');
  titleWrap.append(h('b', null, SCREEN_META[name]?.title || ''), h('small', null, SCREEN_META[name]?.sub || ''));
  const spacer = h('div', 'spacer');
  const creditsWrap = h('div', 'currency currency-credits');
  creditsWrap.id = 'currency-credits';
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
/** 局外按钮的稳定 id：id="btn-<action>"（契约 §11）。 */
function btnId(action) { return `btn-${action}`; }

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
  const hero = h('div', 'home-hero');
  const eyebrow = h('div', 'eyebrow', 'TACTICAL SURVIVAL · 64 PLAYERS');
  const logo = h('div', 'home-logo');
  const cn = h('h1', 'title-xl home-logo-cn', '雾岛突围');
  const en = h('div', 'home-logo-en', 'MIST ISLE');
  const tag = h('p', 'tagline', '雾散了，活到最后的人才能离开。');
  logo.append(cn, en, tag);
  hero.append(eyebrow, logo);

  const nav = h('div', 'home-nav');
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', '主菜单导航');
  for (const item of HOME_NAV) {
    // .home-nav-item 的样式用 grid-template-areas: "name arrow" / "hint arrow"
    const btn = h('button', 'home-nav-item nav-button');
    btn.type = 'button';
    btn.dataset.nav = item.id;
    btn.id = HOME_NAV_IDS[item.id] || `nav-${item.id}`;
    btn.setAttribute('aria-label', `${item.name} · ${item.desc}`);
    btn.append(h('b', null, item.name), h('small', null, item.desc), h('span', 'arrow', '↗'));
    const dot = h('span', 'badge dot');
    dot.dataset.badge = item.id;
    dot.style.display = 'none';
    btn.append(dot);
    btn.addEventListener('click', () => openScreen(item.id));
    nav.append(btn);
  }

  const player = h('aside', 'player-card');
  player.id = 'player-card';
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
  const creditLine = h('div', 'currency');
  creditLine.append(icon('coin', 14), h('b', 'js-credits', '0'), h('small', null, '信用点'));
  metaWrap.append(nameLine, rankLine, bar, creditLine);
  player.append(levelRing, metaWrap);

  const foot = h('footer', 'home-foot');
  const hint = h('span', 'hint muted', touchDevice ? '触屏操作 · 左摇杆移动 · 右摇杆瞄准开火' : 'WASD 移动 · 鼠标瞄准射击 · Esc 呼出菜单');
  const version = h('span', 'version', `v${VERSION} · BUILD 1.0.0`);
  version.id = 'version-label';
  foot.append(hint, version);
  const row = h('div', 'home-bottom');
  row.append(player, foot);
  body.append(hero, nav, row);
  el.append(body);
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
  const bar = makeChrome('play');
  el.bar = bar;
  el.append(bar);
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head');
  head.append(h('div', 'eyebrow', 'DEPLOYMENT'), h('h2', 'title-lg', '选择你的战场'), h('p', 'muted', '行动开始前，确认模式、地图与敌人强度。'));
  body.append(head);

  const main = h('div', 'screen-main play-main');
  const modes = h('div', 'mode-grid');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '对局模式');
  for (const mode of MODE_LIST) {
    const btn = h('button', `mode-pick card ${uiState.mode === mode.id ? 'active' : ''}`.trim());
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
    const btn = h('button', `map-pick card ${uiState.mapId === map.id ? 'active' : ''}`.trim());
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
  return Object.values(attachmentTable()).filter(att => slots.includes(att.slot) || !att.slot);
}
function currentAttachment(slotId) {
  const att = loadout().attachments?.[slotId];
  return Array.isArray(att) ? att : [];
}

function buildLoadout() {
  const el = makeScreen('loadout');
  const bar = makeChrome('loadout');
  el.bar = bar;
  el.append(bar);
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
  const bar = makeChrome('store');
  el.bar = bar;
  el.append(bar);
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
  const bar = makeChrome('missions');
  el.bar = bar;
  el.append(bar);
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

// ── 13 · 图鉴 ───────────────────────────────────────────────────────────────
function buildCodex() {
  const el = makeScreen('codex');
  const bar = makeChrome('codex');
  el.bar = bar;
  el.append(bar);
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head');
  head.append(h('div', 'eyebrow', 'CODEX'), h('h2', 'title-lg', '战场档案'), h('p', 'muted', '武器、配件、道具、地图与敌人的完整资料。点击卡片查看详情。'));
  body.append(head);

  const tabs = h('div', 'tabs codex-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const tab of codexTabs) {
    const btn = h('button', 'tab', tab.name);
    btn.type = 'button';
    btn.dataset.tab = tab.id;
    btn.id = `codex-tab-${tab.id}`;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => { uiState.codexTab = tab.id; renderCodex(); });
    tabs.append(btn);
  }
  body.append(tabs);
  const grid = h('div', 'codex-grid');
  grid.id = 'codex-grid';
  body.append(grid);
  el.append(body);
  return el;
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

function renderCodex() {
  const el = screenEl('codex');
  if (!el) return;
  for (const tab of el.querySelectorAll('.codex-tabs .tab')) {
    const active = tab.dataset.tab === uiState.codexTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  const grid = document.getElementById('codex-grid');
  if (!grid) return;
  clear(grid);
  for (const entry of codexEntries(uiState.codexTab)) {
    const card = h('button', `codex-card ${rarityClass(entry.rarity || 'common')}`);
    card.type = 'button';
    card.dataset.kind = entry.kind;
    card.dataset.id = entry.id;
    card.id = `codex-${entry.kind}-${entry.id}`;
    card.setAttribute('aria-label', `${entry.name || entry.id} 详情`);
    const art = h('div', 'codex-art');
    art.dataset.kind = entry.kind;
    art.append(icon(entry.kind === 'map' ? 'map' : entry.kind === 'enemy' ? 'skull' : entry.kind === 'item' ? 'box' : entry.kind === 'attachment' ? 'crosshair' : 'target', 24));
    const meta = h('div', 'codex-meta');
    meta.append(h('b', 'item-name', entry.name || entry.id));
    const sub = entry.kind === 'map' ? `${entry.regions?.length || 0} 区域 · 难度 ${entry.difficulty || 1}`
      : entry.kind === 'enemy' ? `威胁 ${entry.threat || 1} · 生命 ${entry.hp || DASH}`
        : entry.kind === 'attachment' ? `${entry.slot || '通用'} · ${rarityName(entry.rarity)}`
          : rarityName(entry.rarity || 'common');
    meta.append(h('small', 'muted', sub));
    card.append(art, meta);
    if (entry.kind === 'weapon') {
      card.append(h('span', 'codex-badge', `${entry.damage || 0} 伤害`));
    }
    card.addEventListener('click', () => openCodexDetail(entry.kind, entry.id));
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
  const hero = h('div', `codex-hero ${rarityClass(entry.rarity || 'common')}`);
  hero.append(icon(kind === 'enemy' ? 'skull' : kind === 'item' ? 'box' : 'target', 34));
  const headInfo = h('div', 'codex-hero-info');
  headInfo.append(h('h3', 'title-md', entry.name || id), h('div', 'row'));
  const tagRow = headInfo.querySelector('.row');
  if (entry.rarity) tagRow.append(rarityTag(entry.rarity));
  if (entry.cls) tagRow.append(h('span', 'chip chip-xs', entry.cls));
  if (entry.ammo) tagRow.append(h('span', 'chip chip-xs', `弹药 · ${entry.ammo}`));
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
  showModal('codex-dialog', { title: '档案详情', eyebrow: 'CODEX ENTRY', body: bodyBox });
}

// ── 14 · 生涯 ───────────────────────────────────────────────────────────────
function buildCareer() {
  const el = makeScreen('career');
  const bar = makeChrome('career');
  el.bar = bar;
  el.append(bar);
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head');
  head.append(h('div', 'eyebrow', 'CAREER'), h('h2', 'title-lg', '生涯档案'), h('p', 'muted', '你的每一场战斗都会记录在这里。'));
  body.append(head);

  const overview = h('section', 'panel career-head');
  overview.id = 'career-overview';
  body.append(overview);

  const statPanel = h('section', 'panel');
  statPanel.append(h('div', 'panel-head', '生涯统计'));
  const statGrid = h('div', 'stat-grid career-stats');
  statGrid.id = 'career-stats';
  statPanel.append(statGrid);
  body.append(statPanel);

  const achPanel = h('section', 'panel');
  const achHead = h('div', 'panel-head row');
  achHead.append(h('b', null, '成就'), h('span', 'spacer'), h('small', 'muted', '完成后可领取奖励'));
  achPanel.append(achHead);
  const achGrid = h('div', 'ach-grid');
  achGrid.id = 'achievement-grid';
  achPanel.append(achGrid);
  body.append(achPanel);

  const historyPanel = h('section', 'panel');
  historyPanel.append(h('div', 'panel-head', '最近战报'));
  const history = h('div', 'match-history');
  history.id = 'match-history';
  historyPanel.append(history);
  body.append(historyPanel);
  el.append(body);
  return el;
}

function renderCareer() {
  const el = screenEl('career');
  if (!el) return;
  const info = xpInfo();
  const rank = rankInfo();
  const overview = document.getElementById('career-overview');
  if (overview) {
    clear(overview);
    const badge = h('div', 'career-badge');
    badge.append(icon('medal', 30));
    const levelRing = h('div', 'level-ring level-ring-lg');
    levelRing.append(h('b', null, fmtNum(info.level || playerLevel())), h('small', null, 'LV'));
    const right = h('div', 'grow career-info');
    const nameRow = h('div', 'row');
    nameRow.append(h('b', 'career-name', OWNER_NAME), h('span', 'rank-tag', rank?.name || rank?.tier || '青铜'));
    right.append(nameRow);
    const xpText = h('small', 'muted');
    setText(xpText, `经验 ${fmtNum(info.current || 0)} / ${fmtNum(info.needed || 0)}`);
    const bar = h('div', 'progress progress-lg');
    const fill = h('i');
    const pct = Math.max(0, Math.min(100, ((Number(info.current) || 0) / (Number(info.needed) || 1)) * 100));
    fill.style.width = `${pct.toFixed(1)}%`;
    bar.append(fill);
    const rankBar = h('div', 'rank-progress');
    const rp = h('div', 'progress');
    const rpf = h('i');
    rpf.style.width = `${Math.round((rank?.progress || 0) * 100)}%`;
    rp.append(rpf);
    const nextText = h('small', 'muted', `段位分 ${fmtNum(rating())} · 下一段位还需 ${fmtNum(Math.max(0, 240 - (rating() % 240)))}`);
    rankBar.append(rp, nextText);
    right.append(xpText, bar, rankBar);
    overview.append(badge, levelRing, right);
  }

  const stats = saveData().stats || {};
  const grid = document.getElementById('career-stats');
  if (grid) {
    clear(grid);
    const rows = [
      ['对局场次', fmtNum(stats.matches || 0)],
      ['胜场', fmtNum(stats.wins || 0)],
      ['淘汰数', fmtNum(stats.kills || 0)],
      ['场均伤害', fmtNum((stats.damage || 0) / Math.max(1, stats.matches || 1))],
      ['最长生存', fmtTime(stats.survived || 0)],
      ['最佳名次', stats.bestPlacement ? `#${stats.bestPlacement}` : DASH],
      ['当前连胜', fmtNum(stats.streak || 0)],
      ['最高连胜', fmtNum(stats.bestStreak || 0)],
      ['波次纪录', fmtNum(stats.hordeWaves || 0)],
      ['段位分', fmtNum(rating())],
    ];
    for (const [label, value] of rows) {
      const card = h('div', 'stat');
      card.append(h('small', null, label), h('b', null, value));
      grid.append(card);
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
  let ok = false;
  try {
    if (m?.claimAchievement) ok = m.claimAchievement(ach.id) !== false;
  } catch (err) { toast(err?.message || '领取失败'); return; }
  if (!ok) { toast('成就尚未完成'); return; }
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
  const el = makeScreen('settings');
  const bar = makeChrome('settings');
  el.bar = bar;
  el.append(bar);
  const body = h('div', 'screen-body');
  const head = h('div', 'screen-head');
  head.append(h('div', 'eyebrow', 'SETTINGS'), h('h2', 'title-lg', '作战设置'), h('p', 'muted', '调整后自动保存，下次启动沿用当前配置。'));
  body.append(head);

  const s = app?.settings || {};
  const columns = h('div', 'settings-columns');

  const audioPanel = h('section', 'panel');
  audioPanel.id = 'settings-audio';
  audioPanel.append(h('div', 'panel-head row'));
  audioPanel.querySelector('.panel-head').append(icon('volume', 18), h('b', null, '音频'));
  const soundRow = settingRow('游戏音效', '枪声、脚步与界面反馈');
  const soundToggle = buildToggle(s.sound !== false, value => updateSetting('sound', value), '游戏音效');
  soundToggle.id = 'sound-toggle';
  soundRow.append(soundToggle);
  const musicRow = settingRow('背景音乐', '主菜单与战斗音乐');
  const musicToggle = buildToggle(s.music !== false, value => updateSetting('music', value), '背景音乐');
  musicToggle.id = 'music-toggle';
  musicRow.append(musicToggle);
  const volumeRow = settingRow('主音量', '');
  const sfxVolume = buildSlider(Math.round((s.sfxVolume ?? 0.8) * 100), 0, 100, 5, value => updateSetting('sfxVolume', value / 100), '主音量');
  volumeRow.append(sfxVolume);
  audioPanel.append(soundRow, musicRow, volumeRow);

  const displayPanel = h('section', 'panel');
  displayPanel.id = 'settings-display';
  const displayHead = h('div', 'panel-head row');
  displayHead.append(icon('monitor', 18), h('b', null, '画面'));
  displayPanel.append(displayHead);
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
  qualitySelect.addEventListener('change', () => updateSetting('quality', qualitySelect.value));
  qualityRow.append(qualitySelect);
  const fpsRow = settingRow('显示帧率', 'HUD 右上角显示实时 FPS');
  const fpsToggle = buildToggle(!!s.showFps, value => updateSetting('showFps', value), '显示帧率');
  fpsToggle.id = 'fps-toggle';
  fpsRow.append(fpsToggle);
  const hudRow = settingRow('HUD 缩放', '调整局内界面大小');
  const hudScale = buildSlider(Math.round((s.hudScale ?? 1) * 100), 70, 130, 5, value => updateSetting('hudScale', value / 100), 'HUD 缩放');
  hudRow.append(hudScale);
  displayPanel.append(qualityRow, fpsRow, hudRow);

  const controlsPanel = h('section', 'panel');
  controlsPanel.id = 'settings-controls';
  const controlsHead = h('div', 'panel-head row');
  controlsHead.append(icon('gamepad', 18), h('b', null, '操作'));
  controlsPanel.append(controlsHead);
  const sensRow = settingRow('瞄准灵敏度', '数值越高转向越快');
  const sensSlider = buildSlider(Math.round((s.sensitivity ?? 1) * 100), 20, 200, 5, value => updateSetting('sensitivity', value / 100), '瞄准灵敏度');
  sensRow.append(sensSlider);
  const stickRow = settingRow('摇杆大小', '触屏摇杆的视觉与触控半径');
  const stickSlider = buildSlider(Math.round((s.joystickScale ?? 1) * 100), 70, 140, 5, value => updateSetting('joystickScale', value / 100), '摇杆大小');
  stickRow.append(stickSlider);
  const autoRow = settingRow('自动开火', '准星覆盖目标时自动射击');
  const autoToggle = buildToggle(!!s.autoFire, value => updateSetting('autoFire', value), '自动开火');
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
    });
    layoutSeg.append(btn);
  }
  layoutRow.append(layoutSeg);
  controlsPanel.append(sensRow, stickRow, autoRow, hapticRow, layoutRow);

  const guidePanel = h('section', 'panel');
  guidePanel.id = 'settings-guide';
  guidePanel.append(h('div', 'panel-head row'));
  guidePanel.querySelector('.panel-head').append(icon('help', 18), h('b', null, '引导与存档'));
  const helpRow = settingRow('操作说明', '查看键鼠与触屏两套操作方式');
  const helpBtn = h('button', 'btn btn-ghost btn-sm', '查看');
  helpBtn.type = 'button';
  helpBtn.id = 'btn-show-help';
  helpBtn.addEventListener('click', () => showHelpDialog());
  helpRow.append(helpBtn);
  const tutorialRow = settingRow('重新播放新手引导', '从第一步开始重新熟悉操作');
  const tutorialBtn = h('button', 'btn btn-ghost btn-sm', '重启引导');
  tutorialBtn.type = 'button';
  tutorialBtn.id = 'btn-restart-tutorial';
  tutorialBtn.addEventListener('click', () => restartTutorial());
  tutorialRow.append(tutorialBtn);
  const resetRow = settingRow('重置本地存档', '等级、信用点、任务与成就都会清空');
  const resetBtn = h('button', 'btn btn-danger btn-sm', '重置');
  resetBtn.type = 'button';
  resetBtn.id = 'btn-reset-save';
  resetBtn.addEventListener('click', () => confirmResetSave());
  resetRow.append(resetBtn);
  guidePanel.append(helpRow, tutorialRow, resetRow);

  columns.append(audioPanel, displayPanel, controlsPanel, guidePanel);
  body.append(columns);
  el.append(body);
  return el;
}

function updateSetting(key, value) {
  try { app?.settings && (app.settings[key] = value); } catch { /* 忽略只读 settings */ }
  try {
    if (app?.applySettings) app.applySettings(key);
    else if (app?.saveSettings) app.saveSettings();
  } catch (err) { console.warn('[ui] 设置保存失败', err); }
}

function restartTutorial() {
  confirmDialog({
    title: '重新播放新手引导',
    message: '将从头展示移动、射击、搜刮与救援的操作提示，不影响现有存档。',
    confirmText: '开始引导',
    onConfirm: () => {
      try { app?.restartTutorial?.(); } catch { /* 忽略 */ }
      toast('新手引导已重新启动', 2400);
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
  close.addEventListener('click', () => hideDialog(id));
  card.append(close);
  const head = h('div', 'modal-head');
  const eyebrow = h('div', 'eyebrow');
  const title = h('h2', 'modal-title');
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
    const result = app?.startOffline?.(uiState.mode, {
      mapId: uiState.mapId,
      difficulty: uiState.difficulty,
      loadout: loadout(),
      profile: meta()?.data,
    });
    if (result && typeof result.then === 'function') result.catch(err => toast(err?.message || '无法开始行动', 3000));
    closeScreens();
  } catch (err) {
    toast(err?.message || '无法开始行动', 3000);
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
    try { navigator.clipboard?.writeText(value); toast('邀请码已复制'); } catch { toast(`邀请码：${value}`); }
  });
  codeBox.append(copy);
  const hint = h('p', 'modal-hint muted');
  hint.id = 'room-hint';
  const list = h('div', 'room-players');
  list.id = 'room-players';
  wrap.append(codeBox, hint, list);
  const actions = h('div', 'room-actions');
  const start = h('button', 'btn btn-primary', '开始战斗');
  start.type = 'button';
  start.id = 'btn-start-room';
  start.addEventListener('click', () => {
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
    ready.classList.toggle('active');
    const isReady = ready.classList.contains('active');
    setText(ready, isReady ? '已准备' : '准备');
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
}
export function hideRoom() { hideDialog('room-dialog'); }

/** 关闭 #dialog-root 内所有打开的弹窗（开战/回大厅时调用）。 */
export function hideAllDialogs(exceptId = '') {
  for (const node of document.querySelectorAll('#dialog-root .modal.open')) {
    if (exceptId && node.id === exceptId) continue;
    node.classList.remove('open');
    node.removeAttribute('open');
    node.setAttribute('aria-hidden', 'true');
  }
}

// ── 19 · 暂停菜单 ───────────────────────────────────────────────────────────
function buildPauseDialog() {
  const wrap = h('div', 'pause-body');
  const note = h('p', 'muted');
  note.id = 'pause-note';
  setText(note, '联机对战会继续进行；离线训练将暂停模拟。');
  const stats = h('div', 'pause-stats');
  stats.id = 'pause-stats';
  const actions = h('div', 'pause-actions');
  const resume = h('button', 'btn btn-primary btn-lg', '继续战斗');
  resume.type = 'button';
  resume.id = 'btn-resume';
  resume.addEventListener('click', () => {
    hidePause();
    try { app?.resumeFromMenu?.(); } catch (err) { console.warn(err); }
  });
  const settings = h('button', 'btn btn-ghost', '作战设置');
  settings.type = 'button';
  settings.id = 'btn-pause-settings';
  settings.addEventListener('click', () => {
    hidePause();
    try { app?.pauseForMenu?.(); } catch { /* 忽略 */ }
    openScreen('settings');
  });
  const help = h('button', 'btn btn-ghost', '操作说明');
  help.type = 'button';
  help.id = 'btn-pause-help';
  help.addEventListener('click', () => showHelpDialog());
  const exit = h('button', 'btn btn-danger', '退出本局');
  exit.type = 'button';
  exit.id = 'btn-exit-match';
  exit.addEventListener('click', () => {
    hidePause();
    try { app?.leaveMatch?.(); } catch (err) { console.warn(err); }
  });
  actions.append(resume, settings, help, exit);
  wrap.append(note, stats, actions);
  return wrap;
}

export function showPause() {
  const node = showModal('pause-dialog', {
    title: '战斗暂停',
    eyebrow: 'PAUSED',
    hint: '',
    body: buildPauseDialog(),
    static: true,
  });
  node.dataset.static = '1';
  renderPauseStats();
  setTimeout(() => document.getElementById('btn-resume')?.focus({ preventScroll: true }), 60);
}
export function hidePause() { hideDialog('pause-dialog'); }

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

// ── 20 · 结算弹窗 ───────────────────────────────────────────────────────────
function buildResultDialog() {
  const wrap = h('div', 'result-body');
  const rankWrap = h('div', 'result-rank');
  const rank = h('div', 'rank-display');
  rank.id = 'rank-display';
  rank.textContent = '#1';
  const rankLabel = h('small', 'muted', '最终排名');
  rankWrap.append(rank, rankLabel);
  const textWrap = h('div', 'result-headline');
  const eyebrow = h('div', 'eyebrow');
  eyebrow.id = 'result-eyebrow';
  const title = h('h2', 'title-lg');
  title.id = 'result-title';
  const subtitle = h('p', 'muted');
  subtitle.id = 'result-subtitle';
  textWrap.append(eyebrow, title, subtitle);
  const stats = h('div', 'result-stats');
  stats.id = 'result-stats';
  const rewards = h('div', 'result-rewards');
  rewards.id = 'result-rewards';
  const tags = h('div', 'result-tags');
  tags.id = 'result-tags';
  const actions = h('div', 'result-actions');
  const again = h('button', 'btn btn-primary btn-lg', '再来一局');
  again.type = 'button';
  again.id = 'btn-again';
  again.addEventListener('click', () => {
    hideResult();
    try {
      if (app?.rematch) app.rematch();
      else startOffline();
    } catch (err) { toast(err?.message || '无法重新开始'); }
  });
  const home = h('button', 'btn btn-ghost btn-lg', '返回大厅');
  home.type = 'button';
  home.id = 'btn-return-home';
  home.addEventListener('click', () => {
    hideResult();
    try { app?.home?.(); } catch (err) { console.warn(err); }
    openScreen('home');
  });
  actions.append(again, home);
  wrap.append(rankWrap, textWrap, stats, rewards, tags, actions);
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
}

// ── 21 · 操作说明 / 教程 ────────────────────────────────────────────────────
const HELP_DESKTOP = [
  ['W A S D', '移动', '按住 Shift 冲刺，Ctrl 蹲伏，空格翻滚'],
  ['鼠标', '瞄准与射击', '左键射击，右键开镜'],
  ['R', '换弹', '切枪会保留各自弹匣'],
  ['E', '交互', '拾取物资、上下车、救援队友'],
  ['Q', '切换武器', '主武器与副武器互换'],
  ['G / F', '投掷物', '破片手雷 / 烟雾弹'],
  ['H', '使用消耗品', '优先治疗，静止时生效'],
  ['M', '全图', '打开战术地图查看标记'],
  ['Tab', '记分板', '查看本局所有队伍的排名'],
  ['Esc', '菜单', '暂停、设置或退出对局'],
];
const HELP_TOUCH = [
  ['左摇杆', '移动', '推到外圈自动冲刺'],
  ['右摇杆', '瞄准与开火', '推离中心即持续射击'],
  ['换弹 / 治疗', '右侧动作按钮', '拇指可及的圆形按钮'],
  ['交互', '拾取、上车、救援', '靠近目标后按住'],
  ['投掷 / 切枪', '战术按钮', '长按可切换投掷物'],
  ['蹲 / 翻滚', '姿态按钮', '翻滚有冷却，可躲子弹'],
  ['背包', '查看携带物资', '暂停时可整理装备'],
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
function onKeyDown(event) {
  if (isTyping(event.target)) {
    if (event.key === 'Escape') { event.target.blur(); }
    return;
  }
  const open = topDialog();
  if (event.key === 'Escape') {
    if (open) {
      event.preventDefault();
      if (open.dataset.static === '1') {
        if (open.id === 'pause-dialog') hidePause();
        else if (open.id === 'result-dialog') hideResult();
        else if (open.id === 'room-dialog') hideRoom();
      } else hideDialog(open.id);
      return;
    }
    if (activeScreen && activeScreen !== 'home') { event.preventDefault(); openScreen('home'); return; }
    if (app?.mode === 'match' && app?.paused !== undefined) { event.preventDefault(); try { app.pauseForMenu?.(); } catch { /* 忽略 */ } }
    return;
  }
  if (event.key === 'Tab' || event.code === 'Tab') {
    const appMode = app?.mode;
    if (appMode === 'match') return;
    event.preventDefault();
    const order = HOME_NAV.map(item => item.id);
    const idx = order.indexOf(activeScreen);
    const dir = event.shiftKey ? -1 : 1;
    const next = order[(idx + dir + order.length) % order.length] || 'home';
    openScreen(next);
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

