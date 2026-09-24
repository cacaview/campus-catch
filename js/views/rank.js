// js/views/rank.js — 排行榜视图（源 pages/rank/rank.js 135 行逻辑全保留）
// wx→Web：getStorageSync→getStorage，setData→状态+渲染，wx:for/wx:if→JS 渲染
import { navigate } from '../main.js';
import { getStorage } from '../platform/storage.js';

// 时间范围：本周榜 / 本月榜 / 总榜
const PERIODS = {
  week: 7 * 24 * 3600 * 1000,
  month: 30 * 24 * 3600 * 1000,
  all: 0
};

const RANK_HTML = `
  <div class="rank-container">
    <div class="header">
      <span class="title">🏆 活动排行榜</span>
    </div>

    <!-- 时间范围：周榜 / 月榜 / 总榜 -->
    <div class="period-tabs">
      <div class="period-tab" data-period="week">周榜</div>
      <div class="period-tab" data-period="month">月榜</div>
      <div class="period-tab active" data-period="all">总榜</div>
    </div>

    <!-- 我的排名速览 -->
    <div class="my-rank-bar" id="rank-my-bar" hidden></div>
    <div class="mock-tip" id="rank-mock-tip" hidden>ℹ️ 以下为示例数据，完成一局真实活动后将替换为你的战绩</div>

    <div class="tabs">
      <div class="tab active" data-tab="all">总排行</div>
      <div class="tab" data-tab="cat">猫队榜</div>
      <div class="tab" data-tab="mouse">鼠队榜</div>
    </div>

    <div class="rank-list" id="rank-list"></div>

    <div class="empty-state" id="rank-empty" hidden>
      <span class="empty-icon">📭</span>
      <span class="empty-text">这个时间段还没有活动记录，快去参加一次吧！</span>
      <button class="play-btn" id="rank-go-play">去活动</button>
    </div>
  </div>`;

export function create(rootEl, globalStateRef) {
  rootEl.innerHTML = RANK_HTML;
  const $ = id => rootEl.querySelector('#' + id);

  // 状态（源 data 对象）
  const s = {
    currentTab: 'all',
    period: 'all',
    rankData: [],
    myName: '',
    myRank: 0,
    myScore: 0,
    usingMock: false
  };

  const esc = str => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ---------- 渲染 ---------- */

  const renderTabs = () => {
    rootEl.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === s.currentTab));
    rootEl.querySelectorAll('.period-tab').forEach(el => el.classList.toggle('active', el.dataset.period === s.period));
  };

  const renderMyBar = () => {
    const show = s.myRank > 0;
    $('rank-my-bar').hidden = !show;
    if (show) {
      const periodWord = s.period === 'week' ? '周' : (s.period === 'month' ? '月' : '榜');
      $('rank-my-bar').innerHTML = `🔖 ${esc(s.myName || '我')}：本${periodWord}第 <span class="my-rank-num">${s.myRank}</span> 名 · 共 ${s.myScore} 分`;
    }
  };

  const rankItemHtml = (p, index) => `
    <div class="rank-item${index < 3 ? ' top-' + (index + 1) : ''}${p.isMe ? ' is-me' : ''}">
      <div class="rank-num">
        ${index > 2 ? index + 1 : (index === 0 ? '<span class="medal">🥇</span>' : index === 1 ? '<span class="medal">🥈</span>' : '<span class="medal">🥉</span>')}
      </div>
      <div class="avatar-box"><span class="avatar">${p.team === 'cat' ? '🐱' : '🐭'}</span></div>
      <div class="info">
        <span class="name">${esc(p.name)}${p.isMock ? ' <span class="mock-badge">示例</span>' : ''}</span>
        <span class="stats">场次: ${p.games} | 胜率: ${p.winRate}%</span>
      </div>
      <div class="score">
        <span class="score-val">${p.totalScore}</span>
        <span class="score-label">总分</span>
      </div>
    </div>`;

  const renderList = () => {
    const hasData = s.rankData.length > 0;
    $('rank-list').hidden = !hasData;
    $('rank-empty').hidden = hasData;
    $('rank-mock-tip').hidden = !s.usingMock;
    $('rank-list').innerHTML = hasData ? s.rankData.map(rankItemHtml).join('') : '';
    renderMyBar();
    renderTabs();
  };

  /* ---------- 数据（源 loadRankData 原样移植） ---------- */

  const loadRankData = () => {
    const history = getStorage('gameHistory') || [];
    const isAI = p => /^(AI|电脑)/i.test(String(p.name || '')) || /^\d+$/.test(String(p.id ?? ''));

    // 周榜/月榜：按对局日期过滤（旧记录无 date 字段时视为不计入周期榜）
    let games = history;
    if (s.period !== 'all') {
      const since = Date.now() - PERIODS[s.period];
      games = history.filter(g => Number(g.date) >= since);
    }

    // 聚合键：新记录用稳定 playerId（'u_' 前缀，跨局不变）；
    // 旧记录回退按昵称聚合，避免历史战绩碎裂
    const playerStats = {};
    games.forEach(game => {
      (game.players || []).forEach(p => {
        const team = String(p.team || '').toLowerCase();
        if (team !== 'cat' && team !== 'mouse') return;
        if (isAI(p)) return;

        const key = String(p.id || '').startsWith('u_') ? 'id:' + p.id : 'name:' + p.name;
        if (!playerStats[key]) {
          playerStats[key] = {
            key,
            playerId: String(p.id || '').startsWith('u_') ? p.id : '',
            name: p.name,
            team,
            totalScore: 0,
            games: 0,
            wins: 0
          };
        }

        const stat = playerStats[key];
        stat.totalScore += p.score;
        stat.games += 1;
        if (game.winner === p.team || game.winner === team) {
          stat.wins += 1;
        }
        stat.team = team;
        stat.name = p.name || stat.name;
      });
    });

    const myStableId = getStorage('playerId');
    const rankList = Object.values(playerStats).map(p => {
      p.winRate = Math.round((p.wins / p.games) * 100);
      p.isMe = (p.playerId && p.playerId === myStableId) || (!p.playerId && p.name === s.myName);
      p.isMock = false;
      return p;
    });

    rankList.sort((a, b) => b.totalScore - a.totalScore);

    // 同名新旧记录并存时「我」只认稳定 id 行
    const myIdRow = rankList.find(p => p.playerId && p.isMe);
    if (myIdRow) {
      rankList.forEach(p => { if (p !== myIdRow) p.isMe = false; });
    }

    // 无真实战绩时的示例数据：明确打上「示例」标记
    let usingMock = false;
    if (rankList.length === 0) {
      usingMock = true;
      rankList.push(
        { key: 'mock_1', name: '猫神', team: 'cat', totalScore: 850, games: 10, winRate: 80, isMe: false, isMock: true },
        { key: 'mock_2', name: '鼠霸天', team: 'mouse', totalScore: 720, games: 12, winRate: 66, isMe: false, isMock: true },
        { key: 'mock_3', name: '路人甲', team: 'cat', totalScore: 450, games: 8, winRate: 50, isMe: false, isMock: true }
      );
    }

    const filtered = s.currentTab === 'all' ? rankList : rankList.filter(p => p.team === s.currentTab);
    const myRow = rankList.find(p => p.isMe);

    s.rankData = filtered;
    s.usingMock = usingMock;
    s.myRank = myRow ? filtered.findIndex(p => p.isMe) + 1 : 0;
    s.myScore = myRow ? myRow.totalScore : 0;
    renderList();
  };

  /* ---------- 事件绑定（一次性） ---------- */
  rootEl.querySelectorAll('.tab').forEach(el => {
    el.addEventListener('click', () => {
      s.currentTab = el.dataset.tab;
      loadRankData();
    });
  });
  rootEl.querySelectorAll('.period-tab').forEach(el => {
    el.addEventListener('click', () => {
      s.period = el.dataset.period;
      loadRankData();
    });
  });
  $('rank-go-play').addEventListener('click', () => navigate('home'));

  /* ---------- 生命周期 ---------- */

  const onShow = () => {
    s.myName = getStorage('lastNickname') || '';
    loadRankData();
  };

  const onHide = () => {};

  return { onShow, onHide };
}
