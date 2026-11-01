// 雾岛突围 / MIST ISLE 1.0 — 房内动作（owner: netserver · server/actions.mjs）
// 职责：ready / start（含 5s 倒计时与取消）/ kick / config / team / chat（含系统与快捷短语）/ input。
import { Match, MAX_PLAYERS } from '../shared/simulation.mjs';
import { SQUAD_SIZE } from '../shared/rules.mjs';
import { MAPS } from '../shared/data/maps.mjs';
import { LIMITS, reviewFire } from './guard.mjs';
import { GAME_MODES, DIFFICULTIES, QUICK_PHRASES, clampStr, deployStyleFor } from './rooms.mjs';

const START_COUNTDOWN_MS = 5000;

/**
 * now / pingCooldownMs 可注入：
 * - now 与注册表共用同一时间基准（测试用假时钟推进冷却）；
 * - ping 标记冷却走常量，测试可注入更短的值验证剥离逻辑，而不用真等 1.2 秒。
 */
export function createActions({ io, registry, now = Date.now, pingCooldownMs = LIMITS.pingFlagCooldownMs }) {
  const clock = () => Number(now()) || Date.now();
  // start 防抖时间戳存在 room 对象上（room.startDebounceAt），随房间销毁一起释放；
  // 模块级 Map 以房号为键、无删除路径，房间清理后会永久残留。

  const setReady = (client, room, msg) => {
    const member = room.members.get(client.id);
    if (!member) return false;
    member.ready = msg.ready !== false;
    if (room.pendingStart && !registry.isReadyAll(room)) room.pendingStart = null;
    registry.broadcast(room, registry.lobby(room));
    return true;
  };

  /**
   * 降落区投票：等待阶段记录成员最新一票（归一化 0-1 坐标，clamp 后入账），
   * 并把包含全员最新票的 lobby 广播给房间；非等待阶段直接忽略。
   * 开局时由 registry.startMatch 聚合各队质心作为 Match 落点 hint。
   */
  const dropVote = (client, room, msg) => {
    const member = room.members.get(client.id);
    if (!member) return false;
    if (!room.dropVotes) room.dropVotes = new Map();
    if (room.match.phase !== 'waiting') return false;
    const x = typeof msg?.x === 'number' && Number.isFinite(msg.x) ? msg.x : null;
    const z = typeof msg?.z === 'number' && Number.isFinite(msg.z) ? msg.z : null;
    if (x == null || z == null) { io.fail(client.ws, '降落区坐标无效', 'BAD_DROP'); return false; }
    const round3 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
    room.dropVotes.set(client.id, { x: round3(x), z: round3(z), at: Date.now() });
    registry.broadcast(room, registry.lobby(room));
    return true;
  };

  /**
   * 开始：全员已准备 → 立即开；否则进入 5 秒倒计时（房主可再发 start 取消）。
   * 返回 'started' | 'countdown' | 'cancelled' | 'ignored'。
   */
  const start = (client, room, msg) => {
    if (room.host !== client.id) { io.fail(client.ws, '只有房主可以开始战斗', 'NOT_HOST'); return 'ignored'; }
    if (room.match.phase !== 'waiting') return 'ignored';
    if (msg && msg.cancel === true) {
      room.pendingStart = null;
      registry.addSystemChat(room, '房主取消了开始倒计时');
      registry.broadcast(room, registry.lobby(room));
      return 'cancelled';
    }
    if (registry.isReadyAll(room) || room.members.size <= 1 || room.startNow) {
      room.startNow = false;
      registry.startMatch(room);
      return 'started';
    }
    if (room.pendingStart && Date.now() - (room.startDebounceAt || 0) < 400) return 'ignored';
    room.startDebounceAt = Date.now();
    room.pendingStart = { at: Date.now() + START_COUNTDOWN_MS, by: client.id };
    registry.addSystemChat(room, `有队员尚未准备，${START_COUNTDOWN_MS / 1000} 秒后自动开始（房主可取消）`);
    registry.broadcast(room, registry.lobby(room));
    return 'countdown';
  };

  const kick = (client, room, msg) => {
    if (room.host !== client.id) { io.fail(client.ws, '只有房主可以移出成员', 'NOT_HOST'); return false; }
    const targetId = clampStr(msg.targetId, 32);
    if (!targetId || targetId === client.id) { io.fail(client.ws, '不能移出自己', 'BAD_TARGET'); return false; }
    const target = room.members.get(targetId);
    if (!target) { io.fail(client.ws, '目标不在房间内', 'NOT_FOUND'); return false; }
    const name = target.name;
    if (target.ws) {
      io.send(target.ws, { type: 'kicked', reason: clampStr(msg.reason, 60) || '你已被房主移出房间', by: client.id });
      try { target.ws.close(4001, 'kicked'); } catch { /* ignore */ }
    }
    room.members.delete(targetId);
    room.dropVotes?.delete(targetId);
    if (room.match.phase === 'waiting') room.match.removePlayer?.(targetId);
    else if (room.match.phase !== 'ended') {
      const p = room.match.players.find((x) => x.id === targetId);
      if (p) room.match.kill(p, null, 'kick');
    }
    if (room.pendingStart && !registry.isReadyAll(room)) room.pendingStart = null;
    registry.addSystemChat(room, `${name} 被房主移出房间`);
    registry.broadcast(room, registry.lobby(room));
    return true;
  };

  /** waiting 阶段才能改配置；改 mode/map 需要重建 Match，按原队伍信息重新落座。 */
  const config = (client, room, msg) => {
    if (room.host !== client.id) { io.fail(client.ws, '只有房主可以修改房间设置', 'NOT_HOST'); return false; }
    if (room.match.phase !== 'waiting') { io.fail(client.ws, '对局已开始，无法修改设置', 'ROOM_STARTED'); return false; }
    const mode = GAME_MODES.includes(msg.mode) ? msg.mode : room.match.mode;
    const mapId = MAPS[msg.mapId] ? msg.mapId : room.match.mapId;
    const difficulty = DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : room.match.difficulty;
    const deployStyle = deployStyleFor(mode, msg.deployStyle || room.match.deployStyle);
    if (mode === room.match.mode && mapId === room.match.mapId
      && difficulty === room.match.difficulty && deployStyle === room.match.deployStyle) {
      registry.broadcast(room, registry.lobby(room));
      return true;
    }
    const specs = [...room.members.values()].map((m) => ({ id: m.id, name: m.name, team: m.team }));
    const match = new Match({
      mapId, mode, difficulty, deployStyle,
      seed: Math.floor(Math.random() * 2 ** 30),
      maxPlayers: mode === 'training' ? 16 : MAX_PLAYERS,
    });
    for (const spec of specs) {
      const p = match.addPlayer(spec.id, spec.name, { bot: false, team: spec.team });
      if (p) { const m = room.members.get(spec.id); if (m) m.team = p.team; }
    }
    room.match = match;
    room.killEventId = 0;
    room.pendingStart = null;
    room.dropVotes?.clear(); // 设置变更会重开等待期，落点投票一并作废
    for (const m of room.members.values()) { m.knownLoot = null; m.lastEvent = 0; m.ready = false; }
    registry.addSystemChat(room, `房间设置已更新：${mode} · ${match.mapName}`);
    registry.broadcast(room, registry.lobby(room));
    return true;
  };

  /** waiting 阶段换队，不能超过 SQUAD_SIZE。 */
  const team = (client, room, msg) => {
    const member = room.members.get(client.id);
    if (!member) return false;
    if (room.match.phase !== 'waiting') { io.fail(client.ws, '对局已开始，无法换队', 'ROOM_STARTED'); return false; }
    if (room.match.teamSize === 1) { io.fail(client.ws, '单人模式无法换队', 'TEAM_LOCKED'); return false; }
    const want = Number(msg.team);
    if (!Number.isInteger(want) || want < 0 || want >= room.match.maxTeams) { io.fail(client.ws, '无效的小队编号', 'TEAM_INVALID'); return false; }
    if (want === member.team) return true;
    if (room.match.players.filter((p) => p.team === want).length >= SQUAD_SIZE) {
      io.fail(client.ws, `第 ${want + 1} 队已满（上限 ${SQUAD_SIZE} 人）`, 'TEAM_FULL');
      return false;
    }
    member.team = want;
    const p = room.match.players.find((x) => x.id === client.id);
    if (p) p.team = want;
    registry.broadcast(room, registry.lobby(room));
    return true;
  };

  /** 聊天：quick 短语优先、服务端映射为预设中文；all/team 两频道。 */
  const chat = (client, room, msg) => {
    const member = room.members.get(client.id);
    if (!member) return false;
    const quickKey = msg.quick ? String(msg.quick).slice(0, 24) : '';
    const quick = quickKey && QUICK_PHRASES[quickKey] ? QUICK_PHRASES[quickKey] : '';
    const text = quick || clampStr(msg.text, LIMITS.chatMaxChars);
    if (!text) return false;
    const channel = quick ? 'team' : (msg.channel === 'all' ? 'all' : 'team');
    const out = {
      type: 'chat', from: client.id, name: member.name, team: member.team,
      text, channel, quick: quickKey || undefined,
    };
    if (channel === 'all') registry.broadcast(room, out);
    else for (const m of room.members.values()) if (m.ws && m.team === member.team) io.send(m.ws, out);
    return true;
  };

  /**
   * 队伍标记冷却：Match 自己的 pingCd 只在 live 阶段被消费
   *（waiting/loading 时 Match.update 直接 return），跳伞/部署与大厅阶段
   * 客户端仍能每 tick 带 ping:true 刷 pings 数组。这里在进 Match 之前
   * 按成员剥离过频的标记意图，冷却窗口内把 ping 置 false 而不是丢弃整条输入。
   */
  const gatePingFlag = (member, input) => {
    if (!input || input.ping !== true) return input;
    const at = clock();
    if (at - (member.lastPingFlagAt || 0) < pingCooldownMs) return { ...input, ping: false };
    member.lastPingFlagAt = at;
    return input;
  };

  /** 输入 + 射速校验：违规丢弃该次开火，3 次踢出（带原因）。 */
  const input = (client, room, msg, tick) => {
    const member = room.members.get(client.id);
    if (!member) return false;
    const player = room.match.players.find((x) => x.id === client.id);
    if (!player) return false;
    if (!msg.input || typeof msg.input !== 'object') return false;
    const review = reviewFire(member.guard, player, msg.input, tick);
    if (review.violation) {
      io.log('warn', 'anticheat-fire', {
        code: room.code, id: client.id, reason: review.reason,
        violations: member.guard.violations, dropped: member.guard.dropped,
      });
      if (member.guard.violations >= LIMITS.fireViolations) {
        io.send(member.ws, { type: 'kicked', reason: '射速异常，连接已被服务器终止', code: 'FIRE_RATE' });
        try { member.ws.close(4003, 'fire-rate'); } catch { /* ignore */ }
        // 必须同步清席位：只 close() 不会立刻触发 ws 'close' 回调，
        // 期间该玩家仍留在 room.members 里（占用名额、仍能收到广播）。
        // 房主被踢时还要把房主身份转交出去，否则房间再也没人能开始。
        try {
          room.members.delete(client.id);
          room.dropVotes?.delete(client.id);
          if (room.host === client.id) {
            const next = [...room.members.values()].find((m) => m.ws);
            if (next) { room.host = next.id; io.log('info', 'host-transfer', { code: room.code, to: next.id, reason: 'anticheat' }); }
          }
          const p = room.match.players.find((x) => x.id === client.id);
          if (p && room.match.phase !== 'ended') {
            if (room.match.phase === 'waiting') room.match.removePlayer?.(client.id);
            else room.match.kill(p, null, 'kick');
          }
        } catch (err) { io.log('warn', 'anticheat-cleanup', { err: String(err?.message || err) }); }
        return false;
      }
    }
    return room.match.input(client.id, gatePingFlag(member, review.input));
  };

  /** 重开：60% 在线成员投票通过后重建 Match，保留身份与队伍。 */
  const rematch = (client, room) => {
    if (room.match.phase !== 'ended') { io.fail(client.ws, '本局还没有结束', 'NOT_ENDED'); return false; }
    room.rematchVotes.add(client.id);
    const connected = [...room.members.values()].filter((m) => m.ws);
    if (room.rematchVotes.size >= Math.max(1, Math.ceil(connected.length * 0.6))) restart(room);
    return true;
  };

  const restart = (room) => {
    const members = [...room.members.values()];
    const match = new Match({
      mapId: room.match.mapId, mode: room.match.mode,
      maxPlayers: room.match.mode === 'training' ? 16 : MAX_PLAYERS,
      difficulty: room.match.difficulty, seed: Math.floor(Math.random() * 2 ** 30),
      // 重开沿用本房间已选定的空降风格，而不是回落到全局默认。
      deployStyle: room.match.deployStyle,
    });
    room.match = match;
    room.endedAt = 0; room.rematchVotes.clear(); room.loadingAt = 0;
    room.pendingStart = null; room.killEventId = 0;
    room.dropVotes?.clear(); // 重开一局：降落区投票作废，等待期重新投票
    for (const member of members) {
      member.ready = false; member.knownLoot = null; member.lastEvent = 0;
      if (!member.ws) continue;
      const p = match.addPlayer(member.id, member.name, { bot: false, team: member.team });
      if (p) member.team = p.team;
    }
    registry.broadcast(room, registry.lobby(room));
  };

  return { setReady, start, dropVote, kick, config, team, chat, input, rematch, restart };
}
