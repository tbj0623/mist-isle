// 雾岛突围 / MIST ISLE 1.1 — DOM 反馈层（owner: feel · client/ui-feedback.js）
// 只负责「看得见的 DOM 打击反馈」：方向性红边 / 击杀徽章 / 伤害飘字 / 连杀提示 /
// 低血量暗角 / 慢动作径向线 / 治疗脉冲 / 死亡去饱和。
// 全部样式在运行时注入 <style>，不改 client/style.css；所有节点 pointer-events:none。
// 约定：#feel-layer 的**直接子节点固定 5 个**（flash/center/nums/hp/rings），
// 其余反馈都是这 5 个容器内的临时节点，用完即删，避免长时间对局积累 DOM。

const LAYER_ID = 'feel-layer';
const STYLE_ID = 'feel-style';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

let layer = null;
let styleEl = null;
let reduced = false;
let bannerNode = null;
let flashTimer = 0;
let hpTimer = 0;
let hpAnim = null;
let deathTimer = 0;

const CSS = `
#feel-layer{position:fixed;inset:0;z-index:26;pointer-events:none;overflow:hidden;contain:layout style;}
#feel-layer>*{pointer-events:none;will-change:transform,opacity;}
#feel-layer .feel-flash{position:absolute;inset:0;opacity:0;background:conic-gradient(from 0deg at 50% 50%,rgba(255,60,44,0) 0deg,rgba(255,54,38,.98) 22deg,rgba(255,116,66,.72) 40deg,rgba(255,60,44,0) 66deg);-webkit-mask-image:radial-gradient(ellipse 74% 70% at 50% 50%,transparent 34%,rgba(0,0,0,.85) 74%,#000 100%);mask-image:radial-gradient(ellipse 74% 70% at 50% 50%,transparent 34%,rgba(0,0,0,.85) 74%,#000 100%);}
#feel-layer .feel-center{position:absolute;inset:0;display:grid;place-items:center;align-content:center;}
#feel-layer .feel-nums{position:absolute;inset:0;}
#feel-layer .feel-hp{position:absolute;inset:0;opacity:0;transition:opacity .4s ease;box-shadow:inset 0 0 9vmin 3vmin rgba(196,20,12,.55),inset 0 0 22vmin 6vmin rgba(120,8,4,.35);}
#feel-layer .feel-hp.on{opacity:.85;}
#feel-layer .feel-rings{position:absolute;inset:0;opacity:0;background:repeating-conic-gradient(from 0deg at 50% 50%,rgba(240,248,255,.5) 0deg .35deg,transparent .35deg 5deg);-webkit-mask-image:radial-gradient(circle at 50% 50%,transparent 26%,#000 62%,transparent 88%);mask-image:radial-gradient(circle at 50% 50%,transparent 26%,#000 62%,transparent 88%);}
#feel-layer .kill-banner{display:grid;justify-items:center;gap:2px;padding:10px 26px 12px;border-radius:14px;background:linear-gradient(180deg,rgba(10,20,24,.74),rgba(10,20,24,.26));border:1px solid rgba(255,214,140,.35);box-shadow:0 8px 40px rgba(0,0,0,.45);}
#feel-layer .kill-banner .kb-tag{font-size:12px;letter-spacing:.42em;color:#ffd98a;}
#feel-layer .kill-banner .kb-name{font-size:28px;font-weight:800;color:#fff;text-shadow:0 2px 18px rgba(255,96,60,.55);}
#feel-layer .kill-banner.headshot .kb-name{color:#ffd166;}
#feel-layer .feel-streak{margin-top:10px;font-size:14px;font-weight:700;letter-spacing:.3em;color:#ffb066;text-shadow:0 0 16px rgba(255,120,40,.6);}
#feel-layer .feel-num{position:absolute;transform:translate(-50%,-50%);font-weight:800;font-size:20px;color:#f4f8fb;text-shadow:0 2px 8px rgba(0,0,0,.65);font-variant-numeric:tabular-nums;}
#feel-layer .feel-num.headshot{color:#ffd166;font-size:26px;}
#feel-layer .feel-num.kill{color:#ff6b52;font-size:28px;}
#feel-layer .feel-num.heal{color:#7fe08a;}
#feel-layer .feel-heal{position:absolute;inset:0;background:radial-gradient(circle at 50% 52%,rgba(96,230,140,.3),transparent 62%);}
@media (prefers-reduced-motion:reduce){#feel-layer .feel-hp{transition:none;}}
`;

function injectStyle() {
  if (styleEl && styleEl.isConnected) return;
  styleEl = document.getElementById(STYLE_ID);
  if (styleEl) return;
  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = CSS;
  (document.head || document.documentElement).append(styleEl);
}

function el(tag, cls, parent) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (parent) parent.append(node);
  return node;
}

function adopt(root, cls) {
  let node = root.querySelector(`.${cls}`);
  if (!node) { node = el('div', cls, root); }
  return node;
}

/** 创建（或复用）#feel-layer。可重复调用；被 destroy 之后会重建。 */
export function ensureFeedbackLayer() {
  if (layer && layer.el && layer.el.isConnected) return layer;
  injectStyle();
  let root = document.getElementById(LAYER_ID);
  if (!root) {
    root = el('div', null, document.body || document.documentElement);
    root.id = LAYER_ID;
    root.setAttribute('aria-hidden', 'true');
  }
  layer = {
    el: root,
    flash: adopt(root, 'feel-flash'),
    center: adopt(root, 'feel-center'),
    nums: adopt(root, 'feel-nums'),
    hp: adopt(root, 'feel-hp'),
    rings: adopt(root, 'feel-rings'),
  };
  return layer;
}

function removeAfter(node, ms) {
  if (!node) return null;
  return setTimeout(() => { try { node.remove(); } catch { /* 已移除 */ } }, Math.max(16, ms));
}

/** 播放一次 WAAPI 动画并在结束后删除；reducedMotion 时只落最终态。 */
function run(node, frames, opts = {}, lifeMs = 900) {
  if (!node) return null;
  if (reduced) {
    const last = frames[frames.length - 1] || {};
    if (last.opacity !== undefined) node.style.opacity = String(last.opacity);
    if (last.transform) node.style.transform = last.transform;
    removeAfter(node, Math.min(lifeMs, 240));
    return null;
  }
  let anim = null;
  try {
    anim = node.animate(frames, { fill: 'forwards', ...opts });
    anim.finished.then(() => node.remove()).catch(() => { /* 被 cancel */ });
  } catch {
    removeAfter(node, lifeMs);
    return null;
  }
  removeAfter(node, lifeMs + 500); // 兜底：页面不可见时 WAAPI 回调可能不触发
  return anim;
}

/** 方向性红边：angle 为屏幕角（弧度，0=正上方，顺时针），intensity 0–1。 */
export function showHitFlash(angle = 0, intensity = 0.6) {
  const host = ensureFeedbackLayer();
  const node = host.flash;
  const deg = ((Number(angle) || 0) * 180) / Math.PI;
  const k = clamp(Number(intensity) || 0, 0, 1);
  const alpha = (0.42 + k * 0.55).toFixed(2);
  node.style.background = `conic-gradient(from ${deg.toFixed(1)}deg at 50% 50%,rgba(255,60,44,0) 0deg,`
    + `rgba(255,54,38,${alpha}) 22deg,rgba(255,116,66,${(alpha * 0.72).toFixed(2)}) 40deg,rgba(255,60,44,0) 66deg)`;
  clearTimeout(flashTimer);
  for (const anim of node.getAnimations?.() || []) { try { anim.cancel(); } catch { /* 忽略 */ } }
  if (reduced) {
    node.style.opacity = String(0.3 + k * 0.3);
    flashTimer = setTimeout(() => { node.style.opacity = '0'; }, 140);
    return node;
  }
  node.style.opacity = '0';
  try {
    node.animate([{ opacity: Math.min(1, 0.62 + k * 0.38) }, { opacity: 0 }],
      { duration: 260, easing: 'ease-out', fill: 'none' });
  } catch { /* 忽略：老 WebView 无 WAAPI */ }
  return node;
}

/** 居中击杀徽章；name 为目标名，multiKill ≥2 时附带连杀角标。 */
export function showKillBanner({ name = '', headshot = false, multiKill = 0 } = {}) {
  const host = ensureFeedbackLayer();
  if (bannerNode) { try { bannerNode.remove(); } catch { /* 忽略 */ } bannerNode = null; }
  const node = el('div', `kill-banner feel-kill-banner${headshot ? ' headshot' : ''}`, host.center);
  const tag = el('span', 'kb-tag', node);
  tag.textContent = headshot ? '爆头淘汰' : '淘汰';
  const title = el('strong', 'kb-name', node);
  title.textContent = name ? String(name).slice(0, 16) : '目标已清除';
  bannerNode = node;
  const life = 1150;
  run(node, [
    { opacity: 0, transform: 'scale(.62)' },
    { opacity: 1, transform: 'scale(1.12)', offset: 0.18 },
    { opacity: 1, transform: 'scale(1)', offset: 0.62 },
    { opacity: 0, transform: 'scale(.98)' },
  ], { duration: life, easing: 'cubic-bezier(.2,.9,.25,1)' }, life);
  return node;
}

/** 连杀提示（双杀/三杀/…），出现在徽章下方。 */
export function showStreakHint(kind) {
  const host = ensureFeedbackLayer();
  const label = kind ? String(kind) : '连杀';
  const node = el('div', 'feel-streak', host.center);
  node.textContent = label;
  run(node, [
    { opacity: 0, transform: 'translateY(14px) scale(.9)' },
    { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.2 },
    { opacity: 0, transform: 'translateY(-12px) scale(1.02)' },
  ], { duration: 900, easing: 'ease-out' }, 900);
  return node;
}

/** 伤害飘字。x/y 为视口坐标（px），kind: normal | headshot | kill | heal。 */
export function showDamageNumber(x, y, amount, kind = 'normal') {
  const host = ensureFeedbackLayer();
  const value = Math.round(Math.abs(Number(amount) || 0));
  if (!value) return null;
  // 连发时最多同时存在 6 个飘字：超出立刻掐掉最旧的，避免 DOM 堆积
  while (host.nums.childElementCount >= 6) host.nums.firstElementChild?.remove();
  const node = el('span', `feel-num ${kind}`, host.nums);
  node.textContent = kind === 'heal' ? `+${value}` : String(value);
  node.style.left = `${clamp(Number(x) || 0, 0, window.innerWidth || 0)}px`;
  node.style.top = `${clamp(Number(y) || 0, 0, window.innerHeight || 0)}px`;
  const rise = kind === 'kill' ? -54 : -34;
  const life = kind === 'headshot' || kind === 'kill' ? 900 : 700;
  run(node, [
    { opacity: 0, transform: 'translate(-50%,-50%) scale(.7)' },
    { opacity: 1, transform: `translate(-50%,calc(-50% + ${rise * 0.45}px)) scale(1.06)`, offset: 0.22 },
    { opacity: 0, transform: `translate(-50%,calc(-50% + ${rise}px)) scale(.94)` },
  ], { duration: life, easing: 'cubic-bezier(.2,.8,.3,1)' }, life);
  return node;
}

/** 低血量持续暗角 + 心跳脉冲；on=false 关闭。幂等：重复同一状态不重建动画。 */
export function showLowHpVignette(on) {
  const host = ensureFeedbackLayer();
  const node = host.hp;
  if (!on) {
    clearTimeout(hpTimer);
    hpTimer = 0;
    if (hpAnim) { try { hpAnim.cancel(); } catch { /* 忽略 */ } hpAnim = null; }
    node.classList.remove('on');
    node.style.opacity = '0';
    return;
  }
  if (node.classList.contains('on') && (reduced || hpAnim)) return; // 已经亮着
  clearTimeout(hpTimer);
  node.classList.add('on');
  if (hpAnim) { try { hpAnim.cancel(); } catch { /* 忽略 */ } hpAnim = null; }
  hpTimer = setTimeout(() => showLowHpVignette(false), 12000); // 兜底：血量读数丢了也不会永久红屏
  if (reduced) return;
  try {
    hpAnim = node.animate([
      { opacity: 0.55 }, { opacity: 0.9, offset: 0.12 }, { opacity: 0.62, offset: 0.3 }, { opacity: 0.9, offset: 0.42 },
    ], { duration: 1150, iterations: Infinity, easing: 'ease-in-out' });
  } catch { hpAnim = null; }
}

/** 慢动作径向线条：短促一组，向中心收。 */
export function showSlowmoRings() {
  const host = ensureFeedbackLayer();
  const node = host.rings;
  if (reduced) {
    node.style.opacity = '0.24';
    setTimeout(() => { node.style.opacity = '0'; }, 220);
    return node;
  }
  try { for (const a of node.getAnimations?.() || []) a.cancel(); } catch { /* 忽略 */ }
  node.style.opacity = '0';
  try {
    node.animate([
      { opacity: 0, transform: 'scale(1.16)' },
      { opacity: 0.55, transform: 'scale(1)', offset: 0.25 },
      { opacity: 0, transform: 'scale(.94)' },
    ], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'none' });
  } catch { /* 忽略 */ }
  return node;
}

/** 治疗完成：中心柔和绿光一次性脉冲。 */
export function showHealPulse() {
  const host = ensureFeedbackLayer();
  const node = el('div', 'feel-heal', host.center);
  run(node, [
    { opacity: 0, transform: 'scale(.8)' },
    { opacity: 1, transform: 'scale(1)', offset: 0.25 },
    { opacity: 0, transform: 'scale(1.06)' },
  ], { duration: 620, easing: 'ease-out' }, 620);
  return node;
}

/** 死亡/结算：整页缓慢去饱和。返回取消函数；reducedMotion 时不做。 */
export function showDeathDesat(on = true) {
  const root = document.documentElement;
  clearTimeout(deathTimer);
  if (!on) { root.style.filter = ''; return; }
  if (reduced) return;
  root.style.transition = 'filter 900ms ease-out';
  root.style.filter = 'saturate(.35) contrast(1.04)';
  deathTimer = setTimeout(() => { root.style.filter = ''; }, 2600);
}

/** 供 FeelDirector 同步设置；reducedMotion 时所有动画降级为最终态。 */
export function setFeedbackReducedMotion(on) {
  reduced = !!on;
  if (reduced) {
    if (bannerNode) { try { bannerNode.remove(); } catch { /* 忽略 */ } bannerNode = null; }
    if (hpAnim) { try { hpAnim.cancel(); } catch { /* 忽略 */ } hpAnim = null; }
  }
}

/** 清空所有临时反馈节点（保留 5 个固定容器），回主菜单/换局时调用。 */
export function resetFeedbackLayer() {
  const host = ensureFeedbackLayer();
  for (const key of ['center', 'nums']) {
    const box = host[key];
    while (box?.firstElementChild) box.firstElementChild.remove();
  }
  bannerNode = null;
  showLowHpVignette(false);
  return host;
}

/** 彻底移除反馈层（回主菜单 / 热重载时用）。 */
export function destroyFeedbackLayer() {
  clearTimeout(flashTimer);
  clearTimeout(hpTimer);
  clearTimeout(deathTimer);
  if (hpAnim) { try { hpAnim.cancel(); } catch { /* 忽略 */ } hpAnim = null; }
  if (layer?.el) {
    try { for (const a of layer.el.getAnimations?.({ subtree: true }) || []) a.cancel(); } catch { /* 忽略 */ }
    try { layer.el.remove(); } catch { /* 忽略 */ }
  }
  bannerNode = null;
  layer = null;
  try { document.documentElement.style.filter = ''; } catch { /* 忽略 */ }
}
