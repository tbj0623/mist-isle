// 雾岛突围 / MIST ISLE — 对战模拟核心（owner: simcore · shared/simulation.mjs）
// 服务端权威：命中/伤害/缩圈/载具/波次全部在这里结算，客户端只发输入。
// 单位：米 / 秒 / 弧度（0 = +Z，x 分量 = sin(angle)）；禁止 Math.random，只用 this.rng()。
import * as mapgen from './map.mjs';
import {
  TICK_RATE, SQUAD_SIZE, MAX_PLAYERS, MAX_HUMANS, MAX_LOOT, MAX_EVENTS, MAX_GRENADES, MAX_CARS,
  MATCH_MODES, DEFAULT_DURATION, MOVE, COMBAT, ZONE_PHASES, ZONE_FIRST_WAIT, REVIVE_TIME,
  BLEEDOUT_TIME, REVIVE_HP, REVIVE_RANGE, HORDE, DIFFICULTY, DEPLOY,
} from './rules.mjs';
import {
  WEAPONS, ATTACHMENTS, AMMO_TYPES, WEAPON_ORDER, applyAttachmentMods, getWeapon, damageAtDistance,
} from './data/weapons.mjs';
import { ARMORS, CONSUMABLES, THROWABLES, BACKPACKS, armorForTier } from './data/items.mjs';
import { buildLootForSpot, buildAirdropLoot } from './data/loot.mjs';
import { getMapDef } from './data/maps.mjs';
import { thinkBot } from './ai.mjs';
// horde（PvE 波次）的敌人 AI/波次编排/升级效果都在独立模块里，本文件只做桥接。
import * as Horde from './horde.mjs';

export { WEAPONS, ATTACHMENTS, ARMORS, CONSUMABLES, THROWABLES, BACKPACKS, AMMO_TYPES, WEAPON_ORDER };
export { TICK_RATE, SQUAD_SIZE, MAX_PLAYERS };
export const MAX_HUMANS_PER_ROOM = MAX_HUMANS;
export const MAX_SQUADS = Math.ceil(MAX_PLAYERS / SQUAD_SIZE);

const TAU = Math.PI * 2;
// 共享只读空集合：快照里的空数组占位（markers / 无配件 / 无队内标记）复用同一实例，
// JSON 序列化输出与逐份新建完全一致，省去每份快照的重复分配。
const EMPTY_ATTACHMENTS = [];
const EMPTY_PINGS = [];
const EMPTY_MARKERS = [];
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
  'dodge', 'revive', 'ready', 'jump'];
const AMMO_KEYS = ['light', 'medium', 'heavy', 'shell', 'bolt'];
// 空投物资的独立生成额度：每局最多 3 箱 × 3–4 件，给到 24 件足够，
// 且不占用地面物资的 MAX_LOOT 名额（详见 addLoot 里的说明）。
const MAX_AIRDROP_LOOT = 24;
/** 自由落体阶段吃掉的水平距离比例；剩下的交给开伞滑翔精修。 */
const FREEFALL_SHARE = 0.78;

// 装备界面的「投掷物 / 消耗品」→ 玩家身上的计数字段。
// 玩家身上每种投掷物/消耗品各有一个独立计数器（grenades/smokes/flashes/molotovs、
// bandages/meds/energy/shields），装备时只给选中的那一种发初始数量。
const THROWABLE_STOCK = { frag: 'grenades', smoke: 'smokes', flash: 'flashes', molotov: 'molotovs' };
const CONSUMABLE_STOCK = { bandage: 'bandages', medkit: 'meds', energy: 'energy', shield: 'shields' };
const THROWABLE_START = 2;   // 开局带 2 个选定投掷物（与掉落节奏一致，不构成压倒性优势）
const CONSUMABLE_START = 2;  // 开局带 2 个选定消耗品
const CARS = {
  buggy: { id: 'buggy', name: '沙滩越野', seats: 4, speed: 15.5, hp: 220, color: 0xd8a24a },
  jeep: { id: 'jeep', name: '军用吉普', seats: 4, speed: 13.5, hp: 320, color: 0x6f8f6a },
  bike: { id: 'bike', name: '越野摩托', seats: 2, speed: 18.5, hp: 130, color: 0xb05a4a },
  truck: { id: 'truck', name: '运输卡车', seats: 6, speed: 11.2, hp: 440, color: 0x7a8a94 },
};
const CAR_TYPES = ['buggy', 'jeep', 'bike', 'truck'];

/** 校验队伍落点 hint：{ [team]: {x,z} }，坐标为归一化 0-1，clamp 后返回纯数据对象；
 * 非法条目整体忽略，全部非法返回 null（缺省行为与无 hint 完全一致）。 */
const sanitizeDropHints = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of Object.keys(raw)) {
    const team = Number(key);
    const hint = raw[key];
    if (!Number.isInteger(team) || team < 0 || team > 1023 || !hint || typeof hint !== 'object') continue;
    const x = Number(hint.x);
    const z = Number(hint.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    out[team] = { x: clamp(x, 0, 1), z: clamp(z, 0, 1) };
  }
  return Object.keys(out).length ? out : null;
};

// ── 输入 ────────────────────────────────────────────────────────────────────
export const emptyInput = () => ({
  mx: 0, mz: 0, aim: 0, fire: false, reload: false, heal: false, interact: false, swap: false,
  ping: false, sprint: false, crouch: false, dodge: false, throwable: null, useItem: null,
  pingKind: 'move', slot: -1, revive: false, buy: null, upgrade: null, ready: false, seq: 0,
  // jump：舱内请求跳伞（skydive 专用）；其它阶段被忽略。
  jump: false,
  // jumpAt：跳伞时选定的落点（归一化 0-1）。仅与 jump 同帧生效。
  jumpAt: null,
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
  out.jumpAt = sanitizeJumpAt(raw.jumpAt);
  out.seq = clamp(Math.floor(num(raw.seq)), 0, Number.MAX_SAFE_INTEGER);
  return out;
}

/** 跳伞落点：归一化 0-1 坐标；非法输入返回 null（服务端不接受任意坐标）。 */
function sanitizeJumpAt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const z = Number(raw.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x: clamp(x, 0, 1), z: clamp(z, 0, 1) };
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
    difficulty = 'veteran', humanTeam = 0, horde = false, deployStyle = 'instant',
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
    this.airdropLoot = 0;   // 空投物资已生成数（独立于地面 loot 上限）
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
    this.dropHints = null; // 队伍落点 hint（start({ dropHints }) 注入，见 _spawnPoint）
    // 空降风格：'instant'（默认，向后兼容）或 'skydive'（自由航线 + 跳伞）。
    // 默认 instant 是刻意的：55 处既有测试与快速模式都假定 start() 后玩家已在地面。
    this.deployStyle = deployStyle === 'skydive' ? 'skydive' : 'instant';
    // 航线状态（仅 skydive）。phase==='deploying' 期间由 _updateDeploy 推进。
    this.flight = null;
    this.tickCount = 0;
    this._snapCache = null; // 快照共享基座（见 _snapBase），每个 tick 失效一次
    this.nextDrop = 0;
    this.dropsLeft = 0;
    this.startedAt = 0;
    this.counters = { lootSpawned: 0, kills: 0, shots: 0, hits: 0, headshots: 0 };
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
    // 上限同时看「当前在场数量」与「本局累计生成数」：lootId 只增不减，
    // 这样 loot 压实（剔除已拾取条目）不会凭空腾出生成额度，空投补货行为与压实前完全一致。
    //
    // `opts.airdrop === true` 走独立额度：地面物资在开局就生成到 601–631 件
    //（上限 640），如果空投也共享同一个计数器，空投落地时永远拿不到名额 ——
    // 实测「空投箱打开后是空的」，这是空投玩法整体失效的根因。
    // 空投每局最多 3 箱、每箱 3–4 件，上限单独给 24 件足够且不影响地面配比。
    if (opts.airdrop) {
      if (this.airdropLoot >= MAX_AIRDROP_LOOT) return null;
    } else if (this.lootId >= MAX_LOOT || this.loot.length >= MAX_LOOT) {
      return null;
    }
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
    if (opts.airdrop) { this.airdropLoot = (this.airdropLoot || 0) + 1; entry.airdrop = true; }
    this.loot.push(entry);
    return entry;
  }

  /** 压实 loot 数组：剔除 taken 条目，其余元素保持相对顺序与 id 稳定（客户端差量按 id 水合）。 */
  _compactLoot() {
    let w = 0;
    for (let i = 0; i < this.loot.length; i++) {
      const l = this.loot[i];
      if (!l.taken) this.loot[w++] = l;
    }
    this.loot.length = w;
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
      // maxHp 由 _spawnPlayer 按难度写入（DIFFICULTY.*.hpMul）；这里给人类默认值，
      // 保证「waiting 阶段尚未 spawn」的玩家也有合法血量上限。
      hp: COMBAT.maxHp, maxHp: COMBAT.maxHp, armor: 0, armorTier: 0, shield: 0, stamina: MOVE.sprintStamina,
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
      // ── 对局内累计统计（服务端权威） ──────────────────────────────────────
      // 背景：结算摘要过去只从「最后一帧快照的 events 窗口」派生，而 MAX_EVENTS=140
      // 只能装下一局约 1839 条事件中的 7.6%，且客户端结算时 sinceEventId 已消费到最新，
      // 窗口为空 —— 结果是 shotsFired/shotsHit/headshots/pickups/revives/throws 等
      // 12 个字段恒为 0，直接导致 35% 成就、54% 每日任务不可达。
      // 这里在 Match 内做权威累计，由 _selfView 的 stats 字段随快照下发，
      // 客户端结算时直接读，不再依赖事件窗口。
      stats: {
        shotsFired: 0, shotsHit: 0, headshots: 0, kills: 0, downs: 0, assists: 0,
        damageDealt: 0, damageTaken: 0, pickups: 0, revives: 0, throws: 0,
        healItems: 0, vehicleSeconds: 0, airdrops: 0, dodges: 0,
        weaponsUsed: [],           // 用过的武器 id（去重，按首次使用顺序）
      },
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

  /**
   * 应用玩家装备。
   *
   * 接受两种形状（历史遗留，必须都支持）：
   *   1) 数组：[{ type, ammo, attachments }, { type, ammo, attachments }]
   *      —— 服务器 room 存档、测试、horde 强制装置用的形状；
   *   2) 对象：{ primary, secondary, attachments: { primary, secondary }, throwable, consumable, skin }
   *      —— `client/main.js` 的 `normalizeLoadout()` 返回的形状，也是「装备」界面写进存档的形状。
   *
   * 历史 bug：这里只认数组。客户端传对象时 `Array.isArray` 为 false，静默回退成
   * `[{type:'p9'}, null]` —— **所有对局开局都只有 P9 手枪、无配件、无消耗品、无投掷物**，
   * 「装备」界面形同虚设（换枪/换配件/换消耗品全部无效）。离线训练场、solo、squad 全中招。
   * 另外旧实现从不读取 throwable/consumable，即使形状对了也拿不到手雷与药品。
   */
  _applyLoadout(player, loadout) {
    let list = null;
    let extras = null;
    if (Array.isArray(loadout) && loadout.length) {
      list = loadout;
    } else if (loadout && typeof loadout === 'object') {
      // 对象形状：主/副武器 + 各自配件 + 投掷物/消耗品/皮肤
      const att = loadout.attachments && typeof loadout.attachments === 'object' ? loadout.attachments : {};
      list = [
        loadout.primary ? { type: loadout.primary, attachments: att.primary } : null,
        loadout.secondary ? { type: loadout.secondary, attachments: att.secondary } : null,
      ];
      extras = loadout;
    }
    if (!list) list = [{ type: 'p9' }, null];

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
    // 主武器无效时退到副武器，两把都无效时给一把保底手枪（否则开局无法战斗）
    player.slot = player.loadout[0] ? 0 : 1;
    if (!player.loadout[0] && !player.loadout[1]) {
      const w = getWeapon('p9');
      player.loadout[0] = { type: 'p9', ammo: w.magazine, attachments: [], _eff: null };
      const ammoDef = AMMO_TYPES[AMMO_TYPES[w.ammo] ? w.ammo : 'light'];
      player.mags[w.ammo] = Math.max(player.mags[w.ammo] || 0, Math.round(ammoDef.cap * 0.6));
      player.slot = 0;
    }

    // 投掷物 / 消耗品 / 皮肤（对象形状才带；数组形状保持既有默认）
    if (extras) {
      if (THROWABLES[extras.throwable]) {
        const key = THROWABLE_STOCK[extras.throwable];
        if (key) player[key] = Math.max(player[key] || 0, THROWABLE_START);
      }
      if (CONSUMABLES[extras.consumable]) {
        const key = CONSUMABLE_STOCK[extras.consumable];
        if (key && !(player[key] > 0)) player[key] = CONSUMABLE_START;
      }
      if (typeof extras.skin === 'string' && extras.skin) player.skin = extras.skin;
    }
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

  /** 进入对局：补 bot、撒点、清空等待态。
   * opts.dropHints：可选的队伍落点 hint（{ [team]: {x,z} 归一化 0-1 }），由房间层在
   * 开局前聚合「降落区投票」得到；只影响人类玩家的出生锚点选择（见 _spawnPoint），
   * 不改变 rng 消耗路径（hint 是开局配置，不是随机源）。 */
  start(opts = {}) {
    if (this.phase !== 'waiting') return false;
    this.dropHints = sanitizeDropHints(opts && typeof opts === 'object' ? opts.dropHints : null);
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
    if (this.deployStyle === 'skydive') this._beginFlight();
    this._emit('start', { mode: this.mode, players: this.players.length });
    return true;
  }

  // ── 空降：自由航线 + 跳伞 ─────────────────────────────────────────────────
  /** 生成一条横穿地图的航线，并把所有玩家放上飞机（舱内等待跳伞）。
   *
   * 航线用 rng 生成，但它消耗的随机数发生在「所有 loot / 出生点已生成之后」，
   * 且 skydive 与 instant 是两种不同 deployStyle —— 同一 seed 下各自确定性，
   * 不会互相污染。 */
  _beginFlight() {
    const R = this.world?.radius || 182;
    // 随机方位 + 从一侧到另一侧的偏移；两端伸出地图，保证「横穿整张图」
    const a = this.rng() * TAU;
    const off = (this.rng() - 0.5) * R * 0.9;         // 航线到圆心的垂直偏移
    const span = R * (1 + DEPLOY.planeMargin);
    const ux = Math.cos(a), uz = Math.sin(a);          // 航向
    const px = -uz, pz = ux;                           // 航线法向
    const cx = px * off, cz = pz * off;
    const from = { x: cx - ux * span, z: cz - uz * span };
    const to = { x: cx + ux * span, z: cz + uz * span };
    const total = Math.hypot(to.x - from.x, to.z - from.z) / Math.max(1, DEPLOY.planeSpeed);
    // 可跳窗口：飞机进入地图圆内开始，到离开圆之前结束；再与 jumpWindow 取交集
    const enter = Math.max(0, (span - R) / Math.max(1, DEPLOY.planeSpeed));
    const leave = Math.max(enter + 1, (span + R) / Math.max(1, DEPLOY.planeSpeed));
    const jumpOpen = enter;
    const jumpClose = Math.min(leave, jumpOpen + DEPLOY.jumpWindow);
    this.flight = {
      from, to, ux, uz, total, t: 0,
      jumpOpen, jumpClose,
      // 当前机位（按进度插值），快照直接读
      x: from.x, z: from.z,
      open: false,
      // 已跳人数 / 总数，供 HUD 显示「跳伞 3/64」
      jumped: 0,
    };
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.chute = 1;               // 1 = 完全在舱内（未跳）；落地后归 0
      p.deployStage = 'plane';   // plane → freefall → chute → ground
      p.deployT = 0;
      p.dropTarget = null;
      p.x = from.x; p.z = from.z; p.y = DEPLOY.planeHeight;
      p.state = 'normal';
    }
  }

  /** 玩家请求跳伞（客户端 input.jump）。仅在可跳窗口内且仍在舱内时生效。
   * target 可选：归一化 0-1 世界坐标，玩家在空中选定的落点。 */
  jumpFromPlane(id, target = null) {
    const p = this._find(id);
    if (!p || this.phase !== 'deploying' || !this.flight) return false;
    if (p.deployStage !== 'plane') return false;
    if (!this.flight.open) return false;
    this._beginFreefall(p, target || p.dropTarget || null);
    return true;
  }

  /** 把 p 从机舱弹出，进入自由落体。target 为归一化 0-1 世界坐标（可空）。 */
  _beginFreefall(p, target) {
    const f = this.flight;
    const R = this.world?.radius || 182;
    let tx = p.x;
    let tz = p.z;
    if (target && Number.isFinite(target.x) && Number.isFinite(target.z)) {
      const want = this._clampToMap((target.x * 2 - 1) * R, (target.z * 2 - 1) * R);
      tx = want.x; tz = want.z;
    } else {
      // 没给目标：朝当前航向斜前方飘一段（自然跳伞观感），落在可走点
      const want = this._clampToMap(p.x + f.ux * 34, p.z + f.uz * 34);
      tx = want.x; tz = want.z;
    }
    const ground = this._nearestWalkable(tx, tz);
    p.deployStage = 'freefall';
    p.deployT = 0;
    p.dropTarget = { x: (ground.x / R + 1) / 2, z: (ground.z / R + 1) / 2 };
    p.dropSpot = { x: ground.x, z: ground.z };
    // 插值起点：自由落体/滑翔都从「跳伞瞬间的机位」算起，
    // 用固定起点而不是逐帧累加，保证不同帧率下轨迹一致。
    p.deployFrom = { x: p.x, z: p.z };
    p.chute = 0;
    p.y = DEPLOY.dropHeight;
    p.angle = Math.atan2(ground.x - p.x, ground.z - p.z);
    if (f) f.jumped++;
    this._emit('jump', {
      player: p.id, x: r2(p.x), z: r2(p.z), x2: r2(ground.x), z2: r2(ground.z),
    });
  }

  /** 把坐标夹进地图圆形可玩区（留 2% 余量）。航空投放的落点必须走这里：
   *  只夹方形 bounds 会让玩家落在圆外的四个角上，开局就站在圈外掉血。 */
  _clampToMap(x, z) {
    const R = (this.world?.radius || 182) * 0.96;
    const d = Math.hypot(x, z);
    if (d <= R || d === 0) return { x, z };
    const k = R / d;
    return { x: x * k, z: z * k };
  }

  /** 就近找一个可站立点：以 (x,z) 为中心向外螺旋搜索，结果始终在地图圆内。 */
  _nearestWalkable(x, z) {
    const w = this.world;
    if (!w) return this._clampToMap(x, z);
    const start = this._clampToMap(x, z);
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * TAU * 3;
      const rr = i === 0 ? 0 : Math.sqrt(i) * 6;
      const p = this._clampToMap(start.x + Math.cos(a) * rr, start.z + Math.sin(a) * rr);
      if (!w.blocked(p.x, p.z, MOVE.radius)) return p;
    }
    return start;
  }

  /** 推进运输机与所有跳伞中的玩家。由 update() 在 deploying 期间调用。 */
  _updateDeploy(dt) {
    const f = this.flight;
    if (!f) return;
    f.t = Math.min(f.total, f.t + dt);
    const k = f.total > 0 ? f.t / f.total : 1;
    f.x = f.from.x + (f.to.x - f.from.x) * k;
    f.z = f.from.z + (f.to.z - f.from.z) * k;
    const wasOpen = f.open;
    f.open = f.t >= f.jumpOpen && f.t < f.jumpClose;
    if (f.open && !wasOpen) this._emit('doorOpen', { x: r2(f.x), z: r2(f.z) });
    if (!f.open && wasOpen) this._emit('doorClose', { x: r2(f.x), z: r2(f.z) });

    // 舱门关闭后，仍未跳的玩家被强制弹出（掉队惩罚：落点就是当前机位）
    if (!f.open && f.t >= f.jumpClose) {
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        if (p.deployStage === 'plane') this._beginFreefall(p, null);
      }
    }

    let air = 0;
    let ground = 0;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.deployStage === 'plane') {
        p.x = f.x; p.z = f.z; p.y = DEPLOY.planeHeight;
        air++;
      } else if (p.deployStage === 'freefall' || p.deployStage === 'chute') {
        this._updateParachute(p, dt);
        if (p.deployStage === 'ground') ground++; else air++;
      } else {
        ground++;
      }
    }
    // 全员落地 → 进入 live（自由落体/滑翔都结束）
    if (ground >= this.players.length) {
      this.phase = 'live';
      this.time = 0;
      this._emit('landAll', {});
    }
  }

  /** 单个玩家的自由落体 / 开伞滑翔。
   *
   * 用「时间驱动的分段插值」而不是「速度 × 时长」推进：
   * 跳伞点到落点常常只有 30–50m，而 64 m/s × 2.6s 等于 166m，一帧就冲过头，
   * 实测滑翔阶段持续 0 帧（stage 从 freefall 直接跳 ground），开伞表现与音效全丢了。
   * 现在自由落体按进度吃掉 FREEFALL_SHARE 的水平距离，滑翔精修剩下的，
   * 两个阶段都必有完整时长，且落点精确、与帧率无关（确定性）。 */
  _updateParachute(p, dt) {
    const spot = p.dropSpot || { x: p.x, z: p.z };
    const from = p.deployFrom || { x: p.x, z: p.z };
    p.deployT += dt;
    if (p.deployStage === 'freefall' && p.deployT >= DEPLOY.freefall) {
      p.deployStage = 'chute';
      p.deployT = 0;
      this._emit('chute', { player: p.id, x: r2(p.x), z: r2(p.z) });
    }
    if (p.deployStage === 'freefall') {
      const k = Math.min(1, p.deployT / Math.max(0.01, DEPLOY.freefall)) * FREEFALL_SHARE;
      p.x = from.x + (spot.x - from.x) * k;
      p.z = from.z + (spot.z - from.z) * k;
      p.chute = Math.max(0.45, 1 - (k / FREEFALL_SHARE) * 0.55);
      p.y = DEPLOY.dropHeight * p.chute;
    } else {
      // 滑翔起点固定为自由落体结束时的 78% 位置，保证不受帧率影响
      const gx = from.x + (spot.x - from.x) * FREEFALL_SHARE;
      const gz = from.z + (spot.z - from.z) * FREEFALL_SHARE;
      const k = Math.min(1, p.deployT / Math.max(0.01, DEPLOY.chuteGlide));
      p.x = gx + (spot.x - gx) * k;
      p.z = gz + (spot.z - gz) * k;
      p.chute = Math.max(0, 1 - k) * 0.45;
      p.y = DEPLOY.dropHeight * p.chute;
    }
    const dx = spot.x - p.x;
    const dz = spot.z - p.z;
    if (dx * dx + dz * dz > 0.04) p.angle = Math.atan2(dx, dz);
    if (p.deployStage === 'chute' && p.deployT >= DEPLOY.chuteGlide) {
      p.deployStage = 'ground';
      p.chute = 0;
      p.y = 0;
      p.x = spot.x; p.z = spot.z;
      this._landPlayer(p);
    }
  }

  /** 落地：把玩家放到可走点，散开避免同点重叠，触发 land 事件。 */
  _landPlayer(p) {
    const R = this.world?.radius || 182;
    let x = p.x;
    let z = p.z;
    if (this.world?.blocked && this.world.blocked(x, z, MOVE.radius)) {
      const safe = this._nearestWalkable(x, z);
      x = safe.x; z = safe.z;
    }
    // 同队散开：在一个小圆环上按已有落地人数错开
    let peers = 0;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (q === p || q.deployStage !== 'ground' || q.team !== p.team) continue;
      if (dist(q.x, q.z, x, z) < DEPLOY.landRadius) peers++;
    }
    if (peers > 0) {
      const ang = (peers / 6) * TAU + (p.team * 0.7);
      const rr = 2.2 + peers * 0.9;
      const nx = x + Math.sin(ang) * rr;
      const nz = z + Math.cos(ang) * rr;
      if (!this.world?.blocked || !this.world.blocked(nx, nz, MOVE.radius)) { x = nx; z = nz; }
    }
    p.x = x; p.z = z; p.y = 0; p.chute = 0;
    p.state = 'normal';
    this._emit('land', { player: p.id, x: r2(p.x), z: r2(p.z) });
  }

  _spawnPlayer(p) {
    const spot = this._spawnPoint(p);
    p.x = spot.x; p.z = spot.z; p.y = 0;
    // 难度生命倍率：DIFFICULTY.*.hpMul 此前只写在表里、全项目零引用，
    // 导致「精锐和新兵一样脆，但 dmgMul 却生效」的数值不对称。
    // 玩家（人类）不受难度影响；只有 bot 按自己的档位取 hpMul。
    const hpMul = p.bot ? (DIFFICULTY[p.difficulty]?.hpMul || 1) : 1;
    p.maxHp = Math.round(COMBAT.maxHp * hpMul * 100) / 100;
    p.state = 'normal'; p.hp = p.maxHp; p.alive = true; p.downed = false;
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
    // 降落区投票 hint：仅人类玩家且本队有票质心时生效——出生锚点换成「距 hint 最近」的
    // 一个，队内多人按小队序号展开在固定环位上再叠加原有抖动（环位为纯几何偏移，
    // 不消耗 rng，不影响随机序列），保持队内不重叠；bot 与无 hint 的队完全走原路径
    // （base = team*3 + bot 偏移）。hint → 世界坐标的换算与客户端战术地图一致：
    // 世界 = (归一化 * 2 - 1) * 地图半径。
    const hint = !p.bot && this.dropHints ? this.dropHints[p.team] : null;
    const base = (p.team * 3 + (p.bot ? 1 : 0)) % anchors.length;
    let primary = base;
    let ox = 0;
    let oz = 0;
    if (hint) {
      const worldRadius = this.world?.radius || 182;
      primary = this._nearestAnchor((hint.x * 2 - 1) * worldRadius, (hint.z * 2 - 1) * worldRadius, anchors);
      const slot = this._squadSlot(p);
      const orbit = Math.max(1, this.teamSize);
      const ring = 3.4 + Math.floor(slot / orbit) * 4.4;
      const ang = (slot % orbit) * (TAU / orbit);
      ox = Math.sin(ang) * ring;
      oz = Math.cos(ang) * ring;
    }
    for (let i = 0; i < 8; i++) {
      const a = anchors[(primary + i * 5) % anchors.length];
      const x = a.x + ox + (this.rng() - 0.5) * 4;
      const z = a.z + oz + (this.rng() - 0.5) * 4;
      if (!this.world.blocked(x, z, MOVE.radius)) return { x, z };
    }
    const a = anchors[primary] || anchors[0];
    return { x: a.x + ox, z: a.z + oz };
  }

  /** 距 (hx,hz) 最近的出生锚点下标；并列时取下标更小者（确定性，不消耗 rng）。 */
  _nearestAnchor(hx, hz, anchors) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      const d = (anchors[i].x - hx) ** 2 + (anchors[i].z - hz) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** p 在本队人类中的出生序号（players 数组顺序，用于 hint 环位展开）。 */
  _squadSlot(p) {
    let slot = 0;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (q === p) break;
      if (q.team === p.team && !q.bot) slot++;
    }
    return slot;
  }

  // ── 主循环 ────────────────────────────────────────────────────────────────
  update(dt = 1 / TICK_RATE) {
    const step = Number.isFinite(dt) ? clamp(dt, 0.0001, 0.1) : 1 / TICK_RATE;
    if (this.phase === 'ended') return;
    this.tickCount++;
    if (this.phase === 'waiting' || this.phase === 'loading') return;
    this.time += step;
    this.matchTime += step;
    if (this.phase === 'deploying') {
      // skydive：由航线状态机决定何时进入 live（全员落地）；
      // instant：保持 1.x 的「2.5 秒后自动开打」。
      if (this.flight) this._updateDeploy(step);
      else if (this.time > 2.5) this.phase = 'live';
    }
    // loot 压实：每 50 tick（≈1.7s 模拟时间）剔除已拾取物资。保持相对顺序与 id 稳定，
    // 快照/拾取/交互扫描随对局推进变短；客户端差量协议按 id 水合，「剔除」与原来的
    // 「taken 后不再下发」对客户端完全等价（两者都表现为 lootPatch.remove）。
    if (this.tickCount % 50 === 0) this._compactLoot();
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

  /** 波次流转已完全交给 shared/horde.mjs（updateWaveFlow），这里保留空壳兼容旧调用点。 */
  _reachHorde() {}

  _resolveHordeClear() {}

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
    this._snapCache = null; // connected 字段进快照基座，断线后立刻失效
    return true;
  }

  reconnect(id) {
    const p = this._find(id);
    if (!p) return false;
    p.connected = true;
    this._snapCache = null;
    return true;
  }

  _find(id) {
    for (let i = 0; i < this.players.length; i++) if (this.players[i].id === id) return this.players[i];
    return null;
  }

  /**
   * 发一条事件。
   *
   * ⚠ `id` 是**事件序号**，绝不能被 data 覆盖。
   * 历史实现是 `for (const k in data) ev[k] = data[k]`，而大量调用方把「实体 id」
   * 也命名为 `id`（`_emit('explosion', { id: g.id })`、`_emit('smoke', { id: 's12' })` …），
   * 于是 `ev.id` 变成字符串 `"g9"` / `"s12"`。而 snapshot() 的事件窗口按
   * `ev.id > sinceEventId`（字符串 vs 数字）过滤，比较恒为 false ——
   * **所有带实体 id 的事件都被静默丢弃**：爆炸、烟雾、燃烧、闪光、空投、
   * 以及 horde 的 Boss 技能在联机模式全部没有特效表现。
   *
   * 修法：data 里的 `id` 自动改名为 `entityId`（保持调用点不变，兼容客户端
   * 已有的 `ev.id` 读取逻辑——客户端读 `ev.id` 的地方现在读的是真正的实体 id，
   * 与旧行为一致），事件序号始终用 `id`。
   */
  /**
   * 把一次声响投递给 AI 听觉表（不产生网络事件，纯服务端共享状态）。
   *
   * 为什么需要它：AI 之前只有「视线」一种感知，`weapon.noise` 字段全项目零引用——
   * 消音器除了伤害更低没有任何作用，蹲伏潜行、绕后这些战术完全不存在。
   * 现在枪声按可听半径写入 `match.soundBoard`，AI 会把「听到但没看到」的位置
   * 当作低置信度目标位置（见 ai.mjs 的 hearsOf），形成「听声辨位 → 摸过去」的行为。
   *
   * radius 是球半径；同一时刻只保留最近一次（每队一份），避免表无限增长。
   */
  _emitSound(source, radius, kind = 'shot') {
    if (!source || !(radius > 0)) return;
    if (!this.soundBoard) this.soundBoard = new Map();
    const team = source.team | 0;
    // 每队一份，且只保留 4 秒：过期声音会把 bot 引到早已离开的位置。
    this.soundBoard.set(team, {
      x: r2(source.x), z: r2(source.z), r: r2(radius), t: r2(this.time), kind,
      by: source.id,
    });
    // 无队伍归属的声音（手雷/载具）单独存 key，供所有队监听。
    this.soundBoard.set('world', {
      x: r2(source.x), z: r2(source.z), r: r2(radius), t: r2(this.time), kind, by: source.id || null,
    });
  }

  _emit(type, data) {
    this.eventId++;
    const ev = { id: this.eventId, type, time: r2(this.time) };
    if (data) {
      for (const k in data) {
        if (k === 'id') { ev.entityId = data[k]; continue; }
        ev[k] = data[k];
      }
    }
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
      // 空降中：玩家不在地面，移动/开火/治疗全部接管给 _updateDeploy；
      // 只在这里消费一次 jump 意图（窗口外会被 jumpFromPlane 拒绝）。
      if (p.deployStage && p.deployStage !== 'ground') {
        if (p.input && p.input.jump && !p.jumpLatch) {
          p.jumpLatch = true;
          // 客户端可在按下跳伞的那一帧带上落点（jumpAt，归一化 0-1）。
          // 没有就退回队伍 hint / 随机锚点（见 _beginFreefall）。
          const at = sanitizeJumpAt(p.input.jumpAt);
          this.jumpFromPlane(p.id, at);
        } else if (p.input && !p.input.jump) {
          p.jumpLatch = false;
        }
        continue;
      }
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
      if (p.stats) p.stats.dodges += 1;
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
    let heads = 0;
    let lastX = ox; let lastZ = oz;
    for (let i = 0; i < pellets; i++) {
      const a = p.angle + (this.rng() * 2 - 1) * spread;
      const dx = Math.sin(a); const dz = Math.cos(a);
      const hit = this._traceShot(ox, oz, dx, dz, weapon.range, p);
      if (hit) {
        hits++;
        if (hit.head) heads++;
        this._applyShotDamage(p, hit, weapon);
      }
      lastX = ox + dx * Math.min(weapon.range, hit ? hit.t : weapon.range);
      lastZ = oz + dz * Math.min(weapon.range, hit ? hit.t : weapon.range);
    }
    p.spreadBloom = Math.min(2.4, p.spreadBloom + weapon.recoil * 0.11);
    p.recoil = Math.min(9, p.recoil + weapon.recoil * 0.55);
    this.counters.shots++;
    if (hits > 0) this.counters.hits++;
    // 权威累计（不依赖事件窗口，见 addPlayer 里 stats 字段的注释）
    p.stats.shotsFired += 1;
    if (hits > 0) p.stats.shotsHit += 1;
    if (heads > 0) p.stats.headshots += heads;
    if (weapon.id && !p.stats.weaponsUsed.includes(weapon.id)) p.stats.weaponsUsed.push(weapon.id);
    this._emit('shot', {
      player: p.id, x: r2(ox), z: r2(oz), tx: r2(lastX), tz: r2(lastZ),
      weapon: weapon.id, hit: hits > 0, hits, headshots: heads,
    });
    // 枪声传播：AI 听觉的唯一输入源。半径 = 基础 78m × 武器 noise，
    // 消音器（noise≈0.45）能把可听半径压到 35m，这才是它真正的战术价值
    // —— 此前 noise 字段全项目零引用，消音器只是个「伤害更低的枪口」。
    this._emitSound(p, 78 * (weapon.noise || 1), 'shot');
    if (slot.ammo <= 0) this.reload(p);
    return true;
  }

  _traceShot(ox, oz, dx, dz, range, shooter) {
    let best = null; let bestT = range;
    // 霰弹（多弹丸）不做要害判定，见下方 head 的注释。
    const multPellets = (effectiveWeapon(shooter)?.pellets || 1) > 1;
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
      // 要害判定：命中点到人体中轴线的横向偏移落在「核心区」内算要害（爆头）。
      // 这是 2D 俯视角，没有真实高度判定，所以用「是否打在躯干正中心」代理：
      // 核心区比例由 rules.COMBAT.headshotCoreRatio 统一控制（0.38 ≈ 命中圆内约 14% 面积），
      // 贴脸时几乎必然打中，远距离需要瞄准更精确——正好符合要害的风险回报。
      //
      // 霰弹特例：pellets > 1 的武器不参与要害判定。
      // 原因：8m 内散布锥小于核心区，9 颗弹丸会几乎全部判要害，单发伤害 99 × 1.5 ≈ 148.5，
      // 对裸甲 3m/5m 100% 秒杀、8m 93% 秒杀，而设计意图是「贴脸 2 发必杀」。
      // 霰弹的强度已经由「弹丸总数 × 近距全中」体现，再乘爆头倍率是双重放大。
      const head = !multPellets && perp < radius * COMBAT.headshotCoreRatio;
      bestT = t; best = { kind: 'player', target: q, t, head };
    }
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.dead) continue;
      const rx = c.x - ox; const rz = c.z - oz;
      const t = rx * dx + rz * dz;
      if (t <= 0.3 || t > bestT) continue;
      const perp = Math.abs(rx * dz - rz * dx);
      if (perp > 1.6) continue;
      // 车体命中不能「吞掉」已命中的乘员。
      //
      // 历史 bug：乘员坐标被强行同步到 car.x/car.z（见 _driveInput），而车体半径 1.6
      // 大于玩家 0.7，且 `t > bestT` 在相等时继续（不跳过），于是任何射向乘员的子弹
      // 都被车体截胡 —— 实测 300 发全打车上、乘员 0 命中。载具因此成为「6 人免疫
      // 子弹的移动堡垒」，唯一反制是打爆车（AR7 需 17 发）或撞击。
      // 修法：若当前最佳命中已经是「在这辆车里的玩家」，让子弹穿过车体打人。
      if (best && best.kind === 'player' && best.target && best.target.car === c.id) continue;
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
      let falloff = damageAtDistance(weapon, dist);
      const mul = DIFFICULTY[shooter.difficulty]?.dmgMul || 1;
      // 要害：武器自身 headshotMul（1.4–2.2）直接作为倍率，
      // 不再叠加 COMBAT.headshotMul，避免双重放大；缺省回落到全局默认 1.8。
      // 倒地目标同样吃要害倍率，与 damage() 内的 downedDamageMul 乘算叠加（先要害、后倒地）。
      let head = false;
      if (hit.head) {
        head = true;
        falloff = damageAtDistance(weapon, dist) * (weapon.headshotMul || COMBAT.headshotMul);
      }
      const applied = this.damage(target, falloff * mul, shooter.id, { weapon: weapon.id, source: shooter, headshot: head });
      shooter.accuracy = shooter.accuracy * 0.98 + 0.02;
      if (head) {
        shooter.headshots = (shooter.headshots || 0) + 1;
        this.counters.headshots = (this.counters.headshots || 0) + 1;
        this._emit('headshot', { player: shooter.id, target: target.id, damage: r2(applied || 0) });
      }
    } else if (hit.kind === 'car') {
      const car = hit.target;
      this._damageCar(car, damageAtDistance(weapon, hit.t), shooter);
    } else if (hit.kind === 'enemy') {
      const e = hit.target;
      e.hp -= damageAtDistance(weapon, hit.t);
      e.flash = 0.12;
      if (e.hp <= 0 && !e.dead) Horde.awardKill(this, e);
    }
  }

  // ── 伤害 / 倒地 / 淘汰 ────────────────────────────────────────────────────
  damage(target, amount, sourceId = null, opts = {}) {
    // 权威累计：受到的伤害（用于「无伤吃鸡」成就与受击统计）
    if (target && target.stats && amount > 0) target.stats.damageTaken += amount;
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
    // 毒圈伤害无视护盾/护甲：护盾与护甲是「挡子弹」的资源，不该同时延长圈外生存。
    // 旧行为里 P5（28/s）裸甲能活 3.6s、重甲+满盾能活 10.8s（3 倍），
    // 等于把「跑圈」的惩罚按装备折算，决赛圈变成装备检定而不是位置博弈。
    // PUBG 类游戏的通行做法是圈伤直接打血，这里沿用。
    const ignoreGear = opts.zone === true;
    if (!ignoreGear && target.shield > 0) {
      const s = Math.min(target.shield, dmg);
      target.shield -= s; dmg -= s;
    }
    if (!ignoreGear && dmg > 0 && target.armor > 0 && target.armorTier > 0) {
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
      else this.kill(target, sourceId, opts.reason || (opts.zone ? 'zone' : 'shot'));
    }
    return dmg;
  }

  heal(target, amount) {
    if (!target || !target.alive) return 0;
    const before = target.hp;
    // 用目标自己的血量上限：精英 bot 的 maxHp 是 105，写死 100 会让治疗永远补不满。
    target.hp = Math.min(target.maxHp || COMBAT.maxHp, target.hp + amount);
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
    // 击倒计入攻击者的权威统计（此前 p.downs 从不自增，d_down4 / a_knock_20 永不可达）
    const src = sourceId ? this._find(sourceId) : null;
    if (src && src !== p && src.stats) src.stats.downs += 1;
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
      if (src.stats) src.stats.kills += 1;
    }
    this.counters.kills++;
    // 击杀事件带武器类别与蹲姿：任务/成就里的 killsPistol / killsSniper / crouchKills
    // 等 6 个指标此前永远为 0，因为事件里没有 weaponClass / crouch 字段。
    const srcWeapon = src ? effectiveWeapon(src) : null;
    this._emit('kill', {
      player: target.id, by: sourceId, reason, team: target.team,
      x: r2(target.x), z: r2(target.z), name: target.name,
      attackerName: src && src !== target ? src.name : null,
      weapon: srcWeapon ? srcWeapon.id : null,
      weaponClass: srcWeapon ? (srcWeapon.cls || srcWeapon.category || null) : null,
      crouch: !!(src && src.state === 'crouch'),
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
    // 只有对局真正开始后才判定团灭。
    // 历史 bug：removePlayer() 会无条件调这里，而 waiting/loading 阶段玩家全在同一队
    // 或人数很少时，`alive.size <= 1` 直接成立 → 大厅里有人退出就把整场比赛判结束，
    // 房主再点开始会收到 start=false（表现为「房间莫名无法开局」）。
    if (this.phase === 'waiting' || this.phase === 'loading') return;
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
    if (p.stats) p.stats.healItems += 1;
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
    if (p.stats) p.stats.throws += 1;
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
          this.damage(q, THROWABLES.molotov.burn * 0.5, f.owner, { source: this._find(f.owner), reason: 'fire' });
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
        // 友军伤害：枪械由 COMBAT.friendlyFire=0 完全关闭，但手雷是面积伤害，
        // 旧实现在这里没有队友判定 —— 一颗雷能把三个队友和自己一起打成残血，
        // 「四人小队的雷比敌人的雷更致命」。这里与枪械口径对齐：
        // 队友只吃 30%（保留「别乱扔雷」的惩罚，但不至于团灭自己人）。
        if (owner && q !== owner && q.team === owner.team && COMBAT.friendlyFire <= 0) {
          const blockedF = !this.world.clearLine({ x: g.x, z: g.z }, { x: q.x, z: q.z });
          const falloffF = Math.max(0.2, 1 - (d / (radius * 0.95)));
          this.damage(q, def.damage * falloffF * (blockedF ? 0.45 : 1) * 0.3, g.owner, { source: owner, noDown: true, reason: 'grenade' });
          continue;
        }
        const blocked = !this.world.clearLine({ x: g.x, z: g.z }, { x: q.x, z: q.z });
        const falloff = Math.max(0.2, 1 - (d / (radius * 0.95)));
        let dmg = def.damage * falloff * (blocked ? 0.45 : 1);
        if (q.id === g.owner) dmg *= 0.5;
        this.damage(q, dmg, g.owner, { source: owner, noDown: true, reason: 'grenade' });
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
      if (p.stats) p.stats.pickups += 1;
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
      if (p.stats) p.stats.pickups += 1;
      this._emit('pickup', { player: p.id, item: key, kind: 'ammo' });
      return true;
    }
    if (l.kind === 'armor') {
      const def = ARMORS[l.item];
      if (!def || def.tier <= p.armorTier) return false;
      p.armorTier = def.tier;
      p.armor = def.durability;
      l.taken = true;
      if (p.stats) p.stats.pickups += 1;
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
    if (p.stats) p.stats.pickups += 1;
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
    if (this.world.blocked(nx, nz, 1.9)) {
      // 撞墙：按冲击速度扣载具耐久（这部分损失是合理的，替代原先「行驶即自损」）
      const impact = Math.abs(car.speed);
      car.speed *= -0.25;
      if (impact > 6 && car.hitCd <= 0) {
        car.hitCd = 0.6;
        // 撞墙伤害要有、但不能成为主要损毁来源：按冲击速度的 0.6 倍结算，
        // 并设 12 点上限。否则一次全速撞墙（15.5 m/s → 24.8 伤害）+ 反弹后再撞，
        // 会让「撞墙」比被枪打更致命，与「载具是位移工具」的定位相悖。
        this._damageCar(car, Math.min(12, impact * 0.6), null);
        this._emit('vehicle', { action: 'crash', car: car.id, speed: r2(impact) });
      }
    } else { car.x = nx; car.z = nz; }
    for (let s = 0; s < car.seats; s++) {
      const q = car.occupants[s] ? this._find(car.occupants[s]) : null;
      if (q) { q.x = car.x; q.z = car.z; }
    }
    car.hitCd = Math.max(0, car.hitCd - dt);
    if (Math.abs(car.speed) > 4 && car.hitCd <= 0) {
      let rammed = false;
      for (let i = 0; i < this.players.length; i++) {
        const q = this.players[i];
        if (!q.alive || q.car != null) continue;
        if (car.occupants.includes(q.id)) continue;
        if (dist(q.x, q.z, car.x, car.z) > 2.2) continue;
        // 队友不被自己人撞：与枪械口径一致（COMBAT.friendlyFire = 0）。
        // 旧实现照撞不误 —— 司机一慌就打转把队友撞成重伤，是四人小队里最莫名其妙的死法。
        const driver = car.driver ? this._find(car.driver) : null;
        if (driver && q.team === driver.team && COMBAT.friendlyFire <= 0) continue;
        this.damage(q, Math.abs(car.speed) * 3.4, car.driver, { reason: 'vehicle' });
        rammed = true;
        this._emit('vehicle', { action: 'hit', car: car.id, player: q.id, speed: r2(car.speed) });
      }
      // 自损**只在真的撞到人时**结算。
      //
      // 历史实现把 `_damageCar(speed * 0.35)` 写在 if 块末尾、无条件执行：全油门
      // 行驶 1 秒会调用 27 次 _damageCar、把 220 HP 的沙滩越野从 220 打到 108
      // ——车永远开不到安全区，AI 的「载具转移」战术因此完全失效。
      // 撞车损毁应该来自「撞到人」与「撞墙」（见上方 blocked 分支），而不是行驶本身。
      if (rammed) {
        car.hitCd = 0.45;
        this._damageCar(car, Math.abs(car.speed) * 0.9, null);
      }
    }
  }

  /**
   * 载具乘客开火。
   *
   * 历史实现只发一条 `hit:false` 的 shot 事件、不调 `_traceShot`/`_applyShotDamage`，
   * 乘员持续开火 3 秒目标 HP 纹丝不动 —— 车里的人既免疫子弹（见 _traceShot 的车体
   * 命中优先）又不能输出，载具变成「移动堡垒但无火力」，与设计意图相反。
   * 现在真正跑弹道判定，并给车载射击一个散布惩罚（1.6×）作为代价。
   */
  tryFireVehicle(p, car) {
    const weapon = effectiveWeapon(p);
    if (!weapon || p.fireCd > 0) return false;
    const slot = p.loadout[p.slot];
    if (!slot || slot.ammo <= 0) { this.reload(p); return false; }
    p.fireCd = weapon.interval;
    p.spreadBloom = Math.min(2.4, p.spreadBloom + weapon.recoil * 0.11);
    p.recoil = Math.min(9, p.recoil + weapon.recoil * 0.55);
    slot.ammo -= 1;
    const ox = p.x, oz = p.z;
    const baseSpread = (weapon.spread + p.spreadBloom * weapon.spread * 1.4 + p.recoil * 0.0012) * 1.6;
    let hits = 0; let heads = 0; let lastX = ox; let lastZ = oz;
    const pellets = Math.max(1, weapon.pellets | 0);
    for (let i = 0; i < pellets; i++) {
      const a = p.angle + (this.rng() * 2 - 1) * baseSpread;
      const dx = Math.sin(a), dz = Math.cos(a);
      const hit = this._traceShot(ox, oz, dx, dz, weapon.range, p);
      if (hit) {
        hits++;
        if (hit.head) heads++;
        this._applyShotDamage(p, hit, weapon);
      }
      lastX = ox + dx * Math.min(weapon.range, hit ? hit.t : weapon.range);
      lastZ = oz + dz * Math.min(weapon.range, hit ? hit.t : weapon.range);
    }
    if (hits > 0) p.stats.shotsHit += 1;
    p.stats.shotsFired += 1;
    if (heads > 0) p.stats.headshots += heads;
    this._emit('shot', {
      player: p.id, x: r2(ox), z: r2(oz), tx: r2(lastX), tz: r2(lastZ),
      weapon: weapon.id, hit: hits > 0, hits, headshots: heads, vehicle: true,
    });
    if (slot.ammo <= 0) this.reload(p);
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
    // 乘员集合：爆炸半径的第二轮**必须跳过**他们。
    // 历史 bug：_exitCar 把乘员放到车侧 2.2m，随后半径 6m 的第二轮爆炸又对他们
    // 结算最多 70 伤害 —— 实测两名满血乘员 100/100 → 0.7/0.7（55 + 44.3）。
    // 四排一辆车被击毁 = 全队瞬间残血，几乎必死。乘员只吃一次 55 点。
    const riders = new Set();
    for (let s = 0; s < riderIds.length; s++) {
      const q = riderIds[s] ? this._find(riderIds[s]) : null;
      if (!q) continue;
      riders.add(q.id);
      this._exitCar(q, true);
      this.damage(q, 55, null, { noDown: true, reason: 'explosion' });
    }
    car.occupants.fill(null);
    car.driver = null;
    for (let i = 0; i < this.players.length; i++) {
      const q = this.players[i];
      if (!q.alive || q.car != null) continue;
      if (riders.has(q.id)) continue;      // 乘员已单独结算，不再吃爆炸二段
      const d = dist(q.x, q.z, car.x, car.z);
      if (d > 6) continue;
      this.damage(q, 70 * (1 - d / 6), shooter ? shooter.id : null, { noDown: true, reason: 'explosion' });
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
    // 空降阶段（skydive 的机舱/伞降）不推进缩圈：玩家没有位移自由，
    // 提前缩圈只会让「跳得晚的人还没落地就站在圈外」。
    if (this.phase === 'deploying' && this.flight) return;
    if (this.hordeMode || this.mode === 'training') {
      this._applyZoneDamage(dt, 0);
      return;
    }
    z.nextIn = Math.max(0, z.nextIn - dt);
    // 名义总时长 = 每个阶段的「等待 + 收缩」之和。
    // 首圈等待就是 ZONE_PHASES[0].wait（见 rules.mjs 的 ZONE_FIRST_WAIT 别名），
    // 这里不能再额外加一次，否则 totalTime 会凭空多出一段从未真正流逝的时间
    // （旧代码 = 26 + 208 = 234s，而真实时间线只有 204s）。
    const total = ZONE_PHASES.reduce((a, p) => a + p.wait + p.shrink, 0);
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
    // 空降阶段（飞机上/伞降中）不吃圈伤：玩家没有位移自由，掉血只会惩罚运气。
    if (this.phase === 'deploying') return;
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
    if (p && p.stats) p.stats.airdrops += 1;
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
      if (p.stats) p.stats.revives += 1;
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
      horde: Horde.runSummary(this.hordeRun),
    };
    this._emit('end', {
      winnerTeam: winTeam, reason, ranks: ranks.slice(0, 8),
      horde: this.result.horde,
    });
    return true;
  }

  spawnWave(n = 1, count = 6) {
    if (!this.hordeRun) return 0;
    return this._spawnEnemies(count, n);
  }

  // ── horde（PvE 波次） ─────────────────────────────────────────────────────
  // 敌人 AI / 波次编排 / 升级效果在 shared/horde.mjs；这里只保留「开局 / 桥接 / 查询」。
  _startHorde() {
    const spot = this.world.spawnAnchors[0] || { x: 0, z: 0 };
    this.hordeRun = Horde.createRun(this, spot.x, spot.z);
    const base = this.hordeRun.base;
    this.enemies = this.hordeRun.enemies;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.loadout = [null, null];
      this._applyLoadout(p, [{ type: 'ak12' }, { type: 'p9' }]);
      p.mags = { light: 180, medium: 200, heavy: 60, shell: 30, bolt: 20 };
      p.armorTier = 2; p.armor = ARMORS.armor2.durability;
      p.shield = 100; p.meds = 3; p.bandages = 5; p.energy = 2; p.shields = 2;
      p.grenades = 3; p.smokes = 1; p.flashes = 1; p.molotovs = 1;
      p.respawnIn = HORDE.reviveAfter;
      this._spawnPlayer(p);
      p.x = base.x + Math.cos(i * 1.1) * 4; p.z = base.z + Math.sin(i * 1.1) * 4;
    }
    this.phase = 'live';
    this.time = 0; this.matchTime = 0;
    this.zone = { x: base.x, z: base.z, r: 120, target: { x: base.x, z: base.z, r: 120 }, closing: false, damage: 0, phase: -1, nextIn: 0 };
    this._emit('hordeStart', { waves: HORDE.waves, baseX: r2(base.x), baseZ: r2(base.z) });
    return true;
  }

  /** 兼容旧接口：按数量补刷（wave 用于决定数值曲线）。 */
  _spawnEnemies(count, wave = 1) {
    const run = this.hordeRun;
    if (!run) return 0;
    const prev = run.wave;
    run.wave = Math.max(1, wave | 0);
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      if (run.enemies.length >= run.activeCap) break;
      const e = Horde.spawnEnemy(this, 'crawler');
      if (e) spawned++;
    }
    run.wave = prev;
    return spawned;
  }

  /** 每帧推进：波次流转 / 敌人 AI / 炮塔 / 毒圈 / 复活全部委托 horde.mjs。 */
  _updateHorde(dt) {
    const run = this.hordeRun;
    if (!run || this.phase === 'ended') return;
    const base = run.base;
    Horde.update(this, dt);
    if (this.phase === 'ended') return;
    // 玩家阵亡 → 基地复活（1–5 波 6s / 6–12 波 10s / 13+ 波 14s）
    const delay = Horde.reviveDelay(run);
    run.reviveAt = delay;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.alive && p.connected) {
        p.respawnIn = (Number.isFinite(p.respawnIn) ? p.respawnIn : delay) - dt;
        if (p.respawnIn <= 0) {
          p.respawnIn = delay;
          this.revive(p);
          p.hp = 70;
          p.x = base.x + (this.rng() - 0.5) * 6;
          p.z = base.z + (this.rng() - 0.5) * 6;
          this._emit('respawn', { player: p.id, delay });
        }
      }
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
      e.flash = 0.12;
      if (e.hp <= 0) {
        killed++;
        Horde.awardKill(this, e);
      }
      break;
    }
    if (run.enemies.length && run.enemies.every((e) => e.hp <= 0)) Horde.clearWave(this);
    return killed;
  }

  _startNextWave() {
    const run = this.hordeRun;
    if (!run) return 0;
    if (!run.endless && run.wave >= run.totalWaves) { Horde.finishRun(this, 'cleared'); return 0; }
    run.waveCleared = false;
    run.nextWaveIn = 0;
    return Horde.beginWave(this, run.wave + 1);
  }

  upgradeCost(kind) {
    const def = HORDE.upgrades[kind];
    if (!def) return Infinity;
    const run = this.hordeRun;
    const bought = run ? run.upgradesBought?.[kind] || 0 : 0;
    if (Number.isFinite(def.max) && bought >= def.max) return Infinity;
    return def.baseCost + def.step * bought;
  }

  /** 升级实现（rules.HORDE.upgrades[kind].apply 调这里，避免循环依赖）。 */
  hordeUpgrade(kind, team = null) {
    const run = this.hordeRun;
    if (!run) return false;
    const def = HORDE.upgrades[kind];
    if (!def) return false;
    const base = run.base;
    const teammates = this.players.filter((q) => team == null || q.team === team);
    if (kind === 'repair') {
      base.hp = Math.min(base.maxHp, base.hp + base.maxHp * 0.3);
    } else if (kind === 'ammo') {
      for (const q of teammates) {
        q.mags = { light: 240, medium: 240, heavy: 90, shell: 48, bolt: 30 };
        q.meds = Math.max(q.meds, 3); q.bandages = Math.max(q.bandages, 5);
        q.grenades = Math.max(q.grenades, 3); q.smokes = Math.max(q.smokes, 2);
        q.flashes = Math.max(q.flashes, 1);
      }
    } else if (kind === 'armor') {
      for (const q of teammates) {
        q.armorTier = Math.min(3, Math.max(q.armorTier || 1, (q.armorTier || 0) + 1));
        q.armor = armorForTier(q.armorTier)?.durability || 60;
      }
    } else if (kind === 'turret') {
      const cap = HORDE.upgrades.turret.max || 4;
      if (run.turrets.length >= cap) return false;
      const a = (run.turrets.length / cap) * TAU + 0.4;
      run.turrets.push({
        id: `t${run.turrets.length + 1}`,
        x: base.x + Math.cos(a) * 5.5, z: base.z + Math.sin(a) * 5.5,
        angle: a, cd: 0, damage: 26, range: 26,
      });
      base.turrets = run.turrets.length;
    } else if (kind === 'barricade') {
      const cap = HORDE.upgrades.barricade.max || 6;
      if (run.barricades.length >= cap) return false;
      const a = (run.barricades.length / cap) * TAU;
      run.barricades.push({ id: `bc${run.barricades.length + 1}`, x: base.x + Math.cos(a) * 9, z: base.z + Math.sin(a) * 9, r: 3.2 });
    } else if (kind === 'medstation') {
      run.medstations = Math.min(HORDE.upgrades.medstation.max || 3, run.medstations + 1);
    } else if (kind === 'airstrike') {
      const alive = run.enemies.filter((e) => e.hp > 0 && !e.dead);
      const kill = Math.floor(alive.length * 0.6);
      for (let i = 0; i < kill; i++) Horde.awardKill(this, alive[i]);
      this._emit('airstrike', {
        x: r2(base.x), z: r2(base.z), killed: kill, total: alive.length,
      });
    } else if (kind === 'slowfield') {
      run.slowfields = Math.min(HORDE.upgrades.slowfield.max || 2, run.slowfields + 1);
    } else if (kind === 'weaponcache') {
      const pool = ['v9', 'mp5k', 'ar7', 'ak12', 'bullpup', 'm14', 's12'];
      for (const q of teammates) {
        const idx = Math.floor(this.rng() * pool.length);
        const type = pool[Math.min(pool.length - 1, idx)];
        q.loadout[0] = null;
        this._applyLoadout(q, [{ type }, q.loadout[1] ? { type: q.loadout[1].type } : { type: 'p9' }]);
        q.mags = { light: 240, medium: 240, heavy: 90, shell: 48, bolt: 30 };
      }
    } else if (kind === 'overcharge') {
      run.overchargeWaves = 1;
      run.overcharge = true;
    } else {
      return false;
    }
    return true;
  }

  _buy(p, kind) {
    const run = this.hordeRun;
    if (!run || !HORDE.upgrades[kind]) return false;
    const cost = this.upgradeCost(kind);
    if (!Number.isFinite(cost) || run.credits < cost) return false;
    const team = p ? p.team : null;
    const def = HORDE.upgrades[kind];
    if (typeof def.apply === 'function' ? !def.apply(this, team) : !this.hordeUpgrade(kind, team)) return false;
    run.credits -= cost;
    run.upgradesBought = run.upgradesBought || {};
    run.upgradesBought[kind] = (run.upgradesBought[kind] || 0) + 1;
    this._emit('upgrade', { player: p ? p.id : null, kind, cost, name: def.name });
    return true;
  }

  // ── Bot 与快照 ────────────────────────────────────────────────────────────
  _bots(dt) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.bot || !p.alive) continue;
      // 空降中：bot 自己决定何时跳伞（否则窗口一关会被强制弹出，全挤在机尾）。
      if (p.deployStage && p.deployStage !== 'ground') {
        this._botDeploy(p);
        continue;
      }
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
      // 倒地 bot 不走动作分派：reviveProgress 存在倒地者身上，
      // 倒地 bot 的 _handleActions 会把队友正在积累的救援进度清零（与倒地人类行为对齐）。
      if (!p.downed) this._handleActions(p, dt);
    }
  }

  /** bot 跳伞决策：离自己的目标落点最近时跳（不是随机跳，否则全图散沙）。 */
  _botDeploy(p) {
    const f = this.flight;
    if (!f || !f.open || p.deployStage !== 'plane') return;
    // 目标：优先队伍落点 hint（投票），否则用队伍锚点；换算成世界坐标。
    let tx = f.x + f.ux * 30;
    let tz = f.z + f.uz * 30;
    if (p.dropSpot) { tx = p.dropSpot.x; tz = p.dropSpot.z; }
    else {
      const hint = this.dropHints ? this.dropHints[p.team] : null;
      const R = this.world?.radius || 182;
      const anchors = this.world?.spawnAnchors || [];
      if (hint) {
        tx = (hint.x * 2 - 1) * R;
        tz = (hint.z * 2 - 1) * R;
      } else if (anchors.length) {
        const a = anchors[(p.team * 3 + 1) % anchors.length];
        tx = a.x; tz = a.z;
      }
    }
    const d = dist(f.x, f.z, tx, tz);
    // 距离目标 < 60m 或窗口快关时跳；bot 之间用 index 抖动避免同帧全跳
    const late = f.jumpClose - f.t < 3.2;
    const close = d < 60;
    if (close || late) {
      const R = this.world?.radius || 182;
      this._beginFreefall(p, { x: (tx / R + 1) / 2 + (p.team % 3) * 0.004, z: (tz / R + 1) / 2 });
    }
  }

  teamName(team) {
    return TEAM_NAMES[team] || `小队 ${team + 1}`;
  }

  /** horde 里 bot 的守家行为：贴基地、点最靠近基地的敌人、残血回撤。返回 true 表示已接管。 */
  _hordeBot(p, dt) {
    const run = this.hordeRun;
    const base = run.base;
    // 优先打「离基地最近」的敌人（漏怪才是真的输），而不是离自己最近的
    let target = null; let bestScore = Infinity;
    for (let i = 0; i < run.enemies.length; i++) {
      const e = run.enemies[i];
      if (e.hp <= 0) continue;
      const d = dist(p.x, p.z, e.x, e.z);
      if (d > 40) continue;
      const threat = dist(e.x, e.z, base.x, base.z) - (e.kind === 'boss' ? 12 : 0) - (e.kind === 'suicide' ? 6 : 0);
      if (threat < bestScore) { bestScore = threat; target = e; }
    }
    const toBase = dist(p.x, p.z, base.x, base.z);
    const inp = emptyInput();
    const hurt = p.hp / Math.max(1, COMBAT.maxHp);
    // 残血：回基地圈内、边走边打（医疗站/掩体会救你）
    const retreating = hurt < 0.45 && toBase > 3.5;
    if (target) {
      p.angle = Math.atan2(target.x - p.x, target.z - p.z);
      inp.aim = p.angle;
      const d = dist(p.x, p.z, target.x, target.z);
      inp.fire = d < 32 && p.reloadTime <= 0;
      if (p.fireCd <= 0.02) this.tryFire(p);
      if (p.reloadTime <= 0 && p.loadout[p.slot] && p.loadout[p.slot].ammo === 0) inp.reload = true;
      if (retreating) {
        const a = Math.atan2(base.x - p.x, base.z - p.z);
        inp.mx = Math.sin(a) * 0.85; inp.mz = Math.cos(a) * 0.85;
      } else if (d > 11) { inp.mx = Math.sin(p.angle) * 0.7; inp.mz = Math.cos(p.angle) * 0.7; }
    } else if (toBase > 6) {
      const a = Math.atan2(base.x - p.x, base.z - p.z);
      inp.mx = Math.sin(a); inp.mz = Math.cos(a); inp.aim = a;
    } else if (hurt < 0.9 && p.healTime <= 0) {
      // 没敌人时回血，别带着残血进下一波
      const kind = p.meds > 0 ? 'medkit' : (p.bandages > 0 ? 'bandage' : null);
      if (kind) this.useItem(p, kind);
    }
    p.input = inp;
    p.moved = inp.mx !== 0 || inp.mz !== 0;
    if (inp.mx || inp.mz) {
      const speed = MOVE.walk * (hurt < 0.3 ? 1.12 : 0.9);
      this.world.moveBody(p, inp.mx * speed * dt, inp.mz * speed * dt, MOVE.radius);
    }
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
      // 空降阶段：plane（舱内）/ freefall（自由落体）/ chute（开伞）/ ground（已落地）。
      // 只在 skydive 模式写入该键 —— instant 模式下键必须完全缺失，
      // 二进制侧同样不写（PLAYER_SCHEMA 里没有默认值），两端键集合才能一致。
      ...(p.deployStage ? { deployStage: p.deployStage } : null),
    };
  }

  /**
   * 快照共享基座：与观察者无关的部分（zone/counts/cars/手雷/烟/火/空投/标记/horde/
   * result/玩家视图/loot 视图）每个 tick 只构建一次，全房间复用。观察者相关的部分
   * （可见集过滤、me/teammates、sinceEventId 事件窗口）仍在 snapshot() 里逐份组装，
   * 顶层 state 对象每份新建 —— 输出字段、取值与逐份重建完全一致（协议 v3 不变）。
   * 有效性闸门：tickCount/eventId/players.length/loot.length 任一变化即失效，
   * 覆盖 start/end/kill/addPlayer/addLoot/disconnect 等所有会改变基座内容的路径。
   */
  _snapBase() {
    const cache = this._snapCache;
    if (cache && cache.tick === this.tickCount && cache.eventId === this.eventId
      && cache.playersLen === this.players.length && cache.lootLen === this.loot.length) return cache;
    const playerViews = new Array(this.players.length);
    for (let i = 0; i < this.players.length; i++) playerViews[i] = this._playerView(this.players[i], null);
    const lootViews = new Array(this.loot.length);
    for (let i = 0; i < this.loot.length; i++) {
      const l = this.loot[i];
      lootViews[i] = l.taken ? null : {
        id: l.id, kind: l.kind, item: l.item, x: r2(l.x), z: r2(l.z), y: r2(l.y),
        qty: l.qty, ammo: l.ammo, rarity: l.rarity,
        attachments: l.attachments.length ? l.attachments.slice() : EMPTY_ATTACHMENTS,
      };
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
    const grenades = this.grenades.map((g) => ({
      id: g.id, kind: g.kind, x: r2(g.x), z: r2(g.z), y: r2(g.y), ttl: r2(g.ttl),
    }));
    const smokes = this.smokes.map((s) => ({ id: s.id, x: r2(s.x), z: r2(s.z), r: s.r, ttl: r2(s.ttl) }));
    const fires = this.fires.map((f) => ({ id: f.id, x: r2(f.x), z: r2(f.z), r: f.r, ttl: r2(f.ttl) }));
    // 队内标记按队伍分组缓存：spectator/空 self 取全部，成员按队伍取各自分组
    const pingsAll = [];
    const pingsByTeam = new Map();
    for (let i = 0; i < this.pings.length; i++) {
      const pg = this.pings[i];
      const view = { id: pg.id, team: pg.team, x: r2(pg.x), z: r2(pg.z), kind: pg.kind, ttl: r2(pg.ttl) };
      pingsAll.push(view);
      let list = pingsByTeam.get(pg.team);
      if (!list) { list = []; pingsByTeam.set(pg.team, list); }
      list.push(view);
    }
    const drops = this.drops.map((d) => ({
      id: d.id, x: r2(d.x), z: r2(d.z), y: r2(d.y), landsIn: r2(d.landsIn), opened: d.opened,
    }));
    let alive = 0; let humans = 0; let bots = 0;
    const teamSet = new Set();
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.alive) alive++;
      if (p.bot) bots++; else humans++;
      if (p.alive || p.downed) teamSet.add(p.team);
    }
    const base = {
      tick: this.tickCount, eventId: this.eventId,
      playersLen: this.players.length, lootLen: this.loot.length,
      playerViews, lootViews, cars, grenades, smokes, fires, drops,
      counts: {
        alive, total: this.players.length, teams: this.maxTeams,
        aliveTeams: teamSet.size, humans, bots,
      },
      zone: this._zoneView(),
      horde: this._hordeView(),
      result: this.result ? {
        winnerTeam: this.result.winnerTeam, winnerName: this.result.winnerName,
        reason: this.result.reason,
        ranks: this.result.ranks.map((rk) => ({ ...rk, players: rk.players.slice() })),
      } : null,
      pingsAll, pingsByTeam,
      eventsCache: new Map(), // sinceEventId → 事件窗口（同 tick 内重复窗口共享同一数组）
    };
    this._snapCache = base;
    return base;
  }

  snapshot(viewerId = null, sinceEventId = 0) {
    const base = this._snapBase();
    const self = viewerId ? this._find(viewerId) : null;
    const players = [];
    const teammates = [];
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const isMate = self ? p.team === self.team : false;
      if (!this._visibleTo(self, p)) continue;
      players.push(base.playerViews[i]);
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
      const view = base.lootViews[i];
      if (!view) continue; // 已拾取（基座里置 null）
      if (self && !self.bot && dist(self.x, self.z, this.loot[i].x, this.loot[i].z) > 70) continue;
      loot.push(view);
    }
    // 事件窗口：同一 sinceEventId 在同一 tick 内共享同一数组；事件对象创建后不可变，
    // 直接引用（原来是逐条 {...ev} 浅展开，序列化输出一致）。
    let events = base.eventsCache.get(sinceEventId);
    if (!events) {
      events = [];
      for (let i = this.events.length - 1; i >= 0 && events.length < MAX_EVENTS; i--) {
        if (this.events[i].id > sinceEventId) events.push(this.events[i]);
      }
      events.reverse();
      base.eventsCache.set(sinceEventId, events);
    }
    const me = self ? this._selfView(self) : null;
    return {
      v: 3, mode: this.mode, mapId: this.mapId, mapName: this.mapName,
      weather: this.weather, timeOfDay: this.timeOfDay,
      phase: this.phase, time: r2(this.time), matchTime: r2(this.matchTime), duration: this.duration,
      // 空降航线（仅 skydive 且未全员落地时才有值）：客户端据此画航线、飞机、
      // 舱门状态与「可跳窗口」倒计时。其余情况键完全缺失（不是 null），
      // 与二进制侧（decodeFlight 不设键）保持键集合一致。
      ...(this._flightView() ? { flight: this._flightView() } : null),
      zone: base.zone,
      counts: base.counts,
      selfId: self ? self.id : null,
      me,
      players, loot, cars: base.cars,
      grenades: base.grenades,
      smokes: base.smokes,
      fires: base.fires,
      pings: self ? (base.pingsByTeam.get(self.team) || EMPTY_PINGS) : base.pingsAll,
      drops: base.drops,
      markers: EMPTY_MARKERS,
      horde: base.horde,
      events,
      loading: null,
      result: base.result,
      teammates,
    };
  }

  /** 舱内落点预览的 x：沿当前朝向从机位投出 190m（与客户端 input.js 同源）。 */
  _previewDropX(p) {
    const spot = this._previewDrop(p);
    return spot.x;
  }

  _previewDropZ(p) {
    const spot = this._previewDrop(p);
    return spot.z;
  }

  /** 舱内落点预览：当前朝向 × 190m，夹进地图圆。纯几何推算，不消耗 rng。 */
  _previewDrop(p) {
    const R = this.world?.radius || 182;
    const x = p.x + Math.sin(p.angle) * 190;
    const z = p.z + Math.cos(p.angle) * 190;
    return this._clampToMap(x, z);
  }

  /** 空降航线视图：非 deploying 阶段返回 undefined（键完全不出现）。
   *  二进制侧 decodeFlight 在无航线时同样不设置该键，端到端保持一致 ——
   *  wire.test 的结构一致性用例是按键集合比对的，键缺失必须两边都缺失。 */
  _flightView() {
    const f = this.flight;
    if (!f || this.phase !== 'deploying') return undefined;
    const canJump = !!f.open;
    return {
      x: r2(f.x), z: r2(f.z),
      fromX: r2(f.from.x), fromZ: r2(f.from.z),
      toX: r2(f.to.x), toZ: r2(f.to.z),
      ux: +f.ux.toFixed(3), uz: +f.uz.toFixed(3),
      open: canJump,
      // 距离舱门关闭还有多少秒（open 时为剩余可跳时间）
      closeIn: r2(Math.max(0, f.jumpClose - f.t)),
      jumped: f.jumped,
      total: this.players.length,
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

  /** horde 快照：波次 / 剩余敌人 / 修正 / 基地 / 防御设施 / hordeRun 战绩。 */
  _hordeView() {
    const run = this.hordeRun;
    if (!run) return null;
    let queued = 0;
    for (let i = 0; i < run.spawnQueue.length; i++) queued += run.spawnQueue[i].count;
    const enemiesLeft = run.enemies.length + queued;
    return {
      wave: run.wave, totalWaves: run.totalWaves, enemiesLeft, queued,
      nextWaveIn: r2(run.nextWaveIn), prepTime: run.waveCleared ? r2(run.nextWaveIn) : 0,
      prepTotal: run.prepTotal,
      boss: run.boss, bossCount: run.enemies.reduce((n, e) => n + (e.boss ? 1 : 0), 0),
      score: Math.round(run.score), baseHp: r2(Math.max(0, run.base.hp)),
      baseMaxHp: run.base.maxHp, cost: r2(run.credits),
      modifier: run.modifier ? run.modifier.id : null,
      modifierName: run.modifier ? run.modifier.name : null,
      modifierDesc: run.modifier ? run.modifier.desc : null,
      fog: run.fog,
      turrets: run.turrets.length, barricades: run.barricades.length,
      medstations: run.medstations, slowfields: run.slowfields,
      overcharge: !!run.overcharge,
      reviveAt: r2(run.reviveAt || HORDE.reviveAfter),
      endless: !!run.endless,
      upgrades: Object.keys(HORDE.upgrades).map((id) => ({
        id, name: HORDE.upgrades[id].name, desc: HORDE.upgrades[id].desc,
        cost: this.upgradeCost(id), max: HORDE.upgrades[id].max ?? null,
        bought: run.upgradesBought?.[id] || 0,
        affordable: run.credits >= this.upgradeCost(id),
      })),
      hordeRun: Horde.runSummary(run),
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
    // 当前散布角（弧度）+ 相对精度：客户端准星要按这个画，而不是恒定值。
    // 公式必须与 tryFire() 里的一致，否则准星和实际弹道对不上。
    let spreadNow = 0;
    let accuracyNow = 1;
    if (weapon) {
      spreadNow = weapon.spread * (p.moved ? 1.85 : 1) * (p.state === 'crouch' ? 0.62 : 1);
      spreadNow += p.spreadBloom * weapon.spread * 1.4 + p.recoil * 0.0012;
      if (p.state === 'sprint') spreadNow *= 1.3;
      accuracyNow = Math.max(0.05, Math.min(1, weapon.spread / Math.max(0.0001, spreadNow)));
    }
    return {
      id: p.id, name: p.name, bot: p.bot, team: p.team, teamName: this.teamName(p.team),
      // 血条口径：客户端 UI（client/ui-hud.js 的 health-bar 宽度、feel.js 的 _hpRatio）
      // 一律按 0–100 渲染，所以自视角的 hp 要归一到 100 点制，否则精锐 bot 的 105 会溢出、
      // 人类玩家的 displayed hp 也会随难度倍率漂移。
      // 注意：不再额外下发 maxHp（append-only 的协议字段由 wire.mjs 所有者维护），
      // 归一后 100 点制与原语义完全兼容。
      hp: r2(p.maxHp ? (p.hp / p.maxHp) * COMBAT.maxHp : p.hp),
      armor: r2(p.armor), armorTier: p.armorTier, shield: r2(p.shield),
      alive: p.alive, downed: p.downed, downedHp: r2(p.downedHp), bleedout: r2(p.bleedout),
      reviveProgress: r2(p.reviveProgress), reviveTarget: p.reviveTarget,
      kills: p.kills, assists: p.assists, damage: r2(p.damage), rank: p.rank,
      state: p.state, x: r2(p.x), z: r2(p.z), angle: r2(p.angle), stamina: r2(p.stamina),
      // 空降（仅 skydive）：阶段与伞降进度，客户端据此切「舱内/自由落体/开伞」表现与操作。
      // instant 下键完全缺失（不是 null），与二进制 PLAYER/SELF schema 同口径。
      ...(p.deployStage ? { deployStage: p.deployStage } : null),
      // 落点预览（世界坐标）：舱内还没有 dropSpot 时给「当前朝向的预投点」，
      // 让客户端的落点圈从第一帧就有东西可画。
      ...(p.deployStage && p.deployStage !== 'ground' ? {
        dropPreviewX: r2(p.deployStage === 'plane' ? this._previewDropX(p) : (p.dropSpot?.x ?? p.x)),
        dropPreviewZ: r2(p.deployStage === 'plane' ? this._previewDropZ(p) : (p.dropSpot?.z ?? p.z)),
      } : null),
      chute: p.chute,
      y: r2(p.y),
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
      spread: +spreadNow.toFixed(4),
      accuracy: +accuracyNow.toFixed(3),
      // 权威累计统计：结算摘要直接读这里，不再依赖 events 窗口
      // （MAX_EVENTS=140 只能装下约 7.6% 的事件，导致 12 个字段恒为 0）。
      stats: {
        shotsFired: p.stats.shotsFired, shotsHit: p.stats.shotsHit,
        headshots: p.stats.headshots, kills: p.stats.kills, downs: p.stats.downs,
        assists: p.stats.assists, damageDealt: r2(p.stats.damageDealt),
        damageTaken: r2(p.stats.damageTaken), pickups: p.stats.pickups,
        revives: p.stats.revives, throws: p.stats.throws, healItems: p.stats.healItems,
        vehicleSeconds: r2(p.stats.vehicleSeconds), airdrops: p.stats.airdrops,
        dodges: p.stats.dodges,
        weaponsUsed: p.stats.weaponsUsed.slice(),
      },
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
  // 水域判定：map.mjs 导出的名字是 `isWater`，模拟层用的是 `inWater`。
  // 历史实现只检查 `world.inWater`，而 makeWorld 从不提供这个别名 ——
  // 于是它被赋成 `() => false`，水里减速（MOVE.waterMul = 0.55）成了死代码，
  // 玩家走浅滩/冰湖完全不减速。这里优先复用 isWater。
  world.inWater = typeof world.inWater === 'function' ? world.inWater
    : (typeof world.isWater === 'function' ? world.isWater : () => false);
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
