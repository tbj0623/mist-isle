// 雾岛突围 / MIST ISLE — 武器数据（共享唯一事实来源，服务端与客户端同构）
// ─────────────────────────────────────────────────────────────────────────────
// 平衡口径：无甲 100 HP。TTK = (命中数 - 1) × interval，首发记 0 秒；霰弹按全弹丸命中计。
//   手枪 3-4 发 ｜ 冲锋枪 6-8 发 ｜ 步枪 3-5 发 ｜ 霰弹 近距 2 发 ｜ 机枪 5-7 发 ｜ 狙击 1-2 发
// 设计分工：伤害决定 TTK 档位，射速决定容错，散布/后坐/衰减决定「这把枪该在几米开外开火」。
// 表中数值即最终有效值（rarity 只影响掉落权重/配色）；若 simulation 需要按掉落稀有度缩放，
// 请用 loot 条目的 rarity 乘 rules.RARITY_STAT_MUL，不要二次缩放本表。
// 字段：damage=单发（霰弹=单颗弹丸）、interval=射击间隔秒、range=米、spread=弧度、noise=枪声暴露系数、
//       moveMul=持枪移动倍率、adsZoom=开镜倍率；可选 burst=点射发数、falloff={start,keep}、headshotMul。
// ─────────────────────────────────────────────────────────────────────────────

export const AMMO_TYPES = {
  light: { id: 'light', name: '手枪弹', color: 0xd8d3a2, pickup: 45, cap: 300 },
  medium: { id: 'medium', name: '步枪弹', color: 0xc9b07a, pickup: 30, cap: 240 },
  heavy: { id: 'heavy', name: '重型弹', color: 0xb08a6a, pickup: 15, cap: 150 },
  shell: { id: 'shell', name: '霰弹', color: 0xd06a4f, pickup: 12, cap: 96 },
  bolt: { id: 'bolt', name: '弩箭', color: 0x8fb6a8, pickup: 12, cap: 96 },
};

export const WEAPON_CLASSES = {
  pistol: { name: '手枪', icon: '▸', color: 0xc9d2cb, desc: '落地即用的保命家伙，负重最低、换枪最快。' },
  smg: { name: '冲锋枪', icon: '▹', color: 0x8fd6c0, desc: '高射速近战利器，出了十米就开始掉伤害。' },
  rifle: { name: '突击步枪', icon: '▰', color: 0xe0b56a, desc: '全能主力，交战距离与容错最均衡。' },
  shotgun: { name: '霰弹枪', icon: '▣', color: 0xd06a4f, desc: '贴脸即决，越远越像在撒豆子。' },
  marksman: { name: '精准步枪', icon: '⊹', color: 0x9ec8e8, desc: '中远距离单点压制，考验节奏与呼吸。' },
  sniper: { name: '狙击枪', icon: '✛', color: 0xc48bf0, desc: '一枪定生死，代价是慢到几乎奢侈的节奏。' },
  lmg: { name: '机枪', icon: '▤', color: 0xa9b89a, desc: '大弹容持续压制，换弹时是你唯一的破绽。' },
  special: { name: '特种', icon: '◈', color: 0x8fb6a8, desc: '规则之外的选择，用得好就是奇招。' },
};

export const WEAPONS = {
  // ── 手枪 ────────────────────────────────────────────────────────────────
  p9: {
    id: 'p9', name: 'P9 手枪', short: 'P9', cls: 'pistol', ammo: 'light',
    damage: 26, interval: 0.30, magazine: 15, reload: 1.25,
    spread: 0.030, recoil: 0.7, range: 34, pellets: 1, auto: false,
    moveMul: 1.05, adsZoom: 1.15, noise: 0.85, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['muzzle', 'mag'], headshotMul: 1.7,
    falloff: { start: 0.50, keep: 0.50 },
    art: { len: 0.55, body: 0x3c4a4f, accent: 0x9a7a4b, size: 0.9 },
    desc: '可靠的制式手枪，弹匣随处可见，落地就能打。',
  },
  p226: {
    id: 'p226', name: 'P226 重手枪', short: 'P226', cls: 'pistol', ammo: 'light',
    damage: 35, interval: 0.42, magazine: 12, reload: 1.40,
    spread: 0.034, recoil: 1.1, range: 38, pellets: 1, auto: false,
    moveMul: 1.02, adsZoom: 1.20, noise: 0.95, rarity: 'uncommon', tier: 1,
    unlock: 2, price: 260, slots: ['optic', 'muzzle', 'mag'], headshotMul: 1.8,
    falloff: { start: 0.55, keep: 0.55 },
    art: { len: 0.62, body: 0x2f3a3d, accent: 0xb08a5a, size: 1.0 },
    desc: '大口径重手枪，三发就能放倒轻甲，代价是换弹偏慢。',
  },
  // ── 冲锋枪 ──────────────────────────────────────────────────────────────
  v9: {
    id: 'v9', name: 'V9 冲锋枪', short: 'V9', cls: 'smg', ammo: 'light',
    damage: 15, interval: 0.085, magazine: 30, reload: 1.60,
    spread: 0.040, recoil: 0.80, range: 26, pellets: 1, auto: true,
    moveMul: 1.00, adsZoom: 1.05, noise: 0.80, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['optic', 'muzzle', 'mag'], headshotMul: 1.5,
    falloff: { start: 0.45, keep: 0.35 },
    art: { len: 0.78, body: 0x39484b, accent: 0x8f7a4f, size: 1.0 },
    desc: '便宜耐用的老式冲锋枪，巷战里从不会让你失望。',
  },
  mp5k: {
    id: 'mp5k', name: 'MP5K 紧凑冲锋枪', short: 'MP5K', cls: 'smg', ammo: 'light',
    damage: 14, interval: 0.072, magazine: 30, reload: 1.50,
    spread: 0.036, recoil: 0.72, range: 30, pellets: 1, auto: true,
    moveMul: 1.02, adsZoom: 1.10, noise: 0.78, rarity: 'uncommon', tier: 2,
    unlock: 4, price: 520, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.5,
    falloff: { start: 0.48, keep: 0.38 },
    art: { len: 0.68, body: 0x2e3b40, accent: 0x7f8c85, size: 0.95 },
    desc: '紧凑枪身、平顺后坐，室内清点的标准答案。',
  },
  vector: {
    id: 'vector', name: 'Vector 高速冲锋枪', short: 'VEC', cls: 'smg', ammo: 'light',
    damage: 14, interval: 0.062, magazine: 25, reload: 1.70,
    spread: 0.045, recoil: 0.90, range: 22, pellets: 1, auto: true,
    moveMul: 1.00, adsZoom: 1.02, noise: 0.82, rarity: 'rare', tier: 2,
    unlock: 8, price: 940, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.45,
    falloff: { start: 0.35, keep: 0.25 },
    art: { len: 0.72, body: 0x39424f, accent: 0xc8a24e, size: 1.0 },
    desc: '射速快到近乎失控，贴身八米内它就是判决书。',
  },
  // ── 突击步枪 ────────────────────────────────────────────────────────────
  ar7: {
    id: 'ar7', name: 'AR7 突击步枪', short: 'AR7', cls: 'rifle', ammo: 'medium',
    damage: 26, interval: 0.105, magazine: 30, reload: 1.90,
    spread: 0.026, recoil: 1.00, range: 52, pellets: 1, auto: true,
    moveMul: 0.95, adsZoom: 1.35, noise: 1.05, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.75,
    falloff: { start: 0.66, keep: 0.60 },
    art: { len: 1.00, body: 0x3a4742, accent: 0x8f7a45, size: 1.1 },
    desc: '全岛最常见的步枪，没有惊喜，也从不掉链子。',
  },
  ak12: {
    id: 'ak12', name: 'AK12 重突击步枪', short: 'AK12', cls: 'rifle', ammo: 'medium',
    damage: 34, interval: 0.150, magazine: 30, reload: 2.15,
    spread: 0.036, recoil: 1.55, range: 54, pellets: 1, auto: true,
    moveMul: 0.92, adsZoom: 1.30, noise: 1.20, rarity: 'uncommon', tier: 2,
    unlock: 5, price: 760, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.8,
    falloff: { start: 0.55, keep: 0.55 },
    art: { len: 1.05, body: 0x4a3f33, accent: 0xa86a3f, size: 1.15 },
    desc: '重弹头、硬后坐，三发就能把人按进土里。',
  },
  bullpup: {
    id: 'bullpup', name: 'BULLPUP 无托步枪', short: 'BP', cls: 'rifle', ammo: 'medium',
    damage: 23, interval: 0.078, magazine: 30, reload: 1.85, burst: 3,
    spread: 0.028, recoil: 0.75, range: 50, pellets: 1, auto: false,
    moveMul: 0.98, adsZoom: 1.28, noise: 1.00, rarity: 'rare', tier: 3,
    unlock: 12, price: 1180, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.8,
    falloff: { start: 0.70, keep: 0.62 },
    art: { len: 0.98, body: 0x42504a, accent: 0x6f9a8a, size: 1.1 },
    desc: '无托结构换来极限控枪，三点射就是它的语言。',
  },
  // ── 霰弹枪 ──────────────────────────────────────────────────────────────
  s12: {
    id: 's12', name: 'S12 泵动霰弹', short: 'S12', cls: 'shotgun', ammo: 'shell',
    damage: 12, interval: 0.85, magazine: 6, reload: 3.10,
    spread: 0.105, recoil: 2.2, range: 15, pellets: 9, auto: false,
    moveMul: 0.94, adsZoom: 1.10, noise: 1.15, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['muzzle', 'mag', 'grip'], headshotMul: 1.5,
    falloff: { start: 0.30, keep: 0.16 },
    art: { len: 1.05, body: 0x3d3a33, accent: 0x8a6a45, size: 1.1 },
    desc: '一格一格上膛的节奏感，贴脸时就是最硬的道理。',
  },
  aa12: {
    id: 'aa12', name: 'AA12 自动霰弹', short: 'AA12', cls: 'shotgun', ammo: 'shell',
    damage: 10, interval: 0.34, magazine: 8, reload: 2.80,
    spread: 0.125, recoil: 2.8, range: 13, pellets: 8, auto: true,
    moveMul: 0.90, adsZoom: 1.05, noise: 1.30, rarity: 'epic', tier: 3,
    unlock: 18, price: 1680, slots: ['muzzle', 'mag'], headshotMul: 1.4,
    falloff: { start: 0.26, keep: 0.13 },
    art: { len: 1.12, body: 0x33383a, accent: 0xc06a45, size: 1.15 },
    desc: '扣住扳机就没人能站着走近，代价是凶猛的吃弹速度。',
  },
  // ── 精准步枪 ────────────────────────────────────────────────────────────
  m14: {
    id: 'm14', name: 'M14 精准步枪', short: 'M14', cls: 'marksman', ammo: 'medium',
    damage: 44, interval: 0.24, magazine: 10, reload: 2.30,
    spread: 0.016, recoil: 1.7, range: 68, pellets: 1, auto: false,
    moveMul: 0.95, adsZoom: 1.60, noise: 1.15, rarity: 'uncommon', tier: 2,
    unlock: 6, price: 820, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.9,
    falloff: { start: 0.70, keep: 0.70 },
    art: { len: 1.10, body: 0x4a3d2f, accent: 0x9c7f52, size: 1.1 },
    desc: '老式半自动步枪，节奏沉稳，专治探头探脑。',
  },
  svd: {
    id: 'svd', name: 'SVD 半自动狙击', short: 'SVD', cls: 'marksman', ammo: 'heavy',
    damage: 62, interval: 0.40, magazine: 10, reload: 2.60,
    spread: 0.010, recoil: 2.4, range: 78, pellets: 1, auto: false,
    moveMul: 0.88, adsZoom: 2.00, noise: 1.35, rarity: 'rare', tier: 3,
    unlock: 14, price: 1420, slots: ['optic', 'muzzle', 'mag'], headshotMul: 2.0,
    falloff: { start: 0.74, keep: 0.75 },
    art: { len: 1.22, body: 0x3f4a3c, accent: 0x8d9a6a, size: 1.15 },
    desc: '半自动的连续压制，让对手没有第二次抬头的机会。',
  },
  // ── 狙击枪 ──────────────────────────────────────────────────────────────
  sr338: {
    id: 'sr338', name: 'SR338 栓动狙击', short: 'SR338', cls: 'sniper', ammo: 'heavy',
    damage: 92, interval: 1.05, magazine: 5, reload: 3.20,
    spread: 0.007, recoil: 3.2, range: 96, pellets: 1, auto: false,
    moveMul: 0.82, adsZoom: 2.60, noise: 1.55, rarity: 'epic', tier: 3,
    unlock: 16, price: 1900, slots: ['optic', 'muzzle', 'mag'], headshotMul: 2.1,
    falloff: { start: 0.78, keep: 0.80 },
    art: { len: 1.34, body: 0x37424a, accent: 0x7fa3b8, size: 1.2 },
    desc: '栓动上膛的一声轻响，决定了下一百米归谁。',
  },
  awm: {
    id: 'awm', name: 'AWM 重型栓动', short: 'AWM', cls: 'sniper', ammo: 'heavy',
    damage: 118, interval: 1.50, magazine: 4, reload: 3.70,
    spread: 0.005, recoil: 4.0, range: 112, pellets: 1, auto: false,
    moveMul: 0.78, adsZoom: 3.00, noise: 1.75, rarity: 'legendary', tier: 3,
    unlock: 24, price: 2600, slots: ['optic', 'muzzle', 'mag'], headshotMul: 2.2,
    falloff: { start: 0.82, keep: 0.85 },
    art: { len: 1.46, body: 0x2f3a3f, accent: 0xd8b45e, size: 1.3 },
    desc: '重到让人不想背，但它在哑火之前从不说第二次。',
  },
  // ── 机枪 ────────────────────────────────────────────────────────────────
  m60: {
    id: 'm60', name: 'M60 轻机枪', short: 'M60', cls: 'lmg', ammo: 'medium',
    damage: 18, interval: 0.095, magazine: 60, reload: 4.30,
    spread: 0.040, recoil: 1.5, range: 58, pellets: 1, auto: true,
    moveMul: 0.86, adsZoom: 1.25, noise: 1.25, rarity: 'rare', tier: 2,
    unlock: 10, price: 1250, slots: ['optic', 'muzzle'], headshotMul: 1.6,
    falloff: { start: 0.62, keep: 0.58 },
    art: { len: 1.28, body: 0x3c4a3f, accent: 0x9a8a5a, size: 1.2 },
    desc: '六十发弹链就是你的底气，换弹那四秒是你的葬礼。',
  },
  pkm: {
    id: 'pkm', name: 'PKM 重机枪', short: 'PKM', cls: 'lmg', ammo: 'heavy',
    damage: 22, interval: 0.110, magazine: 75, reload: 5.20,
    spread: 0.048, recoil: 2.2, range: 64, pellets: 1, auto: true,
    moveMul: 0.80, adsZoom: 1.20, noise: 1.40, rarity: 'epic', tier: 3,
    unlock: 20, price: 2100, slots: ['optic', 'muzzle', 'grip'], headshotMul: 1.7,
    falloff: { start: 0.64, keep: 0.60 },
    art: { len: 1.36, body: 0x463f35, accent: 0xa8683f, size: 1.25 },
    desc: '弹雨能压住整条街，可它从不会替你跑路。',
  },
  // ── 特种 ────────────────────────────────────────────────────────────────
  crossbow: {
    id: 'crossbow', name: '十字弩', short: 'XBOW', cls: 'special', ammo: 'bolt',
    damage: 100, interval: 1.35, magazine: 1, reload: 2.20,
    spread: 0.006, recoil: 1.0, range: 44, pellets: 1, auto: false,
    moveMul: 1.00, adsZoom: 1.80, noise: 0.12, rarity: 'rare', tier: 3,
    unlock: 15, price: 1350, slots: ['optic', 'grip'], headshotMul: 2.0,
    falloff: { start: 0.76, keep: 0.74 },
    art: { len: 0.95, body: 0x3b4a40, accent: 0x8fb6a8, size: 1.05 },
    desc: '没有枪声的死刑，飞行的弩矢比子弹更懂耐心。',
  },
  scout: {
    id: 'scout', name: 'Scout 侦察步枪', short: 'SCOUT', cls: 'special', ammo: 'medium',
    damage: 30, interval: 0.22, magazine: 12, reload: 1.45,
    spread: 0.020, recoil: 0.90, range: 60, pellets: 1, auto: false,
    moveMul: 1.12, adsZoom: 1.55, noise: 0.95, rarity: 'epic', tier: 3,
    unlock: 22, price: 2000, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 2.0,
    falloff: { start: 0.68, keep: 0.64 },
    art: { len: 0.86, body: 0x445049, accent: 0xc8b48a, size: 0.95 },
    desc: '轻得像没带枪，跑位与枪法在这里是同一件事。',
  },
};

// 配件：mods 为相对修正系数。
//   spread / interval / reload / recoil / range / damage / magazine：乘算（-0.1 = ×0.9）
//   adsZoom / adsTime：加算（+0.10 = +0.10 倍 / +0.10 秒）
export const ATTACHMENTS = {
  red_dot: {
    id: 'red_dot', name: '红点镜', short: '红点', slot: 'optic', rarity: 'common',
    unlock: 1, price: 0, mods: { adsZoom: 0.12, spread: -0.10, range: 0.05 },
    desc: '清晰的单点准星，近中距离抬枪就打。',
  },
  holo: {
    id: 'holo', name: '全息镜', short: '全息', slot: 'optic', rarity: 'uncommon',
    unlock: 4, price: 320, mods: { adsZoom: 0.18, spread: -0.12, range: 0.04 },
    desc: '大视野全息环，连发时更容易咬住移动目标。',
  },
  scope_4x: {
    id: 'scope_4x', name: '4 倍镜', short: '4×', slot: 'optic', rarity: 'rare',
    unlock: 9, price: 680, mods: { adsZoom: 1.10, spread: -0.20, range: 0.10, adsTime: 0.12 },
    desc: '中远距离点名的标配，开镜要慢半拍。',
  },
  scope_8x: {
    id: 'scope_8x', name: '8 倍镜', short: '8×', slot: 'optic', rarity: 'epic',
    unlock: 15, price: 1250, mods: { adsZoom: 2.20, spread: -0.28, range: 0.16, adsTime: 0.28 },
    desc: '把整片山谷拉到眼前，代价是狭窄的视界。',
  },
  suppressor: {
    id: 'suppressor', name: '消音器', short: '消音', slot: 'muzzle', rarity: 'rare',
    unlock: 8, price: 720, mods: { noise: -0.55, spread: -0.05, damage: -0.04, range: -0.04 },
    desc: '把枪声压成一记闷响，换来一点初速损失。',
  },
  compensator: {
    id: 'compensator', name: '补偿器', short: '补偿', slot: 'muzzle', rarity: 'uncommon',
    unlock: 5, price: 360, mods: { recoil: -0.22, spread: -0.06, noise: 0.06 },
    desc: '向上喷口压住枪口跳动，连发落点明显收紧。',
  },
  muzzle_brake: {
    id: 'muzzle_brake', name: '制退器', short: '制退', slot: 'muzzle', rarity: 'common',
    unlock: 2, price: 180, mods: { recoil: -0.14, noise: 0.12 },
    desc: '简单粗暴的侧向排气，巨响会替你报坐标。',
  },
  choke: {
    id: 'choke', name: '收束器', short: '收束', slot: 'muzzle', rarity: 'uncommon',
    unlock: 3, price: 300, mods: { spread: -0.18, range: 0.12, damage: 0.02 },
    desc: '把弹丸拢成更紧的一束，霰弹的有效距离翻倍。',
  },
  ext_mag: {
    id: 'ext_mag', name: '扩容弹匣', short: '扩容', slot: 'mag', rarity: 'uncommon',
    unlock: 4, price: 340, mods: { magazine: 0.33, reload: 0.08 },
    desc: '多出一个弹匣的余量，代价是换弹慢半拍。',
  },
  quick_mag: {
    id: 'quick_mag', name: '快拔弹匣', short: '快拔', slot: 'mag', rarity: 'rare',
    unlock: 7, price: 640, mods: { reload: -0.22, magazine: -0.08 },
    desc: '打磨过的卡榫让换弹行云流水，弹容略减。',
  },
  drum_mag: {
    id: 'drum_mag', name: '弹鼓', short: '弹鼓', slot: 'mag', rarity: 'epic',
    unlock: 12, price: 980, mods: { magazine: 0.85, reload: 0.30, moveMul: -0.05 },
    desc: '整个弹鼓压进枪里，走起来也更沉了。',
  },
  vertical_grip: {
    id: 'vertical_grip', name: '垂直握把', short: '垂直', slot: 'grip', rarity: 'common',
    unlock: 1, price: 150, mods: { recoil: -0.16, spread: -0.04 },
    desc: '最朴素的改装，也是最有效的压枪手段。',
  },
  angled_grip: {
    id: 'angled_grip', name: '斜角握把', short: '斜角', slot: 'grip', rarity: 'uncommon',
    unlock: 3, price: 280, mods: { recoil: -0.08, spread: -0.10, adsTime: -0.08 },
    desc: '举枪更快、开镜更顺，适合边走边打。',
  },
  bipod: {
    id: 'bipod', name: '两脚架', short: '脚架', slot: 'grip', rarity: 'rare',
    unlock: 6, price: 560, mods: { recoil: -0.34, spread: -0.14, moveMul: -0.08 },
    desc: '架稳之后几乎无后坐，但背着它跑不快。',
  },
};

export const ATTACHMENT_ORDER = [
  'red_dot', 'holo', 'scope_4x', 'scope_8x',
  'suppressor', 'compensator', 'muzzle_brake', 'choke',
  'ext_mag', 'quick_mag', 'drum_mag',
  'vertical_grip', 'angled_grip', 'bipod',
];

export const ATTACHMENT_SLOTS = ['optic', 'muzzle', 'mag', 'grip'];

// 物资档次武器池（低/中/高三档），与 LOOT_TABLES 的 weapon 列保持一致
export const LOOT_WEAPON_POOL = {
  low: ['p9', 'v9', 's12', 'ar7', 'p226', 'm14', 'mp5k'],
  mid: ['v9', 'mp5k', 'ar7', 'ak12', 's12', 'm14', 'm60', 'bullpup'],
  high: ['ak12', 'bullpup', 'vector', 'aa12', 'svd', 'sr338', 'm60', 'pkm', 'crossbow', 'scout', 'awm', 'ar7'],
};

const WEAPON_BY_ID = new Map(Object.entries(WEAPONS));
const ATTACHMENT_BY_ID = new Map(Object.entries(ATTACHMENTS));

export function getWeapon(id) {
  return WEAPON_BY_ID.get(id) || WEAPONS.p9;
}

export function getAttachment(id) {
  return ATTACHMENT_BY_ID.get(id) || null;
}

// 有效属性里的单发总伤害（含弹丸数与爆头倍率）
export function shotDamage(weapon, { headshot = false, distance = 0, rarityMul = 1 } = {}) {
  const w = typeof weapon === 'string' ? getWeapon(weapon) : weapon;
  const perPellet = damageAtDistance(w, distance);
  const total = perPellet * (w.pellets || 1) * (headshot ? (w.headshotMul ?? 1.8) : 1) * rarityMul;
  return Math.round(total * 100) / 100;
}

// 命中数（默认无甲、无爆头、理想距离），霰弹按全弹丸命中
export function hitsToKill(weapon, hp = 100) {
  const w = typeof weapon === 'string' ? getWeapon(weapon) : weapon;
  const perShot = w.damage * (w.pellets || 1);
  return Math.max(1, Math.ceil(hp / Math.max(1, perShot)));
}

// 理论 TTK（秒）：首发射出记 t=0，之后每发间隔 interval
export function timeToKill(weapon, hp = 100) {
  const w = typeof weapon === 'string' ? getWeapon(weapon) : weapon;
  const ttk = (hitsToKill(w, hp) - 1) * w.interval;
  return Math.round(ttk * 1000) / 1000;
}

// 站桩 DPS（不考虑换弹）：damage × 弹丸 × 射速
export function burstDps(weapon) {
  const w = typeof weapon === 'string' ? getWeapon(weapon) : weapon;
  return Math.round((w.damage * (w.pellets || 1)) / w.interval * 10) / 10;
}

// 持续 DPS（含换弹循环）：打完一个满弹匣再换弹平均
export function sustainedDps(weapon) {
  const w = typeof weapon === 'string' ? getWeapon(weapon) : weapon;
  const perShot = w.damage * (w.pellets || 1);
  const mag = Math.max(1, w.magazine);
  const cycle = (mag - 1) * w.interval + w.reload;
  return Math.round(((perShot * mag) / cycle) * 10) / 10;
}

// 单发命中的射程衰减（falloff 未定义时套用 rules.COMBAT 的默认 0.55 → 0.28）
export function damageAtDistance(weapon, distance) {
  const w = typeof weapon === 'string' ? getWeapon(weapon) : weapon;
  const start = w.falloff?.start ?? 0.55;
  const keep = w.falloff?.keep ?? 0.28;
  const span = Math.max(0.01, 1 - start);
  if (!(distance > w.range * start)) return w.damage;
  const t = Math.min(1, (distance / w.range - start) / span);
  return Math.max(w.damage * keep, w.damage * (1 - (1 - keep) * t));
}

// 按配件组合后的「有效属性」；绝不修改传入的 weapon 对象。
// 同类槽只取第一个有效配件；未知 id 或该武器没有的槽位直接忽略。
export function applyAttachmentMods(weapon, attachmentIds = []) {
  const base = typeof weapon === 'string' ? getWeapon(weapon) : weapon;
  const w = base && base.id ? base : WEAPONS.p9;
  const usedSlots = new Set();
  const mods = {};
  const applied = [];
  for (const id of attachmentIds) {
    const att = ATTACHMENT_BY_ID.get(id);
    if (!att || usedSlots.has(att.slot)) continue;
    if (Array.isArray(w.slots) && !w.slots.includes(att.slot)) continue;
    usedSlots.add(att.slot);
    applied.push(att.id);
    for (const [key, val] of Object.entries(att.mods)) mods[key] = (mods[key] || 0) + val;
  }
  const mul = (key) => 1 + (mods[key] || 0);
  const round = (v, p) => Math.round(v * p) / p;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 以原武器为底做浅拷贝（保留 falloff/burst/auto/art 等只读字段），再覆盖修正后的数值。
  return {
    ...w,
    id: w.id,
    cls: w.cls,
    ammo: w.ammo,
    damage: round(w.damage * mul('damage'), 100),
    interval: round(w.interval * mul('interval'), 1000),
    magazine: Math.max(1, Math.round(w.magazine * mul('magazine'))),
    reload: Math.max(0.4, round(w.reload * mul('reload'), 100)),
    spread: Math.max(0.001, round(w.spread * mul('spread'), 10000)),
    recoil: Math.max(0.1, round(w.recoil * mul('recoil'), 100)),
    range: round(w.range * mul('range'), 10),
    adsZoom: round(w.adsZoom + (mods.adsZoom || 0), 100),
    moveMul: clamp(round(w.moveMul * mul('moveMul'), 1000), 0.55, 1.3),
    noise: clamp(round(w.noise * mul('noise'), 100), 0.05, 2),
    headshotMul: w.headshotMul ?? 1.8,
    pellets: w.pellets,
    slots: w.slots,
    attachments: applied,
    mods: { ...mods },
  };
}

export const WEAPON_ORDER = [
  'p9', 'p226', 'v9', 'mp5k', 'vector',
  'ar7', 'ak12', 'bullpup',
  's12', 'aa12',
  'm14', 'svd',
  'sr338', 'awm',
  'm60', 'pkm',
  'crossbow', 'scout',
];
