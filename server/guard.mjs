// 雾岛突围 / MIST ISLE 1.0 — 服务端防护层（owner: netserver · server/guard.mjs）
// 职责：Origin 校验、双档令牌桶限流、input 侧反作弊（射速 / 瞬移）、以及全部硬阈值常量。
// 注意：本文件只读取 simulation 暴露的公开字段，绝不修改 shared/**。
import { performance } from 'node:perf_hooks';
import { effectiveWeapon } from '../shared/simulation.mjs';
import { MOVE } from '../shared/rules.mjs';

export const LIMITS = {
  // 令牌桶：输入档更宽松（客户端 25Hz 输入 + 抖动余量），控制档更严格。
  input: { capacity: 60, refill: 45, sustainDrops: 600, windowMs: 10000 },
  control: { capacity: 45, refill: 24 },
  maxPayload: 8192,             // ws maxPayload：超过即协议层拒绝（1009）
  violations: 3,                // 控制消息违规 3 次踢出
  maxBuffer: 512 * 1024,        // 背压阈值：socket 缓冲超过 512KB 暂停快照
  slowMs: 5000,                 // 连续 5 秒超限才断开
  pingMs: 10000,                // 每 10 秒 ws.ping()
  pongTimeoutMs: 30000,         // 30 秒无 pong / 无任何消息断开
  reconnectMs: 20000,           // 断线保留席位 20 秒
  maxTeleport: 12,              // 单 tick 位移上限（米）
  fireTolerance: 0.85,          // 允许快于武器 interval 的 15%
  fireSamples: 10,              // 最近 10 次开火时间戳
  minFireGapMs: 25,             // 25Hz 客户端理论间隔 40ms，25ms 内多次开火必属异常
  maxFirePerTick: 8,            // 单 tick 内 fire 请求上限（正常 ≤2）
  fireViolations: 3,            // 射速违规 3 次踢出
  spectatorLimit: 8,
  maxRooms: 12,
  maxConnectionsPerIp: 8,
  // ── 服务端权威输入校验（反作弊）─────────────────────────────────────────
  inputWindowMs: 1000,          // 输入速率窗口：1 秒滑动窗口
  inputPerWindow: 120,          // 单窗口上限（正常客户端 25Hz，留 4 倍余量）
  inputWindowStrikes: 3,        // 连续 3 个窗口超限 → 断开（1008）
  seqRegressions: 20,           // 同一连接内 seq 回退次数上限（重放/伪造）
  // ── 动作限速（契约 §4：chat 80 字 / 2 条每秒）──────────────────────────
  chatPerSec: 2,
  chatMaxChars: 80,
  dropvotePerSec: 5,
  dropvoteWindowMs: 1000,
  pingFlagCooldownMs: 1200,     // 输入里的标记（ping）冷却，与 Match 的 pingCd 对齐
  // ── 房间级异常保护 ──────────────────────────────────────────────────────
  matchDropMs: 90000,           // 对局中断线超过 90s 才真正移出 Match
  // ── HTTP 加固 ──────────────────────────────────────────────────────────
  maxUrlBytes: 2048,            // 请求 URL 上限（超出 414）
};

/**
 * 输入速率滑动窗口。
 *
 * 每个到达的 input 消息都记一笔（在令牌桶之前）：令牌桶决定「处理还是丢弃」，
 * 窗口统计的是「客户端到底发了多少」，否则攻击者只要被令牌桶丢掉就不会被计数。
 * 超限的窗口最多记一次违规；相邻违规间隔不超过 2 个窗口算「连续」，
 * 连续达到 strikes 次返回 'kick'。
 */
export function createInputWindow() {
  return { times: [], strikes: 0, violations: 0, lastViolationAt: 0, kicked: false };
}

export function trackInputRate(win, now, cfg) {
  const windowMs = Number(cfg?.windowMs) > 0 ? cfg.windowMs : LIMITS.inputWindowMs;
  const max = Number(cfg?.max) > 0 ? cfg.max : LIMITS.inputPerWindow;
  const strikes = Number(cfg?.strikes) > 0 ? cfg.strikes : LIMITS.inputWindowStrikes;
  // 已经判过 kick 的连接不再重复计数：断线是异步的，close 前还会到几条消息，
  // 重复返回 kick 会让调用方重复 close / 重复累加计数。
  if (win.kicked) return null;
  const times = win.times;
  let drop = 0;
  while (drop < times.length && now - times[drop] >= windowMs) drop++;
  if (drop) times.splice(0, drop);
  times.push(now);
  // 内存上限：超限窗口只保留最新的 2×max 条就够判「仍在超限」，
  // 否则 1 秒 10 万条的洪泛会把时间戳数组撑成内存放大器。
  if (times.length > max * 2) times.splice(0, times.length - max * 2);
  if (times.length <= max) return null;
  // 同一窗口内只记一次：否则 1 秒 200 条会变成 200 次违规，连续窗口语义被冲垮。
  if (win.lastViolationAt && now - win.lastViolationAt < windowMs) return null;
  win.violations++;
  win.strikes = win.lastViolationAt && now - win.lastViolationAt <= windowMs * 2 ? win.strikes + 1 : 1;
  win.lastViolationAt = now;
  if (win.strikes < strikes) return 'violation';
  win.kicked = true;
  return 'kick';
}

/**
 * 挂件上的滑动窗口配额（dropvote 这类「静默丢弃」的动作限速用）。
 * holder[key] 存时间戳数组；窗口内已有 max 次则拒绝。返回是否放行。
 */
export function takeWindowQuota(holder, key, now, windowMs, max) {
  const ms = Number(windowMs) > 0 ? windowMs : LIMITS.dropvoteWindowMs;
  const limit = Number(max) > 0 ? max : LIMITS.dropvotePerSec;
  const times = holder[key] || (holder[key] = []);
  let drop = 0;
  while (drop < times.length && now - times[drop] >= ms) drop++;
  if (drop) times.splice(0, drop);
  if (times.length >= limit) return false;
  times.push(now);
  return true;
}

/**
 * 输入序号校验：同一连接内 seq 只允许单调递增。
 * 回退次数超过上限说明客户端在重放/伪造输入（正常客户端 seq 严格递增）。
 * 返回 null / 'violation' / 'kick'。
 */
export function trackSeq(client, seq, limit = LIMITS.seqRegressions) {
  const value = Number(seq);
  if (!Number.isFinite(value) || value <= 0) return null;
  const last = Number(client.lastInputSeq) || 0;
  if (last && value < last) {
    client.seqRegressions = (client.seqRegressions || 0) + 1;
    const max = Number.isFinite(limit) ? limit : LIMITS.seqRegressions;
    return client.seqRegressions > max ? 'kick' : 'violation';
  }
  if (value > last) client.lastInputSeq = value;
  return null;
}

/** Origin 白名单：'*' / 数组 / 逗号分隔串；未配置时放行。 */
export function originAllowed(origins, origin) {
  const list = Array.isArray(origins) ? origins : String(origins || '').split(',');
  const clean = list.map((s) => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean);
  if (!clean.length || clean.includes('*')) return true;
  if (!origin) return true; // 原生客户端 / 探活请求不带 Origin
  const value = String(origin).trim().replace(/\/+$/, '');
  return clean.includes(value);
}

/** 令牌桶：按 refill/秒 连续补充，最多 capacity；桶按"每类配额"计时。 */
export function makeBucket(capacity, refill, now = performance.now()) {
  return { tokens: capacity, capacity, refill, at: now, idleAt: now, dropped: 0 };
}

/**
 * 取令牌。空闲超过 1 秒视为"不忙"：先恢复 1 秒的量，再按突发处理。
 * 这样 200 条/秒的洪泛仍会瞬间耗尽容量被丢弃，而 25Hz 的稳定输入不会误伤。
 */
export function takeToken(bucket, cost = 1, now = performance.now()) {
  const seconds = Math.max(0, now - bucket.at) / 1000;
  if (seconds > 0) {
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + seconds * bucket.refill);
    bucket.at = now;
  }
  if (bucket.tokens < cost) { bucket.dropped++; return false; }
  bucket.tokens -= cost;
  return true;
}

export function createLimits() {
  return {
    input: makeBucket(LIMITS.input.capacity, LIMITS.input.refill),
    control: makeBucket(LIMITS.control.capacity, LIMITS.control.refill),
  };
}

/** 记录一次违规；返回是否应当踢出。 */
export function registerViolation(client, reason) {
  client.violations = (client.violations || 0) + 1;
  client.lastViolation = reason;
  return client.violations >= LIMITS.violations;
}

// ── 反作弊：射速校验 ─────────────────────────────────────────────────────────
export function createAntiCheat() {
  return {
    fireAt: [], violations: 0, shots: 0, dropped: 0,
    burstTick: -1, burstCount: 0,
    anchor: null, suspect: 0, teleports: 0,
  };
}

/** 当前武器理论射击间隔（秒）。缺省 0.35s，避免脏数据把阈值算成 0。 */
export function weaponInterval(player) {
  const weapon = effectiveWeapon(player);
  const interval = Number(weapon?.interval);
  return Number.isFinite(interval) && interval > 0 ? interval : 0.35;
}

/**
 * 开火校验：最近 10 次开火时间戳中若有 ≥3 组间隔小于 min(interval×0.85, 25ms)，
 * 或单 tick fire 请求数 > 8，则丢弃这次开火并计一次违规。
 * 正常客户端 25Hz 发送、30Hz 推演，间隔 ≥40ms 且单 tick 最多 2 次，不会误伤。
 */
export function reviewFire(cheat, player, input, tick, now = performance.now()) {
  if (!input || input.fire !== true) return { input, violation: false, reason: null };
  if (cheat.burstTick !== tick) { cheat.burstTick = tick; cheat.burstCount = 0; }
  cheat.burstCount++;
  cheat.fireAt.push(now);
  if (cheat.fireAt.length > LIMITS.fireSamples) cheat.fireAt.shift();
  const intervalMs = weaponInterval(player) * 1000 * LIMITS.fireTolerance;
  const window = Math.min(intervalMs, LIMITS.minFireGapMs);
  let fast = 0;
  for (let i = 1; i < cheat.fireAt.length; i++) if (cheat.fireAt[i] - cheat.fireAt[i - 1] < window) fast++;
  const burst = cheat.burstCount > LIMITS.maxFirePerTick;
  if (burst || fast >= 3) {
    cheat.violations++;
    cheat.dropped++;
    return { input: { ...input, fire: false }, violation: true, reason: burst ? 'fire-burst' : 'fire-rate' };
  }
  cheat.shots++;
  return { input, violation: false, reason: null };
}

// ── 反作弊：瞬移校验 ─────────────────────────────────────────────────────────
/**
 * 单 tick 位移 > 12m 且不是闪避/载具 → 连续 2 个 tick 仍超限则拉回锚点。
 * 只应在 match.phase === 'live' 时调用；死亡/载具/闪避会重置锚点。
 */
export function reviewMove(cheat, player) {
  if (!player || player.bot || !player.alive || player.state === 'dead') {
    cheat.anchor = null; cheat.suspect = 0;
    return false;
  }
  if (player.car != null || player.dodgeTime > 0) {
    cheat.anchor = { x: player.x, z: player.z }; cheat.suspect = 0;
    return false;
  }
  if (!cheat.anchor) { cheat.anchor = { x: player.x, z: player.z }; return false; }
  const dx = player.x - cheat.anchor.x;
  const dz = player.z - cheat.anchor.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= LIMITS.maxTeleport) {
    if (distance > 0.05) cheat.anchor = { x: player.x, z: player.z };
    cheat.suspect = 0;
    return false;
  }
  cheat.suspect++;
  if (cheat.suspect < 2) return false;
  cheat.suspect = 0;
  cheat.teleports++;
  player.x = cheat.anchor.x;
  player.z = cheat.anchor.z;
  if (player.input) { player.input.mx = 0; player.input.mz = 0; }
  return true;
}

/** 位移合法性参考值（供调试/日志）：冲刺速度 ×1.25，约 11.1 m/s。 */
export const LEGAL_SPEED = MOVE.sprint * 1.25;
