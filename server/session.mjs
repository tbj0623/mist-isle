// 雾岛突围 / MIST ISLE 1.0 — 会话（owner: netserver · server/session.mjs）
// 职责：join / resume / spectate / leave / disconnect。房间维护与动作见 rooms.mjs、actions.mjs。
import { randomBytes } from 'node:crypto';
import { MAX_HUMANS_PER_ROOM } from '../shared/simulation.mjs';
import { SCHEDULE } from '../shared/rules.mjs';
import { MAPS, MAP_ORDER } from '../shared/data/maps.mjs';
import { LIMITS, createAntiCheat } from './guard.mjs';
import { GAME_MODES, DIFFICULTIES, clampStr, roomActive } from './rooms.mjs';

const RESUME_GRACE_MS = SCHEDULE.reconnectWindow * 1000;

/**
 * now 可注入假时钟（默认 Date.now）：必须与 rooms 注册表共用同一个时钟，
 * 否则 emptySince / lastSeen（会话写入）与 tickRoom / cleanup（注册表读取）
 * 会拿两个不同时间基准做减法，宽限期判断直接失真。
 */
export function createSessions({ io, registry, now = Date.now }) {
  const { rooms } = registry;
  const clock = () => Number(now()) || Date.now();

  /**
   * 二进制能力协商：只有 join 里显式 binary:true 且服务端未禁用时才走 wire 帧。
   * 老客户端不带该字段 → member.binary 为 false，全程 JSON，行为完全不变。
   * wireSig 记在成员上：roster 变化时由 rooms.broadcastState 补发 roster。
   */
  const applyBinary = (member, msg) => {
    const want = msg?.binary === true && io.binary !== false;
    member.binary = want;
    member.wireSig = null;
    member.wireWriter = null;
    return want;
  };

  const resume = (client, ws, code, msg) => {
    const room = rooms.get(code);
    const token = clampStr(msg.token, 128);
    const member = room && [...room.members.values()].find((m) => token && m.token === token);
    if (!member) { io.fail(ws, '重连凭证已失效，请重新加入房间', 'RESUME_EXPIRED'); return null; }
    if (member.ws && member.ws !== ws) { io.fail(ws, '该角色已在另一台设备上活跃', 'RESUME_CONFLICT'); return null; }
    if (!member.ws && clock() - member.lastSeen > RESUME_GRACE_MS) {
      io.fail(ws, '重连窗口已过（20 秒），请重新加入房间', 'RESUME_EXPIRED');
      return null;
    }
    member.ws = ws; member.lastSeen = clock();
    member.knownLoot = null;
    member.lastEvent = 0; // 全量基线：不再用 sinceEventId 差分，避免重连后状态残缺
    member.guard = member.guard || createAntiCheat();
    // 座位在 20s 后就被 sweepDisconnected 回收，但 Match 里的「尸体」要留 90s 才移除。
    // 重连成功必须把待移除登记撤掉，否则玩家连回来了、几秒后却从 Match 里被删掉。
    room.dropped?.delete(member.id);
    // 重连时重新协商二进制能力：同一个 token 可能换了客户端版本。
    applyBinary(member, msg);
    client.id = member.id; client.room = room.code; client.spectator = false;
    try { room.match.reconnect(member.id); } catch { /* ignore */ }
    room.emptySince = null; room.touched = clock();
    if (!room.host) room.host = member.id;
    io.send(ws, {
      type: 'joined', id: member.id, token: member.token, code: room.code,
      host: room.host === member.id, team: member.team, mapId: room.match.mapId,
      gameMode: room.match.mode, resumed: true, full: true,
      // 重连同样回执能力位：客户端据此决定后续按二进制还是 JSON 解包。
      binary: member.binary === true, wire: member.binary ? 1 : 0,
    });
    if (room.match.phase === 'waiting') registry.broadcast(room, registry.lobby(room));
    else registry.broadcastState(room);
    return room;
  };

  const join = (client, ws, msg) => {
    const code = clampStr(msg.code, 8).toUpperCase();
    const proto = Number(msg.protocol);
    if (proto !== io.protocol) { io.fail(ws, `客户端版本(${proto || '?'})与服务器(${io.protocol})不一致，请更新后重试`, 'PROTOCOL'); return null; }
    if (client.room) { io.fail(ws, '请先离开当前房间', 'ALREADY_IN_ROOM'); return null; }
    if (msg.mode === 'resume') return resume(client, ws, code, msg);

    const gameMode = GAME_MODES.includes(msg.gameMode) ? msg.gameMode : 'squad';
    const mapId = MAPS[msg.mapId] ? msg.mapId : MAP_ORDER[0];
    const difficulty = DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : 'veteran';
    let room = null;
    if (msg.mode === 'create') room = registry.newRoom({ public: false, mode: gameMode, mapId, difficulty });
    else if (msg.mode === 'quick') {
      room = [...rooms.values()].find((r) => r.public && r.match.mode === gameMode
        && r.match.phase === 'waiting' && r.members.size < MAX_HUMANS_PER_ROOM)
        || registry.newRoom({ public: true, mode: gameMode, mapId, difficulty });
    } else if (msg.mode === 'join') room = rooms.get(code);
    else { io.fail(ws, '未知的房间操作', 'BAD_MODE'); return null; }

    if (!room) {
      if (msg.mode === 'join') io.fail(ws, '房间不存在，请检查邀请码', 'ROOM_NOT_FOUND');
      else io.fail(ws, '服务器房间已满，请稍后再试', 'ROOM_LIMIT');
      return null;
    }
    if (room.match.phase !== 'waiting') { io.fail(ws, '本局已经开始，请等待下一局或让房主重开', 'ROOM_STARTED'); return null; }
    if (room.members.size >= MAX_HUMANS_PER_ROOM) { io.fail(ws, '战局已满', 'ROOM_FULL'); return null; }

    const teamWant = Number.isInteger(msg.team) ? msg.team : msg.mode === 'quick' ? -1 : 0;
    let team = teamWant;
    if (room.match.teamSize === 1) team = 0;
    else if (team < 0 || team >= room.match.maxTeams) team = room.match.nextTeam();
    else if (room.match.players.filter((p) => p.team === team).length >= room.match.teamSize) {
      if (msg.mode === 'join') { io.fail(ws, '该小队已满，请选择另一支小队', 'TEAM_FULL'); return null; }
      team = room.match.nextTeam();
    }
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(24).toString('base64url');
    const name = clampStr(msg.name, 14) || '旅人';
    const player = room.match.addPlayer(id, name, { bot: false, team, loadout: msg.loadout });
    if (!player) { io.fail(ws, '加入失败，请重试', 'JOIN_FAILED'); return null; }
    const member = {
      id, token, ws, name: player.name, team: player.team, lastSeen: clock(), ready: false,
      knownLoot: null, lastEvent: 0, guard: createAntiCheat(),
    };
    applyBinary(member, msg);
    room.members.set(id, member);
    room.host = room.host || id;
    room.touched = clock(); room.emptySince = null;
    client.id = id; client.room = room.code; client.spectator = false;
    io.send(ws, {
      type: 'joined', id, token, code: room.code, host: room.host === id, team,
      mapId: room.match.mapId, gameMode: room.match.mode, max: MAX_HUMANS_PER_ROOM,
      // 能力协商回执：客户端据此决定是否按二进制帧解包（false 时继续 JSON）。
      binary: member.binary === true, wire: member.binary ? 1 : 0,
    });
    registry.addSystemChat(room, `${player.name} 加入了房间`);
    registry.broadcast(room, registry.lobby(room));
    return room;
  };

  /** 观战：不调用 addPlayer（simulation 无 spectator），只用 match.snapshot(null, 0) 只读通道。 */
  const spectate = (client, ws, msg) => {
    if (client.room) { io.fail(ws, '请先离开当前房间', 'ALREADY_IN_ROOM'); return null; }
    const room = rooms.get(clampStr(msg.code, 8).toUpperCase());
    if (!room) { io.fail(ws, '房间不存在，请检查邀请码', 'ROOM_NOT_FOUND'); return null; }
    const live = [...room.spectators.values()].filter((s) => s.ws).length;
    if (live >= LIMITS.spectatorLimit) { io.fail(ws, '观战席已满（上限 8 人）', 'SPECTATOR_LIMIT'); return null; }
    const id = `s${randomBytes(6).toString('hex')}`;
    const token = randomBytes(18).toString('base64url');
    const name = clampStr(msg.name, 14) || '观战者';
    const spec = { id, token, ws, name, lastSeen: clock() };
    applyBinary(spec, msg);
    room.spectators.set(id, spec);
    room.touched = clock(); room.emptySince = null;
    client.id = id; client.room = room.code; client.spectator = true;
    io.send(ws, {
      type: 'spectating', id, token, code: room.code, host: false, spectator: true,
      mapId: room.match.mapId, gameMode: room.match.mode, phase: room.match.phase,
      binary: spec.binary === true, wire: spec.binary ? 1 : 0,
    });
    registry.addSystemChat(room, `${name} 进入观战`);
    registry.broadcast(room, registry.lobby(room));
    // 首帧走与常规广播相同的通道（二进制/JSON 由能力位决定），
    // 这样二进制观战者也能先拿到 roster 再拿到完整快照。
    try { registry.pushState(spec, room, room.match.snapshot(null, 0), { spectator: true }); } catch { /* ignore */ }
    return room;
  };

  const leave = (client, ws) => {
    const room = rooms.get(client.room);
    client.room = null;
    if (!room) { io.send(ws, { type: 'left' }); return; }
    const spec = room.spectators.get(client.id);
    if (spec) {
      room.spectators.delete(client.id);
      // 观战者离开同样要重算空置状态：旧实现只处理了成员分支，
      // 最后一个观战者退出后会留下一个空房间且 emptySince 为 null。
      if (!roomActive(room)) room.emptySince = room.emptySince || clock();
      registry.addSystemChat(room, `${spec.name} 离开观战`);
      io.send(ws, { type: 'left' });
      return;
    }
    const member = room.members.get(client.id);
    if (!member) { io.send(ws, { type: 'left' }); return; }
    room.members.delete(client.id);
    if (room.match.phase === 'waiting') room.match.removePlayer?.(client.id);
    else if (room.match.phase !== 'ended') {
      const p = room.match.players.find((x) => x.id === client.id);
      if (p) room.match.kill(p, null, 'leave');
    }
    if (room.host === client.id) room.host = [...room.members.values()].find((m) => m.ws)?.id || null;
    // 主动离开也走同一套空置判定：members / spectators 里还有 ws 就不算空房。
    if (!roomActive(room)) room.emptySince = room.emptySince || clock();
    if (room.pendingStart && !registry.isReadyAll(room)) room.pendingStart = null;
    registry.addSystemChat(room, `${member.name} 离开了房间`);
    if (room.match.phase === 'waiting') registry.broadcast(room, registry.lobby(room));
    io.send(ws, { type: 'left' });
  };

  /**
   * 断线：保留席位 20 秒（由 rooms.tickRoom 回收），这里把席位标记为掉线。
   * 修复：处理后必须重算房间空置状态 —— 玩家直接关浏览器 / 断网时不走 leave，
   * 旧实现只把 member.ws 置 null 而从不设置 room.emptySince；20 秒后 tickRoom 把
   * 掉线成员剔除、房间变成 0 人，但 emptySince 仍是 null，cleanup 的回收条件不满足，
   * 于是 Match（64 人 / 地图 / AI / 物资）常驻内存并继续 30Hz 空跑，反复几次占满 maxRooms。
   */
  const disconnect = (client) => {
    const room = rooms.get(client.room);
    client.room = null;
    if (!room) return;
    const member = room.members.get(client.id);
    if (member && (!member.ws || member.ws === client.ws)) {
      member.ws = null;
      member.ready = false;
      member.lastSeen = clock();
      try { room.match.disconnect(client.id); } catch { /* ignore */ }
    }
    const spec = room.spectators.get(client.id);
    if (spec && (!spec.ws || spec.ws === client.ws)) room.spectators.delete(client.id);
    // 统一重算：members 与 spectators 里任一还有 ws 即视为活跃，否则记下宽限期起点。
    if (roomActive(room)) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = clock();
  };

  return { join, resume, spectate, leave, disconnect };
}
