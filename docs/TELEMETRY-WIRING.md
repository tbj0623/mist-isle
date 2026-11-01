# 遥测接线指南（给 Lead）

> `client/main.js` 归 Lead 所有，本文件只提供**可直接粘贴**的接线代码。
> 遥测模块已全部就绪并自测通过（14 项单测 + 全链路模拟）。

## 0. 前置状态（已完成，无需再改）

| 项 | 状态 |
| --- | --- |
| `shared/telemetry.mjs` | ✅ 事件字典 / Telemetry 类 / sanitize / aggregate / analyzeMatches |
| `server/telemetry.mjs` | ✅ POST /telemetry、/analytics/{summary,funnel,weapons}、流式读取 |
| `server/http.mjs` | ✅ 已加 3 行 handler 转发（`ctx.telemetry`） |
| `server/index.mjs` | ✅ 已创建服务并传入 ctx（`telemetryOptions` 可注入） |
| `client/telemetry.js` | ✅ TelemetryClient（默认关闭、离线缓冲、1/20 采样） |
| `shared/progression.mjs` | ✅ `DEFAULT_SETTINGS.telemetry = false`（默认关闭） |
| 设置页开关 | ❌ **需要 Lead 加**（`client/ui-screens.js` 是只读文件） |
| main.js 埋点 | ❌ **需要 Lead 接**（见下） |

## 1. import（main.js 顶部，import 区块内任意位置）

```js
import { TelemetryClient } from './telemetry.js';
```

## 2. boot()：创建 + 会话开始（`function boot() {` 第 1 行之后）

```js
  // 遥测：仅当玩家在设置页主动开启（默认 false）才创建；关闭时连对象都不建。
  if (app.settings?.telemetry === true) {
    app.telemetry = new TelemetryClient(app, { enabled: true });
    app.telemetry.boot({ version: VERSION, quality: app.settings.quality });
    app.telemetry.funnel('boot', true);
    app.telemetry.funnel('home', true);
  }
```

## 3. 界面停留：screen_open / screen_leave（boot() 末尾、`UI.openScreen('home')` 之前）

`UI.openScreen` 是 ES module 导出，**不能重新赋值**（严格模式下 assign 会抛 TypeError）。
推荐二选一：

**方案 A（推荐，需改 ui-screens.js 约 3 行）**——在 `client/ui-screens.js` 的
`export function openScreen(name)` 里加：

```js
export function openScreen(name) {
  if (!screens.has(name)) return;
  setActiveScreen(name);
  screens.get(name)?.render?.();
  refreshChrome();
  try { app?.telemetry?.openScreen?.(name, app?.currentScreen || 'boot'); } catch { /* 遥测不影响 UI */ }
  if (app) app.currentScreen = name;
}
```

**方案 B（完全不改 ui-screens.js，用 DOM 观察兜底）**——加在 boot() 末尾：

```js
  // 兜底：ui-screens 每次开屏都会把 #screen-root 的 data-active 改成新界面名。
  try {
    const root = document.getElementById('screen-root');
    new MutationObserver(() => {
      const name = root?.dataset?.active || '';
      if (name && name !== app.currentScreen) {
        app.telemetry?.openScreen(name, app.currentScreen || 'boot');
        app.currentScreen = name;
      }
    }).observe(root, { attributes: true, attributeFilter: ['data-active'] });
  } catch { /* 忽略 */ }
```

> 方案 B 的停留时长精度取决于 observer 回调时机（实际够用，误差 <1 帧）。

## 4. 对局开始（`enterMatch()` 内 `app.emit('match:start', …)` 之后）

```js
  app.telemetry?.startMatch({
    mode: app.modeId, mapId: app.mapId, difficulty: app.difficulty, offline: !!app.offline,
  });
  app.telemetry?.funnel('live', true);
```

同时把部署点算作漏斗一步（`app.startOffline` / `app.startOnline` 进入房间时）：

```js
  app.telemetry?.funnel('deploy', true);   // 成功进入部署/加载
  app.telemetry?.funnel('play', true);     // 从大厅点了「开始」
```

## 5. 对局结算（`finishMatch(state)` 内 `app.emit('match:end', …)` 之后）

```js
  try { app.telemetry?.finishMatch(summary); } catch { /* 遥测失败不影响结算 */ }
```

`summary` 就是现成的 `matchSummaryFromState(...)` 返回值，字段完全对得上
（mode/mapId/placement/kills/damage/survived/won）。

## 6. 战斗与击杀（`processEvents()` 的 `case 'shot':` 和 `case 'kill':`）

```js
      // case 'shot': 末尾（开火，客户端内部已做 1/20 采样）
      if (ev.player === app.selfId) app.telemetry?.weaponFire(ev.weapon || 'unknown', ev.dist || 0);

      // case 'kill': 新增（击杀）
      if (ev.by === app.selfId) app.telemetry?.weaponKill(ev.weapon || 'unknown', ev.dist || 0, !!ev.headshot);
      else if (ev.player === app.selfId) app.telemetry?.death(ev.weapon || 'unknown', ev.dist || 0, !!ev.headshot);
```

> 现行 `simulation` 的 kill 事件字段是 `{player, by, reason, team, x, z, name}`，不含
> weapon/dist/headshot。若 Lead 愿意给 kill 事件补 `weapon`/`dist`/`headshot` 三个字段
> （simulation.mjs 冻结，需 Lead 决策），平衡数据会自动变准；不补也能跑，只是这三项为
> 默认值（`unknown` / 0 / false），报表里会归到 unknown 桶。

## 7. 经济与任务（购买成功、领取任务奖励处）

```js
  app.telemetry?.purchase(itemId, price, 'credits');
  app.telemetry?.missionClaim(missionId, xp);
```

## 8. 页面卸载 / 回首页 / 切前后台

```js
  // 页面隐藏或卸载时，把队列发完（keepalive 保证被杀的页面也能送达）
  window.addEventListener('pagehide', () => { try { app.telemetry?.end(); } catch { /* 忽略 */ } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) app.telemetry?.flush('hidden'); });
```

`app.leaveMatch()` 内加一行 `app.telemetry?.leaveScreen();`。

## 9. 设置页开关（`client/ui-screens.js` 的 `buildSettings()`）

在「引导与存档」面板里加一行（需要 Lead 改该文件，约 8 行）：

```js
  const telemetryRow = settingRow('匿名玩法数据', '仅本地/自托管收集，不含账号与个人信息；默认关闭');
  const telemetryToggle = buildToggle(!!s.telemetry, value => {
    updateSetting('telemetry', value);
    if (value) app?.telemetry?.setEnabled?.(true);
    else { app?.telemetry?.setEnabled?.(false); app.telemetry = null; }
  }, '匿名玩法数据');
  telemetryToggle.id = 'telemetry-toggle';
  telemetryRow.append(telemetryToggle);
```

然后把它加进 `guidePanel` 的 rows：`[helpRow, telemetryRow, tutorialRow, resetRow]`。

## 10. 服务端启用（运维）

```bash
# 开启分析端点（不设置则 /analytics/* 一律 503）
export ANALYTICS_TOKEN="$(openssl rand -hex 32)"
# 可选：自定义落盘目录
export TELEMETRY_DIR=/var/lib/mistisle/telemetry
node server/index.mjs
```

查询：

```bash
curl -H "Authorization: Bearer $ANALYTICS_TOKEN" http://127.0.0.1:8787/analytics/summary
curl -H "Authorization: Bearer $ANALYTICS_TOKEN" "http://127.0.0.1:8787/analytics/funnel?days=7"
curl -H "Authorization: Bearer $ANALYTICS_TOKEN" "http://127.0.0.1:8787/analytics/weapons?days=7"
```

## 11. 删除权（合规）

```bash
node scripts/analytics-seed.mjs --clean       # 只删 seed 假数据，保留真实事件
rm -rf data/telemetry/2026-10-27.jsonl          # 删除某一天的全部遥测
rm -rf data/telemetry/                          # 全量删除
```
