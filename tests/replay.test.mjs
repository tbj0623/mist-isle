// 雾岛突围 / MIST ISLE — 死亡回放录制器测试（node --test tests/replay.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayRecorder, FLAG, REPLAY_TICK_RATE } from '../shared/replay.mjs';
import { Match } from '../shared/simulation.mjs';
import { TICK_RATE } from '../shared/rules.mjs';

const tick = 1 / TICK_RATE;
const MAX_BYTES = 1.5 * 1024 * 1024;

/** 最小可控对局：1 名真人 + 1 个静止 bot。 */
function duel() {
  const m = new Match({ seed: 7, mode: 'squad', maxPlayers: 4, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  m.players.length = 1;
  m.players[0].x = 0; m.players[0].z = 0; m.players[0].angle = 0;
  const b = m.addPlayer('b0', 'Bot0', { bot: true, team: 1 });
  b.x = 0; b.z = 40;
  m.zone.nextIn = 9999;
  m.dropsLeft = 0;
  return m;
}

test('1. 采样上限：30Hz 跑 300 tick / sampleEvery=3 只留 100 帧，超出 maxFrames 从头丢', () => {
  const m = duel();
  const rec = new ReplayRecorder({ maxFrames: 50, sampleEvery: 3 });
  for (let i = 0; i < 300; i++) { m.update(tick); rec.sample(m); }
  assert.equal(rec.size, 50, '帧数被 maxFrames 夹住');
  assert.equal(rec.bytes > 0, true);
  // 保留的必须是最新的：末帧时间等于最后一次采样时刻附近
  const last = rec.frames[rec.size - 1];
  assert.ok(last.t > 9.0, `末帧应接近当前时间，实际 ${last.t}`);
  // 帧结构契约
  assert.equal(typeof last.t, 'number');
  assert.ok(Array.isArray(last.p) && last.p.length >= 2);
  const row = last.p.find((x) => x[0] === 'a');
  assert.ok(row, '真人 a 在帧里');
  assert.equal(row.length, 6, '[id,x,z,angle,hp,flags]');
});

test('2. lastSeconds：5 秒窗口 ≈ 5×30/3 = 50 帧，且首帧不早于窗口起点', () => {
  const m = duel();
  const rec = new ReplayRecorder({ sampleEvery: 3 });
  for (let i = 0; i < 30 * 20; i++) { m.update(tick); rec.sample(m); }
  const w = rec.lastSeconds(5);
  assert.ok(w.frames.length >= 48 && w.frames.length <= 52, `5s 窗口帧数 ${w.frames.length}`);
  assert.equal(w.tickRate, REPLAY_TICK_RATE);
  const last = rec.frames[rec.size - 1].t;
  assert.ok(w.frames[0].t >= last - 5.05, '窗口不越界');
  assert.ok(w.events.length >= 0);
  // 全量 lastSeconds 比 2s 长
  assert.ok(w.frames.length > rec.lastSeconds(2).frames.length);
});

test('3. aroundDeath：以 kill 事件为轴定位死者/击杀者', () => {
  const m = duel();
  const rec = new ReplayRecorder({ sampleEvery: 1 });
  for (let i = 0; i < 30 * 6; i++) { m.update(tick); rec.sample(m); }
  const victim = m.players[0];
  const killer = m.players[1];
  m.kill(victim, killer.id, 'shot');
  rec.sample(m);
  const r = rec.aroundDeath(victim.id, killer.id, 4.5);
  assert.equal(r.victimId, victim.id);
  assert.equal(r.killerId, killer.id);
  assert.equal(r.tickRate, REPLAY_TICK_RATE);
  assert.ok(r.frames.length > 0, '有帧');
  assert.ok(r.frames.length <= 4.5 * 30 + 30, '时间窗被夹住');
  assert.ok(r.events.some((e) => e.type === 'kill' && e.p === victim.id), 'kill 在窗口事件里');
  // 死者在末帧 flags 里 ALIVE 位必须为 0
  const tail = r.frames[r.frames.length - 1];
  const row = tail.p.find((x) => x[0] === victim.id);
  assert.ok(row, '死者出现在帧里');
  assert.equal(row[5] & FLAG.ALIVE, 0, '死亡后不再带 ALIVE');
});

test('4. 空 match / 坏输入不崩：无帧时返回空结构，非法参数不抛错', () => {
  const rec = new ReplayRecorder();
  assert.equal(rec.size, 0);
  const empty = rec.lastSeconds(5);
  assert.deepEqual([empty.frames.length, empty.events.length, empty.tickRate], [0, 0, 30]);
  const dead = rec.aroundDeath('nobody', null, 4);
  assert.deepEqual([dead.frames.length, dead.victimId, dead.killerId], [0, 'nobody', null]);
  assert.doesNotThrow(() => rec.sample(null));
  assert.doesNotThrow(() => rec.sample({}));
  assert.doesNotThrow(() => rec.sample({ players: [], events: [] }));
  assert.equal(rec.size, 0);
  assert.equal(rec.recordEvent(null), null);
  assert.equal(rec.recordEvent({ type: 'zone' }), null, '非 shot/hit/kill 不入库');
  rec.clear();
  assert.equal(rec.size, 0);
  assert.equal(rec.bytes, 0);
});

test('5. 大小估算：900 帧 × 32 人全场 + 240 事件 < 1.5MB', () => {
  const players = [];
  for (let i = 0; i < 32; i++) {
    players.push({
      id: `p${i}-xxxxxxxx`, x: -181.367 + i, z: 179.444 - i, angle: 6.2831,
      hp: 100, alive: i % 7 !== 0, downed: false, state: i % 3 ? 'normal' : 'crouch', car: i % 5 ? null : 3,
    });
  }
  const match = { time: 0, players, events: [] };
  const rec = new ReplayRecorder({ sampleEvery: 1, maxFrames: 900 });
  for (let i = 0; i < 900; i++) {
    match.time = i / 30;
    match.events = [
      { id: i * 3 + 1, type: 'shot', time: match.time, player: 'p0-xxxxxxxx', x: 12.34, z: -5.67, tx: 40.1, tz: 11.9, weapon: 'ar7' },
      { id: i * 3 + 2, type: 'hit', time: match.time, player: 'p1-xxxxxxxx', by: 'p0-xxxxxxxx', x: 3, z: 4 },
      { id: i * 3 + 3, type: 'kill', time: match.time, player: 'p2-xxxxxxxx', by: 'p0-xxxxxxxx', reason: 'shot', name: '旅人二号' },
    ];
    rec.sample(match);
  }
  assert.equal(rec.size, 900);
  const jsonBytes = Buffer.byteLength(JSON.stringify(rec.lastSeconds(30)), 'utf8');
  assert.ok(jsonBytes < MAX_BYTES, `30s 窗口 ${jsonBytes} 字节应 < 1.5MB`);
  assert.ok(rec.bytes < MAX_BYTES, `估算字节 ${rec.bytes} 应 < 1.5MB`);
  assert.ok(rec.events.length <= 240, '事件队列有上限');
});

test('6. 帧率与标志位：sampleEvery 生效、fired/car/crouch 合成位掩码', () => {
  const fake = {
    time: 1.5,
    players: [
      { id: 'a', x: 1.04, z: -2.06, angle: 0.005, hp: 61.4, alive: true, downed: false, state: 'crouch', car: 2 },
      { id: 'b', x: 9, z: 9, angle: 3, hp: 0, alive: false, downed: true, state: 'dead', car: null },
    ],
    events: [{ id: 1, type: 'shot', time: 1.5, player: 'a', x: 1, z: -2 }],
  };
  const rec = new ReplayRecorder({ sampleEvery: 5 });
  for (let i = 0; i < 4; i++) rec.sample(fake); // 4 tick < 5，还没落帧
  assert.equal(rec.size, 0);
  const frame = rec.sample(fake);
  assert.equal(rec.size, 1);
  assert.equal(frame.t, 1.5);
  const [a, b] = frame.p;
  assert.deepEqual([a[1], a[2], a[3], a[4]], [1, -2.1, 0.01, 61], '坐标 1 位小数 / 角度 2 位 / hp 取整');
  assert.equal(a[5], FLAG.ALIVE | FLAG.FIRE | FLAG.CROUCH | FLAG.VEHICLE);
  assert.equal(b[5], FLAG.DOWNED, '未开火、非蹲、非车上');
});
