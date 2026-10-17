// 雾岛突围 / MIST ISLE — 程序化音频引擎
// 纯 WebAudio 合成：枪声/爆炸/UI/环境/音乐全部运行时生成，不依赖任何外部音频文件。
// 设计约束：import 本模块在任何环境都安全（构造阶段不触碰 window）；
// 无 AudioContext、未解锁或 ctx 非 running 时全部静默 no-op，绝不抛错打断游戏。

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const tick = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// 枪声配方：按武器类别区分音色（噪声带通中心、低频腔体、冲击、尾音、高频嘶声）
const SHOT = {
  pistol: { dur: 0.13, freq: 1650, q: 1.1, body: 205, bodyEnd: 62, punch: 0.5, tail: 0.1, peak: 0.5, hp: 320 },
  smg: { dur: 0.1, freq: 2350, q: 0.9, body: 245, bodyEnd: 95, punch: 0.42, tail: 0.08, peak: 0.4, hp: 420 },
  rifle: { dur: 0.17, freq: 1780, q: 1.05, body: 152, bodyEnd: 58, punch: 0.62, tail: 0.24, peak: 0.56, hp: 300 },
  shotgun: { dur: 0.3, freq: 920, q: 0.6, body: 94, bodyEnd: 40, punch: 0.9, tail: 0.32, peak: 0.72, hp: 150 },
  marksman: { dur: 0.22, freq: 1380, q: 1.2, body: 122, bodyEnd: 50, punch: 0.66, tail: 0.4, peak: 0.58, hp: 260 },
  sniper: { dur: 0.34, freq: 1080, q: 1.5, body: 96, bodyEnd: 36, punch: 0.82, tail: 0.58, peak: 0.68, hp: 220 },
  lmg: { dur: 0.16, freq: 1280, q: 0.8, body: 108, bodyEnd: 46, punch: 0.7, tail: 0.26, peak: 0.58, hp: 250 },
  special: { dur: 0.21, freq: 2750, q: 2.6, body: 330, bodyEnd: 140, punch: 0.38, tail: 0.28, peak: 0.44, hp: 720 },
};
const SHOT_CLASS = {
  pistol: 'pistol', p9: 'pistol', revolver: 'pistol', smg: 'smg', v9: 'smg', rifle: 'rifle', ar: 'rifle',
  shotgun: 'shotgun', marksman: 'marksman', dmr: 'marksman', sniper: 'sniper', lmg: 'lmg',
  special: 'special', bow: 'special', launcher: 'special', thrower: 'special',
};

// 常见别名 → 标准音名
const ALIAS = {
  shot: 'shot:rifle', click: 'ui_click', hover: 'ui_hover', error: 'ui_error', ui: 'ui_click',
  hit_marker: 'hit', head: 'headshot', knocked: 'down', eliminated: 'kill',
  throw: 'throwable', grenade: 'explosion', vehicle_explode: 'vehicle_destroy', car: 'vehicle',
  wave: 'wave_start', win: 'victory', lose: 'defeat', storm_alert: 'storm', step: 'footstep',
};

// 程序化音乐：每个模式一组和弦进行（相对根音的半音偏移），bar = 每小节秒数
const PROGRESSIONS = {
  home: { root: 110, bar: 4.2, pad: 0.13, pulse: 0.08, verb: 0.35, bars: [[0, 7, 12, 15], [-2, 5, 10, 14], [3, 10, 15, 19], [-4, 3, 8, 12]] },
  battle: { root: 98, bar: 2.6, pad: 0.17, pulse: 0.24, verb: 0.22, bars: [[0, 7, 10, 12], [0, 7, 10, 15], [-2, 5, 8, 12], [3, 10, 13, 15]] },
  tense: { root: 92, bar: 3.0, pad: 0.16, pulse: 0.3, verb: 0.3, bars: [[0, 6, 7, 12], [0, 6, 11, 12], [-1, 5, 6, 11], [0, 6, 7, 14]] },
  result: { root: 130, bar: 3.6, pad: 0.13, pulse: 0.05, verb: 0.45, bars: [[0, 5, 9, 12], [0, 4, 7, 12], [-3, 4, 9, 12], [0, 5, 9, 16]] },
  horde: { root: 82, bar: 1.8, pad: 0.15, pulse: 0.38, verb: 0.18, bars: [[0, 3, 7, 10], [0, 3, 6, 10], [0, 2, 7, 10], [0, 3, 7, 12]] },
};

// 环境循环噪声：低通/高通/带通中心 + LFO 摆动
const AMBIENCE = {
  clear: { low: 360, high: 55, band: 900, q: 0.7, gain: 0.07, lfo: 0.07, depth: 90 },
  rain: { low: 5200, high: 850, band: 3200, q: 0.5, gain: 0.16, lfo: 0.5, depth: 700 },
  fog: { low: 280, high: 40, band: 520, q: 0.9, gain: 0.1, lfo: 0.05, depth: 60 },
  sandstorm: { low: 1500, high: 220, band: 1200, q: 0.6, gain: 0.2, lfo: 0.85, depth: 600 },
  snow: { low: 1900, high: 480, band: 2400, q: 0.4, gain: 0.09, lfo: 0.2, depth: 300 },
  off: { low: 300, high: 40, band: 800, q: 0.7, gain: 0, lfo: 0.05, depth: 0 },
};

export class GameAudio {
  constructor() {
    this.app = null;
    this.ctx = null;
    this.master = null;
    this.comp = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.ambBus = null;
    this.reverb = null;
    this.reverbSend = null;
    this.noiseBuffer = null;
    this.irBuffer = null;
    this.volume = { master: 0.9, sfx: 0.9, music: 0.55, ambience: 0.65 };
    this.muted = false;
    this.enabled = true; // 兼容旧 main.js 的 audio.enabled = settings.sound
    this.ready = false;
    this.unlocked = false;
    this.voices = 0;
    this.maxVoices = 24;
    this.lastAt = new Map();
    this.voiceEnds = [];
    this.tension = 0;
    this.musicMode = 'off';
    this.musicTrack = null;
    this.ambKind = null;
    this.ambIntensity = 0;
    this.ambNodes = null;
    this.gestureBound = false;
    this._onGesture = null;
    this._gestureOpts = null;
  }

  // ---- 生命周期 ---------------------------------------------------------

  init(app) {
    this.app = app || this.app;
    const settings = this.app && this.app.settings;
    if (settings) {
      this.enabled = settings.sound !== false;
      if (settings.sound === false) this.muted = true;
      const sfx = Number(settings.sfx);
      const music = Number(settings.music);
      this.setVolume({ sfx: Number.isFinite(sfx) ? sfx : undefined, music: Number.isFinite(music) ? music : undefined });
    }
    this._bindGesture();
    return this;
  }

  _bindGesture() {
    if (this.gestureBound || typeof window === 'undefined' || !window.addEventListener) return;
    this.gestureBound = true;
    this._gestureOpts = { passive: true };
    this._onGesture = () => {
      this.unlock();
      if (this.ready) this._removeGesture();
    };
    for (const type of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(type, this._onGesture, this._gestureOpts);
  }

  _removeGesture() {
    if (!this._onGesture || typeof window === 'undefined') return;
    for (const type of ['pointerdown', 'touchstart', 'keydown']) window.removeEventListener(type, this._onGesture, this._gestureOpts);
    this._onGesture = null;
  }

  unlock() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) this._boot();
      if (!this.ctx) return false;
      if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume().catch(() => {});
      this.unlocked = true;
      return true;
    } catch (err) {
      return false;
    }
  }

  _boot() {
    if (typeof window === 'undefined') return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume.master;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.volume.sfx;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.volume.music;
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = this.volume.ambience;
    for (const bus of [this.sfxBus, this.musicBus, this.ambBus]) bus.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);
    this.noiseBuffer = this._makeNoise(ctx, 2.5);
    this.irBuffer = this._makeImpulse(ctx, 1.1);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.irBuffer;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.4;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.comp);
    this.ready = true;
  }

  suspend() {
    if (!this.ctx) return;
    try {
      this._stopMusic(0.25);
      if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
    } catch (err) { /* 静音失败不打断游戏 */ }
  }

  resume() {
    if (!this.ctx) return;
    try {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    } catch (err) { /* 忽略 */ }
  }

  // ---- 混音 -------------------------------------------------------------

  setVolume(next = {}) {
    const v = this.volume;
    for (const key of ['master', 'sfx', 'music', 'ambience']) {
      const n = Number(next && next[key]);
      if (Number.isFinite(n)) v[key] = clamp(n, 0, 1.5);
    }
    if (this.ready) {
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.muted ? 0 : v.master, t, 0.05);
      this.sfxBus.gain.setTargetAtTime(v.sfx, t, 0.05);
      this.musicBus.gain.setTargetAtTime(v.music, t, 0.08);
      this.ambBus.gain.setTargetAtTime(v.ambience, t, 0.1);
    }
    return { ...v };
  }

  mute(on) {
    this.muted = typeof on === 'boolean' ? on : !this.muted;
    if (!this.muted) this.enabled = true;
    if (this.ready) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume.master, t, 0.04);
    }
    return this.muted;
  }

  // ---- 公共播放入口 -----------------------------------------------------

  // play('shot:rifle', { vol, pan, dist, pitch }) / play('shot', { weapon:'shotgun' }) / play('shot', 'shotgun')
  play(name, opts = {}) {
    if (!this.ready || !this.enabled) return false;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return false;
    if (typeof opts === 'string') opts = { weapon: opts };
    let key = typeof name === 'string' ? name : '';
    if (key === 'shot') key = `shot:${SHOT_CLASS[opts.weapon] || 'rifle'}`;
    if (key === 'end') key = opts.win === false ? 'defeat' : 'victory';
    key = ALIAS[key] || key;
    const group = key.startsWith('shot:') ? 'shot' : key;
    const throttle = group === 'shot' ? 70 : group.startsWith('ui_') ? 60 : group === 'footstep' ? 110 : 0;
    if (throttle && !this._allow(group, throttle)) return false;

    const dist = clamp(Number(opts.dist) || 0, 0, 140);
    const vol = clamp(Number.isFinite(Number(opts.vol)) ? Number(opts.vol) : 1, 0, 3);
    const pan = clamp(Number(opts.pan) || 0, -1, 1);
    const pitch = clamp(Number(opts.pitch) || 1, 0.5, 2);
    const far = clamp(dist / 75, 0, 1);
    const near = 1 - far * 0.82;

    if (key.startsWith('shot:')) return this._shot(key.slice(5), { vol: vol * near, pan, far, pitch, dist });
    const handler = this[`_sfx_${key}`];
    if (typeof handler === 'function') return handler.call(this, { vol: vol * near, pan, far, pitch, dist });
    return this._sfx_generic(key, { vol: vol * near, pan, far, pitch });
  }

  _shot(cls, o) {
    const cfg = SHOT[cls] || SHOT.rifle;
    const dur = cfg.dur * (o.far > 0.5 ? 1.5 : 1);
    if (!this._reserve(dur + cfg.tail)) return false;
    const cutoff = cfg.freq * (1 - o.far * 0.55) * o.pitch;
    const base = o.vol * cfg.peak;
    // 1) 主噪声脉冲：带通（远处进一步低通）
    this._burst({ dur, type: 'bandpass', freq: cutoff, q: cfg.q, peak: base, pan: o.pan, rate: 1.1 * o.pitch, verb: 0.1 + o.far * 0.5 });
    // 2) 高频嘶声（枪口爆音），远处衰减明显
    this._burst({ dur: dur * 0.55, type: 'highpass', freq: cfg.hp * (1 - o.far * 0.7), q: 0.6, peak: base * 0.42 * (1 - o.far * 0.8), pan: o.pan, rate: 1.4 });
    // 3) 低频冲击腔
    this._tone({ dur: dur * 0.9, type: 'triangle', from: cfg.body * o.pitch, to: cfg.bodyEnd, peak: base * cfg.punch, pan: o.pan });
    // 4) 尾音：远处是混响尾巴，近处是短扩散
    this._burst({ when: dur * 0.5, dur: cfg.tail + o.far * 0.7, type: 'lowpass', freq: 900 - o.far * 500, q: 0.7, peak: base * (o.far > 0.35 ? 0.3 : 0.14) * (1 - o.far * 0.4), pan: o.pan, verb: 0.15 + o.far * 0.55 });
    return true;
  }

  // --- 战斗反馈 ---
  _sfx_hit(o) {
    this._tone({ dur: 0.07, type: 'square', from: 1180, to: 900, peak: 0.12 * o.vol, pan: o.pan });
    this._tone({ when: 0.02, dur: 0.1, type: 'sine', from: 2100, to: 1500, peak: 0.09 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_headshot(o) {
    this._tone({ dur: 0.09, type: 'square', from: 1580, to: 1180, peak: 0.15 * o.vol, pan: o.pan });
    this._tone({ when: 0.05, dur: 0.16, type: 'triangle', from: 2400, to: 1750, peak: 0.12 * o.vol, pan: o.pan, verb: 0.2 });
    return true;
  }

  _sfx_down(o) {
    this._tone({ dur: 0.34, type: 'sawtooth', from: 240, to: 70, peak: 0.14 * o.vol, pan: o.pan, verb: 0.25 });
    this._burst({ dur: 0.25, type: 'lowpass', freq: 700, q: 0.7, peak: 0.1 * o.vol, pan: o.pan, verb: 0.25 });
    return true;
  }

  _sfx_kill(o) {
    this._tone({ dur: 0.1, type: 'triangle', from: 880, to: 1320, peak: 0.13 * o.vol, pan: o.pan });
    this._tone({ when: 0.08, dur: 0.2, type: 'sine', from: 1760, to: 1320, peak: 0.11 * o.vol, pan: o.pan, verb: 0.3 });
    return true;
  }

  _sfx_revive(o) {
    [0, 0.09, 0.18].forEach((when, i) => this._tone({ when, dur: 0.22, type: 'sine', from: 420 + i * 140, to: 620 + i * 160, peak: 0.1 * o.vol, pan: o.pan, verb: 0.3 }));
    return true;
  }

  _sfx_heal(o) {
    this._tone({ dur: 0.34, type: 'sine', from: 320, to: 560, peak: 0.1 * o.vol, pan: o.pan, verb: 0.3 });
    this._burst({ dur: 0.4, type: 'bandpass', freq: 1600, q: 2.2, peak: 0.05 * o.vol, pan: o.pan, verb: 0.35 });
    return true;
  }

  _sfx_pickup(o) {
    this._tone({ dur: 0.08, type: 'triangle', from: 720, to: 1080, peak: 0.12 * o.vol, pan: o.pan });
    this._tone({ when: 0.07, dur: 0.12, type: 'sine', from: 1240, to: 1560, peak: 0.1 * o.vol, pan: o.pan, verb: 0.2 });
    return true;
  }

  _sfx_empty(o) {
    this._burst({ dur: 0.05, type: 'highpass', freq: 2600, q: 0.8, peak: 0.16 * o.vol, pan: o.pan });
    this._tone({ dur: 0.05, type: 'square', from: 320, to: 220, peak: 0.06 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_reload(o) {
    // 机械咔哒：退弹匣 → 插入 → 拉栓
    const steps = [
      { when: 0, dur: 0.05, type: 'highpass', freq: 2200, peak: 0.16 },
      { when: 0.13, dur: 0.04, type: 'highpass', freq: 3200, peak: 0.13 },
      { when: 0.3, dur: 0.045, type: 'bandpass', freq: 1500, q: 1.6, peak: 0.15 },
      { when: 0.46, dur: 0.06, type: 'highpass', freq: 1800, peak: 0.18 },
    ];
    for (const step of steps) this._burst({ ...step, peak: step.peak * o.vol, pan: o.pan });
    this._tone({ when: 0.46, dur: 0.09, type: 'square', from: 190, to: 120, peak: 0.08 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_throw(o) {
    this._burst({ dur: 0.18, type: 'bandpass', freq: 900, q: 1.2, peak: 0.12 * o.vol, pan: o.pan, rate: 0.8 });
    return true;
  }

  _sfx_explosion(o) {
    // 三层：低频轰鸣 + 噪声爆 + 碎片
    this._reserve(0.9);
    this._tone({ dur: 0.75, type: 'sine', from: 120 * o.pitch, to: 32, peak: 0.5 * o.vol, pan: o.pan, verb: 0.5 });
    this._burst({ dur: 0.5, type: 'lowpass', freq: 1200 - o.far * 700, q: 0.8, peak: 0.5 * o.vol, pan: o.pan, verb: 0.55 });
    this._burst({ dur: 0.22, type: 'bandpass', freq: 2600, q: 0.6, peak: 0.24 * o.vol * (1 - o.far * 0.5), pan: o.pan });
    for (let i = 0; i < 4; i++) this._burst({ when: 0.12 + i * 0.07, dur: 0.12, type: 'highpass', freq: 3200 + i * 700, q: 1, peak: 0.05 * o.vol, pan: clamp(o.pan + (i - 1.5) * 0.18, -1, 1), rate: 1.2 });
    return true;
  }

  _sfx_smoke(o) {
    this._burst({ dur: 1.1, type: 'lowpass', freq: 1400, q: 0.5, peak: 0.16 * o.vol, pan: o.pan, rate: 0.55, verb: 0.3 });
    return true;
  }

  _sfx_fire(o) {
    this._burst({ dur: 1.2, type: 'bandpass', freq: 420, q: 0.7, peak: 0.13 * o.vol, pan: o.pan, rate: 0.6, verb: 0.25 });
    this._tone({ dur: 0.9, type: 'sawtooth', from: 90, to: 60, peak: 0.05 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_flash(o) {
    this._burst({ dur: 0.35, type: 'highpass', freq: 3800, q: 0.5, peak: 0.2 * o.vol, pan: o.pan, verb: 0.4 });
    this._tone({ dur: 0.5, type: 'sine', from: 3200, to: 4600, peak: 0.05 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_vehicle(o) {
    this._tone({ dur: 0.5, type: 'sawtooth', from: 70, to: 110, peak: 0.1 * o.vol, pan: o.pan });
    this._burst({ dur: 0.5, type: 'lowpass', freq: 600, q: 1, peak: 0.08 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_vehicle_start(o) { return this._sfx_vehicle(o); }

  _sfx_vehicle_destroy(o) {
    this._tone({ dur: 0.8, type: 'sawtooth', from: 160, to: 40, peak: 0.24 * o.vol, pan: o.pan, verb: 0.4 });
    this._burst({ dur: 0.7, type: 'lowpass', freq: 1600, q: 0.7, peak: 0.26 * o.vol, pan: o.pan, verb: 0.4 });
    for (let i = 0; i < 3; i++) this._burst({ when: 0.1 + i * 0.1, dur: 0.14, type: 'highpass', freq: 3000, q: 1, peak: 0.06 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_ui_click(o) {
    this._tone({ dur: 0.045, type: 'triangle', from: 880, to: 1180, peak: 0.09 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_ui_hover(o) {
    this._tone({ dur: 0.03, type: 'sine', from: 1400, to: 1500, peak: 0.04 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_ui_error(o) {
    this._tone({ dur: 0.07, type: 'square', from: 300, to: 220, peak: 0.08 * o.vol, pan: o.pan });
    this._tone({ when: 0.09, dur: 0.08, type: 'square', from: 240, to: 180, peak: 0.08 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_levelup(o) {
    [0, 0.1, 0.2, 0.32].forEach((when, i) => this._tone({ when, dur: 0.4, type: 'triangle', from: 523 * Math.pow(2, i / 4), to: 523 * Math.pow(2, i / 4) * 1.5, peak: 0.1 * o.vol, pan: o.pan, verb: 0.4 }));
    return true;
  }

  _sfx_wave_start(o) {
    this._tone({ dur: 0.6, type: 'sawtooth', from: 110, to: 220, peak: 0.14 * o.vol, pan: o.pan, verb: 0.4 });
    this._burst({ dur: 0.6, type: 'lowpass', freq: 800, q: 0.8, peak: 0.12 * o.vol, pan: o.pan, verb: 0.35 });
    return true;
  }

  _sfx_wave_clear(o) {
    [0, 0.12, 0.24].forEach((when, i) => this._tone({ when, dur: 0.45, type: 'sine', from: 660 + i * 220, to: 880 + i * 220, peak: 0.09 * o.vol, pan: o.pan, verb: 0.45 }));
    return true;
  }

  _sfx_boss(o) {
    this._tone({ dur: 1.4, type: 'sawtooth', from: 55, to: 42, peak: 0.26 * o.vol, pan: o.pan, verb: 0.5 });
    this._tone({ when: 0.1, dur: 1.1, type: 'square', from: 82, to: 62, peak: 0.1 * o.vol, pan: o.pan, verb: 0.5 });
    this._burst({ dur: 1.2, type: 'lowpass', freq: 500, q: 1.2, peak: 0.16 * o.vol, pan: o.pan, verb: 0.4 });
    return true;
  }

  _sfx_victory(o) {
    [0, 0.16, 0.32, 0.48].forEach((when, i) => this._tone({ when, dur: 0.7, type: 'triangle', from: [392, 523, 659, 784][i], to: [523, 659, 784, 1046][i], peak: 0.12 * o.vol, pan: o.pan, verb: 0.5 }));
    return true;
  }

  _sfx_defeat(o) {
    [0, 0.2, 0.4].forEach((when, i) => this._tone({ when, dur: 0.9, type: 'triangle', from: [330, 262, 196][i], to: [262, 196, 147][i], peak: 0.11 * o.vol, pan: o.pan, verb: 0.5 }));
    return true;
  }

  _sfx_storm(o) {
    this._burst({ dur: 1.6, type: 'bandpass', freq: 700, q: 0.5, peak: 0.14 * o.vol, pan: o.pan, rate: 0.7, verb: 0.4 });
    this._tone({ dur: 1.2, type: 'sine', from: 70, to: 50, peak: 0.08 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_footstep(o) {
    this._burst({ dur: 0.075, type: 'bandpass', freq: 460 + (o.pitch - 1) * 220, q: 1.4, peak: 0.1 * o.vol, pan: o.pan, rate: 1 });
    this._tone({ dur: 0.06, type: 'sine', from: 140, to: 90, peak: 0.05 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_sprint(o) {
    this._burst({ dur: 0.12, type: 'bandpass', freq: 620, q: 0.9, peak: 0.08 * o.vol, pan: o.pan, rate: 1.2 });
    return true;
  }

  _sfx_grenade_bounce(o) {
    this._tone({ dur: 0.06, type: 'square', from: 520, to: 300, peak: 0.07 * o.vol, pan: o.pan });
    return true;
  }

  _sfx_throwable(o) { return this._sfx_throw(o); }

  // 距离/方位便捷入口：世界坐标 → pan + dist
  playAt(name, opts = {}) {
    const x = Number(opts.x) || 0;
    const z = Number(opts.z) || 0;
    const self = opts.self || (this.app && (this.app.me || (this.app.state && this.app.state.me)));
    if (!self) return this.play(name, opts);
    const dx = x - self.x;
    const dz = z - self.z;
    const dist = Math.hypot(dx, dz);
    const angle = Math.atan2(dx, dz) - (self.angle || 0);
    return this.play(name, { ...opts, dist, pan: clamp(Math.sin(angle) * 0.85, -1, 1) });
  }

  // 受击/开火等短促反馈（由 app 调用），自带冷却避免连发刷屏
  hapticsHint() {
    return this.play('hit', { vol: 0.5 });
  }

  dispose() {
    try {
      this._stopMusic(0.2);
      this._stopAmbience(0.2);
      this._removeGesture();
      if (this.ctx && this.ctx.close) this.ctx.close().catch(() => {});
    } catch (err) { /* 忽略 */ }
    this.ready = false;
    this.ctx = null;
  }

  _sfx_generic(name, o) {
    // 未知名字：给一个中性提示音，避免静默失败也避免报错
    this._tone({ dur: 0.08, type: 'sine', from: 660, to: 880, peak: 0.05 * o.vol, pan: o.pan });
    return true;
  }

  // ---- 音乐 -------------------------------------------------------------

  setMusic(mode) {
    const next = PROGRESSIONS[mode] ? mode : 'off';
    if (next === this.musicMode) return this.musicMode;
    this.musicMode = next;
    if (!this.ready) return next;
    try {
      this._stopMusic(1.2);
      if (next !== 'off') this._startMusic(next);
    } catch (err) { /* 音乐失败不影响游戏 */ }
    return next;
  }

  setTension(value) {
    this.tension = clamp(Number(value) || 0, 0, 1);
    if (this.musicTrack) {
      const t = this.ctx.currentTime;
      const track = this.musicTrack;
      if (track.padGain) track.padGain.gain.setTargetAtTime(track.pad * (1 + this.tension * 0.35), t, 0.5);
      if (track.pulseGain) track.pulseGain.gain.setTargetAtTime(track.pulse * (0.4 + this.tension), t, 0.5);
    }
    return this.tension;
  }

  _startMusic(mode) {
    const ctx = this.ctx;
    const prog = PROGRESSIONS[mode];
    const padGain = ctx.createGain();
    padGain.gain.value = 0;
    padGain.connect(this.musicBus);
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0;
    pulseGain.connect(this.musicBus);
    const track = { mode, prog, padGain, pulseGain, pad: prog.pad, pulse: prog.pulse, timer: 0, bar: 0, voices: [], stopped: false };
    this.musicTrack = track;
    padGain.gain.setTargetAtTime(prog.pad * (1 + this.tension * 0.35), ctx.currentTime, 0.6);
    pulseGain.gain.setTargetAtTime(prog.pulse * (0.4 + this.tension), ctx.currentTime, 0.6);
    this._scheduleBar(track);
    const setTimer = typeof window !== 'undefined' && window.setInterval ? window.setInterval.bind(window) : typeof setInterval !== 'undefined' ? setInterval : null;
    track.timer = setTimer ? setTimer(() => this._scheduleBar(track), prog.bar * 1000) : 0;
  }

  _scheduleBar(track) {
    if (!this.ready || track.stopped || this.musicTrack !== track) return;
    const ctx = this.ctx;
    const chord = track.prog.bars[track.bar % track.prog.bars.length];
    track.bar++;
    const start = ctx.currentTime + 0.05;
    const dur = track.prog.bar * 0.98;
    for (const semis of chord) {
      const hz = track.prog.root * Math.pow(2, semis / 12);
      for (const [type, detune, gainMul] of [['sine', 0, 1], ['triangle', 6, 0.45], ['sine', -7, 0.4]]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = hz * Math.pow(2, detune / 1200);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.055 * gainMul), start + dur * 0.3);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = 900 + this.tension * 1400;
        osc.connect(filt); filt.connect(g); g.connect(track.padGain);
        const send = ctx.createGain();
        send.gain.value = track.prog.verb;
        g.connect(send); send.connect(this.reverbSend);
        osc.start(start); osc.stop(start + dur + 0.1);
        osc.onended = () => { try { osc.disconnect(); g.disconnect(); filt.disconnect(); send.disconnect(); } catch (err) { /* 已断开 */ } };
      }
    }
    // 低频脉冲（心跳感，随 tension 增强）
    const pulseHz = 55 + this.tension * 25;
    for (const when of [0, track.prog.bar * 0.5]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(pulseHz, start + when);
      osc.frequency.exponentialRampToValueAtTime(pulseHz * 0.6, start + when + 0.28);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start + when);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.16 * (0.35 + this.tension)), start + when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + when + 0.34);
      osc.connect(g); g.connect(track.pulseGain);
      osc.start(start + when); osc.stop(start + when + 0.4);
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (err) { /* 已断开 */ } };
    }
  }

  _stopMusic(seconds) {
    const track = this.musicTrack;
    if (!track) return;
    this.musicTrack = null;
    track.stopped = true;
    if (track.timer) clearInterval(track.timer);
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const node of [track.padGain, track.pulseGain]) {
      try {
        node.gain.cancelScheduledValues(t);
        node.gain.setTargetAtTime(0, t, Math.max(0.05, seconds / 4));
      } catch (err) { /* 忽略 */ }
    }
    setTimeout(() => {
      try { track.padGain.disconnect(); track.pulseGain.disconnect(); } catch (err) { /* 已断开 */ }
    }, (seconds + 0.6) * 1000);
  }

  // ---- 环境音 -----------------------------------------------------------

  setAmbience(kind, intensity = 0.6) {
    const next = AMBIENCE[kind] ? kind : 'clear';
    const value = clamp(Number(intensity), 0, 1);
    if (next === this.ambKind && Math.abs(value - this.ambIntensity) < 0.001) return next;
    this.ambKind = next;
    this.ambIntensity = value;
    if (!this.ready) return next;
    try {
      this._stopAmbience(0.9);
      if (next !== 'off' && value > 0.001) this._startAmbience(next, value);
    } catch (err) { /* 环境音失败不影响游戏 */ }
    return next;
  }

  _startAmbience(kind, intensity) {
    const ctx = this.ctx;
    const cfg = AMBIENCE[kind];
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = kind === 'rain' ? 1.4 : kind === 'sandstorm' ? 1.1 : 0.8;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = cfg.low;
    low.Q.value = cfg.q;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = cfg.high;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = cfg.band;
    band.Q.value = cfg.q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = cfg.lfo;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = cfg.depth;
    lfo.connect(lfoGain);
    lfoGain.connect(band.frequency);
    src.connect(high); high.connect(low); low.connect(band); band.connect(gain); gain.connect(this.ambBus);
    const send = ctx.createGain();
    send.gain.value = 0.25;
    gain.connect(send); send.connect(this.reverbSend);
    const peak = cfg.gain * intensity;
    gain.gain.setTargetAtTime(peak, ctx.currentTime, 1.2);
    src.start();
    lfo.start();
    this.ambNodes = { src, low, high, band, gain, lfo, lfoGain, send };
  }

  _stopAmbience(seconds) {
    const nodes = this.ambNodes;
    if (!nodes) return;
    this.ambNodes = null;
    try {
      const t = this.ctx.currentTime;
      nodes.gain.gain.cancelScheduledValues(t);
      nodes.gain.gain.setTargetAtTime(0, t, Math.max(0.05, seconds / 4));
    } catch (err) { /* 忽略 */ }
    setTimeout(() => {
      try {
        nodes.src.stop();
        nodes.lfo.stop();
        for (const node of [nodes.src, nodes.low, nodes.high, nodes.band, nodes.gain, nodes.lfo, nodes.lfoGain, nodes.send]) node.disconnect();
      } catch (err) { /* 已停止 */ }
    }, (seconds + 0.4) * 1000);
  }

  // ---- 内部：限流与节点链 -----------------------------------------------

  _makeNoise(ctx, seconds) {
    const rate = ctx.sampleRate || 44100;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(1, len, rate);
    const data = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = clamp(white * 0.82 + brown * 2.4, -1, 1);
    }
    return buf;
  }

  _makeImpulse(ctx, seconds) {
    const rate = ctx.sampleRate || 44100;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * 0.8;
      }
    }
    return buf;
  }

  _allow(group, ms) {
    const now = tick();
    const last = this.lastAt.get(group) || 0;
    if (now - last < ms) return false;
    this.lastAt.set(group, now);
    if (this.lastAt.size > 96) for (const [key, at] of this.lastAt) if (now - at > 4000) this.lastAt.delete(key);
    return true;
  }

  _reserve(dur) {
    const now = this.ctx.currentTime;
    this.voiceEnds = this.voiceEnds.filter((end) => end > now);
    if (this.voiceEnds.length >= this.maxVoices) return false;
    this.voiceEnds.push(now + dur + 0.05);
    this.voices = this.voiceEnds.length;
    return true;
  }

  // 建一条「噪声 → 滤波 → 包络 → (pan) → bus」的凋零链，返回起点增益以便额外连接
  _burst({ when = 0, dur = 0.2, type = 'bandpass', freq = 1200, q = 1, peak = 0.5, attack = 0.004, bus = 'sfx', pan = 0, rate = 1, verb = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(clamp(freq, 30, 18000), t);
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(filter);
    filter.connect(gain);
    let out = gain;
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      gain.connect(panner);
      out = panner;
    }
    out.connect(this._bus(bus));
    if (verb > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = verb;
      out.connect(send);
      send.connect(this.reverbSend);
    }
    src.start(t);
    src.stop(t + dur + 0.06);
    src.onended = () => { try { src.disconnect(); filter.disconnect(); gain.disconnect(); panner?.disconnect(); } catch (err) { /* 已断开 */ } };
    return { filter, gain, t, src };
  }

  // 建一条「振荡器 → 增益 → (pan) → bus」的音调链
  _tone({ when = 0, dur = 0.2, type = 'sine', from = 440, to = 440, peak = 0.2, attack = 0.005, bus = 'sfx', pan = 0, verb = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, from), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    osc.connect(gain);
    let out = gain;
    if (panner) {
      panner.pan.value = clamp(pan, -1, 1);
      gain.connect(panner);
      out = panner;
    }
    out.connect(this._bus(bus));
    if (verb > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = verb;
      out.connect(send);
      send.connect(this.reverbSend);
    }
    osc.start(t);
    osc.stop(t + dur + 0.04);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); panner?.disconnect(); } catch (err) { /* 已断开 */ } };
    return { gain, t, osc };
  }

  _bus(name) {
    if (name === 'music') return this.musicBus;
    if (name === 'ambience') return this.ambBus;
    return this.sfxBus;
  }
}
