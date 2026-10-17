# MIST ISLE · 设计规范（DESIGN.md）

> 版本 1.0.0 · Owner: design · 对应实现：`client/style.css`（唯一事实来源是 CSS 变量本身，本文档是索引与约束）
> 关联契约：`docs/CONTRACTS.md` §11（DOM class/id 清单）

## 1. 设计目标

| 目标 | 落地手段 |
| --- | --- |
| 成熟商业战术竞技手游的质感 | 深色海雾底 + 冷光描边 + 毛玻璃 + 切角，克制的动效 |
| 手机横屏 640×360 可玩 | 全部 HUD 尺寸走 `--hud-u` 缩放单位，面板按小屏重排 |
| 桌面 1440p 舒适 | 大屏放大栅格与字号，HUD 居中收束，隐藏触屏控件 |
| 信息密度与可读性 | 数字等宽、标签大写细字距、颜色只承担语义（青绿=可用 / 琥珀=奖励 / 红=危险） |
| 低端机 60FPS | 动画只用 transform/opacity，模糊与阴影限量，稀有度流光是唯一常驻动画且默认暂停 |

**设计语言三要素**：①海雾青绿信号色 `#6fe0c8`；②琥珀奖励色 `#f5b445`；③军事切角与 1px 网格。

## 2. 色彩 Token

| Token | 值 | 用途 |
| --- | --- | --- |
| `--c-abyss-900 / 950` | `#050f10` / `#030a0b` | 页面底 / 最深遮罩 |
| `--c-abyss-700` | `#0e2324` | 面板实色底 |
| `--c-mist-400 … 100` | `#24423f` → `#9db4ad` | 描边、次要文本、禁用 |
| `--c-teal-400` | `#6fe0c8` | 主信号色（可用/成功/焦点） |
| `--c-teal-500 / 600` | `#46cbb1` / `#26a58d` | 渐变亮端 / 暗端 |
| `--c-amber-500` | `#f5b445` | 奖励、货币、传奇稀有度、警告 |
| `--c-red-500` | `#ff5c5c` | 致命信息、低血量、缩圈危险 |
| `--text-hi / mid / lo / dim` | `#eaf6f1` / `#c2d6cf` / `#8ba39c` / `#64807a` | 四级文本层次 |
| `--line / --line-strong / --line-accent` | 青绿 14% / 26% / 50% 透明 | 面板描边三级 |

**稀有度五档**（与 `shared/rules.mjs` RARITY 对齐）：
`common #9aa8a4` · `uncommon #7ce08a` · `rare #5aa9ff` · `epic #c07cff` · `legendary #f5b445`
用法：容器加 `.rarity-<tier>`，内部用 `var(--rarity)` / `var(--rarity-rgb)`；legendary/epic 额外有 hover 才播放的流光。

## 3. 间距 / 圆角 / 层级 Token

- 间距 4pt 基准：`--sp-1 4` `--sp-2 8` `--sp-3 12` `--sp-4 16` `--sp-5 20` `--sp-6 24` `--sp-7 32` `--sp-8 40` `--sp-9 56` `--sp-10 72` `--sp-11 96`
- 圆角：`--radius-xs 2` `sm 4` `md 6` `lg 10` `xl 14` `pill 999`；切角：`--cut-sm 8` `--cut-md 14` `--cut-lg 22`（用于 `.btn`、`.panel.cut`、HUD 面板）
- 层级：`#world 0` → `#hud 20` → `#screen-root 30` → `#fx-overlay 45` → `#dialog-root 60` → `#toast-root 70` → `#boot 90` → `#rotate-hint 95`

## 4. 字号 Token

| Token | 值 | 用途 |
| --- | --- | --- |
| `--fs-2xs` | 10px | 标签、单位、键帽 |
| `--fs-xs` | 11px | 辅助说明、列表副行 |
| `--fs-sm` | 12px | 按钮、正文小号 |
| `--fs-md / --fs-body` | 13 / 14px | 正文、卡片标题 |
| `--fs-lg / --fs-xl` | 16 / 20px | 小节标题、数值 |
| `--fs-2xl … --fs-4xl` | 26 / 34 / clamp(34,4.4vw,56) | 弹窗标题、屏标题 |
| `--fs-hero` | clamp(46,7.6vw,104) | 首页主标题 |

字体栈：`Inter, "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`；数字一律 `font-variant-numeric: tabular-nums`（`.mono` / `#hud` 内读数）。

## 5. 组件清单

**基础**：`.screen(+.active)` `.screen-bg` `.topbar` `.brand` `.main-nav/.nav-button` `.top-actions` `.currency` `.screen-body` `.screen-head` `.screen-main` `.screen-side` `.screen-foot` `.title-xl/.title-lg/.title-md` `.eyebrow` `.muted` `.divider` `.hidden`
**容器**：`.panel(+.flat/.accent/.cut/.amber/.danger)` `.panel-head/.panel-body/.panel-foot` `.card(+.interactive/.selected/.locked)` `.section-title` `.empty-state`
**交互**：`.btn/.btn-primary/.btn-ghost/.btn-danger`（+`.btn-sm/.btn-lg/.btn-block`）`.icon-btn` `.link-btn` `.keycap` `.chip(+.active)` `.badge(+.amber/.danger/.neutral/.solid)` `.badge-corner` `.tab(+.active)` `.segmented` `.toggle(+.on)` `.slider` `.tooltip`
**数据**：`.stat(+.accent/.amber/.danger)` `.stat-row` `.stat-bar>i` `.progress>i` `.list/.list-row` `.avatar` `.level-ring` `.progress-row`
**局外屏**：`.home-hero/.home-nav/.home-nav-item` `.player-card` `.mode-grid/.mode-pick` `.map-row/.map-pick/.map-art/.map-diff` `.difficulty-row` `.play-actions` `.squad-grid/.squad-slot` `.slot/.slots-row` `.preview-stage` `.loaded-stats` `.skin-grid/.skin-card` `.store-tabs/.store-grid/.item-art/.item-meta/.item-name/.item-desc/.price` `.codex-tabs/.codex-grid/.codex-card` `.mission-list/.mission/.mission-meta` `.career-head` `.stat-grid` `.ach-grid/.ach-card/.ach-icon` `.match-history` `.settings-group` `.setting-row`
**弹窗**：`.modal(+[open]/.open)` `.modal-backdrop` `.modal-card` `.modal-head` `.modal-body` `.modal-actions` `.modal-close` `.modal-hint` `.room-code-display/.room-player` `.help-grid` `.rank-display` `.result-stats` `.connection-overlay` `.toast(+.show)`
**HUD**：`.hud-panel` `.hud-top` `.hud-alive` `.hud-kills` `.zone-pill` `.hud-map/.minimap-wrap/#minimap` `.squad-panel/.squad-member(+.self/.downed/.eliminated)` `.health-panel/.health-track/.armor-track/.stamina-track` `.weapon-panel/#ammo/#reserve/#reload-progress` `.crosshair` `.hitmarker` `.damage-vignette` `.damage-dir` `.killfeed/.killfeed-row` `.phase-banner` `.context-hint/.interact-prompt` `.scoreboard` `.chat-panel` `.horde-panel` `.spectate-bar` `.joystick/.touch-btn/.action-buttons/.tactical-buttons` `#touch-controls.left-handed`

## 6. HUD 布局图（横屏）

```
┌──────────────────────────────────────────────────────────────────────┐
│ [41 存活 | 3 淘汰]      (缩圈 00:23)                ☰   [ 小地图 ]    │
│ ┌─小队─────────┐                          ┌─击杀播报──────────────┐   │
│ │ ● 旅人   100 │                          │ 旅人 ⌖ 影  AR7        │   │
│ │ ● 阿岚    86 │                          │ 阿岚 ⌖ 风  P9         │   │
│ │ ● 老陈 倒地  │                          └──────────────────────┘   │
│ │ ○ 小满 淘汰  │                                                     │
│ └──────────────┘               ✛ 准星                                │
│                                                                      │
│                  (阶段横幅 / 交互提示 居中)      [AR7 步枪  RARE]     │
│ ┌─生命─34───┐                                   [ 24 / 120    ]     │
│ │ 血条 █████ │                                   [重装进度条     ]     │
│ │ 护甲 ███   │                                   [ Q · P9       ]     │
│ │ 耐力 ████  │                                                        │
│ │ ✚2  ▣1    │                                        (触屏动作簇)    │
│ └───────────┘   ╭───╮  (桌面：键位提示居中底)  ╭───╮  ↻ ✚ ⇄          │
│  (触屏) 移动摇杆 ╰───╯                         ╰───╯ 瞄准摇杆          │
└──────────────────────────────────────────────────────────────────────┘
```

分区（所有值由 `--hud-u` 派生）：
- 顶部中：`.hud-top`（存活/击杀/缩圈/菜单），`left:50%` 居中；
- 右上：`.hud-map`（小地图 132×132 × `--hud-u`）+ 天气；桌面播报在其下方右对齐；
- 左上：`#squad-panel`（宽 158 × `--hud-u`）；
- 左下：`#health-panel`（宽 228 × `--hud-u`）+ 消耗品；
- 右下：`#weapon-panel`（宽 ≥168 × `--hud-u`）；
- 触屏：左下 `#move-stick`、右下偏内 `#aim-stick`、右下角 `#action-buttons`、左上 `#tactical-buttons`。

## 7. 响应式断点

| 断点 | 策略 |
| --- | --- |
| `min-width:1800px` | 内容边距 48px，侧栏上限 380px |
| `≤1180px` | `.screen-main` 单列，侧栏转网格 |
| `≤900px` | 顶栏 62px，隐藏品牌副标，弹窗收窄 |
| `≤760px` / `height≤460px` | 手机横屏：导航缩为纯中文，地图卡 3 列，隐藏描述文本，按钮 46px |
| `height≤400px` | 进一步压缩标题与卡片（640×360 验收） |
| `max-height:500px + landscape` | HUD 小屏布局：`--hud-u ≈ 0.9–1.1px`，面板重排，文字标签隐藏，按钮 ≥38px |
| `761–1180 + landscape` | 平板 HUD 中间档缩放 |
| `orientation:portrait` | 显示 `#rotate-hint` 遮罩，隐藏屏幕内容 |
| `pointer:coarse` | 隐藏桌面键位提示，显示触屏控件，取消 hover 位移 |
| `pointer:fine + min-width:768` | 隐藏触屏控件，显示 `.desktop-controls` |
| `prefers-reduced-motion` | 全部动画/过渡压缩到 0.001ms，流光关闭 |
| `prefers-contrast:more` | 描边加粗、文本提亮 |

安全区：`--safe-t/r/b/l = env(safe-area-inset-*, 0px)`，所有 HUD 与屏幕边距都用 `max(基准, safe + 基准)`；横屏左右额外留白。

## 8. 动效规范

| 场景 | 实现 | 时长/曲线 |
| --- | --- | --- |
| 屏幕切换 | `.screen.active` → `screenIn`（opacity + translateY 12px + scale .995） | 520ms `--ease-out` |
| 卡片进入 | `fadeUp` + `nth-child` stagger（40→200ms，最多 5 档） | 520ms |
| 按钮 | hover `translateY(-1px)` + 描边变亮；active `scale(.985)`；primary 有斜向高光扫过 | 120–320ms |
| 弹窗 | `.modal-card` 从 `translateY(18px) scale(.97)` 到原位 | 520ms `--ease-spring` |
| 血条/护甲 | `width` 过渡（仅 HUD 内允许，元素少） | 320ms |
| 准星 | 开火 `.firing` `scale(1.42)`；命中 `.hit` `scale(.84)` | 120ms |
| 命中标记 | `hitFlash` 240ms（scale 1.6→.92→1.15 + 淡出） | — |
| 受伤方向 | `.damage-dir` conic-gradient 扇形 + `damageFlash` 900ms | — |
| 击杀播报 | `killfeedIn` 右移淡入 / `killfeedOut` 右移淡出 | 260/320ms |
| 阶段横幅 | `phaseIn`（字距 0.4em→0.26em + 位移） | 420ms |
| 稀有度流光 | `raritySheen` 5.2s 循环，**默认暂停**，仅 hover / selected / 列表首个播放 | — |
| 数字变化 | JS 加 `.bump` → `numRoll` 220ms | — |
| 任务完成 | `.flash` → `taskFlash` 900ms 光环扩散 | — |
| 启动图标 | `bootFloat` 上下浮动 3.4s | — |

**性能约束**：动画只改 `transform`/`opacity`；`will-change` 仅用于摇杆头、流光层；同一屏同时播放的流光 ≤ 2；`prefers-reduced-motion` 全量降级。

## 9. 无障碍规则

1. **对比度**：正文 `#c2d6cf` on `#050f10` ≈ 12:1；`.muted` `#8ba39c` ≈ 6.7:1；禁用态允许低于 4.5:1 但不承载信息。
2. **点击区**：所有可交互元素最小 44×44（触屏媒体查询下按钮至少 38px 实际尺寸，配合 44px 命中盒）；HUD 小屏按钮 ≥38px。
3. **键盘可达**：`:focus-visible` 2px 青绿描边 + 3px offset；`.hidden` 元素不参与 tab 序。
4. **语义**：`#rotate-hint`、`#toast-root` 用 `role="status"`；`#killfeed` 建议 `aria-live="polite"`；图标按钮必须有 `aria-label`；纯装饰伪元素 `pointer-events:none`。
5. **不依赖颜色**：稀有度同时有文字（`.rarity-tag`）、边框、发光三重编码；倒地/淘汰除颜色外有文案与图标。
6. **触摸**：`touch-action:none` 全局，输入框/滚动区单独放开 `auto`/`pan-y`；禁用长按菜单与双击缩放；`user-select:none`。
7. **降级**：`backdrop-filter` 不支持时面板仍有不透明底色（`--bg-panel` 为 rgba，底色足够）；`clip-path` 不支持时退化为普通圆角矩形。

## 10. 使用约定（给 ui-screens / ui-hud）

- 屏幕根节点必须是 `.screen` + `data-screen`，激活加 `.active`（非激活由 CSS 隐藏）。
- 图标一律内联 `<svg stroke="currentColor" fill="none">`，尺寸由父级 CSS 控制，不要写死 px。
- 状态优先级：`.btn-primary > .btn > .btn-ghost > .btn-danger`（危险操作仅用于不可逆行为，且需二次确认）。
- 文案长度：按钮 ≤ 6 个汉字；卡片标题 ≤ 12 字；超长用 `.ellipsis`。
- 稀有度类只加在卡片容器上，不要加在文字标签上（避免描边套到文字）。
