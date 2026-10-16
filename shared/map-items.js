/**
 * 🪤 地图道具与陷阱管理器 (Map Items & Traps Manager)
 * 负责在地图上动态刷新：能量奶酪 🧀、猫薄荷 🌿、控制陷阱 🪤、草丛安全区 🌫️
 */

import GameArea from './game-area.js';

export const ITEM_TYPES = {
  CHEESE: 'CHEESE',       // 🧀 能量奶酪：鼠拾取 +10 分并加速 5 秒
  CATNIP: 'CATNIP',       // 🌿 猫薄荷：猫拾取全图透视老鼠 5 秒
  TRAP: 'TRAP',           // 🪤 控制陷阱：踩中解控被困 3 秒
  BUSH: 'BUSH'            // 🌫️ 草丛安全区：进入隐藏位置
};

export class MapItems {
  constructor() {
    this.items = [];
    this.itemIdCounter = 2001;
  }

  /**
   * Generate items inside the selected polygon. A seed makes every client in
   * the same room derive the same positions and numeric ids.
   */
  spawnItems(areaOrCenter, count = 6, seed = null) {
    this.items = [];
    const types = [ITEM_TYPES.CHEESE, ITEM_TYPES.CHEESE, ITEM_TYPES.CATNIP, ITEM_TYPES.TRAP, ITEM_TYPES.TRAP, ITEM_TYPES.BUSH];
    const area = GameArea.isValidArea(areaOrCenter) ? areaOrCenter : null;
    const centerPos = area
      ? GameArea.center(area)
      : areaOrCenter && Number.isFinite(Number(areaOrCenter.latitude)) && Number.isFinite(Number(areaOrCenter.longitude))
        ? { latitude: Number(areaOrCenter.latitude), longitude: Number(areaOrCenter.longitude) }
        : null;
    if (!centerPos) return this.items;

    const itemCount = Math.max(0, Math.floor(Number(count) || 0));
    const random = seed == null ? Math.random : createSeededRandom(seed);
    const bounds = area ? getBounds(area) : null;
    const seedHash = seed == null ? null : hashSeed(seed);
    const firstId = seedHash == null
      ? this.itemIdCounter
      : 2001 + (seedHash % 1_000_000_000) * Math.max(itemCount, 1);

    for (let i = 0; i < itemCount; i++) {
      const type = types[i % types.length];
      const position = area
        ? randomPointInArea(area, bounds, random, Math.max(100, itemCount * 1000))
        : {
            latitude: centerPos.latitude + (random() - 0.5) * 0.003,
            longitude: centerPos.longitude + (random() - 0.5) * 0.003
          };
      if (!position) break;

      this.items.push({
        id: Number(firstId + i), // Marker 与 relay 都沿用数字 ID。
        type: type,
        latitude: position.latitude,
        longitude: position.longitude,
        icon: this.getIconForType(type),
        name: this.getNameForType(type)
      });
    }

    if (seed == null) this.itemIdCounter += this.items.length;

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
   * Find an eligible nearby item without removing it. Online clients wait for
   * the relay's pickup confirmation before changing shared state.
   */
  findItemPickup(playerPos, isCat) {
    const PICKUP_RADIUS_METERS = 15;
    return this.items.find(item => {
      // 阵营门控：奶酪只有鼠能拿、猫薄荷只有猫能拿；陷阱/草丛双方通用
      const usable = item.type === ITEM_TYPES.CATNIP ? !!isCat
                   : item.type === ITEM_TYPES.CHEESE ? !isCat
                   : true;
      return usable && GameArea.distanceMeters(item, playerPos) <= PICKUP_RADIUS_METERS;
    });
  }

  removeItemById(id) {
    const index = this.items.findIndex(item => String(item.id) === String(id));
    if (index < 0) return null;
    return this.items.splice(index, 1)[0];
  }

  /** Check and remove a nearby item (offline mode). */
  checkItemPickup(playerPos, isCat) {
    const item = this.findItemPickup(playerPos, isCat);
    return item ? this.removeItemById(item.id) : null;
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

function getBounds(area) {
  const latitudes = area.points.map(point => Number(point.latitude));
  const longitudes = area.points.map(point => Number(point.longitude));
  return {
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
    minLng: Math.min(...longitudes),
    maxLng: Math.max(...longitudes)
  };
}

function randomPointInArea(area, bounds, random, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const point = {
      latitude: bounds.minLat + random() * (bounds.maxLat - bounds.minLat),
      longitude: bounds.minLng + random() * (bounds.maxLng - bounds.minLng)
    };
    if (GameArea.contains(area, point)) return point;
  }
  return null;
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (const character of String(seed)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function roomItemSeed(roomId, areaOrCenter) {
  return `${roomId}|${JSON.stringify(GameArea.isValidArea(areaOrCenter) ? areaOrCenter.points : areaOrCenter)}`;
}

export const DEFAULT_ITEM_CENTER = { latitude: 23.1598575, longitude: 108.1912479 };
