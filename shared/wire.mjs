// 雾岛突围 / MIST ISLE — 二进制快照编解码（owner: netserver · shared/wire.mjs）
// ─────────────────────────────────────────────────────────────────────────────
// 目标：把 10Hz 快照从 JSON 的 5–35KB 压到 1–5KB，同时保持 `snapshot()` 的 JSON 输出
// 完全不变。本文件只做「在 snapshot 之上的一层」：编解码是纯函数式的（无 DOM / Node
// API、无随机源），浏览器与 Node 共用同一份代码。
//
// 设计要点（与 README / docs/CONTRACTS.md §4 对应）：
//   1. 静态字符串表：武器/道具/事件类型/字段名等常量在两端用同一顺序建表，帧内只发索引；
//      未知字符串（例如玩家昵称）走「长度 + UTF-8 内联」，不改变两端表，天然抗丢帧。
//   2. roster：id/name/bot/team/teamName 只在加入/开局时用 JSON 下发一次，快照里玩家
//      引用 1 字节槽位；事件里的 player/by/target 同样走槽位。
//   3. 位掩码 + 默认值省缺：玩家、自己、队友、载具、战利品等结构都有字段 schema，
//      只出现「与默认值不同」的字段；一局里绝大多数玩家每帧只发 x/z/angle/hp 等少数字段。
//   4. 量化：位置 0.05m（int16）、角度 1/65536 圈（uint16）、生命/护甲/时间等 0.01
//      （varint），所有误差都在测试容差内；NaN/Infinity 统一落到 0，永不抛异常。
//   5. 事件按类型 schema 编码；未知类型/未知字段走通用值编码器，向前兼容。
//   6. 兼容：协议版本仍是 3；二进制是「能力协商」，老客户端继续走 JSON，服务端可用
//      WIRE_BINARY=0 一键回退（见 README）。
// ─────────────────────────────────────────────────────────────────────────────

import { WEAPONS, ATTACHMENTS, WEAPON_ORDER, ATTACHMENT_ORDER, AMMO_TYPES } from './data/weapons.mjs';
import {
  ARMORS,
  CONSUMABLES,
  THROWABLES,
  BACKPACKS,
  ITEM_KINDS,
  CONSUMABLE_ORDER,
  THROWABLE_ORDER,
  BACKPACK_ORDER,
} from './data/items.mjs';
import { MAPS, MAP_ORDER } from './data/maps.mjs';
import { HORDE, RARITY, WEATHER, TIME_OF_DAY } from './rules.mjs';

export const WIRE_VERSION = 1;
export const FRAME_STATE = 1;

const TAU = Math.PI * 2;
const MAX_ROSTER = 254;

// ── 量化比例（测试与 benchmark 共用）────────────────────────────────────────
export const QUANT = Object.freeze({
  POS: 20, // 1/20 m = 0.05m
  ANGLE: 65536, // 1/65536 圈 ≈ 0.0055°
  CENTI: 100, // 0.01（生命/护甲/时间/速度等 r2 字段）
  MILLI: 1000, // 0.001（accuracy）
  MICRO: 10000, // 0.0001（spread）
});

export class WireError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WireError';
  }
}

// ── 7 位 varint / zigzag ────────────────────────────────────────────────────
class Writer {
  constructor(size = 4096) {
    this.buf = new Uint8Array(Math.max(64, size | 0));
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  reset() {
    this.pos = 0;
    return this;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }
  i8(v) {
    this.u8(v & 0xff);
  }

  u16(v) {
    this.ensure(2);
    v &= 0xffff;
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
  }

  i16(v) {
    this.u16(v & 0xffff);
  }

  u32(v) {
    this.ensure(4);
    v >>>= 0;
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    this.buf[this.pos++] = (v >>> 24) & 0xff;
  }

  i32(v) {
    this.u32(v >>> 0);
  }

  f64(v) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  varint(v) {
    let n = Number(v);
    if (!Number.isFinite(n) || n < 0) n = 0;
    n = Math.floor(n) >>> 0;
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.u8(n);
  }

  zigzag(v) {
    let n = Math.round(Number(v));
    if (!Number.isFinite(n)) n = 0;
    const u = ((n << 1) ^ (n >> 31)) >>> 0;
    this.varint(u);
  }

  raw(bytes) {
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.ensure(src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
  }

  reserve(n) {
    const start = this.pos;
    this.ensure(n);
    this.buf.fill(0, start, start + n);
    this.pos += n;
    return start;
  }

  patch(start, bytes) {
    this.buf.set(bytes, start);
  }

  bytes() {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  constructor(bytes) {
    if (bytes instanceof Uint8Array) {
      this.buf = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else if (bytes instanceof ArrayBuffer) {
      this.buf = new Uint8Array(bytes);
      this.view = new DataView(bytes);
    } else {
      throw new WireError('decode 需要 Uint8Array / ArrayBuffer');
    }
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n > this.buf.length) throw new WireError('帧被截断');
  }

  u8() {
    this.ensure(1);
    return this.buf[this.pos++];
  }
  i8() {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }

  u16() {
    this.ensure(2);
    const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }

  i16() {
    const v = this.u16();
    return v > 32767 ? v - 65536 : v;
  }

  u32() {
    this.ensure(4);
    const v =
      (this.buf[this.pos] |
        (this.buf[this.pos + 1] << 8) |
        (this.buf[this.pos + 2] << 16) |
        (this.buf[this.pos + 3] << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }

  i32() {
    const v = this.u32();
    return v | 0;
  }

  f64() {
    this.ensure(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  varint() {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 6; i++) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
    throw new WireError('varint 过长');
  }

  zigzag() {
    const u = this.varint();
    return ((u >>> 1) ^ -(u & 1)) | 0;
  }

  raw(n) {
    this.ensure(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  get remaining() {
    return this.buf.length - this.pos;
  }
}

/** 便于单测/诊断：把非负整数编码成 varint 字节。 */
export function encodeVarint(value) {
  const w = new Writer(16);
  w.varint(value);
  return w.bytes();
}

/** 便于单测/诊断：解码一个 varint，返回 { value, bytes }。 */
export function decodeVarint(bytes) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const value = r.varint();
  return { value, bytes: r.pos };
}

// ── 字符串表 ────────────────────────────────────────────────────────────────
class StringTable {
  constructor(strings = []) {
    this.list = [];
    this.index = new Map();
    for (const s of strings) this.add(s);
  }

  add(value) {
    const s = String(value);
    const hit = this.index.get(s);
    if (hit !== undefined) return hit;
    const id = this.list.length;
    this.index.set(s, id);
    this.list.push(s);
    return id;
  }

  idOf(s) {
    return this.index.get(s);
  }
  get(id) {
    return this.list[id];
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

// writeStr 的低 2 位标记：0=null、1=空串、2=表索引、3=内联 UTF-8。
// 内联字符串不写入字符串表，因此丢帧/重连不会造成两端表错位。
function writeStr(w, ctx, value) {
  if (value == null) {
    w.varint(0);
    return;
  }
  const s = String(value);
  if (s === '') {
    w.varint(1);
    return;
  }
  const id = ctx.table.idOf(s);
  if (id !== undefined && id < 0x0fffffff) {
    w.varint((id << 2) | 2);
    return;
  }
  const bytes = TEXT_ENCODER.encode(s);
  if (bytes.length > 4096) throw new WireError('字符串过长');
  w.varint((bytes.length << 2) | 3);
  w.raw(bytes);
}

function readStr(r, ctx) {
  const v = r.varint();
  const tag = v & 3;
  if (tag === 0) return null;
  if (tag === 1) return '';
  if (tag === 2) {
    const s = ctx.table.get(v >>> 2);
    if (s === undefined) throw new WireError('未知字符串索引');
    return s;
  }
  const len = v >>> 2;
  if (len > 4096) throw new WireError('内联字符串过长');
  return TEXT_DECODER.decode(r.raw(len));
}

// ── 静态字符串（两端顺序必须一致）──────────────────────────────────────────
const STATIC_STRINGS = [];
const STATIC_SEEN = new Set();
const addStatic = (value) => {
  if (value == null) return;
  const s = String(value);
  if (!s || STATIC_SEEN.has(s)) return;
  STATIC_SEEN.add(s);
  STATIC_STRINGS.push(s);
};

// 快照/事件里出现过的全部字段名（错误兜底：未知字段走内联，不影响正确性）。
const KEY_STRINGS = [
  // 快照顶层
  'v',
  'mode',
  'mapId',
  'mapName',
  'weather',
  'timeOfDay',
  'phase',
  'time',
  'matchTime',
  'duration',
  'zone',
  'counts',
  'selfId',
  'me',
  'players',
  'loot',
  'lootPatch',
  'cars',
  'grenades',
  'smokes',
  'fires',
  'pings',
  'drops',
  'markers',
  'horde',
  'events',
  'loading',
  'result',
  'teammates',
  'target',
  'aliveTeams',
  'humans',
  'bots',
  'teams',
  'upsert',
  'remove',
  // 玩家/自己/队友
  'id',
  'name',
  'bot',
  'team',
  'teamName',
  'entityId',
  'x',
  'z',
  'angle',
  'y',
  'hp',
  'armor',
  'armorTier',
  'alive',
  'downed',
  'downedHp',
  'bleedout',
  'reviveProgress',
  'reviveTarget',
  'weapon',
  'kills',
  'rank',
  'car',
  'seat',
  'connected',
  'state',
  'chute',
  'shield',
  'assists',
  'damage',
  'stamina',
  'ammo',
  'reserve',
  'ammoType',
  'slot',
  'loadout',
  'mags',
  'meds',
  'bandages',
  'energy',
  'shields',
  'grenades',
  'smokes',
  'flashes',
  'molotovs',
  'interactLabel',
  'blind',
  'reloadTime',
  'healTime',
  'healKind',
  'fireCooldown',
  'spread',
  'accuracy',
  'isSelf',
  'attachments',
  // 战利品/载具/投掷物/标记
  'kind',
  'item',
  'qty',
  'rarity',
  'type',
  'maxHp',
  'color',
  'seats',
  'driver',
  'speed',
  'ttl',
  'landsIn',
  'opened',
  'label',
  'r',
  // 事件
  'by',
  'tx',
  'tz',
  'hit',
  'hits',
  'headshots',
  'reason',
  'armor',
  'attacker',
  'attackerName',
  'byName',
  'action',
  'force',
  'closed',
  'closing',
  'wait',
  'shrink',
  'winnerTeam',
  'ranks',
  'count',
  'spawned',
  'boss',
  'modifier',
  'modifierName',
  'credits',
  'score',
  'baseHp',
  'killed',
  'total',
  'waves',
  'baseX',
  'baseZ',
  'overcharge',
  'power',
  'desc',
  'achievement',
  'source',
  'level',
  'modifiers',
  'bossKills',
  'cleared',
  'affordable',
  'max',
  'bought',
  // horde 视图
  'totalWaves',
  'enemiesLeft',
  'queued',
  'nextWaveIn',
  'prepTime',
  'prepTotal',
  'bossCount',
  'baseMaxHp',
  'cost',
  'modifierDesc',
  'fog',
  'turrets',
  'barricades',
  'medstations',
  'slowfields',
  'reviveAt',
  'endless',
  'upgrades',
  'hordeRun',
  // 结算
  'winnerName',
];

const EVENT_TYPES = [
  'start',
  'land',
  'shot',
  'hit',
  'headshot',
  'down',
  'kill',
  'revive',
  'revived',
  'heal',
  'healStart',
  'healCancel',
  'healed',
  'pickup',
  'throw',
  'explosion',
  'smoke',
  'smokeEnd',
  'fire',
  'flash',
  'empty',
  'airdrop',
  'supply',
  'zone',
  'vehicle',
  'ping',
  'wave',
  'waveClear',
  'boss',
  'basehit',
  'end',
  'levelup',
  'enemyDown',
  'enemyHit',
  'enemyRepath',
  'dodge',
  'drop',
  'dropLanded',
  'dropOpen',
  'respawn',
  'reload',
  'reloaded',
  'swap',
  'hordeStart',
  'airstrike',
  'upgrade',
  'modifier',
  'achievement',
  'baseDestroyed',
  'baseHitFx',
  'medHeal',
  'knockback',
  'fuse',
  'acidThrow',
  'acidLand',
  'bossCharge',
  'bossChargeEnd',
  'bossQuake',
  'bossSummon',
  'turretShot',
  'jump',
  'chute',
  'doorOpen',
  'doorClose',
  'landAll',
];

const PLAYER_STATES = ['normal', 'crouch', 'sprint', 'dodge', 'downed', 'dead', 'vehicle'];
const PHASES = ['waiting', 'loading', 'deploying', 'live', 'ended', 'lobby', 'playing'];
const MODES = ['solo', 'squad', 'horde', 'training'];
const TEAM_NAMES = [
  '曙光',
  '黑潮',
  '雾岚',
  '赤礁',
  '白沙',
  '远星',
  '山隼',
  '星火',
  '长风',
  '暗礁',
  '苍穹',
  '疾雨',
  '晨鹿',
  '鲸落',
  '沙丘',
  '雪松',
];
const CAR_NAMES = { buggy: '沙滩越野', jeep: '军用吉普', bike: '越野摩托', truck: '运输卡车' };
const CAR_TYPES = ['buggy', 'jeep', 'bike', 'truck'];
const PING_KINDS = ['move', 'enemy', 'loot', 'danger'];
const VEHICLE_ACTIONS = ['enter', 'exit', 'hit', 'damage', 'explode'];
const END_REASONS = ['lastTeam', 'timeout', 'horde', 'cleared', 'wipe', 'leave', 'zone'];
const ENEMY_TYPES = Object.keys(HORDE.enemies);
const MODIFIER_IDS = Object.keys(HORDE.modifiers);

for (const key of KEY_STRINGS) addStatic(key);
for (const type of EVENT_TYPES) addStatic(type);
for (const id of WEAPON_ORDER) addStatic(id);
for (const id of ATTACHMENT_ORDER) addStatic(id);
for (const id of Object.keys(WEAPONS)) addStatic(id);
for (const id of Object.keys(ATTACHMENTS)) addStatic(id);
for (const id of Object.keys(AMMO_TYPES)) addStatic(id);
for (const group of [ARMORS, CONSUMABLES, THROWABLES, BACKPACKS]) {
  for (const id of Object.keys(group)) addStatic(id);
}
for (const id of ITEM_KINDS) addStatic(id);
for (const id of CONSUMABLE_ORDER) addStatic(id);
for (const id of THROWABLE_ORDER) addStatic(id);
for (const id of BACKPACK_ORDER) addStatic(id);
for (const id of RARITY) addStatic(id);
for (const id of WEATHER) addStatic(id);
for (const key of Object.keys(TIME_OF_DAY)) addStatic(key);
for (const id of MAP_ORDER) addStatic(id);
for (const id of MAP_ORDER) addStatic(MAPS[id]?.name);
for (const type of CAR_TYPES) {
  addStatic(type);
  addStatic(CAR_NAMES[type]);
  addStatic(`驾驶 ${CAR_NAMES[type]}`);
}
for (const name of TEAM_NAMES) addStatic(name);
for (const state of PLAYER_STATES) addStatic(state);
for (const phase of PHASES) addStatic(phase);
for (const mode of MODES) addStatic(mode);
for (const kind of PING_KINDS) addStatic(kind);
for (const action of VEHICLE_ACTIONS) addStatic(action);
for (const reason of END_REASONS) addStatic(reason);
for (const type of ENEMY_TYPES) addStatic(type);
for (const id of MODIFIER_IDS) {
  const mod = HORDE.modifiers[id];
  addStatic(id);
  addStatic(mod.name);
  addStatic(mod.desc);
}
for (const id of Object.keys(HORDE.upgrades)) {
  const up = HORDE.upgrades[id];
  addStatic(id);
  addStatic(up.name);
  addStatic(up.desc);
}
for (const label of ['下车', '拾取 物资', '开启 空投', '换弹', 'enemy', 'base', 'horde_conqueror', '雾岛征服者']) {
  addStatic(label);
}
for (let i = 1; i <= 18; i++) addStatic(`car${i}`);

// 载具规格：与 simulation.mjs 的 CARS 保持同值；若数据漂移，编码器会自动显式下发
// 差异字段（只是多几个字节），测试也会用真实对局覆盖四种载具。
const CAR_SPECS = {
  buggy: { hp: 220, maxHp: 220, color: 0xd8a24a, seats: 4 },
  jeep: { hp: 320, maxHp: 320, color: 0x6f8f6a, seats: 4 },
  bike: { hp: 130, maxHp: 130, color: 0xb05a4a, seats: 2 },
  truck: { hp: 440, maxHp: 440, color: 0x7a8a94, seats: 6 },
};

// ── 上下文：字符串表 + roster ───────────────────────────────────────────────
/**
 * 创建编解码上下文。服务端在每次下发 roster 时新建、并与 roster 消息一起发给客户端；
 * 客户端收到 roster 后用同一份数据新建。两端字符串表顺序因此完全一致。
 */
export function createWireContext({ roster = [] } = {}) {
  const table = new StringTable(STATIC_STRINGS);
  const list = [];
  for (const p of roster || []) {
    if (!p || p.id == null) continue;
    const entry = {
      id: String(p.id),
      name: p.name == null ? '' : String(p.name),
      bot: !!p.bot,
      team: Number.isInteger(p.team) ? p.team : 0,
      teamName: p.teamName == null ? '' : String(p.teamName),
    };
    list.push(entry);
    if (list.length >= MAX_ROSTER) break;
    table.add(entry.id);
    if (entry.name) table.add(entry.name);
    if (entry.teamName) table.add(entry.teamName);
  }
  const index = new Map();
  for (let i = 0; i < list.length; i++) index.set(list[i].id, i);
  return { table, roster: list, index };
}

/** 把 snapshot 的 players（或 Match.players）提炼成 roster 消息体。 */
export function rosterFromPlayers(players) {
  const out = [];
  for (const p of players || []) {
    if (!p || p.id == null) continue;
    out.push({
      id: String(p.id),
      name: p.name == null ? '' : String(p.name),
      bot: !!p.bot,
      team: Number.isInteger(p.team) ? p.team : 0,
      teamName: p.teamName == null ? '' : String(p.teamName),
    });
    if (out.length >= MAX_ROSTER) break;
  }
  return out;
}

// ── 基础量化读写 ────────────────────────────────────────────────────────────
const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function quant(v, scale) {
  if (!Number.isFinite(v)) return 0;
  const n = Math.round(v * scale);
  return Number.isFinite(n) ? n : 0;
}

function writePos(w, v) {
  w.i16(clampInt(quant(v, QUANT.POS), -32768, 32767));
}
function readPos(r) {
  return r.i16() / QUANT.POS;
}

// 角度按 1/65536 圈量化（≈0.0055°，远超 1/256 圈方案），并保留原值的符号区间：
// 模拟层的玩家角在 [-π, π]（wrapAngle），载具角可能累积到 [0, 2π) 甚至更大；
// 用 u16 +「负半圈」标记恢复原符号，避免解码值与原值跨过 ±π 分界（客户端插值会
// 因此反向绕一圈）。负数用 1 位标记 + 绝对值编码，最多 3 字节。
function writeAngle(w, v) {
  const a = Number.isFinite(v) ? v : 0;
  const neg = a < 0;
  const abs = Math.abs(a);
  // 先按整圈取模再量化：2π 与 0 等价，量化后不会溢出 u16。
  const step = Math.round(((abs % TAU) / TAU) * QUANT.ANGLE) % QUANT.ANGLE;
  w.varint(step * 2 + (neg ? 1 : 0));
}
function readAngle(r) {
  const v = r.varint();
  const step = v >>> 1;
  const mag = (step / QUANT.ANGLE) * TAU;
  return v & 1 ? -mag : mag;
}

function writeQ(w, v, scale) {
  w.zigzag(quant(v, scale));
}
function readQ(r, scale) {
  return r.zigzag() / scale;
}

function writeTime(w, v) {
  w.u32(clampInt(quant(v, QUANT.CENTI), 0, 0xffffffff));
}
function readTime(r) {
  return r.u32() / QUANT.CENTI;
}

// ── 实体/玩家引用 ──────────────────────────────────────────────────────────
function writeIdRef(w, ctx, id) {
  if (id == null) {
    w.u8(0);
    return;
  }
  const slot = ctx.index.get(String(id));
  if (slot !== undefined && slot < MAX_ROSTER) {
    w.u8(slot + 1);
    return;
  }
  w.u8(255);
  writeStr(w, ctx, id);
}

function readIdRef(r, ctx) {
  const b = r.u8();
  if (b === 0) return null;
  if (b === 255) return readStr(r, ctx);
  const entry = ctx.roster[b - 1];
  return entry ? entry.id : null;
}

/** 玩家引用：roster 命中时只发 1 字节槽位；静态字段变化（极少）时整条内联。 */
function writePlayerRef(w, ctx, p) {
  const slot = ctx.index.get(String(p.id));
  if (slot !== undefined && slot < MAX_ROSTER) {
    const e = ctx.roster[slot];
    if (
      e &&
      e.name === (p.name == null ? '' : String(p.name)) &&
      e.bot === !!p.bot &&
      e.team === (Number.isInteger(p.team) ? p.team : 0) &&
      e.teamName === (p.teamName == null ? '' : String(p.teamName))
    ) {
      w.u8(slot + 1);
      return;
    }
  }
  w.u8(255);
  writeStr(w, ctx, p.id);
  writeStr(w, ctx, p.name);
  w.u8(p.bot ? 1 : 0);
  w.zigzag(Number.isInteger(p.team) ? p.team : 0);
  writeStr(w, ctx, p.teamName);
}

function readPlayerRef(r, ctx) {
  const b = r.u8();
  if (b !== 255) {
    const e = ctx.roster[b - 1];
    if (!e) throw new WireError('未知 roster 槽位');
    return { id: e.id, name: e.name, bot: e.bot, team: e.team, teamName: e.teamName };
  }
  return {
    id: readStr(r, ctx),
    name: readStr(r, ctx),
    bot: r.u8() !== 0,
    team: r.zigzag(),
    teamName: readStr(r, ctx),
  };
}

/** 实体 id：e12 / l7 / g5 这类「单字母 + 数字」压成 1+1+varint，其余走字符串表。 */
function writeEntityId(w, ctx, id) {
  if (id == null) {
    w.u8(0);
    return;
  }
  const s = String(id);
  const m = /^([a-z])(\d{1,9})$/.exec(s);
  if (m) {
    w.u8(1);
    w.u8(m[1].charCodeAt(0));
    w.varint(Number(m[2]));
    return;
  }
  w.u8(2);
  writeStr(w, ctx, s);
}

function readEntityId(r, ctx) {
  const t = r.u8();
  if (t === 0) return null;
  if (t === 1) return String.fromCharCode(r.u8()) + r.varint();
  return readStr(r, ctx);
}

/** 战利品 id：l12 → 1–2 字节；其它形态内联。 */
function writeLootId(w, id) {
  const s = String(id);
  const m = /^l(\d{1,9})$/.exec(s);
  if (m) {
    w.varint(Number(m[1]) << 1);
    return;
  }
  const bytes = TEXT_ENCODER.encode(s);
  if (bytes.length > 64) throw new WireError('战利品 id 过长');
  w.varint((bytes.length << 1) | 1);
  w.raw(bytes);
}

function readLootId(r) {
  const v = r.varint();
  if (v & 1) {
    const len = v >>> 1;
    if (len > 64) throw new WireError('战利品 id 过长');
    return TEXT_DECODER.decode(r.raw(len));
  }
  return `l${v >>> 1}`;
}

// ── 字段 schema（位掩码 + 默认值省缺）──────────────────────────────────────
const EMPTY_LOADOUT = [null, null];
const EMPTY_MAGS = { light: 0, medium: 0, heavy: 0, shell: 0, bolt: 0 };
const MAG_KEYS = ['light', 'medium', 'heavy', 'shell', 'bolt'];
const ATTACH_EMPTY = [];

function cloneDefault(def) {
  if (Array.isArray(def)) return def.map(cloneDefault);
  if (def && typeof def === 'object') {
    const out = {};
    for (const k of Object.keys(def)) out[k] = cloneDefault(def[k]);
    return out;
  }
  return def;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !sameValue(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function writeLoadout(w, ctx, arr) {
  const list = Array.isArray(arr) ? arr : [];
  w.varint(list.length);
  for (const slot of list) {
    if (!slot) {
      w.u8(0);
      continue;
    }
    w.u8(1);
    writeStr(w, ctx, slot.type);
    w.zigzag(Number.isFinite(slot.ammo) ? Math.round(slot.ammo) : 0);
    const att = Array.isArray(slot.attachments) ? slot.attachments : [];
    w.varint(att.length);
    for (const id of att) writeStr(w, ctx, id);
  }
}

function readLoadout(r, ctx) {
  const n = readCount(r, 8);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (r.u8() === 0) {
      out.push(null);
      continue;
    }
    const type = readStr(r, ctx);
    const ammo = r.zigzag();
    const an = readCount(r, 16);
    const attachments = [];
    for (let k = 0; k < an; k++) attachments.push(readStr(r, ctx));
    out.push({ type, ammo, attachments });
  }
  return out;
}

function writeMags(w, mags) {
  const m = mags || EMPTY_MAGS;
  for (const key of MAG_KEYS) w.zigzag(Number.isFinite(m[key]) ? Math.round(m[key]) : 0);
}

function readMags(r) {
  const out = {};
  for (const key of MAG_KEYS) out[key] = r.zigzag();
  return out;
}

// me.stats：结算摘要的权威累计（15 个计数器 + 用过的武器列表）。全 0 时只占 2 字节掩码。
const STATS_INT_KEYS = [
  'shotsFired',
  'shotsHit',
  'headshots',
  'kills',
  'downs',
  'assists',
  'pickups',
  'revives',
  'throws',
  'healItems',
  'airdrops',
  'dodges',
];
const STATS_Q_KEYS = ['damageDealt', 'damageTaken', 'vehicleSeconds'];

function writeStats(w, ctx, stats) {
  const s = stats || {};
  let mask = 0;
  const used = [];
  for (let i = 0; i < STATS_INT_KEYS.length; i++) {
    const v = s[STATS_INT_KEYS[i]];
    if (Number.isFinite(v) && v !== 0) {
      mask |= 1 << i;
      used.push(['int', v]);
    } else used.push(null);
  }
  for (let i = 0; i < STATS_Q_KEYS.length; i++) {
    const v = s[STATS_Q_KEYS[i]];
    if (Number.isFinite(v) && v !== 0) {
      mask |= 1 << (STATS_INT_KEYS.length + i);
      used.push(['q', v]);
    } else used.push(null);
  }
  const weapons = Array.isArray(s.weaponsUsed) ? s.weaponsUsed : [];
  if (weapons.length) mask |= 1 << (STATS_INT_KEYS.length + STATS_Q_KEYS.length);
  w.u16(mask);
  for (const item of used) {
    if (!item) continue;
    if (item[0] === 'q') writeQ(w, item[1], QUANT.CENTI);
    else w.zigzag(Math.round(item[1]));
  }
  if (mask & (1 << (STATS_INT_KEYS.length + STATS_Q_KEYS.length))) {
    w.varint(weapons.length);
    for (const id of weapons) writeStr(w, ctx, id);
  }
}

function readStats(r, ctx) {
  const mask = r.u16();
  const out = {};
  for (let i = 0; i < STATS_INT_KEYS.length; i++) {
    out[STATS_INT_KEYS[i]] = mask & (1 << i) ? r.zigzag() : 0;
  }
  for (let i = 0; i < STATS_Q_KEYS.length; i++) {
    out[STATS_Q_KEYS[i]] = mask & (1 << (STATS_INT_KEYS.length + i)) ? readQ(r, QUANT.CENTI) : 0;
  }
  if (mask & (1 << (STATS_INT_KEYS.length + STATS_Q_KEYS.length))) {
    const n = readCount(r, 64);
    const weapons = [];
    for (let i = 0; i < n; i++) weapons[i] = readStr(r, ctx);
    out.weaponsUsed = weapons;
  } else {
    out.weaponsUsed = [];
  }
  return out;
}

// loot.ammo 是多态的：字符串=弹药类型（light/medium/…），数字=弹药数量（背包/弹药盒）。
// 用 1 字节 tag 区分：0=null、1=数字、2=字符串。
function writeAmmo(w, ctx, v) {
  if (v == null) {
    w.u8(0);
    return;
  }
  if (typeof v === 'number') {
    w.u8(1);
    w.zigzag(Number.isFinite(v) ? Math.round(v) : 0);
    return;
  }
  w.u8(2);
  writeStr(w, ctx, v);
}

function readAmmo(r, ctx) {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag === 1) return r.zigzag();
  if (tag === 2) return readStr(r, ctx);
  throw new WireError(`未知弹药标记 ${tag}`);
}

function writeAttachments(w, ctx, att) {
  const list = Array.isArray(att) ? att : [];
  w.varint(list.length);
  for (const id of list) writeStr(w, ctx, id);
}

function readAttachments(r, ctx) {
  const n = readCount(r, 16);
  const out = [];
  for (let i = 0; i < n; i++) out.push(readStr(r, ctx));
  return out;
}

function writeField(w, ctx, codec, v) {
  switch (codec) {
    case 'pos':
      writePos(w, v);
      break;
    case 'angle':
      writeAngle(w, v);
      break;
    case 'q10':
      writeQ(w, v, 10);
      break;
    case 'q100':
      writeQ(w, v, QUANT.CENTI);
      break;
    case 'q1000':
      writeQ(w, v, QUANT.MILLI);
      break;
    case 'q10000':
      writeQ(w, v, QUANT.MICRO);
      break;
    case 'int':
      w.zigzag(Number.isFinite(v) ? Math.round(v) : 0);
      break;
    case 'bool':
      w.u8(v ? 1 : 0);
      break;
    case 'str':
      writeStr(w, ctx, v);
      break;
    case 'pid':
      writeIdRef(w, ctx, v);
      break;
    case 'eid':
      writeEntityId(w, ctx, v);
      break;
    case 'loadout':
      writeLoadout(w, ctx, v);
      break;
    case 'mags':
      writeMags(w, v);
      break;
    case 'attachments':
      writeAttachments(w, ctx, v);
      break;
    case 'stats':
      writeStats(w, ctx, v);
      break;
    case 'ammo':
      writeAmmo(w, ctx, v);
      break;
    case 'any':
      writeValue(w, ctx, v);
      break;
    default:
      throw new WireError(`未知字段编码 ${codec}`);
  }
}

function readField(r, ctx, codec) {
  switch (codec) {
    case 'pos':
      return readPos(r);
    case 'angle':
      return readAngle(r);
    case 'q10':
      return readQ(r, 10);
    case 'q100':
      return readQ(r, QUANT.CENTI);
    case 'q1000':
      return readQ(r, QUANT.MILLI);
    case 'q10000':
      return readQ(r, QUANT.MICRO);
    case 'int':
      return r.zigzag();
    case 'bool':
      return r.u8() !== 0;
    case 'str':
      return readStr(r, ctx);
    case 'pid':
      return readIdRef(r, ctx);
    case 'eid':
      return readEntityId(r, ctx);
    case 'loadout':
      return readLoadout(r, ctx);
    case 'mags':
      return readMags(r);
    case 'attachments':
      return readAttachments(r, ctx);
    case 'stats':
      return readStats(r, ctx);
    case 'ammo':
      return readAmmo(r, ctx);
    case 'any':
      return readValue(r, ctx);
    default:
      throw new WireError(`未知字段编码 ${codec}`);
  }
}

function writeFields(w, ctx, obj, schema) {
  const n = schema.length;
  const maskBytes = (n + 7) >> 3;
  const mask = new Uint8Array(maskBytes);
  const start = w.reserve(maskBytes);
  for (let i = 0; i < n; i++) {
    const field = schema[i];
    const key = field[0];
    const codec = field[1];
    const hasDefault = field.length >= 3;
    const v = obj[key];
    if (v === undefined) continue;
    if (hasDefault && sameValue(v, field[2])) continue;
    mask[i >> 3] |= 1 << (i & 7);
    writeField(w, ctx, codec, v);
  }
  w.patch(start, mask);
}

function readFields(r, ctx, schema, base) {
  const n = schema.length;
  const maskBytes = (n + 7) >> 3;
  const mask = r.raw(maskBytes);
  const out = base || {};
  for (let i = 0; i < n; i++) {
    const field = schema[i];
    const key = field[0];
    if (mask[i >> 3] & (1 << (i & 7))) out[key] = readField(r, ctx, field[1]);
    else if (field.length >= 3) out[key] = cloneDefault(field[2]);
  }
  return out;
}

// ── 通用值编码（未知事件字段 / horde / result / 顶层扩展）──────────────────
const T_NULL = 0;
const T_FALSE = 1;
const T_TRUE = 2;
const T_INT = 3;
const T_FLOAT = 4;
const T_STR = 5;
const T_ARR = 6;
const T_OBJ = 7;
const T_POS = 8;
const T_Q100 = 9;
const T_Q1000 = 10;
const T_Q10000 = 11;
const T_PID = 12;
const T_EID = 13;
const MAX_DEPTH = 12;
const MAX_ITEMS = 8192;

const KEY_CODEC = {
  x: 'pos',
  z: 'pos',
  tx: 'pos',
  tz: 'pos',
  baseX: 'pos',
  baseZ: 'pos',
  damage: 'q100',
  hp: 'q100',
  shield: 'q100',
  maxHp: 'q100',
  baseHp: 'q100',
  downedHp: 'q100',
  stamina: 'q100',
  r: 'q100',
  ttl: 'q100',
  nextIn: 'q100',
  nextWaveIn: 'q100',
  prepTime: 'q100',
  reviveAt: 'q100',
  speed: 'q100',
  power: 'q100',
  delay: 'q100',
  time: 'q100',
  blind: 'q100',
  reloadTime: 'q100',
  healTime: 'q100',
  fireCooldown: 'q100',
  bleedout: 'q100',
  reviveProgress: 'q100',
  chute: 'q100',
  spread: 'q10000',
  accuracy: 'q1000',
};

function writeValue(w, ctx, v, key, depth = 0) {
  if (depth > MAX_DEPTH) throw new WireError('嵌套过深');
  if (v === null || v === undefined) {
    w.u8(T_NULL);
    return;
  }
  const t = typeof v;
  if (t === 'boolean') {
    w.u8(v ? T_TRUE : T_FALSE);
    return;
  }
  if (t === 'number') {
    if (!Number.isFinite(v)) {
      w.u8(T_FLOAT);
      w.f64(v);
      return;
    }
    const codec = key ? KEY_CODEC[key] : null;
    if (codec === 'pos') {
      w.u8(T_POS);
      writePos(w, v);
      return;
    }
    if (codec === 'q100') {
      w.u8(T_Q100);
      writeQ(w, v, QUANT.CENTI);
      return;
    }
    if (codec === 'q1000') {
      w.u8(T_Q1000);
      writeQ(w, v, QUANT.MILLI);
      return;
    }
    if (codec === 'q10000') {
      w.u8(T_Q10000);
      writeQ(w, v, QUANT.MICRO);
      return;
    }
    if (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) {
      w.u8(T_INT);
      w.zigzag(v);
      return;
    }
    w.u8(T_FLOAT);
    w.f64(v);
    return;
  }
  if (t === 'string') {
    w.u8(T_STR);
    writeStr(w, ctx, v);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ITEMS) throw new WireError('数组过大');
    w.u8(T_ARR);
    w.varint(v.length);
    for (const item of v) writeValue(w, ctx, item, undefined, depth + 1);
    return;
  }
  if (t === 'object') {
    const keys = Object.keys(v);
    if (keys.length > MAX_ITEMS) throw new WireError('对象过大');
    w.u8(T_OBJ);
    w.varint(keys.length);
    for (const k of keys) {
      writeStr(w, ctx, k);
      writeValue(w, ctx, v[k], k, depth + 1);
    }
    return;
  }
  w.u8(T_NULL);
}

function readValue(r, ctx, key, depth = 0) {
  if (depth > MAX_DEPTH) throw new WireError('嵌套过深');
  const tag = r.u8();
  switch (tag) {
    case T_NULL:
      return null;
    case T_FALSE:
      return false;
    case T_TRUE:
      return true;
    case T_INT:
      return r.zigzag();
    case T_FLOAT:
      return r.f64();
    case T_STR:
      return readStr(r, ctx);
    case T_ARR: {
      const n = readCount(r, MAX_ITEMS);
      const out = [];
      for (let i = 0; i < n; i++) out.push(readValue(r, ctx, undefined, depth + 1));
      return out;
    }
    case T_OBJ: {
      const n = readCount(r, MAX_ITEMS);
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = readStr(r, ctx);
        out[k] = readValue(r, ctx, k, depth + 1);
      }
      return out;
    }
    case T_POS:
      return readPos(r);
    case T_Q100:
      return readQ(r, QUANT.CENTI);
    case T_Q1000:
      return readQ(r, QUANT.MILLI);
    case T_Q10000:
      return readQ(r, QUANT.MICRO);
    case T_PID:
      return readIdRef(r, ctx);
    case T_EID:
      return readEntityId(r, ctx);
    default:
      throw new WireError(`未知值类型 ${tag}`);
  }
}

function readCount(r, max) {
  const n = r.varint();
  if (n > max) throw new WireError(`数量超限 ${n} > ${max}`);
  return n;
}

// ── 各结构 schema ──────────────────────────────────────────────────────────
const PLAYER_SCHEMA = [
  ['x', 'pos'],
  ['z', 'pos'],
  ['angle', 'angle'],
  ['y', 'pos', 0],
  ['hp', 'q100', 100],
  ['armor', 'q100', 0],
  ['armorTier', 'int', 0],
  ['alive', 'bool', true],
  ['downed', 'bool', false],
  ['bleedout', 'q100', 0],
  ['reviveProgress', 'q100', 0],
  ['reviveTarget', 'pid', null],
  ['weapon', 'str', null],
  ['kills', 'int', 0],
  ['rank', 'int', 0],
  ['car', 'str', null],
  ['seat', 'int', -1],
  ['connected', 'bool', true],
  ['state', 'str', 'normal'],
  ['chute', 'q100', 0],
  // deployStage：instant 模式下键缺失（不是 null）。这里刻意不给默认值，
  // readFields 只在有默认值时才补字段，缺省即不出现，与 JSON 快照同构。
  ['deployStage', 'str'],
  // 落点预览（世界坐标）：舱内从第一帧就有，用于客户端画落点圈。
  ['dropPreviewX', 'pos'],
  ['dropPreviewZ', 'pos'],
];

const SELF_SCHEMA = [
  ['hp', 'q100', 100],
  ['armor', 'q100', 0],
  ['armorTier', 'int', 0],
  ['shield', 'q100', 0],
  ['alive', 'bool', true],
  ['downed', 'bool', false],
  ['downedHp', 'q100', 100],
  ['bleedout', 'q100', 0],
  ['reviveProgress', 'q100', 0],
  ['reviveTarget', 'pid', null],
  ['kills', 'int', 0],
  ['assists', 'int', 0],
  ['damage', 'q100', 0],
  ['rank', 'int', 0],
  ['state', 'str', 'normal'],
  ['x', 'pos'],
  ['z', 'pos'],
  ['angle', 'angle'],
  ['stamina', 'q100', 100],
  ['weapon', 'str', null],
  ['ammo', 'int', 0],
  ['reserve', 'int', 0],
  ['ammoType', 'str', null],
  ['slot', 'int', 0],
  ['loadout', 'loadout', EMPTY_LOADOUT],
  ['mags', 'mags', EMPTY_MAGS],
  ['meds', 'int', 0],
  ['bandages', 'int', 0],
  ['energy', 'int', 0],
  ['shields', 'int', 0],
  ['grenades', 'int', 0],
  ['smokes', 'int', 0],
  ['flashes', 'int', 0],
  ['molotovs', 'int', 0],
  ['car', 'str', null],
  ['seat', 'int', -1],
  ['interactLabel', 'str', null],
  ['blind', 'q100', 0],
  ['reloadTime', 'q100', 0],
  ['healTime', 'q100', 0],
  ['healKind', 'str', null],
  ['fireCooldown', 'q100', 0],
  ['spread', 'q10000', 0],
  ['accuracy', 'q1000', 1],
  ['stats', 'stats', null],
  // 空降（仅 skydive 模式赋值；instant 模式下为 undefined → 不写字节，
  // 解码端也不设置该键，与 JSON 快照的键缺失语义一致）。
  // deployStage：instant 模式下键缺失（不是 null）。这里刻意不给默认值，
  // readFields 只在有默认值时才补字段，缺省即不出现，与 JSON 快照同构。
  ['deployStage', 'str'],
  ['chute', 'q100', 0],
  ['y', 'pos', 0],
  // 落点预览：与 SELF_SCHEMA 同名同码，缺省不写（instant 模式无此键）。
  ['dropPreviewX', 'pos'],
  ['dropPreviewZ', 'pos'],
];

// 队友视图比玩家视图少 team/teamName/bot（客户端复用 players 时会自带），
// 因此只发 id 引用 + 名字，解码结果字段与 snapshot() 完全一致。
const TEAMMATE_SCHEMA = [
  ['name', 'str'],
  ['x', 'pos'],
  ['z', 'pos'],
  ['alive', 'bool', true],
  ['downed', 'bool', false],
  ['hp', 'q100', 100],
  ['bleedout', 'q100', 0],
  ['car', 'str', null],
  ['connected', 'bool', true],
  ['isSelf', 'bool', false],
];

// 注意 loot.ammo 是「弹药类型字符串」（light/medium/…）或 null，不是数量。
const LOOT_SCHEMA = [
  ['kind', 'str'],
  ['item', 'str'],
  ['x', 'pos'],
  ['z', 'pos'],
  ['y', 'pos', 0.05],
  ['qty', 'int', 1],
  ['ammo', 'ammo', null],
  ['rarity', 'str', 'common'],
  ['attachments', 'attachments', ATTACH_EMPTY],
];

const PING_SCHEMA = [
  ['team', 'int'],
  ['x', 'pos'],
  ['z', 'pos'],
  ['kind', 'str'],
  ['ttl', 'q100'],
];
const DROP_SCHEMA = [
  ['x', 'pos'],
  ['z', 'pos'],
  ['y', 'pos'],
  ['landsIn', 'q100'],
  ['opened', 'bool'],
];
const GRENADE_SCHEMA = [
  ['kind', 'str'],
  ['x', 'pos'],
  ['z', 'pos'],
  ['y', 'pos'],
  ['ttl', 'q100'],
];
const EFFECT_SCHEMA = [
  ['x', 'pos'],
  ['z', 'pos'],
  ['r', 'q100'],
  ['ttl', 'q100'],
];
const MARKER_SCHEMA = [
  ['kind', 'str'],
  ['x', 'pos'],
  ['z', 'pos'],
  ['r', 'q100'],
  ['label', 'str'],
];

function carSchema(type) {
  const spec = CAR_SPECS[type] || { hp: 0, maxHp: 0, color: 0, seats: 0 };
  return [
    ['x', 'pos'],
    ['z', 'pos'],
    ['angle', 'angle'],
    ['hp', 'q100', spec.hp],
    ['maxHp', 'q100', spec.maxHp],
    ['color', 'int', spec.color],
    ['seats', 'int', spec.seats],
    ['driver', 'pid', null],
    ['speed', 'q100', 0],
  ];
}
const CAR_SCHEMAS = Object.fromEntries(CAR_TYPES.map((t) => [t, carSchema(t)]));
const CAR_SCHEMA_FALLBACK = [
  ['x', 'pos'],
  ['z', 'pos'],
  ['angle', 'angle'],
  ['hp', 'q100'],
  ['maxHp', 'q100'],
  ['color', 'int'],
  ['seats', 'int'],
  ['driver', 'pid', null],
  ['speed', 'q100', 0],
];

// ── 事件 schema ─────────────────────────────────────────────────────────────
const EVENT_SCHEMAS = {
  start: [
    ['mode', 'str'],
    ['players', 'int'],
  ],
  land: [],
  shot: [
    ['player', 'pid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['tx', 'pos'],
    ['tz', 'pos'],
    ['weapon', 'str'],
    ['hit', 'bool'],
    ['hits', 'int'],
    ['headshots', 'int'],
  ],
  hit: [
    ['player', 'pid'],
    ['target', 'pid'],
    ['damage', 'q100'],
    ['armor', 'int'],
    ['headshot', 'bool'],
  ],
  headshot: [
    ['player', 'pid'],
    ['target', 'pid'],
    ['damage', 'q100'],
  ],
  down: [
    ['player', 'pid'],
    ['by', 'pid'],
    ['team', 'int'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  kill: [
    ['player', 'pid'],
    ['by', 'pid'],
    ['reason', 'str'],
    ['team', 'int'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['name', 'str'],
  ],
  revive: [
    ['player', 'pid'],
    ['name', 'str'],
    ['by', 'pid'],
    ['byName', 'str'],
  ],
  revived: [
    ['player', 'pid'],
    ['by', 'pid'],
  ],
  heal: [
    ['player', 'pid'],
    ['kind', 'str'],
  ],
  healStart: [
    ['player', 'pid'],
    ['item', 'str'],
    ['time', 'q100'],
  ],
  healCancel: [['player', 'pid']],
  healed: [
    ['player', 'pid'],
    ['item', 'str'],
    ['hp', 'q100'],
    ['shield', 'q100'],
  ],
  pickup: [
    ['player', 'pid'],
    ['item', 'str'],
    ['kind', 'str'],
  ],
  throw: [
    ['player', 'pid'],
    ['kind', 'str'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['tx', 'pos'],
    ['tz', 'pos'],
  ],
  explosion: [
    ['entityId', 'eid'],
    ['kind', 'str'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['r', 'q100'],
  ],
  smoke: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['r', 'q100'],
  ],
  smokeEnd: [['entityId', 'eid']],
  fire: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['r', 'q100'],
  ],
  flash: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['r', 'q100'],
  ],
  empty: [['player', 'pid']],
  airdrop: [
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  supply: [
    ['player', 'pid'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  zone: [
    ['phase', 'int'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['r', 'q100'],
    ['damage', 'int'],
    ['closing', 'bool'],
    ['wait', 'q100'],
    ['shrink', 'q100'],
    ['closed', 'bool'],
  ],
  vehicle: [
    ['action', 'str'],
    ['player', 'pid'],
    ['car', 'str'],
    ['seat', 'int'],
    ['force', 'bool'],
    ['hp', 'q100'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  ping: [
    ['player', 'pid'],
    ['team', 'int'],
    ['kind', 'str'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  wave: [
    ['wave', 'int'],
    ['count', 'int'],
    ['spawned', 'int'],
    ['boss', 'bool'],
    ['modifier', 'str'],
    ['modifierName', 'str'],
  ],
  waveClear: [
    ['wave', 'int'],
    ['credits', 'int'],
    ['score', 'int'],
    ['baseHp', 'q100'],
    ['time', 'q100'],
    ['killed', 'int'],
    ['modifier', 'str'],
  ],
  boss: [
    ['wave', 'int'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  basehit: [
    ['hp', 'q100'],
    ['maxHp', 'q100'],
    ['by', 'str'],
  ],
  end: [
    ['winnerTeam', 'int'],
    ['reason', 'str'],
    ['ranks', 'any'],
    ['horde', 'any'],
  ],
  levelup: [
    ['level', 'int'],
    ['player', 'pid'],
  ],
  enemyDown: [
    ['entityId', 'eid'],
    ['type', 'str'],
    ['boss', 'bool'],
    ['wave', 'int'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  enemyHit: [
    ['entityId', 'eid'],
    ['player', 'pid'],
    ['damage', 'q100'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  enemyRepath: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  dodge: [
    ['player', 'pid'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  drop: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  dropLanded: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  dropOpen: [
    ['entityId', 'eid'],
    ['player', 'pid'],
  ],
  respawn: [
    ['player', 'pid'],
    ['delay', 'q100'],
  ],
  reload: [
    ['player', 'pid'],
    ['weapon', 'str'],
    ['time', 'q100'],
  ],
  reloaded: [
    ['player', 'pid'],
    ['weapon', 'str'],
    ['ammo', 'int'],
    ['reserve', 'int'],
  ],
  swap: [
    ['player', 'pid'],
    ['slot', 'int'],
    ['weapon', 'str'],
  ],
  hordeStart: [
    ['waves', 'int'],
    ['baseX', 'pos'],
    ['baseZ', 'pos'],
  ],
  airstrike: [
    ['x', 'pos'],
    ['z', 'pos'],
    ['killed', 'int'],
    ['total', 'int'],
  ],
  upgrade: [
    ['player', 'pid'],
    ['kind', 'str'],
    ['cost', 'int'],
    ['name', 'str'],
  ],
  modifier: [
    ['wave', 'int'],
    ['id', 'str'],
    ['name', 'str'],
    ['desc', 'str'],
  ],
  achievement: [
    ['id', 'str'],
    ['name', 'str'],
    ['wave', 'int'],
  ],
  baseDestroyed: [
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  baseHitFx: [
    ['x', 'pos'],
    ['z', 'pos'],
    ['entityId', 'eid'],
  ],
  medHeal: [
    ['player', 'pid'],
    ['hp', 'q100'],
  ],
  knockback: [
    ['player', 'pid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['power', 'q100'],
  ],
  fuse: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  acidThrow: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['tx', 'pos'],
    ['tz', 'pos'],
  ],
  acidLand: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['r', 'q100'],
  ],
  bossCharge: [
    ['entityId', 'eid'],
    ['hit', 'str'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['tx', 'pos'],
    ['tz', 'pos'],
  ],
  bossChargeEnd: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  bossQuake: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['r', 'q100'],
  ],
  bossSummon: [
    ['entityId', 'eid'],
    ['count', 'int'],
    ['x', 'pos'],
    ['z', 'pos'],
  ],
  turretShot: [
    ['entityId', 'eid'],
    ['x', 'pos'],
    ['z', 'pos'],
    ['tx', 'pos'],
    ['tz', 'pos'],
    ['overcharge', 'bool'],
  ],
};

const EVENT_KEYSETS = new Map();
for (const [type, schema] of Object.entries(EVENT_SCHEMAS)) {
  EVENT_KEYSETS.set(type, new Set(schema.map((f) => f[0])));
}
const EMPTY_KEYSET = new Set();

function writeExtras(w, ctx, obj, known) {
  const keys = [];
  for (const k of Object.keys(obj)) {
    if (k === 'id' || k === 'type' || k === 'time' || known.has(k)) continue;
    keys.push(k);
  }
  w.varint(keys.length);
  for (const k of keys) {
    writeStr(w, ctx, k);
    writeValue(w, ctx, obj[k], k);
  }
}

function readExtras(r, ctx) {
  const n = readCount(r, 64);
  const out = {};
  for (let i = 0; i < n; i++) {
    const k = readStr(r, ctx);
    out[k] = readValue(r, ctx, k);
  }
  return out;
}

function encodeEvent(w, ctx, ev) {
  w.varint(Number.isFinite(ev.id) ? Math.max(0, Math.round(ev.id)) : 0);
  writeStr(w, ctx, ev.type);
  w.varint(Math.max(0, quant(ev.time, QUANT.CENTI)));
  const schema = EVENT_SCHEMAS[ev.type];
  if (!schema) {
    writeExtras(w, ctx, ev, EMPTY_KEYSET);
    return;
  }
  writeFields(w, ctx, ev, schema);
  writeExtras(w, ctx, ev, EVENT_KEYSETS.get(ev.type) || EMPTY_KEYSET);
}

function decodeEvent(r, ctx) {
  const id = r.varint();
  const type = readStr(r, ctx);
  const time = r.varint() / QUANT.CENTI;
  const schema = EVENT_SCHEMAS[type];
  const base = { id, type, time };
  if (!schema) {
    const extras = readExtras(r, ctx);
    return Object.assign(base, extras);
  }
  const ev = readFields(r, ctx, schema, base);
  const extras = readExtras(r, ctx);
  return Object.assign(ev, extras);
}

// ── 快照主体 ───────────────────────────────────────────────────────────────
const KNOWN_TOP_KEYS = new Set([
  'v',
  'flight',
  'mode',
  'mapId',
  'mapName',
  'weather',
  'timeOfDay',
  'phase',
  'time',
  'matchTime',
  'duration',
  'zone',
  'counts',
  'selfId',
  'me',
  'players',
  'loot',
  'lootPatch',
  'cars',
  'grenades',
  'smokes',
  'fires',
  'pings',
  'drops',
  'markers',
  'horde',
  'events',
  'loading',
  'result',
  'teammates',
]);

function encodeFlight(w, flight) {
  // 1 字节存在标志：非空降阶段（绝大多数帧）只花 1 字节。
  w.u8(flight ? 1 : 0);
  if (!flight) return;
  writePos(w, flight.x);
  writePos(w, flight.z);
  writePos(w, flight.fromX);
  writePos(w, flight.fromZ);
  writePos(w, flight.toX);
  writePos(w, flight.toZ);
  w.u8(flight.open ? 1 : 0);
  writeQ(w, flight.closeIn, QUANT.CENTI);
  w.varint(Math.max(0, Math.round(flight.jumped || 0)));
  w.varint(Math.max(0, Math.round(flight.total || 0)));
}

function decodeFlight(r) {
  if (r.u8() === 0) return null;
  const x = readPos(r);
  const z = readPos(r);
  const fromX = readPos(r);
  const fromZ = readPos(r);
  const toX = readPos(r);
  const toZ = readPos(r);
  const open = r.u8() !== 0;
  const closeIn = readQ(r, QUANT.CENTI);
  const jumped = r.varint();
  const total = r.varint();
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  return { x, z, fromX, fromZ, toX, toZ, ux: dx / len, uz: dz / len, open, closeIn, jumped, total };
}

function encodeZone(w, zone) {
  const z = zone || {};
  writePos(w, z.x);
  writePos(w, z.z);
  writePos(w, z.r);
  const target = z.target || {};
  writePos(w, target.x);
  writePos(w, target.z);
  writePos(w, target.r);
  w.u8(z.closing ? 1 : 0);
  w.zigzag(Number.isFinite(z.damage) ? Math.round(z.damage) : 0);
  w.zigzag(Number.isFinite(z.phase) ? Math.round(z.phase) : 0);
  writeQ(w, z.nextIn, QUANT.CENTI);
}

function decodeZone(r) {
  return {
    x: readPos(r),
    z: readPos(r),
    r: readPos(r),
    target: { x: readPos(r), z: readPos(r), r: readPos(r) },
    closing: r.u8() !== 0,
    damage: r.zigzag(),
    phase: r.zigzag(),
    nextIn: readQ(r, QUANT.CENTI),
  };
}

function encodeCounts(w, counts) {
  const c = counts || {};
  for (const key of ['alive', 'total', 'teams', 'aliveTeams', 'humans', 'bots']) {
    w.varint(Math.max(0, Number.isFinite(c[key]) ? Math.round(c[key]) : 0));
  }
}

function decodeCounts(r) {
  return {
    alive: r.varint(),
    total: r.varint(),
    teams: r.varint(),
    aliveTeams: r.varint(),
    humans: r.varint(),
    bots: r.varint(),
  };
}

function encodeLootItem(w, ctx, item) {
  writeLootId(w, item.id);
  writeFields(w, ctx, item, LOOT_SCHEMA);
}

function decodeLootItem(r, ctx) {
  return readFields(r, ctx, LOOT_SCHEMA, { id: readLootId(r) });
}

function encodeLoot(w, ctx, state) {
  if (Array.isArray(state.loot)) {
    w.u8(1);
    w.varint(state.loot.length);
    for (const item of state.loot) encodeLootItem(w, ctx, item);
    return;
  }
  if (state.lootPatch && typeof state.lootPatch === 'object') {
    w.u8(2);
    const upsert = Array.isArray(state.lootPatch.upsert) ? state.lootPatch.upsert : [];
    const remove = Array.isArray(state.lootPatch.remove) ? state.lootPatch.remove : [];
    w.varint(upsert.length);
    for (const item of upsert) encodeLootItem(w, ctx, item);
    w.varint(remove.length);
    for (const id of remove) writeLootId(w, id);
    return;
  }
  w.u8(0);
}

function decodeLoot(r, ctx, state) {
  const mode = r.u8();
  if (mode === 1) {
    const n = readCount(r, MAX_ITEMS);
    const loot = [];
    for (let i = 0; i < n; i++) loot[i] = decodeLootItem(r, ctx);
    state.loot = loot;
    return;
  }
  if (mode === 2) {
    const un = readCount(r, MAX_ITEMS);
    const upsert = [];
    for (let i = 0; i < un; i++) upsert[i] = decodeLootItem(r, ctx);
    const rn = readCount(r, MAX_ITEMS);
    const remove = [];
    for (let i = 0; i < rn; i++) remove[i] = readLootId(r);
    state.lootPatch = { upsert, remove };
  }
}

function encodeCars(w, ctx, cars) {
  w.varint(cars.length);
  for (const car of cars) {
    writeStr(w, ctx, car.id);
    writeStr(w, ctx, car.type);
    const schema = CAR_SCHEMAS[car.type] || CAR_SCHEMA_FALLBACK;
    writeFields(w, ctx, car, schema);
  }
}

function decodeCars(r, ctx) {
  const n = readCount(r, 64);
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = readStr(r, ctx);
    const type = readStr(r, ctx);
    const schema = CAR_SCHEMAS[type] || CAR_SCHEMA_FALLBACK;
    out[i] = readFields(r, ctx, schema, { id, type });
  }
  return out;
}

function encodeSimpleList(w, ctx, list, schema) {
  w.varint(list.length);
  for (const item of list) {
    writeStr(w, ctx, item.id);
    writeFields(w, ctx, item, schema);
  }
}

function decodeSimpleList(r, ctx, schema, max = 1024) {
  const n = readCount(r, max);
  const out = [];
  for (let i = 0; i < n; i++) {
    out[i] = readFields(r, ctx, schema, { id: readStr(r, ctx) });
  }
  return out;
}

function encodeTeammates(w, ctx, list) {
  w.varint(list.length);
  for (const mate of list) {
    writeIdRef(w, ctx, mate.id);
    writeFields(w, ctx, mate, TEAMMATE_SCHEMA);
  }
}

function decodeTeammates(r, ctx) {
  const n = readCount(r, 64);
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = readIdRef(r, ctx);
    out[i] = readFields(r, ctx, TEAMMATE_SCHEMA, { id });
  }
  return out;
}

function encodePlayers(w, ctx, list) {
  w.varint(list.length);
  for (const p of list) {
    writePlayerRef(w, ctx, p);
    writeFields(w, ctx, p, PLAYER_SCHEMA);
  }
}

function decodePlayers(r, ctx) {
  const n = readCount(r, 1024);
  const out = [];
  for (let i = 0; i < n; i++) {
    const ref = readPlayerRef(r, ctx);
    out[i] = readFields(r, ctx, PLAYER_SCHEMA, ref);
  }
  return out;
}

function encodeMe(w, ctx, me) {
  if (!me) {
    w.u8(0);
    return;
  }
  w.u8(1);
  writePlayerRef(w, ctx, me);
  writeFields(w, ctx, me, SELF_SCHEMA);
}

function decodeMe(r, ctx) {
  if (r.u8() === 0) return null;
  const ref = readPlayerRef(r, ctx);
  return readFields(r, ctx, SELF_SCHEMA, ref);
}

function encodeEvents(w, ctx, events) {
  w.varint(events.length);
  for (const ev of events) encodeEvent(w, ctx, ev);
}

function decodeEvents(r, ctx) {
  const n = readCount(r, 4096);
  const out = [];
  for (let i = 0; i < n; i++) out[i] = decodeEvent(r, ctx);
  return out;
}

function encodeExtra(w, ctx, state) {
  const keys = [];
  for (const k of Object.keys(state)) if (!KNOWN_TOP_KEYS.has(k)) keys.push(k);
  w.varint(keys.length);
  for (const k of keys) {
    writeStr(w, ctx, k);
    writeValue(w, ctx, state[k], k);
  }
}

function readExtra(r, ctx, state) {
  const n = readCount(r, 64);
  for (let i = 0; i < n; i++) {
    const k = readStr(r, ctx);
    state[k] = readValue(r, ctx, k);
  }
}

function encodeViewerBlock(w, ctx, state) {
  w.u8(Number.isFinite(state.v) ? state.v & 0xff : 3);
  writeStr(w, ctx, state.mode);
  writeStr(w, ctx, state.mapId);
  writeStr(w, ctx, state.mapName);
  writeStr(w, ctx, state.weather);
  writeStr(w, ctx, state.timeOfDay);
  writeStr(w, ctx, state.phase);
  writeTime(w, state.time);
  writeTime(w, state.matchTime);
  w.varint(Math.max(0, Number.isFinite(state.duration) ? Math.round(state.duration) : 0));

  encodeFlight(w, state.flight || null);
  encodeZone(w, state.zone);
  encodeCounts(w, state.counts);
  writeIdRef(w, ctx, state.selfId);
  encodeMe(w, ctx, state.me);
  encodePlayers(w, ctx, Array.isArray(state.players) ? state.players : []);

  encodeLoot(w, ctx, state);
  encodeSimpleList(w, ctx, Array.isArray(state.pings) ? state.pings : [], PING_SCHEMA);
  encodeTeammates(w, ctx, Array.isArray(state.teammates) ? state.teammates : []);
  encodeExtra(w, ctx, state);
}

/**
 * 与观察者无关的区块（车辆/投掷物/烟雾/火焰/空投/标记/horde/事件窗口/loading/结算）。
 * 同一 tick 内 64 名玩家的这些区块完全相同，服务端可以只编码一次、复用字节，
 * 把「每帧 64 次序列化」降成「1 次共享区块 + 64 次小增量」。
 */
function encodeSharedBlock(w, ctx, state) {
  encodeCars(w, ctx, Array.isArray(state.cars) ? state.cars : []);
  encodeSimpleList(w, ctx, Array.isArray(state.grenades) ? state.grenades : [], GRENADE_SCHEMA);
  encodeSimpleList(w, ctx, Array.isArray(state.smokes) ? state.smokes : [], EFFECT_SCHEMA);
  encodeSimpleList(w, ctx, Array.isArray(state.fires) ? state.fires : [], EFFECT_SCHEMA);
  encodeSimpleList(w, ctx, Array.isArray(state.drops) ? state.drops : [], DROP_SCHEMA);
  encodeSimpleList(w, ctx, Array.isArray(state.markers) ? state.markers : [], MARKER_SCHEMA);
  writeValue(w, ctx, state.horde == null ? null : state.horde, 'horde');
  encodeEvents(w, ctx, Array.isArray(state.events) ? state.events : []);
  if (state.loading) {
    w.u8(1);
    w.varint(Math.max(0, Math.round(state.loading.ready || 0)));
    w.varint(Math.max(0, Math.round(state.loading.total || 0)));
  } else {
    w.u8(0);
  }
  writeValue(w, ctx, state.result == null ? null : state.result, 'result');
}

function decodeSharedBlock(r, ctx, state) {
  state.cars = decodeCars(r, ctx);
  state.grenades = decodeSimpleList(r, ctx, GRENADE_SCHEMA);
  state.smokes = decodeSimpleList(r, ctx, EFFECT_SCHEMA);
  state.fires = decodeSimpleList(r, ctx, EFFECT_SCHEMA);
  state.drops = decodeSimpleList(r, ctx, DROP_SCHEMA, 64);
  state.markers = decodeSimpleList(r, ctx, MARKER_SCHEMA, 64);
  state.horde = readValue(r, ctx, 'horde');
  state.events = decodeEvents(r, ctx);
  state.loading = r.u8() === 0 ? null : { ready: r.varint(), total: r.varint() };
  state.result = readValue(r, ctx, 'result');
}

function decodeStateViewer(r, ctx, state) {
  state.v = r.u8();
  state.mode = readStr(r, ctx);
  state.mapId = readStr(r, ctx);
  state.mapName = readStr(r, ctx);
  state.weather = readStr(r, ctx);
  state.timeOfDay = readStr(r, ctx);
  state.phase = readStr(r, ctx);
  state.time = readTime(r);
  state.matchTime = readTime(r);
  state.duration = r.varint();

  // 无航线时不设键（而不是设 null）：JSON 快照里 `flight` 也是键缺失，
  // 两边键集合必须一致，否则结构一致性断言会报 undefined != null。
  const flight = decodeFlight(r);
  if (flight) state.flight = flight;
  state.zone = decodeZone(r);
  state.counts = decodeCounts(r);
  state.selfId = readIdRef(r, ctx);
  state.me = decodeMe(r, ctx);
  state.players = decodePlayers(r, ctx);

  decodeLoot(r, ctx, state);
  state.pings = decodeSimpleList(r, ctx, PING_SCHEMA);
  state.teammates = decodeTeammates(r, ctx);
  readExtra(r, ctx, state);
}

// ── 对外 API ───────────────────────────────────────────────────────────────
// 帧布局：[FRAME_STATE u8][WIRE_VERSION u8][flags u8][保留 u8]
//   → 共享区块（车辆/事件/空投/horde/结算…，与观察者无关）
//   → 观察者区块（顶层帧头/zone/counts/me/players/loot/pings/teammates/扩展字段）
// 共享区块先编码，这样服务端可以把「同一 tick、同一事件窗口」的字节算一次给全房复用。
const FLAG_SPECTATOR = 1;

/**
 * 只编码共享区块。同一 tick 内 64 个观察者只需调用一次，把结果通过
 * `encodeStateFrame(..., { shared })` 传回，可省掉 63 次重复编码。
 * 注意：事件窗口随 sinceEventId 变化，缓存键必须是 (tick, eventId)。
 */
export function encodeSharedBlockFrame(state, ctx, opts = {}) {
  if (!ctx || !ctx.table) throw new WireError('缺少 wire 上下文');
  const w = opts.writer instanceof Writer ? opts.writer : new Writer(opts.capacity || 4096);
  w.reset();
  encodeSharedBlock(w, ctx, state || {});
  // bytes() 返回副本：调用方可以长期持有，writer 之后可安全复用。
  return w.bytes();
}

/**
 * 编码一帧二进制 state。
 * @param {object} state snapshot() 输出（JSON 路径完全不变）
 * @param {object} ctx createWireContext() 返回的上下文
 * @param {{writer?: Writer, spectator?: boolean, shared?: Uint8Array, sharedWriter?: Writer}} opts
 *   - shared：encodeSharedBlockFrame() 的返回值，可跨观察者复用
 *   - writer / sharedWriter：可复用的缓冲区，减少 GC
 * @returns {Uint8Array} 可直接 ws.send 的二进制帧（内部已复制，调用方可长期持有）
 */
export function encodeStateFrame(state, ctx, opts = {}) {
  if (!ctx || !ctx.table) throw new WireError('缺少 wire 上下文');
  const s = state || {};
  let shared = opts.shared;
  if (!(shared instanceof Uint8Array)) shared = encodeSharedBlockFrame(s, ctx, { writer: opts.sharedWriter });
  const w = opts.writer instanceof Writer ? opts.writer : new Writer(opts.capacity || 4096);
  w.reset();
  w.u8(FRAME_STATE);
  w.u8(WIRE_VERSION);
  w.u8(opts.spectator ? FLAG_SPECTATOR : 0);
  w.u8(0);
  w.raw(shared);
  encodeViewerBlock(w, ctx, s);
  return w.bytes();
}

/**
 * 解码一帧二进制 state。返回与 JSON 路径同构的状态对象（数值有量化误差）。
 * @returns {{type:'state', state:object, spectator:boolean}}
 */
export function decodeStateFrame(bytes, ctx) {
  if (!ctx || !ctx.table) throw new WireError('缺少 wire 上下文');
  const r = new Reader(bytes);
  const frame = r.u8();
  if (frame !== FRAME_STATE) throw new WireError(`未知帧类型 ${frame}`);
  const version = r.u8();
  if (version !== WIRE_VERSION) throw new WireError(`wire 版本不一致 ${version}`);
  const flags = r.u8();
  r.u8();
  const state = {};
  decodeSharedBlock(r, ctx, state);
  decodeStateViewer(r, ctx, state);
  if (r.remaining !== 0) throw new WireError(`帧尾有 ${r.remaining} 字节多余数据`);
  return { type: 'state', state, spectator: (flags & FLAG_SPECTATOR) !== 0 };
}

export { Writer as WireWriter, Reader as WireReader };
export default {
  encodeStateFrame,
  decodeStateFrame,
  encodeSharedBlockFrame,
  createWireContext,
  rosterFromPlayers,
  WIRE_VERSION,
};
