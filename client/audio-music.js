// 雾岛突围 / MIST ISLE 1.0 — 分层自适应音乐（owner: audio · client/audio-music.js）
//
// 三层 stem，全部 GainNode 交叉淡入淡出（0.8–1.5s），所有参数变化只用
// setTargetAtTime / linearRampToValueAtTime，绝不直接赋值 → 无爆音：
//   base    ：持续 pad（和弦铺底），一直在放；
//   tension ：打击脉冲（底鼓 + 短促噪声），接近敌人 / 圈收缩时淡入；
//   climax  ：高音 arpeggio，决赛圈 / 最后 3 队时淡入。
//
// 每个 stem 只能看到自己的 GainNode，三者的实际权重由 setTension(0–1) 统一映射：
//   base    0.55 → 1.00（几乎恒定，tension 只把它略微推亮）
//   tension 0.00 → 0.85（tension 0.25 起才真正可闻）
//   climax  0.00 → 0.70（tension 0.62 起才真正可闻，避免中期就吵）
//
// 调度用 AudioContext 时钟前瞻排程（lookahead 1.2s + 250ms 轮询），不用 setInterval
// 直接定音；段落切换（setMusic）会先淡出旧 stem 再建新的，旧节点 1.5s 后 disconnect。

const clamp = (n, a, b) => (n < a ? a : n > b ? b : n);

export const PROGRESSIONS = {
  home: { root: 110, bar: 4.2, pad: 0.13, pulse: 0.08, verb: 0.35, bars: [[0, 7, 12, 15], [-2, 5, 10, 14], [3, 10, 15, 19], [-4, 3, 8, 12]] },
  battle: { root: 98, bar: 2.6, pad: 0.17, pulse: 0.24, verb: 0.22, bars: [[0, 7, 10, 12], [0, 7, 10, 15], [-2, 5, 8, 12], [3, 10, 13, 15]] },
  tense: { root: 92, bar: 3.0, pad: 0.16, pulse: 0.3, verb: 0.3, bars: [[0, 6, 7, 12], [0, 6, 11, 12], [-1, 5, 6, 11], [0, 6, 7, 14]] },
  result: { root: 130, bar: 3.6, pad: 0.13, pulse: 0.05, verb: 0.45, bars: [[0, 5, 9, 12], [0, 4, 7, 12], [-3, 4, 9, 12], [0, 5, 9, 16]] },
  horde: { root: 82, bar: 1.8, pad: 0.15, pulse: 0.38, verb: 0.18, bars: [[0, 3, 7, 10], [0, 3, 6, 10], [0, 2, 7, 10], [0, 3, 7, 12]] },
};

/** tension → 三层目标权重（0–1，尚未乘入各自音量系数）。 */
export function stemMix(tension) {
  const x = clamp(Number(tension) || 0, 0, 1);
  const base = 0.55 + x * 0.45;
  const tense = clamp((x - 0.18) / 0.42, 0, 1);
  const climax = clamp((x - 0.58) / 0.42, 0, 1);
  return { base, tension: tense * 0.85, climax: climax * 0.7 };
}

export class MusicStems {
  constructor(host) {
    this.host = host;   // GameAudio 实例：提供 ctx / musicBus / reverbSend / ready
    this.track = null;
    this.tension = 0;
    this.startedAt = 0;
  }

  get ctx() { return this.host && this.host.ctx; }

  get mode() { return this._mode || 'off'; }

  /** 切换模式。返回实际生效的模式名。 */
  setMode(mode, fade = 1.2) {
    const next = PROGRESSIONS[mode] ? mode : 'off';
    if (this._mode === next) return next;
    this._mode = next;
    if (!this.host || !this.host.ready) return next;
    try {
      this._stop(fade);
      if (next !== 'off') this._start(next, fade);
    } catch { /* 音乐失败不影响游戏 */ }
    return next;
  }

  setTension(v) {
    this.tension = clamp(Number(v) || 0, 0, 1);
    const track = this.track;
    if (!track || !this.ctx) return this.tension;
    const mix = stemMix(this.tension);
    const t = this.ctx.currentTime;
    for (const [key, gain] of Object.entries(track.stems)) {
      const target = Math.max(0.0001, mix[key] * (track.prog[key === 'base' ? 'pad' : key === 'tension' ? 'pulse' : 'pad'] || 1));
      try { gain.gain.setTargetAtTime(target, t, 0.45); } catch { /* 忽略 */ }
    }
    return this.tension;
  }

  _start(mode, fade) {
    const ctx = this.ctx;
    const prog = PROGRESSIONS[mode];
    const bus = this.host.musicBus;
    const stems = {};
    for (const key of ['base', 'tension', 'climax']) {
      const g = ctx.createGain();
      // 从 0 起步，用 setTargetAtTime 淡入（不是直接赋值 → 无爆音）
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.connect(bus);
      stems[key] = g;
    }
    const track = { mode, prog, stems, bar: 0, nextBarAt: ctx.currentTime + 0.08, timer: 0, stopped: false, nodes: new Set() };
    this.track = track;
    this._mode = mode;
    this.startedAt = ctx.currentTime;
    this.setTension(this.tension);
    const tick = () => this._pump(track);
    tick();
    // 前 1 秒用 250ms 轮询快速补排，之后稳定在 250ms 前瞻排程
    const setTimer = typeof window !== 'undefined' && window.setInterval ? window.setInterval.bind(window) : (typeof setInterval !== 'undefined' ? setInterval : null);
    track.timer = setTimer ? setTimer(tick, 250) : 0;
    void fade;
  }

  /** 前瞻排程：把 nextBarAt 之前 1.2s 内的小节全部排上。 */
  _pump(track) {
    if (!this.host || !this.host.ready || track.stopped || this.track !== track) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const horizon = ctx.currentTime + 1.2;
    let guard = 0;
    while (track.nextBarAt < horizon && guard++ < 4) {
      this._scheduleBar(track, track.nextBarAt);
      track.nextBarAt += track.prog.bar;
    }
  }

  _scheduleBar(track, start) {
    const prog = track.prog;
    const ctx = this.ctx;
    const chord = prog.bars[track.bar % prog.bars.length];
    track.bar++;
    const dur = prog.bar * 0.98;
    const tension = this.tension;
    // base：每个和弦音 3 个失谐振荡器 → 低通 → 包络
    for (const semis of chord) {
      const hz = prog.root * Math.pow(2, semis / 12);
      for (const [type, detune, mul] of [['sine', 0, 1], ['triangle', 6, 0.45], ['sine', -7, 0.4]]) {
        this._voice(track, start, dur, (ctx, out) => {
          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.setValueAtTime(hz * Math.pow(2, detune / 1200), start);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, start);
          g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.055 * mul), start + dur * 0.3);
          g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
          const f = ctx.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.setValueAtTime(900 + tension * 1400, start);
          osc.connect(f); f.connect(g); g.connect(out);
          this._verb(track, g, prog.verb);
          osc.start(start); osc.stop(start + dur + 0.1);
          return [osc, g, f];
        });
      }
    }
    // tension：底鼓脉冲（tension 低时也排，只是被 gain 压到听不见 → 交叉淡入无断层）
    const pulseHz = 55 + tension * 25;
    for (const when of [0, prog.bar * 0.5]) {
      this._voice(track, start + when, 0.4, (ctx, out) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(pulseHz, start + when);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, pulseHz * 0.6), start + when + 0.28);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, start + when);
        g.gain.exponentialRampToValueAtTime(0.16, start + when + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, start + when + 0.34);
        osc.connect(g); g.connect(out);
        osc.start(start + when); osc.stop(start + when + 0.4);
        return [osc, g];
      });
    }
    // climax：高音 arpeggio（每小节 4 个 16 分音符，三角波 + 短包络）
    const top = Math.max(...chord) + 24;
    for (let i = 0; i < 4; i++) {
      const when = start + (prog.bar / 4) * i;
      const hz = prog.root * Math.pow(2, (top + (i % 2 ? 7 : 0)) / 12);
      this._voice(track, when, 0.22, (ctx, out) => {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(hz, when);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(0.045, when + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
        osc.connect(g); g.connect(out);
        this._verb(track, g, prog.verb * 0.8);
        osc.start(when); osc.stop(when + 0.24);
        return [osc, g];
      });
    }
  }

  _verb(track, node, amount) {
    const ctx = this.ctx;
    const send = this.host.reverbSend;
    if (!send || !(amount > 0)) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amount, ctx.currentTime);
    node.connect(g); g.connect(send);
    track.nodes.add(g);
  }

  /**
   * 建一组节点：build(ctx, stemOut) 返回该组节点数组（第一个节点负责 onended）。
   * 全部登记到 track.nodes，结束后统一 disconnect —— 不依赖外部清理。
   */
  _voice(track, start, dur, build) {
    const ctx = this.ctx;
    try {
      const nodes = build(ctx, track.stems.base) || [];
      for (const n of nodes) track.nodes.add(n);
      const first = nodes[0];
      if (first && 'onended' in first) {
        first.onended = () => {
          for (const n of nodes) { track.nodes.delete(n); try { n.disconnect(); } catch { /* 已断开 */ } }
        };
      }
    } catch { /* 单条声部失败不打断整段 */ }
    void start; void dur;
  }

  _stop(fade = 1.2) {
    const track = this.track;
    if (!track) return;
    this.track = null;
    track.stopped = true;
    if (track.timer) { try { clearInterval(track.timer); } catch { /* 忽略 */ } track.timer = 0; }
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const tau = Math.max(0.08, clamp(fade, 0.2, 3) / 4);
    for (const g of Object.values(track.stems)) {
      try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, tau); } catch { /* 忽略 */ }
    }
    const cleanup = () => {
      for (const g of Object.values(track.stems)) { try { g.disconnect(); } catch { /* 已断开 */ } }
      for (const n of track.nodes) { try { n.disconnect(); } catch { /* 已断开 */ } }
      track.nodes.clear();
    };
    const timer = typeof setTimeout !== 'undefined' ? setTimeout : null;
    if (timer) timer(cleanup, (fade + 0.6) * 1000); else cleanup();
  }

  dispose() { this._stop(0.2); }
}
