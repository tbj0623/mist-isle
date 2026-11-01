// 雾岛突围 / MIST ISLE 1.0 — 生存波次（horde）AI 与结算（owner: horde）
// 只被 shared/simulation.mjs 的 horde 方法调用；纯逻辑、无 DOM、无 Math.random。
// 随机一律用 match.rng()（mulberry32，种子在 Match 构造时确定）。
import { HORDE, MOVE } from './rules.mjs';
import {
  ENEMIES, waveEntry, endlessEntry, waveSpawnQueue, rollModifier, reviveTimeFor,
} from './data/enemies.mjs';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r2 = (v) => Math.round(v * 100) / 100;
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const SEP_RADIUS = 1.2;
const SEP_CELL = 2.4;
const ACTIVE_CAP = HORDE.maxActive || 60;

/** 敌人/建筑统一取「波次 1」基准，再乘难度曲线。 */
function waveScale(wave) {
  const w = Math.max(1, wave | 0);
  const over = Math.max(0, w - HORDE.waves);
  return {
    hp: Math.pow(HORDE.hpPerWave, w - 1) * Math.pow(1 + HORDE.endlessHpStep, over),
    dmg: Math.pow(HORDE.dmgPerWave, w - 1),
    speed: Math.min(1.45, Math.pow(HORDE.speedPerWave, w - 1)),
  };
}

export function createRun(match, baseX, baseZ) {
  const base = { x: baseX, z: baseZ, hp: HORDE.baseHp, maxHp: HORDE.baseHp, turrets: 0 };
  const run = {
    wave: 0, totalWaves: HORDE.waves, prepTime: HORDE.prepTime, base,
    score: 0, credits: 400, kills: 0, bossKills: 0,
    enemies: [], spawnQueue: [], activeCap: ACTIVE_CAP,
    nextWaveIn: HORDE.prepTime, prepTotal: HORDE.prepTime,
    modifier: null, modifiers: [], fog: 1,
    boss: false, bossSpawned: false,
    turrets: [], barricades: [], medstations: 0, slowfields: 0,
    overcharge: false, overchargeWaves: 0,
    bolts: [], acids: [],
    upgradesBought: {}, achievement: null, cleared: false,
    waveCleared: false, waveStart: 0, waveKills: 0, waveStats: [],
    healTimer: 0, repairTimer: 0, reviveAt: HORDE.reviveAfter,
    endless: false, spawnedThisWave: 0,
  };
  match.enemies = run.enemies;
  return run;
}

/** 本波编排：前 20 波读表，之后走无尽模板。 */
export function entryForWave(run, wave) {
  const table = waveEntry(wave);
  if (table) return table;
  run.endless = true;
  return endlessEntry(wave);
}

/** 开波：抽修正 → 展开刷怪队列 → 立刻刷到上限。 */
export function beginWave(match, wave) {
  const run = match.hordeRun;
  if (!run) return 0;
  run.wave = wave;
  run.waveCleared = false;
  run.waveStart = match.time;
  run.waveKills = 0;
  run.spawnedThisWave = 0;
  run.spawnQueue.length = 0;
  run.bolts.length = 0;
  run.acids.length = 0;
  const entry = entryForWave(run, wave);
  const mod = rollModifier(() => match.rng(), wave, entry);
  run.modifier = mod || null;
  if (mod) {
    run.modifiers.push(mod.id);
    run.fog = mod.viewMul ? mod.viewMul : 1;
    match._emit('modifier', { wave, id: mod.id, name: mod.name, desc: mod.desc });
  } else {
    run.fog = 1;
  }
  // 超载只持续 1 波
  if (run.overchargeWaves > 0) run.overchargeWaves--;
  run.overcharge = run.overchargeWaves > 0;
  const queue = waveSpawnQueue(entry, mod);
  for (const part of queue) run.spawnQueue.push({ type: part.type, count: part.count });
  run.totalThisWave = queue.reduce((a, p) => a + p.count, 0);
  const spawned = fillSpawnQueue(match);
  run.boss = run.enemies.some((e) => e.kind === 'boss');
  run.bossSpawned = run.boss;
  match._emit('wave', {
    wave, count: run.totalThisWave, spawned, boss: run.boss,
    modifier: mod ? mod.id : null, modifierName: mod ? mod.name : null,
  });
  if (run.boss) match._emit('boss', { wave, x: r2(run.base.x), z: r2(run.base.z) });
  return spawned;
}

/** 从队列补怪到活跃上限（超了就等死一个补一个）。 */
export function fillSpawnQueue(match) {
  const run = match.hordeRun;
  if (!run) return 0;
  let spawned = 0;
  while (run.enemies.length < run.activeCap && run.spawnQueue.length) {
    const head = run.spawnQueue[0];
    if (!head || head.count <= 0) { run.spawnQueue.shift(); continue; }
    head.count--;
    if (head.count <= 0) run.spawnQueue.shift();
    const e = spawnEnemy(match, head.type);
    if (e) { spawned++; run.spawnedThisWave++; }
  }
  return spawned;
}

/** 在基地外围找一个不被墙挡住的出生点。 */
function spawnPointFor(match, radius = 34) {
  const base = match.hordeRun.base;
  for (let i = 0; i < 28; i++) {
    const a = match.rng() * TAU;
    const rr = radius + match.rng() * 12;
    const x = base.x + Math.cos(a) * rr;
    const z = base.z + Math.sin(a) * rr;
    if (!match.world.blocked(x, z, 0.9)) return { x, z };
  }
  const a = match.rng() * TAU;
  return { x: base.x + Math.cos(a) * radius, z: base.z + Math.sin(a) * radius };
}

/** 生成一个敌人实例（数值来自 HORDE.enemies，再乘波次曲线与修正）。 */
export function spawnEnemy(match, type, at = null) {
  const run = match.hordeRun;
  const def = ENEMIES[type];
  if (!run || !def) return null;
  const mod = run.modifier;
  const scale = waveScale(run.wave);
  const hpMul = (mod && mod.hpMul ? mod.hpMul : 1);
  const point = at || spawnPointFor(match, def.kind === 'boss' ? 42 : 34);
  const hp = Math.max(1, Math.round(def.hp * scale.hp * hpMul));
  const a = Math.atan2(run.base.x - point.x, run.base.z - point.z);
  const e = {
    id: `e${++match.entityId}`, type: def.id, name: def.name, kind: def.kind,
    behavior: def.behavior, boss: def.kind === 'boss',
    x: point.x, z: point.z, angle: a,
    hp, maxHp: hp, radius: def.radius, color: def.color,
    speed: def.speed * scale.speed, damage: Math.round(def.damage * scale.dmg),
    attackCd: def.attackCd, cd: 0.6 + match.rng() * 0.6,
    xp: def.xp, credits: def.credits, score: def.score,
    knockback: def.knockback || 0, meleeRange: def.meleeRange || 1.8,
    range: def.range || 0, projectileSpeed: def.projectileSpeed || 0,
    poolRadius: def.poolRadius || 0, poolTtl: def.poolTtl || 0, poolDps: def.poolDps || 0,
    blastRadius: def.blastRadius || 0, triggerRange: def.triggerRange || 0,
    skillCd: def.skillCd || 0, skillT: def.skillCd ? 1.6 + match.rng() * 1.5 : 0,
    chargeSpeed: def.chargeSpeed || 0, chargeTime: def.chargeTime || 0,
    summonCount: def.summonCount || 0, quakeRadius: def.quakeRadius || 0,
    quakeDamage: def.quakeDamage || 0, wave: run.wave,
    fuse: -1, charging: 0, chargeDx: 0, chargeDz: 0,
    flash: 0, grounded: true, uid: run.enemies.length,
    dx: 0, dz: 0, navT: match.tickCount % 4,
  };
  run.enemies.push(e);
  return e;
}

/** 波次清空 → 结算奖励、回血、进入准备期或结束。 */
export function clearWave(match) {
  const run = match.hordeRun;
  if (!run || run.waveCleared) return false;
  run.waveCleared = true;
  const wave = run.wave;
  const credits = HORDE.creditsBase + wave * HORDE.creditsPerWave;
  const score = HORDE.scoreWaveBase + wave * HORDE.scoreWaveStep;
  run.credits += credits;
  run.score += score;
  const heal = run.base.maxHp * HORDE.waveHeal;
  run.base.hp = Math.min(run.base.maxHp, run.base.hp + heal);
  const took = Math.round((match.time - run.waveStart) * 10) / 10;
  run.waveStats.push({ wave, kills: run.waveKills, time: took, baseHp: Math.round(run.base.hp) });
  match._emit('waveClear', {
    wave, credits, score, baseHp: Math.round(run.base.hp), time: took,
    killed: run.waveKills, modifier: run.modifier ? run.modifier.id : null,
  });
  if (!run.endless && wave >= run.totalWaves) {
    finishRun(match, 'cleared');
    return true;
  }
  run.nextWaveIn = HORDE.prepTime;
  run.prepTotal = HORDE.prepTime;
  return true;
}

/** 20 波全清：给独有成就 + 结束对局。 */
export function finishRun(match, reason = 'cleared') {
  const run = match.hordeRun;
  if (!run) return null;
  run.achievement = 'horde_conqueror';
  run.score += 500;
  const human = match.players.find((p) => !p.bot) || match.players[0] || null;
  const team = human ? human.team : 0;
  match._emit('achievement', { id: 'horde_conqueror', name: '雾岛征服者', wave: run.wave });
  match.end(reason, team);
  return run;
}

/** 对局结算里带的 horde 汇总（result.horde / 存档 hordeWaves 都读它）。 */
export function runSummary(run) {
  if (!run) return null;
  return {
    wave: run.wave, totalWaves: run.totalWaves, score: Math.round(run.score),
    credits: Math.round(run.credits), kills: run.kills, bossKills: run.bossKills,
    baseHp: Math.round(Math.max(0, run.base.hp)), baseMaxHp: run.base.maxHp,
    modifiers: run.modifiers.slice(), achievement: run.achievement,
    cleared: !!(run.achievement === 'horde_conqueror'),
  };
}

/** 复活等待时间（1–5 波 6s / 6–12 波 10s / 13+ 波 14s）。 */
export function reviveDelay(run) { return reviveTimeFor(run ? run.wave : 1); }

// ── 每帧推进 ───────────────────────────────────────────────────────────────
/** 波次流转：刷怪队列空 + 场上清空 → 清波结算 → 准备期倒数 → 下一波。 */
export function updateWaveFlow(match, dt) {
  const run = match.hordeRun;
  if (!run || match.phase === 'ended') return;
  if (run.enemies.length === 0 && run.spawnQueue.length === 0) {
    if (run.wave === 0 || run.waveCleared) {
      run.nextWaveIn = Math.max(0, run.nextWaveIn - dt);
      run.prepTime = run.nextWaveIn;
      if (run.nextWaveIn > 0) return;
      if (!run.endless && run.wave >= run.totalWaves) { finishRun(match, 'cleared'); return; }
      beginWave(match, run.wave + 1);
      return;
    }
    if (run.wave > 0) clearWave(match);
  }
}

/** 击杀结算：分数/信用点/计数只在这里加，保证只加一次。 */
export function awardKill(match, e) {
  const run = match.hordeRun;
  if (!run || !e || e.dead) return false;
  e.dead = true;
  e.hp = 0;
  run.kills++;
  run.waveKills++;
  run.score += e.score || 25;
  run.credits += e.credits || 6;
  if (e.boss) { run.bossKills++; run.boss = run.enemies.some((x) => x.boss && !x.dead); }
  match._emit('enemyDown', {
    id: e.id, type: e.type, boss: !!e.boss, wave: run.wave, x: r2(e.x), z: r2(e.z),
  });
  return true;
}

/** 空间哈希重建（O(n)）：分离力只查 3×3 邻格，避免 O(n²)。 */
function rebuildGrid(run) {
  const grid = run._sepGrid || (run._sepGrid = new Map());
  grid.clear();
  const cell = SEP_CELL;
  for (let i = 0; i < run.enemies.length; i++) {
    const e = run.enemies[i];
    if (e.hp <= 0) continue;
    const key = ((e.x / cell) | 0) * 4096 + ((e.z / cell) | 0);
    const bucket = grid.get(key);
    if (bucket) bucket.push(e); else grid.set(key, [e]);
  }
  run._sepCell = cell;
}

/** 分离力：把靠得太近的敌人推开到 1.2m。 */
function separation(run, e) {
  const grid = run._sepGrid;
  if (!grid) return;
  const cell = run._sepCell || SEP_CELL;
  const cx = (e.x / cell) | 0;
  const cz = (e.z / cell) | 0;
  let px = 0, pz = 0, n = 0;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const bucket = grid.get(gx * 4096 + gz);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const o = bucket[i];
        if (o === e || o.hp <= 0) continue;
        const dx = e.x - o.x;
        const dz = e.z - o.z;
        const d = Math.hypot(dx, dz);
        if (d >= SEP_RADIUS || d < 1e-4) continue;
        const push = (SEP_RADIUS - d) / SEP_RADIUS;
        px += (dx / d) * push; pz += (dz / d) * push; n++;
      }
    }
  }
  if (!n) return;
  e.sepX = clamp(px / n, -1, 1);
  e.sepZ = clamp(pz / n, -1, 1);
}

/** 移动一步：直线被挡就沿墙滑（不用 A*，敌人多会卡）。 */
function stepEnemy(match, e, dx, dz, dt, speed) {
  const step = Math.max(0, speed * dt);
  if (step <= 0) return false;
  const r = e.radius * 0.9;
  const current = e.speedMul || 1;
  const total = step * current;
  if (!match.world.blocked(e.x + dx * total, e.z + dz * total, r)) {
    e.x += dx * total; e.z += dz * total;
    return true;
  }
  // 切线滑动：沿墙面法线切向走，两侧都试
  const tx = -dz, tz = dx;
  for (let s = 1; s >= -1; s -= 2) {
    if (!match.world.blocked(e.x + tx * total * s, e.z + tz * total * s, r)) {
      e.x += tx * total * s; e.z += tz * total * s;
      return true;
    }
  }
  if (!match.world.blocked(e.x + dx * total * 0.4, e.z, r)) { e.x += dx * total * 0.4; return true; }
  if (!match.world.blocked(e.x, e.z + dz * total * 0.4, r)) { e.z += dz * total * 0.4; return true; }
  return false;
}

/**
 * 绕障：在直线方向上被挡时，围绕目标方向采样若干偏转角，取「能直走 & 更靠近基地」的
 * 第一个角度作为临时航点。纯采样、无 A*，60 个敌人也扛得住。
 */
function detourAngle(match, e, tx, tz) {
  const base = match.hordeRun.base;
  const aim = Math.atan2(tx - e.x, tz - e.z);
  const sign = e.slideSign || 1;
  const here = dist(e.x, e.z, base.x, base.z);
  const cand = [0.5, 0.85, 0.7, 1.15, 1.45, 1.8, 2.1, 2.5];
  for (let i = 0; i < cand.length; i++) {
    for (let s = 0; s < 2; s++) {
      const dir = (s === 0 ? sign : -sign);
      const a = aim + dir * cand[i];
      const px = e.x + Math.sin(a) * 3.5;
      const pz = e.z + Math.cos(a) * 3.5;
      if (match.world.blocked(px, pz, e.radius * 0.9)) continue;
      if (dist(px, pz, base.x, base.z) > here + 1.6) continue;
      return a;
    }
  }
  return aim + sign * 1.2;
}

/** 敌人移动：绕墙 + 分离 + 减速场 + 目标选择（runner 优先玩家、boss 冲基地）。 */
function moveEnemy(match, e, dt) {
  const run = match.hordeRun;
  const base = run.base;
  let tx = base.x, tz = base.z;
  let target = null;
  // 疾行者优先追活人；其余敌人只有在玩家贴脸时才换目标
  let bestD = 1e9;
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i];
    if (!p.alive || p.downed) continue;
    const d = dist(e.x, e.z, p.x, p.z);
    const want = e.behavior === 'flank' ? d < 46 : d < 9;
    if (want && d < bestD) { bestD = d; target = p; }
  }
  if (target) {
    tx = target.x; tz = target.z;
    if (e.behavior === 'flank') {
      // 绕后：朝玩家侧后方切，而不是直线扑脸
      const a = Math.atan2(e.x - tx, e.z - tz) + (e.flankOffset || 7) / 30;
      tx = tx + Math.sin(a) * 6; tz = tz + Math.cos(a) * 6;
    }
  }
  let aim;
  // 每 0.4s 判定一次直线可走性；被挡就走绕障航点（航点保持到下一次判定）
  e.navT -= dt;
  if (e.navT <= 0) {
    e.navT = 0.4;
    if (match.world.nav.pathClear(e.x, e.z, tx, tz)) {
      e.slide = false;
      e.navAim = Math.atan2(tx - e.x, tz - e.z);
    } else {
      e.slide = true;
      e.navAim = detourAngle(match, e, tx, tz);
    }
  }
  aim = Number.isFinite(e.navAim) ? e.navAim : Math.atan2(tx - e.x, tz - e.z);
  let dx = Math.sin(aim);
  let dz = Math.cos(aim);
  if (e.sepX || e.sepZ) { dx += e.sepX * 0.55; dz += e.sepZ * 0.55; }
  const len = Math.hypot(dx, dz) || 1;
  e.angle = Math.atan2(dx / len, dz / len);
  const px = e.x, pz = e.z;
  stepEnemy(match, e, dx / len, dz / len, dt, e.speed);
  const moved = dist(e.x, e.z, px, pz);
  const toBase = dist(e.x, e.z, base.x, base.z);
  // 进展检测：位移太小 or 离基地不再变近 → 累计「卡住」时间
  const improved = moved > 0.02 && toBase < (e.lastBaseD ?? 1e9) - 0.02;
  e.lastBaseD = toBase;
  if (moved < 0.02) {
    e.stuck = (e.stuck || 0) + dt;
    if (e.stuck > 1.2) e.slideSign = -(e.slideSign || 1);
    if (e.stuck > 4) {
      // 彻底卡死：换到基地另一侧的出生点重新推进（比 A* 便宜得多）
      e.stuck = 0; e.slideSign = -(e.slideSign || 1); e.navT = 0;
      const p = spawnPointFor(match, 24);
      e.x = p.x; e.z = p.z;
      e.lastBaseD = dist(e.x, e.z, base.x, base.z);
      match._emit('enemyRepath', { id: e.id, x: r2(e.x), z: r2(e.z) });
    }
  } else {
    e.stuck = Math.max(0, (e.stuck || 0) - dt * 0.5);
  }
  // 长时间没有靠近基地（例如绕着障碍转圈）→ 换绕行方向
  if (improved) e.noGain = 0; else e.noGain = (e.noGain || 0) + dt;
  if (e.noGain > 4.5) {
    e.noGain = 0;
    e.slideSign = -(e.slideSign || 1);
    e.navT = 0;
  }
}

/** 减速：路障（-50%）与减速场（基地 12m 内 -35%/层，最多 -50%）。 */
function applySlow(match, e) {
  const run = match.hordeRun;
  let mul = 1;
  const base = run.base;
  for (let i = 0; i < run.barricades.length; i++) {
    const b = run.barricades[i];
    if (dist(e.x, e.z, b.x, b.z) <= b.r) { mul = Math.min(mul, 0.5); break; }
  }
  if (run.slowfields > 0 && dist(e.x, e.z, base.x, base.z) <= 12) {
    mul = Math.min(mul, 1 - Math.min(0.5, 0.35 * run.slowfields));
  }
  e.speedMul = mul;
}

/** 对基地造成伤害（统一事件出口）。敌人打建筑按 baseDamageMul 折算。 */
export function damageBase(match, amount) {
  const run = match.hordeRun;
  if (!run || !(amount > 0)) return 0;
  const dealt = amount * (HORDE.baseDamageMul ?? 1);
  run.base.hp = Math.max(0, run.base.hp - dealt);
  match._emit('basehit', { hp: Math.round(run.base.hp), maxHp: run.base.maxHp, by: 'enemy' });
  return dealt;
}

/** 击退玩家（重装兵/boss 震地）。 */
function knockPlayer(match, p, srcX, srcZ, power) {
  const d = Math.max(0.001, dist(p.x, p.z, srcX, srcZ));
  const dx = (p.x - srcX) / d;
  const dz = (p.z - srcZ) / d;
  const body = match.world;
  if (body && body.moveBody) body.moveBody(p, dx * power, dz * power, MOVE.radius);
  else { p.x += dx * power; p.z += dz * power; }
  match._emit('knockback', { player: p.id, x: r2(p.x), z: r2(p.z), power: r2(power) });
}

/** 近战玩家/基地。 */
function meleeAttack(match, e, dt) {
  const run = match.hordeRun;
  e.cd -= dt;
  if (e.cd > 0) return;
  const range = e.meleeRange || 1.8;
  let hit = false;
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i];
    if (!p.alive || p.downed) continue;
    if (dist(e.x, e.z, p.x, p.z) > range) continue;
    match.damage(p, e.damage, null, { noDown: true });
    if (e.knockback) knockPlayer(match, p, e.x, e.z, e.knockback);
    match._emit('enemyHit', { id: e.id, player: p.id, damage: e.damage, x: r2(p.x), z: r2(p.z) });
    hit = true;
    break;
  }
  if (!hit && dist(e.x, e.z, run.base.x, run.base.z) <= range + 0.9) {
    damageBase(match, e.damage);
    match._emit('baseHitFx', { x: r2(run.base.x), z: r2(run.base.z), id: e.id });
    hit = true;
  }
  const speed = run.modifier && run.modifier.attackSpeed ? run.modifier.attackSpeed : 1;
  if (hit) e.cd = Math.max(0.25, e.attackCd / speed);
}

/** 喷吐者：15m 内抛酸液，落地生成 4m 毒圈 8 秒。 */
function rangedAttack(match, e, dt) {
  e.cd -= dt;
  if (e.cd > 0) return;
  const base = match.hordeRun.base;
  let tx = base.x, tz = base.z, best = 1e9;
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i];
    if (!p.alive || p.downed) continue;
    const d = dist(e.x, e.z, p.x, p.z);
    if (d < best) { best = d; tx = p.x; tz = p.z; }
  }
  if (dist(e.x, e.z, tx, tz) > (e.range || 15)) return;
  const speed = match.hordeRun.modifier && match.hordeRun.modifier.attackSpeed
    ? match.hordeRun.modifier.attackSpeed : 1;
  e.cd = Math.max(0.6, e.attackCd / speed);
  e.angle = Math.atan2(tx - e.x, tz - e.z);
  match.hordeRun.bolts.push({
    id: `b${++match.entityId}`, x: e.x, z: e.z, tx, tz,
    speed: e.projectileSpeed || 17, damage: e.damage,
    poolRadius: e.poolRadius || 4, poolTtl: e.poolTtl || 8, poolDps: e.poolDps || 7, owner: e.id,
  });
  match._emit('acidThrow', { id: e.id, x: r2(e.x), z: r2(e.z), tx: r2(tx), tz: r2(tz) });
}

/** 自爆兵：进入 2.5m 或血量 < 20% 时点燃引信，0.6s 后炸。 */
function bomberTick(match, e, dt) {
  if (e.fuse >= 0) {
    e.fuse -= dt;
    if (e.fuse <= 0) detonate(match, e);
    return;
  }
  const base = match.hordeRun.base;
  let near = dist(e.x, e.z, base.x, base.z) <= (e.triggerRange || 2.5) + 1;
  if (!near) {
    for (let i = 0; i < match.players.length; i++) {
      const p = match.players[i];
      if (!p.alive || p.downed) continue;
      if (dist(e.x, e.z, p.x, p.z) <= (e.triggerRange || 2.5)) { near = true; break; }
    }
  }
  const low = e.hp / Math.max(1, e.maxHp) < 0.2;
  if (near || low) {
    e.fuse = 0.6;
    match._emit('fuse', { id: e.id, x: r2(e.x), z: r2(e.z) });
  }
}

/** 自爆结算：8m 半径 45 伤害，同时炸玩家和基地。 */
export function detonate(match, e) {
  const run = match.hordeRun;
  if (!run || e.dead) return 0;
  const radius = e.blastRadius || 8;
  let hits = 0;
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i];
    if (!p.alive || p.downed) continue;
    const d = dist(e.x, e.z, p.x, p.z);
    if (d > radius) continue;
    const falloff = 1 - (d / radius) * 0.5;
    match.damage(p, e.damage * falloff, null, { noDown: true });
    hits++;
  }
  const bd = dist(e.x, e.z, run.base.x, run.base.z);
  if (bd <= radius) damageBase(match, e.damage * (1 - (bd / radius) * 0.5) * 0.6);
  match._emit('explosion', { id: e.id, x: r2(e.x), z: r2(e.z), r: radius, source: 'bomber' });
  awardKill(match, e);
  return hits;
}

// ── 首领技能：每 6 秒随机一个（冲锋 / 召唤 / 震地） ───────────────────────
function bossSkills(match, e, dt) {
  const run = match.hordeRun;
  if (e.charging > 0) {
    // 冲锋中：18m/s 直线推进，撞到谁就撞谁
    e.charging -= dt;
    stepEnemy(match, e, e.chargeDx, e.chargeDz, dt, e.chargeSpeed);
    for (let i = 0; i < match.players.length; i++) {
      const p = match.players[i];
      if (!p.alive || p.downed) continue;
      if (dist(e.x, e.z, p.x, p.z) > 2.2) continue;
      match.damage(p, (e.chargeDamage || 40), null, { noDown: true });
      knockPlayer(match, p, e.x, e.z, 3.5);
    }
    if (dist(e.x, e.z, run.base.x, run.base.z) < 3.2) {
      damageBase(match, e.chargeDamage || 40);
      e.charging = 0;
      match._emit('bossCharge', { id: e.id, hit: 'base', x: r2(e.x), z: r2(e.z) });
    }
    if (e.charging <= 0) match._emit('bossChargeEnd', { id: e.id, x: r2(e.x), z: r2(e.z) });
    return true;
  }
  e.skillT -= dt;
  if (e.skillT > 0) return false;
  e.skillT = e.skillCd || 6;
  const roll = match.rng();
  const pick = roll < 0.34 ? 'charge' : roll < 0.67 ? 'summon' : 'quake';
  if (pick === 'charge') {
    const target = pickTarget(match, e);
    const d = Math.max(0.001, dist(e.x, e.z, target.x, target.z));
    e.chargeDx = (target.x - e.x) / d;
    e.chargeDz = (target.z - e.z) / d;
    e.charging = e.chargeTime || 1.5;
    e.angle = Math.atan2(e.chargeDx, e.chargeDz);
    match._emit('bossCharge', { id: e.id, x: r2(e.x), z: r2(e.z), tx: r2(target.x), tz: r2(target.z) });
  } else if (pick === 'summon') {
    const n = e.summonCount || 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + match.rng() * 0.6;
      const at = { x: e.x + Math.cos(a) * 3, z: e.z + Math.sin(a) * 3 };
      if (match.world.blocked(at.x, at.z, 0.6)) continue;
      if (run.enemies.length >= run.activeCap) break;
      spawnEnemy(match, 'crawler', at);
    }
    match._emit('bossSummon', { id: e.id, count: n, x: r2(e.x), z: r2(e.z) });
  } else {
    const radius = e.quakeRadius || 8;
    for (let i = 0; i < match.players.length; i++) {
      const p = match.players[i];
      if (!p.alive || p.downed) continue;
      const d = dist(e.x, e.z, p.x, p.z);
      if (d > radius) continue;
      match.damage(p, e.quakeDamage || 30, null, { noDown: true });
      knockPlayer(match, p, e.x, e.z, e.knockback || 4);
    }
    const bd = dist(e.x, e.z, run.base.x, run.base.z);
    if (bd <= radius) damageBase(match, (e.quakeDamage || 30) * 0.5);
    match._emit('bossQuake', { id: e.id, x: r2(e.x), z: r2(e.z), r: radius });
  }
  return true;
}

function pickTarget(match, e) {
  let best = match.hordeRun.base;
  let bestD = dist(e.x, e.z, best.x, best.z);
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i];
    if (!p.alive || p.downed) continue;
    const d = dist(e.x, e.z, p.x, p.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { x: best.x, z: best.z };
}

/** 酸液抛射物推进 + 落地生成毒圈。 */
function updateBolts(match, dt) {
  const run = match.hordeRun;
  for (let i = run.bolts.length - 1; i >= 0; i--) {
    const b = run.bolts[i];
    const d = dist(b.x, b.z, b.tx, b.tz);
    const step = b.speed * dt;
    if (d <= step || d < 0.4) {
      run.acids.push({
        id: b.id, x: b.tx, z: b.tz, r: b.poolRadius, ttl: b.poolTtl,
        dps: b.poolDps, tick: 0, owner: b.owner,
      });
      run.bolts.splice(i, 1);
      match._emit('acidLand', { id: b.id, x: r2(b.tx), z: r2(b.tz), r: b.poolRadius });
      continue;
    }
    b.x += ((b.tx - b.x) / d) * step;
    b.z += ((b.tz - b.z) / d) * step;
  }
}

/** 毒圈：4m 内玩家/基地持续掉血，8 秒后消失。 */
function updateAcids(match, dt) {
  const run = match.hordeRun;
  for (let i = run.acids.length - 1; i >= 0; i--) {
    const a = run.acids[i];
    a.ttl -= dt;
    if (a.ttl <= 0) { run.acids.splice(i, 1); continue; }
    a.tick -= dt;
    if (a.tick > 0) continue;
    a.tick = 1;
    for (let k = 0; k < match.players.length; k++) {
      const p = match.players[k];
      if (!p.alive || p.downed) continue;
      if (dist(a.x, a.z, p.x, p.z) > a.r) continue;
      match.damage(p, a.dps, null, { noDown: true });
    }
    if (dist(a.x, a.z, run.base.x, run.base.z) <= a.r) damageBase(match, a.dps * 0.4);
  }
}

/** 炮塔：每 0.55s 打一次 26m 内最近的敌人，超载时伤害 ×2。 */
function updateTurrets(match, dt) {
  const run = match.hordeRun;
  for (let t = 0; t < run.turrets.length; t++) {
    const turret = run.turrets[t];
    turret.cd -= dt;
    if (turret.cd > 0) continue;
    let target = null; let bestD = 26;
    for (let i = 0; i < run.enemies.length; i++) {
      const e = run.enemies[i];
      if (e.hp <= 0) continue;
      const d = dist(turret.x, turret.z, e.x, e.z);
      if (d < bestD) { bestD = d; target = e; }
    }
    if (!target) continue;
    turret.cd = 0.55;
    turret.angle = Math.atan2(target.x - turret.x, target.z - turret.z);
    const dmg = (turret.damage || 26) * (run.overcharge ? 2 : 1);
    target.hp -= dmg;
    target.flash = Math.max(target.flash || 0, 0.09);
    match._emit('turretShot', {
      id: turret.id, x: r2(turret.x), z: r2(turret.z),
      tx: r2(target.x), tz: r2(target.z), overcharge: !!run.overcharge,
    });
    if (target.hp <= 0) awardKill(match, target);
  }
}

/** 医疗站：基地范围内每 2 秒回 2 点生命。 */
function updateMedstations(match, dt) {
  const run = match.hordeRun;
  if (!run.medstations) return;
  run.healTimer -= dt;
  if (run.healTimer > 0) return;
  run.healTimer = 2;
  const amount = 2 * run.medstations;
  for (let i = 0; i < match.players.length; i++) {
    const p = match.players[i];
    if (!p.alive || p.downed) continue;
    if (dist(p.x, p.z, run.base.x, run.base.z) > 10) continue;
    const before = p.hp;
    p.hp = Math.min(100, p.hp + amount);
    if (p.hp > before) match._emit('medHeal', { player: p.id, hp: r2(p.hp) });
  }
}

/** 再生修正：敌人每秒回 1% 最大生命。 */
function updateRegen(match, dt) {
  const run = match.hordeRun;
  const mod = run.modifier;
  if (!mod || !mod.regenPct) return;
  const amount = dt * mod.regenPct;
  for (let i = 0; i < run.enemies.length; i++) {
    const e = run.enemies[i];
    if (e.hp <= 0 || e.hp >= e.maxHp) continue;
    e.hp = Math.min(e.maxHp, e.hp + e.maxHp * amount);
  }
}

/** 主入口：simulation._updateHorde 只调这一个函数。 */
export function update(match, dt) {
  const run = match.hordeRun;
  if (!run || match.phase === 'ended') return;
  updateWaveFlow(match, dt);
  if (match.phase === 'ended') return;
  rebuildGrid(run);
  const regen = !!(run.modifier && run.modifier.regenPct);
  if (regen) updateRegen(match, dt);
  for (let i = run.enemies.length - 1; i >= 0; i--) {
    const e = run.enemies[i];
    if (e.hp <= 0) {
      if (!e.dead) awardKill(match, e);
      run.enemies.splice(i, 1);
      continue;
    }
    if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);
    applySlow(match, e);
    separation(run, e);
    if (e.kind === 'boss') {
      const casted = bossSkills(match, e, dt);
      if (!casted || e.charging <= 0) moveEnemy(match, e, dt);
      meleeAttack(match, e, dt);
      continue;
    }
    if (e.kind === 'suicide') { bomberTick(match, e, dt); moveEnemy(match, e, dt); continue; }
    if (e.kind === 'ranged') {
      const range = e.range || 15;
      const bd = dist(e.x, e.z, run.base.x, run.base.z);
      if (bd > range * 0.8) moveEnemy(match, e, dt);
      rangedAttack(match, e, dt);
      continue;
    }
    moveEnemy(match, e, dt);
    meleeAttack(match, e, dt);
  }
  updateBolts(match, dt);
  updateAcids(match, dt);
  updateTurrets(match, dt);
  updateMedstations(match, dt);
  fillSpawnQueue(match);
  if (run.base.hp <= 0) {
    match._emit('baseDestroyed', { x: r2(run.base.x), z: r2(run.base.z) });
    match.end('baseDestroyed', null);
  }
}

export { waveScale, SEP_RADIUS, ACTIVE_CAP };
