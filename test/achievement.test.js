import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setStorageBackend } from '../js/platform/storage.js';

const mem = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

// 每个测试全新后端 + 全新实例（achievement 单例在导入时绑定首次后端，测试用 class 构造独立实例）
let A;
beforeEach(async () => {
  setStorageBackend(mem());
  A = (await import('../js/utils/achievement.js?a=' + Date.now())).AchievementManager;
});

test('fresh manager: 0 points, no titles, default equipped obj', () => {
  const m = new A();
  assert.equal(m.getPoints(), 0);
  assert.ok(m.getTitles().every(t => !t.unlocked));
  assert.equal(m.getEquippedTitleObj().id, 'none');
});

test('updateProgress(500) completes daily task_1; claim gives +50; re-claim 0', () => {
  const m = new A();
  m.updateProgress(500, false, false);
  const t1 = m.data.tasks.find(t => t.id === 'task_1');
  assert.equal(t1.done, true);
  assert.equal(t1.current, 500);
  assert.equal(m.claimTaskReward('task_1'), 50);
  assert.equal(m.getPoints(), 50);
  assert.equal(m.claimTaskReward('task_1'), 0);
});

test('completing a game unlocks t0 and advances task_2', () => {
  const m = new A();
  m.updateProgress(0, true, true);
  assert.ok(m.data.unlockedTitles.includes('t0'));
  assert.equal(m.data.tasks.find(t => t.id === 'task_2').current, 1);
  assert.equal(m.data.totalGames, 1);
});

test('5 catches unlock t3; 1000m unlocks t4; 2000m unlocks t6; 3 wins unlock t5', () => {
  const m = new A();
  for (let i = 0; i < 5; i++) m.recordCatch();
  assert.ok(m.data.unlockedTitles.includes('t3'));
  m.updateProgress(1000, false, false);
  assert.ok(m.data.unlockedTitles.includes('t4'));
  m.updateProgress(1000, false, false);
  assert.ok(m.data.unlockedTitles.includes('t6'));
  m.updateProgress(0, true, true);
  m.updateProgress(0, true, true);
  m.updateProgress(0, true, true);
  assert.ok(m.data.unlockedTitles.includes('t5'));
});

test('equipTitle: locked fails, unlocked succeeds', () => {
  const m = new A();
  assert.equal(m.equipTitle('t1'), false);
  m.unlockTitle('t1');
  assert.equal(m.equipTitle('t1'), true);
  assert.equal(m.getEquippedTitleObj().id, 't1');
});

test('spendPoints: insufficient returns false, sufficient deducts', () => {
  const m = new A();
  assert.equal(m.spendPoints(10), false);
  m.data.points = 20;
  assert.equal(m.spendPoints(10), true);
  assert.equal(m.getPoints(), 10);
});

test('daily tasks reset across day change', () => {
  const m = new A();
  m.updateProgress(500, false, false); // task_1 done today
  // 模拟跨天：改 taskDate 后新实例应重置任务
  m.data.taskDate = '1999-0-0';
  m.saveData();
  const m2 = new A();
  assert.equal(m2.data.tasks.find(t => t.id === 'task_1').current, 0);
  assert.deepEqual(Object.keys(m2.data.claimedTasks), []);
});

test('warmup w1 claimable after 1 game; double-claim returns 0', () => {
  const m = new A();
  m.updateProgress(0, false, true);
  assert.equal(m.claimWarmupReward('w1'), 20);
  assert.equal(m.claimWarmupReward('w1'), 0);
  assert.equal(m.getPoints(), 20);
});
