// 雾岛突围 / MIST ISLE 1.0 — 联机服务器（owner: netserver · server/index.mjs）
// 单进程内存房间；30Hz 固定步长推演，10Hz 状态广播（含战利品增量）。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { Match, sanitizeInput, MAX_PLAYERS, MAX_HUMANS_PER_ROOM } from '../shared/simulation.mjs';
import { PROTOCOL_VERSION, VERSION, TICK_RATE, SNAPSHOT_EVERY_TICKS, SQUAD_SIZE, SCHEDULE } from '../shared/rules.mjs';
import { MAPS, MAP_ORDER } from '../shared/data/maps.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 64;
const MAX_CONNECTIONS = 512;
const MAX_BUFFER = 512 * 1024;
const MAX_PAYLOAD = 8192;
const RATE_PER_SEC = 90;
const GAME_MODES = ['squad', 'solo', 'horde', 'training'];

const clampStr = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

export function createGameServer({
  port = 8787, host = '0.0.0.0', maxRooms = MAX_ROOMS,
  autoStartMs = SCHEDULE.lobbyAutoStartMs, origins = [], maxConnectionsPerIp = 96,
} = {}) {
  const rooms = new Map();
  const clients = new Set();
  const ipCounts = new Map();
  const root = new URL('../dist/', import.meta.url);
  const startedAt = Date.now();
  const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ]);

  const send = (ws, data) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > MAX_BUFFER) { try { ws.close(1013, 'slow'); } catch { /* ignore */ } return false; }
    try { ws.send(JSON.stringify(data)); return true; } catch { return false; }
  };
  const fail = (ws, message) => send(ws, { type: 'error', message });
  const broadcast = (room, data) => { for (const m of room.members.values()) if (m.ws) send(m.ws, data); };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const path = (req.url || '/').split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true, version: VERSION, protocol: PROTOCOL_VERSION, rooms: rooms.size,
        connections: clients.size, maxPlayers: MAX_PLAYERS, uptime: Math.round((Date.now() - startedAt) / 1000),
      }));
      return;
    }
    if (path === '/rooms') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ rooms: roomSummaries() }));
      return;
    }
    const file = files.get(path);
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const data = await readFile(new URL(file[0], root));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(503); res.end('Run `npm run build` before starting the server.'); }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin;
    const url = (req.url || '').split('?')[0];
    if (url !== '/ws' || clients.size >= MAX_CONNECTIONS || (ipCounts.get(ip) || 0) >= maxConnectionsPerIp
      || (origins.length && origin && !origins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // ── 房间 ──────────────────────────────────────────────────────────────────
  const makeCode = () => {
    let code;
    do { code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (rooms.has(code));
    return code;
  };
  const roomSummaries = () => [...rooms.values()].filter((r) => r.public && r.match.phase === 'waiting')
    .map((r) => ({ code: r.code, mode: r.match.mode, mapId: r.match.mapId, players: r.members.size, max: MAX_HUMANS_PER_ROOM, startsIn: Math.max(0, Math.ceil((r.created + autoStartMs - Date.now()) / 1000)) }));

  const newRoom = ({ public: isPublic = false, mode = 'squad', mapId = 'qinglan', difficulty = 'veteran' } = {}) => {
    if (rooms.size >= maxRooms) return null;
    const code = makeCode();
    const match = new Match({ mapId, seed: randomInt(1, 2 ** 30), mode, maxPlayers: mode === 'training' ? 16 : MAX_PLAYERS, difficulty });
    const room = {
      code, public: isPublic, host: null, members: new Map(), match,
      created: Date.now(), touched: Date.now(), emptySince: null, endedAt: 0, loadingAt: 0, rematchVotes: new Set(),
    };
    rooms.set(code, room);
    return room;
  };

  const lobby = (room) => ({
    type: 'lobby', code: room.code, host: room.host, public: room.public,
    mode: room.match.mode, gameMode: room.match.mode, mapId: room.match.mapId,
    mapName: room.match.mapDef?.name || '', teamSize: room.match.teamSize, max: MAX_HUMANS_PER_ROOM,
    startsIn: room.public ? Math.max(0, Math.ceil((room.created + autoStartMs - Date.now()) / 1000)) : null,
    phase: room.match.phase,
    players: [...room.members.values()].map((m) => ({
      id: m.id, name: m.name, team: m.team, host: room.host === m.id,
      ready: !!m.ready, connected: !!m.ws,
    })),
  });

  const broadcastState = (room) => {
    if (room.match.phase === 'waiting') return;
    for (const member of room.members.values()) {
      if (!member.ws) continue;
      let state;
      try { state = room.match.snapshot(member.id, member.lastEvent || 0); } catch (err) { console.error('[snapshot]', err); continue; }
      if (room.match.phase === 'loading') {
        const list = [...room.members.values()].filter((m) => m.ws);
        state.loading = { ready: list.filter((m) => m.ready).length, total: list.length };
      }
      const next = new Map((state.loot || []).map((l) => [l.id, l]));
      if (member.knownLoot) {
        const upsert = (state.loot || []).filter((l) => !member.knownLoot.has(l.id));
        const remove = [...member.knownLoot.keys()].filter((id) => !next.has(id));
        delete state.loot;
        state.lootPatch = { upsert, remove };
      }
      member.knownLoot = next;
      member.lastEvent = room.match.eventId;
      send(member.ws, { type: 'state', state });
    }
  };

  const startMatch = (room) => {
    if (room.match.phase !== 'waiting') return false;
    if (!room.match.start()) return false;
    // start() 直接把 phase 设为 live；联机需要先等所有客户端渲染就绪
    room.match.phase = 'loading';
    room.match.time = 0;
    room.loadingAt = Date.now();
    for (const member of room.members.values()) member.ready = false;
    broadcast(room, lobby(room));
    broadcastState(room);
    return true;
  };

  const leaveRoom = (client, explicit = false) => {
    const room = rooms.get(client.room);
    client.room = null;
    if (!room) return;
    const member = room.members.get(client.id);
    if (!member) return;
    if (member.ws && member.ws !== client.ws) return;
    member.ws = null;
    member.lastSeen = Date.now();
    try { room.match.disconnect(client.id); } catch { /* ignore */ }
    if (explicit) {
      room.members.delete(client.id);
      if (room.match.phase === 'waiting') room.match.removePlayer?.(client.id);
      else if (room.match.phase !== 'ended') {
        const p = room.match.players.find((x) => x.id === client.id);
        if (p) room.match.kill(p, null, 'leave');
      }
    }
    if (room.host === client.id) room.host = [...room.members.values()].find((m) => m.ws)?.id || null;
    if (![...room.members.values()].some((m) => m.ws)) room.emptySince = room.emptySince || Date.now();
    room.touched = Date.now();
    if (room.match.phase === 'waiting') broadcast(room, lobby(room));
  };

  const joinRoom = (client, ws, msg) => {
    const code = clampStr(msg.code, 8).toUpperCase();
    const proto = Number(msg.protocol);
    if (proto !== PROTOCOL_VERSION) { fail(ws, `客户端版本(${proto || '?'})与服务器(${PROTOCOL_VERSION})不一致，请更新后重试`); return; }
    if (client.room) { fail(ws, '请先离开当前房间'); return; }

    if (msg.mode === 'resume') {
      const room = rooms.get(code);
      const token = clampStr(msg.token, 128);
      const member = room && [...room.members.values()].find((m) => token && m.token === token);
      if (!member) { fail(ws, '重连凭证已失效，请重新加入房间'); return; }
      if (member.ws && member.ws !== ws) { fail(ws, '该角色已在另一台设备上活跃'); return; }
      member.ws = ws; member.lastSeen = Date.now(); member.knownLoot = null; member.lastEvent = 0;
      client.id = member.id; client.room = room.code;
      try { room.match.reconnect(member.id); } catch { /* ignore */ }
      room.emptySince = null; room.touched = Date.now();
      if (!room.host) room.host = member.id;
      send(ws, { type: 'joined', id: member.id, token: member.token, code: room.code, host: room.host === member.id, team: member.team, mapId: room.match.mapId, gameMode: room.match.mode });
      if (room.match.phase === 'waiting') broadcast(room, lobby(room));
      else broadcastState(room);
      return;
    }

    const gameMode = GAME_MODES.includes(msg.gameMode) ? msg.gameMode : 'squad';
    const mapId = MAPS[msg.mapId] ? msg.mapId : MAP_ORDER[0];
    const difficulty = ['recruit', 'veteran', 'elite'].includes(msg.difficulty) ? msg.difficulty : 'veteran';
    let room = null;
    if (msg.mode === 'create') room = newRoom({ public: false, mode: gameMode, mapId, difficulty });
    else if (msg.mode === 'quick') room = [...rooms.values()].find((r) => r.public && r.match.mode === gameMode && r.match.phase === 'waiting' && r.members.size < MAX_HUMANS_PER_ROOM) || newRoom({ public: true, mode: gameMode, mapId, difficulty });
    else if (msg.mode === 'join') room = rooms.get(code);
    else { fail(ws, '未知的房间操作'); return; }
    if (!room) { fail(ws, msg.mode === 'join' ? '房间不存在，请检查邀请码' : '服务器房间已满，请稍后再试'); return; }
    if (room.match.phase !== 'waiting') { fail(ws, '本局已经开始，请等待下一局或让房主重开'); return; }
    if (room.members.size >= MAX_HUMANS_PER_ROOM) { fail(ws, '战局已满'); return; }

    const teamWant = Number.isInteger(msg.team) ? msg.team : msg.mode === 'quick' ? -1 : 0;
    let team = teamWant;
    if (room.match.teamSize === 1) team = 0;
    else if (team < 0 || team >= room.match.maxTeams) team = room.match.nextTeam();
    else if (room.match.players.filter((p) => p.team === team).length >= room.match.teamSize) {
      if (msg.mode === 'join') { fail(ws, '该小队已满，请选择另一支小队'); return; }
      team = room.match.nextTeam();
    }
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(24).toString('base64url');
    const name = clampStr(msg.name, 14) || '旅人';
    const player = room.match.addPlayer(id, name, { bot: false, team, loadout: msg.loadout });
    if (!player) { fail(ws, '加入失败，请重试'); return; }
    room.members.set(id, { id, token, ws, name: player.name, team: player.team, lastSeen: Date.now(), ready: false, knownLoot: null, lastEvent: 0 });
    room.host = room.host || id;
    room.touched = Date.now(); room.emptySince = null;
    client.id = id; client.room = room.code;
    send(ws, { type: 'joined', id, token, code: room.code, host: room.host === id, team, mapId: room.match.mapId, gameMode: room.match.mode });
    broadcast(room, lobby(room));
  };

  // ── 连接 ──────────────────────────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    const client = { ws, ip, id: null, room: null, alive: true, bucket: 0, bucketAt: Date.now(), joins: 0, joinsAt: Date.now(), chat: 0, chatAt: Date.now() };
    clients.add(client);
    ws.on('error', () => {});
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => {
      leaveRoom(client);
      clients.delete(client);
      const n = (ipCounts.get(ip) || 1) - 1;
      if (n > 0) ipCounts.set(ip, n); else ipCounts.delete(ip);
    });
    send(ws, { type: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, motd: '雾岛突围 1.0 · 信号已接入' });

    ws.on('message', (buffer, binary) => {
      const now = Date.now();
      if (now - client.bucketAt > 1000) { client.bucketAt = now; client.bucket = 0; }
      if (++client.bucket > RATE_PER_SEC) { try { ws.close(1008, 'rate'); } catch { /* ignore */ } return; }
      if (binary) { fail(ws, '请使用 JSON 文本协议'); return; }
      let msg;
      try { msg = JSON.parse(buffer.toString()); } catch { fail(ws, '消息格式错误'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { fail(ws, '消息格式错误'); return; }

      if (msg.type === 'ping') { send(ws, { type: 'pong', sent: Number(msg.sent) || 0, time: now }); return; }
      if (msg.type === 'rooms') { send(ws, { type: 'rooms', rooms: roomSummaries() }); return; }
      if (msg.type === 'join') {
        if (now - client.joinsAt > 10000) { client.joinsAt = now; client.joins = 0; }
        if (++client.joins > 10) { fail(ws, '操作过于频繁，请稍后再试'); return; }
        joinRoom(client, ws, msg);
        return;
      }
      if (!client.room) { fail(ws, '请先加入房间'); return; }
      const room = rooms.get(client.room);
      if (!room) { fail(ws, '房间已失效'); return; }

      if (msg.type === 'leave') { leaveRoom(client, true); send(ws, { type: 'left' }); return; }
      if (msg.type === 'ready') {
        const member = room.members.get(client.id);
        if (member) member.ready = msg.ready !== false;
        return;
      }
      if (msg.type === 'start') {
        if (room.host !== client.id) { fail(ws, '只有房主可以开始战斗'); return; }
        if (room.match.phase === 'waiting') startMatch(room);
        return;
      }
      if (msg.type === 'rematch') {
        if (room.match.phase !== 'ended') { fail(ws, '本局还没有结束'); return; }
        room.rematchVotes.add(client.id);
        const connected = [...room.members.values()].filter((m) => m.ws);
        if (room.rematchVotes.size >= Math.max(1, Math.ceil(connected.length * 0.6))) restartRoom(room);
        return;
      }
      if (msg.type === 'chat') {
        if (now - client.chatAt > 1000) { client.chatAt = now; client.chat = 0; }
        if (++client.chat > 2) { fail(ws, '发言太快了'); return; }
        const text = clampStr(msg.text, 80);
        if (!text) return;
        const member = room.members.get(client.id);
        const out = { type: 'chat', from: client.id, name: member?.name || '?', team: member?.team ?? 0, text, channel: msg.channel === 'all' ? 'all' : 'team' };
        if (out.channel === 'all') broadcast(room, out);
        else for (const m of room.members.values()) if (m.ws && m.team === out.team) send(m.ws, out);
        return;
      }
      if (msg.type === 'input') {
        room.match.input(client.id, msg.input);
        return;
      }
    });
  });

  const restartRoom = (room) => {
    const members = [...room.members.values()].filter((m) => m.ws);
    const match = new Match({ mapId: room.match.mapId, seed: randomInt(1, 2 ** 30), mode: room.match.mode, maxPlayers: room.match.mode === 'training' ? 16 : MAX_PLAYERS, difficulty: room.match.difficultyId });
    room.match = match;
    room.endedAt = 0; room.rematchVotes.clear(); room.loadingAt = 0;
    for (const member of members) {
      member.ready = false; member.knownLoot = null; member.lastEvent = 0;
      const p = match.addPlayer(member.id, member.name, { bot: false, team: member.team });
      if (p) member.team = p.team;
    }
    broadcast(room, lobby(room));
  };

  // ── 主循环 ────────────────────────────────────────────────────────────────
  let previous = performance.now();
  let accumulator = 0;
  let ticks = 0;
  const TICK_MS = 1000 / TICK_RATE;
  const timer = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min((now - previous) / 1000, 0.25);
    previous = now;
    while (accumulator >= 1 / TICK_RATE) {
      accumulator -= 1 / TICK_RATE;
      ticks++;
      for (const room of rooms.values()) {
        const activeMembers = [...room.members.values()].filter((m) => m.ws);
        const active = activeMembers.length > 0;

        // 等待室：清理长时间掉线成员
        if (room.match.phase === 'waiting') {
          for (const member of room.members.values()) {
            if (!member.ws && Date.now() - member.lastSeen > SCHEDULE.reconnectWindow * 1000) {
              room.members.delete(member.id);
              room.match.removePlayer?.(member.id);
              if (room.host === member.id) room.host = activeMembers[0]?.id || null;
              broadcast(room, lobby(room));
            }
          }
          if (room.public && active && Date.now() - room.created >= autoStartMs) startMatch(room);
        }

        // 加载阶段：等所有在线客户端渲染就绪，或超时
        if (room.match.phase === 'loading') {
          const ready = activeMembers.every((m) => m.ready);
          if (ready || Date.now() - room.loadingAt > SCHEDULE.loadingTimeout * 1000) {
            room.match.phase = 'deploying';
            room.match.time = 0;
            if (room.match.botsReady !== true) room.match.botsReady = true;
          }
        }

        try { room.match.update(1 / TICK_RATE); } catch (err) { console.error('[update]', room.code, err); }

        if (ticks % SNAPSHOT_EVERY_TICKS === 0 && room.match.phase !== 'waiting' && active) broadcastState(room);
        if (room.match.phase === 'ended' && !room.endedAt) room.endedAt = Date.now();
      }
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const empty = room.emptySince && now - room.emptySince > 30000;
      const ended = room.endedAt && now - room.endedAt > SCHEDULE.endedKeepMs;
      const stale = room.match.phase === 'waiting' && now - room.created > SCHEDULE.roomLifetimeMs;
      if (empty || ended || stale) {
        for (const m of room.members.values()) {
          if (m.ws) { send(m.ws, { type: 'expired' }); try { m.ws.close(1000, 'room closed'); } catch { /* ignore */ } }
        }
        rooms.delete(room.code);
      }
    }
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch { /* ignore */ } }
      else { c.alive = false; try { c.ws.ping(); } catch { /* ignore */ } }
    }
  }, 15000);
  if (cleanup.unref) cleanup.unref();

  return {
    server, rooms, clients,
    listen: () => new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(port, host, () => { server.off('error', rej); res(server.address()); });
    }),
    close: () => new Promise((res) => {
      clearInterval(timer); clearInterval(cleanup);
      for (const c of clients) { try { c.ws.terminate(); } catch { /* ignore */ } }
      wss.close();
      server.close(() => res());
    }),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const app = createGameServer({
    port: Number(process.env.PORT) || 8787,
    host: process.env.HOST || '0.0.0.0',
    origins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  const address = await app.listen();
  console.log(`MIST ISLE ${VERSION} · protocol ${PROTOCOL_VERSION} listening on http://${address.address}:${address.port}`);
  const stop = async () => { try { await app.close(); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
