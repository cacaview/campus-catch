import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomRegistry } from '../lib/room-registry.js';

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = 3;
  }

  packets(type) {
    return this.sent.filter(packet => packet.type === type);
  }

  clear() {
    this.sent.length = 0;
  }
}

const player = (id, team = 'cat') => ({ id, name: `Player ${id}`, team });
const packet = (type, payload = {}, senderId = '') => ({ type, senderId, timestamp: 1, payload });

function joined(registry, id, passcode = '1234', team = 'cat', createIfMissingRoom = !registry.rooms.has(passcode), extra = {}) {
  const socket = new FakeSocket();
  registry.onConnection(socket);
  registry.handlePacket(socket, packet('JOIN_ROOM', {
    passcode,
    player: player(id, team),
    gameArea: null,
    gameDurationSeconds: 600,
    createIfMissingRoom,
    ...extra
  }, id));
  return socket;
}

test('onlyStartedRoomHostCanSynchronizeSettlement', () => {
  const registry = new RoomRegistry();
  const host = joined(registry, 'host');
  const guest = joined(registry, 'guest');
  const other = joined(registry, 'other', '9999');
  guest.clear();
  registry.handlePacket(host, packet('GAME_END'));
  assert.equal(guest.packets('GAME_END').length, 0);
  registry.handlePacket(host, packet('ROOM_START_REQUEST'));
  host.clear(); guest.clear(); other.clear();
  registry.handlePacket(guest, packet('GAME_END', {}, 'host'));
  assert.equal(host.packets('GAME_END').length, 0);
  registry.handlePacket(host, packet('GAME_END'));
  assert.equal(guest.packets('GAME_END').length, 1);
  assert.equal(guest.packets('GAME_END')[0].senderId, 'host');
  assert.equal(other.packets('GAME_END').length, 0);
});

test('routesChatOnlyWithinJoinedRoom', () => {
  const registry = new RoomRegistry();
  const sender = joined(registry, 'sender');
  const sameRoom = joined(registry, 'same-room');
  const otherRoom = joined(registry, 'other-room', '9999');
  sameRoom.clear();
  otherRoom.clear();

  registry.handlePacket(sender, packet('CHAT_MESSAGE', { sender: 'Spoof', text: 'hello' }, 'sender'));

  assert.equal(sameRoom.packets('CHAT_MESSAGE').length, 1);
  assert.equal(otherRoom.packets('CHAT_MESSAGE').length, 0);
});

test('usesJoinedIdentityForChat', () => {
  const registry = new RoomRegistry();
  const sender = joined(registry, 'sender');
  const receiver = joined(registry, 'receiver');
  receiver.clear();

  registry.handlePacket(sender, packet('CHAT_MESSAGE', { sender: 'Admin', text: 'hello' }, 'admin-id'));

  assert.equal(receiver.packets('CHAT_MESSAGE')[0].payload.sender, 'Player sender');
  assert.equal(receiver.packets('CHAT_MESSAGE')[0].senderId, 'sender');
});

test('reconnecting sole room member keeps the room registered', () => {
  const registry = new RoomRegistry();
  const original = joined(registry, 'same-player', '1234');

  const reconnected = joined(registry, 'same-player', '1234', 'cat', false, { reconnectToken: original.packets('JOIN_ACK')[0].payload.reconnectToken });
  const nextPlayer = joined(registry, 'next-player', '1234', 'mouse');

  assert.equal(original.readyState, 3);
  assert.equal(registry.rooms.has('1234'), true);
  assert.equal(nextPlayer.packets('JOIN_ACK').at(-1)?.payload.members.length, 2);
  assert.equal(reconnected.packets('PLAYER_LEFT').length, 0);
});

test('forwards validated gameplay only within the started room', () => {
  let now = 0;
  const registry = new RoomRegistry({ now: () => now });
  const sender = joined(registry, 'sender');
  const sameRoom = joined(registry, 'same-room');
  const otherRoom = joined(registry, 'other-room', '9999');
  registry.handlePacket(sender, packet('ROOM_START_REQUEST'));
  now = 3000;
  const cases = [
    ['SYNC_ROOM_STATE', { remainingTime: 550 }, { remainingTime: 550, paused: false }],
    ['PLAYER_MOVE', { latitude: 23.16, longitude: 108.19, score: 3 }, { id: 'sender', name: 'Player sender', team: 'cat', latitude: 23.16, longitude: 108.19, score: 3, stealthActive: false, disguiseActive: false, decoyPosition: null }],
    ['USE_SKILL', { skillId: 'cat_radar' }, { skillId: 'cat_radar', playerId: 'sender', playerName: 'Player sender' }],
    ['GAME_PAUSE', { paused: false }, { paused: false }],
    ['GAME_EXTEND', { seconds: 300 }, { seconds: 300 }],
    ['RECONNECT', {}, {}]
  ];
  for (const [type, payload, expected] of cases) {
    sameRoom.clear(); otherRoom.clear();
    registry.handlePacket(sender, packet(type, payload, 'spoofed-id'));
    assert.deepEqual(sameRoom.packets(type)[0]?.payload, expected);
    assert.equal(sameRoom.packets(type)[0]?.senderId, 'sender');
    assert.equal(otherRoom.packets(type).length, 0);
  }
});

test('broadcasts a valid nearby map-item pickup once to the started room', () => {
  let now = 0;
  const registry = new RoomRegistry({ now: () => now });
  const picker = joined(registry, 'picker');
  const teammate = joined(registry, 'teammate', '1234', 'mouse');
  const otherRoom = joined(registry, 'other-room', '9999');
  registry.handlePacket(picker, packet('ROOM_START_REQUEST'));
  now = 3000;
  const item = registry.rooms.get('1234').mapItems.items.find(i => i.type === 'CATNIP');
  registry.handlePacket(picker, packet('PLAYER_MOVE', { latitude: item.latitude, longitude: item.longitude }));
  for (const socket of [picker, teammate, otherRoom]) socket.clear();
  registry.handlePacket(picker, packet('MAP_ITEM_PICKUP', { itemId: item.id }, 'spoofed-id'));
  registry.handlePacket(picker, packet('MAP_ITEM_PICKUP', { itemId: item.id }, 'spoofed-id'));
  assert.equal(picker.packets('MAP_ITEM_PICKUP').length, 1);
  assert.equal(teammate.packets('MAP_ITEM_PICKUP').length, 1);
  assert.equal(otherRoom.packets('MAP_ITEM_PICKUP').length, 0);
  assert.deepEqual(teammate.packets('MAP_ITEM_PICKUP')[0].payload, { itemId: item.id, playerId: 'picker' });
  assert.equal(teammate.packets('MAP_ITEM_PICKUP')[0].senderId, 'picker');
});

test('rejectsWrongTeamForVoiceChannel', () => {
  const registry = new RoomRegistry();
  const mouse = joined(registry, 'mouse', '1234', 'mouse');

  registry.handlePacket(mouse, packet('VOICE_JOIN', { channel: 'cat' }));

  assert.equal(mouse.packets('VOICE_ERROR').at(-1)?.payload.code, 'TEAM_MISMATCH');
  assert.equal(mouse.packets('VOICE_ROSTER').length, 0);
});

test('updatesRosterOnJoinAndLeave', () => {
  const registry = new RoomRegistry();
  const first = joined(registry, 'first');
  const second = joined(registry, 'second');
  first.clear();
  second.clear();

  registry.handlePacket(first, packet('VOICE_JOIN', { channel: 'global' }));
  registry.handlePacket(second, packet('VOICE_JOIN', { channel: 'global' }));

  assert.equal(second.packets('VOICE_ROSTER').at(-1)?.payload.members.length, 2);
  assert.equal(first.packets('VOICE_PEER_JOINED').at(-1)?.payload.member.id, 'second');
  first.clear();
  registry.removeConnection(second);
  assert.equal(first.packets('VOICE_PEER_LEFT').at(-1)?.payload.playerId, 'second');
});

test('reportsRoomVoiceChannelCountsAndBroadcastsChanges', () => {
  const registry = new RoomRegistry();
  const globalMember = joined(registry, 'global-member');
  const catMember = joined(registry, 'cat-member', '1234', 'cat');
  const observer = joined(registry, 'observer', '1234', 'mouse');
  const otherRoom = joined(registry, 'other-room', '9999', 'cat');
  for (const socket of [globalMember, catMember, observer, otherRoom]) socket.clear();

  registry.handlePacket(observer, packet('VOICE_COUNTS_REQUEST', {}));
  assert.deepEqual(observer.packets('VOICE_COUNTS').at(-1)?.payload.counts, {
    global: 0, cat: 0, mouse: 0
  });

  registry.handlePacket(globalMember, packet('VOICE_JOIN', { channel: 'global' }));
  assert.equal(observer.packets('VOICE_COUNTS').at(-1)?.payload.counts.global, 1);
  assert.equal(otherRoom.packets('VOICE_COUNTS').length, 0);
  registry.handlePacket(catMember, packet('VOICE_JOIN', { channel: 'cat' }));
  assert.deepEqual(observer.packets('VOICE_COUNTS').at(-1)?.payload.counts, {
    global: 1, cat: 1, mouse: 0
  });
  registry.handlePacket(globalMember, packet('VOICE_LEAVE', {}));
  assert.equal(observer.packets('VOICE_COUNTS').at(-1)?.payload.counts.global, 0);
});

test('routesVoiceSignalOnlyWithinSameRoomAndChannel', () => {
  const registry = new RoomRegistry();
  const sender = joined(registry, 'sender');
  const sameChannel = joined(registry, 'same-channel');
  const otherChannel = joined(registry, 'other-channel');
  const otherRoom = joined(registry, 'other-room', '9999');
  for (const socket of [sender, sameChannel, otherChannel, otherRoom]) socket.clear();
  registry.handlePacket(sender, packet('VOICE_JOIN', { channel: 'global' }));
  registry.handlePacket(sameChannel, packet('VOICE_JOIN', { channel: 'global' }));
  registry.handlePacket(otherChannel, packet('VOICE_JOIN', { channel: 'cat' }));
  registry.handlePacket(otherRoom, packet('VOICE_JOIN', { channel: 'global' }));
  for (const socket of [sender, sameChannel, otherChannel, otherRoom]) socket.clear();

  registry.handlePacket(sender, packet('VOICE_SIGNAL', {
    targetId: 'same-channel', channel: 'global', signal: { type: 'offer', sdp: 'offer' }
  }));
  assert.equal(sameChannel.packets('VOICE_SIGNAL').length, 1);
  assert.equal(sameChannel.packets('VOICE_SIGNAL')[0].payload.fromId, 'sender');
  assert.equal(otherChannel.packets('VOICE_SIGNAL').length, 0);
  assert.equal(otherRoom.packets('VOICE_SIGNAL').length, 0);

  registry.handlePacket(sender, packet('VOICE_SIGNAL', {
    targetId: 'other-channel', channel: 'global', signal: { candidate: 'candidate' }
  }));
  registry.handlePacket(sender, packet('VOICE_SIGNAL', {
    targetId: 'other-room', channel: 'global', signal: { candidate: 'candidate' }
  }));
  assert.equal(otherChannel.packets('VOICE_SIGNAL').length, 0);
  assert.equal(otherRoom.packets('VOICE_SIGNAL').length, 0);
});

test('enforcesVoiceLimitAndCleansDisconnectedMembers', () => {
  const registry = new RoomRegistry({ maxVoiceMembers: 2 });
  const first = joined(registry, 'first');
  const second = joined(registry, 'second');
  const third = joined(registry, 'third');
  const fourth = joined(registry, 'fourth');

  for (const socket of [first, second, third, fourth]) {
    registry.handlePacket(socket, packet('VOICE_JOIN', { channel: 'global' }));
  }

  assert.equal(third.packets('VOICE_ERROR').at(-1)?.payload.code, 'CHANNEL_FULL');
  registry.removeConnection(second);
  registry.handlePacket(fourth, packet('VOICE_JOIN', { channel: 'global' }));
  assert.equal(fourth.packets('VOICE_ROSTER').at(-1)?.payload.members.length, 2);
  assert.equal(first.packets('VOICE_PEER_LEFT').some(p => p.payload.playerId === 'second'), true);
});

test('assignsFirstMemberAsHostAndReturnsWaitingPhase', () => {
  const registry = new RoomRegistry();
  const host = joined(registry, 'host');
  const guest = joined(registry, 'guest');

  const hostAck = host.packets('JOIN_ACK')[0].payload;
  const guestAck = guest.packets('JOIN_ACK')[0].payload;
  assert.equal(hostAck.phase, 'WAITING');
  assert.equal(hostAck.hostId, 'host');
  assert.equal(hostAck.isHost, true);
  assert.equal(hostAck.members.find(member => member.id === 'host').isHost, true);
  assert.equal(guestAck.phase, 'WAITING');
  assert.equal(guestAck.hostId, 'host');
  assert.equal(guestAck.isHost, false);
});

test('onlyHostCanStartAfterAnotherPlayerJoins', () => {
  let now = 1000;
  const registry = new RoomRegistry({ now: () => now });
  const host = joined(registry, 'host');
  registry.handlePacket(host, packet('ROOM_START_REQUEST'));
  assert.equal(host.packets('ROOM_START_ERROR').at(-1)?.payload.code, 'WAITING_FOR_PLAYERS');
  assert.equal(host.packets('ROOM_STARTED').length, 0);

  const guest = joined(registry, 'guest');
  host.clear();
  guest.clear();

  registry.handlePacket(guest, packet('ROOM_START_REQUEST'));
  assert.equal(guest.packets('ROOM_START_ERROR').at(-1)?.payload.code, 'NOT_HOST');
  assert.equal(host.packets('ROOM_STARTED').length, 0);

  now = 2000;
  registry.handlePacket(host, packet('ROOM_START_REQUEST'));
  assert.equal(host.packets('ROOM_STARTED').length, 1);
  assert.equal(guest.packets('ROOM_STARTED').length, 1);
  assert.equal(host.packets('ROOM_STARTED')[0].payload.phase, 'STARTED');
  assert.equal(host.packets('ROOM_STARTED')[0].payload.startAt, 5000);

  registry.handlePacket(host, packet('ROOM_START_REQUEST'));
  assert.equal(host.packets('ROOM_STARTED').length, 1, 'duplicate request cannot restart the room');
  assert.equal(host.packets('ROOM_START_ERROR').at(-1)?.payload.code, 'ALREADY_STARTED');
});

test('does not let one socket join as multiple players to satisfy room start', () => {
  const registry = new RoomRegistry();
  const host = joined(registry, 'host');

  registry.handlePacket(host, packet('JOIN_ROOM', {
    passcode: '1234',
    player: player('spoof', 'mouse'),
    gameArea: null,
    gameDurationSeconds: 600
  }));
  registry.handlePacket(host, packet('ROOM_START_REQUEST'));

  assert.equal(host.packets('JOIN_ACK').at(-1)?.payload.success, false);
  assert.equal(host.packets('ROOM_START_ERROR').at(-1)?.payload.code, 'WAITING_FOR_PLAYERS');
  assert.equal(host.packets('ROOM_STARTED').length, 0);
  assert.equal(registry.rooms.get('1234').members.size, 1);
});

test('rejectsLateJoinButAllowsKnownPlayerReconnect', () => {
  let now = 1000;
  const registry = new RoomRegistry({ now: () => now });
  const host = joined(registry, 'host');
  const guest = joined(registry, 'guest');
  registry.handlePacket(host, packet('ROOM_START_REQUEST'));

  const late = new FakeSocket();
  registry.onConnection(late);
  registry.handlePacket(late, packet('JOIN_ROOM', {
    passcode: '1234', player: player('late'), gameArea: null, gameDurationSeconds: 600
  }));
  assert.equal(late.packets('JOIN_ACK').at(-1)?.payload.success, false);
  assert.match(late.packets('JOIN_ACK').at(-1)?.payload.reason, /活动已开始/);

  const reconnectedGuest = joined(registry, 'guest', '1234', 'cat', false, { reconnectToken: guest.packets('JOIN_ACK')[0].payload.reconnectToken });
  const reconnectAck = reconnectedGuest.packets('JOIN_ACK').at(-1)?.payload;
  assert.equal(reconnectAck.success, true);
  assert.equal(reconnectAck.phase, 'STARTED');
  assert.equal(reconnectAck.hostId, 'host');
  assert.equal(guest.readyState, 3);
});

test('retains an empty started room for known reconnects, then expires it', () => {
  let now = 1000;
  const registry = new RoomRegistry({ now: () => now, startedRoomReconnectGraceMs: 5000 });
  const host = joined(registry, 'host');
  const guest = joined(registry, 'guest');
  registry.handlePacket(host, packet('ROOM_START_REQUEST'));
  const room = registry.rooms.get('1234');
  const startAt = room.startAt;

  now = 2000;
  registry.removeConnection(host);
  registry.removeConnection(guest);
  assert.equal(registry.rooms.get('1234').phase, 'STARTED');

  const reconnectedGuest = joined(registry, 'guest', '1234', 'cat', false, { reconnectToken: guest.packets('JOIN_ACK')[0].payload.reconnectToken });
  const reconnectAck = reconnectedGuest.packets('JOIN_ACK').at(-1)?.payload;
  assert.equal(reconnectAck.success, true);
  assert.equal(reconnectAck.phase, 'STARTED');
  assert.equal(reconnectAck.startAt, startAt);

  registry.removeConnection(reconnectedGuest);
  now = room.expiresAt + 1;
  const expiredJoin = joined(registry, 'late-guest');
  assert.equal(expiredJoin.packets('JOIN_ACK').at(-1)?.payload.success, false);
  assert.match(expiredJoin.packets('JOIN_ACK').at(-1)?.payload.reason, /活动已结束/);
  assert.equal(registry.rooms.has('1234'), false);

  const retry = new FakeSocket();
  registry.onConnection(retry);
  registry.handlePacket(retry, packet('JOIN_ROOM', {
    passcode: '1234', player: player('late-guest'), gameArea: null, gameDurationSeconds: 600
  }));
  assert.equal(retry.packets('JOIN_ACK').at(-1)?.payload.success, false);
});

test('promotesNextMemberWhenWaitingHostDisconnects', () => {
  const registry = new RoomRegistry();
  const host = joined(registry, 'host');
  const nextHost = joined(registry, 'next-host');
  const remaining = joined(registry, 'remaining');
  for (const socket of [host, nextHost, remaining]) socket.clear();

  registry.removeConnection(host);

  for (const socket of [nextHost, remaining]) {
    const change = socket.packets('ROOM_HOST_CHANGED').at(-1)?.payload;
    assert.equal(change.hostId, 'next-host');
    assert.equal(change.members.find(member => member.id === 'next-host').isHost, true);
  }
});

/* ---------- 服务器权威近距离自动抓捕（3 秒连续在范围内） ---------- */

const BASE_LAT = 23.1598575;
const BASE_LNG = 108.1912479;
const metersToDeg = meters => meters / 111320;

function startedCatchRoom(extra = {}) {
  let now = -3000;
  const registry = new RoomRegistry({ now: () => now });
  const cat = joined(registry, 'cat1', '1234', 'cat', true, extra);
  const mouse = joined(registry, 'mouse1', '1234', 'mouse');
  registry.handlePacket(cat, packet('ROOM_START_REQUEST'));
  now = 0;
  for (const socket of [cat, mouse]) socket.clear();
  const move = (ws, latitude, longitude) =>
    registry.handlePacket(ws, packet('PLAYER_MOVE', { latitude, longitude }));
  return { registry, cat, mouse, move, at: value => { now = value; }, now: () => now };
}

test('ignores client-sent catch events', () => {
  const { registry, cat, mouse } = startedCatchRoom();

  registry.handlePacket(cat, packet('CATCH_EVENT', { catName: 'A', mouseName: 'B', success: true }, 'spoofed-id'));

  assert.equal(cat.packets('CATCH_EVENT').length, 0);
  assert.equal(mouse.packets('CATCH_EVENT').length, 0);
});

test('does not evaluate catches before the room starts', () => {
  let now = 0;
  const registry = new RoomRegistry({ now: () => now });
  const cat = joined(registry, 'cat1');
  const mouse = joined(registry, 'mouse1', '1234', 'mouse');
  for (const socket of [cat, mouse]) socket.clear();
  const move = (ws, latitude, longitude) =>
    registry.handlePacket(ws, packet('PLAYER_MOVE', { latitude, longitude }));

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  now = 10_000;
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);

  assert.equal(cat.packets('CATCH_EVENT').length, 0);
  assert.equal(mouse.packets('CATCH_EVENT').length, 0);
});

test('auto-catches after three continuous seconds within range', () => {
  const { cat, mouse, move, at } = startedCatchRoom();

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 窗口在 t=0 打开
  at(2999);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 2999ms 尚不足 3 秒
  assert.equal(cat.packets('CATCH_EVENT').length, 0);
  assert.equal(mouse.packets('CATCH_EVENT').length, 0);

  at(3000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 满 3 秒 → 自动抓捕
  const events = cat.packets('CATCH_EVENT');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, {
    success: true,
    catId: 'cat1',
    catName: 'Player cat1',
    mouseId: 'mouse1',
    mouseName: 'Player mouse1'
  });
  assert.equal(events[0].senderId, 'server');
  assert.equal(mouse.packets('CATCH_EVENT').length, 1);
  assert.deepEqual(mouse.packets('CATCH_EVENT')[0].payload, events[0].payload);
});

test('resets the catch window when the pair leaves range', () => {
  const { cat, mouse, move, at } = startedCatchRoom();

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 窗口 t=0
  at(2000);
  move(cat, BASE_LAT + metersToDeg(100), BASE_LNG); // 离开范围 → 窗口清零
  at(4000);
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 重新进入，窗口 t=4000
  at(6999);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 0, '重新接近后需要重新累计 3 秒');
  at(7000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 1);
});

test('stale positions do not trigger a catch', () => {
  const { cat, mouse, move, at } = startedCatchRoom();

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  at(10_000); // 双方位置均已超过 5 秒过期
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);

  assert.equal(cat.packets('CATCH_EVENT').length, 0);
  assert.equal(mouse.packets('CATCH_EVENT').length, 0);
});

test('golden shield absorbs one proximity catch and is consumed', () => {
  const { registry, cat, mouse, move, at } = startedCatchRoom();

  registry.handlePacket(mouse, packet('USE_SKILL', { skillId: 'golden_shield', playerName: 'Player mouse1' }));
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  at(3000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);

  const blocked = cat.packets('CATCH_EVENT');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.blocked, true);
  assert.equal(blocked[0].payload.catId, 'cat1');
  assert.equal(blocked[0].payload.mouseId, 'mouse1');
  assert.equal(mouse.packets('CATCH_EVENT')[0].payload.blocked, true);

  // 护盾已消耗：冷却期后的第二次相遇应被正常抓捕
  at(13_000);
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  at(16_000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);

  const events = cat.packets('CATCH_EVENT');
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.blocked, undefined);
  assert.equal(events[1].payload.success, true);
});

test('pair cooldown prevents an immediate recatch', () => {
  const { cat, mouse, move, at } = startedCatchRoom();

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  at(3000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 1);

  at(12_000); // 仍在 10 秒冷却内
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 1);
  at(13_000);
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 冷却结束，重新累计 3 秒
  at(16_000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 2);
});

test('cat radar skill extends the catch radius to 25 meters', () => {
  const { registry, cat, mouse, move, at } = startedCatchRoom();

  // 20 米：基础 10 米范围外
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);
  at(3000);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 0, '未开雷达时 20 米不会触发抓捕');

  registry.handlePacket(cat, packet('USE_SKILL', { skillId: 'cat_radar', playerName: 'Player cat1' }));
  at(4000);
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG); // 雷达生效，窗口 t=4000
  at(6999);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 0);
  at(7000);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 1);
});

test('radar radius expires after its duration', () => {
  const { registry, cat, mouse, move, at } = startedCatchRoom();

  registry.handlePacket(cat, packet('USE_SKILL', { skillId: 'cat_radar', playerName: 'Player cat1' }));
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);
  at(12_000); // 雷达 10 秒已过期，20 米超出基础 10 米范围
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);

  assert.equal(cat.packets('CATCH_EVENT').length, 0);
});

test('ignores radar skill from a mouse player', () => {
  const { registry, cat, mouse, move, at } = startedCatchRoom();

  registry.handlePacket(mouse, packet('USE_SKILL', { skillId: 'cat_radar', playerName: 'Player mouse1' }));
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);
  at(12_000);
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(20), BASE_LNG);

  assert.equal(cat.packets('CATCH_EVENT').length, 0);
});

/* ---------- 两种抓捕判定方式共存：即时 / 3 秒持续 ---------- */

test('instant mode resolves the catch on the first in-range move', () => {
  const { cat, mouse, move } = startedCatchRoom({ catchMode: 'instant' });

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 一进入范围立即判定

  const events = cat.packets('CATCH_EVENT');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.success, true);
  assert.equal(mouse.packets('CATCH_EVENT').length, 1);
});

test('instant mode pair cooldown prevents an immediate recatch', () => {
  const { cat, mouse, move, at } = startedCatchRoom({ catchMode: 'instant' });

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  at(1000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 1, '冷却期内不重复抓捕');
  at(10_000);
  move(mouse, BASE_LAT, BASE_LNG); // 刷新位置，避免 5 秒过期
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 2);
});

test('instant mode golden shield blocks the first encounter and is consumed', () => {
  const { registry, cat, mouse, move, at } = startedCatchRoom({ catchMode: 'instant' });

  registry.handlePacket(mouse, packet('USE_SKILL', { skillId: 'golden_shield', playerName: 'Player mouse1' }));
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);

  const events = cat.packets('CATCH_EVENT');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.blocked, true);
  at(11_000); // 护盾已消耗，10 秒冷却也结束
  move(mouse, BASE_LAT, BASE_LNG); // 刷新位置，避免 5 秒过期
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG); // 立即再捕
  assert.equal(cat.packets('CATCH_EVENT').length, 2);
  assert.equal(cat.packets('CATCH_EVENT')[1].payload.success, true);
});

test('room stores the creator catchMode and exposes it in JOIN_ACK', () => {
  const registry = new RoomRegistry();
  const host = joined(registry, 'host', '4321', 'cat', true, { catchMode: 'instant' });
  assert.equal(host.packets('JOIN_ACK').at(-1).payload.catchMode, 'instant');
  const guest = joined(registry, 'guest', '4321', 'mouse', false, { catchMode: 'sustained' });
  assert.equal(guest.packets('JOIN_ACK').at(-1).payload.catchMode, 'instant', '成员设置不覆盖房主');
});

test('invalid catchMode falls back to the sustained three-second window', () => {
  const registry = new RoomRegistry();
  const host = joined(registry, 'host', '4322', 'cat', true, { catchMode: 'bogus' });
  assert.equal(host.packets('JOIN_ACK').at(-1).payload.catchMode, 'sustained');

  const { cat, mouse, move, at } = startedCatchRoom({ catchMode: 'bogus' });
  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  at(2999);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 0, '非法设置回退 3 秒持续判定');
  at(3000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  assert.equal(cat.packets('CATCH_EVENT').length, 1);
});

test('rejects out-of-range coordinates without evaluating catches', () => {
  const { registry, cat, mouse, move, at } = startedCatchRoom();
  const room = registry.rooms.get('1234');

  registry.handlePacket(cat, packet('PLAYER_MOVE', { latitude: 999, longitude: 181 }));
  assert.equal(room.playerPositions.has('cat1'), false, '非法坐标不入库');

  move(mouse, BASE_LAT, BASE_LNG);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);
  at(4000);
  move(cat, BASE_LAT + metersToDeg(5), BASE_LNG);

  assert.equal(cat.packets('CATCH_EVENT').length, 1, '合法位置仍正常累计抓捕');
});
