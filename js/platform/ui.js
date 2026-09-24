// UI 兼容层：wx.showToast/showModal/showLoading/showActionSheet/clipboard/vibrate
let toastTimer = null;

export function showToast({ title, icon = 'none', duration = 2500 } = {}) {
  const el = document.getElementById('app-toast');
  const prefix = icon === 'success' ? '✅ ' : icon === 'error' ? '❌ ' : '';
  el.textContent = prefix + (title || '');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

export function showModal({ title = '', content = '', showCancel = true, confirmText = '确定', cancelText = '取消' } = {}) {
  return new Promise(resolve => {
    const mask = document.getElementById('app-modal-mask');
    const confirmBtn = document.getElementById('app-modal-confirm');
    const cancelBtn = document.getElementById('app-modal-cancel');
    document.getElementById('app-modal-title').textContent = title;
    document.getElementById('app-modal-content').textContent = content;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = showCancel ? '' : 'none';
    mask.classList.add('show');
    const done = confirmed => {
      mask.classList.remove('show');
      confirmBtn.onclick = cancelBtn.onclick = null;
      resolve({ confirm: confirmed, tapIndex: confirmed ? 0 : 1 });
    };
    confirmBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
  });
}

let loadingCount = 0;
export function showLoading({ title = '' } = {}) {
  loadingCount++;
  document.getElementById('app-loading-text').textContent = title;
  document.getElementById('app-loading').classList.add('show');
}
export function hideLoading() {
  if (--loadingCount <= 0) {
    loadingCount = 0;
    document.getElementById('app-loading').classList.remove('show');
  }
}

export function showActionSheet({ itemList = [] } = {}) {
  return new Promise(resolve => {
    const mask = document.getElementById('app-actionsheet-mask');
    const sheet = document.getElementById('app-actionsheet');
    const list = document.getElementById('app-actionsheet-list');
    list.innerHTML = '';
    let finished = false;
    const finish = tapIndex => {
      if (finished) return;
      finished = true;
      mask.classList.remove('show');
      sheet.classList.remove('show');
      mask.onclick = null;
      resolve({ tapIndex });
    };
    itemList.forEach((text, i) => {
      const btn = document.createElement('button');
      btn.className = 'sheet-item';
      btn.textContent = text;
      btn.onclick = () => finish(i);
      list.appendChild(btn);
    });
    mask.onclick = () => finish(-1);
    mask.classList.add('show');
    sheet.classList.add('show');
  });
}

export function setClipboardData(data) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(data).catch(() => {});
  }
  return new Promise(resolve => {
    const ta = document.createElement('textarea');
    ta.value = data;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {}
    ta.remove();
    resolve();
  });
}

export async function getClipboardData() {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (e) {
    /* 权限拒绝等 */
  }
  return '';
}

const VIBRO = { light: 10, medium: 20, heavy: 40 };
export function vibrateShort(type = 'medium') {
  try {
    navigator.vibrate && navigator.vibrate(VIBRO[type] || VIBRO.medium);
  } catch (e) {}
}
export function vibrateLong() {
  try {
    navigator.vibrate && navigator.vibrate(200);
  } catch (e) {}
}
