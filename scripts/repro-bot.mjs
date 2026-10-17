import { Match } from '../shared/simulation.mjs';
const m = new Match({ seed: 61, mode: 'squad', maxPlayers: 8, duration: 600 });
m.addPlayer('a','Alpha',{team:0}); m.addPlayer('b','Bravo',{team:0}); m.start();
m.players.length = 2;
m.players[0].x = 0; m.players[0].z = 0;
const bot = m.addPlayer('botx','BotX',{bot:true,team:3});
bot.x = 0; bot.z = 20;
for (let i = 0; i < 20; i++) m.addPlayer(`bm${i}`,`BM${i}`,{bot:true,team:4+(i%6)});
m.zone.nextIn = 9999; m.dropsLeft = 0;
const targets = m.players.filter(p=>p.bot).slice(0,4).map(p=>({id:p.id}));
for (let i = 0; i < 120; i++) m.update(1/30);
for (const t of targets) {
  const p = m.players.find(x=>x.id===t.id);
  console.log(t.id, 'alive', p.alive, 'pos', p.x.toFixed(1), p.z.toFixed(1), 'input.fire', p.input.fire, 'thinkT', p.think?.t?.toFixed(2), 'botInput', p.botInput ? 'pending' : 'none', 'fireCd', p.fireCd?.toFixed(2), 'ammo', p.loadout[p.slot]?.ammo, 'targetId', p.think?.target);
}
console.log('events', m.events.length, [...new Set(m.events.map(e=>e.type))].join(','));
