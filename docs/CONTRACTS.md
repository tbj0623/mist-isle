# MIST ISLE 1.0 — 并行开发契约（唯一事实来源）

> 本文件是所有并行开发者的**绑定契约**。任何跨模块的数据结构、函数签名、DOM id、文件归属都以本文件为准。
> 如果你认为契约有问题：**不要自行改动并传播**，先在 `docs/CONTRACT-NOTES.md` 记录，并给 Lead 发消息；Lead 会更新本文件。
> 版本：1.0.0 · 协议版本：3 · 更新：2026-10-18

---

## 0. 计划与硬性约束

- 产品：《雾岛突围 / MIST ISLE》1.0.0，**横屏俯视角（top-down）战术竞技手游**，Android WebView + Three.js 渲染，服务端 Node.js。
- 现有 `0.2.0` 是原型：全部源码都要按本契约重构/替换，可以删除旧实现，但必须保持 `npm run build`、`npm start`、`npm test`、`npm run android` 可用。
- 依赖固定：`three@0.180.0`、`ws@8.22.0`、`lucide@1.53.0`、`esbuild`、`@playwright/test`。**禁止新增任何运行时依赖**（不要 npm install 新包）。全部美术/音效用代码程序化生成。
- ESM（`.mjs` / `"type":"module"`），2 空格缩进，单引号，行尾分号。中文 UI 文案直接写在代码里。
- `shared/` 必须**同构**：不允许出现 `window`、`document`、`performance.now` 之外任何 DOM/Node 专属 API（`performance` 用 `Date.now` 代替）。共享层必须可被 Node 测试直接 import。
- 模拟必须**确定性**：只使用 `match.rng()`（种子随机），禁止 `Math.random()`；时间只能用传入的 `dt`。
- 性能预算：服务端 64 人 30Hz 单核 < 60% 单帧预算（1 tick 平均 < 8ms，p99 < 20ms）；客户端中端机 60FPS（draw calls < 220，三角面 < 260k）。
- 每个模块作者**只改自己名下的文件**。跨文件需求发消息给 Lead 或对应 owner。
- 提交：不要 `git commit`（Lead 统一提交）。不要改 `package.json`（Lead 维护），需要脚本/依赖时给 Lead 发消息。
- 测试：只运行自己负责的测试文件，例如 `node --test tests/simulation.test.mjs`。`npm test` 由 Lead 统一跑。

## 1. 文件归属（Owner）

| 文件/目录 | Owner | 说明 |
| --- | --- | --- |
| `shared/rules.mjs` | **Lead**（已冻结，只读） | 常量 |
| `shared/data/maps.mjs` | **Lead**（只读） | 3 张地图定义 |
| `shared/data/weapons.mjs`、`attachments.mjs`、`items.mjs`、`loot.mjs` | `gamedata` | 武器/配件/道具/掉落表 |
| `shared/data/missions.mjs`、`achievements.mjs`、`store.mjs`、`ranks.mjs`、`bots.mjs` | `metacontent` | 任务/成就/商店/段位/AI 名字 |
| `shared/progression.mjs` | `metacontent` | 纯函数：经验/等级/段位/奖励/任务进度 |
| `shared/map.mjs` | `worldgen` | `makeWorld(mapId)`，碰撞/射线/导航 |
| `shared/simulation.mjs` | `simcore` | `Match` 全部玩法逻辑与快照 |
| `shared/ai.mjs` | `botai` | Bot 决策（被 simulation 调用） |
| `server/index.mjs` | `netserver` | 房间/协议/网络 |
| `client/net.js` | `netserver` | 客户端 WebSocket 封装 |
| `client/models.js` | `models` | 程序化模型工厂（角色/载具/建筑/道具） |
| `client/scene.js`、`client/fx.js` | `renderfx` | 场景渲染/特效 |
| `client/ui-hud.js` | `uihud` | 局内 HUD/小地图/击杀播报（**动态建 DOM，容器 `#hud`**） |
| `client/ui-screens.js` | `uiscreens` | 局外界面/大厅/设置/结算（**动态建 DOM，容器 `#screen-root` `#dialog-root`**） |
| `client/index.html`、`client/style.css` | `design` | 页面外壳 + 设计系统与全部样式 |
| `client/audio.js` | `feel-audio` | 程序化音效与音乐 |
| `client/input.js` | `feel-input` | 键盘/触控/摇杆/震动 |
| `client/meta.js` | `metacontent` | 本地存档（localStorage）读写与奖励结算 |
| `client/main.js` | **Lead** | 应用装配与主循环 |
| `tests/e2e/**`、`scripts/benchmark.mjs`、`scripts/smoke*.mjs` | `qa` | 端到端与压力 |
| `android/**`、`scripts/build*.mjs`、`scripts/build-android.ps1`、`docs/**`、`README.md` | **Lead** | 构建与文档 |

## 2. 核心常量（`shared/rules.mjs`，只读）

```js
export const PROTOCOL_VERSION = 3;
export const VERSION = '1.0.0';
export const TICK_RATE = 30;            // 服务端/离线模拟
export const SNAPSHOT_EVERY_TICKS = 3;  // 10 Hz
export const MAX_PLAYERS = 64;
export const SQUAD_SIZE = 4;
export const MAX_TEAMS = 16;
export const MAX_HUMANS = 64;
export const MAX_LOOT = 640;
export const REVIVE_TIME = 4.5;
export const BLEEDOUT_TIME = 30;
export const MAP_RADIUS = ...            // 每张地图不同，见 map 定义
export const MOVE = { walk:6.2, sprint:8.7, crouch:3.4, downed:2.2, vehicleMul:... }
export const COMBAT = {...}
export const ZONE_PHASES = [...]        // 多阶段缩圈
export const RARITY = ['common','uncommon','rare','epic','legendary'];
export const RARITY_COLORS = {...}
export const AMMO_TYPES = {...}
export const MATCH_MODES = ['solo','squad','horde','training'];
export const WEATHER = ['clear','rain','fog','sandstorm','snow'];
```

> 实际字段以 `shared/rules.mjs` 文件为准；禁止修改该文件。

## 3. 权威快照（snapshot）结构

所有渲染/HUD/网络都只消费这个结构。服务端 `Match.snapshot(viewerId, sinceEventId)` 与离线模拟返回**同构**对象。
单位：位置=游戏单位（约 1m），角度=弧度（0=+Z 方向，`sin(angle)` 为 x 分量），时间=秒。

```js
{
  v: 3,
  mode: 'solo'|'squad'|'horde'|'training',
  mapId: 'qinglan'|'chisha'|'baiye',
  mapName: '青岚岛',
  weather: 'clear'|'sandstorm'|'fog'|'snow'|'rain',
  timeOfDay: 'day'|'dusk'|'night',
  phase: 'lobby'|'loading'|'deploying'|'playing'|'ended',
  time: 123.4,            // 当前阶段已过时间
  matchTime: 132.0,       // 全局对局时间
  duration: 420,
  zone: {
    x: 0, z: 0,
    r: 165,               // 当前安全区半径
    target: { x: 12, z: -8, r: 92 },   // 下一圈中心与半径
    closing: true,        // 是否正在缩圈
    damage: 4,            // 圈外每秒伤害
    phase: 1,             // 1..5
    nextIn: 22.5          // 距离下一次状态变化（秒）
  },
  counts: { alive: 41, total: 64, teams: 16, aliveTeams: 9, humans: 4, bots: 37 },
  selfId: 'p_ab12' | null,
  me: {                   // 本机玩家完整状态；无本机（观战/大厅）时为 null
    id, name, bot, team, teamName, hp, armor, armorTier, alive, downed, downedHp, bleedout,
    reviveProgress, reviveTarget, kills, damage, rank, assists, state: 'normal'|'crouch'|'sprint'|'dodge'|'downed'|'dead'|'vehicle',
    stamina, x, z, angle, weapon, ammo, reserve, ammoType, slot, loadout: [{ type, ammo, attachments:['red_dot'] }],
    mags: { light: 40 }, meds, bandages, energy, shields, grenades, smokes, flashes, molotovs,
    car, seat, interactLabel, pingCooldown, fireCooldown, reloadTime, healTime, healKind,
    accuracy: 0.5, aliveAtEnd, spectating
  },
  players: [ {            // 可见的其他玩家（服务端按距离过滤；队友永远可见）
    id, name, bot, team, teamName,
    x, z, angle, y,       // y = 空降高度/载具高度偏移（0 = 地面）
    hp, armor, armorTier, alive, downed, bleedout, reviveProgress, reviveTarget,
    weapon, rank, kills, car, seat, connected, state, chute: 0..1, lastSeen, ping
  } ],
  loot: [ { id, type:'weapon'|'ammo'|'consumable'|'armor'|'throwable'|'attachment'|'backpack',
            item: 'ar7', x, z, y, qty, ammo, rarity, attachments:['red_dot'] } ],
  lootPatch: { upsert: [...], remove: ['l12'] },   // 服务端增量；离线为 undefined
  cars: [ { id, type:'buggy'|'jeep'|'bike'|'truck', x, z, angle, hp, maxHp, color, seats:[id|null x4], driver, speed } ],
  grenades: [ { id, kind:'frag'|'smoke'|'flash'|'molotov', x, z, y, ttl } ],
  smokes:   [ { id, x, z, r, ttl } ],
  fires:    [ { id, x, z, r, ttl } ],
  pings:    [ { id, team, x, z, kind:'enemy'|'loot'|'move'|'help', ttl } ],
  drops:    [ { id, x, z, y, landsIn, opened } ],
  markers:  [ { id, kind:'boss'|'objective'|'zone', x, z, r, label } ],
  horde: null | { wave: 3, totalWaves: 10, enemiesLeft: 12, nextWaveIn: 8.5, boss: false, score: 1240, baseHp: 500, baseMaxHp: 500, prepTime: 0 },
  events: [ { id, type, time, ...payload } ],      // 见 §3.1，按 id 递增
  loading: null | { ready: 2, total: 4 },
  result: null | { winnerTeam, winnerName, reason:'squad'|'timeout'|'horde'|'wipe', ranks:[{team,name,rank,players:[{id,name,kills,damage,survived}]}] },
  teammates: [ { id, name, x, z, alive, downed, hp, bleedout, car } ]  // 小队面板专用（含自己）
}
```

### 3.1 事件类型（`events[]`）

| type | 额外字段 |
| --- | --- |
| `start` | `mapId, mode` |
| `land` | `-` |
| `shot` | `player, x, z, tx, tz, weapon, hit(null|id), kill(false)` |
| `hit` | `player(攻击者), target, damage, armor, headshot(false)` |
| `down` | `player, attacker, name, attackerName, weapon` |
| `kill` | `player, attacker, name, attackerName, weapon, reason, rank` |
| `revive` | `player, name, by, byName` |
| `heal` | `player, kind` |
| `pickup` | `player, item, name` |
| `throw` | `player, kind` |
| `explosion` | `x, z, r, kind` |
| `smoke` | `x, z, r` |
| `fire` | `x, z, r` |
| `flash` | `x, z, r` |
| `empty` | `player` |
| `airdrop` | `x, z` |
| `supply` | `player, x, z` |
| `zone` | `phase, x, z, r` |
| `vehicle` | `player, car, action:'enter'|'exit'|'destroy'` |
| `ping` | `player, team, kind, x, z` |
| `wave` | `wave, totalWaves, boss` |
| `boss` | `name, x, z` |
| `basehit` | `hp, maxHp` |
| `end` | `winnerTeam, winnerName, reason` |
| `levelup` | `level`（仅本地离线/客户端生成） |

客户端必须忽略未知事件类型。

## 4. 网络协议（WebSocket `/ws`，JSON 文本）

- 客户端 → 服务端：
  - `{type:'join', protocol, mode:'create'|'join'|'quick'|'resume', code, token, name, team, gameMode:'squad'|'solo'|'horde', mapId, loadout:{primary,secondary,attachments}, clientVersion, difficulty}`
  - `{type:'ready'}`：渲染就绪
  - `{type:'start'}`：房主开始
  - `{type:'input', input:{seq,mx,mz,aim,fire,reload,heal,interact,swap,throwable:'frag'|'smoke'|'flash'|'molotov'|null, sprint, crouch, dodge, useItem:'bandage'|'med'|'energy'|'shield'|null, ping, pingKind, revive, slot:0|1, buy, upgrade, ready}}`
  - `{type:'chat', text, channel:'team'|'all'}`（服务端限制 80 字、2 条/秒）
  - `{type:'rematch'}`、`{type:'leave'}`、`{type:'ping', sent}`
- 服务端 → 客户端：
  - `{type:'hello', protocol, version, motd}`
  - `{type:'joined', id, token, code, host:bool, team, teamName, mapId, mode}`
  - `{type:'lobby', code, public, host, mode, gameMode, mapId, mapName, startsIn, players:[{id,name,team,host,ready,connected,level}], max, teamSize, difficulty}`
  - `{type:'state', state:snapshot}`
  - `{type:'error', message, code?}`
  - `{type:'chat', from, name, team, text, channel}`
  - `{type:'pong', sent, time}`
  - `{type:'expired'}` / `{type:'left'}` / `{type:'kicked', reason}`
- 频率：input 25Hz（40ms），state 10Hz，ping 每 2s。单帧 JSON < 32KB（服务端必须做 loot/事件增量 + 距离过滤）。
- 校验：服务端 `sanitizeInput` 白名单 + 限速（90 msg/s）+ 速率桶 + 载荷上限 4KB；位置/伤害/血量只信服务端。

## 5. 数据文件契约

### 5.1 `shared/data/weapons.mjs`
```js
export const AMMO_TYPES = {
  light:  { id:'light',  name:'手枪弹', color:0xd8d3a2, pickup:45, cap:300 },
  medium: { id:'medium', name:'步枪弹', color:0xc9b07a, pickup:30, cap:240 },
  heavy:  { id:'heavy',  name:'重型弹', color:0xb08a6a, pickup:15, cap:150 },
  shell:  { id:'shell',  name:'霰弹',   color:0xd06a4f, pickup:12, cap:96  },
  bolt:   { id:'bolt',   name:'弩箭',   color:0x8fb6a8, pickup:12, cap:96  },
};
export const WEAPONS = {
  p9: {
    id:'p9', name:'P9 手枪', short:'P9', cls:'pistol',      // pistol|smg|rifle|shotgun|marksman|sniper|lmg|special
    ammo:'light', damage:26, interval:0.30, magazine:15, reload:1.25,
    spread:0.030, recoil:0.7, range:34, pellets:1, auto:false,
    moveMul:1.05, adsZoom:1.15, noise:0.85, rarity:'common', tier:1,
    unlock:1, price:0, slots:['muzzle','mag'],
    art:{ len:0.55, body:0x3c4a4f, accent:0x9a7a4b, size:0.9 },
    desc:'可靠的制式手枪，弹药随处可见。'
  },
  // ... 共 18 把：pistol×2, smg×3, rifle×3, shotgun×2, marksman×2, sniper×2, lmg×2, special×2
};
export const ATTACHMENTS = {
  red_dot: { id:'red_dot', name:'红点镜', slot:'optic', rarity:'common', unlock:1, price:0,
             mods:{ adsZoom:0.12, spread:-0.10, range:0.05 }, desc:'...' },
  // optic×4, muzzle×4, mag×3, grip×3
};
export const WEAPON_ORDER = ['p9', ...];     // 图鉴/商店顺序
export const LOOT_WEAPON_POOL = { low:[...], mid:[...], high:[...] };
```
`mods` 为乘加系数（`spread:-0.1` 表示乘 0.9；`adsZoom:+0.12` 为加算）。`interval` 为射击间隔（秒）。

### 5.2 `shared/data/items.mjs`
```js
export const ARMORS = {
  armor1:{ id:'armor1', name:'轻型护甲', tier:1, absorb:0.35, durability:60, rarity:'common', unlock:1, price:0, color:0x88bfe2 },
  armor2:{...tier:2, absorb:0.45, durability:100, rarity:'uncommon' },
  armor3:{...tier:3, absorb:0.55, durability:150, rarity:'rare' },
};
export const CONSUMABLES = {   // 使用时长 use（秒），heal/shield 数值
  bandage:{ id:'bandage', name:'绷带', heal:22, use:2.0, stack:8, rarity:'common', price:0, color:0xd8cfa8 },
  medkit:{...heal:75, use:4.0, stack:4},
  energy:{...heal:35, use:1.2, stack:4, haste:1.18, hasteTime:12},
  shield:{...shield:60, use:3.0, stack:3},
};
export const THROWABLES = {
  frag:{ id:'frag', name:'破片手雷', fuse:2.2, radius:8, damage:120, stack:4, rarity:'uncommon' },
  smoke:{...fuse:1.4, radius:7, duration:16, stack:4},
  flash:{...fuse:1.1, radius:10, blind:2.6, stack:3},
  molotov:{...fuse:1.6, radius:6, burn:18/s, duration:9, stack:3},
};
export const BACKPACKS = { bp1:{...}, bp2:{...}, bp3:{...} };  // ammoCap/consumableStack
export const LAND_ATTACHMENT_RARITY = { ... };
```

### 5.3 `shared/data/loot.mjs`
```js
export const LOOT_TABLES = {   // 按 POI tier (1-3) 与 rarity 权重
  tier1: { weapon:[['p9',30],['v9',20],...], ammo:..., consumable:..., armor:..., throwable:..., attachment:... },
  tier2: {...}, tier3: {...},
};
export const RARITY_WEIGHTS = { common:55, uncommon:26, rare:12, epic:5, legendary:2 };  // 可被地图 tier 修正
export function rollRarity(rng, tier) {...}
export function randomWeaponForTier(rng, tier) {...}   // 返回 {id, attachments:[]}
```
生成 loot 的最终逻辑在 `simulation.mjs`，`loot.mjs` 只提供表与工具。

### 5.4 `shared/data/maps.mjs`（Lead 已冻结）
```js
export const MAPS = {
  qinglan: {
    id:'qinglan', name:'青岚岛', subtitle:'海雾中的绿岛', seed:74129,
    radius:180, size:360, theme:{...}, timeOfDay:'day', weather:'clear',
    difficulty:1, description:'...', minPlayers:16,
    regions:[{ id:'town', name:'青岚镇', x:-65, z:-65, tier:3, kind:'town' }, ... 9 个],
  },
  chisha: {...}, baiye: {...}
};
export const MAP_ORDER = ['qinglan','chisha','baiye'];
```
`kind`: `town|village|port|mine|farm|industrial|wild|checkpoint|ruins`。
`tier`: 1-3（物资质量）。

### 5.5 `shared/data/missions.mjs` / `achievements.mjs` / `store.mjs` / `ranks.mjs` / `bots.mjs`
```js
// missions.mjs
export const DAILY_POOL = [{ id:'d_kill10', title:'清除 10 名敌人', metric:'kills', target:10, xp:120, credits:80 }, ...]; // ≥12
export const WEEKLY_POOL = [...]; // ≥8
export const MISSION_METRICS = ['kills','wins','matches','damage','survived','revives','pickups','headshots','vehicles','hordeWaves','placementTop3','accuracyShots'];
// achievements.mjs
export const ACHIEVEMENTS = [{ id:'a_first_win', title:'初次突围', desc:'赢得第一场对局', metric:'wins', target:1, xp:200, credits:150, hidden:false }, ...]; // ≥24
// store.mjs
export const SKINS = [{ id:'skin_default', name:'雾行者', kind:'character', price:0, rarity:'common', colors:{ primary:0xf3b655, secondary:0x2b4a4f, accent:0xffdc8c } }, ...]; // 角色 ≥10, 武器 ≥12
export const STORE_ITEMS = [...]; // 皮肤 + 表情/喷漆
// ranks.mjs
export const RANK_TIERS = [{ id:'bronze', name:'青铜', min:0, color:'#a9794e' }, ... 7 档];
export function rankFor(rating) {...}
export function ratingDelta({placement, totalTeams, kills, damage, won, mode}) {...}
// bots.mjs
export const BOT_NAMES = [...≥40]; export const BOT_TITLES = [...];
export const DIFFICULTIES = { recruit:{...}, veteran:{...}, elite:{...} };  // 参数见 §7
```

## 6. 世界与导航（`shared/map.mjs`，owner: worldgen）

```js
export function makeWorld(mapId) -> World
export const worldCache  // Map<mapId, World>
World = {
  id, def, radius,
  regions: [{ id, name, x, z, tier, kind }],
  buildings: [{ id, x, z, w, d, h, rot, walls:true, roofColor, floorColor, regionId, entrances:[{x,z}] }],
  obstacles: [{ id, x, z, w, d, h, kind:'wall'|'tree'|'rock'|'container'|'crate'|'barrier'|'vehicle', blocksBullets:true, blocksVision:false }],
  props: [{ id, x, z, w, d, h, kind, color }],           // 纯装饰/可挡路小物
  trees: [{ x, z, scale, kind:0|1|2 }],
  roads: [{ x, z, w, d, rot, kind:'asphalt'|'dirt' }],
  waters: [{ x, z, r, w, d }],
  lootSpots: [{ x, z, tier }],
  carSpots: [{ x, z, type, rot }],
  spawnAnchors: [{ x, z }],
  landmarks: [{ kind, x, z, r?, label? }],
  bounds: { minX, maxX, minZ, maxZ },
  nav: { cell, cols, rows, minX, minZ, walkable:Uint8Array, blockedAt(x,z), nearestWalkable(x,z), pathClear(ax,az,bx,bz) },
  blocked(x, z, r=0.55):bool,
  moveBody(body, dx, dz, r=0.55),        // 原地修改 body.x/z，沿轴分步滑墙
  wallDistance(x, z, dx, dz, range):number,   // 射线到墙距离（子弹/视线）
  clearLine(a, b):bool,
  isWater(x, z):bool,
  randomPoint(rng, radius, margin):{x,z},
  regionAt(x, z):region|null
}
```
要求：3 张地图**几何上明显不同**（青岚岛：海岸+城镇+农田+松林+检查站；赤砂矿区：峡谷/矿洞/集装箱堆场/废车场/沙丘；白夜港：港湾/码头/仓库/冰面/灯塔/棚户区）。每张 ≥ 60 栋建筑、≥ 500 障碍、≥ 900 树/装饰，导航网格 4m 单元，生成 < 800ms/图（可缓存）。

## 7. 模拟核心（`shared/simulation.mjs`，owner: simcore）

```js
export class Match {
  constructor({ mapId, seed, mode, duration, maxPlayers, difficulty, humanTeam, objectives })
  // 公开字段（服务端/测试会用）：phase, time, matchTime, players, loot, cars, zone, events, eventId,
  //   winnerTeam, resultReason, mode, mapId, world, rng, humanTeam
  addPlayer(id, name, opts={bot,team,loadout,difficulty}) : player|null
  removePlayer(id)                       // 进房前移除
  start() : bool                         // 补 bot、分配出生点、进入 deploying
  update(dt=1/30)                        // tick
  input(id, rawInput)                    // 校验并记录
  disconnect(id) / reconnect(id)
  snapshot(viewerId=null, sinceEventId=0) : snapshot
  // 测试与调试可用：damage(), kill(), revive(), addLoot(), spawnWave(), end()
}
export const emptyInput = () => ({...});
export function sanitizeInput(raw) : Input;
export { WEAPONS, ITEMS, ... } from data;   // 便于客户端
export const PLAYER_STATE = {...};
```
玩法必需项（验收硬指标）：
1. 移动：走/冲刺(耐力)/蹲/翻滚冲刺（冷却 1.8s）/倒地爬行；地形与载具碰撞；水区减速。
2. 武器：18 把，命中扫描 + 弹道下坠?（不做下坠，做距离衰减与穿墙限制）；霰弹多弹丸；连发/单发/点射；换弹/切枪保留弹匣；配件影响 spread/range/mag/zoom/后坐。
3. 护甲：三档 + 耐久吸收；头盔?（不再单独头盔，合并到护甲 tier）。
4. 消耗品：绷带/医疗包/能量饮料(加速)/护盾电池；使用需静止、被打断。
5. 投掷物：破片/烟雾/闪光/燃烧；真实抛物线、爆炸遮挡、火焰区域持续伤害。
6. 载具：4 种（buggy 4 座快、jeep 4 座带机枪位?（不做机枪位，做撞击伤害）、bike 2 座、truck 6 座慢厚）；上下车、乘客射击、司机接替、爆炸伤及周围；载具受击掉血。
7. 缩圈：5 阶段，含等待/收缩与伤害递增；圈外伤害；圈心随机漂移。
8. 空投：2-3 次，稀有物资；可交互开启。
9. 倒地/救援/淘汰/排名/观战。
10. Bot：调用 `shared/ai.mjs` 的 `thinkBot(match, bot, dt)`，四档难度，行为含搜刮、转移、交战、掩体、救援、用车、投掷、撤圈。
11. 模式：`training`（无限复活? 不：训练=单人对 15 bot，可重开）、`solo`（单排）、`squad`（四排）、`horde`（PvE 波次：固定基地 500HP，10 波，波间 15s 准备，可用信用点买升级；玩家阵亡 8s 后复活，基地被毁结束）。
12. 快照：生产 §3 结构，服务端增量 loot、距离过滤、事件上限 120。
13. 性能：64 人 30Hz，平均 tick < 6ms（Lead 会跑 benchmark 验证）。

## 8. Bot AI（`shared/ai.mjs`，owner: botai）

```js
export function thinkBot(match, bot, dt)   // 设置 bot.input（复用 sanitizeInput 结构）+ bot.ai 内部记忆
export function botProfile(difficulty) -> { reaction, aimError, burst, retarget, coverUse, throwChance, useVehicle, reviveChance }
```
- 禁止读取超出「玩家可见信息」的状态做瞄准（可用 `match.players` 但必须模拟反应延迟与命中误差）。
- 寻路：基于 `world.nav` 网格 A*，带缓存（每 0.6-1.2s 重算），路径点队列；预算化（每 tick 最多 N 个 bot 寻路）。
- 目标状态机：`loot → rotate → engage → cover → revive → retreat → hunt`。
- 必须能在 64 bot 满编时维持 30Hz（每 bot 每 tick < 0.06ms 平均）。

## 9. 成长系统（`shared/progression.mjs` + `client/meta.js`，owner: metacontent）

```js
// 纯函数（shared，可测）
export function xpForLevel(level) -> number            // 升到 level+1 需要
export function levelFromXp(xp) -> { level, current, needed }
export function rankFor(rating) -> { tier, division, name, color, progress }
export function ratingDelta(result) -> number          // result = matchSummary
export function computeRewards(summary, level, missions) -> { xp, credits, missionDone:[{id,xp,credits}], achievementsDone:[...] }
export function dayKey(date) / weekKey(date)
export function pickDaily(dateSeed) -> [missionId x3]
export function pickWeekly(dateSeed) -> [missionId x3]
export function missionProgress(missions, summary) -> {id -> progress}
export function matchSummary(state, selfId) -> summary // 客户端结算用（从 snapshot 生成）
```
`matchSummary`（客户端与服务端都能构造；**由客户端结算存档**，服务端不存账号）：
```js
{ mode, mapId, won, placement, totalTeams, kills, assists, damage, damageTaken, survived,
  shotsFired, shotsHit, revives, downs, pickups, vehiclesUsed, hordeWaves, aliveAtEnd, rating }
```
本地存档（localStorage `mist-isle-save-v1`）：
```js
{ version:1, xp, level, credits, rating, peakRating, stats:{matches,wins,kills,damage,survived,bestPlacement,streak,bestStreak,hordeWaves}, unlocked:{weapons:[],skins:[],modes:[]},
  loadout:{ primary:'ar7', secondary:'p9', attachments:{primary:['red_dot'],secondary:[]}, skin:'skin_default', throwable:'frag', consumable:'medkit' },
  missions:{ day:'2026-10-18', daily:{id->{progress,done,claimed}}, week:'2026-W42', weekly:{...} },
  achievements:{ id->{progress,done,claimed} }, settings:{...}, lastResult: null }
```
`Meta` API（client/meta.js）：
```js
export class Meta {
  constructor(storage = localStorage)
  save, data, level, credits, rating
  addMatchResult(summary) -> { xp, credits, levelUp, newLevel, missionsCompleted, achievementsCompleted, ratingDelta }
  claimMission(id), claimAchievement(id)
  buySkin(skinId) / equipSkin / buyWeapon?（武器按等级解锁，商店只卖皮肤）
  isUnlocked(kind, id)
  setLoadout(loadout), loadout
  refreshMissions(now)
  reset()
}
```

## 10. 客户端架构

`client/main.js`（Lead）负责：启动、App 状态机、渲染循环、把 input/net/scene/ui/audio/meta 组装。**其它模块不许 import main.js**。组装时通过 `init(app)` 注入 `app`。

```js
// app 对象（main.js 创建，传给各模块 init）
app = {
  mode: 'home'|'match',
  offline: bool, paused: bool, suspended: bool,
  phase, state, selfId, me, mapId, modeId,
  settings: { sound, music, quality:'low'|'balanced'|'high', sensitivity, autoFire, joystickScale, showFps, haptics, invertY? },
  meta: Meta 实例,
  scene: GameScene,
  audio: GameAudio,
  fx: null (scene 持有),
  input: InputController,
  net: NetClient|null,
  match: Match|null,      // 离线模拟
  socketInfo: { code, token, host, ping },
  hud: {...},             // ui-hud 私有
  // 方法
  startOffline(modeId, opts), startOnline(opts), leaveMatch(), home(),
  updateHud(), toast(msg), showScreen(id), pauseForMenu(), resumeFromMenu(),
  applySettings(), saveSettings(), onSnapshot(state), emit/on(event, cb)  // 简单事件总线
}
window.mistIsle = { getState, getStatus, getMeta }   // 只读诊断，e2e 用
```

### 10.1 场景（`client/scene.js`）
```js
export class GameScene {
  constructor(canvas)                      // 建 renderer/scene/lights，调用 models/fx
  setQuality(q)                            // low|balanced|high
  showHome()                               // 主菜单英雄场景（可旋转岛屿）
  setMap(mapId)                            // 重建静态世界（缓存！不要每局重建纹理/几何体）
  beginMatch(config)                       // 清实体、设置相机
  setState(snapshot, selfId)               // 每帧调用（10Hz 数据，内部插值）
  render(dt, elapsed)
  aimAt(screenX, screenY, self) -> angle   // 桌面鼠标世界坐标
  groundAt(screenX, screenY) -> {x,z}
  predictInput(input, dt)                  // 本地预测
  shake(amount) / hitmarker()
  dispose()
}
```
- 相机：跟随 + 轻微前瞻 + 缩圈/击杀时抖动（可关）；桌面可滚轮拉远。
- 遮挡：玩家在建筑内时屋顶淡出；对手在视野外不渲染；距离 > 90 的实体剔除。
- 渲染预算：InstancedMesh 批量静态物；角色 ≤ 30 个可见；draw calls < 220。
- 必须暴露 `renderer.info` 供诊断。

### 10.2 特效（`client/fx.js`）
```js
export class Fx {
  constructor(scene3d)
  spawn(kind, data)   // 'muzzle','tracer','impact','blood','explosion','smoke','fire','flash','shell','heal','pickup','levelup','shield','repair','wave','boss'
  update(dt)
  clear()
}
```

### 10.3 模型（`client/models.js`）
```js
export function createCharacter({ colors, team, isSelf }) -> {
  group, parts:{ body, head, torso, armL, armR, legL, legR, gun, muzzle, chute, shadow, backpack, labelAnchor },
  setWeapon(weaponId), playRecoil(), setPose('normal'|'crouch'|'downed'|'sprint')
}
export function createVehicle(type, color) -> { group, wheels:[...], parts:{...} }
export function createLootModel(type, itemId, rarity) -> { group, glow }
export function createTree(tree, theme) / createBuilding(building, theme) / createProp(prop, theme)
export function createAirdrop(), createCrate(rarity), createPingMarker(kind), createTextSprite(text, color, size)
export function disposeModel(object3d)
```
模型要求：低多边形但有辨识度（角色有四肢摆动、武器按类别不同轮廓、4 种载具明显不同、建筑有屋顶/门窗/招牌）。全部共享几何体/材质缓存，禁止每实例 new material。

### 10.4 UI 模块
```js
// client/ui-hud.js
export function initHud(app)
export function updateHud(app, state, dt)   // 每帧调用，内部节流
export function showHud(visible)
export function hudKillfeed(event) / hudToast(app, msg)
export function drawMinimap(canvas, state, me)   // 也提供大图 drawFullMap
export function setHudScale(scale)

// client/ui-screens.js
export function initScreens(app)
export function openScreen(name)   // 'home'|'play'|'loadout'|'store'|'missions'|'codex'|'career'|'settings'
export function closeScreens()
export function toast(message, ms)
export function showOnlineDialog() / hideOnlineDialog()
export function showRoom(lobby) / updateLobby(lobby) / hideRoom()
export function showResult(summary) / hideResult()
export function showPause() / hidePause()
export function refreshAll()        // 存档变化后刷新（等级/货币/任务红点）
export function openCodexDetail(kind, id)
```

### 10.5 输入（`client/input.js`）
```js
export class InputController {
  constructor(canvas, app)
  update(dt) -> Input          // 与 shared sanitizeInput 同构 + 额外 ui 字段
  clear()
  setSensitivity(v) / setJoystickScale(v)
  destroy()
}
```
必须支持：桌面（WASD/Shift/Ctrl/Space/鼠标左右键/R/E/Q/1/2/F/G/H/Tab/M/Esc/滚轮）、触屏（左摇杆移动、右摇杆瞄准+自动开火、冲刺/蹲/翻滚/换弹/治疗/投掷/交互/切枪/背包按钮、双指?、摇杆动态位置）、失焦清空、震动反馈（`navigator.vibrate`）。

### 10.6 音频（`client/audio.js`）
```js
export class GameAudio {
  init(app) / unlock()
  play(name, opts)   // 'shot:rifle','reload','pickup','heal','explosion','hit','down','revive','click','levelup','wave','wind','rain'
  setMusic(mode)     // 'home'|'battle'|'tense'|'result'|'horde'|'off'
  setVolume({sfx, music}) / suspend() / resume()
}
```
全部用 WebAudio 合成（振荡器/噪声/滤波/混响），要有：枪声按武器类别区分、距离衰减、混音限流。

## 11. DOM 契约（重要：UI 由 JS 动态构建）

`client/index.html` 只包含最小外壳 + 两个根容器。**所有界面与 HUD 的 DOM 由 `ui-screens.js` / `ui-hud.js` 在运行时创建**，`design` 负责 `style.css` 里对应的类名样式。

外壳 HTML 结构（Lead 维护，`design` 可微调但必须保留这些 id）：
```html
<body>
  <canvas id="world"></canvas>          <!-- 3D 场景，始终存在 -->
  <div id="boot">…启动画面/LOGO/进度…</div>
  <div id="screen-root"></div>           <!-- 局外界面全部由 JS 注入 -->
  <div id="hud" class="hidden"></div>    <!-- 局内 HUD 全部由 JS 注入 -->
  <div id="dialog-root"></div>           <!-- 弹窗（联机/房间/暂停/结算/图鉴详情） -->
  <div id="toast-root"></div>
  <div id="fx-overlay"></div>            <!-- 全屏滤镜：受伤、闪光、黑白 -->
  <div id="rotate-hint">…</div>
</body>
```
- `ui-screens.js` 必须自行创建/维护 `#screen-root` 内的各个屏幕（`.screen` 根节点，`data-screen="home|play|loadout|store|missions|codex|career|settings"`），以及 `#dialog-root` 内的弹窗。
- `ui-hud.js` 必须自行创建 `#hud` 内所有元素（血条/弹药/小地图 canvas/小队面板/击杀播报/摇杆/按钮…）。
- 两个模块都通过 `const $ = (sel, root=document) => root.querySelector(sel)` 自取；不得依赖页面里预先存在的 HUD 节点（`#world`、`#hud`、`#screen-root`、`#dialog-root`、`#toast-root`、`#fx-overlay` 除外）。
- 所有可点击元素必须有稳定 id：局外用 `id="nav-<screen>"`、`id="btn-<action>"`；局内用契约 §10.4 列出的 id（`heal-action`、`reload-action`、`interact-action`、`throw-action`、`swap-action`、`sprint-action`、`crouch-action`、`dodge-action`、`move-stick`、`aim-stick`、`game-menu`、`minimap` 等）。qa 的 e2e 依赖这些 id。
- 统一 class（design 必须提供样式）：`.screen` `.screen.active` `.panel` `.card` `.btn` `.btn-primary` `.btn-ghost` `.btn-danger` `.icon-btn` `.chip` `.chip.active` `.stat` `.list-row` `.rarity-common/uncommon/rare/epic/legendary` `.progress` `.progress>i` `.hud-panel` `.touch-btn` `.joystick` `.hidden` `.muted` `.eyebrow` `.title-xl` `.divider` `.badge` `.toggle` `.modal` `.modal.open` `.modal-backdrop` `.tab` `.tab.active` `.toast` `.toast.show`。
- 移动端：所有交互元素最小点击区 44px；`user-select:none`；禁用长按菜单与双击缩放。横屏设计，`safe-area-inset-*` 适配刘海屏。
- e2e 关键测试钩子（必须存在）：`#boot.hidden`（启动完成）、`#screen-root .screen[data-screen="home"]`、`#nav-play`、`#btn-offline`、`#btn-online`、`#online-dialog[open]`、`#room-dialog[open]`、`#result-dialog[open]`、`#pause-dialog[open]`、`#toast-root`、`#hud:not(.hidden)`、`#move-stick`、`#aim-stick`、`#game-menu`、`#heal-action`、`#reload-action`、`#interact-action`。

## 12. 测试与验收

- `node --test tests/*.test.mjs` 必须全绿（Lead 统一跑）。
- 各 owner 至少为自己模块写测试：`world.test.mjs`（碰撞/射线/导航/三图生成时间）、`simulation.test.mjs`（§7 每条玩法）、`ai.test.mjs`（bot 会交战/撤圈/救援、性能预算）、`server.test.mjs`（协议/重连/房间/限速/开始同步）、`progression.test.mjs`（经验/段位/任务/奖励）。
- `npm run test:e2e` 由 `qa` 负责维护（Playwright 桌面 + 手机横屏 + 四客户端同队 + 断线重连 + 多模式）。
- 手工验收见 `docs/ACCEPTANCE.md`；所有截图输出到 `artifacts/`。

## 13. 协作规则

1. 开工先 `read` 本文件与你负责的所有相关文件；不确定就发消息给 Lead。
2. 只改自己 owner 的文件；需要改别人的：给 Lead 发消息说明原因与建议。
3. 完成一个里程碑（文件可导入、测试通过）就发消息给 Lead：`[done] 文件 + 测试命令 + 关键接口`。
4. 发现契约缺陷：消息里写「契约变更请求：字段 X 改为 Y，原因 Z」，等 Lead 确认。
5. 不要运行 `npm run android`、不要 `npm run build`（Lead 统一），除非 Lead 明确要求。
6. 不要启动长期服务器端口（除临时测试随机端口）。
7. 不要删除别人的文件；不要 `git` 操作。
