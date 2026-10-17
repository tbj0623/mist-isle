import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Match } from '../shared/simulation.mjs';
import { MAX_PLAYERS, PROTOCOL_VERSION } from '../shared/rules.mjs';
import { createGameServer } from '../server/index.mjs';

const start=performance.now(), tickTimes=[], simulations=[];
for(const seed of [14,77,130]) {
  const match=new Match({seed}); match.addPlayer('human','Player'); match.start(); let ticks=0;
  while(match.phase!=='ended' && ticks<14000) { const t=performance.now(); match.update(1/30); tickTimes.push(performance.now()-t); ticks++; }
  assert.equal(match.phase,'ended');
  assert.ok(match.players.every(p=>p.rank>=1 && p.rank<=16));
  simulations.push({seed,ticks,gameSeconds:Math.round(match.time),winnerTeam:match.winnerTeam});
}
tickTimes.sort((a,b)=>a-b);
const simulatedMs=performance.now()-start;
const server=createGameServer({port:0,host:'127.0.0.1'}), address=await server.listen();
const connections=[], inputs=[], loop=monitorEventLoopDelay({resolution:10}); loop.enable();
let code, bytes=0, packets=0, errors=0;
try {
  for(let i=0;i<MAX_PLAYERS;i++) {
    const ws=new WebSocket(`ws://127.0.0.1:${address.port}/ws`), connection={ws,id:null,states:0,lastTime:0};
    const session=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Join timed out')),8000);
      ws.on('error',reject);
      ws.on('message',data=>{
        bytes+=data.length; packets++;
        const message=JSON.parse(data);
        if(message.type==='error') { errors++; reject(new Error(message.message)); }
        if(message.type==='joined') { clearTimeout(timer); connection.id=message.id; resolve(message); }
        if(message.type==='state') { connection.states++; connection.lastTime=message.state.time; }
        if(message.type==='state' && message.state.phase==='loading') ws.send(JSON.stringify({type:'ready'}));
      });
      ws.on('open',()=>ws.send(JSON.stringify({type:'join',mode:i===0?'create':'join',code,team:Math.floor(i/4),name:`Load-${i}`,protocol:PROTOCOL_VERSION})));
    });
    const joined=await session; code ||= joined.code; connections.push(connection);
  }
  connections[0].ws.send(JSON.stringify({type:'start'}));
  await delay(4000);
  for(const [i,c] of connections.entries()) {
    let seq=0;
    inputs.push(setInterval(()=>{ if(c.ws.readyState===WebSocket.OPEN)c.ws.send(JSON.stringify({type:'input',input:{mx:Math.sin(i),mz:Math.cos(i),aim:i,fire:true,seq:++seq}})); },50));
  }
  const begin=performance.now(), bytesAt=bytes;
  await delay(8000);
  const seconds=(performance.now()-begin)/1000;
  assert.equal(errors,0); assert.ok(connections.every(c=>c.states>35));
  const match=server.rooms.get(code).match; assert.equal(match.players.filter(p=>!p.bot).length,MAX_PLAYERS);
  const report={ testedAt:new Date().toISOString(), scope:'Local synthetic sockets, not 64 physical phones or public internet', players:MAX_PLAYERS,
    simulation:{simulatedMs:Math.round(simulatedMs),ticks:tickTimes.length,p50TickMs:tickTimes[Math.floor(tickTimes.length*.5)],p95TickMs:tickTimes[Math.floor(tickTimes.length*.95)],maxTickMs:tickTimes.at(-1),matches:simulations},
    network:{seconds,connections:connections.length,statesPerClient:connections.map(c=>c.states),errors,megabytesPerSecond:(bytes-bytesAt)/seconds/1e6,eventLoopP95Ms:loop.percentile(95)/1e6,heapMiB:process.memoryUsage().heapUsed/1024/1024,packets}};
  await mkdir('artifacts',{recursive:true}); await writeFile('artifacts/benchmark.json',JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally { loop.disable(); inputs.forEach(clearInterval); connections.forEach(c=>c.ws.terminate()); await server.close(); }
