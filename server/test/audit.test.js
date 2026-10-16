import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry } from '../lib/room-registry.js';

class Socket {
  readyState = 1; sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  packets(type) { return this.sent.filter(p => p.type === type); }
}
const packet = (type, payload = {}) => ({ type, payload });
const area = { type: 'polygon', points: [
  { latitude: 23.159, longitude: 108.190 }, { latitude: 23.160, longitude: 108.190 },
  { latitude: 23.160, longitude: 108.192 }, { latitude: 23.159, longitude: 108.192 }
] };
function setup(options = {}) {
  let now = 1000;
  const registry = new RoomRegistry({ now: () => now, ...options });
  const join = (id, team = 'cat', extra = {}, passcode = '1234') => {
    const ws = new Socket(); registry.onConnection(ws);
    registry.handlePacket(ws, packet('JOIN_ROOM', { passcode,
      player: { id, name: id, team }, gameArea: area,
      createIfMissingRoom: !registry.rooms.has(passcode), ...extra }));
    return ws;
  };
  const host = join('host'); const mouse = join('mouse', 'mouse');
  registry.handlePacket(host, packet('ROOM_START_REQUEST'));
  now = 4000;
  const move = (ws, latitude = 23.1595, longitude = 108.191, extra = {}) =>
    registry.handlePacket(ws, packet('PLAYER_MOVE', { latitude, longitude, score: 0, ...extra }));
  return { registry, join, host, mouse, move, room: registry.rooms.get('1234'), at: n => { now = n; } };
}

test('untrusted JSON objects never throw in numeric fields', () => {
  const h = setup(); const bad = { toString: null };
  const stranger = new Socket(); h.registry.onConnection(stranger);
  for (const ws of [stranger, h.host]) {
    for (const p of [packet('MAP_ITEM_PICKUP', { itemId: bad }), packet('PLAYER_MOVE', { latitude: bad, longitude: 1 }),
      packet('GAME_EXTEND', { seconds: bad })]) assert.doesNotThrow(() => h.registry.handlePacket(ws, p));
  }
  assert.doesNotThrow(() => h.join('invalid', 'cat', { gameDurationSeconds: bad }, 'bad-room'));
  assert.doesNotThrow(() => h.join('invalid-area', 'cat', { gameArea: { type: 'polygon', points: [null, bad, bad] } }, 'bad-area'));
});

test('known player IDs cannot replace members without private reconnect proof', () => {
  const h = setup(); const original = h.host;
  const impostor = h.join('host', 'mouse');
  assert.equal(impostor.packets('JOIN_ACK').at(-1).payload.success, false);
  assert.equal(original.readyState, 1);
  const token = original.packets('JOIN_ACK')[0].payload.reconnectToken;
  assert.ok(typeof token === 'string' && token.length >= 32);
  assert.ok(!JSON.stringify(h.mouse.sent).includes(token), 'private token must not enter public roster');
  const resumed = h.join('host', 'mouse', { reconnectToken: token });
  assert.equal(resumed.packets('JOIN_ACK').at(-1).payload.success, true);
  assert.equal(resumed.packets('JOIN_ACK').at(-1).payload.members.find(p => p.id === 'host').team, 'cat');
  assert.equal(original.readyState, 3);
  h.registry.handlePacket(original, packet('JOIN_ROOM', { passcode: '1234', player: { id: 'host', name: 'host', team: 'cat' }, reconnectToken: token }));
  assert.equal(h.room.members.get('host').ws, resumed, 'replaced socket must stay blocked');
});

test('ordinary member cannot publish host controls', () => {
  const h = setup();
  for (const [type, payload] of [['GAME_PAUSE', { paused: true }], ['GAME_EXTEND', { seconds: 300 }],
    ['SYNC_ROOM_STATE', { remainingTime: 10 }], ['PLAYER_KICK', { playerId: 'host' }]]) {
    h.registry.handlePacket(h.mouse, packet(type, payload));
    assert.equal(h.host.packets(type).length, 0, type);
  }
});

test('movement broadcasts canonical membership and rejects invalid coordinates', () => {
  const h = setup();
  h.move(h.mouse, 23.1595, 108.191, { id: 'host', name: '<img>', team: 'cat', score: '<img>' });
  const p = h.host.packets('PLAYER_MOVE').at(-1).payload;
  assert.equal(p.id, 'mouse'); assert.equal(p.name, 'mouse'); assert.equal(p.team, 'mouse'); assert.equal(p.score, 0);
  const count = h.host.packets('PLAYER_MOVE').length;
  h.move(h.mouse, 999, 181);
  assert.equal(h.host.packets('PLAYER_MOVE').length, count);
});

test('host kick revokes membership and prevents queued packets from rejoining', () => {
  const h = setup(); const token = h.mouse.packets('JOIN_ACK')[0].payload.reconnectToken;
  h.registry.handlePacket(h.host, packet('PLAYER_KICK', { playerId: 'mouse', name: '<img>' }));
  assert.equal(h.room.members.has('mouse'), false);
  assert.equal(h.mouse.readyState, 3);
  h.registry.handlePacket(h.mouse, packet('JOIN_ROOM', { passcode: '1234', player: { id: 'mouse', name: 'mouse', team: 'mouse' }, reconnectToken: token }));
  assert.equal(h.room.members.has('mouse'), false);
  assert.equal(h.join('mouse', 'mouse', { reconnectToken: token }).packets('JOIN_ACK').at(-1).payload.success, false);
});

test('pause clears proximity progress and blocks captures; end blocks all further gameplay', () => {
  const h = setup(); h.move(h.mouse); h.move(h.host);
  h.registry.handlePacket(h.host, packet('GAME_PAUSE', { paused: true }));
  h.at(8000); h.move(h.mouse); h.move(h.host);
  assert.equal(h.host.packets('CATCH_EVENT').length, 0);
  h.registry.handlePacket(h.host, packet('GAME_PAUSE', { paused: false }));
  h.move(h.mouse); h.move(h.host);
  assert.equal(h.host.packets('CATCH_EVENT').length, 0);
  h.registry.handlePacket(h.host, packet('GAME_END'));
  h.at(11000); h.move(h.mouse); h.move(h.host);
  assert.equal(h.host.packets('CATCH_EVENT').length, 0);
  assert.equal(h.room.phase, 'ENDED');
});

test('nonexistent pickups cannot exhaust valid items; proximity and team are enforced', () => {
  const h = setup();
  for (let i = 2001; i < 2009; i++) h.registry.handlePacket(h.mouse, packet('MAP_ITEM_PICKUP', { itemId: i }));
  assert.equal(h.room.pickedMapItemIds.size, 0);
  const cheese = h.room.mapItems.items.find(i => i.type === 'CHEESE');
  h.move(h.host, cheese.latitude, cheese.longitude);
  h.registry.handlePacket(h.host, packet('MAP_ITEM_PICKUP', { itemId: cheese.id }));
  assert.equal(h.room.pickedMapItemIds.size, 0, 'wrong team');
  h.move(h.mouse, 23.159, 108.190);
  h.registry.handlePacket(h.mouse, packet('MAP_ITEM_PICKUP', { itemId: cheese.id }));
  assert.equal(h.room.pickedMapItemIds.size, 0, 'too far');
  h.move(h.mouse, cheese.latitude, cheese.longitude);
  h.registry.handlePacket(h.mouse, packet('MAP_ITEM_PICKUP', { itemId: cheese.id }));
  h.registry.handlePacket(h.mouse, packet('MAP_ITEM_PICKUP', { itemId: cheese.id }));
  assert.equal(h.room.pickedMapItemIds.size, 1);
  assert.equal(h.mouse.packets('MAP_ITEM_PICKUP').length, 1);
});

test('east-west distances use latitude scaling for the ten meter catch radius', () => {
  const h = setup();
  const a = { latitude: 60, longitude: 10 }, b = { latitude: 60, longitude: 10.00016 };
  assert.ok(h.registry.distanceMeters(a, b) > 8 && h.registry.distanceMeters(a, b) < 10);
});

test('room and retained membership counts have explicit bounds', () => {
  const h = setup({ maxRooms: 1, maxMembers: 2, maxRoomSessions: 2 });
  assert.equal(h.join('third').packets('JOIN_ACK').at(-1).payload.success, false);
  assert.equal(h.join('other-host', 'cat', {}, '5678').packets('JOIN_ACK').at(-1).payload.success, false);
  h.registry.removeConnection(h.mouse);
  assert.equal(h.join('new-third', 'mouse').packets('JOIN_ACK').at(-1).payload.success, false);
});

test('slow receivers cannot accumulate unbounded outgoing broadcasts', () => {
  const h = setup(); h.mouse.bufferedAmount = 2_000_000;
  h.registry.handlePacket(h.host, packet('CHAT_MESSAGE', { text: 'hello' }));
  assert.equal(h.mouse.readyState, 3);
});

test('relay derives remote marker effects from skills, never client movement flags', () => {
  const h = setup(); h.move(h.mouse);
  h.move(h.mouse, 23.1595, 108.191, { stealthActive: true, disguiseActive: true });
  assert.equal(h.host.packets('PLAYER_MOVE').at(-1).payload.stealthActive, false);
  h.registry.handlePacket(h.mouse, packet('USE_SKILL', { skillId: 'stealth' }));
  assert.equal(h.host.packets('PLAYER_MOVE').at(-1).payload.stealthActive, true);
  h.registry.handlePacket(h.mouse, packet('USE_SKILL', { skillId: 'disguise' }));
  assert.equal(h.host.packets('PLAYER_MOVE').at(-1).payload.disguiseActive, true);
  h.registry.handlePacket(h.mouse, packet('USE_SKILL', { skillId: 'decoy_signal' }));
  const decoy = h.host.packets('PLAYER_MOVE').at(-1).payload.decoyPosition;
  assert.ok(Number.isFinite(decoy.latitude) && Number.isFinite(decoy.longitude));
  h.at(20000); h.move(h.mouse);
  const expired = h.host.packets('PLAYER_MOVE').at(-1).payload;
  assert.equal(expired.stealthActive, false); assert.equal(expired.disguiseActive, false);
  assert.equal(expired.decoyPosition, null);
});

test('repeated skills consume a bounded per-room allowance', () => {
  const h = setup(); h.move(h.mouse);
  for (let i = 0; i < 20; i++) h.registry.handlePacket(h.mouse, packet('USE_SKILL', { skillId: 'golden_shield' }));
  assert.equal(h.host.packets('USE_SKILL').length, 1);
});
