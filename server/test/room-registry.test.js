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

  packets(type) {
    return this.sent.filter(packet => packet.type === type);
  }

  clear() {
    this.sent.length = 0;
  }
}

const player = (id, team = 'cat') => ({ id, name: `Player ${id}`, team });
const packet = (type, payload = {}, senderId = '') => ({ type, senderId, timestamp: 1, payload });

function joined(registry, id, passcode = '1234', team = 'cat') {
  const socket = new FakeSocket();
  registry.onConnection(socket);
  registry.handlePacket(socket, packet('JOIN_ROOM', {
    passcode,
    player: player(id, team),
    gameArea: null,
    gameDurationSeconds: 600
  }, id));
  return socket;
}

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

test('forwardsExistingGameplayPacketsWithinRoom', () => {
  const registry = new RoomRegistry();
  const sender = joined(registry, 'sender');
  const sameRoom = joined(registry, 'same-room');
  const otherRoom = joined(registry, 'other-room', '9999');
  const gameplayTypes = [
    'SYNC_ROOM_STATE', 'PLAYER_MOVE', 'USE_SKILL', 'CATCH_EVENT', 'GAME_PAUSE',
    'GAME_EXTEND', 'PLAYER_KICK', 'RECONNECT', 'RECONNECT_ACK', 'MAP_ITEM_PICKUP'
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
