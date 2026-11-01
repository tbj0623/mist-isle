// 雾岛突围 / MIST ISLE — 成就（共享数据，无 DOM）
// metric 与 missions.mjs 的 MISSION_METRICS 对齐，另加单局型与特殊型计数。
// hidden: 未解锁前不显示具体条件；icon 为程序化图标 key（客户端可映射到 lucide）。
// category: combat / survival / explore / social / collection / mastery
// tier: bronze / silver / gold（gold 为最难一档，除信用点外奖励专属外观 rewardSkin）

const a = (id, title, desc, metric, target, category, tier, xp, credits, icon, extra = {}) => ({
  id, title, name: title, desc, metric, target, xp, credits, icon,
  category, tier, hidden: false, ...extra,
});

export const ACHIEVEMENT_CATEGORIES = [
  { id: 'combat', name: '战斗' },
  { id: 'survival', name: '生存' },
  { id: 'explore', name: '探索' },
  { id: 'social', name: '团队' },
  { id: 'collection', name: '收集' },
  { id: 'mastery', name: '精通' },
];

export const ACHIEVEMENTS = [
  // ── 战斗 combat（13）─────────────────────────────────────────────────────
  a('a_first_blood', '第一滴血', '完成第一次击杀。', 'kills', 1, 'combat', 'bronze', 80, 50, 'target'),
  a('a_kill_100', '百杀者', '累计击杀 100 名敌人。', 'kills', 100, 'combat', 'bronze', 600, 400, 'skull'),
  a('a_kill_500', '雾岛噩梦', '累计击杀 500 名敌人。', 'kills', 500, 'combat', 'silver', 1600, 1100, 'skull'),
  a('a_kill_1000', '千杀传说', '累计击杀 1000 名敌人。', 'kills', 1000, 'combat', 'gold', 3200, 2200, 'crown', { rewardSkin: 'skin_gold_thousand' }),
  a('a_kill_2000', '杀神降临', '累计击杀 2000 名敌人。', 'kills', 2000, 'combat', 'gold', 5200, 3600, 'crown', { rewardSkin: 'wskin_ar7_reaper' }),
  a('a_kill10_match', '一局十杀', '单局击杀 10 名敌人。', 'matchKills', 10, 'combat', 'silver', 800, 520, 'swords'),
  a('a_kill_15_match', '半个战场', '单局击杀 15 名敌人。', 'matchKills', 15, 'combat', 'gold', 2200, 1500, 'swords', { rewardSkin: 'wskin_awm_eclipse' }),
  a('a_damage_1000', '千伤俱乐部', '单局造成 1000 点伤害。', 'matchDamage', 1000, 'combat', 'bronze', 500, 320, 'flame'),
  a('a_damage_3000', '人形炮台', '单局造成 3000 点伤害。', 'matchDamage', 3000, 'combat', 'gold', 2400, 1600, 'flame'),
  a('a_damage_total', '破坏之王', '累计造成 100000 点伤害。', 'damage', 100000, 'combat', 'silver', 2400, 1600, 'flame'),
  a('a_headshot_50', '爆头专家', '累计爆头 50 次。', 'headshots', 50, 'combat', 'bronze', 600, 380, 'crosshair'),
  a('a_headshot_500', '颅骨收藏家', '累计爆头 500 次。', 'headshots', 500, 'combat', 'silver', 2000, 1300, 'crosshair'),
  a('a_headshot_1000', '颅骨王座', '累计爆头 1000 次。', 'headshots', 1000, 'combat', 'gold', 4200, 2800, 'crosshair', { rewardSkin: 'skin_gold_skull' }),

  // ── 生存 survival（8）────────────────────────────────────────────────────
  a('a_survive_60', '生存一分钟', '单局生存超过 60 秒。', 'matchSurvived', 60, 'survival', 'bronze', 60, 40, 'timer'),
  a('a_survive_300', '熬到缩圈', '单局生存超过 5 分钟。', 'matchSurvived', 300, 'survival', 'silver', 700, 450, 'timer'),
  a('a_survive_total', '时间旅人', '累计生存 10 小时。', 'survived', 36000, 'survival', 'silver', 2000, 1300, 'timer'),
  a('a_unscathed_win', '毫发无伤', '在未受伤的完整血量下赢得对局。', 'unscathedWins', 1, 'survival', 'gold', 1200, 800, 'shield', { rewardSkin: 'skin_gold_untouched' }),
  a('a_top3_streak', '稳定前三', '连续 3 局进入前三名。', 'top3Streak', 3, 'survival', 'bronze', 700, 450, 'medal'),
  a('a_top3_streak_10', '决赛圈常客', '连续 10 局进入前三名。', 'top3Streak', 10, 'survival', 'gold', 2600, 1700, 'medal', { rewardSkin: 'skin_gold_finalist' }),
  a('a_win_streak_3', '三连突围', '连续赢下 3 场对局。', 'winStreak', 3, 'survival', 'silver', 900, 600, 'trophy'),
  a('a_win_streak_8', '八风不动', '连续赢下 8 场对局。', 'winStreak', 8, 'survival', 'gold', 3600, 2400, 'trophy', { rewardSkin: 'wskin_sr338_zenith' }),

  // ── 探索 explore（8）─────────────────────────────────────────────────────
  a('a_secret_white_night', '白夜的第七码', '在暴雪与长夜中完成一场对局。', 'nightMatches', 1, 'explore', 'silver', 300, 200, 'moon', { hidden: true }),
  a('a_secret_no_land', '落地成盒也快乐', '落地后 20 秒内被淘汰。', 'earlyDeaths', 1, 'explore', 'bronze', 40, 30, 'ghost', { hidden: true }),
  a('a_night_win', '长夜行者', '在长夜或落雪中赢下一场对局。', 'nightWins', 1, 'explore', 'gold', 1800, 1200, 'moon', { hidden: true, rewardSkin: 'wskin_vector_midnight' }),
  a('a_all_maps_win', '三岛制霸', '在三张地图上各赢下一场对局。', 'winsAllMaps', 3, 'explore', 'gold', 2400, 1600, 'map', { rewardSkin: 'skin_gold_cartographer' }),
  a('a_airdrop_10', '空投猎人', '开启 10 个补给空投。', 'airdrops', 10, 'explore', 'silver', 900, 600, 'package'),
  a('a_vehicle_ram', '路怒症', '用载具撞倒一名敌人。', 'vehicleRams', 1, 'explore', 'bronze', 400, 260, 'car'),
  a('a_vehicle_50', '车队指挥官', '累计驾驶载具 50 次。', 'vehicles', 50, 'explore', 'silver', 700, 450, 'car'),

  // ── 团队 social（7）──────────────────────────────────────────────────────
  a('a_first_win', '初次突围', '赢得第一场对局。', 'wins', 1, 'social', 'bronze', 200, 150, 'flag'),
  a('a_revive_20', '战地医生', '累计救援队友 20 次。', 'revives', 20, 'social', 'bronze', 700, 460, 'heart-pulse'),
  a('a_revive_100', '生死与共', '累计救援队友 100 次。', 'revives', 100, 'social', 'gold', 1800, 1200, 'heart-pulse', { rewardSkin: 'skin_gold_medic' }),
  a('a_win_50', '常胜将军', '累计赢下 50 场对局。', 'wins', 50, 'social', 'silver', 1500, 1000, 'trophy'),
  a('a_placement_1_10', '十冠之路', '累计获得 10 次第一名。', 'wins', 10, 'social', 'silver', 1000, 700, 'crown'),
  a('a_assist_100', '最佳配角', '累计助攻 100 次。', 'assists', 100, 'social', 'silver', 750, 480, 'users'),
  a('a_throw_hit_30', '投掷艺术家', '用投掷物命中 30 次。', 'throwHits', 30, 'social', 'silver', 850, 560, 'zap'),

  // ── 收集 collection（6）──────────────────────────────────────────────────
  a('a_all_weapons', '军械库全制霸', '使用 18 种不同武器完成击杀。', 'weaponsUsed', 18, 'collection', 'gold', 1600, 1000, 'armory', { rewardSkin: 'wskin_m60_arsenal' }),
  a('a_pickup_500', '拾荒之王', '累计拾取 500 件物资。', 'pickups', 500, 'collection', 'bronze', 600, 400, 'package'),
  a('a_collect_skins_12', '衣柜主人', '收集 12 件角色皮肤或外观。', 'skinsOwned', 12, 'collection', 'silver', 1400, 900, 'gift'),
  a('a_collect_skins_30', '行走的展览馆', '收集 30 件角色皮肤或外观。', 'skinsOwned', 30, 'collection', 'gold', 3000, 2000, 'gift', { rewardSkin: 'car_paint_gold' }),
  a('a_secret_credits', '岛上首富', '累计获得 20000 信用点。', 'creditsEarned', 20000, 'collection', 'silver', 1800, 1200, 'banknote', { hidden: true }),
  a('a_attach_50', '配件堆成山', '累计拾取 50 个武器配件。', 'attachments', 50, 'collection', 'bronze', 500, 340, 'wrench'),

  // ── 精通 mastery（7）─────────────────────────────────────────────────────
  a('a_match_100', '百战老兵', '完成 100 场对局。', 'matches', 100, 'mastery', 'bronze', 1200, 800, 'medal'),
  a('a_match_300', '雾岛常驻', '完成 300 场对局。', 'matches', 300, 'mastery', 'gold', 2600, 1700, 'medal', { rewardSkin: 'skin_gold_veteran' }),
  a('a_accuracy_30', '神枪手', '完成一局命中率 ≥ 30%。', 'bestAccuracy', 30, 'mastery', 'bronze', 700, 460, 'crosshair'),
  a('a_accuracy_45', '弹道计算者', '完成一局命中率 ≥ 45%。', 'bestAccuracy', 45, 'mastery', 'gold', 2000, 1400, 'crosshair'),
  a('a_knock_20', '击倒大师', '累计击倒 20 名敌人。', 'downs', 20, 'mastery', 'bronze', 500, 330, 'skull'),
  a('a_dodge_200', '雾中残影', '累计翻滚闪避 200 次。', 'dodges', 200, 'mastery', 'silver', 800, 520, 'wind'),
  a('a_horde_boss', '雾岛之主猎手', '击败虫潮首领。', 'bossKills', 1, 'mastery', 'gold', 1500, 1000, 'ghost', { hidden: true, rewardSkin: 'wskin_crossbow_bone' }),
];

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
export const ACHIEVEMENT_METRICS = Array.from(new Set(ACHIEVEMENTS.map(a => a.metric)));
export const GOLD_ACHIEVEMENTS = ACHIEVEMENTS.filter(a => a.tier === 'gold');
export const HIDDEN_ACHIEVEMENTS = ACHIEVEMENTS.filter(a => a.hidden);

export function getAchievement(id) { return ACHIEVEMENT_BY_ID[id] || null; }
export function achievementsOfCategory(category) { return ACHIEVEMENTS.filter(a => a.category === category); }
export function goldRewardSkins() { return GOLD_ACHIEVEMENTS.map(a => a.rewardSkin).filter(Boolean); }
