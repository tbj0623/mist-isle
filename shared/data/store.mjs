// 雾岛突围 / MIST ISLE — 商店与外观（共享数据，无 DOM）
// 全部外观都能用信用点购买或靠进度解锁（无付费点）。默认解锁项 price:0 + default:true。
// 武器外观的 itemId/weapon 绑定 shared/data/weapons.mjs 的武器 id。
//
// 价格梯度：T1 500–900 / T2 1200–2000 / T3 2600–4000 / 传说 6000+。
// unlock 三种形态：
//   { level: 30 }                    → 等级门槛（unlockLevel 同步写入，兼容旧 UI）
//   { achievement: 'a_kill_1000' }   → 成就解锁（price:0，领取成就时自动发放）
//   { season: 'S1' }                 → 赛季标签（不拦购买，只做展示）

import { RARITY, RARITY_NAMES } from '../rules.mjs';
// 精通奖励（v1.1.0 补全）：mastery.mjs 的 rewardsAtLevel() 发出的 id 全部在这里有实体。
// 这些条目不进 STORE_ALL（商店不出售），但会被 getStoreItem()/getSkin() 查到，
// 所以精通发放后可以正常装备；是否可购买一律以 unlockSource()/purchasable 为准。
import {
  MASTERY_SKINS, MASTERY_CHARMS, MASTERY_TITLES, MASTERY_VOICES,
  MASTERY_EMBLEMS, MASTERY_COSMETICS, MASTERY_REWARDS, MASTERY_REWARD_BY_ID,
  skinsForWeapon, masteryRewardsForWeapon,
} from './unlocks.mjs';

const tierOf = price => (price >= 6000 ? 'legendary' : price >= 2600 ? 't3' : price >= 1200 ? 't2' : price > 0 ? 't1' : 'free');

const skin = (id, name, price, rarity, colors, desc, extra = {}) => ({
  id, name, kind: 'character', itemId: id, price, rarity, colors, desc,
  unlockLevel: extra.unlock?.level ?? 1, default: false, tier: tierOf(price), tag: '', ...extra,
});

// 角色皮肤 22：3 默认 + 12 购买 + 7 成就金皮
export const SKINS = [
  skin('skin_default', '雾行者', 0, 'common', { primary: 0xf3b655, secondary: 0x2b4a4f, accent: 0xffdc8c }, '标准作战服，岛上的第一次呼吸。', { default: true, tag: '初始' }),
  skin('skin_scout', '侦察兵', 0, 'common', { primary: 0x7c9e68, secondary: 0x2f3d33, accent: 0xa7c98a }, '轻装林地伪装，脚步更轻。', { default: true, tag: '初始' }),
  skin('skin_medic', '白袍医官', 0, 'uncommon', { primary: 0xe6e8e2, secondary: 0x8fb6a8, accent: 0xd05c4f }, '红十字袖标在雾里格外显眼。', { default: true, tag: '初始' }),
  skin('skin_rust', '锈锚船员', 700, 'common', { primary: 0x8b6a4a, secondary: 0x354b52, accent: 0xd9a05b }, '旧港打捞队留下的防水外套，盐渍洗不掉。', { tag: '基础' }),
  skin('skin_sand', '赤砂旅人', 900, 'uncommon', { primary: 0xd2a064, secondary: 0x6b5137, accent: 0xf0d39a }, '风沙磨出的厚布与护目镜，走过沙暴不留脚印。', { tag: '基础' }),
  skin('skin_ember', '余烬消防员', 1400, 'rare', { primary: 0xb6483a, secondary: 0x2e2b28, accent: 0xffb35c }, '隔热纤维里还带着烧焦的气味。', { tag: '赛季限定' }),
  skin('skin_night', '长夜哨兵', 1800, 'rare', { primary: 0x1f2b3a, secondary: 0x3d5a6c, accent: 0x6fd0e8 }, '深色涂层，肩灯只在必要时亮起。', { tag: '长夜' }),
  skin('skin_frost', '霜岸猎手', 2000, 'rare', { primary: 0xdfe9ee, secondary: 0x6f8fa3, accent: 0x9fd4e8 }, '积雪反光下的白色斗篷，呼吸都结成霜。', { tag: '长夜' }),
  skin('skin_quarry', '矿坑工头', 2600, 'epic', { primary: 0x6d7f8f, secondary: 0xb08a4a, accent: 0xffe08a }, '头灯与重型护具，能把矿道走成家。', { unlock: { level: 8 }, tag: '史诗' }),
  skin('skin_diver', '深潜者', 2800, 'epic', { primary: 0x2f5f6b, secondary: 0x10262e, accent: 0x7ff0d8 }, '从沉船里爬上来的人，一身水压的味道。', { unlock: { level: 10 }, tag: '史诗' }),
  skin('skin_smuggler', '走私客', 3000, 'epic', { primary: 0x4a3b5c, secondary: 0x2a2233, accent: 0xc48bf0 }, '缝满暗袋的长风衣，永远有第三只手。', { unlock: { level: 12 }, tag: '赛季限定' }),
  skin('skin_beacon', '灯塔守望', 3400, 'epic', { primary: 0xf2e2b8, secondary: 0x24506b, accent: 0xffd75e }, '海雾里的一束暖光，替迷路的人留着。', { unlock: { level: 15 }, tag: '史诗' }),
  skin('skin_ash', '灰烬行者', 3600, 'epic', { primary: 0x3a3330, secondary: 0x151212, accent: 0xff7a3c }, '走过焦土的人，脚印会自己烧起来。', { unlock: { level: 18 }, tag: '联动' }),
  skin('skin_legend_mist', '雾岛之主', 6800, 'legendary', { primary: 0x2b4a4f, secondary: 0xc48bf0, accent: 0x7ff0d8 }, '传说中走进雾里就不再回来的人。', { unlock: { level: 20 }, tag: '传说' }),
  skin('skin_legend_dawn', '破晓号角', 7200, 'legendary', { primary: 0xe8c26a, secondary: 0x7a2e2e, accent: 0xfff1c2 }, '每次突围，都会吹响它——只是没人听过回声。', { unlock: { level: 25 }, tag: '传说' }),
  skin('skin_gold_thousand', '千杀之冠', 0, 'legendary', { primary: 0x1a1a1f, secondary: 0xf5b445, accent: 0xfff3c0 }, '冠冕由一千枚弹壳焊成，戴上它的人从不低头。', { unlock: { achievement: 'a_kill_1000' }, tag: '成就奖励' }),
  skin('skin_gold_skull', '颅骨王座', 0, 'legendary', { primary: 0x2a2429, secondary: 0xd8d2c4, accent: 0xc48bf0 }, '一千次瞄准眉心的人，最后学会了平静。', { unlock: { achievement: 'a_headshot_1000' }, tag: '成就奖励' }),
  skin('skin_gold_untouched', '无瑕之白', 0, 'legendary', { primary: 0xf5f4ef, secondary: 0xbfc9c2, accent: 0xffd75e }, '一场没被碰到的胜利，衣服上连雾都没沾。', { unlock: { achievement: 'a_unscathed_win' }, tag: '成就奖励' }),
  skin('skin_gold_finalist', '决赛圈之王', 0, 'legendary', { primary: 0x1c2a33, secondary: 0xf5b445, accent: 0xff6a5a }, '十次决赛圈，十次站着走出烟里的人。', { unlock: { achievement: 'a_top3_streak_10' }, tag: '成就奖励' }),
  skin('skin_gold_medic', '生命之链', 0, 'legendary', { primary: 0xeaf2ec, secondary: 0x2f6b5a, accent: 0x7ff0d8 }, '一百次把队友从死亡线上拽回来，绳子磨出了光。', { unlock: { achievement: 'a_revive_100' }, tag: '成就奖励' }),
  skin('skin_gold_cartographer', '三岛制图师', 0, 'legendary', { primary: 0x2b3a2f, secondary: 0xc9a66b, accent: 0x9fd4e8 }, '三张地图的每一道风，他都画在了袖口上。', { unlock: { achievement: 'a_all_maps_win' }, tag: '成就奖励' }),
  skin('skin_gold_veteran', '雾岛老兵', 0, 'legendary', { primary: 0x4a4a48, secondary: 0x8a6a4a, accent: 0xe2bb5b }, '三百场之后，衣服比人更懂这座岛。', { unlock: { achievement: 'a_match_300' }, tag: '成就奖励' }),
];

// 武器皮肤 26：20 购买 + 6 成就金皮
export const WEAPON_SKINS = [
  { id: 'wskin_p9_ivory', name: 'P9 · 象牙', kind: 'weapon', itemId: 'p9', price: 500, rarity: 'common', colors: { primary: 0xe8e3d2, secondary: 0x4a4238, accent: 0xc9a66b }, desc: '温润的象牙握把，摸起来像旧时的烟盒。', tier: 't1', tag: '基础' },
  { id: 'wskin_p9_rust', name: 'P9 · 锈蚀', kind: 'weapon', itemId: 'p9', price: 700, rarity: 'uncommon', colors: { primary: 0x8a6a4f, secondary: 0x3a2f27, accent: 0xd08a4a }, desc: '从旧港淤泥里捞出来的版本，还能响。', tier: 't1', tag: '基础' },
  { id: 'wskin_v9_steel', name: 'V9 · 冷钢', kind: 'weapon', itemId: 'v9', price: 900, rarity: 'uncommon', colors: { primary: 0x9fb0b8, secondary: 0x30393d, accent: 0x7fd0cf }, desc: '抛光到能映出雾的形状。', tier: 't1', tag: '基础' },
  { id: 'wskin_ar7_olive', name: 'AR7 · 橄榄', kind: 'weapon', itemId: 'ar7', price: 800, rarity: 'uncommon', colors: { primary: 0x6f7a52, secondary: 0x2f3529, accent: 0xb6c08a }, desc: '林地标准涂装，油味比枪味重。', tier: 't1', tag: '基础' },
  { id: 'wskin_ar7_night', name: 'AR7 · 夜巡', kind: 'weapon', itemId: 'ar7', price: 1200, rarity: 'rare', colors: { primary: 0x222c35, secondary: 0x0f151a, accent: 0x6fb7f0 }, desc: '哑光吸光涂层，在灯下也只剩一个轮廓。', tier: 't2', tag: '长夜' },
  { id: 'wskin_mp5k_tide', name: 'MP5K · 潮汐', kind: 'weapon', itemId: 'mp5k', price: 1300, rarity: 'uncommon', colors: { primary: 0x3b6e78, secondary: 0x14272c, accent: 0x9fe8d8 }, desc: '机匣上的波纹随着潮位变化。', tier: 't2', tag: '基础' },
  { id: 'wskin_s12_hazard', name: 'S12 · 警戒', kind: 'weapon', itemId: 's12', price: 1400, rarity: 'uncommon', colors: { primary: 0xd8c23a, secondary: 0x22221c, accent: 0xfff07a }, desc: '黄黑警示条，嗓门一样大。', tier: 't2', tag: '基础' },
  { id: 'wskin_m60_industrial', name: 'M60 · 工业', kind: 'weapon', itemId: 'm60', price: 1500, rarity: 'rare', colors: { primary: 0x4a5259, secondary: 0x22282c, accent: 0xe07a3a }, desc: '仓库里焊接出来的怪物，焊缝没打磨过。', tier: 't2', tag: '基础' },
  { id: 'wskin_v9_ember', name: 'V9 · 余烬', kind: 'weapon', itemId: 'v9', price: 1600, rarity: 'rare', colors: { primary: 0x50302a, secondary: 0x241b19, accent: 0xff8a4a }, desc: '枪管上还留着烤蓝的痕迹。', tier: 't2', tag: '赛季限定' },
  { id: 'wskin_s12_blood', name: 'S12 · 獠牙', kind: 'weapon', itemId: 's12', price: 1900, rarity: 'rare', colors: { primary: 0x5a2020, secondary: 0x241010, accent: 0xff6a5a }, desc: '近身距离的唯一语言。', tier: 't2', tag: '赛季限定' },
  { id: 'wskin_m14_fog', name: 'M14 · 雾隐', kind: 'weapon', itemId: 'm14', price: 2000, rarity: 'rare', colors: { primary: 0x5b6e6a, secondary: 0x2a3533, accent: 0x8fb6a8 }, desc: '枪身做旧成海雾的颜色，抬枪像叹气。', tier: 't2', tag: '长夜' },
  { id: 'wskin_awm_white', name: 'AWM · 白夜', kind: 'weapon', itemId: 'awm', price: 2600, rarity: 'epic', colors: { primary: 0xe4ecf0, secondary: 0x5f7480, accent: 0x9fd4e8 }, desc: '雪原上只剩呼吸声。', tier: 't3', tag: '长夜' },
  { id: 'wskin_vector_neon', name: 'Vector · 霓虹', kind: 'weapon', itemId: 'vector', price: 3000, rarity: 'epic', colors: { primary: 0x1d2b3a, secondary: 0x101820, accent: 0x7ff0d8 }, desc: '长夜里最亮的那一条弹道。', tier: 't3', tag: '赛季限定' },
  { id: 'wskin_aa12_furnace', name: 'AA12 · 熔炉', kind: 'weapon', itemId: 'aa12', price: 3200, rarity: 'epic', colors: { primary: 0x5c2a1e, secondary: 0x1d100c, accent: 0xffb35c }, desc: '连续喷吐十二发，机匣烫得能烤手。', tier: 't3', tag: '史诗' },
  { id: 'wskin_ar7_gold', name: 'AR7 · 沙金', kind: 'weapon', itemId: 'ar7', price: 3400, rarity: 'epic', colors: { primary: 0xc9a14a, secondary: 0x3a2d1b, accent: 0xffe9a8 }, desc: '赤砂矿区的战利品镀层。', tier: 't3', tag: '史诗' },
  { id: 'wskin_awm_obsidian', name: 'AWM · 黑曜', kind: 'weapon', itemId: 'awm', price: 3800, rarity: 'epic', colors: { primary: 0x1a1c22, secondary: 0x0b0c10, accent: 0xc48bf0 }, desc: '切面像火山玻璃，摸上去是凉的。', tier: 't3', tag: '史诗' },
  { id: 'wskin_pkm_iron', name: 'PKM · 铁幕', kind: 'weapon', itemId: 'pkm', price: 4000, rarity: 'epic', colors: { primary: 0x3d4248, secondary: 0x14171a, accent: 0xe2bb5b }, desc: '弹链拖在地上，像一道会走的铁幕。', tier: 't3', tag: '史诗' },
  { id: 'wskin_ak12_rustfire', name: 'AK12 · 锈火', kind: 'weapon', itemId: 'ak12', price: 6000, rarity: 'legendary', colors: { primary: 0x7a4a32, secondary: 0x2b1d15, accent: 0xffb35c }, desc: '每打一枪都像在拆自己，可它从不散架。', tier: 'legendary', tag: '传说' },
  { id: 'wskin_sr338_phantom', name: 'SR338 · 幻痛', kind: 'weapon', itemId: 'sr338', price: 6600, rarity: 'legendary', colors: { primary: 0x2a2f3a, secondary: 0x0d1016, accent: 0x8fb6ff }, desc: '枪响之后才想起自己开过枪。', tier: 'legendary', tag: '传说' },
  { id: 'wskin_legend_typhoon', name: 'M60 · 台风眼', kind: 'weapon', itemId: 'm60', price: 7600, rarity: 'legendary', colors: { primary: 0x1e3a44, secondary: 0x0a171c, accent: 0x9ff0ff }, desc: '最安静的地方，永远是风暴的中心。', tier: 'legendary', tag: '传说' },
  { id: 'wskin_ar7_reaper', name: 'AR7 · 收魂', kind: 'weapon', itemId: 'ar7', price: 0, rarity: 'legendary', colors: { primary: 0x181418, secondary: 0x0a080a, accent: 0xd05c4f }, desc: '两千次击杀磨出的包浆，比漆更黑。', tier: 'legendary', tag: '成就奖励', unlock: { achievement: 'a_kill_2000' } },
  { id: 'wskin_awm_eclipse', name: 'AWM · 蚀日', kind: 'weapon', itemId: 'awm', price: 0, rarity: 'legendary', colors: { primary: 0x1a1410, secondary: 0x0b0908, accent: 0xf5b445 }, desc: '一发子弹遮住了太阳，只用了十五次。', tier: 'legendary', tag: '成就奖励', unlock: { achievement: 'a_kill_15_match' } },
  { id: 'wskin_sr338_zenith', name: 'SR338 · 天顶', kind: 'weapon', itemId: 'sr338', price: 0, rarity: 'legendary', colors: { primary: 0xe8eef5, secondary: 0x2b3a4a, accent: 0xffd75e }, desc: '八连胜之后，准星再也没抖过。', tier: 'legendary', tag: '成就奖励', unlock: { achievement: 'a_win_streak_8' } },
  { id: 'wskin_vector_midnight', name: 'Vector · 子夜', kind: 'weapon', itemId: 'vector', price: 0, rarity: 'legendary', colors: { primary: 0x141a2a, secondary: 0x080a12, accent: 0x9fb6ff }, desc: '在最黑的夜里赢了之后，枪自己亮了起来。', tier: 'legendary', tag: '成就奖励', unlock: { achievement: 'a_night_win' } },
  { id: 'wskin_m60_arsenal', name: 'M60 · 军械库', kind: 'weapon', itemId: 'm60', price: 0, rarity: 'legendary', colors: { primary: 0x4a4a3e, secondary: 0x1d1d18, accent: 0xe2bb5b }, desc: '十八把枪都用过的人，最后选了最重的这把。', tier: 'legendary', tag: '成就奖励', unlock: { achievement: 'a_all_weapons' } },
  { id: 'wskin_crossbow_bone', name: '猎手弩 · 骨白', kind: 'weapon', itemId: 'crossbow', price: 0, rarity: 'legendary', colors: { primary: 0xdcd3bd, secondary: 0x4a4034, accent: 0xb08a6a }, desc: '捡来的骨头磨成了弩臂，现在它是首领的。', tier: 'legendary', tag: '成就奖励', unlock: { achievement: 'a_horde_boss' } },
];

// 其他商店条目 20：喷漆 / 表情 / 降落伞 / 载具涂装 / 名片
// kind 统一为 'other' 以便 UI 的 skinKind() 归入「其他物品」页；slot 保留具体类别。
const other = (id, name, slot, price, rarity, colors, desc, extra = {}) => ({
  id, name, kind: 'other', slot, itemId: id, price, rarity, colors, desc,
  unlockLevel: extra.unlock?.level ?? 1, tier: tierOf(price), tag: '', ...extra,
});

export const STORE_ITEMS = [
  other('spray_mist_eye', '喷漆 · 雾眼', 'spray', 500, 'common', { primary: 0x8fb6a8 }, '墙上睁开的一只雾眼，看久了会觉得它在眨眼。', { tag: '基础' }),
  other('emote_salute', '表情 · 敬礼', 'emote', 600, 'common', { primary: 0xf3b655 }, '对倒下的对手表示尊重，也对自己。', { tag: '基础' }),
  other('spray_wolf', '喷漆 · 苍狼', 'spray', 750, 'uncommon', { primary: 0x9fb0b8 }, '狼头只剩一半，更凶。', { tag: '基础' }),
  other('emote_taunt', '表情 · 挑衅', 'emote', 900, 'uncommon', { primary: 0xd05c4f }, '风险与快乐成正比，尤其在决赛圈。', { tag: '基础' }),
  other('car_paint_hazard', '载具涂装 · 警戒', 'vehicle', 1200, 'uncommon', { primary: 0xd8c23a, secondary: 0x22221c }, '让所有人都看见你冲过来——这本来就是战术。', { tag: '基础' }),
  other('spray_radio', '喷漆 · 无线电', 'spray', 1300, 'rare', { primary: 0xe2bb5b }, '频率 7.7，永远只有杂音，偶尔有人喊你的名字。', { tag: '长夜' }),
  other('emote_wave', '表情 · 招手', 'emote', 1400, 'rare', { primary: 0x7ed3a5 }, '队友，这边。', { tag: '基础' }),
  // 稀有度必须与价位匹配：1600/1800 已在 rare 档，原先标 uncommon 会造成
  // 「更贵的反而更不稀有」的倒挂（test/content-expansion.test.mjs 断言捕捉到）。
  other('chute_mist', '降落伞 · 白雾', 'parachute', 1600, 'rare', { primary: 0xdfe9ee, secondary: 0x8fb6a8 }, '开伞时像一片云，落地时像一场雾。', { tag: '基础' }),
  other('card_veteran', '名片 · 老兵', 'card', 1800, 'rare', { primary: 0xb07a4f }, '结算界面的身份标签，边角磨白了。', { tag: '基础' }),
  other('car_paint_fog', '载具涂装 · 雾隐', 'vehicle', 2000, 'rare', { primary: 0x5b6e6a, secondary: 0x2a3533 }, '慢，但安静，适合把整队人送进决赛圈。', { tag: '长夜' }),
  other('chute_dawn', '降落伞 · 破晓', 'parachute', 2600, 'epic', { primary: 0xffd75e, secondary: 0xc45a3a }, '落地前先亮一下，让底下的人抬头。', { unlock: { level: 8 }, tag: '史诗' }),
  other('card_mistwalker', '名片 · 雾行者', 'card', 2800, 'epic', { primary: 0xc48bf0 }, '只有走过整座岛的人，才配这个底色。', { unlock: { level: 12 }, tag: '史诗' }),
  other('spray_legend', '喷漆 · 传说签名', 'spray', 3200, 'epic', { primary: 0xf5b445 }, '签在墙上，也签在别人的记忆里。', { unlock: { level: 15 }, tag: '赛季限定' }),
  other('emote_laststand', '表情 · 最后一舞', 'emote', 3400, 'epic', { primary: 0xc48bf0 }, '决赛圈 1v4 之前，先跳完这段。', { unlock: { level: 18 }, tag: '赛季限定' }),
  other('chute_storm', '降落伞 · 风暴眼', 'parachute', 3600, 'epic', { primary: 0x2b4a4f, secondary: 0x9ff0ff }, '从台风眼里跳下去，落地时风还没停。', { unlock: { level: 20 }, tag: '联动' }),
  other('car_paint_gold', '载具涂装 · 鎏金', 'vehicle', 0, 'legendary', { primary: 0xf5b445, secondary: 0x2b2110 }, '三十件外观换来的颜色，开出去像一场游行。', { unlock: { achievement: 'a_collect_skins_30' }, tag: '成就奖励' }),
  other('card_legend', '名片 · 雾岛之主', 'card', 6200, 'legendary', { primary: 0x2b4a4f, secondary: 0xf5b445 }, '整座岛都在你的名片背面。', { unlock: { level: 30 }, tag: '传说' }),
  other('chute_legend', '降落伞 · 归途', 'parachute', 6800, 'legendary', { primary: 0xe8c26a, secondary: 0x2b4a4f }, '传说落地的那一瞬，雾会自己让开。', { unlock: { level: 32 }, tag: '传说' }),
  other('emote_gold_crown', '表情 · 加冕', 'emote', 0, 'legendary', { primary: 0xf5b445 }, '只有千杀之人才配戴上的那一下。', { unlock: { achievement: 'a_kill_1000' }, tag: '成就奖励' }),
  other('spray_gold_mark', '喷漆 · 金色印记', 'spray', 0, 'legendary', { primary: 0xe2bb5b }, '留在战场上的最后一个记号，擦不掉。', { unlock: { achievement: 'a_kill_500' }, tag: '成就奖励' }),
];

export const STORE_KINDS = ['character', 'weapon', 'other'];
export const STORE_SLOTS = ['character', 'weapon', 'spray', 'emote', 'parachute', 'vehicle', 'card'];
export const PRICE_TIERS = {
  t1: { name: '入门', min: 500, max: 900 },
  t2: { name: '进阶', min: 1200, max: 2000 },
  t3: { name: '高阶', min: 2600, max: 4000 },
  legendary: { name: '传说', min: 6000, max: Infinity },
};
export const STORE_ALL = [...SKINS, ...WEAPON_SKINS, ...STORE_ITEMS];
// 查询表要含精通奖励：getStoreItem()/getSkin()/equipSkin() 都走这里。
export const STORE_BY_ID = Object.fromEntries(
  [...STORE_ALL, ...MASTERY_REWARDS].map(item => [item.id, item]),
);

export function getSkin(id) { return STORE_BY_ID[id] || null; }
export function getStoreItem(id) { return STORE_BY_ID[id] || null; }
export function storeItemsOfKind(kind) { return STORE_ALL.filter(item => item.kind === kind); }
export function weaponSkinsFor(weaponId) { return WEAPON_SKINS.filter(s => s.itemId === weaponId); }
export function rarityLabel(rarity) { return RARITY_NAMES[rarity] || rarity; }
export function isRarity(rarity) { return RARITY.includes(rarity); }
export function defaultSkinIds() { return SKINS.filter(s => s.default).map(s => s.id); }
export function priceTierOf(price) { return tierOf(Number(price) || 0); }
// 成就解锁的物品：id 列表，供 client/meta.js 在成就达成时自动发放。
export function achievementUnlocks() {
  return STORE_ALL.filter(item => item.unlock?.achievement).map(item => ({ id: item.id, achievement: item.unlock.achievement }));
}
export function levelUnlocks(level) {
  const lv = Math.max(1, Number(level) || 1);
  return STORE_ALL.filter(item => !item.unlock?.achievement && Number(item.unlockLevel || 1) <= lv).map(item => item.id);
}

// ── 精通奖励（v1.1.0）───────────────────────────────────────────────────────
// 90 条：18 把枪 × (field / gold / charm / voice / master)。另附 18 个 Lv1 徽记，
// 保证 rewardsAtLevel() 每一级发出的 id 都能在数据里查到。
export { MASTERY_SKINS, MASTERY_CHARMS, MASTERY_TITLES, MASTERY_VOICES, MASTERY_EMBLEMS };
export { MASTERY_COSMETICS, MASTERY_REWARDS, MASTERY_REWARD_BY_ID, masteryRewardsForWeapon };
export { skinsForWeapon };

// 精通奖励也进 STORE_BY_ID（getStoreItem/equipSkin 要能查到），但不进 STORE_ALL，
// 商店目录/等级解锁/成就发放都不会把它们当成可购买商品。
export const STORE_LOOKUP = Object.freeze({ ...STORE_BY_ID, ...MASTERY_REWARD_BY_ID });

Object.assign(STORE_BY_ID, MASTERY_REWARD_BY_ID);

/**
 * 该 id 的获取方式。三种形态：
 *   { kind:'mastery', weaponId, level }   精通 Lv 奖励，不可用信用点购买
 *   { kind:'achievement', achievement }   成就奖励，达成后自动发放
 *   { kind:'credits', price }             信用点购买
 * 未知 id 返回 null。
 */
export function unlockSource(id) {
  const item = STORE_BY_ID[id];
  if (!item) return null;
  const mastery = item.unlock?.mastery;
  if (mastery && mastery.weaponId) {
    return { kind: 'mastery', weaponId: mastery.weaponId, level: Number(mastery.level) || 1 };
  }
  if (item.unlock?.achievement) return { kind: 'achievement', achievement: item.unlock.achievement };
  return { kind: 'credits', price: Number(item.price) || 0 };
}

// 能否用信用点买：精通/成就奖励一律 false。
export function isPurchasable(id) {
  const source = unlockSource(id);
  return !!source && source.kind === 'credits';
}

// 购买入口的守卫：UI 必须先调用它，避免精通奖励被当成商品买走。
// 返回 { ok:true } 或 { ok:false, error:'unknown-item'|'mastery-required'|'achievement-required' }。
export function purchaseGuard(id) {
  const source = unlockSource(id);
  if (!source) return { ok: false, error: 'unknown-item' };
  if (source.kind === 'mastery') return { ok: false, error: 'mastery-required', weaponId: source.weaponId, level: source.level };
  if (source.kind === 'achievement') return { ok: false, error: 'achievement-required', achievement: source.achievement };
  return { ok: true };
}

// 某把枪在给定精通等级下已解锁的奖励 id（供 UI 打勾/置灰）。
export function masteryUnlocksFor(weaponId, level = 0) {
  const lv = Math.max(0, Math.floor(Number(level) || 0));
  return MASTERY_REWARDS
    .filter(item => item.weaponId === weaponId && Number(item.masteryLevel) <= lv)
    .map(item => item.id);
}
