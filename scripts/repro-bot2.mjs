import { Match } from '../shared/simulation.mjs';
import { thinkBot } from '../shared/ai.mjs';
const m = new Match({ seed: 61, mode: 'squad', maxPlayers: 8, duration: 600 });
m.addPlayer('a','Alpha',{team:0}); m.start();
m.players.length = 1;
const bot = m.addPlayer('botx','BotX',{bot:true,team:3});
bot.x = 0; bot.z = 20; m.players[0].x = 0; m.players[0].z = 0;
bot.difficulty = 'veteran';
thinkBot(m, bot, 0.033);
console.log('botInput', JSON.stringify(bot.botInput));
console.log('think', JSON.stringify(bot.think));
// manually check pickEnemy logic
const b = bot, list = m.players;
let best=null, bestD=55;
for(const p of list){ if(!p.alive||p.team===b.team) continue; const d=Math.hypot(b.x-p.x,b.z-p.z); console.log('cand',p.id,p.team,d.toFixed(1)); if(d>=bestD)continue; bestD=d;best=p; }
console.log('best',best?.id,'clearLine',best?m.world.clearLine(b,best):null);
