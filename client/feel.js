// 雾岛突围 / MIST ISLE 1.1 — 手感调度器（owner: feel · client/feel.js）
// 统一管理 hitstop / 方向性镜头反馈 / 受击红边 / 击杀确认 / 慢动作 / 死亡降速。
// 设计原则：所有外部依赖都「可选链 + 本地兜底」，scene/audio/input/hud 任一为 null 时静默跳过；
// 绝不修改 scene.js —— 相机偏移通过包装 renderer.render 在真正绘制前注入、绘制后还原。
import {
  showHitFlash, showKillBanner, showDamageNumber, showStreakHint,
  showLowHpVignette, showSlowmoRings, showHealPulse, showDeathDesat,
  setFeedbackReducedMotion,
} from './ui-feedback.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 确定性噪声：三层正弦叠加。绝不用 Math.random —— 每帧随机只会抖成癫痫。 */
export function feelNoise(t, seed = 0) {
  return Math.sin(t * 1.07 + seed) * 0.6 + Math.sin(t * 2.41 + 1.7 + seed) * 0.3 + Math.sin(t * 5.13 + 4.2 + seed) * 0.1;
}

// hitstop 时长（ms）：普通命中不顿帧，爆头 45，击杀 80
const HITSTOP_MS = { hit: 0, headshot: 45, kill: 80 };
const HITSTOP_SCALE = 0.02;     // 「几乎静止」而非真暂停：模拟/网络都还在跑
const REDUCED_HITSTOP_SCALE = 0.32; // 减少动态效果时保留节奏感，但不闪断
const DEATH_MS = 1200;
const DEATH_SCALE = 0.3;
const MULTI_WINDOW = 2600;      // 多杀判定窗口（ms）
const MULTI_LABEL = ['', '', '双杀', '三杀', '四杀', '团灭'];
const LOW_HP = 0.32;            // 低血量暗角阈值
const LETHAL_HP = 0.18;         // 耳鸣阈值

export class FeelDirector {
  constructor({ scene = null, audio = null, input = null, hud = null, settings = null } = {}) {
    this.scene = scene; this.audio = audio; this.input = input; this.hud = hud;
    // settings 允许传对象或 getter：main.js 的 app.settings 每次 applySettings 都会整体替换
    this._settings = typeof settings === 'function' ? settings : () => settings || {};
    this.reducedMotion = false;
    this.screenShake = 1;
    this._scale = 1; this._hitstopUntil = 0; this._slowUntil = 0; this._slowScale = 1;
    this._deathUntil = 0; this._t = 0; this._lastNow = 0;
    // 相机：_kick 是瞬时冲量（每帧 ×0.82 衰减），_off 是弹簧跟随的实际偏移
    this._kick = { x: 0, y: 0, z: 0 };
    this._off = { x: 0, y: 0, z: 0 };
    this._lift = 0; this._rumble = 0; this._fovKick = 0;
    this._hooked = null; this._origRender = null;
    this._killTimes = []; this._lowHp = false; this._tinnitusAt = 0;
    this.stats = { hits: 0, headshots: 0, kills: 0, damage: 0, hitstops: 0, maxMulti: 0 };
    this._applySettings();
  }

  // ── 设置 ────────────────────────────────────────────────────────────────
  /** 每帧读一次设置：reducedMotion（强度降 60%）与 screenShake（0–1 倍率）。 */
  _applySettings() {
    const s = this._settings() || {};
    const rm = !!s.reducedMotion;
    if (rm !== this.reducedMotion) {
      this.reducedMotion = rm;
      try { setFeedbackReducedMotion(rm); } catch { /* 无 DOM 时忽略 */ }
    }
    const shake = s.screenShake;
    this.screenShake = Number.isFinite(Number(shake)) ? clamp(Number(shake), 0, 1) : 1;
    return s;
  }

  // ── 时间控制 ─────────────────────────────────────────────────────────────
  get timeScale() {
    return this._resolveScale(nowMs());
  }

  /** 命中定格：把时间压到 0.02 持续 ms 毫秒（不是暂停，模拟与网络照常跑）。 */
  hitstop(ms) {
    const d = clamp(num(ms), 0, 400);
    if (d <= 0) return 0;
    this._hitstopUntil = Math.max(this._hitstopUntil, nowMs() + d);
    this.stats.hitstops++;
    return d;
  }

  /** 慢动作：timeScale 压到 scale，持续 ms 毫秒后自动恢复 1。 */
  slowmo(scale, ms) {
    const s = clamp(num(scale, 1), 0.05, 1);
    const d = clamp(num(ms), 0, 5000);
    if (s >= 1 || d <= 0) return;
    this._slowScale = Math.min(this._slowScale, s);
    this._slowUntil = Math.max(this._slowUntil, nowMs() + d);
  }

  _resolveScale(now) {
    if (now < this._hitstopUntil) return this.reducedMotion ? Math.max(REDUCED_HITSTOP_SCALE, HITSTOP_SCALE) : HITSTOP_SCALE;
    if (now < this._slowUntil) return this.reducedMotion ? Math.max(0.7, this._slowScale) : this._slowScale;
    this._slowScale = 1;
    return 1;
  }

  /** 主循环调用：推进反馈弹簧并返回缩放后的 dt（渲染/插值用；网络与模拟用原始 dt）。 */
  update(dt) {
    const raw = clamp(num(dt), 0, 0.25);
    this._applySettings();
    const now = nowMs();
    const real = this._lastNow ? clamp((now - this._lastNow) / 1000, 0.0001, 0.25) : raw;
    this._lastNow = now;
    this._t += real;
    this._advance(real);
    const scale = this._resolveScale(now);
    this._scale = scale;
    this._syncLowHp();
    if (now > this._deathUntil && this._deathUntil) { this._deathUntil = 0; showDeathDesat(false); }
    return raw * scale;
  }

  /** 相机弹簧：冲量按 0.82/帧 衰减，偏移量用指数弹簧跟随，叠加确定性噪声。 */
  _advance(dt) {
    const step = Math.max(0.0001, dt);
    const decay = Math.pow(0.82, step * 60);
    this._kick.x *= decay; this._kick.y *= decay; this._kick.z *= decay;
    this._rumble *= decay;
    this._fovKick *= Math.pow(0.86, step * 60);
    const k = 1 - Math.exp(-30 * step);
    this._off.x += (this._kick.x - this._off.x) * k;
    this._off.y += (this._kick.y - this._off.y) * k;
    this._off.z += (this._kick.z - this._off.z) * k;
    if (this._lift > 0.001) { this._lift *= Math.pow(0.965, step * 60); if (this._lift < 0.004) this._lift = 0; }
    if (this._rumble > 0.002 && this.screenShake > 0.001) {
      // 确定性噪声：同样的时间输入永远给同样的抖动，不会逐帧乱跳
      const a = this._t * 46;
      const s = this._rumble * 0.05 * (this.reducedMotion ? 0.4 : 1);
      this._off.x += feelNoise(a, 0.7) * s;
      this._off.y += feelNoise(a * 1.3, 2.1) * s * 0.6;
      this._off.z += feelNoise(a * 0.9, 4.4) * s;
    }
  }

  /** 方向冲量：朝 angle 的反方向推相机（射击后坐 / 受击后退），mag 为世界单位。 */
  _kickCamera(angle, mag, lift = 0) {
    const m = mag * this.screenShake * (this.reducedMotion ? 0.4 : 1);
    this._kick.x -= Math.sin(angle) * m;
    this._kick.z -= Math.cos(angle) * m;
    this._kick.y += lift * this.screenShake * (this.reducedMotion ? 0.4 : 1);
  }

  /**
   * 包装 renderer.render：绘制前把偏移/FOV 冲量加到相机上，绘制后立刻还原。
   * 这样 scene.js 的相机逻辑完全不受污染（下一帧仍从干净状态开始）。
   */
  _installHook() {
    if (this._hooked && this._hooked.__feelHooked) return this._hooked;
    const r = this.scene && this.scene.renderer;
    if (!r || typeof r.render !== 'function' || r.__feelHooked) return null;
    const orig = r.render.bind(r);
    const self = this;
    r.render = function feelRender(scene3, camera) {
      const cam = camera || self.scene?.camera;
      const o = self._off;
      const lift = self._lift || 0;
      const fovKick = self._fovKick;
      const useFov = Math.abs(fovKick) > 0.01;
      let px = 0; let py = 0; let pz = 0; let fov0 = 0; const touched = !!(cam && (o.x || o.y || o.z || lift > 0.001 || useFov));
      if (touched) {
        px = cam.position.x; py = cam.position.y; pz = cam.position.z;
        cam.position.set(px + o.x, py + o.y + lift, pz + o.z);
        if (useFov) { fov0 = cam.fov; cam.fov = Math.max(18, fov0 + fovKick); cam.updateProjectionMatrix(); }
      }
      const out = orig(scene3, cam || camera);
      if (touched) {
        cam.position.set(px, py, pz);
        if (useFov) { cam.fov = fov0; cam.updateProjectionMatrix(); }
      }
      return out;
    };
    r.__feelHooked = true;
    this._hooked = r;
    this._origRender = orig;
    return r;
  }

  // ── 公共 API：命中反馈 ───────────────────────────────────────────────────
  /** kind: 'hit' | 'headshot' | 'kill'；targetX/targetZ 为被命中目标的世界坐标（飘字与方向用，可缺省）。 */
  onHit({ kind, damage = 0, distance = 0, headshot = false, killed = false, targetX, targetZ } = {}) {
    const killedFlag = !!killed || kind === 'kill';
    const head = !!headshot || kind === 'headshot';
    const tier = killedFlag ? 'kill' : head ? 'headshot' : 'hit';
    const dmg = Math.max(0, num(damage));
    const dist = Math.max(0, num(distance));
    this.stats.hits++;
    if (head) this.stats.headshots++;
    this._installHook();

    // 1) hitstop：普通 0 / 爆头 45 / 击杀 80；>60m 起衰减，避免远程点名顿得难受
    const base = HITSTOP_MS[tier] || 0;
    if (base > 0) this.hitstop(base * (dist > 90 ? 0.5 : dist > 60 ? 0.75 : 1));

    // 2) 相机：向「目标→射手」反推（后坐），不是随机抖
    const ang = this._aimAngle(targetX, targetZ);
    const kick = this.reducedMotion ? 0.4 : 1;
    this._kickCamera(ang, (tier === 'kill' ? 0.34 : head ? 0.26 : 0.16) * kick,
      (head || killedFlag) ? 0.06 * kick : 0.02 * kick);
    this._rumble += (tier === 'kill' ? 0.28 : head ? 0.2 : 0.12) * this.screenShake;
    if (head || killedFlag) this._fovKick -= 0.55 * this.screenShake;

    // 3) 音频：命中音 + 爆头额外高频音；4) 震动：12 / 25 / [15,30,15]
    this._sfx(head ? 'headshot' : 'hit', { local: true, vol: 0.8 });
    if (head) this._sfx('hitmarker_head', { local: true, vol: 0.55, pitch: 1.2 });
    this._haptic(tier === 'kill' ? [15, 30, 15] : head ? 25 : 12);

    // 5) DOM：伤害飘字（击杀交给 onKill 的徽章）
    if (!killedFlag) this._damageNumber(targetX, targetZ, dmg, head ? 'headshot' : 'normal');
    return tier;
  }

  // ── 公共 API：受击反馈 ───────────────────────────────────────────────────
  /** fromAngle：攻击者相对自己的世界角度（0=+Z）。heavy 加长震动与红边。 */
  onDamage({ damage = 0, fromAngle = 0, heavy = false } = {}) {
    const dmg = Math.max(0, num(damage));
    const ang = num(fromAngle);
    this.stats.damage += dmg;

    // 1) 相机：向受击反方向偏移 1–3px + 回弹
    this._kickCamera(ang, (heavy ? 0.14 : 0.075) + Math.min(0.06, dmg / 900), -0.02);
    this._rumble += (heavy ? 0.34 : 0.2) * this.screenShake;

    // 2) 屏幕：方向性红边（不是全屏红）
    try { showHitFlash(Math.PI - ang, clamp(0.32 + dmg / 110 + (heavy ? 0.25 : 0), 0.2, 1)); }
    catch { /* 无 DOM 时忽略 */ }

    // 3) 音频：低频 thud；血量低时叠耳鸣。4) 震动：20ms，heavy 加长
    this._sfx('hurt', { local: true, vol: clamp(0.5 + dmg / 160, 0.5, 1), pitch: heavy ? 0.9 : 1 });
    this._syncLowHp(); // 走统一入口：低血量暗角与 _lowHp 状态必须一起更新
    if (this._hpRatio() <= LETHAL_HP) this._tinnitus();
    this._haptic(heavy ? [20, 18, 26] : 20);
    return dmg;
  }

  // ── 公共 API：击杀确认 ───────────────────────────────────────────────────
  onKill({ targetName = '', headshot = false, multiKill = 0 } = {}) {
    const now = nowMs();
    this._killTimes.push(now);
    while (this._killTimes.length && now - this._killTimes[0] > MULTI_WINDOW) this._killTimes.shift();
    const multi = Math.max(num(multiKill), this._killTimes.length, 1);
    this.stats.kills++;
    this.stats.maxMulti = Math.max(this.stats.maxMulti, multi);

    // 1) hitstop 80ms + 慢动作 0.15s（0.6 → 1）
    this.hitstop(HITSTOP_MS.kill);
    this.slowmo(0.6, 150);

    // 2) 相机 / FOV：一次短促拉近
    this._kickCamera(this._aimAngle(), 0.3, 0.12);
    this._fovKick -= 1.1 * this.screenShake;
    this._rumble += 0.3 * this.screenShake;

    // 3) 音频：分层击杀音，multiKill 升调。5) 震动：三段
    this._sfx('kill', { local: true, vol: 0.95, pitch: clamp(1 + (multi - 1) * 0.08, 1, 1.4) });
    this._sfx('headshot', { local: true, vol: 0.45, pitch: 1.3 });
    if (multi >= 2) this._sfx('levelup', { local: true, vol: 0.5, pitch: 1.05 + multi * 0.04 });
    this._haptic([15, 30, 15]);

    // 4) 屏幕：中心徽章放大→淡出 + 连杀提示
    try {
      showKillBanner({ name: targetName, headshot: !!headshot, multiKill: multi });
      if (multi >= 2) showStreakHint(MULTI_LABEL[Math.min(multi, MULTI_LABEL.length - 1)]);
    } catch { /* 无 DOM 时忽略 */ }
    return multi;
  }

  // ── 公共 API：死亡 ───────────────────────────────────────────────────────
  onDeath() {
    // 时间放缓到 0.3（1.2s）→ 恢复；reducedMotion 时不压时间只做视觉
    if (!this.reducedMotion) {
      this._slowScale = Math.min(this._slowScale, DEATH_SCALE);
      this._slowUntil = Math.max(this._slowUntil, nowMs() + DEATH_MS);
    }
    this._deathUntil = nowMs() + DEATH_MS + 1200;
    this._installHook();

    // 相机拉高（持续 1.2s 的缓慢抬升，走独立通道，不跟 0.82/帧 的冲量一起衰减）
    this._lift = Math.min(6, this._lift + 3.4 * this.screenShake);
    this._kick.z += 1.2 * this.screenShake;
    this._fovKick -= 3.4 * this.screenShake;
    this._rumble += 0.5;

    this._sfx('death', { local: true, vol: 1 });
    try { showDeathDesat(true); showHitFlash(Math.PI, 0.9); } catch { /* 无 DOM 时忽略 */ }
    this._haptic([30, 60, 30]);
    return DEATH_MS;
  }

  // ── 公共 API：拾取 / 换弹 / 治疗 ─────────────────────────────────────────
  onPickup({ rarity = 'common' } = {}) {
    const scale = { legendary: 1.6, epic: 1.35, rare: 1.15, uncommon: 1.05, common: 1 }[rarity] || 1;
    this._sfx('pickup', { local: true, vol: 0.6 * scale, pitch: 1 + (scale - 1) * 0.25 });
    // 稀有度越高：一段短促金色推镜 + 更强震动
    if (scale >= 1.15) {
      this._fovKick -= 0.35 * scale * this.screenShake;
      this._rumble += 0.1 * scale * this.screenShake;
      this._haptic(Math.round(10 * scale));
    }
    return scale;
  }

  onReload() {
    this._sfx('reload', { local: true, vol: 0.5 });
    this._kick.y -= 0.03 * this.screenShake;
    this._haptic(8);
  }

  onHealDone() {
    this._sfx('heal_done', { local: true, vol: 0.75 });
    this._fovKick += 0.3 * this.screenShake;
    this._haptic(14);
    try { showHealPulse(); } catch { /* 无 DOM 时忽略 */ }
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────────
  /** 瞄准角：没有目标点时用主角朝向；都没有则用相机 yaw。 */
  _aimAngle(tx, tz) {
    const sc = this.scene;
    const self = sc?.state?.players?.find?.((p) => p.id === sc.selfId);
    if (Number.isFinite(tx) && Number.isFinite(tz) && self && Number.isFinite(self.x)) {
      const dx = num(tx) - num(self.x);
      const dz = num(tz) - num(self.z);
      if (dx * dx + dz * dz > 0.04) return Math.atan2(dx, dz);
    }
    if (self && Number.isFinite(self.angle)) return self.angle;
    return num(sc?.camYaw);
  }

  _hpRatio() {
    const me = this._me();
    if (!me) return 1;
    return clamp(num(me.hp, 100) / (num(me.maxHp, 100) || 100), 0, 1);
  }

  _me() {
    const st = this.scene?.state;
    if (!st || !Array.isArray(st.players)) return null;
    return st.players.find((p) => p.id === this.scene.selfId) || null;
  }

  _syncLowHp() {
    const low = this._hpRatio() <= LOW_HP;
    // 不能只比较状态就 return：onDamage 会先动 _lowHp，暗角节点可能还没真正点亮，
    // 必须每次都把 DOM 状态与逻辑状态对齐（幂等，开销只有一次 classList 检查）。
    this._lowHp = low;
    try { showLowHpVignette(low); } catch { /* 无 DOM 时忽略 */ }
  }

  /** 耳鸣：正弦细线 + 指数衰减，2.5s 冷却，避免连续受击刺耳。 */
  _tinnitus() {
    const now = nowMs();
    if (now - this._tinnitusAt < 2500) return;
    this._tinnitusAt = now;
    const audio = this.audio;
    const ctx = audio && audio.ctx;
    if (!ctx || ctx.state !== 'running' || typeof ctx.createOscillator !== 'function') return;
    try {
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const dest = typeof audio._bus === 'function' ? audio._bus('ui') : audio.master;
      if (!dest) return;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(4200, t0);
      osc.frequency.exponentialRampToValueAtTime(3300, t0 + 1.1);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.035, t0 + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
      osc.connect(gain); gain.connect(dest);
      osc.start(t0); osc.stop(t0 + 1.25);
    } catch { /* WebAudio 不可用时静默 */ }
  }

  _damageNumber(x, z, amount, kind) {
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    const h = typeof window !== 'undefined' ? window.innerHeight : 0;
    if (!(amount > 0) || !Number.isFinite(x) || !Number.isFinite(z) || !this.scene?.camera || !w || !h) return;
    // 俯视角近似投影：按相机跟随点 + camDist 做透视缩放，避免为一次飘字做 raycast
    const cx = num(this.scene.follow?.x, num(x));
    const cz = num(this.scene.follow?.z, num(z));
    const dist = Math.max(8, num(this.scene.camDist, 30));
    const px = ((x - cx) / dist) * h * 1.6 + w * 0.5;
    const py = ((z - cz) / dist) * h * 1.1 + h * 0.52;
    try {
      showDamageNumber(clamp(px, 8, w - 8), clamp(py, 40, h - 40), amount, kind);
    } catch { /* 无 DOM 时忽略 */ }
  }

  _sfx(name, opts) {
    const audio = this.audio;
    if (!audio || typeof audio.play !== 'function') return false;
    try { return audio.play(name, opts || {}); } catch { return false; }
  }

  _haptic(pattern) {
    const input = this.input;
    if (!input) return false;
    try {
      if (typeof input.haptics === 'function') return input.haptics(pattern);
      if (typeof input.haptic === 'function') return input.haptic(pattern);
    } catch { /* 无震动设备时忽略 */ }
    return false;
  }

  /** 慢动作视觉：径向线。onKill / onDeath / 外部（如决赛圈开启）可直接调。 */
  slowmoFx() {
    try { showSlowmoRings(); } catch { /* 无 DOM 时忽略 */ }
  }

  dispose() {
    const r = this._hooked;
    if (r && r.__feelHooked && this._origRender) {
      try { r.render = this._origRender; delete r.__feelHooked; } catch { /* 忽略 */ }
    }
    this._hooked = null; this._origRender = null;
    this._kick = { x: 0, y: 0, z: 0 }; this._off = { x: 0, y: 0, z: 0 };
    this._lift = 0; this._rumble = 0; this._fovKick = 0;
    this._hitstopUntil = 0; this._slowUntil = 0; this._slowScale = 1; this._deathUntil = 0;
    try { showLowHpVignette(false); showDeathDesat(false); } catch { /* 无 DOM 时忽略 */ }
  }
}
