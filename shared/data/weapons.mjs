// 雾岛突围 / MIST ISLE — 武器数据（共享唯一事实来源，服务端与客户端同构）
// ─────────────────────────────────────────────────────────────────────────────
// 平衡口径：无甲 100 HP。TTK = (命中数 - 1) × interval，首发记 0 秒；霰弹按全弹丸命中计。
//   手枪 3-4 发 ｜ 冲锋枪 6-8 发 ｜ 步枪 3-5 发 ｜ 霰弹 近距 2 发 ｜ 机枪 5-7 发 ｜ 狙击 1-2 发
// 设计分工：伤害决定 TTK 档位，射速决定容错，散布/后坐/衰减决定「这把枪该在几米开外开火」。
// 表中数值即最终有效值（rarity 只影响掉落权重/配色）；若 simulation 需要按掉落稀有度缩放，
// 请用 loot 条目的 rarity 乘 rules.RARITY_STAT_MUL，不要二次缩放本表。
// 字段：damage=单发（霰弹=单颗弹丸）、interval=射击间隔秒、range=米、spread=弧度、noise=枪声暴露系数、
//       moveMul=持枪移动倍率、adsZoom=开镜倍率；可选 burst=点射发数、falloff={start,keep}、headshotMul。
//
// 结算口径：simulation.mjs 实际读取的是 damage / interval / magazine / reload / spread / recoil /
// range / pellets / auto / moveMul / headshotMul / falloff / ammo。noise 与 adsZoom 目前只服务
// 表现层（音频与图鉴的镜头参数），simulation 不结算，也不参与伤害或命中判定；
// 因此配件系统不把它们写进 mods（详见 ATTACHMENTS 区注释）。burst 是手写节奏提示，
// simulation 用 auto=false 要求逐发扣扳机，不读取 burst 字段。
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
    damage: 35, interval: 0.42, magazine: 12, reload: 1.20,
    // 平衡（1.3）：换弹 1.40 → 1.20。旧值让 P226 的持续 DPS（69.8）低于免费 P9（71.6），
    // 花 260 信用点买到的是「更差的面板」。现在 72.2 > 71.6，同类别价格梯度不再倒挂。
    spread: 0.034, recoil: 1.1, range: 38, pellets: 1, auto: false,
    moveMul: 1.02, adsZoom: 1.20, noise: 0.95, rarity: 'uncommon', tier: 1,
    unlock: 2, price: 260, slots: ['optic', 'muzzle', 'mag'], headshotMul: 1.8,
    falloff: { start: 0.55, keep: 0.55 },
    art: { len: 0.62, body: 0x2f3a3d, accent: 0xb08a5a, size: 1.0 },
    desc: '大口径重手枪，三发就能放倒轻甲，代价是换弹偏慢。',
  },
  r500: {
    id: 'r500', name: 'R500 重手枪', short: 'R500', cls: 'pistol', ammo: 'light',
    // 平衡：3 发致死（48 / 33 / 33），TTK 0.90 落在手枪 3-4 发区间；
    // 8 发弹匣 + 1.70s 换弹把持续 DPS 抬到 79.2，高于免费 P9 的 71.6，
    // 避免「花 620 买一把面板更差的枪」。手感用更重的后坐与更慢的连点换伤害。
    damage: 48, interval: 0.45, magazine: 8, reload: 1.70,
    spread: 0.036, recoil: 1.5, range: 42, pellets: 1, auto: false,
    moveMul: 1.00, adsZoom: 1.25, noise: 1.05, rarity: 'uncommon', tier: 2,
    unlock: 6, price: 620, slots: ['optic', 'muzzle', 'mag'], headshotMul: 1.9,
    falloff: { start: 0.55, keep: 0.55 },
    art: { len: 0.64, body: 0x2b3336, accent: 0xc0a06a, size: 1.0 },
    desc: '旧港军械库里翻出的警用重手枪，八发弹匣压着大口径弹，抬手就是一声闷雷。',
  },
  // ── 冲锋枪 ──────────────────────────────────────────────────────────────
  v9: {
    id: 'v9', name: 'V9 冲锋枪', short: 'V9', cls: 'smg', ammo: 'light',
    damage: 17, interval: 0.085, magazine: 30, reload: 1.55,
    spread: 0.040, recoil: 0.80, range: 28, pellets: 1, auto: true,
    moveMul: 1.00, adsZoom: 1.05, noise: 0.80, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['optic', 'muzzle', 'mag'], headshotMul: 1.5,
    // 平衡：0–20m 王者、30m 明显衰减但必须强于手枪 → 拉长保持段（.52→.58）并抬高残伤（.34→.46）。
    falloff: { start: 0.58, keep: 0.46 },
    art: { len: 0.78, body: 0x39484b, accent: 0x8f7a4f, size: 1.0 },
    desc: '便宜耐用的老式冲锋枪，巷战里从不会让你失望。',
  },
  mp5k: {
    id: 'mp5k', name: 'MP5K 紧凑冲锋枪', short: 'MP5K', cls: 'smg', ammo: 'light',
    damage: 15, interval: 0.072, magazine: 30, reload: 1.50,
    spread: 0.036, recoil: 0.72, range: 30, pellets: 1, auto: true,
    moveMul: 1.02, adsZoom: 1.10, noise: 0.78, rarity: 'uncommon', tier: 2,
    unlock: 4, price: 520, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.5,
    falloff: { start: 0.56, keep: 0.45 },
    art: { len: 0.68, body: 0x2e3b40, accent: 0x7f8c85, size: 0.95 },
    desc: '紧凑枪身、平顺后坐，室内清点的标准答案。',
  },
  vector: {
    id: 'vector', name: 'Vector 高速冲锋枪', short: 'VEC', cls: 'smg', ammo: 'light',
    damage: 15, interval: 0.062, magazine: 25, reload: 1.45,
    // 平衡（1.3）：换弹 1.65 → 1.45。射速快到 0.062 的枪，换弹慢半拍就只剩「空仓等死」，
    // 持续 DPS 也从 119.5 回到 127.6，不再出现「940 信用点的枪比免费的 V9 面板更低」。
    spread: 0.045, recoil: 0.90, range: 26, pellets: 1, auto: true,
    moveMul: 1.00, adsZoom: 1.02, noise: 0.82, rarity: 'rare', tier: 2,
    unlock: 8, price: 940, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.45,
    falloff: { start: 0.54, keep: 0.42 },
    art: { len: 0.72, body: 0x39424f, accent: 0xc8a24e, size: 1.0 },
    desc: '射速快到近乎失控，贴身八米内它就是判决书。',
  },
  vss: {
    id: 'vss', name: 'VSS 微声冲锋枪', short: 'VSS', cls: 'smg', ammo: 'light',
    // 生态位：消音冲锋枪。noise 0.35 是纯度很高的表现层参数（simulation 不结算听觉），
    // 真正的数值交换写在弹道里：单发 19（6 发致死，落在冲锋枪 6-8 档），
    // 32 发弹匣 + 1.70s 换弹给出 130.9 的持续 DPS，是冲锋枪里最高的一档。
    damage: 19, interval: 0.095, magazine: 32, reload: 1.70,
    spread: 0.034, recoil: 0.70, range: 32, pellets: 1, auto: true,
    moveMul: 1.00, adsZoom: 1.35, noise: 0.35, rarity: 'epic', tier: 3,
    unlock: 11, price: 1080, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.55,
    falloff: { start: 0.60, keep: 0.48 },
    art: { len: 0.92, body: 0x2c3430, accent: 0x8fa08a, size: 1.05 },
    desc: '一体式消声枪管把连发压成一串短促的叹息，适合在雾里一个个把哨位清干净。',
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
    // 平衡：原 spread 0.036 / recoil 1.55 让 30m 对甲2 的实用 TTK 掉到 1.9s 级，
    // 花 760 信用点买到的是一把比免费 AR7 更差的枪。收紧稳态散布与后坐累积，
    // 保留「重弹头、慢射速」的定位，让付费枪在 30m 至少不输给 T1。
    // spread 取 0.027（而非 0.030）：0.030 时 30m 稳态命中率只有 50%，实用 TTK 仍 1.5s；
    // 0.027 把命中拉到 54~55%，实用 TTK 落在 1.37~1.38，正好在目标区间 1.3~1.4。
    damage: 34, interval: 0.150, magazine: 30, reload: 2.15,
    spread: 0.027, recoil: 1.25, range: 54, pellets: 1, auto: true,
    moveMul: 0.92, adsZoom: 1.30, noise: 1.20, rarity: 'uncommon', tier: 2,
    unlock: 5, price: 760, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.8,
    falloff: { start: 0.55, keep: 0.55 },
    art: { len: 1.05, body: 0x4a3f33, accent: 0xa86a3f, size: 1.15 },
    desc: '重弹头、硬后坐，三发就能把人按进土里。',
  },
  bullpup: {
    id: 'bullpup', name: 'BULLPUP 无托步枪', short: 'BP', cls: 'rifle', ammo: 'medium',
    // 平衡：T3 的定位是「更稳」而不是「更快」。射速保持低于 AR7，
    // 用单发伤害（26→28，面板 DPS 243）补上面板差距，再靠 spread/recoil/更缓的衰减
    // 拉开实际命中率——T3 的面板 DPS 不再低于免费 T1，整体强度则由控枪与衰减体现。
    damage: 28, interval: 0.115, magazine: 30, reload: 1.80, burst: 3,
    spread: 0.022, recoil: 0.62, range: 50, pellets: 1, auto: false,
    moveMul: 0.98, adsZoom: 1.28, noise: 1.00, rarity: 'rare', tier: 3,
    unlock: 12, price: 1180, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.8,
    falloff: { start: 0.74, keep: 0.66 },
    art: { len: 0.98, body: 0x42504a, accent: 0x6f9a8a, size: 1.1 },
    desc: '无托结构换来极限控枪，三点射就是它的语言。',
  },
  // ── 霰弹枪 ──────────────────────────────────────────────────────────────
  s12: {
    id: 's12', name: 'S12 泵动霰弹', short: 'S12', cls: 'shotgun', ammo: 'shell',
    // 平衡：9 弹丸 × 15 = 135 单发，裸甲一发秒杀过强。改为 9 × 11 = 99：
    // 贴脸 2 发必杀（裸甲/二档甲都是 2 发），12m 内 2 发，15m 掉到 3 发，20m 外基本无效。
    damage: 11, interval: 0.80, magazine: 6, reload: 2.85,
    spread: 0.095, recoil: 2.2, range: 18, pellets: 9, auto: false,
    moveMul: 0.94, adsZoom: 1.10, noise: 1.15, rarity: 'common', tier: 1,
    unlock: 1, price: 0, slots: ['muzzle', 'mag', 'grip'], headshotMul: 1.5,
    falloff: { start: 0.40, keep: 0.14 },
    art: { len: 1.05, body: 0x3d3a33, accent: 0x8a6a45, size: 1.1 },
    desc: '一格一格上膛的节奏感，贴脸时就是最硬的道理。',
  },
  aa12: {
    id: 'aa12', name: 'AA12 自动霰弹', short: 'AA12', cls: 'shotgun', ammo: 'shell',
    damage: 11, interval: 0.32, magazine: 8, reload: 2.65,
    spread: 0.115, recoil: 2.8, range: 16, pellets: 9, auto: true,
    moveMul: 0.90, adsZoom: 1.05, noise: 1.30, rarity: 'epic', tier: 3,
    unlock: 18, price: 1680, slots: ['muzzle', 'mag'], headshotMul: 1.4,
    falloff: { start: 0.42, keep: 0.12 },
    art: { len: 1.12, body: 0x33383a, accent: 0xc06a45, size: 1.15 },
    desc: '扣住扳机就没人能站着走近，代价是凶猛的吃弹速度。',
  },
  // ── 精准步枪 ────────────────────────────────────────────────────────────
  m14: {
    id: 'm14', name: 'M14 精准步枪', short: 'M14', cls: 'marksman', ammo: 'medium',
    // 平衡（1.3）：换弹 2.30 → 3.00。老式 10 发弹匣的机械结构本就更慢，也顺带修掉
    // 「同类别最贵武器持续 DPS 低于最便宜武器」的倒挂（98.7 vs SVD 87.3）。
    // 调整后 M14 98.7→85.3，SVD 87.3 → 最贵 ≥ 最便宜，且 M14 仍是 820 价位的入门精准步枪。
    damage: 44, interval: 0.24, magazine: 10, reload: 3.00,
    spread: 0.016, recoil: 1.7, range: 68, pellets: 1, auto: false,
    moveMul: 0.95, adsZoom: 1.60, noise: 1.15, rarity: 'uncommon', tier: 2,
    unlock: 6, price: 820, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.9,
    falloff: { start: 0.70, keep: 0.70 },
    art: { len: 1.10, body: 0x4a3d2f, accent: 0x9c7f52, size: 1.1 },
    desc: '老式半自动步枪，节奏沉稳，专治探头探脑。',
  },
  dm7: {
    id: 'dm7', name: 'DM7 精确射手步枪', short: 'DM7', cls: 'marksman', ammo: 'medium',
    // 生态位：tier2 半自动精确步枪。36 伤害刚好 3 发致死（marksman 2-3 发区间），
    // 0.24s 间隔给出 0.48s TTK；15 发弹匣 + 2.2s 换弹把持续 DPS 抬到 97.1，
    // 高于免费 M14（85.3），付费档在「补枪节奏」上确实更强。
    damage: 36, interval: 0.24, magazine: 15, reload: 2.20,
    spread: 0.018, recoil: 1.35, range: 64, pellets: 1, auto: false,
    moveMul: 0.96, adsZoom: 1.70, noise: 1.10, rarity: 'uncommon', tier: 2,
    unlock: 7, price: 1120, slots: ['optic', 'muzzle', 'mag', 'grip'], headshotMul: 1.85,
    falloff: { start: 0.72, keep: 0.68 },
    art: { len: 1.08, body: 0x3f4a44, accent: 0xb0985e, size: 1.1 },
    desc: '从检查站的枪架上拆下来的精确射手型，五发节奏压制一条巷口，是哨兵最不愿听见的声音。',
  },
  svd: {
    id: 'svd', name: 'SVD 半自动狙击', short: 'SVD', cls: 'marksman', ammo: 'heavy',
    // 平衡：62 伤害 + 0.42s 间隔让 SVD 在 30m 对甲2 的 TTK 约 0.84s，快过 SR338（1.05s）
    // 与 AWM（1.50s），价格却是三把里最低的 1420。
    //
    // 关于改动的由来（1.3.0）：原先 0.50s 间隔让**持续 DPS 只有 87.3**，低于同类别
    // tier2 的 DM7（97.1）——「更贵、更高 tier 的枪持续输出反而更弱」，玩家花钱买到更差
    // 的体验。问题是 10 发弹匣 + 2.6s 换弹把射速优势摊薄了（DM7 是 15 发 + 2.2s）。
    // 修法二选一：提射速或扩弹匣。这里**同时做小幅调整**（0.42s + 12 发弹匣），
    // 让 SVD 的持续 DPS 明确高于 tier2 的 DM7（实测 97 vs 93），且 0.42s 仍明显
    // 慢于半自动步枪，不破坏「精准位」身份。
    damage: 62, interval: 0.42, magazine: 12, reload: 2.60,
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
    // 平衡：92 伤害本身就不能一枪打掉二档甲（约 102 有效），它是「快节奏补枪狙」；
    // AWM 才是「一枪一个」的重狙。两者差异还应体现在射速/弹匣上。
    falloff: { start: 0.86, keep: 0.84 },
    art: { len: 1.34, body: 0x37424a, accent: 0x7fa3b8, size: 1.2 },
    desc: '栓动上膛的一声轻响，决定了下一百米归谁。',
  },
  awm: {
    id: 'awm', name: 'AWM 重型栓动', short: 'AWM', cls: 'sniper', ammo: 'heavy',
    damage: 118, interval: 1.50, magazine: 4, reload: 3.70,
    spread: 0.005, recoil: 4.0, range: 112, pellets: 1, auto: false,
    moveMul: 0.78, adsZoom: 3.00, noise: 1.75, rarity: 'legendary', tier: 3,
    unlock: 24, price: 2600, slots: ['optic', 'muzzle', 'mag'], headshotMul: 2.2,
    // 平衡：衰减的代价是「打不掉二档甲」。保持段拉到 0.90 倍射程，
    // 让 AWM 在 100m 内对护甲仍是 1 枪，与 sr338 的差异只体现在射速/弹匣/手感。
    falloff: { start: 0.90, keep: 0.88 },
    art: { len: 1.46, body: 0x2f3a3f, accent: 0xd8b45e, size: 1.3 },
    desc: '重到让人不想背，但它在哑火之前从不说第二次。',
  },
  // ── 机枪 ────────────────────────────────────────────────────────────────
  m60: {
    id: 'm60', name: 'M60 轻机枪', short: 'M60', cls: 'lmg', ammo: 'medium',
    // 平衡：标称射程 58m，但 recoil 1.5 让连射 2 秒后稳态散布翻倍，50% 命中距离只有 14m、
    // 20m 外几乎打不中，与「弹雨压住整条街」的描述相反。
    // spread 0.040→0.034、recoil 1.5→1.2：有效射程 18m → 27m（目标 ≥25m）。
    damage: 18, interval: 0.095, magazine: 60, reload: 4.30,
    spread: 0.034, recoil: 1.2, range: 58, pellets: 1, auto: true,
    moveMul: 0.86, adsZoom: 1.25, noise: 1.25, rarity: 'rare', tier: 2,
    unlock: 10, price: 1250, slots: ['optic', 'muzzle'], headshotMul: 1.6,
    falloff: { start: 0.62, keep: 0.58 },
    art: { len: 1.28, body: 0x3c4a3f, accent: 0x9a8a5a, size: 1.2 },
    desc: '六十发弹链就是你的底气，换弹那四秒是你的葬礼。',
  },
  pkm: {
    id: 'pkm', name: 'PKM 重机枪', short: 'PKM', cls: 'lmg', ammo: 'heavy',
    // 平衡：与 M60 同因——recoil 2.2 使有效射程只剩 14m（标称 64m）。
    // spread 0.048→0.035、recoil 2.2→1.7：有效射程 14m → 25m（目标 ≥25m）。
    // 仍比 M60 更抖（1.7 vs 1.2）、单发更高（22 vs 18），保住「重机枪」的档位差。
    damage: 22, interval: 0.110, magazine: 75, reload: 5.20,
    spread: 0.035, recoil: 1.7, range: 64, pellets: 1, auto: true,
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
    unlock: 15, price: 1350, slots: ['optic', 'grip'], headshotMul: 1.5,
    // 平衡：100 伤害 + 2.0 爆头 = 200 点，比 AWM 的爆头还高且无枪声，属于隐藏超模。
    // 弩的定位是「无声处决」，不是「更高的爆头收益」——爆头倍率降到 1.5。
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
//   spread / interval / reload / recoil / range / damage / magazine / moveMul：乘算（-0.1 = ×0.9）
//   ⚠ 只写 simulation.mjs 真正读取的键（spread/recoil/range/damage/magazine/reload/moveMul/interval）。
//   noise 与 adsZoom 只服务表现层，simulation 不结算；写进 mods 会让 data 层承诺一个永不生效的
//   手柄反馈。原来的消音器/补偿器/制退器的 noise 修正、瞄具的 adsZoom/adsTime 修正已全部
//   改写成等价可生效字段（见每件配件的注释）。tests/content-expansion.test.mjs 会静态扫描
//   simulation.mjs 源码，任何未被读取的 mods key 直接判失败。
export const ATTACHMENTS = {
  red_dot: {
    id: 'red_dot', name: '红点镜', short: '红点', slot: 'optic', rarity: 'common',
    unlock: 1, price: 0,
    // adsZoom 是 **加算**（applyAttachmentMods 里 `w.adsZoom + (mods.adsZoom || 0)`），
    // 与 spread/range 的乘算不同 —— 早期注释误判它「不生效」，把红点改成了纯 range。
    // 两个都保留：adsZoom 给「开镜更近的视野」，range 给「判定距离更远」。
    mods: { spread: -0.10, range: 0.06, adsZoom: 0.12 },
    desc: '清晰的单点准星，近中距离抬枪就打。',
  },
  holo: {
    id: 'holo', name: '全息镜', short: '全息', slot: 'optic', rarity: 'uncommon',
    unlock: 4, price: 320,
    // 原 adsZoom +0.18 → 拆成 spread -0.12 / range +0.06，让「大视野咬住移动目标」落到弹道上。
    mods: { spread: -0.14, range: 0.06 },
    desc: '大视野全息环，连发时更容易咬住移动目标。',
  },
  scope_4x: {
    id: 'scope_4x', name: '4 倍镜', short: '4×', slot: 'optic', rarity: 'rare',
    unlock: 9, price: 680,
    // 原 adsZoom +1.10 / adsTime +0.12 都是死字段 → 保留「开镜慢半拍」的代价，
    // 用 interval +0.05（扳机节奏被瞄准流程拖慢）与更大的 range 收益表达。
    mods: { spread: -0.20, range: 0.16, interval: 0.05 },
    desc: '中远距离点名的标配，开镜要慢半拍。',
  },
  scope_8x: {
    id: 'scope_8x', name: '8 倍镜', short: '8×', slot: 'optic', rarity: 'epic',
    unlock: 15, price: 1250,
    // adsZoom 是加算且**确实生效**（applyAttachmentMods: `w.adsZoom + mods.adsZoom`）。
    // 早期把 +2.20 误判成死字段换成了 range，结果客户端准星永远不缩放 —— 加回来。
    mods: { spread: -0.28, range: 0.26, interval: 0.12, adsZoom: 2.2 },
    desc: '把整片山谷拉到眼前，代价是狭窄的视界与更慢的补枪节奏。',
  },
  // 高阶瞄具：8 倍镜之上再补一档「放弃机动」的远距镜，只给狙击/精准位。
  scope_12x: {
    id: 'scope_12x', name: '12 倍镜', short: '12×', slot: 'optic', rarity: 'legendary',
    unlock: 22, price: 2200,
    // 交换比刻意残酷：range +0.40 / spread -0.34，但 interval +0.20、moveMul -0.04。
    mods: { spread: -0.34, range: 0.40, interval: 0.20, moveMul: -0.04 },
    desc: '镜筒比枪身还长，三百米外的一根睫毛都逃不掉——只是你再也跑不动了。',
  },
  suppressor: {
    id: 'suppressor', name: '消音器', short: '消音', slot: 'muzzle', rarity: 'rare',
    unlock: 8, price: 720,
    // noise 现在真正生效（simulation._emitSound → ai.hearsOf）：
    // 枪声可听半径 = 78m × noise，消音器把 0.85 压到 0.45 ≈ 35m。
    // 代价照旧：伤害与射程双降、散布改善。
    mods: { spread: -0.06, damage: -0.06, range: -0.06, magazine: 0.04, noise: -0.47 },
    desc: '把枪声压成一记闷响，换来初速与弹道的双重损失。',
  },
  compensator: {
    id: 'compensator', name: '补偿器', short: '补偿', slot: 'muzzle', rarity: 'uncommon',
    unlock: 5, price: 360,
    // 原 noise +0.06 不可生效 → 去掉，只保留「控枪但略拖射速」的交换。
    mods: { recoil: -0.22, spread: -0.06, interval: 0.02 },
    desc: '向上喷口压住枪口跳动，连发落点明显收紧。',
  },
  muzzle_brake: {
    id: 'muzzle_brake', name: '制退器', short: '制退', slot: 'muzzle', rarity: 'common',
    unlock: 2, price: 180,
    // 原 noise +0.12 不可生效 → 换成 range -0.04（侧向排气拖慢弹道）。
    mods: { recoil: -0.14, range: -0.04 },
    desc: '简单粗暴的侧向排气，代价是弹道被扯得更散一些。',
  },
  choke: {
    id: 'choke', name: '收束器', short: '收束', slot: 'muzzle', rarity: 'uncommon',
    unlock: 3, price: 300,
    mods: { spread: -0.18, range: 0.12, damage: 0.02 },
    desc: '把弹丸拢成更紧的一束，霰弹的有效距离翻倍。',
  },
  // 高阶枪口：重型消焰器，控枪最强但只对高射速武器有意义。
  heavy_brake: {
    id: 'heavy_brake', name: '重型消焰器', short: '重消焰', slot: 'muzzle', rarity: 'epic',
    unlock: 16, price: 1450,
    mods: { recoil: -0.30, spread: -0.10, moveMul: -0.03 },
    desc: '四腔室消焰结构，机枪连射也能压在一条线上，只是枪口重得压手。',
  },
  ext_mag: {
    id: 'ext_mag', name: '扩容弹匣', short: '扩容', slot: 'mag', rarity: 'uncommon',
    unlock: 4, price: 340,
    mods: { magazine: 0.33, reload: 0.08 },
    desc: '多出一个弹匣的余量，代价是换弹慢半拍。',
  },
  quick_mag: {
    id: 'quick_mag', name: '快拔弹匣', short: '快拔', slot: 'mag', rarity: 'rare',
    unlock: 7, price: 640,
    mods: { reload: -0.22, magazine: -0.08 },
    desc: '打磨过的卡榫让换弹行云流水，弹容略减。',
  },
  drum_mag: {
    id: 'drum_mag', name: '弹鼓', short: '弹鼓', slot: 'mag', rarity: 'epic',
    unlock: 12, price: 980,
    mods: { magazine: 0.85, reload: 0.30, moveMul: -0.05 },
    desc: '整个弹鼓压进枪里，走起来也更沉了。',
  },
  // 高阶弹匣：双鼓，容量最猛、代价最重（换弹与机动双双下滑）。
  twin_drum: {
    id: 'twin_drum', name: '双鼓弹匣', short: '双鼓', slot: 'mag', rarity: 'legendary',
    unlock: 26, price: 2450,
    mods: { magazine: 1.20, reload: 0.45, moveMul: -0.10 },
    desc: '两个弹鼓并排挂在机匣下，压满一整个弹链舱，也压垮了你的步频。',
  },
  vertical_grip: {
    id: 'vertical_grip', name: '垂直握把', short: '垂直', slot: 'grip', rarity: 'common',
    unlock: 1, price: 150,
    mods: { recoil: -0.16, spread: -0.04 },
    desc: '最朴素的改装，也是最有效的压枪手段。',
  },
  angled_grip: {
    id: 'angled_grip', name: '斜角握把', short: '斜角', slot: 'grip', rarity: 'uncommon',
    unlock: 3, price: 280,
    // 原 adsTime -0.08 是死字段 → 换成 interval -0.04（举枪更快 = 更快出第二发）。
    mods: { recoil: -0.08, spread: -0.10, interval: -0.04 },
    desc: '举枪更快、开镜更顺，适合边走边打。',
  },
  bipod: {
    id: 'bipod', name: '两脚架', short: '脚架', slot: 'grip', rarity: 'rare',
    unlock: 6, price: 560,
    mods: { recoil: -0.34, spread: -0.14, moveMul: -0.08 },
    desc: '架稳之后几乎无后坐，但背着它跑不快。',
  },
  // 高阶握把：精密扳机组，用射速换稳定与一点射程。
  match_trigger: {
    id: 'match_trigger', name: '竞赛扳机', short: '竞赛扳机', slot: 'grip', rarity: 'epic',
    unlock: 18, price: 1680,
    mods: { interval: -0.10, spread: -0.12, recoil: -0.10 },
    desc: '扳机行程被削到只有两毫米，扣下去的那一刻枪已经响完了。',
  },
};

export const ATTACHMENT_ORDER = [
  'red_dot', 'holo', 'scope_4x', 'scope_8x', 'scope_12x',
  'suppressor', 'compensator', 'muzzle_brake', 'choke', 'heavy_brake',
  'ext_mag', 'quick_mag', 'drum_mag', 'twin_drum',
  'vertical_grip', 'angled_grip', 'bipod', 'match_trigger',
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
  'p9', 'p226', 'r500', 'v9', 'mp5k', 'vector', 'vss',
  'ar7', 'ak12', 'bullpup',
  's12', 'aa12',
  'm14', 'dm7', 'svd',
  'sr338', 'awm',
  'm60', 'pkm',
  'crossbow', 'scout',
];
