import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setStorageBackend } from '../js/platform/storage.js';
import { ShopManager } from '../js/utils/shop.js';
// 注意：不能带 query 重新导入 achievement —— shop.js 内部持有的是首次导入的单例，
// 测试必须拿到同一个实例修改 points 才能影响 shop 的购买逻辑
import { achievementManager } from '../js/utils/achievement.js';

const mem = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

beforeEach(() => {
  setStorageBackend(mem());
});

test('getItems: 5 items with owned=0', () => {
  const m = new ShopManager();
  const items = m.getItems();
  assert.equal(items.length, 5);
  assert.ok(items.every(i => i.owned === 0));
});

test('buy with insufficient points fails with 积分不足 reason', () => {
  const m = new ShopManager();
  achievementManager.data.points = 0;
  const r = m.buy('extra_skill');
  assert.equal(r.ok, false);
  assert.match(r.reason, /积分不足/);
});

test('buy succeeds, deducts points, consume decrements stock', () => {
  const m = new ShopManager();
  achievementManager.data.points = 100;
  assert.equal(m.buy('extra_skill').ok, true);
  assert.equal(achievementManager.getPoints(), 40);
  assert.equal(m.getOwned('extra_skill'), 1);
  assert.equal(m.consume('extra_skill'), true);
  assert.equal(m.getOwned('extra_skill'), 0);
  assert.equal(m.consume('extra_skill'), false);
});

test('buy title_card unlocks t9', () => {
  const m = new ShopManager();
  achievementManager.data.points = 150;
  assert.equal(m.buy('title_card').ok, true);
  assert.ok(achievementManager.data.unlockedTitles.includes('t9'));
});
