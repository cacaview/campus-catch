/**
 * 🏠 房间会话管理 (Room Session)
 * 区分 房主 (Host) 与 从机 (Client)，处理身份码校验与状态管理
 */

export class RoomSession {
  constructor() {
    this.roomId = '';
    this.passcode = '';
    this.isHost = false;
    this.hostId = '';
    this.phase = 'WAITING';
    this.startAt = null;
    this.myPlayer = null;
    this.members = [];
    this.hostIp = '';
    this.gameArea = null;
    this.gameDurationSeconds = 600;
  }

  /**
   * 创建房间 (作房主)
   */
  createRoom(hostPlayer, passcode, gameArea = null, gameDurationSeconds = 600) {
    this.isHost = true;
    this.hostId = String(hostPlayer?.id || '');
    this.phase = 'WAITING';
    this.startAt = null;
    this.passcode = passcode || '8888';
    this.roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
    this.myPlayer = hostPlayer;
    this.members = [hostPlayer];
    this.gameArea = gameArea;
    this.gameDurationSeconds = gameDurationSeconds;
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
    }
    if (payload.gameArea) this.gameArea = payload.gameArea;
    if (Number.isFinite(payload.gameDurationSeconds)) this.gameDurationSeconds = payload.gameDurationSeconds;
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
  }

  localStartAt(serverStartAt, serverTimestamp) {
    if (!Number.isFinite(serverStartAt)) return null;
    const delay = Number.isFinite(serverTimestamp)
      ? serverStartAt - serverTimestamp
      : serverStartAt - Date.now();
    return Date.now() + Math.max(0, delay);
  }

  /**
   * 重置房间
   */
  reset() {
    this.roomId = '';
    this.passcode = '';
    this.isHost = false;
    this.hostId = '';
    this.phase = 'WAITING';
    this.startAt = null;
    this.myPlayer = null;
    this.members = [];
    this.hostIp = '';
    this.gameArea = null;
    this.gameDurationSeconds = 600;
  }
}

const roomSession = new RoomSession();

export { roomSession };
export default RoomSession;
