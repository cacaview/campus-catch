/**
 * 🪤 地图道具与陷阱管理器 (Map Items & Traps Manager)
 * 负责在地图上动态刷新：能量奶酪 🧀、猫薄荷 🌿、控制陷阱 🪤、草丛安全区 🌫️
 */

export const ITEM_TYPES = {
  CHEESE: 'CHEESE',       // 🧀 能量奶酪：鼠拾取 +10 分并加速 5 秒
  CATNIP: 'CATNIP',       // 🌿 猫薄荷：猫拾取全图透视老鼠 5 秒
  TRAP: 'TRAP',           // 🪤 控制陷阱：踩中解控被困 3 秒
  BUSH: 'BUSH'            // 🌫️ 草丛安全区：进入隐藏位置
};

class MapItems {
  constructor() {
    this.items = [];
    this.itemIdCounter = 2001;
  }

  /**
   * 在地图中心点周边随机刷新 N 个道具/陷阱
   */
  spawnItems(centerPos, count = 6) {
    this.items = [];
    const types = [ITEM_TYPES.CHEESE, ITEM_TYPES.CHEESE, ITEM_TYPES.CATNIP, ITEM_TYPES.TRAP, ITEM_TYPES.TRAP, ITEM_TYPES.BUSH];

    for (let i = 0; i < count; i++) {
      const type = types[i % types.length];
      const offsetLat = (Math.random() - 0.5) * 0.003; // ~150-200m
      const offsetLng = (Math.random() - 0.5) * 0.003;

      this.items.push({
        id: Number(this.itemIdCounter++), // 必须是 Number 类型！
        type: type,
        latitude: centerPos.latitude + offsetLat,
        longitude: centerPos.longitude + offsetLng,
        icon: this.getIconForType(type),
        name: this.getNameForType(type)
      });
    }

    return this.items;
  }

  getIconForType(type) {
    switch (type) {
      case ITEM_TYPES.CHEESE: return '🧀';
      case ITEM_TYPES.CATNIP: return '🌿';
      case ITEM_TYPES.TRAP: return '🪤';
      case ITEM_TYPES.BUSH: return '🌫️';
      default: return '❓';
    }
  }

  getNameForType(type) {
    switch (type) {
      case ITEM_TYPES.CHEESE: return '能量奶酪';
      case ITEM_TYPES.CATNIP: return '猫薄荷';
      case ITEM_TYPES.TRAP: return '捕鼠陷阱';
      case ITEM_TYPES.BUSH: return '隐蔽草丛';
      default: return '道具';
    }
  }

  /**
   * 检查玩家坐标是否触碰到地图道具 (距离 < 10 米)
   */
  checkItemPickup(playerPos, isCat) {
    const PICKUP_RADIUS = 0.00015; // 约 10-15 米
    let pickedItem = null;

    this.items = this.items.filter(item => {
      // 阵营门控：奶酪只有鼠能拿、猫薄荷只有猫能拿；陷阱/草丛双方通用
      const usable = item.type === ITEM_TYPES.CATNIP ? !!isCat
                   : item.type === ITEM_TYPES.CHEESE ? !isCat
                   : true;
      const dLat = Math.abs(item.latitude - playerPos.latitude);
      const dLng = Math.abs(item.longitude - playerPos.longitude);

      if (usable && dLat < PICKUP_RADIUS && dLng < PICKUP_RADIUS && !pickedItem) {
        pickedItem = item;
        return false; // 移除已拾取的道具
      }
      return true;
    });

    return pickedItem;
  }

  /**
   * 获取 Web 地图标记数据（MapLibre DOM marker 用，无微信 callout 字段）
   */
  getMapMarkers() {
    return this.items.map(item => ({
      id: item.id,
      type: item.type,
      latitude: item.latitude,
      longitude: item.longitude,
      icon: this.getIconForType(item.type),
      name: this.getNameForType(item.type)
    }));
  }
}

const MapItemsManager = new MapItems();

export { MapItemsManager };
