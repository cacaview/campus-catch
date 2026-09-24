# 真人版猫抓老鼠 Web 版 — 设计文档

日期：2026-09-24
来源项目：`/Users/user/code/game1/导航小程序/2.0/校园导航-静态`（微信小程序，~5,300 行 JS）
目标项目：`/Users/user/code/game_web`（纯静态 Web 应用，托管 GitHub Pages）

---

## 1. 背景与目标

原游戏是「真人版猫抓老鼠」：基于真实 GPS 位置的户外猫鼠对抗游戏（校园场景）。猫队靠近鼠队 15 米触发相遇打卡，鼠队躲避、打卡奶酪得分，支持技能卡、聊天、房间管理、积分商店、称号任务、排行榜。

因微信平台迟迟不开放所需的 API 能力（UDP 套接字、VoIP 群通话等需专项审批），现改为 Web 版本，直接托管到 GitHub Pages。

**核心目标**：把完整可玩的游戏移植为一个**零配置、纯静态**的 Web 应用——不需要任何 API key、不需要自建后端即可在 GitHub Pages 上玩起来。

## 2. 硬约束

1. **GitHub Pages 只能托管静态文件**：不能运行原项目的 Node WebSocket 中继服务器（`server.js`），不能运行任何常驻进程。
2. **页面是 HTTPS**：浏览器安全策略禁止 HTTPS 页面连接 `ws://` 内网地址（mixed content），因此原「局域网 IP 直连」模式在托管后不可用。
3. **浏览器没有 UDP 套接字 API**：原 P2P 模式（`wx.createUDPSocket`）无对应物。
4. **浏览器无 VoIP 群通话**：`wx.joinVoIPChat` 没有静态环境下的对应物（WebRTC 语音需要信令服务器 + STUN/TURN，超出静态托管范围）。

## 3. 范围

### 3.1 完整移植（核心玩法 1:1 保留）

| 模块 | 内容 |
|---|---|
| 首页 | 选队伍（猫/鼠）、昵称、地图框选活动区域（点选 3~12 点 + 撤销/清空 + 3 种一键模板）、单局时长滑杆、联机模式选择、就绪清单、开始按钮 |
| 大厅 | 房间信息卡、玩家列表、单机 AI 补位步进器、开始/修改配置/解散房间 |
| 游戏页 | 地图（玩家/AI/道具标记、区域多边形、卫星图切换）、HUD（距离/计时/房主/背包）、倒计时、战斗播报层、暂停遮罩、右侧工具栏（视图/扫描/排行/雷达/追踪）、聊天面板、技能卡栏、抓捕覆盖层、实时排名弹窗、房主控制（暂停/延时/踢人/提前结算） |
| 游戏逻辑 | 1.5s tick（AI 追逃、道具拾取、声呐震动、抓捕判定+防连击冷却、行为分）、1s 倒计时、越界检测与暂停计分、足迹采样（≥3m 或 ≥5s，上限 800 点）、技能效果（隐身/护盾/透视/诱饵/伪装/热感）、商店道具进局生效 |
| 单机模式 | AI 玩家（猫追鼠逃行为控制器）、AI 补位 0~5 名 |
| 联机模式 | 服务器模式：输入 `wss://` 地址连接，复用现有 JSON 协议（JOIN_ROOM/PLAYER_MOVE/CATCH_EVENT/CHAT_MESSAGE/GAME_PAUSE/GAME_EXTEND/PLAYER_KICK/心跳/重连） |
| 结算页 | 胜负判定 + 粒子特效、双方得分榜（MVP 标记）、个人统计、**足迹回放**（地图折线 + 移动标记，播放/暂停/重播）、再来一局 |
| 排行页 | 总榜/猫队榜/鼠队榜 × 周榜/月榜/总榜（基于本地历史战绩聚合，稳定 playerId 聚合键，示例数据兜底） |
| 成就系统 | 称号（8 个，解锁/佩戴）、每日任务（3 个，按天重置）、热身任务（5 个，永久线）、积分钱包 |
| 积分商店 | 5 种消耗品道具（进局自动生效）+ 限定称号卡 |
| 新手引导 | 3 屏引导（仅首次展示，可跳过） |
| 应战邀请 | URL 参数 `?challenge=1&by=xx&team=cat` → 首页横幅 → 接受后预填对立阵营 |

### 3.2 裁剪（静态托管下不可行，明确降级）

| 原功能 | 处理 | 理由 |
|---|---|---|
| UDP P2P 联机（`wx.createUDPSocket`） | **移除** | 浏览器无 UDP API |
| 局域网 IP 直连（ws://LAN-IP） | **移除该模式**，保留「服务器」模式输入框（可填任意 wss:// 地址） | HTTPS 页面 mixed content 拦截 |
| 语音频道（全局/猫队/鼠队，`wx.joinVoIPChat`） | **移除**，工具栏「语音」按钮点击提示「Web 版暂不支持语音」 | 需信令服务器 + WebRTC 基础设施 |
| 微信登录（`wx.login`/openId） | **移除**，身份改用本地稳定 playerId（`player-identity.js` 原样保留） | Web 无微信登录，本地身份足够 |
| 扫二维码加入房间（`wx.scanCode`） | **移除**，改为：房主展示「加入链接」（页面 URL + `?server=..&passcode=..`），加入者打开链接或手输 | 浏览器无扫 QR 标准 API（BarcodeDetector 覆盖不全） |
| 保存战报卡片到相册（`wx.saveImageToPhotosAlbum`） | **降级**为浏览器下载 PNG（canvas.toBlob → a[download]） | 浏览器无相册写入 |
| 微信分享（`onShareAppMessage`） | **降级**为复制带应战参数的页面链接（navigator.clipboard） | 无微信分享环境 |
| `wx.getLocalIPAddress` 本机 IP 展示 | 移除 | 浏览器无法获取本机 LAN IP |

### 3.3 明确不实现（YAGNI）

- 用户账号系统 / 云端战绩同步（排行仅本地）
- 多语言（仅中文）
- 桌面端键盘控制（游戏本质依赖手机 GPS，桌面端仅作浏览/试玩）

## 4. 关键技术与决策

### 4.1 地图：MapLibre GL JS + 免 key 底图（本设计最重要的决策）

**选型对比**：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **MapLibre GL + Carto Voyager 栅格瓦片（默认）+ Esri World Imagery（卫星）** ✅ | 全部免 key、纯静态、WGS-84 与浏览器定位同坐标系、可切卫星图 | 中国校园街区细节不如高德/腾讯 |
| 高德 JS API / 腾讯 JS API | 中国底图细节最好 | 需注册账号申请 key + 安全码（违反零配置目标）；GCJ-02 与浏览器 WGS-84 定位需额外转换 |
| Leaflet + OSM | 更轻 | 交互能力弱于 MapLibre；同样免 key |

**决定**：MapLibre GL JS（本地 vendor，不依赖 CDN 可用性），默认底图 Carto Voyager（`https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`，WGS-84，免费非商用），卫星视图切 Esri World Imagery（`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`，WGS-84，免 key）。

**坐标系**：浏览器 `navigator.geolocation` 返回 WGS-84（iOS 确定；Android 在中国可能因系统层返回 GCJ-02）。底图为 WGS-84 → **游戏逻辑全程使用 WGS-84，不做坐标转换**（与原小程序 gcj02 帧不同，但游戏逻辑只依赖坐标间的相对距离与多边形包含判断，坐标系帧统一即可正确工作）。风险：中国大陆 Android 用户若系统返回 GCJ-02，其标记相对真实地理会有 ~500m 偏移——由于所有玩家/区域绘制/标记全部在同一帧内自洽，玩法（相对距离、区域判定）不受影响，仅底图地理参照偏移。在首页规则说明中加一句提示。此决策已作为假设记录（见 §8）。

**地图能力封装**（`js/lib/map.js`）：`init(container, {center, zoom})`、`setMarkers(list)`（divIcon：emoji + 名字 + 分数 + 阵营配色，支持高亮态）、`setPolygon(points)`、`setPolyline(points)`、`fitBounds(points)`、`setSatellite(bool)`、`onTap(cb)`（返回点击的经纬度，用于首页框选）、`moveTo(lat,lng)`、`setUserLocation(lat,lng)`。

### 4.2 定位：Geolocation API + 模拟降级

- `watchPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 })`，每次回调按原逻辑：Haversine 累计距离（1~150m 有效）、区域包含判断、足迹采样。
- 授权拒绝/定位失败 → 沿用原逻辑的**模拟移动**兜底（每 2s 随机微移 + 距离累加），保证桌面端/无 GPS 场景可完整试玩。
- 页面要求用户保持前台（浏览器后台会冻结定时器与定位节流）——在规则说明中注明。

### 4.3 网络：离线默认 + 服务器可选

- **OFFLINE（默认）**：AI 玩家，纯本地。
- **SERVER**：输入 `wss://` 地址 → 原生 `WebSocket` → 原协议层（`protocol.js`/`room-session.js`/`network-manager.js`/`websocket-adapter.js`）1:1 移植（CommonJS → ESM，`wx.connectSocket` → `new WebSocket`）。原 `server.js` 稍加改造（去掉 WeChat 签名端点、加 CORS 头）即可部署在任意 HTTPS 环境（Cloudflare Workers/VPS），协议不变。
- 心跳（3s PING/PONG）、指数退避重连（1/2/4/8/16s，最多 5 次）逻辑原样保留。
- UDP 适配器文件不移植；`network-manager` 中 P2P/LAN 分支删除，仅留 OFFLINE + SERVER 两态。

### 4.4 技术栈：原生 ES Modules，无构建步骤

- 不引入框架与打包器：原代码本身就是无依赖的过程式 JS（`Page({})`/`Component({})` + `setData`），移植为「每页一个模块 + 命令式 DOM 更新」最贴近原代码、风险最低、GitHub Pages 零构建。
- `index.html` 静态包含 5 个 `<section class="view">`（home/lobby/game/result/rank），`js/main.js` 用 hash 路由（`#/home` 等）切换视图；各视图模块负责自己的 DOM 渲染与事件绑定（对应原 `onLoad`/`onReady`/`onShow`/`onUnload`）。
- 原 `app.js` 的 `globalData` → `js/main.js` 导出的普通对象 `globalState`。
- MapLibre 的 JS/CSS 下载到 `vendor/` 本地（保证断网/离线可用，且避免 CDN 被墙风险）。

### 4.5 wx API 兼容层（`js/platform/`）

不逐调用点改写，而是提供与原签名尽量一致的薄封装，页面移植改动最小：

| 原 wx API | Web 实现 |
|---|---|
| `wx.getStorageSync` / `setStorageSync` | `localStorage`（键名不变：`lastNickname`/`indexCfg`/`playerId`/`player_achievements_v2`/`shop_data_v1`/`gameHistory`/`guideShown`） |
| `wx.showToast` | 顶部 toast 条（自动 2.5s 消失，`icon` 参数映射 emoji） |
| `wx.showModal` | DOM 模态框（Promise 化，`confirmText`/`showCancel` 保留） |
| `wx.showLoading` / `hideLoading` | 全屏加载遮罩 |
| `wx.showActionSheet` | DOM 底部动作列表（Promise 化，返回 tapIndex） |
| `wx.reLaunch` / `switchTab` / `navigateTo` / `navigateBack` | hash 路由跳转（`reLaunch` = 清栈直达，单页应用里等同切视图） |
| `wx.vibrateShort` / `vibrateLong` | `navigator.vibrate(...)`（iOS Safari 不支持则静默 no-op） |
| `wx.setClipboardData` / `getClipboardData` | `navigator.clipboard`（降级 `execCommand`） |
| `wx.getLocation` / `startLocationUpdate` / `onLocationChange` | `navigator.geolocation`（封装成与原回调语义一致） |
| `wx.createMapContext` | 由 `js/lib/map.js` 承担（moveToLocation → `map.move`） |
| `wx.scanCode` / `saveImageToPhotosAlbum` / `login` / `createUDPSocket` / `joinVoIPChat` 族 | 不实现（见 §3.2） |

`utils/` 下纯逻辑文件（game-area、ai-player、skill-system、map-items、achievement、shop、player-identity、network/*）只做 **CommonJS → ESM 转换**，逻辑一行不改。`sound-vibration.js` 的 wx 调用改走 platform 层。

### 4.6 分享卡片

结算页战报卡片：HTML5 `<canvas>` 600×960 按原 `drawShareCard` 绘制逻辑 1:1 重绘 → `toBlob` → 下载链接 + 「复制应战链接」按钮。

## 5. 项目结构

```
game_web/
├── index.html                 # 应用壳：5 个 view section + toast/modal/loading/actionsheet 容器
├── css/
│   ├── base.css               # 主题变量/动画（移植 app.wxss，rpx→rem/vw 换算）
│   ├── home.css  lobby.css  game.css  result.css  rank.css
├── js/
│   ├── main.js                # hash 路由 + globalState（原 app.js）+ 启动
│   ├── platform/
│   │   ├── storage.js         # storage 封装
│   │   ├── ui.js              # toast/modal/loading/actionsheet/clipboard/vibrate
│   │   └── geo.js             # geolocation 封装（与原回调语义一致）+ 模拟降级
│   ├── lib/
│   │   └── map.js             # MapLibre 封装（markers/polygon/polyline/satellite/onTap）
│   ├── utils/                 # 原逻辑 1:1 移植（CommonJS→ESM）
│   │   ├── game-area.js  ai-player.js  skill-system.js  map-items.js
│   │   ├── achievement.js  shop.js  player-identity.js  sound-vibration.js
│   │   └── network/  protocol.js  room-session.js  websocket-adapter.js  network-manager.js
│   └── views/
│       ├── home.js  lobby.js  game.js  result.js  rank.js   # 每页对应原 Page
├── vendor/
│   ├── maplibre-gl.js  maplibre-gl.css
├── docs/superpowers/specs/    # 本文档
└── README.md                  # 玩法说明 + GitHub Pages 部署步骤 + 可选联机服务器说明
```

**模块边界**：
- `utils/*` 不 import 任何 `views/*` 或 `platform/ui.js`（唯一例外：achievement 的解锁 toast → 改为返回事件由视图层展示，保持纯逻辑可测）。
- `views/*` 只通过 `platform/*` 和 `lib/map.js` 触达浏览器 API。
- `lib/map.js` 是 MapLibre 唯一使用点（home 框选地图、game 主地图、result 回放地图三处实例都走它）。

## 6. 视图细节

### 6.1 首页（home）
- 布局自上而下：引导层（首次）→ 标题 → 应战横幅（条件）→ 队伍选择卡 → 昵称输入 → 区域框选地图（点击加点、编号标记、多边形、撤销/清空、3 模板按钮）→ 时长滑杆 → 称号/任务/商店入口条 → 联机模式 tabs（🤖单机 / ☁️服务器）→ 服务器 URL 输入（SERVER 模式时）→ 就绪清单 + 开始按钮 + 大厅入口 → 规则折叠区。
- 原 LAN/P2P 模式 tab、扫码、QR 展示、本机 IP 卡：**删除**。
- SERVER 模式开始流程：校验 URL（自动补 `wss://`）→ 连接（10s 超时看门狗）→ 成功进游戏页 / 失败降级单机并进游戏（与原行为一致）。
- SERVER 模式「加入链接」：房主（先连接者）可生成 `页面URL?server=<wss地址>&passcode=<码>` 链接复制给队友；页面加载时解析该 query 自动填入 SERVER 表单（替代原扫码/QR 功能）。
- 配置持久化：`indexCfg`（队伍/时长/区域原始点）原样保留。

### 6.2 大厅（lobby）
- Web 版大厅为**单机专用**（与原行为一致：原小程序的 SERVER 模式是 首页连接→直接进游戏，不经大厅；LAN 模式已移除）。
- 房间卡（🤖单机房间、时长/区域 meta）+ 玩家列表（我 + AI 补位）+ AI 步进器（0~5）+ 开始/修改配置/解散房间。

### 6.3 游戏（game）
- 主地图 + 全部 HUD/覆盖层/面板按 §3.1 移植；`game.js` 1,286 行逻辑逐段对应移植（data 字段 → 视图状态对象，setData → 定向 DOM 更新函数）。
- 语音相关字段/方法保留 UI 占位（按钮提示不可用），不引入语音管理器。
- 标记体系：divIcon 样式复刻原 callout（emoji+名字+分数，阵营配色：猫 `#ff3366`、鼠 `#33ccff`、高亮 `#ffd700`、诱饵 `#8e44ad`、道具四色）。
- 位置/游戏循环/tick/抓捕/AI/技能/房主控制：逻辑与原 `game.js` 完全一致（含 3s 抓捕冷却、同目标 10s 防重复、雷达 40m 抓捕半径、声呐双档震动 900ms 节流等全部细节）。

### 6.4 结算（result）
- 胜负/平局头图 + 粒子 + 得分榜（双列，MVP 皇冠，我标记）+ 四项统计 + 足迹回放（MapLibre 折线逐段加亮 + 移动标记，200ms/点）+ 按钮组：再来一局 / 复制应战链接 / 下载战报卡片 / 查看排行 / 回首页。
- 历史战绩写入 `gameHistory`（最近 50 局，team 归一化）原样保留。

### 6.5 排行（rank）
- 时间 tabs（周/月/总）+ 队伍 tabs（总/猫/鼠）+ 我的排名速览条 + 榜单（前三名奖牌、示例数据标「示例」、空态引导）。聚合逻辑（稳定 id 优先、昵称兜底、去重「我」）原样保留。

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 定位授权拒绝 | toast 提示 + 自动切模拟移动（游戏可玩） |
| 区域外 | 顶部警示条 + 暂停计分/拾取/同步（原逻辑），回到区域内自动恢复 |
| 服务器连接失败/超时 | 10s 看门狗 + 错误弹窗（诊断提示）；SERVER 模式开始失败降级单机 |
| 游戏中断线 | 指数退避重连（原逻辑），状态点显示「重连中」 |
| localStorage 满/不可用（隐私模式） | storage 层 try/catch 降级为内存 Map，toast 提示数据不持久 |
| MapLibre 瓦片加载失败 | 地图显示灰色底（底图加载失败不影响标记/多边形/玩法） |
| 非 HTTPS 环境访问定位 | 浏览器拒绝 geolocation（需安全上下文）→ 同「授权拒绝」路径走模拟移动，并在首页提示「请通过 HTTPS 访问以启用真实定位」 |

## 8. 已记录的假设（用户未答，按最佳判断）

1. **默认离线单机为第一目标**，服务器联机为可选增强（用户部署 server.js 即可启用）——依据用户「直接托管 GitHub Pages」的明确表述。
2. **地图选免 key 方案**（MapLibre+Carto/Esri）而非高德/腾讯——依据零配置托管目标；若用户愿意注册高德 key 获得更好底图，`lib/map.js` 的封装使替换底图是局部改动。
3. **坐标系统一 WGS-84**，不做 GCJ 转换（见 §4.1 风险分析）。
4. **语音/P2P/LAN 移除**（§3.2）——静态托管的硬约束所限。
5. 页面标题/水印沿用「校园定位活动」原名（原 app.json navigationBarTitleText）。

## 9. 测试策略

1. **纯逻辑单测**（Node，无框架，`node:test` 或 assert 脚本）：game-area（距离/包含/中心/边界排序）、protocol（编解码/身份码）、room-session（建房/校验/成员）、ai-player（猫追/鼠逃/游走）、skill-system（按队取卡）、map-items（刷点/拾取/阵营门控）、achievement（解锁/任务/积分/跨天重置）、shop（购买/消耗/库存）。
2. **浏览器 E2E**（本地静态服务器 + 浏览器自动化）：
   - 首页：选队伍/输昵称/一键模板生成区域/滑杆 → 就绪清单全绿 → 开始
   - 游戏页：倒计时 3s → PLAYING；无定位（桌面）→ 模拟移动生效、距离累计、AI 移动、道具标记存在；技能卡点击生效（次数-1）；扫描/排名弹窗/房主菜单可用
   - 结束（等倒计时或提前结算）→ 结算页：胜负/得分榜/足迹回放可播放
   - 排行页：本局历史已写入、榜单展示
3. **手工联机验证**（可选）：本地 `node server.js` + 两个浏览器实例走 SERVER 模式验证协议互通。

## 10. 部署（GitHub Pages）

1. `git init` → 推送到用户 GitHub 仓库。
2. 仓库 Settings → Pages → Source: main branch / root（或 /docs，见 README 两种写法）。
3. 访问 `https://<user>.github.io/<repo>/`。
4. 注意：真实定位要求 HTTPS（GitHub Pages 天然满足）；本地 `file://` 打开时定位不可用，自动走模拟移动。
5. 可选：联机服务器部署说明（server.js → Cloudflare Workers 的最小改造清单）写入 README。

## 11. 遗留/后续迭代（本次不做）

- 语音频道：WebRTC + 免费信令（如 Supabase Realtime）方案
- 高德/腾讯底图可选切换（需用户提供 key）
- 云端战绩排行榜（需后端）
- 移动端 PWA 封装（manifest + 全屏）
