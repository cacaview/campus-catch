/**
 * 📳 音效与触觉震动反馈模块 (Sound & Vibration Manager)
 * 处理抓捕、逃脱、踩陷阱、技能释放时的短震/长震与音效
 */
import { vibrateShort as uiVibrateShort, vibrateLong as uiVibrateLong } from '../platform/ui.js';

class SoundVibrationManager {
  /**
   * 触发短触觉震动 (抓捕/点击/释放技能)
   */
  vibrateShort(type = 'medium') {
    try {
      uiVibrateShort(type);
    } catch (e) {
      // ignore
    }
  }

  /**
   * 触发长震动 (被抓捕/游戏结束)
   */
  vibrateLong() {
    try {
      uiVibrateLong();
    } catch (e) {
      // ignore
    }
  }

  /**
   * 播放音效提示
   */
  playSound(soundType) {
    console.log(`[SoundManager] Playing sound effect: ${soundType}`);
    // 触发对应级别的震动提示反馈
    switch (soundType) {
      case 'catch_success':
        this.vibrateLong();
        break;
      case 'escape_success':
        this.vibrateShort('light');
        break;
      case 'trap_triggered':
        this.vibrateShort('heavy');
        break;
      case 'skill_used':
        this.vibrateShort('medium');
        break;
      default:
        this.vibrateShort('light');
        break;
    }
  }
}

const soundVibrationManager = new SoundVibrationManager();

export default soundVibrationManager;
