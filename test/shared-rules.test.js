import test from 'node:test';
import assert from 'node:assert/strict';
import GameArea from '../shared/game-area.js';
import { MapItems, roomItemSeed } from '../shared/map-items.js';

test('item pickup uses geographic distance instead of a rectangular degree threshold', () => {
  const manager = new MapItems();
  manager.items = [{ id: 2001, type: 'CHEESE', latitude: 60, longitude: 10 }];
  assert.equal(manager.findItemPickup({ latitude: 60, longitude: 10.0002 }, false)?.id, 2001);
  assert.equal(manager.findItemPickup({ latitude: 60.00014, longitude: 10.00014 }, false), undefined,
    'a diagonal point more than fifteen meters away must not request a pickup');
});

test('browser and relay deterministic items do not share mutable per-room state', () => {
  const a = new MapItems(), b = new MapItems();
  const center = { latitude: 23.1598575, longitude: 108.1912479 };
  const seed = roomItemSeed('ROOM_1234', center);
  a.spawnItems(center, 8, seed); b.spawnItems(center, 8, seed);
  assert.deepEqual(a.items, b.items);
  a.removeItemById(a.items[0].id);
  assert.equal(a.items.length, 7); assert.equal(b.items.length, 8);
});

test('invalid JSON polygon points are rejected without coercion or exceptions', () => {
  for (const points of [[null,null,null], [{latitude:{toString:null},longitude:0}, {}, {}],
    [{latitude:0,longitude:0},{latitude:1,longitude:1},{latitude:2,longitude:2}],
    Array.from({length:65}, () => ({latitude:0,longitude:0}))]) {
    assert.equal(GameArea.isValidArea({ type: 'polygon', points }), false);
  }
});
