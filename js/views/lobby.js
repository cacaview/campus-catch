// js/views/lobby.js — 大厅（源 pages/lobby/lobby.js 154 行，Web 单机专用裁剪：去房间码/二维码/LAN 同步）
import { navigate } from '../main.js';
import { showToast, showModal } from '../platform/ui.js';

// 单机 AI 补位名单（与 game.js initMockAIPlayers 保持一致）
const AI_ROSTER = ['AI猫-汤姆', 'AI鼠-杰瑞', 'AI鼠-泰菲', 'AI猫-斯派克', 'AI鼠-布奇'];
const MAX_AI = AI_ROSTER.length;

const LOBBY_HTML = `
  <div class="lobby-title">🛋️ 房间大厅</div>
  <div class="lobby-container">
    <!-- 房间信息卡 -->
    <div class="room-card">
      <div class="room-mode" id="lobby-mode">🤖 单机房间</div>
      <div class="room-meta" id="lobby-meta"></div>
    </div>

    <!-- 玩家列表 -->
    <div class="players-card">
      <div class="card-title">👥 玩家列表（<span id="lobby-count">0</span> 人）</div>
      <div id="lobby-players"></div>
      <!-- 单机 AI 补位步进器 -->
      <div class="ai-stepper" id="lobby-ai-stepper">
        <span class="ai-label">🤖 AI 补位</span>
        <div class="stepper">
          <button class="step-btn" id="lobby-ai-minus" aria-label="减少 AI">−</button>
          <span class="step-num" id="lobby-ai-count">3</span>
          <button class="step-btn" id="lobby-ai-plus" aria-label="增加 AI">＋</button>
        </div>
      </div>
    </div>

    <!-- 操作区 -->
    <div class="lobby-actions">
      <button class="btn btn-primary" id="lobby-start">🚀 开始活动</button>
      <div class="secondary-actions">
        <button class="btn btn-ghost" id="lobby-edit">⚙️ 修改配置</button>
        <button class="btn btn-ghost danger" id="lobby-dissolve">🚪 解散房间</button>
      </div>
    </div>
  </div>`;

export function create(rootEl, globalStateRef) {
  const $ = id => document.getElementById(id);
  rootEl.innerHTML = LOBBY_HTML;
  let aiFillCount = 3;

  const buildPlayers = () => {
    const me = globalStateRef.currentPlayer || { id: 'me', name: '玩家', team: 'mouse' };
    const players = [{ ...me, isHost: true, isAI: false, ready: true }];
    for (let i = 0; i < aiFillCount; i++) {
      players.push({
        id: `ai_${i}`,
        name: AI_ROSTER[i],
        team: AI_ROSTER[i].includes('猫') ? 'cat' : 'mouse',
        isHost: false, isAI: true, ready: true
      });
    }
    $('lobby-count').textContent = players.length;
    $('lobby-players').innerHTML = players.map(p =>
      `<div class="player-row">
         <span class="p-avatar">${p.team === 'cat' ? '🐱' : '🐭'}</span>
         <span class="p-name">${p.name}</span>
         ${p.isHost ? '<span class="p-tag host">房主</span>' : ''}
         ${p.isAI ? '<span class="p-tag ai">AI</span>' : ''}
         <span class="p-ready">已就绪</span>
       </div>`).join('');
    $('lobby-ai-count').textContent = aiFillCount;
    $('lobby-ai-minus').disabled = aiFillCount <= 0;
    $('lobby-ai-plus').disabled = aiFillCount >= MAX_AI;
  };

  const onShow = () => {
    // 守卫：无身份不能进大厅（对应源 tabBar 裸进守卫精神）
    if (!globalStateRef.currentPlayer) {
      showToast({ title: '请先回首页选择队伍并输入昵称', icon: 'none' });
      navigate('home');
      return;
    }
    aiFillCount = Math.max(0, Math.min(MAX_AI, Number(globalStateRef.aiFillCount ?? 3)));
    const durationMin = Math.round((globalStateRef.gameDurationSeconds || 600) / 60);
    const area = globalStateRef.gameArea;
    const areaText = area && Array.isArray(area.points) && area.points.length
      ? `已框选 ${area.points.length} 个边界点`
      : '未框选区域';
    $('lobby-meta').innerHTML = `<span>⏱ 时长：${durationMin} 分钟</span><span>📍 ${areaText}</span>`;
    buildPlayers();
  };

  const onAiChange = delta => {
    const next = Math.max(0, Math.min(MAX_AI, aiFillCount + delta));
    aiFillCount = next;
    globalStateRef.aiFillCount = next;
    buildPlayers();
  };

  // 源 startFromLobby 单机分支：置 gameReady → 进游戏页
  const startFromLobby = () => {
    globalStateRef.gameReady = true;
    globalStateRef.aiFillCount = aiFillCount;
    navigate('game');
  };

  // 源 editConfig：回首页调整（配置已持久化在 indexCfg）
  const editConfig = () => navigate('home');

  // 源 dissolveRoom：确认弹窗 → 清 gameReady → 回首页（去掉联机 disconnect/reset）
  const dissolveRoom = async () => {
    const res = await showModal({
      title: '解散房间',
      content: '确定解散当前房间并返回首页吗？'
    });
    if (!res.confirm) return;
    globalStateRef.gameReady = false;
    navigate('home');
  };

  $('lobby-ai-minus').addEventListener('click', () => onAiChange(-1));
  $('lobby-ai-plus').addEventListener('click', () => onAiChange(1));
  $('lobby-start').addEventListener('click', startFromLobby);
  $('lobby-edit').addEventListener('click', editConfig);
  $('lobby-dissolve').addEventListener('click', dissolveRoom);

  const onHide = () => {};
  return { onShow, onHide };
}
