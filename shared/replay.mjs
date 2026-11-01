// 雾岛突围 / MIST ISLE — 死亡回放（Killcam）录制器 · v1.1.0
// 纯逻辑、无 DOM：服务端 tick 循环直接驱动。每 sampleEvery 个 tick 抽一帧，
// 帧结构 { t, p: [[id, x, z, angle, hp, flags], ...] }，坐标 1 位小数、角度 2 位。
// 双预算：maxFrames 帧数 + maxBytes 字节估算，任一超限都从最旧帧开始丢。
export const REPLAY_TICK_RATE = 30;
export const FLAG = { ALIVE: 1, DOWNED: 2, FIRE: 4, CROUCH: 8, VEHICLE: 32 };
const EVENT_KINDS = new Set(['shot', 'hit', 'kill']);
const MAX_EVENTS = 240;
const r1 = (v) => Math.round((Number.isFinite(v) ? v : 0) * 10) / 10;
const r2 = (v) => Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

function flagsOf(p, fired) {
  let f = 0;
  if (p.alive) f |= FLAG.ALIVE;
  if (p.downed) f |= FLAG.DOWNED;
  if (fired) f |= FLAG.FIRE;
  if (p.state === 'crouch') f |= FLAG.CROUCH;
  if (p.car != null) f |= FLAG.VEHICLE;
  return f;
}

export class ReplayRecorder {
  constructor({ maxFrames = 900, sampleEvery = 3, tickRate = REPLAY_TICK_RATE, maxBytes = 1_400_000 } = {}) {
    this.maxFrames = Math.max(1, Math.floor(positive(maxFrames, 900)));
    this.sampleEvery = Math.max(1, Math.floor(positive(sampleEvery, 3)));
    this.tickRate = positive(tickRate, REPLAY_TICK_RATE);
    this.maxBytes = positive(maxBytes, 1_400_000);
    this.frames = [];
    this.events = [];
    this._sizes = [];
    this._bytes = 0;
    this._ticks = 0;
    this._lastEventId = 0;
    this._fired = new Set();
  }

  get size() { return this.frames.length; }
  get bytes() { return this._bytes; }

  /** 每 tick 调一次：先吃掉新事件，再按 sampleEvery 决定是否落一帧。 */
  sample(match) {
    if (!match || !Array.isArray(match.players)) return this.frames[this.frames.length - 1] || null;
    this._ticks++;
    this._harvest(match);
    if (this._ticks % this.sampleEvery !== 0) return this.frames[this.frames.length - 1] || null;
    const p = [];
    for (const pl of match.players) {
      if (!pl || pl.id == null) continue;
      p.push([pl.id, r1(pl.x), r1(pl.z), r2(pl.angle), Math.round(pl.hp || 0), flagsOf(pl, this._fired.has(pl.id))]);
    }
    this._fired.clear();
    const frame = { t: r2(match.time), p };
    const size = 16 + p.length * 24;
    this.frames.push(frame);
    this._sizes.push(size);
    this._bytes += size;
    this._trim();
    return frame;
  }

  _harvest(match) {
    const list = match.events;
    if (!Array.isArray(list) || !list.length) return;
    const fresh = [];
    for (const ev of list) if (ev && ev.id > this._lastEventId) fresh.push(ev);
    if (!fresh.length) return;
    for (const ev of fresh) {
      if (ev.id > this._lastEventId) this._lastEventId = ev.id;
      if (ev.type === 'shot' && ev.player != null) this._fired.add(ev.player);
      this.recordEvent(ev);
    }
  }

  recordEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const type = String(ev.type || '');
    if (!EVENT_KINDS.has(type)) return null;
    const out = { t: r2(ev.time), type };
    if (ev.player != null) out.p = ev.player;
    if (ev.by != null) out.by = ev.by;
    if (ev.x != null) out.x = r1(ev.x);
    if (ev.z != null) out.z = r1(ev.z);
    if (ev.tx != null) out.tx = r1(ev.tx);
    if (ev.tz != null) out.tz = r1(ev.tz);
    if (ev.weapon) out.w = ev.weapon;
    if (ev.reason) out.r = ev.reason;
    if (ev.name) out.n = String(ev.name).slice(0, 20);
    if (ev.hit === true) out.hit = 1;
    this.events.push(out);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return out;
  }

  _trim() {
    while (this.frames.length > this.maxFrames && this.frames.length > 1) {
      this.frames.shift();
      this._bytes -= this._sizes.shift();
    }
    while (this._bytes > this.maxBytes && this.frames.length > 1) {
      this.frames.shift();
      this._bytes -= this._sizes.shift();
    }
    if (this._bytes < 0) this._bytes = 0;
  }

  _window(from, to) {
    const frames = this.frames.filter((f) => f.t >= from && f.t <= to);
    const last = this.frames[this.frames.length - 1];
    const events = this.events.filter((e) => e.t >= from && e.t <= to);
    return { frames: frames.length ? frames : last ? [last] : [], events, tickRate: this.tickRate };
  }

  lastSeconds(seconds = 5) {
    const sec = positive(seconds, 5);
    const last = this.frames[this.frames.length - 1];
    if (!last) return { frames: [], events: [], tickRate: this.tickRate };
    const w = this._window(last.t - sec, last.t + 0.001);
    return { frames: w.frames, events: w.events, tickRate: this.tickRate };
  }

  aroundDeath(victimId, killerId = null, seconds = 4.5) {
    const sec = positive(seconds, 4.5);
    let death = null;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === 'kill' && e.p === victimId) { death = e; break; }
    }
    if (!death) {
      const w = this.lastSeconds(sec);
      return { ...w, victimId, killerId: killerId ?? null };
    }
    const w = this._window(death.t - sec, death.t + 0.75);
    return { frames: w.frames, events: w.events, victimId, killerId: killerId ?? death.by ?? null, tickRate: this.tickRate };
  }

  clear() {
    this.frames.length = 0;
    this.events.length = 0;
    this._sizes.length = 0;
    this._bytes = 0;
    this._ticks = 0;
    this._lastEventId = 0;
    this._fired.clear();
  }
}
