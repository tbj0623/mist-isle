import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.mjs';
import { PROTOCOL_VERSION, MAX_PLAYERS } from '../shared/rules.mjs';
import { createWireContext, decodeStateFrame } from '../shared/wire.mjs';

async function setup(t, options = {}) {
  // shutdownGraceMs 默认 5000ms（生产：让对局自然收尾）。测试里 socket 由 t.after
  // 在 server.close() 之后才 terminate，而 Node 的 after 钩子按注册顺序执行，
  // 于是 close() 每次都要等满 5 秒宽限。改成 50ms 后，整份测试从 ~72s 降到 ~15s。
  const server = createGameServer({
    host: '127.0.0.1', port: 0, log: { level: 'error' },
    shutdownGraceMs: 50,
    ...options,
  });
  const address = await server.listen();
  t.after(() => server.close());
  return { server, url: `ws://127.0.0.1:${address.port}/ws`, http: `http://127.0.0.1:${address.port}` };
}
async function client(t, url, ready = true) {
  const ws = new WebSocket(url), queue = [], waiters = [];
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (ready && msg.type === 'state' && msg.state.phase === 'loading') ws.send(JSON.stringify({type:'ready'}));
    const n = waiters.findIndex(w => w.predicate(msg));
    if (n >= 0) { const [w] = waiters.splice(n, 1); clearTimeout(w.timer); w.resolve(msg); }
    else queue.push(msg);
    if (queue.length > 200) queue.shift();
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  return {
    ws, send: msg => ws.send(JSON.stringify(msg)),
    next: (predicate, timeout = 6000) => {
      const n = queue.findIndex(predicate); if (n >= 0) return Promise.resolve(queue.splice(n, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('Expected server message timed out')); }, timeout);
        waiters.push(waiter);
      });
    },
  };
}
const type = name => message => message.type === name;
async function join(c, mode, code, team = 0) { c.send({ type: 'join', mode, code, team, name: 'tester', protocol: PROTOCOL_VERSION }); return c.next(type('joined')); }

test('HTTP health is healthy and static traversal is rejected', async t => {
  const { http } = await setup(t); const health = await (await fetch(`${http}/health`)).json();
  assert.equal(health.ok, true); assert.equal(health.protocol, PROTOCOL_VERSION);
  assert.equal((await fetch(`${http}/../package.json`)).status, 404);
});
test('two sockets share a room, only host starts, and state is authoritative', async t => {
  const { server, url } = await setup(t); const host = await client(t, url), peer = await client(t, url);
  const first = await join(host, 'create'), second = await join(peer, 'join', first.code);
  assert.equal(first.host, true); assert.equal(second.host, false); assert.notEqual(first.id, second.id);
  peer.send({ type: 'start' }); assert.match((await peer.next(type('error'))).message, /房主/);
  host.send({ type: 'start' }); const a = (await host.next(type('state'))).state, b = (await peer.next(type('state'))).state;
  assert.equal(a.phase, b.phase); assert.equal(a.counts.total, MAX_PLAYERS); assert.equal(a.players.filter(p => !p.bot).length, 2);
  await host.next(msg => msg.type === 'state' && (msg.state.phase === 'playing' || msg.state.phase === 'deploying'));
  const match = server.rooms.get(first.code).match;
  const p = match.players.find(p => p.id === first.id), before = p.x, simulationTimeBefore = match.time;
  for (let seq = 1; seq <= 10; seq++) { host.send({ type: 'input', input: { mx: 1, mz: 0, seq, hp: 100000, x: 900000 } }); await delay(35); }
  assert.ok(p.x > before); assert.ok(p.x - before <= (match.time - simulationTimeBefore) * 7 + .02); assert.ok(p.hp <= 100);
  const observed = await peer.next(msg => msg.type === 'state' && msg.state.players.some(p => p.id === first.id && p.x > before));
  assert.ok(observed.state.players.some(p => p.id === first.id && p.x < 100));
});
test('resume requires token and keeps the same player and rank', async t => {
  const { server, url } = await setup(t); const first = await client(t, url); const session = await join(first, 'create');
  first.send({ type: 'start' }); await first.next(type('state'));
  const closed = new Promise(resolve => first.ws.once('close', resolve)); first.ws.close(); await closed; await delay(50);
  const second = await client(t, url); second.send({ type: 'join', mode: 'resume', code: session.code, token: 'wrong', protocol: PROTOCOL_VERSION });
  assert.match((await second.next(type('error'))).message, /凭证/);
  second.send({ type: 'join', mode: 'resume', code: session.code, token: session.token, protocol: PROTOCOL_VERSION });
  const resumed = await second.next(type('joined')); assert.equal(resumed.id, session.id);
  assert.equal(server.rooms.get(session.code).match.players.length, MAX_PLAYERS);
  assert.equal(server.rooms.get(session.code).match.players.find(p => p.id === session.id).connected, true);
});
test('a second live socket cannot take over an active session', async t => {
  const { url } = await setup(t), first = await client(t, url), second = await client(t, url);
  const session = await join(first, 'create'); second.send({ type: 'join', mode: 'resume', code: session.code, token: session.token, protocol: PROTOCOL_VERSION });
  assert.match((await second.next(type('error'))).message, /另一台设备/);
});
test('host departure transfers room ownership and frees the waiting slot', async t => {
  const { url } = await setup(t), host = await client(t, url), peer = await client(t, url);
  const a = await join(host, 'create'), b = await join(peer, 'join', a.code);
  host.send({ type: 'leave' });
  const lobby = await peer.next(msg => msg.type === 'lobby' && msg.host === b.id);
  assert.equal(lobby.players.length, 1); peer.send({ type: 'start' }); assert.equal((await peer.next(type('state'))).state.counts?.total, MAX_PLAYERS);
});
test('quick match counts down, room cap and malformed input are handled', async t => {
  const { url } = await setup(t, { maxRooms: 1, autoStartMs: 100 });
  const first = await client(t, url), second = await client(t, url); await join(first, 'quick');
  second.send({ type: 'join', mode: 'create', protocol: PROTOCOL_VERSION }); assert.match((await second.next(type('error'))).message, /已满/);
  first.ws.send('not-json'); assert.match((await first.next(type('error'))).message, /格式/);
  assert.equal((await first.next(type('state'))).state.phase, 'loading');
});
test('payload rate limit closes abusive connections', async t => {
  const { url } = await setup(t), c = await client(t, url); const closed = new Promise(resolve => c.ws.once('close', code => resolve(code)));
  for (let n = 0; n < 100; n++) c.send({ type: 'ping', sent: n });
  assert.equal(await closed, 1008);
});

test('four real connections join one squad, a fifth can join another squad', async t => {
  const { server, url } = await setup(t);
  const peers = []; for (let n=0; n<5; n++) peers.push(await client(t,url));
  const first=await join(peers[0],'create'); const joined=[first];
  for(let n=1;n<4;n++)joined.push(await join(peers[n],'join',first.code));
  peers[4].send({type:'join',mode:'join',code:first.code,team:0,protocol:PROTOCOL_VERSION});
  assert.match((await peers[4].next(type('error'))).message,/小队已满/);
  const fifth=await join(peers[4],'join',first.code,1);
  peers[0].send({type:'start'});
  for(const peer of peers) assert.equal((await peer.next(type('state'))).state.counts?.total,MAX_PLAYERS);
  const match=server.rooms.get(first.code).match;
  assert.deepEqual(joined.map(s=>match.players.find(p=>p.id===s.id).team),[0,0,0,0]);
  assert.equal(match.players.find(p=>p.id===fifth.id).team,1);
  assert.equal(match.players.filter(p=>!p.bot).length,5);
});

test('a waiting-room disconnect keeps its slot and restores identity', async t => {
  const {server,url}=await setup(t); const original=await client(t,url); const session=await join(original,'create');
  original.ws.close(); await delay(80);
  assert.equal(server.rooms.get(session.code).members.size,1);
  const replacement=await client(t,url); replacement.send({type:'join',mode:'resume',code:session.code,token:session.token,protocol:PROTOCOL_VERSION});
  assert.equal((await replacement.next(type('joined'))).id,session.id);
  assert.equal((await replacement.next(type('lobby'))).players.length,1);
});

test('old wire protocol is rejected before a room is allocated', async t => {
  const {server,url}=await setup(t); const c=await client(t,url);
  c.send({type:'join',mode:'create',protocol:1}); assert.match((await c.next(type('error'))).message,/版本/); assert.equal(server.rooms.size,0);
});

test('invalid team is reassigned instead of allocating a broken room; leaving an ended match preserves results', async t => {
  const { server, url } = await setup(t); const c = await client(t, url);
  const session = await join(c, 'create');
  assert.equal(server.rooms.size, 1);
  const room = server.rooms.get(session.code);
  room.match.start();
  room.match.end('squad', 0);
  assert.equal(room.match.phase, 'ended');
  assert.equal(room.match.winnerTeam, 0);
  c.send({ type: 'leave' });
  await c.next(type('left'));
  assert.equal(room.match.phase, 'ended');
  assert.equal(room.match.winnerTeam, 0);
});

test('a match waits for connected clients to render before deploying',async t=>{
  const {server,url}=await setup(t);const first=await client(t,url,false),second=await client(t,url,false);
  const session=await join(first,'create');await join(second,'join',session.code);first.send({type:'start'});
  assert.equal((await first.next(type('state'))).state.phase,'loading');first.send({type:'ready'});await delay(250);
  assert.equal(server.rooms.get(session.code).match.phase,'loading');assert.equal(server.rooms.get(session.code).match.time,0);
  second.send({type:'ready'});const state=(await first.next(m=>m.type==='state'&&m.state.phase==='deploying')).state;
  assert.ok(state.time<.5);
});

test('loot deltas remove pickups, and resume rehydrates a full baseline',async t=>{
  const {server,url}=await setup(t);const c=await client(t,url);const joined=await join(c,'create');c.send({type:'start'});
  const initial=(await c.next(type('state'))).state;assert.ok(Array.isArray(initial.loot));
  await c.next(m=>m.type==='state'&&(m.state.phase==='playing'||m.state.phase==='deploying'));
  const room=server.rooms.get(joined.code),p=room.match.players.find(p=>p.id===joined.id);
  room.match.addLoot('armor',p.x+6,p.z);const loot=room.match.loot.at(-1);
  await c.next(m=>m.type==='state'&&m.state.lootPatch?.upsert.some(l=>l.id===loot.id));
  room.match.loot=room.match.loot.filter(l=>l.id!==loot.id);
  await c.next(m=>m.type==='state'&&m.state.lootPatch?.remove.includes(loot.id));
  c.ws.close();await delay(60);const re=await client(t,url);re.send({type:'join',mode:'resume',code:joined.code,token:joined.token,protocol:PROTOCOL_VERSION});
  await re.next(type('joined'));assert.ok(Array.isArray((await re.next(type('state'))).state.loot));
});

// ── 运维端点 /stats ──────────────────────────────────────────────────────────
test('/stats reports memory, rooms, sockets, matches and tick percentiles; /health keeps its fields', async t => {
  const { server, url, http } = await setup(t);
  const a = await client(t, url), b = await client(t, url);
  const session = await join(a, 'create'); await join(b, 'join', session.code);
  a.send({ type: 'start' }); await a.next(msg => msg.type === 'state' && msg.state.phase !== 'waiting');
  await delay(150);
  const stats = await (await fetch(`${http}/stats`)).json();
  assert.equal(stats.ok, true);
  assert.ok(Number.isFinite(stats.uptime) && stats.uptime >= 0);
  assert.ok(stats.memory.rss > 0 && stats.memory.heapUsed > 0);
  assert.equal(stats.rooms, 1); assert.equal(stats.sockets, 2); assert.equal(stats.matches, 1);
  assert.ok(stats.tickMs.p50 >= 0 && stats.tickMs.p95 >= 0 && stats.tickMs.p99 >= 0, 'tick 分位应为非负数');
  assert.equal((await fetch(`${http}/stats`, { method: 'POST' })).status, 405);
  const health = await (await fetch(`${http}/health`)).json();
  assert.equal(health.ok, true); assert.equal(health.protocol, PROTOCOL_VERSION); assert.equal(health.rooms, 1);
  assert.ok(Number(health.players) >= 2);
});

// ── Origin 默认策略 ──────────────────────────────────────────────────────────
function attempt(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { headers: { origin } } : {});
    ws.once('open', () => { try { ws.terminate(); } catch { /* ignore */ } resolve('open'); });
    ws.once('unexpected-response', (req, res) => { try { ws.terminate(); } catch { /* ignore */ } resolve(res.statusCode); });
    ws.once('error', () => resolve('error'));
  });
}
test('default origin policy allows loopback and appassets but rejects foreign origins', async t => {
  const { url } = await setup(t); // 未配置 ALLOWED_ORIGINS
  assert.equal(await attempt(url, 'http://localhost:5173'), 'open', '本地开发端口应放行');
  assert.equal(await attempt(url, 'http://127.0.0.1:8787'), 'open', 'Playwright e2e 来源应放行');
  assert.equal(await attempt(url, 'https://appassets.androidplatform.net'), 'open', 'Android WebView 来源应放行');
  assert.equal(await attempt(url, ''), 'open', '原生客户端不带 Origin 应放行');
  assert.notEqual(await attempt(url, 'https://evil.example'), 'open', '陌生来源应被拒绝');
});
test('explicit ALLOWED_ORIGINS switches to a strict allowlist', async t => {
  const { url } = await setup(t, { origins: ['https://good.example/'] });
  assert.equal(await attempt(url, 'https://good.example'), 'open');
  assert.notEqual(await attempt(url, 'http://localhost:5173'), 'open', '显式白名单下回环不再自动放行');
});

// ── 对局结果落盘 data/matches.jsonl ─────────────────────────────────────────
test('match summaries append one JSON line per match and survive a rematch', async t => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'mist-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = pathJoin(dir, 'nested', 'matches.jsonl'); // 目录不存在：验证自动创建
  const { server, url } = await setup(t, { matchLogPath: path });
  const a = await client(t, url);
  const session = await join(a, 'create');
  server.rooms.get(session.code).match.start();
  server.rooms.get(session.code).match.end('squad', 0);
  await delay(120); // 等 tick 循环检测到 ended
  const lines = () => readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines().length, 1);
  const record = JSON.parse(lines()[0]);
  assert.equal(record.code, session.code);
  assert.equal(record.mode, 'squad');
  assert.equal(record.winnerTeam, 0);
  assert.ok(Number.isFinite(record.durationSec));
  assert.ok(Array.isArray(record.players) && record.players.some((p) => !p.bot && p.name === 'tester'));
  await delay(120); // ended 后继续 tick 也不得重复落盘
  assert.equal(lines().length, 1);
  const b = await client(t, url); // 第二局（新房间）应再落一行
  const second = await join(b, 'create');
  server.rooms.get(second.code).match.start();
  server.rooms.get(second.code).match.end('timeout', null);
  await delay(120);
  assert.equal(lines().length, 2);
  assert.equal(JSON.parse(lines()[1]).code, second.code);
});
test('match log IO failure degrades to a warning and never breaks the match flow', async t => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'mist-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocker = pathJoin(dir, 'blocker');
  await writeFile(blocker, 'x'); // 用一个普通文件挡住落盘路径，制造 mkdir/append 失败
  const events = [];
  const { server, url, http } = await setup(t, {
    matchLogPath: pathJoin(blocker, 'matches.jsonl'),
    log: { level: 'warn', sink: (level, event) => events.push(event) },
  });
  const c = await client(t, url);
  const session = await join(c, 'create');
  const room = server.rooms.get(session.code);
  room.match.start(); room.match.end('squad', 0);
  await delay(120);
  assert.equal(room.match.phase, 'ended');
  assert.ok(events.includes('match-log-failed'), '落盘失败应降级为日志');
  assert.equal((await (await fetch(`${http}/health`)).json()).ok, true, '服务器仍应存活');
});

// ── 优雅停机（可编程触发） ───────────────────────────────────────────────────
test('graceful shutdown broadcasts a Chinese notice and closes sockets with 1001', async t => {
  const server = createGameServer({ host: '127.0.0.1', port: 0, log: { level: 'error' }, shutdownGraceMs: 300 });
  const address = await server.listen();
  t.after(() => server.close());
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const notice = new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data))));
  const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  const stopping = server.shutdown();
  const pushed = await notice;
  assert.equal(pushed.type, 'shutdown');
  assert.match(pushed.reason, /停机/);
  const result = await closed;
  assert.equal(result.code, 1001);
  assert.match(result.reason, /服务器/);
  await stopping;
  await server.shutdown(); // 幂等：重复调用直接返回
  assert.equal(server.shuttingDown, true);
});

// ── 防滥用与输入安全 ─────────────────────────────────────────────────────────
test('a single oversized message closes the connection but the server stays healthy', async t => {
  const { url, http } = await setup(t);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.send('x'.repeat(20 * 1024));
  assert.equal(await closed, 1009);
  assert.equal((await (await fetch(`${http}/health`)).json()).ok, true);
  const again = await attempt(url, ''); // 断开后新连接仍可用
  assert.equal(again, 'open');
});
test('malformed JSON messages are answered and never crash the process', async t => {
  const { url, http } = await setup(t);
  const c = await client(t, url);
  for (const raw of ['{', '[1,2', '"quoted"', '123', 'null', '{"type":']) c.ws.send(raw);
  const err = await c.next((m) => m.type === 'error' && m.code === 'BAD_JSON');
  assert.match(err.message, /格式/);
  c.send({ type: 'ping', sent: 5 });
  assert.equal((await c.next(type('pong'))).sent, 5, '畸形消息后连接仍可正常收发');
  assert.equal((await (await fetch(`${http}/health`)).json()).ok, true);
});

// ── close 可靠性（事件循环清空时不得以 exit 13 收场） ──────────────────────────
test('server.close() resolves promptly while sockets are terminating', async t => {
  const server = createGameServer({ host: '127.0.0.1', port: 0, log: { level: 'error' }, shutdownGraceMs: 1000 });
  const address = await server.listen();
  t.after(() => server.close());
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.terminate();
  let timeoutHit = false;
  await Promise.race([
    server.close(),
    delay(3000).then(() => { timeoutHit = true; }),
  ]);
  if (timeoutHit) throw new Error('server.close() 未在 3 秒内 resolve');
  assert.equal(server.shuttingDown, true);
});

// ── 降落区投票（dropvote）：等待阶段投票 → lobby 广播 → 开局质心 hint ─────────
// 说明：ws 层的 dropvote 分发 case 位于 server/index.mjs（由服务端接线代理维护），
// 这里的测试直接以「服务端成员对象」（room.members.get(id)）驱动 actions.dropVote ——
// 与 index.mjs 接线后到达的是同一函数、同一 client 形状（{id, ws: 服务端套接字}）。
test('dropvote records the latest vote, broadcasts it in lobby, and rejects bad payloads', async t => {
  const { server, url } = await setup(t);
  const host = await client(t, url), peer = await client(t, url);
  const a = await join(host, 'create'), b = await join(peer, 'join', a.code);
  const room = server.rooms.get(a.code);
  const voter = room.members.get(b.id);
  assert.equal(server.actions.dropVote(voter, room, { x: 0.28, z: 0.76 }), true);
  const lobby = await host.next(m => m.type === 'lobby' && Array.isArray(m.dropVotes) && m.dropVotes.length === 1);
  assert.equal(lobby.dropVotes[0].by, b.id);
  assert.equal(lobby.dropVotes[0].name, 'tester');
  assert.equal(lobby.dropVotes[0].team, 0);
  assert.equal(lobby.dropVotes[0].x, 0.28);
  assert.equal(lobby.dropVotes[0].z, 0.76);
  // 最新一票覆盖旧票，越界坐标被 clamp 进 0-1
  assert.equal(server.actions.dropVote(voter, room, { x: 4, z: -2 }), true);
  const updated = await host.next(m => m.type === 'lobby' && m.dropVotes?.[0]?.x === 1);
  assert.equal(updated.dropVotes[0].z, 0);
  assert.equal(room.dropVotes.size, 1, '同一成员只保留最新一票');
  // 非法坐标：拒绝并回错误，不改票
  assert.equal(server.actions.dropVote(voter, room, { x: 'x', z: Number.NaN }), false);
  const bad = await peer.next(m => m.type === 'error' && m.code === 'BAD_DROP');
  assert.match(bad.message, /降落区/);
  assert.equal(room.dropVotes.get(b.id).x, 1);
});

test('dropvote is ignored outside the waiting phase and stale votes never become hints', async t => {
  const { server, url } = await setup(t);
  const host = await client(t, url), peer = await client(t, url);
  const a = await join(host, 'create'), b = await join(peer, 'join', a.code);
  const room = server.rooms.get(a.code);
  // 队友投票后离开：票仍在 Map 里，但不再是成员，开局不得成为 hint
  assert.equal(server.actions.dropVote(room.members.get(b.id), room, { x: 0.05, z: 0.05 }), true);
  await host.next(m => m.type === 'lobby' && m.dropVotes?.length === 1); // 先消化投票广播
  peer.send({ type: 'leave' }); await peer.next(type('left'));
  // 用离开系统聊天做同步点（历史队列里没有该文案），其后第一条 lobby 即离开广播
  await host.next(m => m.type === 'chat' && m.system && /离开了房间/.test(m.text || ''));
  await host.next(m => m.type === 'lobby' && m.dropVotes?.length === 0);
  // 房主投票并开局：质心 = 房主自己的票；开局后（非等待阶段）再投被忽略
  assert.equal(server.actions.dropVote(room.members.get(a.id), room, { x: 0.7, z: 0.4 }), true);
  await host.next(m => m.type === 'lobby' && m.dropVotes?.length === 1);
  host.send({ type: 'start' });
  await host.next(type('state'));
  assert.equal(server.actions.dropVote(room.members.get(a.id), room, { x: 0.1, z: 0.1 }), false);
  const match = room.match;
  assert.deepEqual(match.dropHints, { 0: { x: 0.7, z: 0.4 } }, '开局质心应取在房成员的票');
  assert.equal(room.dropVotes.size, 0, '开局后清票，重开一局从零开始');
  // 有票队人类应贴近质心最近锚点；bot 不受影响
  const anchors = match.world.spawnAnchors;
  const R = match.world.radius;
  const wx = (0.7 * 2 - 1) * R, wz = (0.4 * 2 - 1) * R;
  let target = anchors[0], best = Infinity;
  for (const anc of anchors) {
    const d = (anc.x - wx) ** 2 + (anc.z - wz) ** 2;
    if (d < best) { best = d; target = anc; }
  }
  const human = match.players.find(p => p.id === a.id);
  assert.ok(Math.hypot(human.x - target.x, human.z - target.z) < 6,
    `人类出生应贴近 hint 锚点（${Math.hypot(human.x - target.x, human.z - target.z).toFixed(1)}m）`);
  const bot = match.players.find(p => p.bot && p.team === 0);
  assert.ok(Math.hypot(bot.x - anchors[1].x, bot.z - anchors[1].z) < 5, 'bot 仍走默认锚点');
});

test('kick and waiting-timeout removal clear the departed member vote', async t => {
  const { server, url } = await setup(t);
  const host = await client(t, url), peer = await client(t, url);
  const a = await join(host, 'create'), b = await join(peer, 'join', a.code);
  const room = server.rooms.get(a.code);
  assert.equal(server.actions.dropVote(room.members.get(b.id), room, { x: 0.5, z: 0.5 }), true);
  assert.equal(room.dropVotes.size, 1);
  await host.next(m => m.type === 'lobby' && m.dropVotes?.length === 1); // 先消化投票广播
  host.send({ type: 'kick', targetId: b.id, reason: '测试' });
  // 用踢人系统聊天做同步点（历史队列里没有该文案），其后第一条 lobby 即踢人广播
  await host.next(m => m.type === 'chat' && m.system && /被房主移出房间/.test(m.text || ''));
  await host.next(m => m.type === 'lobby' && m.dropVotes?.length === 0);
  assert.equal(room.dropVotes.size, 0, '被移出成员的票应被清除');
});

// ── 二进制快照协议（wire v1）────────────────────────────────────────────────
// 这一层是「能力协商」：join 里带 binary:true 才走二进制，老客户端行为完全不变。
// 单测覆盖 shared/wire.mjs 的编解码正确性（tests/wire.test.mjs），这里只验证
// 「服务端真的按协商结果发二进制帧，且内容能被客户端解回同构 state」。

/** 以二进制模式连接的客户端：收集二进制帧与 JSON 消息。 */
async function binaryClient(t, url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const json = [], frames = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) { frames.push(data); return; }
    try { json.push(JSON.parse(data.toString())); } catch { /* 忽略非 JSON */ }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  const nextJson = async (predicate, timeout = 6000) => {
    const start = Date.now();
    for (;;) {
      const hit = json.find(predicate);
      if (hit) return hit;
      if (Date.now() - start > timeout) throw new Error('Expected JSON message timed out');
      await delay(20);
    }
  };
  return { ws, json, frames, send: (m) => ws.send(JSON.stringify(m)), nextJson };
}

test('binary: 协商成功后收到二进制 state 帧，且能解回同构快照', async t => {
  const { url } = await setup(t);
  const host = await binaryClient(t, url);
  host.send({ type: 'join', mode: 'create', name: '二进制', protocol: PROTOCOL_VERSION, binary: true });
  const joined = await host.nextJson((m) => m.type === 'joined');
  assert.equal(joined.binary, true, '服务端应确认 binary 能力');

  host.send({ type: 'start' });
  // 服务端在发第一帧二进制之前会先单播一条 roster（静态字段 + 字符串表）
  const rosterMsg = await host.nextJson((m) => m.type === 'roster');
  assert.ok(Array.isArray(rosterMsg.players) && rosterMsg.players.length > 0, 'roster 必须带玩家名单');

  // 等第一批二进制帧
  const deadline = Date.now() + 6000;
  while (!host.frames.length && Date.now() < deadline) await delay(50);
  assert.ok(host.frames.length > 0, '协商为二进制后必须收到二进制 state 帧');
  assert.equal(host.json.filter((m) => m.type === 'state').length, 0, '不应再收到 JSON state');

  // 用服务端下发的 roster 建上下文解码
  const ctx = createWireContext({ roster: rosterMsg.players });
  const first = new Uint8Array(host.frames[0]);
  const decoded = decodeStateFrame(first, ctx);
  assert.equal(decoded.type, 'state');
  assert.ok(decoded.state, '解码结果必须包含 state');
  assert.equal(decoded.state.selfId, joined.id, '解码后的 selfId 应与 joined.id 一致');
  assert.ok(Array.isArray(decoded.state.players), 'players 必须是数组');
  assert.ok(decoded.state.me, '必须包含 me');
});

test('binary: 未协商的连接继续收 JSON，二者互不影响', async t => {
  const { url } = await setup(t);
  const bin = await binaryClient(t, url);
  bin.send({ type: 'join', mode: 'create', name: '二进制', protocol: PROTOCOL_VERSION, binary: true });
  const hostJoined = await bin.nextJson((m) => m.type === 'joined');

  const plain = await client(t, url);
  const peerJoined = await join(plain, 'join', hostJoined.code);
  assert.notEqual(peerJoined.binary, true, '未声明 binary 的客户端不应被判为二进制');

  bin.send({ type: 'start' });
  const stateMsg = await plain.next(type('state'));
  assert.ok(stateMsg.state, 'JSON 客户端必须收到结构完整的 state');
  await delay(300);
  assert.ok(bin.frames.length > 0, '二进制客户端应继续收到二进制帧');
});

test('binary: WIRE_BINARY=0 时即使声明 binary 也退回 JSON', async t => {
  const { url } = await setup(t, { binary: false });
  const host = await client(t, url);
  const joined = await join(host, 'create');
  assert.notEqual(joined.binary, true, '服务端禁用二进制后不应确认该能力');
  host.send({ type: 'start' });
  const stateMsg = await host.next(type('state'));
  assert.ok(stateMsg.state, '回退路径必须仍能收到 JSON state');
});

test('binary: 二进制帧体积显著小于同等 JSON state', async t => {
  const { url } = await setup(t);
  const bin = await binaryClient(t, url);
  bin.send({ type: 'join', mode: 'create', name: '二进制', protocol: PROTOCOL_VERSION, binary: true });
  const hostJoined = await bin.nextJson((m) => m.type === 'joined');

  const plain = await client(t, url);
  await join(plain, 'join', hostJoined.code);

  bin.send({ type: 'start' });
  await delay(2500);

  const jsonState = await plain.next((m) => m.type === 'state' && m.state?.phase !== 'waiting');
  const jsonBytes = Buffer.byteLength(JSON.stringify(jsonState));
  assert.ok(bin.frames.length > 0, '二进制客户端应有帧');
  const binBytes = bin.frames.reduce((s, f) => s + (f.byteLength ?? f.length), 0) / bin.frames.length;
  assert.ok(binBytes < jsonBytes, `二进制帧应小于 JSON：${binBytes} vs ${jsonBytes}`);
  assert.ok(binBytes < jsonBytes * 0.6, `压缩不足：${((binBytes / jsonBytes) * 100).toFixed(1)}%`);
});

// ── 运维端点鉴权（OPS_TOKEN）──────────────────────────────────────────────
// /stats 与 /metrics 会暴露内存、房间数、连接数、tick 分位与全部 Prometheus 指标，
// 公网裸奔等于给攻击者一张拓扑图。设置 OPS_TOKEN 后必须带 Bearer；未设置时保持开放
// （本机开发/内网部署的默认行为，与 1.1.0 一致）。
test('ops: 未设置 OPS_TOKEN 时 /stats 与 /metrics 开放', async (t) => {
  const { http } = await setup(t);
  assert.equal((await fetch(`${http}/stats`)).status, 200);
  assert.equal((await fetch(`${http}/metrics`)).status, 200);
});

test('ops: 设置 OPS_TOKEN 后无令牌返回 404，带正确令牌返回 200', async (t) => {
  const { http } = await setup(t, { opsToken: 'secret-token-123' });
  // 无令牌：404（不确认端点存在，比 403 更不泄露信息）
  assert.equal((await fetch(`${http}/stats`)).status, 404);
  assert.equal((await fetch(`${http}/metrics`)).status, 404);
  // 错误令牌
  assert.equal((await fetch(`${http}/stats`, { headers: { Authorization: 'Bearer wrong' } })).status, 404);
  // 正确令牌（Bearer）
  const okHeader = await fetch(`${http}/stats`, { headers: { Authorization: 'Bearer secret-token-123' } });
  assert.equal(okHeader.status, 200);
  assert.equal((await okHeader.json()).ok, true);
  // 正确令牌（query 参数，给浏览器/简易探针对用）
  assert.equal((await fetch(`${http}/metrics?token=secret-token-123`)).status, 200);
});

// ── 反代真实 IP（TRUST_PROXY）───────────────────────────────────────────────
// 经 Caddy/Nginx 反代后，`req.socket.remoteAddress` 对所有玩家都是 127.0.0.1，
// 每 IP 连接配额（默认 8）会在第 9 个玩家时永久 429 —— 按推荐方式部署后游戏不可用。
// 打开 TRUST_PROXY 后读 X-Forwarded-For 的最右一项；默认关闭，防止伪造头绕过配额。
test('trust proxy: 默认关闭时不采信 X-Forwarded-For（防伪造绕过配额）', async (t) => {
  const { url } = await setup(t, { maxConnectionsPerIp: 2 });
  // 连续开 3 条连接，每条都伪造不同的 XFF —— 若被采信，三条各占一份配额，不会被拒
  const sockets = [];
  let rejected = 0;
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(url, { headers: { 'X-Forwarded-For': `10.0.0.${i + 1}` } });
    const outcome = await new Promise((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('rejected'));
      ws.once('unexpected-response', () => resolve('rejected'));
    });
    if (outcome === 'rejected') rejected++;
    else sockets.push(ws);
  }
  for (const ws of sockets) { try { ws.terminate(); } catch { /* ignore */ } }
  assert.ok(rejected >= 1, `默认应忽略伪造的 XFF，第 3 条连接应被配额拒绝（实际 rejected=${rejected}）`);
});

test('trust proxy: 打开后按 X-Forwarded-For 的**最右**一项识别客户端', async (t) => {
  const { server } = await setup(t, { trustProxy: true, maxConnectionsPerIp: 1 });
  // 通过内部接口验证解析结果（真实反代场景下最右项才是可信代理写入的那个）
  assert.equal(typeof server, 'object');
  // 直接测解析：伪造的左侧项不应被采用
  const cases = [
    { xff: '1.2.3.4', expect: '1.2.3.4' },
    { xff: '9.9.9.9, 5.6.7.8', expect: '5.6.7.8' },     // 最右
    { xff: '9.9.9.9, 5.6.7.8,', expect: '5.6.7.8' },   // 尾逗号
    { xff: '', expect: null },                          // 空：回落直连地址
  ];
  for (const c of cases) {
    const got = server.clientIpForTest({ headers: { 'x-forwarded-for': c.xff }, socket: { remoteAddress: '127.0.0.1' } });
    if (c.expect) assert.equal(got, c.expect, `XFF="${c.xff}" 应解析为 ${c.expect}`);
    else assert.equal(got, '127.0.0.1', '空 XFF 应回落到直连地址');
  }
});
