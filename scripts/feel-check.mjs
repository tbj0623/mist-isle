// 手感层验收：hitstop 时间缩放、击杀徽章、reducedMotion 降级、DOM 无泄漏、无 console error。
// 运行：node scripts/feel-check.mjs   （需要 npm run dev 或已在 8787 跑着服务）
import { chromium } from 'playwright';

const URL = process.env.FEEL_URL || 'http://127.0.0.1:8787/';
const results = [];
let failed = 0;
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.addInitScript(() => {
  localStorage.setItem('mist-isle-settings-v2', JSON.stringify({
    quality: 'low', music: false, sound: false, tutorialDone: true, hint: 0,
  }));
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__mistFeel, { timeout: 30000 });
await page.waitForTimeout(600);

// ── 1. onHit 爆头 → timeScale 压到 < 0.1，80ms 后回到 1 ─────────────────────
const hit = await page.evaluate(async () => {
  const feel = window.__mistFeel;
  feel.onHit({ kind: 'headshot', damage: 48, distance: 20, headshot: true, targetX: 4, targetZ: 6 });
  const immediate = feel.timeScale;
  const scaledDt = feel.update(0.016); // 定格期间取一帧：dt 必须被压小
  await new Promise((r) => setTimeout(r, 80));
  const after = feel.timeScale;
  return { immediate, after, scaledDt, stats: { ...feel.stats } };
});
check('1. onHit 爆头 timeScale < 0.1', hit.immediate < 0.1, `timeScale=${hit.immediate.toFixed(3)}`);
check('1b. 80ms 后 timeScale 恢复 1', hit.after === 1, `timeScale=${hit.after}`);
check('1c. update() 返回缩放后的 dt', hit.scaledDt < 0.016 && hit.scaledDt > 0, `dt=${hit.scaledDt.toFixed(5)}`);

// ── 2. onKill → #feel-layer 出现 .kill-banner ────────────────────────────────
const kill = await page.evaluate(async () => {
  const feel = window.__mistFeel;
  feel.onKill({ targetName: '雾岛游侠', headshot: false, multiKill: 1 });
  const scaleNow = feel.timeScale;          // 同步读：慢机器上 rAF 可能 >80ms，先取瞬时值
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const layer = document.getElementById('feel-layer');
  const banner = layer?.querySelector('.kill-banner');
  return {
    hasLayer: !!layer,
    hasBanner: !!banner,
    text: banner?.textContent || '',
    children: layer ? layer.childElementCount : -1,
    scale: scaleNow,
  };
});
check('2. #feel-layer 存在', kill.hasLayer, JSON.stringify(kill));
check('2b. 出现 .kill-banner', kill.hasBanner, `text="${kill.text}"`);
check('2c. kill 触发 hitstop（< 0.1）', kill.scale < 0.1, `timeScale=${kill.scale}`);
check('2d. 容器数固定 5 个', kill.children === 5, `children=${kill.children}`);

// ── 3. reducedMotion: true 时 timeScale 不低于 0.02 ─────────────────────────
const reduced = await page.evaluate(async () => {
  const feel = window.__mistFeel;
  const app = window.__mistApp;
  app.settings.reducedMotion = true;
  feel.update(0.016);
  feel.hitstop(120);
  const during = feel.timeScale;
  const dt = feel.update(0.016);
  feel.onHit({ kind: 'headshot', damage: 30, distance: 10, headshot: true });
  const afterHit = feel.timeScale;
  await new Promise((r) => setTimeout(r, 220));
  const recovered = feel.timeScale;
  // 复原，别影响后续用例
  app.settings.reducedMotion = false;
  feel.update(0.016);
  return { during, dt, afterHit, recovered, reducedFlag: feel.reducedMotion };
});
check('3. reducedMotion 下 timeScale 不打到 0.02 以下', reduced.during >= 0.02 && reduced.afterHit >= 0.02,
  `during=${reduced.during} afterHit=${reduced.afterHit}`);
check('3b. reducedMotion 下仍保留定格节奏（< 1）', reduced.during < 1, `during=${reduced.during}`);

// ── 4. 连续 20 次 onHit 不产生 DOM 泄漏 ────────────────────────────────────
const leak = await page.evaluate(async () => {
  const feel = window.__mistFeel;
  for (let i = 0; i < 20; i++) {
    feel.onHit({ kind: i % 4 === 0 ? 'headshot' : 'hit', damage: 12 + i, distance: 8, headshot: i % 4 === 0, targetX: 2 + i, targetZ: 3 });
  }
  const layer = document.getElementById('feel-layer');
  const before = layer.childElementCount;
  await new Promise((r) => setTimeout(r, 1400));
  const after = layer.childElementCount;
  return { before, after, totalNodes: layer.querySelectorAll('*').length };
});
check('4. onHit ×20 后直接子节点 ≤ 5', leak.after <= 5, `before=${leak.before} after=${leak.after}`);

// ── 5. 无 console error ─────────────────────────────────────────────────────
await page.waitForTimeout(400);
const realErrors = errors.filter((e) => !/favicon|Download the React|WebGL.*deprecat/i.test(e));
check('5. 无 console error / pageerror', realErrors.length === 0, realErrors.slice(0, 3).join(' | ') || 'clean');

// ── 附加：容错（null 依赖不抛）与受击红边 ──────────────────────────────────
const guard = await page.evaluate(async () => {
  const { FeelDirector } = await import('/app.js').catch(() => ({}));
  const feel = window.__mistFeel;
  const out = { damage: null, flashOk: false };
  try { feel.onDamage({ damage: 26, fromAngle: 1.2, heavy: false }); out.damage = 'ok'; } catch (e) { out.damage = String(e); }
  const flash = document.querySelector('#feel-layer .feel-flash');
  out.flashOk = !!flash && getComputedStyle(flash).background.includes('conic-gradient');
  out.multi = feel.onKill({ targetName: 'A' }) && feel.onKill({ targetName: 'B' });
  return out;
});
check('6. onDamage 不抛且红边已就位', guard.damage === 'ok' && guard.flashOk, JSON.stringify(guard));
check('6b. 连杀自动升档（连续两次击杀 → 2）', guard.multi >= 2, `multi=${guard.multi}`);

// ── 7. 低血量暗角：hp 掉到阈值下由 update 自动点亮 ─────────────────────────
const lowhp = await page.evaluate(async () => {
  const feel = window.__mistFeel;
  // 首页没有对局状态：临时塞一个最小 scene.state 桩，测完还原
  const prev = feel.scene.state; const prevId = feel.scene.selfId;
  const prevLow = feel._lowHp;
  feel._lowHp = false;
  feel.scene.selfId = 'p1';
  feel.scene.state = { players: [{ id: 'p1', hp: 18, maxHp: 100, x: 0, z: 0, angle: 0 }] };
  feel.onDamage({ damage: 20, fromAngle: 1, heavy: false });
  feel.update(0.016);
  const hp = document.querySelector('#feel-layer .feel-hp');
  const on = !!hp && hp.classList.contains('on');
  feel.scene.state.players[0].hp = 100;
  feel.update(0.016);
  await new Promise((r) => setTimeout(r, 40));
  const off = !!hp && !hp.classList.contains('on');
  feel.scene.state = prev; feel.scene.selfId = prevId; feel._lowHp = prevLow;
  return { on, off };
});
check('7. 低血量暗角自动点亮/熄灭', lowhp.on && lowhp.off, JSON.stringify(lowhp));

await browser.close();

const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('\n── FEEL CHECK ──────────────────────────────────────────────');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 42)} ${r.detail}`);
console.log(`────────────────────────────────────────────────────────────\n${results.length - failed}/${results.length} passed\n`);
if (failed) process.exitCode = 1;
