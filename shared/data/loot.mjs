// 雾岛突围 / MIST ISLE — 掉落表与随机工具（确定性：只使用传入的 rng）
// 设计意图：穷地方真穷、富地方真富。
//   tier1：手枪/冲锋枪 + 绷带为主，稀有度期望 ≈ 0.5 级（common/uncommon 之间）；
//   tier3：连狙/重甲/高倍镜为主，稀有度期望显著更高，且武器更容易自带配件。
// 所有随机都走 rng()，服务端与离线模拟共用同一套表，便于回放与测试。

import { WEAPONS, ATTACHMENTS, getWeapon } from './weapons.mjs';
import {
  ARMORS, CONSUMABLES, THROWABLES, BACKPACKS, ITEM_LOOKUP, LAND_ATTACHMENT_RARITY,
} from './items.mjs';
import { RARITY } from '../rules.mjs';

// 基础稀有度权重（tier2 = 基准）。tier1/tier3 见 RARITY_WEIGHTS_BY_TIER。
export const RARITY_WEIGHTS = { common: 55, uncommon: 26, rare: 12, epic: 5, legendary: 2 };

export const RARITY_WEIGHTS_BY_TIER = {
  1: { common: 70, uncommon: 22, rare: 6, epic: 2, legendary: 0 },
  2: { ...RARITY_WEIGHTS },
  3: { common: 26, uncommon: 30, rare: 26, epic: 13, legendary: 5 },
};

export const RARITY_INDEX = Object.fromEntries(RARITY.map((id, index) => [id, index]));
export const RARITY_BY_INDEX = [...RARITY];

export const LOOT_TABLES = {
  tier1: {
    weapon: [
      ['p9', 30], ['v9', 24], ['s12', 14], ['ar7', 14], ['p226', 10], ['m14', 5], ['mp5k', 3],
    ],
    ammo: [
      ['light', 42], ['medium', 30], ['shell', 18], ['heavy', 7], ['bolt', 3],
    ],
    consumable: [
      ['bandage', 46], ['energy', 22], ['medkit', 20], ['shield', 12],
    ],
    armor: [
      ['armor1', 78], ['armor2', 20], ['armor3', 2],
    ],
    throwable: [
      ['smoke', 40], ['frag', 34], ['flash', 18], ['molotov', 8],
    ],
    attachment: [
      ['red_dot', 34], ['vertical_grip', 24], ['muzzle_brake', 16], ['ext_mag', 12],
      ['compensator', 8], ['angled_grip', 4], ['holo', 2],
    ],
  },
  tier2: {
    weapon: [
      ['v9', 18], ['mp5k', 16], ['ar7', 18], ['ak12', 14], ['s12', 10], ['m14', 10], ['m60', 8], ['bullpup', 6],
    ],
    ammo: [
      ['light', 26], ['medium', 34], ['shell', 18], ['heavy', 16], ['bolt', 6],
    ],
    consumable: [
      ['bandage', 34], ['medkit', 24], ['energy', 20], ['shield', 22],
    ],
    armor: [
      ['armor1', 38], ['armor2', 48], ['armor3', 14],
    ],
    throwable: [
      ['frag', 38], ['smoke', 28], ['flash', 20], ['molotov', 14],
    ],
    attachment: [
      ['red_dot', 20], ['holo', 14], ['scope_4x', 9], ['compensator', 12], ['suppressor', 6],
      ['ext_mag', 13], ['quick_mag', 6], ['vertical_grip', 12], ['angled_grip', 6], ['bipod', 2],
    ],
  },
  tier3: {
    weapon: [
      ['ak12', 14], ['bullpup', 12], ['vector', 10], ['aa12', 8], ['svd', 10], ['sr338', 8],
      ['m60', 7], ['pkm', 7], ['crossbow', 6], ['scout', 8], ['awm', 3], ['ar7', 6],
    ],
    ammo: [
      ['light', 14], ['medium', 30], ['shell', 16], ['heavy', 32], ['bolt', 8],
    ],
    consumable: [
      ['bandage', 22], ['medkit', 28], ['energy', 18], ['shield', 32],
    ],
    armor: [
      ['armor1', 12], ['armor2', 44], ['armor3', 44],
    ],
    throwable: [
      ['frag', 32], ['smoke', 20], ['flash', 18], ['molotov', 30],
    ],
    attachment: [
      ['scope_4x', 18], ['scope_8x', 10], ['holo', 10], ['suppressor', 12], ['compensator', 8],
      ['ext_mag', 10], ['quick_mag', 12], ['drum_mag', 5], ['vertical_grip', 8], ['bipod', 7],
    ],
  },
};

const clampTier = (tier) => Math.min(3, Math.max(1, Math.round(Number(tier) || 1)));
const tableFor = (tier) => LOOT_TABLES[`tier${clampTier(tier)}`];

// 加权抽样：entries = [[value, weight], ...]；rng 必须返回 [0,1)
export function pickWeighted(rng, entries) {
  if (!entries || !entries.length) return null;
  let total = 0;
  for (const [, weight] of entries) total += weight;
  if (!(total > 0)) return entries[0][0];
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

export function rollRarity(rng, tier = 2) {
  const weights = RARITY_WEIGHTS_BY_TIER[clampTier(tier)];
  return pickWeighted(rng, RARITY.map((id) => [id, weights[id] || 0])) || 'common';
}

// 取两个稀有度里更高的那个（用于「穷地捡到普通绷带、富地可能捡到精良/稀有」）
export function maxRarity(a, b) {
  return (RARITY_INDEX[b] ?? 0) > (RARITY_INDEX[a] ?? 0) ? b : a;
}

// 按类别随机一件物品，返回 { kind, item, rarity }
export function randomItemForTier(rng, tier, kind) {
  const table = tableFor(tier);
  const entries = table[kind];
  if (!entries) return null;
  return { kind, item: pickWeighted(rng, entries) };
}

// 某把武器允许装配的配件槽（special 弩只有 optic/grip，机枪没有 mag 等）
export function attachmentSlotsFor(weapon) {
  return (weapon?.slots || []).filter((slot) => ['optic', 'muzzle', 'mag', 'grip'].includes(slot));
}

// 随机配件：先按本档次品质权重决定稀有度，再在同稀有度里随机。
// opts.slot 限定槽位；opts.cls 用于排除枪管收束器之类不合适的配件。
export function randomAttachment(rng, tier = 2, opts = {}) {
  const t = clampTier(tier);
  const weights = LAND_ATTACHMENT_RARITY[`tier${t}`];
  const rarity = pickWeighted(rng, RARITY.map((id) => [id, weights[id] || 0])) || 'common';
  const all = Object.values(ATTACHMENTS);
  const matchSlot = (a) => !opts.slot || a.slot === opts.slot;
  const matchCls = (a) => opts.cls === 'shotgun' || a.id !== 'choke';
  let pool = all.filter((a) => a.rarity === rarity && matchSlot(a) && matchCls(a));
  if (!pool.length) pool = all.filter((a) => matchSlot(a) && matchCls(a));
  if (!pool.length) pool = all.filter(matchSlot);
  if (!pool.length) pool = all;
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))].id;
}

// 随机武器：本档次武器池 + 按稀有度决定的自带配件数量。
// 返回 { id, attachments:[] }，供 loot 条目直接使用。
export function randomWeaponForTier(rng, tier = 2) {
  const t = clampTier(tier);
  const id = pickWeighted(rng, tableFor(t).weapon);
  const weapon = getWeapon(id);
  const slots = attachmentSlotsFor(weapon);
  const roll = rollRarity(rng, t);
  const rarityIndex = RARITY_INDEX[roll] ?? 0;
  let wanted = rarityIndex >= 4 ? 2 : rarityIndex >= 2 ? 1 : 0;
  if (wanted === 0 && rng() < 0.18) wanted = 1;
  const open = [...slots];
  const attachments = [];
  for (let i = 0; i < wanted && open.length; i++) {
    const slot = open.splice(Math.floor(rng() * open.length), 1)[0];
    const att = randomAttachment(rng, t, { slot, cls: weapon.cls });
    if (att && !attachments.includes(att)) attachments.push(att);
  }
  return { id, attachments, rarity: weapon.rarity };
}

// 每个 POI 档次的条目数：穷地常见 1 条，富地常见 2-3 条
const COUNT_TABLE = {
  1: [[1, 70], [2, 30]],
  2: [[1, 34], [2, 46], [3, 20]],
  3: [[1, 8], [2, 40], [3, 52]],
};

// 每个 POI 档次的物品种类权重
const KIND_TABLE = {
  1: [['weapon', 18], ['ammo', 26], ['consumable', 28], ['armor', 8], ['throwable', 8], ['attachment', 12]],
  2: [['weapon', 20], ['ammo', 22], ['consumable', 22], ['armor', 12], ['throwable', 10], ['attachment', 14]],
  3: [['weapon', 24], ['ammo', 16], ['consumable', 16], ['armor', 16], ['throwable', 10], ['attachment', 18]],
};

// 生成一个物资点：1-3 条描述，供 simulation 落成实体 loot。
// 返回 [{ kind, item, rarity, ammo?, attachments?, qty? }]
export function buildLootForSpot(rng, spot = {}) {
  const t = clampTier(spot.tier);
  const count = pickWeighted(rng, COUNT_TABLE[t]);
  const out = [];
  for (let i = 0; i < count; i++) {
    const kind = pickWeighted(rng, KIND_TABLE[t]);
    // 第二条起避免与前一条完全同名同类的物品，减少「一个箱子两卷绷带」的荒谬感
    if (out.length && kind === out[out.length - 1].kind && rng() < 0.55) continue;
    if (kind === 'weapon') {
      const { id, attachments } = randomWeaponForTier(rng, t);
      out.push({ kind, item: id, rarity: WEAPONS[id].rarity, ammo: WEAPONS[id].magazine, attachments });
    } else if (kind === 'ammo') {
      const ammo = pickWeighted(rng, tableFor(t).ammo);
      // 富地更可能成组出现（一盒 20-40 发），穷地常只有半盒
      const base = 10 + t * 6;
      out.push({ kind, item: ammo, rarity: 'common', ammo, qty: base + Math.floor(rng() * (14 + t * 6)) });
    } else if (kind === 'attachment') {
      const id = randomAttachment(rng, t);
      out.push({ kind, item: id, rarity: ATTACHMENTS[id].rarity });
    } else {
      const itemId = pickWeighted(rng, tableFor(t)[kind]);
      const def = (kind === 'armor' ? ARMORS : kind === 'consumable' ? CONSUMABLES : THROWABLES)[itemId];
      // 非武器物品的稀有度取自物品定义本身（避免出现「稀有绷带」这类会误导玩家拾取的发光）
      const entry = { kind, item: itemId, rarity: def?.rarity || 'common' };
      if (kind === 'armor') entry.qty = 1;
      else if (def?.stack) entry.qty = 1 + Math.floor(rng() * Math.min(3, def.stack));
      out.push(entry);
    }
  }
  return out;
}

// 空投箱：3-4 件高品质物资，武器必出，其余从史诗/传说池里挑。
export function buildAirdropLoot(rng) {
  const out = [];
  const count = 3 + (rng() < 0.55 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    if (i === 0 || rng() < 0.5) {
      const { id, attachments } = randomWeaponForTier(rng, 3);
      out.push({ kind: 'weapon', item: id, rarity: WEAPONS[id].rarity, ammo: WEAPONS[id].magazine, attachments });
    } else {
      const roll = rollRarity(rng, 3);
      const high = RARITY_INDEX[roll] >= RARITY_INDEX.epic;
      const pool = high
        ? [['aa12', 4], ['svd', 4], ['sr338', 4], ['awm', 2], ['pkm', 4], ['scope_8x', 5], ['drum_mag', 4]]
        : [['scope_4x', 4], ['suppressor', 4], ['medkit', 4], ['armor3', 4], ['shield', 3]];
      const id = pickWeighted(rng, pool);
      if (ATTACHMENTS[id]) out.push({ kind: 'attachment', item: id, rarity: ATTACHMENTS[id].rarity });
      else if (CONSUMABLES[id]) out.push({ kind: 'consumable', item: id, rarity: CONSUMABLES[id].rarity, qty: 1 + Math.floor(rng() * 2) });
      else if (ARMORS[id]) out.push({ kind: 'armor', item: id, rarity: ARMORS[id].rarity, qty: 1 });
      else out.push({ kind: 'weapon', item: id, rarity: WEAPONS[id].rarity, ammo: WEAPONS[id].magazine, attachments: [] });
    }
  }
  return out;
}

export { WEAPONS, ATTACHMENTS, ARMORS, CONSUMABLES, THROWABLES, BACKPACKS, ITEM_LOOKUP };
