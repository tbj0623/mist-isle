import { Match } from '../shared/simulation.mjs';
const tick = 1/30;
const m = new Match({ seed: 3, mode: 'squad', maxPlayers: 4, duration: 420, difficulty: 'veteran' });
m.addPlayer('a','Alpha',{team:0}); m.start();
m.players.length = 1;
m.players[0].x = 0; m.players[0].z = 0; m.players[0].angle = 0;
m.zone.nextIn = 9999; m.dropsLeft = 0;
const p = m.players[0];
// openLane
function openLane(world, len = 24) {
  const spots = (world.lootSpots || []).concat(world.spawnAnchors || []);
  for (const s of spots) {
    if (world.blocked(s.x, s.z, 1.2)) continue;
    for (let ai = 0; ai < 12; ai++) {
      const a = (ai / 12) * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      if (world.blocked(s.x + dx*len, s.z + dz*len, 1.2)) continue;
      let ok = true;
      for (let k = 1; k <= 10; k++) if (world.blocked(s.x + dx*k*len/10, s.z + dz*k*len/10, 1.0)) { ok = false; break; }
      if (ok) return { x: s.x, z: s.z, dx, dz, angle: Math.atan2(dx, dz) };
    }
  }
  return null;
}
const lane = openLane(m.world, 12);
console.log('lane', lane);
p.x = lane.x; p.z = lane.z; p.angle = lane.angle;
p.dodgeCd = 0;
m.input('a', { mx: lane.dx, mz: lane.dz, dodge: true });
m.update(tick);
console.log('state', p.state, 'dodgeTime', p.dodgeTime, 'cd', p.dodgeCd, 'fireCd', p.fireCd);
console.log('tryFire', m.tryFire(p));

