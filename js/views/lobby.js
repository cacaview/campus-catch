// 占位模块（后续 Task 替换为完整实现）
export function create(rootEl, globalState) {
  rootEl.innerHTML = '<div class="view-loading">' + 'lobby' + ' 视图加载中…</div>';
  return { onShow() {}, onHide() {} };
}
