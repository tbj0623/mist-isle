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
const DEADZONE = 0.16;
const THROW_ORDER = ['frag', 'smoke', 'flash', 'molotov'];
const ITEMS = ['bandage', 'medkit', 'energy', 'shield'];
const PULSE_MS = 220; // 脉冲保持窗口：25Hz 发送（40ms）下至少覆盖 5 帧

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
  backpack: 'inventory', ping: 'ping', pause: 'pause', fullmap: 'map',
};
const PULSED_ACTIONS = new Set(['reload', 'swap', 'dodge', 'throw', 'ping', 'inventory', 'map', 'scoreboard', 'ready']);
const HELD_ACTIONS = {
  interact: 'interact', revive: 'interact', heal: 'heal', sprint: 'sprint', crouch: 'crouch',
};
const TOGGLE_ACTIONS = new Set(['sprint', 'crouch']);

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
    this.ads = false;
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
    try { return !!document.querySelector('#dialog-root .modal.open, #dialog-root dialog[open]'); } catch { return false; }
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
    if (kind === 'move') meta.sprint = mag > 0.86;
    return stick;
  }

  /** 按钮按下（ui-hud 的 bindActionButton 会调用）。 */
  press(action) {
    const mapped = ACTION_ALIAS[action] || action;
    this.mode = 'touch';
    if (mapped === 'interact') { this.held.add('interact'); return; }
    if (mapped === 'heal') { this.held.add('heal'); this._pulse('heal'); return; }
    if (mapped === 'throw') { this.cycleThrowable(1); this._pulse('throw'); return; }
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

  haptics(pattern) {
    if (this.destroyed) return false;
    if (this.app.settings && this.app.settings.haptics === false) return false;
    const t = nowMs();
    if (t - this.lastHaptic < 80) return false;
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
    const moveStick = this.sticks.move;
    const mag = this.stickMeta.move.mag;
    if (mag > DEADZONE) {
      // 触屏摇杆微缩：幅度过小时平滑减弱，避免抖动
      const scale = clamp((mag - DEADZONE) / (0.55 - DEADZONE), 0, 1);
      mx = moveStick.x * scale;
      mz = moveStick.y * scale;
    }
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    out.mx = mx;
    out.mz = mz;

    // 瞄准：右摇杆 → 角度；桌面 → scene.aimAt（未就绪则保持上次角度）；ADS 锚定
    const aimMag = this.stickMeta.aim.mag;
    if (aimMag > DEADZONE * (1.6 - this.sensitivity * 0.6)) {
      // 灵敏度影响转向速度：低灵敏度时角度缓动更慢
      const target = Math.atan2(this.sticks.aim.x, this.sticks.aim.y);
      const rate = 0.28 + this.sensitivity * 0.5;
      this.aim = lerpAngle(this.aim, target, clamp(rate * Math.max(dt || 0.016, 0.008) * 12, 0, 1));
      this.aimValid = true;
    } else if (this.ads && this.pointer.right) {
      this.aim = this.aimAnchor;
    } else if (this.mode === 'desktop' && this.pointer.moved && this.pointer.inside) {
      const next = this._aimAtPointer();
      if (Number.isFinite(next)) { this.aim = next; this.aimValid = true; }
    }
    out.aim = this.aim;
    out.ads = this.ads;

    // 冲刺 / 蹲：键盘按住 | 摇杆外圈 | 触屏切换
    out.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.held.has('sprint')
      || this.held.has('press:sprint') || this.toggles.sprint || (moveStick !== null && this.stickMeta.move.sprint);
    out.crouch = this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.held.has('crouch')
      || this.held.has('press:crouch') || this.toggles.crouch;

    // 开火：桌面左键 / 触屏右摇杆拖出（autoFire 关闭时需更大幅度）
    const touchFire = aimMag > (this.autoFire ? 0.28 : 0.62);
    out.fire = !downed && (this.pointer.down || touchFire);

    // 按住型布尔
    out.interact = !downed && (this.keys.has('KeyE') || this.held.has('interact'));
    out.revive = out.interact;
    out.heal = !downed && (this.keys.has('KeyH') || this.held.has('heal'));

    // 脉冲型（按下瞬间一次）
    out.reload = this._consume('reload');
    out.swap = this._consume('swap');
    out.dodge = !downed && this._consume('dodge');
    if (out.swap && this.pendingSwapSlot >= 0) { out.slot = this.pendingSwapSlot; this.pendingSwapSlot = -1; }
    if (this._consume('slot0')) out.slot = 0;
    if (this._consume('slot1')) out.slot = 1;
    if (this.pendingSwapSlot >= 0 && !out.swap) { out.swap = true; out.slot = this.pendingSwapSlot; this.pendingSwapSlot = -1; }

    // 投掷物：G/F 或 ui-hud 指定
    if (this._consume('throw')) { out.throwable = this.pendingThrow || THROW_ORDER[this.throwIndex]; this.pendingThrow = null; }
    else if (this.pendingThrow) { out.throwable = this.pendingThrow; this.pendingThrow = null; }
    if (this._consume('throwNext')) this.cycleThrowable(1);

    // 消耗品：H 用最快可用物（由模拟挑），ui-hud 可指定具体物品
    if (this.pendingUseItem) { out.useItem = this.pendingUseItem; this.pendingUseItem = null; }
    else if (out.heal) out.useItem = null; // 交给模拟决定

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
    for (const action of ['reload', 'swap', 'dodge', 'throw', 'ping', 'inventory', 'map', 'scoreboard', 'ready', 'pause']) this.pulses.delete(action);
    this.pendingThrow = null;
    this.pendingUseItem = null;
    this.pendingSwapSlot = -1;
    if (this.toggles.sprint && this.app.mode !== 'match') this.toggles.sprint = false;
  }

  cycleThrowable(step = 1) {
    const i = THROW_ORDER.indexOf(this.throwIndex >= 0 ? THROW_ORDER[this.throwIndex] : 'frag');
    this.throwIndex = (i + step + THROW_ORDER.length) % THROW_ORDER.length;
    this.pendingThrow = THROW_ORDER[this.throwIndex];
    if (this.app.audio && typeof this.app.audio.play === 'function') { try { this.app.audio.play('ui_click', { vol: 0.6 }); } catch { /* 忽略 */ } }
    return this.pendingThrow;
  }
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
