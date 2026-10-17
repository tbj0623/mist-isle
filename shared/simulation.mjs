// 雾岛突围 / MIST ISLE — 对战模拟核心（owner: simcore · shared/simulation.mjs）
// 服务端权威：命中/伤害/缩圈/载具/波次全部在这里结算，客户端只发输入。
// 单位：米 / 秒 / 弧度（0 = +Z，x 分量 = sin(angle)）；禁止 Math.random，只用 this.rng()。
import * as mapgen from './map.mjs';
import {
  TICK_RATE, SQUAD_SIZE, MAX_PLAYERS, MAX_HUMANS, MAX_LOOT, MAX_EVENTS, MAX_GRENADES, MAX_CARS,
  MATCH_MODES, DEFAULT_DURATION, MOVE, COMBAT, ZONE_PHASES, ZONE_FIRST_WAIT, REVIVE_TIME,
  BLEEDOUT_TIME, REVIVE_HP, REVIVE_RANGE, HORDE, DIFFICULTY, INPUT_DEFAULTS,
} from './rules.mjs';
import {
  WEAPONS, ATTACHMENTS, AMMO_TYPES, WEAPON_ORDER, applyAttachmentMods, getWeapon, damageAtDistance,
} from './data/weapons.mjs';
import { ARMORS, CONSUMABLES, THROWABLES, BACKPACKS, armorForTier } from './data/items.mjs';
import { buildLootForSpot, buildAirdropLoot } from './data/loot.mjs';
import { getMapDef } from './data/maps.mjs';
import { thinkBot } from './ai.mjs';

export { WEAPONS, ATTACHMENTS, ARMORS, CONSUMABLES, THROWABLES, BACKPACKS, AMMO_TYPES, WEAPON_ORDER };
export { TICK_RATE, SQUAD_SIZE, MAX_PLAYERS };
export const MAX_HUMANS_PER_ROOM = MAX_HUMANS;
export const MAX_SQUADS = Math.ceil(MAX_PLAYERS / SQUAD_SIZE);

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r2 = (v) => Math.round(v * 100) / 100;
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const wrapAngle = (a) => {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
};
const TEAM_NAMES = ['曙光', '黑潮', '雾岚', '赤礁', '白沙', '远星', '山隼', '星火',
  '长风', '暗礁', '苍穹', '疾雨', '晨鹿', '鲸落', '沙丘', '雪松'];
const BOT_NAMES = ['松鸦', '北斗', '灰狐', '纸飞机', '野渡', '杉木', '海盐', '回声', '浮游', '寒鸦',
  '拾荒者', '潮汐', '白鹭', '山猫', '微光', '石榴', '长风', '沙棘', '枯木', '星火'];
const PING_KINDS = ['move', 'enemy', 'loot', 'danger'];
const BOOL_INPUTS = ['fire', 'reload', 'heal', 'interact', 'swap', 'ping', 'sprint', 'crouch',
  'dodge', 'revive', 'ready'];
const AMMO_KEYS = ['light', 'medium', 'heavy', 'shell', 'bolt'];
const CARS = {
  buggy: { id: 'buggy', name: '沙滩越野', seats: 4, speed: 15.5, hp: 220, color: 0xd8a24a },
  jeep: { id: 'jeep', name: '军用吉普', seats: 4, speed: 13.5, hp: 320, color: 0x6f8f6a },
  bike: { id: 'bike', name: '越野摩托', seats: 2, speed: 18.5, hp: 130, color: 0xb05a4a },
  truck: { id: 'truck', name: '运输卡车', seats: 6, speed: 11.2, hp: 440, color: 0x7a8a94 },
};
const CAR_TYPES = ['buggy', 'jeep', 'bike', 'truck'];

// ── 输入 ────────────────────────────────────────────────────────────────────
export const emptyInput = () => ({
  mx: 0, mz: 0, aim: 0, fire: false, reload: false, heal: false, interact: false, swap: false,
  ping: false, sprint: false, crouch: false, dodge: false, throwable: null, useItem: null,
  pingKind: 'move', slot: -1, revive: false, buy: null, upgrade: null, ready: false, seq: 0,
});

export function sanitizeInput(raw) {
  const out = emptyInput();
  if (!raw || typeof raw !== 'object') return out;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  let mx = clamp(num(raw.mx), -1, 1);
  let mz = clamp(num(raw.mz), -1, 1);
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  out.mx = mx; out.mz = mz;
  out.aim = wrapAngle(num(raw.aim));
  for (let i = 0; i < BOOL_INPUTS.length; i++) {
    const k = BOOL_INPUTS[i];
    out[k] = raw[k] === true;
  }
  out.slot = raw.slot === 0 || raw.slot === 1 ? raw.slot : -1;
  out.throwable = THROWABLES[raw.throwable] ? raw.throwable : null;
  out.useItem = CONSUMABLES[raw.useItem] ? raw.useItem : null;
  out.pingKind = PING_KINDS.includes(raw.pingKind) ? raw.pingKind : 'move';
  out.buy = typeof raw.buy === 'string' && HORDE.upgrades[raw.buy] ? raw.buy : null;
  out.upgrade = typeof raw.upgrade === 'string' && HORDE.upgrades[raw.upgrade] ? raw.upgrade : null;
  out.seq = clamp(Math.floor(num(raw.seq)), 0, Number.MAX_SAFE_INTEGER);
  return out;
}

/** 应用配件后的武器有效数值（缓存于 loadout 槽位，换配件时失效）。 */
export function effectiveWeapon(player) {
  if (!player || !Array.isArray(player.loadout)) return null;
  const slot = player.loadout[player.slot | 0] || player.loadout[0];
  if (!slot || !slot.type) return null;
  if (!slot._eff) slot._eff = applyAttachmentMods(getWeapon(slot.type), slot.attachments || []);
  return slot._eff;
}

// ── Match ───────────────────────────────────────────────────────────────────
export class Match {
  constructor({
    mapId = 'qinglan', seed = 1, mode = 'squad', maxPlayers = MAX_PLAYERS, duration = null,
    difficulty = 'veteran', humanTeam = 0, horde = false,
  } = {}) {
    this.seed = seed >>> 0;
    this.rng = mapgen.mulberry32(this.seed);
    this.mapId = mapId;
    this.mapDef = getMapDef(mapId) || getMapDef('qinglan');
    this.mapName = this.mapDef?.name || '青岚岛';
    this.weather = this.mapDef?.weather || 'clear';
    this.timeOfDay = this.mapDef?.timeOfDay || 'day';
    this.world = createWorld(this.mapId);
    this.mode = MATCH_MODES.includes(mode) ? mode : 'squad';
    this.teamSize = this.mode === 'solo' || this.mode === 'training' ? 1 : SQUAD_SIZE;
    this.hordeMode = horde === true || this.mode === 'horde';
    this.horde = this.hordeMode;
    this.humanTeam = Number.isFinite(humanTeam) ? humanTeam : 0;
    this.maxPlayers = clamp(Math.floor(maxPlayers) || MAX_PLAYERS, 2, MAX_PLAYERS);
    this.maxTeams = Math.max(1, Math.ceil(this.maxPlayers / this.teamSize));
    this.duration = clamp(
      Number.isFinite(duration) ? duration : (DEFAULT_DURATION[this.mode] || 420), 60, 1800,
    );
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'veteran';
    this.phase = 'waiting';
    this.time = 0;
    this.matchTime = 0;
    this.phaseTime = 0;
    this.players = [];
    this.loot = [];
    this.cars = [];
    this.grenades = [];
    this.smokes = [];
    this.fires = [];
    this.pings = [];
    this.drops = [];
    this.events = [];
    this.eventId = 0;
    this.lootId = 0;
    this.entityId = 0;
    this.zone = null;
    this.winnerTeam = null;
    this.resultReason = null;
    this.result = null;
    this.hordeRun = null;
    this.tickCount = 0;
    this.nextDrop = 0;
    this.dropsLeft = 0;
    this.startedAt = 0;
    this.counters = { lootSpawned: 0, kills: 0, shots: 0 };
    this._rankCounter = 0;
    this._setupZone();
    this._setupCars();
    this._generateLoot();
  }

  // ── 世界与开局 ────────────────────────────────────────────────────────────
  _setupZone() {
    const radius = this.world?.radius || 182;
    const startR = radius * 0.96;
    this.zone = {
      x: 0, z: 0, r: startR,
      target: { x: 0, z: 0, r: startR },
      closing: false, damage: 0, phase: -1, nextIn: ZONE_FIRST_WAIT, t: 0,
    };
  }

  _setupCars() {
    const spots = Array.isArray(this.world?.carSpots) ? this.world.carSpots : [];
    const limit = Math.min(spots.length, MAX_CARS);
    for (let i = 0; i < limit; i++) {
      const s = spots[i];
      const type = CARS[s.type] ? s.type : CAR_TYPES[i % CAR_TYPES.length];
      const def = CARS[type];
      this.cars.push({
        id: `car${i + 1}`, type, x: s.x, z: s.z, angle: s.rot ?? s.angle ?? 0,
        hp: def.hp, maxHp: def.hp, color: def.color, seats: def.seats,
        occupants: new Array(def.seats).fill(null), driver: null, speed: 0,
        dead: false, hitCd: 0,
      });
    }
  }

  _generateLoot() {
    const spots = Array.isArray(this.world?.lootSpots) ? this.world.lootSpots : [];
    for (let i = 0; i < spots.length && this.loot.length < MAX_LOOT; i++) {
      const spot = spots[i];
      const entries = buildLootForSpot(this.rng, spot);
      for (let k = 0; k < entries.length && this.loot.length < MAX_LOOT; k++) {
        const e = entries[k];
        this.addLoot(e.kind, e.item, spot.x + (this.rng() - 0.5) * 1.4,
          spot.z + (this.rng() - 0.5) * 1.4, e);
      }
    }
    this.counters.lootSpawned = this.loot.length;
  }

  addLoot(kind, item, x, z, opts = {}) {
    if (this.loot.length >= MAX_LOOT) return null;
    const entry = {
      id: `l${++this.lootId}`, kind, item, x, z, y: 0.05,
      qty: opts.qty ?? 1,
      ammo: opts.ammo ?? null,
      rarity: opts.rarity || 'common',
      attachments: Array.isArray(opts.attachments) ? opts.attachments.slice() : [],
      taken: false,
    };
    if (kind === 'consumable' && CONSUMABLES[item]) entry.qty = opts.qty ?? 1;
    if (kind === 'throwable' && THROWABLES[item]) entry.qty = opts.qty ?? 1;
    if (kind === 'armor' && ARMORS[item]) entry.qty = 1;
    this.loot.push(entry);
    return entry;
  }

  addPlayer(id, name, opts = {}) {
    const bot = opts.bot === true;
    let team = Number.isInteger(opts.team) ? opts.team : -1;
    if (team < 0) team = this._nextTeamSlot();
    if (team < 0) team = 0;
    if (team >= this.maxTeams) this.maxTeams = Math.min(MAX_PLAYERS, team + 1);
    const player = {
      id, name: (typeof name === 'string' && name ? name : '旅人').slice(0, 20), bot,
      team, connected: true, difficulty: DIFFICULTY[opts.difficulty] ? opts.difficulty : this.difficulty,
      hp: COMBAT.maxHp, armor: 0, armorTier: 0, shield: 0, stamina: MOVE.sprintStamina,
      state: 'normal', x: 0, z: 0, y: 0, angle: this.rng() * TAU, chute: 0,
      downed: false, downedHp: 100, bleedout: 0, reviveProgress: 0, reviveTarget: null,
      alive: true, kills: 0, assists: 0, damage: 0, rank: 0, score: 0,
      loadout: [null, null], slot: 0,
      mags: { light: 0, medium: 0, heavy: 0, shell: 0, bolt: 0 },
      meds: 0, bandages: 0, energy: 0, shields: 0,
      grenades: 0, smokes: 0, flashes: 0, molotovs: 0,
      backpack: 'bp1', car: null, seat: -1,
      input: emptyInput(), lastSeq: -1, moved: false,
      fireCd: 0, reloadTime: 0, healTime: 0, healKind: null, healTotal: 0,
      recoil: 0, spreadBloom: 0, blind: 0, haste: 0,
      dodgeTime: 0, dodgeCd: 0, dodgeDx: 0, dodgeDz: 0,
      interactCd: 0, pingCd: 0, throwCd: 0, useCd: 0,
      lastHitBy: null, lastHitAt: -99, downedAt: 0, deadAt: 0,
      accuracy: 1, lastFireAt: -99, think: null, aggro: null,
      buy: null, upgradesBought: 0,
    };
    this._applyLoadout(player, opts.loadout);
    this.players.push(player);
    if (this.phase !== 'waiting' && this.phase !== 'loading') this._spawnPlayer(player);
    return player;
  }

  _nextTeamSlot() {
    const counts = new Array(this.maxTeams + 1).fill(0);
    for (let i = 0; i < this.players.length; i++) {
      const t = this.players[i].team;
      counts[t] = (counts[t] || 0) + 1;
    }
    for (let t = 0; t < this.maxTeams; t++) if (counts[t] < this.teamSize) return t;
    return -1;
  }

  nextTeam() { return Math.max(0, this._nextTeamSlot()); }

  /** 把队伍容量扩展到能容纳 count 名玩家（squad 4 人一队，最多 16 队）。 */
  _ensureCapacity(count) {
    const needed = Math.ceil(count / Math.max(1, this.teamSize));
    if (needed > this.maxTeams) {
      this.maxTeams = Math.min(MAX_PLAYERS, Math.max(this.maxTeams, needed));
    }
    return this.maxTeams;
  }

  _applyLoadout(player, loadout) {
    const list = Array.isArray(loadout) && loadout.length ? loadout : [{ type: 'p9' }, null];
    for (let i = 0; i < 2; i++) {
      const raw = list[i];
      if (!raw || !WEAPONS[raw.type]) { player.loadout[i] = null; continue; }
      const w = getWeapon(raw.type);
      player.loadout[i] = {
        type: raw.type,
        ammo: Number.isFinite(raw.ammo) ? clamp(Math.floor(raw.ammo), 0, w.magazine) : w.magazine,
        attachments: Array.isArray(raw.attachments)
          ? raw.attachments.filter((a) => ATTACHMENTS[a]).slice(0, 4) : [],
        _eff: null,
      };
      const eff = applyAttachmentMods(w, player.loadout[i].attachments);
      const ammoDef = AMMO_TYPES[eff.ammo] || AMMO_TYPES.light;
      player.mags[eff.ammo] = Math.max(player.mags[eff.ammo] || 0, Math.round(ammoDef.cap * 0.6));
    }
    player.slot = player.loadout[0] ? 0 : 1;
    if (!player.loadout[1]) player.loadout[1] = null;
  }

  removePlayer(id) {
    const i = this.players.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const p = this.players[i];
    if (p.car != null) this._exitCar(p, true);
    this.players.splice(i, 1);
    this._checkTeamWipe();
    return true;
  }

  /** 进入对局：补 bot、撒点、清空等待态。 */
  start() {
    if (this.phase !== 'waiting') return false;
    if (this.hordeMode) return this._startHorde();
    const target = this.mode === 'training' ? Math.max(this.players.length, 16) : this.maxPlayers;
    this._ensureCapacity(Math.max(target, this.players.length));
    let n = this.players.filter((p) => !p.bot).length;
    let guard = 0;
    while (this.players.length < target && guard++ < MAX_PLAYERS * 4) {
      const team = this._nextTeamSlot();
      if (team < 0) break;
      const name = `${BOT_NAMES[(n + this.players.length) % BOT_NAMES.length]}·${1 + (n % 9)}`;
      this.addPlayer(`bot${++this.entityId}`, name, {
        bot: true, team,
        difficulty: this.mode === 'training' ? 'recruit' : this.difficulty,
      });
      n++;
    }
    for (let i = 0; i < this.players.length; i++) this._spawnPlayer(this.players[i]);
    this.phase = 'deploying';
    this.time = 0;
    this.matchTime = 0;
    this.startedAt = 0;
    this.nextDrop = this.mode === 'training' ? 60 : 45;
    this.dropsLeft = this.mode === 'training' ? 1 : 3;
    this._emit('start', { mode: this.mode, players: this.players.length });
    return true;
  }

  _spawnPlayer(p) {
    const spot = this._spawnPoint(p);
    p.x = spot.x; p.z = spot.z; p.y = 0;
    p.state = 'normal'; p.hp = COMBAT.maxHp; p.alive = true; p.downed = false;
    p.downedHp = 100; p.bleedout = 0; p.reviveProgress = 0; p.reviveTarget = null;
    p.car = null; p.seat = -1; p.chute = 0;
    p.angle = this.rng() * TAU;
    p.armorTier = p.armorTier || 0;
    p.armor = p.armorTier ? (armorForTier(p.armorTier)?.durability || 0) : 0;
    p.stamina = MOVE.sprintStamina;
    p.fireCd = 0; p.reloadTime = 0; p.healTime = 0; p.healKind = null;
  }

  _spawnPoint(p) {
    const anchors = this.world?.spawnAnchors?.length ? this.world.spawnAnchors : null;
    const radius = (this.world?.radius || 182) * (this.zone?.r ? this.zone.r / (this.world?.radius || 182) : 1);
    if (!anchors) {
      const a = this.rng() * TAU;
      const rr = Math.sqrt(this.rng()) * Math.max(8, radius * 0.8);
      return { x: Math.cos(a) * rr, z: Math.sin(a) * rr };
    }
    const base = (p.team * 3 + (p.bot ? 1 : 0)) % anchors.length;
    for (let i = 0; i < 8; i++) {
      const a = anchors[(base + i * 5) % anchors.length];
      const x = a.x + (this.rng() - 0.5) * 4;
      const z = a.z + (this.rng() - 0.5) * 4;
      if (!this.world.blocked(x, z, MOVE.radius)) return { x, z };
    }
    const a = anchors[base] || anchors[0];
    return { x: a.x, z: a.z };
  }

  // ── 主循环 ────────────────────────────────────────────────────────────────
  update(dt = 1 / TICK_RATE) {
    const step = Number.isFinite(dt) ? clamp(dt, 0.0001, 0.1) : 1 / TICK_RATE;
    if (this.phase === 'ended') return;
    this.tickCount++;
    if (this.phase === 'waiting' || this.phase === 'loading') return;
    this.time += step;
    this.matchTime += step;
    if (this.phase === 'deploying' && this.time > 2.5) this.phase = 'live';
    this._updatePlayers(step);
    this._updateGrenades(step);
    this._updateCars(step);
    this._updateZones(step);
    this._updateDrops(step);
    this._reachHorde(step);
    this._updateHorde(step);
    this._bots(step);
    this._checkEnd(step);
    this._resolveHordeClear();
  }

  /** 把当前波次的可清除状态推进到「下一波准备期」。 */
  _reachHorde(dt) {
    const run = this.hordeRun;
    if (!run || this.phase === 'ended') return;
    if (run.wave > 0 && run.enemies.length === 0 && run.nextWaveIn <= 0 && run.wave < run.totalWaves) {
      run.nextWaveIn = HORDE.prepTime;
      run.prepTime = HORDE.prepTime;
      run.clearedAt = this.time;
    }
  }

  _resolveHordeClear() {
    const run = this.hordeRun;
    if (!run || this.phase === 'ended') return;
    if (run.nextWaveIn > 0 && run.enemies.length === 0) {
      run.nextWaveIn = Math.max(0, run.nextWaveIn);
    }
  }

  input(id, raw) {
    const p = this._find(id);
    if (!p) return false;
    const next = sanitizeInput(raw);
    if (next.seq <= p.lastSeq && next.seq !== 0) return false;
    if (next.seq) p.lastSeq = next.seq;
    next.throwable = p.input.throwable && !next.throwable ? null : next.throwable;
    p.input = next;
    return true;
  }

  disconnect(id) {
    const p = this._find(id);
    if (!p) return false;
    p.connected = false;
    p.input = emptyInput();
    return true;
  }

  reconnect(id) {
    const p = this._find(id);
    if (!p) return false;
    p.connected = true;
    return true;
  }

  _find(id) {
    for (let i = 0; i < this.players.length; i++) if (this.players[i].id === id) return this.players[i];
    return null;
  }

  _emit(type, data) {
    this.eventId++;
    const ev = { id: this.eventId, type, time: r2(this.time) };
    if (data) for (const k in data) ev[k] = data[k];
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return ev;
  }

  // ── 玩家：输入 / 状态 / 移动 / 耐力 ───────────────────────────────────────
  _updatePlayers(dt) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.fireCd = Math.max(0, p.fireCd - dt);
      p.dodgeCd = Math.max(0, p.dodgeCd - dt);
      p.interactCd = Math.max(0, p.interactCd - dt);
      p.pingCd = Math.max(0, p.pingCd - dt);
      p.throwCd = Math.max(0, p.throwCd - dt);
      p.blind = Math.max(0, p.blind - dt);
      p.haste = Math.max(0, p.haste - dt);
      p.spreadBloom = Math.max(0, p.spreadBloom - dt * 2.6);
      p.recoil = Math.max(0, p.recoil - dt * 3.2);
      if (!p.alive) { p.state = 'dead'; continue; }
      if (!p.connected && !p.bot) { p.input = emptyInput(); }
      if (p.downed) { this._updateDowned(p, dt); continue; }
      this._updateReload(p, dt);
      this._updateHeal(p, dt);
      if (p.car != null) { this._carActions(p); this._driveInput(p, dt); continue; }
      if (p.bot) continue; // bot 的移动/开火由 _bots 在 thinkBot 之后统一处理
      this._updateDodge(p, dt);
      if (p.dodgeTime > 0) continue;
      this._movePlayer(p, dt);
      this._handleActions(p, dt);
    }
  }

  _movePlayer(p, dt) {
    const inp = p.input;
    let mx = inp.mx, mz = inp.mz;
    const moving = mx * mx + mz * mz > 0.0004;
    let speed;
    if (inp.crouch) { p.state = 'crouch'; speed = MOVE.crouch; }
    else if (inp.sprint && p.stamina >= 1) {
      if (p.stamina > MOVE.sprintMin || p.state === 'sprint') { p.state = 'sprint'; speed = MOVE.sprint; }
      else { p.state = 'normal'; speed = MOVE.walk; }
    } else { p.state = 'normal'; speed = MOVE.walk; }
    const weapon = effectiveWeapon(p);
    if (weapon) speed *= weapon.moveMul;
    if (inp.fire) speed *= MOVE.adsMul;
    if (this.world.inWater && this.world.inWater(p.x, p.z)) speed *= MOVE.waterMul;
    if (p.haste > 0) speed *= 1.18;
    if (moving) {
      const len = Math.hypot(mx, mz) || 1;
      mx /= len; mz /= len;
      this.world.moveBody(p, mx * speed * dt, mz * speed * dt, MOVE.radius);
      if (Math.abs(inp.aim) > 0.0001) p.angle = inp.aim;
      else p.angle = wrapAngle(Math.atan2(mx, mz));
      p.moved = true;
    } else {
      p.moved = false;
      if (Math.abs(inp.aim) > 0.0001) p.angle = inp.aim;
    }
    if (p.state === 'sprint' && moving) p.stamina = Math.max(0, p.stamina - MOVE.sprintDrain * dt);
    else p.stamina = Math.min(MOVE.sprintStamina, p.stamina + MOVE.sprintRegen * dt);
  }

  _updateDodge(p, dt) {
    if (p.dodgeTime > 0) {
      p.dodgeTime = Math.max(0, p.dodgeTime - dt);
      this.world.moveBody(p, p.dodgeDx * dt, p.dodgeDz * dt, MOVE.radius);
      p.state = 'dodge';
      if (p.dodgeTime <= 0) p.state = 'normal';
      return;
    }
    if (p.input.dodge && p.dodgeCd <= 0) {
      const inp = p.input;
      let dx = inp.mx, dz = inp.mz;
      if (dx * dx + dz * dz < 0.0004) { dx = Math.sin(p.angle); dz = Math.cos(p.angle); }
      const len = Math.hypot(dx, dz) || 1;
      const speed = MOVE.dodgeDistance / MOVE.dodgeTime;
      p.dodgeDx = (dx / len) * speed;
      p.dodgeDz = (dz / len) * speed;
      p.dodgeTime = MOVE.dodgeTime;
      p.dodgeCd = MOVE.dodgeCooldown;
      p.state = 'dodge';
      p.reloadTime = 0; p.healTime = 0; p.healKind = null;
      this._emit('dodge', { player: p.id, x: r2(p.x), z: r2(p.z) });
    }
  }

  /** 主输入分派：开火 / 换弹 / 换枪 / 用药 / 交互 / 投掷 / 标记 / 救人 / 购买。 */
  _handleActions(p, dt) {
    const inp = p.input;
    if (inp.slot >= 0 && inp.slot !== p.slot) this._swapSlot(p, inp.slot);
    if (inp.swap) this._swapSlot(p, p.slot === 0 ? 1 : 0);
    if (inp.reload && p.reloadTime <= 0) this.reload(p);
    if (inp.useItem && p.healTime <= 0) this.useItem(p, inp.useItem);
    if (inp.throwable && p.throwCd <= 0) this.throwGrenade(p, inp.throwable);
    if (inp.interact && p.interactCd <= 0) this._interact(p);
    if (inp.revive) this._tryRevive(p, dt);
    else p.reviveProgress = 0;
    if (inp.ping && p.pingCd <= 0) this._ping(p, inp.pingKind);
    if (inp.buy || inp.upgrade) this._buy(p, inp.buy || inp.upgrade);
    if (p.healTime > 0 || p.reloadTime > 0) return;
    if (inp.fire) {
      const weapon = effectiveWeapon(p);
      // 非全自动武器需要重新扣扳机（bot 允许按住连点）
      if (weapon && weapon.auto === false && p.triggerHeld && !p.bot) return;
      p.triggerHeld = true;
      this.tryFire(p);
    } else {
      p.triggerHeld = false;
    }
  }

  // ── 射击 ──────────────────────────────────────────────────────────────────
  tryFire(p) {
    const slot = p.loadout[p.slot];
    const weapon = effectiveWeapon(p);
    if (!weapon || !slot || !p.alive || p.downed || p.car != null) return false;
    if (p.fireCd > 0 || p.healTime > 0 || p.dodgeTime > 0) return false;
    if (slot.ammo <= 0) { this.reload(p); return false; }
    p.fireCd = weapon.interval;
    slot.ammo--;
    p.lastFireAt = this.time;
    const moving = p.moved;
    let spread = weapon.spread * (moving ? 1.85 : 1) * (p.state === 'crouch' ? 0.62 : 1);
    spread += p.spreadBloom * weapon.spread * 1.4 + p.recoil * 0.0012;
    if (p.state === 'sprint') spread *= 1.3;
    const pellets = weapon.pellets || 1;
    const ox = p.x + Math.sin(p.angle) * 0.45;
    const oz = p.z + Math.cos(p.angle) * 0.45;
    let hits = 0;
    let lastX = ox; let lastZ = oz;
    for (let i = 0; i < pellets; i++) {
      const a = p.angle + (this.rng() * 2 - 1) * spread;
      const dx = Math.sin(a); const dz = Math.cos(a);
      const hit = this._traceShot(ox, oz, dx, dz, weapon.range, p);
      if (hit) {
        hits++;
        this._applyShotDamage(p, hit, weapon);
      }
      lastX = ox + dx * Math.min(weapon.range, hit ? hit.t : weapon.range);
      lastZ = oz + dz * Math.min(weapon.range, hit ? hit.t : weapon.range);
    }
    p.spreadBloom = Math.min(2.4, p.spreadBloom + weapon.recoil * 0.11);
    p.recoil = Math.min(9, p.recoil + weapon.recoil * 0.55);
    this.counters.shots++;
    this._emit('shot', {
      player: p.id, x: r2(ox), z: r2(oz), tx: r2(lastX), tz: r2(lastZ),
      weapon: weapon.id, hit: hits > 0, hits,
    });
    if (slot.ammo <= 0) this.reload(p);
    return true;
  }

  _traceShot(ox, oz, dx, dz, range, shooter) {
    let best = null; let bestT = range;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (q === shooter || !q.alive) continue;
      if (q.team === shooter.team && COMBAT.friendlyFire <= 0) continue;
      let radius = 0.7;
      if (q.car != null) radius = MOVE.vehicleRadius;
      else if (q.downed) radius = 0.5;
      else if (q.state === 'crouch') radius = 0.45;
      const rx = q.x - ox; const rz = q.z - oz;
      const t = rx * dx + rz * dz;
      if (t <= 0.2 || t > bestT) continue;
      const perp = Math.abs(rx * dz - rz * dx);
      if (perp > radius) continue;
      bestT = t; best = { kind: 'player', target: q, t };
    }
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.dead) continue;
      const rx = c.x - ox; const rz = c.z - oz;
      const t = rx * dx + rz * dz;
      if (t <= 0.3 || t > bestT) continue;
      const perp = Math.abs(rx * dz - rz * dx);
      if (perp > 1.6) continue;
      bestT = t; best = { kind: 'car', target: c, t };
    }
    const enemies = this.hordeRun ? this.hordeRun.enemies : null;
    if (enemies) {
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e.hp <= 0) continue;
        const rx = e.x - ox; const rz = e.z - oz;
        const t = rx * dx + rz * dz;
        if (t <= 0.2 || t > bestT) continue;
        const perp = Math.abs(rx * dz - rz * dx);
        if (perp > (e.boss ? 1.3 : 0.8)) continue;
        bestT = t; best = { kind: 'enemy', target: e, t };
      }
    }
    if (!best) return null;
    const wall = this.world.wallDistance(ox, oz, dx, dz, range);
    if (wall < best.t - 0.05) return null;
    return best;
  }

  _applyShotDamage(shooter, hit, weapon) {
    if (hit.kind === 'player') {
      const target = hit.target;
      const dist = hit.t;
      const falloff = damageAtDistance(weapon, dist);
      const mul = DIFFICULTY[shooter.difficulty]?.dmgMul || 1;
      this.damage(target, falloff * mul, shooter.id, { weapon: weapon.id, source: shooter });
      shooter.accuracy = shooter.accuracy * 0.98 + 0.02;
    } else if (hit.kind === 'car') {
      const car = hit.target;
      this._damageCar(car, damageAtDistance(weapon, hit.t), shooter);
    } else if (hit.kind === 'enemy') {
      const e = hit.target;
      const run = this.hordeRun;
      e.hp -= damageAtDistance(weapon, hit.t);
      if (e.hp <= 0 && run) {
        run.score += e.boss ? 500 : 25;
        run.credits += e.boss ? 300 : 18;
        run.kills++;
        this._emit('enemyDown', { id: e.id, boss: e.boss, wave: run.wave });
        if (run.enemies.every((x) => x.hp <= 0)) {
          run.nextWaveIn = HORDE.prepTime;
          run.prepTime = HORDE.prepTime;
          run.score += 100 + run.wave * 25;
          run.credits += 120 + run.wave * 30;
          this._emit('waveClear', { wave: run.wave });
        }
      }
    }
  }

  // ── 伤害 / 倒地 / 淘汰 ────────────────────────────────────────────────────
  damage(target, amount, sourceId = null, opts = {}) {
    if (!target || !target.alive || !(amount > 0)) return 0;
    const src = opts.source || (sourceId ? this._find(sourceId) : null);
    let dmg = amount;
    if (target.downed) {
      const d = dmg * COMBAT.downedDamageMul;
      target.downedHp -= d;
      target.lastHitBy = sourceId;
      if (target.downedHp <= 0) this.kill(target, sourceId, 'bleed');
      return d;
    }
    if (target.shield > 0) {
      const s = Math.min(target.shield, dmg);
      target.shield -= s; dmg -= s;
    }
    if (dmg > 0 && target.armor > 0 && target.armorTier > 0) {
      const def = armorForTier(target.armorTier);
      const absorb = def?.absorb ?? COMBAT.armorBaseAbsorb;
      const room = target.armor / COMBAT.armorDurabilityLoss;
      let absorbed = Math.min(room, dmg * absorb, dmg * 0.6);
      absorbed = Math.min(absorbed, dmg);
      target.armor = Math.max(0, target.armor - absorbed * COMBAT.armorDurabilityLoss);
      dmg -= absorbed;
      if (target.armor <= 0.01) { target.armor = 0; target.armorTier = 0; }
    }
    target.hp = Math.max(0, target.hp - dmg);
    target.lastHitBy = sourceId;
    target.lastHitAt = this.time;
    if (src && src !== target) src.damage += Math.min(dmg, amount);
    if (target.hp <= 0) {
      const mates = this._teamMates(target).filter((m) => m !== target && m.alive && !m.downed);
      const canDown = !opts.noDown && this.teamSize > 1 && mates.length > 0 && this.mode !== 'solo'
        && this.mode !== 'training' && !this.hordeMode;
      if (canDown) this._downPlayer(target, sourceId);
      else this.kill(target, sourceId, 'shot');
    }
    return dmg;
  }

  heal(target, amount) {
    if (!target || !target.alive) return 0;
    const before = target.hp;
    target.hp = Math.min(COMBAT.maxHp, target.hp + amount);
    return target.hp - before;
  }

  _downPlayer(p, sourceId) {
    p.downed = true;
    p.hp = 0;
    p.downedHp = 100;
    p.bleedout = BLEEDOUT_TIME;
    p.downedAt = this.time;
    p.state = 'downed';
    p.reviveProgress = 0;
    p.reviveTarget = null;
    p.reloadTime = 0; p.healTime = 0; p.healKind = null;
    if (p.car != null) this._exitCar(p, true);
    this._emit('down', { player: p.id, by: sourceId, team: p.team, x: r2(p.x), z: r2(p.z) });
  }

  kill(target, sourceId = null, reason = 'shot') {
    if (!target || !target.alive) return false;
    target.alive = false;
    target.downed = false;
    target.hp = 0;
    target.state = 'dead';
    target.deadAt = this.time;
    target.bleedout = 0;
    target.reviveProgress = 0;
    if (target.car != null) this._exitCar(target, true);
    const src = sourceId ? this._find(sourceId) : null;
    if (src && src !== target && src.team !== target.team) {
      src.kills++;
      src.score += 100;
    }
    this.counters.kills++;
    this._emit('kill', {
      player: target.id, by: sourceId, reason, team: target.team,
      x: r2(target.x), z: r2(target.z), name: target.name,
    });
    this._checkTeamWipe();
    return true;
  }

  /** 测试/客户端复活钩子：把倒地或阵亡的玩家拉回战场。 */
  revive(target) {
    if (!target) return false;
    target.alive = true;
    target.downed = false;
    target.downedHp = 100;
    target.bleedout = 0;
    target.hp = REVIVE_HP;
    target.reviveProgress = 0;
    target.reviveTarget = null;
    target.state = 'normal';
    target.deadAt = 0;
    return true;
  }

  _teamMates(p) {
    const out = [];
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (q.team === p.team && q !== p) out.push(q);
    }
    return out;
  }

  _aliveTeamSet() {
    const set = new Set();
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (q.alive || q.downed) set.add(q.team);
    }
    return set;
  }

  _assignRank(team) {
    const alive = this._aliveTeamSet();
    const rank = alive.size + 1;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (q.team === team && (!q.rank || q.rank < 1)) q.rank = rank;
    }
    return rank;
  }

  _checkTeamWipe() {
    if (this.phase === 'ended') return;
    const alive = this._aliveTeamSet();
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (!q.alive && !q.downed && (!q.rank || q.rank < 1)) {
        const matesAlive = this._teamMates(q).some((m) => m.alive || m.downed);
        if (!matesAlive) this._assignRank(q.team);
      }
    }
    if (alive.size <= 1 && this.players.length > 1 && !this.hordeMode) {
      const winner = alive.size === 1 ? [...alive][0] : null;
      this.end('lastTeam', winner);
    }
  }

  // ── 换弹 / 切枪 / 消耗品 ──────────────────────────────────────────────────
  reload(p) {
    const slot = p.loadout[p.slot];
    const weapon = effectiveWeapon(p);
    if (!slot || !weapon || p.reloadTime > 0) return false;
    const need = weapon.magazine - slot.ammo;
    if (need <= 0) return false;
    if ((p.mags[weapon.ammo] || 0) <= 0) return false;
    p.reloadTime = weapon.reload;
    p.healTime = 0; p.healKind = null;
    this._emit('reload', { player: p.id, weapon: weapon.id, time: r2(weapon.reload) });
    return true;
  }

  _updateReload(p, dt) {
    if (p.reloadTime <= 0) return;
    p.reloadTime = Math.max(0, p.reloadTime - dt);
    if (p.reloadTime > 0) return;
    const slot = p.loadout[p.slot];
    const weapon = effectiveWeapon(p);
    if (!slot || !weapon) return;
    const need = weapon.magazine - slot.ammo;
    const pool = p.mags[weapon.ammo] || 0;
    const take = Math.min(need, pool);
    if (take > 0) {
      slot.ammo += take;
      p.mags[weapon.ammo] = pool - take;
      this._emit('reloaded', { player: p.id, weapon: weapon.id, ammo: slot.ammo, reserve: p.mags[weapon.ammo] });
    }
  }

  _swapSlot(p, idx) {
    if (idx !== 0 && idx !== 1) return false;
    if (!p.loadout[idx] || idx === p.slot) return false;
    p.slot = idx;
    p.fireCd = Math.max(p.fireCd, 0.35);
    p.reloadTime = 0;
    p.spreadBloom = 0;
    this._emit('swap', { player: p.id, slot: idx, weapon: p.loadout[idx].type });
    return true;
  }

  useItem(p, kind) {
    const def = CONSUMABLES[kind];
    if (!def || !p.alive || p.downed || p.car != null) return false;
    if (p.healTime > 0 || p.reloadTime > 0) return false;
    if (!this._countOf(p, kind)) return false;
    p.healTime = def.use;
    p.healTotal = def.use;
    p.healKind = kind;
    this._emit('healStart', { player: p.id, item: kind, time: r2(def.use) });
    return true;
  }

  _countOf(p, kind) {
    if (kind === 'bandage') return p.bandages;
    if (kind === 'medkit') return p.meds;
    if (kind === 'energy') return p.energy;
    if (kind === 'shield') return p.shields;
    return 0;
  }

  _takeOne(p, kind) {
    if (kind === 'bandage') p.bandages = Math.max(0, p.bandages - 1);
    else if (kind === 'medkit') p.meds = Math.max(0, p.meds - 1);
    else if (kind === 'energy') p.energy = Math.max(0, p.energy - 1);
    else if (kind === 'shield') p.shields = Math.max(0, p.shields - 1);
  }

  _updateHeal(p, dt) {
    if (p.healTime <= 0) return;
    if (p.moved) {
      p.healTime = 0; p.healKind = null;
      this._emit('healCancel', { player: p.id });
      return;
    }
    p.healTime = Math.max(0, p.healTime - dt);
    if (p.healTime > 0) return;
    const kind = p.healKind;
    p.healKind = null;
    const def = CONSUMABLES[kind];
    if (!def || !this._countOf(p, kind)) return;
    this._takeOne(p, kind);
    if (def.heal) this.heal(p, def.heal);
    if (def.shield) p.shield = Math.min(COMBAT.maxShield, p.shield + def.shield);
    if (def.haste) { p.haste = def.hasteTime || 12; }
    this._emit('healed', { player: p.id, item: kind, hp: r2(p.hp), shield: r2(p.shield) });
  }

  // ── 投掷物 ────────────────────────────────────────────────────────────────
  _throwCount(p, kind) {
    if (kind === 'frag') return p.grenades;
    if (kind === 'smoke') return p.smokes;
    if (kind === 'flash') return p.flashes;
    if (kind === 'molotov') return p.molotovs;
    return 0;
  }

  _takeThrowable(p, kind) {
    if (kind === 'frag') p.grenades = Math.max(0, p.grenades - 1);
    else if (kind === 'smoke') p.smokes = Math.max(0, p.smokes - 1);
    else if (kind === 'flash') p.flashes = Math.max(0, p.flashes - 1);
    else if (kind === 'molotov') p.molotovs = Math.max(0, p.molotovs - 1);
  }

  throwGrenade(p, kind) {
    const def = THROWABLES[kind];
    if (!def || !p.alive || p.downed || p.throwCd > 0) return false;
    if (!this._throwCount(p, kind)) return false;
    if (this.grenades.length >= MAX_GRENADES) return false;
    this._takeThrowable(p, kind);
    p.throwCd = 0.6;
    const inp = p.input;
    let tx = p.x + Math.sin(p.angle) * 18;
    let tz = p.z + Math.cos(p.angle) * 18;
    if (inp.mx * inp.mx + inp.mz * inp.mz > 0.01 && !(Math.abs(Math.atan2(inp.mx, inp.mz) - p.angle) < 0.25 && inp.mx !== 0)) {
      const len = Math.hypot(inp.mx, inp.mz);
      tx = p.x + (inp.mx / len) * 14;
      tz = p.z + (inp.mz / len) * 14;
    }
    const wall = this.world.wallDistance(p.x, p.z, (tx - p.x) / 14 || 0, (tz - p.z) / 14 || 0, 14);
    const travel = Math.max(2.5, Math.min(14, wall - 0.6));
    const dirLen = Math.hypot(tx - p.x, tz - p.z) || 1;
    tx = p.x + ((tx - p.x) / dirLen) * travel;
    tz = p.z + ((tz - p.z) / dirLen) * travel;
    this.grenades.push({
      id: `g${++this.entityId}`, kind, x: p.x, z: p.z, y: 1.2,
      tx, tz, vx: 0, vz: 0, fly: 0.75, ttl: def.fuse, team: p.team, owner: p.id,
      radius: def.radius || 6,
    });
    this._emit('throw', { player: p.id, kind, x: r2(p.x), z: r2(p.z), tx: r2(tx), tz: r2(tz) });
    return true;
  }

  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      if (g.fly > 0) {
        g.fly = Math.max(0, g.fly - dt);
        const k = 1 - g.fly / 0.75;
        g.x = g.x + (g.tx - g.x) * Math.min(1, dt * 5);
        g.z = g.z + (g.tz - g.z) * Math.min(1, dt * 5);
        g.y = 1.2 + Math.sin(k * Math.PI) * 2.2;
      } else {
        g.y = Math.max(0.15, g.y - dt * 4);
      }
      g.ttl -= dt;
      if (g.ttl > 0) continue;
      this.grenades.splice(i, 1);
      this._detonate(g);
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.ttl -= dt;
      if (s.ttl <= 0) { this.smokes.splice(i, 1); this._emit('smokeEnd', { id: s.id }); }
    }
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.ttl -= dt;
      if (f.ttl <= 0) { this.fires.splice(i, 1); continue; }
      f.tick = (f.tick || 0) + dt;
      if (f.tick < 0.5) continue;
      f.tick = 0;
      for (let k = 0; k < this.players.length; k++) {
        const q = this.players[k];
        if (!q.alive || q.downed) continue;
        if (dist(q.x, q.z, f.x, f.z) <= f.r) {
          this.damage(q, THROWABLES.molotov.burn * 0.5, f.owner, { source: this._find(f.owner) });
        }
      }
    }
  }

  _detonate(g) {
    const def = THROWABLES[g.kind];
    if (!def) return;
    const owner = this._find(g.owner);
    if (g.kind === 'frag') {
      const radius = def.radius || 8;
      for (let i = 0; i < this.players.length; i++) {
        const q = this.players[i];
        if (!q.alive) continue;
        const d = dist(q.x, q.z, g.x, g.z);
        if (d > radius) continue;
        const blocked = !this.world.clearLine({ x: g.x, z: g.z }, { x: q.x, z: q.z });
        const falloff = Math.max(0.2, 1 - (d / (radius * 0.95)));
        let dmg = def.damage * falloff * (blocked ? 0.45 : 1);
        if (q.id === g.owner) dmg *= 0.5;
        this.damage(q, dmg, g.owner, { source: owner, noDown: true });
      }
      this._emit('explosion', { id: g.id, kind: 'frag', x: r2(g.x), z: r2(g.z), r: radius });
    } else if (g.kind === 'smoke') {
      this.smokes.push({
        id: `s${++this.entityId}`, x: g.x, z: g.z, r: def.radius || 7, ttl: def.duration || 16,
      });
      this._emit('smoke', { id: `s${this.entityId}`, x: r2(g.x), z: r2(g.z), r: def.radius || 7 });
    } else if (g.kind === 'flash') {
      for (let i = 0; i < this.players.length; i++) {
        const q = this.players[i];
        if (!q.alive) continue;
        const d = dist(q.x, q.z, g.x, g.z);
        if (d > (def.radius || 10)) continue;
        if (!this.world.clearLine({ x: g.x, z: g.z }, { x: q.x, z: q.z })) continue;
        const facing = Math.abs(wrapAngle(Math.atan2(g.x - q.x, g.z - q.z) - q.angle));
        const mul = facing < 1.1 ? 1 : 0.45;
        q.blind = Math.max(q.blind, (def.blind || 2.6) * mul * (1 - d / (def.radius || 10) * 0.5));
      }
      this._emit('flash', { id: g.id, x: r2(g.x), z: r2(g.z), r: def.radius || 10 });
    } else if (g.kind === 'molotov') {
      this.fires.push({
        id: `f${++this.entityId}`, x: g.x, z: g.z, r: def.radius || 6,
        ttl: def.duration || 9, owner: g.owner, tick: 0,
      });
      this._emit('fire', { id: `f${this.entityId}`, x: r2(g.x), z: r2(g.z), r: def.radius || 6 });
    }
  }

  // ── 载具 ──────────────────────────────────────────────────────────────────
  _carById(id) {
    for (let i = 0; i < this.cars.length; i++) if (this.cars[i].id === id) return this.cars[i];
    return null;
  }

  _nearestCar(p, range = 3.8) {
    let best = null; let bestD = range;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.dead) continue;
      const d = dist(p.x, p.z, c.x, c.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  _interact(p) {
    p.interactCd = 0.35;
    if (p.car != null) { this._exitCar(p, false); p.interactCd = 0.6; return; }
    const car = this._nearestCar(p);
    if (car) {
      if (this._enterCar(p, car)) { p.interactCd = 0.6; return; }
    }
    for (let i = 0; i < this.loot.length; i++) {
      const l = this.loot[i];
      if (l.taken) continue;
      if (dist(p.x, p.z, l.x, l.z) > 1.8) continue;
      if (this._pickup(p, l)) { p.interactCd = 0.25; return; }
    }
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (d.opened || d.landsIn > 0) continue;
      if (dist(p.x, p.z, d.x, d.z) > 2.6) continue;
      this._openDrop(d, p);
      p.interactCd = 0.6;
      return;
    }
  }

  _pickup(p, l) {
    if (l.kind === 'weapon') {
      const slot = p.slot === 0 && !p.loadout[0] ? 0 : p.slot;
      const idx = p.loadout[0] ? (p.loadout[1] ? slot : 1) : 0;
      if (p.loadout[idx]) return false;
      const w = getWeapon(l.item);
      p.loadout[idx] = {
        type: l.item, ammo: l.ammo ?? w.magazine,
        attachments: Array.isArray(l.attachments) ? l.attachments.slice() : [], _eff: null,
      };
      l.taken = true;
      this._emit('pickup', { player: p.id, item: l.item, kind: l.kind });
      return true;
    }
    if (l.kind === 'ammo') {
      const key = l.item;
      if (!AMMO_TYPES[key]) return false;
      const cap = Math.round(AMMO_TYPES[key].cap * (BACKPACKS[p.backpack]?.ammoCap || 1));
      if ((p.mags[key] || 0) >= cap) return false;
      p.mags[key] = Math.min(cap, (p.mags[key] || 0) + (l.qty || 12));
      l.taken = true;
      this._emit('pickup', { player: p.id, item: key, kind: 'ammo' });
      return true;
    }
    if (l.kind === 'armor') {
      const def = ARMORS[l.item];
      if (!def || def.tier <= p.armorTier) return false;
      p.armorTier = def.tier;
      p.armor = def.durability;
      l.taken = true;
      this._emit('pickup', { player: p.id, item: l.item, kind: 'armor' });
      return true;
    }
    if (l.kind === 'backpack') {
      if (BACKPACKS[l.item]) p.backpack = l.item;
      l.taken = true;
      return true;
    }
    const qty = l.qty || 1;
    if (l.kind === 'consumable') {
      if (l.item === 'bandage') p.bandages = Math.min(24, p.bandages + qty);
      else if (l.item === 'medkit' || l.item === 'med') p.meds = Math.min(12, p.meds + qty);
      else if (l.item === 'energy') p.energy = Math.min(12, p.energy + qty);
      else if (l.item === 'shield') p.shields = Math.min(9, p.shields + qty);
      else return false;
    } else if (l.kind === 'throwable') {
      if (l.item === 'frag') p.grenades = Math.min(12, p.grenades + qty);
      else if (l.item === 'smoke') p.smokes = Math.min(12, p.smokes + qty);
      else if (l.item === 'flash') p.flashes = Math.min(9, p.flashes + qty);
      else if (l.item === 'molotov') p.molotovs = Math.min(9, p.molotovs + qty);
      else return false;
    } else if (l.kind === 'attachment') {
      const slot = p.loadout[p.slot];
      if (!slot) return false;
      const att = ATTACHMENTS[l.item];
      if (!att) return false;
      if (slot.attachments.length >= 4) return false;
      slot.attachments.push(l.item);
      slot._eff = null;
    } else return false;
    l.taken = true;
    this._emit('pickup', { player: p.id, item: l.item, kind: l.kind });
    return true;
  }

  _enterCar(p, car) {
    const seats = car.seats | 0;
    for (let s = 0; s < seats; s++) {
      if (car.occupants[s] != null) continue;
      const occ = this._find(car.occupants[s]);
      if (occ) continue;
    }
    let seat = -1;
    for (let s = 0; s < seats; s++) if (!car.occupants[s]) { seat = s; break; }
    if (seat < 0) return false;
    if (p.reloadTime > 0) { p.reloadTime = 0; }
    if (p.healTime > 0) { p.healTime = 0; p.healKind = null; }
    car.occupants[seat] = p.id;
    p.car = car.id;
    p.seat = seat;
    p.state = 'vehicle';
    p.x = car.x; p.z = car.z;
    if (seat === 0) car.driver = p.id;
    this._emit('vehicle', { action: 'enter', player: p.id, car: car.id, seat });
    return true;
  }

  _exitCar(p, force) {
    const car = p.car ? this._carById(p.car) : null;
    if (!car) { p.car = null; p.seat = -1; p.state = 'normal'; return false; }
    const seat = p.seat;
    if (seat >= 0) car.occupants[seat] = null;
    if (car.driver === p.id) {
      car.driver = null;
      for (let s = 0; s < car.seats; s++) {
        const mate = car.occupants[s] ? this._find(car.occupants[s]) : null;
        if (mate && mate.alive) { car.driver = mate.id; mate.seat = s; break; }
      }
    }
    let ox = car.x + Math.sin(car.angle + Math.PI / 2) * 2.2;
    let oz = car.z + Math.cos(car.angle + Math.PI / 2) * 2.2;
    if (this.world.blocked(ox, oz, MOVE.radius)) {
      ox = car.x - Math.sin(car.angle + Math.PI / 2) * 2.2;
      oz = car.z - Math.cos(car.angle + Math.PI / 2) * 2.2;
    }
    if (!this.world.blocked(ox, oz, MOVE.radius)) { p.x = ox; p.z = oz; }
    p.car = null; p.seat = -1;
    p.state = 'normal';
    this._emit('vehicle', { action: 'exit', player: p.id, car: car.id, seat, force: !!force });
    return true;
  }

  /** 车内动作：下车 / 换枪 / 换弹 / 用药 / 购买（驾驶与射击在 _driveInput）。 */
  _carActions(p) {
    const inp = p.input;
    if (inp.interact && p.interactCd <= 0) {
      this._exitCar(p, false);
      p.interactCd = 0.8;
      return;
    }
    if (inp.slot >= 0 && inp.slot !== p.slot) this._swapSlot(p, inp.slot);
    if (inp.swap) this._swapSlot(p, p.slot === 0 ? 1 : 0);
    if (inp.reload && p.reloadTime <= 0) this.reload(p);
    if (inp.buy || inp.upgrade) this._buy(p, inp.buy || inp.upgrade);
  }

  _driveInput(p, dt) {
    const car = this._carById(p.car);
    if (!car) { p.car = null; p.seat = -1; return; }
    p.x = car.x; p.z = car.z;
    if (Math.abs(p.input.aim) > 0.0001) p.angle = p.input.aim;
    if (car.driver !== p.id) {
      if (p.input.fire && p.fireCd <= 0) this.tryFireVehicle(p, car);
      return;
    }
    const def = CARS[car.type] || CARS.jeep;
    const throttle = clamp(p.input.mz, -1, 1);
    const steer = clamp(p.input.mx, -1, 1);
    car.speed += (throttle * def.speed - car.speed) * Math.min(1, dt * 3.2);
    if (Math.abs(car.speed) < 0.05) car.speed = 0;
    car.angle = wrapAngle(car.angle + steer * dt * (0.8 + Math.abs(car.speed) * 0.05));
    const nx = car.x + Math.sin(car.angle) * car.speed * dt;
    const nz = car.z + Math.cos(car.angle) * car.speed * dt;
    if (this.world.blocked(nx, nz, 1.9)) { car.speed *= -0.25; }
    else { car.x = nx; car.z = nz; }
    for (let s = 0; s < car.seats; s++) {
      const q = car.occupants[s] ? this._find(car.occupants[s]) : null;
      if (q) { q.x = car.x; q.z = car.z; }
    }
    car.hitCd = Math.max(0, car.hitCd - dt);
    if (Math.abs(car.speed) > 4 && car.hitCd <= 0) {
      for (let i = 0; i < this.players.length; i++) {
        const q = this.players[i];
        if (!q.alive || q.car != null) continue;
        if (car.occupants.includes(q.id)) continue;
        if (dist(q.x, q.z, car.x, car.z) > 2.2) continue;
        this.damage(q, Math.abs(car.speed) * 3.4, car.driver, {});
        car.hitCd = 0.45;
        this._emit('vehicle', { action: 'hit', car: car.id, player: q.id, speed: r2(car.speed) });
      }
      this._damageCar(car, Math.abs(car.speed) * 0.35, null);
    }
  }

  tryFireVehicle(p, car) {
    const weapon = effectiveWeapon(p);
    if (!weapon || p.fireCd > 0) return false;
    p.fireCd = weapon.interval;
    p.spreadBloom = Math.min(2.4, p.spreadBloom + weapon.recoil * 0.11);
    this._emit('shot', {
      player: p.id, x: r2(p.x), z: r2(p.z),
      tx: r2(p.x + Math.sin(p.angle) * 12), tz: r2(p.z + Math.cos(p.angle) * 12),
      weapon: weapon.id, hit: false, vehicle: true,
    });
    return true;
  }

  _damageCar(car, amount, shooter) {
    if (!car || car.dead || !(amount > 0)) return;
    car.hp -= amount;
    if (shooter) this._emit('vehicle', { action: 'damage', car: car.id, hp: r2(car.hp) });
    if (car.hp <= 0) this._explodeCar(car, shooter);
  }

  _explodeCar(car, shooter) {
    car.dead = true;
    car.hp = 0;
    car.speed = 0;
    const riderIds = car.occupants.slice();
    for (let s = 0; s < riderIds.length; s++) {
      const q = riderIds[s] ? this._find(riderIds[s]) : null;
      if (q) { this._exitCar(q, true); this.damage(q, 55, null, { noDown: true }); }
    }
    car.occupants.fill(null);
    car.driver = null;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (!q.alive || q.car != null) continue;
      const d = dist(q.x, q.z, car.x, car.z);
      if (d > 6) continue;
      this.damage(q, 70 * (1 - d / 6), shooter ? shooter.id : null, { noDown: true });
    }
    this._emit('vehicle', { action: 'explode', car: car.id, x: r2(car.x), z: r2(car.z) });
  }

  _updateCars(dt) {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.dead) continue;
      c.hitCd = Math.max(0, c.hitCd - dt);
      if (c.driver) continue;
      c.speed *= 0.92;
      if (Math.abs(c.speed) < 0.05) c.speed = 0;
    }
  }

  // ── 缩圈 / 空投 / 倒地救援 ────────────────────────────────────────────────
  _updateZones(dt) {
    const z = this.zone;
    if (!z) return;
    if (this.hordeMode || this.mode === 'training') {
      this._applyZoneDamage(dt, 0);
      return;
    }
    z.nextIn = Math.max(0, z.nextIn - dt);
    const total = ZONE_FIRST_WAIT + ZONE_PHASES.reduce((a, p) => a + p.wait + p.shrink, 0);
    if (!z.closing && z.nextIn <= 0) {
      const idx = z.phase + 1;
      if (idx < ZONE_PHASES.length) {
        const phase = ZONE_PHASES[idx];
        const worldR = this.world.radius || 182;
        const nextR = Math.max(8, worldR * phase.ratio);
        const room = Math.max(0, z.r - nextR) * 0.7;
        const a = this.rng() * TAU;
        z.phase = idx;
        z.from = { x: z.x, z: z.z, r: z.r };
        z.target = {
          x: r2(clamp(z.x + Math.cos(a) * room, -worldR * 0.5, worldR * 0.5)),
          z: r2(clamp(z.z + Math.sin(a) * room, -worldR * 0.5, worldR * 0.5)),
          r: r2(nextR),
        };
        z.closing = true;
        z.t = 0;
        z.damage = phase.damage;
        this._emit('zone', {
          phase: idx, x: z.target.x, z: z.target.z, r: z.target.r,
          damage: phase.damage, closing: true, wait: phase.wait, shrink: phase.shrink,
        });
      }
    }
    if (z.closing) {
      const phase = ZONE_PHASES[z.phase] || ZONE_PHASES[ZONE_PHASES.length - 1];
      const dur = Math.max(0.01, phase.shrink);
      z.t = Math.min(dur, z.t + dt);
      const k = z.t / dur;
      const from = z.from || { x: z.x, z: z.z, r: z.r };
      z.x = from.x + (z.target.x - from.x) * k;
      z.z = from.z + (z.target.z - from.z) * k;
      z.r = from.r + (z.target.r - from.r) * k;
      z.nextIn = Math.max(0, dur - z.t) + (ZONE_PHASES[z.phase + 1]?.wait ?? 12);
      if (z.t >= dur) {
        z.x = z.target.x; z.z = z.target.z; z.r = z.target.r;
        z.closing = false;
        z.nextIn = ZONE_PHASES[z.phase + 1]?.wait ?? 12;
        z.from = null;
        this._emit('zone', { phase: z.phase, x: r2(z.x), z: r2(z.z), r: r2(z.r), closed: true });
      }
    }
    z.totalTime = total;
    const dmg = z.closing ? (ZONE_PHASES[z.phase]?.damage || 0) : (z.phase >= 0 ? (ZONE_PHASES[z.phase]?.damage || 0) : 0);
    this._applyZoneDamage(dt, dmg);
  }

  _applyZoneDamage(dt, dmg) {
    const z = this.zone;
    if (!z) return;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (!q.alive) continue;
      if (dist(q.x, q.z, z.x, z.z) <= z.r) { q.zoneTick = 0; continue; }
      if (!(dmg > 0)) continue;
      q.zoneTick = (q.zoneTick || 0) + dt;
      if (q.zoneTick < 1) continue;
      q.zoneTick = 0;
      this.damage(q, dmg, null, { noDown: true, zone: true });
    }
  }

  _updateDrops(dt) {
    if (this.phase === 'live' && this.dropsLeft > 0 && this.time >= this.nextDrop) {
      this._spawnDrop();
      this.dropsLeft--;
      this.nextDrop = this.time + 75;
    }
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (d.landsIn > 0) {
        d.landsIn = Math.max(0, d.landsIn - dt);
        d.y = Math.max(0, 90 * (d.landsIn / 12));
        if (d.landsIn <= 0) { d.y = 0; this._emit('dropLanded', { id: d.id, x: r2(d.x), z: r2(d.z) }); }
      }
    }
  }

  _spawnDrop() {
    const r = Math.max(20, (this.zone?.r || 160) * 0.7);
    const a = this.rng() * TAU;
    const rr = Math.sqrt(this.rng()) * r;
    const x = (this.zone?.x || 0) + Math.cos(a) * rr;
    const z = (this.zone?.z || 0) + Math.sin(a) * rr;
    const drop = {
      id: `d${++this.entityId}`, x, z, y: 90, landsIn: 12, opened: false, items: [],
    };
    this.drops.push(drop);
    this._emit('drop', { id: drop.id, x: r2(x), z: r2(z) });
    return drop;
  }

  _openDrop(drop, p) {
    drop.opened = true;
    const items = buildAirdropLoot(this.rng);
    for (let i = 0; i < items.length && this.loot.length < MAX_LOOT; i++) {
      const e = items[i];
      const entry = this.addLoot(e.kind, e.item, drop.x + (this.rng() - 0.5) * 2.4,
        drop.z + (this.rng() - 0.5) * 2.4, e);
      if (entry) entry.drop = drop.id;
    }
    this._emit('dropOpen', { id: drop.id, player: p ? p.id : null });
    return true;
  }

  _updateDowned(p, dt) {
    p.bleedout = Math.max(0, p.bleedout - dt);
    p.state = 'downed';
    const inp = p.input;
    if (inp.mx * inp.mx + inp.mz * inp.mz > 0.0004) {
      const len = Math.hypot(inp.mx, inp.mz);
      this.world.moveBody(p, (inp.mx / len) * MOVE.downed * dt, (inp.mz / len) * MOVE.downed * dt, MOVE.radius);
    }
    if (inp.revive) this._tryRevive(p, dt);
    if (p.bleedout <= 0) { this.kill(p, p.lastHitBy, 'bleedout'); return; }
    if (p.reviveTarget) {
      const helper = this._find(p.reviveTarget);
      if (!helper || !helper.alive || !helper.input.revive || helper.moved) {
        p.reviveProgress = 0;
        p.reviveTarget = null;
      }
    }
  }

  _tryRevive(p, dt) {
    if (!p.alive || p.downed) return false;
    let target = null; let bestD = REVIVE_RANGE;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (!q.downed || q.team !== p.team || !q.alive) continue;
      const d = dist(p.x, p.z, q.x, q.z);
      if (d < bestD) { bestD = d; target = q; }
    }
    if (!target) return false;
    if (p.moved) { target.reviveProgress = 0; return false; }
    target.reviveTarget = p.id;
    target.reviveProgress += dt;
    if (target.reviveProgress >= REVIVE_TIME) {
      this.revive(target);
      this._emit('revived', { player: target.id, by: p.id });
    }
    return true;
  }

  _ping(p, kind) {
    if (this.pings.length > 80) this.pings.shift();
    p.pingCd = 1.2;
    this.pings.push({
      id: `p${++this.entityId}`, team: p.team,
      x: p.x + Math.sin(p.angle) * 6, z: p.z + Math.cos(p.angle) * 6,
      kind: PING_KINDS.includes(kind) ? kind : 'move', ttl: 6,
    });
  }

  _updatePings(dt) {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      this.pings[i].ttl -= dt;
      if (this.pings[i].ttl <= 0) this.pings.splice(i, 1);
    }
  }

  _checkEnd(dt) {
    if (this.phase === 'ended') return;
    if (this.pings.length) this._updatePings(dt);
    if (this.hordeMode) return;
    if (this.time >= this.duration) {
      const teams = this._teamRanks();
      this.end('timeout', teams.length ? teams[0].team : null);
      return;
    }
    const alive = this._aliveTeamSet();
    if (this.players.length > 1 && alive.size <= 1) {
      this.end('lastTeam', alive.size ? [...alive][0] : null);
    }
  }

  _teamRanks() {
    const map = new Map();
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      const cur = map.get(q.team);
      const alive = q.alive || q.downed;
      if (!cur) {
        map.set(q.team, {
          team: q.team, alive: alive ? 1 : 0, kills: q.kills, damage: q.damage,
          members: [q.name], best: alive ? 2 : 1,
        });
      } else {
        if (alive) cur.alive++;
        cur.kills += q.kills; cur.damage += q.damage; cur.members.push(q.name);
        if (alive) cur.best = Math.max(cur.best, 2);
      }
    }
    const list = [...map.values()];
    list.sort((a, b) => (b.alive - a.alive) || (b.kills - a.kills) || (b.damage - a.damage) || (a.team - b.team));
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      out.push({
        team: e.team, rank: i + 1, name: this.teamName(e.team), alive: e.alive,
        kills: e.kills, damage: r2(e.damage), players: e.members.slice(0, 8),
      });
    }
    return out;
  }

  end(reason = 'lastTeam', winner = null) {
    if (this.phase === 'ended') return false;
    this.phase = 'ended';
    this.time = Math.min(this.time, this.duration);
    let winTeam = winner;
    if (winTeam == null) {
      const alive = this._aliveTeamSet();
      winTeam = alive.size ? [...alive][0] : (this.players[0]?.team ?? null);
    }
    this.winnerTeam = winTeam;
    this.resultReason = reason;
    const ranks = this._teamRanks();
    for (let i = 0; i < ranks.length; i++) {
      const rk = ranks[i];
      for (let k = 0; k < this.players.length; k++) {
        const q = this.players[k];
        if (q.team === rk.team) q.rank = rk.rank;
      }
    }
    for (let i = 0; i < this.players.length; i++) {
      if (!this.players[i].rank) this.players[i].rank = ranks.length + 1;
    }
    this.result = {
      winnerTeam: winTeam, winnerName: this.teamName(winTeam), reason, ranks,
      duration: r2(this.matchTime), players: this.players.length,
    };
    this._emit('end', { winnerTeam: winTeam, reason, ranks: ranks.slice(0, 8) });
    return true;
  }

  spawnWave(n = 1, count = 6) {
    if (!this.hordeRun) return 0;
    return this._spawnEnemies(count, n);
  }

  // ── horde（PvE 波次） ─────────────────────────────────────────────────────
  _startHorde() {
    const spot = this.world.spawnAnchors[0] || { x: 0, z: 0 };
    const base = { x: spot.x, z: spot.z, hp: HORDE.baseHp, maxHp: HORDE.baseHp, turrets: 0 };
    this.hordeRun = {
      wave: 0, totalWaves: HORDE.waves, prepTime: HORDE.prepTime, base,
      score: 0, credits: 400, enemies: [], boss: false, bossSpawned: false,
      nextWaveIn: HORDE.prepTime, kills: 0,
    };
    this.enemies = this.hordeRun.enemies;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.loadout = [null, null];
      this._applyLoadout(p, [{ type: 'ak12' }, { type: 'p9' }]);
      p.mags = { light: 180, medium: 200, heavy: 60, shell: 30, bolt: 20 };
      p.armorTier = 2; p.armor = ARMORS.armor2.durability;
      p.shield = 100; p.meds = 3; p.bandages = 5; p.energy = 2; p.shields = 2;
      p.grenades = 3; p.smokes = 1; p.flashes = 1; p.molotovs = 1;
      this._spawnPlayer(p);
      p.x = base.x + Math.cos(i * 1.1) * 4; p.z = base.z + Math.sin(i * 1.1) * 4;
    }
    this.phase = 'live';
    this.time = 0; this.matchTime = 0;
    this.zone = { x: base.x, z: base.z, r: 120, target: { x: base.x, z: base.z, r: 120 }, closing: false, damage: 0, phase: -1, nextIn: 0 };
    this._emit('hordeStart', { waves: HORDE.waves, baseX: r2(base.x), baseZ: r2(base.z) });
    return true;
  }

  _spawnEnemies(count, wave) {
    const run = this.hordeRun;
    if (!run) return 0;
    const base = run.base;
    const hpMul = Math.pow(HORDE.hpPerWave, Math.max(0, wave - 1));
    const dmgMul = Math.pow(HORDE.dmgPerWave, Math.max(0, wave - 1));
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const a = (i / Math.max(1, count)) * TAU + this.rng() * 0.5;
      let x = base.x + Math.cos(a) * 38;
      let z = base.z + Math.sin(a) * 38;
      let tries = 0;
      while (this.world.blocked(x, z, 0.8) && tries++ < 24) {
        const a2 = this.rng() * TAU;
        const rr = 26 + this.rng() * 18;
        x = base.x + Math.cos(a2) * rr;
        z = base.z + Math.sin(a2) * rr;
      }
      if (this.world.blocked(x, z, 0.8)) continue;
      const boss = wave >= HORDE.bossWave && i === 0 && !run.bossSpawned;
      const hp = (boss ? 1400 : 90) * hpMul;
      run.enemies.push({
        id: `e${++this.entityId}`, x, z, angle: Math.atan2(base.x - x, base.z - z),
        hp, maxHp: hp, speed: boss ? 2.4 : 3.1 + Math.min(1.4, wave * 0.1),
        damage: (boss ? 26 : 9) * dmgMul, attackCd: 0, boss, wave,
      });
      if (boss) { run.boss = true; run.bossSpawned = true; }
      spawned++;
    }
    if (spawned) {
      this._emit('wave', { wave, count: spawned, boss: run.bossSpawned });
    }
    return spawned;
  }

  _updateHorde(dt) {
    const run = this.hordeRun;
    if (!run || this.phase === 'ended') return;
    if (run.nextWaveIn > 0 || run.wave === 0) {
      run.nextWaveIn = Math.max(0, run.nextWaveIn - dt);
      run.prepTime = run.nextWaveIn;
      if (run.nextWaveIn <= 0) {
        if (run.wave >= run.totalWaves) { this.end('cleared', null); return; }
        run.wave++;
        const count = HORDE.enemyStart + HORDE.enemyPerWave * (run.wave - 1);
        this._spawnEnemies(count, run.wave);
      }
      return;
    }
    if (run.wave >= run.totalWaves && run.enemies.length === 0) {
      run.score += 500;
      this.end('cleared', null);
      return;
    }
    const base = run.base;
    for (let i = run.enemies.length - 1; i >= 0; i--) {
      const e = run.enemies[i];
      if (e.hp <= 0) { run.enemies.splice(i, 1); continue; }
      let target = null; let bestD = 1e9;
      for (let k = 0; k < this.players.length; k++) {
        const p = this.players[k];
        if (!p.alive) continue;
        const d = dist(e.x, e.z, p.x, p.z);
        if (d < bestD) { bestD = d; target = p; }
      }
      const bd = dist(e.x, e.z, base.x, base.z);
      if (!target || bd < bestD) {
        if (bd > 2.4) {
          const dx = (base.x - e.x) / bd; const dz = (base.z - e.z) / bd;
          this._enemyStep(e, dx, dz, dt, 0.7);
          e.angle = Math.atan2(dx, dz);
        } else {
          e.attackCd -= dt;
          if (e.attackCd <= 0) { e.attackCd = 2.2; base.hp = Math.max(0, base.hp - e.damage); }
        }
        continue;
      }
      const d = bestD;
      if (d > 1.6) {
        const dx = (target.x - e.x) / d; const dz = (target.z - e.z) / d;
        this._enemyStep(e, dx, dz, dt, 0.7);
        e.angle = Math.atan2(dx, dz);
      } else {
        e.attackCd -= dt;
        if (e.attackCd <= 0) {
          e.attackCd = e.boss ? 0.7 : 1.2;
          this.damage(target, e.damage, null, { noDown: true });
          if (!target.alive) run.score = Math.max(0, run.score - 25);
        }
      }
    }
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.alive && p.connected) {
        p.respawnIn = (p.respawnIn ?? HORDE.reviveAfter) - dt;
        if (p.respawnIn <= 0) {
          p.respawnIn = HORDE.reviveAfter;
          this.revive(p);
          p.hp = 70;
          p.x = base.x + (this.rng() - 0.5) * 6;
          p.z = base.z + (this.rng() - 0.5) * 6;
          this._emit('respawn', { player: p.id });
        }
      }
    }
    if (base.hp <= 0) { this.end('baseDestroyed', null); return; }
    if (run.wave >= run.totalWaves && run.enemies.length === 0) {
      run.score += 500;
      this.end('cleared', null);
    }
  }

  _enemyStep(e, dx, dz, dt, r) {
    const step = e.speed * dt;
    if (!this.world.blocked(e.x + dx * step, e.z + dz * step, r)) {
      e.x += dx * step; e.z += dz * step;
      return true;
    }
    // 撞墙时沿切线滑动，避免卡死在障碍物前
    const tx = -dz; const tz = dx;
    for (let s = 1; s >= -1; s -= 2) {
      if (!this.world.blocked(e.x + tx * step * s, e.z + tz * step * s, r)) {
        e.x += tx * step * s; e.z += tz * step * s;
        return true;
      }
    }
    if (!this.world.blocked(e.x + dx * step * 0.4, e.z, r)) { e.x += dx * step * 0.4; return true; }
    if (!this.world.blocked(e.x, e.z + dz * step * 0.4, r)) { e.z += dz * step * 0.4; return true; }
    return false;
  }

  /** 前方扇形内是否有敌人（horde 用，供伤害判定/测试）。 */
  hordeShot(p, damage = 20, range = 40) {
    const run = this.hordeRun;
    if (!run) return 0;
    let killed = 0;
    for (let i = 0; i < run.enemies.length; i++) {
      const e = run.enemies[i];
      const d = dist(p.x, p.z, e.x, e.z);
      if (d > range) continue;
      const a = Math.abs(wrapAngle(Math.atan2(e.x - p.x, e.z - p.z) - p.angle));
      if (a > 0.5) continue;
      e.hp -= damage;
      if (e.hp <= 0) {
        killed++;
        run.score += e.boss ? 500 : 25;
        run.credits += e.boss ? 300 : 18;
        run.kills++;
        this._emit('enemyDown', { id: e.id, boss: e.boss, wave: run.wave });
      }
      break;
    }
    if (run.enemies.length && run.enemies.every((e) => e.hp <= 0)) {
      run.nextWaveIn = HORDE.prepTime;
      run.prepTime = HORDE.prepTime;
      run.score += 100 + run.wave * 25;
      run.credits += 120 + run.wave * 30;
      this._emit('waveClear', { wave: run.wave });
    }
    return killed;
  }

  _startNextWave() {
    const run = this.hordeRun;
    if (!run) return 0;
    if (run.wave >= run.totalWaves) { this.end('cleared', null); return 0; }
    run.wave++;
    run.nextWaveIn = 0;
    const count = HORDE.enemyStart + HORDE.enemyPerWave * (run.wave - 1);
    return this._spawnEnemies(count, run.wave);
  }

  upgradeCost(kind) {
    const def = HORDE.upgrades[kind];
    if (!def) return Infinity;
    const run = this.hordeRun;
    const bought = run ? run.upgradesBought?.[kind] || 0 : 0;
    return def.baseCost + def.step * bought;
  }

  _buy(p, kind) {
    const run = this.hordeRun;
    if (!run || !HORDE.upgrades[kind]) return false;
    const cost = this.upgradeCost(kind);
    if (run.credits < cost) return false;
    run.credits -= cost;
    run.upgradesBought = run.upgradesBought || {};
    run.upgradesBought[kind] = (run.upgradesBought[kind] || 0) + 1;
    if (kind === 'repair') run.base.hp = Math.min(run.base.maxHp, run.base.hp + run.base.maxHp * 0.3);
    else if (kind === 'ammo') {
      for (let i = 0; i < this.players.length; i++) {
        const q = this.players[i];
        q.mags = { light: 240, medium: 240, heavy: 90, shell: 48, bolt: 30 };
        q.meds = Math.max(q.meds, 3); q.bandages = Math.max(q.bandages, 5);
        q.grenades = Math.max(q.grenades, 3); q.smokes = Math.max(q.smokes, 2);
      }
    } else if (kind === 'armor') {
      for (let i = 0; i < this.players.length; i++) {
        const q = this.players[i];
        q.armorTier = Math.min(3, Math.max(q.armorTier || 1, (q.armorTier || 0) + 1));
        q.armor = armorForTier(q.armorTier)?.durability || 60;
      }
    } else if (kind === 'turret') {
      run.base.turrets = Math.min(HORDE.upgrades.turret.max || 4, (run.base.turrets || 0) + 1);
    }
    this._emit('upgrade', { player: p ? p.id : null, kind, cost });
    return true;
  }

  // ── Bot 与快照 ────────────────────────────────────────────────────────────
  _bots(dt) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.bot || !p.alive) continue;
      if (p.seat === 0 && p.car == null) continue;
      if (this.hordeRun && this._hordeBot(p, dt)) continue;
      try {
        thinkBot(this, p, dt);
      } catch (err) {
        p.think = p.think || { err: 0 };
      }
      if (p.botInput) {
        p.input = sanitizeInput(p.botInput);
        p.botInput = null;
      }
      if (p.car == null) this._movePlayer(p, dt);
      this._handleActions(p, dt);
    }
  }

  teamName(team) {
    return TEAM_NAMES[team] || `小队 ${team + 1}`;
  }

  /** horde 里 bot 的守家行为：贴近基地、朝最近的敌人射击。返回 true 表示已接管。 */
  _hordeBot(p, dt) {
    const run = this.hordeRun;
    const base = run.base;
    let target = null; let bestD = 42;
    for (let i = 0; i < run.enemies.length; i++) {
      const e = run.enemies[i];
      if (e.hp <= 0) continue;
      const d = dist(p.x, p.z, e.x, e.z);
      if (d < bestD) { bestD = d; target = e; }
    }
    const toBase = dist(p.x, p.z, base.x, base.z);
    const inp = emptyInput();
    if (target) {
      p.angle = Math.atan2(target.x - p.x, target.z - p.z);
      inp.aim = p.angle;
      inp.fire = bestD < 34 && p.reloadTime <= 0;
      if (p.fireCd <= 0.02) this.tryFire(p);
      if (bestD > 12) { inp.mx = Math.sin(p.angle); inp.mz = Math.cos(p.angle); }
    } else if (toBase > 7) {
      const a = Math.atan2(base.x - p.x, base.z - p.z);
      inp.mx = Math.sin(a); inp.mz = Math.cos(a); inp.aim = a;
    }
    p.input = inp;
    p.moved = inp.mx !== 0 || inp.mz !== 0;
    if (inp.mx || inp.mz) this.world.moveBody(p, inp.mx * MOVE.walk * dt, inp.mz * MOVE.walk * dt, MOVE.radius);
    return true;
  }

  _visibleTo(viewer, target) {
    if (!target) return false;
    if (!viewer) return true;
    if (viewer.team === target.team) return true;
    return dist(viewer.x, viewer.z, target.x, target.z) <= 70;
  }

  _playerView(p, self) {
    const weapon = effectiveWeapon(p);
    return {
      id: p.id, name: p.name, bot: p.bot, team: p.team, teamName: this.teamName(p.team),
      x: r2(p.x), z: r2(p.z), angle: r2(p.angle), y: r2(p.y), hp: r2(p.hp),
      armor: r2(p.armor), armorTier: p.armorTier, alive: p.alive, downed: p.downed,
      bleedout: r2(p.bleedout), reviveProgress: r2(p.reviveProgress), reviveTarget: p.reviveTarget,
      weapon: weapon ? weapon.id : null, kills: p.kills, rank: p.rank,
      car: p.car, seat: p.seat, connected: p.connected, state: p.state, chute: p.chute,
    };
  }

  snapshot(viewerId = null, sinceEventId = 0) {
    const self = viewerId ? this._find(viewerId) : null;
    const vx = self ? self.x : 0;
    const vz = self ? self.z : 0;
    const players = [];
    const teammates = [];
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const isMate = self ? p.team === self.team : false;
      if (!this._visibleTo(self, p)) continue;
      players.push(this._playerView(p, self));
      if (self && isMate) {
        teammates.push({
          id: p.id, name: p.name, x: r2(p.x), z: r2(p.z), alive: p.alive, downed: p.downed,
          hp: r2(p.hp), bleedout: r2(p.bleedout), car: p.car, connected: p.connected,
          isSelf: p === self,
        });
      }
    }
    const loot = [];
    for (let i = 0; i < this.loot.length; i++) {
      const l = this.loot[i];
      if (l.taken) continue;
      if (self && !self.bot && dist(vx, vz, l.x, l.z) > 70) continue;
      loot.push({
        id: l.id, kind: l.kind, item: l.item, x: r2(l.x), z: r2(l.z), y: r2(l.y),
        qty: l.qty, ammo: l.ammo, rarity: l.rarity, attachments: l.attachments.slice(),
      });
    }
    const cars = [];
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.dead) continue;
      cars.push({
        id: c.id, type: c.type, x: r2(c.x), z: r2(c.z), angle: r2(c.angle), hp: r2(c.hp),
        maxHp: c.maxHp, color: c.color, seats: c.seats, driver: c.driver, speed: r2(c.speed),
      });
    }
    const events = [];
    for (let i = this.events.length - 1; i >= 0 && events.length < MAX_EVENTS; i--) {
      if (this.events[i].id > sinceEventId) events.push({ ...this.events[i] });
    }
    events.reverse();
    let alive = 0; let humans = 0; let bots = 0;
    const teamSet = new Set();
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.alive) alive++;
      if (p.bot) bots++; else humans++;
      if (p.alive || p.downed) teamSet.add(p.team);
    }
    const me = self ? this._selfView(self) : null;
    return {
      v: 3, mode: this.mode, mapId: this.mapId, mapName: this.mapName,
      weather: this.weather, timeOfDay: this.timeOfDay,
      phase: this.phase, time: r2(this.time), matchTime: r2(this.matchTime), duration: this.duration,
      zone: this._zoneView(),
      counts: {
        alive, total: this.players.length, teams: this.maxTeams,
        aliveTeams: teamSet.size, humans, bots,
      },
      selfId: self ? self.id : null,
      me,
      players, loot, cars,
      grenades: this.grenades.map((g) => ({
        id: g.id, kind: g.kind, x: r2(g.x), z: r2(g.z), y: r2(g.y), ttl: r2(g.ttl),
      })),
      smokes: this.smokes.map((s) => ({ id: s.id, x: r2(s.x), z: r2(s.z), r: s.r, ttl: r2(s.ttl) })),
      fires: this.fires.map((f) => ({ id: f.id, x: r2(f.x), z: r2(f.z), r: f.r, ttl: r2(f.ttl) })),
      pings: this.pings
        .filter((pg) => !self || pg.team === self.team)
        .map((pg) => ({ id: pg.id, team: pg.team, x: r2(pg.x), z: r2(pg.z), kind: pg.kind, ttl: r2(pg.ttl) })),
      drops: this.drops.map((d) => ({
        id: d.id, x: r2(d.x), z: r2(d.z), y: r2(d.y), landsIn: r2(d.landsIn), opened: d.opened,
      })),
      markers: [],
      horde: this._hordeView(),
      events,
      loading: null,
      result: this.result ? {
        winnerTeam: this.result.winnerTeam, winnerName: this.result.winnerName,
        reason: this.result.reason,
        ranks: this.result.ranks.map((rk) => ({ ...rk, players: rk.players.slice() })),
      } : null,
      teammates,
    };
  }

  _zoneView() {
    const z = this.zone;
    if (!z) return { x: 0, z: 0, r: 0, target: { x: 0, z: 0, r: 0 }, closing: false, damage: 0, phase: 0, nextIn: 0 };
    return {
      x: r2(z.x), z: r2(z.z), r: r2(z.r),
      target: { x: r2(z.target.x), z: r2(z.target.z), r: r2(z.target.r) },
      closing: z.closing, damage: z.damage, phase: z.phase, nextIn: r2(z.nextIn),
    };
  }

  _hordeView() {
    const run = this.hordeRun;
    if (!run) return null;
    const enemiesLeft = run.enemies.length + (run.nextWaveIn > 0
      ? (HORDE.enemyStart + HORDE.enemyPerWave * Math.max(0, run.wave)) : 0);
    return {
      wave: run.wave, totalWaves: run.totalWaves, enemiesLeft, nextWaveIn: r2(run.nextWaveIn),
      boss: run.boss, score: run.score, baseHp: r2(Math.max(0, run.base.hp)),
      baseMaxHp: run.base.maxHp, prepTime: HORDE.prepTime, cost: r2(run.credits),
    };
  }

  _selfView(p) {
    const weapon = effectiveWeapon(p);
    const slot = p.loadout[p.slot];
    const loadout = [];
    for (let i = 0; i < p.loadout.length; i++) {
      const s = p.loadout[i];
      loadout.push(s ? { type: s.type, ammo: s.ammo, attachments: s.attachments.slice() } : null);
    }
    let interactLabel = null;
    if (p.car == null) {
      const car = this._nearestCar(p);
      if (car) interactLabel = `驾驶 ${CARS[car.type]?.name || '载具'}`;
    } else interactLabel = '下车';
    if (!interactLabel) {
      for (let i = 0; i < this.loot.length; i++) {
        const l = this.loot[i];
        if (!l.taken && dist(p.x, p.z, l.x, l.z) <= 1.8) { interactLabel = '拾取 物资'; break; }
      }
    }
    if (!interactLabel) {
      for (let i = 0; i < this.drops.length; i++) {
        const d = this.drops[i];
        if (!d.opened && d.landsIn <= 0 && dist(p.x, p.z, d.x, d.z) <= 2.6) {
          interactLabel = '开启 空投'; break;
        }
      }
    }
    if (!interactLabel && weapon) interactLabel = p.mags[weapon.ammo] > 0 ? '换弹' : null;
    const dist0 = 0;
    return {
      id: p.id, name: p.name, bot: p.bot, team: p.team, teamName: this.teamName(p.team),
      hp: r2(p.hp), armor: r2(p.armor), armorTier: p.armorTier, shield: r2(p.shield),
      alive: p.alive, downed: p.downed, downedHp: r2(p.downedHp), bleedout: r2(p.bleedout),
      reviveProgress: r2(p.reviveProgress), reviveTarget: p.reviveTarget,
      kills: p.kills, assists: p.assists, damage: r2(p.damage), rank: p.rank,
      state: p.state, x: r2(p.x), z: r2(p.z), angle: r2(p.angle), stamina: r2(p.stamina),
      weapon: weapon ? weapon.id : null,
      ammo: slot ? slot.ammo : 0,
      reserve: weapon ? (p.mags[weapon.ammo] || 0) : 0,
      ammoType: weapon ? weapon.ammo : null,
      slot: p.slot, loadout,
      mags: { ...p.mags }, meds: p.meds, bandages: p.bandages, energy: p.energy,
      shields: p.shields, grenades: p.grenades, smokes: p.smokes, flashes: p.flashes,
      molotovs: p.molotovs, car: p.car, seat: p.seat, interactLabel,
      blind: r2(p.blind), reloadTime: r2(p.reloadTime), healTime: r2(p.healTime),
      healKind: p.healKind, fireCooldown: r2(p.fireCd),
      accuracy: r2(weapon ? Math.max(0.05, 1 - weapon.spread / Math.max(0.01, weapon.spread) * 0.95) : 0),
    };
  }
}

// ── 世界构造（makeWorld 未就绪时的兜底，保证测试与服务器能跑） ─────────────
export function createWorld(mapId = 'qinglan') {
  let world = null;
  try {
    if (typeof mapgen.makeWorld === 'function') world = mapgen.makeWorld(mapId);
  } catch (err) { world = null; }
  if (!world || typeof world.blocked !== 'function' || typeof world.moveBody !== 'function') {
    world = fallbackWorld(mapId);
  }
  return normalizeWorld(world, mapId);
}

function normalizeWorld(world, mapId) {
  const def = getMapDef(mapId) || getMapDef('qinglan');
  const radius = Number.isFinite(world.radius) ? world.radius : (def?.radius || 182);
  world.radius = radius;
  world.regions = Array.isArray(world.regions) ? world.regions : [];
  world.lootSpots = Array.isArray(world.lootSpots) ? world.lootSpots : [];
  world.carSpots = Array.isArray(world.carSpots) ? world.carSpots : [];
  world.spawnAnchors = Array.isArray(world.spawnAnchors) && world.spawnAnchors.length
    ? world.spawnAnchors : makeAnchors(radius);
  world.inWater = typeof world.inWater === 'function' ? world.inWater : () => false;
  if (!world.nav || typeof world.nav !== 'object') {
    world.nav = { pathClear: world.clearLine, nearestWalkable: (x, z) => ({ x, z }) };
  }
  if (typeof world.nav.pathClear !== 'function') world.nav.pathClear = world.clearLine;
  if (typeof world.nav.nearestWalkable !== 'function') world.nav.nearestWalkable = (x, z) => ({ x, z });
  return world;
}

function makeAnchors(radius) {
  const out = [];
  const r = radius * 0.72;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * TAU + (i % 3) * 0.11;
    const rr = r * (0.45 + 0.55 * ((i * 37) % 100) / 100);
    out.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr });
  }
  return out;
}

/** 极简兜底世界：只有边界与少量方形障碍，用于 makeWorld 尚未就绪的场景。 */
export function fallbackWorld(mapId = 'qinglan') {
  const def = getMapDef(mapId) || getMapDef('qinglan');
  const radius = def?.radius || 182;
  const obstacles = [];
  const rng = mapgen.mulberry32((def?.seed || 74129) >>> 0);
  for (let i = 0; i < 60; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * (radius - 24);
    obstacles.push({
      x: Math.cos(a) * rr, z: Math.sin(a) * rr,
      w: 6 + rng() * 12, d: 6 + rng() * 12, h: 4, kind: 'building',
    });
  }
  const collision = mapgen.makeCollision(obstacles, (x, z) => Math.hypot(x, z) < radius - 1);
  const lootSpots = [];
  const carSpots = [];
  for (let i = 0; i < 120; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng()) * (radius - 26);
    lootSpots.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, tier: 1 + ((i * 7) % 3) });
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU;
    carSpots.push({
      x: Math.cos(a) * radius * 0.62, z: Math.sin(a) * radius * 0.62,
      type: CAR_TYPES[i % CAR_TYPES.length], rot: a,
    });
  }
  return {
    ...collision, radius, obstacles, mapId: def?.id || mapId,
    lootSpots, carSpots, spawnAnchors: makeAnchors(radius), regions: [],
  };
}
