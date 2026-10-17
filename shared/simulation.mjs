import { MAP, WORLD_RADIUS, randomGenerator, blocked, moveBody, clearLine, wallDistance } from './map.mjs';
import { TICK_RATE, SQUAD_SIZE, MAX_SQUADS, MAX_PLAYERS, MAX_HUMANS_PER_ROOM, MAX_LOOT, REVIVE_TIME, BLEEDOUT_TIME, WEAPONS } from './rules.mjs';
export { TICK_RATE, SQUAD_SIZE, MAX_SQUADS, MAX_PLAYERS, MAX_HUMANS_PER_ROOM, REVIVE_TIME, BLEEDOUT_TIME, WEAPONS } from './rules.mjs';
const BOT_NAMES = ['松鸦', '北斗', '灰狐', '纸飞机', '野渡', '杉木', '海盐', '回声', '浮游', '寒鸦', '拾荒者', '潮汐', '白鹭', '山猫', '微光', '石榴', '长风', '沙棘', '枯木', '星火'];
const TEAM_NAMES = ['曙光', '黑潮', '雾岚', '赤礁', '白沙', '远星', '山隼', '星火', '长风', '暗礁', '苍穹', '疾雨', '晨鹿', '鲸落', '沙丘', '雪松'];
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const round = x => Math.round(x * 100) / 100;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const teamName = team => TEAM_NAMES[team] || `小队 ${team + 1}`;
export const emptyInput = () => ({ mx: 0, mz: 0, aim: 0, fire: false, reload: false, heal: false, interact: false, swap: false, grenade: false, smoke: false, ping: false, seq: 0 });

export function sanitizeInput(value) {
  if (!value || typeof value !== 'object') return emptyInput();
  const n = key => typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : 0;
  let mx = clamp(n('mx'), -1, 1), mz = clamp(n('mz'), -1, 1);
  const length = Math.hypot(mx, mz);
  if (length > 1) { mx /= length; mz /= length; }
  return {
    mx, mz, aim: n('aim') % (Math.PI * 2), fire: value.fire === true,
    reload: value.reload === true, heal: value.heal === true, interact: value.interact === true,
    swap: value.swap === true, grenade: value.grenade === true, smoke: value.smoke === true, ping: value.ping === true,
    seq: clamp(Math.floor(n('seq')), 0, Number.MAX_SAFE_INTEGER),
  };
}

export class Match {
  constructor({ seed = 1, duration = 360, maxPlayers = MAX_PLAYERS, mode = 'squad' } = {}) {
    this.rng = randomGenerator(seed);
    this.duration = clamp(Number.isFinite(duration) ? duration : 360, 60, 1800);
    this.maxPlayers = clamp(Math.floor(maxPlayers), SQUAD_SIZE, MAX_PLAYERS);
    this.mode = mode === 'solo' ? 'solo' : 'squad';
    this.teamSize = this.mode === 'solo' ? 1 : SQUAD_SIZE;
    this.maxTeams = Math.ceil(this.maxPlayers / this.teamSize);
    this.clock = 0;
    this.time = 0;
    this.phase = 'waiting';
    this.players = [];
    this.loot = [];
    this.cars = [[7,9],[-8,-32],[36,7],[-38,12],[8,110],[-110,8],[-8,-118],[118,-8]].map(([x,z], n) => ({ id: `c${n + 1}`, x, z, angle: 0, hp: 240, driver: null, seats: [null, null, null, null] }));
    this.zone = { x: 0, z: 0, radius: WORLD_RADIUS, next: 60, damage: 5 };
    this.events = [];
    this.eventId = 0;
    this.lootId = 0;
    this.winner = null;
    this.winnerTeam = null;
    this.resultReason = null;
    this.teamRanks = new Map();
    this.grenades = []; this.smokes = []; this.pings = []; this.drops = [];
    this.nextDrop = 75; this.entityId = 0;
    this.generateLoot();
  }

  generateLoot() {
    for (const [i, b] of MAP.buildings.entries()) {
      this.addLoot(['rifle', 'smg', 'marksman', 'shotgun', 'sniper', 'lmg'][i % 6], b.x - 2, b.z);
      this.addLoot('ammo', b.x + 2, b.z);
      this.addLoot(i % 2 ? 'med' : 'armor', b.x, b.z + 2);
    }
    for (let i = 0; i < 165; i++) {
      const p = this.freePosition(WORLD_RADIUS - 8);
      this.addLoot(['rifle', 'ammo', 'med', 'armor', 'shotgun', 'grenade', 'smoke', 'smg'][i % 8], p.x, p.z);
    }
    this.addLoot('rifle', 9, 15);
    this.addLoot('armor', 6, 15);
    this.addLoot('med', 10, 18);
  }

  freePosition(radius, origin = null) {
    for (let i = 0; i < 400; i++) {
      const a = this.rng() * Math.PI * 2, r = Math.sqrt(this.rng()) * radius;
      const p = origin ? { x: origin.x + Math.cos(a) * (2 + this.rng() * 6), z: origin.z + Math.sin(a) * (2 + this.rng() * 6) } : { x: Math.sin(a) * r, z: Math.cos(a) * r };
      if (!blocked(p.x, p.z, 1.2) && Math.hypot(p.x, p.z) < WORLD_RADIUS - 2) return p;
    }
    return { x: 0, z: 0 };
  }

  addLoot(type, x, z, ammo = WEAPONS[type]?.magazine) {
    if (this.loot.length < MAX_LOOT) this.loot.push({ id: `l${++this.lootId}`, type, x, z, ...(ammo !== undefined ? { ammo } : {}) });
  }

  addPlayer(id, name, options = {}) {
    if (typeof options === 'boolean') options = { bot: options };
    const bot = options.bot === true;
    const humans = this.players.filter(p => !p.bot).length;
    if (this.phase !== 'waiting' || this.players.length >= this.maxPlayers || this.players.some(p => p.id === id)) return null;
    if (!bot && humans >= MAX_HUMANS_PER_ROOM) return null;
    const team = this.mode === 'solo' ? this.nextTeam() : Number.isInteger(options.team) ? options.team : bot ? this.nextTeam() : 0;
    if (team < 0 || team >= this.maxTeams || this.players.filter(p => p.team === team).length >= this.teamSize) return null;
    const position = this.freePosition(WORLD_RADIUS - 16);
    const player = {
      id, name: String(name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || '旅人', bot,
      human: !bot, team, squad: team, teamName: teamName(team),
      ...position, angle: 0, hp: 100, armor: 0, alive: true, downed: false, downedHp: 100,
      bleedout: 0, reviveProgress: 0, reviveTarget: null, kills: 0, rank: 0, survived: 0,
      weapon: 'pistol', ammo: 12, reserve: 72, meds: 2, car: null,
      loadout: [{ type: 'pistol', ammo: 12 }], slot: 0, grenades: 2, smokes: 1, downedBy: null,
      swapHeld: false, grenadeHeld: false, smokeHeld: false, pingHeld: false, pingCooldown: 0, damagedAt: -10,
      cooldown: 0, reloadTime: 0, healTime: 0, input: emptyInput(),
      lastInput: 0, inputSeq: -1, connected: true, disconnectedAt: null,
      interactHeld: false, botTimer: 0, ramTimer: 0, air: 0,
    };
    this.players.push(player);
    return player;
  }

  nextTeam() {
    const counts = Array.from({ length: this.maxTeams }, (_, team) => this.players.filter(p => p.team === team).length);
    let team = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] < counts[team]) team = i;
    if (counts[team] >= this.teamSize) team = counts.findIndex(count => count < this.teamSize);
    return team < 0 ? 0 : team;
  }

  start() {
    if (this.phase !== 'waiting' || this.players.length === 0) return false;
    while (this.players.length < this.maxPlayers) {
      const team = this.nextTeam();
      this.addPlayer(`bot-${this.players.length}`, BOT_NAMES[this.players.length % BOT_NAMES.length], { bot: true, team });
    }
    this.assignSquadSpawns();
    this.phase = 'deploying';
    this.time = 0;
    for (const p of this.players) { p.air = 1; p.input = emptyInput(); }
    this.event('start', { teams: this.teamSummary() });
    return true;
  }

  assignSquadSpawns() {
    const anchors = new Map();
    const separation = this.mode === 'solo' ? 18 : 38;
    for (let team = 0; team < this.maxTeams; team++) {
      let point = team === 0 ? { x: 8, z: 18 } : this.freePosition(WORLD_RADIUS - 20);
      for (let n = 0; n < 700 && [...anchors.values()].some(p => distance(p, point) < separation); n++) point = this.freePosition(WORLD_RADIUS - 20);
      anchors.set(team, point);
    }
    const offsets = [[0, 0], [2.5, 1], [-2.5, 1], [0, -2.8]];
    for (const p of this.players) {
      const anchor = anchors.get(p.team), offset = offsets[this.players.filter(t => t.team === p.team).indexOf(p) % offsets.length];
      p.x = anchor.x + offset[0]; p.z = anchor.z + offset[1];
      if (blocked(p.x, p.z, .6) || !clearLine(anchor, p)) {
        let free = anchor;
        for (let n = 0; n < 150; n++) { const candidate = this.freePosition(8, anchor); if (clearLine(anchor, candidate)) { free = candidate; break; } }
        p.x = free.x; p.z = free.z;
      }
    }
  }

  input(id, raw) {
    const p = this.players.find(p => p.id === id);
    if (!p || p.bot || !p.alive || !p.connected || this.phase === 'ended') return;
    const input = sanitizeInput(raw);
    if (input.seq <= p.inputSeq) return;
    p.input = input;
    p.inputSeq = input.seq;
    p.lastInput = this.time;
  }

  event(type, data) {
    this.events.push({ id: ++this.eventId, type, time: round(this.time), ...data });
    if (this.events.length > 80) this.events.shift();
  }

  disconnect(id) {
    const p = this.players.find(p => p.id === id);
    if (!p) return;
    p.connected = false;
    p.disconnectedAt = this.clock;
    p.input = emptyInput();
  }

  reconnect(id) {
    const p = this.players.find(p => p.id === id);
    if (!p) return false;
    p.connected = true;
    p.disconnectedAt = null;
    p.inputSeq = -1;
    p.input = emptyInput();
    return true;
  }

  update(dt = 1 / TICK_RATE) {
    if (this.phase === 'waiting' || this.phase === 'loading' || this.phase === 'ended') return;
    dt = clamp(dt, 0, .1);
    this.clock += dt;
    this.time += dt;
    if (this.phase === 'deploying') {
      for (const p of this.players) p.air = Math.max(0, 1 - this.time / 3.5);
      if (this.time >= 3.5) { this.phase = 'playing'; this.time = 0; for (const p of this.players) { p.input = emptyInput(); p.lastInput = 0; } this.event('land', {}); }
      return;
    }
    const progress = clamp((this.time - 28) / (this.duration - 28), 0, 1);
    this.zone.radius = WORLD_RADIUS * (1 - progress) + 2 * progress;
    this.zone.next = Math.max(2, this.zone.radius - 19);
    this.zone.damage = 4 + progress * 20;
    for (const p of this.players) {
      if (!p.alive) continue;
      p.survived = this.time;
      if (!p.connected && p.disconnectedAt !== null && this.clock - p.disconnectedAt > 20) { this.kill(p, null, 'disconnect'); continue; }
      if (p.bot) this.botInput(p, dt);
      else if (this.time - p.lastInput > .4) p.input = emptyInput();
      const i = p.input;
      p.pingCooldown = Math.max(0, p.pingCooldown - dt);
      if (!p.downed && i.swap && !p.swapHeld) this.swapWeapon(p);
      if (!p.downed && i.grenade && !p.grenadeHeld) this.throwGrenade(p, false);
      if (!p.downed && i.smoke && !p.smokeHeld) this.throwGrenade(p, true);
      if (i.ping && !p.pingHeld && !p.pingCooldown) {
        this.pings = this.pings.filter(ping => ping.player !== p.id);
        const range = Math.min(25, wallDistance(p.x, p.z, Math.sin(p.angle), Math.cos(p.angle), 25));
        this.pings.push({ id: ++this.entityId, player: p.id, team: p.team, x: p.x + Math.sin(p.angle) * range, z: p.z + Math.cos(p.angle) * range, ttl: 10 });
        p.pingCooldown = 1;
      }
      p.swapHeld = i.swap; p.grenadeHeld = i.grenade; p.smokeHeld = i.smoke; p.pingHeld = i.ping;
      const w = WEAPONS[p.weapon];
      p.cooldown = Math.max(0, p.cooldown - dt);
      p.ramTimer = Math.max(0, p.ramTimer - dt);
      if (p.reloadTime > 0) {
        p.reloadTime = Math.max(0, p.reloadTime - dt);
        if (!p.reloadTime) { const amount = Math.min(w.magazine - p.ammo, p.reserve); p.ammo += amount; p.reserve -= amount; }
      }
      if (!p.downed && (i.reload || (i.fire && p.ammo === 0)) && !p.reloadTime && p.ammo < w.magazine && p.reserve > 0 && !p.healTime) p.reloadTime = w.reload;
      if (!p.downed && i.heal && p.meds && p.hp < 100 && !p.healTime && !p.reloadTime && !p.car) p.healTime = 2.5;
      if (p.healTime) {
        if (p.downed || Math.hypot(i.mx, i.mz) > .1 || i.fire || p.car) p.healTime = 0;
        else { p.healTime = Math.max(0, p.healTime - dt); if (!p.healTime) { p.hp = Math.min(100, p.hp + 65); p.meds--; this.event('heal', { player: p.id }); } }
      }
      p.angle = i.aim;
      const rescueNear = this.players.some(t => t.alive && t.downed && t.team === p.team && t.id !== p.id && distance(t, p) < 2.8 && clearLine(p, t));
      const interactEdge = i.interact && !p.interactHeld;
      if (!p.downed && interactEdge && !rescueNear) {
        if (!this.openDrop(p)) this.vehicle(p);
      }
      p.interactHeld = i.interact;
      const car = this.cars.find(c => c.id === p.car);
      const driving = car && car.driver === p.id;
      const speed = car ? (driving ? 22 : 0) : p.downed ? 2.2 : p.healTime || (i.interact && rescueNear) ? 0 : 7;
      moveBody(p, i.mx * speed * dt, i.mz * speed * dt, car ? 1.35 : .55);
      if (driving) {
        car.x = p.x; car.z = p.z;
        if (Math.hypot(i.mx, i.mz) > .1) car.angle = Math.atan2(i.mx, i.mz);
        if (Math.hypot(i.mx, i.mz) > .6 && p.ramTimer === 0) {
          const victim = this.players.find(t => t.alive && !t.downed && t.team !== p.team && t.id !== p.id && !t.car && distance(t, p) < 2);
          if (victim) { this.damage(victim, 32, p); p.ramTimer = .8; }
        }
      }
      if (!p.downed && i.fire && p.cooldown === 0 && p.ammo > 0 && !p.reloadTime && !p.healTime && !driving && !(rescueNear && i.interact)) this.shoot(p);
      if (!p.downed && !car && !(rescueNear && i.interact)) this.pickup(p, interactEdge);
      if (p.downed) {
        p.bleedout = Math.max(0, p.bleedout - dt);
        if (p.bleedout === 0) this.kill(p, this.players.find(k => k.id === p.downedBy), 'bleedout');
      }
      if (distance(p, this.zone) > this.zone.radius) this.damage(p, this.zone.damage * dt, null, 'storm');
    }
    this.syncPassengers();
    this.updateRevives(dt);
    this.updateWorldEvents(dt);
    this.wipeDownedTeams();
    const aliveTeams = this.livingTeams();
    if (aliveTeams.length <= 1) this.end(aliveTeams[0] ?? null, 'squad');
    else if (this.time > this.duration + 25) {
      const ranked = aliveTeams.map(team => ({ team, players: this.players.filter(p => p.alive && p.team === team) })).sort((a, b) => this.teamScore(b.players) - this.teamScore(a.players));
      for (const entry of ranked.slice(1)) for (const p of entry.players) this.kill(p, null, 'timeout');
      this.end(ranked[0]?.team ?? null, 'timeout');
    }
  }

  updateRevives(dt) {
    const revivers = new Map();
    for (const p of this.players) {
      p.reviveTarget = null;
      if (!p.alive || p.downed || p.car || !p.connected || !p.input.interact || p.input.fire || Math.hypot(p.input.mx, p.input.mz) > .12 || p.damagedAt === this.clock) continue;
      const target = this.players.filter(t => t.alive && t.downed && t.team === p.team && distance(p, t) < 2.8 && clearLine(p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
      if (target) { p.reviveTarget = target.id; if (!revivers.has(target.id)) revivers.set(target.id, []); revivers.get(target.id).push(p); }
    }
    for (const p of this.players) {
      if (!p.downed) { p.reviveProgress = 0; continue; }
      const count = revivers.get(p.id)?.length || 0;
      p.reviveProgress = count && p.damagedAt !== this.clock ? Math.min(REVIVE_TIME, p.reviveProgress + dt) : 0;
      if (p.reviveProgress >= REVIVE_TIME) this.revive(p);
    }
  }

  revive(p) {
    p.downed = false; p.hp = 38; p.downedHp = 100; p.bleedout = 0; p.reviveProgress = 0; p.healTime = 0; p.reloadTime = 0; p.downedBy = null;
    this.event('revive', { player: p.id, team: p.team, name: p.name });
  }

  wipeDownedTeams() {
    for (const team of this.livingTeams()) {
      const members = this.players.filter(p => p.team === team && p.alive);
      if (members.length && members.every(p => p.downed)) {
        for (const p of members) this.kill(p, this.players.find(k => k.id === p.downedBy), 'squad-wipe');
      }
    }
  }

  releaseSeat(p) {
    if (!p.car) return;
    const car = this.cars.find(c => c.id === p.car);
    if (car) {
      car.seats = car.seats.map(id => id === p.id ? null : id);
      if (car.driver === p.id) car.driver = car.seats.find(id => id) || null;
    }
    p.car = null;
  }

  syncPassengers() {
    for (const car of this.cars) {
      for (const id of car.seats) {
        const p = this.players.find(p => p.id === id);
        if (p) { p.x = car.x; p.z = car.z; }
      }
    }
  }

  swapWeapon(p) {
    if (p.loadout.length < 2 || p.downed) return;
    p.loadout[p.slot] = { type: p.weapon, ammo: p.ammo };
    p.slot = (p.slot + 1) % p.loadout.length;
    const weapon = p.loadout[p.slot]; p.weapon = weapon.type; p.ammo = weapon.ammo;
    p.reloadTime = 0; p.healTime = 0; p.cooldown = Math.max(.2, p.cooldown);
  }

  throwGrenade(p, smoke) {
    const key = smoke ? 'smokes' : 'grenades';
    if (!p.alive || p.downed || !p[key] || p.car || this.grenades.length >= 128) return;
    p[key]--; p.healTime = 0;
    this.grenades.push({ id: `g${++this.entityId}`, player: p.id, team: p.team, smoke, x: p.x, z: p.z, vx: Math.sin(p.input.aim) * 13, vz: Math.cos(p.input.aim) * 13, ttl: 2.1, height: .6 });
    this.event('throw', { player: p.id, smoke });
  }

  smokeBlocks(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
    return this.smokes.some(s => {
      const t = length ? clamp(((s.x - a.x) * dx + (s.z - a.z) * dz) / length, 0, 1) : 0;
      return Math.hypot(a.x + t * dx - s.x, a.z + t * dz - s.z) < s.radius;
    });
  }

  updateWorldEvents(dt) {
    for (const g of this.grenades) {
      g.ttl -= dt;
      if (!blocked(g.x + g.vx * dt, g.z, .2)) g.x += g.vx * dt; else g.vx *= -.4;
      if (!blocked(g.x, g.z + g.vz * dt, .2)) g.z += g.vz * dt; else g.vz *= -.4;
      g.vx *= 1 - dt * 1.1; g.vz *= 1 - dt * 1.1;
      g.height = .3 + Math.sin(clamp(1 - g.ttl / 2.1, 0, 1) * Math.PI) * 4;
      if (g.ttl <= 0) {
        if (g.smoke) this.smokes.push({ id: `s${++this.entityId}`, x: g.x, z: g.z, radius: 7, ttl: 16 });
        else {
          const attacker = this.players.find(p => p.id === g.player);
          for (const target of this.players) if (target.alive && distance(target, g) < 8 && clearLine(g, target)) this.damage(target, 120 * (1 - distance(target, g) / 8), attacker, 'grenade');
          this.event('explosion', { x: round(g.x), z: round(g.z) });
        }
      }
    }
    this.grenades = this.grenades.filter(g => g.ttl > 0);
    for (const s of this.smokes) s.ttl -= dt;
    this.smokes = this.smokes.filter(s => s.ttl > 0);
    for (const p of this.pings) p.ttl -= dt;
    this.pings = this.pings.filter(p => p.ttl > 0);
    for (const drop of this.drops) drop.landsIn = Math.max(0, drop.landsIn - dt);
    if (this.time >= this.nextDrop && this.drops.length < 4) {
      const position = this.freePosition(Math.max(8, this.zone.radius * .65));
      this.drops.push({ id: `d${++this.entityId}`, ...position, landsIn: 12, opened: false });
      this.nextDrop += 75; this.event('airdrop', position);
    }
  }

  openDrop(p) {
    const drop = this.drops.find(d => !d.opened && !d.landsIn && distance(d, p) < 3 && clearLine(d, p));
    if (!drop) return false;
    drop.opened = true;
    for (const [i, type] of ['sniper', 'lmg', 'armor', 'med', 'ammo', 'grenade'].entries()) {
      const position = { x: drop.x + Math.sin(i) * 1.4, z: drop.z + Math.cos(i) * 1.4 };
      this.addLoot(type, blocked(position.x, position.z, .3) ? drop.x : position.x, blocked(position.x, position.z, .3) ? drop.z : position.z);
    }
    this.event('supply', { player: p.id }); return true;
  }

  vehicle(p) {
    if (p.car) {
      const car = this.cars.find(c => c.id === p.car);
      for (const [x, z] of [[2.4, 0], [-2.4, 0], [0, 2.8], [0, -2.8]]) {
        if (car && !blocked(p.x + x, p.z + z, .6) && clearLine(p, { x: p.x + x, z: p.z + z })) { this.releaseSeat(p); p.x += x; p.z += z; return; }
      }
    } else {
      const car = this.cars.find(c => c.seats.includes(null) && c.hp > 0 && distance(c, p) < 3.8 && clearLine(p, c) && c.seats.every(id => !id || this.players.find(t => t.id === id)?.team === p.team));
      if (car) { car.seats[car.seats.indexOf(null)] = p.id; car.driver ||= p.id; p.car = car.id; p.x = car.x; p.z = car.z; p.healTime = 0; }
    }
  }

  pickup(p, explicit = false) {
    for (let j = this.loot.length - 1; j >= 0; j--) {
      const item = this.loot[j];
      if (distance(p, item) > 1.7 || !clearLine(p, item)) continue;
      let taken = false;
      if (WEAPONS[item.type]) {
        if (!p.loadout.some(w => w.type === item.type) && (p.loadout.length < 2 || explicit)) {
          p.loadout[p.slot] = { type: p.weapon, ammo: p.ammo };
          const next = { type: item.type, ammo: item.ammo ?? WEAPONS[item.type].magazine };
          if (p.loadout.length < 2) { p.loadout.push(next); p.slot = p.loadout.length - 1; }
          else { this.addLoot(p.weapon, p.x + .7, p.z, p.ammo); p.loadout[p.slot] = next; }
          p.weapon = next.type; p.ammo = next.ammo; p.reloadTime = 0; taken = true; explicit = false;
        }
      } else if (item.type === 'ammo' && p.reserve < 240) { p.reserve = Math.min(240, p.reserve + 45); taken = true; }
      else if (item.type === 'med' && p.meds < 4) { p.meds++; taken = true; }
      else if (item.type === 'armor' && p.armor < 65) { p.armor = 65; taken = true; }
      else if (item.type === 'grenade' && p.grenades < 4) { p.grenades++; taken = true; }
      else if (item.type === 'smoke' && p.smokes < 3) { p.smokes++; taken = true; }
      if (taken) { this.loot.splice(j, 1); this.event('pickup', { player: p.id, item: item.type }); }
    }
  }

  shoot(p) {
    const w = WEAPONS[p.weapon]; p.ammo--; p.cooldown = w.interval;
    for (let pellet = 0; pellet < (w.pellets || 1); pellet++) {
      const angle = p.angle + (this.rng() - .5) * w.spread * 2, dx = Math.sin(angle), dz = Math.cos(angle);
      let hit = null, range = wallDistance(p.x, p.z, dx, dz, w.range);
      for (const target of this.players) {
        if (target.id === p.id || !target.alive || target.team === p.team) continue;
        const ox = target.x - p.x, oz = target.z - p.z, along = ox * dx + oz * dz, r = target.car ? 1.45 : .7;
        const perpendicular = ox * ox + oz * oz - along * along;
        if (perpendicular > r * r || along < 0) continue;
        const near = Math.max(0, along - Math.sqrt(r * r - perpendicular));
        if (near < range) { range = near; hit = target; }
      }
      if (hit) this.damage(hit, w.damage, p);
      this.event('shot', { player: p.id, x: round(p.x), z: round(p.z), tx: round(p.x + dx * range), tz: round(p.z + dz * range), hit: hit?.id || null });
    }
  }

  damage(target, amount, attacker, reason = 'shot') {
    if (!target?.alive) return;
    if (attacker && attacker.team === target.team) return;
    target.damagedAt = this.clock; target.healTime = 0;
    if (target.downed) {
      if (reason === 'shot' || reason === 'grenade') target.downedHp = Math.max(0, target.downedHp - amount * 1.4);
      if (reason === 'storm') target.bleedout = Math.max(0, target.bleedout - amount * .35);
      if (target.downedHp <= 0 || target.bleedout <= 0) this.kill(target, attacker, reason);
      return;
    }
    if (reason === 'shot') {
      if (target.car) {
        const car = this.cars.find(c => c.id === target.car); if (car) car.hp -= amount;
        amount *= .3;
        if (car?.hp <= 0) { car.hp = 0; const passengers = this.players.filter(p => p.car === car.id); for (const p of passengers) this.releaseSeat(p); amount += 30; this.event('explosion', { x: car.x, z: car.z }); }
      }
      const absorbed = Math.min(target.armor, amount * .6); target.armor -= absorbed; amount -= absorbed; target.healTime = 0;
    }
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp <= 0) this.down(target, attacker, reason);
  }

  down(p, attacker, reason) {
    if (!p.alive || p.downed) return;
    if (!this.players.some(t => t.id !== p.id && t.team === p.team && t.alive && !t.downed)) { this.kill(p, attacker, reason); return; }
    p.downed = true; p.hp = 1; p.downedHp = 100; p.bleedout = BLEEDOUT_TIME; p.healTime = 0; p.reloadTime = 0;
    p.downedBy = attacker?.id || null;
    this.releaseSeat(p);
    this.event('down', { player: p.id, team: p.team, attacker: attacker?.id || null, name: p.name, attackerName: attacker?.name || '信号风暴', reason });
  }

  kill(p, attacker, reason) {
    if (!p.alive) return;
    const teamRank = this.livingTeams().length;
    p.rank = 0;
    p.survived = this.time; p.alive = false; p.downed = false; p.hp = 0; p.healTime = 0; p.reloadTime = 0; p.reviveProgress = 0;
    this.releaseSeat(p);
    if (!this.players.some(t => t.team === p.team && t.alive)) {
      this.teamRanks.set(p.team, teamRank);
      for (const member of this.players.filter(t => t.team === p.team)) member.rank = teamRank;
    }
    if (attacker && attacker !== p) attacker.kills++;
    this.addLoot('ammo', p.x, p.z);
    p.loadout[p.slot] = { type: p.weapon, ammo: p.ammo };
    for (const weapon of p.loadout) if (weapon.type !== 'pistol') this.addLoot(weapon.type, p.x + .4, p.z + .4, weapon.ammo);
    this.event('kill', { player: p.id, team: p.team, attacker: attacker?.id || null, reason, name: p.name, attackerName: attacker?.name || '信号风暴' });
  }

  livingTeams() { return [...new Set(this.players.filter(p => p.alive).map(p => p.team))].sort((a, b) => a - b); }
  teamScore(players) { return players.reduce((sum, p) => sum + (p.hp + p.armor * .25) + p.kills * 30, 0); }
  teamSummary() {
    return Array.from({ length: this.maxTeams }, (_, team) => {
      const members = this.players.filter(p => p.team === team);
      return { team, name: teamName(team), alive: members.filter(p => p.alive).length, humans: members.filter(p => !p.bot).length, members: members.length };
    }).filter(t => t.members);
  }

  end(winnerTeam, reason) {
    this.phase = 'ended'; this.winnerTeam = winnerTeam; this.resultReason = reason;
    const winner = this.players.find(p => p.team === winnerTeam && p.alive);
    this.winner = winner?.id ?? null;
    for (const p of this.players) if (p.team === winnerTeam) p.rank = 1;
    this.event('end', { winner: this.winner, winnerTeam, reason });
  }

  botInput(p, dt) {
    p.botTimer -= dt;
    if (p.botTimer > 0) return;
    p.botTimer = .24 + this.rng() * .22;
    if (p.downed) {
      const safe = distance(p, this.zone) > this.zone.radius - 4;
      const a = safe ? Math.atan2(this.zone.x - p.x, this.zone.z - p.z) : this.time * .12 + p.team;
      p.input = { ...emptyInput(), mx: Math.sin(a) * .6, mz: Math.cos(a) * .6, aim: a };
      return;
    }
    const teammate = this.players.filter(t => t.alive && t.downed && t.team === p.team && distance(t, p) < 24).sort((a, b) => distance(a, p) - distance(b, p))[0];
    if (teammate && clearLine(p, teammate)) {
      const a = Math.atan2(teammate.x - p.x, teammate.z - p.z);
      const close = distance(p, teammate) < 2.4;
      p.input = { ...emptyInput(), mx: close ? 0 : Math.sin(a) * .7, mz: close ? 0 : Math.cos(a) * .7, aim: a, interact: close };
      return;
    }
    const target = this.players.filter(t => t.alive && !t.downed && t.id !== p.id && t.team !== p.team && distance(t, p) < Math.min(WEAPONS[p.weapon].range, 58))
      .sort((a, b) => distance(a, p) - distance(b, p)).find(t => clearLine(p, t) && !this.smokeBlocks(p, t));
    const outside = distance(p, this.zone) > this.zone.radius - 9;
    let dest;
    if (outside) dest = this.zone;
    else if (target) dest = target;
    else {
      dest = this.loot.filter(l => (p.weapon === 'pistol' && WEAPONS[l.type]) || (l.type === 'armor' && p.armor < 30) || (l.type === 'ammo' && p.reserve < 50)).sort((a, b) => distance(a, p) - distance(b, p))[0];
      if (!dest || distance(p, dest) > 25) dest = { x: Math.sin(this.time * .04 + p.team) * this.zone.radius * .5, z: Math.cos(this.time * .04 + p.team) * this.zone.radius * .5 };
    }
    const a = Math.atan2(dest.x - p.x, dest.z - p.z);
    let mx = Math.sin(a), mz = Math.cos(a);
    if (target && !outside && distance(target, p) < 13) { mx = Math.cos(a) * .6; mz = -Math.sin(a) * .6; }
    for (const offset of [0, .7, -.7, 1.4, -1.4, 2.1, -2.1, Math.PI]) {
      const dx = mx * Math.cos(offset) - mz * Math.sin(offset), dz = mx * Math.sin(offset) + mz * Math.cos(offset);
      if (!blocked(p.x + dx * 2, p.z + dz * 2, .6)) { mx = dx; mz = dz; break; }
    }
    const heal = p.hp < 45 && p.meds > 0 && !target && !outside;
    p.input = { ...emptyInput(), mx: heal ? 0 : mx * .72, mz: heal ? 0 : mz * .72,
      aim: target ? Math.atan2(target.x - p.x, target.z - p.z) + (this.rng() - .5) * .34 : a,
      fire: !!target && this.time > 12 && this.rng() > .2, heal, reload: p.ammo === 0 };
  }

  snapshot(viewerId = null, sinceEvent = 0) {
    const viewer = this.players.find(p => p.id === viewerId);
    const followed = viewer && !viewer.alive ? this.players.find(p => p.alive && p.team === viewer.team) || this.players.find(p => p.alive) || viewer : viewer;
    const visible = p => !followed || p.id === viewer.id || p.team === viewer.team || distance(p, followed) < 70;
    return {
      mode: this.mode, teamSize: this.teamSize, totalPlayers: this.players.length, aliveCount: this.players.filter(p => p.alive).length, phase: this.phase, time: round(this.time), duration: this.duration,
      winner: this.winner, winnerTeam: this.winnerTeam, resultReason: this.resultReason,
      zone: { x: this.zone.x, z: this.zone.z, radius: round(this.zone.radius), next: round(this.zone.next), damage: round(this.zone.damage) }, teamSummary: this.teamSummary(),
      players: this.players.filter(visible).map(p => ({
        id: p.id, name: p.name, bot: p.bot, human: p.human, team: p.team, squad: p.squad, teamName: p.teamName,
        x: round(p.x), z: round(p.z), angle: round(p.angle), hp: round(p.hp), armor: round(p.armor), alive: p.alive,
        downed: p.downed, downedHp: round(p.downedHp), bleedout: round(p.bleedout), reviveProgress: round(p.reviveProgress), reviveTarget: p.reviveTarget,
        kills: p.kills, rank: p.rank, weapon: p.weapon, ammo: p.ammo, reserve: p.reserve, meds: p.meds, car: p.car,
        slot: p.slot, loadout: p.loadout.map((w, i) => ({ type: w.type, ammo: i === p.slot ? p.ammo : w.ammo })), grenades: p.grenades, smokes: p.smokes,
        reloadTime: round(p.reloadTime), healTime: round(p.healTime), air: round(p.air), connected: p.connected, seq: p.inputSeq, survived: round(p.survived),
      })),
      loot: this.loot.filter(visible).map(l => ({ ...l, x: round(l.x), z: round(l.z) })), cars: this.cars.map(c => ({ ...c, x: round(c.x), z: round(c.z), angle: round(c.angle), hp: round(c.hp), seats: [...c.seats] })),
      events: this.events.filter(e => e.id > sinceEvent && (e.type !== 'shot' || !followed || distance(e, followed) < 90)).map(e => ({ ...e })),
      grenades: this.grenades.filter(visible).map(g => ({ id:g.id, x:round(g.x), z:round(g.z), smoke:g.smoke, height:round(g.height), ttl:round(g.ttl) })),
      smokes: this.smokes.filter(visible).map(s => ({ ...s, x:round(s.x), z:round(s.z), ttl:round(s.ttl) })),
      pings: this.pings.filter(p => !viewer || p.team === viewer.team).map(p => ({ ...p, x:round(p.x), z:round(p.z), ttl:round(p.ttl) })),
      drops: this.drops.map(d => ({ ...d, x:round(d.x), z:round(d.z), landsIn:round(d.landsIn) })),
    };
  }
}
