// 雾岛突围 / MIST ISLE 1.0 — 输入控制器（owner: feel · client/input.js）
// 桌面键鼠 + 触屏摇杆/按钮，输出与 shared/rules.mjs 的 INPUT_DEFAULTS 同构。
// 摇杆向量由 ui-hud.js 写入（app.hud.sticks / setStick），本模块负责合成输入。

import { emptyInput } from '../shared/simulation.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEADZONE = 0.16;

// 按键映射：code -> 动作（脉冲型在按下瞬间触发一次）
const PULSE_KEYS = {
  KeyR: 'reload',
  KeyQ: 'swap',
  KeyG: 'throw',
  KeyF: 'throwNext',
  KeyH: 'heal',
  KeyP: 'ping',
  Digit1: 'slot0',
  Digit2: 'slot1',
  KeyB: 'inventory',
  Tab: 'scoreboard',
  KeyM: 'map',
};
const MOVE_KEYS = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
const SWAP_KEYS = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
};

const THROW_ORDER = ['frag', 'smoke', 'flash', 'molotov'];

export class InputController {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;
    this.keys = new Set();
    this.pulses = new Map();       // action -> expireAt
    this.held = new Set();          // 按住型触屏动作
    this.pointer = { x: 0, y: 0, inside: false, down: false, moved: false };
    this.moveStick = { x: 0, y: 0 };
    this.aimStick = { x: 0, y: 0, active: false };
    this.aim = 0;
    this.aimValid = false;
    this.sensitivity = 1;
    this.joystickScale = 1;
    this.autoFire = true;
    this.throwIndex = 0;
    this.useItemIndex = 0;
    this.lastHaptic = 0;
    this.handlers = [];
    this.sticks = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 } };
    this._bind();
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────
  _on(target, type, fn, opts) {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    this.handlers.push([target, type, fn, opts]);
  }

  destroy() {
    for (const [target, type, fn, opts] of this.handlers) {
      try { target.removeEventListener(type, fn, opts); } catch { /* 忽略 */ }
    }
    this.handlers.length = 0;
  }

  _bind() {
    const isTyping = (e) => e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

    this._on(window, 'keydown', (e) => {
      if (isTyping(e)) return;
      const modalOpen = !!document.querySelector('#dialog-root .modal.open');
      if (e.code === 'Escape') return; // main.js 处理
      if (modalOpen) return;
      if (MOVE_KEYS[e.code] || SWAP_KEYS[e.code] || e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ControlLeft') {
        if (this.app?.mode === 'match') e.preventDefault();
      }
      this.keys.add(e.code);
      if (e.repeat) return;
      const action = PULSE_KEYS[e.code];
      if (action) {
        e.preventDefault();
        this.pulse(action);
      }
      if (e.code === 'Space' && this.app?.mode === 'match') { e.preventDefault(); this.pulse('dodge'); }
      if (e.code === 'ShiftLeft') this.keys.add('Sprint');
      if (e.code === 'ControlLeft' || e.code === 'KeyC') { e.preventDefault(); this.pulse('crouch'); }
      if (e.code === 'KeyE') this.held.add('interact');
    });

    this._on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyE') this.held.delete('interact');
    });

    this._on(window, 'blur', () => this.clear());
    this._on(window, 'pointerlockchange', () => { /* 不使用 pointer lock */ });

    // 鼠标瞄准 / 开火
    this._on(this.canvas, 'pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
      this.pointer.moved = true;
    });
    this._on(this.canvas, 'pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button !== 0) return;
      this.pointer.down = true;
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.moved = true;
      try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this._on(this.canvas, type, () => { this.pointer.down = false; });
    }
    this._on(this.canvas, 'pointerleave', () => { this.pointer.inside = false; });
    this._on(this.canvas, 'wheel', (e) => {
      if (this.app?.mode !== 'match') return;
      e.preventDefault();
      this.app.scene?.zoomBy?.(Math.sign(e.deltaY));
    }, { passive: false });
    this._on(document, 'contextmenu', (e) => {
      if (this.app?.mode === 'match') e.preventDefault();
    });
  }

  // ── 触屏摇杆（由 ui-hud 写入） ───────────────────────────────────────────────
  setStick(kind, x, y) {
    const stick = this.sticks[kind] || (this.sticks[kind] = { x: 0, y: 0 });
    stick.x = clamp(x, -1, 1);
    stick.y = clamp(y, -1, 1);
  }

  bindJoystick(root, kind) {
    if (!root) return;
    const state = { id: null, x: 0, y: 0 };
    const inner = root.querySelector('.joystick-knob, span');
    const update = (e) => {
      if (state.id !== e.pointerId) return;
      const rect = root.getBoundingClientRect();
      const radius = (rect.width / 2) * clamp(this.joystickScale, 0.7, 1.4);
      let dx = e.clientX - (rect.left + rect.width / 2);
      let dy = e.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > radius) { dx *= radius / len; dy *= radius / len; }
      state.x = dx / radius;
      state.y = dy / radius;
      if (inner) inner.style.transform = `translate(${dx}px, ${dy}px)`;
      this.setStick(kind, state.x, state.y);
      if (kind === 'aim' && Math.hypot(state.x, state.y) > DEADZONE) {
        this.aim = Math.atan2(state.x, state.y);
        this.aimValid = true;
        state.active = true;
      }
      e.preventDefault();
    };
    const start = (e) => {
      if (state.id !== null) return;
      state.id = e.pointerId;
      try { root.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      this.app?.audio?.unlock?.();
      update(e);
    };
    const end = (e) => {
      if (state.id !== e.pointerId) return;
      state.id = null;
      state.x = 0;
      state.y = 0;
      if (inner) inner.style.transform = '';
      this.setStick(kind, 0, 0);
      if (kind === 'aim') { this.aimStick.active = false; }
    };
    root.addEventListener('pointerdown', start);
    root.addEventListener('pointermove', update);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(type, end);
  }

  // ── 动作按钮（由 ui-hud 调用） ────────────────────────────────────────────────
  bindButton(action, el) {
    if (!el) return;
    const press = (e) => {
      e?.preventDefault?.();
      this.app?.audio?.unlock?.();
      if (action === 'interact' || action === 'revive') this.held.add('interact');
      if (action === 'heal') this.held.add('heal');
      this.pulse(action);
      el.classList.add('pressed');
    };
    const release = () => {
      this.held.delete('interact');
      this.held.delete('heal');
      el.classList.remove('pressed');
    };
    el.addEventListener('pointerdown', press);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
      el.addEventListener(type, release);
    }
  }

  pulse(action) {
    this.pulses.set(action, performance.now() + 180);
  }

  consume(action) {
    if (!this.pulses.has(action)) return false;
    this.pulses.delete(action);
    return true;
  }

  // ── 设置 ───────────────────────────────────────────────────────────────────
  setSensitivity(v) { this.sensitivity = clamp(Number(v) || 1, 0.3, 2.5); }
  setJoystickScale(v) { this.joystickScale = clamp(Number(v) || 1, 0.7, 1.4); }
  setAutoFire(v) { this.autoFire = v !== false; }

  haptics(pattern) {
    if (this.app?.settings?.haptics === false) return;
    const now = performance.now();
    if (now - this.lastHaptic < 80) return;
    this.lastHaptic = now;
    try { navigator.vibrate?.(pattern || 12); } catch { /* 忽略 */ }
  }

  clear() {
    this.keys.clear();
    this.held.clear();
    this.pulses.clear();
    this.pointer.down = false;
    this.sticks.move.x = 0;
    this.sticks.move.y = 0;
    this.sticks.aim.x = 0;
    this.sticks.aim.y = 0;
    this.aimStick.active = false;
  }

  /** 每帧调用（供 UI 动画/摇杆视觉使用，可空实现）。 */
  updateUi() { /* 摇杆视觉由 ui-hud 自行绘制 */ }

  // ── 输出 ───────────────────────────────────────────────────────────────────
  update() {
    const out = emptyInput();
    const playing = this.app?.mode === 'match' && !this.app.paused && !this.app.suspended
      && !document.hidden && !document.querySelector('#dialog-root .modal.open');
    if (!playing) return out;

    // 移动
    let mx = 0;
    let mz = 0;
    for (const [code, [kx, kz]] of Object.entries(MOVE_KEYS)) {
      if (this.keys.has(code)) { mx += kx; mz += kz; }
    }
    for (const [code, [kx, kz]] of Object.entries(SWAP_KEYS)) {
      if (this.keys.has(code)) { mx += kx * 0.7; mz += kz * 0.7; }
    }
    const stick = this.sticks.move;
    if (Math.hypot(stick.x, stick.y) > DEADZONE) { mx = stick.x; mz = stick.y; }
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    out.mx = mx;
    out.mz = mz;

    // 瞄准
    const aimStick = this.sticks.aim;
    const aimLen = Math.hypot(aimStick.x, aimStick.y);
    if (aimLen > DEADZONE) {
      this.aim = Math.atan2(aimStick.x, aimStick.y);
      this.aimValid = true;
    } else if (this.pointer.moved) {
      const me = this.app?.me;
      try {
        if (me && this.app?.scene?.aimAt) {
          const angle = this.app.scene.aimAt(this.pointer.x, this.pointer.y, me);
          if (Number.isFinite(angle)) { this.aim = angle; this.aimValid = true; }
        }
      } catch { /* 忽略 */ }
    }
    out.aim = this.aim;

    // 开火：桌面左键按住 / 触屏右摇杆拖出死区 + 自动开火
    const touchFire = aimLen > 0.3 && (this.autoFire || aimLen > 0.62);
    out.fire = !!(this.pointer.down || touchFire);

    // 冲刺 / 蹲
    out.sprint = this.keys.has('ShiftLeft') || this.held.has('sprint') || this.app?.hud?.toggleSprint === true;
    out.crouch = this.keys.has('ControlLeft') || this.app?.hud?.toggleCrouch === true;

    // 按住型
    out.interact = this.keys.has('KeyE') || this.held.has('interact');
    out.revive = this.held.has('interact');
    out.heal = this.keys.has('KeyH') || this.held.has('heal') || this.consume('heal');

    // 脉冲型
    out.reload = this.consume('reload');
    out.swap = this.consume('swap');
    out.dodge = this.consume('dodge');

    // 投掷物：G 投当前选择，F 循环选择
    if (this.consume('throwNext')) {
      this.throwIndex = (this.throwIndex + 1) % THROW_ORDER.length;
    }
    if (this.consume('throw')) out.throwable = THROW_ORDER[this.throwIndex];

    // 消耗品：H 使用最合适的（由模拟决定）；触屏按钮可指定
    if (this.consume('itemBandage')) out.useItem = 'bandage';
    if (this.consume('itemMedkit')) out.useItem = 'medkit';
    if (this.consume('itemEnergy')) out.useItem = 'energy';
    if (this.consume('itemShield')) out.useItem = 'shield';
    if (out.heal && !out.useItem) out.useItem = 'bandage';

    // 切枪
    if (this.consume('slot0')) out.slot = 0;
    if (this.consume('slot1')) out.slot = 1;

    // 标记
    if (this.consume('ping')) { out.ping = true; out.pingKind = 'move'; }

    // 清理过期脉冲
    const now = performance.now();
    for (const [key, expiry] of this.pulses) if (expiry < now) this.pulses.delete(key);

    if (this.app?.hud) {
      this.app.hud.toggleSprint = false;
      this.app.hud.toggleCrouch = false;
    }
    return out;
  }
}

export default InputController;
