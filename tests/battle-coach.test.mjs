import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../shared/simulation.mjs';
import * as Wire from '../shared/wire.mjs';
import {
  compassDirection, zoneGuidance, nearestLootHint, captureDeath, buildMatchDebrief,
} from '../client/battle-coach.js';

test('方向指示遵循小地图坐标：北 -Z、东 +X、南 +Z', () => {
  assert.equal(compassDirection(0, -2), '北');
  assert.equal(compassDirection(3, -3), '东北');
  assert.equal(compassDirection(5, 0), '东');
  assert.equal(compassDirection(0, 3), '南');
  assert.equal(compassDirection(0, 0), '当前位置');
});

test('圈外导航指向安全区内侧，并显示真实圈伤', () => {
  const zone = { x: 0, z: 0, r: 100, damage: 12, closing: false };
  const me = { x: 130, z: 0, alive: true };
  const advice = zoneGuidance(zone, me);
  assert.equal(advice.kind, 'danger');
  assert.equal(advice.direction, '西');
  assert.equal(advice.meters, 34);
  assert.equal(advice.goal.x, 96);
  assert.match(advice.text, /-12血\/秒/);
  assert.ok(Math.hypot(advice.goal.x, advice.goal.z) < zone.r);
});

test('缩圈时预判下一安全区，而不是把玩家引向旧圈心', () => {
  const zone = { x: 0, z: 0, r: 100, closing: true, damage: 4, target: { x: 45, z: 0, r: 40 } };
  const advice = zoneGuidance(zone, { x: -60, z: 0, alive: true });
  assert.equal(advice.kind, 'warn');
  assert.equal(advice.direction, '东');
  assert.equal(advice.goal.x, 9);
  assert.equal(advice.meters, 69);
});

test('安全区内保持安静；部署、阵亡、训练与虫潮不弹误导性缩圈箭头', () => {
  const zone = { x: 0, z: 0, r: 100, closing: false, damage: 3 };
  assert.equal(zoneGuidance(zone, { x: 2, z: 0, alive: true }), null);
  assert.equal(zoneGuidance(zone, { x: 98, z: 0, alive: true }), null, '安全圈边缘 4 米余量不能误报圈外');
  assert.equal(zoneGuidance(zone, { x: 130, z: 0 }, 'deploying'), null);
  assert.equal(zoneGuidance(zone, { x: 130, z: 0, alive: false }), null);
  assert.equal(zoneGuidance(zone, { x: 130, z: 0 }, 'live', 'training'), null);
  assert.equal(zoneGuidance(zone, { x: 130, z: 0 }, 'live', 'horde'), null);
  assert.equal(zoneGuidance({ r: 0 }, { x: 5, z: 0 }), null);
});

test('物资指导只选可拾取且足够近的物资，并提示方向与距离', () => {
  const loot = [
    { x: 1, z: 0, taken: true },
    { x: 9, z: -4, taken: false },
    { x: 20, z: 0, taken: false },
    { x: 0, z: 0, taken: true },
  ];
  const hint = nearestLootHint(loot, { x: 0, z: 0 });
  assert.equal(hint.direction, '东北');
  assert.equal(hint.meters, 10);
  assert.equal(nearestLootHint(loot, { x: -200, z: 0 }), null);
  assert.equal(nearestLootHint([], { x: 0, z: 0 }), null);
});

test('死亡记录严格匹配本机受害者；从权威事件提取枪械与攻击者', () => {
  const event = { type: 'kill', id: 12, player: 'self', by: 'enemy', reason: 'shot', weapon: 'ar7' };
  assert.equal(captureDeath(event, 'other'), null);
  assert.equal(captureDeath({ ...event, type: 'shot' }, 'self'), null);
  assert.deepEqual(captureDeath(event, 'self', [{ id: 'enemy', name: '对手A' }]), {
    reason: 'shot', attackerName: '对手A', weapon: 'ar7', by: 'enemy',
  });
  assert.equal(captureDeath({ ...event, attackerName: '服务器名字' }, 'self').attackerName, '服务器名字');
});

test('复盘将毒圈、倒地、爆炸、火焰、撞击与枪战区分；不假装知道缺失事件', () => {
  const base = { won: false, shotsFired: 30, shotsHit: 3 };
  const zone = buildMatchDebrief(base, { reason: 'zone' });
  assert.match(zone.cause, /安全区/);
  assert.match(zone.tip, /护甲/);
  assert.match(buildMatchDebrief(base, { reason: 'bleedout' }).cause, /倒地/);
  assert.match(buildMatchDebrief(base, { reason: 'grenade' }).cause, /爆炸/);
  assert.match(buildMatchDebrief(base, { reason: 'fire' }).cause, /燃烧/);
  assert.match(buildMatchDebrief(base, { reason: 'vehicle' }).cause, /载具/);
  const shot = buildMatchDebrief(base, { reason: 'shot', attackerName: '对手A', weapon: 'ar7' });
  assert.match(shot.cause, /对手A.*ar7/);
  assert.match(shot.tip, /10%/);
  assert.match(buildMatchDebrief(base).cause, /暂未收到/);
});

test('存活结算不能被误报为淘汰；胜利给正向下一局建议', () => {
  assert.match(buildMatchDebrief({ won: false, aliveAtEnd: true }).cause, /仍然存活/);
  assert.equal(buildMatchDebrief({ won: true, kills: 5 }).kind, 'win');
});

test('真实模拟层：毒圈击杀事件携带 zone 而非 shot', () => {
  const match = new Match({ seed: 41, mode: 'solo', maxPlayers: 2, duration: 100 });
  match.addPlayer('self', '测试玩家', { team: 0 });
  match.start();
  match.players.length = 1;
  const me = match.players[0];
  me.hp = 30; me.armor = 150; me.shield = 100;
  match.damage(me, 40, null, { noDown: true, zone: true });
  assert.equal(me.alive, false);
  const ev = match.events.find((e) => e.type === 'kill' && e.player === 'self');
  assert.equal(ev?.reason, 'zone');
  assert.equal(ev?.attackerName, null);
  assert.equal(captureDeath(ev, 'self')?.reason, 'zone');
});

test('真实模拟层：燃烧伤害可显式携带淘汰原因', () => {
  const match = new Match({ seed: 42, mode: 'solo', maxPlayers: 2, duration: 100 });
  match.addPlayer('self', '测试玩家', { team: 0 });
  match.start();
  match.players.length = 1;
  const me = match.players[0];
  me.hp = 8; me.shield = 0; me.armor = 0;
  match.damage(me, 20, null, { reason: 'fire', noDown: true });
  const ev = match.events.find((e) => e.type === 'kill' && e.player === 'self');
  assert.equal(ev?.reason, 'fire');
});


test('联机二进制快照：击杀事件额外携带的攻击者名字与武器不会被编码丢弃', () => {
  const match = new Match({ seed: 83, mode: 'solo', maxPlayers: 2, duration: 120 });
  match.addPlayer('self', '我', { team: 0 });
  match.addPlayer('enemy', '敌人甲', { team: 1 });
  match.start();
  const me = match.players.find((p) => p.id === 'self');
  const foe = match.players.find((p) => p.id === 'enemy');
  match.kill(me, foe.id, 'shot');
  const state = match.snapshot('self', 0);
  const ctx = Wire.createWireContext({ roster: Wire.rosterFromPlayers(state.players) });
  const frame = Wire.encodeStateFrame(state, ctx);
  const decoded = Wire.decodeStateFrame(frame, ctx).state;
  const killed = decoded.events.find((e) => e.type === 'kill' && e.player === 'self');
  assert.equal(killed.reason, 'shot');
  assert.equal(killed.attackerName, '敌人甲');
  assert.equal(killed.weapon, state.events.find((e) => e.type === 'kill' && e.player === 'self').weapon);
});
