// 雾岛突围 / MIST ISLE — 成长系统测试（node --test tests/progression.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  xpForLevel, levelFromXp, rankFor, ratingDelta, computeRewards, dayKey, weekKey,
  pickDaily, pickWeekly, missionProgress, matchSummaryFromState, emptyMeta, MAX_LEVEL, RATING,
  protectRating, SAVE_KEY,
} from '../shared/progression.mjs';
import { DAILY_POOL, WEEKLY_POOL, MISSION_METRICS, ALL_MISSIONS } from '../shared/data/missions.mjs';
import { ACHIEVEMENTS } from '../shared/data/achievements.mjs';
import { SKINS, WEAPON_SKINS, STORE_ITEMS, STORE_ALL, getSkin, getStoreItem } from '../shared/data/store.mjs';
import { RANK_TIERS, demotionShield } from '../shared/data/ranks.mjs';
import { BOT_NAMES, BOT_TITLES, TEAM_NAMES, randomBotName, teamNameFor, DIFFICULTIES } from '../shared/data/bots.mjs';
import { Meta, MemoryStorage } from '../client/meta.js';

const storage = () => new MemoryStorage();
const newMeta = () => new Meta(storage());
const metricSet = new Set(MISSION_METRICS);
const summary = (over = {}) => ({
  mode: 'squad', mapId: 'qinglan', won: false, placement: 32, totalTeams: 64,
  kills: 3, assists: 1, damage: 520, damageTaken: 300, survived: 150,
  shotsFired: 100, shotsHit: 35, revives: 0, downs: 1, pickups: 10,
  vehiclesUsed: 0, hordeWaves: 0, aliveAtEnd: false, ...over,
});

test('xpForLevel 单调递增且满级归零，1→60 约需 300 场', () => {
  let total = 0, prev = 0;
  for (let lv = 1; lv < MAX_LEVEL; lv++) {
    const need = xpForLevel(lv);
    assert.ok(need > prev, `level ${lv} 曲线必须递增`);
    assert.ok(need > 0); prev = need; total += need;
  }
  assert.equal(xpForLevel(MAX_LEVEL), 0);
  assert.equal(xpForLevel(999), 0);
  assert.ok(total > 85000 && total < 115000, `1→60 总经验 ${total}`);
  assert.ok(xpForLevel(MAX_LEVEL - 1) / xpForLevel(1) > 20, '等级曲线后期明显更陡');
  // 混合战绩（吃鸡/前 10/中游/早退）实测约 300 场满级
  const meta = newMeta();
  const patterns = [
    summary({ won: true, placement: 1, kills: 7, damage: 1500, survived: 400, revives: 1, pickups: 14, aliveAtEnd: true }),
    summary({ placement: 10, kills: 5, damage: 900, survived: 300, pickups: 12 }),
    summary({ placement: 28, kills: 3, damage: 520, survived: 180, pickups: 10 }),
    summary({ placement: 50, kills: 1, damage: 180, survived: 90, pickups: 6 }),
  ];
  const mix = [0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3];
  let matches = 0;
  while (meta.level < MAX_LEVEL && matches < 2000) { meta.addMatchResult(patterns[mix[matches % mix.length]]); matches++; }
  assert.equal(meta.level, MAX_LEVEL);
  assert.ok(matches >= 200 && matches <= 420, `满级约 ${matches} 场，符合长线成长预期`);
});

test('levelFromXp 边界：0 经验 1 级、满级 60 封顶、current/needed 自洽', () => {
  const start = levelFromXp(0);
  assert.equal(start.level, 1); assert.equal(start.current, 0); assert.ok(start.needed > 0);
  const one = xpForLevel(1);
  assert.equal(levelFromXp(one).level, 2);
  assert.equal(levelFromXp(one - 1).level, 1);
  let total = 0; for (let lv = 1; lv < MAX_LEVEL; lv++) total += xpForLevel(lv);
  const max = levelFromXp(total + 999999);
  assert.equal(max.level, 60); assert.equal(max.maxed, true); assert.equal(max.needed, 0);
  assert.equal(levelFromXp(total).level, 60);
  const mid = levelFromXp(xpForLevel(1) + xpForLevel(2) + 5);
  assert.equal(mid.level, 3); assert.equal(mid.current, 5); assert.ok(mid.progress > 0 && mid.progress < 1);
});

test('rankFor 覆盖 7 档边界且 progress ∈ [0,1]', () => {
  assert.equal(RANK_TIERS.length, 7);
  assert.equal(rankFor(0).tier, 'bronze');
  for (const tier of RANK_TIERS) {
    const at = rankFor(tier.min);
    assert.equal(at.tier, tier.id, `${tier.name} 下限`);
    assert.ok(at.progress >= 0 && at.progress <= 1);
    const near = rankFor(tier.min + 1);
    assert.equal(near.tier, tier.id);
    assert.ok(near.progress >= at.progress);
  }
  assert.equal(rankFor(239).tier, 'bronze');
  assert.equal(rankFor(240).tier, 'silver');
  assert.equal(rankFor(3300).tier, 'legend');
  assert.equal(rankFor(99999).tier, 'legend');
  assert.equal(rankFor(99999).isMax, true);
  assert.equal(rankFor(310).division, 3);
  assert.match(rankFor(310).name, /白银/);
  assert.ok(rankFor(1200).progress < 1);
});

test('ratingDelta：吃鸡加分、垫底扣分、连败有保护、horde 有分', () => {
  const win = ratingDelta({ won: true, placement: 1, totalTeams: 16, kills: 6, damage: 1200, mode: 'squad' });
  const last = ratingDelta({ won: false, placement: 16, totalTeams: 16, kills: 0, damage: 40, mode: 'squad' });
  assert.ok(win > 0); assert.ok(last <= 0);
  assert.ok(win > ratingDelta({ won: false, placement: 8, totalTeams: 16, kills: 0, damage: 0, mode: 'squad' }));
  const protect = ratingDelta({ won: false, placement: 16, totalTeams: 16, kills: 0, damage: 0, mode: 'squad', lossStreak: 4 });
  assert.ok(protect > last, '连败保护应减少掉分');
  // 1.2.1 平衡：连败保护从「所有负分压到 -7」改为「深负分托底到 -34」。
  // 旧断言 `protect >= -7` 正是段位通胀的成因：随机玩家每局最多亏 7 分，
  // 而 1/16 概率吃鸡就 +60，均匀期望恒为正（实测 +4.63/局，713 局上传奇）。
  // 新语义下护盾只把 -45 的垫底分收到 -34（≈25% 缓冲），仍保留「不跌破大段位下限」。
  assert.ok(protect >= RATING.streakShieldCap, `连败保护下限 ${RATING.streakShieldCap}`);
  assert.ok(protect > RATING.lossFloor, '连败保护不应低于普通垫底');
  // 均匀名次期望必须为负：段位是技术分层，不是参与奖。
  // 口径与实测一致：16 队名次各 1/16，典型随机玩家 = 1 杀 + 250 伤害
  // （旧参数下该口径的期望是 +4.63/局，即 713 局上传奇的那条曲线）。
  const typical = { totalTeams: 16, mode: 'squad', kills: 1, damage: 250 };
  let sum = 0;
  for (let p = 1; p <= 16; p++) sum += ratingDelta({ ...typical, placement: p, won: p === 1 });
  const mean = sum / 16;
  assert.ok(mean < 0, `均匀名次期望必须为负，实际 ${mean.toFixed(2)}`);
  assert.ok(mean >= -12 && mean <= -8, `均匀名次期望应落在 -8 ~ -12，实际 ${mean.toFixed(2)}`);
  assert.equal(ratingDelta({ mode: 'training', placement: 5, totalTeams: 16 }), 0);
  assert.ok(ratingDelta({ mode: 'horde', hordeWaves: 5, kills: 20 }) > 0);
  const r = protectRating(250, -60, 5); // 青铜段位下限保护
  assert.equal(r.protected, true); assert.equal(r.rating, 240);
  assert.ok(demotionShield(250, 3).active); assert.equal(demotionShield(250, 1).active, false);
});

test('pickDaily/pickWeekly：同 key 稳定、不同 key 不同、6/4 条且维度互不重复', () => {
  for (const pool of [DAILY_POOL, WEEKLY_POOL]) {
    const ids = new Set();
    for (let i = 0; i < 9; i++) { assert.ok(pool.length >= 10); for (const m of pool) ids.add(m.id); }
    assert.ok(ids.size >= 10);
  }
  const a = pickDaily('2026-10-18'), b = pickDaily('2026-10-18'), c = pickDaily('2026-10-19');
  assert.deepEqual(a, b); assert.equal(a.length, 6);
  assert.notDeepEqual(a, c);
  assert.equal(new Set(a).size, 6, '同一天不能出现重复任务');
  for (const id of a) assert.ok(DAILY_POOL.some(m => m.id === id));
  const weekly = pickWeekly('2026-W42');
  assert.equal(weekly.length, 4); assert.notDeepEqual(weekly, pickWeekly('2026-W43'));
  for (const id of weekly) assert.ok(WEEKLY_POOL.some(m => m.id === id));
  // 维度轮换：连续 30 天里，每日 6 条必须来自 6 个不同 dimension
  for (let i = 0; i < 30; i++) {
    const day = dayKey(new Date(2026, 0, 1 + i));
    const dims = pickDaily(day).map(id => ALL_MISSIONS[id].dimension);
    assert.equal(new Set(dims).size, dims.length, `${day} 出现重复维度 ${dims}`);
  }
  assert.ok(MISSION_METRICS.every(m => metricSet.has(m)), 'MISSION_METRICS 必须是受支持集合的子集');
  assert.ok(MISSION_METRICS.includes('killsPistol') && MISSION_METRICS.includes('winsBaiye'));
});

test('dayKey/weekKey 格式与周界正确', () => {
  assert.equal(dayKey(new Date(2026, 9, 18)), '2026-10-18');
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(weekKey(new Date(2026, 9, 18)), '2026-W42');
  assert.equal(weekKey(new Date(2026, 9, 19)), '2026-W43'); // 周一进入新周
  assert.equal(weekKey(new Date(2026, 9, 20)), '2026-W43');
  assert.match(weekKey(), /^\d{4}-W\d{2}$/);
});

test('computeRewards：胜利 > 失败，击杀/伤害/名次/任务均提高奖励', () => {
  const lose = computeRewards(summary());
  const win = computeRewards(summary({ won: true, placement: 1, aliveAtEnd: true }));
  assert.ok(win.xp > lose.xp); assert.ok(win.credits > lose.credits);
  assert.ok(computeRewards(summary({ kills: 10 })).xp > lose.xp);
  assert.ok(computeRewards(summary({ damage: 2000 })).xp > lose.xp);
  assert.ok(computeRewards(summary({ placement: 2 })).xp > computeRewards(summary({ placement: 40 })).xp);
  const withMission = computeRewards(summary(), {
    level: 1,
    missions: [{ id: 'd_kill6', def: ALL_MISSIONS.d_kill6, progress: 4, done: false }],
  });
  assert.equal(withMission.missionDone[0].id, 'd_kill6');
  assert.ok(withMission.xp > lose.xp + ALL_MISSIONS.d_kill6.xp - 1);
  assert.ok(withMission.credits > lose.credits);
  const done = computeRewards(summary(), { level: 1, missions: [{ id: 'd_kill6', def: ALL_MISSIONS.d_kill6, progress: 9, done: true }] });
  assert.equal(done.missionDone.length, 0);
});

test('missionProgress 计算进度/完成/封顶', () => {
  const out = missionProgress([ALL_MISSIONS.d_kill6, ALL_MISSIONS.d_win1], { d_kill6: { progress: 3 }, d_win1: { progress: 0 } });
  assert.equal(out.d_kill6.progress, 3); assert.equal(out.d_kill6.done, false);
  assert.ok(out.d_kill6.pct > 0.49 && out.d_kill6.pct < 0.51);
  assert.equal(out.d_win1.done, false);
  const capped = missionProgress(['d_kill6'], { d_kill6: 99 });
  assert.equal(capped.d_kill6.progress, 6); assert.equal(capped.d_kill6.done, true);
});

test('matchSummaryFromState 从快照得到 kills/damage/placement/won', () => {
  const snap = {
    v: 3, mode: 'squad', mapId: 'chisha', phase: 'ended', matchTime: 355,
    me: { id: 'p1', team: 2, kills: 6, assists: 2, damage: 980, alive: true, rank: 1, weapon: 'ar7' },
    counts: { teams: 16 },
    horde: null,
    events: [
      { type: 'shot', player: 'p1', hit: 'b2' }, { type: 'shot', player: 'p1', hit: null },
      { type: 'hit', player: 'p1', target: 'b2', damage: 40, headshot: true },
      { type: 'kill', player: 'b2', attacker: 'p1' },
      { type: 'pickup', player: 'p1' }, { type: 'vehicle', player: 'p1', action: 'enter' },
      { type: 'revive', player: 'p2', by: 'p1' },
      { type: 'shot', player: 'p2', hit: 'p1' },
    ],
    result: { winnerTeam: 2, winnerName: '曙光', reason: 'squad', ranks: [{ team: 2, name: '曙光', rank: 1, players: [{ id: 'p1', kills: 6 }] }] },
  };
  const s = matchSummaryFromState(snap, 'p1');
  assert.equal(s.kills, 6); assert.equal(s.damage, 980); assert.equal(s.placement, 1);
  assert.equal(s.totalTeams, 16); assert.equal(s.won, true); assert.equal(s.mode, 'squad');
  assert.equal(s.mapId, 'chisha'); assert.equal(s.headshots, 1); assert.equal(s.pickups, 1);
  assert.equal(s.revives, 1); assert.equal(s.vehiclesUsed, 1); assert.ok(s.shotsFired >= 2);
  assert.equal(s.survived, 355);
  const self = matchSummaryFromState({ ...snap, me: { ...snap.me, id: 'p1' } }, null);
  assert.equal(self.kills, 6);
});

test('爆头三种来源都能统计（shot.headshots / headshot 事件 / 旧 hit.headshot）', () => {
  const base = {
    v: 3, mode: 'squad', mapId: 'chisha', phase: 'ended', matchTime: 200,
    me: { id: 'p1', team: 2, kills: 2, damage: 300, alive: true, rank: 3, weapon: 'ar7' },
    counts: { teams: 16 }, horde: null,
    result: { winnerTeam: 2, winnerName: '曙光', reason: 'squad', ranks: [{ team: 2, name: '曙光', rank: 1, players: [] }] },
  };
  // 1) simulation 主路径：shot 事件的 headshots 计数（霰弹一发可 >1）
  const viaShot = matchSummaryFromState({
    ...base,
    events: [
      { type: 'shot', player: 'p1', hit: 'b9', headshots: 2 },
      { type: 'shot', player: 'p1', hit: null, headshots: 0 },
      { type: 'shot', player: 'p2', hit: 'p1', headshots: 1 },
    ],
  }, 'p1');
  assert.equal(viaShot.headshots, 2, 'shot.headshots 应被统计，且只统计自己的开火');
  // 2) 独立 headshot 事件
  const viaEvent = matchSummaryFromState({
    ...base,
    events: [{ type: 'headshot', player: 'p1', target: 'b9', damage: 88 }, { type: 'headshot', player: 'p1', target: 'b8', damage: 44 }],
  }, 'p1');
  assert.equal(viaEvent.headshots, 2, 'headshot 事件应被统计');
  // 3) 旧快照兼容：hit.headshot
  const viaHit = matchSummaryFromState({
    ...base,
    events: [{ type: 'hit', player: 'p1', target: 'b9', damage: 40, headshot: true }],
  }, 'p1');
  assert.equal(viaHit.headshots, 1, '旧 hit.headshot 标记应继续生效');
  // 4) shot.headshots 与 headshot 事件是同一次要害命中的两个通道，不得双计
  const mixed = matchSummaryFromState({
    ...base,
    events: [{ type: 'shot', player: 'p1', hit: 'b9', headshots: 1 }, { type: 'headshot', player: 'p1', target: 'b9', damage: 70 }],
  }, 'p1');
  assert.equal(mixed.headshots, 1, '同一次要害命中只计一次（两通道取 max 去重）');
});


test('emptyMeta 初始存档结构符合契约 §9（v2）', () => {
  const m = emptyMeta();
  assert.equal(m.version, 2); assert.equal(m.level, 1); assert.equal(m.xp, 0);
  assert.ok(Array.isArray(m.unlocked.skins) && m.unlocked.skins.length >= 3);
  assert.equal(m.loadout.primary, 'ar7'); assert.equal(m.loadout.skin, 'skin_default');
  for (const key of ['matches', 'wins', 'kills', 'damage', 'survived', 'bestPlacement', 'streak', 'bestStreak', 'hordeWaves']) {
    assert.equal(typeof m.stats[key], 'number');
  }
  // v2 新增字段：任务链与统计扩展
  assert.deepEqual(Object.keys(m.streak).sort(), ['best', 'claimed', 'count', 'day', 'lastRewardDay']);
  for (const key of ['airdrops', 'dodges', 'throwHits', 'attachments', 'dismantles', 'vehicleMeters', 'crouchKills', 'nightWins', 'skinsOwned']) {
    assert.equal(typeof m.stats[key], 'number', `stats.${key} 必须是数字`);
  }
  assert.equal(typeof m.stats.wonMaps, 'object');
  assert.deepEqual(Object.keys(m.missions).sort(), ['daily', 'day', 'week', 'weekly']);
  assert.equal(typeof m.settings, 'object');
});

test('Meta：新档初始 + addMatchResult 结算 xp/credits/level/rating/stats', () => {
  const meta = newMeta();
  assert.equal(meta.level, 1); assert.equal(meta.credits, emptyMeta().credits);
  assert.deepEqual(meta.loadout.primary, 'ar7');
  assert.equal(meta.missionList('daily').length, 6);
  const res = meta.addMatchResult(summary({ won: true, placement: 1, kills: 8, damage: 1500, aliveAtEnd: true }));
  assert.ok(res.xp > 0); assert.ok(res.credits > 0);
  assert.equal(meta.xp, res.xp);
  assert.equal(meta.credits, emptyMeta().credits + res.credits);
  assert.ok(meta.level >= 2); assert.equal(meta.data.level, meta.level);
  assert.ok(meta.rating > 0); assert.equal(meta.rating, res.rating);
  assert.equal(meta.stats.matches, 1); assert.equal(meta.stats.wins, 1);
  assert.equal(meta.stats.kills, 8); assert.equal(meta.stats.damage, 1500);
  assert.equal(meta.stats.bestPlacement, 1); assert.equal(meta.stats.streak, 1);
  assert.ok(meta.data.lastResult);
  meta.addMatchResult(summary());
  assert.equal(meta.stats.matches, 2); assert.equal(meta.stats.wins, 1); assert.equal(meta.stats.streak, 0);
});

test('Meta：升级跨级报告 levelUp/newLevel，满级不越界', () => {
  const meta = newMeta();
  const res = meta.addMatchResult(summary({ won: true, placement: 1, kills: 12, damage: 2000 }));
  assert.equal(res.levelUp, true); assert.ok(res.newLevel > 1);
  assert.equal(res.oldLevel, 1);
  const big = newMeta();
  big.data.xp = 0; big.data.level = 1;
  for (let i = 0; i < 40; i++) big.addMatchResult(summary({ won: true, placement: 1, kills: 15, damage: 2500 }));
  assert.ok(big.level <= MAX_LEVEL); assert.equal(big.data.level, big.level);
  assert.equal(levelFromXp(big.xp).level, big.level);
});

test('Meta：任务进度累计、领奖成功且重复领奖被拒', () => {
  const meta = newMeta();
  const res = meta.addMatchResult(summary({ kills: 3, damage: 400 }));
  assert.equal(res.missionsCompleted.length, 0);
  const daily = meta.missionList('daily');
  assert.equal(daily.length, 6);
  // 单局只推进与 summary 字段相关的任务；部分维度（如空投/翻滚）本局必然为 0
  assert.ok(daily.some(m => m.metric === 'kills' && m.progress > 0 || m.progress > 0), '至少一条任务有进度');
  // 直接完成一条任务后领奖
  const target = meta.missionList('daily').find(m => !m.done);
  meta.data.missions.daily[target.id].progress = target.target;
  meta.data.missions.daily[target.id].done = true;
  const before = meta.credits;
  const claim = meta.claimMission(target.id);
  assert.equal(claim.ok, true); assert.ok(claim.xp > 0); assert.equal(meta.credits, before + claim.credits);
  assert.equal(meta.data.missions.daily[target.id].claimed, true);
  assert.deepEqual(meta.claimMission(target.id), { ok: false, error: 'already-claimed' });
  assert.equal(meta.claimMission('d_not_exist').ok, false);
  const notDone = meta.missionList('daily').find(m => !m.done);
  assert.equal(meta.claimMission(notDone.id).error, 'not-complete');
});

test('Meta：成就解锁一次、可领奖、重复领奖被拒', () => {
  const meta = newMeta();
  assert.ok(ACHIEVEMENTS.length >= 26);
  const res = meta.addMatchResult(summary({ won: true, placement: 1, kills: 1 }));
  assert.ok(res.achievementsCompleted.some(a => a.id === 'a_first_win'));
  const entry = meta.data.achievements.a_first_win;
  assert.equal(entry.done, true); assert.equal(entry.claimed, false);
  const claim = meta.claimAchievement('a_first_win');
  assert.equal(claim.ok, true); assert.ok(claim.xp > 0);
  assert.equal(meta.claimAchievement('a_first_win').error, 'already-claimed');
  const progressBefore = meta.data.achievements.a_kill_100.progress;
  meta.addMatchResult(summary({ kills: 2 }));
  assert.equal(meta.data.achievements.a_kill_100.progress, Math.max(progressBefore, meta.data.achievements.a_kill_100.progress));
  assert.equal(meta.claimAchievement('a_nope').ok, false);
});

test('Meta：商店购买——不存在的皮肤/余额不足/等级不足均失败，成功购买后扣钱且解锁', () => {
  const meta = newMeta();
  assert.equal(meta.buySkin('skin_not_exist').ok, false);
  assert.equal(meta.buySkin('skin_not_exist').error, 'unknown-skin');
  const cheap = getSkin('skin_rust');
  const poor = newMeta(); poor.data.credits = 10;
  assert.equal(poor.buySkin(cheap.id).ok, false);
  assert.equal(poor.buySkin(cheap.id).error, 'not-enough-credits');
  meta.data.credits = 5000;
  const ok = meta.buySkin(cheap.id);
  assert.equal(ok.ok, true); assert.equal(meta.credits, 5000 - cheap.price);
  assert.equal(meta.isUnlocked('skin', cheap.id), true);
  assert.equal(meta.buySkin(cheap.id).already, true);
  assert.equal(meta.buyStoreItem('item_not_exist').ok, false);
  const spray = getStoreItem('spray_mist_eye');
  const bought = meta.buyStoreItem(spray.id);
  assert.equal(bought.ok, true); assert.equal(meta.isUnlocked('item', spray.id), true);
  const locked = STORE_ALL.find(item => item.unlockLevel > 1);
  assert.ok(SKINS.length >= 12 && WEAPON_SKINS.length >= 14 && STORE_ITEMS.length >= 8);
  assert.equal(STORE_ALL.length, SKINS.length + WEAPON_SKINS.length + STORE_ITEMS.length);
  if (locked) {
    meta.data.level = 1; meta.data.credits = 99999;
    assert.equal(meta.buyStoreItem(locked.id).error, 'level-required');
  }
});

test('Meta：装备皮肤生效、未解锁皮肤不可装备、loadout 持久化', () => {
  const meta = newMeta();
  meta.data.credits = 3000;
  assert.equal(meta.equipSkin('skin_legend_mist').ok, false);
  assert.equal(meta.loadout.skin, 'skin_default');
  const buy = meta.buySkin('skin_rust'); assert.equal(buy.ok, true);
  assert.equal(meta.equipSkin('skin_rust').ok, true);
  assert.equal(meta.loadout.skin, 'skin_rust');
  meta.setLoadout({ primary: 'v9', throwable: 'smoke' });
  assert.equal(meta.loadout.primary, 'v9'); assert.equal(meta.loadout.throwable, 'smoke');
  assert.deepEqual(meta.loadout.attachments.primary, ['red_dot']);
  const reloaded = new Meta(meta.storage);
  assert.equal(reloaded.loadout.skin, 'skin_rust');
  assert.equal(reloaded.loadout.primary, 'v9');
  assert.equal(reloaded.isUnlocked('skin', 'skin_rust'), true);
  meta.setLoadout({ skin: 'skin_legend_dawn' });
  assert.equal(meta.loadout.skin, 'skin_rust', '未解锁皮肤不能被装备');
});

test('Meta：损坏存档回退、import/export 往返一致、reset 复原', () => {
  const broken = new MemoryStorage({ [SAVE_KEY]: '{not-json' });
  const meta = new Meta(broken);
  assert.equal(meta.level, 1); assert.equal(meta.xp, 0);
  assert.equal(meta.missionList('daily').length, 6);
  const junk = new Meta(new MemoryStorage({ [SAVE_KEY]: JSON.stringify({ version: 1, xp: 'abc', stats: null }) }));
  assert.equal(junk.level, 1); assert.equal(typeof junk.stats.matches, 'number');
  meta.addMatchResult(summary({ won: true, placement: 1 }));
  const exported = meta.exportSave();
  const copy = newMeta();
  const imported = copy.importSave(exported);
  assert.equal(imported.ok, true);
  assert.deepEqual(copy.data.stats, meta.data.stats);
  assert.equal(copy.xp, meta.xp); assert.equal(copy.level, meta.level); assert.equal(copy.rating, meta.rating);
  assert.deepEqual(copy.loadout, meta.loadout);
  assert.equal(copy.exportSave(), exported);
  assert.equal(copy.importSave('{oops').ok, false);
  copy.reset();
  assert.equal(copy.level, 1); assert.equal(copy.xp, 0); assert.equal(copy.stats.matches, 0);
  assert.equal(copy.credits, emptyMeta().credits);
});

test('Meta：refreshMissions 跨天重置进度、同一天保持', () => {
  const meta = newMeta();
  const day1 = new Date(2026, 9, 18, 10);
  const day2 = new Date(2026, 9, 19, 10);
  meta.refreshMissions(day1);
  const ids = Object.keys(meta.data.missions.daily);
  meta.data.missions.daily[ids[0]].progress = 2;
  meta.data.missions.daily[ids[0]].done = true;
  meta.data.missions.daily[ids[0]].claimed = true;
  meta.refreshMissions(day1);
  assert.equal(meta.data.missions.daily[ids[0]].progress, 2, '同一天不应重置');
  meta.refreshMissions(day2);
  assert.equal(meta.data.missions.day, '2026-10-19');
  for (const entry of Object.values(meta.data.missions.daily)) {
    assert.equal(entry.progress, 0); assert.equal(entry.done, false); assert.equal(entry.claimed, false);
  }
  const weekly = Object.keys(meta.data.missions.weekly);
  assert.equal(weekly.length, 4);
  meta.refreshMissions(new Date(2026, 9, 26, 10));
  assert.equal(meta.data.missions.week, '2026-W44');
});

test('Meta：注入指定任务后单局即可推进并在结算返回值中报告完成', () => {
  const meta = newMeta();
  const day = meta.data.missions.day;
  meta.data.missions.daily = { d_kill6: { progress: 4, done: false, claimed: false } };
  meta.refreshMissions(new Date());
  assert.equal(meta.data.missions.day, day);
  const res = meta.addMatchResult(summary({ kills: 3 }));
  assert.ok(res.missionsCompleted.some(m => m.id === 'd_kill6'), 'kill 进度应完成 d_kill6');
  assert.equal(meta.data.missions.daily.d_kill6.done, true);
  const beforeXp = meta.xp, beforeCredits = meta.credits;
  const claim = meta.claimMission('d_kill6');
  assert.equal(claim.ok, true);
  assert.equal(meta.xp, beforeXp + claim.xp);
  assert.equal(meta.credits, beforeCredits + claim.credits);
  const second = meta.addMatchResult(summary({ kills: 9 }));
  assert.equal(second.missionsCompleted.some(m => m.id === 'd_kill6'), false, '已完成任务不再重复上报');
});

test('Meta：horde 模式结算计入波次、评级与 stats，不破坏普通对局统计', () => {
  const meta = newMeta();
  const res = meta.addMatchResult(summary({ mode: 'horde', won: true, placement: 1, totalTeams: 1, kills: 40, damage: 6000, hordeWaves: 7, survived: 500, aliveAtEnd: true }));
  assert.ok(res.xp > 0); assert.ok(res.credits > 0);
  assert.ok(res.ratingDelta > 0, 'horde 模式应加段位分');
  assert.equal(meta.stats.matches, 1); assert.equal(meta.stats.wins, 1);
  assert.equal(meta.stats.hordeWaves, 7);
  // 每日任务是轮换的：不保证当天一定抽到 hordeWaves，但整池必须存在该维度
  assert.ok(DAILY_POOL.some(m => m.metric === 'hordeWaves'), '虫潮任务必须在每日池中');
  const hordeReward = computeRewards(summary({ mode: 'horde', won: true, placement: 1, totalTeams: 1, kills: 20, damage: 3000, hordeWaves: 10 }));
  const normal = computeRewards(summary({ won: true, placement: 1, totalTeams: 1, kills: 20, damage: 3000, hordeWaves: 0 }));
  assert.ok(hordeReward.xp > normal.xp, '波次应提供额外奖励');
  const training = meta.addMatchResult(summary({ mode: 'training', won: true, placement: 1, kills: 15, damage: 3000 }));
  assert.equal(training.ratingDelta, 0, '训练模式不影响段位');
  assert.ok(training.xp <= 90, '训练模式经验封顶');
});

test('数据池完整性：任务/成就/商店/bot 定义合法', () => {
  assert.ok(DAILY_POOL.length >= 14); assert.ok(WEEKLY_POOL.length >= 10);
  const ids = new Set();
  for (const pool of [DAILY_POOL, WEEKLY_POOL]) {
    for (const m of pool) {
      assert.ok(MISSION_METRICS.includes(m.metric), `非法 metric ${m.metric}`);
      assert.ok(m.target > 0 && m.xp > 0 && m.credits > 0 && m.title && m.desc && m.difficulty);
      assert.equal(ids.has(m.id), false, `重复任务 id ${m.id}`); ids.add(m.id);
    }
  }
  assert.ok(MISSION_METRICS.includes('headshots') && MISSION_METRICS.includes('accuracyShots'));
  const achIds = new Set();
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.id && a.title && a.desc && a.metric && a.target > 0 && a.xp > 0 && a.credits > 0);
    assert.equal(typeof a.hidden, 'boolean'); assert.ok(a.icon);
    assert.equal(achIds.has(a.id), false); achIds.add(a.id);
  }
  for (const item of STORE_ALL) {
    assert.ok(item.id && item.name && item.kind && item.price >= 0 && item.rarity);
    assert.ok(Array.isArray(item.desc) || typeof item.desc === 'string');
  }
  assert.ok(SKINS.filter(s => s.default).length >= 3);
  assert.ok(BOT_NAMES.length >= 48); assert.ok(BOT_TITLES.length >= 12); assert.ok(TEAM_NAMES.length >= 24);
  assert.ok(new Set(BOT_NAMES).size === BOT_NAMES.length);
  assert.match(randomBotName(() => 0.13), /·/);
  assert.equal(teamNameFor(0), TEAM_NAMES[0]); assert.equal(teamNameFor(5), TEAM_NAMES[5]);
  assert.equal(typeof DIFFICULTIES.veteran.aimError, 'number');
  assert.ok(DIFFICULTIES.recruit && DIFFICULTIES.veteran && DIFFICULTIES.elite);
});
