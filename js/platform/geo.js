// 定位兼容层：wx.getLocation / startLocationUpdate / onLocationChange → Geolocation API
// 浏览器 GPS 返回 WGS-84（与瓦片坐标系一致，spec §4.1）
let watchId = null;
let changeCb = null;

export function isSecureContext() {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

export function getLocation({ success, fail } = {}) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    fail && fail(new Error('unsupported'));
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => success && success({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    err => fail && fail(err),
    // 与 wx.getLocation 的默认 10s 超时对齐：桌面无 GPS 时不能无限挂起
    { timeout: 10000, maximumAge: 60000 }
  );
}

/** 启动持续定位；返回 false 表示环境不支持（调用方切模拟移动，与原 fail 分支一致） */
export function startLocationUpdate(onChange) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return false;
  changeCb = onChange;
  try {
    watchId = navigator.geolocation.watchPosition(
      pos => changeCb && changeCb({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => {
        /* 单次失败不终止 watch */
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
    return true;
  } catch (e) {
    return false;
  }
}

export function stopLocationUpdate() {
  if (watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
    try {
      navigator.geolocation.clearWatch(watchId);
    } catch (e) {}
  }
  watchId = null;
  changeCb = null;
}
