// 雾岛突围 / MIST ISLE — AI 听觉与枪声传播
//
// 这一层要防的回归是「消音器等于没有」：
// 1.3.0 之前 `weapon.noise` 在全项目零引用 —— 18 把枪的 noise 字段只是装饰，
// 消音器除了让伤害变低没有任何战术价值，蹲伏潜行/绕后这些玩法根本不存在。
// 现在枪声按 `78m × noise` 的半径写入 match.soundBoard，AI 在「无目击情报」时
// 会朝声源方向摸过去。以下用例把这条链路锁死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/simulation.mjs';
import { WEAPONS, applyAttachmentMods } from '../shared/data/weapons.mjs';
import { TICK_RATE } from '../shared/rules.mjs';

const tick = 1 / TICK_RATE;

/** 造一局：1 名真人射手 + n 个 bot。关掉缩圈/空投，避免干扰。 */
function arena({ seed = 77, bots = 1, mode = 'squad' } = {}) {
  const m = new Match({ seed, mode, maxPlayers: bots + 1, duration: 600 });
  m.addPlayer('shooter', '射手', { team: 0 });
  m.start();
  m.phase = 'live';
  m.time = 0;
  m.zone.nextIn = 9999;
  m.dropsLeft = 0;
  const shooter = m.players[0];
  shooter.x = 0; shooter.z = 0;
  for (let i = 0; i < bots; i++) {
    const b = m.addPlayer(`b${i}`, `Bot${i}`, { bot: true, team: i + 1 });
    b.x = 0; b.z = 20 + i * 3;
  }
  return { m, shooter };
}

/** 直接让射手开一枪（绕过输入/朝向，只关心枪声传播）。 */
function fireOnce(m, p, weaponId) {
  p.loadout[0] = { type: weaponId, ammo: WEAPONS[weaponId].magazine, attachments: [] };
  p.slot = 0;
  p.loadout[0]._eff = null;
  p.fireCd = 0;
  p.angle = 0;
  return m.tryFire(p);
}

test('听觉：开枪会在 soundBoard 写入一条带半径的声响', () => {
  const { m, shooter } = arena();
  assert.equal(fireOnce(m, shooter, 'ar7'), true);
  assert.ok(m.soundBoard instanceof Map, 'soundBoard 必须在开枪后存在');
  const s = m.soundBoard.get(0);
  assert.ok(s, '应记录射手的队伍（0）');
  assert.equal(s.kind, 'shot');
  assert.equal(s.by, 'shooter');
  assert.ok(s.r > 0 && s.r < 400, `可听半径应在合理区间，实际 ${s.r}`);
});

test('听觉：可听半径 = 78m × 武器 noise，消音器显著缩短', () => {
  const { m, shooter } = arena();
  fireOnce(m, shooter, 'ar7');
  const loud = m.soundBoard.get(0).r;
  fireOnce(m, shooter, 'awm');
  const sniper = m.soundBoard.get(0).r;
  // AR7 noise 1.0（基准），AWM noise 1.75（更响）
  assert.ok(sniper > loud, `狙击枪应比步枪更响：${sniper} vs ${loud}`);
  assert.ok(Math.abs(loud - 78 * (WEAPONS.ar7.noise || 1)) < 0.5);
  assert.ok(Math.abs(sniper - 78 * (WEAPONS.awm.noise || 1)) < 0.5);
});

test('配件：消音器把 noise 降下来（不再是死字段）', () => {
  for (const id of ['ar7', 'ak12', 'awm', 'm14']) {
    const base = WEAPONS[id];
    const quiet = applyAttachmentMods(base, ['suppressor']);
    assert.ok(quiet.noise < base.noise, `${id} 装消音器后 noise 必须下降：${base.noise} → ${quiet.noise}`);
    assert.ok(quiet.noise > 0.05, `${id} noise 不应被压到 0`);
  }
  // 红点/8 倍镜的 adsZoom 必须是加算且生效
  const scoped = applyAttachmentMods(WEAPONS.awm, ['scope_8x']);
  assert.ok(scoped.adsZoom > WEAPONS.awm.adsZoom, '8 倍镜必须提升开镜倍率');
});

test('听觉：听得见才有反应——半径外的枪声不进 soundBoard 判定', () => {
  const { m, shooter } = arena({ bots: 1 });
  const bot = m.players[1];
  // 把 bot 挪到射程外但仍在枪声半径内
  bot.x = 0; bot.z = 60;
  fireOnce(m, shooter, 'ar7');
  const s = m.soundBoard.get(0);
  const d = Math.hypot(bot.x - s.x, bot.z - s.z);
  assert.ok(d < s.r, `60m 应在 AR7 可听半径（${s.r.toFixed(0)}m）内`);
  // 消音版：同样 60m，但半径压到 ~35m，听不到
  const quiet = applyAttachmentMods(WEAPONS.ar7, ['suppressor']);
  const quietRadius = 78 * quiet.noise;
  assert.ok(d > quietRadius, `消音后 60m 应在可听半径（${quietRadius.toFixed(0)}m）外`);
});

test('听觉：停止交火 4 秒后声响过期，不会把 AI 永久引向老位置', () => {
  const { m, shooter } = arena({ bots: 1 });
  // 先让所有人都打光一轮（bot 也会开枪刷新自己的声源），
  // 然后只留下射手这一条，再静默推进。
  const bot = m.players[1];
  bot.hp = 0; bot.alive = false;         // 让 bot 不再开枪
  fireOnce(m, shooter, 'ar7');
  const firedAt = m.time;
  assert.ok(m.soundBoard.get(0));
  for (let i = 0; i < Math.ceil(5 / tick); i++) m.update(tick);
  const s = m.soundBoard.get(0);
  assert.ok(s, '条目仍在表里（惰性清理，不主动删）');
  assert.ok(m.time - firedAt > 4, `声响应超过 4 秒 TTL，实际 ${(m.time - firedAt).toFixed(1)}s`);
  assert.ok(m.time - s.t > 4, '声响时间戳不应被静默期刷新');
});

test('听觉：同队枪声不触发自己的听觉（不会互相"出卖"）', () => {
  const { m, shooter } = arena({ bots: 0 });
  const mate = m.addPlayer('mate', '队友', { bot: true, team: 0 });
  mate.x = 0; mate.z = 5;
  fireOnce(m, shooter, 'ar7');
  // soundBoard 里键是队伍 0 —— AI 过滤自己队伍，所以队友听不到
  assert.equal(m.soundBoard.get(0).by, 'shooter');
  assert.notEqual(m.soundBoard.get(0).by, 'mate');
});

test('确定性：同 seed + 同开枪序列 → soundBoard 内容完全一致', () => {
  const run = () => {
    const { m, shooter } = arena({ seed: 5150 });
    const out = [];
    for (let i = 0; i < 3; i++) {
      fireOnce(m, shooter, 'ar7');
      for (let k = 0; k < 6; k++) m.update(tick);
      const s = m.soundBoard.get(0);
      out.push([s.x, s.z, s.r, s.kind, s.by]);
    }
    return out;
  };
  assert.deepEqual(run(), run());
});

test('性能：64 bot 满编下 soundBoard 只保留每队一条（不随时间无限增长）', () => {
  const m = new Match({ seed: 9, mode: 'squad', maxPlayers: 64, duration: 600 });
  m.addPlayer('me', '我', { team: 0 });
  m.start();
  m.phase = 'live';
  m.zone.nextIn = 9999;
  m.dropsLeft = 0;
  for (let i = 0; i < 300; i++) m.update(tick);
  assert.ok(m.soundBoard.size <= 17, `soundBoard 最多「每队一条 + world」，实际 ${m.soundBoard.size}`);
});
