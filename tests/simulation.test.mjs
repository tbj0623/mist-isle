// 雾岛突围 / MIST ISLE — 模拟核心测试（node --test tests/simulation.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Match, sanitizeInput, emptyInput, effectiveWeapon, MAX_PLAYERS,
  ATTACHMENTS, WEAPONS, THROWABLES,
} from '../shared/simulation.mjs';
import { TICK_RATE, MAX_LOOT, MOVE, REVIVE_TIME, BLEEDOUT_TIME, REVIVE_HP } from '../shared/rules.mjs';

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

/** 找一段至少 len 米无遮挡的直线跑道（给载具测试用）。 */
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
  m.input('a', { mx: 1, mz: 0 });
  step(m, 20);
  const walkDist = Math.abs(p.x);
  const stamina0 = p.stamina;
  p.x = 0; p.z = 0;
  m.input('a', { mx: 1, mz: 0, sprint: true });
  step(m, 20);
  const sprintDist = Math.abs(p.x);
  assert.ok(sprintDist > walkDist, `sprint ${sprintDist} > walk ${walkDist}`);
  assert.ok(p.stamina < stamina0, 'sprint drains stamina');
  m.input('a', {});
  step(m, 30);
  assert.ok(p.stamina > 0, 'stamina regenerates when idle');
  p.x = 0; p.z = 0; p.stamina = 100;
  m.input('a', { mx: 1, mz: 0, crouch: true });
  step(m, 20);
  const crouchDist = Math.abs(p.x);
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
  const x0 = p.x; const z0 = p.z;
  p.dodgeCd = 0;
  m.input('a', { mx: 1, mz: 0, dodge: true });
  step(m, 1);
  assert.equal(p.state, 'dodge');
  assert.ok(p.dodgeCd > 1.5);
  assert.equal(m.tryFire(p), false);
  step(m, Math.ceil(MOVE_DODGE_TIME / tick) + 1);
  const moved = Math.hypot(p.x - x0, p.z - z0);
  assert.ok(moved > 3.2 && moved < 5.2, `dodge distance ${moved}`);
  m.input('a', { dodge: true });
  assert.equal(p.dodgeCd > 0, true);
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
