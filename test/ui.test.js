import { test } from 'node:test';
import assert from 'node:assert/strict';

// 最小 DOM 桩：ui.js 只依赖 getElementById 返回的对象有 classList/textContent/style/onclick/innerHTML/appendChild
function makeEl(id) {
  const el = {
    id,
    textContent: '',
    innerHTML: '',
    style: {},
    value: '',
    children: [],
    _cls: new Set(),
    onclick: null,
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    select() {},
    className: ''
  };
  el.classList = {
    add: c => el._cls.add(c),
    remove: c => el._cls.delete(c),
    contains: c => el._cls.has(c),
    toggle: (c, f) => (f ? el._cls.add(c) : el._cls.delete(c))
  };
  return el;
}

function setNavigator(obj) {
  Object.defineProperty(globalThis, 'navigator', { value: obj, configurable: true, writable: true });
}

function installDom() {
  const els = {};
  ['app-toast', 'app-modal-mask', 'app-modal-box', 'app-modal-title', 'app-modal-content',
   'app-modal-confirm', 'app-modal-cancel', 'app-loading', 'app-loading-text',
   'app-actionsheet-mask', 'app-actionsheet', 'app-actionsheet-list'].forEach(id => els[id] = makeEl(id));
  els['app-modal-confirm'].onclick = null;
  globalThis.document = {
    getElementById: id => els[id] || null,
    createElement: () => makeEl('tmp'),
    body: { appendChild() {} },
    execCommand: () => true
  };
  setNavigator({ clipboard: undefined, vibrate: undefined });
  return els;
}

test('showToast sets text and show class, hides after duration', async () => {
  const els = installDom();
  const mod = await import('../js/platform/ui.js?b=' + Date.now());
  mod.showToast({ title: '测试', icon: 'success', duration: 50 });
  assert.equal(els['app-toast'].textContent, '✅ 测试');
  assert.ok(els['app-toast'].classList.contains('show'));
  await new Promise(r => setTimeout(r, 80));
  assert.ok(!els['app-toast'].classList.contains('show'));
});

test('showModal resolves confirm on confirm button, hides cancel when showCancel=false', async () => {
  const els = installDom();
  const mod = await import('../js/platform/ui.js?b=' + Date.now());
  const p = mod.showModal({ title: 'T', content: 'C', showCancel: false });
  assert.equal(els['app-modal-cancel'].style.display, 'none');
  assert.equal(els['app-modal-mask'].classList.contains('show'), true);
  els['app-modal-confirm'].onclick();
  const res = await p;
  assert.deepEqual(res, { confirm: true, tapIndex: 0 });
  assert.ok(!els['app-modal-mask'].classList.contains('show'));
});

test('showActionSheet resolves tapped index', async () => {
  const els = installDom();
  const mod = await import('../js/platform/ui.js?b=' + Date.now());
  const p = mod.showActionSheet({ itemList: ['a', 'b'] });
  assert.equal(els['app-actionsheet-list'].children.length, 2); // 两个按钮子节点
  assert.equal(els['app-actionsheet-list'].children[0].textContent, 'a');
  assert.ok(els['app-actionsheet'].classList.contains('show'));
  els['app-actionsheet-list'].children[1].onclick();
  assert.deepEqual(await p, { tapIndex: 1 });
  assert.ok(!els['app-actionsheet-mask'].classList.contains('show'));
});

test('showActionSheet mask click cancels with tapIndex -1', async () => {
  const els = installDom();
  const mod = await import('../js/platform/ui.js?b=' + Date.now());
  const p = mod.showActionSheet({ itemList: ['a', 'b'] });
  els['app-actionsheet-mask'].onclick();
  assert.deepEqual(await p, { tapIndex: -1 });
});

test('loading ref-count: nested show/hide keeps visible until balanced', async () => {
  const els = installDom();
  const mod = await import('../js/platform/ui.js?b=' + Date.now());
  mod.showLoading({ title: 'x' });
  mod.showLoading({ title: 'y' });
  mod.hideLoading();
  assert.ok(els['app-loading'].classList.contains('show'));
  mod.hideLoading();
  assert.ok(!els['app-loading'].classList.contains('show'));
});

test('vibrateShort/vibrateLong no-op without navigator.vibrate (no throw)', async () => {
  installDom();
  const mod = await import('../js/platform/ui.js?b=' + Date.now());
  assert.doesNotThrow(() => {
    mod.vibrateShort('heavy');
    mod.vibrateLong();
  });
});
