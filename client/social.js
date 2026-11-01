// 雾岛突围 / MIST ISLE 1.1 — 社交客户端（owner: social · client/social.js）
// 把 server/social.mjs 的 {type:'social', action} 包成 Promise + 事件；不碰 DOM。
const REQUEST_TIMEOUT = 6000;const REASONS = {
  NOT_READY: '尚未连接到社交服务', BAD_ID: '玩家标识无效', NOT_FOUND: '找不到该玩家', SELF: '不能添加自己',
  ALREADY_FRIEND: '已经是好友了', NOT_FRIEND: '对方不在好友列表', FRIEND_LIMIT: '好友已满（上限 50）',
  TARGET_FRIEND_LIMIT: '对方好友已满', OFFLINE: '对方不在线', TOO_MANY: '待处理邀请过多',
  DUPLICATE: '邀请已发送', EXPIRED: '邀请已过期（30 秒）', NOT_YOURS: '这条邀请不是给你的',
  ALREADY_IN_CLAN: '已经在战队中', LEAVE_FIRST: '请先退出当前战队', CLAN_FULL: '战队已满（上限 20 人）',
  BAD_NAME: '战队名至少 2 个字', BAD_TAG: '战队标签需 2-4 个大写字母', NAME_TAKEN: '战队名已被占用',
  TAG_TAKEN: '战队标签已被占用', NOT_IN_CLAN: '你还没有加入战队', BAD_EMOTE: '无效的表情',
  NO_ROOM: '不在房间内', BAD_ACTION: '无效的社交操作', FAILED: '操作失败',
};
const reasonText = (reason) => REASONS[reason] || '操作失败';

export class SocialClient {
  /** net: NetClient 或 () => NetClient；id: () => playerId（大厅阶段服务端靠它认人）。 */
  constructor(net, id = null) {
    this.net = net || null;
    this.getPlayerId = typeof id === 'function' ? id : () => null;
    this.handlers = new Map();  // event -> Set<fn>
    this.pending = new Map();   // reqId -> { resolve, reject, timer, action }
    this.friends = [];
    this.invites = [];
    this.clan = null;
    this.profile = null;
    this.seq = 0;
  }
  // ── 事件 ──────────────────────────────────────────────────────────────────
  on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this.handlers.get(event)?.delete(fn); }
  emit(event, payload) {
    for (const fn of [...(this.handlers.get(event) || [])]) {
      try { fn(payload); } catch (err) { console.warn('[social]', event, err); }
    }
  }
  // ── 请求-响应（6 秒超时 reject） ──────────────────────────────────────────
  /** net 允许是函数：app.net 会随重连更换，取用时再解引用。 */
  netRef() {
    const net = typeof this.net === 'function' ? this.net() : this.net;
    return net && typeof net.send === 'function' ? net : null;
  }
  request(action, payload = {}, timeout = REQUEST_TIMEOUT) {
    const net = this.netRef();
    if (!net) return Promise.reject(new Error('未连接服务器'));
    const reqId = `s${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const pid = this.getPlayerId?.() || null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`社交请求超时：${action}`));
      }, Math.max(500, Number(timeout) || REQUEST_TIMEOUT));
      this.pending.set(reqId, { resolve, reject, timer, action });
      if (!net.send({ type: `social:${action}`, action, reqId, ...(pid ? { pid } : {}), ...payload })) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new Error('消息发送失败'));
      }
    });
  }
  /** 由 main.js 的 handleNetMessage 转发；返回 true 表示已被社交层消费。 */
  handleMessage(msg) {
    if (!msg || msg.type !== 'social') return false;
    const waiter = msg.reqId ? this.pending.get(msg.reqId) : null;
    if (waiter) {
      this.pending.delete(msg.reqId);
      clearTimeout(waiter.timer);
      if (msg.ok === false) {
        const err = new Error(reasonText(msg.reason));
        err.reason = msg.reason || 'FAILED';
        waiter.reject(err);
        return true;
      }
      waiter.resolve(msg);
    }
    this.applyState(msg);
    return true;
  }
  /** 把服务端下发的快照落到本地缓存，再广播事件（好友/邀请/战队/在线状态）。 */
  applyState(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (Array.isArray(msg.friends)) { this.friends = msg.friends; this.emit('friends', this.friends); }
    if (Array.isArray(msg.invites)) { this.invites = msg.invites; this.emit('invites', this.invites); }
    if (msg.clan !== undefined) { this.clan = msg.clan || null; this.emit('clan', this.clan); }
    if (msg.profile) { this.profile = msg.profile; this.emit('profile', this.profile); }
    if (msg.action === 'invite' && msg.invite) this.emit('invite', msg.invite);
    if (msg.action === 'presence' && msg.presence) this.emit('presence', msg.presence);
    if (msg.action === 'invite:accepted' || msg.action === 'invite:declined') {
      this.emit('invite:result', { accepted: msg.action === 'invite:accepted', inviteId: msg.inviteId, roomCode: msg.roomCode });
    }
    this.emit('message', msg);
  }
  // ── 好友 / 邀请 / 战队 / 表情 ─────────────────────────────────────────────
  listFriends() { return this.request('friend:list'); }
  addFriend(id) { return this.request('friend:add', { id }); }
  removeFriend(id) { return this.request('friend:remove', { id }); }
  updateProfile(patch = {}) { return this.request('profile', { profile: patch }); }
  invite(id, roomCode = '') { return this.request('invite', { id, roomCode }); }
  respond(inviteId, accept = true) { return this.request('respond', { inviteId, accept: !!accept }); }
  listInvites() { return this.request('invites'); }
  createClan(name, tag) { return this.request('clan:create', { name, tag }); }
  joinClan(id) { return this.request('clan:join', { id }); }
  leaveClan() { return this.request('clan:leave'); }
  clanInfo(id = '') { return this.request('clan:info', id ? { id } : {}); }
  emote(id) { return this.request('emote', { id }); }
  /** 断线/重连时清空在途请求，避免 Promise 永远悬着。 */
  reset(reason = '连接已断开') {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      try { waiter.reject(new Error(reason)); } catch { /* ignore */ }
    }
    this.pending.clear();
  }
}
export { REASONS, REQUEST_TIMEOUT, reasonText };
export default SocialClient;
