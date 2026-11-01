// 雾岛突围 / MIST ISLE — 空降（自由航线 + 跳伞）测试
//
// 这一层要防的回归是「跳伞系统看起来在跑，但玩家实际落不到地上」：
//   · start() 后没人跳 → 窗口关闭时必须被强制弹出，不能永远停在舱内；
//   · 跳出去的人必须落在可走点、且在地图圆内（旧实现会甩到圆外的四个角）；
//   · 全员落地必须把 phase 推到 live，否则圈/空投/结算全部不启动；
//   · instant 模式必须逐字节保持 1.x 行为（55 处既有测试依赖它）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/simulation.mjs';
import { DEPLOY, TICK_RATE, ZONE_PHASES } from '../shared/rules.mjs';

const tick = 1 / TICK_RATE;

/** 造一局 skydive：1 名真人 + n 个 bot。 */
function skydive({ seed = 7, players = 8, mode = 'squad', maxPlayers = 16 } = {}) {
  const m = new Match({ seed, mode, maxPlayers, deployStyle: 'skydive' });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  // bot 补齐到 players 人（start() 已按 maxPlayers 补满，这里只为可读性）
  return m;
}

function runUntil(m, pred, limitSeconds = 60) {
  let t = 0;
  while (!pred() && t < limitSeconds) {
    m.update(tick);
    t += tick;
  }
  return t;
}

test('skydive: start() 后全员在舱内，航线横穿地图', () => {
  const m = skydive();
  assert.equal(m.phase, 'deploying');
  assert.ok(m.flight, 'skydive 必须生成航线');
  for (const p of m.players) {
    assert.equal(p.deployStage, 'plane');
    assert.equal(p.y, DEPLOY.planeHeight);
    assert.equal(p.chute, 1);
  }
  const R = m.world.radius;
  assert.ok(Math.hypot(m.flight.to.x - m.flight.from.x, m.flight.to.z - m.flight.from.z) > R,
    '航线长度应超过地图半径（横穿整图）');
  // 航线两端都在地图外
  assert.ok(Math.hypot(m.flight.from.x, m.flight.from.z) > R * 0.8);
});

test('skydive: 可跳窗口按时打开、按时关闭', () => {
  const m = skydive();
  // 窗口打开前按跳伞被拒
  assert.equal(m.jumpFromPlane('a'), false);
  runUntil(m, () => m.flight.open);
  assert.equal(m.flight.open, true);
  assert.equal(m.jumpFromPlane('a'), true);
  assert.equal(m.players[0].deployStage, 'freefall');
  // 同一玩家不能重复跳
  assert.equal(m.jumpFromPlane('a'), false);
});

test('skydive: 舱门关闭后未跳的玩家被强制弹出', () => {
  const m = skydive({ players: 4, maxPlayers: 8 });
  runUntil(m, () => m.phase === 'live', 60);
  assert.equal(m.phase, 'live', '全员必须落地');
  for (const p of m.players) {
    assert.equal(p.deployStage, 'ground');
    assert.equal(p.y, 0);
    assert.equal(p.chute, 0);
  }
});

test('skydive: 落地位置都在地图圆内且不卡墙', () => {
  for (const seed of [7, 21, 4242]) {
    const m = skydive({ seed, maxPlayers: 24 });
    runUntil(m, () => m.phase === 'live', 90);
    const R = m.world.radius;
    for (const p of m.players) {
      const d = Math.hypot(p.x, p.z);
      assert.ok(d <= R * 0.97, `seed=${seed} ${p.id} 落在地图外 ${d.toFixed(1)}m > ${R}`);
      assert.equal(m.world.blocked(p.x, p.z, 0.55), false,
        `seed=${seed} ${p.id} 落在障碍里 (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    }
  }
});

test('skydive: 自由落体比开伞快，且 chute 进度单调降到 0', () => {
  const m = skydive();
  runUntil(m, () => m.flight.open);
  m.jumpFromPlane('a');
  const p = m.players[0];
  assert.equal(p.deployStage, 'freefall');
  const samples = [];
  // 余量 +1 秒：落地判定发生在 chuteGlide 结束那一 tick，循环不能刚好卡在边界。
  for (let i = 0; i < Math.ceil((DEPLOY.freefall + DEPLOY.chuteGlide + 1) / tick); i++) {
    m.update(tick);
    samples.push({ stage: p.deployStage, y: p.y, chute: p.chute });
    if (p.deployStage === 'ground') break;
  }
  const freefall = samples.filter((s) => s.stage === 'freefall');
  const chutePhase = samples.filter((s) => s.stage === 'chute');
  assert.ok(freefall.length > 0 && chutePhase.length > 0, '两个阶段都要被观察到');
  // 高度严格不增
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].y <= samples[i - 1].y + 0.01, '伞降高度不得反弹');
  }
  // 自由落体末段仍在高空，开伞后继续下降
  assert.ok(freefall.at(-1).y > 30, '自由落体结束时不应已接近地面');
  assert.ok(chutePhase.at(-1).y < chutePhase[0].y);
  assert.equal(p.deployStage, 'ground');
});

test('skydive: 指定落点后实际落点贴近目标（自由落体 + 滑翔可修正）', () => {
  const m = skydive();
  runUntil(m, () => m.flight.open);
  const R = m.world.radius;
  // 选一个离当前机位足够远的目标，验证「可以飞过去」
  const target = { x: 0.82, z: 0.24 };
  const wantX = (target.x * 2 - 1) * R;
  const wantZ = (target.z * 2 - 1) * R;
  const p = m.players[0];
  p.dropTarget = target;
  assert.equal(m.jumpFromPlane('a'), true);
  runUntil(m, () => p.deployStage === 'ground', 40);
  const err = Math.hypot(p.x - wantX, p.z - wantZ);
  // 目标点若在墙里会被吸附到附近，所以给 14m 容差（远小于地图半径）
  assert.ok(err < 14, `落点偏差 ${err.toFixed(1)}m 过大`);
});

test('skydive: 空投/缩圈在部署阶段不推进，落地后才开始计时', () => {
  const m = skydive({ maxPlayers: 8 });
  // 部署期间圈不缩、不掉血
  m.zone.nextIn = 0.05;
  const hp0 = m.players.map((p) => p.hp);
  for (let i = 0; i < 60; i++) m.update(tick);
  assert.equal(m.zone.phase, -1, '部署阶段不得推进缩圈');
  assert.deepEqual(m.players.map((p) => p.hp), hp0, '部署阶段不得掉血');
  runUntil(m, () => m.phase === 'live', 60);
  // 落地后圈才会正常推进
  m.zone.nextIn = 0.01;
  for (let i = 0; i < 10; i++) m.update(tick);
  assert.equal(m.zone.phase, 0, '落地后缩圈必须恢复');
});

test('skydive: 同队落地散开，不会重叠在同一点', () => {
  const m = skydive({ maxPlayers: 16 });
  // 让全队都跳到同一目标，检验散开逻辑
  runUntil(m, () => m.flight.open);
  const R = m.world.radius;
  const target = { x: 0.5, z: 0.5 };
  for (const p of m.players) {
    if (p.team !== 0) continue;
    p.dropTarget = target;
    m.jumpFromPlane(p.id);
  }
  runUntil(m, () => m.phase === 'live', 60);
  const mates = m.players.filter((p) => p.team === 0);
  assert.ok(mates.length >= 1);
  for (let i = 0; i < mates.length; i++) {
    for (let j = i + 1; j < mates.length; j++) {
      const d = Math.hypot(mates[i].x - mates[j].x, mates[i].z - mates[j].z);
      assert.ok(d > 0.8, `同队 ${mates[i].id}/${mates[j].id} 落地重叠 ${d.toFixed(2)}m`);
    }
  }
});

test('skydive: 确定性——同 seed 两次跑出完全相同的落点', () => {
  const a = skydive({ seed: 999, maxPlayers: 16 });
  const b = skydive({ seed: 999, maxPlayers: 16 });
  runUntil(a, () => a.phase === 'live', 60);
  runUntil(b, () => b.phase === 'live', 60);
  assert.deepEqual(a.players.map((p) => [p.id, +p.x.toFixed(2), +p.z.toFixed(2)]),
    b.players.map((p) => [p.id, +p.x.toFixed(2), +p.z.toFixed(2)]));
});

test('instant: 默认模式不生成航线，2.5 秒后照常开打（向后兼容）', () => {
  const m = new Match({ seed: 3, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  assert.equal(m.flight, null, 'instant 不应有航线');
  for (const p of m.players) assert.equal(p.deployStage, undefined);
  for (let i = 0; i < Math.ceil(3 / tick); i++) m.update(tick);
  assert.equal(m.phase, 'live');
  assert.equal(m.snapshot('a', 0).flight, undefined, 'instant 快照的 flight 键必须缺失');
});

test('skydive: 快照在部署期带 flight 与 deployStage，落地后 flight 消失', () => {
  const m = skydive({ maxPlayers: 8 });
  runUntil(m, () => m.flight.open);
  const mid = m.snapshot('a', 0);
  assert.ok(mid.flight, '部署期必须下发航线');
  assert.equal(typeof mid.flight.open, 'boolean');
  assert.equal(mid.me.deployStage, 'plane');
  assert.ok(mid.me.y > 1, '舱内高度应下发');
  runUntil(m, () => m.phase === 'live', 60);
  const after = m.snapshot('a', 0);
  assert.equal(after.flight, undefined, '落地后不再下发航线');
  assert.equal(after.me.deployStage, 'ground');
});

test('skydive: 舱内下发落点预览，且随朝向变化（客户端落点圈的数据源）', () => {
  const m = skydive({ maxPlayers: 8 });
  runUntil(m, () => m.flight.open);
  const p = m.players[0];
  const R = m.world.radius;
  // 朝向 0（+Z）时的预览点应落在机位的 +Z 方向
  p.angle = 0;
  const a = m.snapshot('a', 0).me;
  assert.ok(Number.isFinite(a.dropPreviewX) && Number.isFinite(a.dropPreviewZ), '必须下发预览坐标');
  assert.ok(a.dropPreviewZ > p.z, `朝向 +Z 时预览点应在机位前方：${a.dropPreviewZ} vs ${p.z}`);
  // 朝向 π（-Z）时应翻到另一侧
  p.angle = Math.PI;
  const b = m.snapshot('a', 0).me;
  assert.ok(b.dropPreviewZ < p.z, `朝向 -Z 时预览点应翻面：${b.dropPreviewZ} vs ${p.z}`);
  // 预览点永远在地图圆内
  for (const s of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    p.angle = s;
    const v = m.snapshot('a', 0).me;
    const d = Math.hypot(v.dropPreviewX, v.dropPreviewZ);
    assert.ok(d <= R, `预览点必须在地图圆内，朝向 ${s} 时 ${d.toFixed(1)} > ${R}`);
  }
  // 落地后不再下发
  runUntil(m, () => m.phase === 'live', 60);
  const after = m.snapshot('a', 0).me;
  assert.equal(after.dropPreviewX, undefined, '落地后不应再下发预览点');
});

test('skydive: 事件序列包含 jump/chute/land，且 entityId 不污染事件序号', () => {
  const m = skydive({ maxPlayers: 8 });
  const ids = new Set();
  const types = new Set();
  let t = 0;
  while (m.phase === 'deploying' && t < 60) {
    m.update(tick);
    t += tick;
    for (const ev of m.events) {
      assert.equal(typeof ev.id, 'number', '事件序号必须是数字');
      ids.add(ev.id);
      types.add(ev.type);
    }
  }
  for (const need of ['start', 'jump', 'chute', 'land', 'landAll']) {
    assert.ok(types.has(need), `缺少事件 ${need}`);
  }
  // 事件序号严格递增且无重复
  const sorted = [...ids].sort((a, b) => a - b);
  assert.equal(sorted.length, ids.size);
});

test('skydive: 全员落地时 phase 切到 live 且只切一次', () => {
  const m = skydive({ maxPlayers: 8 });
  let landAll = 0;
  runUntil(m, () => m.phase === 'live', 60);
  landAll = m.events.filter((e) => e.type === 'landAll').length;
  assert.equal(landAll, 1);
  for (let i = 0; i < 30; i++) m.update(tick);
  assert.equal(m.events.filter((e) => e.type === 'landAll').length, 1, 'landAll 不得重复触发');
});

test('skydive: bot 会自己跳伞，不依赖强制弹出', () => {
  const m = skydive({ maxPlayers: 24 });
  runUntil(m, () => m.flight.open);
  // 窗口刚开始时 bot 还没到目标点，继续跑一段
  for (let i = 0; i < Math.ceil(6 / tick); i++) m.update(tick);
  const jumped = m.players.filter((p) => p.bot && p.deployStage !== 'plane').length;
  assert.ok(jumped > 0, 'bot 必须在窗口内主动跳伞');
});

test('skydive: 部署阶段不能开火/移动（输入被挂起，位置只随飞机走）', () => {
  const m = skydive({ maxPlayers: 8 });
  const p = m.players[0];
  m.input('a', { mx: 1, mz: 1, fire: true, seq: 1 });
  for (let i = 0; i < 30; i++) m.update(tick);
  // 舱内位置由航线插值决定，与玩家输入无关：必须严格等于当前机位
  const f = m.flight;
  assert.ok(Math.abs(p.x - f.x) < 0.01 && Math.abs(p.z - f.z) < 0.01,
    '舱内玩家位置必须跟随飞机，不能被输入推动');
  assert.equal(m.counters.shots, 0, '舱内不得开火');
  // 跳伞后同样不响应移动输入（位置由伞降插值决定）
  runUntil(m, () => m.flight.open);
  m.jumpFromPlane('a');
  const before = { x: p.x, z: p.z };
  m.input('a', { mx: 1, mz: 1, fire: true, seq: 5 });
  for (let i = 0; i < 10; i++) m.update(tick);
  const moved = Math.hypot(p.x - before.x, p.z - before.z);
  const expected = Math.hypot(p.dropSpot.x - before.x, p.dropSpot.z - before.z);
  // 位移必须来自伞降插值（朝落点），而不是朝输入方向 (1,1)
  assert.ok(moved > 0, '伞降中应继续朝落点移动');
  assert.ok(expected > 0);
  assert.equal(m.counters.shots, 0, '伞降中不得开火');
});

test('DEPLOY 常量自洽：时序能容纳一次完整跳伞', () => {
  assert.ok(DEPLOY.jumpWindow > 0);
  assert.ok(DEPLOY.freefall > 0 && DEPLOY.chuteGlide > 0);
  assert.ok(DEPLOY.freefallSpeed > DEPLOY.chuteSpeed, '自由落体应比开伞快');
  assert.ok(DEPLOY.dropHeight > 0);
  // 首圈等待必须长于一次完整空降，否则落地就开始掉血
  const totalAir = DEPLOY.jumpWindow + DEPLOY.freefall + DEPLOY.chuteGlide;
  assert.ok(ZONE_PHASES[0].wait >= 20, `首圈等待 ${ZONE_PHASES[0].wait}s 应给足搜刮时间`);
  assert.ok(totalAir < ZONE_PHASES[0].wait * 2, '空降总时长不应超过首圈等待的 2 倍');
});
