// 雾岛突围 / MIST ISLE — 道具数据（护甲/消耗品/投掷物/背包）
// 与武器数据同构：纯对象 + 纯函数，无 DOM/Node 依赖。
// 数值口径：护甲 absorb 为伤害减免比例，durability 为可吸收的伤害总量；
//           消耗品 use 为使用耗时（需静止），stack 为基础堆叠上限（受背包倍率影响）。

export const ARMORS = {
  armor1: {
    id: 'armor1', name: '轻型护甲', short: '轻甲', kind: 'armor', tier: 1,
    absorb: 0.35, durability: 60, rarity: 'common', unlock: 1, price: 0,
    color: 0x88bfe2, icon: '▤', desc: '帆布夹层里塞了几块插板，聊胜于无，但比裸奔强。',
  },
  armor2: {
    id: 'armor2', name: '制式护甲', short: '制式', kind: 'armor', tier: 2,
    absorb: 0.45, durability: 100, rarity: 'uncommon', unlock: 5, price: 480,
    color: 0x7ed3a5, icon: '▥', desc: '军警制式装备，正面能替你多挨两发步枪弹。',
  },
  armor3: {
    id: 'armor3', name: '重型护甲', short: '重甲', kind: 'armor', tier: 3,
    absorb: 0.55, durability: 150, rarity: 'rare', unlock: 12, price: 1150,
    color: 0xc48bf0, icon: '▦', desc: '厚重复合板，穿上它的人像一堵会移动的墙。',
  },
};

export const CONSUMABLES = {
  bandage: {
    id: 'bandage', name: '绷带', short: '绷带', kind: 'consumable',
    heal: 22, use: 2.0, stack: 8, rarity: 'common', unlock: 1, price: 0,
    color: 0xd8cfa8, icon: '＋', desc: '止住血就够了，别指望它把你修好。',
  },
  medkit: {
    id: 'medkit', name: '医疗包', short: '医疗', kind: 'consumable',
    heal: 75, use: 4.0, stack: 4, rarity: 'uncommon', unlock: 2, price: 120,
    color: 0xe8e0d0, icon: '✚', desc: '四秒钟站定不动，换一管几乎满格的血。',
  },
  energy: {
    id: 'energy', name: '能量饮料', short: '能量', kind: 'consumable',
    heal: 35, use: 1.2, stack: 4, haste: 1.18, hasteTime: 12, rarity: 'common',
    unlock: 1, price: 70, color: 0xf0c860, icon: '↯',
    desc: '一口下去跑得比风快，代价是十二秒后你会想它。',
  },
  shield: {
    id: 'shield', name: '护盾电池', short: '电池', kind: 'consumable',
    shield: 60, use: 3.0, stack: 3, rarity: 'rare', unlock: 7, price: 220,
    color: 0x8fd6e8, icon: '◍', desc: '先有盾再有命，交火前记得把它灌进去。',
  },
};

export const THROWABLES = {
  frag: {
    id: 'frag', name: '破片手雷', short: '手雷', kind: 'throwable',
    fuse: 2.2, radius: 8, damage: 120, stack: 4, rarity: 'uncommon', unlock: 1,
    price: 120, color: 0x8a906a, icon: '✹',
    desc: '掩体后面也不安全，除非你退得足够快。',
  },
  smoke: {
    id: 'smoke', name: '烟雾弹', short: '烟雾', kind: 'throwable',
    fuse: 1.4, radius: 7, duration: 16, stack: 4, rarity: 'common', unlock: 1,
    price: 80, color: 0xb8c4c0, icon: '☁',
    desc: '一团白雾，够你换一次位置或救一个队友。',
  },
  flash: {
    id: 'flash', name: '闪光弹', short: '闪光', kind: 'throwable',
    fuse: 1.1, radius: 10, blind: 2.6, stack: 3, rarity: 'uncommon', unlock: 3,
    price: 140, color: 0xf0e6a0, icon: '☀',
    desc: '别直视它，也别背对它——转身同样会瞎。',
  },
  molotov: {
    id: 'molotov', name: '燃烧瓶', short: '燃烧', kind: 'throwable',
    fuse: 1.6, radius: 6, burn: 18, duration: 9, stack: 3, rarity: 'rare', unlock: 6,
    price: 180, color: 0xd06a3f, icon: '♨',
    desc: '火焰封路，比子弹更有耐心。',
  },
};

export const BACKPACKS = {
  bp1: {
    id: 'bp1', name: '轻型背包', short: '轻包', kind: 'backpack', tier: 1,
    ammoCap: 1.0, consumableStack: 1.0, rarity: 'common', unlock: 1, price: 0,
    color: 0x9aa8a2, icon: '◫', desc: '只装得下必需品，多一颗子弹都是奢侈。',
  },
  bp2: {
    id: 'bp2', name: '战术背包', short: '战术', kind: 'backpack', tier: 2,
    ammoCap: 1.35, consumableStack: 1.5, rarity: 'uncommon', unlock: 4, price: 260,
    color: 0x7ec3a5, icon: '◫', desc: '多出来的空间，往往就是第二条命。',
  },
  bp3: {
    id: 'bp3', name: '突击背包', short: '突击', kind: 'backpack', tier: 3,
    ammoCap: 1.8, consumableStack: 2.0, rarity: 'rare', unlock: 9, price: 680,
    color: 0xb08ae0, icon: '◫', desc: '像背着一间弹药库跑图，压得人咽不下气。',
  },
};

// 落地配件品质权重（按 POI 档次）：穷地方几乎只有红点，富地方才出 4×/8×。
export const LAND_ATTACHMENT_RARITY = {
  tier1: { common: 74, uncommon: 22, rare: 4, epic: 0, legendary: 0 },
  tier2: { common: 48, uncommon: 34, rare: 15, epic: 3, legendary: 0 },
  tier3: { common: 22, uncommon: 33, rare: 30, epic: 13, legendary: 2 },
};

export const ITEM_KINDS = ['weapon', 'ammo', 'consumable', 'armor', 'throwable', 'attachment', 'backpack'];
export const CONSUMABLE_ORDER = ['bandage', 'medkit', 'energy', 'shield'];
export const THROWABLE_ORDER = ['frag', 'smoke', 'flash', 'molotov'];
export const BACKPACK_ORDER = ['bp1', 'bp2', 'bp3'];

// 统一物品索引：按 id 查任意道具（不含武器，武器见 weapons.mjs）
export const ITEM_LOOKUP = {};
for (const group of [ARMORS, CONSUMABLES, THROWABLES, BACKPACKS]) {
  for (const [id, item] of Object.entries(group)) ITEM_LOOKUP[id] = item;
}
// 兼容别名：UI/存档里用 'med' 指代医疗包，保证查表不落空
ITEM_LOOKUP.med = CONSUMABLES.medkit;

export const ITEM_NAMES = {};
export const ITEM_ICONS = {};
for (const [id, item] of Object.entries(ITEM_LOOKUP)) {
  ITEM_NAMES[id] = item.name;
  ITEM_ICONS[id] = item.icon;
}

export function getItem(id) {
  return ITEM_LOOKUP[id] || null;
}

// 护甲按档位取定义（1..3），越界返回 null
export function armorForTier(tier) {
  return ARMORS[`armor${tier}`] || null;
}

// 消耗品/投掷物的背包堆叠上限（基础 stack × 背包倍率）
export function stackLimit(id, backpackId = 'bp1') {
  const item = ITEM_LOOKUP[id];
  if (!item || !item.stack) return 0;
  const bp = BACKPACKS[backpackId] || BACKPACKS.bp1;
  return Math.round(item.stack * bp.consumableStack);
}

// 弹药储备上限倍率（由背包决定，基础容量见 AMMO_TYPES.cap）
export function backpackAmmoCap(backpackId = 'bp1') {
  return (BACKPACKS[backpackId] || BACKPACKS.bp1).ammoCap;
}
