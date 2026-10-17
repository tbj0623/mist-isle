// 雾岛突围 / MIST ISLE — Bot 兜底 AI（owner: aiteam · shared/ai.mjs）
// simcore 交付的最小可用版本：目标选择 → 接近/绕行 → 开火 → 换弹/用药/救援。
// 正式 AI 由 AI 组重写本文件，接口保持 thinkBot(match, bot, dt) 不变。
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = (a) => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
};

export function thinkBot(match, bot, dt) {
  if (!bot || !bot.alive || bot.downed) return;
  const th = bot.think || (bot.think = { t: 0, next: 0, target: null, strafe: 1, spot: null });
  th.t += dt;
  if (th.t >= th.next) { th.next = th.t + 0.45; th.target = pickEnemy(match, bot); }
  const enemy = th.target ? match.players.find((p) => p.id === th.target) : null;
  const out = {
    mx: 0, mz: 0, aim: bot.angle, fire: false, reload: false, interact: false,
    heal: false, sprint: false, crouch: false, dodge: false, revive: false,
    throwable: null, useItem: null, slot: -1, seq: 0,
  };
  const mate = downMate(match, bot);
  if (mate && (!enemy || dist(bot, enemy) > 30)) return followMate(bot, mate, out);
  if (bot.hp < 55 && bot.bandages + bot.meds > 0 && (!enemy || dist(bot, enemy) > 26)) {
    out.useItem = bot.meds > 0 ? 'medkit' : 'bandage';
  }
  if (!enemy) return roam(match, bot, th, out);
  const d = dist(bot, enemy);
  const aimAt = Math.atan2(enemy.x - bot.x, enemy.z - bot.z);
  const err = 0.05 * (bot.difficulty === 'elite' ? 0.5 : bot.difficulty === 'recruit' ? 1.8 : 1);
  out.aim = wrap(aimAt + Math.sin(th.t * 2.3) * err);
  const slot = bot.loadout[bot.slot];
  const ready = slot && slot.ammo > 0 && bot.reloadTime <= 0;
  out.fire = ready && d < 46 && Math.abs(wrap(aimAt - bot.angle)) < 0.34;
  if (!ready && bot.reloadTime <= 0) out.reload = true;
  if (d > 30) { out.mx = Math.sin(aimAt); out.mz = Math.cos(aimAt); out.sprint = bot.stamina > 25; }
  else if (d < 7) { out.mx = -Math.sin(aimAt); out.mz = -Math.cos(aimAt); }
  else {
    if (Math.abs(wrap(th.t - th.next)) > 0.4) th.strafe = Math.sin(th.t * 0.9) > 0 ? 1 : -1;
    out.mx = Math.sin(aimAt + Math.PI / 2) * th.strafe;
    out.mz = Math.cos(aimAt + Math.PI / 2) * th.strafe;
  }
  out.crouch = d > 22 && d < 44 && slot && slot.ammo > 2;
  bot.botInput = out;
}

function followMate(bot, mate, out) {
  const d = dist(bot, mate) || 1;
  if (d < 3) out.revive = true;
  else { out.mx = (mate.x - bot.x) / d; out.mz = (mate.z - bot.z) / d; out.sprint = bot.stamina > 10; }
  bot.botInput = out;
}

function roam(match, bot, th, out) {
  if (!th.spot || dist(bot, th.spot) < 3 || th.t > th.next) {
    if (!th.spot || dist(bot, th.spot) < 3) th.spot = pickSpot(match, bot);
  }
  const s = th.spot || { x: 0, z: 0 };
  const dx = s.x - bot.x; const dz = s.z - bot.z;
  const len = Math.hypot(dx, dz) || 1;
  out.mx = dx / len; out.mz = dz / len; out.aim = Math.atan2(dx, dz);
  out.sprint = len > 8 && bot.stamina > 25;
  out.interact = len < 2.4;
  bot.botInput = out;
}

function pickEnemy(match, bot) {
  let best = null; let bestD = 55;
  const list = match.players;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p.alive || p.team === bot.team) continue;
    const d = dist(bot, p);
    if (d >= bestD) continue;
    bestD = d; best = p;
  }
  if (best && match.world && !match.world.clearLine(bot, best)) {
    if (bestD > 12) return null;
  }
  return best;
}

function downMate(match, bot) {
  const list = match.players;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p !== bot && p.team === bot.team && p.alive && p.downed) return p;
  }
  return null;
}

function pickSpot(match, bot) {
  const spots = match.world && match.world.lootSpots;
  if (!spots || !spots.length) return { x: 0, z: 0 };
  let best = spots[0]; let bestD = Infinity;
  const stride = Math.max(1, Math.floor(spots.length / 24));
  for (let i = 0; i < spots.length; i += stride) {
    const s = spots[i];
    const d = dist(bot, s);
    if (d < bestD && d > 5) { bestD = d; best = s; }
  }
  return best;
}
