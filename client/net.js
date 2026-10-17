// 雾岛突围 / MIST ISLE 1.0 — 客户端网络封装（owner: netserver · client/net.js）
// 负责：连接、协议消息、输入节流、心跳/RTT、断线自动重连（resume）。

const CONNECT_TIMEOUT = 6000;
const INPUT_INTERVAL = 40;       // 25Hz
const PING_INTERVAL = 2000;
const HEARTBEAT_TIMEOUT = 12000; // 服务端每 10Hz 发 state，12s 无消息判定掉线
const BACKOFF = [600, 1000, 1600, 2400, 3500, 5000];

export class NetClient {
  constructor({ onMessage, onStatus, onError, onRooms } = {}) {
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
    this.ping = null;
    this.jitter = 0;
    this.rtts = [];
    this.reconnectAttempt = 0;
    this.reconnectDeadline = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.closedByUser = false;
    this.pending = [];
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

      ws.onmessage = (event) => {
        if (generation !== this.generation) return;
        this.lastMessageAt = performance.now();
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'pong') {
          this._onPong(msg);
          return;
        }
        if (msg.type === 'joined') { this.joined = true; this.reconnectAttempt = 0; }
        if (msg.type === 'rooms') { this.onRooms(msg.rooms || []); return; }
        if (msg.type === 'error') {
          if (!this.joined) { this.onError(msg); }
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

  _raw(message) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > 64 * 1024) return false;
    try { ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  // ── 协议 ───────────────────────────────────────────────────────────────────
  join(options = {}) {
    const msg = { type: 'join', ...options, protocol: options.protocol };
    this.joinMessage = { type: 'join', mode: 'resume', code: options.code || '', token: options.token || '', protocol: options.protocol };
    if (options.mode === 'resume' && options.token) this.joinMessage = msg;
    return this._raw(msg);
  }

  resume(code, token, protocol) {
    this.joinMessage = { type: 'join', mode: 'resume', code, token, protocol };
    return this._raw(this.joinMessage);
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
    this.ping = Math.round(this.rtts.reduce((a, b) => a + b, 0) / this.rtts.length);
    if (this.rtts.length > 1) {
      const avg = this.ping;
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
    if (this.ping == null) return 'unknown';
    if (this.ping < 80) return 'good';
    if (this.ping < 160) return 'fair';
    return 'poor';
  }
}

export default NetClient;
