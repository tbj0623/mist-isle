// MIST ISLE 1.3.0 · 空降（自由航线 + 跳伞）E2E
//
// 契约（本轮实现，读自 shared/simulation.mjs 与 client/ui-hud.js）：
//   · 离线 solo/squad 默认 deployStyle='skydive'：开局 phase='deploying'，快照带 flight，
//     玩家在舱内（deployStage='plane'，y = DEPLOY.planeHeight）。
//   · 舱门开启（flight.open === true）后按空格 → freefall → chute → ground；
//     全员落地后 phase='live'，flight 键完全消失（_flightView 只在 deploying 有值）。
//   · 训练场/生存波次永远 instant：无 flight、无 deployStage、无 #deploy-status。
//   · 联机房间默认 instant，房主用 #btn-deploy-style 切到 skydive；降落区投票（dropHint）
//     与跳伞落点（input.jumpAt）互不覆盖。
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createGameServer } from '../../server/index.mjs';
import { DEPLOY } from '../../shared/rules.mjs';

const SHOTS = 'artifacts/e2e';
const DESKTOP = { width: 1280, height: 720 };

test.beforeAll(async () => { await mkdir(SHOTS, { recursive: true }); });

/** 收集控制台错误 / 未捕获异常。 */
function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return errors;
}

/** 打开页面并等待诊断接口就绪；boot 遮罩必须在 15s 内消失。 */
async function boot(page, url = '/') {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mist-isle-settings-v2')) {
      localStorage.setItem('mist-isle-settings-v2', JSON.stringify({ quality: 'low', music: false, sound: false, tutorialDone: true, hint: 0 }));
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.mistIsle, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const node = document.getElementById('boot');
    return !node || node.classList.contains('hidden');
  }, null, { timeout: 15000 });
}

const status = (page) => page.evaluate(() => window.mistIsle.getStatus());

/** 空降相关字段一次性取回；断言消息里直接带实际值，排障不用再回 Open。 */
const deployView = (page) => page.evaluate(() => {
  const s = window.mistIsle.getState();
  const me = s?.me || null;
  return {
    phase: s?.phase ?? null,
    hasFlight: !!s && Object.prototype.hasOwnProperty.call(s, 'flight'),
    flight: s?.flight ?? null,
    stage: me?.deployStage ?? null,
    y: me?.y ?? null,
    total: s?.counts?.total ?? null,
  };
});

/** 主菜单 → 出击 → 模式 → 单机开局（等到 app.mode === 'match'）。 */
async function enterMode(page, modeId) {
  await page.locator('#nav-play').click();
  await expect(page.locator('#screen-root')).toHaveAttribute('data-active', 'play');
  await page.locator(`#mode-${modeId}`).click();
  await expect(page.locator(`#mode-${modeId}`), `模式 ${modeId} 应被选中`).toHaveClass(/active/);
  await page.locator('#btn-offline').click();
  await expect.poll(async () => (await status(page)).mode, { timeout: 20000 }).toBe('match');
}

test('desktop · 空降：航线视图、舱内状态、空格跳伞到落地', async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize(DESKTOP);
  const errors = watch(page);
  await boot(page);
  await enterMode(page, 'solo');

  // ── 舱内待命：航线 + 舱内阶段 + 空降状态条 ────────────────────────────────
  await expect.poll(async () => (await deployView(page)).phase, {
    timeout: 30000,
    message: '离线 solo 默认 skydive，开局后 phase 应为 deploying',
  }).toBe('deploying');

  const plane = await deployView(page);
  expect(plane.hasFlight, `deploying 阶段快照必须带 flight 航线视图，实际键缺失（phase=${plane.phase}）`).toBe(true);
  for (const key of ['fromX', 'fromZ', 'toX', 'toZ', 'ux', 'uz', 'open', 'closeIn', 'jumped', 'total']) {
    expect(plane.flight, `flight.${key} 缺失，实际 flight=${JSON.stringify(plane.flight)}`).toHaveProperty(key);
  }
  expect(plane.flight.total, `航线总人数应等于玩家数 ${plane.total}，实际 ${plane.flight.total}`).toBe(plane.total);
  expect(plane.flight.closeIn, `舱门倒计时 closeIn 应为正数，实际 ${plane.flight.closeIn}`).toBeGreaterThan(0);
  // 航线必须横穿地图：两端跨度远大于地图半径（qinglan radius=182）
  const span = Math.hypot(plane.flight.toX - plane.flight.fromX, plane.flight.toZ - plane.flight.fromZ);
  expect(span, `航线跨度 ${span.toFixed(1)}m 应大于地图半径`).toBeGreaterThan(150);

  expect(plane.stage, `舱内 deployStage 应为 plane，实际 ${plane.stage}`).toBe('plane');
  // 舱内高度 = DEPLOY.planeHeight（190m）。DEPLOY.dropHeight（150m）是跳出机舱后的起始高度，
  // 两者不要混：_beginFlight 里写的是 planeHeight，_beginFreefall 才切到 dropHeight。
  expect(Math.abs(plane.y - DEPLOY.planeHeight), `舱内高度应约 ${DEPLOY.planeHeight}m，实际 ${plane.y}m`).toBeLessThan(1);

  await expect(page.locator('#deploy-status'), '舱内应显示空降状态条 #deploy-status').toBeVisible();
  await expect(page.locator('#deploy-stage'), '舱内阶段文案应为「舱内待命」').toContainText('舱内待命');
  await expect(page.locator('#deploy-alt'), '舱门未开时 #deploy-alt 应为「舱门关闭中」或「可跳 · Ns」').toHaveText(/舱门关闭中|可跳 · \d+s/);
  await page.waitForTimeout(120); // 只给一帧渲染，逻辑判断一律走 expect.poll
  await page.screenshot({ path: `${SHOTS}/desktop-skydive-01-plane.png` });

  // ── 舱门开启：flight.open 由航线状态机翻转 ───────────────────────────────
  await expect.poll(async () => {
    const view = await deployView(page);
    return view.flight ? view.flight.open : 'no-flight';
  }, { timeout: 40000, message: '舱门应在航线进入地图后自动打开（flight.open === true）' }).toBe(true);

  const door = await deployView(page);
  expect(door.stage, `舱门开启时玩家仍应在舱内，实际 deployStage=${door.stage}`).toBe('plane');
  await expect(page.locator('#deploy-alt'), '舱门开启后 #deploy-alt 应显示可跳倒计时').toHaveText(/可跳 · \d+s/);
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${SHOTS}/desktop-skydive-02-door-open.png` });

  // ── 空格跳伞：freefall → chute → ground ──────────────────────────────────
  await page.keyboard.press('Space');
  await expect.poll(async () => (await deployView(page)).stage, {
    timeout: 15000,
    message: '按空格后 deployStage 应变成 freefall（jumpFromPlane 接受了跳伞请求）',
  }).toBe('freefall');

  const freefall = await deployView(page);
  expect(freefall.y, `自由落体起始高度应 ≤ ${DEPLOY.dropHeight}m，实际 ${freefall.y}m`).toBeLessThanOrEqual(DEPLOY.dropHeight + 1);
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${SHOTS}/desktop-skydive-03-freefall.png` });

  await expect.poll(async () => (await deployView(page)).stage, {
    timeout: 15000,
    message: '自由落体结束后应自动开伞（chute）',
  }).toBe('chute');
  await expect(page.locator('#deploy-stage'), '开伞后阶段文案应为「伞降滑翔」').toContainText('伞降滑翔');
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${SHOTS}/desktop-skydive-04-chute.png` });

  await expect.poll(async () => (await deployView(page)).stage, {
    timeout: 20000,
    message: '伞降滑翔结束后应落地（ground）',
  }).toBe('ground');

  const landed = await deployView(page);
  expect(landed.y, `落地后高度应为 0，实际 ${landed.y}m`).toBe(0);
  await expect(page.locator('#deploy-status'), '落地后 #deploy-status 应隐藏（updateDeploy: stage=ground → flying=false）').toBeHidden();
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${SHOTS}/desktop-skydive-05-landed.png` });

  // ── 全员落地 → live，航线视图消失 ────────────────────────────────────────
  await expect.poll(async () => (await deployView(page)).phase, {
    timeout: 60000,
    message: '其他 AI 也落地后 phase 应进入 live',
  }).toMatch(/live|playing/);

  const live = await deployView(page);
  expect(live.hasFlight, `全员落地后 flight 键应完全缺失（_flightView 在非 deploying 返回 undefined），实际 flight=${JSON.stringify(live.flight)}`).toBe(false);
  expect(live.stage, `落地后 deployStage 应保持 ground，实际 ${live.stage}`).toBe('ground');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/desktop-skydive-06-live.png` });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('desktop · 空降：训练场保持瞬时部署（无航线/无空降 HUD）', async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize(DESKTOP);
  const errors = watch(page);
  await boot(page);

  await page.locator('#nav-play').click();
  await expect(page.locator('#screen-root')).toHaveAttribute('data-active', 'play');
  await page.locator('#mode-training').click();
  await expect(page.locator('#mode-training')).toHaveClass(/active/);
  const startedAt = Date.now();
  await page.locator('#btn-offline').click();
  await expect.poll(async () => (await status(page)).mode, { timeout: 20000 }).toBe('match');

  // instant：从第一帧起就没有航线 / 空降阶段（键完全缺失，不是 null）
  const early = await deployView(page);
  expect(early.hasFlight, `训练场是 instant，快照不应有 flight 键，实际 flight=${JSON.stringify(early.flight)}`).toBe(false);
  expect(early.stage, `instant 部署下 deployStage 必须缺失（不能是 'plane'），实际 ${early.stage}`).toBeNull();
  await expect(page.locator('#deploy-status'), 'instant 部署不应出现空降状态条').toBeHidden();

  await expect.poll(async () => (await deployView(page)).phase, {
    timeout: 15000,
    message: 'instant 部署应在约 2.5s 模拟时间后进入 live',
  }).toMatch(/live|playing/);

  const elapsed = Date.now() - startedAt;
  expect(elapsed, `训练场从开局到 live 用时 ${elapsed}ms，应远快于跳伞路线（单次航线就要 20s+）`).toBeLessThan(10000);

  const live = await deployView(page);
  expect(live.hasFlight, `live 后仍不应出现 flight 键，实际 flight=${JSON.stringify(live.flight)}`).toBe(false);
  expect(live.stage, `live 后 deployStage 仍应缺失，实际 ${live.stage}`).toBeNull();
  await expect(page.locator('#deploy-status'), '全程不得出现空降状态条').toBeHidden();
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${SHOTS}/desktop-skydive-07-training-instant.png` });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('desktop · 空降：降落区投票与跳伞落点不冲突', async ({ page }) => {
  test.setTimeout(180000);
  const server = createGameServer({ host: '127.0.0.1', port: 0, log: { level: 'error' } });
  const address = await server.listen();
  const errors = watch(page);
  try {
    await page.setViewportSize(DESKTOP);
    await boot(page, `http://127.0.0.1:${address.port}`);

    // ── 建房 ────────────────────────────────────────────────────────────────
    await page.locator('#nav-play').click();
    await page.locator('#mode-squad').click();
    await page.locator('#btn-online').click();
    await expect(page.locator('#online-dialog')).toBeVisible();
    await page.locator('#nickname').fill('SkyLead');
    await page.locator('#btn-create-room').click();
    await expect(page.locator('#room-dialog')).toBeVisible();
    const code = (await page.locator('#current-code').textContent()).trim();
    expect(code, `邀请码应为 5 位，实际 "${code}"`).toMatch(/^[A-Z0-9]{5}$/);

    // ── 房主切换空降方式：直接落地 → 跳伞 ───────────────────────────────────
    const styleBtn = page.locator('#btn-deploy-style');
    await expect(styleBtn).toBeVisible();
    // 自建服务器默认 instant；若用 DEPLOY_STYLE=skydive 起服，房间初始就是跳伞，
    // 先切回直接落地，保证下面这一次点击一定是从 instant → skydive。
    if ((await styleBtn.getAttribute('aria-pressed')) === 'true') {
      await styleBtn.click();
      await expect(styleBtn).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(styleBtn, '默认应为「空降：直接落地」').toContainText('直接落地');
    await styleBtn.click();
    await expect(styleBtn, '点击后按钮应变为选中态').toHaveAttribute('aria-pressed', 'true');
    await expect(styleBtn, '点击后按钮文案应为「空降：跳伞」').toContainText('空降：跳伞');
    await expect.poll(() => server.rooms.get(code)?.match?.deployStyle, {
      timeout: 10000,
      message: '服务端房间应收到 config 并把 deployStyle 切到 skydive',
    }).toBe('skydive');

    // ── 降落区投票（与跳伞方式互不覆盖）────────────────────────────────────
    await page.locator('#btn-dropzone').click();
    await expect(page.locator('#dropzone-dialog')).toBeVisible();
    const zone = await page.locator('#dropzone-canvas').boundingBox();
    expect(zone, '降落区地图 canvas 必须可见').toBeTruthy();
    await page.mouse.click(zone.x + zone.width / 2, zone.y + zone.height / 2);
    await expect(page.locator('#dropzone-status'), '点选后应提示落点已选').toContainText('落点已选');
    await expect.poll(() => server.rooms.get(code)?.dropVotes?.size ?? 0, {
      timeout: 10000,
      message: '服务端应记录本机的降落区投票',
    }).toBeGreaterThanOrEqual(1);
    expect(server.rooms.get(code)?.match?.deployStyle, '投票不应把空降方式改回 instant').toBe('skydive');
    await page.getByRole('button', { name: '返回房间' }).click();
    await expect(page.locator('#dropzone-dialog')).toBeHidden();

    // 投票质心（0.5,0.5）应作为小队 dropHint 进入对局
    const vote = server.rooms.get(code).dropVotes.values().next().value;
    expect(vote, '服务端应有投票记录').toBeTruthy();

    // ── 开局：航线 / 舱门 / 跳伞 ────────────────────────────────────────────
    await page.locator('#btn-start-room').click();
    await expect.poll(async () => (await status(page)).mode, { timeout: 30000 }).toBe('match');
    await expect.poll(async () => (await deployView(page)).phase, {
      timeout: 40000,
      message: '联机房间切到 skydive 后，开局应有 deploying 阶段',
    }).toBe('deploying');

    const plane = await deployView(page);
    expect(plane.stage, `联机 skydive 开局应在舱内（plane），实际 ${plane.stage}`).toBe('plane');
    expect(plane.hasFlight, '联机 skydive 开局快照应带 flight 航线').toBe(true);

    const room = server.rooms.get(code);
    const hint = room.match.dropHints?.[0];
    expect(hint, `降落区投票应作为小队 0 的 dropHint 传入对局，实际 dropHints=${JSON.stringify(room.match.dropHints)}`).toBeTruthy();
    expect(Math.abs(hint.x - vote.x) + Math.abs(hint.z - vote.z), `dropHint 应贴近投票点 (${vote.x},${vote.z})，实际 (${hint.x},${hint.z})`).toBeLessThan(0.02);
    expect(room.match.deployStyle, '开局后房间仍应保持 skydive').toBe('skydive');

    await expect.poll(async () => {
      const view = await deployView(page);
      return view.flight ? view.flight.open : 'no-flight';
    }, { timeout: 40000, message: '联机 skydive 的舱门也应自动打开' }).toBe(true);

    // 记录上行 input 里的 jumpAt（客户端输入 → 服务端的落点链路）
    await page.evaluate(() => {
      const net = window.__mistApp?.net;
      if (!net) throw new Error('联机模式缺 net');
      const original = net.sendInput.bind(net);
      window.__jumpInputs = [];
      net.sendInput = (input) => {
        if (input && input.jump === true) {
          window.__jumpInputs.push({ jumpAt: input.jumpAt ? { x: input.jumpAt.x, z: input.jumpAt.z } : null });
        }
        return original(input);
      };
    });

    // 玩家转向（鼠标点选一个画面方向，等价于舱内转身选落点）后按空格
    const world = await page.locator('#world').boundingBox();
    expect(world, '对局中必须存在 #world canvas').toBeTruthy();
    await page.mouse.click(world.x + world.width / 2 + 160, world.y + world.height / 2 - 120);
    // 转向是否生效看 input 自己记账的 aimValid：enterMatch 会 clear() 把它复位，
    // 只有在 canvas 上重新算出瞄准角之后才为 true（不是单纯的「鼠标点过」）。
    await expect.poll(async () => page.evaluate(() => {
      const input = window.__mistApp?.input;
      return { valid: !!(input && input.aimValid), finiteAim: Number.isFinite(input?.aim) };
    }), { timeout: 5000, message: '鼠标点击 canvas 后输入层应采到新的瞄准角（aimValid）' }).toEqual({ valid: true, finiteAim: true });

    await page.keyboard.press('Space');
    await expect.poll(async () => (await deployView(page)).stage, {
      timeout: 15000,
      message: '联机 skydive 按空格后应进入 freefall（jumpAt 链路没崩）',
    }).toBe('freefall');

    const jumps = await page.evaluate(() => window.__jumpInputs || []);
    expect(jumps.length, '按空格期间至少应有一帧上行 input 带 jump=true').toBeGreaterThan(0);
    for (const frame of jumps) {
      expect(frame.jumpAt, `跳伞帧必须带 jumpAt 落点（客户端 _jumpTarget），实际 ${JSON.stringify(frame)}`).toBeTruthy();
      expect(frame.jumpAt.x, `jumpAt.x 应在 [0,1]，实际 ${frame.jumpAt.x}`).toBeGreaterThanOrEqual(0);
      expect(frame.jumpAt.x, `jumpAt.x 应在 [0,1]，实际 ${frame.jumpAt.x}`).toBeLessThanOrEqual(1);
      expect(frame.jumpAt.z, `jumpAt.z 应在 [0,1]，实际 ${frame.jumpAt.z}`).toBeGreaterThanOrEqual(0);
      expect(frame.jumpAt.z, `jumpAt.z 应在 [0,1]，实际 ${frame.jumpAt.z}`).toBeLessThanOrEqual(1);
    }

    const selfId = (await status(page)).selfId;
    const player = room.match.players.find((p) => p.id === selfId);
    expect(player, `服务端应能找到本机玩家 ${selfId}`).toBeTruthy();
    expect(player.dropSpot, '服务端应为跳伞者记录落地坐标 dropSpot').toBeTruthy();
    expect(player.dropTarget, '服务端应为跳伞者记录归一化落点 dropTarget').toBeTruthy();

    // 落点应贴近客户端 jumpAt（说明用的是玩家选点，而不是航线兜底 +34m）
    const jumpAt = jumps[jumps.length - 1].jumpAt;
    const R = room.match.world.radius;
    const wantX = (jumpAt.x * 2 - 1) * R;
    const wantZ = (jumpAt.z * 2 - 1) * R;
    const err = Math.hypot(player.dropSpot.x - wantX, player.dropSpot.z - wantZ);
    expect(err, `服务端落点距客户端 jumpAt ${err.toFixed(1)}m（应 <40m，远小于投放兜底的随机距离）`).toBeLessThan(40);

    await page.waitForTimeout(120);
    await page.screenshot({ path: `${SHOTS}/desktop-skydive-08-online-freefall.png` });
  } finally {
    await server.close();
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
