/**
 * 🛒 积分商店 (Points Shop)
 * 消耗成就系统积分钱包购买局内增益道具；道具为消耗品，开局自动生效一局。
 */
import { getStorage, setStorage } from '../platform/storage.js';
import { achievementManager } from './achievement.js';

const SHOP_ITEMS = [
  { id: 'extra_skill', name: '技能补给包', icon: '🎁', price: 60, desc: '下一局所有技能使用次数 +1，进局自动生效' },
  { id: 'start_shield', name: '开局金钟罩', icon: '🛡️', price: 40, desc: '下一局开局自动开启金钟罩 10 秒' },
  { id: 'scan_boost', name: '扫描增强器', icon: '📡', price: 50, desc: '下一局全图扫描冷却减半（30s → 15s）' },
  { id: 'double_cheese', name: '奶酪双倍卡', icon: '🧀', price: 80, desc: '下一局奶酪/猫薄荷积分翻倍' },
  { id: 'title_card', name: '限定称号卡', icon: '🎟️', price: 150, desc: '解锁限定称号「积分大佬 💵」，永久有效' }
];

export class ShopManager {
  constructor() {
    this.storageKey = 'shop_data_v1';
    this.data = this.loadData();
  }

  loadData() {
    try {
      const stored = getStorage(this.storageKey);
      if (stored && typeof stored.owned === 'object' && stored.owned) return stored;
    } catch (e) {
      /* ignore */
    }
    return { owned: {} };
  }

  saveData() {
    try {
      setStorage(this.storageKey, this.data);
    } catch (e) {
      /* ignore */
    }
  }

  getItems() {
    return SHOP_ITEMS.map(it => ({
      ...it,
      owned: this.data.owned[it.id] || 0,
      affordable: achievementManager.getPoints() >= it.price
    }));
  }

  getOwned(itemId) {
    return this.data.owned[itemId] || 0;
  }

  // 购买：扣积分、库存 +1；限定称号卡购买后立即解锁称号。返回 { ok, reason }
  buy(itemId) {
    const item = SHOP_ITEMS.find(i => i.id === itemId);
    if (!item) return { ok: false, reason: '商品不存在' };
    if (!achievementManager.spendPoints(item.price)) {
      return { ok: false, reason: `积分不足（还差 ${item.price - achievementManager.getPoints()} 分）` };
    }
    this.data.owned[itemId] = (this.data.owned[itemId] || 0) + 1;
    if (itemId === 'title_card') achievementManager.unlockTitle('t9');
    this.saveData();
    return { ok: true };
  }

  // 消耗一件库存（开局时按道具逐个生效），无库存返回 false
  consume(itemId) {
    if (!this.data.owned[itemId]) return false;
    this.data.owned[itemId] -= 1;
    if (this.data.owned[itemId] <= 0) delete this.data.owned[itemId];
    this.saveData();
    return true;
  }
}

export const shopManager = new ShopManager();
