// 雾岛突围 / MIST ISLE 1.1 — 遥测与分析测试
// 覆盖：队列/自动 flush、PII 脱敏、超长截断、漏斗聚合、对局分析、
//       服务端限流与鉴权、10 万行流式聚合不 OOM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telemetry, aggregate, analyzeMatches, sanitize, pickProps, EVENTS, FUNNEL_STEPS } from '../shared/telemetry.mjs';
import { createTelemetryService, normalizeEvents } from '../server/telemetry.mjs';
import { createGameServer } from '../server/index.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'mist-tel-'));
const okFetch = (sink) => async (url, init) => {
  sink.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive });
  return { ok: true, status: 200 };
};
/** 起一个带遥测服务的真实 HTTP 服务，返回 { base, dir }。 */
async function setup(t, token = 'k') {
  const dir = await tmp();
  const app = createGameServer({ host: '127.0.0.1', port: 0, log: { level: 'error' }, telemetryOptions: { dir, token } });
  const { port } = await app.listen();
  t.after(() => app.close());
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { base: `http://127.0.0.1:${port}`, dir, app };
}

test('Telemetry.track 入队，达到 bufferSize 自动 flush', async () => {
  const batches = [];
  const t = new Telemetry({ endpoint: '/telemetry', bufferSize: 5, flushMs: 0, fetchImpl: okFetch(batches) });
  t.track('funnel', { step: 'boot', ok: true });
  assert.equal(t.size, 1, '未满 buffer 不应 flush');
  for (let i = 0; i < 4; i++) t.track('screen_open', { screen: 'home', from: 'boot' });
  await new Promise((r) => setImmediate(r));
  assert.equal(t.size, 0, '满 buffer 后队列应清空');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].body.length, 5);
  assert.equal(batches[0].keepalive, true, '必须 keepalive，页面卸载时才能送达');
  assert.equal(batches[0].body[0].name, 'funnel');
  t.stop();
});

test('flush 分批发送：超过 MAX_BATCH 时拆成多个请求', async () => {
  const batches = [];
  const t = new Telemetry({ endpoint: '/telemetry', bufferSize: 500, flushMs: 0, maxQueue: 500, fetchImpl: okFetch(batches) });
  for (let i = 0; i < 150; i++) t.track('funnel', { step: 'home', ok: true });
  const res = await t.flush('test');
  assert.equal(res.ok, true);
  assert.equal(res.sent, 150);
  assert.deepEqual(batches.map((b) => b.body.length), [100, 50], '100 + 50 两批');
  t.stop();
});

test('sanitize 去掉邮箱 / 手机号 / 座机 / IP', () => {
  const out = sanitize({
    note: 'mail me at player@example.com or call 13812345678 / 010-88886666',
    addr: '来自 192.168.1.24 和 2001:db8:85a3::8a2e:370:7334',
    nickname: '夜刃', deviceId: 'abc123', weaponId: 'ar7', distance: 21,
  });
  for (const leaked of ['player@example.com', '13812345678', '88886666', '192.168.1.24', '2001:db8']) {
    assert.equal(`${out.note} ${out.addr}`.includes(leaked), false, `${leaked} 必须脱敏`);
  }
  assert.equal(out.nickname, undefined, '昵称属于 PII，整字段丢弃');
  assert.equal(out.deviceId, undefined, '设备标识整字段丢弃');
  assert.equal(out.weaponId, 'ar7', '正常业务字段必须保留');
  assert.equal(out.distance, 21);
});

test('props 超长被截断到 200 字符', () => {
  assert.equal(sanitize({ screen: 'x'.repeat(500) }).screen.length, 200);
  const t = new Telemetry({ endpoint: null, flushMs: 0 });
  t.track('screen_open', { screen: 'y'.repeat(400), from: 'boot' });
  assert.equal(t.getQueue()[0].props.screen.length, 200);
  t.stop();
});

test('未知事件名与白名单外属性被丢弃', () => {
  const t = new Telemetry({ endpoint: null, flushMs: 0 });
  assert.equal(t.track('nope', { a: 1 }), null);
  assert.equal(t.size, 0, '未知事件不入队');
  t.track('weapon_fire', { weaponId: 'ar7', distance: 12, secretField: 'x' });
  assert.deepEqual(Object.keys(t.getQueue()[0].props).sort(), ['distance', 'weaponId']);
  assert.deepEqual(pickProps('funnel', { step: 'bogus', ok: true }), {}, '非法漏斗步骤整条丢弃');
  t.stop();
});

test('aggregate 正确算漏斗转化率与界面停留', () => {
  const events = [];
  const mk = (sid, step) => events.push({ name: 'funnel', sid, props: { step, ok: true } });
  for (let i = 0; i < 10; i++) mk(`s${i}`, 'boot');
  for (let i = 0; i < 8; i++) mk(`s${i}`, 'home');
  for (let i = 0; i < 5; i++) mk(`s${i}`, 'play');
  for (let i = 0; i < 2; i++) mk(`s${i}`, 'deploy');
  events.push({ name: 'screen_open', sid: 's0', props: { screen: 'home' } });
  events.push({ name: 'screen_leave', sid: 's0', props: { screen: 'home', durationMs: 4000 } });
  events.push({ name: 'screen_leave', sid: 's0', props: { screen: 'home', durationMs: 6000 } });
  const agg = aggregate(events);
  assert.equal(agg.sessions, 10);
  assert.deepEqual(agg.funnel.map((f) => f.step), [...FUNNEL_STEPS]);
  assert.equal(agg.funnel[0].rate, 1);
  assert.equal(agg.funnel[1].rate, 0.8);
  assert.equal(agg.funnel[2].rate, 0.5);
  assert.equal(agg.funnel[3].drop, 3, 'play→deploy 流失 3 个会话');
  assert.equal(agg.funnel[4].count, 0, '缺失步骤补 0 而不是缺行');
  const home = agg.screens.find((s) => s.screen === 'home');
  assert.equal(home.opens, 1);
  assert.equal(home.avgDurationMs, 5000);
});

test('aggregate 统计武器使用率 / 击杀 / 距离', () => {
  const agg = aggregate([
    { name: 'weapon_fire', sid: 'a', props: { weaponId: 'ar7', distance: 20 } },
    { name: 'weapon_fire', sid: 'a', props: { weaponId: 'ar7', distance: 30 } },
    { name: 'weapon_fire', sid: 'a', props: { weaponId: 'v9', distance: 5 } },
    { name: 'weapon_kill', sid: 'a', props: { weaponId: 'ar7', distance: 25, headshot: true } },
    { name: 'death', sid: 'a', props: { killerWeapon: 'v9', distance: 4, byHeadshot: false } },
  ]);
  const ar7 = agg.weapons.find((w) => w.id === 'ar7');
  assert.equal(ar7.fires, 2);
  assert.equal(ar7.kills, 1);
  assert.equal(ar7.killShare, 1, '唯一击杀来自 ar7');
  assert.equal(ar7.avgDistance, 25, '(20+30+25)/3');
  assert.equal(agg.deaths[0].killerWeapon, 'v9');
});

test('analyzeMatches 算胜率 / 平均排名 / 武器使用', () => {
  const r = analyzeMatches([
    { mode: 'solo', durationSec: 300, winnerTeam: 0, players: [{ id: 'a', bot: false, team: 0, rank: 1, kills: 4, damage: 600, weapons: ['ar7'] }] },
    { mode: 'solo', durationSec: 200, winnerTeam: 1, players: [{ id: 'b', bot: false, team: 0, rank: 5, kills: 1, damage: 120, weapons: ['v9'] }] },
    { mode: 'squad', durationSec: 400, winnerTeam: 2, players: [{ id: 'c', bot: false, team: 1, rank: 3, kills: 2, damage: 300, weapons: ['ar7', 'p9'] }] },
  ]);
  assert.equal(r.matches, 3);
  assert.equal(r.players, 3);
  assert.equal(r.winRate, 0.3333, '1/3 胜率');
  assert.equal(r.avgPlacement, 3, '(1+5+3)/3');
  assert.equal(r.avgKills, 2.33);
  assert.equal(r.avgDurationSec, 300);
  const ar7 = r.weapons.find((w) => w.id === 'ar7');
  assert.equal(ar7.uses, 2);
  assert.equal(ar7.share, 0.5, '4 次使用里 2 次是 ar7');
});

test('服务端 /telemetry 拒绝超大 payload 与超条数批次', async (t) => {
  const { base } = await setup(t);
  const post = (body) => fetch(`${base}/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  // 101 条 > MAX_BATCH(100)：按条数拒绝
  const tooMany = await post(JSON.stringify(Array.from({ length: 101 }, () => ({ name: 'funnel', props: { step: 'boot' } }))));
  assert.equal(tooMany.status, 413);
  assert.equal((await tooMany.json()).error, 'batch_too_large');
  // 1MB + 1 字节：按体积拒绝（Content-Length 提前拦截，不先读进内存）
  const huge = await post('x'.repeat(1024 * 1024 + 1));
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).error, 'payload_too_large');
  // 正常批次照常写入
  const good = await post(JSON.stringify([{ name: 'funnel', props: { step: 'boot' } }]));
  assert.equal(good.status, 200);
  assert.equal((await good.json()).accepted, 1);
});

test('/analytics/summary 无 token 返回 401，正确 token 返回聚合', async (t) => {
  const { base } = await setup(t, 'secret');
  assert.equal((await fetch(`${base}/analytics/summary`)).status, 401, '无 token 必须 401');
  assert.equal((await fetch(`${base}/analytics/summary`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const events = [
    { name: 'funnel', sid: 'a', props: { step: 'boot', ok: true } },
    { name: 'funnel', sid: 'a', props: { step: 'home', ok: true } },
    { name: 'weapon_fire', sid: 'a', props: { weaponId: 'ar7', distance: 18 } },
    { name: 'weapon_kill', sid: 'a', props: { weaponId: 'ar7', distance: 20, headshot: false } },
    { name: 'session_end', sid: 'a', props: { durationMs: 600000, matchesPlayed: 1 } },
  ];
  const post = await fetch(`${base}/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(events) });
  assert.equal((await post.json()).accepted, 5);
  const summary = await (await fetch(`${base}/analytics/summary`, { headers: { authorization: 'Bearer secret' } })).json();
  assert.equal(summary.sessions, 1);
  assert.equal(summary.avgSessionMin, 10);
  assert.equal(summary.funnel[0].rate, 1);
  assert.equal(summary.weapons[0].id, 'ar7');
  assert.equal(summary.balance.topWeapons[0].id, 'ar7');
  const funnelOnly = await (await fetch(`${base}/analytics/funnel`, { headers: { 'x-analytics-token': 'secret' } })).json();
  assert.equal(funnelOnly.funnel.length, FUNNEL_STEPS.length);
  assert.equal((await fetch(`${base}/analytics/weapons`, { headers: { authorization: 'Bearer secret' } })).status, 200);
});

test('未配置 ANALYTICS_TOKEN 时分析端点 503（默认不裸奔）', async (t) => {
  const { base } = await setup(t, null);
  assert.equal((await fetch(`${base}/analytics/summary`)).status, 503);
});

test('ingest 落盘为按天 JSONL，坏行/未知事件被丢弃但不影响整批', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = createTelemetryService({ dir, token: 'k' });
  const { accepted, rejected } = await service.ingest([
    { name: 'funnel', sid: 'a', props: { step: 'boot', ok: true } },
    { name: 'unknown_event', sid: 'a', props: {} },
    { name: 'weapon_fire', sid: 'a', props: { weaponId: 'ar7', distance: 9 } },
    null,
  ]);
  assert.equal(accepted, 2);
  assert.equal(rejected, 2);
  const all = await service.readAll();
  assert.equal(all.length, 2);
  assert.ok(all.every((e) => typeof e.ts === 'number'), '每条都补了时间戳');
});

test('流式读取不 OOM：10 万行仍能算完 summary', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // 边生成边写盘：测试自身不持有 10 万行，才能真实测聚合端的堆占用。
  const day = new Date().toISOString().slice(0, 10);
  const out = createWriteStream(join(dir, `${day}.jsonl`), { encoding: 'utf8' });
  let chunk = '';
  for (let i = 0; i < 100000; i++) {
    const name = i % 10 === 0 ? 'weapon_fire' : i % 10 === 1 ? 'funnel' : 'screen_open';
    const props = name === 'weapon_fire' ? { weaponId: 'ar7', distance: 20 }
      : name === 'funnel' ? { step: 'boot', ok: true } : { screen: 'home' };
    chunk += `${JSON.stringify({ name, sid: `s${i % 5000}`, ts: Date.now(), props })}\n`;
    if (chunk.length > 65536) { if (!out.write(chunk)) await once(out, 'drain'); chunk = ''; }
  }
  out.end(chunk);
  await once(out, 'finish');

  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const summary = await createTelemetryService({ dir, token: 'k' }).summary(0);
  const deltaMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  assert.equal(summary.windows.events, 100000);
  assert.equal(summary.sessions, 5000);
  assert.equal(summary.weapons[0].fires, 10000);
  assert.ok(deltaMb < 80, `堆增量应远小于事件体积（实际 ${deltaMb.toFixed(1)}MB）`);
  t.diagnostic(`10 万行聚合堆增量 ${deltaMb.toFixed(1)}MB`);
});

test('normalizeEvents 过滤未知字段并保留白名单属性', () => {
  const { events } = normalizeEvents([
    { name: 'match_end', sid: 'x', ts: 1, props: { mode: 'solo', won: true, nickname: 'x', weird: 1 } },
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0].props).sort(), ['mode', 'won']);
  assert.equal(events[0].sid, 'x');
  assert.equal(Object.keys(EVENTS).includes('match_end'), true);
});

// ── 缺陷 3 回归：时间戳必须钳制在合理窗口内，禁止凭 ts 造日期文件 ──────────────
// 历史 bug：normalizeEvents 只做 Number.isFinite 检查，ts = 1e16 时
// dayKeyOf(new Date(1e16)) 的 toISOString() 抛 RangeError（整批 500）；
// 而 2099 年这类合法范围内的远端时间会写出 data/telemetry/2099-01-01.jsonl，
// 攻击者可反复提交不同日期把 data 目录塞满，撑爆 inode。
import { readdir } from 'node:fs/promises';
import { clampTs } from '../server/telemetry.mjs';

test('normalizeEvents 钳制越界时间戳：1e16 / -1 / NaN / 2099 都不抛错', () => {
  const before = Date.now();
  const { events } = normalizeEvents([
    { name: 'session_end', sid: 'a', ts: 1e16 },
    { name: 'session_end', sid: 'b', ts: -1 },
    { name: 'session_end', sid: 'c', ts: Number.NaN },
    { name: 'session_end', sid: 'd', ts: new Date('2099-01-01T00:00:00Z').getTime() },
    { name: 'session_end', sid: 'e', ts: Number.POSITIVE_INFINITY },
    { name: 'session_end', sid: 'f', ts: new Date(before - 8 * 86400000).getTime() }, // 8 天前
    { name: 'session_end', sid: 'g', ts: new Date(before + 2 * 3600000).getTime() },  // 2 小时后
  ]);
  assert.equal(events.length, 7, '字段本身合法的事件都要保留（钳制而不是丢弃）');
  for (const ev of events) {
    assert.equal(Number.isFinite(ev.ts), true, `ts 必须是有限数：${ev.ts}`);
    assert.ok(Math.abs(ev.ts - Date.now()) < 60 * 1000, `越界 ts 应回落到服务端当前时间：${ev.ts}`);
    assert.doesNotThrow(() => new Date(ev.ts).toISOString());
  }
  // 合法窗口内的 ts 原样保留
  const inWindow = before - 3600 * 1000;
  assert.equal(normalizeEvents([{ name: 'session_end', ts: inWindow }]).events[0].ts, inWindow);
});

test('clampTs：窗口边界（7 天前 / 1 小时后）', () => {
  const now = 1_700_000_000_000;
  assert.equal(clampTs(now - 7 * 86400000 + 1000, now), now - 7 * 86400000 + 1000, '窗口内保留');
  assert.equal(clampTs(now - 7 * 86400000 - 1000, now), now, '超出 7 天回落');
  assert.equal(clampTs(now + 3600000 - 1000, now), now + 3600000 - 1000, '1 小时内保留（容忍时钟漂移）');
  assert.equal(clampTs(now + 3600000 + 1000, now), now, '超出 1 小时回落');
  assert.equal(clampTs('not-a-number', now), now);
  assert.equal(clampTs(null, now), now);
});

test('ingest：恶意时间戳不抛错，且不创建非当天/非近期的日期文件', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = createTelemetryService({ dir, token: 'k' });
  const day = new Date().toISOString().slice(0, 10);

  // 1e16 在旧实现里会让 dayKeyOf 抛 RangeError（未捕获 → 整个请求 500）
  const result = await service.ingest([
    { name: 'session_end', sid: 'a', ts: 1e16 },
    { name: 'session_end', sid: 'b', ts: -1 },
    { name: 'session_end', sid: 'c', ts: Number.NaN },
    { name: 'session_end', sid: 'd', ts: new Date('2099-01-01T00:00:00Z').getTime() },
    { name: 'session_end', sid: 'e', ts: 0 },
  ]);
  assert.equal(result.accepted, 5, '全部被钳制到当前时间后正常写入');
  assert.equal(result.rejected, 0);

  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, [`${day}.jsonl`], `只允许当天一个文件，实际：${files.join(',')}`);
  assert.equal(files.some((f) => f.startsWith('2099-')), false, '绝不能出现 2099 年的文件');
  const all = await service.readAll();
  assert.equal(all.length, 5);
  assert.equal(all.every((ev) => Math.abs(ev.ts - Date.now()) < 60 * 1000), true, '落盘 ts 都是近期时间');
});

test('ingest：绕过归一化的非法 ts 也只是跳过该条，不抛出', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { dayKeyFor, dayInRange } = await import('../server/telemetry.mjs');
  // 归一化层的钳制是第一道闸；ingest 内的 dayKeyOf 还要有独立的兜底。
  // 直接验证兜底函数：越界/非法 ts 必须返回 null（而不是抛 RangeError）。
  for (const bad of [1e16, -1e16, Number.NaN, Number.POSITIVE_INFINITY, -1e20]) {
    assert.equal(dayKeyFor(bad), null, `ts=${bad} 不应算出日期`);
  }
  assert.equal(dayKeyFor(Date.now()), new Date().toISOString().slice(0, 10));
  // 范围校验：格式合法的远端日期同样不得落盘
  assert.equal(dayInRange('2099-01-01'), false);
  assert.equal(dayInRange('1999-01-01'), false);

  // 真实 ingest 链路：1e16 经钳制后回流到当天，不抛错、只产生当天文件
  const service = createTelemetryService({ dir, token: 'k' });
  const dirty = { name: 'session_end', sid: 'x', ts: 1e16, v: 1, props: {} };
  const good = { name: 'session_end', sid: 'y', ts: Date.now(), v: 1, props: {} };
  await assert.doesNotReject(() => service.ingest([dirty, good]));
  const all = await service.readAll();
  assert.equal(all.length, 2, '两条都钳制到当天后落盘');
  assert.equal(all.every((ev) => Number.isFinite(ev.ts)), true);
  const files = await readdir(dir);
  assert.deepEqual(files, [`${new Date().toISOString().slice(0, 10)}.jsonl`], '只允许当天文件');
});

test('writeDay 日期白名单：非 YYYY-MM-DD 一律拒写并计入 stats.broken', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = createTelemetryService({ dir, token: 'k' });
  const { isValidDay, dayInRange } = await import('../server/telemetry.mjs');
  const today = new Date().toISOString().slice(0, 10);
  // 白名单函数本身
  for (const bad of ['2026-13-45', '../etc', '2026-1-1', '', null, 20260101, '2026-01-01/../../x']) {
    assert.equal(isValidDay(bad), false, `${bad} 不应通过白名单`);
  }
  assert.equal(isValidDay('2026-10-29'), true);
  assert.equal(isValidDay('2099-01-01'), true, '格式合法');
  assert.equal(dayInRange('2099-01-01'), false, '但超出日期窗口，不得落盘');
  assert.equal(dayInRange(today), true, '当天允许');

  // 真正调用落盘入口：脏日期不能建文件，且计入 stats.broken
  const before = service.stats.broken;
  const line = '{"name":"x"}\n';
  await service.writeDay('../escape', line);
  await service.writeDay('2099-01-01', line);
  await service.writeDay(null, line);
  assert.equal(service.stats.broken, before + 3, '每次拒写都计入 broken');
  const files = await readdir(dir).catch(() => []);
  assert.deepEqual(files, [], `脏日期不得创建任何文件，实际：${files.join(',')}`);

  // 合法日期照常写入
  await service.writeDay('2026-10-29', line);
  const ok = (await readdir(dir)).sort();
  assert.deepEqual(ok, ['2026-10-29.jsonl']);
});
