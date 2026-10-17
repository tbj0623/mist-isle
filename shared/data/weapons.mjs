// 雾岛突围 / MIST ISLE — 武器数据（共享唯一事实来源，服务端与客户端同构）
// 设计基线：无甲 100 HP；TTK ≈ (击杀所需命中数 - 1) × interval（首发视为 0 秒）。
// 字段单位：damage=点/发（霰弹为单颗弹丸伤害）、interval=射击间隔秒、range=米、spread=基准散布弧度、
//           recoil=每发后坐强度、moveMul=举枪/持枪移动速度倍率、adsZoom=开镜倍率、noise=枪声暴露半径系数。
// 可选字段：burst=点射发数、falloff={start,keep}=超过射程 start 比例后线性衰减至射程末端的 keep 倍伤害、
//           headshotMul=爆头倍率（缺省用 rules.COMBAT.headshotMul=1.8）。
// 平衡原则：伤害(命中数) 决定 TTK 档位，射速决定容错，散布/后坐/射程决定交战距离，配件做小幅修正。

export const AMMO_TYPES = {
  light: { id: 'light', name: '手枪弹', color: 0xd8d3a2, pickup: 45, cap: 300 },
  medium: { id: 'medium', name: '步枪弹', color: 0xc9b07a, pickup: 30, cap: 240 },
  heavy: { id: 'heavy', name: '重型弹', color: 0xb08a6a, pickup: 15, cap: 150 },
  shell: { id: 'shell', name: '霰弹', color: 0xd06a4f, pickup: 12, cap: 96 },
  bolt: { id: 'bolt', name: '弩箭', color: 0x8fb6a8, pickup: 12, cap: 96 },
};

export const WEAPON_CLASSES = {
  pistol: { name: '手枪', icon: '▸', color: 0xc9d2cb, desc: '落地即用的保命家伙，负重最低。' },
  smg: { name: '冲锋枪', icon: '▹', color: 0x8fd6c0, desc: '高射速近战利器，中距离伤害衰减明显。' },
  rifle: { name: '突击步枪', icon: '▰', color: 0xe0b56a, desc: '全能主力，交战距离与容错最均衡。' },
  shotgun: { name: '霰弹枪', icon: '▣', color: 0xd06a4f, desc: '贴脸即决，越远越无力。' },
  marksman: { name: '精准步枪', icon: '⊹', color: 0x9ec8e8, desc: '中远距离单点压制，考验节奏。' },
  sniper: { name: '狙击枪', icon: '✛', color: 0xc48bf0, desc: '一枪定生死，代价是极慢的节奏。' },
  lmg: { name: '机枪', icon: '▤', color: 0xa9b89a, desc: '大弹容持续压制，换弹时最脆弱。' },
  special: { name: '特种', icon: '◈', color: 0x8fb6a8, desc: '规则之外的选择，用得好就是奇招。' },
};

export const WEAPONS = {
  // ── 手枪 ────────────────────────────────────────────────
  p9: {
    id: 'p9', name: 'P9 手枪', short: 'P9', cls: 'pistol', ammo: 'light',
    damage: 26, interval: 0.30, magazine: 15, reload: 1.25,
    spread: 0.030, recoil: 0.7, range: 34, pellets: 1, auto: false,
    moveMul: 1.05, adsZoom: 1.15, noise: 0.85, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['muzzle', 'mag'], headshotMul: 1.7,
    falloff: { start: 0.5, keep: 0.5 },
    art: { len: 0.55, body: 0x3c4a4f, accent: 0x9a7a4b, size: 0.9 },
    desc: '可靠的制式手枪，弹匣随处可见，落地就能打。',
  },
  p226: {
    id: 'p226', name: 'P226 重手枪', short: 'P226', cls: 'pistol', ammo: 'light',
    damage: 34, interval: 0.42, magazine: 12, reload: 1.40,
    spread: 0.034, recoil: 1.1, range: 38, pellets: 1, auto: false,
    moveMul: 1.02, adsZoom: 1.20, noise: 0.95, rarity: 'uncommon', tier: 1,
    unlock: 2, price: 260, slots: ['optic', 'muzzle', 'mag'], headshotMul: 1.8,
    falloff: { start: 0.55, keep: 0.55 },
    art: { len: 0.62, body: 0x2f3a3d, accent: 0xb08a5a, size: 1.0 },
    desc: '大口径重手枪，三发就能放倒轻甲，代价是换弹偏慢。',
  },
  // ── 冲锋枪 ──────────────────────────────────────────────
  v9: {
    id: 'v9', name: 'V9 冲锋枪', short: 'V9', cls: 'smg', ammo: 'light',
    damage: 15, interval: 0.085, magazine: 30, reload: 1.60,
    spread: 0.040, recoil: 0.8, range: 26, pellets: 1, auto: true,
    moveMul: 1.00, adsZoom: 1.05, noise: 0.80, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['optic', 'muzzle', 'mag'], headshotMul: 1.5,
    falloff: { start: 0.45, keep: 0.35 },
    art: { len: 0.78, body: 0x39484b, accent: 0x8f7a4f, size: 1.0 },
    desc: '便宜耐用的老式冲锋枪，巷战里从不会让你失望。',
  },
  mp5k: {
    id: 'mp5k', name: 'MP5K 紧凑冲锋枪', short: 'MP5K', cls: 'smg', ammo: 'light',
    damage: 13, interval: 0.075, magazine: 30, reload: 1.50,
    spread: 0.036, recoil: 0.72, range: 30, pellets: 1, auto: true,
    moveMul: 1.02, adsZoom: 1.10, noise: 0.78, rarity: 'uncommon', tier: 2,
    unlock: 4, price: 520, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.5,
    falloff: { start: 0.48, keep: 0.38 },
    art: { len: 0.68, body: 0x2e3b40, accent: 0x7f8c85, size: 0.95 },
    desc: '紧凑枪身、平顺后坐，室内清点的标准答案。',
  },
  vector: {
    id: 'vector', name: 'Vector 高速冲锋枪', short: 'VEC', cls: 'smg', ammo: 'light',
    damage: 13, interval: 0.058, magazine: 25, reload: 1.70,
    spread: 0.045, recoil: 0.9, range: 22, pellets: 1, auto: true,
    moveMul: 1.00, adsZoom: 1.02, noise: 0.82, rarity: 'rare', tier: 2,
    unlock: 8, price: 940, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.45,
    falloff: { start: 0.35, keep: 0.25 },
    art: { len: 0.72, body: 0x39424f, accent: 0xc8a24e, size: 1.0 },
    desc: '射速快到近乎失控，贴身三米内它就是判决。',
  },
  // ── 突击步枪 ────────────────────────────────────────────
  ar7: {
    id: 'ar7', name: 'AR7 突击步枪', short: 'AR7', cls: 'rifle', ammo: 'medium',
    damage: 26, interval: 0.105, magazine: 30, reload: 1.90,
    spread: 0.026, recoil: 1.0, range: 52, pellets: 1, auto: true,
    moveMul: 0.95, adsZoom: 1.35, noise: 1.05, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.75,
    falloff: { start: 0.60, keep: 0.58 },
    art: { len: 1.00, body: 0x3a4742, accent: 0x8f7a45, size: 1.1 },
    desc: '全岛最常见的步枪，没有惊喜，也从不掉链子。',
  },
  ak12: {
    id: 'ak12', name: 'AK12 重突击步枪', short: 'AK12', cls: 'rifle', ammo: 'medium',
    damage: 33, interval: 0.130, magazine: 30, reload: 2.15,
    spread: 0.036, recoil: 1.55, range: 54, pellets: 1, auto: true,
    moveMul: 0.92, adsZoom: 1.30, noise: 1.20, rarity: 'uncommon', tier: 2,
    unlock: 5, price: 760, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.8,
    falloff: { start: 0.62, keep: 0.60 },
    art: { len: 1.05, body: 0x4a3f33, accent: 0xa86a3f, size: 1.15 },
    desc: '重弹头、硬后坐，三发就能把人按进土里。',
  },
  bullpup: {
    id: 'bullpup', name: 'BULLPUP 无托步枪', short: 'BP', cls: 'rifle', ammo: 'medium',
    damage: 24, interval: 0.075, magazine: 30, reload: 1.85, burst: 3,
    spread: 0.030, recoil: 0.85, range: 48, pellets: 1, auto: false,
    moveMul: 0.98, adsZoom: 1.28, noise: 1.00, rarity: 'rare', tier: 3,
    unlock: 12, price: 1180, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.8,
    falloff: { start: 0.60, keep: 0.55 },
    art: { len: 0.98, body: 0x42504a, accent: 0x6f9a8a, size: 1.1 },
    desc: '无托结构换来极限控枪，三点射就是它的语言。',
  },
};

export const WEAPON_ORDER = [
  'p9', 'p226', 'v9', 'mp5k', 'vector',
  'ar7', 'ak12', 'bullpup',
  's12', 'aa12',
  'm14', 'svd',
  'sr338', 'awm',
  'm60', 'pkm',
  'crossbow', 'scout',
];
