/**
 * 🃏 真实户外 GPS / LBS 场景专属技能卡池
 * 所有的技能均围绕 GPS 定位、地图标记、隐身、雷达与真实移动展开
 */

const SKILLS_DB = [
  {
    id: 'stealth',
    name: '匿影藏形',
    type: 'MOUSE',
    maxUses: 3,
    duration: 15,
    icon: '🌫️',
    description: '在敌方地图上隐藏自己的 GPS 标记 15 秒，便于利用现实建筑逃脱'
  },
  {
    id: 'xray',
    name: '火眼金睛',
    type: 'MOUSE',
    maxUses: 2,
    duration: 10,
    icon: '👁️',
    description: '10 秒内高亮透视全图所有敌人的精确 GPS 位置与移动轨迹'
  },
  {
    id: 'decoy_signal',
    name: '声东击西',
    type: 'MOUSE',
    maxUses: 2,
    duration: 10,
    icon: '📢',
    description: '在远处伪造一个虚假的 GPS 信号点，调虎离山诱骗猫咪朝错误方向奔跑'
  },
  {
    id: 'disguise',
    name: '伪装掩护',
    type: 'MOUSE',
    maxUses: 1,
    duration: 15,
    icon: '🎭',
    description: '将自己的地图标记伪装成猫阵营图标，混淆对方视线'
  },
  {
    id: 'golden_shield',
    name: '金钟罩',
    type: 'MOUSE',
    maxUses: 1,
    duration: 10,
    icon: '🛡️',
    description: '开启后 10 秒内免疫 GPS 靠近抓捕，争取绝地反击的逃跑时间'
  },
  {
    id: 'cat_radar',
    name: '猫咪热感',
    type: 'CAT',
    maxUses: 2,
    duration: 10,
    icon: '🔥',
    description: '10 秒内强化定位精度，缩小与目标老鼠的预判范围'
  }
];

const SkillSystem = {
  getSkillsForTeam(team) {
    const isCat = team === 'cat' || team === 'CAT';
    return SKILLS_DB.filter(s => {
      if (s.type === 'NEUTRAL') return true;
      return isCat ? s.type === 'CAT' : s.type === 'MOUSE';
    }).map(s => ({
      ...s,
      usesLeft: s.maxUses,
      isOnCooldown: false
    }));
  },

  isSkillAvailable(skill) {
    if (!skill) return false;
    if (skill.usesLeft <= 0) return false;
    if (skill.isOnCooldown) return false;
    return true;
  }
};

export default SkillSystem;
