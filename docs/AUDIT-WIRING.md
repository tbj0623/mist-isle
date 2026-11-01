# 接线审计（1.3.0 · 2026-10-29）

> 只读审计。范围：`client/` 模块接线、settings 消费方、事件总线、HUD 元素、服务端协议字段。
> 判定口径：注释已剔除（`//`、`/* */`）。被 `tests/`、`scripts/`、`window.mistIsle` 引用的算「测试/工具专用」，不计死代码。
>
> ⚠ 审计期间 `client/main.js` 被并发修改两次（17:34 / 17:36）。本报告以**当前磁盘状态**为准（md5 `6aa34903...`，1150 行）。
> 已被修复的 5 项在 §2 用 ~~删除线~~ 标注，保留记录以免下次重复审计。

## 结论摘要

- **真实死代码 8 处**（导出零消费、且无测试/工具/诊断引用）
- **半接线 12 处**（有消费者，但主流程缺一步，用户可见结果缺失）
- **配置项无消费方 3 处**（`hint`、`invertY`、`screenShake` 定义但无人写/无人读）
- 另有 **emit 无订阅 8 个事件**、**订阅无 emit 3 个事件**、**HUD 只写不读 ref 15 个**

最值得修的 6 项（按影响排序）：

1. `client/season.js:176` + `:236` + `:315` + `:387` 领奖/签到/总览 API 无 UI —— `claimTier`/`claimDailyLogin`/`claimChallenge`/`seasonStatus` 客户端零调用（仅测试引用），玩家升级、签到、完成周挑战后**永远领不到奖励**。（`challengeProgress`/`missionProgress` 的推进已于 17:34 补上，见 §2）
2. `client/telemetry.js:145-221` 自动埋点 8 个方法零调用 —— `openScreen`/`leaveScreen`/`finishMatch`/`weaponFire`/`weaponKill`/`death`/`purchase`/`missionClaim`/`end` 全项目无调用点；`client/main.js:732` 用裸 `track('match_end')` 重写，`funnel('result')` 永不触发；无 `pagehide` → `session_end` 永不发
3. `client/ui-hud.js:480,532` `R.chatLog` 建了从不写入 —— 局内聊天历史区永远空白；`hudChat` 另建 `#hud-chat` 容器（`client/ui-hud.js:2032`），两套聊天 DOM 并存
4. `client/social.js:98-109` 好友列表/战队/表情 9 个 API 无 UI 入口 —— `listFriends`/`listInvites`/`createClan`/`joinClan`/`leaveClan`/`clanInfo`/`emote`/`updateProfile` 零调用，服务端 `server/social.mjs:386-465` 的战队与表情能力完全不可达
5. `client/feel.js:403` `slowmoFx()` 零调用 —— `showSlowmoRings()`（`client/ui-feedback.js:220`）全项目不可达，慢动作只有 DT 缩放、没有径向线视觉
6. `client/net.js` 无 `spectate()` —— 服务端 `server/session.mjs:130` 的观战协议客户端从不发，`client/main.js` 也无 `case 'spectating'`；观战模式整体不可达

## 1. 无消费者的导出

| 文件:行 | 导出 | 判定 | 建议 |
| --- | --- | --- | --- |
| `client/ui-feedback.js:273` | `resetFeedbackLayer()` | 死代码 | 在 `leaveMatch()` 里调用，防止跨局残留 |
| `client/ui-feedback.js:285` | `destroyFeedbackLayer()` | 死代码 | 同上；或删除 |
| `client/ui-hud.js:1954` | `isHudVisible()` | 死代码 | 删除，或接进 `mistIsle.getStatus` |
| `client/ui-hud.js:1955` | `toggleScores()` | 死代码（Tab 键已走内部 `toggleScoreboard`） | 删除 |
| `client/ui-hud.js:1956` | `getHudRefs()` | 死代码（仅 `scripts/archive/_hud-events.mjs:24` 用旧名 `app.hudRefs`） | 删除或导出到诊断接口 |
| `client/ui-hud.js:2010` | `hudSetTouch(show)` | 死代码 | 删除；`app.touch` 已可控制 |
| `client/ui-hud.js:2016` | `showHit(kind)` | 死代码（`hudHit` 才是 main 的入口） | 删除 |
| `client/ui-hud.js:2017` | `hudBanner(...)` | 死代码（内部走 `pushBanner`） | 删除 |

补充（**不算死代码**，但存在重复实现）：

- `client/telemetry.js:17` `TELEMETRY_VERSION` — 导出但全项目零引用（含测试）。
- `client/telemetry.js:231-245` `getQueue`/`sampleCount`/`offlinePending` — 仅 `getQueue` 被 `tests/telemetry.test.mjs:75` 用（测的是 `shared/telemetry.mjs` 的类）；`sampleCount`/`offlinePending` 零引用。
- `client/stats.js:248` `recentMatches()` / `:258` `trend()` — 零调用；UI 侧用的是自己模块的 `recentMatches` 数组（`client/ui-screens.js:23`），不是 career 的方法。
- `client/feel.js:16` `feelNoise()` — 仅 `scripts/feel-check.mjs` 经 `window.__mistFeel` 间接覆盖，工具专用。
- `client/audio.js:1514` 二次导出的 `cutoffAt`/`gainAt`/`SPATIAL`/`VoicePool`/`SpatialRig` — 内部已用（`client/audio.js:537-539`），非死代码。

## 2. 半接线（有消费者但主流程未调用）

| 文件:行 | 能力 | 缺哪一步 | 用户可见影响 | 建议 |
| --- | --- | --- | --- | --- |
| `client/season.js:176` | `claimTier` 档位领奖 | 无 UI 调用 | 升级后奖励永远拿不到，`claimedFree` 恒空 | 加通行证页或结算页「领取」 |
| `client/season.js:259` | `claimDailyLogin` 每日登录 | 无 UI 调用（`loginView`/`checkDailyLogin` 也零调用） | 签到与连击奖励不可得 | 首页加签到入口 |
| `client/season.js:315` | `claimChallenge` 周挑战领奖 | 无 UI 调用 | 周挑战进度会涨（已修）但永远不能领 | 任务页加赛季页签 |
| `client/season.js:369` | `claimMission` 赛季主线领奖 | UI 端 `client/ui-screens.js:1738` 调的是 `meta.claimMission`（日/周任务），不是 season 的 | 赛季主线无法领取 | 合并入口或加独立页签 |
| `client/season.js:387` | `seasonStatus` 赛季总览 | 无 UI 渲染 | 只能从结算条看到 `+XP`（`client/ui-screens.js:3534`） | 加赛季页 |
| `client/telemetry.js:145` | `openScreen`/`leaveScreen`/`dialog` | main.js 未接（`docs/TELEMETRY-WIRING.md` §3 方案 A/B 都没落地） | 无 `screen_open`/`screen_leave`，留存漏斗断裂 | 在 `ui-screens.openScreen` 补一行 |
| `client/telemetry.js:172` | `finishMatch` 结算埋点 | main.js 改用裸 `track('match_end')`（`client/main.js:732`） | 漏斗缺 `result` 步 | 改调 `finishMatch(summary)` |
| `client/telemetry.js:190-211` | `weaponFire`/`weaponKill`/`death`/`purchase`/`missionClaim` | 全项目零调用 | 武器/死亡/商店分析维度全空 | 至少接 `weaponKill`+`death` |
| `client/telemetry.js:214` | `end()` 会话结束 | 无 `pagehide`/`beforeunload`（`client/audio.js:315` 只挂了音频 suspend） | `session_end` 永不发，时长统计缺失 | 在 boot 里挂 `pagehide` |
| `client/feel.js:403` | `slowmoFx` 慢动作径向线 | 零调用；`showSlowmoRings` 唯一入口（`client/feel.js:404`） | 慢动作只有 DT 缩放，无径向线视觉 | 在 `onKill` 多杀分支调用 |
| `client/social.js:98` | `listFriends` 好友列表 | `registerSocialHooks` 只订阅事件，从不主动拉 | 首次打开面板为空，需重连才有数据 | `open()` 时调一次 |
| `client/social.js:101-109` | `updateProfile`/`listInvites`/`createClan`/`joinClan`/`leaveClan`/`clanInfo`/`emote` | 无任何 UI 入口 | 服务端 `server/social.mjs:386` 表情广播、`:440-465` 战队全部不可达 | 至少补 `emote` 到触屏轮盘 |
| `client/stats.js:248` | `recentMatches` 最近战绩 | UI 用自有数组（`client/ui-screens.js:23`） | 重启后战绩列表丢失（只剩 `lastResult` 一条） | 改读 `app.career.recentMatches()` |
| `client/stats.js:258` | `trend` 走势曲线 | 无 UI | 无趋势图 | 低优先级 |
| `client/net.js:259` | `requestRooms` 房间列表 | 零调用；`NetClient` 构造也没传 `onRooms`（`client/main.js:314-318`） | 服务端 `{type:'rooms'}` 永远不被请求，`app.emit('rooms')` 永不触发 | 补调用或删 |
| `client/net.js:252` | `sendNow` 绕过节流 | 零调用 | 无（`sendInput` 已覆盖） | 删除 |
| `client/net.js`（缺方法） | 观战协议 | 服务端 `server/session.mjs:130` 有 `spectate`，客户端从不发；`client/main.js` 无 `case 'spectating'` | 观战模式完全不可达；`R.spectate` 只是「你已淘汰」横幅 | 补 `NetClient.spectate()` + 客户端 case |
| `client/killcam.js:38` | `play` 死亡回放 | 有消费者（`client/main.js:496`），但离线对局不产生 `killcam` 消息（只有 `server/index.mjs:622` 单播） | **离线模式永远看不到回放** | 离线也本地构造 `aroundDeath` |
| `client/audio.js:1157` | `setTension` 音乐张力 | 零调用（只有 `scripts/audio-check.mjs:363` 用） | `tension`/`climax` 轨永不发声（`client/audio-music.js:28-34`） | 按血量/剩余人数驱动 |
| ~~`client/feel.js:287` `onPickup`~~ | 拾取反馈 | **已修** `client/main.js:652` | — | — |
| ~~`client/feel.js:299` `onReload`~~ | 换弹反馈 | **已修** `client/main.js:663` | — | — |
| ~~`client/feel.js:305` `onHealDone`~~ | 治疗完成脉冲 | **已修** `client/main.js:659`（新增 `case 'healed'`，服务端确有该事件 `shared/simulation.mjs:1417`） | — | — |
| ~~`client/season.js:292` `challengeProgress`~~ | 周挑战推进 | **已修** `client/main.js:718` | — | — |
| ~~`client/season.js:342` `missionProgress`~~ | 主线推进 | **已修** `client/main.js:719` | — | — |
| ~~`client/social.js:111` `reset()`~~ | 断线清空在途请求 | **已修** `client/main.js:353`（`closeNet` 内） | — | — |

## 3. 设置项无消费方

> 定义点两处：`client/main.js:35-39` 与 `shared/progression.mjs:20-25`（`Meta` 层 schema）。

| key | 定义位置 | 结论 |
| --- | --- | --- |
| `hint` | `client/main.js:38` | **无消费方**。只被 `client/main.js:813` 写回 1，全项目无读取点。建议删除或接到引导层 |
| `invertY` | `shared/progression.mjs:22` | **死键**。设置页无开关（`client/ui-screens.js` grep 为 0），`client/input.js` 不读，但 `docs/CONTRACTS.md:507` 把它写成可选契约字段 |
| `screenShake` | 无默认值（只在 `client/feel.js:59` 读） | **半接**：消费方存在，但无 UI 写入、`DEFAULT_SETTINGS` 也没这个键 → 恒 `undefined` → 恒为 1 |
| `hudScale` | 无默认值（UI 读 `s.hudScale ?? 1`，`client/ui-screens.js:2318`） | **半接**：能写能读，但不在 `DEFAULT_SETTINGS`，`loadSettings()` 的白名单（`client/main.js:103`）会丢弃它，只有走 `mergeStoredSettings` 路径才保留 |
| `tutorialDone` | `client/main.js:38` | 有消费（`client/ui-screens.js:4512`），正常 |
| `sound`/`sfx`/`music`/`quality`/`sensitivity`/`joystickScale`/`autoFire`/`haptics`/`showFps`/`leftHanded`/`reducedMotion`/`telemetry` | `client/main.js:36-37` | 均有消费（`client/main.js:149-167`、`client/input.js:85-87,541`、`client/ui-hud.js:1274,1910`） |

## 4. 事件对账

> 总线：`client/main.js:42-57`（`Bus`），`app.on/emit` 在 `client/main.js:177-178`。
> 全项目唯一的 `app.on` 订阅点是 `client/ui-screens.js:4037`（`bindGlobal` 的 `refreshers`，`client/ui-screens.js:4035`）。**无任何 `app.once`。**

### emit 无订阅

| 事件 | emit 位置 | 说明 |
| --- | --- | --- |
| `net:reconnecting` | `client/main.js:380` | 无订阅（UI 已由 toast 覆盖） |
| `net:resumed` | `client/main.js:385` | 无订阅 |
| `chat` | `client/main.js:460` | 无订阅（`hudChat` 已直接调用） |
| `rooms` | `client/main.js:482` | 无订阅，且源头 `requestRooms` 从不发（见 §2） |
| `match:start` | `client/main.js:535` | 无订阅 |
| `match:leave` | `client/main.js:776` | 无订阅 |
| `onboarding:shown` | `client/main.js:968` | 无订阅 |
| `hud:pause` / `hud:fullmap` / `input:useItem` | `client/ui-hud.js:734,757`（`emit` 辅助） | 生产无订阅；仅 `scripts/ui-check.mjs:229` 手动 emit `hud:pause` 测试 |

### 订阅无 emit

| 事件 | 订阅位置 | 说明 |
| --- | --- | --- |
| `reward` | `client/ui-screens.js:4035` | 全项目无 `emit('reward')` |
| `levelup` | `client/ui-screens.js:4035` | 全项目无 `emit('levelup')`（`levelup` 只作 sfx 名与快照事件类型存在） |
| `room` | `client/ui-screens.js:4035` | 全项目无 `emit('room')`（房间走 `lobby`） |

有订阅也有 emit（正常）：`meta:changed`、`lobby`、`joined`、`online:error`、`settings`、`match:end`。

## 5. HUD 元素对账

`client/ui-hud.js` 中 `R.xxx = ...` 赋值但**从不被读取**（脚本扫描，已剔注释）共 15 个：

| 文件:行 | ref | 创建的东西 | 结论 |
| --- | --- | --- | --- |
| `client/ui-hud.js:186` | `R.top` | 顶栏容器 | 只写不读；样式走 `#hud .hud-top`，无功能影响 |
| `client/ui-hud.js:195` | `R.weather` | 天气胶囊 | 只写不读（`R.weatherText`/`R.weatherIcon` 有更新，`:1263`） |
| `client/ui-hud.js:199` | `R.pause` | 暂停按钮 | 只写不读，但 click 已绑定（`:201`），非缺陷 |
| `client/ui-hud.js:247` | `R.minimapMeta` | 小地图底栏 | 只写不读（`R.mapName`/`R.net` 有更新） |
| `client/ui-hud.js:263` | `R.squadPanel` | 小队面板 | 只写不读（`R.squadList`/`R.squadRows` 有更新） |
| `client/ui-hud.js:310-313` | `R.hpTrack`/`R.armorTrack`/`R.shieldTrack`/`R.staminaTrack` | 4 条血条轨道 | 只写不读；更新的是 `*Bar`（`:1289-1292`） |
| `client/ui-hud.js:315` | `R.consumables` | 消耗品行容器 | 只写不读；更新的是 `R.consumableButtons`（`:1317`） |
| `client/ui-hud.js:532` | `R.chatLog` | 局内聊天历史 | **真空洞**：从不 append 任何行，聊天面板永远空白 |
| `client/ui-hud.js:593-596` | `R.moveStick`/`R.moveStickInner`/`R.aimStick`/`R.aimStickInner` | 摇杆 DOM | 只写不读；拖动由 `bindJoystick` 闭包持有，功能正常 |

**创建后从不显示的元素**：

- `client/ui-hud.js:480` `chat-log` — 见上（`R.chatLog` 永不写入）
- `client/ui-hud.js:787` `horde` 面板 — 有 `toggle(R.horde,'hidden',!horde)`（`:1579`），只在有 `state.horde` 时显示，正常
- `client/ui-hud.js:799` `spectate-bar` — 由 `:2005` 控制；客户端从不发 `spectate`，所以只在「本局已淘汰」时显示，语义正确

**从不更新（创建后无写入路径）**：无。所有 `hidden` 元素都至少有 1 处 `toggle`/`classList` 控制。

## 6. 协议字段对账

`docs/CONTRACTS.md:188-231`（§4）列出的消息 vs `server/index.mjs:498-515` 的 `switch`：

| 契约消息 | 服务端处理 | 结论 |
| --- | --- | --- |
| `join`/`leave`/`ready`/`start`/`rematch`/`chat`/`input`/`config`/`team`/`dropvote`/`spectate`/`ping`/`rooms` | ✅ `server/index.mjs:465-515` | 一致 |
| `kick` | ✅ `server/index.mjs:507` | 契约 §4 **未列出**；客户端无发送点 → 房主踢人不可达（`server/actions.mjs:75`） |
| `team` | ✅ `server/index.mjs:509` | 契约 §4 **未列出**；客户端无发送点 → 换队不可达（`server/actions.mjs:133`） |
| `metrics` | ❌ 无 case → 落 `default` 回 `UNKNOWN_TYPE` | `server/index.mjs:29` 的 `MESSAGE_TYPES` 列了它，但**该常量全文件只出现 1 次、从未被使用**；HTTP 侧 `/metrics` 存在（`:349`），WS 侧无 |
| `pong` | ❌ 无 case | 契约 §4 只把 `pong` 写成**服务端→客户端**，此处 `MESSAGE_TYPES` 误列，无实际影响 |
| `binary:true`（join 字段） | ✅ `server/session.mjs` 的 `applyBinary` | 一致 |
| `deployStyle`（config 字段） | ✅ `server/actions.mjs:106` | 一致 |
| 服务端→客户端 `spectating` | ⚠️ 服务端发（`server/session.mjs:145`），客户端 `handleNetMessage` **无 case**，`client/net.js:141` 只用于二进制协商 | 契约 §4.0 第 3 条把 `spectating` 当回执，但客户端不消费 id/token → 观战半接 |
| 服务端→客户端 `killcam` | ⚠️ `server/index.mjs:623` 单播，契约 §4 **未列出** | 客户端有 case（`client/main.js:494`），契约缺项 |
| 服务端→客户端 `roster` | ✅ `client/net.js:146` 内部消费，不上抛 | 一致 |

**契约写了但服务端不处理**：`metrics`（唯一一项；且它是「客户端→服务端」方向被 `MESSAGE_TYPES` 误列，契约正文里其实并没有）。

## 7. 判定为「有意为之」的清单（避免下次重复审计）

1. **`client/audio.js:1514` 二次导出**（`cutoffAt`/`gainAt`/`SPATIAL`/`VoicePool`/`SpatialRig`）— 内部已在用（`:537-539`），导出是给 `scripts/audio-check.mjs` 做 A/B 的。
2. **`client/ui-hud.js:1716` `hudKillfeed`** — 外部零调用，但内部有 3 个调用点（`:1618,1627,1652`），是模块内部 API。
3. **`client/ui-hud.js:858-887` `showFullMap`/`hideFullMap`/`isFullMapOpen`/`drawMinimap`/`drawFullMap`** — `draw*` 只被 `tests/ui-static.test.mjs:148` 断言存在；`show/hide/isFullMap` 在 `app.ui`（`client/main.js:185-187`）与内部 M 键都有入口。
4. **`client/feel.js:16` `feelNoise`** — 只被 `scripts/feel-check.mjs` 经 `window.__mistFeel` 覆盖，工具专用。
5. **`client/season.js:21` `dayGap` / `:34` `emptySeasonData`** — 仅 `tests/season.test.mjs:180,186` 引用，纯数据辅助函数。
6. **`client/season.js:137` `paidTrack`** — 被 `addMatchXp`（`:165`）与 `claimableTiers`（`:200`）内部消费。
7. **`client/season.js:330` `missionEntry` / `:337` `chapterOpen`** — 被 `missionProgress` 内部调用。
8. **`client/mastery.js:253` `unlockedAttachments`** — 被 `client/ui-screens.js:962` 真实消费（装备页过滤配件），是 1.3.0 的正向接线样本。
9. **`client/mastery.js:222` `get` / `:246` `describe`** — 零生产调用（仅 `tests/mastery.test.mjs` 与 `scripts/archive/_ui-integration.mjs:84`），属对外 API 表面，标「测试专用」。
10. **`client/telemetry.js:276` `createTelemetry` 返回 `null`** — 设计如此（默认关闭连对象都不建，`:279`），`app.telemetry?.x?.()` 的可选链是刻意的。
11. **离线模式没有 `killcam`** — 服务端才录 `ReplayRecorder`（`shared/replay.mjs`），离线无此消息源；标为「已知缺口」而非 bug，除非产品要求离线也回放。
12. **`client/main.js:732` 用裸 `track('match_end')` 而非 `finishMatch`** — 字段等价但缺 `funnel('result')`；属「有意重写但漏了一步」。
13. **`client/ui-hud.js:1935-1936` `showHud(false)` 清空 feed/toast** — 生命周期正确，不是「建了不用」。
14. **`client/social.js:86-95` 的社交事件 emit**（`friends`/`invites`/`clan`/`profile`/`invite`/`presence`/`invite:result`/`message`）— `presence`/`invite:result`/`message`/`profile` 无订阅者，但属社交层公开事件面，不是 `app` 总线事件。
15. **`client/net.js:146` roster 不上抛** — 刻意在 net 内消费（构建 wire 上下文），上层无需感知。
