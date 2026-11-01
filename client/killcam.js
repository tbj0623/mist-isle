// 雾岛突围 / MIST ISLE — 死亡回放（Killcam）· 最小版
// 只做三件事：① 相机平滑移到击杀者上方 12m ② 3 秒后 resolve ③ stop() 可中断。
// 慢动作 / 高亮 / 渐变留到后续迭代。scene 接口全部走可选链，缺东西就安全降级。
const DURATION_MS = 3000;
const FIT_MS = 600;      // 相机就位时间
const HEIGHT = 12;

const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** 从回放帧里取某玩家最后一帧的坐标（找不到返回 null）。 */
function lastPosOf(frames, id) {
  if (!Array.isArray(frames) || id == null) return null;
  for (let i = frames.length - 1; i >= 0; i--) {
    const rows = frames[i]?.p;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && row[0] === id) return { x: finite(row[1]), z: finite(row[2]) };
    }
  }
  return null;
}

export class Killcam {
  constructor(scene) {
    this.scene = scene || null;
    this._resolve = null;
    this._raf = 0;
    this._timer = 0;
    this._from = null;
    this._to = null;
    this._start = 0;
    this._playing = false;
    this._lastData = null;
  }

  get playing() { return this._playing; }

  play(data) {
    this.stop(); // 重入：上一轮直接 resolve，避免 Promise 悬挂
    const cam = this.scene?.camera;
    if (!cam || !cam.position) return Promise.resolve();
    const target = this._targetOf(data);
    if (!target) return Promise.resolve();
    this._playing = true;
    this._lastData = data || null;
    this._from = { x: finite(cam.position.x), y: finite(cam.position.y, 30), z: finite(cam.position.z) };
    this._to = target;
    this._start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._timer = setTimeout(() => this.stop(), DURATION_MS);
      this._loop();
    });
  }

  /** 击杀者坐标：优先用回放帧（服务端采样），退回场景里的实时实体。 */
  _targetOf(data) {
    if (!data) return null;
    const id = data.killerId ?? null;
    const pos = lastPosOf(data.frames, id);
    if (pos) return { x: pos.x, y: HEIGHT, z: pos.z };
    // 兜底：击杀者已在场上但没进帧（例如数据裁剪）时，用实体位置
    const entry = this.scene?.players?.get?.(id) || this.scene?.entities?.get?.(id);
    const src = entry?.target || entry?.source || entry?.player || entry;
    if (src && Number.isFinite(Number(src.x))) {
      return { x: finite(src.x), y: HEIGHT, z: finite(src.z) };
    }
    return null;
  }

  _loop() {
    if (!this._playing) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const cam = this.scene?.camera;
    if (!cam) { this.stop(); return; }
    const k = Math.min(1, Math.max(0, (now - this._start) / FIT_MS));
    const e = 1 - (1 - k) * (1 - k); // easeOutQuad
    const from = this._from;
    const to = this._to;
    const px = from.x + (to.x - from.x) * e;
    const py = from.y + (to.y - from.y) * e;
    const pz = from.z + (to.z - from.z) * e;
    if (typeof cam.position.set === 'function') cam.position.set(px, py, pz);
    else { cam.position.x = px; cam.position.y = py; cam.position.z = pz; }
    try { cam.lookAt(to.x, 0.8, to.z); } catch { /* 相机不可用就只移动 */ }
    // app.suspended 期间主循环不渲染，这里自己撑住画面（就位后保持镜头继续渲染）。
    try {
      if (this.scene?.renderer && this.scene?.scene) this.scene.renderer.render(this.scene.scene, cam);
    } catch { /* 渲染失败不影响计时 */ }
    this._raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => this._loop())
      : setTimeout(() => this._loop(), 16);
  }

  /** @param {boolean} silent true=内部重入，不重复 resolve 上一轮的 Promise */
  stop(silent = false) {
    if (this._timer) { clearTimeout(this._timer); this._timer = 0; }
    if (this._raf) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
      else clearTimeout(this._raf);
      this._raf = 0;
    }
    this._playing = false;
    const done = this._resolve;
    this._resolve = null;
    if (done && !silent) done();
  }

  /** 当前回放数据（调试/后续扩展用）。 */
  get data() { return this._lastData; }
}
