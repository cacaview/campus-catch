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

function joined(registry, id, passcode = '1234', team = 'cat', createIfMissingRoom = !registry.rooms.has(passcode)) {
  const socket = new FakeSocket();
  registry.onConnection(socket);
  registry.handlePacket(socket, packet('JOIN_ROOM', {
    passcode,
    player: player(id, team),
    gameArea: null,
    gameDurationSeconds: 600,
    createIfMissingRoom
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

  const reconnected = joined(registry, 'same-player', '1234');
  const nextPlayer = joined(registry, 'next-player', '1234', 'mouse');

  assert.equal(original.readyState, 3);
  assert.equal(registry.rooms.has('1234'), true);
  assert.equal(nextPlayer.packets('JOIN_ACK').at(-1)?.payload.members.length, 2);
  assert.equal(reconnected.packets('PLAYER_LEFT').length, 0);
});

test('forwardsExistingGameplayPacketsWithinRoom', () => {
  const registry = new RoomRegistry();
  const sender = joined(registry, 'sender');
  const sameRoom = joined(registry, 'same-room');
  const otherRoom = joined(registry, 'other-room', '9999');
  const gameplayTypes = [
    'SYNC_ROOM_STATE', 'PLAYER_MOVE', 'USE_SKILL', 'CATCH_EVENT', 'GAME_PAUSE',
    'GAME_EXTEND', 'PLAYER_KICK', 'RECONNECT', 'RECONNECT_ACK'
  ];

  for (const type of gameplayTypes) {
    sameRoom.clear();
    otherRoom.clear();
    const payload = { marker: type };
    registry.handlePacket(sender, packet(type, payload, 'spoofed-id'));
    assert.deepEqual(sameRoom.packets(type)[0]?.payload, payload, `${type} reaches same room`);
    assert.equal(otherRoom.packets(type).length, 0, `${type} stays in room`);
  }
});

test('broadcasts a map-item pickup once to the started room', () => {
  const registry = new RoomRegistry();
  const picker = joined(registry, 'picker');
  const teammate = joined(registry, 'teammate', '1234', 'mouse');
  const otherRoom = joined(registry, 'other-room', '9999');
  registry.handlePacket(picker, packet('ROOM_START_REQUEST'));
  for (const socket of [picker, teammate, otherRoom]) socket.clear();

  registry.handlePacket(picker, packet('MAP_ITEM_PICKUP', { itemId: 2001 }, 'spoofed-id'));
  registry.handlePacket(picker, packet('MAP_ITEM_PICKUP', { itemId: 2001 }, 'spoofed-id'));

  assert.equal(picker.packets('MAP_ITEM_PICKUP').length, 1);
  assert.equal(teammate.packets('MAP_ITEM_PICKUP').length, 1);
  assert.equal(otherRoom.packets('MAP_ITEM_PICKUP').length, 0);
  assert.deepEqual(teammate.packets('MAP_ITEM_PICKUP')[0].payload, {
    itemId: 2001,
    playerId: 'picker'
  });
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

  const reconnectedGuest = joined(registry, 'guest');
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

  const reconnectedGuest = joined(registry, 'guest');
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
