import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { Match, MAX_PLAYERS, MAX_HUMANS_PER_ROOM, SQUAD_SIZE, TICK_RATE } from '../shared/simulation.mjs';
import { PROTOCOL_VERSION } from '../shared/rules.mjs';

const MAX_ROOMS = 64;
const MAX_CONNECTIONS = 256;
const MAX_BUFFER = 256 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function createGameServer({ port = 8787, host = '0.0.0.0', maxRooms = MAX_ROOMS, autoStartMs = 20000, origins = [], maxConnectionsPerIp = 72 } = {}) {
  const rooms = new Map();
  const clients = new Set();
  const ipCounts = new Map();
  const root = new URL('../dist/', import.meta.url);
  const allowedFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/icon.svg', ['icon.svg', 'image/svg+xml']]]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const path = (req.url || '/').split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, rooms: rooms.size, connections: clients.size, maxPlayers: MAX_PLAYERS }));
      return;
    }
    const file = allowedFiles.get(path);
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const data = await readFile(new URL(file[0], root));
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(503); res.end('Run npm run build before starting the server.'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress;
    const origin = req.headers.origin;
    if (req.url !== '/ws' || clients.size >= MAX_CONNECTIONS || (ipCounts.get(ip) || 0) >= maxConnectionsPerIp || (origins.length && origin && !origins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  const send = (ws, data) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > MAX_BUFFER) { ws.close(1013, 'Slow connection'); return; }
      ws.send(JSON.stringify(data));
    }
  };
  const fail = (ws, message) => send(ws, { type: 'error', message });
  const broadcast = (room, data) => { for (const member of room.members.values()) if (member.ws) send(member.ws, data); };
  const broadcastState = room => {
    for (const member of room.members.values()) if (member.ws) {
      const state = room.match.snapshot(member.id, member.lastEvent || 0);
      if (room.match.phase === 'loading') state.loading = { ready: [...room.members.values()].filter(m => m.ready && m.ws).length, total: [...room.members.values()].filter(m => m.ws).length };
      const next = new Map(state.loot.map(l => [l.id, l]));
      if (member.knownLoot) {
        const upsert = state.loot.filter(l => !member.knownLoot.has(l.id));
        const remove = [...member.knownLoot.keys()].filter(id => !next.has(id));
        delete state.loot; state.lootPatch = { upsert, remove };
      }
      member.knownLoot = next; member.lastEvent = room.match.eventId;
      send(member.ws, { type: 'state', state });
    }
  };
  const lobby = room => ({ type: 'lobby', code: room.code, host: room.host, public: room.public, mode: room.match.mode,
    startsIn: room.public ? Math.max(0, Math.ceil((room.created + autoStartMs - Date.now()) / 1000)) : null,
    players: [...room.members.values()].map(m => ({ id: m.id, name: m.name, team: m.team, connected: !!m.ws })), max: MAX_HUMANS_PER_ROOM, slots: room.match.teamSize });
  const makeCode = () => {
    let code;
    do { code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (rooms.has(code));
    return code;
  };
  const newRoom = (isPublic, mode) => {
    if (rooms.size >= maxRooms) return null;
    const code = makeCode();
    const room = { code, public: isPublic, host: null, members: new Map(), match: new Match({ seed: randomInt(1, 2 ** 30), mode }), created: Date.now(), touched: Date.now(), emptySince: null };
    rooms.set(code, room);
    return room;
  };
  const prepareMatch = room => {
    if (!room.match.start()) return false;
    room.match.phase = 'loading'; room.loadingAt = Date.now();
    for (const member of room.members.values()) member.ready = false;
    broadcastState(room); return true;
  };
  const leave = (client, explicit = false) => {
    const room = rooms.get(client.room);
    if (!room) { client.room = null; return; }
    const member = room.members.get(client.id);
    if (!member || member.ws !== client.ws) { client.room = null; return; }
    member.ws = null;
    member.lastSeen = Date.now();
    room.match.disconnect(client.id);
    if (explicit) {
      room.members.delete(client.id);
      if (room.match.phase === 'waiting') room.match.players = room.match.players.filter(p => p.id !== client.id);
      else if (room.match.phase !== 'ended') { const p = room.match.players.find(p => p.id === client.id); if (p) room.match.kill(p, null, 'leave'); }
    }
    if (room.host === client.id) room.host = [...room.members.values()].find(m => m.ws)?.id || null;
    if (![...room.members.values()].some(m => m.ws)) room.emptySince = Date.now();
    room.touched = Date.now();
    if (room.match.phase === 'waiting') broadcast(room, lobby(room));
    client.room = null;
  };

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    const client = { ws, ip, id: null, room: null, alive: true, bucket: 0, bucketAt: Date.now(), joins: 0, joinsAt: Date.now() };
    clients.add(client);
    ws.on('error', () => {});
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => { leave(client); clients.delete(client); const count = (ipCounts.get(ip) || 1) - 1; if (count) ipCounts.set(ip, count); else ipCounts.delete(ip); });
    send(ws, { type: 'hello', protocol: PROTOCOL_VERSION });
    ws.on('message', (buffer, binary) => {
      const now = Date.now();
      if (now - client.bucketAt > 1000) { client.bucketAt = now; client.bucket = 0; }
      if (++client.bucket > 90) { ws.close(1008, 'Rate limit'); return; }
      if (binary) { fail(ws, '请使用 JSON 协议'); return; }
      let msg;
      try { msg = JSON.parse(buffer.toString()); } catch { fail(ws, '消息格式错误'); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { fail(ws, '消息格式错误'); return; }
      if (msg.type === 'ping') { send(ws, { type: 'pong', sent: Number(msg.sent) || 0 }); return; }
      if (msg.type === 'leave') { leave(client, true); send(ws, { type: 'left' }); return; }
      if (msg.type === 'join') {
        if (msg.protocol !== PROTOCOL_VERSION) { fail(ws, '版本不一致，请更新客户端和服务端至同一版本'); return; }
        if (client.room) { fail(ws, '请先退出当前房间'); return; }
        if (now - client.joinsAt > 10000) { client.joinsAt = now; client.joins = 0; }
        if (++client.joins > 8) { fail(ws, '操作太频繁，请稍后再试'); return; }
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
        if (msg.mode === 'resume') {
          const room = rooms.get(code);
          const member = room && [...room.members.values()].find(m => typeof msg.token === 'string' && m.token === msg.token);
          if (!member) { fail(ws, '重连凭证已失效，请重新创建房间'); return; }
          if (member.ws && member.ws !== ws) { fail(ws, '该角色已在另一连接中'); return; }
          member.ws = ws; member.lastSeen = now;
          member.knownLoot = null; member.lastEvent = 0;
          client.id = member.id; client.room = code;
          room.match.reconnect(member.id); room.emptySince = null;
          if (!room.host) room.host = member.id;
          send(ws, { type: 'joined', id: member.id, token: member.token, code, host: room.host === member.id });
          if (room.match.phase === 'waiting') broadcast(room, lobby(room)); else broadcastState(room);
          return;
        }
        let room;
        const gameMode = msg.gameMode === 'solo' ? 'solo' : 'squad';
        if (msg.mode === 'create' && gameMode === 'squad' && msg.team !== undefined && (!Number.isInteger(msg.team) || msg.team < 0 || msg.team >= MAX_PLAYERS / SQUAD_SIZE)) { fail(ws,'小队编号无效'); return; }
        if (msg.mode === 'create') room = newRoom(false, gameMode);
        else if (msg.mode === 'quick') room = [...rooms.values()].find(r => r.public && r.match.mode === gameMode && r.match.phase === 'waiting' && r.members.size < MAX_HUMANS_PER_ROOM) || newRoom(true, gameMode);
        else if (msg.mode === 'join') room = rooms.get(code);
        else { fail(ws, '未知的房间操作'); return; }
        if (!room) { fail(ws, msg.mode === 'join' ? '房间不存在，请检查邀请码' : '服务器房间已满'); return; }
        if (room.match.phase !== 'waiting') { fail(ws, '本局已开始，请等待下一局'); return; }
        if (room.members.size >= MAX_HUMANS_PER_ROOM) { fail(ws, '战局已满'); return; }
        const team = msg.mode === 'quick' ? room.match.nextTeam() : Number.isInteger(msg.team) ? msg.team : 0;
        if (room.match.mode === 'squad' && (team < 0 || team >= room.match.maxTeams || room.match.players.filter(p => p.team === team).length >= SQUAD_SIZE)) { fail(ws, '该小队已满，请选择另一个四人小队'); return; }
        const id = randomBytes(8).toString('hex'), token = randomBytes(24).toString('base64url');
        const player = room.match.addPlayer(id, typeof msg.name === 'string' ? msg.name : '旅人', { bot: false, team });
        if (!player) { fail(ws, '加入失败，请重试'); return; }
        room.members.set(id, { id, token, ws, name: player.name, team: player.team, lastSeen: now });
        room.host ||= id;
        room.touched = now; room.emptySince = null;
        client.id = id; client.room = room.code;
        send(ws, { type: 'joined', id, token, code: room.code, host: room.host === id });
        broadcast(room, lobby(room));
        return;
      }
      const room = rooms.get(client.room);
      if (!room) { fail(ws, '请先加入房间'); return; }
      if (msg.type === 'start') {
        if (room.host !== client.id) { fail(ws, '只有房主可以开始'); return; }
        prepareMatch(room);
      } else if (msg.type === 'ready' && room.match.phase === 'loading') {
        const member = room.members.get(client.id); if (member) member.ready = true;
      } else if (msg.type === 'input') room.match.input(client.id, msg.input);
    });
  });

  let previous = performance.now(), accumulator = 0, ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min((now - previous) / 1000, .2); previous = now;
    while (accumulator >= 1 / TICK_RATE) {
      accumulator -= 1 / TICK_RATE; ticks++;
      for (const room of rooms.values()) {
        if (room.match.phase === 'waiting') {
          for (const member of room.members.values()) if (!member.ws && Date.now() - member.lastSeen > 20000) {
            room.members.delete(member.id); room.match.players = room.match.players.filter(p => p.id !== member.id);
            broadcast(room, lobby(room));
          }
        }
        const active = [...room.members.values()].some(m => m.ws);
        if (room.public && room.match.phase === 'waiting' && active && Date.now() - room.created >= autoStartMs) prepareMatch(room);
        if (room.match.phase === 'loading' && active) {
          const members = [...room.members.values()].filter(m => m.ws);
          if (members.every(m => m.ready) || Date.now() - room.loadingAt > 20000) {
            room.match.phase = 'deploying'; room.match.time = 0;
            for (const member of members) if (!member.ready) { send(member.ws, { type:'error', message:'加载超时，本局已开始；重新连接后可恢复' }); member.ws.close(1013,'Loading timeout'); }
          }
        }
        room.match.update(1 / TICK_RATE);
        if (ticks % 3 === 0 && room.match.phase !== 'waiting' && active) broadcastState(room);
        if (ticks % 30 === 0 && room.match.phase === 'waiting' && room.public) broadcast(room, lobby(room));
        if (room.match.phase === 'ended' && !room.endedAt) room.endedAt = Date.now();
      }
    }
  }, 1000 / TICK_RATE);
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if ((room.emptySince && now - room.emptySince > 30000) || (room.endedAt && now - room.endedAt > 180000) || (room.match.phase === 'waiting' && now - room.created > 30 * 60000)) {
        for (const m of room.members.values()) if (m.ws) { send(m.ws, { type: 'expired' }); m.ws.close(1000, 'Room expired'); }
        rooms.delete(room.code);
      }
    }
    for (const c of clients) { if (!c.alive) c.ws.terminate(); else { c.alive = false; c.ws.ping(); } }
  }, 15000);

  return {
    server, rooms,
    listen: () => new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolvePromise(server.address()); }); }),
    close: () => new Promise(resolvePromise => { clearInterval(timer); clearInterval(cleanup); for (const c of clients) c.ws.terminate(); wss.close(); server.close(resolvePromise); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const app = createGameServer({ port: Number(process.env.PORT) || 8787, host: process.env.HOST || '0.0.0.0', origins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean) });
  const address = await app.listen();
  console.log(`Mist Isle listening on http://${address.address}:${address.port}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
