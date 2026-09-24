import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStorage, setStorage, setStorageBackend } from '../js/platform/storage.js';

function mem() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  };
}

test('getStorage missing key returns null', () => {
  setStorageBackend(mem());
  assert.equal(getStorage('nope'), null);
});

test('setStorage then getStorage round-trips object', () => {
  setStorageBackend(mem());
  setStorage('indexCfg', { selectedTeam: 'cat', durationMinutes: 15 });
  assert.deepEqual(getStorage('indexCfg'), { selectedTeam: 'cat', durationMinutes: 15 });
});

test('getStorage on raw (non-JSON) string returns raw string', () => {
  const b = mem();
  b.setItem('raw', 'hello');
  setStorageBackend(b);
  assert.equal(getStorage('raw'), 'hello');
});

test('setStorage with no backend is a no-op (does not throw)', () => {
  setStorageBackend(null);
  assert.doesNotThrow(() => setStorage('x', 1));
  assert.equal(getStorage('x'), null);
});
