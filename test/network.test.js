import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { roomSession } from '../js/utils/network/room-session.js';

// 假 WebSocket（注入全局），记录实例与已发送消息
class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.nextBehavior === 'open') {
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen && this.onopen({});
      });
    } else if (FakeWebSocket.nextBehavior === 'error') {
      queueMicrotask(() => {
        this.onerror && this.onerror(new Error('boom'));
        this.onclose && this.onclose({ code: 1006 });
      });
    }
  }
  send(data) { this.sent.push(data); }
  close() {
    this.closed = true;
    this.onclose && this.onclose({ code: 1000 });
  }
}
FakeWebSocket.nextBehavior = 'open';

beforeEach(() => {
  roomSession.reset();
  FakeWebSocket.instances = [];
  FakeWebSocket.nextBehavior = 'open';
  globalThis.WebSocket = FakeWebSocket;
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('connectServer: resolves on open, state CONNECTED, heartbeat PING within 4s', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const nm = new NM();
  nm.on('stateChange', s => { nm._lastState = s; });
  await nm.connectServer('wss://example.test', { id: 'u_1', name: 'A', team: 'cat' }, '8888', null, 600);
  assert.equal(nm.state, 'CONNECTED');
  assert.equal(nm.mode, 'SERVER');
  assert.ok(FakeWebSocket.instances[0].sent.some(m => JSON.parse(m).type === 'JOIN_ROOM'));
  await sleep(3500);
  assert.ok(FakeWebSocket.instances[0].sent.some(m => JSON.parse(m).type === 'PING'), 'expected PING heartbeat');
  nm.disconnect();
});

test('connectServer marks room creation explicitly and joins do not create absent rooms', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const host = new NM();
  await host.connectServer('wss://example.test', { id: 'host', name: 'Host', team: 'cat' }, '1234', null, 600, {
    createIfMissingRoom: true
  });
  const createPacket = JSON.parse(FakeWebSocket.instances[0].sent.at(-1));
  assert.equal(createPacket.type, 'JOIN_ROOM');
  assert.equal(createPacket.payload.createIfMissingRoom, true);
  host.disconnect();

  const guest = new NM();
  await guest.connectServer('wss://example.test', { id: 'guest', name: 'Guest', team: 'mouse' }, '1234');
  const joinPacket = JSON.parse(FakeWebSocket.instances[1].sent.at(-1));
  assert.equal(joinPacket.payload.createIfMissingRoom, false);
  guest.disconnect();
});

test('connectServer: rejects on socket error', async () => {
  FakeWebSocket.nextBehavior = 'error';
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const nm = new NM();
  await assert.rejects(() => nm.connectServer('wss://bad.test', { id: 'u_1', name: 'A', team: 'cat' }));
  assert.equal(nm.state, 'DISCONNECTED');
  nm.disconnect(); // 停止自动重连链（否则事件循环要等 ~31s 退避结束）
});

test('PING in → PONG out; JOIN_ACK success → joinSuccess event', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const { Protocol, MSG_TYPES } = await import('../js/utils/network/protocol.js');
  const nm = new NM();
  let joined = null;
  nm.on('joinSuccess', p => { joined = p; });
  await nm.connectServer('wss://example.test', { id: 'u_1', name: 'A', team: 'cat' }, '8888');
  const ws = FakeWebSocket.instances[0];
  // 模拟收到 PING
  ws.onmessage({ data: Protocol.encode(MSG_TYPES.PING, { time: 1 }, 'host') });
  assert.ok(ws.sent.some(m => JSON.parse(m).type === 'PONG'), 'PONG sent');
  // 模拟 JOIN_ACK
  ws.onmessage({ data: Protocol.encode(MSG_TYPES.JOIN_ACK, { success: true, roomId: 'R1' }, 'host') });
  assert.ok(joined && joined.success === true);
  nm.disconnect();
});

test('send() in OFFLINE mode returns false and does not throw', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const nm = new NM();
  assert.equal(nm.send('PLAYER_MOVE', { id: 'x' }), false);
});

test('disconnect stops heartbeat and resets state', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const nm = new NM();
  await nm.connectServer('wss://example.test', { id: 'u_1', name: 'A', team: 'cat' }, '8888');
  const before = FakeWebSocket.instances[0].sent.filter(m => JSON.parse(m).type === 'PING').length;
  nm.disconnect();
  assert.equal(nm.state, 'DISCONNECTED');
  assert.equal(nm.mode, 'OFFLINE');
  await sleep(3500);
  const after = FakeWebSocket.instances[0].sent.filter(m => JSON.parse(m).type === 'PING').length;
  assert.ok(after - before <= 1, 'no new PING after disconnect (allow 1 in-flight)');
});

test('JOIN_ACK replaces guessed host state with authoritative room lifecycle', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const { Protocol, MSG_TYPES } = await import('../js/utils/network/protocol.js');
  roomSession.createRoom({ id: 'guest', name: 'Guest', team: 'mouse' }, '1234');
  const nm = new NM();
  let observed = null;
  nm.on('joinSuccess', () => {
    observed = {
      isHost: roomSession.isHost,
      hostId: roomSession.hostId,
      phase: roomSession.phase,
      memberCount: roomSession.members.length
    };
  });
  await nm.connectServer('wss://example.test', { id: 'guest', name: 'Guest', team: 'mouse' }, '1234');
  const ws = FakeWebSocket.instances[0];

  ws.onmessage({ data: Protocol.encode(MSG_TYPES.JOIN_ACK, {
    success: true,
    roomId: 'ROOM_1234',
    hostId: 'host',
    isHost: false,
    phase: 'WAITING',
    startAt: null,
    members: [
      { id: 'host', name: 'Host', team: 'cat', isHost: true },
      { id: 'guest', name: 'Guest', team: 'mouse', isHost: false }
    ]
  }) });

  assert.deepEqual(observed, { isHost: false, hostId: 'host', phase: 'WAITING', memberCount: 2 });
  nm.disconnect();
});

test('room lifecycle packets update live members and phase before emitting events', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const { Protocol, MSG_TYPES } = await import('../js/utils/network/protocol.js');
  const nm = new NM();
  roomSession.myPlayer = { id: 'host', name: 'Host', team: 'cat' };
  await nm.connectServer('wss://example.test', roomSession.myPlayer, '1234');
  const ws = FakeWebSocket.instances[0];
  ws.onmessage({ data: Protocol.encode('JOIN_ACK', {
    success: true, roomId: 'ROOM_1234', hostId: 'host', isHost: true, phase: 'WAITING',
    members: [{ id: 'host', name: 'Host', team: 'cat', isHost: true }]
  }) });
  let joinedCount = null;
  let leftCount = null;
  let promotedHost = null;
  let startedState = null;
  nm.on('PLAYER_JOINED', () => { joinedCount = roomSession.members.length; });
  nm.on('PLAYER_LEFT', () => { leftCount = roomSession.members.length; });
  nm.on(MSG_TYPES.ROOM_HOST_CHANGED, () => { promotedHost = [roomSession.hostId, roomSession.isHost]; });
  nm.on(MSG_TYPES.ROOM_STARTED, () => { startedState = [roomSession.phase, roomSession.startAt]; });

  ws.onmessage({ data: Protocol.encode('PLAYER_JOINED', {
    player: { id: 'guest', name: 'Guest', team: 'mouse', isHost: false }
  }) });
  ws.onmessage({ data: Protocol.encode('PLAYER_LEFT', { playerId: 'guest' }) });
  ws.onmessage({ data: Protocol.encode(MSG_TYPES.ROOM_HOST_CHANGED, {
    hostId: 'replacement',
    members: [{ id: 'host', name: 'Host', team: 'cat', isHost: false },
      { id: 'replacement', name: 'Replacement', team: 'mouse', isHost: true }]
  }) });
  const receivedAt = Date.now();
  const serverTimestamp = receivedAt - 500;
  ws.onmessage({ data: JSON.stringify({
    type: MSG_TYPES.ROOM_STARTED,
    timestamp: serverTimestamp,
    payload: { phase: 'STARTED', startAt: serverTimestamp + 3000 }
  }) });

  assert.equal(joinedCount, 2);
  assert.equal(leftCount, 1);
  assert.deepEqual(promotedHost, ['replacement', false]);
  assert.equal(startedState[0], 'STARTED');
  assert.ok(startedState[1] >= receivedAt + 2990 && startedState[1] <= receivedAt + 3020);
  assert.equal(roomSession.members[0].isHost, false);
  nm.disconnect();
});

test('room start request protocol constant is sendable', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const { MSG_TYPES } = await import('../js/utils/network/protocol.js');
  const nm = new NM();
  await nm.connectServer('wss://example.test', { id: 'host', name: 'Host', team: 'cat' }, '1234');

  assert.equal(MSG_TYPES.ROOM_START_REQUEST, 'ROOM_START_REQUEST');
  assert.equal(nm.send(MSG_TYPES.ROOM_START_REQUEST, {}), true);
  assert.equal(JSON.parse(FakeWebSocket.instances[0].sent.at(-1)).type, 'ROOM_START_REQUEST');
  nm.disconnect();
});

test('automatic reconnect reuses the current room code and game configuration', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js?n=' + Date.now());
  const player = { id: 'host', name: 'Host', team: 'cat' };
  const gameArea = { type: 'polygon', points: [{ latitude: 1, longitude: 2 }] };
  roomSession.createRoom(player, '4321', gameArea, 1200);
  const nm = new NM();
  await nm.connectServer('wss://example.test', player, '4321', gameArea, 1200);

  nm.triggerAutoReconnect();
  await sleep(1100);

  assert.equal(FakeWebSocket.instances.length, 2);
  const reconnectJoin = FakeWebSocket.instances[1].sent
    .map(raw => JSON.parse(raw))
    .find(message => message.type === 'JOIN_ROOM');
  assert.equal(reconnectJoin.payload.passcode, '4321');
  assert.deepEqual(reconnectJoin.payload.gameArea, gameArea);
  assert.equal(reconnectJoin.payload.gameDurationSeconds, 1200);
  nm.disconnect();
});
