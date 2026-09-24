// js/views/game.js — 游戏视图（源 pages/game/game.js 1286 行移植）
// Web 裁剪：删语音频道 8 方法 + 2 网络事件 + 8 数据字段；tool-voice 提示用文字聊天
// wx→platform：getLocation→geo，showModal/showActionSheet→ui（Promise 化），地图→MapLibre 封装
import { navigate, DEFAULT_CENTER } from '../main.js';
import { showToast, showModal, showActionSheet } from '../platform/ui.js';
import { getLocation, startLocationUpdate, stopLocationUpdate } from '../platform/geo.js';
import { createMap } from '../lib/map.js';
import { networkManager } from '../utils/network/network-manager.js';
import { roomSession } from '../utils/network/room-session.js';
import { MSG_TYPES } from '../utils/network/protocol.js';
import SkillSystem from '../utils/skill-system.js';
import { MapItemsManager, ITEM_TYPES } from '../utils/map-items.js';
import soundVibration from '../utils/sound-vibration.js';
import { achievementManager } from '../utils/achievement.js';
import { shopManager } from '../utils/shop.js';
import GameArea from '../utils/game-area.js';
import AIPlayerController from '../utils/ai-player.js';

const ITEM_COLORS = {
  [ITEM_TYPES.CHEESE]: '#ffa500',
  [ITEM_TYPES.CATNIP]: '#4cd137',
  [ITEM_TYPES.TRAP]: '#e84118',
  [ITEM_TYPES.BUSH]: '#718093'
};

const GAME_HTML = `
  <div id="game-map"></div>

  <!-- 越界警告 -->
  <div class="boundary-warning" id="game-boundary" hidden>
    <span class="boundary-icon">⚠</span>
    <span class="bw-text">
      <span class="boundary-title">你已离开活动区域</span>
      <span class="boundary-sub">请返回黄色边界内，期间暂停计分和同步</span>
    </span>
  </div>

  <!-- 标题水印 -->
  <div class="watermark">
    <div class="watermark-title">校园定位活动</div>
    <div class="watermark-subtitle">
      <span class="net-status-dot dot-offline" id="game-net-dot"></span>
      <span id="game-net-text">单机模式</span>
    </div>
  </div>

  <!-- 顶部 HUD -->
  <div class="top-hud">
    <div class="hud-item">🏃 <span id="game-distance">0</span>m</div>
    <div class="hud-item timer" id="game-timer-box">⏱ <span id="game-timer">10:00</span></div>
    <div class="hud-item hud-btn host-btn" id="game-host-btn">👑</div>
    <div class="hud-item hud-btn backpack-btn" id="game-backpack-btn">🃏</div>
  </div>

  <!-- 战况速报悬浮层 -->
  <div class="battle-feed" id="game-feed"></div>

  <!-- 暂停遮罩 -->
  <div class="pause-overlay" id="game-pause" hidden>
    <div class="pause-card">
      <span class="pause-icon">⏸</span>
      <span class="pause-title">活动已暂停</span>
      <span class="pause-sub" id="game-pause-sub"></span>
    </div>
  </div>

  <!-- 倒计时遮罩 -->
  <div class="countdown-overlay" id="game-countdown" hidden>
    <span class="countdown-text" id="game-countdown-num">3</span>
  </div>

  <!-- 右侧工具栏 -->
  <div class="right-toolbar">
    <div class="toolbar-container">
      <button class="tool-btn" id="tool-view"><span class="icon">⊞</span><span class="label">视图</span></button>
      <button class="tool-btn" id="tool-scan"><span class="icon">🔍</span><span class="label">扫描</span></button>
      <button class="tool-btn" id="tool-rank"><span class="icon">🏆</span><span class="label">排行</span></button>
      <button class="tool-btn" id="tool-radar"><span class="icon">👁</span><span class="label">雷达</span></button>
      <button class="tool-btn" id="tool-track"><span class="icon">🎯</span><span class="label">追踪</span></button>
      <button class="tool-btn" id="tool-voice"><span class="icon">🎙️</span><span class="label">语音</span></button>
    </div>
  </div>

  <!-- 聊天面板 -->
  <div class="chat-wrapper">
    <div class="chat-container">
      <div class="chat-scroll" id="game-chat-scroll">
        <div class="message-list" id="game-chat-list"></div>
      </div>
      <div class="chat-input-bar" id="game-chat-inputbar">
        <input id="game-chat-input" placeholder="输入消息..." maxlength="50" />
        <button id="game-chat-send">发送</button>
      </div>
      <div class="chat-toggle-btn" id="game-chat-toggle">⌨️</div>
    </div>
  </div>

  <!-- 技能栏 -->
  <div class="skill-bar"><div class="skill-list" id="game-skills"></div></div>

  <!-- 抓捕覆盖层 -->
  <div class="catch-overlay" id="game-catch" hidden>
    <div class="catch-content"><span class="catch-text" id="game-catch-msg"></span></div>
  </div>

  <!-- 实时排名弹窗 -->
  <div class="rank-mask" id="game-rank-mask" hidden>
    <div class="rank-modal">
      <div class="rank-modal-title">🏆 本局实时排名</div>
      <div class="rank-modal-list" id="game-rank-list"></div>
      <div class="rank-modal-tip" id="game-rank-tip" hidden>🔍 扫描暴露中，金色标记为暴露的敌人</div>
      <button class="m-btn confirm rank-close" id="game-rank-close">关闭</button>
    </div>
  </div>`;

export function create(rootEl, globalStateRef) {
  const $ = id => document.getElementById(id);
  rootEl.innerHTML = GAME_HTML;

  /* ---------- 状态（源 data 对象 1:1，去语音字段） ---------- */
  const s = {
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    gamePhase: 'WAITING',
    countdown: 3,
    remainingTime: 600,
    timerText: '10:00',
    netMode: 'OFFLINE',
    netStatusText: '单机模式',
    netStatusClass: 'dot-offline',
    myTeam: 'mouse',
    myName: '玩家',
    myScore: 0,
    distance: 0,
    equippedTitle: '',
    skills: [],
    battleFeed: [],
    chatMessages: [],
    isOutsideArea: false,
    showCatchOverlay: false,
    catchMessage: '',
    showSkillBackpack: false,
    radarActive: false,
    isShieldActive: false,
    isStealthActive: false,
    stealthUntil: 0,
    disguiseUntil: 0,
    xrayUntil: 0,
    decoyUntil: 0,
    radarUntil: 0,
    satellite: false,
    scanUntil: 0,
    showRankModal: false,
    liveRank: [],
    isHost: false,
    isPaused: false
  };

  /* ---------- 实例字段（源 this._xxx） ---------- */
  let map = null;
  let aiPlayers = [];
  let gameArea = null;
  let countdownTimer = null;
  let gameTimer = null;
  let gameTickTimer = null;
  let simMovementTimer = null;
  const pendingTimers = [];
  let skillUsed = 0;
  let actionCount = 0;
  let myCatches = 0;
  let myEscapes = 0;
  let track = [];
  let lastTrackAt = 0;
  let tickCount = 0;
  let lastSonarAt = 0;
  let catchCdUntil = 0;
  let hasRealLocation = false;
  let lastLat = null;
  let lastLng = null;
  let totalDuration = 600;
  let scanCdMs = 30000;
  let scanCdUntil = 0;
  let cheeseMultiplier = 1;
  let startShield = false;

  // 网络监听引用（off 需按引用解绑，与源 setup/removeNetworkListeners 一致）
  let netHandlers = {};

  const later = (fn, ms) => {
    const id = setTimeout(fn, ms);
    pendingTimers.push(id);
    return id;
  };

  /* ---------- 渲染函数（对应源各 setData 簇） ---------- */

  const renderHud = () => {
    $('game-distance').textContent = s.distance;
    $('game-timer').textContent = s.timerText;
    $('game-timer-box').classList.toggle('timer-danger', s.remainingTime < 60);
  };

  const renderPhase = () => {
    $('game-countdown').hidden = s.gamePhase !== 'COUNTDOWN';
    $('game-countdown-num').textContent = s.countdown;
    $('game-pause').hidden = !s.isPaused;
    $('game-pause-sub').textContent = s.isHost ? '点击顶部 👑 可继续活动' : '等待房主恢复活动…';
  };

  const renderNetStatus = (text, cls) => {
    $('game-net-text').textContent = text;
    $('game-net-dot').className = 'net-status-dot ' + cls;
  };

  const renderBoundary = () => { $('game-boundary').hidden = !s.isOutsideArea; };

  const renderFeed = () => {
    $('game-feed').innerHTML = s.battleFeed.map(m => `<div class="feed-item">${m.text}</div>`).join('');
  };

  // 源 updateMarkers L756-851 → Web 标记形状
  const renderMarkers = () => {
    if (!map) return;
    const now = Date.now();
    const isCat = s.myTeam === 'cat';
    const stealthOn = (s.stealthUntil || 0) > now;
    const disguiseOn = (s.disguiseUntil || 0) > now;
    const xrayOn = (s.xrayUntil || 0) > now;
    const decoyOn = (s.decoyUntil || 0) > now;
    const radarOn = (s.radarUntil || 0) > now;
    const scanOn = (s.scanUntil || 0) > now;

    const markers = [];

    // 玩家自身标记：隐身时隐藏，伪装时显示为猫阵营
    if (!stealthOn) {
      const selfCat = disguiseOn ? true : isCat;
      markers.push({
        id: 1,
        latitude: s.latitude,
        longitude: s.longitude,
        icon: selfCat ? '🐱' : '🐭',
        label: `${s.myName || '我'}（我）`,
        color: selfCat ? '#ff3366' : '#33ccff',
        self: true
      });
    }

    // AI / 联机玩家标记：火眼金睛/猫咪热感/扫描 高亮全部敌人
    (aiPlayers || []).forEach(p => {
      const pCat = p.team === 'cat';
      const enemy = pCat !== isCat;
      const emoji = pCat ? '🐱' : '🐭';

      let numId = 100;
      if (typeof p.id === 'number') {
        numId = p.id;
      } else {
        const parsed = parseInt(String(p.id).replace(/\D/g, ''), 10);
        numId = isNaN(parsed) ? Math.floor(Math.random() * 899 + 100) : parsed;
      }

      const highlight = (xrayOn && enemy) || (radarOn && enemy) || (scanOn && enemy);
      markers.push({
        id: Number(numId),
        latitude: p.latitude,
        longitude: p.longitude,
        icon: emoji,
        label: p.name,
        sub: `${p.score}分${highlight ? '\n🎯 锁定' : ''}`,
        color: highlight ? '#ffd700' : (pCat ? '#ff3366' : '#33ccff'),
        highlight
      });
    });

    // 声东击西诱饵标记
    if (decoyOn) {
      markers.push({
        id: 999,
        latitude: s.latitude + 0.00045,
        longitude: s.longitude + 0.0003,
        icon: '🎭',
        label: `${s.myName || '我'}（诱饵）`,
        color: '#8e44ad'
      });
    }

    // 道具 / 陷阱标记（MapItemsManager 已返回 Web 形状）
    MapItemsManager.getMapMarkers().forEach(m => {
      markers.push({
        id: m.id,
        latitude: m.latitude,
        longitude: m.longitude,
        icon: m.icon,
        label: m.name,
        color: ITEM_COLORS[m.type] || '#ffffff'
      });
    });

    map.setMarkers(markers);
  };

  const renderSkills = () => {
    $('game-skills').innerHTML = s.skills.map(sk => {
      const cls = sk.type === 'MOUSE' ? 'mouse' : sk.type === 'CAT' ? 'cat' : 'neutral';
      const disabled = !SkillSystem.isSkillAvailable(sk);
      const depleted = sk.usesLeft <= 0;
      return `<div class="skill-card ${cls}${disabled ? ' disabled' : ''}${depleted ? ' depleted' : ''}" data-skill="${sk.id}">
        <div class="glow-bg"></div>
        <div class="icon-container"><span class="emoji-icon">${sk.icon}</span></div>
        <div class="info"><span class="name">${sk.name}</span><div class="uses-counter">${sk.usesLeft}/${sk.maxUses}</div></div>
        ${depleted ? '<div class="overlay"><span class="crossed">❌</span></div>' : ''}
      </div>`;
    }).join('');
  };

  const renderChat = () => {
    $('game-chat-list').innerHTML = s.chatMessages.map(m =>
      `<div class="message-item ${m.type === 'notification' ? 'notification' : 'chat'}">
         <div class="message-content">
           <span class="prefix">${m.type === 'notification' ? '📢' : '💬'}</span>
           ${m.type === 'chat' ? `<span class="sender">${m.sender}:</span>` : ''}
           <span class="text">${m.text}</span>
         </div>
       </div>`).join('');
    $('game-chat-scroll').classList.toggle('has-msg', s.chatMessages.length > 0);
    const list = $('game-chat-list');
    list.scrollTop = list.scrollHeight;
  };

  const renderRankModal = () => {
    $('game-rank-mask').hidden = !s.showRankModal;
    if (s.showRankModal) {
      $('game-rank-list').innerHTML = s.liveRank.map(r =>
        `<div class="rank-modal-row ${r.isMe ? 'me' : ''}">
           <span class="rk-num ${r.top3 ? 'top3' : ''}">${r.rank}</span>
           <span class="rk-avatar">${r.team === 'cat' ? '🐱' : '🐭'}</span>
           <span class="rk-name">${r.name}${r.isMe ? '（我）' : ''}</span>
           <span class="rk-score">${r.score} 分</span>
         </div>`).join('');
      $('game-rank-tip').hidden = (s.scanUntil || 0) <= Date.now();
    }
  };

  const renderCatch = () => {
    $('game-catch').hidden = !s.showCatchOverlay;
    $('game-catch-msg').textContent = s.catchMessage;
  };

  /* ---------- 消息 ---------- */

  // 系统战况速报：独立悬浮层，最多 4 条，8 秒自动淡出（源 L1193-1200）
  const addSystemMessage = text => {
    const item = { id: Date.now() + Math.random(), text, ts: Date.now() };
    s.battleFeed = [...s.battleFeed, item].slice(-4);
    renderFeed();
    later(() => {
      s.battleFeed = s.battleFeed.filter(m => m.id !== item.id);
      renderFeed();
    }, 8000);
  };

  // 玩家聊天：只进聊天面板，保留 8 条（源 L1203-1214）
  const addChatMessage = (sender, text) => {
    const newMsg = { id: Date.now() + Math.random(), type: 'chat', text, sender, timestamp: Date.now() };
    s.chatMessages = [...s.chatMessages, newMsg];
    if (s.chatMessages.length > 8) s.chatMessages = s.chatMessages.slice(-8);
    renderChat();
  };

  /* ---------- 网络监听（源 L208-341，去语音 2 个；按引用解绑） ---------- */

  const setupNetworkListeners = () => {
    netHandlers.stateChange = ({ state, mode }) => {
      let statusText = '单机模式';
      let dotClass = 'dot-offline';
      if (mode === 'SERVER') {
        statusText = '服务器联机 🟢';
        dotClass = 'dot-online';
      }
      if (state === 'CONNECTING') {
        statusText = '正在连接... 🟡';
        dotClass = 'dot-connecting';
      } else if (state === 'RECONNECTING') {
        statusText = '断线自动重连中... 🟡';
        dotClass = 'dot-connecting';
      } else if (state === 'DISCONNECTED' && mode !== 'OFFLINE') {
        statusText = '连接已断开 🔴';
        dotClass = 'dot-disconnected';
      }
      renderNetStatus(statusText, dotClass);
    };

    netHandlers.playerMove = payload => {
      if (payload && payload.id) updateRemotePlayerPosition(payload);
    };

    netHandlers.catchEvent = payload => {
      if (payload) onCatchEvent(payload.catName, payload.mouseName, payload.success);
    };

    netHandlers.chatMessage = payload => {
      if (payload && payload.sender) addChatMessage(payload.sender, payload.text);
    };

    netHandlers.gamePause = payload => {
      if (payload && typeof payload.paused === 'boolean' && payload.paused !== s.isPaused) {
        setPaused(payload.paused, true);
      }
    };

    netHandlers.gameExtend = payload => {
      const seconds = Number(payload && payload.seconds) || 0;
      if (seconds > 0) applyExtend(seconds, true);
    };

    netHandlers.playerKick = payload => {
      if (!payload) return;
      const myId = (globalStateRef.currentPlayer && globalStateRef.currentPlayer.id) || 'me';
      if (String(payload.playerId) === String(myId)) {
        showModal({ title: '你被房主移出了本局', content: '可回到首页重新加入其他房间', showCancel: false })
          .then(() => navigate('home'));
        return;
      }
      aiPlayers = (aiPlayers || []).filter(p => String(p.id) !== String(payload.playerId));
      addSystemMessage(`👑 房主移除了玩家 ${payload.name || payload.playerId}`);
      renderMarkers();
    };

    networkManager.on('stateChange', netHandlers.stateChange);
    networkManager.on(MSG_TYPES.PLAYER_MOVE, netHandlers.playerMove);
    networkManager.on(MSG_TYPES.CATCH_EVENT, netHandlers.catchEvent);
    networkManager.on(MSG_TYPES.CHAT_MESSAGE, netHandlers.chatMessage);
    networkManager.on(MSG_TYPES.GAME_PAUSE, netHandlers.gamePause);
    networkManager.on(MSG_TYPES.GAME_EXTEND, netHandlers.gameExtend);
    networkManager.on(MSG_TYPES.PLAYER_KICK, netHandlers.playerKick);
  };

  const removeNetworkListeners = () => {
    if (netHandlers.stateChange) networkManager.off('stateChange', netHandlers.stateChange);
    if (netHandlers.playerMove) networkManager.off(MSG_TYPES.PLAYER_MOVE, netHandlers.playerMove);
    if (netHandlers.catchEvent) networkManager.off(MSG_TYPES.CATCH_EVENT, netHandlers.catchEvent);
    if (netHandlers.chatMessage) networkManager.off(MSG_TYPES.CHAT_MESSAGE, netHandlers.chatMessage);
    if (netHandlers.gamePause) networkManager.off(MSG_TYPES.GAME_PAUSE, netHandlers.gamePause);
    if (netHandlers.gameExtend) networkManager.off(MSG_TYPES.GAME_EXTEND, netHandlers.gameExtend);
    if (netHandlers.playerKick) networkManager.off(MSG_TYPES.PLAYER_KICK, netHandlers.playerKick);
    netHandlers = {};
  };

  const updateRemotePlayerPosition = player => {
    let found = false;
    aiPlayers = (aiPlayers || []).map(p => {
      if (p.id === player.id) {
        found = true;
        return { ...p, latitude: player.latitude, longitude: player.longitude, score: player.score || p.score };
      }
      return p;
    });
    if (!found) {
      aiPlayers.push({
        id: player.id,
        name: player.name || '联机玩家',
        team: player.team || 'cat',
        latitude: player.latitude,
        longitude: player.longitude,
        score: player.score || 0
      });
    }
    renderMarkers();
  };

  /* ---------- 游戏流程 ---------- */

  const startCountdown = () => {
    s.gamePhase = 'COUNTDOWN';
    s.countdown = 3;
    renderPhase();
    soundVibration.playSound('countdown');
    countdownTimer = setInterval(() => {
      const current = s.countdown - 1;
      if (current <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        startGame();
      } else {
        s.countdown = current;
        renderPhase();
      }
    }, 1000);
  };

  // 源 startGame L563-599；Web：定位失败不再卡死，进入模拟移动模式
  const startGame = () => {
    if (GameArea.isValidArea(gameArea) && !hasRealLocation) {
      getLocation({
        success: loc => {
          hasRealLocation = true;
          applyLocation(loc);
          startGame();
        },
        fail: () => {
          // Web 桌面/无授权：无真实 GPS → 模拟移动继续（源微信版失败时停在 WAITING）
          showToast({ title: '未获取定位，进入模拟移动模式', icon: 'none' });
          beginPlaying();
        }
      });
      return;
    }
    beginPlaying();
  };

  const beginPlaying = () => {
    if (GameArea.isValidArea(gameArea) && !GameArea.contains(gameArea, { latitude: s.latitude, longitude: s.longitude })) {
      s.gamePhase = 'WAITING';
      s.isOutsideArea = true;
      renderPhase();
      renderBoundary();
      addSystemMessage('你当前不在房主框选的活动区域内，请进入黄色边界后开始。');
      startLocationWatch();
      return;
    }
    s.gamePhase = 'PLAYING';
    renderPhase();
    addSystemMessage('活动开始！请在现实中跑起来！靠近对方 10 米触发定位相遇（打卡）！');

    // 商店道具「开局金钟罩」
    if (startShield) {
      startShield = false;
      s.isShieldActive = true;
      addSystemMessage('🛡️ 商店道具 [开局金钟罩] 已自动开启 10 秒！');
      later(() => { s.isShieldActive = false; }, 10000);
    }

    gameTimer = setInterval(() => updateTimer(), 1000);
    gameTickTimer = setInterval(() => gameTick(), 1500);
    startLocationWatch();
  };

  const clearAllTimers = () => {
    if (countdownTimer) clearInterval(countdownTimer);
    if (gameTimer) clearInterval(gameTimer);
    if (gameTickTimer) clearInterval(gameTickTimer);
    if (simMovementTimer) clearInterval(simMovementTimer);
    countdownTimer = gameTimer = gameTickTimer = simMovementTimer = null;
    pendingTimers.forEach(id => clearTimeout(id));
    pendingTimers.length = 0;
  };

  // 模拟移动（源 startLocationWatch fail 分支 L888-898）
  const startSimulatedMovement = () => {
    console.warn('no real location, using simulated movement');
    simMovementTimer = setInterval(() => {
      s.latitude += (Math.random() - 0.5) * 0.0001;
      s.longitude += (Math.random() - 0.5) * 0.0001;
      s.distance += Math.floor(Math.random() * 5);
      renderHud();
      recordTrackPoint(s.latitude, s.longitude);
      achievementManager.updateProgress(5, false);
    }, 2000);
  };

  // 源 startLocationWatch L854-900 → Web：watchPosition 回调即定位流
  const startLocationWatch = () => {
    if (!hasRealLocation) {
      // 从未拿到真实定位（桌面/无授权）→ 直接模拟移动
      startSimulatedMovement();
      return;
    }
    const ok = startLocationUpdate(loc => {
      if (!hasRealLocation) hasRealLocation = true;
      if (lastLat != null && lastLng != null) {
        // Haversine 累计（源 L866-879 原样：1~150m 区间才计里程）
        const R = 6371e3;
        const dLat = (loc.latitude - lastLat) * Math.PI / 180;
        const dLng = (loc.longitude - lastLng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lastLat * Math.PI / 180) * Math.cos(loc.latitude * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const d = R * c;
        if (d >= 1 && d <= 150) {
          s.distance += Math.round(d);
          renderHud();
          achievementManager.updateProgress(Math.round(d), false);
        }
      }
      lastLat = loc.latitude;
      lastLng = loc.longitude;
      applyLocation(loc);
    });
    if (!ok) startSimulatedMovement();
  };

  // 足迹回放采样：移动 ≥3 米或距上次采样 ≥5 秒才记录，上限 800 点（源 L903-917 原样）
  const recordTrackPoint = (latitude, longitude, force) => {
    if (s.gamePhase !== 'PLAYING') return;
    const now = Date.now();
    const last = track[track.length - 1];
    if (!force) {
      if (last && now - (lastTrackAt || 0) < 5000) {
        const d = GameArea.distanceMeters(last, { latitude, longitude });
        if (d < 3) return;
      }
    }
    track.push({ latitude: Number(latitude), longitude: Number(longitude), t: now });
    lastTrackAt = now;
    track = track.length > 800 ? track.slice(track.length - 800) : track;
  };

  // 源 applyLocation L919-932 原样
  const applyLocation = loc => {
    const outside = GameArea.isValidArea(gameArea) && !GameArea.contains(gameArea, loc);
    const wasOutside = s.isOutsideArea;
    s.latitude = loc.latitude;
    s.longitude = loc.longitude;
    s.isOutsideArea = outside;
    renderBoundary();
    renderHud();
    if (!outside) recordTrackPoint(loc.latitude, loc.longitude);
    if (outside && !wasOutside) {
      addSystemMessage('⚠️ 已离开活动区域：暂停计分、拾取与位置同步。');
      soundVibration.vibrateLong();
    } else if (!outside && wasOutside) {
      addSystemMessage('✅ 已回到活动区域，活动继续。');
      if (s.gamePhase === 'WAITING') startGame();
    }
    renderMarkers();
  };

  /* ---------- 主循环（源 gameTick L608-725 原样移植） ---------- */

  const gameTick = () => {
    if (s.isOutsideArea || s.isPaused) return;
    let changed = false;

    const currentPos = { latitude: s.latitude, longitude: s.longitude };
    const pickedItem = MapItemsManager.checkItemPickup(currentPos, s.myTeam === 'cat');

    if (pickedItem) {
      soundVibration.playSound('skill_used');
      const pickGain = 10 * (cheeseMultiplier || 1);
      if (pickedItem.type === 'CHEESE') {
        s.myScore += pickGain;
        addSystemMessage(`🧀 真实打卡 [能量奶酪]，积分 +${pickGain}！`);
      } else if (pickedItem.type === 'CATNIP') {
        s.myScore += pickGain;
        addSystemMessage(`🌿 拾取 [猫薄荷]，积分 +${pickGain}！`);
      } else if (pickedItem.type === 'TRAP') {
        soundVibration.playSound('trap_triggered');
        addSystemMessage('🪤 警报！你踩中了 [捕鼠陷阱] 区域！广播暴露位置！');
      } else if (pickedItem.type === 'BUSH') {
        addSystemMessage('🌫️ 你进入了 [隐蔽草丛]，位置标记遮蔽');
      }
      renderHud();
      changed = true;
    }

    if (s.netMode === 'OFFLINE') {
      // 行为快照：AI 感知玩家与彼此
      const snapshot = [
        { latitude: s.latitude, longitude: s.longitude, team: s.myTeam },
        ...aiPlayers
      ];
      aiPlayers.forEach(ai => {
        const move = AIPlayerController.updateAI(ai, snapshot);
        ai.latitude = move.latitude;
        ai.longitude = move.longitude;
        if (move.chat) addChatMessage(ai.name, move.chat);
        changed = true;

        // 真实 GPS 物理接近抓捕检测（源 L648-695 原样：同阵营不触发）
        const pCat = ai.team === 'cat';
        if (pCat === (s.myTeam === 'cat')) return;
        const dLat = Math.abs(ai.latitude - s.latitude);
        const dLng = Math.abs(ai.longitude - s.longitude);
        const distApprox = Math.sqrt(dLat * dLat + dLng * dLng) * 111320;
        let catchRadius = 15;
        let sonarOuter = 30;
        if ((s.myTeam === 'cat') && (s.radarUntil || 0) > Date.now()) {
          catchRadius = 40;
          sonarOuter = 60;
        }

        // 指向性声呐脉冲 + 抓捕防连击（源原样）
        const sonarNow = Date.now();
        if (distApprox < sonarOuter && distApprox > catchRadius && sonarNow - (lastSonarAt || 0) > 900) {
          lastSonarAt = sonarNow;
          soundVibration.vibrateShort(distApprox < catchRadius * 1.6 ? 'heavy' : 'light');
        } else if (distApprox <= catchRadius && !s.showCatchOverlay) {
          const nowTs = Date.now();
          if ((catchCdUntil || 0) > nowTs) return;
          if (ai._lastCatchAt && (nowTs - ai._lastCatchAt < 10000)) return;
          catchCdUntil = nowTs + 3000;
          ai._lastCatchAt = nowTs;
          if (s.isShieldActive) {
            s.isShieldActive = false;
            addSystemMessage('🛡️ [金钟罩] 护盾为你抵扣了一次相遇！');
            soundVibration.vibrateShort('heavy');
          } else {
            const isCat = s.myTeam === 'cat';
            const catName = isCat ? s.myName : ai.name;
            const mouseName = isCat ? ai.name : s.myName;
            const success = isCat || Math.random() < 0.3;

            if (success) {
              soundVibration.playSound('catch_success');
              if (isCat) { s.myScore += 10; renderHud(); }
            } else {
              soundVibration.playSound('escape_success');
              if (!isCat) { s.myScore += 5; renderHud(); }
            }
            onCatchEvent(catName, mouseName, success);
          }
        }
      });
    }

    if (s.netMode !== 'OFFLINE') {
      networkManager.send(MSG_TYPES.PLAYER_MOVE, {
        id: (globalStateRef.currentPlayer && globalStateRef.currentPlayer.id) || 'player_1',
        name: s.myName,
        team: s.myTeam,
        latitude: s.latitude,
        longitude: s.longitude,
        score: s.myScore
      });
    }

    // 行为分：鼠存活 +2 / 猫巡逻 +1，每 30 秒一跳（源 L710-720 原样）
    tickCount = (tickCount || 0) + 1;
    if (tickCount % 20 === 0 && s.gamePhase === 'PLAYING') {
      const myGain = s.myTeam === 'mouse' ? 2 : 1;
      s.myScore += myGain;
      (aiPlayers || []).forEach(ai => {
        ai.score += ai.team === 'mouse' ? 2 : 1;
      });
      renderHud();
      changed = true;
    }

    if (changed) renderMarkers();
  };

  // AI 补位（源 initMockAIPlayers L727-754 原样）
  const initMockAIPlayers = () => {
    const areaCenter = GameArea.center(gameArea) ||
      { latitude: s.latitude, longitude: s.longitude };
    const near = (dx, dy) => ({
      latitude: areaCenter.latitude + dy,
      longitude: areaCenter.longitude + dx
    });
    const count = Math.max(0, Math.min(5, Number(globalStateRef.aiFillCount != null ? globalStateRef.aiFillCount : 3)));
    const roster = [
      { name: 'AI猫-汤姆', team: 'cat' },
      { name: 'AI鼠-杰瑞', team: 'mouse' },
      { name: 'AI鼠-泰菲', team: 'mouse' },
      { name: 'AI猫-斯派克', team: 'cat' },
      { name: 'AI鼠-布奇', team: 'mouse' }
    ];
    const offsets = [[0.0004, -0.0002], [-0.0003, 0.0003], [0.0002, 0.0005], [-0.0005, -0.0004], [0.0006, 0.0003]];
    aiPlayers = roster.slice(0, count).map((r, i) => ({
      id: 101 + i,
      name: r.name,
      team: r.team,
      ...near(offsets[i][0], offsets[i][1]),
      score: 0
    }));
    renderMarkers();
  };

  /* ---------- 积分商店道具进局生效（源 L158-195 原样） ---------- */

  const applyShopItems = teamSkills => {
    try {
      const extraPacks = shopManager.getOwned('extra_skill');
      if (extraPacks > 0) {
        for (let i = 0; i < extraPacks; i++) shopManager.consume('extra_skill');
        s.skills = (teamSkills || s.skills).map(sk => ({ ...sk, usesLeft: sk.usesLeft + extraPacks }));
        renderSkills();
        addSystemMessage(`🎁 技能补给包生效：所有技能次数 +${extraPacks}！`);
      }
      if (shopManager.getOwned('start_shield') > 0) {
        shopManager.consume('start_shield');
        startShield = true;
      }
      if (shopManager.getOwned('scan_boost') > 0) {
        shopManager.consume('scan_boost');
        scanCdMs = 15000;
        addSystemMessage('📡 扫描增强器生效：全图扫描冷却减半！');
      } else {
        scanCdMs = 30000;
      }
      if (shopManager.getOwned('double_cheese') > 0) {
        shopManager.consume('double_cheese');
        cheeseMultiplier = 2;
        addSystemMessage('🧀 奶酪双倍卡生效：打卡积分翻倍！');
      } else {
        cheeseMultiplier = 1;
      }
    } catch (e) {
      console.warn('[Game] shop items apply failed', e);
      scanCdMs = 30000;
      cheeseMultiplier = 1;
    }
  };

  /* ---------- 技能（源 onSkillUse L935-991 原样） ---------- */

  const onSkillUse = skillId => {
    const skill = s.skills.find(sk => sk.id === skillId);
    if (!skill) return;
    if (s.gamePhase !== 'PLAYING') {
      showToast({ title: '本局已结束，技能失效', icon: 'none' });
      return;
    }
    if (skill.usesLeft <= 0) {
      showToast({ title: '次数用尽', icon: 'none' });
      return;
    }

    soundVibration.playSound('skill_used');
    showToast({ title: `释放 GPS 技能 [${skill.name}]`, icon: 'none' });

    skillUsed = (skillUsed || 0) + 1;
    achievementManager.recordSkillUse();

    const now = Date.now();
    if (skill.id === 'stealth') {
      s.isStealthActive = true;
      s.stealthUntil = now + 15000;
      addSystemMessage('🌫️ [匿影藏形] 已开启，你的 GPS 标记隐藏 15 秒！');
      renderMarkers();
      later(() => { s.isStealthActive = false; s.stealthUntil = 0; renderMarkers(); }, 15000);
    } else if (skill.id === 'golden_shield') {
      s.isShieldActive = true;
      addSystemMessage('🛡️ [金钟罩] 护盾开启，10 秒内免疫靠近相遇！');
      later(() => { s.isShieldActive = false; }, 10000);
    } else if (skill.id === 'xray') {
      s.xrayUntil = now + 10000;
      addSystemMessage('👁️ [火眼金睛] 已开启，10 秒内高亮锁定全图敌人！');
      renderMarkers();
      later(() => { s.xrayUntil = 0; renderMarkers(); }, 10000);
    } else if (skill.id === 'decoy_signal') {
      s.decoyUntil = now + 10000;
      addSystemMessage('📢 [声东击西] 已在附近生成伪造 GPS 诱饵标记！');
      renderMarkers();
      later(() => { s.decoyUntil = 0; renderMarkers(); }, 10000);
    } else if (skill.id === 'disguise') {
      s.disguiseUntil = now + 15000;
      addSystemMessage('🎭 [伪装掩护] 已开启，15 秒内你的标记伪装成猫队！');
      renderMarkers();
      later(() => { s.disguiseUntil = 0; renderMarkers(); }, 15000);
    } else if (skill.id === 'cat_radar') {
      s.radarUntil = now + 10000;
      addSystemMessage('🔥 [猫咪热感] 已开启，10 秒内相遇/探测范围大幅扩大！');
      renderMarkers();
      later(() => { s.radarUntil = 0; renderMarkers(); }, 10000);
    } else {
      addSystemMessage(`你释放了 GPS 技能: [${skill.name}]`);
    }

    if (s.netMode !== 'OFFLINE') {
      networkManager.send(MSG_TYPES.USE_SKILL, { skillId: skill.id, playerName: s.myName });
    }

    s.skills = s.skills.map(sk => sk.id === skill.id ? { ...sk, usesLeft: sk.usesLeft - 1 } : sk);
    renderSkills();
    renderMarkers();
  };

  const toggleBackpack = () => {
    s.showSkillBackpack = !s.showSkillBackpack;
    showToast({ title: '打开背包', icon: 'none' });
  };

  /* ---------- 抓捕事件（源 L999-1019 原样） ---------- */

  const onCatchEvent = (catName, mouseName, success) => {
    actionCount = (actionCount || 0) + 1;
    if (success && catName === s.myName) myCatches = (myCatches || 0) + 1;
    if (!success && mouseName === s.myName) myEscapes = (myEscapes || 0) + 1;
    if (success && s.myTeam === 'cat' && catName === s.myName) {
      achievementManager.recordCatch();
    }
    const msg = success ? `🐱 ${catName} 追上了 🐭 ${mouseName}，相遇成功!` : `🐭 ${mouseName} 躲开了相遇，躲避成功!`;
    s.showCatchOverlay = true;
    s.catchMessage = msg;
    renderCatch();
    addSystemMessage(msg);
    later(() => {
      s.showCatchOverlay = false;
      renderCatch();
    }, 2500);
  };

  /* ---------- 工具栏（源 L1023-1062 / L1167-1179 原样） ---------- */

  const onViewToggle = () => {
    s.satellite = !s.satellite;
    if (map) map.setSatellite(s.satellite);
    showToast({ title: s.satellite ? '已切换卫星图' : '已切换标准图', icon: 'none' });
  };

  const onScan = () => {
    const now = Date.now();
    if ((s.scanUntil || 0) > now) {
      showToast({ title: '扫描正在进行中', icon: 'none' });
      return;
    }
    if (scanCdUntil > now) {
      showToast({ title: `扫描冷却中 (${Math.ceil((scanCdUntil - now) / 1000)}s)`, icon: 'none' });
      return;
    }
    s.scanUntil = now + 6000;
    scanCdUntil = now + (scanCdMs || 30000);
    addSystemMessage('🔍 [全图扫描] 敌人位置暴露 6 秒！');
    renderMarkers();
    later(() => renderMarkers(), 6000);
  };

  const onShowRank = () => {
    const now = Date.now();
    const scanOn = (s.scanUntil || 0) > now;
    const rows = [
      { id: 'me', name: s.myName || '我', team: s.myTeam, score: s.myScore, isMe: true },
      ...(aiPlayers || []).map(p => ({ id: String(p.id), name: p.name, team: p.team, score: p.score || 0, isMe: false }))
    ].sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1, top3: i < 3, scanOn }));
    s.liveRank = rows;
    s.showRankModal = true;
    renderRankModal();
  };

  const onCloseRankModal = () => {
    s.showRankModal = false;
    renderRankModal();
  };

  const onRadar = () => {
    s.radarActive = !s.radarActive;
    showToast({ title: s.radarActive ? '声呐雷达开启' : '声呐雷达关闭', icon: 'none' });
  };

  const onTrack = () => {
    showToast({ title: '追踪最近敌人', icon: 'none' });
    if (map && aiPlayers.length > 0) {
      map.moveTo(aiPlayers[0].latitude, aiPlayers[0].longitude);
    }
  };

  /* ---------- 房主控制（源 L1066-1165 原样，wx→ui Promise 化） ---------- */

  const onHostMenu = async () => {
    if (!s.isHost) {
      showToast({ title: '仅房主可以使用本局管理操作', icon: 'none' });
      return;
    }
    const res = await showActionSheet({
      itemList: [
        s.isPaused ? '▶️ 继续活动' : '⏸ 暂停活动',
        '⏱ 延时 5 分钟',
        '🦶 移除玩家',
        '🏁 提前结算本局'
      ]
    });
    if (res.tapIndex === 0) {
      if (s.isPaused) resumeGame();
      else pauseGame();
    } else if (res.tapIndex === 1) {
      extendTime();
    } else if (res.tapIndex === 2) {
      kickPlayerMenu();
    } else if (res.tapIndex === 3) {
      endEarly();
    }
  };

  const setPaused = (paused, fromNet) => {
    if (s.gamePhase !== 'PLAYING' && s.gamePhase !== 'PAUSED') return;
    if (paused) {
      if (gameTimer) clearInterval(gameTimer);
      if (gameTickTimer) clearInterval(gameTickTimer);
      gameTimer = null;
      gameTickTimer = null;
      s.isPaused = true;
      s.gamePhase = 'PAUSED';
      renderPhase();
      addSystemMessage(fromNet ? '⏸ 房主暂停了活动' : '⏸ 你暂停了活动，倒计时与计分已冻结');
      if (!fromNet && s.netMode !== 'OFFLINE') {
        networkManager.send(MSG_TYPES.GAME_PAUSE, { paused: true });
      }
    } else {
      s.isPaused = false;
      s.gamePhase = 'PLAYING';
      gameTimer = setInterval(() => updateTimer(), 1000);
      gameTickTimer = setInterval(() => gameTick(), 1500);
      renderPhase();
      addSystemMessage(fromNet ? '▶️ 房主恢复活动，继续！' : '▶️ 活动继续！');
      if (!fromNet && s.netMode !== 'OFFLINE') {
        networkManager.send(MSG_TYPES.GAME_PAUSE, { paused: false });
      }
    }
  };
  const pauseGame = () => setPaused(true, false);
  const resumeGame = () => setPaused(false, false);

  const applyExtend = (seconds, fromNet) => {
    if (s.gamePhase !== 'PLAYING' && s.gamePhase !== 'PAUSED') return;
    const t = (s.remainingTime || 0) + seconds;
    totalDuration = (totalDuration || 600) + seconds;
    s.remainingTime = t;
    s.timerText = formatTime(t);
    renderHud();
    addSystemMessage(`⏱ ${fromNet ? '房主' : '你'}为本局延长了 ${Math.round(seconds / 60)} 分钟`);
  };

  const extendTime = () => {
    if (!s.isHost) return;
    applyExtend(300, false);
    if (s.netMode !== 'OFFLINE') {
      networkManager.send(MSG_TYPES.GAME_EXTEND, { seconds: 300 });
    }
  };

  const kickPlayerMenu = async () => {
    if (!s.isHost) return;
    const players = aiPlayers || [];
    if (!players.length) {
      showToast({ title: '当前没有可移除的玩家', icon: 'none' });
      return;
    }
    const res = await showActionSheet({
      itemList: players.slice(0, 6).map(p => `${p.team === 'cat' ? '🐱' : '🐭'} ${p.name}（${p.score || 0} 分）`)
    });
    const target = players[res.tapIndex];
    if (!target) return;
    aiPlayers = players.filter(x => x.id !== target.id);
    renderMarkers();
    addSystemMessage(`👑 房主移除了玩家 ${target.name}`);
    if (s.netMode !== 'OFFLINE') {
      networkManager.send(MSG_TYPES.PLAYER_KICK, { playerId: target.id, name: target.name });
    }
  };

  const endEarly = async () => {
    const res = await showModal({ title: '提前结算', content: '确定现在结束本局并结算排名吗？' });
    if (res.confirm) endGame();
  };

  /* ---------- 聊天 ---------- */

  const onSendChat = () => {
    const input = $('game-chat-input');
    const text = input.value.trim();
    if (!text) return;
    addChatMessage(s.myName, text);
    input.value = '';
    if (s.netMode !== 'OFFLINE') {
      networkManager.send(MSG_TYPES.CHAT_MESSAGE, { sender: s.myName, text });
    }
  };

  /* ---------- 计时与结算（源 L1217-1286 原样） ---------- */

  const updateTimer = () => {
    if (s.isPaused) return;
    const t = s.remainingTime - 1;
    if (t <= 0) {
      s.remainingTime = 0;
      s.timerText = '00:00';
      renderHud();
      endGame();
    } else {
      s.remainingTime = t;
      s.timerText = formatTime(t);
      renderHud();
    }
  };

  const endGame = () => {
    if (s.gamePhase === 'END') return; // 防倒计时归零与提前结算重复触发
    clearAllTimers();
    soundVibration.playSound('catch_success');
    s.gamePhase = 'END';
    s.isPaused = false;
    renderPhase();
    addSystemMessage('活动结束！');

    const myPlayerId = (globalStateRef.currentPlayer && globalStateRef.currentPlayer.id) || 'player_1';
    const allPlayers = [
      { id: myPlayerId, name: s.myName || '玩家', team: s.myTeam, score: s.myScore },
      ...(aiPlayers || []).map(ai => ({
        id: String(ai.id), name: ai.name, team: ai.team, score: ai.score || 0
      }))
    ];

    const catScore = allPlayers.filter(p => p.team === 'cat').reduce((sum, p) => sum + p.score, 0);
    const mouseScore = allPlayers.filter(p => p.team === 'mouse').reduce((sum, p) => sum + p.score, 0);
    const winner = catScore > mouseScore ? 'cat' : (mouseScore > catScore ? 'mouse' : 'draw');
    const isWin = s.myTeam === winner;

    achievementManager.updateProgress(0, isWin, true);

    globalStateRef.lastGameResult = {
      winner,
      duration: (totalDuration || 600) - s.remainingTime,
      players: allPlayers,
      stats: {
        distance: s.distance,
        actionCount: actionCount || 0,
        skillUsed: skillUsed || 0,
        myCatches: myCatches || 0,
        myEscapes: myEscapes || 0
      },
      track: track || []
    };

    showModal({ title: '活动结束', content: '时间到！即将前往结算页面...', showCancel: false })
      .then(() => navigate('result'));
  };

  const formatTime = seconds => {
    const m = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  /* ---------- 事件绑定 ---------- */

  $('tool-view').addEventListener('click', onViewToggle);
  $('tool-scan').addEventListener('click', onScan);
  $('tool-rank').addEventListener('click', onShowRank);
  $('tool-radar').addEventListener('click', onRadar);
  $('tool-track').addEventListener('click', onTrack);
  $('tool-voice').addEventListener('click', () => {
    showToast({ title: 'Web 版暂不支持语音，请使用文字聊天', icon: 'none' });
  });
  $('game-host-btn').addEventListener('click', onHostMenu);
  $('game-backpack-btn').addEventListener('click', toggleBackpack);
  $('game-skills').addEventListener('click', e => {
    const card = e.target.closest('[data-skill]');
    if (card) onSkillUse(card.dataset.skill);
  });
  $('game-chat-toggle').addEventListener('click', () => {
    const bar = $('game-chat-inputbar');
    bar.classList.toggle('show');
    if (bar.classList.contains('show')) $('game-chat-input').focus();
  });
  $('game-chat-send').addEventListener('click', onSendChat);
  $('game-chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') onSendChat();
  });
  $('game-rank-close').addEventListener('click', onCloseRankModal);
  $('game-rank-mask').addEventListener('click', e => {
    if (e.target === $('game-rank-mask')) onCloseRankModal();
  });

  /* ---------- 生命周期 ---------- */

  // 源 onLoad L85-151
  const onShow = () => {
    // tabBar 裸进守卫
    if (!globalStateRef.currentPlayer) {
      showModal({
        title: '还没开始活动',
        content: '请先回到首页选择队伍、输入昵称并开始一局活动',
        showCancel: false
      }).then(() => navigate('home'));
      return;
    }

    console.log('Game loading with real outdoor GPS mechanics...');
    skillUsed = 0;
    actionCount = 0;
    myCatches = 0;
    myEscapes = 0;
    track = [];
    lastTrackAt = 0;
    hasRealLocation = false;
    lastLat = null;
    lastLng = null;
    tickCount = 0;
    lastSonarAt = 0;
    catchCdUntil = 0;
    scanCdUntil = 0;
    startShield = false;
    cheeseMultiplier = 1;
    scanCdMs = 30000;

    const netMode = (globalStateRef.netMode || 'OFFLINE');
    // 房主判定：单机默认自己是主持人；联机以 roomSession.isHost 为准
    const isHost = netMode === 'OFFLINE' || roomSession.isHost === true;
    s.isHost = isHost;
    const myTeam = (globalStateRef.currentPlayer && globalStateRef.currentPlayer.team) || 'mouse';
    const titleObj = achievementManager.getEquippedTitleObj();
    gameArea = (globalStateRef.gameArea || null);
    const areaCenter = GameArea.center(gameArea);
    const gameDurationSeconds = Math.max(60, Math.min(7200, Number(globalStateRef.gameDurationSeconds) || 600));

    s.myTeam = myTeam;
    s.myName = (globalStateRef.currentPlayer && globalStateRef.currentPlayer.name) || '玩家';
    s.equippedTitle = titleObj.icon + ' ' + titleObj.name;
    s.netMode = netMode;
    s.myScore = 0;
    s.distance = 0;
    s.battleFeed = [];
    s.chatMessages = [];
    s.showCatchOverlay = false;
    s.catchMessage = '';
    s.isOutsideArea = false;
    s.isShieldActive = false;
    s.isStealthActive = false;
    s.stealthUntil = 0;
    s.disguiseUntil = 0;
    s.xrayUntil = 0;
    s.decoyUntil = 0;
    s.radarUntil = 0;
    s.satellite = false;
    s.scanUntil = 0;
    s.showRankModal = false;
    s.liveRank = [];
    s.isPaused = false;
    s.radarActive = false;
    s.skills = SkillSystem.getSkillsForTeam(myTeam);
    if (areaCenter) {
      s.latitude = areaCenter.latitude;
      s.longitude = areaCenter.longitude;
    }
    s.remainingTime = gameDurationSeconds;
    s.timerText = formatTime(gameDurationSeconds);
    totalDuration = gameDurationSeconds;

    if (netMode === 'OFFLINE') {
      renderNetStatus('单机模式', 'dot-offline');
    } else {
      renderNetStatus('服务器联机 🟢', 'dot-online');
    }

    // 地图：创建/复用 + 区域多边形 + 视野适配
    if (!map) {
      map = createMap($('game-map'), {
        center: [s.longitude, s.latitude],
        zoom: 16
      });
    }
    if (GameArea.isValidArea(gameArea)) {
      map.setPolygon(gameArea.points);
      map.fitBounds(gameArea.points, 60);
    } else {
      map.setPolygon([]);
    }

    applyShopItems(s.skills);
    renderSkills();
    renderHud();
    renderPhase();
    renderBoundary();
    renderFeed();
    renderChat();
    renderRankModal();
    renderCatch();

    // 刷出地图打卡点与道具
    MapItemsManager.spawnItems(
      areaCenter || { latitude: s.latitude, longitude: s.longitude },
      8
    );

    setupNetworkListeners();
    if (netMode === 'OFFLINE') {
      // 仅单机生成 AI 假人；联机只同步真实玩家
      initMockAIPlayers();
      addSystemMessage('已进入单机模式，AI 玩家就位，地图刷新奶酪打卡点！');
    } else {
      addSystemMessage(`已进入 [${netMode}] 联机模式，全员 GPS 坐标实时同步！`);
    }
    renderMarkers();

    startCountdown();
  };

  // 源 onUnload L197-205
  const onHide = () => {
    clearAllTimers();
    removeNetworkListeners();
    stopLocationUpdate();
    networkManager.disconnect();
    if (map) {
      map.destroy();
      map = null;
    }
  };

  return { onShow, onHide };
}
