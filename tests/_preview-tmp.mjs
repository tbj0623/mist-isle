// 临时预览脚本：用系统 Chromium 打开打包后的 client（临时 HTTP 服务，不写入项目 dist）
import { chromium } from 'playwright-core';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

const dir = join(process.env.TEMP, 'mist-preview');
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const server = createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
  const ext = name.slice(name.lastIndexOf('.') + 1);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  createReadStream(join(dir, name)).on('error', () => res.end()).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const exe = process.env.MIST_CHROME;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
await page.waitForTimeout(4500);
const status = await page.evaluate(() => ({ mist: !!window.mistIsle, status: window.mistIsle?.getStatus?.() }));
await page.screenshot({ path: join(process.env.TEMP, 'mist-home.png') });
console.log('HOME', JSON.stringify(status));
// 进入训练对局，检查场景渲染是否正常
await page.evaluate(() => { document.getElementById('btn-offline')?.click(); });
await page.waitForTimeout(5000);
const battle = await page.evaluate(() => window.mistIsle?.getStatus?.());
await page.screenshot({ path: join(process.env.TEMP, 'mist-battle.png') });
console.log('BATTLE', JSON.stringify(battle));
// 模拟移动 + 开火，观察首帧后 draw calls 与稳定性
const before = await page.evaluate(() => window.mistIsle?.getState?.());
await page.mouse.move(700, 300);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
const after = await page.evaluate(() => ({ status: window.mistIsle?.getStatus?.(), state: window.mistIsle?.getState?.() }));
await page.screenshot({ path: join(process.env.TEMP, 'mist-fight.png') });
const sceneDiag = await page.evaluate(() => {
  const s = window.__mistApp?.scene;
  if (!s) return null;
  const roofs = s.roofs || [];
  const inst = roofs.filter((r) => r.instance).length;
  const faded = roofs.filter((r) => r.instanceFaded).length;
  const meshes = [];
  s.worldGroup?.traverse((n) => { if (n.isMesh || n.isInstancedMesh) meshes.push([n.type, n.count ?? 0, n.visible]); });
  return { roofs: roofs.length, inst, faded, meshes: meshes.length, sample: meshes.slice(0, 14), overlay: (s.currentWorld?.roofOverlay || []).filter((o) => o.building).length, theme: s.theme?.mapId, fog: s.scene?.fog?.far };
});
console.log('SCENE', JSON.stringify(sceneDiag));
// 三图切换 + 世界缓存复用
const maps = await page.evaluate(async () => {
  const s = window.__mistApp.scene;
  const out = [];
  const t0 = performance.now();
  for (const id of ['chisha', 'baiye', 'qinglan']) {
    const t = performance.now();
    s.setMap(id);
    out.push({ id, ms: Math.round(performance.now() - t), cached: s.worlds.has(id), buildings: s.world?.buildings?.length, trees: s.world?.trees?.length, fog: Math.round(s.scene.fog.far) });
  }
  return { total: Math.round(performance.now() - t0), out, cacheSize: s.worlds.size };
});
console.log('MAPS', JSON.stringify(maps));
await page.evaluate(() => { window.__mistApp.scene.setMap('baiye'); });
await page.waitForTimeout(900);
await page.screenshot({ path: join(process.env.TEMP, 'mist-baiye.png') });
await page.evaluate(() => { window.__mistApp.scene.setMap('chisha'); });
await page.waitForTimeout(900);
await page.screenshot({ path: join(process.env.TEMP, 'mist-chisha.png') });
await page.evaluate(() => { window.__mistApp.scene.setMap('qinglan'); window.__mistApp.scene.showHome(); });
await page.waitForTimeout(900);
await page.screenshot({ path: join(process.env.TEMP, 'mist-home2.png') });
const self = after.state?.players?.find((p) => p.id === after.state.selfId);
console.log('AFTER', JSON.stringify({ fps: after.status?.fps, calls: after.status?.renderCalls, geoms: after.status?.geometries, tex: after.status?.textures, phase: after.state?.phase, ammo: self?.ammo, z: Math.round(self?.z ?? 0), players: after.state?.players?.length, loot: after.state?.loot?.length }));
const startZ = before?.players?.find((p) => p.id === before.selfId)?.z;
console.log('MOVED', typeof startZ === 'number' && typeof self?.z === 'number' ? (startZ - self.z).toFixed(2) : 'n/a');
console.log('ERRORS', errors.length ? '\n  ' + errors.slice(0, 12).join('\n  ') : 'none');
await browser.close();
server.close();
