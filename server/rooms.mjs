// 雾岛突围 / MIST ISLE 1.0 — 房间注册表（owner: netserver · server/rooms.mjs）
// 职责：房间容器、大厅/摘要视图、广播、系统消息与击杀播报、观战快照、房间 GC。
// 不处理加入/离开的会话细节（见 session.mjs），也不直接碰 ws（统一走 io.send）。
import { randomInt } from 'node:crypto';
import { Match, MAX_HUMANS_PER_ROOM, MAX_PLAYERS } from '../shared/simulation.mjs';
import { SCHEDULE } from '../shared/rules.mjs';
import { LIMITS } from './guard.mjs';
import { MAPS, MAP_ORDER } from '../shared/data/maps.mjs';
import {
  createWireContext, rosterFromPlayers, encodeStateFrame, encodeSharedBlockFrame, WireWriter,
} from '../shared/wire.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GAME_MODES = ['squad', 'solo', 'horde', 'training'];
export const DIFFICULTIES = ['recruit', 'veteran', 'elite'];
// 空降风格：房间级开关，默认 instant。
//   · 默认 instant 是刻意的：1.x 的联机对局都是「落地即开打」，把默认改成跳伞会让
//     所有既有房间多出 20+ 秒的空中等待，且服务端/模拟测试的位移断言都假定玩家在地面。
//   · 房主在等待室可切到 'skydive'（完整航线 + 跳伞）；客户端大厅有对应开关。
//   · 环境变量 DEPLOY_STYLE=skydive 可让新房间默认开启（自建服务器想默认跳伞时用）。
export const SKYDIVE_DEFAULT = process.env.DEPLOY_STYLE === 'skydive' ? 'skydive' : 'instant';
export const deployStyleFor = (mode, want) => {
  if (want === 'instant' || want === 'skydive') return want;
  // 训练场与 horde 永远瞬时部署：新手先学枪法，波次模式没有「航线」可言。
  if (mode === 'training' || mode === 'horde') return 'instant';
  return SKYDIVE_DEFAULT;
};
export const QUICK_PHRASES = {
  need_ammo: '需要弹药！', need_med: '需要治疗！', enemy_spotted: '发现敌人！',
  push: '一起上！', retreat: '撤退！', thanks: '多谢！', gg: '打得好！',
  need_help: '请求支援！', on_my_way: '马上到！', defend: '守住这里！',
};

export const clampStr = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

/**
 * 房间是否还有活跃连接：members / spectators 任一持有 ws 即视为活跃。
 * 断线（ws 置空）与主动 leave 都靠它重算空房状态 —— 这是房间回收的前置条件：
 * 旧实现里玩家直接关浏览器时没有任何路径把 emptySince 设上，房间因此永不回收。
 */
export const roomActive = (room) => {
  if (!room) return false;
  for (const m of room.members.values()) if (m.ws) return true;
  for (const s of room.spectators.values()) if (s.ws) return true;
  return false;
};

/** 空房宽限期：断线保留 20s（SCHEDULE.reconnectWindow）之后，再等 10s 才回收房间。 */
export const EMPTY_GRACE_MS = 30000;

export function createRoomRegistry({
  io, maxRooms = 12, autoStartMs = SCHEDULE.lobbyAutoStartMs, now = Date.now,
  matchDropMs = LIMITS.matchDropMs,
}) {
  const rooms = new Map();

  const makeCode = () => {
    let code;
    do { code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (rooms.has(code));
    return code;
  };

  const isReadyAll = (room) => {
    const live = [...room.members.values()].filter((m) => m.ws);
    return live.length > 0 && live.every((m) => m.ready);
  };

  const newRoom = ({ public: isPublic = false, mode = 'squad', mapId = 'qinglan', difficulty = 'veteran', deployStyle } = {}) => {
    if (rooms.size >= maxRooms) return null;
    const code = makeCode();
    const match = new Match({
      mapId, seed: randomInt(1, 2 ** 30), mode, difficulty,
      deployStyle: deployStyleFor(mode, deployStyle),
      maxPlayers: mode === 'training' ? 16 : MAX_PLAYERS,
    });
    const room = {
      code, public: isPublic, host: null, members: new Map(), spectators: new Map(), match,
      created: now(), touched: now(), emptySince: null, endedAt: 0, loadingAt: 0,
      rematchVotes: new Set(), pendingStart: null, killEventId: 0,
      // 降落区投票：memberId → {x,z,at}（归一化 0-1，最新一票覆盖旧票）。
      dropVotes: new Map(),
      // 对局中掉线超时、但仍留在 Match.players 里的玩家：id → { at, match }。
      // 席位 20s 就被回收，Match 里的尸体要等 90s 才真正移除，否则一局下来
      // 幽灵玩家会一直占着快照与 AI 目标列表。match 引用用于换局后自动作废。
      dropped: new Map(),
    };
    rooms.set(code, room);
    return room;
  };

  /** 降落区投票视图：只保留在房成员的票，按投票时间升序（最新一票在末尾）。 */
  const dropVotesView = (room) => {
    const votes = room.dropVotes;
    if (!votes || !votes.size) return [];
    const out = [];
    for (const [id, v] of votes) {
      const m = room.members.get(id);
      if (!m) continue;
      out.push({ x: v.x, z: v.z, by: id, name: m.name, team: m.team });
    }
    out.sort((a, b) => ((votes.get(a.by)?.at || 0) - (votes.get(b.by)?.at || 0)));
    return out;
  };

  /** 队伍落点 hint：在房成员的票按队取质心（无票的队不出现在结果里）。 */
  const teamDropHints = (room) => {
    const votes = room.dropVotes;
    if (!votes || !votes.size) return null;
    const acc = new Map();
    for (const [id, v] of votes) {
      const m = room.members.get(id);
      if (!m) continue;
      const cur = acc.get(m.team) || { n: 0, x: 0, z: 0 };
      cur.n += 1; cur.x += v.x; cur.z += v.z;
      acc.set(m.team, cur);
    }
    if (!acc.size) return null;
    const hints = {};
    for (const [team, c] of acc) hints[team] = { x: c.x / c.n, z: c.z / c.n };
    return hints;
  };

  const lobby = (room) => ({
    type: 'lobby', code: room.code, host: room.host, public: room.public,
    mode: room.match.mode, gameMode: room.match.mode, mapId: room.match.mapId,
    mapName: room.match.mapDef?.name || '', difficulty: room.match.difficulty,
    // 空降风格：房主可在等待室切换（见 actions.config）。
    deployStyle: room.match.deployStyle,
    teamSize: room.match.teamSize, max: MAX_HUMANS_PER_ROOM,
    startsIn: room.public ? Math.max(0, Math.ceil((room.created + autoStartMs - now()) / 1000)) : null,
    phase: room.match.phase, readyAll: isReadyAll(room),
    startCountdown: room.pendingStart ? Math.max(0, Math.ceil((room.pendingStart.at - now()) / 1000)) : 0,
    startBy: room.pendingStart?.by || null,
    spectators: [...room.spectators.values()].filter((s) => s.ws).length,
    configurable: room.match.phase === 'waiting',
    maps: MAP_ORDER, modes: GAME_MODES,
    dropVotes: dropVotesView(room),
    players: [...room.members.values()].map((m) => ({
      id: m.id, name: m.name, team: m.team, host: room.host === m.id,
      ready: !!m.ready, connected: !!m.ws,
    })),
  });

  const summary = (room) => ({
    code: room.code,
    players: [...room.members.values()].filter((m) => m.ws).length,
    humans: room.members.size,
    spectators: [...room.spectators.values()].filter((s) => s.ws).length,
    max: MAX_HUMANS_PER_ROOM,
    mode: room.match.mode, mapId: room.match.mapId, difficulty: room.match.difficulty,
    phase: room.match.phase, host: room.host, public: room.public,
    startedAt: room.match.startedAt ? Math.round(room.match.startedAt) : null,
    created: room.created,
    startsIn: room.public ? Math.max(0, Math.ceil((room.created + autoStartMs - now()) / 1000)) : null,
  });

  const summaries = () => [...rooms.values()]
    .filter((r) => r.public && r.match.phase === 'waiting')
    .map(summary);

  const broadcast = (room, data) => {
    for (const m of room.members.values()) if (m.ws) io.send(m.ws, data);
    for (const s of room.spectators.values()) if (s.ws) io.send(s.ws, data);
  };

  const addSystemChat = (room, text) => {
    if (!text) return;
    broadcast(room, {
      type: 'chat', from: 'system', name: '[系统]', text: clampStr(text, 120),
      channel: 'all', system: true, team: null,
    });
  };

  /** 击杀播报：只播报有真人参与的事件，单次最多 3 条，避免 AI 混战刷屏。 */
  const killFeed = (room) => {
    const events = room.match.events || [];
    let sent = 0;
    for (const ev of events) {
      if (ev.id <= room.killEventId) continue;
      room.killEventId = ev.id;
      if (ev.type !== 'kill' || sent >= 3) continue;
      const victim = room.members.get(ev.player);
      const killer = ev.by ? room.members.get(ev.by) : null;
      if (!victim && !killer) continue;
      addSystemChat(room, `${killer?.name || (ev.by ? 'AI' : '毒圈')} 淘汰了 ${victim?.name || ev.name || '一名玩家'}`);
      sent++;
    }
  };

  // ── 二进制快照（wire v1）──────────────────────────────────────────────────
  // 能力协商：join 里带 binary:true 且服务端未禁用时，该成员改为收二进制帧。
  // 老客户端不传该字段 → 全程 JSON，行为与 1.1.0 完全一致；服务端 WIRE_BINARY=0
  // 可整体回退（见 server/index.mjs 的 createGameServer({ binary })）。
  const binaryEnabled = () => io.binary !== false;

  /**
   * room 级 wire 上下文缓存：roster 变化（加入/离开/换队/改名）时重建并下发。
   * 稳态下每 tick 都会调用，因此这里逐字段比对（不拼字符串），命中时零分配。
   */
  const wireContextFor = (room) => {
    const players = room.match.players || [];
    const cache = room.wire;
    if (cache && cache.count === players.length) {
      let same = true;
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const r = cache.roster[i];
        // teamName 必须一起比：它进 roster 的字符串表，换队/改名后若没检测到变化，
        // 客户端会继续用旧队伍名（表现是击杀播报/记分板显示上一个队的名字）。
        // 队伍名由 team 派生，所以只要比 team 就够 —— 但保留显式比较更安全，
        // 免得将来队伍名改成可自定义时漏掉。
        if (!r || r.id !== p.id || r.name !== p.name || r.bot !== !!p.bot || r.team !== p.team
          || r.teamName !== room.match.teamName(p.team)) { same = false; break; }
      }
      if (same) return cache;
    }
    const roster = rosterFromPlayers(players.map((p) => ({
      id: p.id, name: p.name, bot: p.bot, team: p.team, teamName: room.match.teamName(p.team),
    })));
    // sig 只用于成员侧「是否需要补发 roster」的判等：内容变化 → 新对象 → 新 sig。
    const sig = `${cache ? (cache.version + 1) : 1}:${roster.length}`;
    const next = {
      sig, version: cache ? cache.version + 1 : 1, count: players.length, roster,
      ctx: createWireContext({ roster }),
    };
    room.wire = next;
    return next;
  };

  /** 给单个二进制成员补发 roster（加入 / roster 变化 / 重连时调用）。返回是否真的发出。 */
  const sendRoster = (member, room) => {
    if (!member?.ws || !member.binary) return false;
    const wire = wireContextFor(room);
    return io.send(member.ws, { type: 'roster', wire: 1, tick: room.match.tickCount, players: wire.roster });
  };

  const sendState = (member, room, state, opts = {}) => {
    if (!member.ws) return;
    if (member.binary && binaryEnabled()) {
      try {
        const wire = wireContextFor(room);
        // roster 变化时先补一条 roster，再发帧：客户端借此重建字符串表与槽位。
        // roster 若因背压被丢弃，这一帧也一并跳过 —— 客户端解不开的帧发了只会浪费带宽，
        // 下一轮广播会重试 roster（wireSig 未更新）。
        if (member.wireSig !== wire.sig) {
          if (!sendRoster(member, room)) return;
          member.wireSig = wire.sig;
        }
        // 每名二进制成员复用一个 Writer（缓冲区随最大帧增长后不再分配），
        // 64 观察者 × 10Hz 时能把每帧的临时分配压到接近 0。
        if (!member.wireWriter) member.wireWriter = new WireWriter(2048);
        const frame = encodeStateFrame(state, wire.ctx, {
          writer: member.wireWriter, shared: opts.shared, spectator: opts.spectator,
        });
        io.sendBytes(member.ws, frame);
        return;
      } catch (err) {
        // 编码失败不能让玩家彻底收不到状态：记录一次并降级回 JSON。
        io.log('warn', 'wire-encode-error', { code: room.code, id: member.id, error: String(err?.message || err) });
        member.binary = false;
      }
    }
    io.send(member.ws, opts.spectator ? { type: 'state', state, spectator: true } : { type: 'state', state });
  };

  /**
   * 共享区块缓存：同一 tick 内，只要「事件窗口起点」相同，车辆/空投/horde/结算
   * 与事件数组就完全一致，可只编码一次给全房复用。多个成员 sinceEventId 不同
   * （例如刚加入的人是 0）时按 since 分桶，不会错发。
   */
  const makeSharedCache = (room) => {
    const buckets = new Map();
    return (state, since, eventId) => {
      const key = `${room.match.tickCount}:${eventId}:${since}`;
      if (buckets.has(key)) return buckets.get(key);
      let bytes = null;
      try { bytes = encodeSharedBlockFrame(state, wireContextFor(room).ctx); } catch { bytes = null; }
      buckets.set(key, bytes);
      return bytes;
    };
  };

  const broadcastState = (room) => {
    if (room.match.phase === 'waiting') return;
    // loading 进度只在 loading 阶段算一次并共享（值对所有成员相同，JSON 输出一致）
    let loading = null;
    if (room.match.phase === 'loading') {
      let ready = 0; let total = 0;
      for (const m of room.members.values()) {
        if (!m.ws) continue;
        total++;
        if (m.ready) ready++;
      }
      loading = { ready, total };
    }
    const sharedFor = makeSharedCache(room);
    for (const member of room.members.values()) {
      if (!member.ws) continue;
      const since = member.lastEvent || 0;
      let state;
      try { state = room.match.snapshot(member.id, since); } catch (err) {
        io.log('warn', 'snapshot-error', { code: room.code, id: member.id, error: String(err?.message || err) });
        continue;
      }
      if (loading) state.loading = loading;
      // 已知物资差量：knownLoot 只存 id 集合（原来是 id→视图 的 Map，重建更重）。
      // upsert/remove 语义与原实现逐字段一致：upsert = 本次可见但未下发过的视图，
      // remove = 上次下发过但本次不可见（被拾取/被压实/走出视野）的 id。
      const views = state.loot || [];
      const ids = new Set();
      for (let i = 0; i < views.length; i++) ids.add(views[i].id);
      if (member.knownLoot) {
        const known = member.knownLoot;
        const upsert = [];
        for (let i = 0; i < views.length; i++) if (!known.has(views[i].id)) upsert.push(views[i]);
        const remove = [];
        for (const id of known) if (!ids.has(id)) remove.push(id);
        delete state.loot;
        state.lootPatch = { upsert, remove };
      }
      member.knownLoot = ids;
      const eventId = room.match.eventId;
      member.lastEvent = eventId;
      sendState(member, room, state, { shared: member.binary ? sharedFor(state, since, eventId) : null });
    }
    // 观战者：只读全量快照（viewer=null、sinceEventId=0），不消费 Match 输入，
    // 也不占 64 人席位。所有观战者看到的是同一份快照 —— 二进制帧与共享区块都只编码一次。
    if (room.spectators.size) {
      let viewed = null;
      try { viewed = room.match.snapshot(null, 0); } catch { viewed = null; }
      if (!viewed) return;
      const specShared = sharedFor(viewed, 0, room.match.eventId);
      for (const spec of room.spectators.values()) {
        if (!spec.ws) continue;
        sendState(spec, room, viewed, { spectator: true, shared: specShared });
      }
    }
  };

  const startMatch = (room) => {
    if (room.match.phase !== 'waiting') return false;
    // 降落区投票：把各队成员票的质心作为落点 hint 传给 Match（无票的队不传），
    // 随后清票，重开/下一局的投票从零开始。
    const dropHints = teamDropHints(room);
    let started = false;
    try { started = room.match.start({ dropHints }); } catch (err) {
      io.log('warn', 'match-start-error', { code: room.code, error: String(err?.message || err) });
      started = false;
    }
    if (!started) {
      // 开局失败必须回到「可重试」的等待态：清掉 startNow / 倒计时，
      // 否则房间会卡在「已宣告开始但 Match 仍是 waiting」，再也没有路径能开局。
      room.startNow = false;
      room.pendingStart = null;
      room.loadingAt = 0;
      io.log('warn', 'match-start-failed', { code: room.code, phase: room.match.phase });
      broadcast(room, lobby(room));
      return false;
    }
    room.dropVotes.clear();
    room.match.phase = 'loading'; // 等所有在线客户端渲染就绪，避免有人落在 loading 之后
    room.match.time = 0;
    room.match.startedAt = now();
    room.loadingAt = now();
    room.pendingStart = null;
    for (const member of room.members.values()) { member.ready = false; member.lastEvent = 0; member.knownLoot = null; }
    broadcast(room, lobby(room));
    broadcastState(room);
    return true;
  };

  /** 房间 GC：空房 30s、结束局 3min、等待室 30min。 */
  const cleanup = () => {
    const t = now();
    let removed = 0;
    for (const room of rooms.values()) {
      // 空房判定不依赖 emptySince 是否被正确设置：直接看「还有没有活跃连接」。
      // 历史 bug：玩家直接关浏览器/断网（不走 leave）时没人设置 emptySince，
      // 最后一名成员被剔除后房间 0 人但 emptySince 仍是 null，cleanup 永不回收，
      // Match（64 人 / 地图 / AI / 物资）常驻内存并继续 30Hz 空跑，最终占满 maxRooms。
      // 判定口径 = 「members 与 spectators 都没有活跃 ws」，它严格包含
      // members.size === 0 && spectators.size === 0 这一情形，同时额外覆盖
      // 「席位还在但全员掉线（ws 全为 null）」的中间态；只剩观战者的房间
      // roomActive 仍为 true，不会被误删。
      const noLive = !roomActive(room);
      if (noLive && !room.emptySince) room.emptySince = t; // 自愈：补记宽限期起点
      const empty = noLive && room.emptySince && t - room.emptySince > EMPTY_GRACE_MS;
      const ended = room.endedAt && t - room.endedAt > SCHEDULE.endedKeepMs;
      const stale = room.match.phase === 'waiting' && t - room.created > SCHEDULE.roomLifetimeMs;
      if (!empty && !ended && !stale) continue;
      const reason = empty ? 'empty' : ended ? 'ended' : 'stale';
      for (const m of room.members.values()) {
        if (!m.ws) continue;
        io.send(m.ws, { type: 'expired', reason });
        try { m.ws.close(1000, 'room closed'); } catch { /* ignore */ }
      }
      for (const s of room.spectators.values()) {
        if (!s.ws) continue;
        io.send(s.ws, { type: 'expired', reason: 'room closed' });
        try { s.ws.close(1000, 'room closed'); } catch { /* ignore */ }
      }
      rooms.delete(room.code);
      removed++;
    }
    return removed;
  };

  /**
   * 重算房间空置状态：有活跃连接 → 清空 emptySince；没有 → 记下宽限期起点。
   * 必须在「剔除掉线成员之后」无条件调用一次：否则最后一名的席位被删掉时没有任何
   * 路径设置 emptySince，cleanup 会以为房间还在使用而永不回收。
   */
  const refreshEmpty = (room, active, t = now()) => {
    if (active) { room.emptySince = null; return; }
    if (!room.emptySince) room.emptySince = t;
  };

  /**
   * 对局中掉线超时的成员真正移出 Match。
   *
   * 两层保留期是刻意的：席位 20s 回收（断线重连窗口），Match 里的「尸体」再留
   * matchDropMs（默认 90s）用于保留击杀/排名语义。但尸体不能永久留下 ——
   * 一局打到 15 分钟，掉线的人会持续占着快照 players 数组与 AI 目标扫描，
   * 90s 之后必须真正从 Match.players 里移除。
   */
  const sweepDropped = (room, t) => {
    const dropped = room.dropped;
    if (!dropped || !dropped.size) return false;
    let removed = 0;
    for (const [id, entry] of dropped) {
      if (entry.match !== room.match) { dropped.delete(id); continue; } // 换过局：旧条目自动作废
      if (t - entry.at < matchDropMs) continue;
      dropped.delete(id);
      // 等待期由 sweepDisconnected 直接 removePlayer；已结束的对局保留完整名单
      // （结算/回放仍要读），只有真正在打的对局才需要把幽灵玩家从 Match 里摘掉。
      const phase = room.match.phase;
      if (phase === 'waiting' || phase === 'ended') continue;
      try { if (room.match.removePlayer?.(id)) removed++; } catch (err) {
        io.log('warn', 'drop-remove-error', { code: room.code, id, error: String(err?.message || err) });
      }
    }
    return removed > 0;
  };

  /**
   * 席位超时回收：任何阶段都执行。
   * 旧实现只在 waiting 分支剔除掉线成员，live 房间会永久留着 ws=null 的幽灵席位，
   * 房间既不为空（members.size > 0）也没人在玩，Match 一直 30Hz 空跑；
   * 配合 emptySince 从不设置，房间永远不会被 cleanup 回收。
   */
  const sweepDisconnected = (room, t) => {
    // 先收集再统一处理：旧实现在循环里每删一个成员就 addSystemChat + broadcast
    // （addSystemChat 自己也广播一次），N 个掉线成员就是 O(n²) 条 lobby 广播。
    const expired = [];
    for (const member of room.members.values()) {
      if (!member.ws && t - member.lastSeen > SCHEDULE.reconnectWindow * 1000) expired.push(member);
    }
    if (!expired.length) return false;
    for (const member of expired) {
      room.members.delete(member.id);
      room.dropVotes?.delete(member.id);
      // 等待期直接移除席位；对局中按「掉线退出」处理（与 leave 一致，保留击杀/排名语义）。
      if (room.match.phase === 'waiting') room.match.removePlayer?.(member.id);
      else if (room.match.phase !== 'ended') {
        const p = room.match.players.find((x) => x.id === member.id);
        if (p) room.match.kill(p, null, 'timeout');
        // 席位回收了，但 Match.players 里还要留一具「尸体」记排名 —— 真正从
        // Match 移除要等到 matchDropMs（默认 90s），以**掉线时刻**为基准计时，
        // 而不是以「席位被剔除」为基准（否则实际要等 20s + 90s）。
        if (!room.dropped) room.dropped = new Map();
        room.dropped.set(member.id, { at: member.lastSeen, match: room.match });
      }
    }
    // 只广播一次：系统消息与 lobby 都在循环结束后发。
    addSystemChat(room, `${expired.map((m) => m.name).join('、')} 因掉线超时离开了房间`);
    // 房主在循环结束后统一校正：仍在线的房主保持不变（不把房主身份无谓地转移给
    // 先入房的人），房主被剔除或已掉线时取「第一个有 ws 的成员」，没有则 null。
    // 旧实现基于删除前的 activeMembers 快照挑选，可能把刚被剔除的人又选回房主。
    const hostLive = !!room.members.get(room.host)?.ws;
    if (!hostLive) room.host = [...room.members.values()].find((m) => m.ws)?.id || null;
    broadcast(room, lobby(room));
    return true;
  };

  /** 每个 tick 的房间维护；返回本 tick 是否应广播快照。 */
  const tickRoom = (room, tickCount, snapshotEvery) => {
    const t = now();
    // 先回收超时席位，再统计活跃成员：顺序反过来会把刚被剔除的人算成在线。
    sweepDisconnected(room, t);
    sweepDropped(room, t);
    const activeMembers = [...room.members.values()].filter((m) => m.ws);
    const hasSpectators = [...room.spectators.values()].some((s) => s.ws);
    const active = activeMembers.length > 0 || hasSpectators;

    if (room.match.phase === 'waiting') {
      if (room.pendingStart) {
        if (!activeMembers.length || !room.host) room.pendingStart = null;
        else if (t >= room.pendingStart.at) {
          // 倒计时结束：房主已宣告开始，即使仍有人未准备也照常开局。
          room.startNow = true;
          startMatch(room);
        } else if (tickCount % 30 === 0) broadcast(room, lobby(room));
      }
      if (room.public && activeMembers.length && t - room.created >= autoStartMs) startMatch(room);
    }
    // 剔除之后无条件重算空置状态：这一 tick 可能刚好删掉最后一名掉线成员。
    // （旧实现只在 leave/spectate 分支设置 emptySince，掉线剔除路径完全没设置。）
    refreshEmpty(room, active, t);

    if (room.match.phase === 'loading') {
      const ready = activeMembers.length > 0 && activeMembers.every((m) => m.ready);
      if (ready || t - room.loadingAt > SCHEDULE.loadingTimeout * 1000) {
        room.match.phase = 'deploying';
        room.match.time = 0;
        if (room.match.botsReady !== true) room.match.botsReady = true;
      }
    }

    try { room.match.update(1 / 30); } catch (err) {
      io.log('warn', 'update-error', { code: room.code, error: String(err?.message || err) });
    }

    killFeed(room);
    if (room.match.phase === 'ended' && !room.endedAt) room.endedAt = t;
    return active && room.match.phase !== 'waiting' && tickCount % snapshotEvery === 0;
  };

  return {
    rooms, autoStartMs, maxRooms, newRoom, lobby, summary, summaries, broadcast, addSystemChat,
    killFeed, broadcastState, startMatch, cleanup, tickRoom, isReadyAll, makeCode,
    binaryEnabled,
    // 单播一个 state（观战首帧 / 重连补帧用）：走与广播相同的二进制协商与 roster 补发。
    pushState: (target, room, state, opts = {}) => sendState(target, room, state, opts),
  };
}

export { MAPS, MAP_ORDER };
