import { WebSocket } from 'ws';
const URL = 'ws://127.0.0.1:8787/ws';
const P = 3;
function client(name) {
  const ws = new WebSocket(URL);
  const q = []; const waiters = [];
  ws.on('message', d => {
    const m = JSON.parse(d);
    const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) { const [w] = waiters.splice(i,1); w.res(m); }
    else q.push(m);
  });
  const next = (pred, t=8000) => {
    const i = q.findIndex(pred); if (i>=0) return Promise.resolve(q.splice(i,1)[0]);
    return new Promise((res, rej) => { const w = { pred, res }; waiters.push(w); setTimeout(() => { const j = waiters.indexOf(w); if (j>=0) waiters.splice(j,1); rej(new Error(name+' timeout')); }, t); });
  };
  return { name, ws, next, send: m => ws.send(JSON.stringify(m)), open: () => new Promise((r,j)=>{ ws.once('open',r); ws.once('error',j); }) };
}
const type = t => m => m.type === t;
const host = client('host'); await host.open();
const peer = client('peer'); await peer.open();
await host.next(type('hello'));
await host.send({ type:'join', protocol:P, mode:'create', name:'队长', gameMode:'squad', mapId:'qinglan', difficulty:'veteran', team:0 });
const joined = await host.next(type('joined'));
console.log('host joined', joined.code, 'host=', joined.host, 'team=', joined.team);
await peer.send({ type:'join', protocol:P, mode:'join', code: joined.code, name:'队友', gameMode:'squad', mapId:'qinglan', team:0 });
const pj = await peer.next(type('joined'));
console.log('peer joined', pj.id !== joined.id, 'host=', pj.host);
const lobby = await host.next(type('lobby'));
console.log('lobby players', lobby.players.length, 'map', lobby.mapId, 'mode', lobby.gameMode);
await peer.send({ type:'start' });
const err = await peer.next(type('error'));
console.log('non-host start rejected:', err.message);
await host.send({ type:'start' });
const state = await host.next(m => m.type==='state' && m.state.phase === 'loading');
console.log('loading state, ready', state.state.loading?.ready, '/', state.state.loading?.total);
host.send({ type:'ready' }); peer.send({ type:'ready' });
const live = await host.next(m => m.type==='state' && (m.state.phase === 'deploying' || m.state.phase === 'live'), 15000);
console.log('phase after ready:', live.state.phase, 'players', live.state.counts.total);
// 走几步
for (let i=1;i<=20;i++) { host.send({ type:'input', input:{ mx:1, mz:0, seq:i } }); await new Promise(r=>setTimeout(r,40)); }
const moved = await host.next(m => m.type==='state' && m.state.me && m.state.me.alive, 8000);
console.log('me moved x=', moved.state.me.x.toFixed(2), 'z=', moved.state.me.z.toFixed(2));
const peerSees = await peer.next(m => m.type==='state' && m.state.players.some(p => p.id === joined.id), 8000);
console.log('peer sees host:', peerSees.state.players.filter(p=>p.id===joined.id).length > 0);
// 断线重连
peer.ws.close();
await new Promise(r=>setTimeout(r,300));
const re = client('re'); await re.open();
await re.next(type('hello'));
await re.send({ type:'join', protocol:P, mode:'resume', code: joined.code, token: pj.token });
const rj = await re.next(type('joined'));
console.log('resume same id:', rj.id === pj.id);
host.ws.close(); re.ws.close();
process.exit(0);
