// 雾岛突围 / MIST ISLE — Bot 战术 AI（owner: botai · shared/ai.mjs）
//
// 目标：让 bot 表现得像真人——落地找枪、搜物资、保血、跑毒、拉队友、开车转移、
// 投掷物压制、掩体进退、侧翼包抄、被打会缩、被闪会乱、horde 里会守家买升级。
// 而不是直线冲人然后站着对枪。
//
// 契约：simulation.mjs 每个 tick 对每个 bot 调 `thinkBot(match, bot, dt)`，
//       AI 只能写 `bot.botInput`（一帧输入），其余状态改动全部由 Match 负责。
//
// 纪律：
//   · 禁止 Math.random / Date.now / DOM，全部随机性走 per-bot PRNG（不消耗 match.rng，
//     否则会影响战利品与缩圈序列，破坏确定性）。
//   · 每帧预算：目标重选按 retarget 缩放 0.16–0.95s 一次；A* 只在换点或卡住时跑，
//     且受全局限流令牌桶约束；反应类（开火/走位/躲闪）每帧都做。
//   · 所有世界查询都要容错（world 可能缺方法、match 可能没 zone）。

import { getWeapon, applyAttachmentMods, AMMO_TYPES } from './data/weapons.mjs';
import { ARMORS, BACKPACKS } from './data/items.mjs';
import { MOVE, REVIVE_RANGE, DIFFICULTY } from './rules.mjs';

// 掉落判据用的小查找表（模块级、只读，避免在热路径里反复查对象）。
const AMMO_CAP = {};
for (const [id, def] of Object.entries(AMMO_TYPES)) AMMO_CAP[id] = def.cap;
const BACKPACK_CAP = {};
const BACKPACK_TIER = {};
for (const [id, def] of Object.entries(BACKPACKS)) {
  BACKPACK_CAP[id] = def.ammoCap;
  BACKPACK_TIER[id] = def.tier || 1;
}
const ARMOR_TIER = {};
for (const [id, def] of Object.entries(ARMORS)) ARMOR_TIER[id] = def.tier;

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Math.hypot 在 V8 里非常慢（走 C++ 且要做溢出检查）；这里距离全部 < 1000m，
// 直接 sqrt(dx²+dz²) 数值上完全安全，实测快 8–10 倍。
const dist = (ax, az, bx, bz) => {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
};
const wrap = (a) => {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
};
const lerpAngle = (a, b, t) => a + wrap(b - a) * clamp(t, 0, 1);

/** 稳定字符串哈希（不依赖 match.rng）。 */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function thinkOf(bot) {
  let th = bot.think;
  if (!th || typeof th !== 'object') th = bot.think = {};
  if (!th.phase) th.phase = 'loot';
  if (th.t === undefined) {
    th.t = 0;
    // 首次重评估相位：**强制 0，不要改成 id 哈希错峰。**
    //
    // 动机是合理的：所有 bot 的 nextThink 都是 0 时，第 1 帧 64 个 bot 会同时
    // scanEnemies + A* 寻路，之后周期又都落在 0.16–0.95s 的相近区间里长期同相
    // —— 实测 AI 占 tick CPU 的 94.2%，同相确实会放大峰值。
    // 试过 `(hash32(id) % 97) / 97 * 0.9` 摊平，性能上成立（CPU/tick 2.81 → 1.81ms），
    // 但它**改变了 AI 的战术表现**：实测新兵 KD 0.20→0.35、前 25% 队率 5%→10%、
    // 老兵胜率 66.7%→83.3%、精锐 33.3%→16.7%。原因是错峰改变了「谁先发现谁」，
    // 而三档平衡是 120 局实测标定出来的（见 rules.mjs 的 DIFFICULTY 注释）。
    //
    // 结论：性能优化不能以改变玩法行为为代价。要压峰值请从「同队共享寻路结果」
    // 或「减少每帧全量遍历」入手，不要动决策时序。
    th.nextThink = 0;
    th.target = null;
    th.targetId = null;
    th.lastSeen = -99;
    th.strafe = 1;
    th.strafeT = 0;
    th.path = null;
    th.pathI = 0;
    th.goal = null;
    th.goalKind = null;
    th.burst = 0;
    th.burstGap = 0;
    th.stuckT = 0;
    th.stuckCheck = { x: bot.x, z: bot.z };
    th.stuckN = 0;
    th.lootTimer = 0;
    th.errT = 0;
    th.errA = 0;
    th.huntT = 0;
    th.cover = null;
    th.coverT = 0;
    th.healCd = 0;
    th.nadeCd = 0;
    th.vehicleT = 0;
    th.callT = 0;
    th.carG = null;         // 正在前往的载具 id（承诺几秒，防止开车/跑步反复横跳）
    th.carT = 0;
    th.zoneG = null;        // 进圈目标点缓存（1.2s 一换）
    th.zoneGT = 0;
    th.reviveHold = null;   // 已拍板「去救」的队友（3s 内不改主意）
    th.reviveHoldT = 0;
  }
  return th;
}

/** 每个 bot 自己的确定性随机流，存在 bot.think.rng 上。 */
function rngOf(bot) {
  const th = thinkOf(bot);
  if (!th.rng) {
    let s = (hash32(String(bot.id)) ^ 0x9e3779b9) >>> 0;
    th.rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  return th.rng;
}

/** bot 当前武器的有效数值（与 Match.effectiveWeapon 同逻辑，避免循环 import）。 */
function weaponOf(bot) {
  const list = bot.loadout;
  if (!Array.isArray(list)) return null;
  const slot = list[bot.slot | 0] || list[0];
  if (!slot || !slot.type) return null;
  if (!slot._eff) {
    const base = getWeapon(slot.type);
    if (!base) return null;
    slot._eff = applyAttachmentMods(base, Array.isArray(slot.attachments) ? slot.attachments : []);
  }
  return slot._eff;
}

function reserveAmmo(bot, weapon) {
  if (!weapon || !bot.mags) return 0;
  return bot.mags[weapon.ammo] | 0;
}

/** 该 bot 是否「有作战能力」（有枪且有子弹）。 */
function armed(bot) {
  const w = weaponOf(bot);
  if (!w) return false;
  const slot = bot.loadout[bot.slot | 0] || bot.loadout[0];
  return !!slot && (slot.ammo > 0 || reserveAmmo(bot, w) > 0);
}

/** 一把枪的「现在值多少分」——只用于槽位比较，不做战斗运算。 */
function scoreSlot(bot, slot) {
  if (!slot || !slot.type) return -1e9;
  const w = slot._eff || applyAttachmentMods(getWeapon(slot.type), Array.isArray(slot.attachments) ? slot.attachments : []);
  slot._eff = w;
  const hasAmmo = (slot.ammo | 0) > 0 || reserveAmmo(bot, w) > 0;
  if (!hasAmmo) return -1e8;
  const dps = ((w.damage || 0) * (w.pellets || 1)) / Math.max(0.05, w.interval || 0.2);
  const mag = (slot.ammo | 0) + (bot.mags?.[w.ammo] | 0);
  // 空仓的枪再强也没用；留一点权重给弹匣深度，避免抱着一把空狙。
  return dps * Math.min(1, 0.35 + mag / 24) + (w.tier || 1) * 3;
}

/**
 * 换到更好的那把枪。
 * 基线里 40 个 bot 整局只打出 p9 的子弹——因为出生就送一把 P9 在 slot 0，
 * 而捡到的新枪只会进 slot 1，AI 从来没有主动换过槽位，等于全场用手枪打步枪。
 */
function pickBetterSlot(match, bot, th) {
  const list = bot.loadout;
  if (!Array.isArray(list) || !list[0] || !list[1]) return;
  const cur = bot.slot | 0;
  const curS = scoreSlot(bot, list[cur]);
  const otherS = scoreSlot(bot, list[cur ? 0 : 1]);
  if (otherS > curS + 14) {
    th.swapWant = cur ? 0 : 1;
  }
}

/** 全局共享：寻路令牌 + 各队伍目击情报（按队隔离，避免隔墙读心）。 */
function shared(match) {
  let s = match.aiShared;
  if (!s) s = match.aiShared = { teams: new Map(), lastContact: -999 };
  return s;
}

/** 本队共享目击表（bot.team → Map(enemyId → 最后目击)）。 */
function teamSeen(match, bot) {
  const s = shared(match);
  let m = s.teams.get(bot.team);
  if (!m) { m = new Map(); s.teams.set(bot.team, m); }
  return m;
}

// 目击信息的存活时间（秒）。超过这个时长的目击已经毫无战术价值：
// 玩家 8 秒能跑出 50m，旧坐标只会让 bot 往空气里冲。
//
// 为什么必须清理：`teamSeen` 是 `Map<team, Map<enemyId, 目击>>`，旧实现只有 set 没有 delete ——
// 一局 16 队 × 64 敌人最多 1024 条，且 `nearestKnownFoe` 每 0.16–0.95s 遍历全表。
// 这是 soak 报告里「heap 随模拟时长线性增长（1.86 MiB/分钟）」的一个真实来源。
const SEEN_TTL = 8;

/** 记录一次目击（同队 bot 共享最近目击位置）。 */
function markSeen(match, bot, enemy) {
  const now = match.time || 0;
  const seen = teamSeen(match, bot);
  seen.set(enemy.id, { id: enemy.id, x: enemy.x, z: enemy.z, t: now, team: enemy.team });
  shared(match).lastContact = now;
  // 惰性清理：只在表明显变大时才扫一遍，避免每次目击都 O(n)。
  if (seen.size > 24) {
    for (const [id, info] of seen) {
      if (now - (info.t || 0) > SEEN_TTL) seen.delete(id);
    }
  }
}

/** 敌人最后被本队目击的位置（没有情报、或情报已过期就用本体兜底）。 */
function lastKnownOf(match, bot, enemy) {
  const info = teamSeen(match, bot).get(enemy.id);
  if (!info) return enemy;
  // 过期目击不可信：目标 8 秒能跑出 50m，用过时坐标会让 bot 追空气。
  if ((match.time || 0) - (info.t || 0) > SEEN_TTL) return enemy;
  return info;
}

/**
 * 听觉：返回「最近一次落在可听半径内的声响」，或 null。
 *
 * 设计取舍：
 *   · 只听「最近一次」而不是累加历史——声音只用来给出一个大概方向，
 *     精确追踪必须靠视线；否则 bot 会隔着三栋楼精确索敌，比外挂还准。
 *   · 置信度（conf）固定 0.55：够触发「朝那边看/摸过去」，不够直接开枪。
 *   · 只对**敌对队伍**生效；同队不互相听（他们本来就共享 teamSeen）。
 *   · 声音表由 simulation.mjs 的 _emitSound 写入，每 4 秒判定过期。
 */
const SOUND_TTL = 4;
const SOUND_CONF = 0.55;
/**
 * 听觉置信度（0–1）：越近越可信，越旧越不可信。
 *
 * 行为侧消费者：`idle` 的「调查声源」分支用 `conf > 0.45` 决定「直接举枪走过去」
 * 还是「先蹲一下观察」。没有这个消费者的时候 SOUND_CONF 是个死字段
 * （A/B 报告 artifacts/hearing-ab.md 第 6 节点명过）。
 */
function soundConfidence(heard, now) {
  if (!heard) return 0;
  const age = Math.max(0, (now || 0) - (heard.t || 0));
  const fresh = Math.max(0, 1 - age / SOUND_TTL);        // 4 秒线性衰减到 0
  const near = Math.max(0, 1 - heard.d / Math.max(1, heard.r || 70)); // 半径边缘衰减到 0
  return SOUND_CONF * (0.35 + 0.65 * fresh) * (0.5 + 0.5 * near);
}
function hearsOf(match, bot) {
  const board = match.soundBoard;
  if (!board || !bot) return null;
  const now = match.time || 0;
  // 敌方队伍的发声 + 无归属的世界音（手雷/载具），取更近/更新的那一个。
  let best = null;
  for (const [key, s] of board) {
    if (!s || now - (s.t || 0) > SOUND_TTL) continue;
    if (key === (bot.team | 0)) continue;              // 自家枪声不触发
    if (s.by && s.by === bot.id) continue;             // 自己开的枪
    const d = dist(bot.x, bot.z, s.x, s.z);
    if (d > (s.r || 0)) continue;                      // 半径外听不到
    // 同一时刻多条时：距离近的优先，其次时间新的
    if (!best || d < best.d || (d === best.d && (s.t || 0) > (best.t || 0))) {
      best = { x: s.x, z: s.z, t: s.t || 0, d, r: s.r || 70, kind: s.kind };
    }
  }
  // conf 在返回前算好，供行为侧（idle 的调查分支）决定接近姿态。
  if (best) best.conf = soundConfidence(best, now);
  return best;
}

/** 目标周围 5.5m 内的敌人聚集数（含目标自己）。≥2 说明扎堆，值得丢燃烧瓶。 */
function clusterCount(th, enemy) {
  const scan = th.scan;
  if (!Array.isArray(scan)) return 1;
  let n = 0;
  for (let i = 0; i < scan.length; i++) {
    const e = scan[i];
    if (!e || !e.p || !e.p.alive) continue;
    if (dist(e.p.x, e.p.z, enemy.x, enemy.z) < 5.5) n++;
  }
  return n;
}

/** 烟雾是否挡住两点连线。 */
function smokeBlocked(match, ax, az, bx, bz) {
  const list = match.smokes;
  if (!list || !list.length) return false;
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || s.ttl <= 0) continue;
    let t = ((s.x - ax) * dx + (s.z - az) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (dist(ax + dx * t, az + dz * t, s.x, s.z) < (s.r || 7) * 0.92) return true;
  }
  return false;
}

/** 视线判定：地形遮挡 + 烟雾。
 *  cost = 'shot'（弹道级，world.clearLine，约 8µs）| 'fast'（导航网格，约 0.1µs）。
 *  为什么两种：world.clearLine 是「子弹碰撞盒级」精度，比真实弹道（_traceShot 的
 *  垂直距离 ≤0.7m）严格 3–7 倍——大量 bot 明明打得中却判定为「没视野」而白跑。
 *  探路用 fast（足够便宜，可每帧调），真正扣扳机前的确认必须用 shot。 */
function canSee(match, bot, enemy, range, cost = 'shot') {
  if (!enemy || !enemy.alive) return false;
  const d = dist(bot.x, bot.z, enemy.x, enemy.z);
  if (d > (range || 74)) return false;
  if (smokeBlocked(match, bot.x, bot.z, enemy.x, enemy.z)) return false;
  const nav = match.world && match.world.nav;
  if (cost === 'fast' && nav && typeof nav.pathClear === 'function') {
    return nav.pathClear(bot.x, bot.z, enemy.x, enemy.z);
  }
  const world = match.world;
  if (world && typeof world.clearLine === 'function') {
    if (!world.clearLine({ x: bot.x, z: bot.z }, { x: enemy.x, z: enemy.z })) return false;
  }
  return true;
}

/** 读难度参数（DIFFICULTY 表，缺失时退回 veteran）。 */
function diffOf(bot) {
  return DIFFICULTY[bot.difficulty] || DIFFICULTY.veteran || {
    reaction: 0.34, aimError: 0.1, aimSpeed: 7.5, burst: 0.7, retarget: 0.65,
    coverUse: 0.55, throwChance: 0.28, useVehicle: 0.5, reviveChance: 0.6,
    lootHaste: 1, aggression: 0.85,
  };
}

// ── 寻路 ────────────────────────────────────────────────────────────────────
// 4m 网格上的 A*（8 邻接 + 拐角剪枝），节点上限 900，单次最多 12ms。
// 只在「换目标点 / 卡住 / 路径走完」时重算，绝不每帧跑。

const NAV_MAX_NODES = 700;
const PATH_TOKENS = 14;      // 令牌桶容量（每 tick 最多 14 个 bot 抢到 A*）
const PATH_REFILL = 30;      // 每秒补充的寻路次数（全 match 共享）

const scratch = {
  g: null,
  f: null,
  from: null,
  closed: null,
  open: [],
  stamp: null,
  gen: 1,
};

/**
 * 全局限流：所有 bot 共享每秒 40 次 A*。
 * 超预算时退回「直线 + 沿墙滑」，绝不排队等待（否则单 tick 会超 33ms 预算）。
 */
function takePathToken(match) {
  const s = shared(match);
  const now = match.time || 0;
  if (s.tokens === undefined) { s.tokens = PATH_TOKENS; s.lastT = now; }
  const dt = Math.max(0, now - s.lastT);
  s.lastT = now;
  s.tokens = Math.min(PATH_TOKENS, s.tokens + dt * PATH_REFILL);
  if (s.tokens < 1) return false;
  s.tokens -= 1;
  return true;
}

function navOf(world) {
  const nav = world && world.nav;
  if (!nav || !nav.walkable || !nav.cols || !nav.rows) return null;
  return nav;
}

function ensureScratch(size) {
  if (scratch.g && scratch.g.length >= size) return;
  scratch.g = new Int32Array(size);
  scratch.f = new Float32Array(size);
  scratch.from = new Int32Array(size);
  scratch.closed = new Uint8Array(size);
  scratch.stamp = new Int32Array(size);
}

/** 在 nav 上找一条从 (ax,az) 到 (bx,bz) 的路；返回世界坐标点数组（不含起点）。 */
function findPath(world, ax, az, bx, bz, limit = NAV_MAX_NODES) {
  const nav = navOf(world);
  if (!nav) return null;
  const cols = nav.cols;
  const rows = nav.rows;
  const cell = nav.cell;
  const startX = nav.colOf(ax);
  const startZ = nav.rowOf(az);
  let goalX = nav.colOf(bx);
  let goalZ = nav.rowOf(bz);
  const inb = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;
  if (!inb(startX, startZ)) return null;
  if (!inb(goalX, goalZ)) return null;
  // 终点不可走时吸附到最近可走格
  if (nav.walkable[goalZ * cols + goalX] !== 1) {
    const near = nav.nearestWalkable ? nav.nearestWalkable(bx, bz, 20) : null;
    if (!near) return null;
    goalX = nav.colOf(near.x);
    goalZ = nav.rowOf(near.z);
    if (!inb(goalX, goalZ)) return null;
  }
  const start = startZ * cols + startX;
  const goal = goalZ * cols + goalX;
  if (start === goal) return [{ x: bx, z: bz }];

  const size = cols * rows;
  ensureScratch(size);
  const gen = ++scratch.gen;
  const g = scratch.g;
  const f = scratch.f;
  const from = scratch.from;
  const closed = scratch.closed;
  const stamp = scratch.stamp;
  const walk = nav.walkable;
  const open = scratch.open;
  open.length = 0;

  const hx = (c, r) => {
    const dx = Math.abs(c - goalX);
    const dz = Math.abs(r - goalZ);
    return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
  };
  stamp[start] = gen;
  g[start] = 0;
  f[start] = hx(startX, startZ);
  from[start] = -1;
  closed[start] = 0;
  open.push(start);

  let visited = 0;
  let bestIdx = start;
  let bestH = f[start];
  let found = false;
  const neighbors = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

  while (open.length && visited < limit) {
    // 线性扫最小 f（节点上限 900，比堆更快且无 GC 压力）
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (stamp[cur] !== gen || closed[cur]) continue;
    closed[cur] = 1;
    visited++;
    if (cur === goal) { found = true; break; }
    const cc = cur % cols;
    const cr = (cur - cc) / cols;
    const hc = hx(cc, cr);
    if (hc < bestH) { bestH = hc; bestIdx = cur; }
    for (let n = 0; n < 8; n++) {
      const nc = cc + neighbors[n][0];
      const nr = cr + neighbors[n][1];
      if (!inb(nc, nr)) continue;
      const ni = nr * cols + nc;
      if (walk[ni] !== 1) continue;
      if (closed[ni] && stamp[ni] === gen) continue;
      // 斜向不允许穿角
      if (neighbors[n][0] && neighbors[n][1]) {
        if (walk[cr * cols + nc] !== 1 || walk[nr * cols + cc] !== 1) continue;
      }
      const ng = g[cur] + neighbors[n][2];
      if (stamp[ni] !== gen) {
        stamp[ni] = gen;
        g[ni] = ng;
        f[ni] = ng + hx(nc, nr);
        from[ni] = cur;
        closed[ni] = 0;
        open.push(ni);
      } else if (ng < g[ni]) {
        g[ni] = ng;
        f[ni] = ng + hx(nc, nr);
        from[ni] = cur;
        if (closed[ni]) closed[ni] = 0;
        open.push(ni);
      }
    }
  }

  const endIdx = found ? goal : bestIdx;
  if (endIdx === start) return null;
  const pts = [];
  let idx = endIdx;
  let guard = 0;
  while (idx >= 0 && idx !== start && guard++ < size) {
    const c = idx % cols;
    const r = (idx - c) / cols;
    pts.push({ x: nav.minX + (c + 0.5) * cell, z: nav.minZ + (r + 0.5) * cell });
    idx = from[idx];
  }
  if (!pts.length) return null;
  pts.reverse();
  pts[pts.length - 1] = { x: bx, z: bz };
  return simplifyPath(world, ax, az, pts);
}

/** 拉直路径：能直连的中间点全部删掉，避免 8 邻接的锯齿。 */
function simplifyPath(world, ax, az, pts) {
  const nav = navOf(world);
  const clear = (x0, z0, x1, z1) => (
    nav && nav.pathClear ? nav.pathClear(x0, z0, x1, z1) : true
  );
  const out = [];
  let cx = ax;
  let cz = az;
  let i = 0;
  // 每次最多往前看 12 个点（O(n·12)，不会因为长路径爆掉单 tick 预算）
  while (i < pts.length) {
    const far = Math.min(pts.length - 1, i + 12);
    let pick = i;
    for (let j = far; j > i; j--) {
      if (clear(cx, cz, pts[j].x, pts[j].z)) { pick = j; break; }
    }
    out.push(pts[pick]);
    cx = pts[pick].x;
    cz = pts[pick].z;
    i = pick + 1;
  }
  return out;
}

/** 让 bot 朝点移动；返回剩下距离。世界缺失时直线走。 */
function moveToward(bot, x, z, out, sprint, world) {
  const dx = x - bot.x;
  const dz = z - bot.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return 0;
  let mx = dx / len;
  let mz = dz / len;
  // 贴墙时尝试沿墙滑一下，避免顶着障碍不动
  if (world && typeof world.blocked === 'function') {
    const step = 0.9;
    if (world.blocked(bot.x + mx * step, bot.z + mz * step, MOVE.radius)) {
      const perp = (wrap(Math.atan2(mx, mz) + Math.PI / 2));
      const s1x = Math.sin(perp);
      const s1z = Math.cos(perp);
      if (!world.blocked(bot.x + s1x * step, bot.z + s1z * step, MOVE.radius)) {
        mx = s1x; mz = s1z;
      } else if (!world.blocked(bot.x - s1x * step, bot.z - s1z * step, MOVE.radius)) {
        mx = -s1x; mz = -s1z;
      }
    }
  }
  out.mx = mx;
  out.mz = mz;
  out.sprint = !!sprint;
  return len;
}

/** 一帧空输入（形状与 simulation.emptyInput 一致，此处本地构造避免循环 import）。 */
function blankInput() {
  return {
    mx: 0, mz: 0, aim: 0, fire: false, reload: false, heal: false, interact: false, swap: false,
    ping: false, sprint: false, crouch: false, dodge: false, throwable: null, useItem: null,
    pingKind: 'move', slot: -1, revive: false, buy: null, upgrade: null, ready: false, seq: 0,
  };
}

/** 队友（含自己）中最近的倒地队友。 */
function downedMate(match, bot) {
  const list = match.players;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p === bot || !p.alive || !p.downed) continue;
    if (p.team !== bot.team) continue;
    const d = dist(bot.x, bot.z, p.x, p.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? { p: best, d: bestD } : null;
}

/**
 * 这件战利品「捡了会不会真的进包」——必须逐条镜像 simulation._pickup 的判据。
 * 为什么需要：`_interact` 会从数组头开始找第一个 1.8m 内的物品并调用 _pickup，
 * 一旦失败就 return，**不会继续找下一件**。于是 bot 站在一堆已满的弹药/同档护甲上
 * 会无限空按（实测 4321 次 interact 只有 118 次成功，成功率 3%）。
 * 这里让 AI 只走向「确定能捡起来」的那一件；至于捡完脚边其他件，交给顺序兜住。
 */
function lootUseful(bot, l, canShoot, hasTwo) {
  if (!l || l.taken) return false;
  switch (l.kind) {
    case 'weapon':
      if (canShoot && hasTwo) return false;
      return !(bot.loadout && bot.loadout[0] && bot.loadout[1]);
    case 'ammo': {
      const cap = Math.round((AMMO_CAP[l.item] || 120) * (BACKPACK_CAP[bot.backpack] || 1));
      return (bot.mags?.[l.item] || 0) < cap;
    }
    case 'armor': {
      const tier = ARMOR_TIER[l.item] || 0;
      return tier > (bot.armorTier || 0);
    }
    case 'backpack':
      return (BACKPACK_TIER[l.item] || 0) > (BACKPACK_TIER[bot.backpack] || 0);
    case 'consumable':
    case 'throwable':
      return true;
    case 'attachment':
      return false; // 配件槽位判定复杂，交给贴脸时的顺带拾取
    default:
      return false;
  }
}

/** 最近的可拾取物品（地上的战利品）。带 0.55s 缓存 + 无 sqrt 粗筛。 */
function nearestLoot(match, bot, th, range = 34) {
  const list = match.loot;
  if (!list || !list.length) return null;
  const now = match.time || 0;
  const cached = th.lootCache;
  if (cached && now - cached.t < 0.55 && cached.range >= range && !(cached.l && cached.l.taken)) {
    return cached.l ? { l: cached.l, d: cached.d } : null;
  }
  const hasTwo = !!(bot.loadout && bot.loadout[0] && bot.loadout[1]);
  const canShoot = armed(bot);
  let best = null;
  let bestD = range;
  let bestD2 = range * range;
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    if (!l || l.taken) continue;
    const dx = bot.x - l.x;
    const ax = dx < 0 ? -dx : dx;
    if (ax >= bestD) continue;
    const dz = bot.z - l.z;
    const az = dz < 0 ? -dz : dz;
    if (az >= bestD) continue;
    const d2 = dx * dx + dz * dz;
    if (d2 >= bestD2) continue;
    if (!lootUseful(bot, l, canShoot, hasTwo)) continue;
    bestD2 = d2;
    bestD = Math.sqrt(d2);
    best = l;
  }
  th.lootCache = { t: now, range, l: best, d: bestD };
  return best ? { l: best, d: bestD } : null;
}

/** 附近的可用载具。 */
function nearestCar(match, bot, range = 16) {
  const list = match.cars;
  if (!list || !list.length) return null;
  let best = null;
  let bestD = range;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || c.dead || c.hp <= 0) continue;
    if (c.driver) continue;
    const d = dist(bot.x, bot.z, c.x, c.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? { c: best, d: bestD } : null;
}

/** 圈外/圈边缘判定。返回 null 表示暂时安全。
 *  除了当前圈，还看「即将生效」的目标圈：圈正在缩或马上要缩时，
 *  站在旧圈里但目标圈外的人也要提前跑毒，否则决赛圈边缘会被静默吞掉。 */
function zonePush(match, bot) {
  const z = match.zone;
  if (!z || !(z.r > 0)) return null;
  const d = dist(bot.x, bot.z, z.x, z.z);
  const safe = z.r - 8;
  if (d > safe) {
    return { z, d, tgt: z.target || null, urgency: clamp((d - safe) / Math.max(6, z.r * 0.5), 0, 1) };
  }
  const tgt = z.target;
  if (tgt && tgt.r > 0 && z.phase >= 0 && (z.closing || z.nextIn < 16)) {
    const td = dist(bot.x, bot.z, tgt.x, tgt.z);
    if (td > tgt.r + 4) {
      const timePress = z.closing ? 0.9 : clamp(1 - z.nextIn / 16, 0.2, 0.8);
      return { z, d, tgt, urgency: clamp((td - tgt.r) / Math.max(10, z.r * 0.4), 0, 1) * timePress };
    }
  }
  return null;
}

/** 已知的最近敌人：本帧扫描优先，其次本队共享目击（8s 内，按队隔离不隔墙读心）。 */
function nearestKnownFoe(match, bot, th) {
  let best = null;
  let bestD = 48;
  const scan = th.scan;
  if (Array.isArray(scan)) {
    for (let i = 0; i < scan.length; i++) {
      const e = scan[i];
      if (!e || !e.p || !e.p.alive) continue;
      if (e.d < bestD) { bestD = e.d; best = e.p; }
    }
  }
  if (best) return best;
  const now = match.time || 0;
  for (const info of teamSeen(match, bot).values()) {
    if (now - info.t > SEEN_TTL) continue;
    const d = dist(bot.x, bot.z, info.x, info.z);
    if (d < bestD) { bestD = d; best = info; }
  }
  // 听觉兜底：没看到人但听到枪声时，把声源当作「大概在那」。
  //
  // ⚠ 这里**不能**用 bestD 作为听觉的上限。bestD 初始值是 48m（视觉扫描半径），
  // 而可听半径是 78 × noise（步枪 66m、狙击 136m、消音 35m）——用 48m 过滤等于
  // 把听觉范围砍掉一半以上。A/B 实测（artifacts/hearing-ab.md）显示修前听觉
  // 每局只影响进圈点 4.75 次，宏观战绩无可检测差异，主因就是这条天花板。
  // 听觉自己的半径已经在 hearsOf 里按 s.r 判过，这里不再叠加距离限制。
  if (!best) {
    const heard = hearsOf(match, bot);
    if (heard) { bestD = heard.d; best = heard; }
  }
  return best;
}

/** 进圈目标点：落在目标圈 55% 半径处（低血 38% 更靠中心）。
 *  不急的时候（urgency < 0.7）绕到背敌一侧进场；低血时偏转方向由 id 哈希
 *  决定——确定性，不消耗 PRNG。 */
function zoneGoalOf(match, bot, th, zp) {
  const z = zp.z;
  const tgt = (zp.tgt && zp.tgt.r > 0) ? zp.tgt : { x: z.x, z: z.z, r: z.r };
  const inR = tgt.r * (bot.hp < 45 ? 0.38 : 0.55);
  const aBot = Math.atan2(bot.x - tgt.x, bot.z - tgt.z);
  let a = aBot;
  if (zp.urgency < 0.7) {
    const foe = nearestKnownFoe(match, bot, th);
    if (foe) {
      const aFoe = Math.atan2(foe.x - tgt.x, foe.z - tgt.z);
      const side = wrap(aFoe - aBot) >= 0 ? -1 : 1;
      a = aBot + side * Math.PI * 0.55;
    } else if (bot.hp < 45) {
      a = aBot + ((hash32(String(bot.id)) % 2) ? 1 : -1) * Math.PI * 0.3;
    }
  }
  return { x: tgt.x + Math.sin(a) * inR, z: tgt.z + Math.cos(a) * inR };
}

/** 每 bot 固定的包抄扇区（±1.4 rad，由 id 哈希决定）——确定性，不消耗 PRNG。 */
function flankSectorOf(bot) {
  return (((hash32(String(bot.id)) >>> 3) % 9) - 4) * 0.35;
}

/** 同队且正在交战同一目标的存活队友数（人类玩家没有 think，天然被排除）。 */
function matesEngaging(match, bot, enemy) {
  let n = 0;
  const list = match.players;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p === bot || !p.alive || p.downed || p.team !== bot.team) continue;
    const t = p.think;
    if (t && t.targetId === enemy.id) n++;
  }
  return n;
}

/** 包抄接近点：有队友在打同一目标时，每 bot 从固定扇区绕侧翼，避免全队
 *  从同一个方向排队送头。没有协击或距离太近时原样返回敌人位置。 */
function flankPoint(match, bot, th, enemy, d) {
  if (d < 9) return enemy;
  const mates = matesEngaging(match, bot, enemy);
  if (!mates) return enemy;
  const aTo = Math.atan2(enemy.x - bot.x, enemy.z - bot.z);
  const sector = flankSectorOf(bot) * (mates > 1 ? 1 : 0.8);
  const a = aTo + Math.PI + sector;
  const r = clamp(d * 0.45, 4.5, 9);
  return { x: enemy.x + Math.sin(a) * r, z: enemy.z + Math.cos(a) * r };
}

/** 圈外/远距离时的载具转移。返回 true 表示本帧决定去开车。
 *  一旦拍板就承诺 th.carT 秒（th.carG），期间不再重新抽签；
 *  车报废/被占/消失才立刻放掉承诺。 */
function tryVehicleTransfer(match, bot, th, out, diff, rng, zp, urgent) {
  if (th.carT > 0 && th.carG) {
    const car = match._carById ? match._carById(th.carG) : null;
    if (car && !car.dead && !car.driver) {
      const d = dist(bot.x, bot.z, car.x, car.z);
      if (d < 3.6) { out.interact = true; return true; } // 贴脸直接上（_interact 的上车半径 3.8）
      followPoint(match, bot, th, car.x, car.z, true, out);
      return true;
    }
    th.carG = null;
    th.carT = 0;
  }
  if (!zp) return false;
  const far = zp.d > 42 || zp.urgency > 0.5;
  if (!far) return false;
  if (!urgent && bot.stamina < 35) return false; // 还有力气就自己跑，车留给真正需要的人
  if (rng() >= (diff.useVehicle || 0.5)) return false;
  const car = nearestCar(match, bot, urgent ? 26 : 20);
  if (!car) return false;
  // 绕路成本检查：经车中转的总路程 ≲ 直奔圈心的 1.6 倍 + 12m 才划算
  const zc = (zp.tgt && zp.tgt.r > 0) ? zp.tgt : zp.z;
  const direct = dist(bot.x, bot.z, zc.x, zc.z);
  const viaCar = car.d + dist(car.c.x, car.c.z, zc.x, zc.z);
  if (viaCar > direct * 1.6 + 12) return false;
  th.carG = car.c.id;
  th.carT = 4 + rng() * 3;
  followPoint(match, bot, th, car.c.x, car.c.z, true, out);
  return true;
}

// ── 感知 ────────────────────────────────────────────────────────────────────
// 每 0.2–0.6s 重扫一次敌人；可见者立即记录，不可见者用「最近目击」推断（听声/队友情报）。

function scanEnemies(match, bot) {
  const list = match.players;
  const out = [];
  if (!Array.isArray(list)) return out;
  // 第一步：按距离粗筛（纯算术，很便宜）
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !p.alive || p.team === bot.team) continue;
    const d = dist(bot.x, bot.z, p.x, p.z);
    if (d > 82) continue;
    out.push({ p, d, visible: false });
  }
  if (!out.length) return out;
  out.sort((a, b) => a.d - b.d);
  // 第二步：分层判定，兼顾「准」和「便宜」。
  //   · 导航网格版（0.1µs）比真实弹道严格 1.6 倍，只配做预筛；
  //   · 弹道版 clearLine（8.6µs）与 _traceShot 同精度，只给最近的 3 个用。
  //
  // 注：我试过把「push 全部 + sort」换成「固定 8 槽有界插入 + 零分配」，动机是
  // 这个函数被 64 bot × 每 0.2–0.6s 各调一次。实测反而更慢（CPU/tick 1.81→3.05ms）：
  // V8 对「小数组 push + 原生 sort」有极强优化，而手写插入循环 + `slice(0,n)` 每次
  // 仍要分配结果数组，反而把优势让掉了。**不要重做这个"优化"。**
  const probes = Math.min(out.length, 8);
  const exactN = Math.min(probes, 3);
  for (let i = 0; i < probes; i++) {
    const e = out[i];
    if (canSee(match, bot, e.p, 76, 'fast')) { e.visible = true; markSeen(match, bot, e.p); }
  }
  for (let i = 0; i < exactN; i++) {
    const e = out[i];
    const exact = canSee(match, bot, e.p, 76, 'shot');
    e.exact = exact;
    e.visible = exact;
    if (exact) markSeen(match, bot, e.p);
  }
  return out;
}
/** 选目标：可见者优先，其次看威胁（正瞄我 / 快倒 / 近距离）。 */
function pickTarget(bot, scanned, th, now) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < scanned.length; i++) {
    const e = scanned[i];
    const p = e.p;
    let score = 0;
    if (e.visible) score += 60;
    else {
      // 没视野：只有近距离或刚被打过才追
      const age = now - th.lastSeen;
      if (e.d > 34 && age > 2.5) continue;
      score += 10;
    }
    score += Math.max(0, 60 - e.d);
    if (th.targetId === p.id) score += 18;
    if (p.downed) score -= 26;
    const hp = p.hp + (p.armor || 0) * 0.5;
    score += (100 - clamp(hp, 0, 100)) * 0.35;
    // 他正对着我 → 威胁更大
    const toMe = Math.atan2(bot.x - p.x, bot.z - p.z);
    if (Math.abs(wrap(toMe - (p.angle || 0))) < 0.6) score += 14;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

/** 找掩体点：敌人视线被挡住、离自己 2–9m、可站立的点。
 *  评分时用 wallDistance 度量「掩体贴得多紧」：掩体点到敌人的墙距远小于
 *  实际距离，说明墙就在眼前——贴墙的点比虚掩的点更硬。 */
function findCover(match, bot, enemy) {
  const world = match.world;
  if (!world || typeof world.blocked !== 'function') return null;
  const hasWall = typeof world.wallDistance === 'function';
  const baseA = Math.atan2(bot.x - enemy.x, bot.z - enemy.z);
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 16; i++) {
    const a = baseA + (i / 16) * TAU;
    const r = 2.2 + (i % 4) * 2.3;
    const x = bot.x + Math.sin(a) * r;
    const z = bot.z + Math.cos(a) * r;
    if (world.blocked(x, z, MOVE.radius + 0.1)) continue;
    if (typeof world.clearLine === 'function' && world.clearLine({ x, z }, { x: enemy.x, z: enemy.z })) continue;
    let tight = 0;
    if (hasWall) {
      const dE = dist(x, z, enemy.x, enemy.z) || 1;
      // ⚠ 不要「为了省开销」把 range 截成 min(dE, 10)。
      // 我试过：2000 个真实场景采样里 1075 个评分发生变化，且**全部偏高**
      //（截断后 wallDistance 在 10m 内找不到墙就返回 10，于是「墙在 12m 外」的
      // 候选点也被算成贴墙紧）。方向单一偏差 = 系统性偏好远墙掩体，不是优化。
      const wd = world.wallDistance(x, z, (enemy.x - x) / dE, (enemy.z - z) / dE, dE);
      tight = clamp(1 - wd / dE, 0, 1) * 1.6;
    }
    // 优先近的 + 贴墙的掩体
    const score = -dist(bot.x, bot.z, x, z) + tight + (i % 2) * 0.4;
    if (score > bestScore) { bestScore = score; best = { x, z }; }
  }
  return best;
}

/** 找（或复用缓存）掩体点。th.cover 带 1.6–2.8s 有效期，走没了才重找；
 *  已到达的掩体会一直蹲到过期（配合残血静止治疗）。 */
function ensureCover(match, bot, th, enemy, rng) {
  if (th.cover && th.coverT > 0 && dist(bot.x, bot.z, th.cover.x, th.cover.z) >= 1.2) return th.cover;
  th.cover = findCover(match, bot, enemy);
  th.coverT = 1.6 + rng() * 1.2;
  return th.cover;
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

export function thinkBot(match, bot, dt) {
  if (!bot || !bot.alive) return;
  if (bot.downed) {
    // 倒地 bot 按住「救援」键。两个作用：一是呼救表现；
    // 二是绕开 _handleActions 里 `else p.reviveProgress = 0` 的误伤——
    // _bots 对倒地 bot 也会调 _handleActions，空输入会让队友的救援进度
    // 每帧被清零，bot 队伍永远救不起来人（按住 revive 走 _tryRevive 的
    // p.downed 早退分支，无副作用）。simulation.mjs 只读，这里 AI 层自救。
    bot.botInput = { revive: true };
    return;
  }
  const th = thinkOf(bot);
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 30;
  th.t += step;
  const now = match.time || 0;
  const diff = diffOf(bot);
  const rng = rngOf(bot);
  const out = blankInput();

  // 载具：司机开车转移、乘客朝敌人开火；到点/车快报废就下车。
  if (bot.car != null) {
    driveVehicle(match, bot, th, out, diff, rng, now, step);
    bot.botInput = out;
    return;
  }

  // 计时器
  th.healCd = Math.max(0, th.healCd - step);
  th.nadeCd = Math.max(0, th.nadeCd - step);
  th.vehicleT = Math.max(0, th.vehicleT - step);
  th.coverT = Math.max(0, th.coverT - step);
  th.callT = Math.max(0, th.callT - step);
  th.carT = Math.max(0, th.carT - step);
  th.zoneGT = Math.max(0, th.zoneGT - step);

  // 卡住检测：每 0.9s 看位移，连续 2 次 < 0.7m 视为卡住
  th.stuckT += step;
  if (th.stuckT >= 0.9) {
    th.stuckT = 0;
    const moved = dist(bot.x, bot.z, th.stuckCheck.x, th.stuckCheck.z);
    th.stuckCheck = { x: bot.x, z: bot.z };
    if (moved < 0.7 && (out.mx || th.path)) th.stuckN = Math.min(3, th.stuckN + 1);
    else th.stuckN = Math.max(0, th.stuckN - 1);
    if (th.stuckN >= 2) { th.path = null; th.goal = null; }
  }

  // 每 0.16–0.95s 重新评估（retarget 是「重估周期」系数：精锐 0.45 扫场更勤，
  // 新兵 0.9 反应更钝；开火/走位等反应类决策仍然每帧都做）
  if (th.t >= th.nextThink) {
    const period = (diff.reaction + rng() * 0.22) * Math.max(0.5, (diff.retarget || 0.65) / 0.65);
    th.nextThink = th.t + clamp(period, 0.16, 0.95);
    const scanned = scanEnemies(match, bot);
    const picked = pickTarget(bot, scanned, th, now);
    th.scan = scanned;
    th.enemyInfo = picked;
    if (picked) {
      if (th.targetId !== picked.p.id) th.targetId = picked.p.id;
      th.target = picked.p;
      if (picked.visible) th.lastSeen = now;
    } else {
      th.targetId = null;
      th.target = null;
    }
  }

  const enemy = th.enemyInfo && th.enemyInfo.p && th.enemyInfo.p.alive ? th.enemyInfo.p : null;
  const enemyDist = enemy ? dist(bot.x, bot.z, enemy.x, enemy.z) : Infinity;
  // 跑毒压力： healer/救人/交战分支都要用它做优先级仲裁
  const zp = zonePush(match, bot);

  // ── 0. 换到更好的枪 ──────────────────────────────────────────────────────
  // 必须放在最前面：换枪本身会解除「空仓无法开火」的死锁，
  // 而且 _swapSlot 会把 fireCd 顶到 0.35s，越晚换越亏。
  if (th.t >= (th.swapT || 0)) {
    th.swapT = th.t + 0.9;
    pickBetterSlot(match, bot, th);
  }
  if (th.swapWant != null && th.swapWant !== (bot.slot | 0)) {
    out.slot = th.swapWant;
    th.swapWant = null;
    bot.botInput = out;
    return;
  }

  // ── 0. 正在用药：原地站桩（移动会打断治疗），只保持瞄准 ──────────────────
  if (bot.healTime > 0 || bot.reloadTime > 0 && bot.healKind) {
    const e0 = th.enemyInfo && th.enemyInfo.p && th.enemyInfo.p.alive ? th.enemyInfo.p : null;
    if (e0) out.aim = Math.atan2(e0.x - bot.x, e0.z - bot.z);
    else out.aim = bot.angle;
    bot.botInput = out;
    return;
  }

  // ── 0b. 被闪：乱走乱转，不开枪 ──────────────────────────────────────────
  if (bot.blind > 0.15) {
    const a = rng() * TAU;
    out.mx = Math.sin(a) * 0.6;
    out.mz = Math.cos(a) * 0.6;
    out.aim = bot.angle + (rng() - 0.5) * 1.2;
    out.crouch = rng() < 0.35;
    bot.botInput = out;
    return;
  }

  // ── 1. 拉队友（优先级仅次于自救）─────────────────────────────────────────
  // 拍板（reviveChance 门控）只在决策时掷一次，拍板后 3s 内不改主意；
  // 真正救人的时候每帧按住 revive（_tryRevive 的硬要求），两者缺一不可。
  // 威胁评估：队友在圈外 → 放弃（救=一起死）；敌人压着尸体 → 先封烟再靠近。
  const mate = downedMate(match, bot);
  if (mate) {
    if (th.reviveId && th.reviveId !== mate.p.id) th.reviveId = null;
    const adjacent = mate.d < 9;
    const mateOutside = zonePush(match, mate.p);
    const enemyOnMate = enemy && enemyDist < 30
      && dist(enemy.x, enemy.z, mate.p.x, mate.p.z) < 22;
    let commit = th.reviveId === mate.p.id;
    if (!commit && !(mateOutside && !adjacent)) {
      if (th.reviveHold === mate.p.id && now < th.reviveHoldT) commit = true;
      else if (mate.d < 26 && (adjacent || !enemy || enemyDist > 20
        || !th.enemyInfo.visible || rng() < diff.reviveChance)) {
        commit = true;
        th.reviveHold = mate.p.id;
        th.reviveHoldT = now + 3;
      }
    }
    if (commit && enemyOnMate && bot.smokes > 0 && th.nadeCd <= 0 && mate.d > 3.5) {
      // 救人前先封烟：烟落在队友和敌人之间，挡住直线火力再靠近
      out.throwable = 'smoke';
      out.mx = 0;
      out.mz = 0;
      out.aim = Math.atan2((mate.p.x + enemy.x) / 2 - bot.x, (mate.p.z + enemy.z) / 2 - bot.z);
      th.nadeCd = 8 + rng() * 4;
      return finish(bot, null, out, 'throw');
    }
    if (commit && mate.d <= REVIVE_RANGE - 0.3) {
      th.reviveId = mate.p.id;
      out.revive = true;
      const fa = enemy ? Math.atan2(enemy.x - bot.x, enemy.z - bot.z) : bot.angle;
      out.aim = fa;
      bot.botInput = out;
      return;
    }
    if (commit && mate.d < 26) {
      th.reviveId = mate.p.id;
      followPoint(match, bot, th, mate.p.x, mate.p.z, true, out);
      return finish(bot, null, out, 'revive');
    }
  } else {
    th.reviveId = null;
    th.reviveHold = null;
  }

  // ── 2. 治疗：血低、脱战或已有掩体 ────────────────────────────────────────
  // 旧版门限 hp<62 且要求完全脱战，实战里几乎永远不成立（本次基线 5 分钟只有 24 次）。
  // 现在：≤76 血或护甲被打光就补；只要「当前看不到我 / 距离够远 / 我正好在掩体后」就敢用。
  const hasMeds = bot.meds > 0 || bot.bandages > 0 || bot.shields > 0;
  if (hasMeds && th.healCd <= 0 && bot.reloadTime <= 0) {
    // 圈外时门槛放宽：毒圈每秒 5–28 点，拖着 80 多血跑毒不如先磕一口再走
    const hurt = bot.hp <= 76 || (zp && bot.hp <= 92)
      || (bot.armor <= 0 && bot.shields > 0 && bot.hp <= 95);
    const safe = !enemy || enemyDist > 18 || !canSee(match, bot, enemy, 60, 'fast');
    if (hurt && safe) {
      // 先打甲片再打血包，血线低优先大药
      out.useItem = bot.hp < 45 && bot.meds > 0 ? 'medkit'
        : bot.shields > 0 && bot.armor < 40 ? 'shield'
          : bot.bandages > 0 ? 'bandage'
            : bot.meds > 0 ? 'medkit'
              : bot.energy > 0 ? 'energy' : null;
      if (out.useItem) {
        th.healCd = 0.9;
        bot.botInput = out;
        return;
      }
    }
  }

  // ── 3. 风暴圈：圈外/即将被吞 → 一切让位给跑毒 ────────────────────────────
  if (zp && !(match.hordeRun || match.mode === 'training')) {
    // 贴脸自卫例外：敌人已经顶到 11m 内还看得见，背身跑毒就是活靶子
    if (enemy && enemyDist < 11 && armed(bot) && bot.hp > 30
      && th.enemyInfo && th.enemyInfo.visible) {
      return combat(match, bot, th, out, enemy, enemyDist, diff, rng, now);
    }
    // 距离远就找空车转移（useVehicle 门控 + 承诺期，防止反复横跳）
    if (tryVehicleTransfer(match, bot, th, out, diff, rng, zp, true)) {
      return finish(bot, null, out, 'vehicle');
    }
    // 进圈点缓存 1.2s：低血/有已知敌人时绕到背敌一侧进场
    if (!th.zoneG || th.zoneGT <= 0 || dist(bot.x, bot.z, th.zoneG.x, th.zoneG.z) < 2.5) {
      th.zoneG = zoneGoalOf(match, bot, th, zp);
      th.zoneGT = 1.2;
    }
    followPoint(match, bot, th, th.zoneG.x, th.zoneG.z, true, out);
    return finish(bot, null, out, 'zone');
  }

  // ── 4. 有敌人：交战 ─────────────────────────────────────────────────────
  if (enemy) return combat(match, bot, th, out, enemy, enemyDist, diff, rng, now);

  // ── 5. 无敌人：补给 / 搜物资 / 载具 / 巡逻 ──────────────────────────────
  return idle(match, bot, th, out, diff, rng, now);
}

/** 收尾：写入 bot.botInput。 */
function finish(bot, moveRes, out, kind) {
  if (kind) {
    const th = thinkOf(bot);
    th.phase = kind;
  }
  bot.botInput = out;
  return moveRes;
}

/** 朝目标点移动（带路径缓存）；把移动量写进 out。 */
function followPoint(match, bot, th, x, z, sprint, out) {
  const world = match.world;
  const need = !th.path || th.pathI >= th.path.length
    || !th.goal || dist(th.goal.x, th.goal.z, x, z) > 4
    || th.stuckN >= 2;
  if (need) {
    th.goal = { x, z };
    // 先试直线：能直走就别浪费 A* 预算
    const nav = navOf(world);
    const straight = nav && typeof nav.pathClear === 'function'
      ? nav.pathClear(bot.x, bot.z, x, z)
      : true;
    if (straight) {
      th.path = [{ x, z }];
    } else if (takePathToken(match)) {
      th.path = findPath(world, bot.x, bot.z, x, z);
    } else {
      th.path = null;
    }
    th.pathI = 0;
    th.stuckN = 0;
    if (!th.path) th.path = [{ x, z }];
  }
  let target = th.path[th.pathI] || { x, z };
  let d = dist(bot.x, bot.z, target.x, target.z);
  // 到达当前路点就看下一个
  let guard = 0;
  while (d < 1.4 && th.pathI < th.path.length - 1 && guard++ < 8) {
    th.pathI++;
    target = th.path[th.pathI];
    d = dist(bot.x, bot.z, target.x, target.z);
  }
  // 卡点自救：贴着当前路点却直线进不去（4m 网格与连续碰撞的精度差会把 bot
  // 憋在凹角里）→ 改瞄「剩余路点里最远一个 nav 直连可达」的；一个都不可达
  // 就丢弃路径下一帧重算。只在临近卡住时才扫，正常走路零开销。
  if (th.stuckN >= 1 && th.pathI < th.path.length - 1) {
    const nav = navOf(world);
    if (nav && typeof nav.pathClear === 'function') {
      let pick = -1;
      const far = Math.min(th.path.length - 1, th.pathI + 6);
      for (let j = far; j > th.pathI; j--) {
        if (nav.pathClear(bot.x, bot.z, th.path[j].x, th.path[j].z)) { pick = j; break; }
      }
      if (pick > th.pathI) {
        th.pathI = pick;
        target = th.path[pick];
        d = dist(bot.x, bot.z, target.x, target.z);
      } else {
        // 全挡：就近挑一个「直连可达、最接近终点」的邻格中心先挪过去。
        // 只要求位置动起来——脱困后 w0 往往就变可达了，比原地顶墙强得多。
        const c0 = nav.colOf(bot.x);
        const r0 = nav.rowOf(bot.z);
        let bx = null;
        let bz = null;
        let bd = Infinity;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dc && !dr) continue;
            const c = c0 + dc;
            const r = r0 + dr;
            if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) continue;
            const ni = r * nav.cols + c;
            if (nav.walkable[ni] !== 1) continue;
            if (nav.steep && nav.steep[ni] === 1) continue;
            const px = nav.minX + (c + 0.5) * nav.cell;
            const pz = nav.minZ + (r + 0.5) * nav.cell;
            if (!nav.pathClear(bot.x, bot.z, px, pz)) continue;
            const dd = dist(px, pz, x, z);
            if (dd < bd) { bd = dd; bx = px; bz = pz; }
          }
        }
        if (bx != null) {
          target = { x: bx, z: bz };
          d = dist(bot.x, bot.z, bx, bz);
        } else {
          th.path = null;
          th.goal = null;
        }
      }
    }
  }
  const left = moveToward(bot, target.x, target.z, out, sprint, world);
  if (left < 1.6) out.interact = true;
  return { d: left };
}

// ── 交战 ────────────────────────────────────────────────────────────────────

function combat(match, bot, th, out, enemy, d, diff, rng, now) {
  const world = match.world;
  const w = weaponOf(bot);
  const slot = bot.loadout[bot.slot | 0] || bot.loadout[0];
  // 视野：默认用认领来的探路结果（快），只有准备扣扳机时才做一次弹道级确认。
  const seen = th.enemyInfo && th.enemyInfo.p === enemy && th.enemyInfo.visible !== false;
  if (seen) th.lastSeen = now;
  const sinceSeen = now - th.lastSeen;
  const dt = 1 / 30;

  // 瞄准：误差每 0.25–0.75s 重掷一次（不逐帧抖动，像真人压枪）。
  // 距离缩放必须开方：角误差 ≈ 落点偏移 / 距离，若按线性缩放，
  // 30m 处 0.1 rad 就是 3m 横向偏移（目标半径只有 0.7m），等于必定脱靶。
  th.errT -= dt;
  if (th.errT <= 0) {
    th.errT = 0.25 + rng() * 0.5;
    const k = d < 12 ? 0.5 : d > 40 ? 1.9 : 1;
    th.errA = (rng() * 2 - 1) * (diff.aimError || 0.1) * k * (0.42 + d * 0.009);
  }
  const baseAngle = Math.atan2(enemy.x - bot.x, enemy.z - bot.z);
  const desired = baseAngle + th.errA;
  const turn = clamp((diff.aimSpeed || 7.5) * 0.09, 0.06, 0.85);
  out.aim = lerpAngle(bot.angle, desired, turn);

  const magazine = slot ? slot.ammo : 0;
  const cap = w ? (w.magazine || 20) : 20;
  const reserve = w ? reserveAmmo(bot, w) : 0;

  // 投掷物：按场景选型——目标蹲掩体拔雷、扎堆丢燃烧、推进前闪光、危险拉烟。
  // 手雷固定飞 ~14m（throwGrenade 的 travel = clamp(墙距-0.6, 2.5, 14)），
  // 所以只在 10–19m 才值得丢，30m 外丢等于给对面送快递。
  if (th.nadeCd <= 0 && d > 9 && d < 34) {
    const roll = rng();
    const tc = diff.throwChance || 0.28;
    // 「蹲掩体」= 正看见他蹲着不动，或刚丢失视野 0.6–4.5s（大概率缩到掩体后了）
    const hiding = (seen && enemy.state === 'crouch' && !enemy.moved)
      || (!seen && sinceSeen > 0.6 && sinceSeen < 4.5);
    const aimAt = seen ? enemy : lastKnownOf(match, bot, enemy);
    const dAim = dist(bot.x, bot.z, aimAt.x, aimAt.z);
    if (bot.grenades > 0 && hiding && dAim > 9.5 && dAim < 19 && roll < tc) {
      out.throwable = 'frag';
      th.nadeCd = 5 + rng() * 3;
    } else if (bot.molotovs > 0 && seen && dAim > 10 && dAim < 16.5
      && clusterCount(th, enemy) >= 2 && roll < tc) {
      out.throwable = 'molotov';
      th.nadeCd = 7 + rng() * 4;
    } else if (bot.flashes > 0 && seen && dAim > 7 && dAim < 16 && roll < tc * 0.8) {
      out.throwable = 'flash';
      th.nadeCd = 8 + rng() * 4;
    } else if (bot.smokes > 0 && seen && (bot.hp < 55 || bot.reloadTime > 0) && d < 26 && roll < tc) {
      out.throwable = 'smoke';
      th.nadeCd = 9 + rng() * 4;
    }
    if (out.throwable) {
      // 投掷沿 aim 方向飞（移动会改成投移动方向），这一帧定住、准星压到目标上
      out.mx = 0;
      out.mz = 0;
      out.aim = Math.atan2(aimAt.x - bot.x, aimAt.z - bot.z);
      return finish(bot, null, out, 'throw');
    }
  }

  // 换弹：空仓，或残弹且不在贴脸交火
  if (slot && magazine <= 0 && reserve > 0) {
    out.reload = true;
    return finish(bot, null, out, 'reload');
  }
  if (slot && magazine <= Math.max(1, Math.floor(cap * 0.12)) && reserve > 0 && d > 20 && sinceSeen < 1.4) {
    out.reload = true;
    return finish(bot, null, out, 'reload');
  }
  // 彻底没子弹：换副武器 / 捡枪 / 逃
  if (slot && magazine <= 0 && reserve <= 0) {
    const otherIdx = bot.slot ? 0 : 1;
    const other = bot.loadout[otherIdx];
    if (other && other.type && other.ammo > 0) {
      out.slot = otherIdx;
      return finish(bot, null, out, 'swap');
    }
    const loot = nearestLoot(match, bot, th, 20);
    if (loot) {
      followPoint(match, bot, th, loot.l.x, loot.l.z, true, out);
      return finish(bot, null, out, 'loot');
    }
    const away = Math.atan2(bot.x - enemy.x, bot.z - enemy.z);
    moveToward(bot, bot.x + Math.sin(away) * 9, bot.z + Math.cos(away) * 9, out, true, world);
    return finish(bot, null, out, 'flee');
  }

  // 开火判据
  // 「朝向」阈值必须按当时的真实弹道散布算：spread 永远 > 0，所以角度误差不可能归零。
  // 旧版固定 0.17 rad（≈10°）在横向走位时（spread × 1.85）几乎永远不成立，
  // 这就是「有视野却不开枪」的主因之一。
  let spreadNow = w ? (w.spread || 0.03) : 0.03;
  if (bot.moved || out.mx || out.mz) spreadNow *= 1.85;
  if (bot.state === 'crouch') spreadNow *= 0.62;
  const tol = Math.min(0.45, 1.3 * spreadNow + 0.045);
  const facing = seen && Math.abs(wrap(desired - bot.angle)) < tol;
  const range = w ? Math.min(w.range || 60, 70) : 42;
  const canShoot = facing && d <= range && magazine > 0
    && bot.reloadTime <= 0 && bot.healTime <= 0;

  if (canShoot) {
    const burstLen = w && w.auto === false ? 1 : 3 + Math.round((diff.burst || 0.7) * 4);
    if (th.burst <= 0 && th.burstGap <= 0) th.burst = burstLen;
    if (th.burst > 0) {
      out.fire = true;
      th.burst--;
      if (th.burst <= 0) th.burstGap = (w && w.auto === false ? 0.18 : 0.1) + rng() * 0.18;
    } else {
      th.burstGap = Math.max(0, th.burstGap - dt);
    }
  } else {
    th.burst = 0;
    th.burstGap = 0;
    // 视线还在、只是没对准：那就把枪口拧过去，而不是原地站着空有视野。
    if (seen && d <= range) out.aim = lerpAngle(out.aim, baseAngle, 0.55);
  }

  // 走位：先判劣势找掩体，再判优势压制推进，其余按距离拉扯。
  // 「被压制」= 1.2s 内吃过子弹（lastHitAt 由模拟层 damage() 维护）。
  const hpFrac = clamp((bot.hp + (bot.armor || 0) * 0.6) / 130, 0, 1);
  const pressured = now - (bot.lastHitAt || -99) < 1.2;
  const myPow = bot.hp + (bot.armor || 0) * 0.6;
  const foePow = enemy.hp + (enemy.armor || 0) * 0.6 + (enemy.shield || 0) * 0.5;
  const adv = myPow - foePow;
  const hurtBad = hpFrac < 0.34 && (bot.meds > 0 || bot.bandages > 0);
  const wantCover = (!seen && sinceSeen < 2.4) || hpFrac < 0.42
    || (bot.reloadTime > 0 && d < 26) || (pressured && hpFrac < 0.62);
  // 残血撤退治疗：血线危急或（低血+有药+正挨打）时不再抽签，直接找掩体；
  // 蹲进掩体后视野被挡，下一个 think 的治疗分支会自然接手原地用药。
  const mustCover = hpFrac < 0.28 || (hurtBad && pressured);
  if (wantCover && (mustCover || rng() < (diff.coverUse || 0.5))) {
    const cv = ensureCover(match, bot, th, enemy, rng);
    if (cv) {
      moveToward(bot, cv.x, cv.z, out, d > 30, world);
      out.crouch = dist(bot.x, bot.z, cv.x, cv.z) < 2.2;
      return finish(bot, null, out, 'cover');
    }
  }

  if (!seen) {
    th.huntT = Math.max(0, th.huntT - dt);
    if (d < 46 || th.huntT <= 0) {
      th.huntT = 2.2;
      // 包抄：有队友同时交战这个目标 → 每 bot 从固定扇区绕侧翼
      const fp = flankPoint(match, bot, th, enemy, d);
      followPoint(match, bot, th, fp.x, fp.z, d > 18, out);
      out.crouch = d < 26;
      return finish(bot, null, out, 'push');
    }
  }

  th.strafeT -= dt;
  if (th.strafeT <= 0) { th.strafeT = 0.55 + rng() * 0.7; th.strafe = rng() < 0.5 ? -1 : 1; }
  // 优势压制推进：血量/护甲明显占优就向前压，不给对面喘息换弹的时间
  const pushBias = seen && adv > 24 && d > 10 && d < 34
    ? 0.3 + 0.35 * (diff.aggression || 0.8) : 0;
  if (d > 34) {
    const fp = flankPoint(match, bot, th, enemy, d);
    moveToward(bot, fp.x, fp.z, out, bot.stamina > 30, world);
    out.crouch = false;
  } else if (d < 6.5) {
    const back = Math.atan2(bot.x - enemy.x, bot.z - enemy.z);
    out.mx = Math.sin(back) * 0.85 + Math.sin(back + Math.PI / 2) * th.strafe * 0.6;
    out.mz = Math.cos(back) * 0.85 + Math.cos(back + Math.PI / 2) * th.strafe * 0.6;
    if (d < 10 && bot.dodgeCd <= 0 && rng() < 0.2 * (diff.aggression || 0.8)) out.dodge = true;
  } else if (d > 20) {
    out.mx = Math.sin(baseAngle + Math.PI / 2) * th.strafe * 0.85 + Math.sin(baseAngle) * pushBias;
    out.mz = Math.cos(baseAngle + Math.PI / 2) * th.strafe * 0.85 + Math.cos(baseAngle) * pushBias;
    out.crouch = pushBias < 0.01 && th.burstGap > 0 && rng() < 0.45;
  } else {
    out.mx = Math.sin(baseAngle + Math.PI / 2) * th.strafe + Math.sin(baseAngle) * pushBias;
    out.mz = Math.cos(baseAngle + Math.PI / 2) * th.strafe + Math.cos(baseAngle) * pushBias;
    out.crouch = false;
  }

  return finish(bot, null, out, sinceSeen < 0.5 ? 'fight' : 'hunt');
}

// ── 无敌人时的行动 ──────────────────────────────────────────────────────────

function idle(match, bot, th, out, diff, rng, now) {
  const world = match.world;
  const hasGun = armed(bot);
  const noPrimary = !bot.loadout[0] || !bot.loadout[0].type;

  // 1) horde 模式：守家（买升级 / 回基地 / 门口待机）
  if (match.hordeRun) return hordeIdle(match, bot, th, out, diff, rng);

  // 2) 没枪 / 弹匣空：优先搜物资
  //    有枪之后也要「补货」：战术物资（甲/雷/药）比多拿一把枪更值钱，
  //    否则 bot 会一路空手进决赛圈（基线的 pickup 只有 111 次 / 5 分钟）。
  //    lootHaste 同时放大搜索半径和「顺路捡」的容忍距离。
  const haste = diff.lootHaste || 1;
  const wantsSupplies = bot.grenades + bot.smokes + bot.flashes + bot.molotovs < 2
    || (bot.meds + bot.bandages) < 2 || bot.armorTier < 2;
  const lootNear = nearestLoot(match, bot, th, (hasGun ? 30 : 60) * haste);
  if (lootNear && (noPrimary || !hasGun || lootNear.d < 14 * haste
    || (wantsSupplies && lootNear.d < 26 * haste))) {
    followPoint(match, bot, th, lootNear.l.x, lootNear.l.z, lootNear.d > 16, out);
    return finish(bot, null, out, 'loot');
  }

  // 3) 载具：距圈远/圈外且有车 → 承诺式转移（useVehicle 门控）
  const zp = zonePush(match, bot);
  if (tryVehicleTransfer(match, bot, th, out, diff, rng, zp, false)) {
    return finish(bot, null, out, 'vehicle');
  }

  // 4) 有枪没敌人：先查「最近听到的枪声」，没有再巡逻。
  //
  // 这是听觉真正落地的地方。A/B 实测（artifacts/hearing-ab.md）显示：修前听觉
  // 只影响「跑毒时的绕行方向」，每局约 4.75 次，宏观战绩无可检测差异 ——
  // 注释里写的「听声辨位 → 摸过去」在代码里根本不存在。现在补上：
  // 有枪、没可见敌人、附近有 8 秒内的声源 → 走过去调查（而不是随机巡逻）。
  // 门槛用 aggression 门控：新兵不一定敢去（0.65），精锐几乎必去（0.9）。
  if (hasGun && !th.target && rng() < (diff.aggression || 0.8)) {
    const heard = hearsOf(match, bot);
    if (heard && heard.d > 4) {
      // 声源坐标加一点噪声：枪声只给方向，不该等于精确坐标（否则 bot 隔墙索敌）。
      // 用 id 哈希做确定性抖动，不消耗 match.rng。
      const h = hash32(String(bot.id) + String(Math.floor(now * 2)));
      const jitterA = (h % 628) / 100;
      const jitterR = 3 + ((h >> 10) % 500) / 100;
      const tx = heard.x + Math.sin(jitterA) * jitterR;
      const tz = heard.z + Math.cos(jitterA) * jitterR;
      // 朝声源走时枪口也朝那边，别一路歪着走
      if (dist(bot.x, bot.z, tx, tz) > 2) {
        followPoint(match, bot, th, tx, tz, heard.d > 20, out);
        out.aim = Math.atan2(tx - bot.x, tz - bot.z);
        // 置信度决定姿态：听得真切（近且新）→ 举枪直冲；模糊 → 蹲下压低身形观察。
        // 这是 SOUND_CONF 唯一的实际消费者（之前它是死字段）。
        if (heard.conf > 0.45) out.sprint = heard.d > 25;
        else out.crouch = true;
        return finish(bot, null, out, 'investigate');
      }
    }
  }

  // 5) 有枪没敌人：向圈中心/热点区域巡逻（避免全图 bot 挤成一坨）
  const zone = match.zone;
  if (zone && rng() < 0.7) {
    const a = rng() * TAU;
    const r = Math.sqrt(rng()) * Math.max(10, zone.r - 18);
    const gx = zone.x + Math.cos(a) * r;
    const gz = zone.z + Math.sin(a) * r;
    if (!th.patrol || dist(bot.x, bot.z, th.patrol.x, th.patrol.z) < 6 || th.patrolT <= 0) {
      th.patrol = { x: gx, z: gz };
      th.patrolT = 8 + rng() * 8;
    } else {
      th.patrolT -= 1 / 30;
    }
    const g = th.patrol || { x: gx, z: gz };
    const far = dist(bot.x, bot.z, g.x, g.z);
    followPoint(match, bot, th, g.x, g.z, far > 24, out);
    return finish(bot, null, out, 'patrol');
  }

  // 6) 兜底：朝圈心走
  if (zone) {
    followPoint(match, bot, th, zone.x, zone.z, true, out);
    return finish(bot, null, out, 'rotate');
  }
  out.aim = bot.angle;
  return finish(bot, null, out, 'idle');
}

/** horde：站在基地附近打最近的敌人；有钱就买升级。 */
function hordeIdle(match, bot, th, out, diff, rng) {
  const run = match.hordeRun;
  const base = run && run.base ? run.base : null;
  const list = run && Array.isArray(run.enemies) ? run.enemies : [];
  let target = null;
  let bestD = 40;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.hp <= 0) continue;
    const d = dist(bot.x, bot.z, e.x, e.z);
    if (d < bestD) { bestD = d; target = e; }
  }
  if (target) {
    const a = Math.atan2(target.x - bot.x, target.z - bot.z);
    out.aim = lerpAngle(bot.angle, a + (rng() - 0.5) * (diff.aimError || 0.1), 0.5);
    if (bestD < 34) out.fire = true;
    if (bestD > 14) {
      const mx = Math.sin(a);
      const mz = Math.cos(a);
      out.mx = mx; out.mz = mz;
    } else if (bestD < 6) {
      out.mx = -Math.sin(a); out.mz = -Math.cos(a);
    }
    return finish(bot, null, out, 'horde');
  }
  if (base) {
    if (dist(bot.x, bot.z, base.x, base.z) > 9) {
      followPoint(match, bot, th, base.x, base.z, false, out);
      return finish(bot, null, out, 'horde-home');
    }
    out.aim = Math.atan2(base.x - bot.x, base.z - bot.z);
    return finish(bot, null, out, 'horde-guard');
  }
  return finish(bot, null, out, 'horde-idle');
}

// ── 载具驾驶 ────────────────────────────────────────────────────────────────
// 司机：朝进圈方向开，前方阻挡就绕；乘客：朝最近的敌人开火。
// 全员：车血低 / 已到安全区 / 有目标下车更划算 → interact 下车。

function driveVehicle(match, bot, th, out, diff, rng, now, step) {
  const car = match._carById ? match._carById(bot.car) : null;
  const world = match.world;
  if (!car) return;
  const isDriver = car.driver === bot.id;
  const hpFrac = car.maxHp ? car.hp / car.maxHp : 1;

  // 找目标（乘客用于开火，司机也看以免撞人堆）
  const scanned = scanEnemies(match, bot);
  let target = null;
  for (let i = 0; i < scanned.length; i++) {
    if (scanned[i].visible) { target = scanned[i].p; break; }
  }
  if (!target && scanned.length) target = scanned[0].p;

  if (target) {
    const a = Math.atan2(target.x - car.x, target.z - car.z);
    out.aim = lerpAngle(bot.angle, a, 0.4);
    const d = dist(bot.x, bot.z, target.x, target.z);
    if (!isDriver && d < 46) out.fire = true;
  }

  // 下车判据：车快报废，或已经在安全区内且敌人靠近（车上不容易打）。
  const zp = zonePush(match, bot);
  const inSafe = !zp;
  const enemyD = target ? dist(bot.x, bot.z, target.x, target.z) : Infinity;
  const shouldLeave = hpFrac < 0.3 || (inSafe && enemyD < 24);
  if (shouldLeave) {
    th.leaveT = (th.leaveT || 0) + step;
    if (th.leaveT > 0.35) {
      out.interact = true;
      th.leaveT = 0;
    }
  }

  if (!isDriver) return;

  // 司机：朝安全区中心开（圈外时更急）
  const zone = match.zone;
  if (!zone) { out.mz = 0.4; return; }
  const zx = zone.x;
  const zz = zone.z;
  const da = Math.atan2(zx - car.x, zz - car.z);
  // 前方 9m 有障碍就左右打方向
  let steer = 0;
  if (world && typeof world.blocked === 'function') {
    const look = 9;
    const fx = car.x + Math.sin(car.angle) * look;
    const fz = car.z + Math.cos(car.angle) * look;
    if (world.blocked(fx, fz, 1.9)) {
      const la = wrap(da - car.angle);
      steer = la >= 0 ? 1 : -1;
      // 障碍很近：倒一点
      if (world.blocked(car.x + Math.sin(car.angle) * 3, car.z + Math.cos(car.angle) * 3, 1.9)) {
        out.mz = -0.5;
        out.mx = -steer;
        return;
      }
    }
  }
  const diffA = wrap(da - car.angle);
  out.mx = clamp(diffA * 1.8 + steer * 0.9, -1, 1);
  // 圈外全速，圈内看距离
  const toZone = dist(car.x, car.z, zx, zz);
  out.mz = toZone > zone.r * 0.75 ? 1 : 0.55;
  out.aim = car.angle;
}
