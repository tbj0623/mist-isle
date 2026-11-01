// 雾岛突围 / MIST ISLE 1.0 — 输入控制器（owner: feel · client/input.js）
// 桌面键鼠 + 触屏摇杆/动作按钮，输出与 shared/rules.mjs 的 INPUT_DEFAULTS 同构。
// 设计：类定义阶段不触碰任何 DOM；constructor 内所有设备 API 都做存在性判断，
// 因此本模块可在 Node 中 import / new（无 DOM 时静默降级）用于静态测试。
//
// 与其它模块的接线（契约 §10.5 / §11）：
//   ui-hud 建按钮后调用 input.bindJoystick(binding) / input.bindButtons()（或依赖自动绑定）；
//   ui-hud 也可调用 input.setStick('move'|'aim', x, y) 写入摇杆轴；
//   按钮点击 → input.press(action) / input.hold(action, bool)；
//   投掷物/消耗品/选槽 → input.throwable(kind) / input.useItem(item) / input.swap(slot)。

import { INPUT_DEFAULTS } from '../shared/rules.mjs';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const DEADZONE = 0.12;          // 摇杆死区：0.12 以内视为回中（原来是 0.16，手游偏钝）
const EDGE_FULL = 0.85;         // 贴边加速：推到 85% 以上直接输出满速，避免“走路慢”
const THROW_ORDER = ['frag', 'smoke', 'flash', 'molotov'];
const ITEMS = ['bandage', 'medkit', 'energy', 'shield'];
const PULSE_MS = 220; // 脉冲保持窗口：25Hz 发送（40ms）下至少覆盖 5 帧

// 自动瞄准辅助：12° 锥、35m 内生效，每帧最多向最近敌人靠拢 15%
// 瞄准辅助参数。
//
// `escapeMul` / `escapeCooldown` / `escapeWindow` 是「逃逸阈值」，业界（COD Mobile、
// Apex）通用的防「磁铁感」做法：玩家主动把准星往反方向甩的时候，辅助必须立刻让路，
// 否则会出现「想切目标却被黏住」的对抗感 —— 这是双摇杆射击最常见的差评来源。
//
// 判定：把最近 escapeWindow 秒内的玩家输入角速度（rad/s）与辅助自身的吸附角速度比较，
// 前者超过后者 escapeMul 倍即视为「玩家在主动摆脱」，关闭辅助 escapeCooldown 秒。
// 同时保留强度分档（weak 0.5 / medium 0.85，不给满值 1.0），给高手留出技巧空间。
const ASSIST = {
  angle: 12 * Math.PI / 180, range: 35, maxStep: 0.15,
  // 强档不给 1.0：满吸附会让跟枪完全变成「扶着走」，高阶玩家会关掉辅助
  strength: { off: 0, weak: 0.5, medium: 0.85 },
  escapeMul: 2.5,          // 玩家角速度 > 吸附角速度 × 2.5 → 判定为主动摆脱
  escapeCooldown: 0.22,    // 摆脱后关闭辅助的时长（秒），150–250ms 是主流区间
  escapeWindow: 0.08,      // 角速度采样窗口（秒）
};
// 分级触觉（navigator.vibrate 不支持时静默）
const HAPTIC = { fire: 6, hit: 12, hurt: 20, kill: [15, 30, 15], reload: 8 };

// code -> 脉冲动作（按下瞬间一次）
const PULSE_KEYS = {
  KeyR: 'reload',
  KeyQ: 'swap',
  KeyG: 'throw',
  KeyF: 'throwNext',
  KeyH: 'heal',
  KeyP: 'ping',
  KeyB: 'inventory',
  KeyM: 'map',
  Tab: 'scoreboard',
  Space: 'dodge',
  Digit1: 'slot0',
  Digit2: 'slot1',
  Escape: 'pause',
};
// code -> 按住布尔
const HOLD_KEYS = { KeyE: 'interact', ShiftLeft: 'sprint', ShiftRight: 'sprint', ControlLeft: 'crouch', ControlRight: 'crouch' };
const MOVE_KEYS = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
// 触屏按钮 action 名（ui-hud 的 data-action）-> 内部语义
const ACTION_ALIAS = {
  interact: 'interact', revive: 'interact', heal: 'heal', reload: 'reload', swap: 'swap',
  throwable: 'throw', throw: 'throw', sprint: 'sprint', crouch: 'crouch', dodge: 'dodge',
  jump: 'jump', backpack: 'inventory', ping: 'ping', pause: 'pause', fullmap: 'map',
};
const PULSED_ACTIONS = new Set(['reload', 'swap', 'dodge', 'jump', 'throw', 'ping', 'inventory', 'map', 'scoreboard', 'ready']);
const HELD_ACTIONS = {
  interact: 'interact', revive: 'interact', heal: 'heal', sprint: 'sprint', crouch: 'crouch',
};
const TOGGLE_ACTIONS = new Set(['sprint', 'crouch']);

// 这些弹窗即使残留在 DOM 里也不应该禁用玩法输入：
//   room-dialog  —— 战前集合，对局开始后可能因服务端广播时序残留
//   help-dialog  —— 纯说明，可边看边动
const IGNORED_DIALOGS = new Set(['room-dialog', 'help-dialog']);

export class InputController {
  constructor(canvas, app = {}) {
    this.canvas = canvas || null;
    this.app = app || {};
    const settings = this.app.settings || {};
    this.mode = 'desktop'; // 'desktop' | 'touch'，由最近的输入事件切换
    this.sensitivity = clamp(Number(settings.sensitivity) || 1, 0.3, 2.5);
    this.joystickScale = clamp(Number(settings.joystickScale) || 1, 0.7, 1.5);
    this.autoFire = settings.autoFire !== false;

    this.keys = new Set();
    this.held = new Set();          // 按住型动作
    this.toggles = { sprint: false, crouch: false };
    this.pulses = new Map();        // action -> 过期时间（ms）
    this.pointer = { x: 0, y: 0, down: false, right: false, inside: false, moved: false };
    this.sticks = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 } };
    this.stickMeta = { move: { mag: 0, sprint: false }, aim: { mag: 0 } };
    this.aim = Number(this.app.me && this.app.me.angle) || 0;
    this.aimValid = false;
    this.aimAnchor = this.aim;      // 右键 ADS：锚定角度（鼠标移动不改变）
    this.ads = false;               // 开镜（右键 / 长按开火键）
    this.aimAssistTarget = null;    // setAimAssistTarget(angle) 由 main.js 每帧喂
    this.aimAssist = settings.aimAssist !== false && settings.aimAssist !== 'off';
    this.aimAssistStrength = ASSIST.strength[settings.aimAssistStrength] ?? ASSIST.strength.medium;
    this._assistEscapeUntil = 0;    // 玩家主动摆脱后，辅助停用到这个时刻（performance.now 毫秒）
    this._aimTrack = [];            // 最近若干帧的 [t, aim]，用于估算玩家输入角速度
    this.fireHoldAt = 0;            // 长按开火键的起始时刻（触屏 ADS）
    this.layout = null;             // setLayout({...}) 触屏布局自定义（只存不渲染）
    this.throwIndex = Math.max(0, THROW_ORDER.indexOf((this.app.meta && this.app.meta.data && this.app.meta.data.loadout && this.app.meta.data.loadout.throwable) || 'frag'));
    this.pendingThrow = null;       // 指定投掷物（下一次 update 消费）
    this.pendingUseItem = null;
    this.pendingSlot = -1;
    this.pendingSwapSlot = -1;
    this.pingKind = 'move';
    this.zoomDelta = 0;
    this.lastHaptic = 0;
    this.handlers = [];
    this.timers = [];
    this.destroyed = false;
    this._bind();
  }

  // ── 事件工具 ────────────────────────────────────────────────────────────
  _on(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    this.handlers.push([target, type, fn, opts]);
  }

  _isTyping(event) {
    const t = event && event.target;
    if (!t || !t.tagName) return false;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable === true;
  }

  _dialogOpen() {
    if (typeof document === 'undefined' || !document.querySelector) return false;
    // 只有「真正挡住游戏」的弹窗才应该禁用玩法输入。
    // room-dialog 是战前集合面板：对局已经开始时它可能因为服务端 lobby 广播的
    // 时序问题残留为 open，但那时玩家已经在场上，输入必须放行，否则整局动不了。
    // 同理 pause/result 走 app.paused / app.mode 判断，不靠 DOM 弹窗。
    const BLOCKING = ['pause-dialog', 'result-dialog'];
    try {
      const open = document.querySelectorAll('#dialog-root .modal.open, #dialog-root dialog[open]');
      for (const node of open) {
        if (BLOCKING.includes(node.id)) return true;
        // 未列入白名单的弹窗（帮助/图鉴/选择器）仍然阻断，避免误操作
        if (node.id && !IGNORED_DIALOGS.has(node.id)) return true;
      }
      return false;
    } catch { return false; }
  }

  _playing() {
    const app = this.app;
    if (app.mode !== 'match' || app.paused || app.suspended) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return !this._dialogOpen();
  }

  _pulse(action) {
    if (!action) return;
    this.pulses.set(action, nowMs() + PULSE_MS);
  }

  _expirePulses() {
    const t = nowMs();
    for (const [key, expiry] of this.pulses) if (expiry < t) this.pulses.delete(key);
  }

  _consume(action) {
    if (!this.pulses.has(action)) return false;
    this.pulses.delete(action);
    return true;
  }

  // ── 绑定 ────────────────────────────────────────────────────────────────
  _bind() {
    if (typeof window === 'undefined') return;
    this._on(window, 'keydown', (e) => this._keydown(e));
    this._on(window, 'keyup', (e) => this._keyup(e));
    this._on(window, 'blur', () => this.clear());
    if (typeof document !== 'undefined') {
      this._on(document, 'visibilitychange', () => { if (document.hidden) this.clear(); });
    }
    const canvas = this.canvas;
    if (!canvas) return;
    this._on(canvas, 'pointerdown', (e) => this._pointerdown(e));
    this._on(canvas, 'pointermove', (e) => this._pointermove(e));
    this._on(canvas, 'pointerleave', () => { this.pointer.inside = false; });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this._on(canvas, type, (e) => { if (!e || e.pointerType !== 'touch') { this.pointer.down = false; this.pointer.right = false; this.ads = false; } });
    }
    this._on(canvas, 'contextmenu', (e) => { if (this.app.mode === 'match') e.preventDefault(); });
    this._on(canvas, 'wheel', (e) => this._wheel(e), { passive: false });
  }

  _keydown(e) {
    if (this._isTyping(e)) return;
    this.mode = 'desktop';
    const code = e.code || '';
    const playing = this.app.mode === 'match';
    if (playing && (MOVE_KEYS[code] || code === 'Space' || code === 'Tab')) {
      // Tab 在浏览器里会移焦点；Space 会滚页。只在对局中拦截。
      e.preventDefault();
    }
    this.keys.add(code);
    const hold = HOLD_KEYS[code];
    if (hold) this.held.add(hold);
    if (code === 'KeyC') { // C 蹲：切换式，与 Ctrl 按住并存
      this.toggles.crouch = !this.toggles.crouch;
      this._pulse('crouch');
      e.preventDefault();
    }
    if (e.repeat) return;
    const action = PULSE_KEYS[code];
    if (!action) return;
    if (action === 'pause') {
      if (playing && !this._dialogOpen()) this._pulse('pause');
      return;
    }
    this._pulse(action);
    if (playing && ['reload', 'swap', 'heal', 'interact', 'throw', 'throwNext', 'dodge', 'ping', 'slot0', 'slot1', 'inventory', 'map'].includes(action)) e.preventDefault();
  }

  _keyup(e) {
    const code = e.code || '';
    this.keys.delete(code);
    const hold = HOLD_KEYS[code];
    if (hold) this.held.delete(hold);
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.toggles.sprint = false;
  }

  _pointerdown(e) {
    if (e.pointerType === 'touch') { this.mode = 'touch'; return; }
    this.mode = 'desktop';
    this.pointer.inside = true;
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.moved = true;
    if (e.button === 0) {
      this.pointer.down = true;
      if (this.app.mode === 'match') e.preventDefault();
    } else if (e.button === 2) {
      // 右键 = ADS 方向锚定：固定当前角度，直到松开
      this.aim = this._aimAtPointer();
      this.aimAnchor = this.aim;
      this.aimValid = true;
      this.pointer.right = true;
      this.ads = true;
    }
    try { canvasCapture(this.canvas, e.pointerId); } catch { /* 忽略 */ }
  }

  _pointermove(e) {
    if (e.pointerType === 'touch') { this.mode = 'touch'; return; }
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.inside = true;
    this.pointer.moved = true;
  }

  _wheel(e) {
    if (this.app.mode !== 'match') return;
    e.preventDefault();
    const step = Math.sign(e.deltaY) || 0;
    this.zoomDelta = clamp(this.zoomDelta + step, -4, 4);
    if (this.app.scene && typeof this.app.scene.zoomBy === 'function') { try { this.app.scene.zoomBy(step); } catch { /* 忽略 */ } }
  }

  _aimAtPointer() {
    const me = this.app.me || null;
    const scene = this.app.scene;
    if (!me) return this.aim;
    try {
      if (scene && typeof scene.aimAt === 'function') {
        const angle = scene.aimAt(this.pointer.x, this.pointer.y, me);
        if (Number.isFinite(angle)) return angle;
      }
    } catch { /* 场景未就绪时保持上一次角度 */ }
    return this.aim;
  }

  // ── 供 ui-hud 调用的接线 API ─────────────────────────────────────────────
  /** 摇杆状态写入（ui-hud 的 syncStick 会调用）。move 支持 mag>0.86 视为拖出外圈冲刺。 */
  setStick(kind, x, y) {
    const stick = this.sticks[kind] || (this.sticks[kind] = { x: 0, y: 0 });
    stick.x = clamp(Number(x) || 0, -1, 1);
    stick.y = clamp(Number(y) || 0, -1, 1);
    const mag = Math.hypot(stick.x, stick.y);
    const meta = this.stickMeta[kind] || (this.stickMeta[kind] = { mag: 0 });
    meta.mag = mag;
    if (kind === 'move') meta.sprint = mag > EDGE_FULL;
    return stick;
  }

  /**
   * 摇杆手感整形：死区 0.12 → 径向钳制到单位圆 → 85% 以上贴边加速到 1.0。
   * 返回 { x, y, mag }（mag 已整形，0–1）。
   */
  shapeStick(kind) {
    const stick = this.sticks[kind] || { x: 0, y: 0 };
    const raw = Math.hypot(stick.x, stick.y);
    if (raw <= DEADZONE) return { x: 0, y: 0, mag: 0 };
    // 径向钳制：先在单位圆内归一化方向，再按整形后的幅度重建
    const nx = stick.x / raw;
    const ny = stick.y / raw;
    const t = clamp((Math.min(raw, 1) - DEADZONE) / (1 - DEADZONE), 0, 1);
    // 曲线：死区刚出来时轻微（防抖），70% 后线性，EDGE_FULL 以上直接满速
    let shaped = t < 0.25 ? t * t * 1.6 + t * 0.4 : t;
    if (raw >= EDGE_FULL) shaped = 1;
    shaped = clamp(shaped, 0, 1);
    return { x: nx * shaped, y: ny * shaped, mag: shaped };
  }

  /**
   * 自动瞄准辅助目标（由 main.js 每帧喂）：只给「准星 12° 内、35m 内最近的敌人」的角度。
   * 不传或传 null 表示本帧没有可吸附目标。main.js 没接也完全安全（辅助自动失效）。
   */
  setAimAssistTarget(angle, dist) {
    if (angle === null || angle === undefined || !Number.isFinite(Number(angle))) { this.aimAssistTarget = null; return null; }
    const d = Number(dist);
    // 距离可选：给了就更精确，没给按范围上限处理
    this.aimAssistTarget = Number.isFinite(d) && d > ASSIST.range ? null : { angle: Number(angle), dist: Number.isFinite(d) ? d : ASSIST.range };
    return this.aimAssistTarget ? this.aimAssistTarget.angle : null;
  }

  /** 当前是否已吸附（调试/HUD 用）。 */
  get aimAssistActive() {
    return !!(this.aimAssist && this.aimAssistTarget && this.aimAssistStrength > 0);
  }

  /**
   * 估算「玩家自己」的输入角速度（rad/s），不含辅助造成的位移。
   *
   * 实现上比较的是**辅助前后**的瞄准角：_applyAimAssist 在调用前先记下 rawAim，
   * 这里用 rawAim 序列而不是 this.aim 序列，否则会把辅助自身的拉拽也算成玩家输入，
   * 导致「辅助越强越容易判定为玩家在摆脱」的自锁死循环。
   */
  _playerAimSpeed(nowMs) {
    const track = this._aimTrack;
    for (let i = 0; i < track.length - 1; i++) {
      const dt = (track[i + 1][0] - track[i][0]) / 1000;
      if (dt >= ASSIST.escapeWindow) return Math.abs(track[i + 1][1] - track[i][1]) / dt;
    }
    return 0;
  }

  /** 吸附：向目标每帧最多插值 maxStep × 强度，且只在 12° 锥内生效。 */
  _applyAimAssist(dt, nowMs = 0) {
    if (!this.aimAssistActive) return false;
    // 逃逸窗口内：玩家正在主动摆脱，辅助完全让路
    if (nowMs && nowMs < this._assistEscapeUntil) return false;
    const target = this.aimAssistTarget.angle;
    let delta = target - this.aim;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) > ASSIST.angle) return false;         // 锥外：绝不硬拉
    // 12° 锥内按接近角度衰减：越靠边吸力越弱，避免“磁铁感”
    const near = 1 - Math.abs(delta) / ASSIST.angle;
    const frames = clamp((Number(dt) || 0.016) * 60, 0.2, 3);
    const step = ASSIST.maxStep * this.aimAssistStrength * near * frames;
    // 逃逸阈值：辅助的角速度（rad/s）与玩家输入角速度比较
    const seconds = Math.max(0.001, Number(dt) || 0.016);
    const assistSpeed = step / seconds;
    if (nowMs && this._playerAimSpeed(nowMs) > assistSpeed * ASSIST.escapeMul) {
      this._assistEscapeUntil = nowMs + ASSIST.escapeCooldown * 1000;
      return false;
    }
    this.aim = lerpAngle(this.aim, target, clamp(step, 0, 1));
    this.aimValid = true;
    return true;
  }

  /**
   * 按「当前最缺什么」挑一个治疗消耗品（H 键 / 触屏治疗键不指定具体物品时使用）。
   *
   * 优先级与直觉一致：先补护盾（不占血量上限、被击时先扣），再按血量缺口
   * 在小药（绷带，22）与大药（医疗包，75）之间选 —— 缺口小用绷带免得浪费，
   * 缺口大直接用医疗包。能量饮料只在其它都没有时兜底。
   * 返回 null 表示没有可用物品（模拟层会安全忽略）。
   */
  /**
   * 跳伞落点：沿当前瞄准方向从机位投出 fall 米，再归一化到 0-1。
   *
   * 俯视角下没有「俯视视角的前方」，所以用瞄准角（也就是玩家转向）作为方向：
   * 舱内左右转 = 在航线图上挑落点，语义直观且不需要额外 UI。
   * 地图半径从 app.mapRadius 取（没有就退回 182，与 rules/maps 一致）。
   */
  _jumpTarget(me) {
    // 半径优先取场景实际世界（与地图定义同源），其次 app.mapRadius，最后 182。
    const mapR = Number(this.app?.scene?.world?.radius)
      || Number(this.app?.mapRadius) || 182;
    const dist = 190;                 // ≈ 自由落体 + 滑翔的实际可达距离
    const x = (Number(me?.x) || 0) + Math.sin(this.aim) * dist;
    const z = (Number(me?.z) || 0) + Math.cos(this.aim) * dist;
    // 世界 → 归一化，并 clamp 进地图圆（服务端还会再 clamp 一次）
    let nx = (x / mapR + 1) / 2;
    let nz = (z / mapR + 1) / 2;
    const dx = nx * 2 - 1;
    const dz = nz * 2 - 1;
    const d = Math.hypot(dx, dz);
    if (d > 0.96) { nx = (dx / d) * 0.96 / 2 + 0.5; nz = (dz / d) * 0.96 / 2 + 0.5; }
    return { x: nx, z: nz };
  }

  _pickHealItem() {
    const me = this.app?.me || this.app?.state?.me || null;
    if (!me) return null;
    const hp = Number(me.hp) || 0;
    const shield = Number(me.shield) || 0;
    const has = (key) => (Number(me[key]) || 0) > 0;
    // 护盾没满且带盾：先补盾（护盾不占血量上限，且先于护甲结算）
    if (shield < 100 && has('shields')) return 'shield';
    if (hp < 50 && has('meds')) return 'medkit';          // 大失血：直接医疗包
    if (hp < 100 && has('meds')) return 'medkit';
    if (hp < 100 && has('bandages')) return 'bandage';
    if (has('energy')) return 'energy';
    if (has('meds')) return 'medkit';
    if (has('bandages')) return 'bandage';
    if (has('shields')) return 'shield';
    return null;
  }

  /** 开镜强度：开镜时灵敏度 × 0.6。 */
  get aimMultiplier() { return this.ads ? 0.6 : 1; }

  /** 按钮按下（ui-hud 的 bindActionButton 会调用）。 */
  press(action) {
    const mapped = ACTION_ALIAS[action] || action;
    this.mode = 'touch';
    if (mapped === 'interact') { this.held.add('interact'); return; }
    if (mapped === 'heal') { this.held.add('heal'); this._pulse('heal'); return; }
    // 短按投掷 = 扔当前选中；切换由长按（ui-hud 的 bindActionButton）或 F 键负责。
    // 历史实现这里是 cycleThrowable(1) 再立刻投掷：手雷 3 / 烟雾 2 时点一下按钮，
    // 扔出去的是**烟雾**（切到下一个并当场扔），与帮助面板「长按切换」正好相反。
    // 注意不能清 pendingThrow —— 投掷物面板点选后要靠它指定本次投掷的种类。
    if (mapped === 'throw') { this._pulse('throw'); return; }
    if (mapped === 'swap') { this._pulse('swap'); return; }
    if (mapped === 'sprint') { this.toggles.sprint = !this.toggles.sprint; return; }
    if (mapped === 'crouch') { this.toggles.crouch = !this.toggles.crouch; return; }
    if (PULSED_ACTIONS.has(mapped)) this._pulse(mapped);
  }

  /** 按钮按住态（pointerdown/up/cancel/lostpointercapture）。 */
  hold(action, down) {
    const mapped = ACTION_ALIAS[action] || action;
    this.mode = 'touch';
    if (!HELD_ACTIONS[mapped]) {
      if (TOGGLE_ACTIONS.has(mapped) && down) this.toggles[mapped] = !this.toggles[mapped];
      return;
    }
    const flag = HELD_ACTIONS[mapped];
    if (flag === 'sprint' || flag === 'crouch') {
      // 按住冲刺/蹲：按下 true，松开回 false（与切换式 C 键互不冲突）
      if (down) this.held.add(`press:${flag}`); else this.held.delete(`press:${flag}`);
      return;
    }
    if (down) this.held.add(flag); else this.held.delete(flag);
  }

  /** ui-hud 面板动作：'pause' | 'fullmap' 等。 */
  command(name) {
    if (name === 'pause') this._pulse('pause');
    else if (name === 'fullmap') this._pulse('map');
    else if (PULSED_ACTIONS.has(name)) this._pulse(name);
  }

  /** 指定投掷物（ui-hud 投掷物选择面板）。 */
  throwable(kind) {
    if (THROW_ORDER.includes(kind)) { this.throwIndex = THROW_ORDER.indexOf(kind); this.pendingThrow = kind; return kind; }
    this._pulse('throw');
    return THROW_ORDER[this.throwIndex];
  }

  /** 指定消耗品（ui-hud 物品栏）。 */
  useItem(item) {
    if (ITEMS.includes(item)) { this.pendingUseItem = item; return item; }
    return null;
  }

  /** 指定武器槽（ui-hud 武器卡）。 */
  swap(slot) {
    const index = Number(slot);
    if (index === 0 || index === 1) { this.pendingSwapSlot = index; return index; }
    this._pulse('swap');
    return -1;
  }

  // ── 设置 / 反馈 ─────────────────────────────────────────────────────────
  setSensitivity(v) { this.sensitivity = clamp(Number(v) || 1, 0.3, 2.5); return this.sensitivity; }
  setJoystickScale(v) { this.joystickScale = clamp(Number(v) || 1, 0.7, 1.5); return this.joystickScale; }
  setAutoFire(v) { this.autoFire = v !== false; return this.autoFire; }
  setPingKind(kind) { this.pingKind = ['enemy', 'loot', 'move', 'help'].includes(kind) ? kind : 'move'; return this.pingKind; }

  /** 自动瞄准辅助设置：on/off + 强度 off|weak|medium。 */
  setAimAssist(on, strength) {
    if (on !== undefined) this.aimAssist = on !== false && on !== 'off';
    if (strength !== undefined) {
      this.aimAssistStrength = ASSIST.strength[strength] ?? ASSIST.strength.medium;
      if (this.aimAssistStrength === 0) this.aimAssist = false;
    }
    return { on: this.aimAssist, strength: this.aimAssistStrength };
  }

  /**
   * 触屏布局自定义：允许用户拖动按钮位置。只做存储 + 导出，不改 DOM（DOM 归 uiux）。
   * 形如 { joystick: { x, y, size }, fireButton: { x, y, size }, ... }，坐标用 0–1 归一化。
   * 写进 meta settings（app.meta.setSettings）并回写 app.settings.touchLayout。
   */
  setLayout(layout) {
    if (!layout || typeof layout !== 'object') return this.layout;
    const clean = {};
    for (const [key, value] of Object.entries(layout)) {
      if (!value || typeof value !== 'object') continue;
      const x = clamp(Number(value.x), 0, 1);
      const y = clamp(Number(value.y), 0, 1);
      const size = clamp(Number(value.size), 0.4, 2.5);
      clean[key] = {
        x: Number.isFinite(x) ? x : 0.5,
        y: Number.isFinite(y) ? y : 0.5,
        ...(Number.isFinite(size) ? { size } : {}),
      };
    }
    this.layout = { ...(this.layout || {}), ...clean };
    try { this.app.settings = { ...(this.app.settings || {}), touchLayout: this.layout }; } catch { /* 只读 settings */ }
    try { this.app.meta?.setSettings?.({ touchLayout: this.layout }); } catch { /* 无 meta 时忽略 */ }
    return this.layout;
  }

  /** 读回布局（uiux 渲染时用）。 */
  getLayout() { return this.layout ? { ...this.layout } : null; }

  /** 分级触觉：fire 6ms / hit 12ms / hurt 20ms / kill [15,30,15] / reload 8ms。 */
  haptic(kind) {
    const pattern = HAPTIC[kind];
    if (!pattern) return false;
    return this.haptics(pattern);
  }

  haptics(pattern) {
    if (this.destroyed) return false;
    if (this.app.settings && this.app.settings.haptics === false) return false;
    const t = nowMs();
    // 分级触觉自带节奏，冷却只拦「同一毫秒刷屏」，不能吃掉击杀三段震动
    const minGap = Array.isArray(pattern) ? 120 : 60;
    if (t - this.lastHaptic < minGap) return false;
    this.lastHaptic = t;
    try {
      if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
      return navigator.vibrate(pattern === undefined ? 12 : pattern);
    } catch { return false; }
  }

  clear() {
    this.keys.clear();
    this.held.clear();
    this.toggles.sprint = false;
    this.pulses.clear();
    this.pointer.down = false;
    this.pointer.right = false;
    this.ads = false;
    this.aimValid = false;
    this.zoomDelta = 0;
    this.sticks.move.x = 0; this.sticks.move.y = 0;
    this.sticks.aim.x = 0; this.sticks.aim.y = 0;
    this.stickMeta.move.mag = 0; this.stickMeta.aim.mag = 0;
  }

  /** 每帧 UI 相关更新（main.js 会调用；摇杆视觉由 ui-hud 负责）。 */
  updateUi() { /* 预留：震动/指针提示等 */ }

  destroy() {
    this.destroyed = true;
    for (const [target, type, fn, opts] of this.handlers) {
      try { target.removeEventListener(type, fn, opts); } catch { /* 忽略 */ }
    }
    this.handlers.length = 0;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    this.clear();
  }

  // ── 输出（与 INPUT_DEFAULTS 同构） ───────────────────────────────────────
  update(dt) {
    const out = { ...INPUT_DEFAULTS };
    this._expirePulses();
    if (!this._playing()) { this._dropTransient(); return out; }
    const me = this.app.me || null;
    const downed = !!(me && (me.downed || me.state === 'downed'));

    // 移动：键盘 + 移动摇杆（摇杆优先），归一化到 ≤1
    let mx = 0;
    let mz = 0;
    for (const [code, [kx, kz]] of Object.entries(MOVE_KEYS)) if (this.keys.has(code)) { mx += kx; mz += kz; }
    // 摇杆整形：死区 0.12 → 径向钳制 → 85% 以上贴边满速
    const shaped = this.shapeStick('move');
    if (shaped.mag > 0) { mx = shaped.x; mz = shaped.y; }
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    out.mx = mx;
    out.mz = mz;
    out.moveMag = Math.hypot(mx, mz);

    // 开火 / 开镜先算：ADS 会影响本帧灵敏度（开镜 ×0.6），必须早于瞄准解算
    const aimMag = this.stickMeta.aim.mag;
    const touchFire = aimMag > (this.autoFire ? 0.28 : 0.62);
    const wasFire = this.wasFire === true;
    const firing = !downed && (this.pointer.down || touchFire);
    // 长按开火键 → 开镜（触屏）：按住超过 260ms 且未松开即进入 ADS；松开退出
    if (firing && !wasFire) { this.fireHoldAt = nowMs(); this.adsTouch = false; }
    if (!firing) { this.fireHoldAt = 0; this.adsTouch = false; }
    else if (this.mode === 'touch' && this.fireHoldAt && nowMs() - this.fireHoldAt > 260) this.adsTouch = true;
    this.ads = !!(this.pointer.right || this.adsTouch);
    const aimMul = this.ads ? 0.6 : 1;

    // 瞄准：右摇杆 → 角度；桌面 → scene.aimAt（未就绪则保持上次角度）；ADS 锚定
    if (aimMag > DEADZONE * (1.6 - this.sensitivity * 0.6)) {
      // 灵敏度影响转向速度：低灵敏度时角度缓动更慢；开镜时再 × 0.6
      const target = Math.atan2(this.sticks.aim.x, this.sticks.aim.y);
      const rate = (0.28 + this.sensitivity * 0.5) * aimMul;
      this.aim = lerpAngle(this.aim, target, clamp(rate * Math.max(dt || 0.016, 0.008) * 12, 0, 1));
      this.aimValid = true;
    } else if (this.ads && this.pointer.right) {
      this.aim = this.aimAnchor;
    } else if (this.mode === 'desktop' && this.pointer.moved && this.pointer.inside) {
      const next = this._aimAtPointer();
      if (Number.isFinite(next)) { this.aim = next; this.aimValid = true; }
    }
    // 自动瞄准辅助（只能在摇杆/触屏输入上叠加，桌面鼠标保持原样）
    //
    // 先记下「辅助前」的瞄准角，供逃逸阈值判定玩家自己的输入角速度 —— 必须用
    // rawAim 序列，不能用 this.aim（那里面混了辅助自身的位移，会形成自锁死循环）。
    if (this.mode === 'touch' || aimMag > 0) {
      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const track = this._aimTrack;
      track.push([nowMs, this.aim]);
      // 只保留最近 1 秒，够 escapeWindow 用即可（避免长数组）
      while (track.length > 2 && nowMs - track[0][0] > 1000) track.shift();
      // aimMag 高（玩家在用力推摇杆）时才允许触发逃逸；静止时不判定，避免误伤
      if (aimMag > 0.25) this._applyAimAssist(dt, nowMs);
      else this._applyAimAssist(dt, 0);
    }
    out.aim = this.aim;
    out.ads = this.ads;
    out.aimMultiplier = this.aimMultiplier;

    // 冲刺 / 蹲：键盘按住 | 摇杆外圈 | 触屏切换
    out.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.held.has('sprint')
      || this.held.has('press:sprint') || this.toggles.sprint || this.stickMeta.move.sprint;
    out.crouch = this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.held.has('crouch')
      || this.held.has('press:crouch') || this.toggles.crouch;

    // 开火（本帧结果）：桌面左键 / 触屏右摇杆拖出 或 长按开火键
    out.fire = firing;
    if (firing && !wasFire) this.haptic('fire');   // 开火：轻 6ms
    this.wasFire = firing;

    // 按住型布尔
    out.interact = !downed && (this.keys.has('KeyE') || this.held.has('interact'));
    out.revive = out.interact;
    out.heal = !downed && (this.keys.has('KeyH') || this.held.has('heal'));

    // 脉冲型（按下瞬间一次）
    out.reload = this._consume('reload');
    if (out.reload) this.haptic('reload');   // 换弹开始：8ms（完成音由 HUD 侧再触发一次）
    out.swap = this._consume('swap');
    // 空格在「地面」是翻滚、「空中」是跳伞；两个阶段互斥，复用同一个键位。
    // 空中时把这一次按键从 dodge 抢过来，避免地面翻滚逻辑误触发。
    const inAir = !!(me && me.deployStage && me.deployStage !== 'ground');
    const jumpPressed = inAir && this._consume('dodge');
    out.jump = jumpPressed || (inAir && this._consume('jump'));
    out.dodge = !downed && !inAir && this._consume('dodge');
    if (out.dodge) this.haptic('dodge');
    if (out.jump) this.haptic('fire');
    // 跳伞落点：把当前瞄准方向从机位向前投 190m（≈ 自由落体 + 滑翔的可达距离），
    // 再换算成归一化 0-1。玩家在舱内转向即等于「选落点」，比只按空格随机落要可控。
    if (out.jump) out.jumpAt = this._jumpTarget(me);
    if (out.swap && this.pendingSwapSlot >= 0) { out.slot = this.pendingSwapSlot; this.pendingSwapSlot = -1; }
    if (this._consume('slot0')) out.slot = 0;
    if (this._consume('slot1')) out.slot = 1;
    if (this.pendingSwapSlot >= 0 && !out.swap) { out.swap = true; out.slot = this.pendingSwapSlot; this.pendingSwapSlot = -1; }

    // 投掷物：G/F 或 ui-hud 指定
    if (this._consume('throw')) { out.throwable = this.pendingThrow || THROW_ORDER[this.throwIndex]; this.pendingThrow = null; }
    else if (this.pendingThrow) { out.throwable = this.pendingThrow; this.pendingThrow = null; }
    if (this._consume('throwNext')) this.cycleThrowable(1);

    // 消耗品：H 用当前最需要的那一种，ui-hud 可指定具体物品。
    //
    // 历史 bug：这里在 heal 时把 useItem 置成 null 并注释「交给模拟决定」，
    // 但模拟层（simulation.mjs 的 _handleActions）只认 `inp.useItem`，
    // 从来没有消费 `heal` 布尔 —— 结果是**键盘 H 与触屏治疗键在所有平台都无效**
    //（实测血量 40 按 H 4.5 秒，hp 不变、meds 不减）。这里由客户端挑好具体物品再发。
    // 不额外做节流：模拟层 _handleActions 里已有 `if (p.useCd > 0) return` 与
    // `healTime > 0` 的保护，重复请求是幂等的。客户端再节流反而会让「松开再按」
    // 的第二次治疗被吃掉（历史实现就踩过这个坑）。
    if (this.pendingUseItem) { out.useItem = this.pendingUseItem; this.pendingUseItem = null; }
    else if (out.heal) out.useItem = this._pickHealItem();

    // 标记
    if (this._consume('ping')) { out.ping = true; out.pingKind = this.pingKind; }
    out.pingKind = this.pingKind;

    // 滚轮缩放（UI 字段，不进协议）
    out.zoom = this.zoomDelta !== 0 ? this.zoomDelta : 0;
    this.zoomDelta = 0;

    // 菜单/面板类 UI 字段（main.js 可读，服务端会忽略未知字段）
    out.scoreboard = this.keys.has('Tab') || this.pulses.has('scoreboard');
    out.map = this.pulses.has('map');
    out.pause = this.pulses.has('pause');
    out.inventory = this.pulses.has('inventory');
    out.ads = this.ads;
    out.downed = downed;
    out.seq = 0; // main.js 统一覆盖
    return out;
  }

  _dropTransient() {
    for (const action of ['reload', 'swap', 'dodge', 'jump', 'throw', 'ping', 'inventory', 'map', 'scoreboard', 'ready', 'pause']) this.pulses.delete(action);
    this.pendingThrow = null;
    this.pendingUseItem = null;
    this.pendingSwapSlot = -1;
    if (this.toggles.sprint && this.app.mode !== 'match') this.toggles.sprint = false;
  }

  /**
   * 切换选中投掷物（F 键 / 触屏长按投掷键）。
   *
   * ⚠ 这里**不能**写 pendingThrow：pendingThrow 的语义是「下一次 update 立刻扔这个」，
   * 而 update() 里有一条 `else if (this.pendingThrow) { out.throwable = ... }`，
   * 所以每次「切换」都会顺手扔出一颗 —— 实测手雷 3 / 烟雾 2 时长按切换到烟雾，
   * 下一帧就把烟雾扔了。切换只改 throwIndex，扔的动作由 press('throw') / G 单独触发。
   */
  cycleThrowable(step = 1) {
    const i = THROW_ORDER.indexOf(this.throwIndex >= 0 ? THROW_ORDER[this.throwIndex] : 'frag');
    this.throwIndex = (i + step + THROW_ORDER.length) % THROW_ORDER.length;
    if (this.app.audio && typeof this.app.audio.play === 'function') { try { this.app.audio.play('ui_click', { vol: 0.6 }); } catch { /* 忽略 */ } }
    return THROW_ORDER[this.throwIndex];
  }

  /** 当前选中的投掷物种类（HUD 长按提示用）。 */
  get throwKind() { return THROW_ORDER[this.throwIndex] || 'frag'; }
}

function lerpAngle(from, to, t) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

function canvasCapture(canvas, pointerId) {
  if (canvas && typeof canvas.setPointerCapture === 'function' && pointerId !== undefined) canvas.setPointerCapture(pointerId);
}

export default InputController;
