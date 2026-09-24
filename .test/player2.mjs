/**
 * 🐭 测试用「第二实例」客户端（模拟 GPS 的联机玩家）
 *
 * 作为联机房间里的第二个实例（加入者 / 鼠队），与浏览器里的完整 Web 应用
 * （房主 / 猫队）通过中继服务器同处一个房间，验证双向同步：
 *   - 本端发送 PLAYER_MOVE（模拟 GPS 沿椭圆轨迹移动）→ 浏览器渲染远程标记
 *   - 接收浏览器发来的 PLAYER_MOVE → 打印其坐标（证明 浏览器→中继→本端 同步）
 *   - 发送 CHAT_MESSAGE / CATCH_EVENT → 浏览器展示聊天与抓捕弹层
 *
 * 用法：
 *   node .test/player2.mjs <passcode> [wsUrl] [durationSec]
 *   例： node .test/player2.mjs 1234 ws://127.0.0.1:8080 90
 */
import WebSocket from 'ws';

const PASSCODE = process.argv[2] || '8888';
const URL = process.argv[3] || 'ws://127.0.0.1:8080';
const DURATION = Number(process.argv[4] || 90);

const MY = { id: 'p2_mouse_001', name: '测试鼠·Jerry', team: 'mouse', score: 0 };

// 模拟 GPS 基准点：房主（浏览器）在 DEFAULT_CENTER(25.238236,110.284419)，
// 本端取其东北方向 ~60m 处为圆心，沿 ~30m 半径椭圆巡游（始终在 200m 模板区域内）。
const BASE_LAT = 25.238595;
const BASE_LNG = 110.285015;
const R_LAT = 0.00026; // ≈ 29m
const R_LNG = 0.00030; // ≈ 30m
const PERIOD = 28;     // 秒/圈

const t0 = Date.now();
const simPos = () => {
  const t = (Date.now() - t0) / 1000;
  const a = (2 * Math.PI * t) / PERIOD;
  return {
    latitude: BASE_LAT + R_LAT * Math.sin(a),
    longitude: BASE_LNG + R_LNG * Math.cos(a)
  };
};

let ws = null;
let seq = 0;
let hostName = '房主';
const timers = [];

const log = (m) => console.log(`[p2] ${new Date().toISOString().slice(11, 19)} ${m}`);
const after = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); };

function send(type, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, senderId: MY.id, timestamp: Date.now(), payload }));
}

function sendMove() {
  const p = simPos();
  seq++;
  send('PLAYER_MOVE', { id: MY.id, name: MY.name, team: MY.team, latitude: p.latitude, longitude: p.longitude, score: 0 });
  if (seq % 10 === 1) log(`→ PLAYER_MOVE #${seq} lat=${p.latitude.toFixed(6)} lng=${p.longitude.toFixed(6)}`);
}

function connect() {
  log(`连接 ${URL} ...`);
  ws = new WebSocket(URL);
  ws.on('open', () => {
    log('已连接，发送 JOIN_ROOM（passcode=' + PASSCODE + '）');
    send('JOIN_ROOM', { passcode: PASSCODE, player: MY, gameArea: null, gameDurationSeconds: 600 });
  });
  ws.on('message', (buf) => {
    let pkt; try { pkt = JSON.parse(buf.toString()); } catch { return; }
    const { type, payload } = pkt;
    switch (type) {
      case 'JOIN_ACK': {
        log(`✅ JOIN_ACK：房内 ${payload.members?.length ?? 0} 人 → ${JSON.stringify((payload.members || []).map(m => `${m.name}(${m.id})`))}`);
        const host = (payload.members || []).find(m => m.id !== MY.id);
        if (host) hostName = host.name;
        // 就绪后开始移动 + 演示事件
        after(1500, () => { sendMove(); log('▶ 开始模拟 GPS 移动（每 1s 一帧）'); timers.push(setInterval(sendMove, 1000)); });
        after(3000, () => { send('CHAT_MESSAGE', { sender: MY.name, text: '鼠鼠上线，谁来抓我 🐭' }); log('→ CHAT_MESSAGE'); });
        after(15000, () => { send('CATCH_EVENT', { catName: hostName, mouseName: MY.name, success: true }); log(`→ CATCH_EVENT（${hostName} 抓到 ${MY.name}）`); });
        after(35000, () => { send('CHAT_MESSAGE', { sender: MY.name, text: '被猫追到啦！再跑一段 🏃' }); log('→ CHAT_MESSAGE #2'); });
        break;
      }
      case 'PLAYER_MOVE': {
        if (payload && payload.id !== MY.id) {
          if (seq === 0 || (pkt.timestamp - t0) % 5000 < 1000) {
            // 限速打印：浏览器(房主)的位置同步
            log(`← PLAYER_MOVE 来自 ${payload.name}(${payload.id}) team=${payload.team} lat=${payload.latitude?.toFixed(6)} lng=${payload.longitude?.toFixed(6)} score=${payload.score}`);
          }
        }
        break;
      }
      case 'CHAT_MESSAGE':
        log(`← CHAT 来自 ${payload?.sender}: ${payload?.text}`);
        break;
      case 'CATCH_EVENT':
        log(`← CATCH ${payload?.catName} 抓 ${payload?.mouseName} success=${payload?.success}`);
        break;
      case 'PLAYER_JOINED':
        log(`↔ 有玩家加入：${payload?.player?.name}(${payload?.player?.id})`);
        break;
      case 'PLAYER_LEFT':
        log(`↔ 有玩家离开：${payload?.playerId}`);
        break;
      case 'PING': send('PONG', { time: Date.now() }); break;
      default: break;
    }
  });
  ws.on('close', () => { log('连接关闭'); finish(); });
  ws.on('error', (e) => log('socket error: ' + e.message));
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  timers.forEach(clearTimeout);
  log(`结束（累计发送 ${seq} 帧 PLAYER_MOVE）。再见 👋`);
  try { ws && ws.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
}

connect();
after(DURATION * 1000, () => { log(`达到 ${DURATION}s，主动退出`); finish(); });
process.on('SIGINT', finish);
