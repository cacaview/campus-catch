# 🐱🐭 校园定位活动（Web 版）

真人户外猫抓老鼠：用浏览器 GPS 在真实校园里跑，**靠近对方 15 米即触发相遇（打卡）**。
鼠队躲猫猫 + 捡奶酪打卡得分，猫队追击，坚持到最后 / 积分高者胜。支持单机 AI 对局与可选的 WebSocket 联机。

由微信小程序版（`导航小程序/2.0/校园导航-静态`）完整移植而来：**纯前端、零后端、零 API key**，可直接托管在 GitHub Pages。

## 本地运行

任意静态服务器即可（ESM 模块需要 `http(s)://` 协议，不能直接双击打开 `index.html`）：

```bash
cd game_web
python3 -m http.server 8123
# 打开 http://localhost:8123
```

> 开发期建议给响应加 `Cache-Control: no-store`，避免浏览器 ESM 模块缓存加载旧代码。

桌面浏览器没有 GPS：定位 10 秒超时后自动进入**模拟移动模式**（toast 提示），流程完全可玩；手机浏览器授权定位后使用真实 GPS。

## 部署到 GitHub Pages（推荐）

1. 把本仓库推送到 GitHub（`git push origin main`）。
2. 仓库 **Settings → Pages → Source** 选择 **Deploy from a branch**，分支选 `main`，目录选 `/ (root)`，保存。
3. 等 1–2 分钟后访问 `https://<用户名>.github.io/<仓库名>/`。

Pages 自带 HTTPS —— 这是浏览器定位 API 的硬性要求。

**404 / 打不开排查：**
- 分支名要写 `main`（仓库默认分支若是 `master` 则选 `master`）。
- 仓库名区分大小写，URL 与仓库实际名字完全一致。
- 推送后 Actions 部署有 1–2 分钟延迟，稍等再刷。
- 确认 Pages 已启用（Settings → Pages 状态不是 disabled）。

## 真实定位说明

- **必须 HTTPS**（GitHub Pages 自带）+ 用户在浏览器弹窗中允许定位。
- 坐标系统一为 **WGS-84**，底图免 key 且与 GPS 直接对齐。**默认 Esri 卫星瓦片（国内可直连）**；街道图 OSM 为可切换样式，国内网络可能不可达——连续加载失败会自动回退卫星图并提示。（CARTO 免 key 瓦片自 2026-09 起强制 API key，已弃用）
- Android 中国机型（高德/百度底层）定位可能带 GCJ-02 偏移（约 300–600m）：绝对位置略偏，但**双方偏移一致，相对距离与相遇判定不受影响**。
- 拒绝授权 / 桌面环境：自动模拟移动，游戏照常进行。

## 可选：多人联机（WebSocket relay）

单机为默认模式。若要真人联机，把原项目的 `server.js`（Node + ws）做一次最小改造部署到 Cloudflare Workers：

1. **替换 `ws` 依赖**：Workers 无 `require('ws')`，改用 Workers 原生 WebSocket API——在 `fetch` 事件中 `request.upgrade('websocket')`，房间状态放入 **Durable Object**（每个房间一个对象实例，天然按 roomId 路由），`broadcastToRoom` 改为遍历 `do.getState().acceptWebSocket` 登记的本对象连接。
2. **补 CORS / 握手响应头**：HTTP 响应与升级响应都要带 `Access-Control-Allow-Origin: *`，并对 `OPTIONS` 预检返回 `204` + `Access-Control-Allow-Headers: *`（浏览器跨源连 `wss://` 会先预检）。
3. **删掉微信专用端点**：`/voip-sign`（依赖小程序 AppID/Secret，Web 版无语音）、`/room-qr` 与 `/network-info`（局域网专用，Web 用「复制链接」代替）。

部署后在首页选 **服务器联机** 模式，填入 `wss://<你的worker地址>` 即可建房；把「加入链接」发给队友（链接自动携带 server + 房间口令）。连接失败会自动降级为单机并 toast 提示。

## 目录结构

```
index.html            SPA 入口（5 个 view 容器 + 平台层 DOM）
js/main.js            路由（hash SPA）+ 全局状态
js/platform/          wx.* 兼容层：storage / ui / geo / network
js/lib/map.js         MapLibre GL 封装（免 key 瓦片）
js/utils/             无状态模块：技能/道具/AI/成就/商店/协议/音效…
js/views/             home / lobby / game / result / rank
css/                  各视图样式（rpx→px÷2 移植自 wxss）
vendor/               maplibre-gl.js（本地化，无需 CDN）
test/                 node:test 单测 + e2e 检查单
docs/                 移植计划与规格
```

## 测试

```bash
node --test test/*.test.js   # 50 个单测
```

浏览器全链路走查见 [test/e2e-checklist.md](test/e2e-checklist.md)。

## 已知限制（相对小程序版）

- **语音房**：Web 无微信 VoIP 接口，语音入口改为提示「请使用文字聊天」。
- **UDP / 局域网直连**：静态托管不支持，联机走可选的 WSS relay（见上）。
- **微信分享卡片**：改为复制应战链接 + 下载战报卡片 PNG（`canvas.toBlob`）。
- **扫码进房**：改为「复制加入链接」（链接含 server + 口令）。
- **相册保存**：改为浏览器下载。
- 战绩排行基于本机 `localStorage`（跨设备不同步）；联机仅同步对局内实时数据。
