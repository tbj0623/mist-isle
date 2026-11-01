// 雾岛突围 / MIST ISLE — 赛季通行证测试（node --test tests/season.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEASON, SEASON_TIERS, XP_PER_TIER, FREE_TIER_REWARDS, PAID_TIER_REWARDS, DAILY_LOGIN,
  STREAK_BONUSES, SEASON_WEEKLY_CHALLENGES, SEASON_MISSIONS, SEASON_CHAPTERS,
  seasonXpForMatch, tierFromXp, rewardForTier, seasonDaysLeft, seasonPhase,
  loginDayFor, loginRewardFor, paidTrackUnlocked,
} from '../shared/data/season.mjs';
import { STORE_ALL } from '../shared/data/store.mjs';
import { SeasonTracker, emptySeasonData } from '../client/season.js';

const STORE_IDS = new Set(STORE_ALL.map(i => i.id));
const day = s => new Date(`${s}T12:00:00`);
const sum = (o = {}) => ({ mode: 'squad', mapId: 'qinglan', won: false, placement: 16, totalTeams: 16, kills: 0, damage: 200, survived: 60, ...o });
const WIN = sum({ won: true, placement: 1, kills: 6, survived: 400 }); // 260 XP
// 轻量 meta 替身：只提供 data / save，避免测试拖入 localStorage
const fakeMeta = (seed = {}) => ({
  data: { credits: 0, level: 1, rating: 0, peakRating: 0, stats: { creditsEarned: 0, skinsOwned: 0 }, unlocked: { skins: [], items: [] }, ...seed },
  saves: 0, save() { this.saves += 1; return this.data; },
});
const tracker = (seed) => new SeasonTracker(fakeMeta(seed));
const at = (xp, extra = {}) => { const t = tracker(extra); t.data.xp = xp; t.data.tier = tierFromXp(xp).tier; return t; };
const keys = list => list.map(x => `${x.track}:${x.tier}`);

test('1 · SEASON 数据完整：50 级 / 双轨档位 / 登录 / 连击 / 8+12 任务', () => {
  assert.deepEqual([SEASON.id, SEASON.tiers, SEASON.xpPerTier, SEASON.name, SEASON_TIERS, XP_PER_TIER],
    ['s1', 50, 1000, '第一赛季 · 雾起', 50, 1000]);
  assert.equal(FREE_TIER_REWARDS.length, 10, '免费轨 10 档');
  assert.equal(PAID_TIER_REWARDS.length, 16, '高级轨 16 档');
  assert.deepEqual(FREE_TIER_REWARDS.map(r => r.tier), [5, 10, 15, 20, 25, 30, 35, 40, 45, 50], '每 5 级一档');
  assert.deepEqual(PAID_TIER_REWARDS.map(r => r.tier), Array.from({ length: 16 }, (_, i) => (i + 1) * 3), '每 3 级一档');
  for (const list of [FREE_TIER_REWARDS, PAID_TIER_REWARDS]) { // 档位递增 + 同轨价值单调不降
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].tier > list[i - 1].tier, '档位递增');
      assert.ok(list[i].value >= list[i - 1].value, `${list[i].id} 价值不低于前档`);
    }
  }
  const total = l => l.reduce((a, r) => a + r.value, 0);
  assert.ok(total(PAID_TIER_REWARDS) > total(FREE_TIER_REWARDS) * 1.8, '高级轨整体明显更肥');
  assert.equal(DAILY_LOGIN.length, 7);
  assert.equal(DAILY_LOGIN[0].amount, 100, 'Day1 = 100 信用点');
  assert.deepEqual([DAILY_LOGIN[6].rarity, DAILY_LOGIN[6].itemId], ['legendary', 'skin_legend_dawn'], 'Day7 = 传说皮肤');
  assert.deepEqual(STREAK_BONUSES.map(b => b.days), [3, 7, 14, 30], '3/7/14/30 天连击');
  assert.equal(SEASON_WEEKLY_CHALLENGES.length, 8);
  assert.equal(SEASON_MISSIONS.length, 12);
  assert.equal(SEASON_CHAPTERS.length, 3);
  for (const ch of SEASON_CHAPTERS) assert.equal(SEASON_MISSIONS.filter(m => m.chapter === ch.id).length, 4, `第 ${ch.id} 章 4 条`);
  assert.deepEqual(SEASON_MISSIONS.filter(m => m.chapter === 1).map(m => m.order), [1, 2, 3, 4]);
  // 文案中文 + id 唯一 + 物品奖励必须真实存在于 store.mjs
  const ids = new Set();
  for (const r of [...FREE_TIER_REWARDS, ...PAID_TIER_REWARDS, ...DAILY_LOGIN, ...STREAK_BONUSES]) {
    assert.ok(r.label?.length > 1 && r.desc?.length > 4, `${r.id} 有标题与描述`);
    assert.match(`${r.label}${r.desc}`, /[\u4e00-\u9fa5]/, '文案为中文');
    if (r.id) { assert.ok(!ids.has(r.id), `奖励 id 唯一：${r.id}`); ids.add(r.id); }
    if (r.kind === 'item') assert.ok(STORE_IDS.has(r.itemId), `${r.itemId} 存在于 store.mjs`);
  }
  assert.deepEqual([rewardForTier(5, 'free').track, rewardForTier(6, 'paid').tier], ['free', 6]);
  assert.equal(rewardForTier(7, 'free'), null, '没设奖励的等级返回 null');
});

test('2 · seasonXpForMatch：吃鸡 > 前十 > 落地成盒，全部落在 80–260', () => {
  const win = seasonXpForMatch(WIN);
  const top10 = seasonXpForMatch(sum({ placement: 10, kills: 2, survived: 180 }));
  const dead = seasonXpForMatch(sum({ placement: 16, kills: 0, survived: 15 }));
  assert.ok(win > top10, `吃鸡 ${win} > 前十 ${top10}`);
  assert.ok(top10 > dead, `前十 ${top10} > 落地 ${dead}`);
  assert.equal(win, 260, '吃鸡顶到单局上限');
  for (const [n, xp] of [['吃鸡', win], ['前十', top10], ['落地', dead]]) assert.ok(xp >= 80 && xp <= 260, `${n} ${xp} ∈ [80,260]`);
  assert.ok(win < XP_PER_TIER * 2, '一局升不到两级');
  const normal = seasonXpForMatch(sum({ placement: 8, kills: 3, survived: 240 })); // 4–8 局升一级
  const perTier = XP_PER_TIER / normal;
  assert.ok(perTier >= 4 && perTier <= 8, `中位对局 ${normal} XP → ${perTier.toFixed(1)} 局一级`);
  assert.ok((SEASON_TIERS - 1) * perTier >= 200 && (SEASON_TIERS - 1) * perTier <= 400, '满级 200–400 局');
  assert.equal(seasonXpForMatch({ mode: 'training', won: true, placement: 1 }), 0, '训练场不给');
  const horde = seasonXpForMatch({ mode: 'horde', hordeWaves: 20, kills: 60 });
  assert.ok(horde > 0 && horde <= 220, `虫潮 ${horde}`);
  assert.ok(seasonXpForMatch() >= 80, '空 summary 不炸');
});

test('3 · tierFromXp 边界：0 → 1、999 → 1、1000 → 2、满级封顶', () => {
  assert.deepEqual([tierFromXp(0).tier, tierFromXp(0).progress, tierFromXp(999).tier], [1, 0, 1]);
  assert.deepEqual([tierFromXp(999).xpToNext, tierFromXp(1000).tier, tierFromXp(1000).intoTier], [1, 2, 0]);
  assert.deepEqual([tierFromXp(1499).tier, tierFromXp(-50).tier], [2, 1], '负经验按 0');
  const max = tierFromXp((SEASON_TIERS - 1) * XP_PER_TIER);
  assert.deepEqual([max.tier, max.maxed, max.xpToNext, max.progress], [50, true, 0, 1]);
  assert.equal(tierFromXp(999999).tier, 50, '超量经验封顶 50');
  for (let t = 1; t <= SEASON_TIERS; t++) assert.equal(tierFromXp((t - 1) * XP_PER_TIER).tier, t, `tier ${t} 门槛`);
});

test('4 · addMatchXp 跨级返回 leveledUp 与跨过的奖励', () => {
  const r = tracker({ level: 12 }).addMatchXp(WIN); // 解锁高级轨
  assert.deepEqual([r.gained, r.before, r.after, r.leveledUp, r.rewards.length], [260, 0, 260, false, 0], '一局升不了一级');
  const a = at(3900, { level: 12 }).addMatchXp(WIN); // 4 级末尾 → 5 级
  assert.deepEqual([a.tierBefore, a.tierAfter, a.leveledUp, a.after], [4, 5, true, 4160]);
  assert.deepEqual(keys(a.rewards), ['free:5'], '跨到 5 级只出免费档');
  const b = at(4900, { level: 12 }).addMatchXp(WIN); // 5 级末尾 → 6 级
  assert.deepEqual([b.tierAfter, ...keys(b.rewards)], [6, 'paid:6']);
  assert.ok(b.rewards.every(x => x.claimable && x.tier > b.tierBefore && x.tier <= b.tierAfter), '奖励区间自洽');
  assert.deepEqual(keys(at(1900, { level: 12 }).addMatchXp(WIN).rewards), ['paid:3'], '2 级末尾 → 3 级跨过高级 3 档');
  assert.ok(at(3900).addMatchXp(WIN).rewards.every(x => x.track === 'free'), '高级轨未解锁不给 paid');
});

test('5 · claimTier 幂等 + 档位门槛 + 发放入账', () => {
  const t = at(5200, { level: 12 });
  const first = t.claimTier(5, 'free');
  assert.equal(first.ok, true);
  assert.deepEqual(first.rewards.map(r => r.tier), [5]);
  assert.deepEqual(t.claimTier(5, 'free'), { ok: false, reason: 'already', rewards: [] }, '二次 claim 拒绝');
  assert.equal(t.claimTier(5, 'free').ok, false, '重复领取仍拒绝');
  assert.deepEqual([t.claimTier(20, 'free').reason, t.claimTier(7, 'free').reason], ['locked', 'empty'], '未达等级 / 该级无档');
  assert.deepEqual([t.claimTier(0, 'free').reason, t.claimTier(51, 'paid').reason], ['invalid', 'invalid']);
  assert.deepEqual([t.claimTier(6, 'paid').ok, t.claimTier(3, 'paid').ok], [true, true]);
  assert.equal(at(5200).claimTier(3, 'paid').reason, 'paid-locked', '未解锁领不到高级轨');
  const m = at(5200, { level: 12 });
  m.claimTier(3, 'paid');
  assert.deepEqual([m.meta.data.credits, m.meta.data.stats.creditsEarned], [500, 500], '信用点已发放');
  m.claimTier(6, 'paid');
  assert.ok(m.meta.data.unlocked.items.includes('wskin_p9_ivory'), '武器皮肤已解锁');
  const title = at(45000, { level: 12 });
  title.claimTier(45, 'free');
  assert.deepEqual(title.meta.data.titles, ['雾中常客'], '称号奖励入档');
});

test('6 · claimableTiers 只返回已达成未领取的档位', () => {
  assert.deepEqual(tracker().claimableTiers(), [], '1 级什么都领不到');
  const t = at(5200, { level: 12 });
  assert.deepEqual(keys(t.claimableTiers()), ['paid:3', 'free:5', 'paid:6'], '按档位升序');
  t.claimTier(5, 'free'); t.claimTier(3, 'paid');
  assert.deepEqual(keys(t.claimableTiers()), ['paid:6']);
  t.claimTier(6, 'paid');
  assert.deepEqual(t.claimableTiers(), []);
  assert.deepEqual(at(5200).claimableTiers().map(x => x.track), ['free'], '高级轨未解锁不列 paid');
});

test('7 · 每日登录 7 天循环 + 同一天不可重复领', () => {
  assert.deepEqual(DAILY_LOGIN.map(r => r.day), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([loginDayFor(1), loginDayFor(7), loginDayFor(8), loginDayFor(14), loginDayFor(15)], [1, 7, 1, 7, 1], '第 8 天回 Day1');
  assert.deepEqual([loginRewardFor(8).day, loginRewardFor(15).amount], [1, 100]);
  const t = tracker();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(2026, 9, i, 12);
    assert.equal(t.checkDailyLogin(d).canClaim, true, `第 ${i} 天可领`);
    assert.equal(t.checkDailyLogin(d).day, i, `第 ${i} 天的日历位`);
    const r = t.claimDailyLogin(d);
    assert.deepEqual([r.ok, r.day, r.rewards[0].day], [true, i, i]);
  }
  assert.equal(t.data.login.cycleDay, 7);
  assert.deepEqual([t.claimDailyLogin(new Date(2026, 9, 7, 23)).reason, t.checkDailyLogin(new Date(2026, 9, 7, 23)).canClaim], ['claimed', false], '同一天重复领被拒');
  const d8 = t.claimDailyLogin(new Date(2026, 9, 8, 9));
  assert.deepEqual([d8.day, d8.rewards[0].amount], [1, 100], '第 8 天循环回 Day1');
  const last = t.data.login.lastDay;
  t.checkDailyLogin(new Date(2026, 9, 9, 9));
  assert.equal(t.data.login.lastDay, last, 'checkDailyLogin 不落盘');
});

test('8 · 连续登录：连续 3 天触发 bonus、漏一天重置为 1', () => {
  const t = tracker();
  t.claimDailyLogin(day('2026-10-01'));
  assert.equal(t.streakInfo(day('2026-10-01')).days, 1);
  t.claimDailyLogin(day('2026-10-02'));
  assert.equal(t.streakInfo(day('2026-10-02')).days, 2);
  const before = t.meta.data.credits;
  const third = t.claimDailyLogin(day('2026-10-03'));
  assert.equal(third.streak, 3);
  const bonus = third.rewards.find(r => r.bonus);
  assert.deepEqual([bonus?.days, t.meta.data.credits - before], [3, 500], 'Day3 登录 200 + 连击 300');
  const info = t.streakInfo(day('2026-10-03'));
  assert.deepEqual([info.claimedToday, info.nextBonusAt, info.nextBonusIn], [true, 7, 4]);
  const reset = t.claimDailyLogin(day('2026-10-05')); // 漏 10-04
  assert.equal(reset.streak, 1, '断一天后连击从 1 重来');
  assert.ok(!reset.rewards.some(r => r.bonus), '重置那次没有连击奖励');
  assert.equal(t.data.login.bestStreak, 3, '历史最佳保留');
  const broken = tracker();
  broken.claimDailyLogin(day('2026-10-01'));
  assert.deepEqual([broken.streakInfo(day('2026-10-04')).days, broken.streakInfo(day('2026-10-04')).alive], [0, false], '三天没领视为断链');
});

test('9 · 赛季重置：seasonId 变更时 migrate 清空进度', () => {
  const old = { ...emptySeasonData(), seasonId: 's0', xp: 12345, tier: 13, claimedFree: [5, 10], claimedPaid: [3, 6], challenges: { sc_fog_hunt: { progress: 12, done: true, week: '2026-W40' } }, missions: { sm_1_1: { progress: 3, done: true, claimed: true } } };
  const t = tracker({ season: old });
  assert.deepEqual([t.data.seasonId, t.data.xp, t.data.tier], ['s1', 0, 1], '赛季 id 切换 + 经验/等级清零');
  assert.deepEqual([t.data.claimedFree, t.data.claimedPaid], [[], []], '双轨领取记录清空');
  assert.deepEqual([t.data.challenges, t.data.missions], [{}, {}], '周挑战 / 主线清空');
  assert.equal(t.data.migratedFrom, 's0');
  const direct = tracker().migrate(old);
  assert.deepEqual([direct.xp, direct.seasonId], [0, 's1'], 'migrate 直接调用同结果');
  const same = at(5200);
  assert.equal(same.migrate({ ...same.data, seasonId: 's1' }).xp, 5200, '同赛季 migrate 保留进度');
  assert.deepEqual([tracker().data.seasonId, tracker().data.xp], ['s1', 0], '老档无 season → 全新');
  const junk = new SeasonTracker(fakeMeta({ season: { seasonId: 's1', xp: 'abc', claimedFree: 'oops', challenges: [] } }));
  assert.deepEqual([junk.data.xp, junk.data.claimedFree], [0, []], '垃圾字段不炸');
});

test('10 · seasonDaysLeft / seasonPhase 在赛季前后的取值', () => {
  const start = new Date('2026-10-01T00:00:00');
  assert.equal(seasonDaysLeft(start), 91, '10/1 → 12/31 共 91 天');
  assert.equal(seasonDaysLeft(new Date('2026-12-31T23:59:59')), 0, '最后一天归零');
  assert.equal(seasonDaysLeft(new Date('2027-06-01')), 0, '结束后不为负');
  assert.ok(seasonDaysLeft(new Date('2026-09-01')) >= 120, '赛季前返回整段长度');
  assert.ok(seasonDaysLeft(day('2026-10-01')) > seasonDaysLeft(day('2026-11-01')));
  assert.ok(seasonDaysLeft(day('2026-11-01')) > seasonDaysLeft(day('2026-12-01')));
  assert.deepEqual([seasonPhase(day('2026-09-15')), seasonPhase(day('2026-10-15'))], ['preseason', 'active']);
  assert.deepEqual([seasonPhase(day('2026-12-28')), seasonPhase(day('2027-01-05'))], ['ending', 'ended'], '最后 7 天收官');
  assert.equal(seasonPhase(start), 'active', '首日算 active');
  const st = at(2500, { level: 12 }).seasonStatus(day('2026-11-01'));
  assert.deepEqual([st.id, st.name, st.tier, st.tiers, st.xp, st.xpToNext], ['s1', '第一赛季 · 雾起', 3, 50, 2500, 500]);
  assert.deepEqual([st.phase, st.daysLeft > 50, st.paidTrack.unlocked], ['active', true, true]);
});

test('11 · 周挑战 / 主线：metric 累计、封顶、章节顺序解锁', () => {
  const t = tracker();
  t.challengeProgress([sum({ kills: 13 })]); // 推进「雾里点名」（目标 12）
  const fog = t.challengeProgress().find(c => c.id === 'sc_fog_hunt');
  assert.deepEqual([fog.progress, fog.done], [12, true], '进度封顶到 target');
  assert.deepEqual([t.claimChallenge('sc_fog_hunt').ok, t.claimChallenge('sc_fog_hunt').reason], [true, 'already']);
  assert.deepEqual([t.claimChallenge('sc_win_two').reason, t.claimChallenge('nope').reason], ['not-done', 'unknown']);
  // 主线：第一章第一条 = 3 场对局
  assert.equal(t.missionProgress().filter(m => m.unlocked).length, 1, '1 级只开第一章第一条');
  t.missionProgress([sum(), sum(), sum()]);
  assert.equal(t.missionProgress().find(m => m.id === 'sm_1_1').done, true);
  assert.equal(t.claimMission('sm_1_1').ok, true);
  assert.ok(t.data.xp >= 300, '主线给赛季经验');
  assert.equal(t.missionProgress().find(m => m.id === 'sm_1_2').unlocked, true, '前一条完成后解锁下一条');
  assert.equal(t.missionProgress().find(m => m.id === 'sm_2_1').unlocked, false, '第二章要 8 级');
  assert.equal(at(7000).missionProgress().find(m => m.id === 'sm_2_1').unlocked, true, '8 级开放第二章');
  assert.deepEqual([paidTrackUnlocked(10, 0), paidTrackUnlocked(1, 620), paidTrackUnlocked(9, 619)], [true, true, false]);
});
