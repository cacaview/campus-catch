// js/views/lobby.js — 单机 AI 大厅与服务器在线等待大厅
import { navigate } from '../main.js?v=347ee3abc67c';
import { showToast, showModal, setClipboardData } from '../platform/ui.js';
import { networkManager } from '../utils/network/network-manager.js';
import { roomSession } from '../utils/network/room-session.js';
import { MSG_TYPES } from '../utils/network/protocol.js';

const AI_ROSTER = ['AI猫-汤姆', 'AI鼠-杰瑞', 'AI鼠-泰菲', 'AI猫-斯派克', 'AI鼠-布奇'];
const MAX_AI = AI_ROSTER.length;

const LOBBY_HTML = `
  <div class="lobby-title">🛋️ 房间大厅</div>
  <div class="lobby-container">
    <div class="room-card">
      <div class="room-mode" id="lobby-mode">🤖 单机房间</div>
      <div class="room-meta" id="lobby-meta"></div>
      <div class="online-invite" id="lobby-online-invite" hidden>
        <div class="room-code-row">
          <span class="invite-label">房间身份码</span>
          <strong class="room-code-value" id="lobby-room-passcode"></strong>
          <button class="btn btn-ghost" id="lobby-copy-passcode">复制身份码</button>
        </div>
        <span class="invite-label">邀请链接</span>
        <span class="invite-link" id="lobby-invite-link"></span>
        <button class="btn btn-ghost" id="lobby-copy-link">📋 复制邀请链接</button>
      </div>
      <div class="online-status" id="lobby-online-status" hidden></div>
    </div>

    <div class="players-card">
      <div class="card-title">👥 玩家列表（<span id="lobby-count">0</span> 人）</div>
      <div id="lobby-players"></div>
      <div class="ai-stepper" id="lobby-ai-stepper">
        <span class="ai-label">🤖 AI 补位</span>
        <div class="stepper">
          <button class="step-btn" id="lobby-ai-minus" aria-label="减少 AI">−</button>
          <span class="step-num" id="lobby-ai-count">3</span>
          <button class="step-btn" id="lobby-ai-plus" aria-label="增加 AI">＋</button>
        </div>
      </div>
    </div>

    <div class="lobby-actions">
      <button class="btn btn-primary" id="lobby-start">🚀 开始活动</button>
      <div class="secondary-actions" id="lobby-secondary-actions">
        <button class="btn btn-ghost" id="lobby-edit">⚙️ 修改配置</button>
        <button class="btn btn-ghost danger" id="lobby-dissolve">🚪 解散房间</button>
      </div>
    </div>
  </div>`;

export function create(rootEl, globalStateRef) {
  const $ = id => document.getElementById(id);
  rootEl.innerHTML = LOBBY_HTML;
  let aiFillCount = 3;
  let listenersBound = false;
  let startRequestPending = false;

  const appendText = (parent, tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  };

  const renderPlayers = players => {
    const list = $('lobby-players');
    list.textContent = '';
    $('lobby-count').textContent = String(players.length);
    for (const player of players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      appendText(row, 'span', 'p-avatar', player.team === 'cat' ? '🐱' : '🐭');
      appendText(row, 'span', 'p-name', player.name || '玩家');
      if (player.isHost || String(player.id) === String(roomSession.hostId)) {
        appendText(row, 'span', 'p-tag host', '房主');
      }
      if (player.isAI) appendText(row, 'span', 'p-tag ai', 'AI');
      appendText(row, 'span', 'p-ready', player.isAI ? '已就绪' : '在线');
      list.appendChild(row);
    }
  };

  const renderOfflineLobby = () => {
    const me = globalStateRef.currentPlayer || { id: 'me', name: '玩家', team: 'mouse' };
    const players = [{ ...me, isHost: true, isAI: false, ready: true }];
    for (let i = 0; i < aiFillCount; i++) {
      players.push({
        id: `ai_${i}`,
        name: AI_ROSTER[i],
        team: AI_ROSTER[i].includes('猫') ? 'cat' : 'mouse',
        isHost: false,
        isAI: true,
        ready: true
      });
    }
    renderPlayers(players);
    $('lobby-ai-count').textContent = String(aiFillCount);
    $('lobby-ai-minus').disabled = aiFillCount <= 0;
    $('lobby-ai-plus').disabled = aiFillCount >= MAX_AI;
  };

  const renderOnlineLobby = () => {
    const connected = networkManager.state === 'CONNECTED';
    const phase = roomSession.phase;
    const members = roomSession.members || [];
    const inviteUrl = `${location.origin}${location.pathname}?server=${encodeURIComponent(networkManager.targetUrl)}&passcode=${encodeURIComponent(roomSession.passcode)}`;
    $('lobby-mode').textContent = '🌐 在线房间';
    $('lobby-room-passcode').textContent = roomSession.passcode || '----';
    $('lobby-meta').textContent = `⏱ 活动时长：${Math.round((roomSession.gameDurationSeconds || 600) / 60)} 分钟`;
    $('lobby-online-invite').hidden = false;
    $('lobby-invite-link').textContent = inviteUrl;
    $('lobby-online-status').hidden = false;
    $('lobby-online-status').textContent = !connected
      ? '服务器连接中断，正在尝试重连…'
      : phase === 'STARTED'
        ? '活动已开始，正在进入…'
        : roomSession.isHost
          ? (members.length < 2 ? '服务器已连接，等待队员加入' : '队员已加入，房主可以开始活动')
          : '服务器已连接，等待房主开始活动';
    $('lobby-ai-stepper').hidden = true;
    $('lobby-secondary-actions').hidden = true;
    renderPlayers(members);

    const startButton = $('lobby-start');
    const canStart = connected && roomSession.isHost && members.length >= 2 && phase === 'WAITING' && !startRequestPending;
    startButton.disabled = !canStart;
    if (startRequestPending) startButton.textContent = '正在请求开始…';
    else if (phase === 'STARTED') startButton.textContent = '活动已开始';
    else if (!connected) startButton.textContent = '等待服务器连接';
    else if (roomSession.isHost && members.length < 2) startButton.textContent = '等待队员加入';
    else if (roomSession.isHost) startButton.textContent = '🚀 开始活动';
    else startButton.textContent = '等待房主开始';
  };

  const onPlayerChange = () => renderOnlineLobby();
  const onHostChange = () => renderOnlineLobby();
  const onStateChange = () => {
    if (networkManager.state !== 'CONNECTED') startRequestPending = false;
    renderOnlineLobby();
  };
  const onJoinSuccess = () => {
    renderOnlineLobby();
    if (roomSession.phase === 'STARTED') navigate('game');
  };
  const onStartError = payload => {
    startRequestPending = false;
    showToast({ title: payload?.message || '开始活动失败，请稍后重试', icon: 'none' });
    renderOnlineLobby();
  };
  const onRoomStarted = () => {
    startRequestPending = false;
    navigate('game');
  };

  const bindNetworkListeners = () => {
    if (listenersBound) return;
    listenersBound = true;
    networkManager.on(MSG_TYPES.PLAYER_JOINED, onPlayerChange);
    networkManager.on(MSG_TYPES.PLAYER_LEFT, onPlayerChange);
    networkManager.on(MSG_TYPES.ROOM_HOST_CHANGED, onHostChange);
    networkManager.on(MSG_TYPES.ROOM_STARTED, onRoomStarted);
    networkManager.on(MSG_TYPES.ROOM_START_ERROR, onStartError);
    networkManager.on('joinSuccess', onJoinSuccess);
    networkManager.on('stateChange', onStateChange);
  };

  const unbindNetworkListeners = () => {
    if (!listenersBound) return;
    listenersBound = false;
    networkManager.off(MSG_TYPES.PLAYER_JOINED, onPlayerChange);
    networkManager.off(MSG_TYPES.PLAYER_LEFT, onPlayerChange);
    networkManager.off(MSG_TYPES.ROOM_HOST_CHANGED, onHostChange);
    networkManager.off(MSG_TYPES.ROOM_STARTED, onRoomStarted);
    networkManager.off(MSG_TYPES.ROOM_START_ERROR, onStartError);
    networkManager.off('joinSuccess', onJoinSuccess);
    networkManager.off('stateChange', onStateChange);
  };

  const onShow = () => {
    if (!globalStateRef.currentPlayer) {
      showToast({ title: '请先回首页选择队伍并输入昵称', icon: 'none' });
      navigate('home');
      return;
    }
    if (globalStateRef.netMode === 'SERVER') {
      if (!roomSession.roomId || !roomSession.passcode) {
        showToast({ title: '请先创建或加入服务器房间', icon: 'none' });
        navigate('home');
        return;
      }
      bindNetworkListeners();
      renderOnlineLobby();
      if (roomSession.phase === 'STARTED') navigate('game');
      return;
    }
    unbindNetworkListeners();
    aiFillCount = Math.max(0, Math.min(MAX_AI, Number(globalStateRef.aiFillCount ?? 3)));
    const durationMin = Math.round((globalStateRef.gameDurationSeconds || 600) / 60);
    const area = globalStateRef.gameArea;
    const areaText = area && Array.isArray(area.points) && area.points.length
      ? `已框选 ${area.points.length} 个边界点`
      : '未框选区域';
    $('lobby-meta').innerHTML = `<span>⏱ 时长：${durationMin} 分钟</span><span>📍 ${areaText}</span>`;
    renderOfflineLobby();
  };

  const onAiChange = delta => {
    const next = Math.max(0, Math.min(MAX_AI, aiFillCount + delta));
    aiFillCount = next;
    globalStateRef.aiFillCount = next;
    renderOfflineLobby();
  };

  const startFromLobby = () => {
    globalStateRef.gameReady = true;
    globalStateRef.aiFillCount = aiFillCount;
    navigate('game');
  };

  const startOnlineRoom = () => {
    if (!roomSession.isHost || roomSession.phase !== 'WAITING' || roomSession.members.length < 2) return;
    startRequestPending = true;
    renderOnlineLobby();
    if (!networkManager.send(MSG_TYPES.ROOM_START_REQUEST, {})) {
      startRequestPending = false;
      showToast({ title: '服务器暂不可用，无法开始活动', icon: 'none' });
      renderOnlineLobby();
    }
  };

  const copyInviteLink = () => {
    const inviteUrl = $('lobby-invite-link').textContent;
    if (!inviteUrl) return;
    setClipboardData(inviteUrl).then(() => {
      showToast({ title: '邀请链接已复制，发给队友即可', icon: 'success' });
    });
  };

  const copyRoomPasscode = () => {
    if (!roomSession.passcode) return;
    setClipboardData(roomSession.passcode).then(() => {
      showToast({ title: '房间身份码已复制', icon: 'success' });
    });
  };

  const editConfig = () => navigate('home');
  const dissolveRoom = async () => {
    const res = await showModal({ title: '解散房间', content: '确定解散当前房间并返回首页吗？' });
    if (!res.confirm) return;
    globalStateRef.gameReady = false;
    navigate('home');
  };

  $('lobby-ai-minus').addEventListener('click', () => onAiChange(-1));
  $('lobby-ai-plus').addEventListener('click', () => onAiChange(1));
  $('lobby-start').addEventListener('click', () => {
    if (globalStateRef.netMode === 'SERVER') startOnlineRoom();
    else startFromLobby();
  });
  $('lobby-copy-link').addEventListener('click', copyInviteLink);
  $('lobby-copy-passcode').addEventListener('click', copyRoomPasscode);
  $('lobby-edit').addEventListener('click', editConfig);
  $('lobby-dissolve').addEventListener('click', dissolveRoom);

  const onHide = () => {
    unbindNetworkListeners();
    startRequestPending = false;
  };
  return { onShow, onHide };
}
