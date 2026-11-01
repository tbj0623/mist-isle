// 三图并排对比截图 + 地标特写 + 渲染性能采样（worldgen/renderfx 验证脚本）
// 用法：node scripts/map-compare.mjs [--tag=after] [--only=qinglan,chisha,baiye] [--res=1280x720]
// 输出：artifacts/maps/<tag>/<mapId>-overview.png / <mapId>-<landmarkId>.png / report.json
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=?(.*)$/.exec(a);
  return m ? [m[1], m[2] || '1'] : [a, '1'];
}));
const TAG = args.tag || 'after';
const ONLY = (args.only || 'qinglan,chisha,baiye').split(',').filter(Boolean);
const [RW, RH] = (args.res || '1280x720').split('x').map(Number);
const OUT = path.join('artifacts', 'maps', TAG);
const URL = args.url || 'http://127.0.0.1:8787/';

async function fpsSample(page, ms = 2600) {
  return page.evaluate((dur) => new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => {
      frames++;
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      else resolve({ fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1), frames });
    };
    requestAnimationFrame(tick);
  }), ms);
}

async function health(page) {
  return page.evaluate(() => window.mistIsle.getHealth());
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: RW, height: RH }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.addInitScript(() => {
  localStorage.setItem('mist-isle-settings-v2', JSON.stringify({
    quality: 'high', music: false, sound: false, tutorialDone: true, hint: 0, showFps: false,
  }));
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 });
await page.waitForFunction(() => {
  const n = document.getElementById('boot');
  return !n || n.classList.contains('hidden');
}, null, { timeout: 20000 });
await page.waitForTimeout(1200);

// 主菜单隐藏所有 UI 面板，只留 3D
await page.addStyleTag({ content: '#screen-root,#hud,#dialog-root,#toast-root,#boot{display:none!important}' });

await mkdir(OUT, { recursive: true });
const report = { tag: TAG, res: `${RW}x${RH}`, maps: {}, generatedAt: new Date().toISOString() };

for (const mapId of ONLY) {
  // 1) 对局内正常视角
  await page.evaluate((id) => {
    const app = window.__mistApp;
    try { app.leaveMatch?.(); } catch { /* noop */ }
    app.startOffline('training', { mapId: id });
  }, mapId);
  await page.waitForFunction(() => {
    const s = window.mistIsle.getStatus();
    return s.mode === 'match' && /live|playing/.test(s.phase || '');
  }, null, { timeout: 40000 });
  await page.waitForTimeout(2600);
  const battle = await health(page);
  const battleFps = await fpsSample(page);
  await page.screenshot({ path: path.join(OUT, `${mapId}-battle.png`) });

  // 2) 全景俯视（关掉相机跟随 + 暂时推远雾，否则 300m 外全是雾）
  const info = await page.evaluate((id) => {
    const sc = window.__mistApp.scene;
    const world = sc.worlds?.get?.(id)?.world || sc.world;
    sc.updateCamera = () => {};
    const r = world?.radius || 180;
    // 俯视全景：相机在地图正上方偏南，距离 ≈ 1.6R，fov 62° 刚好装下全图
    sc.camera.position.set(0, r * 1.55, r * 0.55);
    sc.camera.lookAt(0, 0, 0);
    sc.camera.fov = 62; sc.camera.updateProjectionMatrix();
    // 截图期间把雾推远（否则远景全被雾吃掉，看不出地形）
    const fog = sc.scene.fog;
    if (fog) {
      if (fog.isFogExp2) { sc._fogBackup = { density: fog.density }; fog.density = 0.0012; }
      else { sc._fogBackup = { near: fog.near, far: fog.far }; fog.near = 600; fog.far = 1400; }
    }
    const lm = (world?.landmarks || []).map((l) => ({
      id: l.id, name: l.name, kind: l.kind, x: l.x, z: l.z, radius: l.radius, tier: l.tier, hero: !!l.hero,
    }));
    return {
      mapId: world?.id, radius: r, landmarks: lm,
      stats: world?.stats || null,
      heightRange: (() => {
        if (typeof world?.heightAt !== 'function') return null;
        let lo = Infinity; let hi = -Infinity;
        for (let i = 0; i < 900; i++) {
          const a = (i / 900) * Math.PI * 2 * 7;
          const rr = (i / 900) * (r - 6);
          const h = world.heightAt(Math.cos(a) * rr, Math.sin(a) * rr);
          if (h < lo) lo = h; if (h > hi) hi = h;
        }
        return { min: +lo.toFixed(2), max: +hi.toFixed(2) };
      })(),
    };
  }, mapId);
  await page.waitForTimeout(700);
  const overview = await health(page);
  const overviewFps = await fpsSample(page, 1600);
  await page.screenshot({ path: path.join(OUT, `${mapId}-overview.png`) });
  // 还原雾
  await page.evaluate(() => {
    const sc = window.__mistApp.scene;
    const fog = sc.scene.fog;
    if (!fog || !sc._fogBackup) return;
    if (fog.isFogExp2) fog.density = sc._fogBackup.density;
    else { fog.near = sc._fogBackup.near; fog.far = sc._fogBackup.far; }
    sc._fogBackup = null;
  });

  // 3) 每个地标特写：把相机摆到地标斜上方（按地标规模 + 高度自适应取景）
  const shots = [];
  for (const lm of info.landmarks || []) {
    await page.evaluate((l) => {
      const sc = window.__mistApp.scene;
      const world = sc.worlds?.get?.(sc.mapId)?.world || sc.world;
      const h = typeof world?.heightAt === 'function' ? world.heightAt(l.x, l.z) : 0;
      // 取景距离：地标半径 + 高度的加权，保证整座地标进画面
      const tall = { signal_tower: 40, lighthouse: 34, derrick: 22, conveyor: 24, bridge: 32, waterfall: 16, radar_station: 16, open_pit: 20, shipwreck: 18, dock: 14, container_maze: 14, warehouse: 14 }[l.kind] || 14;
      const sink = l.kind === 'open_pit' ? Math.abs(h) : 0;      // 下沉坑：相机抬到地表以上
      const span = Math.max(tall, (l.radius || 10) * 1.9);
      const baseY = sink ? 0 : h;
      // 尖塔类：拉远到能装下整根塔（高度是最主要的视觉记忆点）
      const tallKind = ['signal_tower', 'lighthouse', 'derrick', 'bridge'].includes(l.kind);
      const dist = tallKind ? tall * 1.9 + 24 : span * 1.55 + 10;
      sc.camera.position.set(l.x + dist * 0.52, baseY + (tallKind ? tall * 0.75 + 12 : span * 0.9) + sink * 0.55, l.z + dist * 0.68);
      sc.camera.lookAt(l.x, baseY + tall * 0.45 - sink * 0.4, l.z);
      sc.camera.fov = 56; sc.camera.updateProjectionMatrix();
    }, lm);
    await page.waitForTimeout(380);
    const file = `${mapId}-${lm.hero ? 'LM-' : ''}${lm.id || lm.kind}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    shots.push({ ...lm, file, health: await health(page) });
  }

  report.maps[mapId] = {
    info,
    battle: { ...battle, fps: battleFps.fps },
    overview: { ...overview, fps: overviewFps.fps },
    landmarkShots: shots,
  };
  console.log(`[${TAG}] ${mapId}: battle calls=${battle.drawCalls} tris=${battle.triangles} fps=${battleFps.fps} | overview calls=${overview.drawCalls} tris=${overview.triangles} fps=${overviewFps.fps} | landmarks=${(info.landmarks || []).length}`);
}

report.errors = errors.slice(0, 40);
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
if (errors.length) console.log('ERRORS:', errors.slice(0, 10).join('\n'));
await browser.close();
console.log(`wrote ${path.join(OUT, 'report.json')}`);
