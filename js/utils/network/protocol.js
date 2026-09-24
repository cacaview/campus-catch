/**
 * 🎮 游戏网络通信协议 (Network Protocol)
 * 定义所有网络数据包类型与编码/解码逻辑
 */

export const MSG_TYPES = {
  // 基础连接与握手
  JOIN_ROOM: 'JOIN_ROOM',         // 加入房间 (含身份码)
  JOIN_ACK: 'JOIN_ACK',           // 加入确认 (成功/失败)
  LEAVE_ROOM: 'LEAVE_ROOM',       // 离开房间

  // 心跳保活
  PING: 'PING',                   // 心跳请求
  PONG: 'PONG',                   // 心跳响应

  // 游戏同步
  SYNC_ROOM_STATE: 'SYNC_ROOM_STATE', // 房间全量状态 (房主 -> 从机)
  PLAYER_MOVE: 'PLAYER_MOVE',     // 玩家位置移动 (客户端 -> 全员/房主)
  USE_SKILL: 'USE_SKILL',         // 释放技能
  CATCH_EVENT: 'CATCH_EVENT',     // 抓捕判定事件
  CHAT_MESSAGE: 'CHAT_MESSAGE',   // 聊天消息

  // 房主控制 (Host -> 全员)
  GAME_PAUSE: 'GAME_PAUSE',       // 暂停/继续 { paused }
  GAME_EXTEND: 'GAME_EXTEND',     // 延长局时 { seconds }
  PLAYER_KICK: 'PLAYER_KICK',     // 踢出玩家 { playerId, name }

  // 重连
  RECONNECT: 'RECONNECT',         // 重连恢复状态请求
  RECONNECT_ACK: 'RECONNECT_ACK'  // 重连恢复确认
};

export class Protocol {
  /**
   * 打包消息为 JSON 字符串
   */
  static encode(type, payload = {}, senderId = '') {
    return JSON.stringify({
      type,
      senderId,
      timestamp: Date.now(),
      payload
    });
  }

  /**
   * 解包 JSON 字符串消息
   */
  static decode(rawMsg) {
    try {
      if (typeof rawMsg !== 'string') {
        rawMsg = String(rawMsg);
      }
      return JSON.parse(rawMsg);
    } catch (err) {
      console.error('[Protocol] Decode error:', err, rawMsg);
      return null;
    }
  }

  /**
   * 生成随机 4 位数字身份码 (Passcode)
   */
  static generatePasscode() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  /**
   * 格式化 IP 地址与端口号
   */
  static formatAddress(ip, port = 8080) {
    let cleanIp = ip.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!cleanIp.includes(':')) {
      cleanIp = `${cleanIp}:${port}`;
    }
    return cleanIp;
  }
}
