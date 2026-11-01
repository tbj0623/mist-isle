// 雾岛突围 / MIST ISLE 1.1 — 社交服务（owner: social · server/social.mjs）
// 职责：玩家档案 / 好友 / 组队邀请 / 战队 / 在线状态 / 表情广播。
// 纯内存（Map），服务端重启即清空；不接数据库，也不修改房间状态（registry 只读）。
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { clampStr } from './rooms.mjs';

/** 表情轮盘：id 与 client/ui-social.js 的 EMOTES 保持一致。 */
export const EMOTES = {
  wave: { emoji: '👋', text: '集合' }, caution: { emoji: '🎯', text: '小心' },
  medic: { emoji: '🚑', text: '需要治疗' }, ok: { emoji: '👍', text: '好' },
  no: { emoji: '👎', text: '不行' }, nice: { emoji: '🔥', text: '漂亮' },
  dead: { emoji: '💀', text: '挂了' }, run: { emoji: '🏃', text: '快跑' },
};

/** 全部硬上限集中在这里，测试与 UI 都可引用。 */
export const SOCIAL_LIMITS = {
  friends: 50, clanMembers: 20, inviteTtlMs: 30 * 1000, profileTtlMs: 10 * 60 * 1000,
  pendingInvites: 12, invites: 500, nameMax: 20, tagMin: 2, tagMax: 4,
};

const RANKS = new Set(['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'legend']);
const int = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * 创建社交服务。io 只用来 io.send(ws, data)；registry 只读 registry.rooms；now 可注入假时钟。
 * isOpen 可注入自定义「套接字是否可写」判定；默认用 WebSocket.OPEN 常量，
 * 避免把 ws@8 的 OPEN === 1 硬编码在业务代码里（换库/换常量就静默失效）。
 */
export function createSocial({ io, registry = null, now = Date.now, isOpen = null } = {}) {
  const clock = typeof now === 'function' ? now : () => Number(now) || Date.now();
  const send = (ws, data) => (typeof io?.send === 'function' ? io.send(ws, data) : false);
  const profiles = new Map(); // clientId -> { id, name, level, rank, friends:Set, clanId, ws:Set, ... }
  const clans = new Map();    // clanId -> { id, name, tag, ownerId, members:Set, created }
  const invites = new Map();  // inviteId -> { id, fromId, fromName, toId, roomCode, at, expiresAt }

  // ── 内部工具 ──────────────────────────────────────────────────────────────
  const roomOf = (id) => {
    const rooms = registry?.rooms;
    if (!rooms || typeof rooms.values !== 'function') return null;
    for (const room of rooms.values()) if (room?.members?.has?.(id)) return room;
    for (const room of rooms.values()) if (room?.spectators?.has?.(id)) return room;
    return null;
  };
  // 断开的 ws 可能还没触发 close：按 readyState 兜底，避免把幽灵连接算作在线。
  // readyState === undefined 表示测试替身（无 readyState 字段），按可写处理。
  const liveWs = typeof isOpen === 'function'
    ? (ws) => !!ws && isOpen(ws)
    : (ws) => !!ws && (ws.readyState === undefined || ws.readyState === WebSocket.OPEN);

  const ensure = (rawId) => {
    const id = clampStr(rawId, 64);
    if (!id) return null;
    let p = profiles.get(id);
    if (p) return p;
    p = {
      id, name: `旅人${id.slice(-3)}`, level: 1, rank: 'bronze', avatar: 'default',
      lastSeen: clock(), status: 'offline', roomCode: null, friends: new Set(),
      clanId: null, ws: new Set(), offlineAt: clock(),
    };
    profiles.set(id, p);
    return p;
  };

  const stateOf = (p) => (p.ws.size ? (p.roomCode ? 'in-room' : 'online') : 'offline');
  const view = (p) => (p ? {
    id: p.id, name: p.name, level: p.level, rank: p.rank, avatar: p.avatar,
    lastSeen: p.lastSeen, status: stateOf(p), online: p.ws.size > 0,
    roomCode: p.roomCode || null, clanId: p.clanId || null, friendCount: p.friends.size,
  } : null);
  const friendView = (t) => ({
    id: t.id, name: t.name, level: t.level, online: t.ws.size > 0,
    roomCode: t.roomCode || null, status: stateOf(t),
  });

  /** 支持「玩家 ID / 昵称」直接定位，方便好友面板按名字添加。 */
  const resolve = (ref) => {
    const key = clampStr(ref, 64);
    if (!key) return null;
    const direct = profiles.get(key);
    if (direct) return direct;
    const lower = key.toLowerCase();
    // 昵称匹配不区分大小写：先查已建档档案，再查房间成员。
    for (const p of profiles.values()) if (String(p.name || '').toLowerCase() === lower) return p;
    for (const room of registry?.rooms?.values?.() || []) {
      for (const m of room.members?.values?.() || []) {
        if (m?.id && String(m.name || '').toLowerCase() === lower) return ensure(m.id);
      }
    }
    return null;
  };

  const listFriends = (clientId) => {
    purge();
    const p = ensure(clientId);
    if (!p) return [];
    const out = [];
    for (const id of p.friends) { const f = profiles.get(id); if (f) out.push(friendView(f)); }
    return out.sort((a, b) => (Number(b.online) - Number(a.online)) || a.name.localeCompare(b.name, 'zh-CN'));
  };

  const purge = () => {
    const t = clock();
    for (const [id, p] of [...profiles]) {
      if (p.ws.size || !p.offlineAt || t - p.offlineAt <= SOCIAL_LIMITS.profileTtlMs) continue;
      for (const fid of p.friends) profiles.get(fid)?.friends.delete(id);
      if (p.clanId) leaveClan(id, true);
      profiles.delete(id);
    }
    for (const [id, inv] of [...invites]) if (t > inv.expiresAt) invites.delete(id);
  };

  // ── 档案 ──────────────────────────────────────────────────────────────────
  const profile = (clientId) => { purge(); return view(ensure(clientId)); };

  /** 只改自己的档案：id / status / clanId 等字段一律忽略，name/avatar/level/rank 净化后写入。 */
  const updateProfile = (clientId, patch = null) => {
    const p = ensure(clientId);
    if (!p) return null;
    if (patch && typeof patch === 'object') {
      if (patch.name !== undefined) p.name = clampStr(patch.name, SOCIAL_LIMITS.nameMax) || p.name;
      if (patch.avatar !== undefined) p.avatar = clampStr(patch.avatar, 32) || p.avatar;
      if (patch.level !== undefined) p.level = int(patch.level, 1, 100, p.level);
      if (patch.rank !== undefined) {
        const rank = clampStr(patch.rank, 12).toLowerCase();
        if (RANKS.has(rank)) p.rank = rank;
      }
    }
    p.lastSeen = clock();
    return view(p);
  };

  // ── 好友（双向） ──────────────────────────────────────────────────────────
  const pushFriends = (p) => {
    const friends = listFriends(p.id);
    for (const ws of p.ws) send(ws, { type: 'social', action: 'friends:update', friends });
    return friends;
  };

  const addFriend = (a, b) => {
    purge();
    const from = ensure(a);
    const target = resolve(b);
    if (!from) return { ok: false, reason: 'BAD_ID' };
    if (!target) return { ok: false, reason: 'NOT_FOUND' };
    if (target.id === from.id) return { ok: false, reason: 'SELF' };
    if (from.friends.has(target.id)) return { ok: false, reason: 'ALREADY_FRIEND' };
    if (from.friends.size >= SOCIAL_LIMITS.friends) return { ok: false, reason: 'FRIEND_LIMIT' };
    if (target.friends.size >= SOCIAL_LIMITS.friends) return { ok: false, reason: 'TARGET_FRIEND_LIMIT' };
    from.friends.add(target.id);
    target.friends.add(from.id);
    pushFriends(target);
    return { ok: true, friend: friendView(target), friends: pushFriends(from) };
  };

  const removeFriend = (a, b) => {
    purge();
    const from = ensure(a);
    const target = resolve(b);
    if (!from) return { ok: false, reason: 'BAD_ID' };
    if (!target) return { ok: false, reason: 'NOT_FOUND' };
    if (!from.friends.has(target.id)) return { ok: false, reason: 'NOT_FRIEND' };
    from.friends.delete(target.id);
    target.friends.delete(from.id);
    pushFriends(target);
    return { ok: true, friends: pushFriends(from) };
  };

  // ── 组队邀请（30 秒过期） ──────────────────────────────────────────────────
  const invitesOf = (toId) => {
    purge();
    const out = [];
    for (const inv of invites.values()) {
      if (inv.toId !== toId) continue;
      out.push({
        id: inv.id, fromId: inv.fromId, fromName: profiles.get(inv.fromId)?.name || inv.fromName || '队友',
        roomCode: inv.roomCode, createdAt: inv.at, expiresAt: inv.expiresAt,
        remainingMs: Math.max(0, inv.expiresAt - clock()),
      });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  };

  const invite = (fromId, toId, roomCode) => {
    purge();
    const from = ensure(fromId);
    const target = resolve(toId);
    if (!from) return { ok: false, reason: 'BAD_ID' };
    if (!target) return { ok: false, reason: 'NOT_FOUND' };
    if (target.id === from.id) return { ok: false, reason: 'SELF' };
    if (!target.ws.size) return { ok: false, reason: 'OFFLINE' };
    const pending = invitesOf(target.id);
    if (pending.length >= SOCIAL_LIMITS.pendingInvites) return { ok: false, reason: 'TOO_MANY' };
    const code = clampStr(roomCode, 8).toUpperCase() || null;
    if (pending.some((i) => i.fromId === from.id && i.roomCode === code)) return { ok: false, reason: 'DUPLICATE' };
    const now0 = clock();
    const inv = {
      id: randomBytes(6).toString('hex'), fromId: from.id, fromName: from.name, toId: target.id,
      roomCode: code, at: now0, expiresAt: now0 + SOCIAL_LIMITS.inviteTtlMs,
    };
    invites.set(inv.id, inv);
    if (invites.size > SOCIAL_LIMITS.invites) {
      const oldest = [...invites.values()].sort((a, b) => a.at - b.at)[0];
      if (oldest) invites.delete(oldest.id);
    }
    const payload = { type: 'social', action: 'invite', invite: { ...inv, remainingMs: SOCIAL_LIMITS.inviteTtlMs } };
    for (const ws of target.ws) send(ws, payload);
    return { ok: true, inviteId: inv.id, expiresIn: SOCIAL_LIMITS.inviteTtlMs };
  };

  const respondInvite = (toId, inviteId, accept) => {
    // 先取再 purge：purge 会删掉过期邀请，先 purge 会把 EXPIRED 误报成 NOT_FOUND。
    const id = clampStr(inviteId, 32);
    const inv = invites.get(id);
    if (!inv) { purge(); return { ok: false, reason: 'NOT_FOUND' }; }
    if (inv.toId !== toId) return { ok: false, reason: 'NOT_YOURS' };
    invites.delete(id);
    if (clock() > inv.expiresAt) return { ok: false, reason: 'EXPIRED' };
    const action = accept ? 'invite:accepted' : 'invite:declined';
    for (const ws of profiles.get(inv.fromId)?.ws || []) {
      send(ws, { type: 'social', action, inviteId: id, by: toId, roomCode: inv.roomCode });
    }
    return accept ? { ok: true, accepted: true, roomCode: inv.roomCode } : { ok: true, accepted: false };
  };

  const pendingInvites = (clientId) => invitesOf(clampStr(clientId, 64));

  // ── 战队 ──────────────────────────────────────────────────────────────────
  const clanInfo = (clanId) => {
    const clan = clans.get(clampStr(clanId, 32));
    if (!clan) return null;
    const members = [...clan.members].map((id) => {
      const p = profiles.get(id);
      return {
        id, name: p?.name || '旅人', level: p?.level || 1, rank: p?.rank || 'bronze',
        online: !!p?.ws.size, owner: id === clan.ownerId,
      };
    });
    return {
      id: clan.id, name: clan.name, tag: clan.tag, ownerId: clan.ownerId,
      members, memberCount: members.length, score: members.reduce((s, m) => s + m.level, 0),
      maxMembers: SOCIAL_LIMITS.clanMembers, created: clan.created,
    };
  };

  /** 战队成员推送：clan 为 null 时只推「已退出」。 */
  const pushClan = (clan, leftWs = []) => {
    if (!clan) return;
    const info = clanInfo(clan.id);
    for (const id of clan.members) for (const ws of profiles.get(id)?.ws || []) {
      send(ws, { type: 'social', action: 'clan:update', clan: info });
    }
    for (const ws of leftWs) send(ws, { type: 'social', action: 'clan:left', clanId: clan.id });
  };

  const createClan = (ownerId, data = null) => {
    purge();
    const owner = ensure(ownerId);
    if (!owner) return { ok: false, reason: 'BAD_ID', clan: null };
    if (owner.clanId) return { ok: false, reason: 'ALREADY_IN_CLAN', clan: clanInfo(owner.clanId) };
    const name = clampStr(data?.name, SOCIAL_LIMITS.nameMax);
    const tag = clampStr(data?.tag, SOCIAL_LIMITS.tagMax).toUpperCase();
    if (name.length < 2) return { ok: false, reason: 'BAD_NAME', clan: null };
    if (!/^[A-Z]{2,4}$/.test(tag)) return { ok: false, reason: 'BAD_TAG', clan: null };
    for (const c of clans.values()) {
      if (c.name === name) return { ok: false, reason: 'NAME_TAKEN', clan: null };
      if (c.tag === tag) return { ok: false, reason: 'TAG_TAKEN', clan: null };
    }
    const clan = {
      id: randomBytes(6).toString('hex'), name, tag, ownerId: owner.id,
      members: new Set([owner.id]), created: clock(),
    };
    clans.set(clan.id, clan);
    owner.clanId = clan.id;
    pushClan(clan);
    return { ok: true, clan: clanInfo(clan.id) };
  };

  const joinClan = (clientId, clanId) => {
    purge();
    const p = ensure(clientId);
    const clan = clans.get(clampStr(clanId, 32));
    if (!p) return { ok: false, reason: 'BAD_ID' };
    if (!clan) return { ok: false, reason: 'NOT_FOUND' };
    if (p.clanId === clan.id) return { ok: false, reason: 'ALREADY_IN_CLAN' };
    if (p.clanId) return { ok: false, reason: 'LEAVE_FIRST' };
    if (clan.members.size >= SOCIAL_LIMITS.clanMembers) return { ok: false, reason: 'CLAN_FULL' };
    clan.members.add(p.id);
    p.clanId = clan.id;
    pushClan(clan);
    return { ok: true, clan: clanInfo(clan.id) };
  };

  const leaveClan = (clientId, silent = false) => {
    const p = profiles.get(clampStr(clientId, 64));
    if (!p || !p.clanId) return { ok: false, reason: 'NOT_IN_CLAN' };
    const clan = clans.get(p.clanId);
    p.clanId = null;
    if (!clan) return { ok: true };
    clan.members.delete(p.id);
    if (!clan.members.size) { clans.delete(clan.id); return { ok: true, dissolved: true }; }
    if (clan.ownerId === p.id) clan.ownerId = [...clan.members][0];
    if (!silent) pushClan(clan, p.ws);
    return { ok: true };
  };

  // ── 在线状态 ──────────────────────────────────────────────────────────────
  // client = { id, ws }；id 可空（匿名连接先挂临时档案，进房后再补）。
  // 同一 id 可多端在线，ws 收进 Set；最后一个连接断开才进入 10 分钟保留期。
  const onConnect = (client) => {
    if (!client || !client.ws) return null;
    const prevId = client.ws.__socialId;
    const wantId = clampStr(client.id, 64) || prevId || `anon${randomBytes(4).toString('hex')}`;
    // 进房前 ws 挂在匿名档案上，进房后 client.id 才确定：先迁走，避免旧档案里留幽灵连接。
    if (prevId && prevId !== wantId) profiles.get(prevId)?.ws.delete(client.ws);
    const p = ensure(wantId);
    client.ws.__socialId = p.id;
    p.ws.add(client.ws);
    p.offlineAt = 0;
    p.lastSeen = clock();
    if (client.name) p.name = clampStr(client.name, SOCIAL_LIMITS.nameMax) || p.name;
    p.status = p.roomCode ? 'in-room' : 'online';
    notifyFriends(p.id, { type: 'social', action: 'presence', presence: view(p) });
    for (const ws of p.ws) {
      send(ws, { type: 'social', action: 'profile', profile: view(p), friends: listFriends(p.id), invites: invitesOf(p.id) });
    }
    return view(p);
  };

  const onDisconnect = (client) => {
    // 优先用 ws 上记录的实际挂靠档案：进房后 client.id 变成房间玩家 id，
    // 但若 handle() 还没触发迁移，ws.__socialId 仍是 sid 档案，删错档案会留下幽灵连接。
    const id = clampStr(client?.ws?.__socialId || client?.id, 64);
    const p = id ? profiles.get(id) : null;
    if (!p) return false;
    if (client?.ws) p.ws.delete(client.ws);
    p.lastSeen = clock();
    if (p.ws.size) return true;
    p.status = 'offline';
    p.roomCode = null;
    p.offlineAt = clock();
    notifyFriends(p.id, { type: 'social', action: 'presence', presence: view(p) });
    return true;
  };

  const onlineCount = () => {
    let n = 0;
    for (const p of profiles.values()) if (p.ws.size) n++;
    return n;
  };

  /** 广播给好友（以及战队成员）「我在线 / 我进房间了」。payload 原样透传，不读回。 */
  const notifyFriends = (clientId, payload) => {
    const p = profiles.get(clampStr(clientId, 64));
    if (!p || !payload || typeof payload !== 'object') return 0;
    let sent = 0;
    const seen = new Set();
    const push = (id) => {
      if (seen.has(id) || id === p.id) return;
      seen.add(id);
      for (const ws of profiles.get(id)?.ws || []) if (liveWs(ws) && send(ws, payload)) sent++;
    };
    for (const fid of p.friends) push(fid);
    for (const id of clans.get(p.clanId)?.members || []) push(id);
    return sent;
  };

  /** 进房 / 离房时更新 roomCode 并通知好友。 */
  const setRoom = (clientId, roomCode) => {
    const p = profiles.get(clampStr(clientId, 64));
    if (!p) return null;
    p.roomCode = clampStr(roomCode, 8).toUpperCase() || null;
    p.status = stateOf(p);
    p.lastSeen = clock();
    notifyFriends(p.id, { type: 'social', action: 'presence', presence: view(p) });
    for (const ws of p.ws) send(ws, { type: 'social', action: 'presence', presence: view(p), self: true });
    return view(p);
  };

  const statusOf = (ref) => view(resolve(ref));

  /** 表情：校验 id 后广播给同房间（发送者也收到，保证本地回显一致）。 */
  const emote = (clientId, emoteId, roomCode) => {
    const key = clampStr(emoteId, 16).toLowerCase();
    const def = EMOTES[key];
    const p = profiles.get(clampStr(clientId, 64)) || ensure(clientId);
    if (!def) return { ok: false, reason: 'BAD_EMOTE' };
    const code = clampStr(roomCode, 8).toUpperCase() || p?.roomCode || roomOf(p?.id)?.code || '';
    const room = code ? registry?.rooms?.get?.(code) : roomOf(p?.id);
    if (!room) return { ok: false, reason: 'NO_ROOM' };
    const out = {
      type: 'emote', id: key, emoji: def.emoji, text: def.text,
      from: p?.id || null, name: p?.name || '队友', roomCode: room.code, at: clock(),
    };
    if (typeof registry?.broadcast === 'function') registry.broadcast(room, out);
    else for (const m of room.members?.values?.() || []) if (m.ws) send(m.ws, out);
    return { ok: true, emote: out };
  };

  /**
   * 协议层：把 {type:'social:xxx', action} 映射到内部方法，返回「回给请求者」的一条消息。
   * 服务端只负责 send()，不做业务判断；返回 null 表示不回包（目前没有这种 action）。
   */
  const handle = (client, ws, msg) => {
    // 身份只认服务端自己签发的：进房后是 client.id（房间系统分配的玩家 id），
    // 大厅阶段是本连接在 hello 里拿到的 sid。
    // 安全修复：绝不读取 msg.pid —— 旧实现 `client.id || msg.pid` 在大厅阶段完全信任
    // 客户端自报 pid，而同房玩家的 id 在 lobby/joined 消息里是明文，攻击者可以拿别人
    // 的 id 改档案、读好友与邀请（含 roomCode）、以他人身份发申请。pid 字段保留仅为
    // 兼容旧客户端，服务端一律忽略其值。
    const claimed = clampStr(client?.id, 64) || clampStr(client?.sid, 64) || clampStr(ws?.__sid, 64);
    const known = clampStr(ws?.__socialId, 64);
    if (claimed && known !== claimed) onConnect({ id: claimed, ws });
    else if (!known) onConnect({ ws, id: null });
    const id = claimed || clampStr(ws?.__socialId, 64);
    const action = clampStr(msg?.action, 24) || String(msg?.type || '').slice(7);
    const reply = (name, r, extra = {}) => ({
      type: 'social', action: name, ok: r?.ok !== false,
      ...(msg?.reqId ? { reqId: clampStr(msg.reqId, 24) } : {}),
      ...(r?.reason ? { reason: r.reason } : {}), ...extra,
    });
    if (!id) return reply(action || 'error', { ok: false, reason: 'NOT_READY' });
    switch (action) {
      case 'profile': {
        const profile = updateProfile(id, msg?.profile || null);
        return reply('profile', { ok: !!profile }, { profile, friends: listFriends(id), invites: invitesOf(id) });
      }
      case 'friend:add': {
        const r = addFriend(id, msg?.id ?? msg?.name);
        return reply('friend:add', r, { friend: r.friend || null, friends: r.friends || listFriends(id) });
      }
      case 'friend:remove': {
        const r = removeFriend(id, msg?.id ?? msg?.name);
        return reply('friend:remove', r, { friends: r.friends || listFriends(id) });
      }
      case 'friend:list': return reply('friend:list', { ok: true }, { friends: listFriends(id) });
      case 'invites': return reply('invites', { ok: true }, { invites: invitesOf(id) });
      case 'invite': {
        const r = invite(id, msg?.id ?? msg?.to, msg?.roomCode);
        return reply('invite', r, { inviteId: r.inviteId || null, expiresIn: r.expiresIn || 0 });
      }
      case 'respond': {
        const r = respondInvite(id, msg?.inviteId, msg?.accept !== false);
        return reply('respond', r, { inviteId: clampStr(msg?.inviteId, 32), accepted: !!r.accepted, roomCode: r.roomCode || null });
      }
      case 'clan:create': {
        const r = createClan(id, { name: msg?.name, tag: msg?.tag });
        return reply('clan:create', r, { clan: r.clan || null });
      }
      case 'clan:join': {
        const r = joinClan(id, msg?.id ?? msg?.clanId);
        return reply('clan:join', r, { clan: r.clan || null });
      }
      case 'clan:leave': return reply('clan:leave', leaveClan(id), {});
      case 'clan:info':
        return reply('clan:info', { ok: true }, { clan: clanInfo(msg?.id ?? msg?.clanId ?? profiles.get(id)?.clanId) });
      case 'emote': {
        const r = emote(id, msg?.id ?? msg?.emote, msg?.roomCode);
        return reply('emote', r, { emote: r.emote || null });
      }
      default: return reply(action || 'unknown', { ok: false, reason: 'BAD_ACTION' });
    }
  };

  return {
    profile, updateProfile,
    addFriend, removeFriend, listFriends,
    invite, respondInvite, pendingInvites,
    createClan, joinClan, leaveClan, clanInfo,
    onConnect, onDisconnect, onlineCount, notifyFriends, setRoom, statusOf,
    emote, purge, handle,
    // 只读调试口（测试/运维用）
    get profiles() { return profiles; },
    get clans() { return clans; },
    get invites() { return invites; },
  };
}

export default createSocial;
