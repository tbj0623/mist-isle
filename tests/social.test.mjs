// 雾岛突围 / MIST ISLE 1.1 — 社交服务单测（owner: social · tests/social.test.mjs）
// 覆盖：好友上限 / 重复添加 / 邀请过期 / 战队人数上限 / profile 净化 / 断线保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocial, SOCIAL_LIMITS, EMOTES } from '../server/social.mjs';

/** 假时钟 + 收集下发消息；ws 用 {readyState:1} 冒充已连接。 */
function setup(startAt = 1_000_000) {
  let now = startAt;
  const sent = [];
  const io = { send: (ws, data) => { sent.push({ ws, data }); return true; } };
  const social = createSocial({ io, registry: null, now: () => now });
  const sock = (tag) => ({ readyState: 1, tag });
  return { social, sent, sock, tick: (ms) => { now += ms; return now; } };
}
const live = (s, id) => { const w = { readyState: 1, tag: id }; s.onConnect({ id, ws: w }); return w; };
const pick = (o, ...keys) => keys.map((k) => o[k]);

test('好友：双向添加，重复添加被拒绝', () => {
  const { social } = setup();
  live(social, 'a'); live(social, 'b');
  assert.equal(social.addFriend('a', 'b').ok, true);
  assert.deepEqual([social.listFriends('a').length, social.listFriends('b').length], [1, 1], '好友必须双向');
  const dup = social.addFriend('a', 'b');
  assert.deepEqual([dup.ok, dup.reason], [false, 'ALREADY_FRIEND']);
  assert.equal(social.addFriend('a', 'a').reason, 'SELF');
  assert.equal(social.addFriend('a', 'nobody').reason, 'NOT_FOUND');
});

test('好友上限 50：第 51 个被拒绝', () => {
  const { social } = setup();
  social.profile('owner'); // 目标必须已建档（好友只能加已存在的玩家）
  for (let i = 0; i < SOCIAL_LIMITS.friends; i++) {
    social.addFriend('owner', social.profile(`f${i}`).id);
    assert.equal(social.listFriends('owner').filter((f) => f.id === `f${i}`).length, 1, `第 ${i + 1} 个好友应成功`);
  }
  assert.equal(social.listFriends('owner').length, SOCIAL_LIMITS.friends);
  social.profile('overflow');
  assert.deepEqual(pick(social.addFriend('owner', 'overflow'), 'ok', 'reason'), [false, 'FRIEND_LIMIT']);
  assert.equal(social.listFriends('owner').length, SOCIAL_LIMITS.friends, '超限后不落库');
});

test('邀请：30 秒过期后 respond 返回 EXPIRED', () => {
  const { social, tick } = setup();
  live(social, 'inviter'); live(social, 'target');
  assert.equal(social.invite('inviter', 'target', 'ab12').ok, true);
  const invites = social.pendingInvites('target');
  assert.deepEqual([invites.length, invites[0].roomCode], [1, 'AB12'], '房间码统一大写');
  tick(SOCIAL_LIMITS.inviteTtlMs - 1);
  assert.equal(social.respondInvite('target', social.invite('inviter', 'target', 'cd34').inviteId, false).ok, true);
  const old = social.invite('inviter', 'target', 'ef56');
  tick(SOCIAL_LIMITS.inviteTtlMs + 1);
  assert.deepEqual(pick(social.respondInvite('target', old.inviteId, true), 'ok', 'reason'), [false, 'EXPIRED'], '过期报 EXPIRED 而非 NOT_FOUND');
});

test('邀请：别人不能替你处理；离线目标不可邀请', () => {
  const { social } = setup();
  live(social, 'p1'); const w2 = live(social, 'p2');
  const inv = social.invite('p1', 'p2', 'zz99');
  assert.equal(social.respondInvite('p1', inv.inviteId, true).reason, 'NOT_YOURS');
  assert.equal(social.invite('p1', 'ghost', 'zz99').reason, 'NOT_FOUND');
  social.onDisconnect({ id: 'p2', ws: w2 });
  assert.equal(social.invite('p1', 'p2', 'aa11').reason, 'OFFLINE');
});

test('战队：20 人上限，超出返回 CLAN_FULL', () => {
  const { social } = setup();
  const created = social.createClan('lead', { name: '雾岛小队', tag: 'MI' });
  assert.deepEqual([created.ok, created.clan.memberCount], [true, 1]);
  const clanId = created.clan.id;
  for (let i = 1; i < SOCIAL_LIMITS.clanMembers; i++) {
    assert.equal(social.joinClan(`m${i}`, clanId).ok, true, `第 ${i + 1} 人应入队`);
  }
  assert.equal(social.clanInfo(clanId).memberCount, SOCIAL_LIMITS.clanMembers);
  assert.deepEqual(pick(social.joinClan('m99', clanId), 'ok', 'reason'), [false, 'CLAN_FULL']);
  assert.equal(social.clanInfo(clanId).memberCount, SOCIAL_LIMITS.clanMembers, '超限不改人数');
  assert.equal(social.createClan('lead', { name: '另一队', tag: 'AB' }).reason, 'ALREADY_IN_CLAN');
  assert.equal(social.createClan('newbie', { name: '雾岛小队', tag: 'QQ' }).reason, 'NAME_TAKEN');
  assert.equal(social.createClan('newbie', { name: '新队', tag: 'x' }).reason, 'BAD_TAG');
});

test('profile：名字净化到 20 字，非法 rank 被忽略，id 不可篡改', () => {
  const { social } = setup();
  live(social, 'u1');
  const view = social.updateProfile('u1', { name: `<b>${'名'.repeat(40)}</b>`, rank: 'god', level: 999, id: 'x' });
  assert.equal(view.id, 'u1', 'id 不可被 patch 覆盖');
  assert.ok(view.name.length <= SOCIAL_LIMITS.nameMax, `名字应≤20 字，实际 ${view.name.length}`);
  assert.equal(/[<>]/.test(view.name), false, '尖括号应被净化');
  assert.deepEqual([view.rank, view.level], ['bronze', 100], '非法 rank 忽略，level 夹到上限');
  assert.equal(social.updateProfile('u1', { name: '    ' }).name, view.name, '空名字不覆盖');
});

test('断线保留 profile 10 分钟，过期后好友关系一起清理', () => {
  const { social, tick } = setup();
  live(social, 'ka'); const b = live(social, 'kb');
  social.addFriend('ka', 'kb');
  social.onDisconnect({ id: 'kb', ws: b });
  assert.equal(social.profile('ka').friendCount, 1, '断线期间好友仍在');
  tick(5 * 60 * 1000);
  assert.deepEqual([social.profile('kb').online, social.listFriends('ka')[0].online], [false, false]);
  tick(SOCIAL_LIMITS.profileTtlMs + 1);
  social.purge();
  assert.equal(social.profiles.has('kb'), false, '超过 10 分钟应回收 profile');
  assert.equal(social.listFriends('ka').length, 0, '对端好友关系应一并清理');
});

test('协议层 handle：统一返回 {type:"social", action, ok} 并带回 reqId', () => {
  const { social } = setup();
  live(social, 'p1'); live(social, 'p2');
  const a = { readyState: 1 };
  social.onConnect({ id: 'p1', ws: a });
  const added = social.handle({ id: 'p1' }, a, { type: 'social:friend:add', action: 'friend:add', id: 'p2', reqId: 'r1' });
  assert.deepEqual([added.type, added.action, added.ok, added.reqId], ['social', 'friend:add', true, 'r1']);
  assert.deepEqual(pick(social.handle({ id: 'p1' }, a, { action: 'nope:action', reqId: 'r2' }), 'ok', 'reason'), [false, 'BAD_ACTION']);
  const clan = social.handle({ id: 'p1' }, a, { action: 'clan:create', name: '测试队', tag: 'TS', reqId: 'r3' });
  assert.deepEqual([clan.ok, clan.clan.memberCount], [true, 1]);
  assert.equal(social.handle({ id: 'p1' }, a, { action: 'clan:info', reqId: 'r4' }).clan.id, clan.clan.id);
  assert.equal(social.handle({ id: 'p1' }, a, { action: 'emote', emote: 'wave' }).ok, false, '不在房间不能发表情');
  assert.ok(Object.keys(EMOTES).length >= 6);
});

// ── 缺陷 2 回归：社交身份只能由服务端签发的 sid / 玩家 id 决定 ──────────────────
// 历史 bug：social.handle 用 `client.id || msg.pid`，而 client.id 只在大厅阶段为 null，
// 于是服务端完全信任客户端自报的 pid。玩家 id 在房间的 lobby/joined 消息里是明文，
// 同房任何人（甚至任意连接）都能拿别人的 id 改档案、读好友与邀请、以他人身份发申请。
// 下面用两条真实 WebSocket 连接复现攻击面，验证修复后服务端只认自己的身份。
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.mjs';
import { PROTOCOL_VERSION } from '../shared/rules.mjs';

async function wsPair(t) {
  const app = createGameServer({ host: '127.0.0.1', port: 0, log: { level: 'error' }, shutdownGraceMs: 50 });
  const { port } = await app.listen();
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${port}/ws`;
  const open = (name) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      const n = waiters.findIndex((w) => w.predicate(msg));
      if (n >= 0) { const [w] = waiters.splice(n, 1); clearTimeout(w.timer); w.resolve(msg); } else queue.push(msg);
    });
    ws.once('error', reject);
    ws.once('open', () => {
      t.after(() => { try { ws.terminate(); } catch { /* ignore */ } });
      resolve({
        ws,
        send: (msg) => ws.send(JSON.stringify(msg)),
        next: (predicate, timeout = 4000) => {
          const n = queue.findIndex(predicate);
          if (n >= 0) return Promise.resolve(queue.splice(n, 1)[0]);
          return new Promise((res, rej) => {
            const w = { predicate, resolve: res, timer: null };
            w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error(`timed out: ${name}`)); }, timeout);
            waiters.push(w);
          });
        },
      });
    });
  });
  return { app, open };
}

test('社交身份：服务端签发 sid，冒用他人 playerId 改不了对方档案', async (t) => {
  const { app, open } = await wsPair(t);
  const A = await open('A');
  const helloA = await A.next((m) => m.type === 'hello');
  const B = await open('B');
  const helloB = await B.next((m) => m.type === 'hello');
  assert.ok(helloA.sid, 'hello 必须下发服务端签发的 sid');
  assert.notEqual(helloA.sid, helloB.sid, '每条连接一个独立 sid');

  // B 进房拿到明文可见的 playerId（lobby/joined 里任何人可见）
  B.send({ type: 'join', mode: 'create', protocol: PROTOCOL_VERSION, name: 'BRAVO', team: 0 });
  const joined = await B.next((m) => m.type === 'joined');
  const victimId = joined.id;
  assert.ok(victimId && victimId !== helloB.sid);
  // B 在房间里的社交档案会在 join 时建立
  assert.ok(app.social.profiles.has(victimId), '进房后社交档案以 playerId 为键');

  // 攻击：A 从未进房，用 B 的 playerId 冒充
  A.send({
    type: 'social:profile', action: 'profile', pid: victimId,
    profile: { name: 'HACKED', level: 100 }, reqId: 'atk1',
  });
  const reply = await A.next((m) => m.type === 'social' && m.action === 'profile' && m.reqId === 'atk1');
  assert.equal(reply.profile.id, helloA.sid, 'A 改到的是自己的档案（sid），不是受害者的');
  assert.notEqual(reply.profile.id, victimId);
  // 受害者档案必须原封不动
  const victim = app.social.profiles.get(victimId);
  assert.notEqual(victim.name, 'HACKED', '受害者昵称未被篡改');
  assert.notEqual(victim.level, 100, '受害者等级未被篡改');
  assert.equal(victim.name, 'BRAVO');

  // 读好友/邀请同样不能被冒用：A 带 pid 查询，返回的仍是 A 自己的（空）邀请
  A.send({ type: 'social:invites', action: 'invites', pid: victimId, reqId: 'atk2' });
  const invites = await A.next((m) => m.type === 'social' && m.action === 'invites' && m.reqId === 'atk2');
  assert.deepEqual(invites.invites, [], '拿到的不是受害者的邀请列表');

  // 以他人身份发好友申请：好友关系应落在 A 的 sid 上
  app.social.profile('someone');
  A.send({ type: 'social:friend:add', action: 'friend:add', pid: victimId, id: 'someone', reqId: 'atk3' });
  const added = await A.next((m) => m.type === 'social' && m.action === 'friend:add' && m.reqId === 'atk3');
  assert.equal(added.ok, true);
  assert.equal(app.social.profiles.get(helloA.sid).friends.has('someone'), true, '申请以 A 的 sid 发出');
  assert.equal(app.social.profiles.get(victimId).friends.has('someone'), false, '受害者没有被代发申请');
});

test('社交身份：每条连接用自己的 sid 正常读写自己的档案', async (t) => {
  const { open } = await wsPair(t);
  const A = await open('A');
  const helloA = await A.next((m) => m.type === 'hello');
  A.send({ type: 'social:profile', action: 'profile', profile: { name: '夜刃', level: 7, rank: 'gold' }, reqId: 'p1' });
  const written = await A.next((m) => m.type === 'social' && m.action === 'profile' && m.reqId === 'p1');
  assert.equal(written.ok, true);
  assert.equal(written.profile.id, helloA.sid, '档案键就是服务端签发的 sid');
  assert.deepEqual([written.profile.name, written.profile.level, written.profile.rank], ['夜刃', 7, 'gold']);

  // 重新读一次（走 handle → ensure(claimed)，不依赖客户端任何自报字段）
  A.send({ type: 'social:profile', action: 'profile', reqId: 'p2' });
  const read = await A.next((m) => m.type === 'social' && m.action === 'profile' && m.reqId === 'p2');
  assert.equal(read.profile.id, helloA.sid);
  assert.equal(read.profile.name, '夜刃');
  assert.equal(read.profile.level, 7);

  // 另一条连接（不同 sid）看到的是自己的空档案，看不到 A 的
  const B = await open('B');
  await B.next((m) => m.type === 'hello');
  B.send({ type: 'social:profile', action: 'profile', reqId: 'p3' });
  const other = await B.next((m) => m.type === 'social' && m.action === 'profile' && m.reqId === 'p3');
  assert.notEqual(other.profile.id, helloA.sid);
  assert.notEqual(other.profile.name, '夜刃');
});

test('社交身份：handle 完全忽略 msg.pid（协议层单测）', () => {
  const { social } = setup();
  const ws = { readyState: 1 };
  const res = social.handle({ sid: 'server-sid-1' }, ws, {
    type: 'social:profile', action: 'profile', pid: 'victim', profile: { name: 'X' },
  });
  assert.equal(res.profile.id, 'server-sid-1', '只认传入的 sid');
  assert.equal(social.profiles.has('victim'), false, 'pid 不会凭空建出受害者档案');
});

test('liveWs 使用 WebSocket.OPEN 语义，并支持注入 isOpen', () => {
  const sent = [];
  const io = { send: (ws, data) => { sent.push({ ws, data }); return true; } };
  const social = createSocial({ io, registry: null, now: () => 1, isOpen: (ws) => ws.readyState === WebSocket.OPEN });
  const open = { readyState: WebSocket.OPEN };
  const closing = { readyState: WebSocket.CLOSING };
  social.onConnect({ id: 'a', ws: open });
  social.onConnect({ id: 'b', ws: { readyState: WebSocket.OPEN } });
  social.addFriend('a', 'b');
  sent.length = 0;
  const n = social.notifyFriends('a', { type: 'social', action: 'presence' });
  assert.equal(n, 1, '只推给 OPEN 的连接');
  assert.equal(sent.every((s) => s.ws.readyState === WebSocket.OPEN), true);
  assert.equal(closing.readyState === 1, false, 'WebSocket.CLOSING 不再是「在线」');
});
