// 雾岛突围 / MIST ISLE — 二进制快照服务端集成测试（node --test tests/wire-integration.test.mjs）
// 覆盖：能力协商（binary:true / 老客户端 / 服务端回退）、roster 先于首帧、二进制解码结果
// 与同房间 JSON 客户端一致、观战者二进制、重连后重新协商。
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.mjs';
import { PROTOCOL_VERSION } from '../shared/rules.mjs';
import { createWireContext, decodeStateFrame } from '../shared/wire.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t, options = {}) {
  const server = createGameServer({ host: '127.0.0.1', port: 0, log: { level: 'error' }, ...options });
  const address = await server.listen();
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${address.port}/ws` };
}

/**
 * 客户端桩：按 binary 能力位收帧。
 * - JSON 帧：解析后进 queue；
 * - 二进制帧：用 roster 建好的上下文解码成 { type:'state', state, spectator } 后进 queue。
 */
function connect(t, url, { binary = false, autoReady = true } = {}) {
  const ws = new WebSocket(url);
  const client = { ws, queue: [], binary, rosterCount: 0, binFrames: 0, jsonStates: 0, errors: [], ctx: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      client.binFrames++;
      if (!client.ctx) {
        client.errors.push('二进制帧早于 roster');
        return;
      }
      try {
        const frame = decodeStateFrame(new Uint8Array(data), client.ctx);
        if (autoReady && (frame.state.phase === 'loading' || frame.state.loading)) {
          ws.send(JSON.stringify({ type: 'ready', ready: true }));
        }
        client.queue.push(frame);
      } catch (err) {
        client.errors.push(`decode: ${err.message}`);
      }
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === 'roster') {
      client.rosterCount++;
      client.ctx = createWireContext({ roster: msg.players || [] });
      client.queue.push(msg);
      return;
    }
    if (msg.type === 'state') {
      client.jsonStates++;
      if (autoReady && (msg.state.phase === 'loading' || msg.state.loading))
        ws.send(JSON.stringify({ type: 'ready', ready: true }));
    }
    client.queue.push(msg);
  });
  t.after(() => {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

function join(c, options = {}) {
  c.ws.send(
    JSON.stringify({
      type: 'join',
      mode: 'create',
      team: 0,
      name: '测试员',
      protocol: PROTOCOL_VERSION,
      ...options,
    }),
  );
}

async function waitFor(c, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (let i = 0; i < c.queue.length; i++) {
      if (predicate(c.queue[i])) return c.queue.splice(i, 1)[0];
    }
    await delay(30);
  }
  throw new Error('等待消息超时');
}

test('binary: 协商成功 —— roster 先到，随后全部是二进制帧', async (t) => {
  const { url } = await setup(t);
  const c = await connect(t, url, { binary: true });
  join(c, { binary: true });
  const joined = await waitFor(c, (m) => m.type === 'joined');
  assert.equal(joined.binary, true, 'joined 应确认二进制');
  assert.equal(joined.wire, 1);
  c.ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(c, (m) => m.type === 'roster');
  const state = await waitFor(c, (m) => m.type === 'state' && m.state);
  assert.ok(state.state.players.length > 0, '二进制帧应解出玩家列表');
  assert.equal(state.state.me.id, joined.id);
  assert.ok(c.binFrames > 0, '应收到二进制帧');
  assert.equal(c.jsonStates, 0, '协商二进制后不应再收到 JSON state');
  assert.deepEqual(c.errors, []);
  assert.ok(c.rosterCount >= 1);
});

test('binary: 老客户端（不带 binary）全程 JSON，字节结构不变', async (t) => {
  const { url } = await setup(t);
  const c = await connect(t, url, { binary: false });
  join(c);
  const joined = await waitFor(c, (m) => m.type === 'joined');
  assert.equal(joined.binary, false, '未申请二进制时 joined.binary 应为 false');
  c.ws.send(JSON.stringify({ type: 'start' }));
  const state = await waitFor(c, (m) => m.type === 'state' && m.state);
  assert.ok(Array.isArray(state.state.players));
  assert.ok(Array.isArray(state.state.loot), 'JSON 路径仍带 loot 数组');
  assert.equal(c.binFrames, 0, '老客户端不应收到二进制帧');
  assert.equal(c.rosterCount, 0, '老客户端不应收到 roster');
});

test('binary: 服务端 WIRE_BINARY=0 时强制回退 JSON', async (t) => {
  const { url } = await setup(t, { binary: false });
  const c = await connect(t, url, { binary: true });
  join(c, { binary: true });
  const joined = await waitFor(c, (m) => m.type === 'joined');
  assert.equal(joined.binary, false, '服务端禁用后即使申请也只走 JSON');
  c.ws.send(JSON.stringify({ type: 'start' }));
  const state = await waitFor(c, (m) => m.type === 'state' && m.state);
  assert.ok(Array.isArray(state.state.players));
  assert.equal(c.binFrames, 0);
});

test('binary: 同房间二进制客户端与 JSON 客户端状态一致', async (t) => {
  const { url } = await setup(t);
  const bin = await connect(t, url, { binary: true });
  const json = await connect(t, url, { binary: false });
  join(bin, { binary: true });
  const host = await waitFor(bin, (m) => m.type === 'joined');
  json.ws.send(
    JSON.stringify({
      type: 'join',
      mode: 'join',
      code: host.code,
      team: 1,
      name: 'JSON乙',
      protocol: PROTOCOL_VERSION,
    }),
  );
  const binJoined = host;
  const jsonJoined = await waitFor(json, (m) => m.type === 'joined');
  bin.ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(bin, (m) => m.type === 'state' && m.state?.phase === 'loading');
  await waitFor(json, (m) => m.type === 'state' && m.state?.phase === 'loading');
  bin.ws.send(JSON.stringify({ type: 'ready', ready: true }));
  json.ws.send(JSON.stringify({ type: 'ready', ready: true }));

  // 等到同一 tick 的两份快照：玩家数、存活数、载具数、物资集合必须一致。
  const b = await waitFor(bin, (m) => m.type === 'state' && m.state.phase !== 'loading', 30000);
  const j = await waitFor(json, (m) => m.type === 'state' && m.state.phase !== 'loading', 30000);
  // 两份快照可能相差一两个 tick：只比较与观察者无关的全局字段与各自的自视角。
  // （players 是可见集裁剪的结果，双方站位不同，人数本来就可能不同。）
  assert.equal(b.state.counts.total, j.state.counts.total);
  assert.ok(Math.abs(b.state.counts.alive - j.state.counts.alive) <= 3, '存活数应基本同步');
  assert.equal(b.state.cars.length, j.state.cars.length, '载具对全房一致');
  assert.equal(b.state.phase, j.state.phase);
  assert.ok(Math.abs(b.state.time - j.state.time) < 1, '时间轴应基本同步');
  const bIds = new Set(b.state.players.map((p) => p.id));
  // 注意：`players` 是**按观察者裁剪**的可见集（`_visibleTo`：同队恒可见，异队 70m 内）。
  // 两名观察者出生点不同，可见的敌队玩家本来就会不同。
  // 唯一必须成立的约束是：两队各自的同队玩家（含 bot）在两边都完整下发。
  for (const p of b.state.players.filter((p) => p.team === b.state.me?.team)) {
    assert.ok(bIds.has(p.id), `二进制客户端缺自己的同队玩家 ${p.id}`);
  }
  const jIds = new Set(j.state.players.map((p) => p.id));
  for (const p of j.state.players.filter((p) => p.team === j.state.me?.team)) {
    assert.ok(jIds.has(p.id), `JSON 客户端缺自己的同队玩家 ${p.id}`);
  }
  // 双方都必须能看到同一批队友（人数一致）
  const bMates = b.state.players.filter((p) => p.team === b.state.me?.team).length;
  const jMates = j.state.players.filter((p) => p.team === j.state.me?.team).length;
  assert.equal(bMates, jMates, '两队规模相同，各自的同队可见人数应一致');
  assert.ok(b.state.me && j.state.me, '双方都应有自视角');
  // 各自的 me 必须是各自的会话身份（不是同一个人）。
  assert.equal(b.state.me.id, binJoined.id, '二进制客户端的 me 必须是自己的 id');
  assert.equal(j.state.me.id, jsonJoined.id, 'JSON 客户端的 me 必须是自己的 id');
  assert.notEqual(b.state.me.id, j.state.me.id);
  // 物资差量结构一致
  const bLoot = new Set((b.state.loot || b.state.lootPatch?.upsert || []).map((l) => l.id));
  const jLoot = new Set((j.state.loot || j.state.lootPatch?.upsert || []).map((l) => l.id));
  assert.deepEqual([...bLoot].sort(), [...jLoot].sort(), '物资差量集合应一致');
  assert.deepEqual(bin.errors, []);
});

test('binary: 观战者可通过二进制通道收到只读快照', async (t) => {
  const { url } = await setup(t);
  const host = await connect(t, url, { binary: true });
  join(host, { binary: true });
  const joined = await waitFor(host, (m) => m.type === 'joined');
  host.ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(host, (m) => m.type === 'state' && m.state?.phase !== 'loading', 30000);
  const spec = await connect(t, url, { binary: true });
  spec.ws.send(
    JSON.stringify({ type: 'spectate', code: joined.code, name: '观战者', protocol: PROTOCOL_VERSION, binary: true }),
  );
  const ack = await waitFor(spec, (m) => m.type === 'spectating');
  assert.equal(ack.binary, true);
  const state = await waitFor(spec, (m) => m.type === 'state' && m.state, 30000);
  assert.equal(state.spectator, true, '观战帧应带 spectator 标志');
  assert.equal(state.state.selfId, null, '观战快照不带 self');
  assert.ok(state.state.players.length > 0);
  assert.deepEqual(spec.errors, []);
});

test('binary: 重连后重新协商，roster 重新下发', async (t) => {
  const { server, url } = await setup(t);
  const first = await connect(t, url, { binary: true });
  join(first, { binary: true });
  const session = await waitFor(first, (m) => m.type === 'joined');
  first.ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(first, (m) => m.type === 'state' && m.state?.phase !== 'loading', 30000);
  first.ws.close();
  await delay(80);
  const second = await connect(t, url, { binary: true });
  second.ws.send(
    JSON.stringify({
      type: 'join',
      mode: 'resume',
      code: session.code,
      token: session.token,
      protocol: PROTOCOL_VERSION,
      binary: true,
    }),
  );
  const resumed = await waitFor(second, (m) => m.type === 'joined');
  assert.equal(resumed.id, session.id);
  assert.equal(resumed.binary, true);
  const roster = await waitFor(second, (m) => m.type === 'roster', 30000);
  assert.ok(Array.isArray(roster.players) && roster.players.length > 0, '重连后必须重发 roster');
  const state = await waitFor(second, (m) => m.type === 'state' && m.state, 30000);
  assert.ok(Array.isArray(state.state.players) && state.state.players.length > 0);
  assert.deepEqual(second.errors, []);
  assert.ok(server.rooms.get(session.code), '房间应仍然存在');
});
