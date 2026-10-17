import { GameScene } from './scene.js';
import { Match, emptyInput, TICK_RATE, WEAPONS } from '../shared/simulation.mjs';
import { MAP, WORLD_RADIUS } from '../shared/map.mjs';
import { PROTOCOL_VERSION, REVIVE_TIME, BLEEDOUT_TIME, MAX_SQUADS } from '../shared/rules.mjs';
import { GameAudio } from './audio.js';
import { createElement, Settings, Maximize, Menu, Crosshair, HeartPulse, RotateCw, ArrowLeftRight, X } from 'lucide';

const $ = id => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const nativeApp = location.hostname === 'appassets.androidplatform.net';
const defaultServer = nativeApp ? '' : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
const audio = new GameAudio();
const app = {
  mode: 'menu', offline: false, paused: false, state: null, selfId: null, code: null, token: null,
  socket: null, generation: 0, connectTimer: null, retryTimer: null, reconnectSince: 0,
  reconnecting: false, reconnectAttempt: 0, server: '', isHost: false, sequence: 0,
  match: null, accumulator: 0, snapshotTimer: 0, lastSent: 0, eventId: 0,
  deathShown: false, endShown: false, hp: 100, ping: null, pingAt: 0, readyFrames: 0, readySent: false,
  keys: new Set(), heldActions: new Set(), pulses: new Map(), pointer: { x: innerWidth / 2, y: innerHeight / 2, down: false, moved: false },
  move: { x: 0, y: 0, id: null }, aim: { x: 0, y: 0, id: null }, input: emptyInput(),
  settings: { sound: true, quality: 'balanced' }, scene: null, frameAt: 0, fps: 0, suspended: false,
};
let toastTimer, flashTimer;

const playing = () => app.mode === 'playing';
const player = () => app.state?.players.find(p => p.id === app.selfId);
function show(id) { if (!$(id).open) $(id).showModal(); }
function hide(id) { if ($(id).open) $(id).close(); }
function hidden(id, value) { $(id).classList.toggle('hidden', value); }
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function toast(message, ms = 2400) {
  $('toast').textContent = message; $('toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), ms);
}
function storeSettings() {
  try {
    localStorage.setItem('mist-isle-settings', JSON.stringify({ ...app.settings, server: $('server-address').value, name: $('nickname').value }));
  } catch { /* Play remains available when storage is disabled. */ }
}
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('mist-isle-settings') || '{}');
    app.settings.sound = saved.sound !== false;
    if (['low', 'balanced', 'high'].includes(saved.quality)) app.settings.quality = saved.quality;
    $('server-address').value = typeof saved.server === 'string' ? saved.server : defaultServer;
    if (typeof saved.name === 'string') $('nickname').value = saved.name.slice(0, 14);
  } catch { $('server-address').value = defaultServer; }
  $('sound-toggle').checked = app.settings.sound; $('quality').value = app.settings.quality;
  audio.enabled = app.settings.sound; app.scene.setQuality(app.settings.quality);
}
function name() {
  const cleaned = $('nickname').value.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || '旅人';
  $('nickname').value = cleaned; return cleaned;
}
function serverUrl() {
  let value = $('server-address').value.trim();
  if (!value) throw new Error(nativeApp ? '填写电脑局域网 IP，例如 ws://192.168.1.8:8787' : '填写服务器地址');
  value = value.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  if (!/^wss?:\/\//i.test(value)) value = `ws://${value}`;
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('地址格式应为 ws://主机:端口 或 wss://域名');
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  url.pathname = url.pathname.replace(/\/$/, '');
  if (!nativeApp && location.protocol === 'https:' && url.protocol === 'ws:') throw new Error('此 HTTPS 网页请连接 wss:// 服务器，局域网调试请用 HTTP 网页或安卓应用');
  return url.href;
}
function setBusy(value) {
  for (const id of ['create-room', 'join-room', 'quick-match']) $(id).disabled = value;
}
function clearInput() {
  app.keys.clear(); app.heldActions.clear(); app.pulses.clear(); app.pointer.down = false;
  app.move = { x: 0, y: 0, id: null }; app.aim = { x: 0, y: 0, id: null }; app.input = emptyInput();
  for (const id of ['move-stick', 'aim-stick']) $(id).querySelector('span').style.transform = '';
}
function closeSocket() {
  app.generation++; clearTimeout(app.connectTimer); clearTimeout(app.retryTimer);
  const socket = app.socket; app.socket = null;
  if (socket) { socket.onclose = null; socket.close(); }
}
function send(message) {
  if (app.socket?.readyState === WebSocket.OPEN && app.socket.bufferedAmount < 32768) {
    app.socket.send(JSON.stringify(message)); return true;
  }
  return false;
}
function home() {
  send({ type: 'leave' }); closeSocket();
  app.mode = 'menu'; app.match = null; app.state = null; app.selfId = null; app.code = null; app.token = null;
  app.isHost = false; app.reconnecting = false; app.paused = false; app.accumulator = 0;
  clearInput(); setBusy(false);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  hidden('reconnect', true); hidden('hud', true); hidden('menu', false); hidden('phase-banner', true);
  $('killfeed').replaceChildren(); document.body.classList.remove('in-match'); app.scene.showLobby();
}
function beginState() {
  app.mode = 'playing'; app.sequence = 0; app.lastSent = 0; app.eventId = 0;
  app.deathShown = false; app.endShown = false; app.hp = 100; app.snapshotTimer = 0;
  app.readyFrames = 0; app.readySent = false;
  clearInput(); hide('room-dialog'); hide('online-dialog');
  hidden('menu', true); hidden('hud', false); document.body.classList.add('in-match');
  $('killfeed').replaceChildren();
}
function startOffline() {
  const mode = $('game-mode').value;
  home(); app.offline = true; app.selfId = 'training-you'; app.match = new Match({ seed: Math.floor(Math.random() * 1e8), mode });
  app.match.addPlayer(app.selfId, name()); app.match.start(); beginState();
  acceptState(app.match.snapshot()); storeSettings();
  toast('训练已开始 · 左侧移动，右侧瞄准开火');
}

function connect(mode, code = '') {
  let url;
  try { url = serverUrl(); } catch (err) { $('online-error').textContent = err.message; return; }
  closeSocket(); clearInput(); app.server = url; app.offline = false; app.mode = 'connecting';
  app.selfId = null; app.token = null; app.reconnecting = false; app.reconnectAttempt = 0;
  $('online-error').textContent = ''; setBusy(true); storeSettings();
  openSocket({ type: 'join', mode, code, name: name(), team: Number($('squad-choice').value), gameMode: $('game-mode').value, protocol: PROTOCOL_VERSION }, false);
}
function openSocket(joinMessage, resume) {
  const generation = ++app.generation;
  let socket;
  try { socket = new WebSocket(app.server); } catch (err) { connectionFailed(err.message, resume); return; }
  app.socket = socket;
  app.connectTimer = setTimeout(() => { if (generation === app.generation) socket.close(); }, 6000);
  socket.onopen = () => {
    if (generation !== app.generation) return;
    socket.send(JSON.stringify(joinMessage));
  };
  socket.onmessage = event => {
    if (generation !== app.generation) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleMessage(message, resume);
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    if (generation !== app.generation) return;
    clearTimeout(app.connectTimer); app.socket = null;
    if ((playing() || app.mode === 'room') && app.state?.phase !== 'ended' && app.token) scheduleReconnect();
    else if (app.mode === 'connecting' || app.mode === 'room') connectionFailed('服务器连接中断，请检查地址、端口和网络', false);
  };
}
function connectionFailed(message, resume) {
  clearTimeout(app.connectTimer);
  if (resume) { scheduleReconnect(); return; }
  setBusy(false); app.mode = 'menu'; hide('room-dialog'); show('online-dialog'); $('online-error').textContent = message;
}
function scheduleReconnect() {
  if (!app.reconnecting) { app.reconnecting = true; app.reconnectSince = performance.now(); app.reconnectAttempt = 0; clearInput(); if(app.mode==='room')hide('room-dialog'); }
  hidden('reconnect', false);
  if (performance.now() - app.reconnectSince >= 20000) {
    $('reconnect-text').textContent = '重连等待已结束。返回准备室后可重新开局。'; return;
  }
  $('reconnect-text').textContent = `连接中断，正在重试（${++app.reconnectAttempt}）。角色暂留原地。`;
  clearTimeout(app.retryTimer);
  app.retryTimer = setTimeout(() => openSocket({ type: 'join', mode: 'resume', code: app.code, token: app.token, protocol: PROTOCOL_VERSION }, true), Math.min(2500, app.reconnectAttempt * 650));
}
function handleMessage(message, resume) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'hello') {
    if (message.protocol !== PROTOCOL_VERSION) { closeSocket(); connectionFailed('客户端与服务器版本不一致', false); }
    return;
  }
  if (message.type === 'error') {
    if (resume) { closeSocket(); app.reconnecting = true; hidden('reconnect', false); $('reconnect-text').textContent = message.message; }
    else if (app.mode === 'connecting') { closeSocket(); connectionFailed(message.message, false); }
    else toast(message.message);
    return;
  }
  if (message.type === 'joined') {
    clearTimeout(app.connectTimer); setBusy(false); app.selfId = message.id; app.token = message.token; app.code = message.code; app.isHost = message.host === true; app.sequence = 0;
    app.reconnecting = false; hidden('reconnect', true);
    if (!resume) { app.mode = 'room'; hide('online-dialog'); show('room-dialog'); }
    return;
  }
  if (message.type === 'lobby') {
    app.mode = 'room'; show('room-dialog');
    updateLobby(message); return;
  }
  if (message.type === 'state') {
    if (!playing()) beginState();
    acceptState(message.state); return;
  }
  if (message.type === 'pong') { app.ping = Math.max(0, Math.round(performance.now() - message.sent)); return; }
  if (message.type === 'expired' || message.type === 'left') { home(); toast(message.type === 'expired' ? '房间已结束，重新创建即可出击' : '已退出房间'); }
}
function updateLobby(lobby) {
  app.code = lobby.code; app.isHost = lobby.host === app.selfId;
  $('current-code').textContent = lobby.code;
  $('start-room').disabled = !app.isHost;
  $('start-room').textContent = app.isHost ? '全员出击 ↗' : '等待房主开始';
  const own = lobby.players.find(p => p.id === app.selfId);
  $('room-hint').textContent = lobby.public ? `匹配倒计时 ${lobby.startsIn}s · 本局 ${lobby.players.length}/${lobby.max} 人` : `${lobby.mode === 'solo' ? '单人生存' : `你在第 ${(own?.team || 0) + 1} 小队 · 同队最多4人`} · 本局 ${lobby.players.length}/${lobby.max}`;
  const list = $('room-players'); list.replaceChildren();
  for (const p of lobby.players) {
    const row = document.createElement('div'); row.className = 'room-player';
    const dot = document.createElement('i'), label = document.createElement('b'), info = document.createElement('small');
    label.textContent = p.name; info.textContent = `${p.id === app.selfId ? '你 · ' : ''}${p.id === lobby.host ? '房主 · ' : ''}${!p.connected ? '重连中 · ' : ''}第 ${p.team + 1} 队`;
    row.append(dot, label, info); list.append(row);
  }
}

function acceptState(state) {
  if (!state?.players || !state.zone || !state.cars) return;
  if (!state.loot && state.lootPatch) {
    const loot = new Map((app.state?.loot || []).map(l => [l.id, l]));
    for (const id of state.lootPatch.remove) loot.delete(id);
    for (const item of state.lootPatch.upsert) loot.set(item.id,item);
    state.loot = [...loot.values()];
  }
  if (!state.loot) return;
  app.state = state; app.scene.setState(state, app.selfId);
  updateHud(state);
}
function updateHud(state) {
  const self = player(); if (!self) return;
  $('player-name').textContent = self.name;
  $('health-value').textContent = self.downed ? `${Math.ceil(self.bleedout)}s` : Math.ceil(self.hp); $('health-bar').style.width = `${self.downed ? self.bleedout / BLEEDOUT_TIME * 100 : self.hp}%`;
  $('armor-bar').style.width = `${self.armor / 65 * 100}%`;
  $('alive-count').textContent = state.teamSummary.filter(t => t.alive > 0).length;
  $('alive-label').textContent = state.mode === 'solo' ? '存活人数' : '存活小队';
  $('kill-count').textContent = self.kills; $('weapon-name').textContent = WEAPONS[self.weapon]?.name || '';
  $('ammo').textContent = self.ammo; $('reserve').textContent = self.reserve; $('med-count').textContent = self.meds;
  $('action-progress').textContent = self.reviveTarget ? `救援 ${Math.round((state.players.find(p => p.id === self.reviveTarget)?.reviveProgress || 0) / REVIVE_TIME * 100)}%` : self.reloadTime > 0 ? `换弹 ${self.reloadTime.toFixed(1)}s` : self.healTime > 0 ? `治疗 ${self.healTime.toFixed(1)}s` : '';
  $('second-weapon').textContent = WEAPONS[self.loadout?.find((_, i) => i !== self.slot)?.type]?.name || '空枪位';
  $('grenade-count').textContent = self.grenades; $('smoke-count').textContent = self.smokes;
  const outside = Math.hypot(self.x - state.zone.x, self.z - state.zone.z) > state.zone.radius;
  $('zone-status').textContent = outside ? '⚠ 信号风暴 · 持续失血' : state.time < 28 ? `风暴倒计时 ${Math.ceil(28 - state.time)}s` : `安全区 ${Math.ceil(state.zone.radius)}m`;
  $('zone-status').classList.toggle('danger', outside);
  const vehicle = state.cars.find(c => c.id === self.car);
  $('player-state').textContent = !self.alive ? '已淘汰 · 正在观战' : self.downed ? `倒地 · 等待救援 ${Math.ceil(self.bleedout)}s` : vehicle ? vehicle.driver === self.id ? `驾驶中 · ${vehicle.seats.filter(Boolean).length}/4 座` : '乘车中 · 可以射击' : outside ? '立即返回安全区' : '保持移动，注意安全区';
  $('health-panel').classList.toggle('downed', self.downed);
  $('net-status').textContent = `${app.offline ? '本地' : app.code} · ${state.aliveCount}/${state.totalPlayers} · ${app.offline ? '训练' : `${app.ping ?? '--'}ms`}`;
  updateSquadHud(state, self);
  const car = state.cars.find(c => c.hp > 0 && c.seats.includes(null) && Math.hypot(c.x - self.x, c.z - self.z) < 3.8);
  const gun = state.loot.find(l => WEAPONS[l.type] && l.type !== self.weapon && Math.hypot(l.x - self.x, l.z - self.z) < 1.7);
  const teammate = state.players.filter(p => p.alive && p.downed && p.team === self.team && p.id !== self.id && Math.hypot(p.x - self.x, p.z - self.z) < 2.8).sort((a, b) => Math.hypot(a.x - self.x, a.z - self.z) - Math.hypot(b.x - self.x, b.z - self.z))[0];
  $('interact-label').textContent = self.downed ? '倒地' : teammate ? '救援' : self.car ? '下车' : car ? '上车' : gun ? '换枪' : '交互';
  const drop = state.drops?.find(d => !d.opened && !d.landsIn && Math.hypot(d.x - self.x, d.z - self.z) < 3);
  $('context-hint').textContent = !self.alive ? '' : self.downed ? `倒地中 · 还剩 ${Math.ceil(self.bleedout)} 秒` : teammate ? `${coarsePointer ? '按住救援' : '按住 E'} 救援 ${teammate.name}` : self.car ? `${coarsePointer ? '点击交互' : 'E'} 下车` : drop ? '交互 · 打开空投补给' : car ? '交互 · 乘坐四座越野车' : gun ? `交互 · 更换 ${WEAPONS[gun.type].name}` : '';
  if (state.phase === 'deploying' || state.phase === 'loading') {
    hidden('phase-banner', false); $('phase-banner').replaceChildren();
    const title = document.createElement('span'), subtitle = document.createElement('small');
    title.textContent = state.phase === 'loading' ? '战场准备中' : '正在空降'; subtitle.textContent = state.phase === 'loading' ? `已就绪 ${state.loading?.ready || 0}/${state.loading?.total || 0} · 等待其他队员` : '落地搜装 · 留意信号风暴'; $('phase-banner').append(title, subtitle);
  } else hidden('phase-banner', true);
  for (const event of state.events) {
    if (event.id <= app.eventId) continue;
    app.eventId = Math.max(app.eventId, event.id);
    if (event.type === 'kill' || event.type === 'down' || event.type === 'revive') addKillfeed(event);
    if (event.type === 'shot' && event.player === app.selfId) audio.play('shot', self.weapon);
    if (event.type === 'heal' && event.player === app.selfId) audio.play('heal');
    if (event.type === 'airdrop') toast('补给空投正在降落 · 地图已标出落点', 3000);
    if (event.type === 'pickup' && event.player === app.selfId) {
      audio.play('pickup');
      toast(WEAPONS[event.item] ? `拾取 ${WEAPONS[event.item].name}` : ({ ammo: '拾取弹药', med: '医疗包 +1', armor: '护甲已装备', grenade: '手雷 +1', smoke: '烟雾弹 +1' })[event.item] || '物资已拾取', 1300);
    }
  }
  if (app.hp - self.hp > .8) { $('damage-vignette').style.opacity = '.9'; clearTimeout(flashTimer); flashTimer = setTimeout(() => $('damage-vignette').style.opacity = '0', 160); }
  app.hp = self.hp;
  drawMinimap(state, self);
  if (!self.alive && !app.deathShown) { app.deathShown = true; clearInput(); showResult(false); }
  if (state.phase === 'ended' && !app.endShown) { app.endShown = true; audio.play('end'); showResult(true); }
}
function addKillfeed(event) {
  const symbol = event.type === 'down' ? '↓' : event.type === 'revive' ? '✚' : '✕';
  const row = document.createElement('div'); row.textContent = event.type === 'revive' ? `${event.name} 已被队友救起` : `${event.attackerName || '风暴'}  ${symbol}  ${event.name}`;
  $('killfeed').prepend(row); while ($('killfeed').children.length > 4) $('killfeed').lastChild.remove();
  setTimeout(() => row.remove(), 5500);
}
function updateSquadHud(state, self) {
  const members = state.players.filter(p => p.team === self.team).sort((a, b) => a.id === self.id ? -1 : b.id === self.id ? 1 : a.name.localeCompare(b.name));
  const signature = members.map(p => [p.id, p.alive, p.downed, Math.ceil(p.hp), Math.ceil(p.bleedout), Math.round(p.reviveProgress * 10), p.connected, p.car].join('|')).join(';');
  if ($('squad-members').dataset.signature === signature) return;
  $('squad-members').dataset.signature = signature;
  $('squad-name').textContent = `${self.teamName || '曙光'}小队`;
  $('squad-alive').textContent = `${members.filter(p => p.alive).length} / ${members.length}`;
  const root = $('squad-members'); root.replaceChildren();
  for (const member of members) {
    const row = document.createElement('div'); row.className = `squad-member${member.id === self.id ? ' self' : ''}${member.downed ? ' downed' : ''}${!member.alive ? ' eliminated' : ''}`;
    const dot = document.createElement('i'), label = document.createElement('b'), state = document.createElement('small');
    label.textContent = member.name; state.textContent = !member.alive ? '淘汰' : member.downed ? `${Math.ceil(member.bleedout)}s` : member.car ? '载具' : !member.connected ? '重连' : `${member.bot ? 'AI' : member.id === self.id ? '你' : '队友'} ${Math.ceil(member.hp)}`;
    row.append(dot, label, state);
    if (member.downed && member.reviveProgress > 0) { const track = document.createElement('div'); track.className = 'revive-bar'; const fill = document.createElement('i'); fill.style.width = `${member.reviveProgress / REVIVE_TIME * 100}%`; track.append(fill); row.append(track); }
    root.append(row);
  }
}
function drawMinimap(state, self) {
  const canvas = $('minimap'), ctx = canvas.getContext('2d'), scale = canvas.width / (WORLD_RADIUS * 2 + 12), half = canvas.width / 2;
  const point = (x, z) => [half + x * scale, half + z * scale];
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#416e69'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#738562'; ctx.beginPath(); ctx.arc(half, half, WORLD_RADIUS * scale, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#566653'; ctx.fillRect(half - 3, 6, 6, canvas.height - 12); ctx.fillRect(6, half - 3, canvas.width - 12, 6);
  ctx.fillStyle = '#c8bc95'; for (const b of MAP.buildings) { const [x, y] = point(b.x, b.z); ctx.fillRect(x - b.w * scale / 2, y - b.d * scale / 2, b.w * scale, b.d * scale); }
  const [x, y] = point(state.zone.x, state.zone.z);
  ctx.strokeStyle = '#a0ebd7'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, state.zone.radius * scale, 0, Math.PI * 2); ctx.stroke();
  for (const car of state.cars) if (car.hp > 0) { const [cx, cy] = point(car.x, car.z); ctx.fillStyle = '#e4b667'; ctx.fillRect(cx - 1, cy - 1, 3, 3); }
  for (const marker of [...(state.pings || []), ...(state.drops || []).filter(d => !d.opened)]) { const [mx, my] = point(marker.x, marker.z); ctx.strokeStyle = '#ffd574'; ctx.strokeRect(mx - 3, my - 3, 6, 6); }
  for (const teammate of state.players) if (teammate.alive && teammate.team === self.team && teammate.id !== self.id) { const [tx, ty] = point(teammate.x, teammate.z); ctx.fillStyle = teammate.downed ? '#f28f6f' : '#a6e0bc'; ctx.beginPath(); ctx.arc(tx, ty, 2.7, 0, Math.PI * 2); ctx.fill(); }
  // Enemy positions are deliberately not drawn on the tactical map.
  const [px, py] = point(self.x, self.z); ctx.save(); ctx.translate(px, py); ctx.rotate(-self.angle + Math.PI);
  ctx.fillStyle = '#ffe09b'; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(-3.5, 4); ctx.lineTo(3.5, 4); ctx.closePath(); ctx.fill(); ctx.restore();
}
function showResult(ended) {
  const self = player(); if (!self) return;
  hide('pause-dialog');
  const win = ended && app.state.winnerTeam === self.team;
  $('result-eyebrow').textContent = win ? 'MISSION COMPLETE' : ended ? 'MATCH COMPLETE' : 'SIGNAL LOST';
  $('rank-display').textContent = self.rank ? `#${self.rank}` : win ? '#1' : '观战';
  $('result-title').textContent = win ? '雾岛幸存者' : '下一次，活到最后。';
  $('result-subtitle').textContent = ended ? app.state.winnerTeam === null ? '本局无人存活。' : `${app.state.teamSummary?.find(t => t.team === app.state.winnerTeam)?.name || '获胜'} ${app.state.mode === 'solo' ? '选手' : '小队'}成为最后的幸存者。` : self.downed ? '你正在倒地状态，队友仍可在倒计时内救援。' : '你已淘汰，可以继续观看这一局。';
  $('result-kills').textContent = self.kills; $('result-time').textContent = formatTime(self.survived ?? app.state.time);
  $('result-mode').textContent = app.offline ? '训练' : '联机'; hidden('spectate', ended);
  show('result-dialog');
}

function updateInput(now) {
  if (!playing() || app.reconnecting || app.suspended || document.hidden || document.querySelector('dialog[open]') || !player()?.alive || app.state.phase !== 'playing') {
    app.input = { ...emptyInput(), aim: app.input.aim }; return;
  }
  let mx = (app.keys.has('KeyD') ? 1 : 0) - (app.keys.has('KeyA') ? 1 : 0);
  let mz = (app.keys.has('KeyS') ? 1 : 0) - (app.keys.has('KeyW') ? 1 : 0);
  if (app.move.id !== null) { mx = app.move.x; mz = app.move.y; }
  const length = Math.hypot(mx, mz); if (length > 1) { mx /= length; mz /= length; }
  if (app.aim.id !== null && Math.hypot(app.aim.x, app.aim.y) > .12) app.input.aim = Math.atan2(app.aim.x, app.aim.y * 1.24);
  else if (!coarsePointer && app.pointer.moved) app.input.aim = app.scene.aimAt(app.pointer.x, app.pointer.y, player());
  app.input.mx = mx; app.input.mz = mz;
  app.input.fire = !player().downed && (app.pointer.down || (app.aim.id !== null && Math.hypot(app.aim.x, app.aim.y) > .22));
  for (const [key, expiry] of app.pulses) if (expiry < now) app.pulses.delete(key);
  app.input.reload = app.keys.has('KeyR') || app.pulses.has('reload');
  app.input.heal = !player().downed && (app.keys.has('KeyH') || app.pulses.has('heal'));
  app.input.interact = app.keys.has('KeyE') || app.pulses.has('interact') || app.heldActions.has('interact');
  for (const action of ['swap', 'grenade', 'smoke', 'ping']) app.input[action] = app.pulses.has(action);
}
function bindStick(id, key) {
  const root = $(id);
  const update = e => {
    const stick = app[key]; if (stick.id !== e.pointerId) return;
    const rect = root.getBoundingClientRect(), radius = rect.width * .34;
    let x = e.clientX - rect.left - rect.width / 2, y = e.clientY - rect.top - rect.height / 2;
    const length = Math.hypot(x, y); if (length > radius) { x *= radius / length; y *= radius / length; }
    stick.x = x / radius; stick.y = y / radius;
    root.querySelector('span').style.transform = `translate(${x}px, ${y}px)`;
  };
  root.addEventListener('pointerdown', e => { if (app[key].id !== null) return; e.preventDefault(); audio.unlock(); app[key].id = e.pointerId; root.setPointerCapture(e.pointerId); update(e); });
  root.addEventListener('pointermove', update);
  const release = e => { if (app[key].id !== e.pointerId) return; app[key] = { id: null, x: 0, y: 0 }; root.querySelector('span').style.transform = ''; };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(event, release);
}
function gameMenu() {
  if (!playing()) return;
  clearInput(); app.paused = app.offline;
  $('pause-note').textContent = app.offline ? '训练已暂停，继续后恢复战斗。' : '联机对战继续进行，菜单打开时你的角色停留原地。';
  show('pause-dialog');
}
function bindActions() {
  for (const [id, icon] of [['settings-open', Settings], ['fullscreen', Maximize], ['game-menu', Menu]]) {
    $(id).replaceChildren(createElement(icon)); $(id).title = $(id).getAttribute('aria-label');
  }
  for (const [id, icon] of [['heal-action', HeartPulse], ['reload-action', RotateCw], ['interact-action', ArrowLeftRight]]) {
    const label = $(id).querySelector('small'); $(id).replaceChildren(createElement(icon), label); $(id).title = $(id).getAttribute('aria-label');
  }
  $('aim-stick').querySelector('span').replaceChildren(createElement(Crosshair));
  document.querySelectorAll('.modal-close').forEach(button => { button.replaceChildren(createElement(X)); button.title = '关闭'; });
  document.addEventListener('pointerdown', () => audio.unlock(), { passive: true });
  document.addEventListener('contextmenu', e => { if (playing()) e.preventDefault(); });
  addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Escape' && playing() && !document.querySelector('dialog[open]')) { e.preventDefault(); gameMenu(); return; }
    app.keys.add(e.code);
    const action = { KeyR: 'reload', KeyH: 'heal', KeyE: 'interact', KeyQ: 'swap', KeyG: 'grenade', KeyF: 'smoke', KeyP: 'ping' }[e.code];
    if (action && !e.repeat) app.pulses.set(action, performance.now() + 220);
    if (playing() && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyH', 'KeyE', 'Space'].includes(e.code)) e.preventDefault();
  });
  addEventListener('keyup', e => app.keys.delete(e.code)); addEventListener('blur', clearInput);
  document.addEventListener('visibilitychange', () => { clearInput(); if (document.hidden) audio.suspend(); });
  $('world').addEventListener('pointermove', e => { if (e.pointerType === 'touch') return; app.pointer.x = e.clientX; app.pointer.y = e.clientY; app.pointer.moved = true; });
  $('world').addEventListener('pointerdown', e => {
    if (!playing() || e.pointerType === 'touch' || e.button !== 0) return;
    app.pointer.down = true; app.pointer.x = e.clientX; app.pointer.y = e.clientY; app.pointer.moved = true;
    $('world').setPointerCapture(e.pointerId);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('world').addEventListener(event, () => { app.pointer.down = false; });
  bindStick('move-stick', 'move'); bindStick('aim-stick', 'aim');
  $('online-open').onclick = () => { $('online-error').textContent = ''; show('online-dialog'); };
  $('train').onclick = startOffline;
  $('nav-play').onclick = () => { hide('help-dialog'); };
  document.querySelector('.brand').onclick = e => { e.preventDefault(); if (playing()) gameMenu(); };
  $('nav-help').onclick = () => show('help-dialog'); $('settings-open').onclick = () => show('settings-dialog');
  $('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast('安卓应用已使用全屏显示'); } };
  $('create-room').onclick = () => connect('create'); $('quick-match').onclick = () => connect('quick');
  $('join-room').onclick = () => {
    const code = $('room-code').value.trim().toUpperCase();
    if (!/^[A-Z2-9]{5}$/.test(code)) { $('online-error').textContent = '输入 5 位房间邀请码'; return; }
    connect('join', code);
  };
  $('start-room').onclick = () => { send({ type: 'start' }); };
  for (const id of ['leave-room', 'exit-match', 'return-home', 'cancel-reconnect']) $(id).onclick = home;
  $('spectate').onclick = () => hide('result-dialog'); $('game-menu').onclick = gameMenu;
  $('pause-dialog').addEventListener('close', () => { app.paused = false; clearInput(); });
  $('room-dialog').addEventListener('cancel', e => { e.preventDefault(); home(); });
  $('online-dialog').addEventListener('close', () => { if (app.mode === 'connecting') { closeSocket(); app.mode = 'menu'; setBusy(false); } });
  $('result-dialog').addEventListener('cancel', e => { if (app.state?.phase === 'ended') { e.preventDefault(); home(); } });
  document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => hide(button.dataset.close); });
  for (const [id, action] of [['heal-action', 'heal'], ['reload-action', 'reload'], ['interact-action', 'interact'], ['swap-action','swap'], ['grenade-action','grenade'], ['smoke-action','smoke'], ['ping-action','ping']]) {
    $(id).onclick = () => app.pulses.set(action, performance.now() + 170);
  }
  $('interact-action').addEventListener('pointerdown', e => { app.heldActions.add('interact'); $('interact-action').setPointerCapture(e.pointerId); });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('interact-action').addEventListener(event, () => app.heldActions.delete('interact'));
  for (let i = 0; i < MAX_SQUADS; i++) { const option = document.createElement('option'); option.value = String(i); option.textContent = `第 ${i + 1} 小队`; $('squad-choice').append(option); }
  $('game-mode').onchange = () => { $('squad-choice').disabled = $('game-mode').value === 'solo'; };
  $('room-code').oninput = e => { e.target.value = e.target.value.replace(/[^a-z2-9]/gi, '').toUpperCase(); };
  $('sound-toggle').onchange = e => { app.settings.sound = e.target.checked; audio.enabled = app.settings.sound; storeSettings(); };
  $('quality').onchange = e => { app.settings.quality = e.target.value; app.scene.setQuality(e.target.value); storeSettings(); };
  for (const id of ['server-address', 'nickname']) $(id).addEventListener('change', storeSettings);
  $('world').addEventListener('webglcontextlost', e => { e.preventDefault(); home(); toast('图形上下文丢失，正在恢复', 4500); });
  window.mistIsleBack = () => {
    const dialog = document.querySelector('dialog[open]');
    if (dialog) { if (dialog.id === 'room-dialog') home(); else dialog.close(); }
    else if (playing()) gameMenu();
    else { show('settings-dialog'); toast('使用系统手势可返回桌面'); }
  };
  window.mistIsleVisibility = visible => {
    app.suspended = !visible; clearInput();
    if (!visible) { audio.suspend(); if (playing() && !app.offline) send({type:'input',input:{...emptyInput(),seq:++app.sequence}}); }
    else app.frameAt = performance.now();
  };
}
function frame(now) {
  const dt = Math.min(.15, (now - (app.frameAt || now)) / 1000); app.frameAt = now;
  app.fps = app.fps ? app.fps * .95 + (dt ? 1 / dt : 60) * .05 : 60;
  updateInput(now);
  if (playing() && app.offline && !app.paused && !app.suspended && !document.hidden && app.state.phase !== 'ended') {
    app.accumulator += dt;
    while (app.accumulator >= 1 / TICK_RATE) {
      app.match.input(app.selfId, { ...app.input, seq: ++app.sequence });
      app.match.update(1 / TICK_RATE); app.accumulator -= 1 / TICK_RATE;
    }
    app.snapshotTimer += dt;
    if (app.snapshotTimer >= .05) { app.snapshotTimer = 0; acceptState(app.match.snapshot()); }
  }
  if (playing() && !app.offline && !app.reconnecting) {
    if (now - app.lastSent >= 40) {
      const input = { ...app.input, seq: ++app.sequence };
      if (send({ type: 'input', input })) app.scene.predictInput(input, (now - app.lastSent) / 1000);
      app.lastSent = now;
    }
    if (now - app.pingAt >= 2000) { app.pingAt = now; send({ type: 'ping', sent: now }); }
  }
  if (!document.hidden && !app.suspended) {
    app.scene.render(Math.min(dt, .05), now / 1000);
    if (!app.offline && app.state?.phase === 'loading' && !app.readySent && ++app.readyFrames >= 3) app.readySent = send({type:'ready'});
  }
  requestAnimationFrame(frame);
}
function init() {
  app.scene = new GameScene($('world')); loadSettings(); bindActions();
  hidden('boot', true); requestAnimationFrame(frame);
  Object.defineProperty(window, 'mistIsle', { value: Object.freeze({
    getState: () => app.state ? structuredClone(app.state) : null,
    getStatus: () => ({ mode: app.mode, offline: app.offline, selfId: app.selfId, code: app.code, paused: app.paused, reconnecting: app.reconnecting, fps: Math.round(app.fps), renderCalls: app.scene.renderer.info.render.calls, geometries: app.scene.renderer.info.memory.geometries, textures: app.scene.renderer.info.memory.textures }),
  }) });
}
try { init(); } catch (err) {
  console.error(err); $('boot').replaceChildren();
  const title = document.createElement('strong'), message = document.createElement('p');
  title.textContent = '图形引擎启动失败'; message.textContent = '需要支持 WebGL 2 的浏览器或 Android System WebView。更新后重新打开。';
  $('boot').append(title, message);
}
