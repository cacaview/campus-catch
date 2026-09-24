// js/main.js — 路由 + 全局状态（原 app.js 的 globalData）
// 视图模块契约：module.create(rootEl, globalState) → { onShow?, onHide? }

import * as home from './views/home.js';
import * as lobby from './views/lobby.js';
import * as game from './views/game.js';
import * as result from './views/result.js';
import * as rank from './views/rank.js';

export const globalState = {
  currentPlayer: null,       // { id, name, team, score }
  netMode: 'OFFLINE',        // 'OFFLINE' | 'SERVER'
  gameArea: null,            // { type: 'polygon', points: [{latitude, longitude}] }
  gameDurationSeconds: 600,
  lastGameResult: null,      // 结算数据（原 app.globalData.lastGameResult）
  aiFillCount: 3,
  roomQrUrl: '',
  challengeInvite: null,     // { by, team, time, myTeam }
  gameReady: false
};

// 桂林学院默认中心：原小程序 GCJ-02 25.2354,110.2890 换算为 WGS-84（tools/gcj2wgs.js，与 coordtransform 参考实现一致）
export const DEFAULT_CENTER = { latitude: 25.238236, longitude: 110.284419 };

// 启动参数：?challenge=1&by=xx&team=cat 或 ?server=wss://..&passcode=1234
export function parseQueryParams() {
  const q = new URLSearchParams(location.search);
  const out = {};
  if (q.get('challenge') === '1') {
    out.challenge = { by: q.get('by') || '好友', team: q.get('team') === 'mouse' ? 'mouse' : 'cat', time: Date.now() };
  }
  if (q.get('server')) out.server = q.get('server');
  if (q.get('passcode')) out.passcode = q.get('passcode');
  return out;
}

const VIEW_MODULES = { home, lobby, game, result, rank };
const VIEWS = ['home', 'lobby', 'game', 'result', 'rank'];
const instances = {};
let currentView = null;

export function navigate(view) {
  if (!VIEWS.includes(view)) view = 'home';
  if (location.hash === '#/' + view) {
    // 同视图重进（reLaunch 语义）：销毁重建
    const inst = instances[view];
    if (inst) { inst.onHide && inst.onHide(); delete instances[view]; }
    instances[view] = VIEW_MODULES[view].create(document.getElementById('view-' + view), globalState);
    instances[view].onShow && instances[view].onShow();
  } else {
    location.hash = '#/' + view;
  }
}

function initRouter() {
  const show = () => {
    const h = location.hash.replace(/^#\/?/, '');
    const next = VIEWS.includes(h) ? h : 'home';
    if (currentView && currentView !== next) {
      const old = instances[currentView];
      if (old && old.onHide) old.onHide();
    }
    document.querySelectorAll('.view').forEach(v => {
      v.classList.toggle('active', v.id === 'view-' + next);
    });
    currentView = next;
    if (!instances[next]) {
      const root = document.getElementById('view-' + next);
      instances[next] = VIEW_MODULES[next].create(root, globalState);
    }
    const inst = instances[next];
    if (inst.onShow) inst.onShow();
  };
  window.addEventListener('hashchange', show);
  if (!location.hash) location.hash = '#/home';
  show();
}

initRouter();
