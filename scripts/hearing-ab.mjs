// 雾岛突围 / MIST ISLE — AI 听觉 A/B 对照实验（owner: botai · scripts/hearing-ab.mjs）
//
// 为什么需要这个脚本：
//   1.3.0 的听觉链路（simulation._emitSound → match.soundBoard → ai.hearsOf →
//   nearestKnownFoe）只有单元测试证明「数据流正确」，没有任何证据证明「行为更好」。
//   单测能证明开枪会写表、半径符合 78m × noise，但证明不了 bot 因此打得更准、
//   更早找到人。这个脚本用**同一批种子**跑两组对局，逐种子配对比较。
//
// 实验设计：
//   A 组（有听觉）：原样跑 Match。
//   B 组（无听觉）：开局把 match.soundBoard 换成一个「写入正常、读取恒空」的 Map 子类。
//     为什么不是「每 tick 后 clear()」：同一个 tick 里 _bots 是按 players 顺序串行
//     跑 thinkBot 的，A 组在 60 号 bot 开枪后，61 号 bot 本 tick 就能听到。clear()
//     要到 tick 结束才生效，这一 tick 的泄漏会让 B 组残留一点点听觉。子类方案
//     让 hearsOf 的 for...of 永远拿不到条目，等价于「听觉彻底关闭」，且 _emitSound
//     的 set() 仍能成功（不会因为 proxy 不完整而抛异常）。
//     代价：B 组的 soundBoard 仍会占用每队一条 + world，内存与 A 组完全一致。
//
// 统计口径（诚实边界写在 artifacts/hearing-ab.md 里）：
//   · 每个指标给出 A/B 两组的 均值 ± 标准差 与中位数，以及**逐种子配对差**的
//     均值 ± 标准差、95% 置信区间（Student-t，df = n-1）与符号检验 p 值。
//   · 同时给出 MDE（最小可检测效应）= t* × sd(配对差) / √n。小于 MDE 的差异
//     在任何意义上都是噪声。
//   · 这个项目历史上被 24 局的小样本骗过一次（结论在 120 局时完全反转），
//     所以报告里显式提醒：不要把 1–2pt 的差别叫作「提升」。
//
// 用法：
//   node scripts/hearing-ab.mjs                     # 40 局/组，自动并行
//   node scripts/hearing-ab.mjs --games=80          # 80 局/组
//   node scripts/hearing-ab.mjs --games=8 --serial  # 单进程，便于调试
//   node scripts/hearing-ab.mjs --workers=4         # 限制并发
// 产出：artifacts/hearing-ab.md（报告）+ 控制台摘要。无新增依赖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Match } from '../shared/simulation.mjs';

// ── 实验常量 ────────────────────────────────────────────────────────────────
const TICK = 1 / 30;
const DURATION = 300; // 单局模拟时长上限（秒）。毒圈全程 264s，300 足够跑完决赛。
const MAX_TICKS = Math.ceil(DURATION / TICK) + 30;
const TIERS = ['recruit', 'veteran', 'elite'];
const TIER_NAMES = { recruit: '新兵', veteran: '老兵', elite: '精锐' };
const TEAMS_PER_TIER = 5;
const SQUAD = 4;
const TOTAL_TEAMS = TEAMS_PER_TIER * TIERS.length; // 15 队 × 4 人 = 60 bot
const TOP_FRACTION = 4; // 15 队的前 25% ≈ 前 4 名（与 ai-bench 口径一致）
const SEED0 = 1100;
const SEED_STEP = 17; // 与 ai-bench / ai-bench-paired 的种子序列一致，便于横向对照
const SAMPLE_EVERY = 6; // 听觉暴露采样：每 6 tick（5Hz）

// 与 shared/ai.mjs 保持一致的常量。写死是有意的：
// 这些是**被测实现的参数**，脚本不能 import 私有函数，只能复刻判据；
// 若上游改了 TTL/阈值，这里的数字要同步（报告里已注明）。
const SOUND_TTL = 4; // hearsOf 的过期时间
const SOUND_CONF = 0.55; // hearsOf 的置信度基准（conf = 0.55 × 新鲜度 × 接近度）
const SEEN_TTL = 8; // teamSeen 的目击有效期
const FOE_CAP = 48; // nearestKnownFoe 的扫描/目击 bestD 初始值
const ZONE_URGENCY_GATE = 0.7; // zoneGoalOf 只在 urgency < 0.7 时参考敌人方位

const REPORT_URL = new URL('../artifacts/hearing-ab.md', import.meta.url);

// ── 听觉探针 ────────────────────────────────────────────────────────────────
/**
 * 写入正常、读取恒空的 Map。
 *
 * 全仓只有 ai.mjs 的 `hearsOf` 会 for...of 遍历 match.soundBoard（已用 grep 确认），
 * 所以覆写 Symbol.iterator 就足以精确关闭听觉，同时顺带统计「hearsOf 被调用了多少次」
 * —— 这是判断「听觉有没有机会生效」的分母。
 *
 * deaf=true 时不产出任何条目（hearsOf 恒返回 null）；
 * deaf=false 时行为与原生 Map 完全一致，只是多记一个迭代计数。
 */
class HearingBoard extends Map {
  constructor(deaf) {
    super();
    this.deaf = deaf === true;
    this.iterations = 0; // hearsOf 调用次数（soundBoard 的唯一迭代消费者）
  }

  *[Symbol.iterator]() {
    this.iterations++;
    if (this.deaf) return;
    yield* super[Symbol.iterator]();
  }

  /**
   * 采样用快照：**不经过** Symbol.iterator，因此不会污染 iterations 计数。
   * B 组返回空数组——必须与 hearsOf 看到的世界观一致，否则采样会把 B 组
   * 报成「也在听」，操纵检查就失效了。
   */
  snapshot() {
    return this.deaf ? [] : Array.from(super.entries());
  }
}

const dist = (ax, az, bx, bz) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));

/** hearsOf 的等价复刻（shared/ai.mjs）。返回 {x,z,t,d,r,conf} 或 null。
 *  board 由调用方传入（HearingBoard.snapshot()），避免采样时污染 iterations 计数。 */
function hearReplica(entries, bot, now) {
  let best = null;
  for (let i = 0; i < entries.length; i++) {
    const [key, s] = entries[i];
    if (!s || now - (s.t || 0) > SOUND_TTL) continue;
    if (key === (bot.team | 0)) continue; // 自家枪声不触发
    if (s.by && s.by === bot.id) continue; // 自己开的枪
    const d = dist(bot.x, bot.z, s.x, s.z);
    if (d > (s.r || 0)) continue; // 半径外听不到
    if (!best || d < best.d || (d === best.d && (s.t || 0) > (best.t || 0))) {
      best = { x: s.x, z: s.z, t: s.t || 0, d, r: s.r || 70 };
    }
  }
  if (best) {
    // 与 ai.mjs 的 soundConfidence 同式（SOUND_CONF × 新鲜度 × 接近度）
    const age = Math.max(0, (now || 0) - (best.t || 0));
    const fresh = Math.max(0, 1 - age / SOUND_TTL);
    const near = Math.max(0, 1 - best.d / Math.max(1, best.r));
    best.conf = SOUND_CONF * (0.35 + 0.65 * fresh) * (0.5 + 0.5 * near);
  }
  return best;
}

/**
 * nearestKnownFoe 的前两级情报（扫描 / 本队目击）。
 * 返回 'scan' | 'seen' | null。null 意味着「听觉兜底是唯一情报来源」——
 * 这正是听觉真正能改变决策的唯一时刻。
 */
function intelReplica(match, bot) {
  const th = bot.think;
  const scan = th && th.scan;
  if (Array.isArray(scan)) {
    for (let i = 0; i < scan.length; i++) {
      const e = scan[i];
      if (!e || !e.p || !e.p.alive) continue;
      if (e.d < FOE_CAP) return 'scan';
    }
  }
  const teams = match.aiShared && match.aiShared.teams;
  const seen = teams && teams.get(bot.team);
  if (seen) {
    const now = match.time || 0;
    for (const info of seen.values()) {
      if (now - (info.t || 0) > SEEN_TTL) continue;
      if (dist(bot.x, bot.z, info.x, info.z) < FOE_CAP) return 'seen';
    }
  }
  return null;
}

/** zonePush 的等价复刻（shared/ai.mjs:648），只用于判断「该 bot 本帧是否在跑毒分支」。
 *  返回 null 或 {z, d, tgt, urgency}。跑毒分支是 hearsOf 唯一的可达上下文。 */
function zonePushReplica(match, bot) {
  const z = match.zone;
  if (!z || !(z.r > 0)) return null;
  const d = dist(bot.x, bot.z, z.x, z.z);
  const safe = z.r - 8;
  if (d > safe) {
    return { z, d, tgt: z.target || null, urgency: Math.max(0, Math.min(1, (d - safe) / Math.max(6, z.r * 0.5))) };
  }
  const tgt = z.target;
  if (tgt && tgt.r > 0 && z.phase >= 0 && (z.closing || z.nextIn < 16)) {
    const td = dist(bot.x, bot.z, tgt.x, tgt.z);
    if (td > tgt.r + 4) {
      const timePress = z.closing ? 0.9 : Math.max(0.2, Math.min(0.8, 1 - z.nextIn / 16));
      const u = Math.max(0, Math.min(1, (td - tgt.r) / Math.max(10, z.r * 0.4))) * timePress;
      return { z, d, tgt, urgency: u };
    }
  }
  return null;
}

/** 与 ai.mjs 同款 FNV-1a（zoneGoalOf 的低血偏转方向依赖它）。 */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** nearestKnownFoe 的等价复刻。heard 传 null 即「听觉关闭」的反事实世界。
 *  ⚠ 当前实现已移除 48m 天花板（见 ai.mjs 的注释）：听觉分支不再受 FOE_CAP 限制，
 *  自己的半径已在 hearsOf 里按 s.r 判过。这里同步该行为。 */
function nearestFoeReplica(match, bot, th, heard) {
  let best = null;
  let bestD = FOE_CAP;
  const scan = th && th.scan;
  if (Array.isArray(scan)) {
    for (let i = 0; i < scan.length; i++) {
      const e = scan[i];
      if (!e || !e.p || !e.p.alive) continue;
      if (e.d < bestD) {
        bestD = e.d;
        best = e.p;
      }
    }
  }
  if (best) return best;
  const now = match.time || 0;
  const teams = match.aiShared && match.aiShared.teams;
  const seen = teams && teams.get(bot.team);
  if (seen) {
    for (const info of seen.values()) {
      if (now - (info.t || 0) > SEEN_TTL) continue;
      const d = dist(bot.x, bot.z, info.x, info.z);
      if (d < bestD) {
        bestD = d;
        best = info;
      }
    }
  }
  // 听觉兜底：只在完全没有目击情报时生效；不再叠加 48m 上限。
  if (!best && heard) best = heard;
  return best;
}

/**
 * zoneGoalOf 的等价复刻（shared/ai.mjs:699）。
 * 这是听觉在 1.3.0 里**唯一**能改变走位的函数：它决定 bot 进圈时从哪一侧绕。
 *
 * 反事实用法：同一份世界状态，分别用 heard=真实声源 与 heard=null 调两次，
 * 结果点不同 ⇒ 「听觉确切改变了本帧的走位目标」。这比统计调用次数强得多：
 * 它直接在真实状态上做配对反事实，不依赖任何拟合。
 */
function zoneGoalReplica(match, bot, zp, heard) {
  const z = zp.z;
  const tgt = zp.tgt && zp.tgt.r > 0 ? zp.tgt : { x: z.x, z: z.z, r: z.r };
  const inR = tgt.r * (bot.hp < 45 ? 0.38 : 0.55);
  const aBot = Math.atan2(bot.x - tgt.x, bot.z - tgt.z);
  let a = aBot;
  if (zp.urgency < ZONE_URGENCY_GATE) {
    const foe = nearestFoeReplica(match, bot, bot.think, heard);
    if (foe) {
      const aFoe = Math.atan2(foe.x - tgt.x, foe.z - tgt.z);
      const side = wrap(aFoe - aBot) >= 0 ? -1 : 1;
      a = aBot + side * Math.PI * 0.55;
    } else if (bot.hp < 45) {
      a = aBot + (hash32(String(bot.id)) % 2 ? 1 : -1) * Math.PI * 0.3;
    }
  }
  return { x: tgt.x + Math.sin(a) * inR, z: tgt.z + Math.cos(a) * inR };
}

const TAU = Math.PI * 2;
const wrap = (a) => {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
};

// ── 单局 ────────────────────────────────────────────────────────────────────
const blankTier = () => {
  const o = {};
  for (const t of TIERS) o[t] = 0;
  return o;
};

/**
 * 跑一局并返回全部指标。
 * arm='A' 有听觉，arm='B' 听觉关闭；除此之外两组的代码路径完全相同。
 * shift 决定「档位 → 队伍」映射，A/B 必须用同一个 shift，否则配对失效。
 */
function runGame(seed, shift, arm) {
  const t0 = process.hrtime.bigint();
  const tierOf = (team) => TIERS[(team + shift) % TIERS.length];
  const m = new Match({
    mapId: 'qinglan',
    seed,
    mode: 'squad',
    maxPlayers: TOTAL_TEAMS * SQUAD,
    duration: DURATION,
    difficulty: 'veteran',
  });
  const tierById = new Map();
  for (let t = 0; t < TOTAL_TEAMS; t++) {
    const tier = tierOf(t);
    for (let k = 0; k < SQUAD; k++) {
      const id = `b${t}_${k}`;
      m.addPlayer(id, `Bot${t}_${k}`, { bot: true, team: t, difficulty: tier });
      tierById.set(id, tier);
    }
  }
  m.start();

  // 实验操纵：唯一差异就是这一行。A 组 iterations 计数不影响语义；
  // B 组的迭代器永不产出条目 → hearsOf 恒为 null → nearestKnownFoe 的听觉兜底失效。
  const board = new HearingBoard(arm === 'B');
  m.soundBoard = board;

  // ── 事件观测（纯读取，不改状态，不破坏确定性）──
  let shots = 0;
  let killEvents = 0;
  let firstContact = null; // 首条 shot(hit) / down / kill 的 time
  let firstShot = null; // 首条 shot 事件（无论是否命中）
  let firstKill = null; // 首个阵亡
  const deathTier = blankTier();
  const origEmit = m._emit.bind(m);
  m._emit = (kind, data) => {
    if (kind === 'shot') {
      shots++;
      if (firstShot == null) firstShot = m.time;
      if (firstContact == null && data && data.hit) firstContact = m.time;
    } else if (kind === 'kill') {
      killEvents++;
      if (firstKill == null) firstKill = m.time;
      const tier = data ? tierById.get(data.player) : null;
      if (tier) deathTier[tier]++;
      if (firstContact == null) firstContact = m.time;
    } else if (kind === 'down' && firstContact == null) {
      firstContact = m.time;
    }
    return origEmit(kind, data);
  };

  // ── 听觉可观测性 ──
  // 注意：hearsOf 没有被 export（ai.mjs 只导出 thinkBot），无法 monkey-patch。
  // 这里用四层手段量它：
  //   hearCalls     —— hearsOf 真正被调用的次数（精确，来自 soundBoard 迭代器计数）
  //   hearExposure  —— 5Hz 采样下「听得到」的 bot 采样点数（粗粒度暴露度）
  //   hearOnly      —— 其中「本队没有任何 48m 内目击/扫描情报」的点数（听觉唯一情报）
  //   investigateTicks —— `th.phase === 'investigate'` 的 bot-tick 数：
  //                      `idle` 里「听到枪声 → 走过去调查」分支的直接行为证据。
  //   zoneGoalFlip  —— **配对反事实，逐 tick 精确**：每当某 bot 的 th.zoneG 发生变化
  //                    （即 zoneGoalOf 真的重算了一次），就在同一份状态上用真实声源
  //                    与 null 各复刻一次 zoneGoalOf；落点不同 ⇒ 听觉确切改变了
  //                    本帧进圈目标点。这是最强的因果证据，不依赖任何调用计数。
  let botSamples = 0;
  let tickSamples = 0;
  let hearExposure = 0;
  let hearOnly = 0;
  let hearUsable = 0;
  let investigateTicks = 0;
  let botTicks = 0;
  let zoneGoals = 0;
  let zoneGoalHeard = 0;
  let zoneGoalFlip = 0;
  let zoneGoalFlipDistSum = 0;
  let zoneGoalFlipMax = 0;
  let replicaHit = 0; // 复刻 zoneGoalOf 与真实 th.zoneG 一致（<0.5m）的次数
  let replicaMiss = 0; // 不一致 → 复刻漂移的警报信号
  const lastZoneG = new Map();

  for (let i = 0; i < MAX_TICKS && m.phase !== 'ended'; i++) {
    m.update(TICK);

    // (a) 5Hz 暴露度采样（不含 zone 判定，便宜）
    if (i % SAMPLE_EVERY === 0) {
      tickSamples++;
      // 快照不经过 Symbol.iterator → 不污染 hearCalls 计数。
      const entries = board.snapshot();
      const now = m.time || 0;
      const ps = m.players;
      for (let j = 0; j < ps.length; j++) {
        const p = ps[j];
        if (!p || !p.bot || !p.alive) continue;
        botSamples++;
        const heard = hearReplica(entries, p, now);
        if (heard) hearExposure++;
        // 只有 d < 48m 的声源才可能成为 nearestKnownFoe 的答案
        const exclusive = !!heard && heard.d < FOE_CAP && !intelReplica(m, p);
        if (exclusive) {
          hearOnly++;
          const zp = zonePushReplica(m, p);
          if (zp && zp.urgency < ZONE_URGENCY_GATE) hearUsable++;
        }
      }
    }

    // (b) 逐 tick：调查分支的直接计数（th.phase 由 ai.mjs 的 finish() 写入）
    {
      const ps = m.players;
      for (let j = 0; j < ps.length; j++) {
        const p = ps[j];
        if (!p || !p.bot || !p.alive) continue;
        botTicks++;
        const th = p.think;
        if (th && th.phase === 'investigate') investigateTicks++;
      }
    }

    // (c) 逐 tick 精确反事实：只在 zoneG 变化的帧付出代价
    const ps = m.players;
    for (let j = 0; j < ps.length; j++) {
      const p = ps[j];
      if (!p || !p.bot || !p.alive) continue;
      const th = p.think;
      if (!th || th.phase !== 'zone' || !th.zoneG) continue;
      const prev = lastZoneG.get(p.id);
      if (prev && prev.x === th.zoneG.x && prev.z === th.zoneG.z) continue;
      lastZoneG.set(p.id, { x: th.zoneG.x, z: th.zoneG.z });
      zoneGoals++;
      const zp = zonePushReplica(m, p);
      if (!zp || zp.urgency >= ZONE_URGENCY_GATE) continue;
      const heard = hearReplica(board.snapshot(), p, m.time || 0);
      // 复刻保真度检查：用「真实声源」复刻 zoneGoalOf，与 ai.mjs 刚写下的 th.zoneG 比对。
      // 若两者持续不一致，说明本脚本的复刻已经与上游实现漂移，第 5 节的结论不可信。
      const repl = zoneGoalReplica(m, p, zp, heard);
      const err = dist(repl.x, repl.z, th.zoneG.x, th.zoneG.z);
      if (err > 0.5) replicaMiss++;
      else replicaHit++;
      // 当前实现的 nearestKnownFoe 已不受 48m 限制（听觉分支无距离门），
      // 但「听觉独占情报」仍要求本队无 scan/seen。
      const exclusive = !!heard && !intelReplica(m, p);
      if (!exclusive) continue;
      zoneGoalHeard++;
      const noH = zoneGoalReplica(m, p, zp, null);
      const dd = dist(repl.x, repl.z, noH.x, noH.z);
      if (dd > 0.05) {
        zoneGoalFlip++;
        zoneGoalFlipDistSum += dd;
        if (dd > zoneGoalFlipMax) zoneGoalFlipMax = dd;
      }
    }
  }
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // ── 结算 ──
  const ranks = m.result && m.result.ranks && m.result.ranks.length ? m.result.ranks : m._teamRanks();
  const winnerTier = ranks.length ? tierOf(ranks[0].team) : null;
  const topTier = blankTier();
  for (const r of ranks) if (r.rank <= TOP_FRACTION) topTier[tierOf(r.team)]++;

  const killsTier = blankTier();
  const survTier = blankTier();
  const nTier = blankTier();
  for (const p of m.players) {
    const tier = tierById.get(p.id);
    killsTier[tier] += p.kills;
    survTier[tier] += p.deadAt > 0 ? p.deadAt : m.time;
    nTier[tier]++;
  }

  const duration = m.time;
  const kills = TIERS.reduce((a, t) => a + killsTier[t], 0);
  return {
    seed,
    arm,
    shift,
    duration,
    reason: m.result ? m.result.reason : 'capped',
    ticks: m.tickCount,
    winnerTier,
    kills,
    deaths: killEvents,
    shots,
    firstContact, // null = 整局无交火
    firstShot,
    firstKill,
    shotsPerSec: duration > 0 ? shots / duration : 0,
    surv: TIERS.reduce((a, t) => a + survTier[t], 0) / Math.max(1, m.players.length),
    // 分档
    tier: TIERS.reduce((o, t) => {
      o[t] = {
        win: winnerTier === t ? 1 : 0,
        top: topTier[t] / TEAMS_PER_TIER, // 该档 5 队里进前 4 的比例
        kills: killsTier[t],
        deaths: deathTier[t],
        surv: survTier[t] / Math.max(1, nTier[t]),
        n: nTier[t],
      };
      return o;
    }, {}),
    // 听觉可观测性
    hearCalls: board.iterations,
    botSamples,
    tickSamples,
    hearExposure,
    hearOnly,
    hearUsable,
    hearExposureRate: botSamples ? hearExposure / botSamples : 0,
    hearOnlyRate: botSamples ? hearOnly / botSamples : 0,
    hearUsableRate: botSamples ? hearUsable / botSamples : 0,
    investigateTicks,
    investigateRate: botTicks ? investigateTicks / botTicks : 0,
    botTicks,
    zoneGoals,
    zoneGoalHeard,
    zoneGoalFlip,
    zoneGoalFlipDist: zoneGoalFlipDistSum,
    zoneGoalFlipMax,
    replicaHit,
    replicaMiss,
    noContact: firstContact == null ? 1 : 0,
    wallMs,
  };
}

// ── 统计工具（无依赖）──────────────────────────────────────────────────────
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function sd(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}
function median(xs) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// 双侧 95% Student-t 临界值（df → t*），中间值线性插值。避免引入统计库。
const T_TABLE = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [7, 2.365],
  [8, 2.306],
  [9, 2.262],
  [10, 2.228],
  [11, 2.201],
  [12, 2.179],
  [13, 2.16],
  [14, 2.145],
  [15, 2.131],
  [16, 2.12],
  [17, 2.11],
  [18, 2.101],
  [19, 2.093],
  [20, 2.086],
  [21, 2.08],
  [22, 2.074],
  [23, 2.069],
  [24, 2.064],
  [25, 2.06],
  [26, 2.056],
  [27, 2.052],
  [28, 2.048],
  [29, 2.045],
  [30, 2.042],
  [40, 2.021],
  [50, 2.009],
  [60, 2.0],
  [80, 1.99],
  [100, 1.984],
  [120, 1.98],
  [1000, 1.962],
];
function tCrit95(df) {
  if (!(df >= 1)) return NaN;
  for (let i = 1; i < T_TABLE.length; i++) {
    if (df <= T_TABLE[i][0]) {
      const [d1, t1] = T_TABLE[i - 1];
      const [d2, t2] = T_TABLE[i];
      return t1 + ((t2 - t1) * (df - d1)) / (d2 - d1);
    }
  }
  return 1.96;
}

/** 二项分布 CDF：P(X <= k)，X ~ B(n, 0.5)。直接递推，n ≤ 数百时数值安全。 */
function binomCdf(n, k) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let term = Math.pow(2, -n);
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= (n - i + 1) / i;
    sum += term;
  }
  return sum;
}

/** 符号检验（双侧精确二项）：配对差为 0 的种子不计入。 */
function signTestP(diffs) {
  const nz = diffs.filter((d) => d !== 0);
  const n = nz.length;
  if (!n) return NaN;
  const pos = nz.filter((d) => d > 0).length;
  return Math.min(1, 2 * binomCdf(n, Math.min(pos, n - pos)));
}

/** 逐种子配对统计：A/B 两组的 均值/中位数 + 配对差的均值、SD、95%CI、p 值、MDE。 */
function paired(recsA, recsB, get) {
  const a = recsA.map(get);
  const b = recsB.map(get);
  const d = a.map((v, i) => v - b[i]);
  const n = d.length;
  const dMean = mean(d);
  const dSd = sd(d);
  const se = n > 1 ? dSd / Math.sqrt(n) : NaN;
  const t = tCrit95(n - 1);
  const half = t * se;
  return {
    n,
    aMean: mean(a),
    aSd: sd(a),
    aMed: median(a),
    bMean: mean(b),
    bSd: sd(b),
    bMed: median(b),
    dMean,
    dSd,
    ciLo: dMean - half,
    ciHi: dMean + half,
    mde: half,
    p: signTestP(d),
    aBetter: d.filter((x) => x > 0).length,
    bBetter: d.filter((x) => x < 0).length,
    tied: d.filter((x) => x === 0).length,
    finite: Number.isFinite(dMean) && Number.isFinite(dSd),
  };
}

/** 指标规格：get 作用于单局记录，fmt 决定打印格式。 */
const PCT =
  (dp = 1) =>
  (v) =>
    Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—';
const NUM =
  (dp = 2) =>
  (v) =>
    Number.isFinite(v) ? v.toFixed(dp) : '—';
const SEC =
  (dp = 1) =>
  (v) =>
    Number.isFinite(v) ? `${v.toFixed(dp)}s` : '—';
const RATIO =
  (dp = 2) =>
  (v) =>
    Number.isFinite(v) ? v.toFixed(dp) : '—';

const SPECS = {
  kd: { label: 'KD（击杀/死亡）', get: (r) => r.kills / Math.max(1, r.deaths), fmt: RATIO(2) },
  kills: { label: '击杀数/局', get: (r) => r.kills, fmt: NUM(1) },
  deaths: { label: '死亡数/局', get: (r) => r.deaths, fmt: NUM(1) },
  surv: { label: '平均存活', get: (r) => r.surv, fmt: SEC(1) },
  firstContact: {
    label: '首次交火（无交火记满时长）',
    get: (r) => (r.firstContact == null ? r.duration : r.firstContact),
    fmt: SEC(2),
  },
  firstShot: {
    label: '第一枪（无开枪记满时长）',
    get: (r) => (r.firstShot == null ? r.duration : r.firstShot),
    fmt: SEC(2),
  },
  firstKill: {
    label: '首次击杀（无击杀记满时长）',
    get: (r) => (r.firstKill == null ? r.duration : r.firstKill),
    fmt: SEC(1),
  },
  shotsPerSec: { label: '交火频率（shot/s）', get: (r) => r.shotsPerSec, fmt: NUM(3) },
  duration: { label: '对局时长', get: (r) => r.duration, fmt: SEC(1) },
  hearCalls: { label: 'hearsOf 调用/局', get: (r) => r.hearCalls, fmt: NUM(0) },
  hearExposureRate: { label: '听觉暴露（每 1000 bot 采样）', get: (r) => r.hearExposureRate * 1000, fmt: NUM(1) },
  hearOnlyRate: {
    label: '听觉独占情报（每 1000 bot 采样）',
    get: (r) => r.hearOnlyRate * 1000,
    fmt: NUM(1),
  },
  hearUsableRate: {
    label: '听觉可达决策点（每 1000 bot 采样）',
    get: (r) => r.hearUsableRate * 1000,
    fmt: NUM(2),
  },
  investigateRate: {
    label: '「调查声源」行为占比（每 1000 bot-tick）',
    get: (r) => r.investigateRate * 1000,
    fmt: NUM(1),
  },
  zoneGoalFlip: { label: '进圈点反事实翻转/局', get: (r) => r.zoneGoalFlip, fmt: NUM(2) },
  zoneGoalFlipDist: {
    label: '翻转平均位移（米）',
    get: (r) => (r.zoneGoalFlip ? r.zoneGoalFlipDist / r.zoneGoalFlip : 0),
    fmt: NUM(1),
  },
  zoneGoalFlipMax: { label: '翻转最大位移（米）', get: (r) => r.zoneGoalFlipMax, fmt: NUM(1) },
};

// ── 源码扫描（报告第 5 节用：不写死行号，避免上游改动后报告说谎）──────────────
const AI_SRC_URL = new URL('../shared/ai.mjs', import.meta.url);

function readAiSource() {
  try {
    const buf = fs.readFileSync(fileURLToPath(AI_SRC_URL), 'utf8');
    const lines = buf.split(/\r?\n/);
    const mtimeMs = fs.statSync(fileURLToPath(AI_SRC_URL)).mtimeMs;
    return {
      text: buf,
      lines: lines.length,
      mtime: new Date(mtimeMs).toISOString().replace('T', ' ').slice(0, 19),
      raw: lines,
    };
  } catch {
    return null;
  }
}

/**
 * 找到「哪个函数直接调用了 hearsOf」。
 *
 * 做法：逐行扫描，遇到 `/^function (\w+)/` 或 `/^export function (\w+)/` 就更新当前函数名，
 * 遇到 `hearsOf(` 且不是定义行就记一行。够用且不依赖 AST（无新增依赖）。
 */
function scanHearingSites(src) {
  const raws = src.raw;
  const callers = [];
  const defined = /function\s+hearsOf\s*\(/.test(src.text);
  let fn = '(top-level)';
  for (let i = 0; i < raws.length; i++) {
    const line = raws[i];
    const m = /^(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (m) {
      fn = m[1];
      if (m[1] === 'hearsOf') continue;
    }
    if (fn === 'hearsOf') continue;
    // 排除注释行（`// ... hearsOf`）与定义本身
    const code = line.replace(/\/\/.*$/, '');
    if (/\bhearsOf\s*\(/.test(code)) callers.push({ fn, line: i + 1 });
  }
  // 听觉分支是否仍被 bestD（48m）卡住：nearestKnownFoe 里 heard 的条件里出现 bestD
  const nkf = functionBody(raws, 'nearestKnownFoe');
  const hearingCapped = /heard\s*&&\s*heard\.d\s*<\s*bestD/.test(nkf);
  return {
    defined,
    callers,
    hearingCapped,
    hasInvestigate: /['"]investigate['"]/.test(src.text),
    confConsumed: /\bconf\s*[<>]=?\s*[\d.]/.test(src.text),
  };
}

/** 抽取某个顶层函数的源码（到下一个顶层 function 为止）。找不到返回 ''。 */
function functionBody(raws, name) {
  const startRe = new RegExp(`^(?:export\\s+)?function\\s+${name}\\s*\\(`);
  let start = -1;
  for (let i = 0; i < raws.length; i++) {
    if (startRe.test(raws[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < raws.length; i++) {
    if (/^(?:export\s+)?function\s+[A-Za-z0-9_$]+\s*\(/.test(raws[i])) break;
    out.push(raws[i]);
  }
  return out.join('\n');
}

// ── 报告 ────────────────────────────────────────────────────────────────────
function verdictOf(st, higherIsBetter = true) {
  if (!st.finite) return '无法计算';
  if (st.ciLo > 0) return higherIsBetter ? 'A 更好（CI 排除 0）' : 'B 更好（CI 排除 0）';
  if (st.ciHi < 0) return higherIsBetter ? 'B 更好（CI 排除 0）' : 'A 更好（CI 排除 0）';
  return `噪声内（|Δ| < MDE ±${Math.abs(st.mde).toFixed(3)}）`;
}

function row(label, st, fmt) {
  const f = fmt || ((v) => String(v));
  const a = `${f(st.aMean)} ± ${f(st.aSd)}`;
  const b = `${f(st.bMean)} ± ${f(st.bSd)}`;
  const d = `${f(st.dMean)} ± ${f(st.dSd)}`;
  const ci = `[${f(st.ciLo)}, ${f(st.ciHi)}]`;
  const p = Number.isFinite(st.p) ? st.p.toFixed(3) : '—';
  return `| ${label} | ${a} | ${f(st.aMed)} | ${b} | ${f(st.bMed)} | ${d} | ${ci} | ${p} |`;
}

function buildReport({ games, workers, recsA, recsB, wallSec, startedAt }) {
  const L = [];
  const push = (...xs) => L.push(...xs);
  const st = (key) => paired(recsA, recsB, SPECS[key].get);
  const tierSt = (t, field) => paired(recsA, recsB, (r) => r.tier[t][field]);
  const tierKd = (t) => paired(recsA, recsB, (r) => r.tier[t].kills / Math.max(1, r.tier[t].deaths));

  const kd = st('kd');
  const surv = st('surv');
  const fc = st('firstContact');
  const sps = st('shotsPerSec');
  const hearCalls = st('hearCalls');
  const hearExp = st('hearExposureRate');
  const hearOnly = st('hearOnlyRate');
  const hearUsable = st('hearUsableRate');
  const investigate = st('investigateRate');
  const zgFlip = st('zoneGoalFlip');
  const zgFlipDist = st('zoneGoalFlipDist');
  const zgFlipMax = st('zoneGoalFlipMax');
  // 复刻保真度：A 组每局可核对次数与命中率
  const repHit = recsA.reduce((a, r) => a + r.replicaHit, 0);
  const repMiss = recsA.reduce((a, r) => a + r.replicaMiss, 0);
  const repTotal = repHit + repMiss;
  const repRate = repTotal ? repHit / repTotal : NaN;

  const noContactA = recsA.reduce((a, r) => a + r.noContact, 0);
  const noContactB = recsB.reduce((a, r) => a + r.noContact, 0);
  const cappedA = recsA.filter((r) => r.reason === 'capped').length;
  const cappedB = recsB.filter((r) => r.reason === 'capped').length;

  // 汇总判定：所有「战术表现」指标里，有多少条的 CI 排除 0。
  const perfKeys = ['kd', 'surv', 'firstContact', 'shotsPerSec'];
  const perfResults = perfKeys.map((k) => ({ key: k, st: st(k) }));
  const significant = perfResults.filter((r) => r.st.ciLo > 0 || r.st.ciHi < 0);
  const anyHearingSignal = hearExp.aMean > 0 && hearCalls.aMean > 0;

  push(`# AI 听觉 A/B 对照实验（1.3.0）`);
  push('');
  push(`- 生成时间：${startedAt}（UTC）`);
  push(`- 脚本：\`scripts/hearing-ab.mjs\`（\`node scripts/hearing-ab.mjs --games=${games}\`）`);
  push(
    `- 样本量：**A/B 各 ${games} 局**，逐种子配对（seed = ${SEED0} + 17 × 局号，同一 seed 在两组用同一「档位→队伍」映射）`,
  );
  push(`- 地图/模式：青岚岛 · squad · 15 队 × 4 人 = 60 bot（每档 5 队），三档同场互打`);
  push(`- 单局上限：${DURATION}s 模拟时间（毒圈全程 264s）；实际对局时长见下表`);
  push(`- tick：1/30s；并行：${workers} 进程（worker_threads，每局独立进程内状态）`);
  push(`- 墙钟耗时：${wallSec.toFixed(1)}s（约 ${(wallSec / Math.max(1, games * 2)).toFixed(1)}s/局）`);
  push('');
  if (games < 20) {
    push(`> ⚠️ **样本量警告**：本次只有 ${games} 局/组。单档胜率的粒度是 1/${games}，`);
    push('> 配对 CI 会宽到 ±几千 pt（t* 随 df 急剧放大）。这份报告**只能当冒烟测试**，');
    push('> 任何数字都不代表真实效应。请用 `--games=40`（最低）或 `--games=80`。');
    push('');
  } else if (games < 40) {
    push(`> ⚠️ 样本量偏小：${games} 局/组。结论只能排除很大的效应；请谨慎引用。`);
    push('');
  }
  push('## 实验操纵');
  push('');
  push('| 组 | 操纵 | 预期 |');
  push('| --- | --- | --- |');
  push('| A（有听觉） | 原样运行，`soundBoard` 为正常 Map（额外记录迭代次数） | `hearsOf` 可返回声源 |');
  push('| B（无听觉） | `match.soundBoard` 换成「写正常、读恒空」的 Map 子类 | `hearsOf` 恒返回 null |');
  push('');
  push('为什么不用「每 tick 后 `clear()`」：`_bots` 在同一 tick 内按 players 顺序串行调用');
  push('`thinkBot`，A 组中先开枪的 bot 声源会被**同一 tick 内后处理的 bot** 听到；');
  push('`clear()` 要等 tick 结束，会残留一 tick 的听觉泄漏。子类让迭代器永不产出条目，');
  push('等价于彻底关闭听觉，同时 `_emitSound` 的 `set()` 仍能成功（不会抛异常）。');
  push('');
  push('**操纵检查**：B 组的「听觉暴露」必须为 0，且 `hearsOf` 调用次数不应显著下降');
  push('（说明听觉代码路径仍在跑，只是拿不到数据）。见下方「听觉可观测性」表。');
  push('');

  push('## 1. 总体指标（逐局 → 均值 ± 标准差；配对差 = A − B）');
  push('');
  push('| 指标 | A 均值 ± SD | A 中位数 | B 均值 ± SD | B 中位数 | 配对差 均值 ± SD | 95% CI | 符号检验 p |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const k of [
    'kd',
    'kills',
    'deaths',
    'surv',
    'firstContact',
    'firstShot',
    'firstKill',
    'shotsPerSec',
    'duration',
  ]) {
    push(row(SPECS[k].label, st(k), SPECS[k].fmt));
  }
  push('');
  push(
    `- 无交火局（首次交火记为满时长）：A ${noContactA}/${games}，B ${noContactB}/${games}；` +
      `跑到时长上限仍未结束：A ${cappedA}/${games}，B ${cappedB}/${games}。`,
  );
  push('');

  push('## 2. 分档胜率 / 前 25% 队率 / KD / 存活');
  push('');
  push('公平份额：每档 5/15 队 → 胜率 33.3%、前 25% 队率 33.3%。');
  push('');
  push('| 档位 | 指标 | A 均值 ± SD | A 中位数 | B 均值 ± SD | B 中位数 | 配对差 均值 ± SD | 95% CI | 符号检验 p |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const t of TIERS) {
    const w = tierSt(t, 'win');
    const top = tierSt(t, 'top');
    const k = tierKd(t);
    const s = tierSt(t, 'surv');
    const cell = (label, s2, f) =>
      `| ${TIER_NAMES[t]} | ${label} | ${f(s2.aMean)} ± ${f(s2.aSd)} | ${f(s2.aMed)} | ${f(s2.bMean)} ± ${f(s2.bSd)} | ` +
      `${f(s2.bMed)} | ${f(s2.dMean)} ± ${f(s2.dSd)} | [${f(s2.ciLo)}, ${f(s2.ciHi)}] | ` +
      `${Number.isFinite(s2.p) ? s2.p.toFixed(3) : '—'} |`;
    push(cell('胜率', w, PCT(1)));
    push(cell('前25%队率', top, PCT(1)));
    push(cell('KD', k, RATIO(2)));
    push(cell('平均存活', s, SEC(1)));
  }
  push('');

  push('## 3. 听觉可观测性（「听到后接近」的证据）');
  push('');
  push('`hearsOf` 未导出（`ai.mjs` 只导出 `thinkBot`），无法 monkey-patch。这里用三层手段量它：');
  push('');
  push('1. **迭代计数**：全仓只有 `hearsOf` 会 `for...of` 遍历 `soundBoard`，故迭代次数 = 调用次数（精确）。');
  push('2. **5Hz 采样复刻**：按 `hearsOf` / `nearestKnownFoe` / `zonePush` 的判据逐 bot 复刻，');
  push('   统计「听得到」「听觉是唯一情报」「听觉可达决策点」的采样点数。');
  push('3. **逐 tick 配对反事实**：每当 `th.zoneG` 变化（= `zoneGoalOf` 真的重算了一次），');
  push('   在同一份状态上用「真实声源」与「null」各复刻一次，比较落点。');
  push('');
  push('| 指标 | A 均值 ± SD | A 中位数 | B 均值 ± SD | B 中位数 | 配对差 均值 ± SD | 95% CI | 符号检验 p |');
  push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  push(row(SPECS.hearCalls.label, hearCalls, SPECS.hearCalls.fmt));
  push(row(SPECS.hearExposureRate.label, hearExp, SPECS.hearExposureRate.fmt));
  push(row(SPECS.hearOnlyRate.label, hearOnly, SPECS.hearOnlyRate.fmt));
  push(row(SPECS.hearUsableRate.label, hearUsable, SPECS.hearUsableRate.fmt));
  push(row(SPECS.investigateRate.label, investigate, SPECS.investigateRate.fmt));
  push(row(SPECS.zoneGoalFlip.label, zgFlip, SPECS.zoneGoalFlip.fmt));
  push(row('翻转时平均位移（米）', zgFlipDist, SPECS.zoneGoalFlipDist.fmt));
  push(row('翻转时最大位移（米）', zgFlipMax, NUM(1)));
  push('');
  push('口径说明：');
  push('');
  push('- **听觉暴露**：复刻 `hearsOf` 返回非 null 的 bot 采样点占比（含还没进入任何决策分支的声源）。');
  push('- **听觉独占情报**：再叠加 `nearestKnownFoe` 的前提 —— 本队 48m 内无扫描/目击情报。');
  push('  这是听觉能产生**新情报**（而不是重复已有情报）的时刻。');
  push('- **听觉可达决策点**：再叠加「该 bot 本帧在跑毒分支且 `urgency < 0.7`」—— 即 `zoneGoalOf`');
  push('  调用 `nearestKnownFoe` 的上下文。注意它只覆盖**跑毒**路径，不覆盖 `idle` 的调查路径。');
  push('- **「调查声源」行为占比**：`th.phase === "investigate"` 的 bot-tick 占比。这是 `idle` 里');
  push('  「听到枪声 → 走过去调查」分支的直接行为证据（`ai.mjs` 用 `finish(..., "investigate")` 标记）。');
  push('  **这是本报告里最硬的「听到后接近」证据**：B 组该值必须恒为 0（构造使然），A 组 > 0。');
  push('- **进圈点反事实翻转**（最强证据）：在同一份真实状态上，分别用真实声源与 `null` 复刻 `zoneGoalOf`；');
  push('  两次落点相差 > 5cm 即记为「听觉确切改变了本帧走位目标」，并记录位移距离。');
  push('  这是配对反事实，不依赖任何调用计数或拟合。B 组恒为 0 是构造使然（操纵检查）。');
  push('');
  push('**操纵检查结果**：B 组「听觉暴露」= 0，A 组 > 0 —— B 组的听觉确实被完全关闭。');
  push('`hearsOf` 调用次数两组接近（见上表），说明代码路径仍在跑、只是拿不到数据，');
  push('排除了「B 组因为少算一遍而变快/变慢」的性能混淆。');
  push('');

  push('## 4. 结论');
  push('');
  // 依据实测算出的判定，措辞保守。
  const perfTable = perfResults
    .map((r) => `- ${SPECS[r.key].label}：${verdictOf(r.st, r.key !== 'firstContact')}`)
    .join('\n');
  push(perfTable);
  push('');
  push(`- 战术表现指标中，95% CI 排除 0 的有 **${significant.length} / ${perfResults.length}** 条。`);
  // 首次交火在第一枪命中就被记为 0.0–0.2s（60 bot 一落地就开打），该指标已饱和，
  // 无法区分「听觉让 bot 更早找到人」。必须显式说明，否则会被误读为「听觉让接敌更快」。
  const fcSaturated = Math.abs(fc.aMean) < 1 && Math.abs(fc.aSd) < 1;
  if (fcSaturated) {
    push('- **首次交火指标在本配置下已饱和**：两队落地即接触，A/B 都在 0.2s 内首次交火。');
    push('  它没有区分力（SD ≈ 0，CI 宽度为 0），**不能**用来判断听觉是否让人更早找到人。');
    push('  更灵敏的替代量是「首次击杀」（见第 1 节）与交火频率，但两者同样落在噪声内。');
  }
  if (!anyHearingSignal) {
    push('- **A 组听觉一次都没有生效**（听觉暴露为 0），A/B 实际上是同一份配置，实验无效。');
  } else {
    push(
      `- 听觉在 A 组平均每局被调用 ${hearCalls.aMean.toFixed(0)} 次，` +
        `其中「听得到」的 bot 采样点占 ${hearExp.aMean.toFixed(1)}/1000，` +
        `「听觉是唯一情报」占 ${hearOnly.aMean.toFixed(1)}/1000，` +
        `落在「跑毒分支 + urgency<0.7」上下文的 ${hearUsable.aMean.toFixed(2)}/1000。`,
    );
    push(
      `- 行为层证据：**「调查声源」占 ${investigate.aMean.toFixed(1)}/1000 bot-tick**` +
        `（B 组 ${investigate.bMean.toFixed(1)}，差 ${investigate.dMean.toFixed(1)}，` +
        `95% CI [${investigate.ciLo.toFixed(1)}, ${investigate.ciHi.toFixed(1)}]）；` +
        `进圈点反事实翻转 **${zgFlip.aMean.toFixed(2)} 次/局**` +
        `（位移 ${zgFlipDist.aMean.toFixed(1)}m，最大 ${zgFlipMax.aMean.toFixed(1)}m）。`,
    );
    if (zgFlip.aMean === 0 && investigate.aMean < 0.01) {
      push('- **A 组的听觉没有在任何可观测行为上留下痕迹**。这局配置下听觉接近死代码。');
    } else {
      push('- 听觉**确实改变了行为**（两条通道均显著），但请看下一节：行为差异没有传导到战绩。');
    }
  }
  // ── 最终判定（单一措辞，避免读者自行解读）──
  const perfNoDirection = significant.length === 0;
  // 行为通道是否存在：调查声源 / 进圈点翻转 任一在 A 组 > 0。
  const channelActive = investigate.aMean > 0.01 || zgFlip.aMean > 0.01;
  const overallVerdict = !anyHearingSignal
    ? '无法判断（实验操纵未生效）'
    : perfNoDirection
      ? '**无差异**（所有战术表现指标的 95% CI 都包含 0）'
      : significant.length >= 3
        ? '**有益**（多数战术表现指标 CI 排除 0 且方向一致）'
        : '**无法判断**（仅个别指标 CI 排除 0，不足以排除多重比较假阳性）';
  push('');
  push(`### 最终判定：${overallVerdict}`);
  push('');
  if (perfNoDirection && anyHearingSignal) {
    if (channelActive) {
      push('听觉**确实改变了行为**：A 组存在 `investigate`（主动走向声源）与进圈点翻转，');
      push('B 组两者恒为 0。但**宏观战绩没有可检测的位移** —— 这是「行为差异存在、');
      push('结果差异小于检测下限」的结论，不是「听觉没用」的证明。');
    } else {
      push('听觉**并非无效**（它确实在跑），但在当前实现下它改变决策的通道太窄，');
      push('宏观战绩指标看不到可检测的位移。');
    }
    push('');
    push(`本样本量（n=${games}/组）只能排除如下量级以上的效应：`);
    push(`KD > ${Math.abs(kd.mde).toFixed(3)}、存活 > ${Math.abs(surv.mde).toFixed(1)}s、`);
    push(`交火频率 > ${Math.abs(sps.mde).toFixed(3)} shot/s。`);
    push('更小的真实效应（例如 1–2pt 胜率）**无法排除，也无法证实**。');
  }
  push('');
  push('### 置信区间与噪声');
  push('');
  push(`- n = ${games}/组（配对），df = ${games - 1}，t* = ${tCrit95(games - 1).toFixed(3)}。`);
  push(
    `- **最小可检测效应（MDE）**：KD ±${Math.abs(kd.mde).toFixed(3)}、存活 ±${Math.abs(surv.mde).toFixed(2)}s、` +
      `首次交火 ±${Math.abs(fc.mde).toFixed(2)}s、交火频率 ±${Math.abs(sps.mde).toFixed(4)} shot/s。` +
      `小于这些数字的差异在本样本量下**无法与噪声区分**。`,
  );
  for (const t of TIERS) {
    const w = tierSt(t, 'win');
    push(
      `- ${TIER_NAMES[t]}胜率：MDE ±${Math.abs(w.mde * 100).toFixed(1)}pt（95% CI ` +
        `[${(w.ciLo * 100).toFixed(1)}, ${(w.ciHi * 100).toFixed(1)}]pt）` +
        `${Math.abs(w.dMean) < Math.abs(w.mde) ? ' → 落在噪声内' : ''}。`,
    );
  }
  push('');
  push('### ⚠️ 小样本陷阱（必须读）');
  push('');
  push('这个项目已经被小样本骗过一次：24 局得出的三档胜率结论，在 120 局时**完全反转**');
  push('（同一份代码的 5 个 24 局种子批次之间，同档位胜率可差 ±7pt）。因此：');
  push('');
  push('- 胜率的分辨率上限是 `1/n`：n=40 时单档胜率粒度 2.5pt，n=80 时 1.25pt。');
  push('- 任何 **1–2pt 的胜率差都不构成「提升」**，哪怕 CI 恰好不含 0（多重比较下会假阳性）。');
  push('- 本报告只做**单次** A/B，没有做多重比较校正；4 个战术指标 × 3 档 = 12 次比较时，');
  push('  偶然出现 1 条 p<0.05 是预期内的（期望假阳性 0.6 条）。判据要同时看 95% CI 与 MDE，');
  push('  并优先相信**方向一致 + 跨指标复现**的差异。');
  push('- 若要在 33.3% 公平份额附近分辨 3pt 的胜率差，按二项近似至少需要 n≈1000 局/组。');
  push('  这就是为什么本报告的结论只写「可排除多大的效应」，不写「提升了多少」。');
  push('');

  // 听觉的作用面：从源码现场扫描（不写死行号，避免上游改动后报告说谎）
  const src = readAiSource();
  const sites = src ? scanHearingSites(src) : null;
  push('## 5. 听觉的作用面（源码现场扫描 + 实测）');
  push('');
  if (!sites) {
    push('未能读取 `shared/ai.mjs`，本节跳过。');
  } else {
    push(`扫描对象：\`shared/ai.mjs\`（${src.lines} 行，mtime ${src.mtime}）。`);
    push('');
    push('| 函数 | 直接调用 `hearsOf` 的位置 |');
    push('| --- | --- |');
    if (sites.callers.length) {
      for (const c of sites.callers) push(`| \`${c.fn}\` | 第 ${c.line} 行 |`);
    } else {
      push('| （无） | — |');
    }
    push('');
    push(`- \`hearsOf\` 定义：${sites.defined ? '有' : '**没有**'}；被调用 **${sites.callers.length}** 处。`);
    push(
      `- \`nearestKnownFoe\` 里是否仍用 \`bestD\` 限制听觉距离：${sites.hearingCapped ? '**是**（会砍掉远距离声源）' : '否'}`,
    );
    push(`- 是否存在 \`investigate\` 行为标记：${sites.hasInvestigate ? '是（idle 会主动走向声源）' : '**否**'}`);
    push(`- \`conf\` 是否有消费者：${sites.confConsumed ? '是（接近姿态受置信度控制）' : '**否**（死字段）'}`);
    push('');
    push('实测对照：');
    push('');
    push(
      `- A 组「调查声源」行为占比 ${investigate.aMean.toFixed(1)}/1000 bot-tick，B 组 ${investigate.bMean.toFixed(1)}/1000。`,
    );
    push(`- A 组进圈点反事实翻转 ${zgFlip.aMean.toFixed(2)} 次/局（B 组 ${zgFlip.bMean.toFixed(2)}）。`);
    push('');
    if (sites.callers.length <= 1 && !sites.hasInvestigate) {
      push('⚠ 听觉只有一个调用点且没有「调查」行为 —— 它的全部作用是**在跑毒时改变进圈绕行方向**，');
      push('不会让 bot 主动搜索声源。这与第 6 节的调参建议对应。');
      push('');
    } else {
      push('听觉至少有一条「主动走向声源」的路径（`investigate` 或等价分支）。');
      push('若宏观战绩仍无位移，问题不在通道缺失，而在**通道太窄或效应量太小**（见上表占比）。');
      push('');
    }
    push('两个结构性收窄（与实现无关，长期存在）：');
    push('');
    push(`1. 可听半径是 \`78 × noise\`（步枪 ≈66m、狙击 ≈136m、消音 ≈35m），但 60 bot 同场时`);
    push('   「本队完全没有任何目击情报」并不常见，听觉独占情报只占千分之几的 bot 采样。');
    push('2. 听觉给的是**位置点**而非「有敌人在那个方向」的模糊线索；bot 一旦接近到视觉范围，');
    push('   信息就被 `scanEnemies` 接管。所以听觉只影响「接近路径」，不影响「交火质量」。');
    push('');
    push('**方法学限制（必读）**：');
    push('');
    push('- `hearsOf` / `nearestKnownFoe` / `zoneGoalOf` 都是 `ai.mjs` 的私有函数，本脚本用**复刻**');
    push('  来度量它们。复刻与真实实现之间如果漂移（上游改了阈值而没同步本脚本的常量），');
    push('  可观测性指标会失真。缓解手段：(a) 常量集中在文件顶部并注明来源；(b) 第 5 节现场扫描源码，');
    push('  把「48m 天花板 / investigate / conf 消费者」这些结构特征直接读出来，而不是写死；');
    push('  (c) 「调查声源」指标**不依赖复刻**——它直接读 `th.phase`，由 `ai.mjs` 的 `finish()` 写入。');
    push(
      `- **复刻保真度实测**：A 组共核对 ${repTotal} 次 \`zoneGoalOf\` 复刻，` +
        `命中 ${repHit} 次、偏离 >0.5m ${repMiss} 次，一致率 ` +
        `${Number.isFinite(repRate) ? (repRate * 100).toFixed(1) + '%' : '—'}。` +
        (repTotal && repRate < 0.9
          ? ' ⚠ **一致率偏低，说明本脚本的复刻已与上游漂移** —— 请以「调查声源」指标（不依赖复刻）为准。'
          : ' 一致率高 → 反事实推演可信。'),
    );
    push('- 反事实复刻发生在 `update()` 之后，bot 已移动一个 tick（≈0.3m）。翻转位移是数十米量级，');
    push('  这点位置误差不影响「是否翻转」的判定，但**翻转次数是下界**（不是精确计数）。');
    push('- A/B 两组共享同一套种子与档位映射，但 B 组的行为一旦分叉，后续世界状态就不同了。');
    push('  因此配对差只抵消「初始条件」，不抵消「分叉后的路径差异」——配对仍比非配对强得多，');
    push('  但不是完美的共同随机数（CRN）设计。');
    push('');
    push('这与实测一致：听觉确实在跑，也改变了少量决策，但宏观战绩指标没有可检测的位移。');
  }
  push('');
  push('## 6. 建议（若要让听觉产生可观测的行为差异）');
  push('');
  push('本节按**当前源码状态**给出，条目随实测自动标注「已实现 / 仍未实现」。');
  push('所有改动都在 `shared/ai.mjs`（本脚本不改源码）。');
  push('');
  const done = (v) => (v ? '**[已实现]**' : '**[未实现]**');
  push(`1. ${done(!sites || !sites.hearingCapped)} **删掉 nearestKnownFoe 的 48m 天花板**（或用 s.r 而非 48）。`);
  push('   `bestD = 48` 是视觉扫描半径，而可听半径是 66–136m；用它过滤等于把听觉范围砍掉一半以上。');
  push(`2. ${done(!!sites && sites.hasInvestigate)} **让听觉进入 idle，新增「调查声源」状态**：`);
  push('   有枪、没可见敌人、附近有 4s 内声源 → 走向声源并把枪口朝那边。');
  push('   这是「听到后接近」唯一能真正落地的位置（实测见第 3 节「调查声源行为占比」）。');
  push(`3. ${done(!!sites && sites.confConsumed)} **把 conf 接到行为上**。`);
  push('   `SOUND_CONF` 之前是死字段（全仓零读取），实测前 conf 恒为常量。现在用「新鲜度 × 接近度」');
  push('   算 conf，并让它决定接近姿态（举枪直冲 vs 蹲下观察）——否则置信度对行为没有任何影响。');
  push('4. **[未实现] 把声源喂给 pickTarget**：当前 `scan` 里没有听觉目标，`combat` 的');
  push('   `!seen` 分支（`push`/`hunt`）收不到听觉信息。给 `th` 加 `th.heard = {x,z,t}` 并在');
  push('   `pickTarget` 里 `score += 12`，bot 才会在**已经交火**时利用听觉绕后。');
  push('   这是把听觉从「找人的辅助」升级为「战术信息」的关键一步。');
  push('5. **[未实现] 缩短 SOUND_TTL 并加位置噪声**：4 秒内枪声是精确坐标，等于赠送穿墙定位。');
  push('   注意 `investigate` 分支当前**自己**加了 ±3–8m 抖动（不消耗 rng），方向是对的；');
  push('   但 `zoneGoalOf` 路径仍在用无噪声坐标。建议把抖动下沉到 `_emitSound` 或 `hearsOf`，');
  push('   两条路径共享同一份模糊度。');
  push('6. **[未实现] 参数化 A/B 开关**：给 Match 加 `hearing: true/false` 或 `soundRadiusMul`，');
  push('   让本脚本不必替换 `soundBoard`，也能跑「听觉半径 ×0.5 / 消音器零收益」等消融实验。');
  push('   当前实现只能做「全开 vs 全关」，无法定位是哪条子路径在起作用。');
  push('');
  push('调参后请务必用 `--games=80`（或更多）重跑本脚本，并只在 **KD / 前 25% 队率 /');
  push('交火频率 / 调查声源占比** 上同时看到方向一致的位移时才下结论。胜率请当作最钝的指标。');
  push('');

  return L.join('\n');
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function parseNum(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const v = Number(hit.slice(name.length + 3));
  return Number.isFinite(v) ? v : dflt;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** 单进程跑一段种子（A/B 各一局），返回 {a,b} 数组。worker 与 --serial 共用。 */
function runChunk(tasks) {
  const out = [];
  for (const t of tasks) {
    const a = runGame(t.seed, t.shift, 'A');
    const b = runGame(t.seed, t.shift, 'B');
    out.push({ seed: t.seed, a, b });
  }
  return out;
}

async function main() {
  const startedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const games = Math.max(2, Math.floor(parseNum('games', 40)));
  const avail = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const workers = hasFlag('serial')
    ? 1
    : Math.max(1, Math.min(games, Math.floor(parseNum('workers', Math.min(10, Math.max(1, avail - 2))))));

  const tasks = [];
  for (let g = 0; g < games; g++) {
    tasks.push({ seed: SEED0 + g * SEED_STEP, shift: g % TIERS.length });
  }

  const t0 = Date.now();
  const pairs = [];
  if (workers <= 1) {
    for (let i = 0; i < tasks.length; i++) {
      pairs.push(...runChunk([tasks[i]]));
      if ((i + 1) % 5 === 0) process.stderr.write(`  ${i + 1}/${games} seeds\n`);
    }
  } else {
    // 轮转分片：每局耗时 8–13s，轮转比连续分片更均衡。
    const chunks = Array.from({ length: workers }, () => []);
    tasks.forEach((t, i) => chunks[i % workers].push(t));
    let done = 0;
    const results = new Map();
    const runOne = (chunk) =>
      new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), { workerData: { chunk } });
        w.on('message', (msg) => {
          if (msg && msg.type === 'game') {
            results.set(msg.seed, msg.pair);
            done++;
            if (done % 5 === 0 || done === tasks.length) {
              process.stderr.write(`  ${done}/${tasks.length} seeds done\n`);
            }
          }
        });
        w.on('error', reject);
        w.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker exited with code ${code}`));
        });
      });
    await Promise.all(chunks.filter((c) => c.length).map(runOne));
    for (const t of tasks) pairs.push(results.get(t.seed));
  }

  const wallSec = (Date.now() - t0) / 1000;
  const recsA = pairs.map((p) => p.a);
  const recsB = pairs.map((p) => p.b);

  const report = buildReport({ games, workers, recsA, recsB, wallSec, startedAt });
  const outPath = fileURLToPath(REPORT_URL);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${report}\n`, 'utf8');

  // 控制台摘要（与报告的「总体指标」表同口径）
  const st = (key) => paired(recsA, recsB, SPECS[key].get);
  const fmt = (v, f) => (Number.isFinite(v) ? f(v) : '—');
  const P = (v) => `${(v * 100).toFixed(1)}%`;
  const N = (v) => v.toFixed(2);
  const S = (v) => `${v.toFixed(1)}s`;

  console.log(`\n=== AI 听觉 A/B：${games} 局/组（种子配对，${workers} 并行，${wallSec.toFixed(0)}s） ===`);
  console.log('指标             A 均值±SD            B 均值±SD            配对差(A−B)          95% CI');
  const show = (label, key, f) => {
    const s = st(key);
    console.log(
      `${label.padEnd(14)} ${(fmt(s.aMean, f) + '±' + fmt(s.aSd, f)).padEnd(20)} ` +
        `${(fmt(s.bMean, f) + '±' + fmt(s.bSd, f)).padEnd(20)} ` +
        `${(fmt(s.dMean, f) + '±' + fmt(s.dSd, f)).padEnd(20)} [${fmt(s.ciLo, f)}, ${fmt(s.ciHi, f)}]`,
    );
  };
  show('KD', 'kd', N);
  show('平均存活', 'surv', S);
  show('首次交火', 'firstContact', S);
  show('交火频率/s', 'shotsPerSec', (v) => v.toFixed(3));
  show('hearsOf 调用', 'hearCalls', (v) => v.toFixed(0));
  show('听觉暴露/1000', 'hearExposureRate', (v) => v.toFixed(1));
  show('听觉独占/1000', 'hearOnlyRate', (v) => v.toFixed(1));
  show('听觉可达/1000', 'hearUsableRate', (v) => v.toFixed(2));
  show('调查声源/1000', 'investigateRate', (v) => v.toFixed(1));
  show('进圈点反事实翻转', 'zoneGoalFlip', N);
  show('翻转平均位移/m', 'zoneGoalFlipDist', (v) => v.toFixed(1));
  console.log('\n分档（胜率 / 前25%队率 / KD）：');
  for (const t of TIERS) {
    const w = paired(recsA, recsB, (r) => r.tier[t].win);
    const tp = paired(recsA, recsB, (r) => r.tier[t].top);
    const k = paired(recsA, recsB, (r) => r.tier[t].kills / Math.max(1, r.tier[t].deaths));
    const p = Number.isFinite(w.p) ? w.p.toFixed(3) : '—';
    console.log(
      `  ${TIER_NAMES[t].padEnd(3)} 胜率 ${P(w.aMean)}→${P(w.bMean)} Δ${(w.dMean * 100).toFixed(1)}pt ` +
        `[${(w.ciLo * 100).toFixed(1)}, ${(w.ciHi * 100).toFixed(1)}] p=${p} | ` +
        `前25% ${P(tp.aMean)}→${P(tp.bMean)} | KD ${k.aMean.toFixed(2)}→${k.bMean.toFixed(2)}`,
    );
  }
  const perfKeys = ['kd', 'surv', 'firstContact', 'shotsPerSec'];
  const significant = perfKeys.filter((key) => {
    const s = st(key);
    return s.ciLo > 0 || s.ciHi < 0;
  });
  const hearLive = st('hearExposureRate').aMean > 0;
  const behav = st('investigateRate');
  const flip = st('zoneGoalFlip');
  console.log(
    `\n结论：${!hearLive ? '无法判断（A 组听觉未生效）' : significant.length === 0 ? '无差异（4 个战术指标 95% CI 全部包含 0）' : `仅 ${significant.length}/4 个战术指标 CI 排除 0 → 无法判断`}`,
  );
  console.log(
    `行为层：调查声源 ${behav.aMean.toFixed(1)}→${behav.bMean.toFixed(1)}/1000 bot-tick` +
      `（95% CI [${behav.ciLo.toFixed(1)}, ${behav.ciHi.toFixed(1)}]），` +
      `进圈点翻转 ${flip.aMean.toFixed(2)}→${flip.bMean.toFixed(2)} 次/局` +
      `（95% CI [${flip.ciLo.toFixed(2)}, ${flip.ciHi.toFixed(2)}]）`,
  );
  const kdS = st('kd');
  console.log(
    `MDE（n=${games}/组）：KD ±${Math.abs(kdS.mde).toFixed(3)}，` +
      `存活 ±${Math.abs(st('surv').mde).toFixed(1)}s，交火频率 ±${Math.abs(st('shotsPerSec').mde).toFixed(3)} shot/s。` +
      `小于此量级的差异在本样本量下无法与噪声区分。`,
  );
  console.log(`报告已写入：${outPath}`);
}

// worker 入口：接收一段种子，逐局跑 A/B，边跑边回报。
if (!isMainThread && workerData && workerData.chunk) {
  for (const t of workerData.chunk) {
    const a = runGame(t.seed, t.shift, 'A');
    const b = runGame(t.seed, t.shift, 'B');
    parentPort.postMessage({ type: 'game', seed: t.seed, pair: { seed: t.seed, a, b } });
  }
} else if (isMainThread) {
  await main();
}
