// 雾岛突围 / MIST ISLE 1.0 — 客户端网络封装（owner: netserver · client/net.js）
// 负责：连接、协议消息、输入节流、心跳/RTT、断线自动重连（resume）。
// 二进制快照（wire v1）：握手时申明 binary:true；服务端回 joined.binary 后，
// 收到的二进制帧在这里解成与 JSON 完全同构的 { type:'state', state }，上层零改动。

import { createWireContext, decodeStateFrame } from '../shared/wire.mjs';

/**
 * 判断一条 ws 消息是不是二进制帧。
 * - 浏览器：binaryType='arraybuffer' 时 event.data 为 ArrayBuffer；
 *   （若某些环境仍给 Blob，这里返回 false，JSON.parse 会失败并安全丢弃。）
 * - Node 的 ws（e2e / 单测脚本）：event 第二参数为 binary 标志，data 是 Buffer。
 */
function isBinaryMessage(event) {
  if (event && event.isBinary === true) return true;
  const data = event?.data;
  if (!data) return false;
  if (typeof data !== 'object') return false; // 字符串走 JSON
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

/** 把浏览器 ArrayBuffer / Node Buffer / TypedArray 统一成 Uint8Array。 */
function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(0);
}

const CONNECT_TIMEOUT = 6000;
const INPUT_INTERVAL = 40;       // 25Hz
const PING_INTERVAL = 2000;
const HEARTBEAT_TIMEOUT = 12000; // 服务端每 10Hz 发 state，12s 无消息判定掉线
const BACKOFF = [600, 1000, 1600, 2400, 3500, 5000];

export class NetClient {
  constructor({ onMessage, onStatus, onError, onRooms, wantBinary = true } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.onRooms = onRooms || (() => {});
    this.ws = null;
    this.url = '';
    this.generation = 0;
    this.connected = false;
    this.joined = false;
    this.joinMessage = null;
    this.lastInputAt = 0;
    this.lastPingAt = 0;
    this.lastMessageAt = 0;
    // 注意：字段名不能叫 ping —— 会遮蔽原型方法 ping()（this.ping = null 之后
    // app.net.ping() 会抛 TypeError，且该异常发生在 rAF 帧回调里会把主循环打死）。
    this.pingMs = null;
    this.jitter = 0;
    this.rtts = [];
    this.reconnectAttempt = 0;
    this.reconnectDeadline = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.closedByUser = false;
    this.pending = [];
    // ── 二进制快照状态 ──
    // wantBinary：本端是否愿意用二进制（构造函数可关，便于 A/B 对比与排障）。
    this.wantBinary = wantBinary !== false;
    // binary：服务端是否已确认本连接走二进制（joined.binary === true）。
    this.binary = false;
    // wireCtx：由服务端 roster 消息构建；解码任何二进制帧之前必须就绪。
    this.wireCtx = null;
    this.wireReady = false;
    this.binaryFrames = 0;
    this.jsonFrames = 0;
  }

  // ── 连接 ───────────────────────────────────────────────────────────────────
  connect(url) {
    this.url = url;
    this.closedByUser = false;
    return this._open(false);
  }

  _open(isResume) {
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        if (isResume) { this._scheduleReconnect(); resolve(); return; }
        reject(new Error('无法创建连接，请检查服务器地址'));
        return;
      }
      this.ws = ws;
      // 新连接（含重连）必须等新 roster 才能解二进制帧；旧上下文先作废，
      // 避免用上一局的字符串表/槽位误解码（跨局重开时槽位可能整体错位）。
      this.wireReady = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* 忽略 */ }
        if (isResume) { this._scheduleReconnect(); resolve(); }
        else reject(new Error('连接超时，请检查地址与网络'));
      }, CONNECT_TIMEOUT);

      ws.onopen = () => {
        if (generation !== this.generation) return;
        clearTimeout(timeout);
        this.connected = true;
        this.lastMessageAt = performance.now();
        if (!settled) { settled = true; resolve(); }
        // 重连时发送 resume
        if (isResume && this.joinMessage) this._raw(this.joinMessage);
        // 补发排队消息（join 除外，join 由上层显式发送）
        const queue = this.pending;
        this.pending = [];
        for (const msg of queue) this._raw(msg);
        this._startHeartbeat();
      };

      // 二进制消息标记（浏览器：event.data 为 Blob/ArrayBuffer；Node 测试用的 ws：
      // 第二参数 binary=true）。两者都要兼容，否则 e2e 与真实浏览器行为会分叉。
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (event) => {
        if (generation !== this.generation) return;
        this.lastMessageAt = performance.now();
        if (isBinaryMessage(event)) { this._onBinary(event.data); return; }
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'pong') {
          this._onPong(msg);
          return;
        }
        if (msg.type === 'joined') {
          this.joined = true;
          this.reconnectAttempt = 0;
          // 服务端确认走二进制：下一帧之前必须已经收到 roster。
          this.binary = msg.binary === true;
          if (!this.binary) { this.wireCtx = null; this.wireReady = false; }
        }
        if (msg.type === 'spectating') {
          this.binary = msg.binary === true;
          if (!this.binary) { this.wireCtx = null; this.wireReady = false; }
        }
        // roster：静态字段（id/name/bot/team/teamName）与字符串表，一次下发多次复用。
        if (msg.type === 'roster') {
          this.wireCtx = createWireContext({ roster: msg.players || [] });
          this.wireReady = true;
          return; // 上层不需要感知 roster
        }
        if (msg.type === 'rooms') { this.onRooms(msg.rooms || []); return; }
        if (msg.type === 'error') {
          // 重连期间的错误必须上抛：旧实现用 `!this.joined` 过滤，而断线时 joined
          // 仍为 true，RESUME_EXPIRED / RESUME_CONFLICT 被静默吞掉，界面只会卡在
          // 「重连中」直到 20 秒超时，玩家完全不知道发生了什么。
          if (!this.joined || msg.code) { this.onError(msg); }
          // 重连被服务端明确拒绝时放弃重连，立刻回到可重试状态
          if (msg.code === 'RESUME_EXPIRED' || msg.code === 'RESUME_CONFLICT' || msg.code === 'PROTOCOL_MISMATCH') {
            this.closedByUser = true;
            this.onStatus('resume-failed', msg);
            return;
          }
        }
        try { this.onMessage(msg); } catch (err) { console.error('[net] message handler', err); }
      };

      ws.onerror = () => { /* close 会跟随触发 */ };

      ws.onclose = (event) => {
        if (generation !== this.generation) return;
        clearTimeout(timeout);
        this.connected = false;
        this._stopHeartbeat();
        this.ws = null;
        if (!settled) {
          settled = true;
          if (isResume) { this._scheduleReconnect(); resolve(); return; }
          reject(new Error(this.closedByUser ? '连接已取消' : '无法连接服务器，请检查地址与网络'));
          return;
        }
        if (this.closedByUser) { this.onStatus('closed', event); return; }
        // 已被服务端踢出/过期：不重连
        if (event?.code === 1000 || event?.code === 1008 || event?.code === 1013) {
          this.onStatus('closed', event);
          return;
        }
        if (this.joined) this._scheduleReconnect();
        else this.onStatus('closed', event);
      };
    });
  }

  /**
   * 二进制帧解码：还原成与 JSON 完全同构的 { type:'state', state, spectator }，
   * 交给同一套 onMessage，因此 client/main.js、scene.js、ui-hud.js 无需任何改动。
   * 若 roster 尚未到达（理论上不会：服务端保证 roster 先于首帧），丢弃并按 JSON 心跳处理；
   * 解码抛错也只丢这一帧 —— 不能因为一帧坏包打死整个 rAF 主循环。
   */
  _onBinary(data) {
    if (!this.wireReady || !this.wireCtx) return;
    let frame;
    try { frame = decodeStateFrame(toBytes(data), this.wireCtx); } catch (err) { console.warn('[net] binary frame dropped', err?.message || err); return; }
    this.binaryFrames++;
    try { this.onMessage(frame); } catch (err) { console.error('[net] message handler', err); }
  }

  _raw(message) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > 64 * 1024) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  // ── 协议 ───────────────────────────────────────────────────────────────────
  join(options = {}) {
    // binary:true 是能力位：老服务端会忽略未知字段、继续回 JSON；
    // 新服务端只有在 joined 里回 binary:true 后才会改发二进制帧。
    const msg = { type: 'join', ...options, protocol: options.protocol, binary: this.wantBinary === true };
    // 只有「第一次成功进房前」才用这份兜底 resume 帧；真正的 code/token 由
    // setResume() 在收到 joined 后写入（见 client/main.js）。
    if (options.mode === 'resume' && options.token) this.joinMessage = msg;
    return this._raw(msg);
  }

  /**
   * 记录重连凭据。收到服务端 joined（含 code/token）后必须调用一次，
   * 否则断线后 _open(true) 发出的 resume 帧里 code/token 为空，
   * 服务端必然回 RESUME_EXPIRED —— 表现为「断线后永远连不回来」。
   */
  setResume({ code, token, protocol } = {}) {
    if (!token) return false;
    this.joinMessage = {
      type: 'join', mode: 'resume', code: String(code || ''), token: String(token),
      protocol, binary: this.wantBinary === true,
    };
    return true;
  }

  resume(code, token, protocol) {
    return this.setResume({ code, token, protocol }) && this._raw(this.joinMessage);
  }

  send(message) { return this._raw(message); }

  sendInput(input) {
    const now = performance.now();
    if (now - this.lastInputAt < INPUT_INTERVAL) return false;
    this.lastInputAt = now;
    return this._raw({ type: 'input', input });
  }

  sendNow(input) { return this._raw({ type: 'input', input }); }

  ping() {
    this.lastPingAt = performance.now();
    this._raw({ type: 'ping', sent: performance.now() });
  }

  requestRooms() { return this._raw({ type: 'rooms' }); }

  chat(text, channel = 'team') {
    const clean = String(text || '').slice(0, 80);
    if (!clean) return false;
    return this._raw({ type: 'chat', text: clean, channel });
  }

  /** 降落区投票：归一化 0-1 坐标，越界值先本地 clamp，非法值不发送。 */
  dropVote(x, z) {
    const norm = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
    const nx = norm(Number(x));
    const nz = norm(Number(z));
    if (nx == null || nz == null) return false;
    return this._raw({ type: 'dropvote', x: nx, z: nz });
  }

  leave() {
    this._raw({ type: 'leave' });
    this.closedByUser = true;
    this.close();
  }

  close() {
    this.closedByUser = true;
    this.generation++;
    this._stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.joined = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000, 'client closed'); } catch { /* 忽略 */ }
    }
  }

  // ── RTT / 心跳 ──────────────────────────────────────────────────────────────
  _onPong(msg) {
    const rtt = Math.max(0, Math.round(performance.now() - (msg.sent || performance.now())));
    this.rtts.push(rtt);
    if (this.rtts.length > 8) this.rtts.shift();
    this.pingMs = Math.round(this.rtts.reduce((a, b) => a + b, 0) / this.rtts.length);
    if (this.rtts.length > 1) {
      const avg = this.pingMs;
      const variance = this.rtts.reduce((sum, r) => sum + (r - avg) ** 2, 0) / this.rtts.length;
      this.jitter = Math.round(Math.sqrt(variance));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      if (performance.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT) {
        try { this.ws?.close(4000, 'heartbeat timeout'); } catch { /* 忽略 */ }
        return;
      }
      if (performance.now() - this.lastPingAt > PING_INTERVAL) this.ping();
    }, 1000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  // ── 重连 ───────────────────────────────────────────────────────────────────
  _scheduleReconnect() {
    if (this.closedByUser) return;
    const now = performance.now();
    if (!this.reconnectDeadline) this.reconnectDeadline = now + 20000;
    if (now > this.reconnectDeadline) {
      this.onStatus('failed', { message: '重连超时，请重新加入房间' });
      this.close();
      return;
    }
    const attempt = ++this.reconnectAttempt;
    this.onStatus('reconnecting', { attempt });
    const delay = BACKOFF[Math.min(BACKOFF.length - 1, attempt - 1)];
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.closedByUser) return;
      this._open(true).then(() => {
        if (this.connected) {
          this.reconnectDeadline = 0;
          this.onStatus('resumed', { attempt });
        }
      }).catch(() => { /* 交给下一次退避 */ });
    }, delay);
  }

  get quality() {
    if (this.pingMs == null) return 'unknown';
    if (this.pingMs < 80) return 'good';
    if (this.pingMs < 160) return 'fair';
    return 'poor';
  }
}

export default NetClient;
