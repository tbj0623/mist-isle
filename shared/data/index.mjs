// 雾岛突围 / MIST ISLE — 共享数据总出口（服务端 / 客户端 / 离线模拟共用）
// 纯数据 + 纯函数：不依赖 DOM、Node，可被 node --test 直接 import。
// 用法：import { WEAPONS, ITEM_LOOKUP, buildLootForSpot } from './shared/data/index.mjs';

export {
  AMMO_TYPES,
  WEAPON_CLASSES,
  WEAPONS,
  WEAPON_ORDER,
  ATTACHMENTS,
  ATTACHMENT_ORDER,
  ATTACHMENT_SLOTS,
  LOOT_WEAPON_POOL,
  getWeapon,
  getAttachment,
  applyAttachmentMods,
  shotDamage,
  hitsToKill,
  timeToKill,
  burstDps,
  sustainedDps,
  damageAtDistance,
} from './weapons.mjs';

export {
  ARMORS,
  CONSUMABLES,
  THROWABLES,
  BACKPACKS,
  LAND_ATTACHMENT_RARITY,
  ITEM_KINDS,
  CONSUMABLE_ORDER,
  THROWABLE_ORDER,
  BACKPACK_ORDER,
  ITEM_LOOKUP,
  ITEM_NAMES,
  ITEM_ICONS,
  getItem,
  armorForTier,
  stackLimit,
  backpackAmmoCap,
} from './items.mjs';

export {
  LOOT_TABLES,
  RARITY_WEIGHTS,
  RARITY_WEIGHTS_BY_TIER,
  RARITY_INDEX,
  RARITY_BY_INDEX,
  pickWeighted,
  rollRarity,
  maxRarity,
  randomItemForTier,
  randomWeaponForTier,
  randomAttachment,
  attachmentSlotsFor,
  buildLootForSpot,
  buildAirdropLoot,
} from './loot.mjs';

export { MAPS, MAP_ORDER, getMapDef, mapRotation } from './maps.mjs';
