// 雾岛突围 / MIST ISLE — 二进制快照编解码测试（node --test tests/wire.test.mjs）
//
// 覆盖目标：`shared/wire.mjs` 是「在 snapshot() 之上的一层编码」，它的正确性直接决定
// 联机模式能不能用二进制传输。这里锁死四件事：
//   1. 往返一致：encode → decode 后，所有字段与原始快照在量化容差内一致；
//   2. 量化边界：位置/角度/生命/时间在极值、负数、NaN、Infinity 下都不崩、不漂移超限；
//   3. 体积：64 人满房快照必须压到 JSON 的 25% 以内（否则这套协议没有存在意义）；
//   4. 健壮性：截断帧、错误版本、空 roster、超长昵称、未知字段都必须给出明确行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/simulation.mjs';
import * as W from '../shared/wire.mjs';

// ── 工具 ──────────────────────────────────────────────────────────────────────
/** 建一局 n 人的对局并推进 tick 次，返回快照 + 编解码上下文。 */
function buildSnapshot({ players = 16, ticks = 120, seed = 1234, bot = true } = {}) {
  const m = new Match({ seed, mode: 'squad', maxPlayers: 64 });
  m.addPlayer('me', '我', { bot: false, team: 0 });
  for (let i = 1; i < players; i++) {
    m.addPlayer(`b${i}`, `机器人${i}`, { bot, team: (i / 4) | 0 });
  }
  m.start();
  for (let t = 0; t < ticks; t++) m.update(1 / 30);
  const state = m.snapshot('me', 0);
  const roster = W.rosterFromPlayers(state.players);
  return { match: m, state, roster, ctx: W.createWireContext({ roster }) };
}

const roundtrip = (state, ctx) => {
  const bytes = W.encodeStateFrame(state, ctx);
  return { bytes, decoded: W.decodeStateFrame(bytes, ctx).state };
};

/** 角度差（归一到 [-π, π]）。 */
function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

// ── 1. 基础 API ──────────────────────────────────────────────────────────────
test('wire: 常量与量化比例是有限正数', () => {
  assert.equal(W.WIRE_VERSION, 1);
  assert.equal(W.FRAME_STATE, 1);
  for (const [k, v] of Object.entries(W.QUANT)) {
    assert.ok(Number.isFinite(v) && v > 0, `QUANT.${k} 必须是正数，实际 ${v}`);
  }
});

test('wire: varint 往返覆盖 0 到 2^32，且报告正确字节数', () => {
  const cases = [0, 1, 127, 128, 255, 256, 16383, 16384, 2 ** 20, 2 ** 31, 2 ** 32 - 1];
  for (const v of cases) {
    const enc = W.encodeVarint(v);
    assert.ok(enc.length > 0, `varint(${v}) 不应为空`);
    // decodeVarint 返回 { value, bytes }：调用方需要知道消耗了几个字节才能继续读。
    const dec = W.decodeVarint(enc);
    assert.equal(dec.value, v, `varint 往返不一致：${v}`);
    assert.equal(dec.bytes, enc.length, `varint(${v}) 报告的字节数与实际不符`);
  }
});

test('wire: createWireContext 容忍空 roster 与脏数据', () => {
  assert.doesNotThrow(() => W.createWireContext());
  assert.doesNotThrow(() => W.createWireContext({}));
  assert.doesNotThrow(() => W.createWireContext({ roster: null }));
  const ctx = W.createWireContext({ roster: [null, {}, { id: 'a' }, { id: 'b', name: null }] });
  assert.ok(ctx && ctx.table, '空/脏 roster 也必须建出可用上下文');
});

test('wire: rosterFromPlayers 跳过空项并截断超长名单', () => {
  const list = W.rosterFromPlayers([null, { id: 'a', name: 'A' }, {}, { id: 'b', name: 'B', team: 1 }]);
  assert.equal(list.length, 2, '只应保留有 id 的项');
  assert.equal(list[0].id, 'a');
  // 超过 MAX_ROSTER(254) 时截断，不抛错
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `n${i}` }));
  const capped = W.rosterFromPlayers(many);
  assert.ok(capped.length <= 254, `roster 应被截断到 254 以内，实际 ${capped.length}`);
});

// ── 2. 往返一致性 ────────────────────────────────────────────────────────────
test('wire: 16 人快照往返后玩家数、队伍、存活状态一致', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 120 });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(decoded.players.length, state.players.length, '玩家数必须一致');
  const byId = new Map(decoded.players.map((p) => [p.id, p]));
  for (const src of state.players) {
    const got = byId.get(src.id);
    assert.ok(got, `玩家 ${src.id} 在解码结果中丢失`);
    assert.equal(got.team, src.team, `玩家 ${src.id} 的队伍不一致`);
    assert.equal(got.alive, src.alive, `玩家 ${src.id} 的存活状态不一致`);
    assert.equal(got.bot, src.bot, `玩家 ${src.id} 的 bot 标记不一致`);
  }
});

test('wire: 位置量化误差在 0.05m 容差内', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 300 });
  const { decoded } = roundtrip(state, ctx);
  const byId = new Map(decoded.players.map((p) => [p.id, p]));
  let maxErr = 0;
  for (const src of state.players) {
    const got = byId.get(src.id);
    if (!got) continue;
    maxErr = Math.max(maxErr, Math.hypot(src.x - got.x, src.z - got.z));
  }
  // 量化步长 0.05m，x/z 各取整 → 曼哈顿最大 0.05，欧氏最大 0.05*√2 ≈ 0.071
  assert.ok(maxErr <= 0.08, `位置误差超限：${maxErr.toFixed(4)}m`);
});

test('wire: 角度量化误差在 0.01° 内', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 60 });
  const { decoded } = roundtrip(state, ctx);
  const byId = new Map(decoded.players.map((p) => [p.id, p]));
  let maxErr = 0;
  for (const src of state.players) {
    const got = byId.get(src.id);
    if (!got) continue;
    maxErr = Math.max(maxErr, angleDiff(src.angle, got.angle));
  }
  assert.ok(maxErr <= (0.01 * Math.PI) / 180, `角度误差超限：${((maxErr * 180) / Math.PI).toFixed(4)}°`);
});

test('wire: 生命/护甲按 0.01 精度往返', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 60 });
  const { decoded } = roundtrip(state, ctx);
  const byId = new Map(decoded.players.map((p) => [p.id, p]));
  for (const src of state.players) {
    const got = byId.get(src.id);
    if (!got || !src.alive) continue;
    assert.ok(Math.abs(src.hp - got.hp) <= 0.011, `hp 漂移过大 ${src.hp} → ${got.hp}`);
    assert.ok(Math.abs(src.armor - got.armor) <= 0.011, `armor 漂移过大 ${src.armor} → ${got.armor}`);
  }
});

test('wire: 自己（me）的装备与弹药字段完整还原', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 30 });
  assert.ok(state.me, '快照应包含 me');
  const { decoded } = roundtrip(state, ctx);
  assert.ok(decoded.me, '解码后必须有 me');
  assert.equal(decoded.me.id, state.me.id);
  assert.equal(decoded.me.slot, state.me.slot, '当前武器槽不一致');
  assert.equal(decoded.me.weapon, state.me.weapon, '当前武器不一致');
  assert.equal(decoded.me.ammo, state.me.ammo, '弹匣不一致');
  assert.equal(decoded.me.reserve, state.me.reserve, '备弹不一致');
  if (state.me.meds != null) assert.equal(decoded.me.meds, state.me.meds, '医疗包数量不一致');
  if (state.me.grenades != null) assert.equal(decoded.me.grenades, state.me.grenades, '手雷数量不一致');
});

test('wire: 安全区、计数、阶段等全局字段一致', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 900 });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(decoded.mode, state.mode);
  assert.equal(decoded.mapId, state.mapId);
  assert.equal(decoded.phase, state.phase);
  assert.ok(Math.abs(decoded.zone.r - state.zone.r) <= 0.011, `安全区半径漂移: ${state.zone.r} → ${decoded.zone.r}`);
  assert.ok(Math.abs(decoded.zone.damage - state.zone.damage) <= 0.011, '安全区伤害漂移');
  assert.equal(decoded.counts.alive, state.counts.alive, '存活计数不一致');
});

test('wire: 物资列表往返后数量与 id 集合一致', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 60 });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(decoded.loot.length, state.loot.length, '物资数量必须一致');
  const srcIds = new Set(state.loot.map((l) => l.id));
  for (const l of decoded.loot) assert.ok(srcIds.has(l.id), `出现未知物资 id: ${l.id}`);
});

test('wire: 载具列表往返后类型与座位一致', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 60 });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(decoded.cars.length, state.cars.length, '载具数量必须一致');
  for (const src of state.cars) {
    const got = decoded.cars.find((c) => c.id === src.id);
    assert.ok(got, `载具 ${src.id} 丢失`);
    assert.equal(got.type, src.type, `载具 ${src.id} 类型不一致`);
    assert.equal(got.seats, src.seats, `载具 ${src.id} 座位数不一致`);
  }
});

test('wire: 中文昵称不丢失、不被截断', () => {
  const m = new Match({ seed: 9, mode: 'squad', maxPlayers: 8 });
  // 两名人类玩家：bot 的名字会被 start() 的 BOT_NAMES 池覆盖，所以用真人才测得到原样昵称
  m.addPlayer('me', '雾岛旅人', { team: 0 });
  m.addPlayer('p2', '赤砂矿工·阿尔法', { team: 1 });
  m.start();
  const state = m.snapshot('me', 0);
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  const names = decoded.players.map((p) => p.name);
  assert.ok(names.includes('雾岛旅人'), `中文昵称丢失，实际: ${names.join(' / ')}`);
  assert.ok(names.includes('赤砂矿工·阿尔法'), `长中文昵称丢失，实际: ${names.join(' / ')}`);
});

test('wire: 空玩家列表与单人对局都不崩', () => {
  const m = new Match({ seed: 11, mode: 'solo', maxPlayers: 4 });
  m.addPlayer('only', '独狼', { team: 0 });
  m.start();
  const state = m.snapshot('only', 0);
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.ok(decoded.players.length >= 1, '单人局至少要还原出自己');
  assert.equal(decoded.me.id, 'only');
});

test('wire: 同一状态连续编码结果逐字节一致（确定性）', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 60 });
  const a = W.encodeStateFrame(state, ctx);
  const b = W.encodeStateFrame(state, ctx);
  assert.equal(a.length, b.length, '两次编码长度必须一致');
  assert.deepEqual(Array.from(a), Array.from(b), '两次编码内容必须逐字节一致');
});

// ── 3. 体积 ─────────────────────────────────────────────────────────────────
test('wire: 64 人快照压到 JSON 的 25% 以内', () => {
  const { state, ctx } = buildSnapshot({ players: 64, ticks: 600 });
  const json = JSON.stringify(state).length;
  const { bytes } = roundtrip(state, ctx);
  const ratio = bytes.length / json;
  assert.ok(
    ratio <= 0.25,
    `压缩比不达标：${(ratio * 100).toFixed(1)}%（目标 ≤25%，JSON ${json}B / 二进制 ${bytes.length}B）`,
  );
});

test('wire: 二进制载荷随玩家数线性增长且始终小于 JSON', () => {
  for (const n of [8, 16, 32]) {
    const { state, ctx } = buildSnapshot({ players: n, ticks: 120 });
    const json = JSON.stringify(state).length;
    const { bytes } = roundtrip(state, ctx);
    assert.ok(bytes.length < json * 0.5, `${n} 人时压缩效果不足：${bytes.length} vs ${json}`);
  }
});

// ── 4. 健壮性 ───────────────────────────────────────────────────────────────
test('wire: 截断帧抛 WireError 而不是崩溃', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 30 });
  const bytes = W.encodeStateFrame(state, ctx);
  const truncated = bytes.slice(0, Math.max(1, bytes.length >> 1));
  assert.throws(
    () => W.decodeStateFrame(truncated, ctx),
    (err) => err instanceof W.WireError,
  );
});

test('wire: 错误帧类型 / 版本号被明确拒绝', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 30 });
  const bytes = W.encodeStateFrame(state, ctx);
  const badType = Uint8Array.from(bytes);
  badType[0] = 99;
  assert.throws(
    () => W.decodeStateFrame(badType, ctx),
    (err) => err instanceof W.WireError,
  );
  const badVer = Uint8Array.from(bytes);
  badVer[1] = 99;
  assert.throws(
    () => W.decodeStateFrame(badVer, ctx),
    (err) => err instanceof W.WireError,
  );
});

test('wire: 缺少上下文时给出 WireError', () => {
  const { state } = buildSnapshot({ players: 4, ticks: 10 });
  assert.throws(
    () => W.encodeStateFrame(state, null),
    (err) => err instanceof W.WireError,
  );
  assert.throws(
    () => W.decodeStateFrame(new Uint8Array(8), null),
    (err) => err instanceof W.WireError,
  );
});

test('wire: 快照里的 NaN / Infinity / 负数不会污染解码结果', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 30 });
  // 人为注入异常值：真实服务端不会发，但客户端必须扛得住（防篡改/版本错配）
  const dirty = JSON.parse(JSON.stringify(state));
  dirty.me.hp = NaN;
  dirty.me.armor = Infinity;
  dirty.zone.r = -50;
  for (const p of dirty.players) {
    p.x = NaN;
    p.angle = Infinity;
  }
  let decoded;
  assert.doesNotThrow(() => {
    decoded = W.decodeStateFrame(W.encodeStateFrame(dirty, ctx), ctx).state;
  });
  for (const p of decoded.players) {
    assert.ok(Number.isFinite(p.x), `x 不应是 NaN/Infinity，实际 ${p.x}`);
    assert.ok(Number.isFinite(p.angle), `angle 不应是 NaN/Infinity，实际 ${p.angle}`);
  }
  assert.ok(Number.isFinite(decoded.me.hp), 'hp 不应是 NaN');
});

test('wire: 未知额外字段被忽略而不是破坏整帧', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 30 });
  const extra = JSON.parse(JSON.stringify(state));
  extra.__futureField = { nested: [1, 2, 3] };
  extra.me.__futureMeField = 'hello';
  assert.doesNotThrow(() => {
    const dec = W.decodeStateFrame(W.encodeStateFrame(extra, ctx), ctx).state;
    assert.equal(dec.players.length, state.players.length, '未知字段不应影响已知字段');
  });
});

test('wire: roster 少于快照玩家时会优雅降级（不抛错）', () => {
  const { state } = buildSnapshot({ players: 16, ticks: 30 });
  const partial = W.rosterFromPlayers(state.players).slice(0, 4);
  const ctx = W.createWireContext({ roster: partial });
  assert.doesNotThrow(() => {
    const dec = W.decodeStateFrame(W.encodeStateFrame(state, ctx), ctx).state;
    assert.ok(Array.isArray(dec.players), '即使 roster 不全也应产出玩家数组');
  });
});

test('wire: 语音/特效类事件能随快照往返（事件流不丢）', () => {
  const m = new Match({ seed: 88, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('me', '我', { team: 0 });
  m.addPlayer('b1', '敌人', { bot: true, team: 1 });
  m.start();
  for (let t = 0; t < 60; t++) {
    m.input('me', { fire: t % 2 === 0, mx: 0.4, mz: 0.2, seq: t + 1 });
    m.update(1 / 30);
  }
  m.players[0].grenades = 1;
  m.input('me', { throwable: true, aim: 0, seq: 999 });
  for (let t = 0; t < 90; t++) m.update(1 / 30);
  const state = m.snapshot('me', 0);
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.ok(Array.isArray(decoded.events), 'events 必须是数组');
  // 事件 id 必须是数字（历史 bug 的回归点：实体 id 曾覆盖事件序号）
  for (const ev of decoded.events) {
    assert.equal(typeof ev.id, 'number', `事件 ${ev.type} 的 id 必须是数字`);
  }
  assert.ok(decoded.events.length > 0, '对局中应有事件');
});

// ── 5. 结构与字段完整性（与 JSON 路径逐字段对拍）──────────────────────────────
/** 逐层比较：数字按容差、其余严格；返回首个差异描述或 null。 */
function diffValue(a, b, path = '', tol = 0.06) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return Math.abs(a - b) <= tol ? null : `${path}: ${a} != ${b}`;
    }
    return Object.is(a, b) ? null : `${path}: ${a} != ${b}`;
  }
  if (a === b) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diffValue(a[i], b[i], `${path}[${i}]`, tol);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join('|') !== kb.join('|')) return `${path}: keys [${ka.join('|')}] != [${kb.join('|')}]`;
    for (const k of ka) {
      const d = diffValue(a[k], b[k], `${path}.${k}`, tol);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

test('wire: 64 人满载（观战视角）整帧逐字段一致', () => {
  const m = new Match({ seed: 4242, mode: 'squad', maxPlayers: 64 });
  m.addPlayer('me', '我', { team: 0 });
  m.start();
  while (m.players.length < 64) m.addPlayer(`bot${m.players.length}`, `机器人${m.players.length}`, { bot: true });
  for (let t = 0; t < 600; t++) m.update(1 / 30);
  const state = m.snapshot(null, 0);
  assert.equal(state.players.length, 64, '观战快照应包含全部 64 人');
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(m.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(diffValue(state, decoded), null);
});

test('wire: me 的 stats（结算权威累计）完整还原', () => {
  const state = {
    ...buildSnapshot({ players: 8, ticks: 30 }).state,
  };
  state.me = {
    ...state.me,
    stats: {
      shotsFired: 120,
      shotsHit: 61,
      headshots: 9,
      kills: 4,
      downs: 6,
      assists: 2,
      damageDealt: 812.34,
      damageTaken: 455.1,
      pickups: 14,
      revives: 1,
      throws: 3,
      healItems: 5,
      vehicleSeconds: 33.3,
      airdrops: 1,
      dodges: 7,
      weaponsUsed: ['ar7', 'p9'],
    },
  };
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(diffValue(state.me.stats, decoded.me.stats), null);
  assert.deepEqual(decoded.me.stats.weaponsUsed, ['ar7', 'p9']);
});

test('wire: 战利品 ammo 多态字段（字符串 / 数字 / null）原样还原', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 30 });
  const loot = [
    {
      id: 'l1',
      kind: 'weapon',
      item: 'ar7',
      x: 1,
      z: 2,
      y: 0.05,
      qty: 1,
      ammo: 'medium',
      rarity: 'rare',
      attachments: ['red_dot'],
    },
    {
      id: 'l2',
      kind: 'ammo',
      item: 'ammo_box',
      x: 3,
      z: 4,
      y: 0.05,
      qty: 1,
      ammo: 30,
      rarity: 'common',
      attachments: [],
    },
    {
      id: 'l3',
      kind: 'consumable',
      item: 'medkit',
      x: 5,
      z: 6,
      y: 0.05,
      qty: 2,
      ammo: null,
      rarity: 'uncommon',
      attachments: [],
    },
  ];
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip({ ...state, loot }, ctx);
  assert.deepEqual(decoded.loot, loot);
});

test('wire: lootPatch（upsert / remove）差量结构完整还原', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 30 });
  const patch = {
    upsert: [
      {
        id: 'l7',
        kind: 'armor',
        item: 'armor2',
        x: 2,
        z: 3,
        y: 0.05,
        qty: 1,
        ammo: null,
        rarity: 'uncommon',
        attachments: [],
      },
    ],
    remove: ['l8', 'l129'],
  };
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const payload = { ...state, lootPatch: patch };
  delete payload.loot;
  const { decoded } = roundtrip(payload, ctx);
  assert.deepEqual(decoded.lootPatch, patch);
  assert.equal(decoded.loot, undefined, '差量帧不应伪造 loot 数组');
});

test('wire: 玩家多态字段（载具 / 倒地救援 / 掉线 / 空降）往返', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 30 });
  const players = [
    { ...state.players[0], car: 'car3', seat: 0, state: 'vehicle' },
    { ...state.players[1], hp: 0, downed: true, bleedout: 22.5, reviveTarget: state.players[0].id },
    { ...state.players[2], connected: false, alive: false, state: 'dead' },
    { ...state.players[3], chute: 0.42, y: 12.5 },
  ];
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip({ ...state, players }, ctx);
  assert.equal(diffValue(players, decoded.players), null);
});

test('wire: 队友列表（含 isSelf / 载具 / 倒地）往返', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 30 });
  const teammates = [
    {
      id: 'me',
      name: '我',
      x: 1.25,
      z: -2.5,
      alive: true,
      downed: false,
      hp: 87.5,
      bleedout: 0,
      car: null,
      connected: true,
      isSelf: true,
    },
    {
      id: 'b1',
      name: '机器人1',
      x: 3.5,
      z: 4.25,
      alive: false,
      downed: true,
      hp: 0,
      bleedout: 9.5,
      car: 'car2',
      connected: false,
      isSelf: false,
    },
  ];
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip({ ...state, teammates }, ctx);
  assert.equal(diffValue(teammates, decoded.teammates), null);
});

test('wire: 位置在 int16 边界外安全截断（±1638.35m），不回绕', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 10 });
  const players = [
    { ...state.players[0], x: 1638.3, z: -1638.3 },
    { ...state.players[1], x: 99999, z: -99999 },
  ];
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip({ ...state, players }, ctx);
  assert.ok(Math.abs(decoded.players[0].x - 1638.3) <= 0.03);
  // int16 的安全区间是 [-32768, 32767]：正向截到 32767/20 = 1638.35，
  // 负向截到 -32768/20 = -1638.4（比正值多一个量化步长）。
  assert.equal(decoded.players[1].x, 1638.35);
  assert.equal(decoded.players[1].z, -1638.4);
});

test('wire: 角度保留原符号（±π 分界不反向绕圈）', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 10 });
  const angles = [-Math.PI, -1.5708, -0.5, -0.01, 0, 0.01, 1.2345, Math.PI - 1e-6];
  const players = angles.map((angle, i) => ({ ...state.players[i], angle }));
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip({ ...state, players }, ctx);
  for (let i = 0; i < angles.length; i++) {
    assert.ok(
      angleDiff(angles[i], decoded.players[i].angle) <= 1e-3,
      `角度 ${angles[i]} → ${decoded.players[i].angle}`,
    );
    if (Math.abs(angles[i]) > 0.005) {
      assert.equal(Math.sign(decoded.players[i].angle), Math.sign(angles[i]), `角度 ${angles[i]} 符号丢失`);
    }
  }
});

test('wire: 超长 / emoji / 空昵称往返', () => {
  const names = ['旅人', '🎯狙击手🎯', 'x'.repeat(20), '', '雾岛·拾荒者·阿尔法'];
  const m = new Match({ seed: 17, mode: 'squad', maxPlayers: 8 });
  for (let i = 0; i < names.length; i++) m.addPlayer(`p${i}`, names[i] || '空名', { team: 0 });
  m.start();
  const state = m.snapshot('p0', 0);
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(
    diffValue(
      state.players.map((p) => p.name),
      decoded.players.map((p) => p.name),
    ),
    null,
  );
  assert.ok(
    decoded.players.some((p) => p.name.includes('🎯')),
    'emoji 昵称应完整保留',
  );
  assert.ok(
    decoded.players.some((p) => p.name.length >= 8),
    '长中文昵称应完整保留',
  );
});

test('wire: roster 未命中时昵称内联，命中时只发槽位（体积证据）', () => {
  const m = new Match({ seed: 3, mode: 'squad', maxPlayers: 8 });
  for (let i = 0; i < 8; i++) m.addPlayer(`p${i}`, `很长的中文昵称第${i}号`, { team: 0 });
  m.start();
  const state = m.snapshot(null, 0);
  const withRoster = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const noRoster = W.createWireContext({ roster: [] });
  const a = W.encodeStateFrame(state, withRoster).length;
  const b = W.encodeStateFrame(state, noRoster).length;
  assert.ok(b > a, `缺 roster 时应内联昵称（with=${a}, without=${b}）`);
  assert.equal(
    diffValue(
      state.players.map((p) => p.name),
      W.decodeStateFrame(W.encodeStateFrame(state, noRoster), noRoster).state.players.map((p) => p.name),
    ),
    null,
  );
});

test('wire: 玩家改名/换队后自动内联新静态字段，不依赖 roster 更新', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 10 });
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const players = [{ ...state.players[0], name: '新名字', team: 7 }];
  const { decoded } = roundtrip({ ...state, players }, ctx);
  assert.equal(decoded.players[0].name, '新名字');
  assert.equal(decoded.players[0].team, 7);
});

test('wire: 空列表快照（无玩家/无物资/无事件）往返一致', () => {
  const ctx = W.createWireContext({ roster: [] });
  const empty = {
    v: 3,
    mode: 'squad',
    mapId: 'qinglan',
    mapName: '青岚岛',
    weather: 'clear',
    timeOfDay: 'day',
    phase: 'waiting',
    time: 0,
    matchTime: 0,
    duration: 420,
    zone: { x: 0, z: 0, r: 0, target: { x: 0, z: 0, r: 0 }, closing: false, damage: 0, phase: 0, nextIn: 0 },
    counts: { alive: 0, total: 0, teams: 0, aliveTeams: 0, humans: 0, bots: 0 },
    selfId: null,
    me: null,
    players: [],
    loot: [],
    cars: [],
    grenades: [],
    smokes: [],
    fires: [],
    pings: [],
    drops: [],
    markers: [],
    horde: null,
    events: [],
    loading: null,
    result: null,
    teammates: [],
  };
  const { decoded } = roundtrip(empty, ctx);
  assert.equal(diffValue(empty, decoded), null);
});

test('wire: 未知事件类型 / 事件内未知字段向前兼容', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 10 });
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const events = [
    {
      id: 1,
      type: 'futureEvent',
      time: 1.5,
      player: 'me',
      x: 3.25,
      z: -4.5,
      extra: { nested: [1, 2, '三'], flag: true },
      count: 7,
    },
    {
      id: 2,
      type: 'shot',
      time: 2,
      player: 'me',
      x: 0,
      z: 0,
      tx: 1,
      tz: 1,
      weapon: 'p9',
      hit: false,
      hits: 0,
      headshots: 0,
      newField: '扩展',
    },
  ];
  const { decoded } = roundtrip({ ...state, events }, ctx);
  assert.equal(diffValue(events, decoded.events), null);
});

test('wire: horde 视图与结算结构往返', () => {
  const m = new Match({ mapId: 'qinglan', seed: 55, mode: 'horde', maxPlayers: 4, duration: 600 });
  m.addPlayer('me', '我', { team: 0 });
  m.start();
  for (let t = 0; t < 1500; t++) m.update(1 / 30);
  const state = m.snapshot('me', 0);
  assert.ok(state.horde, 'horde 对局必须有 horde 视图');
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(m.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(diffValue(state, decoded), null);
});

test('wire: 观战标志随帧携带，且不改变 state 结构', () => {
  const { state, ctx } = buildSnapshot({ players: 8, ticks: 10 });
  const bytes = W.encodeStateFrame(state, ctx, { spectator: true });
  const out = W.decodeStateFrame(bytes, ctx);
  assert.equal(out.spectator, true);
  assert.equal(diffValue(state, out.state), null);
});

test('wire: 共享区块复用与逐帧编码逐字节一致（服务端 64 观察者优化）', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 120 });
  const shared = W.encodeSharedBlockFrame(state, ctx);
  const withShared = W.encodeStateFrame(state, ctx, { shared });
  const without = W.encodeStateFrame(state, ctx);
  assert.deepEqual(Array.from(withShared), Array.from(without), '复用共享区块不得改变字节');
});

test('wire: 编码器不修改输入快照（snapshot 复用安全）', () => {
  const { state, ctx } = buildSnapshot({ players: 16, ticks: 60 });
  const before = JSON.stringify(state);
  W.encodeStateFrame(state, ctx);
  W.encodeStateFrame(state, ctx, { spectator: true });
  W.encodeSharedBlockFrame(state, ctx);
  assert.equal(JSON.stringify(state), before, '编码过程不能改写 snapshot 对象');
});

test('wire: 0.01 精度字段（r2 之后）往返无损', () => {
  const { state } = buildSnapshot({ players: 8, ticks: 60 });
  const me = {
    ...state.me,
    stamina: 87.53,
    damage: 1234.56,
    bleedout: 12.34,
    reloadTime: 0.77,
    fireCooldown: 0.13,
    accuracy: 0.456,
    spread: 0.0345,
    shield: 66.66,
    downedHp: 45.67,
  };
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip({ ...state, me }, ctx);
  for (const key of [
    'stamina',
    'damage',
    'bleedout',
    'reloadTime',
    'fireCooldown',
    'accuracy',
    'spread',
    'shield',
    'downedHp',
  ]) {
    assert.ok(Math.abs(decoded.me[key] - me[key]) < 0.006, `${key}: ${decoded.me[key]} vs ${me[key]}`);
  }
});

test('wire: 共享层纯净（无 Math.random / DOM / Node API）', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../shared/wire.mjs', import.meta.url), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/Math\.random/.test(body), false, '禁止 Math.random');
  assert.equal(/\bwindow\./.test(body), false, '禁止 window');
  assert.equal(/\bdocument\./.test(body), false, '禁止 document');
  assert.equal(/\bprocess\./.test(body), false, '禁止 process');
  assert.equal(/\bperformance\.now/.test(body), false, '禁止 performance.now');
  assert.equal(/\brequire\(/.test(body), false, '禁止 require');
  assert.equal(/from 'node:/.test(body), false, '禁止 node: 内置模块');
});

// ── 5. 覆盖盲区：horde / 结束局面 / 观战视角 ──────────────────────────────────
test('wire: horde 模式的波次字段能往返', () => {
  const m = new Match({ seed: 901, mode: 'horde', maxPlayers: 4 });
  m.addPlayer('me', '我', { bot: false, team: 0 });
  m.start();
  for (let t = 0; t < 600; t++) m.update(1 / 30);
  const state = m.snapshot('me', 0);
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.ok(decoded.horde, 'horde 视图必须存在');
  assert.equal(decoded.horde.wave, state.horde.wave, '波次号不一致');
  assert.ok(Math.abs(decoded.horde.baseHp - state.horde.baseHp) <= 0.02, '基地血量漂移过大');
});

test('wire: 结束局面（result 排名表）能往返', () => {
  const m = new Match({ seed: 902, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('me', '我', { bot: false, team: 0 });
  m.addPlayer('foe', '敌', { bot: false, team: 1 });
  m.start();
  for (let t = 0; t < 60; t++) m.update(1 / 30);
  m.players[1].alive = false;
  m.end('lastTeam', 0);
  const state = m.snapshot('me', 0);
  assert.ok(state.result, '结束局面应有 result');
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.ok(decoded.result, '解码后 result 必须存在');
  assert.equal(decoded.result.winnerTeam, state.result.winnerTeam, '胜者不一致');
  assert.equal(decoded.result.ranks.length, state.result.ranks.length, '排名表长度不一致');
});

test('wire: 观战视角（无 self）编码解码不崩', () => {
  const m = new Match({ seed: 903, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('me', '我', { bot: false, team: 0 });
  m.start();
  for (let t = 0; t < 60; t++) m.update(1 / 30);
  const state = m.snapshot(null, 0); // 观战者：没有 me
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const bytes = W.encodeStateFrame(state, ctx, { spectator: true });
  const decoded = W.decodeStateFrame(bytes, ctx);
  assert.equal(decoded.spectator, true, '观战标志必须还原');
  assert.equal(decoded.state.selfId, null, '观战视角没有 selfId');
  assert.ok(Array.isArray(decoded.state.players), '观战也必须收到全量玩家');
});

test('wire: 投掷物爆炸后的事件带 entityId 而不是覆盖事件序号', () => {
  const m = new Match({ seed: 904, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('me', '我', { bot: false, team: 0 });
  m.addPlayer('foe', '敌', { bot: false, team: 1 });
  m.start();
  for (let t = 0; t < 60; t++) m.update(1 / 30);
  m.players[0].grenades = 1;
  m.input('me', { throwable: true, aim: 0, seq: 1 });
  for (let t = 0; t < 150; t++) m.update(1 / 30);
  const state = m.snapshot('me', 0);
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  for (const ev of decoded.events) {
    assert.equal(typeof ev.id, 'number', `事件 ${ev.type} 的 id 必须是数字`);
  }
  const boom = decoded.events.find((e) => e.type === 'explosion');
  if (boom) assert.ok(boom.entityId, '爆炸事件应带 entityId（实体 id 不能覆盖事件序号）');
});

test('wire: 超长昵称（20 字上限）编码后不截断', () => {
  const m = new Match({ seed: 905, mode: 'squad', maxPlayers: 4 });
  const longName = '一二三四五六七八九十一二三四五六七八九十';
  m.addPlayer('me', longName, { bot: false, team: 0 });
  m.start();
  const state = m.snapshot('me', 0);
  const ctx = W.createWireContext({ roster: W.rosterFromPlayers(state.players) });
  const { decoded } = roundtrip(state, ctx);
  assert.equal(decoded.me.name, state.me.name, '昵称必须原样还原');
});
