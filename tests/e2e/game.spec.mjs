import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const root = 'artifacts';
async function ready(page) {
  await page.addInitScript(() => { if (!localStorage.getItem('mist-isle-settings')) localStorage.setItem('mist-isle-settings', JSON.stringify({quality:'low',sound:false})); });
  await page.goto('/'); await page.waitForFunction(() => !!window.mistIsle);
  await expect(page.locator('#boot')).toBeHidden();
}
async function pixels(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.getElementById('world'), gl = canvas.getContext('webgl2');
    const data = new Uint8Array(64 * 64 * 4);
    gl.readPixels(Math.floor(canvas.width / 2 - 32), Math.floor(canvas.height / 2 - 32), 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const colors = new Set(); let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i] + data[i + 1] + data[i + 2] > 30) nonBlack++; colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`); }
    resolve({ colors: colors.size, nonBlack });
  })));
}
function self(page) { return page.evaluate(() => { const s = window.mistIsle.getState(), id = window.mistIsle.getStatus().selfId; return s.players.find(p => p.id === id); }); }

test('desktop training renders, moves, fires, reloads, pauses and returns', async ({ page }) => {
  await mkdir(root, { recursive: true }); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 }); await ready(page);
  await page.screenshot({ path: `${root}/desktop-lobby.png` });
  const lobbyPixels = await pixels(page); expect(lobbyPixels.nonBlack).toBeGreaterThan(3000); expect(lobbyPixels.colors).toBeGreaterThan(3);
  await page.locator('#train').click(); await page.waitForFunction(() => window.mistIsle.getState()?.phase === 'playing');
  const first = await self(page); await page.keyboard.down('KeyW');
  await expect.poll(async () => (await self(page)).z).toBeLessThan(first.z - 2); await page.keyboard.up('KeyW');
  const loaded=await self(page);
  await expect(page.locator('#weapon-name')).not.toBeEmpty();
  await page.mouse.move(780, 300); await page.mouse.down(); await expect.poll(async () => (await self(page)).ammo).toBeLessThan(loaded.ammo); await page.mouse.up();
  await page.keyboard.press('KeyR'); await expect.poll(async () => (await self(page)).ammo).toBe(loaded.ammo);
  await page.screenshot({ path: `${root}/desktop-battle.png` });
  const gamePixels = await pixels(page); expect(gamePixels.colors).toBeGreaterThan(5);
  await page.locator('#game-menu').click(); await expect(page.locator('#pause-dialog')).toBeVisible();
  const pausedAt = await page.evaluate(() => window.mistIsle.getState().time); await page.waitForTimeout(350);
  expect(await page.evaluate(() => window.mistIsle.getState().time)).toBe(pausedAt);
  await page.locator('#exit-match').click(); await expect(page.locator('#menu')).toBeVisible(); expect(errors).toEqual([]);
});

test('four independent clients share a squad, move together and recover a socket', async ({ browser }) => {
  test.setTimeout(120000);
  const contexts=[],pages=[],errors=[];
  try {
    for(let i=0;i<4;i++) {
      const context=await browser.newContext({viewport:{width:844,height:480}}); contexts.push(context);
      const page=await context.newPage(); pages.push(page); page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{const Native=window.WebSocket;window.testSockets=[];window.WebSocket=class extends Native {constructor(...args){super(...args);window.testSockets.push(this);}};});
      await ready(page);
    }
    const host=pages[0]; await host.locator('#online-open').click(); await host.locator('#nickname').fill('Captain'); await host.locator('#create-room').click();
    await expect(host.locator('#room-dialog')).toBeVisible(); const code=await host.locator('#current-code').textContent();
    for(let i=1;i<4;i++) {
      await pages[i].locator('#online-open').click(); await pages[i].locator('#nickname').fill(`Ranger${i}`); await pages[i].locator('#room-code').fill(code); await pages[i].locator('#join-room').click();
      await expect(pages[i].locator('#room-dialog')).toBeVisible(); await expect(pages[i].locator('#start-room')).toBeDisabled();
    }
    await expect(host.locator('#room-players .room-player')).toHaveCount(4); await host.screenshot({path:`${root}/four-player-room.png`});
    await host.locator('#start-room').click();
    await host.waitForFunction(()=>!!window.mistIsle.getState());
    await host.bringToFront();
    const id=await host.evaluate(()=>window.mistIsle.getStatus().selfId), initial=await self(host);
    await host.keyboard.down('KeyW'); await expect.poll(async()=>(await self(host)).z).toBeLessThan(initial.z-1); await host.keyboard.up('KeyW');
    await Promise.all(pages.map(page=>page.waitForFunction(()=>window.mistIsle.getState()?.phase==='playing')));
    for(const peer of pages.slice(1)) await expect.poll(()=>peer.evaluate(id=>window.mistIsle.getState().players.find(p=>p.id===id).z,id)).toBeLessThan(initial.z-1);
    const peer=pages[1], identity=await peer.evaluate(()=>window.mistIsle.getStatus().selfId);
    await peer.evaluate(()=>window.testSockets.at(-1).close()); await expect.poll(()=>peer.evaluate(()=>window.testSockets.length)).toBeGreaterThan(1);
    await expect.poll(()=>peer.evaluate(()=>window.mistIsle.getStatus().reconnecting)).toBe(false);
    expect(await peer.evaluate(()=>window.mistIsle.getStatus().selfId)).toBe(identity);
    expect(await peer.evaluate(()=>window.mistIsle.getState().totalPlayers)).toBe(64);
    await Promise.all(pages.map(page=>expect(page.locator('#squad-members .squad-member')).toHaveCount(4)));
    await peer.screenshot({path:`${root}/four-player-battle.png`}); expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(c=>c.close().catch(()=>{}))); }
});

test('mobile landscape has usable touch controls and no overflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await ready(page); await page.screenshot({ path: `${root}/mobile-lobby.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#train').tap(); await page.waitForFunction(() => window.mistIsle.getState()?.phase === 'playing');
    await expect(page.locator('#move-stick')).toBeVisible(); await expect(page.locator('#aim-stick')).toBeVisible();
    const before = await self(page), box = await page.locator('#move-stick').boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width / 2, y: box.y + 8, id: 0 }] });
    await expect.poll(async () => (await self(page)).z).toBeLessThan(before.z - 1);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.screenshot({ path: `${root}/mobile-battle.png` });
    const check = await pixels(page); expect(check.colors).toBeGreaterThan(3); expect(check.nonBlack).toBeGreaterThan(3000); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('portrait fits and settings apply after reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page); await page.screenshot({ path: `${root}/portrait-lobby.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#settings-open').click(); await page.locator('#quality').selectOption('low'); await page.locator('#sound-toggle').uncheck();
  await page.locator('#settings-dialog [data-close]').click(); await page.reload(); await page.waitForFunction(() => !!window.mistIsle);
  await page.locator('#settings-open').click(); await expect(page.locator('#quality')).toHaveValue('low'); await expect(page.locator('#sound-toggle')).not.toBeChecked();
});

test('bad room is actionable and training still starts', async ({ page }) => {
  await ready(page); await page.locator('#online-open').click(); await page.locator('#room-code').fill('ZZZZZ'); await page.locator('#join-room').click();
  await expect(page.locator('#online-error')).toContainText('房间不存在'); await expect(page.locator('#create-room')).toBeEnabled();
  await page.locator('#online-dialog [data-close]').click(); await page.locator('#train').click(); await expect(page.locator('#hud')).toBeVisible();
});

test('repeated match teardown releases GPU resources',async({page})=>{
  await page.setViewportSize({width:844,height:480});await ready(page);
  const baseline=await page.evaluate(()=>window.mistIsle.getStatus());
  for(let i=0;i<3;i++){
    await page.locator('#train').click();await page.waitForFunction(()=>window.mistIsle.getState()?.phase==='playing');
    await page.locator('#game-menu').click();await page.locator('#exit-match').click();await expect(page.locator('#menu')).toBeVisible();
    await page.waitForTimeout(80);
    const after=await page.evaluate(()=>window.mistIsle.getStatus());
    expect(after.geometries).toBeLessThanOrEqual(baseline.geometries+2);expect(after.textures).toBeLessThanOrEqual(baseline.textures+1);
  }
});
