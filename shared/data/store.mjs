// 雾岛突围 / MIST ISLE — 商店与外观（共享数据，无 DOM）
// 全部外观都能用信用点购买（无付费点）。默认解锁项 price:0 + default:true。
// 武器外观的 itemId/weapon 绑定 shared/data/weapons.mjs 的武器 id。

import { RARITY, RARITY_NAMES } from '../rules.mjs';

const skin = (id, name, price, rarity, colors, desc, extra = {}) => ({
  id, name, kind: 'character', itemId: id, price, rarity, colors, desc, unlockLevel: 1, default: false, ...extra,
});

// 角色皮肤 ≥12；前 3 个默认解锁
export const SKINS = [
  skin('skin_default', '雾行者', 0, 'common', { primary: 0xf3b655, secondary: 0x2b4a4f, accent: 0xffdc8c }, '标准作战服，岛上的第一次呼吸。', { default: true }),
  skin('skin_scout', '侦察兵', 0, 'common', { primary: 0x7c9e68, secondary: 0x2f3d33, accent: 0xa7c98a }, '轻装林地伪装，脚步更轻。', { default: true }),
  skin('skin_medic', '白袍医官', 0, 'uncommon', { primary: 0xe6e8e2, secondary: 0x8fb6a8, accent: 0xd05c4f }, '红十字袖标在雾里格外显眼。', { default: true }),
  skin('skin_rust', '锈锚船员', 1200, 'uncommon', { primary: 0x8b6a4a, secondary: 0x354b52, accent: 0xd9a05b }, '旧港打捞队留下的防水外套。'),
  skin('skin_sand', '赤砂旅人', 1600, 'uncommon', { primary: 0xd2a064, secondary: 0x6b5137, accent: 0xf0d39a }, '风沙磨出的厚布与护目镜。'),
  skin('skin_night', '长夜哨兵', 2200, 'rare', { primary: 0x1f2b3a, secondary: 0x3d5a6c, accent: 0x6fd0e8 }, '深色涂层，肩灯只在必要时亮起。'),
  skin('skin_frost', '霜岸猎手', 2600, 'rare', { primary: 0xdfe9ee, secondary: 0x6f8fa3, accent: 0x9fd4e8 }, '积雪反光下的白色斗篷。'),
  skin('skin_ember', '余烬消防员', 3200, 'rare', { primary: 0xb6483a, secondary: 0x2e2b28, accent: 0xffb35c }, '隔热纤维，带着烧焦的气味。'),
  skin('skin_quarry', '矿坑工头', 3800, 'epic', { primary: 0x6d7f8f, secondary: 0xb08a4a, accent: 0xffe08a }, '头灯与重型护具，能把矿道走成家。'),
  skin('skin_smuggler', '走私客', 4400, 'epic', { primary: 0x4a3b5c, secondary: 0x2a2233, accent: 0xc48bf0 }, '缝满暗袋的长风衣。'),
  skin('skin_beacon', '灯塔守望', 5200, 'epic', { primary: 0xf2e2b8, secondary: 0x24506b, accent: 0xffd75e }, '海雾里的一束暖光。'),
  skin('skin_legend_mist', '雾岛之主', 6800, 'legendary', { primary: 0x2b4a4f, secondary: 0xc48bf0, accent: 0x7ff0d8 }, '传说中走进雾里就不再回来的人。'),
  skin('skin_legend_dawn', '破晓号角', 8200, 'legendary', { primary: 0xe8c26a, secondary: 0x7a2e2e, accent: 0xfff1c2 }, '每次突围，都会吹响它。'),
];

// 武器皮肤 ≥14，每个绑定一把武器（itemId = shared/data/weapons.mjs 的武器 id）
export const WEAPON_SKINS = [
  { id: 'wskin_p9_ivory', name: 'P9 · 象牙', kind: 'weapon', itemId: 'p9', price: 500, rarity: 'common', colors: { primary: 0xe8e3d2, secondary: 0x4a4238, accent: 0xc9a66b }, desc: '温润的象牙握把。' },
  { id: 'wskin_p9_rust', name: 'P9 · 锈蚀', kind: 'weapon', itemId: 'p9', price: 700, rarity: 'uncommon', colors: { primary: 0x8a6a4f, secondary: 0x3a2f27, accent: 0xd08a4a }, desc: '从旧港淤泥里捞出的版本。' },
  { id: 'wskin_v9_steel', name: 'V9 · 冷钢', kind: 'weapon', itemId: 'v9', price: 900, rarity: 'uncommon', colors: { primary: 0x9fb0b8, secondary: 0x30393d, accent: 0x7fd0cf }, desc: '抛光到能映出雾的形状。' },
  { id: 'wskin_v9_ember', name: 'V9 · 余烬', kind: 'weapon', itemId: 'v9', price: 1400, rarity: 'rare', colors: { primary: 0x50302a, secondary: 0x241b19, accent: 0xff8a4a }, desc: '枪管上还留着烤蓝的痕迹。' },
  { id: 'wskin_ar7_olive', name: 'AR7 · 橄榄', kind: 'weapon', itemId: 'ar7', price: 800, rarity: 'uncommon', colors: { primary: 0x6f7a52, secondary: 0x2f3529, accent: 0xb6c08a }, desc: '林地标准涂装。' },
  { id: 'wskin_ar7_night', name: 'AR7 · 夜巡', kind: 'weapon', itemId: 'ar7', price: 1800, rarity: 'rare', colors: { primary: 0x222c35, secondary: 0x0f151a, accent: 0x6fb7f0 }, desc: '哑光吸光涂层。' },
  { id: 'wskin_ar7_gold', name: 'AR7 · 沙金', kind: 'weapon', itemId: 'ar7', price: 3600, rarity: 'epic', colors: { primary: 0xc9a14a, secondary: 0x3a2d1b, accent: 0xffe9a8 }, desc: '赤砂矿区的战利品镀层。' },
  { id: 'wskin_s12_hazard', name: 'S12 · 警戒', kind: 'weapon', itemId: 's12', price: 1100, rarity: 'uncommon', colors: { primary: 0xd8c23a, secondary: 0x22221c, accent: 0xfff07a }, desc: '黄黑警示条，嗓门一样大。' },
  { id: 'wskin_s12_blood', name: 'S12 · 獠牙', kind: 'weapon', itemId: 's12', price: 1900, rarity: 'rare', colors: { primary: 0x5a2020, secondary: 0x241010, accent: 0xff6a5a }, desc: '近身距离的唯一语言。' },
  { id: 'wskin_awm_white', name: 'AWM · 白夜', kind: 'weapon', itemId: 'awm', price: 2600, rarity: 'epic', colors: { primary: 0xe4ecf0, secondary: 0x5f7480, accent: 0x9fd4e8 }, desc: '雪原上只剩呼吸声。' },
  { id: 'wskin_awm_obsidian', name: 'AWM · 黑曜', kind: 'weapon', itemId: 'awm', price: 4200, rarity: 'epic', colors: { primary: 0x1a1c22, secondary: 0x0b0c10, accent: 0xc48bf0 }, desc: '切面像火山玻璃。' },
  { id: 'wskin_m60_industrial', name: 'M60 · 工业', kind: 'weapon', itemId: 'm60', price: 1500, rarity: 'rare', colors: { primary: 0x4a5259, secondary: 0x22282c, accent: 0xe07a3a }, desc: '仓库里焊接出来的怪物。' },
  { id: 'wskin_m14_fog', name: 'M14 · 雾隐', kind: 'weapon', itemId: 'm14', price: 2100, rarity: 'rare', colors: { primary: 0x5b6e6a, secondary: 0x2a3533, accent: 0x8fb6a8 }, desc: '枪身做旧成海雾的颜色。' },
  { id: 'wskin_crossbow_bone', name: '猎手弩 · 骨白', kind: 'weapon', itemId: 'crossbow', price: 2400, rarity: 'epic', colors: { primary: 0xdcd3bd, secondary: 0x4a4034, accent: 0xb08a6a }, desc: '捡来的骨头磨成了弩臂。' },
  { id: 'wskin_vector_neon', name: 'Vector · 霓虹', kind: 'weapon', itemId: 'vector', price: 3000, rarity: 'epic', colors: { primary: 0x1d2b3a, secondary: 0x101820, accent: 0x7ff0d8 }, desc: '长夜里最亮的那一条弹道。' },
  { id: 'wskin_ak12_rustfire', name: 'AK12 · 锈火', kind: 'weapon', itemId: 'ak12', price: 5000, rarity: 'legendary', colors: { primary: 0x7a4a32, secondary: 0x2b1d15, accent: 0xffb35c }, desc: '每打一枪都像在拆自己。' },
];

// 其他商店条目 ≥8：喷漆 / 表情 / 降落伞 / 载具涂装 / 名片
// kind 统一为 'other' 以便 UI 的 skinKind() 归入「其他物品」页；slot 保留具体类别。
const other = (id, name, slot, price, rarity, colors, desc, extra = {}) => ({
  id, name, kind: 'other', slot, itemId: id, price, rarity, colors, desc, unlockLevel: 1, ...extra,
});

export const STORE_ITEMS = [
  other('spray_mist_eye', '喷漆 · 雾眼', 'spray', 300, 'common', { primary: 0x8fb6a8 }, '墙上睁开的一只雾眼。'),
  other('spray_wolf', '喷漆 · 苍狼', 'spray', 560, 'uncommon', { primary: 0x9fb0b8 }, '狼头只剩一半，更凶。'),
  other('spray_radio', '喷漆 · 无线电', 'spray', 900, 'rare', { primary: 0xe2bb5b }, '频率 7.7，永远只有杂音。'),
  other('emote_salute', '表情 · 敬礼', 'emote', 400, 'common', { primary: 0xf3b655 }, '对倒下的对手表示尊重。'),
  other('emote_taunt', '表情 · 挑衅', 'emote', 700, 'uncommon', { primary: 0xd05c4f }, '风险与快乐成正比。'),
  other('emote_wave', '表情 · 招手', 'emote', 850, 'rare', { primary: 0x7ed3a5 }, '队友，这边。'),
  other('chute_mist', '降落伞 · 白雾', 'parachute', 1200, 'uncommon', { primary: 0xdfe9ee, secondary: 0x8fb6a8 }, '开伞时像一片云。'),
  other('chute_dawn', '降落伞 · 破晓', 'parachute', 2400, 'epic', { primary: 0xffd75e, secondary: 0xc45a3a }, '落地前先亮一下。', { unlockLevel: 8 }),
  other('car_paint_hazard', '载具涂装 · 警戒', 'vehicle', 1000, 'uncommon', { primary: 0xd8c23a, secondary: 0x22221c }, '让所有人都看见你冲过来。'),
  other('car_paint_fog', '载具涂装 · 雾隐', 'vehicle', 1800, 'rare', { primary: 0x5b6e6a, secondary: 0x2a3533 }, '慢，但安静。'),
  other('card_veteran', '名片 · 老兵', 'card', 600, 'uncommon', { primary: 0xb07a4f }, '结算界面的身份标签。'),
  other('card_mistwalker', '名片 · 雾行者', 'card', 2600, 'legendary', { primary: 0xc48bf0 }, '只有传说才配这个底色。', { unlockLevel: 12 }),
];

export const STORE_KINDS = ['character', 'weapon', 'other'];
export const STORE_SLOTS = ['character', 'weapon', 'spray', 'emote', 'parachute', 'vehicle', 'card'];
export const STORE_ALL = [...SKINS, ...WEAPON_SKINS, ...STORE_ITEMS];
export const STORE_BY_ID = Object.fromEntries(STORE_ALL.map(item => [item.id, item]));

export function getSkin(id) { return STORE_BY_ID[id] || null; }
export function getStoreItem(id) { return STORE_BY_ID[id] || null; }
export function storeItemsOfKind(kind) { return STORE_ALL.filter(item => item.kind === kind); }
export function weaponSkinsFor(weaponId) { return WEAPON_SKINS.filter(s => s.itemId === weaponId); }
export function rarityLabel(rarity) { return RARITY_NAMES[rarity] || rarity; }
export function isRarity(rarity) { return RARITY.includes(rarity); }
export function defaultSkinIds() { return SKINS.filter(s => s.default).map(s => s.id); }
