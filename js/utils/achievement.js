/**
 * 🏆 称号、勋章、每日任务与积分钱包 (Achievement & Titles Manager)
 */
import { getStorage, setStorage } from '../platform/storage.js';
import { showToast } from '../platform/ui.js';

const TITLES = [
  { id: 't0', name: '初次进场', icon: '🎓', desc: '完成 1 局对战解锁', team: 'all' },
  { id: 't1', name: '猫阵营队长', icon: '👑🐱', desc: '联机结算猫阵营最高分获得', team: 'cat' },
  { id: 't2', name: '鼠阵营队长', icon: '👑🐭', desc: '联机结算鼠阵营最高分获得', team: 'mouse' },
  { id: 't3', name: '暗夜猎手', icon: '🗡️', desc: '累计抓捕 5 次解锁', team: 'cat' },
  { id: 't4', name: '闪电走位怪', icon: '⚡', desc: '累计奔跑 1000m 解锁', team: 'all' },
  { id: 't5', name: '桂院第一鼠', icon: '🧀', desc: '胜利 3 局解锁', team: 'mouse' },
  { id: 't6', name: '神行太保', icon: '👟', desc: '累计奔跑 2000m 解锁', team: 'all' },
  { id: 't9', name: '积分大佬', icon: '💵', desc: '积分商店兑换限定称号卡解锁', team: 'all' }
];

const DAILY_TASKS = [
  { id: 'task_1', title: '现实奔跑 500 米', reward: 50, current: 0, target: 500, unit: 'm', done: false },
  { id: 'task_2', title: '完成 2 局对战', reward: 30, current: 0, target: 2, unit: '局', done: false },
  { id: 'task_3', title: '释放 3 次技能', reward: 40, current: 0, target: 3, unit: '次', done: false }
];

// 热身任务（新手成长线，永久不重置，进度由累计统计直接推导）
const WARMUP_TASKS = [
  { id: 'w1', title: '完成第 1 局对战', reward: 20, target: 1, unit: '局' },
  { id: 'w2', title: '累计奔跑 300 米', reward: 20, target: 300, unit: 'm' },
  { id: 'w3', title: '释放 5 次技能', reward: 20, target: 5, unit: '次' },
  { id: 'w4', title: '完成 5 局对战', reward: 40, target: 5, unit: '局' },
  { id: 'w5', title: '累计抓捕 3 次（猫）', reward: 40, target: 3, unit: '次' }
];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class AchievementManager {
  constructor() {
    this.storageKey = 'player_achievements_v2';
    this.data = this.loadData();
  }

  loadData() {
    try {
      const stored = getStorage(this.storageKey);
      if (stored) {
        // 旧版本数据迁移：补充积分/抓捕/局数字段
        if (typeof stored.points !== 'number') stored.points = 0;
        if (typeof stored.totalCatches !== 'number') stored.totalCatches = 0;
        if (typeof stored.totalGames !== 'number') stored.totalGames = 0;
        if (typeof stored.totalSkills !== 'number') stored.totalSkills = 0;
        if (!stored.claimedTasks) stored.claimedTasks = {};
        if (!stored.warmup || typeof stored.warmup.claimed !== 'object') stored.warmup = { claimed: {} };
        // 每日任务跨天后重置（旧版本从未重置过）
        if (stored.taskDate !== todayStr()) {
          stored.taskDate = todayStr();
          stored.tasks = DAILY_TASKS.map(t => ({ ...t }));
          stored.claimedTasks = {};
        }
        return stored;
      }
    } catch (e) {
      // ignore
    }
    return {
      unlockedTitles: [],
      equippedTitle: '',
      tasks: DAILY_TASKS.map(t => ({ ...t })),
      taskDate: todayStr(),
      claimedTasks: {},
      warmup: { claimed: {} },
      points: 0,
      totalDistance: 0,
      totalWins: 0,
      totalCatches: 0,
      totalGames: 0,
      totalSkills: 0
    };
  }

  saveData() {
    try {
      setStorage(this.storageKey, this.data);
    } catch (e) {
      // ignore
    }
  }

  /* ================= 积分钱包 ================= */

  getPoints() {
    return this.data.points || 0;
  }

  // 领取任务奖励：仅当日已完成且未领取过时可领，返回到账积分（0 表示不可领）
  claimTaskReward(taskId) {
    const task = this.data.tasks.find(t => t.id === taskId);
    if (!task || !task.done) return 0;
    const claimKey = `${this.data.taskDate}_${taskId}`;
    if (this.data.claimedTasks[claimKey]) return 0;
    this.data.claimedTasks[claimKey] = true;
    this.data.points = (this.data.points || 0) + task.reward;
    this.saveData();
    return task.reward;
  }

  // 消耗积分（商店/功能解锁等预留），余额不足返回 false
  spendPoints(cost) {
    if ((this.data.points || 0) < cost) return false;
    this.data.points -= cost;
    this.saveData();
    return true;
  }

  /* ================= 热身任务（永久成长线） ================= */

  _warmupProgress(id) {
    const d = this.data;
    switch (id) {
      case 'w1': return d.totalGames || 0;
      case 'w2': return d.totalDistance || 0;
      case 'w3': return d.totalSkills || 0;
      case 'w4': return d.totalGames || 0;
      case 'w5': return d.totalCatches || 0;
      default: return 0;
    }
  }

  getWarmupTasks() {
    const claimed = (this.data.warmup && this.data.warmup.claimed) || {};
    return WARMUP_TASKS.map(t => {
      const current = Math.min(t.target, this._warmupProgress(t.id));
      return {
        ...t,
        current,
        done: current >= t.target,
        claimed: !!claimed[t.id]
      };
    });
  }

  claimWarmupReward(taskId) {
    if (!this.data.warmup || typeof this.data.warmup.claimed !== 'object') this.data.warmup = { claimed: {} };
    if (this.data.warmup.claimed[taskId]) return 0;
    const t = WARMUP_TASKS.find(x => x.id === taskId);
    if (!t) return 0;
    if (this._warmupProgress(taskId) < t.target) return 0;
    this.data.warmup.claimed[taskId] = true;
    this.data.points = (this.data.points || 0) + t.reward;
    this.saveData();
    return t.reward;
  }

  // 供积分商店等外部模块调用：直接解锁指定称号（不发 toast，由调用方提示）
  unlockTitle(titleId) {
    if (!TITLES.find(t => t.id === titleId)) return false;
    if (!this.data.unlockedTitles.includes(titleId)) {
      this.data.unlockedTitles.push(titleId);
      this.saveData();
    }
    return true;
  }

  /* ================= 称号 ================= */

  getEquippedTitleObj() {
    if (!this.data.equippedTitle || !this.data.unlockedTitles.includes(this.data.equippedTitle)) {
      return { id: 'none', name: '未解锁任何称号', icon: '🔒' };
    }
    return TITLES.find(t => t.id === this.data.equippedTitle) || { id: 'none', name: '未解锁任何称号', icon: '🔒' };
  }

  // 解锁进度文案：未解锁称号显示「还差多少」，已解锁返回空
  _titleProgressText(id) {
    const d = this.data;
    switch (id) {
      case 't0': return `已完成 ${d.totalGames || 0}/1 局`;
      case 't3': return `已抓捕 ${d.totalCatches || 0}/5 次`;
      case 't4': return `已奔跑 ${d.totalDistance || 0}/1000m`;
      case 't5': return `已胜利 ${d.totalWins || 0}/3 局`;
      case 't6': return `已奔跑 ${d.totalDistance || 0}/2000m`;
      default: return '';
    }
  }

  getTitles() {
    return TITLES.map(t => {
      const unlocked = this.data.unlockedTitles.includes(t.id);
      return {
        ...t,
        unlocked,
        equipped: this.data.equippedTitle === t.id,
        progressText: unlocked ? '' : this._titleProgressText(t.id)
      };
    });
  }

  equipTitle(titleId) {
    if (this.data.unlockedTitles.includes(titleId)) {
      this.data.equippedTitle = titleId;
      this.saveData();
      return true;
    }
    return false;
  }

  _unlock(titleId) {
    if (this.data.unlockedTitles.includes(titleId)) return;
    const t = TITLES.find(x => x.id === titleId);
    this.data.unlockedTitles.push(titleId);
    try {
      showToast({ title: `🎉 解锁新称号: ${t ? t.name : titleId}`, icon: 'none' });
    } catch (e) {
      /* 非 Web 环境（测试）无 DOM：静默 */
    }
  }

  /* ================= 记录接口 ================= */

  // 记录一次技能释放，推进每日任务 task_3 与热身任务 w3
  recordSkillUse(count = 1) {
    this.data.totalSkills = (this.data.totalSkills || 0) + count;
    const task = this.data.tasks.find(t => t.id === 'task_3');
    if (task && !task.done) {
      task.current = Math.min(task.target, task.current + count);
      if (task.current >= task.target) task.done = true;
    }
    this.saveData();
  }

  // 记录一次成功抓捕（猫），推进称号 t3
  recordCatch() {
    this.data.totalCatches = (this.data.totalCatches || 0) + 1;
    if (this.data.totalCatches >= 5) this._unlock('t3');
    this.saveData();
  }

  updateProgress(distance, wins, completedGame) {
    completedGame = !!completedGame;
    this.data.totalDistance += distance;
    if (wins) this.data.totalWins += 1;
    if (completedGame) this.data.totalGames = (this.data.totalGames || 0) + 1;

    // 检查解锁新称号
    if ((this.data.totalGames || 0) >= 1) this._unlock('t0');
    if (this.data.totalDistance >= 1000) this._unlock('t4');
    if (this.data.totalDistance >= 2000) this._unlock('t6');
    if (this.data.totalWins >= 3) this._unlock('t5');

    // 更新每日任务
    this.data.tasks.forEach(t => {
      if (t.id === 'task_1') {
        t.current = Math.min(t.target, t.current + distance);
        if (t.current >= t.target) t.done = true;
      }
      if (t.id === 'task_2') {
        // “完成 2 局对战”只应在整局结束时 +1，而非每次定位/移动
        if (completedGame) {
          t.current = Math.min(t.target, t.current + 1);
          if (t.current >= t.target) t.done = true;
        }
      }
    });

    this.saveData();
  }
}

export const achievementManager = new AchievementManager();
