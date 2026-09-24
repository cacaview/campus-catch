import { test } from 'node:test';
import assert from 'node:assert/strict';

function setNavigator(obj) {
  Object.defineProperty(globalThis, 'navigator', { value: obj, configurable: true, writable: true });
}

function fakeGeo(impl) { setNavigator({ geolocation: impl }); }

test('startLocationUpdate returns false without geolocation', async () => {
  setNavigator({});
  const mod = await import('../js/platform/geo.js?b=' + Date.now());
  assert.equal(mod.startLocationUpdate(() => {}), false);
});

test('startLocationUpdate wires watchPosition and maps coords', async () => {
  let cb = null;
  let opts = null;
  fakeGeo({
    watchPosition: (c, e, o) => { cb = c; opts = o; return 42; },
    clearWatch: () => {}
  });
  const mod = await import('../js/platform/geo.js?b=' + Date.now());
  assert.equal(mod.startLocationUpdate(loc => { globalThis.__captured = loc; }), true);
  assert.equal(opts.enableHighAccuracy, true);
  cb({ coords: { latitude: 25.1, longitude: 110.1, accuracy: 12 } });
  assert.deepEqual(globalThis.__captured, { latitude: 25.1, longitude: 110.1, accuracy: 12 });
  mod.stopLocationUpdate();
});

test('getLocation maps getCurrentPosition success/fail', async () => {
  let succ = null;
  let fail = null;
  fakeGeo({ getCurrentPosition: (s, f) => { succ = s; fail = f; } });
  const mod = await import('../js/platform/geo.js?b=' + Date.now());
  mod.getLocation({
    success: l => { globalThis.__loc = l; },
    fail: e => { globalThis.__err = e; }
  });
  succ({ coords: { latitude: 1, longitude: 2, accuracy: 5 } });
  assert.deepEqual(globalThis.__loc, { latitude: 1, longitude: 2, accuracy: 5 });
  fail(new Error('denied'));
  assert.ok(globalThis.__err instanceof Error);
});
