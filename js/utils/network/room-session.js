/**
 * 🏠 房间会话管理 (Room Session)
 * 区分 房主 (Host) 与 从机 (Client)，处理身份码校验与状态管理
 */

const RECONNECT_STORAGE_KEY = 'campusCatch.privateReconnect';

export class RoomSession {
  constructor() {
    this.roomId = '';
    this.passcode = '';
    this.reconnectToken = '';
    this.reconnectScope = '';
    this.isHost = false;
    this.hostId = '';
    this.phase = 'WAITING';
    this.startAt = null;
    this.paused = false;
    this.myPlayer = null;
    this.members = [];
    this.hostIp = '';
    this.gameArea = null;
    this.gameDurationSeconds = 600;
    this.catchMode = 'sustained';
    this.pickedMapItemIds = [];
  }

  /**
   * 创建房间 (作房主)
   */
  createRoom(hostPlayer, passcode, gameArea = null, gameDurationSeconds = 600) {
    this.clearReconnectToken();
    this.isHost = true;
    this.hostId = String(hostPlayer?.id || '');
    this.phase = 'WAITING';
    this.startAt = null;
    this.paused = false;
    this.passcode = passcode || '8888';
    this.roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
    this.myPlayer = hostPlayer;
    this.members = [hostPlayer];
    this.gameArea = gameArea;
    this.gameDurationSeconds = gameDurationSeconds;
    this.pickedMapItemIds = [];
    this.maxCapacity = Infinity; // ♾️ 无人数上限大乱斗
    console.log(`[RoomSession] Created Unlimited Room ${this.roomId} with passcode ${this.passcode}`);
    return {
      roomId: this.roomId,
      passcode: this.passcode,
      gameArea: this.gameArea,
      gameDurationSeconds: this.gameDurationSeconds
    };
  }

  /**
   * 校验身份码
   */
  validatePasscode(inputPasscode) {
    return String(inputPasscode).trim() === String(this.passcode).trim();
  }

  /**
   * 添加新成员 (仅 Host 维护)
   */
  addMember(player) {
    if (!player || player.id == null) return;
    const member = { ...player, isHost: String(player.id) === String(this.hostId) };
    const existingIndex = this.members.findIndex(m => String(m.id) === String(member.id));
    if (existingIndex >= 0) {
      this.members[existingIndex] = member;
    } else {
      this.members.push(member);
    }
  }

  /**
   * 移除成员
   */
  removeMember(playerId) {
    this.members = this.members.filter(m => String(m.id) !== String(playerId));
  }

  applyJoinAck(payload = {}, serverTimestamp = null) {
    if (typeof payload.reconnectToken === 'string' && payload.reconnectToken) {
      this.reconnectToken = payload.reconnectToken;
      if (this.reconnectScope) {
        try {
          globalThis.sessionStorage?.setItem(RECONNECT_STORAGE_KEY, JSON.stringify({
            scope: this.reconnectScope, token: this.reconnectToken
          }));
        } catch { /* Storage may be blocked; in-memory reconnect still works. */ }
      }
    }
    if (payload.roomId) this.roomId = payload.roomId;
    if (payload.hostId) this.hostId = String(payload.hostId);
    if (typeof payload.isHost === 'boolean') this.isHost = payload.isHost;
    else if (this.hostId && this.myPlayer?.id != null) this.isHost = String(this.myPlayer.id) === this.hostId;
    if (payload.phase === 'WAITING' || payload.phase === 'STARTED') this.phase = payload.phase;
    this.startAt = this.localStartAt(payload.startAt, serverTimestamp);
    if (Array.isArray(payload.members)) {
      this.members = payload.members
        .filter(member => member && member.id != null)
        .map(member => ({ ...member, isHost: String(member.id) === this.hostId }));
      const self = this.members.find(member => String(member.id) === String(this.myPlayer?.id));
      if (self) this.myPlayer = { ...self };
    }
    if (typeof payload.paused === 'boolean') this.paused = payload.paused;
    if (payload.gameArea) this.gameArea = payload.gameArea;
    if (Number.isFinite(payload.gameDurationSeconds)) this.gameDurationSeconds = payload.gameDurationSeconds;
    if (payload.catchMode === 'instant' || payload.catchMode === 'sustained') this.catchMode = payload.catchMode;
    if (Array.isArray(payload.pickedMapItemIds)) {
      this.pickedMapItemIds = payload.pickedMapItemIds
        .map(Number)
        .filter(id => Number.isSafeInteger(id) && id >= 2001);
    }
  }

  applyHostChange(payload = {}) {
    if (payload.hostId) this.hostId = String(payload.hostId);
    if (Array.isArray(payload.members)) {
      this.members = payload.members
        .filter(member => member && member.id != null)
        .map(member => ({ ...member, isHost: String(member.id) === this.hostId }));
    } else {
      this.members = this.members.map(member => ({
        ...member,
        isHost: String(member.id) === this.hostId
      }));
    }
    this.isHost = this.myPlayer?.id != null && String(this.myPlayer.id) === this.hostId;
  }

  applyRoomStarted(payload = {}, serverTimestamp = null) {
    this.phase = 'STARTED';
    this.startAt = this.localStartAt(payload.startAt, serverTimestamp);
    this.paused = false;
  }

  localStartAt(serverStartAt, serverTimestamp) {
    if (!Number.isFinite(serverStartAt)) return null;
    const delay = Number.isFinite(serverTimestamp)
      ? serverStartAt - serverTimestamp
      : serverStartAt - Date.now();
    return Date.now() + Math.max(0, delay);
  }

  restoreReconnectToken(scope) {
    if (this.reconnectScope && this.reconnectScope !== scope) this.clearReconnectToken();
    if (this.reconnectScope !== scope) this.reconnectToken = '';
    this.reconnectScope = scope;
    try {
      const stored = JSON.parse(globalThis.sessionStorage?.getItem(RECONNECT_STORAGE_KEY) || 'null');
      if (stored?.scope === scope && typeof stored.token === 'string' && stored.token) {
        this.reconnectToken = stored.token;
      }
    } catch { /* Invalid or inaccessible storage must not prevent a connection. */ }
    return this.reconnectToken;
  }

  clearReconnectToken() {
    this.reconnectToken = '';
    this.reconnectScope = '';
    try {
      globalThis.sessionStorage?.removeItem(RECONNECT_STORAGE_KEY);
    } catch { /* Browser privacy settings can disable session storage. */ }
  }

  /**
   * 重置房间
   */
  reset() {
    this.clearReconnectToken();
    this.roomId = '';
    this.passcode = '';
    this.reconnectToken = '';
    this.isHost = false;
    this.hostId = '';
    this.phase = 'WAITING';
    this.startAt = null;
    this.paused = false;
    this.myPlayer = null;
    this.members = [];
    this.hostIp = '';
    this.gameArea = null;
    this.gameDurationSeconds = 600;
    this.catchMode = 'sustained';
    this.pickedMapItemIds = [];
  }
}

const roomSession = new RoomSession();

export { roomSession };
export default RoomSession;
