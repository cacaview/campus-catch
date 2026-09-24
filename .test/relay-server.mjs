/**
 * ⚡ 测试用 WebSocket 中继服务器（仅本地联调，非交付物）
 *
 * 作用：复刻原 server.js 的「房间广播」协议子集，供 Web 版多实例联机自测：
 *   - 同一身份码 (passcode) 归入同一房间
 *   - JOIN_ROOM → 回 JOIN_ACK（成员列表）+ 向他人广播 PLAYER_JOINED
 *   - PLAYER_MOVE / USE_SKILL / CATCH_EVENT / CHAT_MESSAGE / GAME_* 等 → 房间内广播（排除发送者）
 *   - PING → PONG；断线 → PLAYER_LEFT
 *
 * 与原 server.js 的区别（spec 约束）：
 *   - 不加载 .env、不含微信 AppID/AppSecret
 *   - 删除 /voip-sign /room-qr /network-info（Web 版无 VoIP / 扫码）
 *   - 零业务密钥，仅做消息转发
 *
 * 运行：node .test/relay-server.mjs   （监听 ws://127.0.0.1:8080）
 */
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

/** passcode -> { passcode, members: Map<playerId, {ws, player}>, gameArea, gameDurationSeconds } */
const rooms = new Map();

function encode(type, payload = {}, senderId = '') {
  return JSON.stringify({ type, senderId, timestamp: Date.now(), payload });
}

function broadcastToRoom(room, packet, excludeWs = null) {
  const str = typeof packet === 'string' ? packet : JSON.stringify(packet);
  room.members.forEach(m => {
    if (m.ws && m.ws.readyState === 1 /* OPEN */ && m.ws !== excludeWs) {
      try { m.ws.send(str); } catch (e) { console.error('[relay] send error', e.message); }
    }
  });
}

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[relay] + client ${ip}`);
  let room = null;
  let playerId = null;

  ws.on('message', (buf) => {
    let packet;
    try { packet = JSON.parse(buf.toString()); }
    catch (e) { console.error('[relay] bad packet', e.message); return; }
    const { type, senderId, payload } = packet;

    switch (type) {
      case 'PING':
        ws.send(encode('PONG', { time: Date.now() }));
        break;

      case 'JOIN_ROOM': {
        const { passcode, player, gameArea, gameDurationSeconds } = payload || {};
        playerId = (player && player.id) || senderId || 'anon';
        let r = rooms.get(String(passcode));
        if (!r) {
          r = {
            passcode: String(passcode),
            members: new Map(),
            gameArea: gameArea || null,
            gameDurationSeconds: Math.max(60, Math.min(7200, Number(gameDurationSeconds) || 600))
          };
          rooms.set(String(passcode), r);
          console.log(`[relay] room created passcode=${passcode}`);
        }
        room = r;
        room.members.set(String(playerId), { ws, player });
        if (!room.gameArea && gameArea) room.gameArea = gameArea;
        const members = Array.from(room.members.values()).map(m => m.player);
        console.log(`[relay] ${player?.name || playerId} 加入 passcode=${passcode}（房内 ${members.length} 人）`);
        ws.send(encode('JOIN_ACK', {
          success: true,
          roomId: 'ROOM_' + room.passcode,
          members,
          gameArea: room.gameArea,
          gameDurationSeconds: room.gameDurationSeconds
        }));
        broadcastToRoom(room, encode('PLAYER_JOINED', { player }, senderId), ws);
        break;
      }

      case 'PLAYER_MOVE':
      case 'USE_SKILL':
      case 'CATCH_EVENT':
      case 'CHAT_MESSAGE':
      case 'MAP_ITEM_PICKUP':
      case 'GAME_PAUSE':
      case 'GAME_EXTEND':
      case 'PLAYER_KICK':
        if (room) {
          const preview = type === 'PLAYER_MOVE'
            ? ` lat=${payload?.latitude?.toFixed(6)} lng=${payload?.longitude?.toFixed(6)}`
            : '';
          console.log(`[relay] ${type} from ${senderId}${preview} → 房内 ${room.members.size} 人`);
          broadcastToRoom(room, packet, ws);
        }
        break;

      default:
        if (room) broadcastToRoom(room, packet, ws);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[relay] - client ${ip} (${playerId || '?'})`);
    if (room) {
      room.members.delete(String(playerId));
      if (room.members.size > 0) {
        broadcastToRoom(room, encode('PLAYER_LEFT', { playerId }));
      } else {
        rooms.delete(room.passcode);
        console.log(`[relay] room passcode=${room.passcode} 已空，移除`);
      }
    }
  });

  ws.on('error', (e) => console.error(`[relay] socket error ${ip}`, e.message));
});

wss.on('listening', () => {
  console.log(`====================================================`);
  console.log(`🔁 测试中继已启动：ws://127.0.0.1:${PORT}`);
  console.log(`====================================================`);
});
