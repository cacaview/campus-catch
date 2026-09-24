/**
 * 🏠 房间会话管理 (Room Session)
 * 区分 房主 (Host) 与 从机 (Client)，处理身份码校验与状态管理
 */

export class RoomSession {
  constructor() {
    this.roomId = '';
    this.passcode = '';
    this.isHost = false;
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
    const existingIndex = this.members.findIndex(m => m.id === player.id);
    if (existingIndex >= 0) {
      this.members[existingIndex] = player;
    } else {
      this.members.push(player);
    }
  }

  /**
   * 移除成员
   */
  removeMember(playerId) {
    this.members = this.members.filter(m => m.id !== playerId);
  }

  /**
   * 重置房间
   */
  reset() {
    this.roomId = '';
    this.passcode = '';
    this.isHost = false;
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
