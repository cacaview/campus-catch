// 存储兼容层：wx.getStorageSync/setStorageSync → localStorage（内存兜底）
let injected = null;

export function setStorageBackend(backend) {
  injected = backend || null;
}

function backend() {
  if (injected) return injected;
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null;
    if (!ls) return null;
    ls.setItem('__t', '1');
    ls.removeItem('__t');
    return ls;
  } catch (e) {
    return null; // 隐私模式等：降级为不可用（上层按 null 处理）
  }
}

export function getStorage(key) {
  const b = backend();
  if (!b) return null;
  try {
    const v = b.getItem(key);
    if (v === null) return null;
    try {
      return JSON.parse(v);
    } catch (e) {
      return v;
    }
  } catch (e) {
    return null;
  }
}

export function setStorage(key, value) {
  const b = backend();
  if (!b) return;
  try {
    b.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* 配额满：静默 */
  }
}
