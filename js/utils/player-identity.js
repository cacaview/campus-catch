/**
 * 🪪 稳定玩家身份
 * 每台设备首次使用时生成持久 playerId（'u_' 前缀），
 * 排行榜用它做聚合键，避免「同昵称合并战绩 / 改昵称分裂战绩」。
 * 旧战绩记录里的 'player_时间戳' 是每局随机的，聚合时回退按昵称。
 */
import { getStorage, setStorage } from '../platform/storage.js';

function getStablePlayerId() {
  try {
    let id = getStorage('playerId');
    if (!id) {
      id = 'u_' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
      setStorage('playerId', id);
    }
    return id;
  } catch (e) {
    return 'u_' + Date.now().toString(36);
  }
}

export { getStablePlayerId };
