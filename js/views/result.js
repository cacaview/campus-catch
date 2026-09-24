// js/views/result.js — 结算视图（源 pages/result/result.js 364 行全量移植）
// wx→Web：canvasToTempFilePath→canvas.toBlob，saveImageToPhotosAlbum→a[download]，
// onShareAppMessage→复制链接（?challenge=1&by=&team=），wx:if/wx:for→JS 渲染，
// map 组件→MapLibre 封装，getStorageSync/setStorageSync→platform/storage
import { navigate } from '../main.js';
import { showToast, setClipboardData } from '../platform/ui.js';
import { getStorage, setStorage } from '../platform/storage.js';
import { createMap } from '../lib/map.js';
import GameArea from '../utils/game-area.js';
import { getStablePlayerId } from '../utils/player-identity.js';

const RESULT_HTML = `
  <!-- 无结算数据空态：引导回首页开局，不展示任何 mock 战报 -->
  <div class="result-empty" id="result-empty">
    <span class="result-empty-icon">🎮</span>
    <span class="result-empty-text">还没有可展示的活动记录</span>
    <button class="btn btn-primary" id="result-empty-home">回首页开一局</button>
  </div>

  <div class="result-main" id="result-main" hidden>
    <!-- Particles for win -->
    <div class="result-particles" id="result-particles"></div>

    <div class="result-header anim-stagger-1">
      <span class="result-title" id="result-title"></span>
      <div class="result-banner-box">
        <span class="result-banner" id="result-banner"></span>
      </div>
    </div>

    <div class="scoreboard anim-stagger-2">
      <div class="team-col cat-col">
        <div class="col-title">猫队</div>
        <div class="player-list" id="result-cats"></div>
      </div>
      <div class="divider"></div>
      <div class="team-col mouse-col">
        <div class="col-title">鼠队</div>
        <div class="player-list" id="result-mice"></div>
      </div>
    </div>

    <div class="stats-section anim-stagger-3" id="result-stats"></div>

    <!-- 足迹回放 -->
    <div class="replay-card anim-stagger-3" id="result-replay-card" hidden>
      <div class="replay-header">
        <span class="replay-title">🐾 本局足迹回放</span>
        <span class="replay-progress" id="result-replay-progress"></span>
      </div>
      <div class="replay-map" id="result-replay-map"></div>
      <div class="replay-actions">
        <button class="btn btn-secondary replay-btn" id="result-replay-toggle">▶️ 播放回放</button>
        <button class="btn btn-secondary replay-btn" id="result-replay-restart">⟲ 重新播放</button>
      </div>
    </div>
    <div class="replay-empty anim-stagger-3" id="result-replay-empty" hidden>
      <span class="replay-empty-text">🐾 本局没有记录到足够的移动轨迹，跑起来再玩一局解锁足迹回放～</span>
    </div>

    <div class="actions anim-stagger-4">
      <button class="btn btn-primary" id="result-again">再来一局</button>
      <button class="btn btn-secondary" id="result-share">📤 分享活动结果</button>
    </div>
    <div class="actions anim-stagger-4 actions-row2">
      <button class="btn btn-secondary" id="result-save-card">🖼️ 保存活动卡片</button>
      <button class="btn btn-secondary" id="result-rank">查看排行</button>
      <button class="btn btn-secondary" id="result-home">回首页</button>
    </div>

    <!-- 战报卡片离屏画布（仅用于生成分享图） -->
    <canvas id="result-share-canvas" class="share-canvas"></canvas>
  </div>`;

export function create(rootEl, globalStateRef) {
  rootEl.innerHTML = RESULT_HTML;
  const $ = id => rootEl.querySelector('#' + id);

  /* ---------- 状态（源 data 对象） ---------- */
  const s = {
    noResult: false,
    result: {},
    catPlayers: [],
    mousePlayers: [],
    myId: '',
    myTeam: '',
    myStats: {},
    myScore: 0,
    myRank: 0,
    durationStr: '00:00',
    hasTrack: false,
    trackPoints: 0,
    replaying: false,
    replayIndex: 0
  };

  let map = null;
  let replayTimer = null;
  let track = [];
  let myName = '';
  let shareBlob = null;

  const esc = str => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------- 渲染 ---------- */

  const renderEmpty = () => {
    $('result-empty').hidden = s.noResult === false;
    $('result-main').hidden = s.noResult;
  };

  const playerItemHtml = p => `
    <div class="player-item${p.id === s.myId ? ' me' : ''}${p.isMVP ? ' mvp' : ''}">
      <span class="avatar">${p.team === 'cat' ? '🐱' : '🐭'}</span>
      <div class="p-info">
        <span class="p-name">${esc(p.name)}${p.id === s.myId ? ' <span class="tag">(我)</span>' : ''}</span>
        <span class="p-score">${p.score} 分</span>
      </div>
      ${p.isMVP ? '<span class="mvp-icon">👑</span>' : ''}
    </div>`;

  const renderResult = () => {
    rootEl.classList.toggle('win', s.result.winner === s.myTeam && s.result.winner !== 'draw');
    rootEl.classList.toggle('lose', s.result.winner !== s.myTeam && s.result.winner !== 'draw');

    const win = s.result.winner === s.myTeam && s.result.winner !== 'draw';
    // 粒子仅胜利时显示（源 wx:if result.winner === myTeam）
    $('result-particles').innerHTML = win
      ? Array.from({ length: 20 }).map(() => {
          const left = Math.random() * 100;
          const delay = Math.random() * 2;
          return `<span class="particle" style="left:${left}%;animation-delay:${delay}s"></span>`;
        }).join('')
      : '';

    $('result-title').textContent = s.result.winner === 'draw' ? '🤝 平局！'
      : (s.result.winner === s.myTeam ? '🎉 胜利！' : '😿 失败！');
    const banner = $('result-banner');
    const winnerCls = s.result.winner === 'draw' ? 'draw' : s.result.winner;
    banner.className = 'result-banner ' + winnerCls;
    banner.textContent = s.result.winner === 'draw' ? '🤝 双方打成平手'
      : ((s.result.winner === 'cat' ? '🐱 猫队' : '🐭 鼠队') + ' 获得最终胜利');

    $('result-cats').innerHTML = s.catPlayers.map(playerItemHtml).join('');
    $('result-mice').innerHTML = s.mousePlayers.map(playerItemHtml).join('');

    $('result-stats').innerHTML = `
      <div class="stat-item"><span class="stat-val">${s.myStats.distance || 0}m</span><span class="stat-label">移动距离</span></div>
      <div class="stat-item"><span class="stat-val">${s.myStats.actionCount || 0}</span><span class="stat-label">${s.myTeam === 'cat' ? '相遇次数' : '躲避次数'}</span></div>
      <div class="stat-item"><span class="stat-val">${s.myStats.skillUsed || 0}</span><span class="stat-label">技能使用</span></div>
      <div class="stat-item"><span class="stat-val">${s.durationStr}</span><span class="stat-label">活动时长</span></div>`;

    $('result-replay-card').hidden = !s.hasTrack;
    $('result-replay-empty').hidden = s.hasTrack;
    renderReplayProgress();
  };

  const renderReplayProgress = () => {
    $('result-replay-progress').textContent = s.replaying
      ? `回放中 ${s.replayIndex + 1}/${s.trackPoints}`
      : `共 ${s.trackPoints} 个轨迹点`;
    $('result-replay-toggle').textContent = s.replaying ? '⏸ 暂停回放' : '▶️ 播放回放';
  };

  /* ---------- 足迹回放（源 setupReplay/onReplayToggle/onReplayRestart L227-301 原样） ---------- */

  const setupReplay = pts => {
    track = pts;
    const points = track.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
    map.fitBounds(points, 60);
    map.setPolylines([{ points, color: '#ffd70088', width: 4 }]);
    map.setMarkers([]);
    s.replayIndex = 0;
    s.replaying = false;
    renderReplayProgress();
  };

  const stopReplayTimer = () => {
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
  };

  const onReplayToggle = () => {
    if (s.replaying) {
      stopReplayTimer();
      s.replaying = false;
      renderReplayProgress();
      return;
    }
    if (!track.length || track.length < 2) return;
    let i = (s.replayIndex || 0) >= track.length - 1 ? 0 : (s.replayIndex || 0);
    s.replaying = true;
    renderReplayProgress();
    replayTimer = setInterval(() => {
      if (i >= track.length) {
        stopReplayTimer();
        s.replaying = false;
        renderReplayProgress();
        return;
      }
      const p = track[i];
      const played = track.slice(Math.max(0, i - 40), i + 1)
        .map(x => ({ latitude: x.latitude, longitude: x.longitude }));
      s.replayIndex = i;
      map.setPolylines([
        { points: track.map(x => ({ latitude: x.latitude, longitude: x.longitude })), color: '#ffd70055', width: 4 },
        { points: played, color: '#ffd700', width: 6 }
      ]);
      map.setMarkers([{
        id: 1,
        latitude: p.latitude,
        longitude: p.longitude,
        icon: '🐾',
        label: `🐾 第 ${i + 1}/${track.length} 步`,
        color: '#ffd700'
      }]);
      renderReplayProgress();
      i += 1;
    }, 200);
  };

  const onReplayRestart = () => {
    stopReplayTimer();
    s.replaying = false;
    s.replayIndex = 0;
    if (track && track.length >= 2) setupReplay(track);
    renderReplayProgress();
  };

  /* ---------- 战报卡片（源 drawShareCard L83-186 逐行移植） ---------- */

  const roundRect = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  const drawShareCard = () => {
    const canvas = $('result-share-canvas');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 2;
    const W = 600, H = 960;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const r = s.result;
    const win = r.winner === s.myTeam && r.winner !== 'draw';
    const draw = r.winner === 'draw';
    const accent = draw ? '#ffd700' : (win ? '#7be0a2' : '#ff6b81');
    const stats = s.myStats || {};

    // 背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1a1a2e');
    bg.addColorStop(1, '#23234a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 顶部色带
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 10);

    const center = (text, y, font, color, bold) => {
      ctx.font = bold ? `bold ${font}px sans-serif` : `${font}px sans-serif`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(text, W / 2, y);
    };

    center(draw ? '🤝 平局' : (win ? '🎉 胜利！' : '😿 惜败'), 120, 56, accent, true);
    center(`${s.myTeam === 'cat' ? '🐱 猫队' : '🐭 鼠队'} · ${myName || '我'}`, 180, 30, '#e8eaf8', false);

    center(String(s.myScore), 320, 140, '#ffd700', true);
    center('我的积分', 370, 26, '#9aa0c3', false);

    // 名次徽章
    if (s.myRank > 0) {
      center(`全场第 ${s.myRank} 名`, 430, 30, '#6fd8ff', true);
    }

    // 统计框
    const rows = [
      ['🏃 移动距离', `${stats.distance || 0} m`],
      [s.myTeam === 'cat' ? '🎯 相遇次数' : '💨 躲避次数', String(s.myTeam === 'cat' ? (stats.myCatches || 0) : (stats.myEscapes || 0))],
      ['🃏 技能使用', String(stats.skillUsed || 0)],
      ['⏱ 活动时长', s.durationStr]
    ];
    let y = 500;
    rows.forEach(([k, v]) => {
      ctx.textAlign = 'left';
      ctx.font = '28px sans-serif';
      ctx.fillStyle = '#9aa0c3';
      ctx.fillText(k, 80, y);
      ctx.textAlign = 'right';
      ctx.font = 'bold 32px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(v, W - 80, y);
      y += 76;
    });

    // 底部横幅
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, 40, 830, W - 80, 90, 20);
    ctx.fill();
    center('校园定位活动 · 校园版', 878, 28, '#ffd700', true);
    center(new Date().toLocaleDateString('zh-CN'), 908, 20, '#8a8fb0', false);

    // 导出图片供分享使用（wx.canvasToTempFilePath → toBlob）
    if (canvas.toBlob) {
      canvas.toBlob(b => { shareBlob = b; }, 'image/png');
    }
  };

  /* ---------- 操作 ---------- */

  // 保存战报卡片（源 saveShareCard L199-223：相册 → 浏览器下载）
  const saveShareCard = () => {
    if (!shareBlob) {
      drawShareCard();
      showToast({ title: '卡片生成中，稍后再试', icon: 'none' });
      return;
    }
    const url = URL.createObjectURL(shareBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '战报卡片.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast({ title: '已下载战报卡片，去分享吧！', icon: 'none' });
  };

  // 好友分享（源 onShareAppMessage L96-102：微信卡片 → 复制应战链接）
  const shareChallenge = () => {
    const url = `${location.origin}${location.pathname}?challenge=1&by=${encodeURIComponent(myName || '玩家')}&team=${s.myTeam}`;
    setClipboardData(url).then(() => {
      showToast({ title: '应战链接已复制，发给好友吧！', icon: 'none' });
    });
  };

  // 历史战绩（源 saveToHistory L310-322 原样）
  const saveToHistory = result => {
    let history = getStorage('gameHistory') || [];
    const players = (result.players || []).map(p => ({ ...p, team: String(p.team || '').toLowerCase() }));
    history.push({
      date: new Date().getTime(),
      winner: String(result.winner || '').toLowerCase(),
      players
    });
    if (history.length > 50) history = history.slice(-50);
    setStorage('gameHistory', history);
  };

  const formatTime = seconds => {
    if (!seconds) return '00:00';
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const sec = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  // 再来一局（源 playAgain L325-333 原样：沿用配置直接重开）
  const playAgain = () => {
    const cfg = getStorage('indexCfg') || {};
    const lastPlayer = globalStateRef.currentPlayer;
    const team = cfg.selectedTeam || (lastPlayer && lastPlayer.team) || 'mouse';
    const name = (lastPlayer && lastPlayer.name) || getStorage('lastNickname') || '玩家';

    globalStateRef.currentPlayer = {
      id: getStablePlayerId(),
      name,
      team,
      score: 0
    };
    globalStateRef.netMode = 'OFFLINE';
    globalStateRef.gameReady = true;
    const rawPoints = Array.isArray(cfg.areaRawPoints) ? cfg.areaRawPoints : [];
    if (rawPoints.length >= 3) {
      globalStateRef.gameArea = { type: 'polygon', points: GameArea.orderBoundaryPoints(rawPoints) };
    } else if (!globalStateRef.gameArea) {
      globalStateRef.gameArea = null;
    }
    globalStateRef.gameDurationSeconds = (Number(cfg.durationMinutes) || 10) * 60;
    navigate('game');
  };

  /* ---------- 生命周期 ---------- */

  const onShow = () => {
    // 无结算数据（直接打开本页/异常路径）时展示空态引导
    const gameResult = globalStateRef.lastGameResult;
    if (!gameResult || !Array.isArray(gameResult.players) || !gameResult.players.length) {
      s.noResult = true;
      renderEmpty();
      return;
    }
    s.noResult = false;
    renderEmpty();

    const myPlayer = globalStateRef.currentPlayer || { id: gameResult.players[0].id, team: gameResult.players[0].team };

    // 分阵营榜 + MVP（源 onLoad L47-52 原样）
    s.catPlayers = gameResult.players.filter(p => p.team === 'cat').sort((a, b) => b.score - a.score);
    s.mousePlayers = gameResult.players.filter(p => p.team === 'mouse').sort((a, b) => b.score - a.score);
    if (s.catPlayers.length > 0) s.catPlayers[0].isMVP = true;
    if (s.mousePlayers.length > 0) s.mousePlayers[0].isMVP = true;

    // 我的积分与全场排名（分享卡片文案用）
    const allSorted = [...s.catPlayers, ...s.mousePlayers].sort((a, b) => b.score - a.score);
    const myIndex = allSorted.findIndex(p => p.id === myPlayer.id);
    const meRow = myIndex >= 0 ? allSorted[myIndex] : null;

    saveToHistory(gameResult);

    s.result = gameResult;
    myName = myPlayer.name || getStorage('lastNickname') || '玩家';
    s.myId = myPlayer.id;
    s.myTeam = myPlayer.team;
    s.myScore = meRow ? meRow.score : 0;
    s.myRank = myIndex >= 0 ? myIndex + 1 : 0;
    s.myStats = gameResult.stats || { distance: 0, actionCount: 0, skillUsed: 0 };
    s.durationStr = formatTime(gameResult.duration);
    const pts = Array.isArray(gameResult.track) ? gameResult.track : [];
    s.hasTrack = pts.length >= 2;
    s.trackPoints = pts.length;

    renderResult();

    // 足迹回放地图
    if (s.hasTrack) {
      if (!map) {
        map = createMap($('result-replay-map'), {
          center: [pts[0].longitude, pts[0].latitude],
          zoom: 16
        });
      }
      map.setPolygon([]);
      setupReplay(pts);
    } else if (map) {
      map.destroy();
      map = null;
    }

    // 提前渲染分享卡片（源 onReady）
    drawShareCard();
  };

  const onHide = () => {
    stopReplayTimer();
    if (map) {
      map.destroy();
      map = null;
    }
  };

  /* ---------- 事件绑定（一次性） ---------- */
  $('result-empty-home').addEventListener('click', () => navigate('home'));
  $('result-again').addEventListener('click', playAgain);
  $('result-share').addEventListener('click', shareChallenge);
  $('result-save-card').addEventListener('click', saveShareCard);
  $('result-rank').addEventListener('click', () => navigate('rank'));
  $('result-home').addEventListener('click', () => navigate('home'));
  $('result-replay-toggle').addEventListener('click', onReplayToggle);
  $('result-replay-restart').addEventListener('click', onReplayRestart);

  return { onShow, onHide };
}
