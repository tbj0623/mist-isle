import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMBAT_TASKS, createCombatGuide, observeCombatMovement, observeCombatEvent, combatGuideStatus,
} from '../client/training-guide.js';

test('训练目标：只累计有限的正常位移，重连瞬移不算移动', () => {
  const guide = createCombatGuide();
  assert.equal(observeCombatMovement(guide, { x: 0, z: 0, alive: true }), false);
  assert.equal(observeCombatMovement(guide, { x: 2, z: 0, alive: true }), false);
  assert.equal(observeCombatMovement(guide, { x: 40, z: 0, alive: true }), false);
  assert.equal(observeCombatMovement(guide, { x: 42, z: 0, alive: true }), false);
  assert.equal(observeCombatMovement(guide, { x: 44, z: 0, alive: true }), true);
  assert.equal(combatGuideStatus(guide).count, 1);
  assert.equal(observeCombatMovement(guide, { x: 45, z: 0, alive: true }), false);
  assert.equal(observeCombatMovement(guide, { x: NaN, z: 3 }), false);
});

test('训练目标：远处敌人的行为不能计为本机玩家操作', () => {
  const guide = createCombatGuide();
  for (const type of ['shot', 'hit', 'reloaded', 'pickup']) {
    assert.equal(observeCombatEvent(guide, { type, player: 'bot', hit: true }, 'self'), false);
  }
  assert.equal(combatGuideStatus(guide).count, 0);
});

test('训练目标：开火命中、换弹、拾取可独立乱序记分，重复事件不重复计数', () => {
  const guide = createCombatGuide();
  assert.equal(observeCombatEvent(guide, { type: 'shot', player: 'self', hit: false }, 'self'), true);
  assert.equal(combatGuideStatus(guide).next.id, 'move');
  assert.equal(observeCombatEvent(guide, { type: 'shot', player: 'self', hit: true }, 'self'), true);
  assert.equal(observeCombatEvent(guide, { type: 'shot', player: 'self', hit: true }, 'self'), false);
  assert.equal(observeCombatEvent(guide, { type: 'reload', player: 'self' }, 'self'), false);
  assert.equal(observeCombatEvent(guide, { type: 'reloaded', player: 'self' }, 'self'), true);
  assert.equal(observeCombatEvent(guide, { type: 'pickup', player: 'self' }, 'self'), true);
  observeCombatMovement(guide, { x: 0, z: 0 });
  observeCombatMovement(guide, { x: 3, z: 0 });
  observeCombatMovement(guide, { x: 5.2, z: 0 });
  assert.deepEqual(combatGuideStatus(guide), { count: COMBAT_TASKS.length, total: COMBAT_TASKS.length, next: null });
});

test('训练目标：独立 hit 事件支持 attacker 字段', () => {
  const guide = createCombatGuide();
  assert.equal(observeCombatEvent(guide, { type: 'hit', attacker: 'self', target: 'bot' }, 'self'), true);
  assert.equal(guide.completed.has('hit'), true);
  assert.equal(observeCombatEvent(guide, { type: 'hit', attacker: 'bot', target: 'self' }, 'self'), false);
});
