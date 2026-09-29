# 🐱🐭 校园定位活动（Web 版）

真人户外猫抓老鼠：浏览器定位，在真实校园里跑，靠近对方 15 米即触发相遇。支持单机 AI 对局和服务器联机；联机房间提供文字聊天，以及全体、猫队、鼠队三种 WebRTC 语音频道。

Web 语音由浏览器麦克风和 WebRTC 提供。服务器只转发房间信令与临时 TURN 凭证，不录制或保存音频；媒体优先点对点传输，必要时经 Coturn 中继。在线功能需要 HTTPS/WSS 和用户主动授予麦克风权限。

## 本地运行

任意静态服务器即可（ESM 模块需要 `http(s)://` 协议，不能直接双击打开 `index.html`）：

```bash
python3 -m http.server 8123
# 打开 http://localhost:8123
```

桌面浏览器没有 GPS：定位超时后自动进入模拟移动模式；手机浏览器授权定位后使用真实 GPS。服务器联机地址默认指向生产服务，也可在首页修改。

## 线上服务

- 游戏页面：<https://106.53.199.187/>
- WebSocket 联机：`wss://106.53.199.187/ws`
- TURN 凭证接口：`https://106.53.199.187/api/ice-config`
- Relay 健康检查：<https://106.53.199.187/healthz>

服务器由 Nginx 提供 HTTPS/WSS 与静态文件，Node relay 仅绑定 `127.0.0.1:8081`，Coturn 转发 WebRTC 媒体。部署、证书续签、主机防火墙与运维步骤见 [`deploy/README.md`](deploy/README.md)。生产密钥只保存在服务器的 root-only 文件中，不放入 Web 目录或仓库。

## 真实定位与联机说明

- 真实定位需要 HTTPS 和用户允许浏览器定位。拒绝定位或桌面环境会使用模拟移动。
- 坐标系统一为 WGS-84；Android 中国机型定位可能带 GCJ-02 偏移，双方相对距离通常不受影响。
- 浏览器首次加入语音频道时会请求麦克风权限。关闭、离开频道或网络断开会停止本地音轨；语音不录制、不上传到应用服务器。
- 每个频道最多 8 人；猫队和鼠队频道按玩家队伍限制。网络断开后需要手动重新加入。
- 战绩排行保存在本机 `localStorage`，不会跨设备同步。

## 目录结构

```
index.html            SPA 入口
js/main.js            路由（hash SPA）+ 全局状态
js/platform/          wx.* 兼容层：storage / ui / geo / network
js/utils/             游戏规则、联机协议、语音管理等模块
js/views/             首页 / 大厅 / 游戏 / 结算 / 排行
css/                  各视图样式
vendor/               本地化 MapLibre GL
server/               Node WebSocket relay 与 ICE 凭证接口
deploy/               Nginx、systemd、Coturn、nftables 和部署手册
test/                 node:test 单测与浏览器 E2E 检查单
docs/                 移植文档、功能规格与实施计划
```

## 测试与浏览器走查

在仓库根目录执行：

```bash
node --test test/*.test.js
node --test server/test/*.test.js
```

浏览器全链路检查见 [`test/e2e-checklist.md`](test/e2e-checklist.md)。真实双设备语音还需要用户在浏览器允许麦克风，并使用两台设备或不同网络联调。

## Web 与小程序的对应方式

- 小程序实时文字消息由同房间 WebSocket relay 提供，聊天以纯文本渲染。
- 小程序语音房由浏览器 WebRTC mesh 实现；Coturn 为无法直连的网络提供媒体中继。
- 微信分享卡片改为复制应战链接并下载战报 PNG；扫码进房改为复制加入链接；相册保存改为浏览器下载。
- UDP / 局域网直连及微信专属 VoIP API 不适用于浏览器，Web 版使用 HTTPS/WSS 和 WebRTC。
