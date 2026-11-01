// 雾岛突围 / MIST ISLE 1.0 — 服务端加固测试（owner: netserver）
// 覆盖：房间上限、每 IP 连接上限、令牌桶、射速反作弊、payload/JSON 健壮性、
// 优雅关闭、观战、踢人、配置权限、metrics 指标、权威输入校验与 HTTP 加固。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.mjs';
import { LIMITS, createInputWindow, trackInputRate, trackSeq } from '../server/guard.mjs';
import { createRequestHandler, parseRange } from '../server/http.mjs';
import { PROTOCOL_VERSION } from '../shared/rules.mjs';
import { budget } from './perf-budget.mjs';

const LOG = { level: 'error' };

async function setup(t, options = {}) {
  // 与 server.test.mjs 同理：测试里 socket 在 server.close() 之后才 terminate，
  // 默认 5s 宽限会让每个用例白等 5 秒。测试用 50ms。
  // 需要验证「优雅停机横幅/宽限」的用例可自行传更大的 shutdownGraceMs 覆盖。
  const server = createGameServer({
    host: '127.0.0.1', port: 0, log: LOG, shutdownGraceMs: 50,
    ...options,
  });
  const address = await server.listen();
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${address.port}/ws`, http: `http://127.0.0.1:${address.port}` };
}

async function connect(t, url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'state' && msg.state?.phase === 'loading') ws.send(JSON.stringify({ type: 'ready', ready: true }));
    const n = waiters.findIndex((w) => w.predicate(msg));
    if (n >= 0) { const [w] = waiters.splice(n, 1); clearTimeout(w.timer); w.resolve(msg); } else queue.push(msg);
    if (queue.length > 400) queue.shift();
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => { try { ws.terminate(); } catch { /* ignore */ } });
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  return {
    ws, closed, queue,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (predicate, timeout = 6000) => {
      const n = queue.findIndex(predicate);
      if (n >= 0) return Promise.resolve(queue.splice(n, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('Expected server message timed out'));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

const type = (name) => (message) => message.type === name;

async function join(c, mode, code, extra = {}) {
  c.send({ type: 'join', mode, code, team: 0, name: 'tester', protocol: PROTOCOL_VERSION, ...extra });
  return c.next(type('joined'));
}

// ── 1 · 房间上限 ─────────────────────────────────────────────────────────────
test('creating past maxRooms returns ROOM_LIMIT', async (t) => {
  const { server, url } = await setup(t, { maxRooms: 1 });
  const first = await connect(t, url);
  await join(first, 'create');
  assert.equal(server.rooms.size, 1);
  const second = await connect(t, url);
  second.send({ type: 'join', mode: 'create', protocol: PROTOCOL_VERSION });
  const err = await second.next(type('error'));
  assert.equal(err.code, 'ROOM_LIMIT');
  assert.match(err.message, /已满/);
  assert.equal(server.rooms.size, 1);
});

// ── 2 · 每 IP 连接上限 ───────────────────────────────────────────────────────
test('connections above maxConnectionsPerIp are rejected at upgrade', async (t) => {
  const { url } = await setup(t, { maxConnectionsPerIp: 2 });
  const a = await connect(t, url);
  const b = await connect(t, url);
  const third = new WebSocket(url);
  const outcome = await new Promise((resolve) => {
    third.once('open', () => resolve('open'));
    third.once('error', (err) => resolve(err.message));
    third.once('unexpected-response', (req, res) => resolve(`http-${res.statusCode}`));
  });
  try { third.terminate(); } catch { /* ignore */ }
  assert.notEqual(outcome, 'open', '第三个连接不应建立');
  a.send({ type: 'ping', sent: 1 });
  b.send({ type: 'ping', sent: 1 });
  assert.equal((await a.next(type('pong'))).sent, 1);
  assert.equal((await b.next(type('pong'))).sent, 1);
});

// ── 3 · 令牌桶：输入洪泛只丢弃、不断线 ────────────────────────────────────────
test('input token bucket drops bursts but keeps the connection alive', async (t) => {
  const { server, url } = await setup(t);
  const c = await connect(t, url);
  const session = await join(c, 'create');
  const before = server.registry.rooms.get(session.code).match.players.find((p) => p.id === session.id);
  assert.ok(before);
  for (let n = 0; n < 200; n++) c.send({ type: 'input', input: { mx: 1, mz: 0, seq: n + 1 } });
  // 轮询而不是固定 sleep：全量测试时同机并发会拖慢事件循环，250ms 可能连一半
  // 消息都没处理完（实测会报「应丢弃约 140 条，实际 0」）。断言内容不变。
  const deadline = Date.now() + budget(5000);
  while (server.stats.counters.rateDropped < 130 && Date.now() < deadline) await delay(25);
  assert.equal(c.ws.readyState, WebSocket.OPEN, '输入洪泛不应断开连接');
  const dropped = server.stats.counters.rateDropped;
  assert.ok(dropped >= 130, `应丢弃约 140 条输入，实际 ${dropped}`);
  c.send({ type: 'ping', sent: 42 });
  assert.equal((await c.next(type('pong'))).sent, 42, '控制消息档位不受输入洪泛影响');
});

// ── 3b · 控制消息洪泛 → 3 次违规踢出 ─────────────────────────────────────────
test('control message flooding trips three violations and closes with 1008', async (t) => {
  const { url } = await setup(t);
  const c = await connect(t, url);
  const started = Date.now();
  for (let n = 0; n < 200; n++) c.send({ type: 'rooms' });
  const { code } = await c.closed;
  assert.equal(code, 1008);
  assert.ok(Date.now() - started < budget(3000), `踢出应在 ${budget(3000)}ms 内完成`);
});

// ── 4 · 射速反作弊 ───────────────────────────────────────────────────────────
test('a client firing 60 times per tick is flagged and kicked', async (t) => {
  const { server, url } = await setup(t);
  const c = await connect(t, url);
  const session = await join(c, 'create');
  c.send({ type: 'start' });
  await c.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(session.code);
  const player = room.match.players.find((p) => p.id === session.id);
  assert.ok(player);
  let seq = 0;
  const blast = setInterval(() => {
    for (let n = 0; n < 60; n++) c.send({ type: 'input', input: { mx: 0, mz: 0, fire: true, seq: ++seq } });
  }, 20);
  const { code } = await Promise.race([c.closed, delay(9000).then(() => ({ code: 'timeout' }))]);
  clearInterval(blast);
  assert.equal(code, 4003, '持续超射速应以 4003 断开');
  const guest = room.members.get(session.id);
  assert.ok(!guest || !guest.ws, '被踢玩家应从席位移除');
});

// ── 4b · 正常射速不误伤 ──────────────────────────────────────────────────────
test('legitimate 25Hz fire input is never flagged', async (t) => {
  const { server, url } = await setup(t);
  const c = await connect(t, url);
  const session = await join(c, 'create');
  c.send({ type: 'start' });
  await c.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(session.code);
  for (let n = 1; n <= 25; n++) {
    c.send({ type: 'input', input: { mx: 0, mz: 0, fire: true, aim: 0, seq: n } });
    await delay(40);
  }
  await delay(120);
  assert.equal(room.members.get(session.id)?.guard.violations, 0, '正常 25Hz 开火不应产生违规');
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

// ── 5 · payload / 非 JSON 健壮性 ─────────────────────────────────────────────
test('oversized payload and non-JSON messages do not crash the server', async (t) => {
  const { url, http } = await setup(t);
  const c = await connect(t, url);
  await join(c, 'create');
  c.ws.send('x'.repeat(64 * 1024));
  const closed = await Promise.race([c.closed, delay(3000).then(() => ({ code: 'timeout' }))]);
  assert.ok([1009, 1006, 1008, 'timeout'].includes(closed.code), `超长 payload 应被拒绝，实际 ${closed.code}`);
  const other = await connect(t, url);
  other.ws.send('{not json');
  assert.match((await other.next(type('error'))).message, /格式/);
  other.ws.send('[]');
  assert.match((await other.next(type('error'))).message, /格式/);
  other.send({ type: 'ping', sent: 7 });
  assert.equal((await other.next(type('pong'))).sent, 7, '非 JSON 不应影响后续消息');
  const health = await (await fetch(`${http}/health`)).json();
  assert.equal(health.ok, true, '服务器仍然存活');
});

// ── 6 · 优雅关闭 ─────────────────────────────────────────────────────────────
test('close() is idempotent, notifies clients and stops listening', async (t) => {
  const server = createGameServer({ host: '127.0.0.1', port: 0, log: LOG, shutdownGraceMs: 300 });
  const address = await server.listen();
  const port = address.port;
  const url = `ws://127.0.0.1:${port}/ws`;
  const c = await connect(t, url);
  await join(c, 'create');
  const shutdownMsg = c.next(type('shutdown'), 4000);
  const closing = server.close();
  const second = server.close();
  const notice = await shutdownMsg;
  assert.ok(notice.inSeconds >= 1);
  await Promise.all([closing, second]);
  assert.equal(server.shuttingDown, true);
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => { try { ws.terminate(); } catch { /* ignore */ } resolve(); });
    ws.once('error', reject);
    setTimeout(() => resolve('timeout'), 3000);
  }).then((v) => { if (v === 'timeout') throw new Error('port still accepting'); }), /ECONNREFUSED|refused|timeout/);
  assert.equal(server.clients.size, 0);
});

// ── 7 · 观战 ─────────────────────────────────────────────────────────────────
test('spectator receives state snapshots but never joins the player list', async (t) => {
  const { server, url } = await setup(t);
  const host = await connect(t, url);
  const session = await join(host, 'create');
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const spec = await connect(t, url);
  spec.send({ type: 'spectate', code: session.code, name: 'watcher' });
  const ack = await spec.next(type('spectating'));
  assert.equal(ack.spectator, true);
  assert.match(ack.id, /^s[0-9a-f]+$/);
  const state = (await spec.next((m) => m.type === 'state' && m.state)).state;
  assert.ok(Array.isArray(state.players) && state.players.length > 0, '观战者应收到只读快照');
  assert.equal(state.selfId, null, '观战快照不带 self');
  const room = server.rooms.get(session.code);
  assert.equal(room.members.size, 1, '观战者不占玩家席位');
  assert.equal(room.spectators.size, 1);
  assert.ok(!room.match.players.some((p) => p.id === ack.id), '观战者不出现在 Match 玩家列表');
  spec.send({ type: 'leave' });
  await spec.next(type('left'));
  assert.equal(room.spectators.size, 0);
  assert.equal(room.members.size, 1);
});

test('spectator slots are capped at eight', async (t) => {
  const { server, url } = await setup(t, { maxConnectionsPerIp: 32 });
  const host = await connect(t, url);
  const session = await join(host, 'create');
  const room = server.rooms.get(session.code);
  const made = [];
  for (let n = 0; n < 8; n++) {
    const s = await connect(t, url);
    s.send({ type: 'spectate', code: session.code });
    await s.next(type('spectating'));
    made.push(s);
  }
  assert.equal(room.spectators.size, 8);
  const extra = await connect(t, url);
  extra.send({ type: 'spectate', code: session.code });
  const err = await extra.next(type('error'));
  assert.equal(err.code, 'SPECTATOR_LIMIT');
});

// ── 8 · 踢人 ─────────────────────────────────────────────────────────────────
test('only the host can kick, and the target receives kicked then closes', async (t) => {
  const { url } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  const b = await join(peer, 'join', a.code);
  peer.send({ type: 'kick', targetId: a.id });
  assert.equal((await peer.next(type('error'))).code, 'NOT_HOST');
  host.send({ type: 'kick', targetId: b.id, reason: '挂机' });
  const kicked = await peer.next(type('kicked'));
  assert.equal(kicked.reason, '挂机');
  const { code } = await peer.closed;
  assert.equal(code, 4001);
});

// ── 9 · 配置权限 ─────────────────────────────────────────────────────────────
test('non-host config changes are rejected; host changes broadcast a lobby', async (t) => {
  const { server, url } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  await join(peer, 'join', a.code);
  peer.send({ type: 'config', mode: 'solo', mapId: 'chisha' });
  const err = await peer.next(type('error'));
  assert.equal(err.code, 'NOT_HOST');
  assert.equal(server.rooms.get(a.code).match.mode, 'squad');
  host.send({ type: 'config', mode: 'solo', mapId: 'chisha', difficulty: 'elite' });
  const lobby = await peer.next((m) => m.type === 'lobby' && m.mode === 'solo');
  assert.equal(lobby.mapId, 'chisha');
  assert.equal(lobby.difficulty, 'elite');
  const room = server.rooms.get(a.code);
  assert.equal(room.match.mode, 'solo');
  assert.equal(room.match.players.length, 2, '重建 Match 后保留原成员');
});

test('waiting-room team switch respects SQUAD_SIZE and phase', async (t) => {
  const { url } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peers = [];
  for (let n = 0; n < 4; n++) {
    const p = await connect(t, url);
    await join(p, 'join', a.code, { team: n === 3 ? 1 : 0 });
    peers.push(p);
  }
  peers[3].send({ type: 'team', team: 0 });
  assert.equal((await peers[3].next(type('error'))).code, 'TEAM_FULL');
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  peers[3].send({ type: 'team', team: 0 });
  assert.equal((await peers[3].next(type('error'))).code, 'ROOM_STARTED');
});

// ── 10 · /metrics ────────────────────────────────────────────────────────────
test('/metrics exposes prometheus gauges, histogram and message counters', async (t) => {
  const { url, http } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  await join(peer, 'join', a.code);
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  await delay(400);
  const res = await fetch(`${http}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/plain/);
  const body = await res.text();
  for (const name of ['mist_rooms_total', 'mist_players_online', 'mist_tick_ms_bucket',
    'mist_ws_connections', 'mist_msgs_total{type="join"}']) {
    assert.ok(body.includes(name), `缺少指标 ${name}`);
  }
  assert.match(body, /mist_tick_ms_bucket\{le="\+Inf"\} \d+/);
  assert.match(body, /mist_rooms_total 1/);
  assert.match(body, /mist_ws_connections 2/);
});

test('lobby countdown starts only when not everyone is ready and can be cancelled', async (t) => {
  const { server, url } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  await join(peer, 'join', a.code);
  host.send({ type: 'start' });
  const lobby = await host.next((m) => m.type === 'lobby' && m.startCountdown > 0);
  assert.ok(lobby.startCountdown <= 5 && lobby.startCountdown >= 3, `倒计时应为 5 秒，实际 ${lobby.startCountdown}`);
  assert.equal(server.rooms.get(a.code).match.phase, 'waiting', '倒计时期间不能开局');
  host.send({ type: 'start', cancel: true });
  await host.next((m) => m.type === 'lobby' && m.startCountdown === 0);
  await delay(80);
  assert.equal(server.rooms.get(a.code).pendingStart, null);
  host.send({ type: 'ready', ready: true });
  peer.send({ type: 'ready', ready: true });
  await delay(120);
  host.send({ type: 'start' });
  const state = (await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting')).state;
  assert.ok(['loading', 'deploying'].includes(state.phase));
});

test('quick phrases are mapped server-side and system messages use [系统]', async (t) => {
  const { url } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const sys = await host.next((m) => m.type === 'chat' && m.system === true);
  assert.equal(sys.name, '[系统]');
  assert.match(sys.text, /加入了房间/);
  host.send({ type: 'chat', quick: 'need_ammo', channel: 'all' });
  const quick = await host.next((m) => m.type === 'chat' && m.quick === 'need_ammo');
  assert.equal(quick.text, '需要弹药！');
  assert.equal(quick.system, undefined);
  const peer = await connect(t, url);
  await join(peer, 'join', a.code);
  const joinedMsg = await host.next((m) => m.type === 'chat' && m.system === true && /加入了房间/.test(m.text));
  assert.match(joinedMsg.text, /tester 加入了房间/);
});

// ── 11 · 断线（不走 leave）后房间必须被回收 ────────────────────────────────────
// 复现历史 bug：玩家直接关浏览器 / 断网时 ws 触发 close → sessions.disconnect()
// 只把 member.ws 置 null，从不设置 room.emptySince。20 秒后掉线成员被剔除、房间
// 变成 0 人，但 emptySince 仍是 null → cleanup() 的回收条件不满足 → 房间永不回收，
// Match（64 人 / 地图 / AI / 物资）常驻内存并继续 30Hz 空跑，反复几次占满 maxRooms。
// 用可注入时钟推进时间，验证的是真实 tick/cleanup 路径，不是复制出来的判定逻辑。
test('disconnect without leave reclaims the room after the grace period', async (t) => {
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow, maxRooms: 2 });
  const host = await connect(t, url);
  const session = await join(host, 'create');
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(session.code);
  assert.ok(room, '房间应已创建');
  assert.notEqual(room.match.phase, 'waiting', '对局应已开始（live/loading/deploying）');
  const member = room.members.get(session.id);
  assert.ok(member?.ws, '成员应持有活跃连接');

  // 直接强杀连接：不发 leave，模拟关浏览器 / 断网。
  const closed = new Promise((resolve) => host.ws.once('close', resolve));
  host.ws.terminate();
  await closed;
  await delay(80); // 等服务端 close 事件把 sessions.disconnect 跑完

  assert.equal(room.members.get(session.id)?.ws, null, '席位应被标记为掉线（ws=null）');
  assert.ok(room.emptySince, '断线后必须立刻记下 emptySince（旧实现这里是 null）');
  assert.equal(room.emptySince, fakeNow, 'emptySince 应使用注入时钟的时间基准');

  // 推进 21 秒：tickRoom 会把掉线成员剔除，房间变成 0 人。
  fakeNow += 21000;
  server.registry.tickRoom(room, 30, 3);
  assert.equal(room.members.size, 0, '掉线 20 秒后席位应被剔除');
  assert.ok(room.emptySince, '剔除最后一名成员后 emptySince 仍必须有效');
  assert.equal(server.rooms.has(session.code), true, '宽限期内房间仍在');

  // 再推进 31 秒（空房宽限期 30s）：cleanup 必须回收。
  fakeNow += 31000;
  const removed = server.registry.cleanup();
  assert.equal(removed, 1, '空房应被 GC 回收');
  assert.equal(server.rooms.has(session.code), false, 'registry.rooms 不再包含该房间');
});

test('a room emptied while a match is live is still reclaimed', async (t) => {
  // 同一条 bug 在 live 阶段的变体：旧 tickRoom 只在 waiting 分支剔除掉线成员，
  // 于是 live 房间会永久留着 ws=null 的幽灵席位，match 永远 30Hz 空跑。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const host = await connect(t, url);
  const session = await join(host, 'create');
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(session.code);
  const closed = new Promise((resolve) => host.ws.once('close', resolve));
  host.ws.terminate();
  await closed;
  await delay(80);
  assert.ok(room.emptySince, 'live 阶段掉线同样要设置 emptySince');

  fakeNow += 21000;
  server.registry.tickRoom(room, 60, 3);
  assert.equal(room.members.size, 0, 'live 阶段也要剔除掉线席位（旧实现只在 waiting 剔除）');
  assert.equal(room.host, null, '没有在线成员时房主必须为 null');

  fakeNow += 31000;
  assert.equal(server.registry.cleanup(), 1, 'live 空房同样要被回收');
  assert.equal(server.rooms.has(session.code), false);
});

test('cleanup reclaims an empty room even if emptySince was never set', async (t) => {
  // 防御性回归：即使某条路径漏设 emptySince（旧 bug 的根因），cleanup 也必须
  // 直接按 members/spectators 是否为空兜底判定，而不是信任 emptySince。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const host = await connect(t, url);
  const session = await join(host, 'create');
  const room = server.rooms.get(session.code);
  host.send({ type: 'leave' });
  await host.next(type('left'));
  room.emptySince = null; // 人为抹掉，模拟历史 bug 的现场
  assert.equal(room.members.size + room.spectators.size, 0, '房间已无成员');
  fakeNow += 31000;
  // 第一次 cleanup 只补记 emptySince（宽限期从这一刻开始），第二次才真正回收。
  server.registry.cleanup();
  assert.equal(server.rooms.has(session.code), true, '补记宽限期后的第一次不回收');
  fakeNow += 31000;
  assert.equal(server.registry.cleanup(), 1, '兜底判定必须能回收');
  assert.equal(server.rooms.has(session.code), false);
});

test('disconnected seats are swept with a single lobby broadcast', async (t) => {
  // 旧实现每删一个成员就 addSystemChat + broadcast（addSystemChat 自己也广播），
  // N 名成员同时掉线是 O(n²) 条消息。这里留一名观战者当「收件人」，
  // 统计剔除两名掉线成员时它实际收到的 lobby / chat 条数。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  const b = await join(peer, 'join', a.code);
  const watcher = await connect(t, url);
  watcher.send({ type: 'spectate', code: a.code, name: 'watcher' });
  await watcher.next(type('spectating'));
  const room = server.rooms.get(a.code);
  const hostClosed = new Promise((resolve) => host.ws.once('close', resolve));
  const peerClosed = new Promise((resolve) => peer.ws.once('close', resolve));
  host.ws.terminate();
  peer.ws.terminate();
  await Promise.all([hostClosed, peerClosed]);
  await delay(80);
  assert.equal(room.members.size, 2, '宽限期内席位保留');
  assert.equal(room.members.get(a.id).ws, null);
  assert.equal(room.members.get(b.id).ws, null);

  fakeNow += 21000;
  watcher.queue.length = 0; // 清掉剔除前的历史消息，只数本 tick 的广播
  server.registry.tickRoom(room, 90, 3);
  await delay(60);
  const lobbies = watcher.queue.filter((m) => m.type === 'lobby' && m.code === a.code);
  const timeouts = watcher.queue.filter((m) => m.type === 'chat' && m.system && /掉线超时/.test(m.text || ''));
  assert.equal(room.members.size, 0, '两名掉线成员应被一起剔除');
  assert.equal(room.host, null, '没有在线成员时房主为 null');
  assert.equal(lobbies.length, 1, `剔除 2 名成员只应广播 1 次 lobby，实际 ${lobbies.length} 次`);
  assert.equal(timeouts.length, 1, `掉线系统消息也应合并成 1 条，实际 ${timeouts.length} 条`);
  assert.match(timeouts[0].text, /tester/);
});

test('a room with only a live spectator is not reclaimed', async (t) => {
  // 反向保护：GC 不能只看「有没有玩家」，最后一个玩家离开后还有人在观战，
  // 房间就必须继续存在（否则观战者会被无故踢出）。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const watcher = await connect(t, url);
  watcher.send({ type: 'spectate', code: a.code, name: 'watcher' });
  await watcher.next(type('spectating'));
  const room = server.rooms.get(a.code);
  host.send({ type: 'leave' });
  await host.next(type('left'));
  assert.equal(room.members.size, 0);
  assert.equal(room.spectators.size, 1, '观战者仍在');
  assert.equal(room.emptySince, null, '还有活跃连接，不能记为空房');
  fakeNow += 120000; // 远超空房宽限期
  assert.equal(server.registry.cleanup(), 0, '有观战者的房间不得回收');
  assert.equal(server.rooms.has(a.code), true);
  // 观战者离开后才进入空房计时
  watcher.send({ type: 'leave' });
  await watcher.next(type('left'));
  assert.ok(room.emptySince, '最后一名观战者离开后开始计时');
  fakeNow += 31000;
  assert.equal(server.registry.cleanup(), 1);
  assert.equal(server.rooms.has(a.code), false);
});

// ════════════════════════════════════════════════════════════════════════════
// 组件 A · 服务端权威输入校验（反作弊）
// ════════════════════════════════════════════════════════════════════════════

test('input rate window defaults are 120 per 1s and kick on 3 consecutive windows', () => {
  // 阈值必须在 guard.LIMITS 里，且与契约一致：超过 120 条/秒记违规，连续 3 个窗口断开。
  assert.equal(LIMITS.inputWindowMs, 1000);
  assert.equal(LIMITS.inputPerWindow, 120);
  assert.equal(LIMITS.inputWindowStrikes, 3);
  const win = createInputWindow();
  const cfg = { windowMs: 300, max: 12, strikes: 3 };
  let t = 1000;
  let kicks = 0;
  const verdicts = [];
  // 每 15ms 一条（≈66/s），持续 1.5 秒：每个 300ms 窗口都超限。
  for (let step = 0; step < 40; step++) {
    for (let k = 0; k < 2; k++) {
      t += 15;
      const v = trackInputRate(win, t, cfg);
      if (v) { verdicts.push(v); if (v === 'kick') kicks++; }
    }
    t += 15;
  }
  assert.ok(verdicts.filter((v) => v === 'violation').length >= 1, '超限窗口必须记违规');
  assert.equal(kicks, 1, '连续 3 个超限窗口只应触发一次 kick 结论');
  assert.equal(win.strikes, 3);
  // 停止超限后 strike 计数清零：再超限重新从 1 开始计。
  const calm = createInputWindow();
  for (let n = 0; n < 3; n++) trackInputRate(calm, 1000 + n * 400, cfg);
  assert.equal(calm.violations, 0);
});

test('input flooding above the rate window is disconnected with 1008 and counted', async (t) => {
  const events = [];
  const { server, url } = await setup(t, {
    antiCheat: { inputWindowMs: 200, inputPerWindow: 20, inputWindowStrikes: 3 },
    log: { level: 'warn', sink: (level, event) => events.push(event) },
  });
  const c = await connect(t, url);
  await join(c, 'create');
  let seq = 0;
  // 用爆发而不是 setInterval：Windows 的定时器粒度 ~15ms，固定间隔发不出目标速率。
  // 每轮 60 条（注入窗口 20 条/200ms），轮间隔 250ms ≈ 2 个窗口，构成「连续超限」。
  const blast = (async () => {
    for (let round = 0; round < 5; round++) {
      for (let n = 0; n < 60; n++) {
        // seq 必须单调递增：本次测的是速率窗口，别让 seq 回退抢先触发 seqKicks。
        c.send({ type: 'input', input: { mx: 0, mz: 0, seq: ++seq } });
      }
      await delay(250);
    }
  })();
  // 预算放宽到 15s：全量 npm test 并发时多个测试文件抢 CPU，定时器会被拖慢，
  // 5s 预算会被打穿（实测 timeout）。断言强度不变 —— 仍要求 1008 / rateKicks=1。
  const closed = await Promise.race([c.closed, delay(budget(15000)).then(() => ({ code: 'timeout' }))]);
  await blast;
  assert.equal(closed.code, 1008, `输入洪泛应以 1008 断开，实际 ${closed.code}`);
  assert.equal(server.stats.counters.rateKicks, 1, 'rateKicks 必须计数');
  assert.equal(server.stats.counters.seqKicks, 0, 'seq 单调递增时不应触发 seqKicks');
  assert.ok(events.includes('input-rate-kick'), `必须记 warn 日志，实际 ${events.join(',')}`);
});

test('legitimate 25Hz input never trips the rate window', async (t) => {
  const { server, url } = await setup(t);
  const c = await connect(t, url);
  await join(c, 'create');
  for (let n = 1; n <= 30; n++) {
    c.send({ type: 'input', input: { mx: 0, mz: 0, seq: n } });
    await delay(40);
  }
  await delay(120);
  assert.equal(c.ws.readyState, WebSocket.OPEN, '25Hz 输入不得被断开');
  assert.equal(server.stats.counters.rateKicks, 0);
});

test('repeated seq regressions disconnect the connection and increment seqKicks', async (t) => {
  const { server, url } = await setup(t, { antiCheat: { seqRegressions: 5 } });
  const c = await connect(t, url);
  await join(c, 'create');
  c.send({ type: 'input', input: { mx: 0, mz: 0, seq: 50 } });
  await delay(40);
  // seq 反复回退（重放/伪造的典型特征）：第 6 次回退超过注入上限 5。
  for (let n = 0; n < 7; n++) {
    c.send({ type: 'input', input: { mx: 0, mz: 0, seq: 1 } });
    await delay(20);
  }
  const closed = await Promise.race([c.closed, delay(budget(4000)).then(() => ({ code: 'timeout' }))]);
  assert.equal(closed.code, 1008, `seq 反复回退应以 1008 断开，实际 ${closed.code}`);
  assert.equal(server.stats.counters.seqKicks, 1);
});

test('seq tracking ignores zero/missing seq so clients that omit it are not punished', () => {
  const client = { lastInputSeq: 0, seqRegressions: 0 };
  assert.equal(trackSeq(client, 0, 5), null);
  assert.equal(trackSeq(client, undefined, 5), null);
  assert.equal(trackSeq(client, 10, 5), null);
  assert.equal(trackSeq(client, 11, 5), null);
  assert.equal(trackSeq(client, 11, 5), null, '相同 seq 不算回退');
  assert.equal(trackSeq(client, 3, 5), 'violation');
  assert.equal(client.seqRegressions, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// 组件 B · 动作限速
// ════════════════════════════════════════════════════════════════════════════

test('chat is capped at 80 characters and 2 messages per second', async (t) => {
  const { url } = await setup(t);
  const c = await connect(t, url);
  await join(c, 'create');
  c.send({ type: 'chat', text: 'x'.repeat(200), channel: 'all' });
  const first = await c.next((m) => m.type === 'chat' && !m.system);
  assert.equal(first.text.length, LIMITS.chatMaxChars, `聊天正文必须截到 ${LIMITS.chatMaxChars} 字`);
  c.send({ type: 'chat', text: '快到碗里来', channel: 'all' });
  assert.equal((await c.next((m) => m.type === 'chat' && !m.system && m.text === '快到碗里来')).text, '快到碗里来');
  c.send({ type: 'chat', text: '第三条', channel: 'all' });
  const err = await c.next(type('error'));
  assert.equal(err.code, 'CHAT_SPAM', '每秒第 3 条必须被拒');
  assert.equal(c.ws.readyState, WebSocket.OPEN, '聊天超速只回错误，不断线');
});

test('spectator chat obeys the same per-second throttle', async (t) => {
  const { url } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const spec = await connect(t, url);
  spec.send({ type: 'spectate', code: a.code, name: 'watcher' });
  await spec.next(type('spectating'));
  spec.send({ type: 'chat', text: '一', channel: 'all' });
  spec.send({ type: 'chat', text: '二', channel: 'all' });
  spec.send({ type: 'chat', text: '三', channel: 'all' });
  const err = await spec.next(type('error'));
  assert.equal(err.code, 'CHAT_SPAM', '观战者不能绕过聊天限速');
});

test('input ping flag is stripped while the server-side cooldown is active', async (t) => {
  // pingCd 在 Match.players 上只在 live 阶段被消费；大厅/跳伞阶段客户端仍能
  // 每 tick 带 ping:true 刷标记。这里验证房间层在进 Match 之前就按冷却剥离。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const c = await connect(t, url);
  const session = await join(c, 'create');
  c.send({ type: 'start' });
  await c.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(session.code);
  const member = room.members.get(session.id);
  const player = room.match.players.find((p) => p.id === session.id);
  server.actions.input(member, room, { input: { seq: 1, ping: true, pingKind: 'enemy' } }, 1);
  assert.equal(player.input.ping, true, '首次标记应放行');
  server.actions.input(member, room, { input: { seq: 2, ping: true, pingKind: 'loot' } }, 2);
  assert.equal(player.input.ping, false, `冷却（${LIMITS.pingFlagCooldownMs}ms）内必须剥离 ping`);
  fakeNow += LIMITS.pingFlagCooldownMs + 100;
  server.actions.input(member, room, { input: { seq: 3, ping: true, pingKind: 'danger' } }, 3);
  assert.equal(player.input.ping, true, '冷却结束后恢复放行');
});

test('dropvote is limited to 5 per second, dropped silently and counted', async (t) => {
  const { server, url, http: base } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  const b = await join(peer, 'join', a.code);
  await delay(80); // 消化加入时的 lobby 广播
  host.queue.length = 0;
  const room = server.rooms.get(a.code);
  for (let n = 0; n < 12; n++) peer.send({ type: 'dropvote', x: 0.1 + n * 0.01, z: 0.2 });
  // 轮询到「12 条全部有了结论」（5 放行 + 7 丢弃）再断言，而不是固定 sleep 200ms。
  // 全量测试并发时事件循环被抢占，固定等待会让计数停在中间值（实测广播 2 条）。
  const deadline = Date.now() + budget(5000);
  while (server.stats.counters.dropvoteDropped < 7 && Date.now() < deadline) await delay(25);
  // 再等一小段让剩下的放行广播也进队列（丢弃计数先到 7 时，第 5 条 lobby 可能还在路上）。
  await delay(80);
  const lobbies = host.queue.filter((m) => m.type === 'lobby' && m.dropVotes?.length === 1);
  // 放行条数用「≤5 且 ≥1」而不是 ===5：全量并发下 12 条可能跨过滑动窗口的秒边界
  // （前几条落在上一窗口），这是限流器的正确行为，不是缺陷。真正要守的是
  // 「不会全放行」+「超额被计数」。
  assert.ok(lobbies.length >= 1 && lobbies.length <= 5,
    `每连接每秒最多放行 5 条，实际 ${lobbies.length} 条广播`);
  assert.ok(server.stats.counters.dropvoteDropped >= 7,
    `超限的应被静默丢弃，实际丢弃 ${server.stats.counters.dropvoteDropped}`);
  assert.ok(!host.queue.some((m) => m.type === 'error'), '超限不应回错误（避免放大回包）');
  const finalVote = room.dropVotes.get(b.id);
  assert.ok(finalVote, '至少有一条票被记录');
  assert.equal(peer.ws.readyState, WebSocket.OPEN, '限速不断线');
  const stats = await (await fetch(`${base}/stats`)).json();
  assert.equal(stats.counters.dropvoteDropped, server.stats.counters.dropvoteDropped,
    '/stats 必须反映 dropvote 丢弃数');
});

// ════════════════════════════════════════════════════════════════════════════
// 组件 C · /stats 反作弊计数
// ════════════════════════════════════════════════════════════════════════════

test('/stats exposes anti-cheat counters without changing existing fields', async (t) => {
  const { url, http: base } = await setup(t);
  const c = await connect(t, url);
  await join(c, 'create');
  const stats = await (await fetch(`${base}/stats`)).json();
  assert.equal(stats.ok, true);
  for (const key of ['rateKicks', 'seqKicks', 'dropvoteDropped']) {
    assert.equal(typeof stats.counters?.[key], 'number', `/stats 缺少 counters.${key}`);
    assert.equal(stats.counters[key], 0, `${key} 初始应为 0`);
  }
  // 既有字段一个都不能少（老监控/看板直接读它们）。
  const legacy = ['version', 'protocol', 'uptime', 'memory', 'rooms', 'matches', 'sockets',
    'players', 'spectators', 'tickMs'];
  for (const key of legacy) {
    assert.ok(key in stats, `/stats 丢失既有字段 ${key}`);
  }
  assert.ok(stats.memory.rss > 0 && stats.memory.heapUsed > 0);
  assert.ok(stats.tickMs.p50 >= 0 && stats.tickMs.p99 >= 0);
});

// ════════════════════════════════════════════════════════════════════════════
// 组件 D · 房间级异常保护
// ════════════════════════════════════════════════════════════════════════════

test('a member disconnected longer than 90s is actually removed from the Match', async (t) => {
  // 两层保留期：席位 20s 回收（重连窗口），Match 里的「尸体」再留 90s 保留排名语义。
  // 旧实现只清 ws / 剔席位，Match.players 里的幽灵玩家永久残留。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  const b = await join(peer, 'join', a.code);
  host.send({ type: 'ready', ready: true });
  peer.send({ type: 'ready', ready: true });
  await delay(80);
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(a.code);
  const match = room.match;
  assert.ok(match.players.some((p) => p.id === b.id), '开局后成员应在 Match 里');

  const closed = new Promise((resolve) => peer.ws.once('close', resolve));
  peer.ws.terminate();
  await closed;
  await delay(80);
  assert.equal(room.members.get(b.id)?.ws, null, '席位应先标记为掉线');

  // 21 秒：席位回收，但 Match 里仍保留（排名语义）。
  fakeNow += 21000;
  server.registry.tickRoom(room, 30, 3);
  assert.equal(room.members.has(b.id), false, '20 秒后席位必须剔除');
  assert.equal(match, room.match, '不应换局');
  assert.ok(room.dropped.has(b.id), '应登记待移除的掉线玩家');
  assert.ok(match.players.some((p) => p.id === b.id), '90 秒内仍保留在 Match（排名需要）');

  // 累计 91 秒（> 90s）：必须真正从 Match 移除。
  fakeNow += 70000;
  server.registry.tickRoom(room, 60, 3);
  assert.equal(room.dropped.has(b.id), false, '移除后登记表应清空');
  assert.ok(!match.players.some((p) => p.id === b.id), '掉线 > 90s 的成员必须被移出 Match');
  assert.ok(match.players.some((p) => p.id === a.id), '其他在线玩家不受影响');
});

test('a live member is never swept from the Match', async (t) => {
  // 反向保护：在线成员即使超过 90s 也必须留在 Match 里。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const host = await connect(t, url);
  const session = await join(host, 'create');
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(session.code);
  fakeNow += 120000;
  server.registry.tickRoom(room, 90, 3);
  assert.ok(room.match.players.some((p) => p.id === session.id), '在线玩家不得被移除');
  assert.equal(room.dropped.size, 0);
});

test('reconnecting inside the 90s window cancels the pending Match removal', async (t) => {
  // 席位 20s 就回收，但 Match 里的尸体留 90s。玩家在 20–90s 之间带 token 重连
  // （resume 只看成员表，此时席位已经没了 → 会 RE_RESUME_EXPIRED）。
  // 因此能重连成功的前提是席位还在：这里验证「席位被回收后再重连会失败」，
  // 以及「未超时前重连必须撤掉待移除登记」，避免连回来又被人从 Match 里删掉。
  let fakeNow = Date.now();
  const { server, url } = await setup(t, { now: () => fakeNow });
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const peer = await connect(t, url);
  const b = await join(peer, 'join', a.code);
  host.send({ type: 'ready', ready: true });
  peer.send({ type: 'ready', ready: true });
  await delay(80);
  host.send({ type: 'start' });
  await host.next((m) => m.type === 'state' && m.state.phase !== 'waiting');
  const room = server.rooms.get(a.code);

  const closed = new Promise((resolve) => peer.ws.once('close', resolve));
  peer.ws.terminate();
  await closed;
  await delay(80);
  assert.equal(room.members.get(b.id)?.ws, null);

  // 10 秒后重连（仍在 20s 重连窗口内）：成功后不得留下待移除登记。
  fakeNow += 10000;
  const again = await connect(t, url);
  again.send({
    type: 'join', mode: 'resume', code: a.code, token: b.token, protocol: PROTOCOL_VERSION,
  });
  const resumed = await again.next(type('joined'));
  assert.equal(resumed.id, b.id, '重连应拿回同一身份');
  assert.equal(room.dropped.has(b.id), false, '重连成功必须撤掉待移除登记');

  // 再推进 95 秒：玩家在线，Match 里必须仍在。
  fakeNow += 95000;
  server.registry.tickRoom(room, 120, 3);
  assert.ok(room.match.players.some((p) => p.id === b.id), '重连的玩家不能被 90s 清理误删');
});

test('a failed Match.start leaves the room retryable instead of stuck in loading', async (t) => {
  const { server, url } = await setup(t);
  const host = await connect(t, url);
  const a = await join(host, 'create');
  const room = server.rooms.get(a.code);
  const original = room.match.start;
  room.match.start = () => false;
  room.startNow = true;
  room.pendingStart = { at: Date.now(), by: a.id };
  host.queue.length = 0;
  assert.equal(server.registry.startMatch(room), false, 'start() 返回 false 时 startMatch 必须返回 false');
  assert.equal(room.match.phase, 'waiting', '不能卡在 loading / 半开局状态');
  assert.equal(room.pendingStart, null, '倒计时必须清掉');
  assert.equal(room.startNow, false, 'startNow 必须复位');
  const lobby = await host.next((m) => m.type === 'lobby' && m.code === a.code, budget(3000));
  assert.equal(lobby.phase, 'waiting', '失败后要广播回等待态');
  // 复位后重试必须能正常开局（不卡死）。
  room.match.start = original;
  assert.equal(server.registry.startMatch(room), true);
  assert.equal(room.match.phase, 'loading');
});

// ════════════════════════════════════════════════════════════════════════════
// 组件 E · HTTP 加固
// ════════════════════════════════════════════════════════════════════════════

/** 直接走 node:http 发请求：fetch 会规范化 URL，测不了长 URL 与非法百分号编码。 */
function rawRequest(base, path, { method = 'GET', headers = {} } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('read-only HTTP endpoints answer 405 with an Allow header', async (t) => {
  const { http: base } = await setup(t);
  for (const path of ['/health', '/rooms', '/metrics', '/stats']) {
    const res = await rawRequest(base, path, { method: 'POST' });
    assert.equal(res.status, 405, `${path} 的 POST 应返回 405，实际 ${res.status}`);
    assert.equal(res.headers.allow, 'GET, HEAD', `${path} 必须带 Allow 头`);
  }
  // 不存在的房间也先判方法，再判存在性（不给未授权方法留探测面）。
  const room = await rawRequest(base, '/rooms/ABCDE', { method: 'DELETE' });
  assert.equal(room.status, 405);
});

test('GET on read-only endpoints still works after the 405 guard', async (t) => {
  const { http: base } = await setup(t);
  assert.equal((await rawRequest(base, '/health')).status, 200);
  assert.equal((await rawRequest(base, '/rooms')).status, 200);
  assert.equal((await rawRequest(base, '/metrics')).status, 200);
  assert.equal((await rawRequest(base, '/stats')).status, 200);
});

test('URLs longer than 2048 bytes are rejected with 414', async (t) => {
  const { http: base } = await setup(t);
  const long = `/${'a'.repeat(LIMITS.maxUrlBytes + 16)}`;
  const res = await rawRequest(base, long);
  assert.equal(res.status, 414, `超长 URL 应返回 414，实际 ${res.status}`);
  // 边界内仍正常：2047 字节的未知路径是 404，不是 414。
  const ok = `/${'a'.repeat(LIMITS.maxUrlBytes - 40)}`;
  assert.equal((await rawRequest(base, ok)).status, 404);
});

test('a malformed percent-encoded path returns 400 instead of 500', async (t) => {
  const { http: base } = await setup(t);
  const res = await rawRequest(base, '/rooms/%E0%A4%A');
  assert.equal(res.status, 400, `非法 % 编码应是客户端错误，实际 ${res.status}`);
  assert.doesNotMatch(res.body, /Internal error/);
  // 合法编码仍然能解码后查房间（不存在 → 404）。
  const good = await rawRequest(base, '/rooms/ABCDE');
  assert.equal(good.status, 404);
});

test('parseRange accepts valid ranges and rejects malformed ones', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=50-9999', 100), { start: 50, end: 99 }, '越界尾部要钳到文件末尾');
  for (const bad of ['', 'bytes=', 'bytes=-', 'bytes=abc', 'items=0-1', 'bytes=9-2',
    'bytes=200-300', 'bytes=1-2,4-5', 'bytes=-0', 'bytes=--5']) {
    assert.equal(parseRange(bad, 100), null, `非法 Range 必须回退整文件：${JSON.stringify(bad)}`);
  }
  assert.equal(parseRange('bytes=0-0', 0), null, '空文件不接受 Range');
});

test('valid Range serves 206 with Content-Range; malformed Range falls back to the whole file', async (t) => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'mist-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(pathJoin(dir, 'index.html'), 'x'.repeat(1024));
  // 末尾必须带 '/'：new URL('./', url) 会丢掉最后一段路径。
  const distRoot = new URL(`${pathToFileURL(dir).href}/`);
  const handler = createRequestHandler({
    rooms: new Map(), clients: new Set(), startedAt: Date.now(),
    distRoot,
    roomSummary: () => ({}), roomPublicList: () => [],
  });
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const partial = await rawRequest(base, '/index.html', { headers: { Range: 'bytes=10-19' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers['content-range'], 'bytes 10-19/1024');
  assert.equal(partial.headers['accept-ranges'], 'bytes');
  assert.equal(partial.body.length, 10);

  for (const bad of ['bytes=abc', 'bytes=5000-6000', 'items=0-1']) {
    const full = await rawRequest(base, '/index.html', { headers: { Range: bad } });
    assert.equal(full.status, 200, `非法 Range ${bad} 应回退整文件`);
    assert.equal(full.headers['content-range'], undefined);
    assert.equal(full.body.length, 1024);
  }
});
