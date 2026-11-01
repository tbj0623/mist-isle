// 雾岛突围 / MIST ISLE — 程序化音频引擎
// 纯 WebAudio 合成：枪声/爆炸/UI/环境/音乐全部运行时生成，不依赖任何外部音频文件。
// 设计约束：import 本模块在任何环境都安全（构造阶段不触碰 window）；
// 无 AudioContext、未解锁或 ctx 非 running 时全部静默 no-op，绝不抛错打断游戏。
//
// 1.0 空间化升级（owner: audio）：
//   client/audio-spatial.js  VoicePool（≤24 声道抢占）+ SpatialRig（HRTF/equalpower +
//                            inverse 距离衰减 + 25m→90m 低通闷化）+ 100ms 节流听者；
//   client/audio-music.js    MusicStems（base/tension/climax 三层交叉淡入，无爆音）；
//   本文件                   逐音色配方 + 总线（gun/fx/ui/music/ambience）+ play/playAt 旧签名。

import { VoicePool, SpatialRig, SPATIAL, cutoffAt, gainAt } from './audio-spatial.js';
import { MusicStems, PROGRESSIONS, stemMix } from './audio-music.js';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const tick = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * 1.1 音量感知声道池（VoicePool 的子类，覆写 reserve）。
 * 满员时按「优先级最低 → 实听音量最小 → 距离最远」挑受害者；
 * 新声音如果不比受害者更响/更重要，就直接丢弃 —— 保证团战时丢掉的永远是听不见的那些。
 */
class VolumePool extends VoicePool {
  reserve({ dur = 0.3, prio = 1, dist = 0, gain = 1, kill = null, now = 0 } = {}) {
    const t = Number(now) || 0;
    this.prune(t);
    const item = {
      id: ++this.seq,
      end: t + Math.max(0.02, Number(dur) || 0.3),
      prio: Number(prio) || 1,
      dist: Math.max(0, Number(dist) || 0),
      gain: clamp(Number.isFinite(Number(gain)) ? Number(gain) : 1, 0, 1.5),
      kill,
    };
    if (this.items.length < this.max) { this.items.push(item); return item; }
    let worst = 0;
    const worse = (a, b) => a.prio < b.prio
      || (a.prio === b.prio && (a.gain < b.gain || (a.gain === b.gain && a.dist > b.dist)));
    for (let i = 1; i < this.items.length; i++) if (worse(this.items[i], this.items[worst])) worst = i;
    const victim = this.items[worst];
    if (!victim || victim.prio > item.prio || (victim.prio === item.prio && victim.gain >= item.gain)) {
      this.dropped++;
      return null;
    }
    this.items.splice(worst, 1);
    try { if (typeof victim.kill === 'function') victim.kill(); } catch { /* 抢占失败也要继续 */ }
    this.steals++;
    this.items.push(item);
    return item;
  }
}

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
// 武器 id / 类别 → 枪声配方。
//
// 历史实现只列了 p9 / v9 两个真实 id，其余全是类别名；而事件里的 ev.weapon 是
// weapon.id，于是 18 把武器里有 16 把落到默认的 rifle —— 霰弹枪没有低频轰鸣、
// 狙击枪没有长尾、弩没有特殊音色，八套配方实际只有两三套在用。
// 这里按 shared/data/weapons.mjs 的真实 id 补全（id 与 cls 两套键都保留，
// 事件里给 id、旧调用点给类别名时都能命中）。
const SHOT_CLASS = {
  // 类别名（旧调用点兜底）
  pistol: 'pistol', smg: 'smg', rifle: 'rifle', shotgun: 'shotgun', marksman: 'marksman',
  sniper: 'sniper', lmg: 'lmg', special: 'special',
  // 真实武器 id
  p9: 'pistol', p226: 'pistol', v9: 'smg', mp5k: 'smg', vector: 'smg',
  ar7: 'rifle', ak12: 'rifle', bullpup: 'rifle',
  s12: 'shotgun', aa12: 'shotgun',
  m14: 'marksman', svd: 'marksman',
  sr338: 'sniper', awm: 'sniper',
  m60: 'lmg', pkm: 'lmg',
  crossbow: 'special', scout: 'special',
  // 旧别名
  bow: 'special', launcher: 'special', thrower: 'special', dmr: 'marksman', ar: 'rifle',
};

// 常见别名 → 标准音名
const ALIAS = {
  shot: 'shot:rifle', click: 'ui_click', hover: 'ui_hover', error: 'ui_error', ui: 'ui_click',
  hit_marker: 'hit', head: 'headshot', knocked: 'down', eliminated: 'kill',
  throw: 'throwable', grenade: 'explosion', vehicle_explode: 'vehicle_destroy', car: 'vehicle',
  wave: 'wave_start', win: 'victory', lose: 'defeat', storm_alert: 'storm', step: 'footstep',
  // 1.1 别名：旧调用点不必改
  heartbeat_low: 'heartbeat', lowhp: 'heartbeat', hp_warn: 'heartbeat',
  zone_shrink: 'zone_alarm', zone_close: 'zone_alarm', gas_alert: 'zone_alarm',
  kill_confirm_headshot: 'kill_headshot', kill_streak_confirm: 'kill_streak',
  hit_metal: 'hit_armor', hit_body: 'hit_flesh', hit_helmet: 'hit_head',
  mag_out: 'reload_out', mag_in: 'reload_in', bolt: 'reload_bolt',
  announce: 'voice_announce',
};

// 音乐和弦进行 PROGRESSIONS 已迁移到 client/audio-music.js（三层 stem 共用同一份）。
// 优先级：ui 4 > 战斗反馈 5 > 枪声 2 > 环境 1 > 循环 0（数值越大越不容易被抢占）
const PRIO = { ui: 5, feedback: 5, gun: 2, ambient: 1, loop: 0 };

// 每个音效的元信息：时长（秒，决定声道占用）、优先级、所属 bus
// bus：gun 枪械 / fx 世界音效 / ui 反馈与非定位提示 / music / ambience
const META = {
  _default: { dur: 0.45, prio: PRIO.gun, bus: 'fx' },
  shot: { dur: 0.65, prio: PRIO.gun, bus: 'gun' },
  hit: { dur: 0.12, prio: PRIO.feedback, bus: 'ui' },
  headshot: { dur: 0.26, prio: PRIO.feedback, bus: 'ui' },
  hitmarker_head: { dur: 0.26, prio: PRIO.feedback, bus: 'ui' },
  kill: { dur: 0.5, prio: PRIO.feedback, bus: 'ui' },
  hurt: { dur: 0.2, prio: PRIO.feedback, bus: 'ui' },
  down: { dur: 0.6, prio: PRIO.feedback, bus: 'ui' },
  death: { dur: 1.3, prio: PRIO.feedback, bus: 'ui' },
  revive: { dur: 0.5, prio: PRIO.feedback, bus: 'ui' },
  heal_start: { dur: 0.6, prio: PRIO.feedback, bus: 'ui' },
  heal_done: { dur: 0.5, prio: PRIO.feedback, bus: 'ui' },
  heal: { dur: 0.6, prio: PRIO.feedback, bus: 'ui' },
  pickup: { dur: 0.3, prio: PRIO.feedback, bus: 'ui' },
  equip: { dur: 0.25, prio: PRIO.feedback, bus: 'ui' },
  reload: { dur: 0.6, prio: PRIO.feedback, bus: 'ui' },
  empty: { dur: 0.15, prio: PRIO.feedback, bus: 'ui' },
  ui_click: { dur: 0.1, prio: PRIO.ui, bus: 'ui' },
  ui_hover: { dur: 0.08, prio: PRIO.ui, bus: 'ui' },
  ui_back: { dur: 0.12, prio: PRIO.ui, bus: 'ui' },
  ui_error: { dur: 0.2, prio: PRIO.ui, bus: 'ui' },
  levelup: { dur: 0.8, prio: PRIO.ui, bus: 'ui' },
  victory: { dur: 1.3, prio: PRIO.ui, bus: 'ui' },
  defeat: { dur: 1.4, prio: PRIO.ui, bus: 'ui' },
  wave_start: { dur: 0.8, prio: PRIO.ui, bus: 'ui' },
  zone_warning: { dur: 1.2, prio: PRIO.ui, bus: 'ui' },
  storm: { dur: 1.2, prio: PRIO.ui, bus: 'ui' },
  boss: { dur: 1.6, prio: PRIO.ui, bus: 'ui' },
  boss_spawn: { dur: 1.6, prio: PRIO.ui, bus: 'ui' },
  airdrop_in: { dur: 2.6, prio: PRIO.ambient, bus: 'fx' },
  airdrop_land: { dur: 1.0, prio: PRIO.fx, bus: 'fx' },
  // 空降：开伞布料爆响、落地闷响
  chute_open: { dur: 1.0, prio: PRIO.fx, bus: 'fx' },
  land: { dur: 0.4, prio: PRIO.fx, bus: 'fx' },
  explosion: { dur: 1.0, prio: PRIO.gun, bus: 'gun' },
  flash: { dur: 0.7, prio: PRIO.fx, bus: 'fx' },
  flash_bang: { dur: 0.7, prio: PRIO.fx, bus: 'fx' },
  smoke: { dur: 1.3, prio: PRIO.ambient, bus: 'fx' },
  smoke_pop: { dur: 1.0, prio: PRIO.fx, bus: 'fx' },
  fire: { dur: 1.3, prio: PRIO.ambient, bus: 'fx' },
  fire_crackle: { dur: 1.2, prio: PRIO.loop, bus: 'fx' },
  throw: { dur: 0.25, prio: PRIO.fx, bus: 'fx' },
  throwable: { dur: 0.25, prio: PRIO.fx, bus: 'fx' },
  footstep: { dur: 0.2, prio: PRIO.ambient, bus: 'fx' },
  sprint: { dur: 0.2, prio: PRIO.ambient, bus: 'fx' },
  vehicle: { dur: 0.7, prio: PRIO.ambient, bus: 'fx' },
  vehicle_engine: { dur: 0.5, prio: PRIO.loop, bus: 'fx' },
  vehicle_hit: { dur: 0.35, prio: PRIO.fx, bus: 'fx' },
  vehicle_start: { dur: 0.7, prio: PRIO.ambient, bus: 'fx' },
  vehicle_destroy: { dur: 1.1, prio: PRIO.fx, bus: 'fx' },
  grenade_bounce: { dur: 0.1, prio: PRIO.fx, bus: 'fx' },
  // 1.1 新增：三材质 × 两节奏脚步（step_<terrain>_<gait>）
  step_grass_walk: { dur: 0.16, prio: PRIO.ambient, bus: 'fx' },
  step_grass_run: { dur: 0.14, prio: PRIO.ambient, bus: 'fx' },
  step_hard_walk: { dur: 0.14, prio: PRIO.ambient, bus: 'fx' },
  step_hard_run: { dur: 0.12, prio: PRIO.ambient, bus: 'fx' },
  step_indoor_walk: { dur: 0.18, prio: PRIO.ambient, bus: 'fx' },
  step_indoor_run: { dur: 0.16, prio: PRIO.ambient, bus: 'fx' },
  // 换弹三段独立样本
  reload_out: { dur: 0.22, prio: PRIO.feedback, bus: 'ui' },
  reload_in: { dur: 0.2, prio: PRIO.feedback, bus: 'ui' },
  reload_bolt: { dur: 0.26, prio: PRIO.feedback, bus: 'ui' },
  // 击杀确认三档
  kill_confirm: { dur: 0.32, prio: PRIO.feedback, bus: 'ui' },
  kill_headshot: { dur: 0.42, prio: PRIO.feedback, bus: 'ui' },
  kill_streak: { dur: 0.6, prio: PRIO.feedback, bus: 'ui' },
  // 命中材质三档
  hit_armor: { dur: 0.2, prio: PRIO.feedback, bus: 'ui' },
  hit_flesh: { dur: 0.14, prio: PRIO.feedback, bus: 'ui' },
  hit_head: { dur: 0.24, prio: PRIO.feedback, bus: 'ui' },
  // 低血心跳（双击）与缩圈警报
  heartbeat: { dur: 0.5, prio: PRIO.feedback, bus: 'ui' },
  zone_alarm: { dur: 1.3, prio: PRIO.ui, bus: 'ui' },
  // 播报（voice bus）：撤离/阶段提示
  voice_announce: { dur: 1.2, prio: PRIO.ui, bus: 'voice' },
};

// 脚步声按地形：type/freq/q 决定材质感，splash 为水花层
const FOOTSTEP = {
  grass: { dur: 0.075, type: 'bandpass', freq: 460, q: 1.4, rate: 1.0, thump: 140, splash: false },
  concrete: { dur: 0.055, type: 'bandpass', freq: 1250, q: 1.1, rate: 1.25, thump: 176, splash: false },
  water: { dur: 0.11, type: 'bandpass', freq: 780, q: 0.8, rate: 0.9, thump: 110, splash: true },
  snow: { dur: 0.09, type: 'lowpass', freq: 620, q: 0.9, rate: 0.8, thump: 96, splash: false },
};

// 1.1 三材质脚步：walk（慢、闷、有鞋底摩擦）vs run（快、脆、落地重）
// heel=脚跟落地噪声中心，toe=前掌离地，thump=体重冲击，grit=碎石/砂砾颗粒感
const STEP = {
  grass: {
    walk: { dur: 0.11, freq: 520, q: 1.3, thump: 132, peak: 0.075, rate: 1.0, grit: 0.018, gritFreq: 2600, sway: 0.35 },
    run: { dur: 0.085, freq: 680, q: 1.0, thump: 150, peak: 0.105, rate: 1.3, grit: 0.03, gritFreq: 3400, sway: 0.15 },
  },
  hard: {
    walk: { dur: 0.07, freq: 1500, q: 1.5, thump: 188, peak: 0.09, rate: 1.1, grit: 0.012, gritFreq: 4200, sway: 0.1 },
    run: { dur: 0.055, freq: 1950, q: 1.7, thump: 215, peak: 0.13, rate: 1.35, grit: 0.022, gritFreq: 5200, sway: 0.06 },
  },
  indoor: {
    walk: { dur: 0.13, freq: 940, q: 0.9, thump: 156, peak: 0.07, rate: 0.95, grit: 0.008, gritFreq: 3000, sway: 0.5 },
    run: { dur: 0.1, freq: 1180, q: 0.8, thump: 178, peak: 0.1, rate: 1.2, grit: 0.014, gritFreq: 3800, sway: 0.3 },
  },
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
    this.gunBus = null;
    this.fxBus = null;
    this.uiBus = null;
    this.voiceBus = null;         // 1.1：播报人声总闸
    this.musicBus = null;
    this.ambBus = null;
    this.buses = null;            // bus 名 → GainNode（gun/fx/ui/voice/music/ambience）
    this.reverb = null;
    this.reverbSend = null;
    this.noiseBuffer = null;
    this.irBuffer = null;
    // 1.1 默认值按任务规格：sfx .8 / music .45 / ui .6 / voice .7
    this.volume = { master: 0.9, sfx: 0.8, gun: 0.85, fx: 0.85, ui: 0.6, voice: 0.7, music: 0.45, ambience: 0.6 };
    this.muted = false;
    this.enabled = true; // 兼容旧 main.js 的 audio.enabled = settings.sound
    this.ready = false;
    this.unlocked = false;
    this.suspended = false;
    this.voices = 0;
    this.maxVoices = 24;
    this.pool = new VolumePool(24);
    this.rig = null;              // SpatialRig：听者 + Panner 工厂
    this.panningModel = 'equalpower';
    this.lastAt = new Map();
    this.tension = 0;
    this.musicMode = 'off';
    this.music = new MusicStems(this);
    this.ambKind = null;
    this.ambIntensity = 0;
    this.ambNodes = null;
    this.loops = new Map();       // 循环音（vehicle_engine / fire_crackle）→ { handle, ... }
    this._loopNodes = new Set();  // 循环音占用过的节点（诊断/验收用；dispose 时清空）
    this.gestureBound = false;
    this._onGesture = null;
    this._gestureOpts = null;
    this._visBound = false;
    this._onVisibility = null;
    this._hb = null;              // 低血心跳调度器
    this.stats = { plays: 0, dropped: 0, steals: 0, nodes: 0, errors: 0, capped: 0, quiet: 0 };
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
    this._bindVisibility();
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

  /**
   * 1.1 页面失焦自动 suspend / 回来 resume（省电、避免后台耗电与爆音）。
   * 幂等：main.js 自己也有 visibilitychange 监听，重复调用 suspend/resume 安全。
   */
  _bindVisibility() {
    if (this._visBound || typeof document === 'undefined' || !document.addEventListener) return;
    this._visBound = true;
    this._onVisibility = () => {
      if (document.hidden) this.suspend();
      else this.resume();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', () => this.suspend());
  }

  _removeVisibility() {
    if (!this._onVisibility || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._onVisibility = null;
    this._visBound = false;
  }

  unlock() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) this._boot();
      if (!this.ctx) return false;
      if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume().catch(() => {});
      this.unlocked = true;
      // 补播「解锁前记录的音乐模式」。
      //
      // boot 阶段（用户手势之前）就调了 setMusic('home')，而那时 ready=false，
      // setMusic 只把模式记在 musicMode 里直接 return。旧实现解锁后从不回放，
      // 于是主菜单永远没有 BGM —— 只有打完一局回大厅才听得到。
      if (this.ready && this.musicMode && this.musicMode !== 'off' && this.music && this.music.mode !== this.musicMode) {
        const mode = this.musicMode;
        this.musicMode = 'off';
        try { this.setMusic(mode); } catch { /* 音乐启动失败不影响音效 */ }
      }
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
    // 每类声音独立 bus → 用户可单独调（gun / fx / ui / voice / music / ambience）
    this.gunBus = ctx.createGain();
    this.fxBus = ctx.createGain();
    this.uiBus = ctx.createGain();
    this.voiceBus = ctx.createGain();
    this.sfxBus = ctx.createGain();   // 兼容旧字段：所有 SFX 的总闸
    this.musicBus = ctx.createGain();
    this.ambBus = ctx.createGain();
    this.gunBus.gain.value = this.volume.gun;
    this.fxBus.gain.value = this.volume.fx;
    this.uiBus.gain.value = this.volume.ui;
    this.voiceBus.gain.value = this.volume.voice;
    this.sfxBus.gain.value = this.volume.sfx;
    this.musicBus.gain.value = this.volume.music;
    this.ambBus.gain.value = this.volume.ambience;
    this.buses = { gun: this.gunBus, fx: this.fxBus, ui: this.uiBus, voice: this.voiceBus, music: this.musicBus, ambience: this.ambBus };
    // 信号链：gun/fx/ui/voice → sfx（总音效音量）→ 压缩器 → master → 扬声器
    //          music / ambience 直接进压缩器，二者由自己的 bus 控制，不占 sfx 预算
    this.gunBus.connect(this.sfxBus);
    this.fxBus.connect(this.sfxBus);
    this.uiBus.connect(this.sfxBus);
    this.voiceBus.connect(this.sfxBus);
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
    this.rig = new SpatialRig(ctx, { model: this.panningModel });
    this.panningModel = this.rig.model;
    // 初始听者：玩家未就位时放在原点，面向 +Z
    this.rig.setListener(0, 0, 0, true);
    this.ready = true;
  }

  suspend() {
    if (!this.ctx) return false;
    // 幂等：visibilitychange 与 pagehide 常在同一次切后台时先后触发，
    // 第二次调用时 musicMode 已被第一次改成 'off'，会把「失焦前的音乐模式」
    // 覆盖成 'off' —— 回到前台后 BGM 从此消失，直到下一局。
    if (this.suspended) return true;
    this.suspended = true;
    try {
      // 记住失焦前的音乐模式，resume 时按原模式重建（setMusic('off') 会真正拆掉旧 stem）
      this._musicBeforeSuspend = this.musicMode || 'off';
      this.setMusic('off');
      this._stopAmbience(0.4);
      for (const key of [...this.loops.keys()]) this.stopLoop(key);
      if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
      return true;
    } catch (err) { return false; } // 静音失败不打断游戏
  }

  resume() {
    if (!this.ctx) return false;
    this.suspended = false;
    try {
      if (this.ctx.state !== 'running' && this.ctx.resume) this.ctx.resume().catch(() => {});
      // 失焦期间音乐与环境音已被拆掉：恢复时按原状态重建
      const mode = this._musicBeforeSuspend;
      if (mode && mode !== 'off') { this.musicMode = 'off'; this.setMusic(mode); }
      if (this.ambKind && this.ambKind !== 'off' && !this.ambNodes) {
        this.setAmbience(this.ambKind, this.ambIntensity || 0.6);
      }
      return true;
    } catch (err) { /* 忽略 */ return false; }
  }

  // ---- 混音 -------------------------------------------------------------

  setVolume(next = {}) {
    const v = this.volume;
    for (const key of ['master', 'sfx', 'gun', 'fx', 'ui', 'voice', 'music', 'ambience']) {
      const n = Number(next && next[key]);
      if (Number.isFinite(n)) v[key] = clamp(n, 0, 1.5);
    }
    if (this.ready) {
      const t = this.ctx.currentTime;
      const set = (param, value, tau) => { try { param.setTargetAtTime(value, t, tau); } catch { /* 忽略 */ } };
      set(this.master.gain, this.muted ? 0 : v.master, 0.05);
      set(this.sfxBus.gain, v.sfx, 0.05);
      set(this.gunBus.gain, v.gun, 0.05);
      set(this.fxBus.gain, v.fx, 0.05);
      set(this.uiBus.gain, v.ui, 0.05);
      set(this.voiceBus.gain, v.voice, 0.05);
      set(this.musicBus.gain, v.music, 0.08);
      set(this.ambBus.gain, v.ambience, 0.1);
    }
    return { ...v };
  }

  mute(on) {
    this.muted = typeof on === 'boolean' ? on : !this.muted;
    if (!this.muted) this.enabled = true;
    if (this.ready) {
      const t = this.ctx.currentTime;
      try {
        this.master.gain.cancelScheduledValues(t);
        this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume.master, t, 0.04);
      } catch { /* 忽略 */ }
    }
    return this.muted;
  }

  // ---- 听者（玩家） -----------------------------------------------------

  /** 每帧可调，内部 100ms 节流：绝不每帧写 AudioParam。 */
  updateListener(x, z, angle) {
    if (!this.rig) return false;
    return this.rig.setListener(x, z, angle);
  }

  /** 从 app 状态自动取玩家位置（main.js 没接 updateListener 时的兜底）。 */
  _syncListenerFromApp() {
    const self = this._self();
    if (self) this.updateListener(self.x, self.z, self.angle || 0);
  }

  _self() {
    const app = this.app;
    if (!app) return null;
    if (app.me && Number.isFinite(app.me.x)) return app.me;
    const st = app.state;
    if (st && Array.isArray(st.players)) return st.players.find((p) => p.id === (app.selfId || st.selfId)) || null;
    return null;
  }

  // ---- 公共播放入口 -----------------------------------------------------

  // 旧签名完全保留：
  //   play('shot:rifle', { vol, pan, dist, pitch })
  //   play('shot', { weapon:'shotgun' })
  //   play('shot', 'shotgun')
  //   play('ui_click') —— 非定位音，不受听者影响
  // 新增（可选）：opts.x / opts.z → 自动走 3D 定位；opts.local=true 强制非定位。
  play(name, opts = {}) {
    if (!this.ready || !this.enabled || this.suspended) return false;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return false;
    if (typeof opts === 'string') opts = { weapon: opts };
    if (!opts || typeof opts !== 'object') opts = {};
    let key = typeof name === 'string' ? name : '';
    if (!key) return false;
    if (key === 'shot') key = `shot:${SHOT_CLASS[opts.weapon] || 'rifle'}`;
    if (key === 'end') key = opts.win === false ? 'defeat' : 'victory';
    key = ALIAS[key] || key;
    const group = key.startsWith('shot:') ? 'shot' : key;
    // 枪声节流必须**按射手分桶**。
    //
    // 旧实现是全局按声音名 70ms 一窗：10Hz 快照每 100ms 送来一批事件，
    // 同批内所有 shot:* 共用同一个窗口 —— 实测一批 30 发只响 1 声，下一批 0 声，
    // 团战时玩家听到的是每 70ms 一发的「固定节拍」而不是真实连发节奏，
    // 多把枪的方位信息完全丢失。
    // 现在以 opts.src（射手 id）为键：每个射手各自 55ms 节流，同批多人的枪声都能出来；
    // 同一射手的连发依然限流（避免一次快照把 10 发叠成爆音）。
    const throttleKey = group === 'shot'
      ? `shot:${opts.src != null ? opts.src : 'x'}`
      : group.startsWith('ui_') ? group : group === 'footstep' ? group : '';
    const throttle = group === 'shot' ? 55 : group.startsWith('ui_') ? 60 : group === 'footstep' ? 110 : 0;
    if (throttle && !this._allow(throttleKey, throttle)) return false;

    const meta = META[group] || META[this._sfx_name(key)] || META._default;
    const hasPos = !opts.local && Number.isFinite(Number(opts.x)) && Number.isFinite(Number(opts.z));
    const self = hasPos ? this._self() : null;
    const dist = hasPos && self
      ? Math.hypot(Number(opts.x) - self.x, Number(opts.z) - self.z)
      : clamp(Number(opts.dist) || 0, 0, 160);
    const vol = clamp(Number.isFinite(Number(opts.vol)) ? Number(opts.vol) : 1, 0, 3);
    const pan = clamp(Number(opts.pan) || 0, -1, 1);
    const pitch = clamp(Number(opts.pitch) || 1, 0.5, 2);
    const far = clamp(dist / SPATIAL.maxDistance, 0, 1);
    // 距离在 JS 侧再压一次总音量（Panner 负责声像与衰减，双保险避免远处糊成一片）
    const near = hasPos ? Math.max(0.18, gainAt(dist) * 1.35) : 1 - far * 0.82;
    const o = {
      vol: vol * near, rawVol: vol, pan, far, pitch, dist,
      x: hasPos ? Number(opts.x) : 0, z: hasPos ? Number(opts.z) : 0,
      spatial: hasPos, terrain: opts.terrain || 'grass', speed: Number(opts.speed) || 0,
      bus: opts.bus || meta.bus, local: !!opts.local,
    };
    const voice = this._openVoice(o, meta);
    if (!voice) { this.stats.dropped++; return false; }
    // 声道池吃紧时按压力线性衰减：24/24 → ×0.35，避免枪战糊成一堵墙
    o.pressure = this.pool.pressure;
    o.vol *= clamp(1 - Math.max(0, o.pressure - 0.35) * 0.9, 0.35, 1);
    // 1.1 声音预算：本轮子声部实际写入的峰值总和，超过 1.0 的部分等比例压掉，
    // 其余按音量从大到小保留（最轻的被丢掉 = 「丢弃音量最小的」）。
    o.gainSum = 0;
    o.dropped = 0;
    const prev = this._cur;
    this._cur = voice;
    let ok = true;
    try {
      if (key.startsWith('shot:')) ok = this._shot(key.slice(5), o) !== false;
      else {
        const handler = this[`_sfx_${key}`];
        ok = typeof handler === 'function' ? handler.call(this, o) !== false : this._sfx_generic(key, o);
      }
    } catch (err) {
      this.stats.errors++;
      ok = false;
    } finally {
      this._cur = prev;
      // 时长按 voice 实际声道占用结算（metadata.dur 是保守上限）
      voice.end(meta.dur);
      if (!ok) voice.kill();
    }
    if (ok) this.stats.plays++;
    return ok;
  }

  /** 世界坐标播放：playAt('shot:rifle', { x, z }) 或 playAt('shot:rifle', x, z, { vol })。 */
  playAt(name, opts = {}, z2, opts2) {
    let o;
    if (typeof opts === 'number') o = { ...(opts2 || {}), x: opts, z: Number(z2) || 0 };
    else o = { ...(opts || {}) };
    if (o.x === undefined) o.x = 0;
    if (o.z === undefined) o.z = 0;
    if (!o.weapon && o.class) o.weapon = o.class;
    return this.play(name, o);
  }

  _sfx_name(key) {
    if (key.startsWith('shot:')) return 'shot';
    const head = key.split('_')[0];
    return key.includes('_') ? key : head;
  }

  /** 声道申请 + 空间链（Panner/低通）或立体声像；返回 voice 对象。 */
  _openVoice(o, meta) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = Math.max(0.05, Number(meta.dur) || 0.4);
    const prio = Number(meta.prio) || PRIO.gun;
    const token = this.pool.reserve({ dur: dur + 0.1, prio, dist: o.dist, gain: clamp(Number(o.vol) || 0, 0, 1.5), now, kill: null });
    if (!token) return null;
    const nodes = [];
    const input = ctx.createGain();
    input.gain.value = 1;
    nodes.push(input);
    let chain = null;
    if (o.spatial && this.rig) {
      chain = this.rig.chain({ x: o.x, z: o.z, y: 1.1, dist: o.dist });
      input.connect(chain.input);
      chain.out.connect(this._bus(o.bus));
      for (const n of chain.nodes) if (n !== chain.input) nodes.push(n);
    } else {
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (panner) {
        panner.pan.value = clamp(o.pan, -1, 1);
        input.connect(panner);
        panner.connect(this._bus(o.bus));
        nodes.push(panner);
      } else {
        input.connect(this._bus(o.bus));
      }
    }
    const voice = {
      input, token, nodes, chain, spatial: !!o.spatial, ended: false, lastEnd: 0,
      /** 子声部登记自己的结束时间：voice 清理时取最长的那个，绝不截断尾音。 */
      note(at) { if (Number.isFinite(at) && at > voice.lastEnd) voice.lastEnd = at; },
      /** 子声部声明「我创建了节点」：即使 0 增益也要占住声道（mock 断言依赖这一点）。 */
      part(at, seconds) { voice.notes = (voice.notes || 0) + 1; voice.note(Number(at) + Number(seconds || 0)); },
      end(seconds) {
        let span = Math.max(0.02, Number(seconds) || 0.3);
        if (voice.lastEnd > 0) span = Math.max(span, voice.lastEnd - ctx.currentTime + 0.12);
        const delay = span * 1000 + 120;
        const timer = typeof setTimeout !== 'undefined' ? setTimeout : null;
        if (timer) timer(() => voice.kill(), delay);
        else voice.kill();
      },
      kill: (fade = 0.02) => {
        if (voice.ended) return;
        voice.ended = true;
        this.pool.release(token);
        try {
          const t = ctx.currentTime;
          input.gain.cancelScheduledValues(t);
          input.gain.setTargetAtTime(0.0001, t, Math.max(0.005, fade / 3));
        } catch { /* 忽略 */ }
        const timer = typeof setTimeout !== 'undefined' ? setTimeout : null;
        const drop = () => {
          for (const n of nodes) { try { n.disconnect(); } catch { /* 已断开 */ } }
          if (chain) chain.dispose();
        };
        if (timer) timer(drop, fade * 1000 + 80); else drop();
      },
      moveTo: (x, z, dist) => { if (chain) chain.setPosition(x, z, dist); },
    };
    token.kill = () => voice.kill(0.03);
    this.voices = this.pool.size;
    return voice;
  }

  _shot(cls, o) {
    const cfg = SHOT[cls] || SHOT.rifle;
    const dur = cfg.dur * (o.far > 0.5 ? 1.5 : 1);
    const cutoff = cfg.freq * (1 - o.far * 0.55) * o.pitch;
    const base = o.vol * cfg.peak;
    // 1) 主噪声脉冲：带通（远处进一步低通）
    this._burst({ dur, type: 'bandpass', freq: cutoff, q: cfg.q, peak: base, rate: 1.1 * o.pitch, verb: 0.1 + o.far * 0.5 });
    // 2) 高频嘶声（枪口爆音），远处衰减明显
    this._burst({ dur: dur * 0.55, type: 'highpass', freq: cfg.hp * (1 - o.far * 0.7), q: 0.6, peak: base * 0.42 * (1 - o.far * 0.8), rate: 1.4 });
    // 3) 低频冲击腔
    this._tone({ dur: dur * 0.9, type: 'triangle', from: cfg.body * o.pitch, to: cfg.bodyEnd, peak: base * cfg.punch });
    // 4) 尾音：远处是混响尾巴，近处是短扩散
    this._burst({ when: dur * 0.5, dur: cfg.tail + o.far * 0.7, type: 'lowpass', freq: 900 - o.far * 500, q: 0.7, peak: base * (o.far > 0.35 ? 0.3 : 0.14) * (1 - o.far * 0.4), verb: 0.15 + o.far * 0.55 });
    return true;
  }

  // --- 战斗反馈 ---
  _sfx_hit(o) {
    // 命中反馈：短促金属敲击（带通噪声击打 + 两条金属泛音）
    this._burst({ dur: 0.035, type: 'bandpass', freq: 3600, q: 2.4, peak: 0.1 * o.vol, bus: 'ui' });
    this._tone({ dur: 0.055, type: 'square', from: 1450, to: 1080, peak: 0.1 * o.vol, bus: 'ui' });
    this._tone({ when: 0.012, dur: 0.075, type: 'triangle', from: 2600, to: 1900, peak: 0.07 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_hitmarker_head(o) { return this._sfx_headshot(o); }

  _sfx_headshot(o) {
    // 爆头：更亮、更长的金属“叮”，带一点混响
    this._burst({ dur: 0.04, type: 'bandpass', freq: 5200, q: 3, peak: 0.12 * o.vol, bus: 'ui' });
    this._tone({ dur: 0.09, type: 'square', from: 1750, to: 1300, peak: 0.13 * o.vol, bus: 'ui' });
    this._tone({ when: 0.05, dur: 0.18, type: 'sine', from: 2600, to: 1980, peak: 0.1 * o.vol, bus: 'ui', verb: 0.25 });
    return true;
  }

  _sfx_down(o) {
    this._tone({ dur: 0.34, type: 'sawtooth', from: 240, to: 70, peak: 0.14 * o.vol, verb: 0.25 });
    this._burst({ dur: 0.25, type: 'lowpass', freq: 700, q: 0.7, peak: 0.1 * o.vol, verb: 0.25 });
    return true;
  }

  _sfx_death(o) {
    // 自己阵亡：低频下坠 + 心跳停止的闷响
    this._tone({ dur: 1.1, type: 'sine', from: 180, to: 42, peak: 0.22 * o.vol, verb: 0.5 });
    this._tone({ when: 0.05, dur: 0.9, type: 'triangle', from: 96, to: 30, peak: 0.14 * o.vol, verb: 0.4 });
    this._burst({ dur: 0.8, type: 'lowpass', freq: 520, q: 0.8, peak: 0.16 * o.vol, verb: 0.45 });
    return true;
  }

  _sfx_hurt(o) {
    // 自己受伤：短促的闷击 + 一点高频刺痛（非定位，走 ui bus 保证听得见）
    this._tone({ dur: 0.13, type: 'sine', from: 190, to: 92, peak: 0.16 * o.vol, bus: 'ui' });
    this._burst({ dur: 0.1, type: 'bandpass', freq: 1350, q: 1.8, peak: 0.1 * o.vol, bus: 'ui' });
    this._tone({ when: 0.02, dur: 0.06, type: 'square', from: 820, to: 640, peak: 0.05 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_kill(o) {
    // 击杀确认：上行三音 + 尾音（游戏内最重要的正向反馈之一）
    [880, 1174, 1568].forEach((hz, i) => this._tone({
      when: i * 0.055, dur: 0.16 + i * 0.04, type: 'triangle', from: hz, to: hz * 1.02, peak: 0.11 * o.vol, bus: 'ui',
    }));
    this._tone({ when: 0.16, dur: 0.26, type: 'sine', from: 1760, to: 1320, peak: 0.1 * o.vol, bus: 'ui', verb: 0.3 });
    return true;
  }

  _sfx_revive(o) {
    [0, 0.09, 0.18].forEach((when, i) => this._tone({ when, dur: 0.22, type: 'sine', from: 420 + i * 140, to: 620 + i * 160, peak: 0.1 * o.vol, verb: 0.3 }));
    return true;
  }

  // --- 1.1 击杀确认三档：普通 / 爆头 / 连杀 -------------------------------
  // 设计原则：全部走高音区（1.5–5kHz）短促正弦 + 极短衰减，穿透枪声但不刺耳；
  // 三档靠「音数 + 音程 + 亮度」区分，不靠音量堆叠（音量堆叠会被压缩器吃掉）。
  _sfx_kill_confirm(o) {
    // 普通击杀：两个上行纯音（G6→D7），强衰减，尾巴带一点金属泛音
    this._tone({ dur: 0.055, type: 'sine', from: 1568, to: 1568, peak: 0.15 * o.vol, bus: 'ui' });
    this._tone({ when: 0.045, dur: 0.1, type: 'sine', from: 2349, to: 2349, peak: 0.13 * o.vol, bus: 'ui' });
    this._tone({ when: 0.045, dur: 0.09, type: 'triangle', from: 3520, to: 2960, peak: 0.045 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_kill_headshot(o) {
    // 爆头击杀：三音大三度上行（A6→E7→A7）+ 一记极短的「啪」瞬态，比普通击杀更利落
    this._tone({ dur: 0.05, type: 'sine', from: 1760, to: 1760, peak: 0.15 * o.vol, bus: 'ui' });
    this._tone({ when: 0.04, dur: 0.09, type: 'sine', from: 2637, to: 2637, peak: 0.13 * o.vol, bus: 'ui' });
    this._tone({ when: 0.09, dur: 0.14, type: 'sine', from: 3520, to: 3520, peak: 0.11 * o.vol, bus: 'ui' });
    this._burst({ dur: 0.018, type: 'highpass', freq: 6000, q: 0.8, peak: 0.05 * o.vol, bus: 'ui' });
    this._tone({ when: 0.09, dur: 0.13, type: 'triangle', from: 5274, to: 4400, peak: 0.04 * o.vol, bus: 'ui', verb: 0.2 });
    return true;
  }

  _sfx_kill_streak(o) {
    // 连杀：四音上行琶音 + 结尾长泛音，明显比单杀"更值得炫耀"
    [0, 0.06, 0.12, 0.18].forEach((when, i) => this._tone({
      when, dur: 0.12 + i * 0.02, type: 'sine',
      from: [1319, 1760, 2637, 3520][i], to: [1319, 1760, 2637, 3520][i] * 1.005,
      peak: (0.12 - i * 0.008) * o.vol, bus: 'ui',
    }));
    this._tone({ when: 0.22, dur: 0.34, type: 'sine', from: 5274, to: 3951, peak: 0.09 * o.vol, bus: 'ui', verb: 0.35 });
    this._burst({ when: 0.2, dur: 0.22, type: 'highpass', freq: 7000, q: 0.7, peak: 0.035 * o.vol, bus: 'ui', verb: 0.3 });
    return true;
  }

  // --- 1.1 命中材质三档：护甲（金属）/ 肉体（闷）/ 头部（脆） ---------------
  // 与击杀确认一样走 ui bus（非定位），保证玩家永远听得到自己的命中反馈。
  _sfx_hit_armor(o) {
    // 护甲：金属板被击中的「铛」——高频带通噪声 + 两条不成谐波比例的金属泛音（板振）
    this._burst({ dur: 0.028, type: 'bandpass', freq: 4200, q: 2.8, peak: 0.13 * o.vol, bus: 'ui' });
    this._tone({ dur: 0.06, type: 'square', from: 1980, to: 1620, peak: 0.09 * o.vol, bus: 'ui' });
    this._tone({ when: 0.006, dur: 0.13, type: 'sine', from: 2870, to: 2610, peak: 0.07 * o.vol, bus: 'ui', verb: 0.18 });
    this._tone({ when: 0.004, dur: 0.09, type: 'sine', from: 4310, to: 4020, peak: 0.04 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_hit_flesh(o) {
    // 肉体：低频闷击（165→78Hz）+ 极短低通噪声（噗），几乎没有高频
    this._tone({ dur: 0.085, type: 'sine', from: 165, to: 78, peak: 0.17 * o.vol, bus: 'ui' });
    this._burst({ dur: 0.05, type: 'lowpass', freq: 620, q: 1.1, peak: 0.12 * o.vol, bus: 'ui' });
    this._burst({ when: 0.008, dur: 0.06, type: 'bandpass', freq: 340, q: 1.4, peak: 0.06 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_hit_head(o) {
    // 头部：脆——中高频瞬态 + 短促骨传导感（比护甲更高、更短、衰减更快）
    this._burst({ dur: 0.018, type: 'highpass', freq: 5200, q: 0.9, peak: 0.15 * o.vol, bus: 'ui' });
    this._tone({ dur: 0.045, type: 'triangle', from: 2600, to: 2100, peak: 0.11 * o.vol, bus: 'ui' });
    this._tone({ when: 0.02, dur: 0.07, type: 'sine', from: 3900, to: 3300, peak: 0.05 * o.vol, bus: 'ui' });
    // 极短的低频「叩」：让脆响有重量，不至于像 UI 提示音
    this._tone({ dur: 0.04, type: 'sine', from: 240, to: 150, peak: 0.08 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_heal_start(o) {
    // 开始用药：气雾罐「呲——」+ 上行吸气
    this._burst({ dur: 0.42, type: 'highpass', freq: 2400, q: 0.7, peak: 0.09 * o.vol, bus: 'ui', rate: 0.9 });
    this._tone({ dur: 0.3, type: 'sine', from: 300, to: 480, peak: 0.07 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_heal_done(o) {
    // 用药完成：两声上行确认音
    [660, 990].forEach((hz, i) => this._tone({ when: i * 0.1, dur: 0.2, type: 'sine', from: hz, to: hz * 1.12, peak: 0.1 * o.vol, bus: 'ui', verb: 0.28 }));
    return true;
  }

  _sfx_heal(o) { return this._sfx_heal_done(o); }

  _sfx_pickup(o) {
    this._tone({ dur: 0.08, type: 'triangle', from: 720, to: 1080, peak: 0.12 * o.vol, bus: 'ui' });
    this._tone({ when: 0.07, dur: 0.12, type: 'sine', from: 1240, to: 1560, peak: 0.1 * o.vol, bus: 'ui', verb: 0.2 });
    return true;
  }

  _sfx_equip(o) {
    // 换枪：布料摩擦 + 金属扣 + 上膛
    this._burst({ dur: 0.18, type: 'bandpass', freq: 1100, q: 0.9, peak: 0.08 * o.vol, bus: 'ui', rate: 0.8 });
    this._burst({ when: 0.08, dur: 0.05, type: 'highpass', freq: 2800, q: 1.1, peak: 0.11 * o.vol, bus: 'ui' });
    this._tone({ when: 0.09, dur: 0.07, type: 'square', from: 240, to: 150, peak: 0.06 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_empty(o) {
    // 空仓扳机：金属干击（高频咔 + 弹簧回弹）
    this._burst({ dur: 0.04, type: 'highpass', freq: 3200, q: 0.9, peak: 0.14 * o.vol, bus: 'ui' });
    this._tone({ dur: 0.05, type: 'square', from: 420, to: 210, peak: 0.07 * o.vol, bus: 'ui' });
    this._tone({ when: 0.03, dur: 0.06, type: 'triangle', from: 1500, to: 900, peak: 0.04 * o.vol, bus: 'ui' });
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
    for (const step of steps) this._burst({ ...step, peak: step.peak * o.vol, bus: 'ui' });
    this._tone({ when: 0.46, dur: 0.09, type: 'square', from: 190, to: 120, peak: 0.08 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_throw(o) {
    this._burst({ dur: 0.18, type: 'bandpass', freq: 900, q: 1.2, peak: 0.12 * o.vol, rate: 0.8 });
    return true;
  }

  _sfx_explosion(o) {
    // 三层：低频轰鸣 + 噪声爆 + 碎片
    this._tone({ dur: 0.75, type: 'sine', from: 120 * o.pitch, to: 32, peak: 0.5 * o.vol, verb: 0.5 });
    this._burst({ dur: 0.5, type: 'lowpass', freq: 1200 - o.far * 700, q: 0.8, peak: 0.5 * o.vol, verb: 0.55 });
    this._burst({ dur: 0.22, type: 'bandpass', freq: 2600, q: 0.6, peak: 0.24 * o.vol * (1 - o.far * 0.5) });
    for (let i = 0; i < 4; i++) this._burst({ when: 0.12 + i * 0.07, dur: 0.12, type: 'highpass', freq: 3200 + i * 700, q: 1, peak: 0.05 * o.vol, rate: 1.2 });
    return true;
  }

  _sfx_smoke(o) {
    this._burst({ dur: 1.1, type: 'lowpass', freq: 1400, q: 0.5, peak: 0.16 * o.vol, rate: 0.55, verb: 0.3 });
    return true;
  }

  _sfx_smoke_pop(o) {
    // 烟雾罐起爆：一小声“噗”+ 喷气
    this._burst({ dur: 0.09, type: 'lowpass', freq: 900, q: 0.9, peak: 0.14 * o.vol });
    this._burst({ when: 0.05, dur: 0.9, type: 'bandpass', freq: 1800, q: 0.6, peak: 0.12 * o.vol, rate: 0.7, verb: 0.25 });
    return true;
  }

  _sfx_fire_crackle(o) {
    // 燃烧循环：低频火焰呼啸 + 随机爆裂（用 loop 句柄驱动，见 startLoop）
    return this.startLoop('fire_crackle', o) || true;
  }

  _sfx_fire(o) {
    this._burst({ dur: 1.2, type: 'bandpass', freq: 420, q: 0.7, peak: 0.13 * o.vol, rate: 0.6, verb: 0.25 });
    this._tone({ dur: 0.9, type: 'sawtooth', from: 90, to: 60, peak: 0.05 * o.vol });
    return true;
  }

  _sfx_flash(o) {
    // 闪光弹：宽频爆闪 + 耳鸣高频（定位音，位置由 voice 的 Panner 决定）
    this._burst({ dur: 0.35, type: 'highpass', freq: 3800, q: 0.5, peak: 0.2 * o.vol, verb: 0.4 });
    this._tone({ dur: 0.5, type: 'sine', from: 3200, to: 4600, peak: 0.05 * o.vol });
    this._tone({ when: 0.02, dur: 0.9, type: 'sine', from: 6200, to: 5600, peak: 0.02 * o.vol });
    return true;
  }

  _sfx_flash_bang(o) { return this._sfx_flash(o); }

  _sfx_vehicle(o) {
    this._tone({ dur: 0.5, type: 'sawtooth', from: 70, to: 110, peak: 0.1 * o.vol });
    this._burst({ dur: 0.5, type: 'lowpass', freq: 600, q: 1, peak: 0.08 * o.vol });
    return true;
  }

  _sfx_vehicle_start(o) { return this._sfx_vehicle(o); }

  _sfx_vehicle_destroy(o) {
    this._tone({ dur: 0.8, type: 'sawtooth', from: 160, to: 40, peak: 0.24 * o.vol, verb: 0.4 });
    this._burst({ dur: 0.7, type: 'lowpass', freq: 1600, q: 0.7, peak: 0.26 * o.vol, verb: 0.4 });
    for (let i = 0; i < 3; i++) this._burst({ when: 0.1 + i * 0.1, dur: 0.14, type: 'highpass', freq: 3000, q: 1, peak: 0.06 * o.vol });
    return true;
  }

  _sfx_ui_click(o) {
    this._tone({ dur: 0.045, type: 'triangle', from: 880, to: 1180, peak: 0.09 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_ui_hover(o) {
    this._tone({ dur: 0.03, type: 'sine', from: 1400, to: 1500, peak: 0.04 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_ui_back(o) {
    // 返回/关闭：下行短音（与 ui_click 上行区分）
    this._tone({ dur: 0.06, type: 'triangle', from: 760, to: 520, peak: 0.08 * o.vol, bus: 'ui' });
    this._burst({ dur: 0.04, type: 'highpass', freq: 3000, q: 0.8, peak: 0.04 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_ui_error(o) {
    this._tone({ dur: 0.07, type: 'square', from: 300, to: 220, peak: 0.08 * o.vol, bus: 'ui' });
    this._tone({ when: 0.09, dur: 0.08, type: 'square', from: 240, to: 180, peak: 0.08 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_levelup(o) {
    [0, 0.1, 0.2, 0.32].forEach((when, i) => this._tone({ when, dur: 0.4, type: 'triangle', from: 523 * Math.pow(2, i / 4), to: 523 * Math.pow(2, i / 4) * 1.5, peak: 0.1 * o.vol, bus: 'ui', verb: 0.4 }));
    return true;
  }

  _sfx_level_up(o) { return this._sfx_levelup(o); }

  _sfx_wave_start(o) {
    this._tone({ dur: 0.6, type: 'sawtooth', from: 110, to: 220, peak: 0.14 * o.vol, verb: 0.4 });
    this._burst({ dur: 0.6, type: 'lowpass', freq: 800, q: 0.8, peak: 0.12 * o.vol, verb: 0.35 });
    return true;
  }

  _sfx_wave_clear(o) {
    [0, 0.12, 0.24].forEach((when, i) => this._tone({ when, dur: 0.45, type: 'sine', from: 660 + i * 220, to: 880 + i * 220, peak: 0.09 * o.vol, verb: 0.45 }));
    return true;
  }

  _sfx_boss(o) {
    this._tone({ dur: 1.4, type: 'sawtooth', from: 55, to: 42, peak: 0.26 * o.vol, verb: 0.5 });
    this._tone({ when: 0.1, dur: 1.1, type: 'square', from: 82, to: 62, peak: 0.1 * o.vol, verb: 0.5 });
    this._burst({ dur: 1.2, type: 'lowpass', freq: 500, q: 1.2, peak: 0.16 * o.vol, verb: 0.4 });
    return true;
  }

  _sfx_boss_spawn(o) { return this._sfx_boss(o); }

  _sfx_victory(o) {
    [0, 0.16, 0.32, 0.48].forEach((when, i) => this._tone({ when, dur: 0.7, type: 'triangle', from: [392, 523, 659, 784][i], to: [523, 659, 784, 1046][i], peak: 0.12 * o.vol, verb: 0.5 }));
    return true;
  }

  _sfx_defeat(o) {
    [0, 0.2, 0.4].forEach((when, i) => this._tone({ when, dur: 0.9, type: 'triangle', from: [330, 262, 196][i], to: [262, 196, 147][i], peak: 0.11 * o.vol, verb: 0.5 }));
    return true;
  }

  _sfx_storm(o) { return this._sfx_zone_warning(o); }
  _sfx_zone_warning(o) {
    // 圈警告：两声下行警报 + 低频压迫
    [0, 0.34].forEach((when) => {
      this._tone({ when, dur: 0.26, type: 'square', from: 740, to: 560, peak: 0.1 * o.vol, bus: 'ui' });
      this._tone({ when, dur: 0.26, type: 'sine', from: 370, to: 280, peak: 0.07 * o.vol, bus: 'ui', verb: 0.3 });
    });
    this._burst({ dur: 0.9, type: 'lowpass', freq: 620, q: 0.7, peak: 0.1 * o.vol, verb: 0.4 });
    return true;
  }

  _sfx_airdrop_in(o) {
    // 飞机掠过：多普勒感的带通噪声 + 低频嗡鸣
    this._burst({ dur: 2.4, type: 'bandpass', freq: 620, q: 0.8, peak: 0.14 * o.vol, rate: 0.5, verb: 0.4 });
    this._tone({ dur: 2.0, type: 'sawtooth', from: 62, to: 92, peak: 0.08 * o.vol, verb: 0.3 });
    this._burst({ when: 0.5, dur: 1.2, type: 'highpass', freq: 2600, q: 0.5, peak: 0.04 * o.vol, rate: 0.8 });
    return true;
  }

  _sfx_airdrop_land(o) {
    // 空投落地：金属撞击 + 尘土
    this._tone({ dur: 0.3, type: 'triangle', from: 160, to: 60, peak: 0.22 * o.vol, verb: 0.35 });
    this._burst({ dur: 0.12, type: 'bandpass', freq: 2400, q: 1.4, peak: 0.16 * o.vol });
    this._burst({ when: 0.05, dur: 0.6, type: 'lowpass', freq: 900, q: 0.6, peak: 0.14 * o.vol, rate: 0.7, verb: 0.3 });
    return true;
  }

  _sfx_chute_open(o) {
    // 开伞：伞盖张开的布料爆响 + 一阵泄气的气流
    this._burst({ dur: 0.18, type: 'bandpass', freq: 900, q: 0.8, peak: 0.2 * o.vol, rate: 1.6 });
    this._burst({ when: 0.06, dur: 0.9, type: 'lowpass', freq: 1400, q: 0.5, peak: 0.12 * o.vol, rate: 0.55, verb: 0.3 });
    this._tone({ dur: 0.5, type: 'sine', from: 140, to: 70, peak: 0.09 * o.vol });
    return true;
  }

  _sfx_land(o) {
    // 落地：闷响 + 碎石/草土
    this._tone({ dur: 0.22, type: 'sine', from: 120, to: 48, peak: 0.24 * o.vol, verb: 0.25 });
    this._burst({ dur: 0.16, type: 'lowpass', freq: 1100, q: 0.7, peak: 0.16 * o.vol, rate: 0.9 });
    return true;
  }

  _sfx_footstep(o) {
    // 按地形换音色：草地柔软、水泥硬反射、水花、雪的脆闷
    const terrain = String(o.terrain || 'grass');
    const cfg = FOOTSTEP[terrain] || FOOTSTEP.grass;
    this._burst({ dur: cfg.dur, type: cfg.type, freq: cfg.freq + (o.pitch - 1) * 220, q: cfg.q, peak: 0.1 * o.vol, rate: cfg.rate });
    this._tone({ dur: 0.06, type: 'sine', from: cfg.thump, to: cfg.thump * 0.66, peak: 0.05 * o.vol });
    if (cfg.splash) this._burst({ when: 0.01, dur: 0.16, type: 'highpass', freq: 3400, q: 0.6, peak: 0.05 * o.vol, rate: 1.3 });
    return true;
  }

  _sfx_sprint(o) {
    this._burst({ dur: 0.12, type: 'bandpass', freq: 620, q: 0.9, peak: 0.08 * o.vol, rate: 1.2 });
    return true;
  }

  // --- 1.1 三材质 × 两节奏脚步 -------------------------------------------
  // 每种材质一整套配方（STEP 表），走/跑差异体现在：时长、亮度、体重冲击、砂砾层。
  // 随机微差（±6% 音高 / ±3% 时长）避免连续脚步听起来像机关枪。
  _step(o, terrain, gait) {
    const table = STEP[terrain] || STEP.grass;
    const cfg = table[gait === 'run' ? 'run' : 'walk'];
    const jitter = 0.94 + Math.random() * 0.12;
    const v = o.vol * jitter;
    const pitch = o.pitch * (terrain === 'grass' ? 1 : terrain === 'hard' ? 1.04 : 0.97);
    // 1) 鞋跟/前掌落地：带通噪声，中心频率微扫（摩擦感）
    this._burst({
      dur: cfg.dur, type: 'bandpass', freq: cfg.freq * pitch, freqTo: cfg.freq * 0.72 * pitch,
      q: cfg.q, peak: cfg.peak * v, rate: cfg.rate * jitter, verb: terrain === 'indoor' ? 0.16 : 0.05,
    });
    // 2) 体重冲击：低频闷响（run 明显重于 walk）
    this._tone({ dur: cfg.dur * 0.9, type: 'sine', from: cfg.thump * pitch, to: cfg.thump * 0.62, peak: cfg.peak * 0.62 * v });
    // 3) 材质颗粒层：草=沙沙、硬地=碎石、室内=木地板/瓷砖回响
    this._burst({ when: 0.012, dur: cfg.dur * 1.5, type: 'highpass', freq: cfg.gritFreq * pitch, q: 0.7, peak: cfg.grit * v, rate: 1.25 });
    if (terrain === 'indoor') {
      // 室内混响尾巴 + 低频箱体共鸣（走廊/房间感）
      this._tone({ when: 0.02, dur: cfg.dur * 2.2, type: 'triangle', from: 210 * pitch, to: 150, peak: cfg.sway * cfg.peak * 0.5 * v, verb: 0.3 });
    }
    if (terrain === 'grass' && gait === 'run') {
      // 草地奔跑：额外的草叶抽打（很轻，但让"跑"与"走"一耳朵可分）
      this._burst({ when: 0.03, dur: cfg.dur * 1.2, type: 'bandpass', freq: 3100, q: 0.6, peak: 0.014 * v, rate: 1.4 });
    }
    return true;
  }

  _sfx_step_grass_walk(o) { return this._step(o, 'grass', 'walk'); }
  _sfx_step_grass_run(o) { return this._step(o, 'grass', 'run'); }
  _sfx_step_hard_walk(o) { return this._step(o, 'hard', 'walk'); }
  _sfx_step_hard_run(o) { return this._step(o, 'hard', 'run'); }
  _sfx_step_indoor_walk(o) { return this._step(o, 'indoor', 'walk'); }
  _sfx_step_indoor_run(o) { return this._step(o, 'indoor', 'run'); }

  // --- 1.1 换弹三段独立样本：弹匣弹出 / 插入 / 拉栓 ------------------------
  _sfx_reload_out(o) {
    // 弹匣弹出：卡笋解锁（高频咔）→ 弹匣沿导轨滑出（金属摩擦下滑）→ 自由落体砸地的轻响
    this._burst({ dur: 0.03, type: 'highpass', freq: 3600, q: 1.2, peak: 0.13 * o.vol, bus: 'ui' });
    this._tone({ dur: 0.05, type: 'square', from: 520, to: 260, peak: 0.06 * o.vol, bus: 'ui' });
    this._burst({ when: 0.02, dur: 0.13, type: 'bandpass', freq: 2100, freqTo: 900, q: 1.6, peak: 0.075 * o.vol, rate: 0.9, bus: 'ui' });
    this._burst({ when: 0.13, dur: 0.05, type: 'bandpass', freq: 1400, q: 1.4, peak: 0.05 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_reload_in(o) {
    // 插入弹匣：先「当」一声锁止（金属 + 弹簧），再一小段回弹晃动
    this._burst({ dur: 0.025, type: 'highpass', freq: 2400, q: 0.9, peak: 0.07 * o.vol, bus: 'ui' });
    this._tone({ when: 0.016, dur: 0.1, type: 'triangle', from: 300, to: 140, peak: 0.13 * o.vol, bus: 'ui' });
    this._tone({ when: 0.016, dur: 0.06, type: 'square', from: 900, to: 620, peak: 0.06 * o.vol, bus: 'ui' });
    this._burst({ when: 0.03, dur: 0.06, type: 'bandpass', freq: 2600, q: 2.1, peak: 0.08 * o.vol, bus: 'ui' });
    this._burst({ when: 0.075, dur: 0.05, type: 'bandpass', freq: 1800, q: 1.8, peak: 0.035 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_reload_bolt(o) {
    // 拉栓：枪机后拉（长金属摩擦）→ 到位「咔」→ 复进簧前推 → 闭锁
    this._burst({ dur: 0.11, type: 'bandpass', freq: 1500, freqTo: 2600, q: 1.3, peak: 0.09 * o.vol, rate: 1.1, bus: 'ui' });
    this._burst({ when: 0.1, dur: 0.03, type: 'highpass', freq: 3400, q: 1.0, peak: 0.14 * o.vol, bus: 'ui' });
    this._tone({ when: 0.1, dur: 0.07, type: 'square', from: 380, to: 190, peak: 0.07 * o.vol, bus: 'ui' });
    this._burst({ when: 0.15, dur: 0.09, type: 'bandpass', freq: 2300, freqTo: 1300, q: 1.5, peak: 0.075 * o.vol, rate: 1.15, bus: 'ui' });
    this._tone({ when: 0.235, dur: 0.04, type: 'triangle', from: 720, to: 430, peak: 0.05 * o.vol, bus: 'ui' });
    return true;
  }

  _sfx_vehicle_hit(o) {
    // 载具被击中：金属板 + 玻璃/碎片
    this._tone({ dur: 0.16, type: 'triangle', from: 420, to: 240, peak: 0.14 * o.vol });
    this._burst({ dur: 0.09, type: 'bandpass', freq: 2800, q: 2.2, peak: 0.16 * o.vol });
    this._burst({ when: 0.03, dur: 0.2, type: 'highpass', freq: 4200, q: 0.8, peak: 0.08 * o.vol, rate: 1.2 });
    return true;
  }

  _sfx_grenade_bounce(o) {
    this._tone({ dur: 0.06, type: 'square', from: 520, to: 300, peak: 0.07 * o.vol });
    return true;
  }

  _sfx_throwable(o) { return this._sfx_throw(o); }

  // 载具引擎（循环）：调用后保持运行，重复调用只更新 pitch / 位置
  _sfx_vehicle_engine(o) {
    return this.startLoop('vehicle_engine', o);
  }

  // 受击/开火等短促反馈（由 app 调用），自带冷却避免连发刷屏
  hapticsHint() {
    return this.play('hit', { vol: 0.5 });
  }

  dispose() {
    // ctx 必须在 try 之外先取出：music.dispose() 之类如果抛错，也不能让 AudioContext
    // 泄漏（真实设备上泄漏的 ctx 会一直占用音频硬件，切后台后仍可能唤醒 CPU）。
    const ctx = this.ctx;
    try {
      this.music.dispose();
      this._stopHeartbeat();
      this._stopAmbience(0.2);
      for (const key of [...this.loops.keys()]) this.stopLoop(key);
      this.pool.clear();
      this._loopNodes.clear();
      this._removeGesture();
      this._removeVisibility();
    } catch (err) { /* 忽略单个清理步骤的异常，继续关 ctx */ }
    if (ctx && typeof ctx.close === 'function') {
      try { ctx.close().catch(() => {}); } catch { /* 已关闭或 mock 同步抛错 */ }
    }
    this.ready = false;
    this.ctx = null;
    this.rig = null;
    this.pool = new VolumePool(this.maxVoices);
  }

  _sfx_generic(name, o) {
    // 未知名字：给一个中性提示音，避免静默失败也避免报错
    this._tone({ dur: 0.08, type: 'sine', from: 660, to: 880, peak: 0.05 * o.vol });
    return true;
  }

  // ---- 音乐（三层 stem，见 client/audio-music.js） -----------------------

  setMusic(mode) {
    const next = PROGRESSIONS[mode] ? mode : 'off';
    if (next === this.musicMode && this.music.mode === next) return this.musicMode;
    this.musicMode = next;
    if (!this.ready) return next;
    try {
      this.music.setMode(next, 1.2);
      this.music.setTension(this.tension);
    } catch (err) { /* 音乐失败不影响游戏 */ }
    return next;
  }

  /** tension 0–1 → base/tension/climax 三层增益（0.8–1.5s 交叉淡入，无爆音）。 */
  setTension(value) {
    this.tension = clamp(Number(value) || 0, 0, 1);
    if (this.ready) { try { this.music.setTension(this.tension); } catch (err) { /* 忽略 */ } }
    return this.tension;
  }

  /** e2e / 调试用：当前三层实际权重。 */
  get musicLayers() { return stemMix(this.tension); }

  _stopMusic(seconds) {
    try { this.music._stop(seconds); } catch (err) { /* 忽略 */ }
  }

  // ---- 环境音 -----------------------------------------------------------

  setAmbience(kind, intensity = 0.6) {
    const next = AMBIENCE[kind] ? kind : 'clear';
    const value = clamp(Number(intensity), 0, 1);
    // ambNodes 为空说明此前被 suspend 拆掉过：同样参数也要真正重启
    if (next === this.ambKind && Math.abs(value - this.ambIntensity) < 0.001 && this.ambNodes) return next;
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

  /**
   * 停止低血心跳调度器。
   *
   * 此前 `dispose()` 里调用了一个**不存在的方法**（`_stopHeartbeat`），抛出的
   * TypeError 被同一个 try/catch 吞掉，导致后面的 `_stopAmbience` / `stopLoop` /
   * `pool.clear()` / 解绑手势与可见性监听全部被跳过 —— dispose 名义上完成，
   * 实际泄漏了循环音源、声道池与两个 window 监听器。
   */
  _stopHeartbeat() {
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
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
    // 兼容旧内部调用：现在统一走 VoicePool（≤24 声道，按优先级 + 距离抢占）
    return !!this.pool.reserve({ dur, prio: 1, dist: 0, now: this.ctx ? this.ctx.currentTime : 0 });
  }

  /**
   * 1.1 单个 voice 的声音预算。返回实际可用峰值：
   *   - 累计超预算后，越轻的子声部越先被淘汰（返回 0 = 本子声部不发声）；
   *   - 仍保留的子声部按超出比例整体压低，保证 _tone/_burst 叠加后峰值 ≤ BUDGET。
   * 这样「丢弃音量最小的」不只发生在声道级别，也发生在同一次音效的子声部级别。
   */
  _budget(peak) {
    const voice = this._cur;
    const safe = clamp(Number(peak) || 0, 0, 1.5);
    if (!voice) return safe;
    const BUDGET = 1.0;
    const used = Number(voice.gainSum) || 0;
    if (used >= BUDGET) { voice.dropped = (voice.dropped || 0) + 1; return 0; }
    const next = Math.min(safe, BUDGET - used);
    // 剩余预算不足原峰值的 12% 时直接丢弃（听不见的尾层不用浪费节点）
    if (next < safe * 0.12) { voice.dropped = (voice.dropped || 0) + 1; return 0; }
    voice.gainSum = used + next;
    return next;
  }

  // 建一条「噪声 → 滤波 → 包络 → 声源级出口 → bus」的链；参数全部走 AudioParam 自动化。
  // pan 仅在非定位（立体声）时生效；定位音由 _openVoice 的 Panner 负责声像。
  _burst({ when = 0, dur = 0.2, type = 'bandpass', freq = 1200, freqTo = 0, q = 1, peak = 0.5, attack = 0.004, bus = 'fx', pan = 0, rate = 1, verb = 0 }) {
    const ctx = this.ctx;
    const voice = this._cur;
    // 定位音的所有子声部都必须走 voice.input（→ 低通 → Panner），否则就丢掉了 3D 定位
    const out = (voice && voice.input) || this._bus(bus);
    const t = ctx.currentTime + when;
    const safeFreq = clamp(Number.isFinite(freq) ? freq : 1200, 30, 18000);
    let safePeak = clamp(Number.isFinite(peak) ? peak : 0.2, 0.0002, 1.5);
    // 预算不足 → 这一层不建节点（voice cap 的「丢弃音量最小」在此落地）
    const allowed = this._budget(safePeak);
    if (allowed <= 0) return null;
    safePeak = Math.max(0.0002, allowed);
    voice?.part?.(t, Math.max(0.02, dur) + 0.06);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = clamp(Number.isFinite(rate) ? rate : 1, 0.25, 4);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(safeFreq, t);
    // 1.1 可选扫频：脚步的鞋底摩擦、换弹的弹匣滑出、引擎的转速都需要中心频率移动
    if (Number.isFinite(freqTo) && freqTo > 0) {
      try { filter.frequency.exponentialRampToValueAtTime(clamp(freqTo, 30, 18000), t + Math.max(0.01, dur)); } catch { /* 忽略 */ }
    }
    filter.Q.value = clamp(Number.isFinite(q) ? q : 1, 0.0001, 30);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(safePeak, t + Math.max(0.001, attack));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.01, dur));
    src.connect(filter);
    filter.connect(gain);
    let tail = gain;
    if (!voice) {
      // 没有 voice（直接调用内部方法）时保留旧式立体声声像
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (panner) { panner.pan.value = clamp(Number(pan) || 0, -1, 1); gain.connect(panner); tail = panner; }
      panner && (tail._panner = panner);
    }
    tail.connect(out);
    let send = null;
    if (verb > 0 && this.reverbSend) {
      send = ctx.createGain();
      send.gain.value = clamp(Number(verb) || 0, 0, 1);
      tail.connect(send);
      send.connect(this.reverbSend);
    }
    src.start(t);
    src.stop(t + Math.max(0.02, dur) + 0.06);
    if (voice) voice.note(t + Math.max(0.02, dur) + 0.06);
    src.onended = () => {
      try { src.disconnect(); filter.disconnect(); gain.disconnect(); } catch (err) { /* 已断开 */ }
      try { tail.disconnect(); send?.disconnect(); } catch (err) { /* 已断开 */ }
    };
    this.stats.nodes += 3;
    return { filter, gain, t, src };
  }

  // 建一条「振荡器 → 增益 → 出口 → bus」的音调链
  _tone({ when = 0, dur = 0.2, type = 'sine', from = 440, to = 440, peak = 0.2, attack = 0.005, bus = 'fx', pan = 0, verb = 0 }) {
    const ctx = this.ctx;
    const voice = this._cur;
    const out = (voice && voice.input) || this._bus(bus);
    const t = ctx.currentTime + when;
    voice?.part?.(t, Math.max(0.02, dur) + 0.04);
    const f0 = clamp(Number.isFinite(from) ? from : 440, 20, 18000);
    const f1 = clamp(Number.isFinite(to) ? to : f0, 20, 18000);
    let safePeak = clamp(Number.isFinite(peak) ? peak : 0.1, 0.0002, 1.5);
    // 预算不足 → 这一层不建节点（见 _budget）
    const allowed = this._budget(safePeak);
    if (allowed <= 0) return null;
    safePeak = Math.max(0.0002, allowed);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + Math.max(0.01, dur));
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(safePeak, t + Math.max(0.001, attack));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.01, dur));
    osc.connect(gain);
    let tail = gain;
    if (!voice) {
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (panner) { panner.pan.value = clamp(Number(pan) || 0, -1, 1); gain.connect(panner); tail = panner; }
    }
    tail.connect(out);
    let send = null;
    if (verb > 0 && this.reverbSend) {
      send = ctx.createGain();
      send.gain.value = clamp(Number(verb) || 0, 0, 1);
      tail.connect(send);
      send.connect(this.reverbSend);
    }
    osc.start(t);
    osc.stop(t + Math.max(0.02, dur) + 0.04);
    if (voice) voice.note(t + Math.max(0.02, dur) + 0.04);
    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch (err) { /* 已断开 */ }
      try { tail.disconnect(); send?.disconnect(); } catch (err) { /* 已断开 */ }
    };
    this.stats.nodes += 2;
    return { gain, t, osc };
  }

  // 循环音（载具引擎 / 火焰）：同一 key 重复调用只更新参数，不新建节点
  startLoop(key, o = {}) {
    if (!this.ready || !this.ctx) return false;
    const existing = this.loops.get(key);
    const speed = Number(o.speed);
    if (existing) {
      if (Number.isFinite(speed) && existing.osc) {
        try { existing.osc.frequency.setTargetAtTime(Math.max(20, 46 + speed * 5.4), this.ctx.currentTime, 0.12); } catch { /* 忽略 */ }
      }
      if (existing.voice && Number.isFinite(o.x) && Number.isFinite(o.z)) existing.voice.moveTo(Number(o.x), Number(o.z), Number(o.dist) || 0);
      return true;
    }
    const ctx = this.ctx;
    const voice = this._openVoice({ ...o, spatial: Number.isFinite(o.x) && Number.isFinite(o.z) && !o.local }, META[key] || META._default);
    if (!voice) return false;
    const now = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = key === 'fire_crackle' ? 'bandpass' : 'lowpass';
    filter.frequency.value = key === 'fire_crackle' ? 1600 : 520;
    filter.Q.value = key === 'fire_crackle' ? 0.8 : 1.4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.setTargetAtTime(key === 'fire_crackle' ? 0.09 : 0.12, now, 0.5);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    let osc = null;
    src.connect(filter); filter.connect(gain); gain.connect(voice.input);
    if (key === 'vehicle_engine') {
      osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = Math.max(20, 46 + (Number(o.speed) || 0) * 5.4);
      const og = ctx.createGain();
      og.gain.value = 0.08;
      osc.connect(og); og.connect(voice.input);
      osc.start(now);
      this.stats.nodes += 2;
      voice._og = og;
    }
    src.start(now);
    this.stats.nodes += 3;
    const handle = { key, voice, src, filter, gain, osc, nodes: [src, filter, gain, osc, voice._og].filter(Boolean) };
    for (const n of handle.nodes) this._loopNodes.add(n);
    this.loops.set(key, handle);
    return true;
  }

  /** 循环音参数：载具速度 → 引擎音高。 */
  setLoopSpeed(key, speed) {
    const handle = this.loops.get(key);
    if (!handle || !handle.osc || !this.ctx) return false;
    const hz = Math.max(20, 46 + (Number(speed) || 0) * 5.4);
    try { handle.osc.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.12); } catch { return false; }
    return true;
  }

  stopLoop(key, fade = 0.25) {
    const handle = this.loops.get(key);
    if (!handle) return false;
    this.loops.delete(key);
    if (!this.ctx) return false;
    const t = this.ctx.currentTime;
    try {
      handle.gain.gain.cancelScheduledValues(t);
      handle.gain.gain.setTargetAtTime(0.0001, t, Math.max(0.02, fade / 3));
    } catch { /* 忽略 */ }
    const stop = () => {
      try { handle.src.stop(); } catch { /* 已停止 */ }
      try { handle.osc && handle.osc.stop(); } catch { /* 已停止 */ }
      for (const n of handle.nodes) { try { n.disconnect(); } catch { /* 已断开 */ } this._loopNodes.delete(n); }
      if (handle.voice) handle.voice.kill(0.02);
    };
    const timer = typeof setTimeout !== 'undefined' ? setTimeout : null;
    if (timer) timer(stop, fade * 1000 + 60); else stop();
    return true;
  }

  _bus(name) {
    if (this.buses && this.buses[name]) return this.buses[name];
    if (name === 'music') return this.musicBus;
    if (name === 'ambience') return this.ambBus;
    if (name === 'ui') return this.uiBus || this.sfxBus;
    if (name === 'voice') return this.voiceBus || this.uiBus || this.sfxBus;
    if (name === 'gun') return this.gunBus || this.sfxBus;
    return this.fxBus || this.sfxBus;
  }
}

// 便于 scripts/audio-check.mjs 与调试面板直接校验空间化参数曲线
export { cutoffAt, gainAt, SPATIAL, VoicePool, SpatialRig };
