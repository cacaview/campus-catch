import { test } from 'node:test';
import assert from 'node:assert/strict';
import GameArea from '../js/utils/game-area.js';

test('rebasePoints migrates a legacy-campus polygon without changing its shape', () => {
  const legacy = { latitude: 25.238236, longitude: 110.284419 };
  const current = { latitude: 25.096525, longitude: 110.273130 };
  const points = [
    { latitude: 25.2380, longitude: 110.2840 },
    { latitude: 25.2385, longitude: 110.2840 },
    { latitude: 25.2385, longitude: 110.2848 },
    { latitude: 25.2380, longitude: 110.2848 }
  ];
  const migrated = GameArea.rebasePoints(points, legacy, current);

  assert.notEqual(migrated, points);
  migrated.forEach((point, index) => {
    assert.ok(Math.abs(point.latitude - (points[index].latitude + current.latitude - legacy.latitude)) < 1e-9);
    assert.ok(Math.abs(point.longitude - (points[index].longitude + current.longitude - legacy.longitude)) < 1e-9);
  });
  assert.ok(Math.abs(GameArea.distanceMeters(
    { latitude: points[0].latitude, longitude: points[0].longitude },
    { latitude: points[1].latitude, longitude: points[1].longitude }
  ) - GameArea.distanceMeters(migrated[0], migrated[1])) < 0.01);
});

test('rebasePoints leaves polygons outside the legacy campus untouched', () => {
  const points = [
    { latitude: 25.0960, longitude: 110.2730 },
    { latitude: 25.0965, longitude: 110.2730 },
    { latitude: 25.0965, longitude: 110.2735 }
  ];
  assert.equal(
    GameArea.rebasePoints(points, { latitude: 25.238236, longitude: 110.284419 }, { latitude: 25.096525, longitude: 110.273130 }),
    points
  );
});

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
