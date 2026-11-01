// 雾岛突围 / MIST ISLE 1.0 — 3D 空间化与声道池（owner: audio · client/audio-spatial.js）
//
// 只做三件事，全部与具体音色无关：
//   1) 距离 → 低通截止频率（远枪声发闷），距离/方向 → PannerNode（HRTF 或 equalpower）；
//   2) 听者（玩家）位置：最多每 100ms 写一次 listener，绝不每帧 setValueAtTime；
//   3) 声道池：同时活跃 ≤ 24，超限时按「优先级最低 → 距离最远」抢占并让被抢者 20ms 淡出。
//
// 本文件不触碰 window / AudioContext，ctx 完全由 audio.js 注入，因此可以在
// scripts/audio-check.mjs 的 mock AudioContext 下逐节点断言。

export const SPATIAL = {
  refDistance: 6,
  maxDistance: 90,
  rolloffFactor: 1.4,
  nearCutoff: 18000,  // ≤ curveStart 米：全频
  farCutoff: 1200,    // ≥ maxDistance：闷
  curveStart: 25,     // 25m 起高频开始衰减
  listenerMs: 100,    // 听者位置最小更新间隔
  panningModel: 'equalpower',
};

const clamp = (n, a, b) => (n < a ? a : n > b ? b : n);
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** 距离 → 低通截止频率：25m 内 18k 全开，25→90m 对数下降到 1.2k。 */
export function cutoffAt(dist) {
  const d = clamp(Number.isFinite(Number(dist)) ? Number(dist) : 0, 0, SPATIAL.maxDistance);
  if (d <= SPATIAL.curveStart) return SPATIAL.nearCutoff;
  const t = (d - SPATIAL.curveStart) / (SPATIAL.maxDistance - SPATIAL.curveStart);
  const hi = Math.log(SPATIAL.nearCutoff);
  const lo = Math.log(SPATIAL.farCutoff);
  return Math.round(Math.exp(hi + (lo - hi) * clamp(t, 0, 1)));
}

/** inverse 距离模型的 JS 近似（只用于没有 PannerNode 的兜底音源）。 */
export function gainAt(dist) {
  const d = Math.max(SPATIAL.refDistance, Number.isFinite(Number(dist)) ? Number(dist) : 0);
  return clamp(SPATIAL.refDistance / (SPATIAL.refDistance + SPATIAL.rolloffFactor * (d - SPATIAL.refDistance)), 0, 1);
}

/** HRTF 在手机上太贵：触屏/低核数设备退到 equalpower + 距离衰减。 */
export function pickPanningModel(force) {
  if (force === 'HRTF' || force === 'equalpower') return force;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = (nav && nav.userAgent) || '';
  const cores = nav && nav.hardwareConcurrency ? nav.hardwareConcurrency : 8;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  return mobile || cores <= 4 ? 'equalpower' : 'HRTF';
}

/** 写入 PannerNode 坐标：优先 AudioParam（Chrome/Safari 新接口），否则 setPosition。 */
export function setPos(panner, x, z, y = 1, when = 0) {
  if (!panner) return;
  const px = Number.isFinite(Number(x)) ? Number(x) : 0;
  const pz = Number.isFinite(Number(z)) ? Number(z) : 0;
  const py = Number.isFinite(Number(y)) ? Number(y) : 1;
  try {
    if (panner.positionX && typeof panner.positionX.setValueAtTime === 'function') {
      const t = Math.max(0, Number(when) || 0);
      panner.positionX.setValueAtTime(px, t);
      panner.positionY.setValueAtTime(py, t);
      panner.positionZ.setValueAtTime(pz, t);
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(px, py, pz);
    }
  } catch { /* 老浏览器只读参数，静默 */ }
}

/** 建一个 inverse 衰减的 PannerNode；无 createPanner 时返回 null（退化为立体声声像）。 */
export function createPanner(ctx, { x = 0, z = 0, y = 1, model = null, now = 0 } = {}) {
  if (!ctx || typeof ctx.createPanner !== 'function') return null;
  const panner = ctx.createPanner();
  try {
    panner.panningModel = model || SPATIAL.panningModel;
    panner.distanceModel = 'inverse';
    panner.refDistance = SPATIAL.refDistance;
    panner.maxDistance = SPATIAL.maxDistance;
    panner.rolloffFactor = SPATIAL.rolloffFactor;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 1;
  } catch { /* 属性缺失时保持默认 */ }
  setPos(panner, x, z, y, now);
  return panner;
}

/** 声道池：时长 + 优先级 + 距离，满 24 时抢占最差的那个。 */
export class VoicePool {
  constructor(max = 24) {
    this.max = Math.max(1, max | 0);
    this.items = [];
    this.seq = 0;
    this.steals = 0;
    this.dropped = 0;
  }

  get size() { return this.items.length; }

  /** 池占用率 0–1：持续扫射时用来给新枪声动态压音量（避免 24 声道糊成一堵墙）。 */
  get pressure() { return this.items.length / this.max; }

  /** 清掉已经播完的声道。 */
  prune(now) {
    if (!this.items.length) return;
    const t = Number(now) || 0;
    this.items = this.items.filter((v) => v.end > t);
  }

  /** 申请一个声道：返回 token，或 null（满了且新声音更不重要）。 */
  reserve({ dur = 0.3, prio = 1, dist = 0, kill = null, now = 0 } = {}) {
    const t = Number(now) || 0;
    this.prune(t);
    const item = { id: ++this.seq, end: t + Math.max(0.02, Number(dur) || 0.3), prio: Number(prio) || 1, dist: Math.max(0, Number(dist) || 0), kill };
    if (this.items.length < this.max) {
      this.items.push(item);
      return item;
    }
    // 找最差：优先级最低，同级取距离最远
    let worst = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i];
      const b = this.items[worst];
      if (a.prio < b.prio || (a.prio === b.prio && a.dist > b.dist)) worst = i;
    }
    const victim = this.items[worst];
    // 新声音并不比被抢者更重要 → 直接丢弃（避免远处的枪声挤掉近处的击杀提示）
    if (!victim || victim.prio > item.prio || (victim.prio === item.prio && victim.dist <= item.dist)) {
      this.dropped++;
      return null;
    }
    this.items.splice(worst, 1);
    try { if (typeof victim.kill === 'function') victim.kill(); } catch { /* 抢占失败也要继续 */ }
    this.steals++;
    this.items.push(item);
    return item;
  }

  release(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
  }

  clear() {
    for (const v of this.items) { try { if (typeof v.kill === 'function') v.kill(); } catch { /* 忽略 */ } }
    this.items.length = 0;
  }
}

/** 听者（玩家）+ 单声源空间链。 */
export class SpatialRig {
  constructor(ctx, opts = {}) {
    this.ctx = ctx || null;
    this.listener = (ctx && ctx.listener) || null;
    this.model = pickPanningModel(opts.model);
    this.lastAt = 0;
    this.last = { x: NaN, z: NaN, angle: NaN };
    this.updates = 0;
    this.created = 0;
  }

  setModel(model) {
    this.model = pickPanningModel(model);
    return this.model;
  }

  /** 听者 = 玩家：最多每 100ms 写一次，返回是否真的写了。 */
  setListener(x, z, angle = 0, force = false) {
    const t = nowMs();
    const px = Number.isFinite(Number(x)) ? Number(x) : 0;
    const pz = Number.isFinite(Number(z)) ? Number(z) : 0;
    const pa = Number.isFinite(Number(angle)) ? Number(angle) : 0;
    if (!force) {
      if (t - this.lastAt < SPATIAL.listenerMs) return false;
      if (px === this.last.x && pz === this.last.z && pa === this.last.angle) { this.lastAt = t; return false; }
    }
    this.lastAt = t;
    this.last = { x: px, z: pz, angle: pa };
    const L = this.listener;
    if (!L || !this.ctx) return false;
    const fx = Math.sin(pa);
    const fz = Math.cos(pa);
    // 玩家水平朝向；up=(0,1,0)，俯视相机下等价于「屏幕上方」
    try {
      if (L.positionX && typeof L.positionX.setValueAtTime === 'function' && L.forwardX) {
        L.positionX.setValueAtTime(px, this.ctx.currentTime);
        L.positionY.setValueAtTime(1.6, this.ctx.currentTime);
        L.positionZ.setValueAtTime(pz, this.ctx.currentTime);
        L.forwardX.setValueAtTime(fx, this.ctx.currentTime);
        L.forwardY.setValueAtTime(0, this.ctx.currentTime);
        L.forwardZ.setValueAtTime(fz, this.ctx.currentTime);
        if (L.upY) { L.upX.setValueAtTime(0, this.ctx.currentTime); L.upY.setValueAtTime(1, this.ctx.currentTime); L.upZ.setValueAtTime(0, this.ctx.currentTime); }
      } else if (typeof L.setPosition === 'function') {
        L.setPosition(px, 1.6, pz);
        if (typeof L.setOrientation === 'function') L.setOrientation(fx, 0, fz, 0, 1, 0);
      }
    } catch { /* 老实现只读 → 退化为无方向 */ }
    this.updates++;
    return true;
  }

  /** 单声源链：输入增益 → 低通(距离) → Panner。返回 { input, out, filter, panner, nodes, dispose }。 */
  chain({ x = 0, z = 0, y = 1, dist = 0, model = null } = {}) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = 1;
    let node = input;
    let filter = null;
    const cutoff = cutoffAt(dist);
    if (typeof ctx.createBiquadFilter === 'function') {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      try { filter.frequency.setValueAtTime(cutoff, ctx.currentTime); } catch { filter.frequency.value = cutoff; }
      filter.Q.value = 0.7;
      node.connect(filter);
      node = filter;
    }
    const panner = createPanner(ctx, { x, z, y, model: model || this.model, now: ctx.currentTime });
    if (panner) {
      node.connect(panner);
      node = panner;
    }
    const nodes = [input, filter, panner].filter(Boolean);
    this.created++;
    const chain = {
      input, filter, panner, nodes,
      out: node,
      /** 移动音源（载具）：同步更新声像位置与低通。 */
      setPosition(nx, nz, ndist, when = ctx.currentTime) {
        setPos(panner, nx, nz, y, when);
        if (filter) { try { filter.frequency.setTargetAtTime(cutoffAt(ndist), when, 0.08); } catch { /* 忽略 */ } }
      },
      dispose() {
        for (const n of nodes) { try { n.disconnect(); } catch { /* 已断开 */ } }
      },
    };
    return chain;
  }
}
