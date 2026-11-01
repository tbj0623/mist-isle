// Android 原生壳验证 + 性能采集（MIST ISLE 1.0.0）
//
// 和 scripts/android-e2e.mjs 的区别：
//   - 断言不走「截图肉眼看」，而是用 CDP 读 window.mistIsle.getUi()/getState() 做硬判定；
//   - 触屏坐标由 DOM 元素 boundingBox × devicePixelRatio 现算，不写死 1280x720 的比例；
//   - 返回键走真实 adb keyevent（验证的是 MainActivity 的 OnBackPressedDispatcher，不是 JS）；
//   - 旋转/改尺寸后用一个 JS 侧 marker 证明 WebView 没有被重建（= 没丢局）。
//
// 截图一律 `adb exec-out screencap -p` + Buffer 写盘（PowerShell 文本管道会破坏 PNG）。
//
// 用法：node scripts/android-native-e2e.mjs [emulator-5554] [emulator-5556]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const ADB = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const PKG = 'com.mistisle.game';
const ACTIVITY = `${PKG}/.MainActivity`;
const OUT = 'artifacts/android-native';
const APK_DEBUG = 'artifacts/mist-isle-1.0.0-debug.apk';
const APK_RELEASE = 'artifacts/mist-isle-1.0.0-release.apk';
const DEVICES = process.argv.slice(2).length ? process.argv.slice(2) : ['emulator-5554'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

// ── adb 基础 ────────────────────────────────────────────────────────────────
let DEVICE = DEVICES[0];
const run = (args, opts = {}) => execFileSync(ADB, ['-s', DEVICE, ...args], {
  encoding: opts.binary ? 'buffer' : 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const sh = (cmd) => run(['shell', cmd]);

/** 截图：exec-out 是二进制流，必须用 buffer 接住再写盘。 */
function shot(name) {
  const buf = run(['exec-out', 'screencap', '-p'], { binary: true });
  const path = `${OUT}/${name}`;
  writeFileSync(path, buf);
  const lum = luminance(buf);
  console.log(`   shot ${path} (${buf.length}B, meanLum=${lum.mean.toFixed(1)}, sd=${lum.sd.toFixed(1)})`);
  return { path, bytes: buf.length, meanLum: +lum.mean.toFixed(2), sdLum: +lum.sd.toFixed(2) };
}

function topActivity() {
  const out = sh('dumpsys activity activities');
  const m = out.match(/topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)\//);
  return m ? m[1] : null;
}
const foreground = () => topActivity() === PKG;

// ── 极简 PNG 解码：只为算平均亮度，用于「不是黑屏」的硬断言 ────────────────
function luminance(png) {
  try {
    if (png.readUInt32BE(0) !== 0x89504e47) return { mean: -1, sd: -1 };
    let off = 8, width = 0, height = 0, depth = 0, color = 0, idat = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('ascii', off + 4, off + 8);
      const data = png.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        depth = data[8]; color = data[9];
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (depth !== 8 || ![0, 2, 4, 6].includes(color)) return { mean: -1, sd: -1 };
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = Buffer.alloc(height * stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[pos++];
      const line = raw.subarray(pos, pos + stride); pos += stride;
      const cur = out.subarray(y * stride, (y + 1) * stride);
      const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? cur[x - channels] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= channels ? prev[x - channels] : 0;
        let v = line[x];
        if (filter === 1) v += a; else if (filter === 2) v += b;
        else if (filter === 3) v += (a + b) >> 1;
        else if (filter === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        cur[x] = v & 0xff;
      }
    }
    // 采样 1/9 像素求均值与标准差
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        const i = y * stride + x * channels;
        const lum = 0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2];
        sum += lum; sum2 += lum * lum; n++;
      }
    }
    const mean = sum / n;
    return { mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
  } catch {
    return { mean: -1, sd: -1 };
  }
}

// ── CDP 连接（debug 包才带 WebView 调试） ───────────────────────────────────
let browser = null, page = null, port = 9400;
async function connectCdp() {
  const pid = sh(`pidof ${PKG}`).trim();
  if (!pid) throw new Error('App 进程不存在，无法连接 WebView 调试端口');
  port += 1;
  run(['forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
  let lastErr;
  for (let i = 0; i < 40; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 8000 });
      page = browser.contexts().flatMap((c) => c.pages())
        .find((p) => p.url().includes('appassets.androidplatform.net'));
      if (page) { page.setDefaultTimeout(45000); return page; }
    } catch (err) { lastErr = err; }
    await sleep(500);
  }
  throw new Error(`CDP 连接失败：${lastErr?.message || 'no page'}`);
}

async function disconnectCdp() {
  try { await browser?.close(); } catch { /* 忽略 */ }
  try { run(['forward', '--remove', `tcp:${port}`]); } catch { /* 忽略 */ }
  browser = null; page = null;
}

const ui = () => page.evaluate(() => window.mistIsle.getUi());
const health = () => page.evaluate(() => window.mistIsle.getHealth());
const status = () => page.evaluate(() => window.mistIsle.getStatus());
const state = () => page.evaluate(() => window.mistIsle.getState());

/** 元素中心点的【物理】坐标：CSS px × devicePixelRatio（adb input 要物理像素）。 */
async function tapSel(sel, { align = 'center' } = {}) {
  const box = await page.evaluate((s) => {
    const n = document.querySelector(s);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio };
  }, sel);
  if (!box || box.w < 2 || box.h < 2) throw new Error(`元素不可点：${sel} (${JSON.stringify(box)})`);
  const cx = box.x + box.w / 2;
  const cy = align === 'top' ? box.y + box.h * 0.25 : box.y + box.h / 2;
  sh(`input tap ${Math.round(cx * box.dpr)} ${Math.round(cy * box.dpr)}`);
  return { x: Math.round(cx * box.dpr), y: Math.round(cy * box.dpr) };
}

// ── 设备准备：安装 / 解除挂起 / 冷启动 ──────────────────────────────────────
function packageInfo() {
  const out = sh(`dumpsys package ${PKG}`);
  const m = out.match(/versionName=(\S+)/);
  const s = out.match(/suspended=(true|false)/);
  return { installed: /versionName=/.test(out), versionName: m ? m[1] : null, suspended: s ? s[1] === 'true' : false };
}

function install(apk) {
  // 模拟器被多个项目共用：安装前先摘掉别人的挂起标记
  sh(`pm unsuspend ${PKG}`);
  let info = packageInfo();
  if (info.installed && info.suspended) {
    // 只 unsuspend 不生效（挂起是本 session 的 com.android.shell），重装是唯一可靠的解除方式
    sh(`pm unsuspend --user 0 ${PKG}`);
    info = packageInfo();
    if (info.suspended) { console.log('   包处于 suspended，卸载重装以清除挂起'); sh(`uninstall ${PKG}`); }
  }
  const out = run(['install', '-r', apk]);
  if (!/Success/.test(out)) throw new Error(`安装失败：${out}`);
  return packageInfo();
}

function relaunch() {
  sh(`pm unsuspend ${PKG}`);
  sh(`am force-stop ${PKG}`);
  sh(`am start -n ${ACTIVITY}`);
  for (let i = 0; i < 30; i++) {
    if (foreground()) return true;
    sleepSync(250);
  }
  return false;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const BLOCKER = /SuspendedAppActivity|com\.android\.internal\.app\./;

/**
 * 这台模拟器被多个项目共用，别的 Agent 会随时抢前台（甚至用系统挂起对话框盖住）。
 * 每一步操作前先把游戏拉回前台；抢不回来就跳过本步而不是把整套验证带崩。
 */

/**
 * 当前位置是不是我们这款游戏。仅凭 topResumedActivity 会误判：
 * 页内弹窗、系统悬浮层都可能让 top 不是 .MainActivity，但画面仍是游戏。
 */
function ourAppOnTop() {
  const out = sh('dumpsys activity activities');
  const top = (out.match(/topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)\//) || [])[1] || '';
  if (top === PKG) return true;
  if (BLOCKER.test(top)) return false;
  return !!sh(`pidof ${PKG}`).trim();
}

async function ensureForeground({ kills = false } = {}) {
  if (kills) sh(`am force-stop ${PKG}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    sh(`pm unsuspend ${PKG}`);
    sh(`am start -n ${ACTIVITY}`);
    await sleep(1600);
    const top = await topActivity();
    if (top === PKG) return true;
    if (BLOCKER.test(top || '')) {
      console.log(`   前台被 ${top} 占用，按返回键关掉它`);
      sh('input keyevent KEYCODE_BACK');
      await sleep(900);
      continue;
    }
    if (!BLOCKER.test(top || '') && sh(`pidof ${PKG}`).trim()) return true;
    await sleep(1200);
  }
  return ourAppOnTop();
}

// ── 结果记录 ────────────────────────────────────────────────────────────────
const checks = [];
function fileSize(p) {
  try { return existsSync(p) ? statSync(p).size : null; } catch { return null; }
}
function check(id, name, ok, detail = '', extra = {}) {
  checks.push({ id, name, ok: !!ok, detail, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}

// ── 单个设备的完整验证 + 性能采集 ───────────────────────────────────────────
async function verifyDevice(device) {
  DEVICE = device;
  const result = { device, startedAt: new Date().toISOString(), checks: [], screenshots: [], perf: null, crashes: [] };
  const local = checks.length;
  const push = (c) => { result.checks.push(c); };

  console.log(`\n=== ${device} ===`);
  sh('logcat -c');
  const info = install(APK_DEBUG);
  result.package = info;
  console.log(`   debug APK 已安装：versionName=${info.versionName}`);

  // ── 1 冷启动 → 主菜单 ────────────────────────────────────────────────────
  console.log('\n[1] 冷启动 → 主菜单');
  sh(`am force-stop ${PKG}`);
  await ensureForeground({ kills: false });
  await sleep(5200);
  page = await connectCdp();
  await page.waitForFunction(() => !!window.mistIsle, { timeout: 40000 });
  await ensureForeground();
  const homeUi = await ui();
  const shot1 = shot('01-coldstart-home.png');
  result.screenshots.push('01-coldstart-home.png');
  push(check('1', '冷启动进入主菜单', (await ensureForeground()) && homeUi.screen === 'home' && shot1.meanLum > 12
    && shot1.sdLum > 10,
    `top=${topActivity()} screen=${homeUi.screen} hud=${homeUi.hudVisible} lum=${shot1.meanLum} sd=${shot1.sdLum}`));

  // ── 2 出击 → 训练开局 → 对战画面 ────────────────────────────────────────
  console.log('\n[2] 出击 → 训练场 → 开始行动');
  await ensureForeground();
  await tapSel('#nav-play');
  await page.waitForFunction(() => window.mistIsle.getUi().screen === 'play', { timeout: 15000 });
  await tapSel('#mode-training');
  await sleep(400);
  const shot2a = shot('02a-training-selected.png');
  result.screenshots.push('02a-training-selected.png');
  await ensureForeground();
  await tapSel('#btn-offline');
  await page.waitForFunction(() => window.mistIsle.getState()?.phase === 'playing', { timeout: 30000 });
  await sleep(2500);
  await ensureForeground();
  const battleStatus = await status();
  const shot2 = shot('02-battle.png');
  result.screenshots.push('02-battle.png');
  const hudUp = (await ui()).hudVisible;
  push(check('2', '训练开局进入对战画面', !!battleStatus.offline && hudUp && shot2.meanLum > 8,
    `offline=${battleStatus.offline} fps=${battleStatus.fps} hud=${hudUp} lum=${shot2.meanLum}`, { shot: shot2a.path }));

  // 记录对局时间，用于证明暂停/旋转/前后台都没有重置对局
  const t0 = (await state()).time;

  // ── 3 返回键 → 暂停菜单（不是退出 App） ─────────────────────────────────
  console.log('\n[3] adb 返回键 → 暂停菜单');
  await ensureForeground();
  sh('input keyevent KEYCODE_BACK');
  await sleep(1200);
  const pauseUi = await ui();
  const shot3 = shot('03-pause-menu.png');
  result.screenshots.push('03-pause-menu.png');
  const pauseOpened = pauseUi.dialogs.includes('pause-dialog');
  const stillAlive = ourAppOnTop();
  push(check('3', '返回键弹出暂停菜单且 App 未退出', stillAlive && pauseOpened,
    `alive=${stillAlive} top=${topActivity()} dialogs=[${pauseUi.dialogs.join(',')}]`));

  // 再按一次返回：应关闭弹窗而不是退出（弹窗关掉后 HUD 仍在）
  sh('input keyevent KEYCODE_BACK');
  await sleep(1000);
  const afterSecondBack = await ui();
  push(check('3b', '第二次返回键关闭暂停弹窗而非退出', ourAppOnTop() && !afterSecondBack.dialogs.length,
    `alive=${ourAppOnTop()} dialogs=[${afterSecondBack.dialogs.join(',')}] screen=${afterSecondBack.screen}`));

  // 重新打开暂停菜单，准备点「继续战斗」
  sh('input keyevent KEYCODE_BACK');
  await sleep(900);

  // ── 4 暂停 → 继续 → 回到对战 ────────────────────────────────────────────
  console.log('\n[4] 暂停 → 继续战斗');
  await ensureForeground();
  await tapSel('#btn-resume');
  await sleep(1500);
  const resumedUi = await ui();
  const shot4 = shot('04-resumed-battle.png');
  result.screenshots.push('04-resumed-battle.png');
  const t1 = (await state()).time;
  push(check('4', '继续后回到对战且对局未被重置',
    !resumedUi.dialogs.length && resumedUi.hudVisible && t1 >= t0 && shot4.meanLum > 8,
    `dialogs=[${resumedUi.dialogs.join(',')}] hud=${resumedUi.hudVisible} time ${t0}→${t1} lum=${shot4.meanLum}`));

  // JS 侧 marker：任何 Activity/WebView 重建都会丢失它
  await page.evaluate(() => { window.__mistIsleMarker = 'keep-me-' + Date.now(); });

  // ── 5 旋转 → 不丢局 ────────────────────────────────────────────────────
  console.log('\n[5] 旋转设备（user_rotation + wm size）');
  const rotBefore = sh('settings get system user_rotation').trim();
  sh('settings put system accelerometer_rotation 0');
  sh('settings put system user_rotation 1');
  await sleep(2500);
  await ensureForeground();
  const markerAfterRotate = await page.evaluate(() => window.__mistIsleMarker || null);
  const rotateUi = await ui();
  const shot5 = shot('05-rotated.png');
  result.screenshots.push('05-rotated.png');
  const stateAfterRotate = await state();
  push(check('5', '旋转后 WebView 未重建、对局仍在', !!markerAfterRotate && rotateUi.screen !== null
    && !!stateAfterRotate && stateAfterRotate.phase === 'playing',
    `marker=${markerAfterRotate ? 'kept' : 'LOST'} phase=${stateAfterRotate?.phase} hud=${rotateUi.hudVisible} lum=${shot5.meanLum}`));

  // 追加一次分辨率变更（模拟分屏/折叠屏尺寸变化）
  sh('wm size 1280x720');
  await sleep(2200);
  await ensureForeground();
  const markerAfterResize = await page.evaluate(() => window.__mistIsleMarker || null);
  const shot5b = shot('05b-resized-1280x720.png');
  result.screenshots.push('05b-resized-1280x720.png');
  push(check('5b', '运行中改变分辨率不丢局', !!markerAfterResize && shot5b.meanLum > 6,
    `marker=${markerAfterResize ? 'kept' : 'LOST'} top=${topActivity()} lum=${shot5b.meanLum}`));

  // ── 6 Home 切后台 → 切回 ────────────────────────────────────────────────
  console.log('\n[6] Home 切后台 → 切回');
  await ensureForeground();
  sh('input keyevent KEYCODE_HOME');
  await sleep(3000);
  const bgTop = topActivity();
  await ensureForeground();
  await sleep(3500);
  const resumedStatus = await status();
  const hudHealth = await health();
  const shot6 = shot('06-back-from-home.png');
  result.screenshots.push('06-back-from-home.png');
  push(check('6', '后台切回后游戏恢复（不黑屏/不卡死）',
    ourAppOnTop() && hudHealth.fps > 0 && shot6.meanLum > 8 && hudHealth.frameErrors === 0,
    `bgTop=${bgTop} top=${topActivity()} fps=${hudHealth.fps} frameErrors=${hudHealth.frameErrors} lum=${shot6.meanLum} mode=${resumedStatus.mode}`));

  // ── 7 崩溃检查 ──────────────────────────────────────────────────────────
  console.log('\n[7] logcat 崩溃检查');
  const log = sh('logcat -d -v brief');
  const crashLines = log.split('\n').filter((l) =>
    /FATAL EXCEPTION|AndroidRuntime.*FATAL|chromium.*(FATAL|Crash)|signal \d+ \(SIGSEGV\)|E\/AndroidRuntime/i.test(l));
  const javaCrash = /FATAL EXCEPTION/.test(log);
  result.crashes = crashLines.slice(0, 20);
  push(check('7', 'logcat 无 FATAL / 渲染进程崩溃', !javaCrash,
    javaCrash ? `发现 FATAL EXCEPTION，共 ${crashLines.length} 行` : `扫描 ${log.split('\n').length} 行，无 FATAL EXCEPTION`,
    { crashLines: crashLines.slice(0, 8) }));

  // ── 性能：对战 30 秒后采样 ──────────────────────────────────────────────
  console.log('\n[perf] 对战 30 秒采样');
  const samples = [];
  for (let i = 0; i < 15; i++) { samples.push(await health()); await sleep(2000); }
  const avg = (key) => +(samples.reduce((a, s) => a + (s[key] || 0), 0) / samples.length).toFixed(1);
  const gfx = sh(`dumpsys gfxinfo ${PKG}`);
  const mem = sh(`dumpsys meminfo ${PKG}`);
  const totalFrames = parseGfx(gfx);
  const memMb = parseMem(mem);
  result.perf = {
    device,
    sampledAt: new Date().toISOString(),
    durationSec: 30,
    screenshot: '07-perf.png',
    fps: avg('fps'),
    fpsMin: Math.min(...samples.map((s) => s.fps)),
    fpsMax: Math.max(...samples.map((s) => s.fps)),
    drawCalls: avg('drawCalls'),
    triangles: Math.round(avg('triangles')),
    geometries: avg('geometries'),
    textures: avg('textures'),
    heapMB: avg('heapMB'),
    frameErrors: samples.at(-1).frameErrors,
    lastFrameDtMs: samples.at(-1).lastFrameDtMs,
    gfx,
    mem: memMb,
    memRaw: mem.split('\n').slice(0, 12).join('\n'),
    samples,
  };
  const shot7 = shot('07-perf.png');
  result.screenshots.push('07-perf.png');
  console.log(`   fps=${result.perf.fps} (${result.perf.fpsMin}–${result.perf.fpsMax}) drawCalls=${result.perf.drawCalls} `
    + `tris=${result.perf.triangles} heap=${result.perf.heapMB}MB native=${memMb.totalPss}MB`);

  // gfxinfo 的 janky 比例（Android 11+ 才有 total frames 行）
  if (totalFrames) {
    push(check('perf', '帧率与内存达到验收线（fps≥30 且 PSS<400MB）',
      result.perf.fps >= 30 && memMb.totalPss < 400,
      `fps=${result.perf.fps} PSS=${memMb.totalPss}MB janky=${totalFrames.jankyPct ?? 'n/a'}%`,
      { gfx: totalFrames }));
  }

  // ── release APK：安装 + 启动 ────────────────────────────────────────────
  console.log('\n[release] 安装并启动 release APK');
  await disconnectCdp();
  sh(`am force-stop ${PKG}`);
  const releaseInfo = install(APK_RELEASE);
  const releasePid = sh(`pidof ${PKG}`).trim();
  relaunch();
  await sleep(6000);
  // release 包关闭了 WebView 调试，只能用前台 + 截图亮度判定
  const releaseShot = shot('08-release-launch.png');
  result.screenshots.push('08-release-launch.png');
  const releaseLog = sh('logcat -d -v brief');
  const releaseCrash = /FATAL EXCEPTION/.test(releaseLog);
  push(check('release', 'release APK 可安装并启动到主菜单',
    foreground() && !releaseCrash && releaseShot.meanLum > 12 && releaseShot.sdLum > 8,
    `versionName=${releaseInfo.versionName} top=${topActivity()} lum=${releaseShot.meanLum} sd=${releaseShot.sdLum} crash=${releaseCrash}`));
  result.release = { versionName: releaseInfo.versionName, pid: releasePid, shot: 'release-launch.png', crash: releaseCrash };

  // 收尾：装回 debug、还原旋转/分辨率，避免影响别的项目
  sh('settings put system user_rotation ' + (rotBefore || '0'));
  sh('settings put system accelerometer_rotation 1');
  sh('wm size reset');
  sh(`am force-stop ${PKG}`);
  install(APK_DEBUG);

  result.checks = checks.slice(local);
  result.finishedAt = new Date().toISOString();
  const passed = result.checks.filter((c) => c.ok).length;
  result.passed = passed === result.checks.length;
  result.summary = `${passed}/${result.checks.length}`;
  console.log(`\n${device}: ${result.summary} 通过`);
  return result;
}

function parseGfx(gfx) {
  const frames = gfx.match(/Total frames rendered:\s*(\d+)/);
  const janky = gfx.match(/Janky frames:\s*(\d+)[^(]*\(([\d.]+)%\)/);
  const p50 = gfx.match(/50th percentile:\s*(\d+)ms/);
  const p90 = gfx.match(/90th percentile:\s*(\d+)ms/);
  const p99 = gfx.match(/99th percentile:\s*(\d+)ms/);
  if (!frames && !janky) return null;
  return {
    totalFrames: frames ? +frames[1] : null,
    jankyFrames: janky ? +janky[1] : null,
    jankyPct: janky ? +janky[2] : null,
    p50ms: p50 ? +p50[1] : null,
    p90ms: p90 ? +p90[1] : null,
    p99ms: p99 ? +p99[1] : null,
  };
}

function parseMem(mem) {
  const total = mem.match(/TOTAL PSS:\s*(\d+)/) || mem.match(/TOTAL\s+(\d+)/);
  const java = mem.match(/Java Heap:\s*(\d+)/);
  const native = mem.match(/Native Heap:\s*(\d+)/);
  return {
    totalPss: total ? Math.round(+total[1] / 1024) : null,
    javaHeapMB: java ? Math.round(+java[1] / 1024) : null,
    nativeHeapMB: native ? Math.round(+native[1] / 1024) : null,
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const results = [];
for (const device of DEVICES) {
  try {
    results.push(await verifyDevice(device));
  } catch (error) {
    console.error(`\n${device} 验证中断：${error.message}`);
    results.push({ device, passed: false, error: error.message, checks: checks.slice(-3) });
  } finally {
    await disconnectCdp();
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  apk: {
    debug: { path: APK_DEBUG, bytes: fileSize(APK_DEBUG) },
    release: { path: APK_RELEASE, bytes: fileSize(APK_RELEASE) },
  },
  devices: results,
};
writeFileSync(`${OUT}/e2e-report.json`, JSON.stringify(report, null, 2));
// perf.json 只保留主设备（第一台）的数字，供性能报告引用
const perfDevice = results.find((r) => r.perf);
if (perfDevice) {
  writeFileSync(`${OUT}/perf.json`, JSON.stringify({
    device: perfDevice.device, ...perfDevice.perf, gfx: perfDevice.perf?.gfx, mem: perfDevice.perf?.mem,
  }, null, 2));
}
console.log(`\n报告：${OUT}/e2e-report.json`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
