// 雾岛突围 / MIST ISLE — 赛季通行证追踪器（纯逻辑，无 DOM）
// 只做三件事：维护 meta.data.season、结算赛季经验/档位、结算每日登录与周挑战。
// 日期一律走 shared/progression.mjs 的 dayKey/weekKey（本地时区），本文件不重复实现。
import { dayKey, weekKey, missionContribution } from '../shared/progression.mjs';
import {
  SEASON, SEASON_TIERS, seasonXpForMatch, tierFromXp,
  rewardForTier, seasonDaysLeft, seasonPhase, paidTrackUnlocked,
  DAILY_LOGIN, loginDayFor, loginRewardFor, streakBonusFor, nextStreakBonus,
  SEASON_WEEKLY_CHALLENGES, SEASON_MISSIONS, SEASON_CHAPTERS,
} from '../shared/data/season.mjs';

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const uniqInts = list => [...new Set((Array.isArray(list) ? list : []).map(v => Math.floor(num(v))).filter(v => v > 0))].sort((a, b) => a - b);
// summary / summary[] / { events: [...] } 三种入参统一成数组；null 表示「只读不推进」
const toSummaryList = events => Array.isArray(events) ? events
  : (events && Array.isArray(events.events) ? events.events : (events && typeof events === 'object' ? [events] : null));

// 两个 dayKey 之间的整天差（b - a）；任一非法返回 Infinity，调用方据此判定「断链」
export function dayGap(a, b) {
  const parse = key => {
    const parts = String(key || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  };
  const ta = parse(a); const tb = parse(b);
  if (ta == null || tb == null) return Infinity;
  return Math.round((tb - ta) / 86400000);
}

// meta.data.season 的默认形态（新增字段一律给默认值，保证旧档补齐）
export function emptySeasonData() {
  return {
    seasonId: SEASON.id,
    xp: 0,
    tier: 1,
    claimedFree: [],
    claimedPaid: [],
    login: { lastDay: '', streak: 0, bestStreak: 0, claimedDays: [], cycleDay: 0 },
    challenges: {},
    missions: {},
    titles: [],
  };
}

export class SeasonTracker {
  constructor(meta = null) {
    this.meta = meta || null;
    this.data = this.load();
  }

  // ---------- 读写 ----------
  load() {
    const raw = this.meta?.data ? this.meta.data.season : null;
    this.data = this.repair(raw);
    this.persistToMeta();
    return this.data;
  }

  save() {
    if (!this.meta) return this.data;
    this.persistToMeta();
    try { if (typeof this.meta.save === 'function') this.meta.save(); } catch { /* 存档失败不阻塞游戏 */ }
    return this.data;
  }

  // 把内存里的 season 对象挂回 meta.data（不落盘；落盘由 save() 负责）
  persistToMeta() {
    if (this.meta && this.meta.data && typeof this.meta.data === 'object') this.meta.data.season = this.data;
    return this.data;
  }

  // 把任意历史数据修补成本赛季的合法结构（不清进度，只补字段/裁剪非法值）
  repair(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...emptySeasonData() };
    if (raw.seasonId && raw.seasonId !== SEASON.id) return this.migrate(raw);
    const loginRaw = raw.login && typeof raw.login === 'object' ? raw.login : {};
    const bucket = (source, defs, extra = {}) => {
      const out = {};
      for (const def of defs) {
        const entry = source?.[def.id];
        if (!entry || typeof entry !== 'object') continue;
        out[def.id] = { progress: clamp(num(entry.progress), 0, def.target), done: !!entry.done, claimed: !!entry.claimed, ...extra(entry) };
      }
      return out;
    };
    const xp = Math.max(0, Math.floor(num(raw.xp)));
    return {
      ...emptySeasonData(),
      seasonId: SEASON.id,
      xp,
      tier: clamp(tierFromXp(xp).tier, 1, SEASON_TIERS),
      claimedFree: uniqInts(raw.claimedFree).filter(t => t <= SEASON_TIERS),
      claimedPaid: uniqInts(raw.claimedPaid).filter(t => t <= SEASON_TIERS),
      login: {
        lastDay: str(loginRaw.lastDay),
        streak: Math.max(0, Math.floor(num(loginRaw.streak))),
        bestStreak: Math.max(0, Math.floor(num(loginRaw.bestStreak, num(loginRaw.streak)))),
        // 只留最近 30 个 dayKey，避免存档无限膨胀
        claimedDays: (Array.isArray(loginRaw.claimedDays) ? loginRaw.claimedDays : [])
          .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-30),
        cycleDay: clamp(Math.floor(num(loginRaw.cycleDay)), 0, DAILY_LOGIN.length),
      },
      challenges: bucket(raw.challenges, SEASON_WEEKLY_CHALLENGES, entry => ({ week: str(entry.week) })),
      missions: bucket(raw.missions, SEASON_MISSIONS),
      titles: Array.isArray(raw.titles) ? raw.titles.filter(t => typeof t === 'string') : [],
    };
  }

  // 旧赛季 / 无赛季存档 → 本赛季。进度清零，但两类资产不回收：
  //   1) 已发放的信用点与外观（它们早已写进 meta.data，本模块从不反向扣除）；
  //   2) 登录连击（属于留存数据，不是赛季进度）——最近一次领取在两天内则连击续上。
  migrate(oldSeasonData) {
    const prev = oldSeasonData && typeof oldSeasonData === 'object' && !Array.isArray(oldSeasonData) ? oldSeasonData : null;
    if (prev && prev.seasonId === SEASON.id) return this.repair(prev);
    const fresh = emptySeasonData();
    const login = prev?.login && typeof prev.login === 'object' ? prev.login : null;
    if (login) {
      const lastDay = str(login.lastDay);
      const streak = Math.max(0, Math.floor(num(login.streak)));
      if (lastDay && streak > 0 && dayGap(lastDay, dayKey()) <= 1) {
        fresh.login.streak = streak;
        fresh.login.lastDay = lastDay;
        fresh.login.claimedDays = [lastDay];
        fresh.login.cycleDay = loginDayFor(streak);
      }
    }
    fresh.migratedFrom = prev ? str(prev.seasonId, 'legacy') : 'none';
    fresh.migratedAt = Date.now();
    return fresh;
  }

  // ---------- 高级轨资格 ----------
  // 不内购：赛季等级 ≥ 10，或历史最高段位 ≥ 黄金（620 分）。用 peakRating，掉段不收回资格。
  paidTrack() {
    const data = this.meta?.data || {};
    const level = num(data.level, 1);
    const peak = Math.max(num(data.peakRating), num(data.rating));
    const unlocked = paidTrackUnlocked(level, peak);
    return {
      track: 'paid', unlocked,
      reason: unlocked ? '已解锁' : '赛季等级 10 级或黄金段位解锁',
      requireLevel: 10, requireRating: 620,
      level, peakRating: peak,
    };
  }

  // ---------- 赛季经验 ----------
  // addMatchXp(summary) -> { gained, before, after, leveledUp, rewards[] }
  // rewards = 本次跨过的每一档（tier 达标即视为「可领取」，仍须 claimTier 确认）
  addMatchXp(summary = {}) {
    const gained = Math.max(0, Math.floor(seasonXpForMatch(summary)));
    const before = this.data.xp;
    const beforeTier = tierFromXp(before).tier;
    const after = before + gained;
    const info = tierFromXp(after);
    this.data.xp = after;
    this.data.tier = info.tier;
    const rewards = [];
    for (let t = beforeTier + 1; t <= info.tier; t++) {
      const free = rewardForTier(t, 'free');
      if (free) rewards.push({ ...free, claimable: true });
      if (this.paidTrack().unlocked) {
        const paid = rewardForTier(t, 'paid');
        if (paid) rewards.push({ ...paid, claimable: true });
      }
    }
    const leveledUp = info.tier > beforeTier;
    this.save();
    return { gained, before, after, leveledUp, tierBefore: beforeTier, tierAfter: info.tier, rewards };
  }

  // ---------- 档位领取 ----------
  claimTier(tier, track = 'free') {
    const t = Math.floor(num(tier));
    const k = track === 'paid' ? 'paid' : 'free';
    if (t < 1 || t > SEASON_TIERS) return { ok: false, reason: 'invalid', rewards: [] };
    const reward = rewardForTier(t, k);
    if (!reward) return { ok: false, reason: 'empty', rewards: [] };
    const list = k === 'paid' ? this.data.claimedPaid : this.data.claimedFree;
    if (list.includes(t)) return { ok: false, reason: 'already', rewards: [] };
    if (tierFromXp(this.data.xp).tier < t) return { ok: false, reason: 'locked', rewards: [] };
    if (k === 'paid' && !this.paidTrack().unlocked) return { ok: false, reason: 'paid-locked', rewards: [] };
    list.push(t);
    list.sort((a, b) => a - b);
    this.grant(reward);
    this.save();
    return { ok: true, tier: t, track: k, rewards: [reward] };
  }

  claimableTiers() {
    const tier = tierFromXp(this.data.xp).tier;
    const rows = (list, claimed, track) => list
      .filter(r => r.tier <= tier && !claimed(r.tier))
      .map(r => ({ tier: r.tier, track, rewards: [r] }));
    const out = [
      ...rows(SEASON.freeTierRewards, t => this.data.claimedFree.includes(t), 'free'),
      ...(this.paidTrack().unlocked ? rows(SEASON.paidTierRewards, t => this.data.claimedPaid.includes(t), 'paid') : []),
    ];
    return out.sort((a, b) => a.tier - b.tier || (a.track === b.track ? 0 : a.track === 'free' ? -1 : 1));
  }

  // 发放到 meta.data：信用点直接加；外观进 unlocked（角色皮肤进 skins，其余进 items）
  // 无 meta（纯测试环境）时只返回清单，不抛错。
  grant(reward) {
    const granted = { credits: 0, items: [], title: '' };
    const data = this.meta?.data;
    if (!reward || !data) return granted;
    if (reward.kind === 'credits') {
      granted.credits = Math.max(0, num(reward.amount));
      data.credits = Math.max(0, num(data.credits)) + granted.credits;
      if (data.stats) data.stats.creditsEarned = num(data.stats.creditsEarned) + granted.credits;
    } else if (reward.kind === 'item' && reward.itemId) {
      granted.items.push(reward.itemId);
      if (data.unlocked) {
        const bucket = reward.itemKind === 'character' ? data.unlocked.skins : data.unlocked.items;
        if (Array.isArray(bucket) && !bucket.includes(reward.itemId)) bucket.push(reward.itemId);
        if (data.stats && Array.isArray(data.unlocked.skins) && Array.isArray(data.unlocked.items)) {
          data.stats.skinsOwned = new Set([...data.unlocked.skins, ...data.unlocked.items]).size;
        }
      }
    } else if (reward.kind === 'title' && reward.title) {
      granted.title = reward.title;
      data.titles = Array.isArray(data.titles) ? data.titles : [];
      if (!data.titles.includes(reward.title)) data.titles.push(reward.title);
      data.title = reward.title;
    }
    return granted;
  }

  // ---------- 每日登录 ----------
  // 口径：7 天日历按「累计领取次数」循环，漏签不清零日历（连击另算，漏一天即断）。
  // checkDailyLogin(now) 只读，不落盘，供首页/任务页渲染按钮状态。
  loginView(now) {
    const today = dayKey(now);
    const login = this.data.login;
    const claimed = login.lastDay === today;
    const gap = login.lastDay ? dayGap(login.lastDay, today) : Infinity;
    const day = claimed ? (login.cycleDay || 1) : (login.cycleDay ? (login.cycleDay % DAILY_LOGIN.length) + 1 : 1);
    const streak = claimed ? login.streak : (gap === 1 ? login.streak + 1 : 1);
    const base = loginRewardFor(day);
    const bonus = claimed ? null : streakBonusFor(streak);
    const rewards = claimed ? [] : [{ ...base }, ...(bonus ? [{ ...bonus, bonus: true }] : [])];
    return { today, claimed, gap, day, streak, base, bonus, rewards, nextStreakAt: nextStreakBonus(streak).days };
  }

  checkDailyLogin(now = new Date()) {
    const v = this.loginView(now);
    return {
      claimed: v.claimed, canClaim: !v.claimed, day: v.day,
      streak: v.streak, rewards: v.rewards,
      bonusAt: v.bonus ? v.bonus.days : v.nextStreakAt,
      nextIn: v.claimed ? '明日 0 点' : '今日可领',
    };
  }

  claimDailyLogin(now = new Date()) {
    const v = this.loginView(now);
    if (v.claimed) return { ok: false, reason: 'claimed', day: v.day, rewards: [] };
    const login = this.data.login;
    login.lastDay = v.today;
    login.streak = v.streak;
    login.bestStreak = Math.max(num(login.bestStreak), v.streak);
    login.cycleDay = v.day;
    login.claimedDays = [...login.claimedDays.filter(d => d !== v.today), v.today].slice(-30);
    for (const reward of v.rewards) this.grant(reward);
    this.save();
    return { ok: true, day: v.day, streak: login.streak, rewards: v.rewards };
  }

  // 连击是否仍然有效：今天或昨天领过才算连着；再往前就断了（返回 0）
  streakInfo(now = new Date()) {
    const login = this.data.login;
    const gap = login.lastDay ? dayGap(login.lastDay, dayKey(now)) : Infinity;
    const live = gap === 0 || gap === 1;
    const days = live ? login.streak : 0;
    const next = nextStreakBonus(days);
    return {
      days, stored: login.streak,
      lastClaimAt: login.lastDay || null, lastDay: login.lastDay || null,
      alive: live, claimedToday: gap === 0,
      nextBonusAt: next.days, nextBonusIn: next.remaining, nextBonusLabel: next.label,
      best: Math.max(login.streak, num(login.bestStreak)),
    };
  }

  // ---------- 周挑战 ----------
  // events：单局 summary / summary 数组 / { events: [...] } 三种写法都接受。
  // 周挑战按 weekKey 分段：跨周第一次调用自动清零（同一周内保留进度）。
  challengeProgress(events = null) {
    const week = weekKey();
    const list = toSummaryList(events);
    for (const def of SEASON_WEEKLY_CHALLENGES) {
      let entry = this.data.challenges[def.id];
      if (!entry || entry.week !== week) entry = this.data.challenges[def.id] = { progress: 0, done: false, claimed: false, week };
      if (!list || entry.done) continue;
      const gain = list.reduce((sum, s) => sum + missionContribution(def.metric, s || {}), 0);
      if (gain > 0) entry.progress = Math.min(def.target, num(entry.progress) + gain);
      if (entry.progress >= def.target) entry.done = true;
    }
    return SEASON_WEEKLY_CHALLENGES.map(c => {
      const entry = this.data.challenges[c.id];
      const progress = clamp(num(entry.progress), 0, c.target);
      return {
        id: c.id, title: c.title, desc: c.desc, metric: c.metric, week,
        progress, target: c.target, done: !!entry.done, claimed: !!entry.claimed,
        pct: clamp(progress / Math.max(1, c.target), 0, 1),
        seasonXp: c.seasonXp, credits: c.credits,
      };
    });
  }

  claimChallenge(id) {
    const def = SEASON_WEEKLY_CHALLENGES.find(c => c.id === id);
    if (!def) return { ok: false, reason: 'unknown', rewards: [] };
    const entry = this.data.challenges[id];
    if (!entry || entry.week !== weekKey()) return { ok: false, reason: 'locked', rewards: [] };
    if (entry.claimed) return { ok: false, reason: 'already', rewards: [] };
    if (!entry.done) return { ok: false, reason: 'not-done', rewards: [] };
    entry.claimed = true;
    const reward = { kind: 'credits', amount: num(def.credits), label: def.title, credits: num(def.credits) };
    this.grant(reward);
    this.save();
    return { ok: true, id, xp: num(def.seasonXp), credits: num(def.credits), rewards: [reward] };
  }

  // ---------- 主线任务（3 章 × 4 条：章节按等级解锁，章内按顺序推进）----------
  missionEntry(def) {
    if (!this.data.missions || typeof this.data.missions !== 'object') this.data.missions = {};
    let entry = this.data.missions[def.id];
    if (!entry || typeof entry !== 'object') entry = this.data.missions[def.id] = { progress: 0, done: false, claimed: false };
    return entry;
  }

  chapterOpen(chapterId) {
    const ch = SEASON_CHAPTERS.find(c => c.id === chapterId);
    return !!ch && this.data.tier >= num(ch.unlockTier, 1);
  }

  missionProgress(events = null) {
    const list = toSummaryList(events);
    for (const def of SEASON_MISSIONS) {
      const entry = this.missionEntry(def);
      if (entry.done || !this.chapterOpen(def.chapter)) continue;
      // 章内必须按顺序推进，保证叙事连贯
      if (def.requires && !this.data.missions[def.requires]?.done) continue;
      if (!list) continue;
      const gain = list.reduce((sum, s) => sum + missionContribution(def.metric, s || {}), 0);
      if (gain > 0) entry.progress = Math.min(def.target, num(entry.progress) + gain);
      if (entry.progress >= def.target) entry.done = true;
    }
    return SEASON_MISSIONS.map(def => {
      const entry = this.missionEntry(def);
      const open = this.chapterOpen(def.chapter);
      const progress = clamp(num(entry.progress), 0, def.target);
      return {
        id: def.id, chapter: def.chapter, order: def.order, title: def.title, desc: def.desc,
        metric: def.metric, progress, target: def.target,
        done: !!entry.done, claimed: !!entry.claimed, chapterOpen: open,
        unlocked: open && (!def.requires || !!this.data.missions[def.requires]?.done),
        pct: clamp(progress / Math.max(1, def.target), 0, 1),
        seasonXp: def.seasonXp, credits: def.credits,
      };
    });
  }

  claimMission(id) {
    const def = SEASON_MISSIONS.find(m => m.id === id);
    if (!def) return { ok: false, reason: 'unknown', rewards: [] };
    const entry = this.missionEntry(def);
    if (entry.claimed) return { ok: false, reason: 'already', rewards: [] };
    if (!entry.done) return { ok: false, reason: 'not-done', rewards: [] };
    entry.claimed = true;
    const before = this.data.tier;
    this.data.xp += Math.max(0, num(def.seasonXp));
    this.data.tier = tierFromXp(this.data.xp).tier;
    const reward = { kind: 'credits', amount: num(def.credits), label: def.title, credits: num(def.credits) };
    this.grant(reward);
    this.save();
    const tierAfter = this.data.tier;
    return { ok: true, id, xp: num(def.seasonXp), credits: num(def.credits), rewards: [reward], tierBefore: before, tierAfter, leveledUp: tierAfter > before };
  }

  // ---------- 赛季总览 ----------
  seasonStatus(now = new Date()) {
    const info = tierFromXp(this.data.xp);
    const paidTrack = this.paidTrack();
    return {
      id: SEASON.id, name: SEASON.name,
      tier: info.tier, tiers: SEASON_TIERS, xp: this.data.xp,
      intoTier: info.intoTier, xpToNext: info.xpToNext, needed: info.needed,
      progress: info.progress, maxed: info.maxed,
      daysLeft: seasonDaysLeft(now), phase: seasonPhase(now),
      claimedFree: this.data.claimedFree.length, claimedPaid: this.data.claimedPaid.length,
      paidTrack, login: this.streakInfo(now), claimable: this.claimableTiers().length,
    };
  }
}
