// 雾岛突围 / MIST ISLE — Bot 战术 AI 测试（node --test tests/ai.test.mjs）
// 覆盖：行为冒烟（治疗 / 跑毒 / 掩体）、全 AI 对局确定性、共享层纯净性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/simulation.mjs';
import { TICK_RATE } from '../shared/rules.mjs';

const tick = 1 / TICK_RATE;

function step(m, n = 1, dt = tick) {
  for (let i = 0; i < n; i++) m.update(dt);
  return m;
}

const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** 找 (x,z) 附近一个可站立点（出生/摆放用，避免卡进建筑）。 */
function openNear(world, x, z, r0 = 0) {
  if (!world.blocked(x, z, 1.0)) return { x, z };
  for (let r = Math.max(2, r0); r <= 40; r += 2) {
    for (let a = 0; a < 12; a++) {
      const px = x + Math.cos((a / 12) * Math.PI * 2) * r;
      const pz = z + Math.sin((a / 12) * Math.PI * 2) * r;
      if (!world.blocked(px, pz, 1.0)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/** 造一个只含指定 bot 的最小对局（start 后截断，与 simulation.test 的 duel 同套路）。 */
function soloBot({ seed = 11, difficulty = 'veteran' } = {}) {
  const m = new Match({ seed, mode: 'squad', maxPlayers: 4, duration: 180, difficulty });
  m.addPlayer('b0', 'Bot0', { bot: true, team: 0, difficulty });
  m.start();
  m.players.length = 1;
  m.zone.nextIn = 99999; // 关掉缩圈，行为测试自己摆圈
  m.dropsLeft = 0;
  return m;
}

test('ai 行为：残血且有绷带时原地静止治疗', () => {
  const m = soloBot({ seed: 11 });
  const b = m.players[0];
  const spot = openNear(m.world, b.x, b.z);
  b.x = spot.x; b.z = spot.z;
  b.hp = 35;
  b.bandages = 3;
  b.meds = 0;
  b.shields = 0;
  // 只统计「治疗进行中」的位移：治疗结束后 bot 继续搜物资是正常行为
  let healDrift = 0;
  let prevX = b.x;
  let prevZ = b.z;
  let wasHealing = false;
  for (let i = 0; i < 170; i++) { // ~5.7s：两针绷带的时间
    m.update(tick);
    if (wasHealing) healDrift += dist(b.x, b.z, prevX, prevZ);
    wasHealing = b.healTime > 0;
    prevX = b.x; prevZ = b.z;
  }
  const heals = m.events.filter((e) => e.type === 'healStart' && e.player === 'b0');
  assert.ok(heals.length >= 2, `应至少开始两次治疗，实际 ${heals.length}`);
  assert.ok(b.hp >= 75, `治疗后血线应回到 75+，实际 ${b.hp}`);
  assert.ok(healDrift < 0.6, `治疗期间应静止（移动会打断），实际漂移 ${healDrift.toFixed(2)}m`);
});

test('ai 行为：圈外 bot 朝安全区移动（跑毒优先）', () => {
  const m = soloBot({ seed: 12 });
  const b = m.players[0];
  m.cars.length = 0; // 排除「绕路开车」分支，验证徒步跑毒本身
  // 找一对「直线可走」的锚点当起点/圈心：测的是跑毒决策，不依赖 A* 绕障能力
  const anchors = m.world.spawnAnchors.filter((a) => !m.world.blocked(a.x, a.z, 1.0));
  let scene = null;
  outer:
  for (const s of anchors) {
    for (const z of anchors) {
      const d = dist(s.x, s.z, z.x, z.z);
      if (d < 45 || d > 75) continue;
      if (!m.world.nav.pathClear(s.x, s.z, z.x, z.z)) continue;
      scene = { s, z };
      break outer;
    }
  }
  assert.ok(scene, '地图上应存在直线可达的起点/圈心组合');
  b.x = scene.s.x; b.z = scene.s.z;
  b.stamina = 100;
  m.zone.x = scene.z.x; m.zone.z = scene.z.z; m.zone.r = 25;
  m.zone.target = { x: scene.z.x, z: scene.z.z, r: 25 };
  m.zone.closing = false;
  m.zone.phase = 0;
  m.zone.damage = 5;
  m.zone.nextIn = 30;
  const d0 = dist(b.x, b.z, scene.z.x, scene.z.z);
  const phases = new Set();
  for (let i = 0; i < 120; i++) { // 4s
    m.update(tick);
    if (b.think && b.think.phase) phases.add(b.think.phase);
  }
  const d1 = dist(b.x, b.z, scene.z.x, scene.z.z);
  assert.ok(d1 < d0 - 12, `圈外应向圈心移动：${d0.toFixed(1)}m → ${d1.toFixed(1)}m`);
  assert.ok(phases.has('zone'), `跑毒途中应处于 zone 阶段，实际阶段集 [${[...phases].join(',')}]`);
});

test('ai 行为：残血遇敌时朝遮挡视线的掩体点移动', () => {
  const m = new Match({ seed: 13, mode: 'squad', maxPlayers: 4, duration: 180, difficulty: 'elite' });
  m.addPlayer('b0', 'Bot0', { bot: true, team: 0, difficulty: 'elite' });
  m.start();
  m.players.length = 1;
  m.dropsLeft = 0;
  m.zone.nextIn = 99999;
  // 找一个「暴露位 + 视线通敌 + 9m 内存在挡视线掩体点」的场景，
  // 且该掩体点必须落在 findCover 的同一采样环上（保证必然被找到）。
  const world = m.world;
  let scene = null;
  outer:
  for (const s of (world.spawnAnchors || []).concat(world.lootSpots || [])) {
    if (world.blocked(s.x, s.z, 1.0)) continue;
    for (let ai = 0; ai < 16; ai++) {
      const a = (ai / 16) * Math.PI * 2;
      const ex = s.x + Math.sin(a) * 15;
      const ez = s.z + Math.cos(a) * 15;
      if (world.blocked(ex, ez, 1.0)) continue;
      if (world.clearLine({ x: s.x, z: s.z }, { x: ex, z: ez }) !== true) continue;
      const baseA = Math.atan2(s.x - ex, s.z - ez);
      for (let i = 0; i < 16; i++) {
        const ca = baseA + (i / 16) * Math.PI * 2;
        const r = 2.2 + (i % 4) * 2.3;
        const px = s.x + Math.sin(ca) * r;
        const pz = s.z + Math.cos(ca) * r;
        if (world.blocked(px, pz, 0.65)) continue;
        if (world.clearLine({ x: px, z: pz }, { x: ex, z: ez }) !== false) continue;
        scene = { bx: s.x, bz: s.z, ex, ez };
        break outer;
      }
    }
  }
  assert.ok(scene, '地图上应存在可复现的掩体场景');
  const b = m.players[0];
  const e = m.addPlayer('e0', 'Enemy', { bot: true, team: 1, difficulty: 'elite' });
  e.bot = false; // 木桩敌人：站着不动、不开枪
  e.input = { mx: 0, mz: 0, aim: 0 };
  b.x = scene.bx; b.z = scene.bz;
  e.x = scene.ex; e.z = scene.ez;
  b.hp = 30;
  const startX = b.x;
  const startZ = b.z;
  const phases = new Set();
  for (let i = 0; i < 90; i++) {
    m.update(tick);
    if (b.think && b.think.phase) phases.add(b.think.phase);
  }
  assert.ok(phases.has('cover'), `应进入掩体阶段，实际阶段集 [${[...phases].join(',')}]`);
  assert.ok(b.think.cover, 'bot 应缓存一个掩体点');
  assert.equal(
    world.clearLine({ x: b.think.cover.x, z: b.think.cover.z }, { x: e.x, z: e.z }),
    false,
    '掩体点必须挡住敌人视线',
  );
  assert.ok(dist(b.x, b.z, startX, startZ) > 1, 'bot 应实际朝掩体移动过');
});

/** 全 AI 对局 + 状态指纹（确定性对照用）。 */
function battle(seed, ticks) {
  const m = new Match({ seed, mode: 'squad', maxPlayers: 24, duration: 300, difficulty: 'veteran' });
  for (let t = 0; t < 6; t++) {
    for (let k = 0; k < 4; k++) m.addPlayer(`b${t}_${k}`, `B${t}${k}`, { bot: true, team: t });
  }
  m.start();
  for (let i = 0; i < ticks && m.phase !== 'ended'; i++) m.update(tick);
  return m;
}

function fingerprint(m) {
  return JSON.stringify({
    time: m.time, tick: m.tickCount, phase: m.phase, ev: m.eventId,
    zone: { x: m.zone.x, z: m.zone.z, r: m.zone.r, phase: m.zone.phase, closing: m.zone.closing },
    kills: m.counters.kills, shots: m.counters.shots,
    taken: m.loot.filter((l) => l.taken).length,
    cars: m.cars.map((c) => [c.x, c.z, c.hp, c.driver]).join(';'),
    players: m.players.map((p) => [p.id, +p.x.toFixed(4), +p.z.toFixed(4), +p.hp.toFixed(4),
      p.alive ? 1 : 0, p.downed ? 1 : 0, p.kills, p.slot, p.armorTier, p.car].join(',')),
  });
}

test('ai 确定性：相同 seed 两局全 AI 对局 40s 后状态逐位一致', () => {
  const a = fingerprint(battle(2024, 1200));
  const b = fingerprint(battle(2024, 1200));
  assert.equal(a, b, '同 seed 两局的完整状态指纹应完全一致');
});

test('ai 确定性：不同 seed 的对局走势不同（对照，防指纹恒等）', () => {
  const a = fingerprint(battle(2024, 400));
  const c = fingerprint(battle(9527, 400));
  assert.notEqual(a, c);
});

test('ai 纯净：ai.mjs 无 Math.random / DOM / Node API / 时钟', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../shared/ai.mjs', import.meta.url), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/Math\.random/.test(body), false, '禁止 Math.random（随机性必须走 per-bot PRNG）');
  assert.equal(/\bwindow\./.test(body), false, '禁止 window');
  assert.equal(/\bdocument\./.test(body), false, '禁止 document');
  assert.equal(/\bprocess\./.test(body), false, '禁止 process');
  assert.equal(/\bperformance\.now/.test(body), false, '禁止 performance.now');
  assert.equal(/\bDate\.now/.test(body), false, '禁止 Date.now');
  assert.equal(/\brequire\(/.test(body), false, '禁止 require');
  assert.equal(/\bsetTimeout\(|\bsetInterval\(/.test(body), false, '禁止定时器');
});
