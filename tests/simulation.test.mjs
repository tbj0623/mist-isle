import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, sanitizeInput, emptyInput, MAX_PLAYERS, MAX_HUMANS_PER_ROOM, SQUAD_SIZE, TICK_RATE, REVIVE_TIME, BLEEDOUT_TIME } from '../shared/simulation.mjs';
import { MAX_LOOT } from '../shared/rules.mjs';
import { MAP, blocked, moveBody, wallDistance, clearLine } from '../shared/map.mjs';

function fixture() {
  const match = new Match({ seed: 38, maxPlayers: 8 });
  const a = match.addPlayer('a', 'Alpha', { team: 0 });
  const b = match.addPlayer('b', 'Bravo', { team: 0 });
  const c = match.addPlayer('c', 'Charlie', { team: 0 });
  const d = match.addPlayer('d', 'Delta', { team: 0 });
  const enemy = match.addPlayer('enemy', 'Enemy', { team: 1 });
  match.phase = 'playing'; match.loot = [];
  for (const p of [a, b, c, d, enemy]) { p.x = 0; p.z = 0; p.input = emptyInput(); }
  b.x = 5; c.x = -15; d.x = -20; enemy.x = 0; enemy.z = 10;
  return { match, a, b, c, d, enemy };
}
function setInput(match, id, input = {}) {
  const player = match.players.find(p => p.id === id);
  match.input(id, { ...emptyInput(), ...input, seq: player.inputSeq + 1 });
}
function advance(match, seconds, inputs = {}) {
  for (let n = 0; n < Math.ceil(seconds * TICK_RATE); n++) {
    for (const [id, input] of Object.entries(inputs)) setInput(match, id, input);
    match.update(1 / TICK_RATE);
  }
}

test('invalid numeric input is finite and diagonal speed is normalized', () => {
  const input = sanitizeInput({ mx: 999, mz: 999, aim: NaN, fire: 'true', seq: Infinity, x: 1e20 });
  assert.ok(Math.abs(Math.hypot(input.mx, input.mz) - 1) < 1e-9);
  assert.equal(input.aim, 0); assert.equal(input.fire, false); assert.equal(input.seq, 0); assert.equal(input.x, undefined);
  assert.deepEqual(sanitizeInput(null), emptyInput());
});
test('identical seeds generate identical maps, loot and squad spawns', () => {
  const first = new Match({ seed: 95 }), second = new Match({ seed: 95 });
  first.addPlayer('a', 'Alpha', { team: 0 }); second.addPlayer('a', 'Alpha', { team: 0 }); first.start(); second.start();
  assert.deepEqual(first.snapshot(), second.snapshot());
});
test('four human friends share a squad inside a 64-seat match', () => {
  const match = new Match();
  for (let i = 0; i < SQUAD_SIZE; i++) assert.ok(match.addPlayer(`h${i}`, `H${i}`, { team: 0 }));
  assert.equal(match.addPlayer('late-human', 'Late', { team: 0 }), null);
  assert.equal(match.start(), true); assert.equal(match.players.length, MAX_PLAYERS);
  assert.equal(match.players.filter(p => p.bot).length, MAX_PLAYERS - SQUAD_SIZE);
  assert.deepEqual(match.teamSummary().map(t => t.members), Array(MAX_PLAYERS / SQUAD_SIZE).fill(SQUAD_SIZE));
  advance(match, 3.6); assert.equal(match.phase, 'playing'); assert.ok(match.players.every(p => p.air === 0));
});
test('server controls movement and ignores forged coordinates and health', () => {
  const { match, a } = fixture(); a.x = 0; a.z = 0;
  advance(match, 1, { a: { mx: 1, x: 100000, hp: 100000 } });
  assert.ok(a.x > 4 && a.x < 8); assert.equal(a.hp, 100); assert.equal(a.z, 0);
});
test('duplicate input is rejected and stale input stops movement', () => {
  const { match, a } = fixture(); match.input('a', { mx: 1, seq: 5 }); match.input('a', { mx: -1, seq: 4 });
  assert.equal(a.input.mx, 1); advance(match, 1); const x = a.x; advance(match, 1);
  assert.equal(a.x, x); assert.ok(x > 0);
});
test('movement collides with walls but can pass through the actual door', () => {
  const b = MAP.buildings[0];
  const body = { x: b.x - b.w / 2 - 2, z: b.z };
  moveBody(body, 10, 0); assert.ok(body.x < b.x - b.w / 2);
  const doorway = { x: b.x, z: b.z + b.d / 2 + 2 }; moveBody(doorway, 0, -4);
  assert.ok(doorway.z < b.z + b.d / 2); assert.equal(blocked(doorway.x, doorway.z), false);
});
test('rays stop at walls and open space has clear line of sight', () => {
  const b = MAP.buildings[0], a = { x: b.x - b.w / 2 - 2, z: b.z }, target = { x: b.x, z: b.z };
  assert.equal(clearLine(a, target), false); assert.ok(wallDistance(a.x, a.z, 1, 0, 10) < 3); assert.equal(clearLine({ x: 0, z: 0 }, { x: 0, z: 10 }), true);
});
test('hitscan damages enemies, spends ammunition and ignores friendly fire', () => {
  const { match, a, b, enemy } = fixture(); a.x = 0; a.z = 0; b.x = 0; b.z = 10; enemy.x = 0; enemy.z = 10;
  advance(match, .1, { a: { aim: 0, fire: true } });
  assert.equal(b.hp, 100); assert.equal(enemy.hp, 77); assert.equal(a.ammo, 11); assert.equal(match.events.filter(e => e.type === 'shot').length, 1);
});
test('bullets do not damage an enemy through a wall', () => {
  const { match, a, enemy } = fixture(), house = MAP.buildings[0];
  a.x = house.x - house.w / 2 - 2; a.z = house.z; enemy.x = house.x; enemy.z = house.z;
  advance(match, .1, { a: { aim: Math.atan2(enemy.x - a.x, enemy.z - a.z), fire: true } }); assert.equal(enemy.hp, 100);
});
test('armor absorbs damage and a lethal hit creates a recoverable downed state', () => {
  const { match, a, enemy } = fixture(); a.armor = 65; match.damage(a, 50, enemy); assert.equal(a.armor, 35); assert.equal(a.hp, 80);
  match.damage(a, 200, enemy); assert.equal(a.alive, true); assert.equal(a.downed, true); assert.equal(a.bleedout, BLEEDOUT_TIME);
});
test('a teammate can revive a downed player only after sustained interaction', () => {
  const { match, a, b, enemy } = fixture(); match.damage(a, 200, enemy); b.x = 1; b.z = 0;
  advance(match, REVIVE_TIME - .1, { b: { interact: true } }); assert.equal(a.downed, true); assert.ok(a.reviveProgress > 0);
  advance(match, .2, { b: { interact: true } }); assert.equal(a.downed, false); assert.equal(a.hp, 38); assert.ok(match.events.some(e => e.type === 'revive'));
});
test('downed players bleed out and final death drops equipment', () => {
  const { match, a, enemy } = fixture(); match.damage(a, 200, enemy); a.weapon = 'rifle'; advance(match, BLEEDOUT_TIME + 1); assert.equal(a.alive, false); assert.ok(match.loot.some(l => l.type === 'rifle')); assert.ok(match.events.some(e => e.type === 'kill' && e.reason === 'bleedout'));
});
test('reload consumes reserve only after its delay', () => {
  const { match, a } = fixture(); a.ammo = 2; a.reserve = 4;
  advance(match, .3, { a: { reload: true } }); assert.equal(a.ammo, 2); advance(match, 1.2); assert.equal(a.ammo, 6); assert.equal(a.reserve, 0);
});
test('healing consumes one pack, and movement or damage interrupts it', () => {
  const { match, a, enemy } = fixture(); a.hp = 25; a.meds = 2;
  advance(match, .2, { a: { heal: true } }); advance(match, 2.6); assert.equal(a.hp, 90); assert.equal(a.meds, 1);
  a.hp = 25; advance(match, .2, { a: { heal: true } }); advance(match, .1, { a: { mx: 1 } }); assert.equal(a.healTime, 0); assert.equal(a.meds, 1);
  advance(match, .2, { a: { heal: true } }); match.damage(a, 5, enemy); assert.equal(a.healTime, 0);
});
test('nearby equipment is picked up and inventory limits are respected', () => {
  const { match, a } = fixture(); match.addLoot('rifle', 0, 0); match.addLoot('armor', .1, 0); match.addLoot('med', .2, 0);
  advance(match, .1); assert.equal(a.weapon, 'rifle'); assert.equal(a.ammo, 30); assert.equal(a.armor, 65); assert.equal(a.meds, 3);
  a.meds = 4; match.addLoot('med', 0, 0); advance(match, .1); assert.equal(a.meds, 4); assert.ok(match.loot.some(l => l.type === 'med'));
});
test('four teammates share one vehicle, driver moves and passengers fire', () => {
  const { match, a, b, c, d } = fixture();
  for (const p of [a, b, c, d]) { p.x = 7; p.z = 9; match.vehicle(p); assert.equal(p.car, 'c1'); }
  assert.equal(match.cars[0].seats.filter(Boolean).length, 4); assert.equal(match.cars[0].driver, 'a');
  const x = a.x; advance(match, .3, { a: { mx: 1, fire: true }, b: { fire: true } }); assert.ok(a.x > x + 3); assert.equal(a.ammo, 12); assert.ok(b.ammo < 12);
  assert.equal(b.x, a.x); match.vehicle(a); assert.equal(a.car, null); assert.equal(match.cars[0].driver, 'b'); assert.equal(blocked(a.x, a.z), false);
});
test('disconnect freezes input, reconnect resets sequence, expiry eliminates', () => {
  const { match, a } = fixture(); match.input('a', { mx: 1, seq: 99 }); match.disconnect('a'); advance(match, 1); assert.equal(a.x, 0);
  match.reconnect('a'); match.input('a', { mx: 1, seq: 1 }); advance(match, .1); assert.ok(a.x > 0);
  match.disconnect('a'); advance(match, 21); assert.equal(a.alive, false);
});
test('safe zone shrinks and damages outside players without friendly fire', () => {
  const { match, a } = fixture(); a.x = 176; a.z = 0; const hp = a.hp; advance(match, 45); assert.ok(match.zone.radius < 176); assert.ok(a.hp < hp || a.downed);
});
test('a squad wins when every enemy squad is eliminated', () => {
  const { match, a, enemy } = fixture(); match.kill(enemy, a, 'shot'); match.update(1 / TICK_RATE);
  assert.equal(match.phase, 'ended'); assert.equal(match.winnerTeam, 0); assert.equal(match.winner, a.id); assert.equal(a.rank, 1);
});
test('snapshot is detached, events and loot are bounded', () => {
  const { match, a } = fixture(); const state = match.snapshot(); state.players[0].hp = 0; assert.equal(a.hp, 100);
  for (let i = 0; i < 600; i++) { match.event('test', {}); match.addLoot('ammo', 0, 0); }
  assert.equal(match.events.length, 80); assert.equal(match.loot.length, MAX_LOOT);
});

test('all 64 slots can be human, with four players in each team', () => {
  const match = new Match(); for (let i = 0; i < MAX_HUMANS_PER_ROOM; i++) assert.ok(match.addPlayer(`p${i}`, `Player${i}`, { team: Math.floor(i / 4) }));
  assert.equal(match.addPlayer('overflow','Overflow',{team:0}), null); match.start(); assert.equal(match.players.filter(p => p.bot).length, 0);
});
test('mobile held rescue cancels on movement or firing and ignores stale input', () => {
  const { match, a, b, enemy } = fixture(); match.damage(a, 200, enemy); b.x = 1; b.z = 0;
  advance(match, 1, { b: { interact: true } }); assert.ok(a.reviveProgress > .8);
  advance(match, .1, { b: { interact: true, mx: .5 } }); assert.equal(a.reviveProgress, 0);
  advance(match, 1, { b: { interact: true } }); advance(match, .1, { b: { interact: true, fire: true } }); assert.equal(a.reviveProgress, 0);
  advance(match, 1, { b: { interact: true } }); advance(match, .5); assert.equal(a.reviveProgress, 0);
});
test('whole squad is eliminated when everyone is down, and rankings match', () => {
  const { match, a, b, c, d, enemy } = fixture();
  for (const p of [a,b,c,d]) match.damage(p, 300, enemy); match.update(1/30);
  assert.ok([a,b,c,d].every(p => !p.alive && p.rank === 2)); assert.equal(enemy.kills, 4); assert.equal(match.winnerTeam, 1);
});
test('a dead teammate shares the winning squad rank', () => {
  const { match, a, b, enemy } = fixture(); match.kill(b, enemy, 'shot'); assert.equal(b.rank, 0);
  match.kill(enemy, a, 'shot'); match.update(1/30); assert.equal(b.rank, 1);
});
test('two weapon slots retain ammunition and swaps cannot create ammunition', () => {
  const { match, a } = fixture(); a.ammo = 3; match.addLoot('rifle', 0, 0, 9); match.pickup(a);
  assert.equal(a.weapon, 'rifle'); assert.equal(a.ammo, 9); match.swapWeapon(a); assert.equal(a.weapon,'pistol'); assert.equal(a.ammo,3);
  match.addLoot('sniper', 0, 0, 2); match.pickup(a, true); assert.equal(a.weapon,'sniper'); assert.equal(a.ammo,2);
  assert.equal(match.loot.find(l => l.type === 'pistol').ammo,3); assert.equal(a.reserve,72);
});
test('grenades deal radial enemy damage, smoke blocks AI sight and expires', () => {
  const { match, a, enemy } = fixture(); a.input.aim = 0; enemy.x = 0; enemy.z = 9;
  match.throwGrenade(a, false); assert.equal(a.grenades,1); advance(match,2.2); assert.ok(enemy.hp < 100);
  match.throwGrenade(a, true); advance(match,2.2); assert.equal(match.smokes.length,1);
  assert.equal(match.smokeBlocks({x:0,z:0},{x:0,z:20}),true); advance(match,17); assert.equal(match.smokes.length,0);
});
test('airdrop must land before interaction, opens once and contains rare loot', () => {
  const { match, a } = fixture(); match.time = 75; match.updateWorldEvents(.1); assert.equal(match.drops.length,1);
  const drop = match.drops[0]; a.x = drop.x; a.z = drop.z; assert.equal(match.openDrop(a),false);
  match.updateWorldEvents(12); assert.equal(match.openDrop(a),true); assert.equal(match.openDrop(a),false); assert.ok(match.loot.some(l=>l.type==='sniper'));
});
test('distant enemies are not replicated but teammates and counts remain visible', () => {
  const { match, a, b, enemy } = fixture(); enemy.x=150; enemy.z=0; b.x=-150;
  const view=match.snapshot(a.id); assert.ok(!view.players.some(p=>p.id===enemy.id)); assert.ok(view.players.some(p=>p.id===b.id)); assert.equal(view.totalPlayers,5);
});
test('team spawns stay together and solo mode assigns separate teams', () => {
  const match=new Match({seed:88}); for(let i=0;i<4;i++)match.addPlayer(`p${i}`,`P${i}`,{team:0}); match.start();
  const squad=match.players.filter(p=>p.team===0); assert.ok(squad.every(p=>Math.hypot(p.x-squad[0].x,p.z-squad[0].z)<12));
  const solo=new Match({mode:'solo',maxPlayers:8}); solo.addPlayer('a','A'); solo.addPlayer('b','B'); solo.start(); assert.equal(solo.livingTeams().length,8);
});
