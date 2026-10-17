// 渲染诊断：检查战斗视角相机与世界网格
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.mistIsle, { timeout: 15000 });
await page.waitForTimeout(1500);
await page.click('#nav-play');
await page.click('#btn-offline');
await page.waitForFunction(() => window.mistIsle.getStatus().mode === 'match', { timeout: 12000 });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const app = window.__mistApp;
  const sc = app.scene;
  const s = app.state;
  const me = s?.me;
  return {
    phase: s?.phase,
    mePos: me ? { x: me.x, z: me.z, alive: me.alive } : null,
    camPos: sc.camera.position.toArray().map((v) => +v.toFixed(1)),
    camYaw: +(sc.camYaw ?? 0).toFixed(2),
    camPitch: +(sc.camPitch ?? 0).toFixed(2),
    camDist: +(sc.camDist ?? 0).toFixed(1),
    follow: sc.follow.toArray().map((v) => +v.toFixed(1)),
    home: !!sc.home,
    worldGroups: sc.worldGroup ? sc.worldGroup.children.length : (sc.world ? sc.world.children.length : 'no-world'),
    sceneChildren: sc.scene.children.length,
    renderCalls: sc.renderer.info.render.calls,
    triangles: sc.renderer.info.render.triangles,
    mapId: s?.mapId,
    staticWorlds: sc.staticWorlds ? [...sc.staticWorlds.keys()] : (sc.worlds ? [...sc.worlds.keys()] : 'unknown'),
    playerModels: sc.players?.size ?? 'n/a',
    cameraNear: sc.camera.near,
    cameraFar: sc.camera.far,
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'artifacts/diag-battle.png' });
// 第二张：把相机抬高看全景，验证世界是否存在
await page.evaluate(() => {
  const sc = window.__mistApp.scene;
  sc.updateCamera = () => {};
  sc.camera.position.set(0, 260, 60);
  sc.camera.lookAt(0, 0, 0);
  sc.camera.fov = 55;
  sc.camera.updateProjectionMatrix();
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'artifacts/diag-overview.png' });
await browser.close();
