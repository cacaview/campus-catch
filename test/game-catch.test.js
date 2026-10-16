import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/views/game.js', import.meta.url), 'utf8');

// Execute the production handlers in a controlled clock/DOM environment, without
// importing main.js (which starts the browser router as a module side effect).
function catchHarness() {
  const body = source.match(/const onCatchEvent = \(catName, mouseName, success, ids = null\) => \{([\s\S]*?)\n  \};/)[1];
  const timers = new Map();
  let now = 0;
  let nextId = 0;
  const later = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  const s = { myName: '小猫', myTeam: 'cat', showCatchOverlay: false, catchMessage: '' };
  const overlay = { hidden: true, textContent: '' };
  const feed = [];
  const run = new Function('s', 'globalStateRef', 'later', 'clearTimeout', 'renderCatch',
    'addSystemMessage', 'achievementManager', `
    let actionCount = 0, myCatches = 0, myEscapes = 0, catchOverlayTimer = null;
    const onCatchEvent = (catName, mouseName, success, ids = null) => {${body}\n};
    return { event: onCatchEvent, stats: () => ({ actionCount, myCatches, myEscapes }) };
  `)(s, { currentPlayer: { id: 'me' } }, later, id => timers.delete(id), () => {
    overlay.hidden = !s.showCatchOverlay;
    overlay.textContent = s.catchMessage;
  }, message => feed.push(message), { recordCatch() {} });
  return { ...run, overlay, feed, s, advance(ms) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  } };
}

const myCatch = { catId: 'me', mouseId: 'mouse' };

test('successful catch visibly tells the catching player 抓捕成功', () => {
  const h = catchHarness();
  h.event('小猫', '小鼠', true, myCatch);
  assert.equal(h.overlay.hidden, false);
  assert.match(h.overlay.textContent, /抓捕成功/);
  assert.ok(h.overlay.textContent.includes('小鼠'));
  assert.match(h.feed.at(-1), /抓捕成功/);
  assert.deepEqual(h.stats(), { actionCount: 1, myCatches: 1, myEscapes: 0 });
});

test('caught mouse receives an unambiguous caught message', () => {
  const h = catchHarness();
  h.s.myTeam = 'mouse';
  h.event('对手', '小猫', true, { catId: 'other', mouseId: 'me' });
  assert.match(h.overlay.textContent, /你被.*抓捕/);
});

test('new catch stays visible for its full duration when results arrive close together', () => {
  const h = catchHarness();
  h.event('小猫', '第一只鼠', true, myCatch);
  h.advance(2000);
  h.event('小猫', '第二只鼠', true, myCatch);
  h.advance(500);
  assert.equal(h.overlay.hidden, false, 'the previous result must not dismiss the newer result');
  assert.ok(h.overlay.textContent.includes('第二只鼠'));
  h.advance(2000);
  assert.equal(h.overlay.hidden, true);
});

test('other players catches appear in the feed without inflating personal stats', () => {
  const h = catchHarness();
  h.event('其他猫', '其他鼠', true, { catId: 'cat2', mouseId: 'mouse2' });
  assert.equal(h.feed.length, 1);
  assert.deepEqual(h.stats(), { actionCount: 0, myCatches: 0, myEscapes: 0 });
  assert.equal(h.overlay.hidden, true, 'room-wide events must not replace the personal result');
});

test('escape result credits only the escaping player', () => {
  const h = catchHarness();
  h.s.myTeam = 'mouse';
  h.event('其他猫', '小猫', false, { catId: 'other', mouseId: 'me' });
  assert.match(h.overlay.textContent, /逃脱成功/);
  assert.deepEqual(h.stats(), { actionCount: 1, myCatches: 0, myEscapes: 1 });
});
