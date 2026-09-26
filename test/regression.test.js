import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 联机多端测试（2026-09-25）发现的回归项：这些缺陷均为一两行的关键修复，
// 用源码断言守住，避免后续重构时无声回退。行为级验证见 test/e2e-checklist.md。

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

test('regression: base.css 的 [hidden] 兜底规则存在', () => {
  // BUG: 组件 CSS 写死 display:flex 会覆盖 UA 的 [hidden] 规则，导致
  // 空邀请横幅/假「房间已创建」/结算空态遮挡榜单等 5 处显示缺陷
  const css = read('css/base.css');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('regression: MapView.create 必须传入 style，否则地图永不渲染', () => {
  // BUG: MapLibre 对无 style 的 Map 不调度渲染帧 → load 永不触发 → 瓦片源加不上
  const src = read('js/lib/map.js');
  const ctor = src.match(/new ml\.Map\(\{[\s\S]*?\}\);/);
  assert.ok(ctor, '未找到 new ml.Map(...) 构造调用');
  assert.match(ctor[0], /style:\s*\{\s*version:\s*8/);
});

test('regression: 默认底图不得使用已强制 API key 的 CARTO 瓦片', () => {
  // 外部服务变化: basemaps.cartocdn.com 免 key 瓦片自 2026-09 返回 "API KEY REQUIRED"
  // 占位图（HTTP 仍 200，单看状态码发现不了）
  const src = read('js/lib/map.js');
  assert.doesNotMatch(src, /basemaps\.cartocdn\.com/);
  assert.match(src, /tile\.openstreetmap\.org/);
});

test('regression: 默认底图必须是卫星图（OSM 街道图国内不可达）', () => {
  // BUG: OSM 街道瓦片在国内网络基本无法加载，默认底图改为 Esri 卫星瓦片
  //（免 key、WGS-84、国内可直连），OSM 降为可切换样式
  const src = read('js/lib/map.js');
  assert.match(src, /_satelliteCache = true/);           // 地图默认卫星图
  assert.match(src, /_handleBasemapError/);              // 街道图失败自动回退
  assert.match(src, /onBasemapFallback/);                // 回退通知视图层提示
  const game = read('js/views/game.js');
  assert.match(game, /satellite: true,/);                // 游戏视图初始状态与地图一致
  assert.match(game, /s\.satellite = true;/);
});

test('regression: 加入者路径不得在 connectServer.then 里导航进局', () => {
  // BUG: .then 与 joinSuccess 各 navigate('game') 一次 → 同视图重建触发
  // game.onHide → networkManager.disconnect()，加入者全程离线但 UI 显示在线
  const src = read('js/views/home.js');
  const branch = src.match(/networkManager\.connectServer\(\s*serverUrl,[\s\S]*?\.then\(\(\) => \{[\s\S]*?\}\)/);
  assert.ok(branch, '未找到加入者 connectServer(...) 调用块');
  assert.doesNotMatch(branch[0], /navigate\('game'\)/);
});

test('regression: 聊天面板底部锚点必须高于技能条顶沿', () => {
  // BUG: chat-wrapper bottom 150px < 技能条顶沿 190px，⌨️ 按钮落进技能条
  // 命中区（桌面被 .skill-bar、窄屏被 .glow-bg 挡住），聊天输入无法打开
  const css = read('css/game.css');
  const wrapper = css.match(/#view-game \.chat-wrapper \{[\s\S]*?\}/);
  assert.ok(wrapper, '未找到 .chat-wrapper 规则');
  const bottom = wrapper[0].match(/bottom:\s*calc\((\d+)px/);
  assert.ok(bottom, '未找到 .chat-wrapper 的 bottom 锚点');
  assert.ok(Number(bottom[1]) >= 190, `chat-wrapper bottom=${bottom[1]}px 仍与技能条(顶沿190px)重叠`);
});

test('regression: 迟入者计时对齐消息已接线（RECONNECT/SYNC_ROOM_STATE）', () => {
  // BUG: 每端从自己进局时刻各自倒计时，双端结束时刻不一致
  const game = read('js/views/game.js');
  assert.match(game, /networkManager\.on\(MSG_TYPES\.RECONNECT, netHandlers\.reconnectRequest\)/);
  assert.match(game, /networkManager\.on\(MSG_TYPES\.SYNC_ROOM_STATE, netHandlers\.syncRoomState\)/);
  // 加入者进局时发起对齐请求
  assert.match(game, /!isHost\)\s*\{\s*networkManager\.send\(MSG_TYPES\.RECONNECT/);
  // 协议中两个消息类型保持定义
  const protocol = read('js/utils/network/protocol.js');
  assert.match(protocol, /SYNC_ROOM_STATE:/);
  assert.match(protocol, /RECONNECT:/);
});

test('regression: 房主建房路径保存 lastNickname', () => {
  // BUG: createServerRoom 不写昵称存储，结算回首页后昵称丢失、开始按钮禁用
  const src = read('js/views/home.js');
  const fn = src.match(/const createServerRoom = \(\) => \{[\s\S]*?\n  \};/);
  assert.ok(fn, '未找到 createServerRoom 函数体');
  assert.match(fn[0], /setStorage\('lastNickname'/);
});

test('regression: game.onShow 按真实网络状态渲染联机状态灯', () => {
  // BUG: SERVER 模式无条件渲染「服务器联机 🟢」，断线重建视图后状态灯失真
  const src = read('js/views/game.js');
  const onShow = src.match(/const onShow = \(\) => \{[\s\S]*?const renderNetStatus|const onShow = \(\) => \{[\s\S]*?renderNetStatus\('服务器联机/);
  assert.ok(onShow, '未找到 onShow 中的网络状态渲染');
  assert.match(onShow[0], /networkManager\.state/);
  assert.doesNotMatch(onShow[0], /renderNetStatus\('服务器联机 🟢', 'dot-online'\);\s*\}/);
});
