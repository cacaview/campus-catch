import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 联机多端测试（2026-09-25）发现的回归项：这些缺陷均为一两行的关键修复，
// 用源码断言守住，避免后续重构时无声回退。行为级验证见 test/e2e-checklist.md。

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

test('regression: 暂停面板提供仅房主可用的继续按钮', () => {
  const src = read('js/views/game.js');
  assert.match(src, /id="game-resume" hidden>继续活动<\/button>/);
  assert.match(src, /\$\('game-resume'\)\.hidden = !s\.isHost/);
  assert.match(src, /\$\('game-resume'\)\.addEventListener\('click', \(\) => \{\s*if \(s\.isHost\) resumeGame\(\)/);
  assert.doesNotMatch(src, /点击顶部 👑 可继续活动/);
});

test('regression: 房主结束活动会同步结算，接收端不会重复广播', () => {
  const src = read('js/views/game.js');
  assert.match(src, /netHandlers\.gameEnd = \(\) => endGame\(true\)/);
  assert.match(src, /const endGame = \(fromNet = false\) => \{\s*if \(s\.gamePhase === 'END'\) return/);
  assert.match(src, /if \(!fromNet && s\.isHost && s\.netMode !== 'OFFLINE'\) \{\s*networkManager\.send\(MSG_TYPES\.GAME_END, \{\}\)/);
  assert.match(src, /networkManager\.on\(MSG_TYPES\.GAME_END, netHandlers\.gameEnd\)/);
  assert.match(src, /networkManager\.off\(MSG_TYPES\.GAME_END, netHandlers\.gameEnd\)/);
});

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

test('regression: 校园图片为默认底图且不依赖 CARTO 或 OSM 瓦片', () => {
  const src = read('js/lib/map.js');
  assert.doesNotMatch(src, /basemaps\.cartocdn\.com/);
  assert.doesNotMatch(src, /tile\.openstreetmap\.org/);
  assert.match(src, /assets\/campus-map\.jpg/);
});

test('regression: 入口和视图循环引用使用同一版本的 main 模块', () => {
  const index = read('index.html');
  const entry = index.match(/src="js\/main\.js\?v=([^"]+)"/);
  assert.ok(entry, 'main 模块入口缺少内容版本参数');
  const main = read('js/main.js');
  // Views import main.js back, so all must refresh with the same release.
  const viewVersions = Object.fromEntries(['home', 'lobby', 'game', 'result', 'rank'].map(view => [view, entry[1]]));
  for (const view of Object.keys(viewVersions)) {
    assert.match(read(`js/views/${view}.js`), new RegExp(`from ['"]\\.\\./main\\.js\\?v=${entry[1]}['"]`));
    assert.match(main, new RegExp(`from ['"]\\.\\/views\\/${view}\\.js\\?v=${viewVersions[view]}['"]`));
  }
});

test('regression: 默认校园图叠在卫星底图上，并可切换为纯卫星图', () => {
  const src = read('js/lib/map.js');
  assert.match(src, /_satelliteCache = false/);          // 默认校园图叠加模式
  assert.match(src, /setLayoutProperty\('satellite-layer', 'visibility', 'visible'\)/);
  assert.match(src, /'campus-map-layer'.*visibility/);   // 纯卫星模式隐藏校园图
  const game = read('js/views/game.js');
  assert.match(game, /satellite: false,/);               // 游戏视图初始状态与地图一致
  assert.match(game, /已切换校园图/);
});

test('regression: 首页框选地图固定在校园底图中心，不被设备 GPS 移出图片范围', () => {
  const home = read('js/views/home.js');
  const onShow = home.match(/const onShow = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(onShow, '未找到 home.onShow');
  assert.match(home, /let areaCenter = \{ \.\.\.DEFAULT_CENTER \}/);
  assert.match(onShow[1], /center:\s*\[areaCenter\.longitude, areaCenter\.latitude\]/);
  assert.doesNotMatch(onShow[1], /getLocation\(|map\.setCenter\(/);
});

test('regression: 首页载入时迁移旧校区中心保存的活动区域', () => {
  const home = read('js/views/home.js');
  assert.match(home, /LEGACY_CAMPUS_CENTER\s*=\s*\{\s*latitude:\s*25\.238236,\s*longitude:\s*110\.284419\s*\}/);
  assert.match(home, /from '\.\.\/utils\/game-area\.js\?v=mapfix-20261003a'/);
  assert.match(home, /from '\.\.\/lib\/map\.js\?v=mapblend-20261008opacity1'/);
  assert.match(home, /GameArea\.rebasePoints\(restored,\s*LEGACY_CAMPUS_CENTER,\s*DEFAULT_CENTER/);
  assert.match(home, /PREVIOUS_CAMPUS_CENTER\s*=\s*\{\s*latitude:\s*25\.096525,\s*longitude:\s*110\.273130\s*\}/);
  assert.match(home, /GameArea\.rebasePoints\(olderMigration,\s*PREVIOUS_CAMPUS_CENTER,\s*DEFAULT_CENTER/);
  assert.match(home, /if\s*\(migrated\s*!==\s*restored\)\s*saveConfig\(\)/);
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

test('regression: online join success enters the waiting lobby instead of starting gameplay', () => {
  const home = read('js/views/home.js');
  const start = home.indexOf("networkManager.on('joinSuccess'");
  const end = home.indexOf("networkManager.on('joinFail'", start);
  assert.ok(start >= 0 && end > start, '未找到 joinSuccess 处理器');
  const handler = home.slice(start, end);
  assert.match(handler, /navigate\('lobby'\)/);
  assert.doesNotMatch(handler, /navigate\('game'\)/);
});

test('regression: direct online game route is gated until the room is started', () => {
  const game = read('js/views/game.js');
  assert.match(game, /globalStateRef\.netMode === 'SERVER'\s*&&\s*roomSession\.phase !== 'STARTED'[\s\S]{0,100}navigate\('lobby'\)/);
  assert.match(game, /startCountdown\(netMode === 'SERVER'\s*\?\s*roomSession\.startAt\s*:\s*null\)/);
});

test('regression: redirecting a waiting room away from game preserves its socket', () => {
  const game = read('js/views/game.js');
  const onHide = game.match(/const onHide = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(onHide, '未找到 game.onHide');
  assert.match(onHide[1], /blockedEntry/);
  assert.match(onHide[1], /return;/);
});

test('regression: server gameplay begins at the relay deadline while location resolves independently', () => {
  const game = read('js/views/game.js');
  const startGame = game.match(/const startGame = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(startGame, '未找到 startGame 函数');
  assert.match(startGame[1], /s\.netMode === 'SERVER'[\s\S]*?beginPlaying\(\);[\s\S]*?getLocation\(/);
  assert.match(startGame[1], /clearInterval\(simMovementTimer\)/);

  const effects = [];
  const runStartGame = new Function(
    's', 'GameArea', 'gameArea', 'hasRealLocation', 'beginPlaying', 'getLocation',
    'simMovementTimer', 'clearInterval', 'applyLocation', 'startLocationWatch', 'showToast', 'viewActive', 'viewGeneration',
    `'use strict';\n${startGame[1]}`
  );
  assert.doesNotThrow(() => runStartGame(
    { netMode: 'SERVER' },
    { isValidArea: () => true },
    { type: 'polygon', points: [] },
    false,
    () => effects.push('begin'),
    handlers => { effects.push('request-location'); handlers.success({ latitude: 1, longitude: 2 }); },
    7,
    () => effects.push('clear-simulation'),
    () => effects.push('apply-location'),
    () => effects.push('watch-location'),
    () => effects.push('toast'),
    true, 1
  ));
  assert.deepEqual(effects, ['begin', 'request-location', 'clear-simulation', 'apply-location', 'watch-location']);
});

test('regression: lobby has separate online roster and offline AI controls', () => {
  const lobby = read('js/views/lobby.js');
  assert.match(lobby, /globalStateRef\.netMode === 'SERVER'/);
  assert.match(lobby, /networkManager\.on\(MSG_TYPES\.PLAYER_JOINED/);
  assert.match(lobby, /lobby-ai-stepper/);
  assert.match(lobby, /lobby-copy-link/);
});

test('regression: server lobby without a room returns to home with an explanation', () => {
  const lobby = read('js/views/lobby.js');
  const onShow = lobby.match(/const onShow = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(onShow, '未找到 lobby.onShow');
  assert.match(onShow[1], /globalStateRef\.netMode === 'SERVER'[\s\S]*?roomSession\.roomId[\s\S]*?navigate\('home'\)/);
});

test('regression: failed server room creation clears provisional room identity', () => {
  const home = read('js/views/home.js');
  const createRoom = home.match(/const createServerRoom = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(createRoom, '未找到 createServerRoom');
  assert.match(createRoom[1], /\.catch\(err => \{[\s\S]*?resetRoomAttempt\(\)/);
  assert.match(createRoom[1], /createIfMissingRoom:\s*true/);
  assert.match(home, /const resetRoomAttempt = \(\) => \{[\s\S]*?roomSession\.reset\(\)/);
});

test('regression: returning home after an online match clears the completed room session', () => {
  const result = read('js/views/result.js');
  const home = read('js/views/home.js');
  assert.match(result, /import \{ networkManager \} from '..\/utils\/network\/network-manager\.js'/);
  assert.match(result, /import \{ roomSession \} from '..\/utils\/network\/room-session\.js'/);
  const cleanup = result.match(/const leaveCompletedOnlineRoom = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(cleanup, '结算页缺少已结束联机房间清理');
  const handler = result.match(/const returnHome = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(handler, '结算页缺少统一的回首页处理');
  const onShow = result.match(/const onShow = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(onShow, '未找到 result.onShow');
  assert.match(onShow[1], /if \(!gameResult[\s\S]*?return;[\s\S]*?leaveCompletedOnlineRoom\(\)/);
  assert.match(result, /result-rank'\)\.addEventListener\('click',[\s\S]*?navigate\('rank'\)/);

  const effects = [];
  const globalStateRef = { netMode: 'SERVER', gameReady: true };
  const roomSession = { roomId: 'room-1', reset: () => effects.push('reset-room') };
  const networkManager = { disconnect: () => effects.push('disconnect') };
  const navigate = route => effects.push(`navigate:${route}`);
  let replacedUrl = '';
  const browserWindow = {
    location: { href: 'https://game.example/?server=wss%3A%2F%2Frelay.example%2Fws&passcode=1234#home' },
    history: {
      state: null,
      replaceState: (_state, _title, url) => { replacedUrl = String(url); }
    }
  };
  const returnHome = new Function(
    'globalStateRef', 'roomSession', 'networkManager', 'navigate', 'window',
    `'use strict';\nconst leaveCompletedOnlineRoom = () => {${cleanup[1]}\n};\n` +
      `const returnHome = () => {${handler[1]}\n};\nreturn returnHome;`
  )(globalStateRef, roomSession, networkManager, navigate, browserWindow);
  returnHome();
  assert.deepEqual(effects, ['disconnect', 'reset-room', 'navigate:home']);
  assert.equal(globalStateRef.netMode, 'OFFLINE');
  assert.equal(globalStateRef.gameReady, false);
  assert.equal(globalStateRef.clearRoomSessionOnHome, true);
  assert.ok(replacedUrl, '已使用完的邀请地址应从浏览器地址栏移除');
  const sanitizedUrl = new URL(replacedUrl, 'https://game.example');
  assert.equal(sanitizedUrl.searchParams.has('server'), false);
  assert.equal(sanitizedUrl.searchParams.has('passcode'), false);

  const homeOnShow = home.match(/const onShow = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(homeOnShow, '未找到 home.onShow');
  assert.match(homeOnShow[1], /clearRoomSessionOnHome[\s\S]*?netMode = 'OFFLINE'[\s\S]*?createdRoomPasscode = ''[\s\S]*?joinPasscode = ''/);
});

test('regression: 单机抓捕判定双模式共存（10 米范围，即时 / 3 秒持续）', () => {
  const src = read('js/views/game.js');
  assert.match(src, /const CATCH_PROXIMITY_MS = 3000;/);
  // 10 米开始判定（雷达扩大 25 米）；声呐外圈 20/40
  assert.match(src, /let catchRadius = 10;/);
  assert.match(src, /let sonarOuter = 20;/);
  assert.match(src, /catchRadius = 25;/);
  assert.match(src, /sonarOuter = 40;/);
  // 抓捕判定方式：读自主页面设置（instant / sustained，默认 sustained）
  assert.match(src, /s\.catchMode = getStorage\('catchMode'\) === 'instant' \? 'instant' : 'sustained';/);
  // 即时判定（源逻辑）：进入抓捕范围立即触发
  assert.match(src, /if \(s\.catchMode !== 'sustained'\) \{\s*resolveOfflineCatch\(ai, nowTs\);\s*return;/);
  // 抓捕结算公共逻辑：防连点冷却 → 金钟罩吸收 → 结果
  assert.match(src, /const resolveOfflineCatch = \(ai, nowTs\) => \{/);
  assert.match(src, /ai\._lastCatchAt && \(nowTs - ai\._lastCatchAt < 10000\)/);
  assert.match(src, /s\.isShieldActive[\s\S]*?护盾为你抵扣了一次抓捕/);
  // 3 秒持续判定：入范围启动窗口、出范围清零、满 3 秒才触发
  assert.match(src, /if \(!ai\._proximitySince\) \{\s*ai\._proximitySince = nowTs;/);
  assert.match(src, /if \(distApprox > catchRadius\) \{\s*ai\._proximitySince = 0;\s*return;/);
  assert.match(src, /if \(nowTs - ai\._proximitySince < CATCH_PROXIMITY_MS\) return;/);
  // 旧的「一入范围立即相遇」分支已移除
  assert.doesNotMatch(src, /else if \(distApprox <= catchRadius && !s\.showCatchOverlay\)/);
  // 进入抓捕范围有提示（猫：保持接近；鼠：快离开）
  assert.match(src, /保持接近 3 秒即可自动抓捕/);
  assert.match(src, /进入抓捕范围，快离开/);
});

test('regression: 联机抓捕由中继权威判定，客户端按 ID 记分', () => {
  const src = read('js/views/game.js');
  // CATCH_EVENT 客户端只读：护盾拦截提示 + 按 ID 记分
  assert.match(src, /if \(payload\.blocked\) \{/);
  assert.match(src, /String\(payload\.catId\) === String\(myId\)/);
  assert.match(src, /if \(payload\.success && isMyCat\) s\.myScore \+= 10;/);
  assert.match(src, /if \(!payload\.success && isMyMouse\) s\.myScore \+= 5;/);
  // onCatchEvent 支持 ID 归属判定
  assert.match(src, /const onCatchEvent = \(catName, mouseName, success, ids = null\) => \{/);
  assert.match(src, /const isMyCat = ids \? String\(ids\.catId\) === String\(myId\) : catName === s\.myName;/);

  const server = read('server/lib/room-registry.js');
  // 客户端伪造的 CATCH_EVENT 不再转发：白名单里没有它（只由中继广播）
  const packetTypes = server.match(/const GAME_PACKET_TYPES = new Set\(\[[\s\S]*?\]\);/);
  assert.ok(packetTypes, '中继缺少 GAME_PACKET_TYPES 转发白名单');
  assert.doesNotMatch(packetTypes[0], /CATCH_EVENT/);
  assert.match(server, /const CATCH_PROXIMITY_MS = 3000;/);
  assert.match(server, /const CATCH_PAIR_COOLDOWN_MS = 10_000;/);
  assert.match(server, /const CATCH_BASE_RADIUS_METERS = 10;/);
  assert.match(server, /const CATCH_RADAR_RADIUS_METERS = 25;/);
  // 判定方式：instant（入范围立即判定）/ sustained（3 秒持续，默认），由房主创建房间时设定
  assert.match(server, /const CATCH_MODE_INSTANT = 'instant';/);
  assert.match(server, /const CATCH_MODE_SUSTAINED = 'sustained';/);
  assert.match(server, /if \(room\.catchMode === CATCH_MODE_INSTANT\) \{/);
  assert.match(server, /catchMode: room\.catchMode,/);
  assert.match(server, /this\.evaluateProximityCatches\(room\);/);
  assert.match(server, /this\.resolveProximityCatch\(room, cat, mouse, key, now\);/);
});

test('regression: 主页面可设置抓捕判定方式（即时 / 3 秒持续）', () => {
  const home = read('js/views/home.js');
  // 主页面两个抓捕判定选项
  assert.match(home, /id="catch-mode-instant" data-catch-mode="instant"/);
  assert.match(home, /id="catch-mode-sustained" data-catch-mode="sustained"/);
  // 选择持久化到 localStorage，默认 sustained
  assert.match(home, /let catchMode = getStorage\('catchMode'\) === 'instant' \? 'instant' : 'sustained';/);
  assert.match(home, /setStorage\('catchMode', catchMode\); renderCatchMode\(\);/);
  // 创建房间时把判定方式带给中继
  assert.match(home, /createIfMissingRoom: true,\s*catchMode\s*\}/);
  const net = read('js/utils/network/network-manager.js');
  assert.match(net, /catchMode: options\.catchMode/);
  const session = read('js/utils/network/room-session.js');
  assert.match(session, /if \(payload\.catchMode === 'instant' \|\| payload\.catchMode === 'sustained'\) this\.catchMode = payload\.catchMode;/);
});

test('regression: 道具效果完整（猫薄荷透视 / 陷阱 3 秒 / 草丛隐身）', () => {
  const src = read('js/views/game.js');
  assert.match(src, /const CATNIP_XRAY_MS = 5000;/);
  assert.match(src, /const TRAP_DURATION_MS = 3000;/);
  assert.match(src, /const BUSH_DURATION_MS = 5000;/);
  // 猫薄荷：5 秒透视
  assert.match(src, /s\.xrayUntil = Math\.max\(s\.xrayUntil \|\| 0, Date\.now\(\) \+ CATNIP_XRAY_MS\);/);
  // 陷阱：3 秒被困，被困期间不计行为分
  assert.match(src, /s\.trapUntil = Date\.now\(\) \+ TRAP_DURATION_MS;/);
  assert.match(src, /const trapped = \(s\.trapUntil \|\| 0\) > Date\.now\(\);\s*if \(!trapped\) \{/);
  // 草丛：位置标记隐藏 5 秒（不缩短已有匿影藏形）
  assert.match(src, /s\.stealthUntil = Math\.max\(s\.stealthUntil \|\| 0, Date\.now\(\) \+ BUSH_DURATION_MS\);/);
  // 状态含 trapUntil 且开局清零
  assert.match(src, /trapUntil: 0,/);
  assert.match(src, /s\.trapUntil = 0;/);
});
