/**
 * ⚡ 网络管理器 (Network Manager)
 * 具备连接状态机、心跳检测 (PING/PONG)、指数退避自动重连。
 * Web 版仅保留 OFFLINE / SERVER 两种模式（UDP P2P 与 LAN 直连已移除，spec §3.2）。
 */

import WebSocketAdapter from './websocket-adapter.js';
import { Protocol, MSG_TYPES } from './protocol.js';
import { roomSession } from './room-session.js';

const NET_STATE = {
  DISCONNECTED: 'DISCONNECTED', // 未连接 / 断开
  CONNECTING: 'CONNECTING',     // 正在建立连接
  CONNECTED: 'CONNECTED',       // 连接成功
  RECONNECTING: 'RECONNECTING'  // 断线重连中
};

const NET_MODE = {
  OFFLINE: 'OFFLINE', // 单机模拟
  SERVER: 'SERVER'    // 远程服务器
};

export class NetworkManager {
  constructor() {
    this.state = NET_STATE.DISCONNECTED;
    this.mode = NET_MODE.OFFLINE;
    this.wsAdapter = new WebSocketAdapter();

    this.targetUrl = '';
    this.passcode = '';

    // 心跳配置
    this.heartbeatTimer = null;
    this.missedPings = 0;
    this.maxMissedPings = 3;

    // 重连配置
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimer = null;

    // 事件回调
    this.listeners = {};

    this._bindAdapterEvents();
  }

  /**
   * 绑定底层网络事件
   */
  _bindAdapterEvents() {
    this.wsAdapter.onOpenCallback = () => {
      console.log('[NetworkManager] Connected!');
      this._setState(NET_STATE.CONNECTED);
      this.reconnectAttempts = 0;
      this.missedPings = 0;
      this.startHeartbeat();
    };

    this.wsAdapter.onMessageCallback = (rawMsg) => {
      this.handleIncomingMessage(rawMsg);
    };

    this.wsAdapter.onErrorCallback = (err) => {
      console.warn('[NetworkManager] Socket error:', err);
      this.handleDisconnect('Socket error');
    };

    this.wsAdapter.onCloseCallback = (res) => {
      console.log('[NetworkManager] Socket close:', res);
      this.handleDisconnect('Socket closed');
    };
  }

  /**
   * 更改网络状态并通知 UI
   */
  _setState(newState) {
    if (this.state !== newState) {
      console.log(`[NetworkManager] State transition: ${this.state} -> ${newState}`);
      this.state = newState;
      this.emit('stateChange', { state: this.state, mode: this.mode });
    }
  }

  /**
   * 服务器模式 (Server Mode)
   */
  connectServer(serverUrl, playerInfo, passcode = '8888', gameArea = null, gameDurationSeconds = 600) {
    this.mode = NET_MODE.SERVER;
    this.targetUrl = serverUrl;
    this.passcode = passcode;
    this._setState(NET_STATE.CONNECTING);

    return this.wsAdapter.connect(serverUrl).then(() => {
      this.send(MSG_TYPES.JOIN_ROOM, { passcode, player: playerInfo, gameArea, gameDurationSeconds });
    }).catch(err => {
      console.error('[NetworkManager] Server connect failed:', err);
      this._setState(NET_STATE.DISCONNECTED);
      throw err;
    });
  }

  /**
   * 处理收到的数据包
   */
  handleIncomingMessage(rawMsg) {
    const packet = Protocol.decode(rawMsg);
    if (!packet) return;

    // 重置心跳计数
    this.missedPings = 0;

    switch (packet.type) {
      case MSG_TYPES.PING:
        this.send(MSG_TYPES.PONG, { time: Date.now() });
        break;
      case MSG_TYPES.PONG:
        // 心跳正常回应
        break;
      case MSG_TYPES.JOIN_ROOM:
        // 如果是 Host，校验身份码
        if (roomSession.isHost) {
          const isValid = roomSession.validatePasscode(packet.payload.passcode);
          if (isValid) {
            roomSession.addMember(packet.payload.player);
            this.send(MSG_TYPES.JOIN_ACK, {
              success: true,
              roomId: roomSession.roomId,
              members: roomSession.members
            });
            this.emit('playerJoined', packet.payload.player);
          } else {
            this.send(MSG_TYPES.JOIN_ACK, {
              success: false,
              reason: '身份码错误'
            });
          }
        }
        break;
      case MSG_TYPES.JOIN_ACK:
        if (packet.payload.success) {
          roomSession.gameArea = packet.payload.gameArea || roomSession.gameArea || null;
          roomSession.gameDurationSeconds = packet.payload.gameDurationSeconds || roomSession.gameDurationSeconds || 600;
          console.log('[NetworkManager] Joined room successfully!');
          this.emit('joinSuccess', packet.payload);
        } else {
          console.warn('[NetworkManager] Join failed:', packet.payload.reason);
          this.emit('joinFail', packet.payload.reason);
          this.disconnect();
        }
        break;
      default:
        // 向上层派发具体事件
        this.emit(packet.type, packet.payload);
        break;
    }
  }

  /**
   * 发送消息
   */
  send(type, payload = {}) {
    if (this.mode === NET_MODE.OFFLINE || this.state !== NET_STATE.CONNECTED) {
      return false; // 单机或未连接时不发送，不触发警告控制台日志
    }

    const senderId = roomSession.myPlayer ? roomSession.myPlayer.id : 'unknown';
    const jsonStr = Protocol.encode(type, payload, senderId);

    return this.wsAdapter.send(jsonStr);
  }

  /**
   * 心跳检测机制 (Ping/Pong 3秒一次)
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== NET_STATE.CONNECTED) return;

      this.missedPings++;
      if (this.missedPings > this.maxMissedPings) {
        console.warn(`[NetworkManager] Missed ${this.missedPings} heartbeats, triggering reconnect...`);
        this.handleDisconnect('Heartbeat timeout');
        return;
      }

      this.send(MSG_TYPES.PING, { time: Date.now() });
    }, 3000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 触发断开连接
   */
  handleDisconnect(reason) {
    this.stopHeartbeat();
    if (this.state === NET_STATE.CONNECTED || this.state === NET_STATE.CONNECTING) {
      console.warn(`[NetworkManager] Disconnected due to: ${reason}`);
      this.triggerAutoReconnect();
    }
  }

  /**
   * 自动重连 (带指数退避策略：1s, 2s, 4s, 8s, 16s)
   */
  triggerAutoReconnect() {
    if (this.mode === NET_MODE.OFFLINE) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[NetworkManager] Max reconnect attempts reached');
      this._setState(NET_STATE.DISCONNECTED);
      this.emit('reconnectFailed');
      return;
    }

    this.reconnectAttempts++;
    this._setState(NET_STATE.RECONNECTING);

    const delay = Math.pow(2, this.reconnectAttempts - 1) * 1000;
    console.log(`[NetworkManager] Reconnecting attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      this.connectServer(this.targetUrl, roomSession.myPlayer);
    }, delay);
  }

  /**
   * 主动断开连接
   */
  disconnect() {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.mode = NET_MODE.OFFLINE;
    this.reconnectAttempts = 0;
    // 先置状态再关 socket：close 回调（可能同步触发）不应再触发重连
    this._setState(NET_STATE.DISCONNECTED);
    this.wsAdapter.disconnect();
  }

  // 事件订阅机制
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
    }
  }
}

const networkManager = new NetworkManager();

export { networkManager };
export default NetworkManager;
