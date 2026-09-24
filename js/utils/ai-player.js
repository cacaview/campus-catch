/**
 * 🤖 AI 玩家行为控制器（单机模式）
 * 猫 AI：视距内追最近的老鼠（AI 或玩家），失去目标则游走；
 * 鼠 AI：40 米内有猫就逃离，否则游走；偶发 AI 聊天。
 * 数据形状与 game.js 一致：{ id, name, team:'cat'|'mouse', latitude, longitude, score }
 */

const CHAT_MESSAGES = [
  '被包围了咋办，在线等，很急',
  '救命啊！猫在我后面！',
  '哈哈，你们抓不到我',
  '前面有陷阱，大家小心',
  '你在哪？我去找你',
  '稳住，我们能赢！'
];

// 视距（度）：约 0.0011 度 ≈ 120 米，避免猫 AI 全图瞬移式锁定
const CAT_VISION_DEG = 0.0011;
// 逃离触发距离（度）：约 0.00036 度 ≈ 40 米
const MOUSE_FLEE_DEG = 0.00036;
// 每次移动步长（度）：约 3 米 / 1.5 秒 tick ≈ 2m/s
const STEP_DEG = 0.00003;

const AIPlayerController = {
  // 返回 { latitude, longitude, chat }；chat 为偶发聊天文本或 null
  updateAI(ai, players) {
    let dx = 0;
    let dy = 0;
    const myCat = ai.team === 'cat';

    if (myCat) {
      let target = null;
      let minD = Infinity;
      players.forEach(p => {
        if (p === ai || p.team !== 'mouse') return;
        const d = this.distSq(ai, p);
        if (d < minD) { minD = d; target = p; }
      });
      if (target && minD < CAT_VISION_DEG * CAT_VISION_DEG) {
        dx = target.longitude - ai.longitude;
        dy = target.latitude - ai.latitude;
      }
    } else {
      let threat = null;
      let minD = Infinity;
      players.forEach(p => {
        if (p === ai || p.team !== 'cat') return;
        const d = this.distSq(ai, p);
        if (d < minD) { minD = d; threat = p; }
      });
      if (threat && minD < MOUSE_FLEE_DEG * MOUSE_FLEE_DEG) {
        // 逃离速度略快于追击，保证鼠 AI 有机会甩开
        dx = (ai.longitude - threat.longitude) * 1.15;
        dy = (ai.latitude - threat.latitude) * 1.15;
      }
    }

    const norm = Math.sqrt(dx * dx + dy * dy);
    let nLat;
    let nLng;
    if (norm > 0) {
      // 主方向 + 随机抖动，避免追逃路线过于机械
      nLat = ai.latitude + (dy / norm) * STEP_DEG + (Math.random() - 0.5) * STEP_DEG * 0.6;
      nLng = ai.longitude + (dx / norm) * STEP_DEG + (Math.random() - 0.5) * STEP_DEG * 0.6;
    } else {
      nLat = ai.latitude + (Math.random() - 0.5) * STEP_DEG;
      nLng = ai.longitude + (Math.random() - 0.5) * STEP_DEG;
    }

    const chat = Math.random() < 0.008
      ? CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)]
      : null;

    return { latitude: nLat, longitude: nLng, chat };
  },

  distSq(a, b) {
    const dx = a.longitude - b.longitude;
    const dy = a.latitude - b.latitude;
    return dx * dx + dy * dy;
  }
};

export default AIPlayerController;
