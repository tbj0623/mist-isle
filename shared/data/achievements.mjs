// 雾岛突围 / MIST ISLE — 成就（共享数据，无 DOM）
// metric 与 missions.mjs 的 MISSION_METRICS 对齐，另加单局型与特殊型计数。
// hidden: 未解锁前不显示具体条件；icon 为程序化图标 key（客户端可映射到 lucide）。

export const ACHIEVEMENTS = [
  { id: 'a_first_win', title: '初次突围', desc: '赢得第一场对局。', metric: 'wins', target: 1, xp: 200, credits: 150, hidden: false, icon: 'flag' },
  { id: 'a_first_blood', title: '第一滴血', desc: '完成第一次击杀。', metric: 'kills', target: 1, xp: 80, credits: 50, hidden: false, icon: 'target' },
  { id: 'a_kill_100', title: '百杀者', desc: '累计击杀 100 名敌人。', metric: 'kills', target: 100, xp: 600, credits: 400, hidden: false, icon: 'skull' },
  { id: 'a_kill_500', title: '雾岛噩梦', desc: '累计击杀 500 名敌人。', metric: 'kills', target: 500, xp: 1600, credits: 1100, hidden: false, icon: 'skull' },
  { id: 'a_kill_1000', title: '千杀传说', desc: '累计击杀 1000 名敌人。', metric: 'kills', target: 1000, xp: 3200, credits: 2200, hidden: false, icon: 'crown' },
  { id: 'a_damage_1000', title: '千伤俱乐部', desc: '单局造成 1000 点伤害。', metric: 'matchDamage', target: 1000, xp: 500, credits: 320, hidden: false, icon: 'flame' },
  { id: 'a_damage_total', title: '破坏之王', desc: '累计造成 100000 点伤害。', metric: 'damage', target: 100000, xp: 2400, credits: 1600, hidden: false, icon: 'flame' },
  { id: 'a_kill10_match', title: '一局十杀', desc: '单局击杀 10 名敌人。', metric: 'matchKills', target: 10, xp: 800, credits: 520, hidden: false, icon: 'swords' },
  { id: 'a_top3_streak', title: '稳定前三', desc: '连续 3 局进入前三名。', metric: 'top3Streak', target: 3, xp: 700, credits: 450, hidden: false, icon: 'medal' },
  { id: 'a_win_streak_3', title: '三连突围', desc: '连续赢下 3 场对局。', metric: 'winStreak', target: 3, xp: 900, credits: 600, hidden: false, icon: 'trophy' },
  { id: 'a_win_50', title: '常胜将军', desc: '累计赢下 50 场对局。', metric: 'wins', target: 50, xp: 1500, credits: 1000, hidden: false, icon: 'trophy' },
  { id: 'a_unscathed_win', title: '毫发无伤', desc: '在未受伤的完整血量下赢得对局。', metric: 'unscathedWins', target: 1, xp: 1200, credits: 800, hidden: false, icon: 'shield' },
  { id: 'a_revive_20', title: '战地医生', desc: '累计救援队友 20 次。', metric: 'revives', target: 20, xp: 700, credits: 460, hidden: false, icon: 'heart-pulse' },
  { id: 'a_revive_100', title: '生死与共', desc: '累计救援队友 100 次。', metric: 'revives', target: 100, xp: 1800, credits: 1200, hidden: false, icon: 'heart-pulse' },
  { id: 'a_horde_10', title: '守住黎明', desc: '在虫潮模式中守住第 10 波。', metric: 'hordeWaves', target: 10, xp: 1400, credits: 900, hidden: false, icon: 'waves' },
  { id: 'a_horde_boss', title: '雾岛之主猎手', desc: '击败虫潮首领。', metric: 'bossKills', target: 1, xp: 1500, credits: 1000, hidden: true, icon: 'ghost' },
  { id: 'a_headshot_50', title: '爆头专家', desc: '累计爆头 50 次。', metric: 'headshots', target: 50, xp: 600, credits: 380, hidden: false, icon: 'crosshair' },
  { id: 'a_headshot_500', title: '颅骨收藏家', desc: '累计爆头 500 次。', metric: 'headshots', target: 500, xp: 2000, credits: 1300, hidden: false, icon: 'crosshair' },
  { id: 'a_all_weapons', title: '军械库全制霸', desc: '使用 18 种不同武器完成击杀。', metric: 'weaponsUsed', target: 18, xp: 1600, credits: 1000, hidden: false, icon: 'armory' },
  { id: 'a_vehicle_ram', title: '路怒症', desc: '用载具撞倒一名敌人。', metric: 'vehicleRams', target: 1, xp: 400, credits: 260, hidden: false, icon: 'car' },
  { id: 'a_vehicle_50', title: '车队指挥官', desc: '累计使用载具 50 次。', metric: 'vehicles', target: 50, xp: 700, credits: 450, hidden: false, icon: 'car' },
  { id: 'a_pickup_500', title: '拾荒之王', desc: '累计拾取 500 件物资。', metric: 'pickups', target: 500, xp: 600, credits: 400, hidden: false, icon: 'package' },
  { id: 'a_match_100', title: '百战老兵', desc: '完成 100 场对局。', metric: 'matches', target: 100, xp: 1200, credits: 800, hidden: false, icon: 'medal' },
  { id: 'a_match_300', title: '雾岛常驻', desc: '完成 300 场对局。', metric: 'matches', target: 300, xp: 2600, credits: 1700, hidden: false, icon: 'medal' },
  { id: 'a_survive_60', title: '生存一分钟', desc: '单局生存超过 60 秒。', metric: 'matchSurvived', target: 60, xp: 60, credits: 40, hidden: false, icon: 'timer' },
  { id: 'a_survive_total', title: '时间旅人', desc: '累计生存 10 小时。', metric: 'survived', target: 36000, xp: 2000, credits: 1300, hidden: false, icon: 'timer' },
  { id: 'a_placement_1_10', title: '十冠之路', desc: '累计获得 10 次第一名。', metric: 'wins', target: 10, xp: 1000, credits: 700, hidden: false, icon: 'crown' },
  { id: 'a_accuracy_30', title: '神枪手', desc: '完成一局命中率 ≥ 30%。', metric: 'bestAccuracy', target: 30, xp: 700, credits: 460, hidden: false, icon: 'crosshair' },
  { id: 'a_knock_20', title: '击倒大师', desc: '累计击倒 20 名敌人。', metric: 'downs', target: 20, xp: 500, credits: 330, hidden: false, icon: 'skull' },
  { id: 'a_secret_white_night', title: '白夜的第七码', desc: '在暴雪与长夜中完成一场对局。', metric: 'nightMatches', target: 1, xp: 300, credits: 200, hidden: true, icon: 'moon' },
  { id: 'a_secret_no_land', title: '落地成盒也快乐', desc: '落地后 20 秒内被淘汰。', metric: 'earlyDeaths', target: 1, xp: 40, credits: 30, hidden: true, icon: 'ghost' },
  { id: 'a_secret_credits', title: '岛上首富', desc: '累计获得 20000 信用点。', metric: 'creditsEarned', target: 20000, xp: 1800, credits: 1200, hidden: true, icon: 'banknote' },
];

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
export const ACHIEVEMENT_METRICS = Array.from(new Set(ACHIEVEMENTS.map(a => a.metric)));

export function getAchievement(id) { return ACHIEVEMENT_BY_ID[id] || null; }
