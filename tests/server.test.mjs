import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.mjs';
import { PROTOCOL_VERSION, MAX_PLAYERS } from '../shared/rules.mjs';

async function setup(t, options = {}) {
  const server = createGameServer({ host: '127.0.0.1', port: 0, ...options });
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
