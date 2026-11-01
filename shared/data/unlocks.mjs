// 雾岛突围 / MIST ISLE — 武器精通奖励数据（v1.1.0 补全）
// ─────────────────────────────────────────────────────────────────────────────
// shared/data/mastery.mjs 的 rewardsAtLevel() 会按等级发出这些 id：
//   Lv1  emblem_{weapon}   Lv4  {weapon}_field   Lv6  voice_kill_{weapon}
//   Lv8  charm_{weapon}    Lv10 master_{weapon} + {weapon}_gold
// 本文件补齐它们对应的数据条目，武器 id / 职业 / 配色全部来自 weapons.mjs 真表。
//
// schema 与 store.mjs 的 WEAPON_SKINS / STORE_ITEMS 对齐，只多两个语义字段：
//   unlock: { mastery: { weaponId, level } }  → 只能靠精通等级获得，不可用信用点购买
//   purchasable: false                        → 购买入口应据此隐藏/拒绝
// price 仍按稀有度分档（仅作价值展示，不是售价）。
// 这些条目不进入 STORE_ALL（可购买目录），但会并入 STORE_BY_ID，
// 因此 getStoreItem() / equipSkin() 能查到并装备。
// ─────────────────────────────────────────────────────────────────────────────
import { WEAPONS, WEAPON_ORDER, WEAPON_CLASSES } from './weapons.mjs';

const RARITY_PRICE = { common: 600, uncommon: 900, rare: 2000, epic: 3400, legendary: 7200 };
const tierOf = (price) => (price >= 6000 ? 'legendary' : price >= 2600 ? 't3' : price >= 1200 ? 't2' : price > 0 ? 't1' : 'free');

// k < 1 压暗、k > 1 提亮；只在 0–255 内取整，保证 colors 仍是存进存档的纯数字。
function shade(hex, k) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

// 每个武器系一套文案，避免 90 条奖励长得一模一样；键与 WEAPONS[].cls 对齐。
const CLASS_FLAVOR = {
  pistol: {
    field: '握把与套筒分开配色，拔枪那一下才看得见。',
    charm: '黄铜弹壳', charmDesc: '一枚打空的黄铜弹壳，磨得能照出人来。',
    voice: '“手枪也能翻盘。”',
    title: '弹匣见底时，你仍然先摸它。',
  },
  smg: {
    field: '短枪管配宽弹匣，涂装在狭窄走廊里一闪而过。',
    charm: '弹链铃', charmDesc: '一截变形的弹链头，跑动时晃得像风铃。',
    voice: '“近一点，再近一点。”',
    title: '十米之内，你没有让过谁。',
  },
  rifle: {
    field: '整条枪身压成低饱和地块色，抬枪时像从土里长出来。',
    charm: '铜星', charmDesc: '一枚磨圆的铜星，来自第一场胜利的弹壳。',
    voice: '“这把枪认得我的节奏。”',
    title: '中距离的每一次点射，都算过风。',
  },
  shotgun: {
    field: '枪托刷上醒目的红壳标记，走近就知道是谁。',
    charm: '红壳', charmDesc: '一枚红色塑料弹壳，敲在护木上咯咯响。',
    voice: '“别站在门口。”',
    title: '门后那一声，永远比你想象的近。',
  },
  marksman: {
    field: '细长枪身裹上雾灰色，呼吸和准星一起慢下来。',
    charm: '准星帽', charmDesc: '一枚黄铜准星帽，指腹摩过无数次。',
    voice: '“等风停。”',
    title: '你数过每一段距离，也数过每一次呼吸。',
  },
  sniper: {
    field: '枪管缠上浅色布条，远看只是一道折光。',
    charm: '白羽', charmDesc: '一根白色羽饰，风大时它会先动。',
    voice: '“一枪，一公里。”',
    title: '山脊另一侧的人，从没听见你的脚步。',
  },
  lmg: {
    field: '弹箱与护木刷成工装色，压枪时像一台机器。',
    charm: '弹链节', charmDesc: '一截黄铜弹链，走路时会在背后轻响。',
    voice: '“让他们都趴下。”',
    title: '你守过整条街，换弹的四秒也没丢。',
  },
  special: {
    field: '非常规配色，像从另一套规则里带出来的装备。',
    charm: '雾羽', charmDesc: '一片雾色羽毛，安静得几乎没有重量。',
    voice: '“规则之外，才分胜负。”',
    title: '别人按规则打仗，你按自己的方式活下来。',
  },
};

const flavorOf = (weapon) => CLASS_FLAVOR[weapon.cls] || CLASS_FLAVOR.rifle;

// 统一构造器：kind 'weapon' 的涂装用 itemId 绑武器（与 WEAPON_SKINS 一致），
// 其余品类 itemId 指向自身 id（与 STORE_ITEMS 一致）。
function masteryEntry(weapon, cfg) {
  return {
    id: cfg.id,
    name: cfg.name,
    kind: cfg.kind,
    ...(cfg.slot ? { slot: cfg.slot } : {}),
    itemId: cfg.kind === 'weapon' ? weapon.id : cfg.id,
    price: cfg.price,
    rarity: cfg.rarity,
    colors: cfg.colors,
    desc: cfg.desc,
    tier: tierOf(cfg.price),
    tag: '精通奖励',
    unlockLevel: cfg.level,
    masteryLevel: cfg.level,
    weaponId: weapon.id,
    weaponClass: weapon.cls,
    purchasable: false,
    unlock: { mastery: { weaponId: weapon.id, level: cfg.level } },
  };
}

const fieldSkin = (weapon) => masteryEntry(weapon, {
  id: `${weapon.id}_field`, name: `${weapon.short} · 战地涂装`, kind: 'weapon',
  price: RARITY_PRICE.rare, rarity: 'rare', level: 4,
  colors: { primary: shade(weapon.art.body, 0.92), secondary: shade(weapon.art.accent, 0.72), accent: shade(weapon.art.accent, 1.28) },
  desc: `Lv4 战地涂装：${flavorOf(weapon).field}`,
});

const goldSkin = (weapon) => masteryEntry(weapon, {
  id: `${weapon.id}_gold`, name: `${weapon.short} · 本命金`, kind: 'weapon',
  price: RARITY_PRICE.legendary, rarity: 'legendary', level: 10,
  colors: { primary: 0xd9b45a, secondary: shade(weapon.art.body, 0.7), accent: 0xfff0be },
  desc: 'Lv10 本命涂装：整把枪重新鎏金，握把刻着武器代号与你的本命印记。',
});

const charm = (weapon) => masteryEntry(weapon, {
  id: `charm_${weapon.id}`, name: `${weapon.short} · ${flavorOf(weapon).charm}`, kind: 'other', slot: 'charm',
  price: RARITY_PRICE.epic, rarity: 'epic', level: 8,
  colors: { primary: weapon.art.accent, secondary: shade(weapon.art.body, 0.8), accent: shade(weapon.art.accent, 1.3) },
  desc: `Lv8 枪械挂件：${flavorOf(weapon).charmDesc}`,
});

const voice = (weapon) => masteryEntry(weapon, {
  id: `voice_kill_${weapon.id}`, name: `${weapon.short} · 击杀播报`, kind: 'other', slot: 'voice',
  price: RARITY_PRICE.uncommon, rarity: 'uncommon', level: 6,
  colors: { primary: weapon.art.accent, secondary: weapon.art.body, accent: WEAPON_CLASSES[weapon.cls]?.color || 0x8fb6a8 },
  desc: `Lv6 击杀播报语音：${flavorOf(weapon).voice}`,
});

const title = (weapon) => masteryEntry(weapon, {
  id: `master_${weapon.id}`, name: `${weapon.short} · 本命`, kind: 'other', slot: 'title',
  price: RARITY_PRICE.legendary, rarity: 'legendary', level: 10,
  colors: { primary: WEAPON_CLASSES[weapon.cls]?.color || 0x8fb6a8, secondary: weapon.art.body, accent: 0xf5b445 },
  desc: `Lv10 专属称号「本命」：${flavorOf(weapon).title}`,
});

const emblem = (weapon) => masteryEntry(weapon, {
  id: `emblem_${weapon.id}`, name: `${weapon.short} · 精通徽记`, kind: 'other', slot: 'emblem',
  price: 0, rarity: 'common', level: 1,
  colors: { primary: shade(weapon.art.accent, 1.1), secondary: weapon.art.body, accent: 0xd8d3a2 },
  desc: 'Lv1 精通徽记：第一次把这把枪的保险拨到连发。',
});

const weapons = WEAPON_ORDER.map((id) => WEAPONS[id]).filter(Boolean);

export const MASTERY_SKINS = weapons.flatMap((weapon) => [fieldSkin(weapon), goldSkin(weapon)]);
export const MASTERY_CHARMS = weapons.map(charm);
export const MASTERY_TITLES = weapons.map(title);
export const MASTERY_VOICES = weapons.map(voice);
export const MASTERY_EMBLEMS = weapons.map(emblem);

// 90 条任务要求的精通外观；ema 徽记单列，保证 rewardsAtLevel 的每个 id 也都有数据。
export const MASTERY_COSMETICS = [...MASTERY_SKINS, ...MASTERY_CHARMS, ...MASTERY_TITLES, ...MASTERY_VOICES];
export const MASTERY_REWARDS = [...MASTERY_COSMETICS, ...MASTERY_EMBLEMS];
export const MASTERY_REWARD_BY_ID = Object.freeze(
  Object.fromEntries(MASTERY_REWARDS.map((item) => [item.id, item])),
);

// 该枪的精通涂装（field + gold）；老商店皮肤（wskin_*）不在其中。
export function skinsForWeapon(weaponId) {
  return MASTERY_SKINS.filter((skin) => skin.weaponId === weaponId);
}

// 该枪全部精通奖励（涂装 / 挂件 / 播报 / 称号 / 徽记），按 Lv 升序。
export function masteryRewardsForWeapon(weaponId) {
  return MASTERY_REWARDS
    .filter((item) => item.weaponId === weaponId)
    .sort((a, b) => a.masteryLevel - b.masteryLevel);
}
