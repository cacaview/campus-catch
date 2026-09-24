// js/views/home.js — 首页（源 pages/index/index.js 727 行移植，Web 版裁剪：删 LAN/扫码/二维码，服务器模式走 wss）
import { navigate, DEFAULT_CENTER, parseQueryParams } from '../main.js';
import { getStorage, setStorage } from '../platform/storage.js';
import { showToast, showModal, showLoading, hideLoading, setClipboardData } from '../platform/ui.js';
import { getLocation } from '../platform/geo.js';
import { createMap } from '../lib/map.js';
import { achievementManager } from '../utils/achievement.js';
import { shopManager } from '../utils/shop.js';
import GameArea from '../utils/game-area.js';
import { getStablePlayerId } from '../utils/player-identity.js';
import { Protocol } from '../utils/network/protocol.js';
import { networkManager } from '../utils/network/network-manager.js';
import { roomSession } from '../utils/network/room-session.js';

const GUIDE_SLIDES = [
  {
    emoji: '🐱🐭',
    title: '欢迎来到校园定位活动',
    desc: '在真实校园里用 GPS 位置进行定位相遇与躲避：靠近对方 15 米即触发相遇打卡；打卡奶酪得分、坚持到最后即可获胜。'
  },
  {
    emoji: '📍',
    title: '开局三件事：队伍 / 昵称 / 区域',
    desc: '先选队伍、输入昵称，再在地图上点 3~12 个边界点框出活动区域。不想手点？用「一键模板」秒生成。'
  },
  {
    emoji: '🚀',
    title: '开始活动与组队',
    desc: '单机模式 AI 补位随时开练；服务器模式可创建房间、把加入链接发给好友。准备好了就点开始！'
  }
];

const HOME_HTML = `
  <!-- 新手引导层 -->
  <div class="guide-mask" id="home-guide-mask" hidden>
    <div class="guide-card">
      <div class="guide-emoji" id="home-guide-emoji"></div>
      <div class="guide-title" id="home-guide-title"></div>
      <div class="guide-desc" id="home-guide-desc"></div>
      <div class="guide-dots" id="home-guide-dots"></div>
      <div class="guide-actions">
        <button class="guide-skip" id="home-guide-skip">跳过</button>
        <button class="m-btn confirm guide-next" id="home-guide-next">下一步</button>
      </div>
    </div>
  </div>

  <div class="header">
    <div class="title-container">
      <span class="emoji-anim cat">🐱</span>
      <div class="title-box">
        <div class="main-title">校园定位活动</div>
        <div class="sub-title">校园版</div>
      </div>
      <span class="emoji-anim mouse">🐭</span>
    </div>
  </div>

  <!-- 应战邀请横幅 -->
  <div class="challenge-banner" id="home-challenge" hidden>
    <div class="challenge-info">
      <div class="challenge-title" id="home-challenge-title"></div>
      <div class="challenge-sub" id="home-challenge-sub"></div>
    </div>
    <div class="challenge-actions">
      <button class="challenge-btn accept" id="home-challenge-accept">接受邀请</button>
      <button class="challenge-btn dismiss" id="home-challenge-dismiss">忽略</button>
    </div>
  </div>

  <!-- Team Selection -->
  <div class="team-selection">
    <div class="team-card cat-card" id="team-cat" data-team="cat">
      <div class="team-emoji">🐱</div>
      <div class="team-name">猫队</div>
      <div class="team-desc">定位相遇</div>
    </div>
    <div class="team-card mouse-card" id="team-mouse" data-team="mouse">
      <div class="team-emoji">🐭</div>
      <div class="team-name">鼠队</div>
      <div class="team-desc">躲避猫队</div>
    </div>
  </div>

  <!-- Nickname -->
  <div class="input-section">
    <input class="nickname-input" id="home-nickname" placeholder="请输入昵称" maxlength="10" />
  </div>

  <!-- 区域框选 -->
  <div class="area-section">
    <div class="section-title area-title">📍 框选活动区域 <span id="home-area-count">0 个边界点</span></div>
    <div class="area-map" id="home-area-map"></div>
    <div class="area-help">点击地图放置边界点，系统会自动顺时针连接，避免边界线交叉；所有玩家必须在区域内活动。</div>
    <div class="area-actions">
      <button class="mini-btn" id="home-area-undo" disabled>撤销一点</button>
      <button class="mini-btn" id="home-area-clear" disabled>重新框选</button>
      <span class="area-state" id="home-area-state">请至少标记 3 点</span>
    </div>
    <div class="area-templates">
      <span class="tpl-label">一键模板：</span>
      <button class="mini-btn tpl-btn" data-tpl="teach">🏫 教学楼片区</button>
      <button class="mini-btn tpl-btn" data-tpl="playground">🏃 操场环线</button>
      <button class="mini-btn tpl-btn" data-tpl="radius200">⭕ 周边一转 200m</button>
    </div>
  </div>

  <!-- 时长 -->
  <div class="duration-section">
    <div class="section-title duration-title">
      <span>⏱ 单局时长</span>
      <span class="duration-value" id="home-duration-value">10 分钟</span>
    </div>
    <input type="range" class="duration-slider" id="home-duration" min="1" max="120" step="1" value="10" />
    <div class="duration-marks"><span>1 分钟</span><span>120 分钟</span></div>
    <div class="area-help">联机时由房主设置，并自动同步给所有加入者。</div>
  </div>

  <!-- 称号与任务 -->
  <div class="title-task-bar">
    <div class="equipped-title-badge" id="home-title-entry">
      <span class="label">🏆 当前佩戴称号:</span>
      <span class="title-name" id="home-title-name"></span>
      <span class="edit-icon">✏️</span>
    </div>
    <button class="daily-task-btn" id="home-task-entry">📋 每日任务</button>
    <button class="daily-task-btn shop-btn" id="home-shop-entry">🛒 商店</button>
  </div>

  <!-- 联机模式 -->
  <div class="network-mode-section">
    <div class="section-title">🌐 联机模式选择</div>
    <div class="mode-tabs">
      <div class="mode-tab" id="mode-offline" data-mode="OFFLINE">🤖 单机模拟</div>
      <div class="mode-tab" id="mode-server" data-mode="SERVER">☁️ 服务器</div>
    </div>
  </div>

  <!-- 服务器面板 -->
  <div class="lan-panel server-panel" id="home-server-panel" hidden>
    <div class="input-item">
      <label class="label">服务器地址 (wss:// 开头):</label>
      <input class="modal-input server-input" id="home-server-url" placeholder="例如 wss://192.168.1.100:8080" />
    </div>
    <div class="info-sub">部署了 relay-server 后输入对应地址连接。房主创建房间后会把加入链接发给队友。</div>
    <div class="lan-actions">
      <button class="lan-btn host-btn" id="home-create-server-room">➕ 创建房间(做房主)</button>
    </div>
    <div class="room-created-info" id="home-join-link-box" hidden>
      <div class="info-title">✅ 房间已创建</div>
      <div class="info-item">加入链接：</div>
      <div class="join-link-text" id="home-join-link-text"></div>
      <button class="copy-invite-btn mini-btn" id="home-join-link-copy">📋 复制加入链接</button>
    </div>
  </div>

  <!-- 操作区 -->
  <div class="action-section">
    <div class="ready-checklist" id="home-checklist"></div>
    <button class="start-btn" id="home-start">开始活动 (单机)</button>
    <button class="lobby-entry-btn" id="home-lobby-entry">🛋️ 房间大厅（组队 / AI 补位）</button>
  </div>

  <!-- 规则 -->
  <div class="rules-section">
    <div class="rules-header" id="home-rules-header">
      <span>活动规则与联机说明</span>
      <span class="arrow" id="home-rules-arrow">▼</span>
    </div>
    <div class="rules-content" id="home-rules" hidden>
      <div>🐱 猫队目标：靠近鼠队成员 15 米内触发定位相遇（打卡）</div>
      <div>🐭 鼠队目标：躲避猫队、打卡拾取奶酪、坚持到活动结束</div>
      <div>♾️ 人数无上限：支持十人、百人甚至千人同场定位活动！</div>
      <div>📍 房主先框选活动区域，成员越界后暂停计分与位置同步</div>
      <div>☁️ 服务器联机：房主创建房间后把加入链接发给队友，双方点「开始」进局</div>
      <div>⚡ 断线重连：通信中断时自动发起指数退避重连保活</div>
    </div>
  </div>

  <!-- 称号弹窗 -->
  <div class="modal-mask" id="home-titles-mask" hidden>
    <div class="modal-box">
      <div class="modal-title">🎖️ 选择装扮称号</div>
      <div class="title-list" id="home-titles-list"></div>
      <button class="m-btn confirm close-btn" id="home-titles-close">确定</button>
    </div>
  </div>

  <!-- 任务弹窗 -->
  <div class="modal-mask" id="home-tasks-mask" hidden>
    <div class="modal-box">
      <div class="modal-title">📋 任务中心</div>
      <div class="wallet-bar">💰 我的积分：<span class="wallet-num" id="home-wallet-home">0</span><span class="wallet-tip">（完成任务后点击领取）</span></div>
      <div class="task-group-title">🌙 每日任务（每天重置）</div>
      <div class="task-list" id="home-tasks-daily"></div>
      <div class="task-group-title">🔥 热身任务（永久成长线）</div>
      <div class="task-list" id="home-tasks-warmup"></div>
      <button class="m-btn confirm close-btn" id="home-tasks-close">关闭</button>
    </div>
  </div>

  <!-- 商店弹窗 -->
  <div class="modal-mask" id="home-shop-mask" hidden>
    <div class="modal-box">
      <div class="modal-title">🛒 积分商店</div>
      <div class="wallet-bar">💰 我的积分：<span class="wallet-num" id="home-shop-wallet">0</span><span class="wallet-tip">（道具为消耗品，下一局自动生效）</span></div>
      <div class="shop-list" id="home-shop-list"></div>
      <button class="m-btn confirm close-btn" id="home-shop-close">关闭</button>
    </div>
  </div>
`;

export function create(rootEl, globalStateRef) {
  const $ = id => document.getElementById(id);
  let map = null;
  let rawPoints = [];
  let areaReady = false;
  let areaPoints = [];
  let selectedTeam = null;
  let nickname = '';
  let netMode = 'OFFLINE';
  let durationMinutes = 10;
  let createdRoomPasscode = '';
  let serverUrl = '';
  let joinPasscode = '';   // 加入链接带入的身份码（加入者用）
  let guideStep = 0;
  let showRules = false;
  let joinEventsBound = false;
  let joinWatchdog = null;
  let areaCenter = { ...DEFAULT_CENTER };

  /* ---------- 渲染函数 ---------- */
  const renderGuide = () => {
    const slide = GUIDE_SLIDES[guideStep];
    $('home-guide-emoji').textContent = slide.emoji;
    $('home-guide-title').textContent = slide.title;
    $('home-guide-desc').textContent = slide.desc;
    $('home-guide-dots').innerHTML = GUIDE_SLIDES.map((_, i) =>
      `<span class="guide-dot ${i <= guideStep ? 'on' : ''}"></span>`).join('');
    $('home-guide-next').textContent = guideStep === GUIDE_SLIDES.length - 1 ? '开始使用' : '下一步';
    $('home-guide-mask').hidden = false;
  };
  const hideGuide = () => { $('home-guide-mask').hidden = true; };

  const renderChallenge = () => {
    const inv = globalStateRef.challengeInvite;
    if (!inv) {
      $('home-challenge').hidden = true;
      return;
    }
    $('home-challenge-title').textContent = `📣 ${inv.by} 邀请你参加活动！`;
    $('home-challenge-sub').textContent =
      `TA 加入的是${inv.team === 'cat' ? '猫' : '鼠'}队，接受后将为你预填${inv.myTeam === 'cat' ? '猫' : '鼠'}队`;
    $('home-challenge').hidden = false;
  };

  const renderTeam = () => {
    $('team-cat').classList.toggle('selected', selectedTeam === 'cat');
    $('team-mouse').classList.toggle('selected', selectedTeam === 'mouse');
  };
  const renderChecklist = () => {
    const identityReady = !!selectedTeam && nickname.length > 0;
    const checklist = [
      { label: '队伍', ok: !!selectedTeam },
      { label: '昵称', ok: nickname.length > 0 },
      { label: '区域', ok: areaReady },
      { label: '时长', ok: true }
    ];
    $('home-checklist').innerHTML = checklist.map(c =>
      `<div class="check-item ${c.ok ? 'ok' : ''}"><span class="check-icon">${c.ok ? '✅' : '⬜'}</span><span>${c.label}</span></div>`).join('');
    const ready = identityReady && areaReady;
    $('home-start').classList.toggle('ready', ready);
    $('home-start').textContent = netMode === 'OFFLINE'
      ? '开始活动 (单机)'
      : (createdRoomPasscode ? '开始活动 (房主)' : '开始匹配联机');
  };
  const renderArea = () => {
    areaPoints = GameArea.orderBoundaryPoints(rawPoints);
    areaReady = rawPoints.length >= 3;
    $('home-area-count').textContent = `${rawPoints.length} 个边界点`;
    $('home-area-state').textContent = areaReady ? '区域已锁定' : '请至少标记 3 点';
    $('home-area-state').className = 'area-state' + (areaReady ? ' ok' : '');
    $('home-area-undo').disabled = !rawPoints.length;
    $('home-area-clear').disabled = !rawPoints.length;
    if (map) {
      map.setPolygon(areaPoints);
      map.setMarkers(rawPoints.map((p, i) => ({
        id: 7000 + i,
        latitude: p.latitude,
        longitude: p.longitude,
        icon: String(i + 1),
        color: '#ffd700'
      })));
    }
    renderChecklist();
  };
  const renderDuration = () => { $('home-duration-value').textContent = `${durationMinutes} 分钟`; };
  const renderNetMode = () => {
    $('mode-offline').classList.toggle('active', netMode === 'OFFLINE');
    $('mode-server').classList.toggle('active', netMode === 'SERVER');
    $('home-server-panel').hidden = netMode !== 'SERVER';
    renderChecklist();
  };
  const renderTitles = () => {
    const eq = achievementManager.getEquippedTitleObj();
    $('home-title-name').textContent = `${eq.icon} ${eq.name}`;
    $('home-titles-list').innerHTML = achievementManager.getTitles().map(t =>
      `<div class="title-item ${achievementManager.data.equippedTitle === t.id ? 'equipped' : ''} ${t.unlocked ? '' : 'locked'}" data-id="${t.id}">
         <span class="t-icon">${t.icon}</span>
         <span class="t-info"><span class="t-name">${t.name}</span><span class="t-desc">${t.unlocked ? t.desc : (t.progressText || t.desc)}</span></span>
         <span class="t-status">${t.unlocked ? (achievementManager.data.equippedTitle === t.id ? '佩戴中' : '点击佩戴') : '未解锁'}</span>
       </div>`).join('');
  };
  const renderTasks = () => {
    const item = (t, claimed) => `<div class="task-item">
        <div class="task-info"><span class="task-t">${t.title}</span><span class="task-p">进度: ${t.current} / ${t.target} ${t.unit}</span></div>
        ${t.done && !claimed ? `<button class="task-claim-btn" data-kind="daily" data-id="${t.id}">领 ${t.reward}</button>`
          : claimed ? '<span class="task-status done">已领取 ✅</span>'
          : `<span class="task-status">${t.done ? '已完成 ✅' : '进行中'}</span>`}</div>`;
    const warmupItem = (t) => `<div class="task-item">
        <div class="task-info"><span class="task-t">${t.title}</span><span class="task-p">进度: ${t.current} / ${t.target} ${t.unit}</span></div>
        ${t.done && !t.claimed ? `<button class="task-claim-btn" data-kind="warmup" data-id="${t.id}">领 ${t.reward}</button>`
          : t.claimed ? '<span class="task-status done">已领取 ✅</span>'
          : `<span class="task-status">${t.done ? '已完成 ✅' : '进行中'}</span>`}</div>`;
    $('home-wallet-home').textContent = String(achievementManager.getPoints());
    $('home-tasks-daily').innerHTML = achievementManager.data.tasks
      .map(t => item(t, !!achievementManager.data.claimedTasks[`${achievementManager.data.taskDate}_${t.id}`])).join('');
    $('home-tasks-warmup').innerHTML = achievementManager.getWarmupTasks().map(warmupItem).join('');
  };
  const renderShop = () => {
    $('home-shop-wallet').textContent = String(achievementManager.getPoints());
    $('home-shop-list').innerHTML = shopManager.getItems().map(i =>
      `<div class="shop-item"><span class="shop-icon">${i.icon}</span>
       <span class="shop-info"><span class="shop-name">${i.name}${i.owned > 0 ? `（库存 ${i.owned}）` : ''}</span><span class="shop-desc">${i.desc}</span></span>
       <button class="shop-buy-btn ${i.affordable ? '' : 'poor'}" data-id="${i.id}">💰 ${i.price}</button></div>`).join('');
  };
  const renderRules = () => {
    $('home-rules').hidden = !showRules;
    $('home-rules-arrow').className = 'arrow ' + (showRules ? 'up' : 'down');
  };

  /* ---------- 配置持久化（键名 indexCfg 不变） ---------- */
  const saveConfig = () => setStorage('indexCfg', { selectedTeam, durationMinutes, areaRawPoints: rawPoints });
  const restoreConfig = () => {
    const cfg = getStorage('indexCfg') || {};
    if (cfg.selectedTeam === 'cat' || cfg.selectedTeam === 'mouse') selectedTeam = cfg.selectedTeam;
    if (Number.isFinite(Number(cfg.durationMinutes))) durationMinutes = Math.max(1, Math.min(120, Number(cfg.durationMinutes)));
    if (Array.isArray(cfg.areaRawPoints) && cfg.areaRawPoints.length >= 3) rawPoints = cfg.areaRawPoints.slice();
  };

  /* ---------- 引导 ---------- */
  const maybeShowGuide = () => {
    if (!getStorage('guideShown')) {
      guideStep = 0;
      renderGuide();
    }
  };
  const guideNext = () => {
    const step = guideStep + 1;
    if (step >= GUIDE_SLIDES.length) closeGuide();
    else { guideStep = step; renderGuide(); }
  };
  const closeGuide = () => {
    hideGuide();
    setStorage('guideShown', true);
  };

  /* ---------- 应战邀请 ---------- */
  const acceptChallenge = () => {
    const inv = globalStateRef.challengeInvite;
    if (!inv) return;
    selectedTeam = inv.myTeam;
    globalStateRef.challengeInvite = null;
    saveConfig();
    renderTeam();
    renderChallenge();
    renderChecklist();
    showToast({ title: `已为你选好${inv.myTeam === 'cat' ? '猫' : '鼠'}队，输入昵称参加活动！`, icon: 'none' });
  };
  const dismissChallenge = () => {
    globalStateRef.challengeInvite = null;
    renderChallenge();
  };

  /* ---------- 区域 ---------- */
  const setAreaPoints = (pts) => {
    rawPoints = pts.slice();
    renderArea();
    saveConfig();
  };
  const onAreaMapTap = (pt) => {
    if (!Number.isFinite(pt.latitude) || !Number.isFinite(pt.longitude)) return;
    if (rawPoints.length >= 12) {
      showToast({ title: '最多可设置 12 个边界点', icon: 'none' });
      return;
    }
    setAreaPoints([...rawPoints, { latitude: pt.latitude, longitude: pt.longitude }]);
  };

  // 区域模板一键生成（源 applyAreaTemplate 原样）
  const applyAreaTemplate = (tpl) => {
    const centerLat = areaCenter.latitude;
    const centerLng = areaCenter.longitude;
    const mPerLat = 111320;
    const mPerLng = 111320 * Math.cos(centerLat * Math.PI / 180) || 111320;
    const toPoint = (dxM, dyM) => ({
      latitude: centerLat + dyM / mPerLat,
      longitude: centerLng + dxM / mPerLng
    });
    let pts = [];
    if (tpl === 'teach') {
      pts = [toPoint(-150, -100), toPoint(150, -100), toPoint(150, 100), toPoint(-150, 100)];
    } else if (tpl === 'playground') {
      for (let i = 0; i < 6; i++) {
        const ang = Math.PI / 3 * i;
        pts.push(toPoint(Math.cos(ang) * 150, Math.sin(ang) * 150));
      }
    } else if (tpl === 'radius200') {
      for (let i = 0; i < 8; i++) {
        const ang = Math.PI / 4 * i;
        pts.push(toPoint(Math.cos(ang) * 200, Math.sin(ang) * 200));
      }
    }
    if (pts.length) {
      setAreaPoints(pts);
      showToast({ title: '已一键生成区域，可在地图微调', icon: 'none' });
    }
  };

  /* ---------- 弹窗 ---------- */
  const showTitleModal = () => { renderTitles(); $('home-titles-mask').hidden = false; };
  const hideTitleModal = () => { $('home-titles-mask').hidden = true; };
  const showTaskModal = () => { renderTasks(); $('home-tasks-mask').hidden = false; };
  const hideTaskModal = () => { $('home-tasks-mask').hidden = true; };
  const showShopModal = () => { renderShop(); $('home-shop-mask').hidden = false; };
  const hideShopModal = () => { $('home-shop-mask').hidden = true; };

  const selectEquipTitle = (id) => {
    if (achievementManager.equipTitle(id)) {
      showToast({ title: '已佩戴新称号！', icon: 'success' });
      renderTitles();
    } else {
      const t = achievementManager.getTitles().find(x => x.id === id);
      const tip = t && t.progressText ? `${t.name}：${t.progressText}` : '未解锁该称号';
      showToast({ title: tip, icon: 'none' });
    }
  };

  /* ---------- 房间大厅入口 ---------- */
  const goLobby = () => {
    const identityReady = !!selectedTeam && nickname.length > 0;
    if (!identityReady) {
      showToast({ title: '请先选择队伍并输入昵称', icon: 'none' });
      return;
    }
    globalStateRef.currentPlayer = { id: getStablePlayerId(), name: nickname, team: selectedTeam, score: 0 };
    globalStateRef.netMode = netMode;
    if (areaReady) {
      globalStateRef.gameArea = { type: 'polygon', points: areaPoints };
      globalStateRef.gameDurationSeconds = durationMinutes * 60;
    }
    navigate('lobby');
  };

  /* ---------- 联机看门狗 ---------- */
  const startJoinWatchdog = (actionText) => {
    clearJoinWatchdog();
    joinWatchdog = setTimeout(() => {
      hideLoading();
      showModal({
        title: `${actionText}没有响应`,
        content: '可能的原因：\n1. 服务器地址（wss://）填错\n2. relay-server 未运行\n3. 跨网络无法直连（需要公网可访问的地址）',
        showCancel: false
      });
    }, 12000);
  };
  const clearJoinWatchdog = () => {
    if (joinWatchdog) {
      clearTimeout(joinWatchdog);
      joinWatchdog = null;
    }
  };

  // 加入/建房结果事件只订阅一次
  const ensureJoinEventsBound = () => {
    if (joinEventsBound) return;
    joinEventsBound = true;

    networkManager.on('joinSuccess', () => {
      clearJoinWatchdog();
      hideLoading();
      globalStateRef.gameArea = roomSession.gameArea;
      globalStateRef.gameDurationSeconds = roomSession.gameDurationSeconds;
      showToast({ title: '房间就绪，即将进入活动！', icon: 'success' });
      setTimeout(() => navigate('game'), 600);
    });

    networkManager.on('joinFail', (reason) => {
      clearJoinWatchdog();
      hideLoading();
      showToast({ title: reason || '加入失败，请检查服务器地址和身份码', icon: 'none' });
    });
  };

  /* ---------- 创建服务器房间（房主路径，源 createLanRoom 改造） ---------- */
  const createServerRoom = () => {
    const identityReady = !!selectedTeam && nickname.length > 0;
    if (!identityReady || !areaReady) {
      showToast({ title: '请先填写身份并框选活动区域', icon: 'none' });
      return;
    }
    const url = $('home-server-url').value.trim();
    if (!url) {
      showToast({ title: '请先输入服务器地址', icon: 'none' });
      return;
    }
    serverUrl = url;

    const passcode = Protocol.generatePasscode();
    const playerInfo = { id: getStablePlayerId(), name: nickname, team: selectedTeam, score: 0 };
    const gameArea = { type: 'polygon', points: areaPoints };
    const gameDurationSeconds = durationMinutes * 60;

    globalStateRef.currentPlayer = playerInfo;
    globalStateRef.netMode = 'SERVER';
    roomSession.createRoom(playerInfo, passcode, gameArea, gameDurationSeconds);
    globalStateRef.gameArea = gameArea;
    globalStateRef.gameDurationSeconds = gameDurationSeconds;

    createdRoomPasscode = passcode;
    const link = `${location.origin}${location.pathname}?server=${encodeURIComponent(serverUrl)}&passcode=${passcode}`;
    $('home-join-link-text').textContent = link;
    $('home-join-link-box').hidden = false;
    renderChecklist();

    ensureJoinEventsBound();
    showLoading({ title: '正在创建房间...' });
    startJoinWatchdog('创建房间');
    networkManager.connectServer(serverUrl, playerInfo, passcode, gameArea, gameDurationSeconds).catch(err => {
      hideLoading();
      clearJoinWatchdog();
      createdRoomPasscode = '';
      $('home-join-link-box').hidden = true;
      renderChecklist();
      showModal({
        title: '创建房间失败',
        content: (err && err.message ? err.message + '\n' : '') + '请检查：服务器地址是否正确、relay-server 是否已启动、浏览器是否允许该地址连接。',
        showCancel: false
      });
    });
  };

  const copyJoinLink = () => {
    const link = $('home-join-link-text').textContent;
    if (!link) return;
    setClipboardData(link).then(() => {
      showToast({ title: '加入链接已复制，发给队友即可', icon: 'none' });
    });
  };

  /* ---------- 开始游戏（源 startGame，LAN 分支删除） ---------- */
  const startGame = () => {
    const identityReady = !!selectedTeam && nickname.length > 0;
    if (!identityReady) {
      showToast({ title: '请选择队伍并输入昵称', icon: 'none' });
      return;
    }
    if (!areaReady) {
      showToast({ title: '请先在地图上点击框选至少 3 个边界点', icon: 'none' });
      return;
    }

    setStorage('lastNickname', nickname);
    globalStateRef.currentPlayer = {
      id: getStablePlayerId(),
      name: nickname,
      team: selectedTeam,
      score: 0,
      state: 'IDLE',
      isMVP: false
    };
    globalStateRef.netMode = netMode;
    globalStateRef.gameReady = true;
    globalStateRef.gameArea = { type: 'polygon', points: areaPoints };
    globalStateRef.gameDurationSeconds = durationMinutes * 60;

    if (netMode === 'OFFLINE') {
      showLoading({ title: '匹配中...' });
      setTimeout(() => {
        hideLoading();
        navigate('game');
      }, 800);
    } else if (netMode === 'SERVER') {
      const url = $('home-server-url').value.trim();
      if (!url) {
        showToast({ title: '请输入服务器地址', icon: 'none' });
        return;
      }
      serverUrl = url;

      if (createdRoomPasscode) {
        // 房主已进入房间，直接开局
        navigate('game');
        return;
      }

      showLoading({ title: '正在连接服务器...' });
      startJoinWatchdog('连接服务器');
      ensureJoinEventsBound();
      roomSession.isHost = false;
      roomSession.myPlayer = globalStateRef.currentPlayer;
      roomSession.passcode = joinPasscode || '8888';

      networkManager.connectServer(
        serverUrl,
        globalStateRef.currentPlayer,
        joinPasscode || '8888',
        globalStateRef.gameArea,
        globalStateRef.gameDurationSeconds
      )
        .then(() => {
          hideLoading();
          clearJoinWatchdog();
          navigate('game');
        })
        .catch(() => {
          hideLoading();
          clearJoinWatchdog();
          showToast({ title: '无法连接服务器，已降级为单机试玩', icon: 'none' });
          globalStateRef.netMode = 'OFFLINE';
          setTimeout(() => navigate('game'), 1000);
        });
    }
  };

  /* ---------- 生命周期 ---------- */
  const onShow = () => {
    nickname = getStorage('lastNickname') || '';
    $('home-nickname').value = nickname;
    restoreConfig();
    renderTeam();
    renderDuration();
    renderNetMode();
    renderTitles();
    renderChallenge();
    maybeShowGuide();

    // 启动参数：?challenge=1&by=..&team=.. 或 ?server=wss://..&passcode=..
    const q = parseQueryParams();
    if (q.challenge && !getStorage('guideShown')) {
      /* 首次用户先看引导 */
    } else if (q.challenge) {
      globalStateRef.challengeInvite = { ...q.challenge, myTeam: q.challenge.team === 'cat' ? 'mouse' : 'cat' };
      renderChallenge();
    }
    if (q.server) {
      netMode = 'SERVER';
      serverUrl = q.server;
      $('home-server-url').value = serverUrl;
      if (q.passcode) {
        joinPasscode = q.passcode;
        showToast({ title: `已带入房间身份码 ${q.passcode}`, icon: 'none' });
      }
      renderNetMode();
    }

    // 地图定位中心
    if (!map) {
      map = createMap($('home-area-map'), {
        center: [areaCenter.longitude, areaCenter.latitude],
        zoom: 17
      });
      map.onTap(onAreaMapTap);
    }
    getLocation({
      success: loc => {
        areaCenter = { latitude: loc.latitude, longitude: loc.longitude };
        if (map) map.setCenter(loc.latitude, loc.longitude, 17);
      }
    });
    renderArea();
  };

  const onHide = () => {
    clearJoinWatchdog();
    if (map) {
      map.destroy();
      map = null;
    }
  };

  /* ---------- 初始化 ---------- */
  rootEl.innerHTML = HOME_HTML;
  bindEvents();
  return { onShow, onHide };

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $('team-cat').addEventListener('click', () => { selectedTeam = 'cat'; saveConfig(); renderTeam(); renderChecklist(); });
    $('team-mouse').addEventListener('click', () => { selectedTeam = 'mouse'; saveConfig(); renderTeam(); renderChecklist(); });
    $('home-nickname').addEventListener('input', e => {
      nickname = e.target.value.trim();
      renderChecklist();
    });

    $('home-area-undo').addEventListener('click', () => setAreaPoints(rawPoints.slice(0, -1)));
    $('home-area-clear').addEventListener('click', () => setAreaPoints([]));
    rootEl.querySelectorAll('.tpl-btn').forEach(btn =>
      btn.addEventListener('click', () => applyAreaTemplate(btn.dataset.tpl)));

    $('home-duration').addEventListener('input', e => {
      durationMinutes = Number(e.target.value) || 10;
      renderDuration();
      saveConfig();
    });

    $('home-title-entry').addEventListener('click', showTitleModal);
    $('home-task-entry').addEventListener('click', showTaskModal);
    $('home-shop-entry').addEventListener('click', showShopModal);
    $('home-titles-list').addEventListener('click', e => {
      const item = e.target.closest('[data-id]');
      if (item) selectEquipTitle(item.dataset.id);
    });
    $('home-tasks-daily').addEventListener('click', e => {
      const btn = e.target.closest('.task-claim-btn');
      if (!btn) return;
      const gained = achievementManager.claimTaskReward(btn.dataset.id);
      showToast(gained > 0
        ? { title: `积分 +${gained} 已入账`, icon: 'success' }
        : { title: '该任务暂不可领取', icon: 'none' });
      renderTasks();
    });
    $('home-tasks-warmup').addEventListener('click', e => {
      const btn = e.target.closest('.task-claim-btn');
      if (!btn) return;
      const gained = achievementManager.claimWarmupReward(btn.dataset.id);
      showToast(gained > 0
        ? { title: `积分 +${gained} 已入账`, icon: 'success' }
        : { title: '该任务暂不可领取', icon: 'none' });
      renderTasks();
    });
    $('home-shop-list').addEventListener('click', e => {
      const btn = e.target.closest('.shop-buy-btn');
      if (!btn) return;
      const res = shopManager.buy(btn.dataset.id);
      showToast(res.ok
        ? { title: '购买成功，下一局自动生效', icon: 'success' }
        : { title: res.reason || '购买失败', icon: 'none' });
      renderShop();
    });
    $('home-titles-close').addEventListener('click', hideTitleModal);
    $('home-tasks-close').addEventListener('click', hideTaskModal);
    $('home-shop-close').addEventListener('click', hideShopModal);
    $('home-titles-mask').addEventListener('click', e => { if (e.target === e.currentTarget) hideTitleModal(); });
    $('home-tasks-mask').addEventListener('click', e => { if (e.target === e.currentTarget) hideTaskModal(); });
    $('home-shop-mask').addEventListener('click', e => { if (e.target === e.currentTarget) hideShopModal(); });

    $('mode-offline').addEventListener('click', () => { netMode = 'OFFLINE'; renderNetMode(); });
    $('mode-server').addEventListener('click', () => { netMode = 'SERVER'; renderNetMode(); });
    $('home-create-server-room').addEventListener('click', createServerRoom);
    $('home-join-link-copy').addEventListener('click', copyJoinLink);

    $('home-start').addEventListener('click', startGame);
    $('home-lobby-entry').addEventListener('click', goLobby);

    $('home-rules-header').addEventListener('click', () => { showRules = !showRules; renderRules(); });

    $('home-guide-skip').addEventListener('click', closeGuide);
    $('home-guide-next').addEventListener('click', guideNext);

    $('home-challenge-accept').addEventListener('click', acceptChallenge);
    $('home-challenge-dismiss').addEventListener('click', dismissChallenge);
  }
}
