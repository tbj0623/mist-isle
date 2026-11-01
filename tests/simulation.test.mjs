// 雾岛突围 / MIST ISLE — 模拟核心测试（node --test tests/simulation.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Match, sanitizeInput, emptyInput, effectiveWeapon, MAX_PLAYERS,
  WEAPONS,
} from '../shared/simulation.mjs';
import { TICK_RATE, MAX_LOOT, MOVE, REVIVE_TIME, BLEEDOUT_TIME, REVIVE_HP, COMBAT } from '../shared/rules.mjs';
import { damageAtDistance } from '../shared/data/weapons.mjs';
import { matchSummaryFromState } from '../shared/progression.mjs';
import { budget } from './perf-budget.mjs';

const tick = 1 / TICK_RATE;
const MOVE_DODGE_TIME = MOVE.dodgeTime;

/** 造一个足够小、可控的对局：人类 1 名 + 指定数量的 bot。 */
function duel({ seed = 3, mode = 'squad', bots = 1, maxPlayers = 4, duration = 420, difficulty = 'veteran' } = {}) {
  const m = new Match({ seed, mode, maxPlayers, duration, difficulty });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  m.players.length = 1;
  m.players[0].x = 0; m.players[0].z = 0; m.players[0].angle = 0;
  for (let i = 0; i < bots; i++) {
    const b = m.addPlayer(`b${i}`, `Bot${i}`, { bot: true, team: i + 1 });
    b.x = 0; b.z = 14 + i * 3;
  }
  m.zone.nextIn = 9999;
  m.dropsLeft = 0;
  return m;
}

function step(m, n = 1, dt = tick) {
  for (let i = 0; i < n; i++) m.update(dt);
  return m;
}

/** 找一段至少 len 米无遮挡的直线跑道（给载具/射击测试用）。 */
function openRun(world, len = 14) {
  for (let ring = 0; ring < 40; ring++) {
    for (let ai = 0; ai < 16; ai++) {
      const a = (ai / 16) * Math.PI * 2;
      const r = 10 + ring * 3;
      const x = Math.cos(a) * r; const z = Math.sin(a) * r;
      if (world.blocked(x, z, 2.2)) continue;
      if (world.blocked(x + Math.cos(a) * len, z + Math.sin(a) * len, 2.6)) continue;
      let clear = true;
      for (let k = 1; k <= 8; k++) {
        if (world.blocked(x + Math.cos(a) * (k * len / 8), z + Math.sin(a) * (k * len / 8), 1.9)) { clear = false; break; }
      }
      if (clear) return { x, z, angle: Math.atan2(Math.cos(a), Math.sin(a)) };
    }
  }
  return null;
}

/** 找一块空旷的落点 + 朝向（不穿墙），返回 {x,z,dx,dz,angle}。 */
function openLane(world, len = 24) {
  const spots = (world.lootSpots || []).concat(world.spawnAnchors || []);
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    if (world.blocked(s.x, s.z, 1.2)) continue;
    for (let ai = 0; ai < 12; ai++) {
      const a = (ai / 12) * Math.PI * 2;
      const dx = Math.cos(a); const dz = Math.sin(a);
      if (world.wallDistance(s.x, s.z, dx, dz, len) < len) continue;
      return { x: s.x, z: s.z, dx, dz, angle: Math.atan2(dx, dz) };
    }
  }
  return null;
}

test('sanitizeInput 归一化非法输入并保留合法字段', () => {
  const a = sanitizeInput(null);
  assert.deepEqual(a, emptyInput());
  const b = sanitizeInput({ mx: 3, mz: 4, aim: 9, fire: 'yes', throwable: 'nope', slot: 5, seq: -3, pingKind: 'x' });
  assert.ok(Math.abs(Math.hypot(b.mx, b.mz) - 1) < 1e-6);
  assert.equal(b.fire, false);
  assert.equal(b.throwable, null);
  assert.equal(b.slot, -1);
  assert.equal(b.seq, 0);
  assert.equal(b.pingKind, 'move');
  const c = sanitizeInput({ fire: true, throwable: 'frag', slot: 1, useItem: 'medkit', seq: 12 });
  assert.equal(c.fire, true);
  assert.equal(c.throwable, 'frag');
  assert.equal(c.slot, 1);
  assert.equal(c.useItem, 'medkit');
  assert.equal(c.seq, 12);
});

test('emptyInput 每次返回新对象', () => {
  const a = emptyInput(); const b = emptyInput();
  assert.notEqual(a, b);
  a.mx = 1;
  assert.equal(b.mx, 0);
});

test('命中：正面射击造成伤害并产生 shot 事件', () => {
  const m = duel({ bots: 1 });
  const target = m.players[1];
  target.bot = false;
  target.x = 0; target.z = 10;
  m.input('a', { aim: 0, fire: true });
  const hp0 = target.hp;
  step(m, 4);
  assert.ok(target.hp < hp0, `expected damage, hp ${target.hp}`);
  const shots = m.events.filter((e) => e.type === 'shot');
  assert.ok(shots.length > 0);
  assert.equal(shots[0].player, 'a');
  assert.ok(typeof shots[0].tx === 'number' && typeof shots[0].tz === 'number');
  assert.equal(shots[0].weapon, 'p9');
});

test('墙体遮挡：墙后目标不会被命中', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  const enemy = m.addPlayer('e1', 'Enemy', { bot: true, team: 3 });
  enemy.bot = false;
  const wall = m.world.obstacles.find((o) => o.kind === 'building' || o.kind === 'wall' || o.kind === 'hall');
  assert.ok(wall, 'world should expose obstacles');
  p.x = wall.x; p.z = wall.z - (wall.d / 2 + 2);
  enemy.x = wall.x; enemy.z = wall.z + (wall.d / 2 + 2);
  p.angle = 0;
  const hp0 = enemy.hp;
  for (let i = 0; i < 20; i++) { p.fireCd = 0; p.loadout[0].ammo = 15; m.tryFire(p); }
  assert.equal(enemy.hp, hp0, 'bullets must be blocked by wall');
  assert.ok(!m.world.clearLine(p, enemy));
});

test('护甲吸收：高护甲挨的伤害更少，耐久会下降', () => {
  const m = duel({ bots: 0 });
  const a = m.addPlayer('t1', 'T1', { bot: true, team: 5 });
  const b = m.addPlayer('t2', 'T2', { bot: true, team: 6 });
  a.armorTier = 1; a.armor = 60;
  b.armorTier = 3; b.armor = 150;
  m.damage(a, 50, null, { noDown: true });
  m.damage(b, 50, null, { noDown: true });
  assert.ok(a.hp < b.hp, `light armor ${a.hp} should take more than heavy ${b.hp}`);
  assert.ok(a.armor < 60 && b.armor < 150);
});

test('护甲打空后自动掉落档位并继续扣血', () => {
  const m = duel({ bots: 0 });
  const p = m.addPlayer('t3', 'T3', { bot: true, team: 7 });
  p.armorTier = 1; p.armor = 5;
  m.damage(p, 60, null, { noDown: true });
  assert.equal(p.armorTier, 0);
  assert.equal(p.armor, 0);
  assert.ok(p.hp < 100);
});

test('霰弹多弹丸：近距离一枪多颗弹丸命中', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout[0] = { type: 's12', ammo: 5, attachments: [], _eff: null };
  const t = m.addPlayer('s1', 'S1', { bot: true, team: 8 });
  t.bot = false;
  t.x = 0; t.z = 5;
  p.x = 0; p.z = 0; p.angle = 0;
  m.tryFire(p);
  const ev = m.events.filter((e) => e.type === 'shot').pop();
  assert.equal(ev.weapon, 's12');
  assert.ok(ev.hits >= 1);
  assert.ok(t.hp < 100);
});

// ── 要害（爆头）判定 ─────────────────────────────────────────────────────────
// 俯视角用「命中点到中轴线的横向偏移 ≤ 命中半径 × headshotCoreRatio」代理要害。
// 测试几何：射手在 lane 起点、朝 lane 方向，弹道原点在身位前 0.45m；
// 站立命中半径 0.7 → 核心区 0.266m。把散布最大横向偏移（spread × 距离）压在
// 核心阈值之内/之外，使「必吃倍率」「必不吃倍率」与随机数流无关。

/** 在开阔地上摆好「射手 → 正前方 D 米处的目标」，返回 { shooter, target, dist }。 */
function aimRange(m, { D = 6, lateral = 0, weapon = 'ar7' } = {}) {
  const lane = openLane(m.world, 24);
  assert.ok(lane, '需要一段开阔地');
  const p = m.players[0];
  const t = m.players[1];
  t.bot = false;
  p.loadout[0] = { type: weapon, ammo: 30, attachments: [], _eff: null };
  p.x = lane.x; p.z = lane.z; p.angle = lane.angle;
  m.cars.forEach((c) => { c.x = 1e6; c.z = 1e6; }); // 载具不能挡在弹道上
  const sa = Math.sin(lane.angle); const ca = Math.cos(lane.angle);
  t.x = p.x + sa * D + ca * lateral;
  t.z = p.z + ca * D - sa * lateral;
  return { shooter: p, target: t, dist: D - 0.45, weapon: effectiveWeapon(p) };
}

test('要害命中：核心区伤害 × 武器 headshotMul，事件带要害标记', () => {
  const m = duel({ bots: 1 });
  const { shooter, target, dist, weapon } = aimRange(m, { D: 6 });
  const hp0 = target.hp;
  m.tryFire(shooter);
  // AR7 散布 0.026 rad × 5.55m ≈ 0.144m < 核心区 0.266m → 必判要害
  const expected = damageAtDistance(weapon, dist) * weapon.headshotMul;
  assert.ok(Math.abs((hp0 - target.hp) - expected) < 1e-9,
    `要害伤害 ${hp0 - target.hp} 应等于基础 ${damageAtDistance(weapon, dist)} × ${weapon.headshotMul}`);
  const ev = m.events.filter((e) => e.type === 'shot').pop();
  assert.equal(ev.hit, true);
  assert.equal(ev.headshots, 1);
  const hs = m.events.filter((e) => e.type === 'headshot');
  assert.equal(hs.length, 1);
  assert.equal(hs[0].player, shooter.id);
  assert.equal(hs[0].target, target.id);
  assert.ok(hs[0].damage > 0);
});

test('边缘命中：命中身体但偏离核心区，不吃要害倍率', () => {
  const m = duel({ bots: 1 });
  const { shooter, target, dist, weapon } = aimRange(m, { D: 6, lateral: 0.48 });
  const hp0 = target.hp;
  m.tryFire(shooter);
  // 横向偏移 0.48m：加/减散布极值 0.144m 后仍落在 (0.266, 0.7) → 必命中且必非要害
  const expected = damageAtDistance(weapon, dist);
  assert.ok(Math.abs((hp0 - target.hp) - expected) < 1e-9,
    `边缘伤害 ${hp0 - target.hp} 应等于基础 ${expected}（无倍率）`);
  const ev = m.events.filter((e) => e.type === 'shot').pop();
  assert.equal(ev.hit, true);
  assert.equal(ev.headshots, 0);
  assert.equal(m.events.some((e) => e.type === 'headshot'), false);
});

test('霰弹：多弹丸命中但**不参与**要害判定（避免贴脸单发秒杀）', () => {
  // 设计变更（1.2.1）：霰弹的每颗弹丸不再判要害。
  //
  // 原因：headshotCoreRatio = 0.38 让命中圆中心 14% 面积判要害，而霰弹在 ≤8m 时
  // 散布锥小于这个核心区 —— 9 颗弹丸几乎全部判要害（实测 3m 时 9.0/9），
  // 单发伤害 99 × 1.5 ≈ 148.5，对无甲目标 3m/5m **100% 单发秒杀**、8m 93%，
  // 与设计注释「贴脸 2 发必杀」差了一倍。
  //
  // 现在霰弹只吃基础伤害（贴脸 99，刚好不秒 100 血），仍然保留多弹丸命中与距离衰减。
  const m = duel({ bots: 1 });
  const { shooter, target } = aimRange(m, { D: 12, weapon: 's12' });
  const hp0 = target.hp;
  m.tryFire(shooter);
  const ev = m.events.filter((e) => e.type === 'shot').pop();
  assert.equal(ev.weapon, 's12');
  assert.ok(ev.hits >= 2, `多颗弹丸命中（hits=${ev.hits}）`);
  assert.equal(ev.headshots, 0, `霰弹弹丸不应判要害（headshots=${ev.headshots}）`);
  assert.equal(m.events.filter((e) => e.type === 'headshot').length, 0, '不应产生 headshot 事件');
  assert.ok(target.hp < hp0, '仍应造成伤害');
});

test('倒地目标：要害倍率与 downedDamageMul 乘算叠加', () => {
  const m = new Match({ seed: 31, mode: 'squad', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.addPlayer('b', 'Bravo', { team: 0 });
  m.addPlayer('e1', 'Enemy1', { team: 1 });
  m.addPlayer('e2', 'Enemy2', { team: 1 });
  m.start();
  m.players.length = 4; // a, b, e1, e2；队友活着保证 e1 可倒地
  const a = m.players[0];
  const e1 = m.players[2];
  const e2 = m.players[3];
  const lane = openLane(m.world, 24);
  assert.ok(lane, '需要一段开阔地');
  a.loadout[0] = { type: 'p9', ammo: 5, attachments: [], _eff: null };
  a.x = lane.x; a.z = lane.z; a.angle = lane.angle;
  m.cars.forEach((c) => { c.x = 1e6; c.z = 1e6; });
  const D = 6;
  e1.x = a.x + Math.sin(lane.angle) * D;
  e1.z = a.z + Math.cos(lane.angle) * D;
  e2.x = 1e5; e2.z = 1e5;
  m.damage(e1, 130, a.id, {});
  assert.equal(e1.downed, true);
  // 倒地命中半径 0.5 → 核心区 0.19m；P9 散布 0.030 × 5.55 ≈ 0.167m → 必判要害
  const weapon = effectiveWeapon(a);
  const dist = D - 0.45;
  const expected = damageAtDistance(weapon, dist) * weapon.headshotMul * COMBAT.downedDamageMul;
  const downedHp0 = e1.downedHp;
  m.tryFire(a);
  assert.ok(Math.abs((downedHp0 - e1.downedHp) - expected) < 1e-9,
    `倒地要害 ${downedHp0 - e1.downedHp} 应等于基础 × ${weapon.headshotMul} × ${COMBAT.downedDamageMul}`);
  assert.equal(m.events.filter((e) => e.type === 'shot').pop().headshots, 1);
  assert.ok(m.events.some((e) => e.type === 'headshot' && e.target === e1.id));
});

test('后坐与散布：连续射击后 spreadBloom 上升', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout[0] = { type: 'ak12', ammo: 30, attachments: [], _eff: null };
  assert.equal(p.spreadBloom, 0);
  for (let i = 0; i < 6; i++) { p.fireCd = 0; m.tryFire(p); }
  assert.ok(p.spreadBloom > 0);
  assert.ok(p.recoil > 0);
});

test('换弹消耗弹药池并回满弹匣', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout[0] = { type: 'ak12', ammo: 3, attachments: [], _eff: null };
  p.mags.medium = 90;
  p.reloadTime = 0;
  assert.equal(m.reload(p), true);
  const weapon = effectiveWeapon(p);
  step(m, Math.ceil(weapon.reload / tick) + 2);
  assert.equal(p.loadout[0].ammo, weapon.magazine);
  assert.equal(p.mags.medium, 90 - (weapon.magazine - 3));
});

test('空仓开火自动换弹；弹药池为空时无法换弹', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout[0] = { type: 'ak12', ammo: 1, attachments: [], _eff: null };
  p.mags.medium = 30;
  p.x = 0; p.z = 0; p.angle = 0;
  m.tryFire(p);
  assert.equal(p.loadout[0].ammo, 0);
  assert.ok(p.reloadTime > 0, 'empty mag should start reload');
  p.loadout[0].ammo = 0;
  p.mags.medium = 0;
  p.reloadTime = 0;
  assert.equal(m.reload(p), false);
});

test('切枪保留各自弹匣', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout = [
    { type: 'ak12', ammo: 11, attachments: [], _eff: null },
    { type: 'p9', ammo: 7, attachments: [], _eff: null },
  ];
  p.slot = 0;
  m._swapSlot(p, 1);
  assert.equal(p.slot, 1);
  assert.equal(p.loadout[0].ammo, 11);
  assert.equal(p.loadout[1].ammo, 7);
  m._swapSlot(p, 0);
  assert.equal(effectiveWeapon(p).id, 'ak12');
  assert.equal(p.loadout[0].ammo, 11);
});

test('切换武器槽会惩罚开火冷却', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout = [
    { type: 'ak12', ammo: 11, attachments: [], _eff: null },
    { type: 'p9', ammo: 7, attachments: [], _eff: null },
  ];
  m._swapSlot(p, 1);
  assert.ok(p.fireCd > 0.2);
  assert.equal(m._swapSlot(p, 0), true);
});

test('消耗品需要静止：移动打断治疗', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.hp = 40; p.meds = 2;
  m.useItem(p, 'medkit');
  assert.ok(p.healTime > 0);
  m.input('a', { mx: 1, mz: 0 });
  step(m, 2);
  assert.equal(p.healTime, 0);
  assert.equal(p.healKind, null);
  assert.equal(p.meds, 2, 'interrupted medkit must not be consumed');
});

test('消耗品完成：绷带回血、护盾电池加盾、能量给加速 buff', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  m.input('a', {});
  p.hp = 50; p.bandages = 2;
  m.useItem(p, 'bandage');
  step(m, Math.ceil(2.0 / tick) + 3);
  assert.ok(p.hp > 50 && p.hp <= 72);
  assert.equal(p.bandages, 1);
  p.shield = 0; p.shields = 1;
  m.useItem(p, 'shield');
  step(m, Math.ceil(3.0 / tick) + 3);
  assert.ok(p.shield >= 60);
  p.energy = 1; p.haste = 0;
  m.useItem(p, 'energy');
  step(m, Math.ceil(1.2 / tick) + 3);
  assert.ok(p.haste > 10);
});

test('四种投掷物：手雷爆炸、烟雾区、闪光致盲、燃烧区', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  const victim = m.addPlayer('v1', 'Victim', { bot: true, team: 2 });
  victim.bot = false;
  const watcher = m.addPlayer('w1', 'Watcher', { bot: true, team: 5 });
  watcher.bot = false;
  watcher.x = 40; watcher.z = 40;
  p.x = 0; p.z = 0; p.angle = 0;
  p.grenades = 2; p.smokes = 1; p.flashes = 1; p.molotovs = 1;
  victim.hp = 100;
  victim.x = p.x; victim.z = p.z + 2;
  m.throwGrenade(p, 'frag');
  assert.equal(m.grenades.length, 1);
  const g = m.grenades[0];
  g.fly = 0; g.x = 0; g.z = 6; g.ttl = 0.05;
  step(m, 3);
  assert.equal(m.grenades.length, 0);
  assert.ok(m.events.some((e) => e.type === 'explosion'));
  assert.ok(victim.hp < 100, 'frag should hurt nearby victim');

  victim.hp = 100;
  victim.x = p.x + 12; victim.z = p.z + 12;
  p.throwCd = 0;
  m.throwGrenade(p, 'smoke');
  const sg = m.grenades[m.grenades.length - 1];
  sg.fly = 0; sg.x = 0; sg.z = 2; sg.ttl = 0.05;
  step(m, 3);
  assert.ok(m.smokes.length >= 1);
  assert.ok(m.smokes[0].r >= 6);

  victim.x = 0; victim.z = 2;
  p.throwCd = 0;
  m.throwGrenade(p, 'flash');
  const fg = m.grenades[m.grenades.length - 1];
  fg.fly = 0; fg.x = 0; fg.z = 2; fg.ttl = 0.05;
  step(m, 3);
  assert.ok(m.players.some((q) => q.blind > 0), 'flash should blind nearby players');

  p.throwCd = 0;
  m.throwGrenade(p, 'molotov');
  const mg = m.grenades[m.grenades.length - 1];
  mg.fly = 0; mg.x = 4; mg.z = 4; mg.ttl = 0.05;
  step(m, 3);
  assert.ok(m.fires.length >= 1);
  assert.ok(m.fires[0].ttl > 5);
});

test('投掷物数量不足时无法投掷', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.grenades = 0;
  assert.equal(m.throwGrenade(p, 'frag'), false);
  p.grenades = 1;
  assert.equal(m.throwGrenade(p, 'frag'), true);
  assert.equal(m.throwGrenade(p, 'frag'), false, 'cooldown or empty');
});

test('载具：3.8m 内上下车，司机驾驶带动乘客', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  const car = m.cars[0];
  p.x = car.x + 1.2; p.z = car.z;
  m._interact(p);
  assert.equal(p.car, car.id);
  assert.equal(p.seat, 0);
  assert.equal(car.driver, p.id);
  assert.equal(p.state, 'vehicle');
  m.input('a', { mz: 1 });
  const x0 = car.x; const z0 = car.z;
  step(m, 20);
  assert.ok(Math.hypot(car.x - x0, car.z - z0) > 0.5, 'car should move');
  assert.ok(Math.abs(p.x - car.x) < 1e-6 && Math.abs(p.z - car.z) < 1e-6);
  m.input('a', { interact: true });
  step(m, 2);
  assert.equal(p.car, null);
  assert.equal(p.seat, -1);
});

test('载具：撞击伤害与耐久爆炸释放乘员', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  const car = m.cars[0];
  const run = openRun(m.world, 16);
  assert.ok(run, '需要一段无遮挡跑道');
  car.x = run.x; car.z = run.z; car.angle = run.angle; car.speed = 0;
  const foot = m.addPlayer('f1', 'Foot', { bot: true, team: 4 });
  foot.bot = false;
  p.x = car.x + 1; p.z = car.z;
  m._interact(p);
  assert.equal(p.car, car.id);
  foot.x = car.x + Math.sin(car.angle) * 7;
  foot.z = car.z + Math.cos(car.angle) * 7;
  m.input('a', { mz: 1 });
  step(m, 45);
  assert.ok(foot.hp < 100, `collision should damage pedestrian (hp ${foot.hp})`);
  m._damageCar(car, 500, p);
  assert.equal(car.dead, true);
  assert.equal(p.car, null, 'occupants ejected on explosion');
  assert.ok(m.events.some((e) => e.type === 'vehicle' && e.action === 'explode'));
});

test('缩圈：五阶段时间线推进，圈外每秒掉血', () => {
  const m = new Match({ seed: 11, mode: 'squad', maxPlayers: 4, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  m.players.length = 1;
  m.dropsLeft = 0;
  const p = m.players[0];
  p.x = 0; p.z = 0;
  const startR = m.zone.r;
  m.zone.nextIn = 0.05;
  step(m, 3);
  assert.equal(m.zone.phase, 0);
  assert.equal(m.zone.closing, true);
  const zoneEvents = m.events.filter((e) => e.type === 'zone');
  assert.ok(zoneEvents.length >= 1);
  assert.equal(zoneEvents[0].damage, 5);
  // 推到收缩完成，圈半径应显著变小
  step(m, Math.ceil(26 / tick) + 4);
  assert.ok(m.zone.r < startR, `zone radius ${m.zone.r} should shrink from ${startR}`);
  assert.equal(m.zone.closing, false);
  // 站在圈外：每秒掉血
  p.x = m.zone.x + m.zone.r + 25; p.z = m.zone.z;
  p.hp = 100; p.armor = 0; p.armorTier = 0;
  m.zone.damage = 9;
  step(m, 32);
  assert.ok(p.hp < 100, 'outside zone must take damage');
  assert.ok(m.zone.nextIn > 0);
});

test('缩圈阶段覆盖 rules.ZONE_PHASES 全部五档', () => {
  const m = new Match({ seed: 12, mode: 'squad', maxPlayers: 4, duration: 900 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  m.players.length = 1;
  m.zone.nextIn = 0;
  const seen = new Set();
  for (let i = 0; i < 9000 && seen.size < 5; i++) {
    m.update(tick);
    if (m.zone.phase >= 0) seen.add(m.zone.phase);
    m.players[0].hp = 100;
    m.players[0].alive = true;
    m.players[0].x = m.zone.x; m.players[0].z = m.zone.z;
  }
  assert.equal(seen.size, 5, `phases seen: ${[...seen].join(',')}`);
});

test('空投：12 秒降落，开启后生成稀有物资', () => {
  const m = new Match({ seed: 21, mode: 'squad', maxPlayers: 4, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  m.players.length = 1;
  m.players[0].x = 0; m.players[0].z = 0;
  m.phase = 'live';
  m.time = 0; m.nextDrop = 0; m.dropsLeft = 2;
  step(m, 2);
  assert.equal(m.drops.length, 1);
  const d = m.drops[0];
  assert.ok(d.landsIn > 10);
  assert.ok(d.y > 50);
  step(m, Math.ceil(12 / tick) + 2);
  assert.equal(d.landsIn, 0);
  assert.ok(d.y < 1);
  const before = m.loot.length;
  const p = m.players[0];
  p.x = d.x; p.z = d.z;
  m._interact(p);
  assert.equal(d.opened, true);
  assert.ok(m.loot.length > before, 'airdrop should add loot');
});

test('配件影响有效数值：扩容弹匣 + 消音器', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout[0] = { type: 'ak12', ammo: 30, attachments: [], _eff: null };
  const base = effectiveWeapon(p);
  p.loadout[0].attachments = ['ext_mag', 'suppressor'];
  p.loadout[0]._eff = null;
  const modded = effectiveWeapon(p);
  assert.ok(modded.magazine > base.magazine, `${modded.magazine} > ${base.magazine}`);
  assert.ok(modded.noise < base.noise);
  assert.ok(modded.damage < base.damage, 'suppressor costs damage');
  assert.ok(!Object.isFrozen(modded));
});

test('配件受槽位限制：同类槽只生效第一个', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.loadout[0] = { type: 'ak12', ammo: 30, attachments: ['red_dot', 'holo'], _eff: null };
  const w = effectiveWeapon(p);
  assert.deepEqual(w.attachments, ['red_dot']);
});

test('蹲与冲刺：速度差与耐力消耗/恢复', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  const lane = openLane(m.world, 26);
  assert.ok(lane, '需要一段开阔地');
  p.x = lane.x; p.z = lane.z;
  m.input('a', { mx: lane.dx, mz: lane.dz });
  step(m, 20);
  const walkDist = Math.hypot(p.x - lane.x, p.z - lane.z);
  const stamina0 = p.stamina;
  p.x = lane.x; p.z = lane.z;
  m.input('a', { mx: lane.dx, mz: lane.dz, sprint: true });
  step(m, 20);
  const sprintDist = Math.hypot(p.x - lane.x, p.z - lane.z);
  assert.ok(sprintDist > walkDist, `sprint ${sprintDist} > walk ${walkDist}`);
  assert.ok(p.stamina < stamina0, 'sprint drains stamina');
  m.input('a', {});
  step(m, 30);
  assert.ok(p.stamina > 0, 'stamina regenerates when idle');
  p.x = lane.x; p.z = lane.z; p.stamina = 100;
  m.input('a', { mx: lane.dx, mz: lane.dz, crouch: true });
  step(m, 20);
  const crouchDist = Math.hypot(p.x - lane.x, p.z - lane.z);
  assert.ok(crouchDist < walkDist, `crouch ${crouchDist} < walk ${walkDist}`);
  assert.equal(p.state, 'crouch');
});

test('耐力低于 12 无法起跑', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  p.stamina = 5;
  m.input('a', { mx: 1, mz: 0, sprint: true });
  step(m, 2);
  assert.notEqual(p.state, 'sprint');
});

test('翻滚：位移 4.3m 级别、冷却 1.9s、翻滚中不可开火', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  const lane = openLane(m.world, 12);
  assert.ok(lane);
  p.x = lane.x; p.z = lane.z; p.angle = lane.angle;
  p.dodgeCd = 0;
  m.input('a', { mx: lane.dx, mz: lane.dz, dodge: true });
  m.update(tick);
  assert.equal(p.state, 'dodge');
  assert.ok(p.dodgeCd > 1.5);
  assert.equal(p.input.fire, false, '翻滚输入里不该带开火');
  assert.equal(m.tryFire(p), false, 'dodge 期间禁止开火');
  const x0 = p.x; const z0 = p.z;
  step(m, Math.ceil(MOVE_DODGE_TIME / tick));
  const moved = Math.hypot(p.x - x0, p.z - z0);
  assert.ok(moved > 3.2 && moved < 5.2, `dodge distance ${moved}`);
  assert.ok(p.dodgeCd > 0);
  m.input('a', { dodge: true });
  m.update(tick);
  assert.equal(p.dodgeTime, 0, 'dodge on cooldown must not restart');
});

test('水域减速：水中移动速度约为陆地 0.55 倍', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  const water = m.world.waters && m.world.waters[0];
  if (!water) return; // 该地图没有水域时跳过
  const wx = water.x; const wz = water.z;
  if (m.world.blocked(wx, wz, 0.6)) return;
  p.x = wx; p.z = wz;
  m.input('a', { mx: 1, mz: 0 });
  step(m, 20);
  const wet = Math.abs(p.x - wx);
  p.x = 0; p.z = 0;
  if (m.world.blocked(0, 0, 1)) return;
  m.input('a', { mx: 1, mz: 0 });
  step(m, 20);
  const dry = Math.abs(p.x);
  assert.ok(wet < dry, `water ${wet} should be slower than land ${dry}`);
});

test('团队团灭：全队倒地后淘汰并输出排名', () => {
  const m = new Match({ seed: 31, mode: 'squad', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.addPlayer('b', 'Bravo', { team: 0 });
  m.start();
  m.players.length = 2;
  const [a, b] = m.players;
  a.x = 0; a.z = 0; b.x = 1; b.z = 0;
  const enemy = m.addPlayer('e1', 'Enemy', { bot: true, team: 1 });
  enemy.bot = false;
  enemy.x = 0; enemy.z = 30;
  m.damage(a, 120, 'e1', { noDown: false });
  assert.equal(a.downed, true, 'with a living teammate you get downed');
  m.damage(a, 200, 'e1', {});
  assert.equal(a.alive, false);
  m.damage(b, 120, 'e1', { noDown: false });
  m.damage(b, 200, 'e1', {});
  assert.equal(b.alive, false);
  assert.equal(m.phase, 'ended');
  assert.equal(m.winnerTeam, 1);
  assert.ok(m.result.ranks.length >= 2);
  assert.equal(m.result.ranks[0].team, 1);
  assert.equal(m.result.ranks[1].team, 0);
  assert.ok(m.players.every((q) => q.rank >= 1));
});

test('单人模式：没有倒地，直接淘汰', () => {
  const m = new Match({ seed: 32, mode: 'solo', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.start();
  m.players.length = 1;
  const a = m.players[0];
  const e = m.addPlayer('e1', 'Enemy', { bot: true, team: 1 });
  e.bot = false;
  m.damage(a, 60, 'e1', {});
  assert.equal(a.downed, false);
  assert.equal(a.hp, 40);
  m.damage(a, 60, 'e1', {});
  assert.equal(a.alive, false);
  assert.equal(m.phase, 'ended');
});

test('倒地救援：4.5 秒完成、移动打断、失血 30 秒淘汰', () => {
  const m = new Match({ seed: 33, mode: 'squad', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.addPlayer('b', 'Bravo', { team: 0 });
  m.start();
  m.players.length = 2;
  const [a, b] = m.players;
  a.x = 0; a.z = 0; b.x = 0.5; b.z = 0.5;
  const e = m.addPlayer('e1', 'Enemy', { bot: true, team: 1 });
  e.bot = false; e.x = 0; e.z = 40;
  m.damage(a, 130, 'e1', {});
  assert.equal(a.downed, true);
  assert.ok(a.bleedout > 25);
  m.input('b', { revive: true });
  step(m, Math.ceil(REVIVE_TIME / tick) - 2);
  assert.ok(a.reviveProgress > 3, `progress ${a.reviveProgress}`);
  assert.equal(a.downed, true);
  step(m, 12);
  assert.equal(a.downed, false, 'teammate revive should finish');
  assert.equal(a.alive, true);
  assert.equal(a.hp, REVIVE_HP);
  // 失血：无人救援时 30 秒淘汰
  m.damage(a, 130, 'e1', {});
  assert.equal(a.downed, true);
  b.alive = false; b.downed = false; b.x = 200; b.z = 200;
  step(m, Math.ceil(BLEEDOUT_TIME / tick) + 4);
  assert.equal(a.alive, false);
});

test('64 人容量：addPlayer 到 MAX_PLAYERS，snapshot 计数正确', () => {
  const m = new Match({ seed: 41, mode: 'squad', maxPlayers: MAX_PLAYERS });
  for (let i = 0; i < MAX_PLAYERS; i++) m.addPlayer(`p${i}`, `P${i}`, {});
  assert.equal(m.players.length, MAX_PLAYERS);
  assert.equal(m.start(), true);
  const snap = m.snapshot('p0', 0);
  assert.equal(snap.counts.total, MAX_PLAYERS);
  assert.ok(snap.counts.bots >= 0);
  assert.ok(snap.counts.teams >= 1);
  assert.ok(snap.counts.alive > 0);
});

test('64 人满员对局：人类 + 补满 bot，能正常打出淘汰与排名', () => {
  const m = new Match({ seed: 43, mode: 'squad', maxPlayers: MAX_PLAYERS, duration: 240 });
  m.addPlayer('h', 'Hero', { team: 0 });
  assert.equal(m.start(), true);
  assert.equal(m.players.length, MAX_PLAYERS);
  assert.ok(m.players.filter((p) => p.bot).length >= MAX_PLAYERS - 1);
  let ticks = 0;
  while (m.phase !== 'ended' && ticks < 9000) { m.update(tick); ticks++; }
  assert.equal(m.phase, 'ended');
  assert.ok(m.result.ranks.length >= 1);
  assert.ok(m.players.every((p) => p.rank >= 1 && p.rank <= m.result.ranks.length));
  assert.ok(m.players.reduce((a, p) => a + p.kills, 0) > 0, 'bots should fight and kill');
});

test('快照：字段完整、深拷贝、事件按 sinceEventId 过滤且有限流', () => {
  const m = new Match({ seed: 42, mode: 'squad', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.addPlayer('b', 'Bravo', { team: 0 });
  m.start();
  m.players.length = 2;
  m.players[0].x = 0; m.players[0].z = 0;
  m.players[1].x = 2; m.players[1].z = 0;
  for (let i = 0; i < 40; i++) m._emit('noise', { i });
  const snap = m.snapshot('a', 0);
  const keys = ['v', 'mode', 'mapId', 'mapName', 'weather', 'timeOfDay', 'phase', 'time',
    'matchTime', 'duration', 'zone', 'counts', 'selfId', 'me', 'players', 'loot', 'cars',
    'grenades', 'smokes', 'fires', 'pings', 'drops', 'markers', 'horde', 'events', 'loading',
    'result', 'teammates'];
  for (const k of keys) assert.ok(k in snap, `missing snapshot key ${k}`);
  assert.equal(snap.selfId, 'a');
  assert.ok(snap.me && snap.me.id === 'a');
  const meKeys = ['id', 'name', 'bot', 'team', 'teamName', 'hp', 'armor', 'armorTier', 'shield',
    'alive', 'downed', 'downedHp', 'bleedout', 'reviveProgress', 'reviveTarget', 'kills',
    'assists', 'damage', 'rank', 'state', 'x', 'z', 'angle', 'stamina', 'weapon', 'ammo',
    'reserve', 'ammoType', 'slot', 'loadout', 'mags', 'meds', 'bandages', 'energy', 'shields',
    'grenades', 'smokes', 'flashes', 'molotovs', 'car', 'seat', 'interactLabel', 'blind',
    'reloadTime', 'healTime', 'healKind', 'fireCooldown', 'accuracy'];
  for (const k of meKeys) assert.ok(k in snap.me, `missing me.${k}`);
  assert.ok(snap.events.length <= 140);
  assert.ok(snap.events.every((e) => e.id > 0));
  const last = snap.events[snap.events.length - 1].id;
  const older = m.snapshot('a', last - 1);
  assert.ok(older.events.length <= 2);
  assert.ok(older.events.every((e) => e.id > last - 1));
  // 深拷贝：改动快照不影响内部状态
  const lootId = snap.loot.length ? snap.loot[0].id : null;
  if (lootId) {
    const internal = m.loot.find((l) => l.id === lootId);
    snap.loot[0].x = -9999;
    assert.notEqual(internal.x, -9999);
  }
  snap.me.mags.light = 12345;
  assert.notEqual(m.players[0].mags.light, 12345);
  snap.players[0].x = -123;
  assert.notEqual(m.players[0].x, -123);
  assert.ok(Array.isArray(snap.teammates));
  assert.equal(snap.teammates.length, 2);
  assert.ok(snap.teammates.some((t) => t.isSelf));
});

test('训练模式：单人 + 15 个低难度 bot', () => {
  const m = new Match({ seed: 51, mode: 'training', maxPlayers: 16 });
  m.addPlayer('a', 'Alpha', {});
  assert.equal(m.start(), true);
  assert.ok(m.players.length >= 16, `training should fill 16, got ${m.players.length}`);
  const bots = m.players.filter((p) => p.bot);
  assert.ok(bots.length >= 15);
  assert.ok(bots.every((b) => b.difficulty === 'recruit'));
  const snap = m.snapshot('a', 0);
  assert.equal(snap.mode, 'training');
});

test('end() 生成完整排名表与 result 快照', () => {
  const m = new Match({ seed: 52, mode: 'squad', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.addPlayer('b', 'Bravo', { team: 0 });
  m.addPlayer('c', 'Charlie', { team: 1 });
  m.start();
  assert.equal(m.end('timeout', 0), true);
  assert.equal(m.phase, 'ended');
  assert.equal(m.end('timeout', 0), false, 'end is idempotent');
  assert.ok(m.result);
  assert.equal(m.result.winnerTeam, 0);
  assert.equal(m.result.reason, 'timeout');
  assert.ok(Array.isArray(m.result.ranks));
  assert.ok(m.result.ranks.every((r) => r.rank >= 1 && typeof r.name === 'string'));
  const snap = m.snapshot('a', 0);
  assert.ok(snap.result && Array.isArray(snap.result.ranks));
  assert.ok(snap.events.some((e) => e.type === 'end'));
  // 结束后 update 不再推进时间
  const t = m.time;
  m.update(tick);
  assert.equal(m.time, t);
});

test('观战：死亡玩家仍能拿到快照，队友列表保留全队', () => {
  const m = new Match({ seed: 53, mode: 'squad', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.addPlayer('b', 'Bravo', { team: 0 });
  m.addPlayer('c', 'Charlie', { team: 1 });
  m.start();
  m.players.length = 3;
  const a = m.players[0];
  m.kill(a, 'c', 'shot');
  const snap = m.snapshot('a', 0);
  assert.equal(snap.me.alive, false);
  assert.equal(snap.me.rank, 0);
  assert.ok(snap.teammates.some((t) => t.id === 'a'));
  assert.ok(snap.teammates.some((t) => t.id === 'b'));
  assert.ok(snap.players.every((p) => typeof p.x === 'number'));
  assert.ok(snap.counts.alive >= 2);
});

test('bot 会移动并且会开火', () => {
  const m = new Match({ seed: 61, mode: 'squad', maxPlayers: 8, duration: 600 });
  m.addPlayer('a', 'Alpha', { team: 0 });
  m.addPlayer('b', 'Bravo', { team: 0 });
  m.start();
  m.players.length = 2;
  const lane = openLane(m.world, 26);
  assert.ok(lane);
  m.players[0].x = lane.x; m.players[0].z = lane.z;
  m.players[1].x = lane.x + lane.dx * 2; m.players[1].z = lane.z + lane.dz * 2;
  const bot = m.addPlayer('botx', 'BotX', { bot: true, team: 3 });
  bot.bot = true;
  bot.x = lane.x + lane.dx * 9; bot.z = lane.z + lane.dz * 9;
  for (let i = 0; i < 20; i++) m.addPlayer(`bm${i}`, `BM${i}`, { bot: true, team: 4 + (i % 6) });
  const pos0 = m.players.map((p) => ({ x: p.x, z: p.z }));
  m.zone.nextIn = 9999; m.dropsLeft = 0;
  step(m, 150);
  let movedCount = 0;
  for (let i = 0; i < m.players.length; i++) {
    const p = m.players[i];
    if (!p.alive) continue;
    if (Math.hypot(p.x - pos0[i].x, p.z - pos0[i].z) > 0.5) movedCount++;
  }
  assert.ok(movedCount > 0, 'bots should move');
  assert.ok(m.events.some((e) => e.type === 'shot' || e.type === 'kill'), 'bots should fight');
});

test('horde：波次推进、基地受击、升级与清关', () => {
  const m = new Match({ seed: 71, mode: 'horde', maxPlayers: 8 });
  m.addPlayer('a', 'Alpha', {});
  m.addPlayer('b', 'Bravo', {});
  assert.equal(m.start(), true);
  assert.equal(m.phase, 'live');
  assert.ok(m.hordeRun);
  assert.equal(m.hordeRun.base.maxHp, 800);
  assert.equal(m.hordeRun.base.hp, 800);
  let snap = m.snapshot('a', 0);
  assert.ok(snap.horde, 'horde snapshot present');
  assert.equal(snap.horde.baseMaxHp, 800);
  assert.equal(snap.horde.totalWaves, 20);
  assert.equal(snap.horde.wave, 0);
  assert.ok(snap.horde.cost > 0);
  assert.equal(snap.horde.upgrades.length, 10, '10 种升级都要在快照里');
  // 准备期结束 → 第 1 波
  step(m, Math.ceil(15 / tick) + 2);
  assert.equal(m.hordeRun.wave, 1);
  assert.ok(m.hordeRun.enemies.length > 0);
  assert.equal(m.hordeRun.enemies.length, 6, '第 1 波：6 只爬行者');
  assert.ok(m.hordeRun.enemies.every((e) => e.type === 'crawler'));
  // 敌人会推进并打基地
  m.players.forEach((p) => { p.x = 1e6; p.z = 1e6; });
  const baseHp0 = m.hordeRun.base.hp;
  step(m, 900);
  assert.ok(m.hordeRun.base.hp < baseHp0, 'enemies should damage the base');
  // 清空本波 → 进入准备期
  m.hordeRun.enemies.forEach((e) => { e.hp = 0; });
  step(m, 4);
  assert.equal(m.hordeRun.enemies.length, 0);
  assert.ok(m.hordeRun.nextWaveIn > 0);
  // 升级：修复基地
  m.hordeRun.base.hp = 200;
  m.hordeRun.credits = 4000;
  assert.equal(m.upgradeCost('repair'), 120);
  assert.equal(m._buy(m.players[0], 'repair'), true);
  assert.ok(m.hordeRun.base.hp > 200);
  assert.equal(m.upgradeCost('repair'), 180);
  assert.equal(m._buy(m.players[0], 'ammo'), true);
  assert.equal(m._buy(m.players[0], 'armor'), true);
  assert.equal(m._buy(m.players[0], 'turret'), true);
  assert.equal(m.hordeRun.base.turrets, 1);
  assert.equal(m.hordeRun.turrets.length, 1);
  // 新增 6 种升级都能买成功
  for (const kind of ['barricade', 'medstation', 'airstrike', 'slowfield', 'weaponcache', 'overcharge']) {
    assert.equal(m._buy(m.players[0], kind), true, `${kind} 应该能买`);
  }
  assert.equal(m.hordeRun.barricades.length, 1);
  assert.equal(m.hordeRun.medstations, 1);
  assert.equal(m.hordeRun.slowfields, 1);
  assert.equal(m.hordeRun.overcharge, true);
});

test('horde：基地被摧毁立即结束，玩家阵亡 8 秒后在基地复活', () => {
  const m = new Match({ seed: 72, mode: 'horde', maxPlayers: 4 });
  m.addPlayer('a', 'Alpha', {});
  m.start();
  const p = m.players[0];
  const base = m.hordeRun.base;
  m.hordeRun.nextWaveIn = 0;
  step(m, 2);
  assert.ok(m.hordeRun.enemies.length > 0);
  m.kill(p, null, 'test');
  step(m, Math.ceil(8 / tick) + 4);
  assert.equal(p.alive, true, 'horde death should respawn after 8s');
  base.hp = 0;
  step(m, 3);
  assert.equal(m.phase, 'ended');
  assert.equal(m.resultReason, 'baseDestroyed');
  assert.ok(m.snapshot('a', 0).horde.baseHp <= 0);
});

test('性能：64 玩家 600 tick 低于 8 秒', () => {
  const m = new Match({ seed: 81, mode: 'squad', maxPlayers: MAX_PLAYERS });
  for (let i = 0; i < MAX_PLAYERS; i++) {
    m.addPlayer(`p${i}`, `P${i}`, { team: Math.floor(i / 4) });
  }
  m.start();
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) m.update(tick);
  const ms = performance.now() - t0;
  const perTick = ms / 600;
  assert.ok(ms < budget(8000), `600 ticks took ${ms.toFixed(0)}ms`);
  assert.ok(perTick < (budget(6000) / 1000), `avg ${perTick.toFixed(2)}ms/tick exceeds ${(budget(6000) / 1000).toFixed(1)}ms budget`);
  const snap = m.snapshot('p0', 0);
  assert.ok(snap.players.length <= MAX_PLAYERS + 4);
});

test('MAX_LOOT：物资点数量不会超过上限', () => {
  const m = new Match({ seed: 91, mode: 'squad', maxPlayers: 4 });
  assert.ok(m.loot.length <= MAX_LOOT);
  for (let i = 0; i < MAX_LOOT + 50; i++) m.addLoot('consumable', 'bandage', 0, 0, { qty: 1 });
  assert.ok(m.loot.length <= MAX_LOOT);
});

test('确定性：相同 seed 的两局 tick 后状态一致', () => {
  const build = () => {
    const m = new Match({ seed: 4242, mode: 'squad', maxPlayers: 8, duration: 420 });
    m.addPlayer('a', 'Alpha', { team: 0 });
    m.start();
    for (let i = 0; i < 240; i++) m.update(tick);
    return m;
  };
  const a = build(); const b = build();
  assert.equal(a.players.length, b.players.length);
  for (let i = 0; i < a.players.length; i++) {
    assert.equal(a.players[i].x.toFixed(4), b.players[i].x.toFixed(4));
    assert.equal(a.players[i].z.toFixed(4), b.players[i].z.toFixed(4));
    assert.equal(a.players[i].hp.toFixed(3), b.players[i].hp.toFixed(3));
  }
  assert.equal(a.eventId, b.eventId);
  assert.equal(a.zone.phase, b.zone.phase);
});

test('断线重连：disconnect 后输入被清空，reconnect 恢复', () => {
  const m = duel({ bots: 0 });
  const p = m.players[0];
  m.input('a', { mx: 1, mz: 1, fire: true });
  assert.equal(m.disconnect('a'), true);
  assert.equal(p.connected, false);
  assert.equal(p.input.fire, false);
  assert.equal(m.reconnect('a'), true);
  assert.equal(p.connected, true);
  assert.equal(m.input('ghost', { fire: true }), false);
});

// ── 性能优化回归：loot 压实与快照基座复用（协议输出与逐份重建完全一致） ──────────
test('loot 压实：taken 条目被剔除，其余条目 id 与相对顺序稳定', () => {
  const m = duel({ bots: 0 });
  const before = m.loot.map((l) => l.id);
  assert.ok(before.length >= 4, '测试前置：地图应有足够物资');
  m.loot[1].taken = true;
  m.loot[3].taken = true;
  step(m, 55); // 跨过 50 tick 压实点
  const after = m.loot.map((l) => l.id);
  const expected = before.filter((id) => id !== before[1] && id !== before[3]);
  assert.deepEqual(after, expected, '压实后剩余条目应保持原相对顺序');
  const snap = m.snapshot('a', 0);
  const snapIds = new Set(snap.loot.map((l) => l.id));
  assert.ok(!snapIds.has(before[1]) && !snapIds.has(before[3]), '压实后快照不再包含被剔除 id');
});

test('MAX_LOOT 生成额度以本局累计生成数为准：压实不腾出新生成额度', () => {
  const m = duel({ bots: 0 });
  while (m.addLoot('consumable', 'bandage', 0, 0, { qty: 1 })) { /* 填满本局生成额度 */ }
  assert.equal(m.lootId, MAX_LOOT, '累计生成数应正好达到上限');
  m.loot[0].taken = true;
  m.loot[7].taken = true;
  step(m, 55);
  assert.equal(m.loot.length, MAX_LOOT - 2, '压实应剔除 2 条 taken 条目');
  assert.equal(m.addLoot('consumable', 'bandage', 0, 0, { qty: 1 }), null,
    '压实后不得产生新生成额度（空投补货行为与压实前完全一致）');
});

test('快照基座复用：同 tick 两次快照字节一致，tick 推进后基座刷新', () => {
  const m = duel({ bots: 1 });
  m.players[1].x = 4; m.players[1].z = 4; // 敌人放进 70m 可视圈
  const a1 = JSON.stringify(m.snapshot('a', 0));
  const a2 = JSON.stringify(m.snapshot('a', 0));
  assert.equal(a1, a2, '同 tick 内重复快照输出必须逐字节一致');
  assert.ok(JSON.stringify(m.snapshot(null, 0)).length > 0, '观战快照可用');
  const t1 = m.time;
  step(m, 1);
  const a3 = JSON.parse(JSON.stringify(m.snapshot('a', 0)));
  assert.ok(a3.time > t1, 'tick 推进后快照 time 应刷新（基座随之重建）');
});

// ── 降落区投票（dropHints）：开局前小队选落点 ─────────────────────────────────
test('降落区投票：有票队的人类落在距 hint 最近的锚点，bot 与无票队走默认锚点', () => {
  const m = new Match({ seed: 991, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('h', 'Hero', { bot: false, team: 0 });
  m.addPlayer('b', 'Bot', { bot: true, team: 0 });
  m.addPlayer('x', 'Xeno', { bot: false, team: 1 });
  const anchors = m.world.spawnAnchors;
  const R = m.world.radius;
  const legacy = anchors[0]; // team0 人类默认锚点（team*3）
  let target = null;
  let best = -1;
  for (const a of anchors) {
    const d = Math.hypot(a.x - legacy.x, a.z - legacy.z);
    const d1 = Math.hypot(a.x - anchors[3].x, a.z - anchors[3].z);
    if (d > best && d1 > 40) { best = d; target = a; }
  }
  assert.ok(best > 60, '测试前置：hint 锚点应远离默认锚点');
  const hint = { x: target.x / (2 * R) + 0.5, z: target.z / (2 * R) + 0.5 };
  assert.equal(m.start({ dropHints: { 0: hint } }), true);
  const h = m.players.find((p) => p.id === 'h');
  const bot = m.players.find((p) => p.id === 'b');
  const xeno = m.players.find((p) => p.id === 'x');
  assert.ok(Math.hypot(h.x - target.x, h.z - target.z) < 6,
    `有票队人类应贴近 hint 锚点（${Math.hypot(h.x - target.x, h.z - target.z).toFixed(1)}m）`);
  assert.ok(Math.hypot(bot.x - anchors[1].x, bot.z - anchors[1].z) < 5, 'bot 不受 hint 影响（team*3+1）');
  assert.ok(Math.hypot(xeno.x - anchors[3].x, xeno.z - anchors[3].z) < 5, '无票队人类仍走默认锚点（team*3）');
});

test('降落区缺省：start() 不带 dropHints 时出生路径与 hint 字段保持原样', () => {
  const m = new Match({ seed: 992, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('h', 'Hero', { bot: false, team: 0 });
  assert.equal(m.start(), true);
  assert.equal(m.dropHints, null);
  const anchors = m.world.spawnAnchors;
  const h = m.players[0];
  assert.ok(Math.hypot(h.x - anchors[0].x, h.z - anchors[0].z) < 6, '无 hint 的人类仍落在默认锚点');
  // 非法 dropHints（team 键不是非负整数）整体忽略，且不改变出生序列
  const m2 = new Match({ seed: 992, mode: 'squad', maxPlayers: 8 });
  m2.addPlayer('h', 'Hero', { bot: false, team: 0 });
  assert.equal(m2.start({ dropHints: { x: 0.5, z: 0.5 } }), true);
  assert.equal(m2.dropHints, null);
  assert.equal(m2.players[0].x, h.x);
  assert.equal(m2.players[0].z, h.z);
});

test('降落区 hint：坐标 clamp 到 0-1、同种子同 hint 出生一致、同队人类在锚点附近散开', () => {
  const a = new Match({ seed: 993, mode: 'squad', maxPlayers: 8 });
  a.addPlayer('h', 'Hero', { bot: false, team: 0 });
  a.start({ dropHints: { 0: { x: 5, z: -7 } } });
  assert.deepEqual(a.dropHints, { 0: { x: 1, z: 0 } }, '越界坐标应 clamp 进 0-1');
  const b = new Match({ seed: 993, mode: 'squad', maxPlayers: 8 });
  b.addPlayer('h', 'Hero', { bot: false, team: 0 });
  b.start({ dropHints: { 0: { x: 1, z: 0 } } });
  assert.equal(a.players[0].x, b.players[0].x);
  assert.equal(a.players[0].z, b.players[0].z);
  // 同队两名人类：都贴近 hint 锚点，且保持明显间距（环位展开）
  const c = new Match({ seed: 994, mode: 'squad', maxPlayers: 8 });
  const anchors = c.world.spawnAnchors;
  const R = c.world.radius;
  const t = anchors[10];
  c.addPlayer('p1', 'P1', { bot: false, team: 0 });
  c.addPlayer('p2', 'P2', { bot: false, team: 0 });
  c.start({ dropHints: { 0: { x: t.x / (2 * R) + 0.5, z: t.z / (2 * R) + 0.5 } } });
  const [q1, q2] = c.players;
  assert.ok(Math.hypot(q1.x - t.x, q1.z - t.z) < 6 && Math.hypot(q2.x - t.x, q2.z - t.z) < 6,
    '同队两人都应贴近 hint 锚点');
  const sep = Math.hypot(q1.x - q2.x, q1.z - q2.z);
  assert.ok(sep > 2, `同队人类不应重叠（间距 ${sep.toFixed(2)}m）`);
});

// ── 回归：v1.2 修复的模拟层缺陷 ───────────────────────────────────────────────
test('事件 id 恒为数字，实体 id 走 entityId（否则快照窗口按 > 比较会丢弃整类事件）', () => {
  const m = new Match({ seed: 501, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('a', 'A', { bot: false, team: 0 });
  m.addPlayer('b', 'B', { bot: false, team: 1 });
  m.start();
  for (let i = 0; i < 30; i++) m.update(1 / 30);
  // 制造带实体 id 的事件（投掷物爆炸）
  const p = m.players[0];
  p.x = m.players[1].x + 1;
  p.z = m.players[1].z;
  p.grenades = 1;
  m.input('a', { throwable: true, aim: 0, seq: 1 });
  for (let i = 0; i < 120; i++) m.update(1 / 30);
  assert.ok(m.events.length > 0);
  for (const ev of m.events) {
    assert.equal(typeof ev.id, 'number', `事件 ${ev.type} 的 id 必须是数字，实际 ${typeof ev.id}`);
  }
  // 带实体 id 的事件应改名为 entityId，且仍能被 sinceEventId 窗口正确取到
  const withEntity = m.events.filter((e) => e.entityId !== undefined);
  if (withEntity.length) {
    const cut = withEntity[withEntity.length - 1].id - 1;
    const win = m.snapshot('a', cut).events.map((e) => e.id);
    assert.ok(win.every((id) => id > cut), '快照窗口必须按数字 id 正确过滤');
  }
});

test('载具只在真正撞人/撞墙时掉血，正常行驶不掉耐久', () => {
  const m = new Match({ seed: 502, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('drv', 'D', { bot: false, team: 0 });
  m.start();
  const car = m.cars[0];
  const p = m.players[0];
  p.x = car.x; p.z = car.z;
  assert.ok(m._enterCar(p, car), '应能上车');
  assert.equal(car.driver, p.id);
  // 找一条前方 40m 无遮挡的朝向，避免测试本身撞墙
  let openAngle = null;
  for (let k = 0; k < 32 && openAngle == null; k++) {
    const a = (k / 32) * Math.PI * 2;
    const dx = Math.sin(a), dz = Math.cos(a);
    if (m.world.wallDistance(car.x, car.z, dx, dz, 40) >= 38) openAngle = a;
  }
  assert.ok(openAngle != null, '地图上应能找到一段开阔直道');
  car.angle = openAngle;
  const hp0 = car.hp;
  for (let i = 0; i < 30; i++) {
    m.input('drv', { mz: 1, seq: i + 1 });
    m.update(1 / 30);
  }
  // 正常行驶（不含撞墙）不得掉耐久；撞墙允许小额损耗，但单次不超过 12 点
  assert.ok(car.hp >= hp0 - 13, `正常行驶不应大幅掉耐久：${hp0} → ${car.hp}`);
});

test('载具爆炸不会对同一乘员结算两次伤害', () => {
  const m = new Match({ seed: 503, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('r1', 'R1', { bot: false, team: 0 });
  m.addPlayer('r2', 'R2', { bot: false, team: 0 });
  m.start();
  const car = m.cars[0];
  const [a, b] = m.players;
  a.x = car.x; a.z = car.z; b.x = car.x; b.z = car.z;
  m._enterCar(a, car);
  m._enterCar(b, car);
  const before = { a: a.hp + a.shield + a.armor, b: b.hp + b.shield + b.armor };
  m._explodeCar(car, null);
  const after = { a: a.hp + a.shield + a.armor, b: b.hp + b.shield + b.armor };
  // 只吃一次 55（不是 55 + 70）
  assert.ok(before.a - after.a <= 56, `乘员只应受一次爆炸伤害，实际 ${(before.a - after.a).toFixed(1)}`);
  assert.ok(before.b - after.b <= 56, `乘员只应受一次爆炸伤害，实际 ${(before.b - after.b).toFixed(1)}`);
});

test('大厅阶段移除玩家不会误判团灭结束比赛', () => {
  const m = new Match({ seed: 504, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('x', 'X', { bot: false, team: 0 });
  m.addPlayer('y', 'Y', { bot: false, team: 0 });
  assert.equal(m.phase, 'waiting');
  m.removePlayer('x');
  assert.equal(m.phase, 'waiting', '等待阶段移除玩家不应结束比赛');
  assert.equal(m.start(), true, '移除后仍应能正常开局');
});

test('水面试为减速地形（inWater 别名接到 isWater）', () => {
  const m = new Match({ seed: 505, mode: 'squad', maxPlayers: 8 });
  assert.equal(typeof m.world.inWater, 'function');
  const src = String(m.world.inWater);
  assert.ok(!/=>\s*false/.test(src), 'inWater 不应是恒 false 的空实现');
});

test('结算摘要使用模拟层权威统计，而不是只依赖事件窗口', () => {
  const m = new Match({ seed: 506, mode: 'squad', maxPlayers: 16 });
  m.addPlayer('me', '我', { bot: false, team: 0 });
  for (let i = 1; i < 16; i++) m.addPlayer('b' + i, 'B' + i, { bot: true, team: (i / 4) | 0 });
  m.start();
  for (let t = 0; t < 300; t++) {
    m.input('me', { mx: Math.sin(t / 30), mz: Math.cos(t / 30), fire: t % 3 === 0, seq: t + 1 });
    m.update(1 / 30);
  }
  assert.ok(m.players[0].stats.shotsFired > 0, '模拟层应累计开火数');
  const snap = m.snapshot('me', snapEventIdOf(m));
  assert.ok(snap.me.stats && snap.me.stats.shotsFired > 0, '快照应下发权威统计');
  const summary = matchSummaryFromState(snap, 'me', { mode: 'squad', mapId: 'qinglan' });
  assert.equal(summary.shotsFired, m.players[0].stats.shotsFired, '摘要应直接采用权威统计');
});

// 结算时事件窗口为空（sinceEventId 已消费到最新）—— 这正是旧实现所有字段为 0 的原因
function snapEventIdOf(m) { return m.eventId; }

// ── 回归：装备形状（对象 vs 数组）──────────────────────────────────────────
// 历史 bug：客户端 normalizeLoadout() 返回对象 {primary, secondary, attachments...}，
// 而 _applyLoadout 只认数组，静默回退成 [{type:'p9'}, null] —— 所有对局开局
// 都只有 P9 手枪、无配件、无消耗品、无投掷物，「装备」界面完全无效。
test('装备：对象形状（客户端存档）被正确应用', () => {
  const m = new Match({ seed: 601, mode: 'training', maxPlayers: 4 });
  m.addPlayer('me', '我', {
    team: 0,
    loadout: {
      primary: 'ar7', secondary: 'p9',
      attachments: { primary: ['red_dot'], secondary: [] },
      throwable: 'frag', consumable: 'medkit', skin: 'skin_default',
    },
  });
  m.start();
  const p = m.players[0];
  assert.equal(p.loadout[0]?.type, 'ar7', '主武器应来自存档');
  assert.deepEqual(p.loadout[0]?.attachments, ['red_dot'], '主武器配件应保留');
  assert.equal(p.loadout[1]?.type, 'p9', '副武器应来自存档');
  assert.ok(p.grenades > 0, '应发放选定投掷物');
  assert.ok(p.meds > 0, '应发放选定消耗品');
  assert.equal(p.skin, 'skin_default', '皮肤应被记录');
});

test('装备：数组形状（服务端/测试）仍然可用', () => {
  const m = new Match({ seed: 602, mode: 'training', maxPlayers: 4 });
  m.addPlayer('me', '我', { team: 0, loadout: [{ type: 'ak12', attachments: ['scope2'] }, { type: 'p226' }] });
  m.start();
  const p = m.players[0];
  assert.equal(p.loadout[0]?.type, 'ak12');
  assert.equal(p.loadout[1]?.type, 'p226');
});

test('装备：两把都无效时仍给保底手枪，不会开局空手', () => {
  const m = new Match({ seed: 603, mode: 'training', maxPlayers: 4 });
  m.addPlayer('me', '我', { team: 0, loadout: { primary: 'nonexistent', secondary: 'also_bad' } });
  m.start();
  const p = m.players[0];
  assert.ok(p.loadout[0] || p.loadout[1], '必须至少有一把武器');
});

test('装备：不同投掷物/消耗品映射到各自的计数器', () => {
  const cases = [
    { throwable: 'smoke', consumable: 'bandage', check: (p) => [p.smokes, p.bandages] },
    { throwable: 'flash', consumable: 'shield', check: (p) => [p.flashes, p.shields] },
    { throwable: 'molotov', consumable: 'energy', check: (p) => [p.molotovs, p.energy] },
  ];
  for (const c of cases) {
    const m = new Match({ seed: 604, mode: 'training', maxPlayers: 4 });
    m.addPlayer('me', '我', { team: 0, loadout: { primary: 'ar7', throwable: c.throwable, consumable: c.consumable } });
    m.start();
    const [throwCount, useCount] = c.check(m.players[0]);
    assert.ok(throwCount > 0, `${c.throwable} 应发放到对应计数器，实际 ${throwCount}`);
    assert.ok(useCount > 0, `${c.consumable} 应发放到对应计数器，实际 ${useCount}`);
  }
});

// ── 回归：友军伤害口径一致性 ──────────────────────────────────────────────
// 枪械由 COMBAT.friendlyFire = 0 完全关闭，但面积伤害（手雷）与载具撞击
// 过去都没有队友判定 —— 一颗雷能把三个队友打成残血，司机打转能把队友撞成重伤。
// 这是四人小队里最莫名其妙的死法。现在：手雷对队友 30%，载具撞击对队友 0。
test('友伤：手雷对队友只造成 30% 伤害，对敌人全额', () => {
  const m = new Match({ seed: 701, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('me', '我', { bot: false, team: 0 });
  m.addPlayer('mate', '队友', { bot: false, team: 0 });
  m.addPlayer('foe', '敌人', { bot: false, team: 1 });
  m.start();
  const [me, mate, foe] = m.players;
  // 三人重叠在爆炸中心附近（排除距离衰减差异）
  me.x = 0; me.z = 0; mate.x = 1; mate.z = 0; foe.x = 1; foe.z = 1;
  me.shield = 0; me.armor = 0; mate.shield = 0; mate.armor = 0; foe.shield = 0; foe.armor = 0;
  m._detonate({ id: 'gX', kind: 'frag', x: 0, z: 0, owner: 'me' });
  assert.ok(mate.hp > foe.hp, `队友(${mate.hp.toFixed(0)}) 应比敌人(${foe.hp.toFixed(0)}) 受伤更少`);
  // 30% 伤害 ≈ 掉 30 点（实测剩 68.7，差额来自距离衰减与爆炸中心偏移）
  assert.ok(mate.hp > 60, `队友受伤应约为 30%，实际剩 ${mate.hp.toFixed(1)}`);
  assert.ok(mate.hp < 80, `队友受伤不应过轻，实际剩 ${mate.hp.toFixed(1)}`);
});

test('友伤：载具撞击不会伤害队友', () => {
  const m = new Match({ seed: 702, mode: 'squad', maxPlayers: 8 });
  m.addPlayer('drv', '司机', { bot: false, team: 0 });
  m.addPlayer('mate', '队友', { bot: false, team: 0 });
  m.start();
  const [drv, mate] = m.players;
  const car = m.cars[0];
  car.driver = drv.id;
  drv.car = car.id; drv.seat = 0;
  car.occupants[0] = drv.id;
  // 队友站在车前
  car.speed = 12;
  mate.x = car.x + Math.sin(car.angle) * 1.5;
  mate.z = car.z + Math.cos(car.angle) * 1.5;
  const hp0 = mate.hp;
  car.hitCd = 0;
  m._driveInput(drv, 1 / 30);
  assert.equal(mate.hp, hp0, '队友不应被自己人的车撞伤');
});
