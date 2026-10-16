import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession, roomSession } from '../js/utils/network/room-session.js';

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
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
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

test('private reconnect token is retained for the same destination and never sent to a different relay', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const player = { id: 'host', name: 'Host', team: 'cat' };
  roomSession.createRoom(player, '4321');
  const nm = new NM();
  try {
    await nm.connectServer('wss://example.test', player, '4321');
    FakeWebSocket.instances[0].onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: {
      success: true, reconnectToken: 'private-own-token', members: [player]
    } }) });
    assert.equal(roomSession.reconnectToken, 'private-own-token');
    assert.ok(roomSession.members.every(member => !('reconnectToken' in member)));
    await nm.connectServer('wss://example.test', player, '4321');
    assert.equal(JSON.parse(FakeWebSocket.instances[1].sent[0]).payload.reconnectToken, 'private-own-token');
    await nm.connectServer('wss://other.test', player, '4321');
    assert.equal(JSON.parse(FakeWebSocket.instances[2].sent[0]).payload.reconnectToken, undefined);
    roomSession.reset();
    assert.equal(roomSession.reconnectToken, '');
  } finally { nm.disconnect(); }
});

test('disconnect settles a pending connect and clears its timeout', async () => {
  const { default: Adapter } = await import('../js/utils/network/websocket-adapter.js');
  FakeWebSocket.nextBehavior = 'pending';
  const adapter = new Adapter();
  const outcome = adapter.connect('wss://pending.test').then(() => 'opened', () => 'cancelled');
  adapter.disconnect();
  assert.equal(adapter._connectTimeout, null);
  assert.equal(await Promise.race([outcome, sleep(30).then(() => 'unsettled')]), 'cancelled');
});

test('callbacks captured from a replaced socket cannot change the new socket state', async () => {
  const { default: Adapter } = await import('../js/utils/network/websocket-adapter.js');
  const adapter = new Adapter();
  await adapter.connect('wss://first.test');
  const old = FakeWebSocket.instances[0];
  const lateClose = old.onclose;
  const lateMessage = old.onmessage;
  let messages = 0;
  adapter.onMessageCallback = () => messages++;
  try {
    await adapter.connect('wss://second.test');
    lateClose({ code: 1006 });
    lateMessage({ data: 'stale' });
    assert.equal(adapter.isConnected, true);
    assert.equal(messages, 0);
  } finally { adapter.disconnect(); }
});

test('automatic failures stop at the configured retry limit without unhandled rejections', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const player = { id: 'host', name: 'Host', team: 'cat' };
  roomSession.createRoom(player, '4321');
  const nm = new NM();
  nm.maxReconnectAttempts = 2;
  try {
    await nm.connectServer('wss://example.test', player, '4321');
    FakeWebSocket.nextBehavior = 'error';
    FakeWebSocket.instances[0].onclose({ code: 1006 });
    await sleep(3300);
    assert.equal(FakeWebSocket.instances.length, 3);
    assert.equal(nm.reconnectAttempts, 2);
    assert.equal(nm.state, 'DISCONNECTED');
    assert.equal(nm.reconnectTimer, null);
  } finally { nm.disconnect(); }
});

test('opening a retry socket preserves retry count until JOIN_ACK', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const nm = new NM();
  try {
    await nm.connectServer('wss://example.test', { id: 'a', name: 'A', team: 'cat' }, '1234');
    nm.reconnectAttempts = 3;
    nm.triggerAutoReconnect();
    assert.equal(nm.reconnectAttempts, 4);
    clearTimeout(nm.reconnectTimer);
    nm.reconnectTimer = null;
    await nm.connectServer('wss://example.test', { id: 'a', name: 'A', team: 'cat' }, '1234', null, 600, { reconnect: true });
    assert.equal(nm.reconnectAttempts, 4);
    FakeWebSocket.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: { success: true } }) });
    assert.equal(nm.reconnectAttempts, 0);
  } finally { nm.disconnect(); }
});

test('malformed incoming packets are ignored before room consumers', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const nm = new NM();
  for (const packet of [null, [], { type: 'JOIN_ACK', payload: null }, { type: 'JOIN_ACK', payload: [] }]) {
    assert.doesNotThrow(() => nm.handleIncomingMessage(JSON.stringify(packet)));
  }
});

test('queued reconnect is cancelled when disconnecting or switching the target', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const nm = new NM();
  const player = { id: 'a', name: 'A', team: 'cat' };
  try {
    await nm.connectServer('wss://first.test', player, '1234');
    nm.triggerAutoReconnect();
    nm.disconnect();
    await sleep(1100);
    assert.equal(FakeWebSocket.instances.length, 1);
    await nm.connectServer('wss://first.test', player, '1234');
    nm.triggerAutoReconnect();
    await nm.connectServer('wss://second.test', player, '5678');
    await sleep(1100);
    assert.equal(FakeWebSocket.instances.length, 3);
    assert.equal(FakeWebSocket.instances.at(-1).url, 'wss://second.test');
    assert.equal(nm.state, 'CONNECTED');
  } finally { nm.disconnect(); }
});

test('RoomSession clears a private token when creating a fresh room', () => {
  roomSession.applyJoinAck({ reconnectToken: 'old-private-token' });
  roomSession.createRoom({ id: 'a', name: 'A', team: 'cat' }, '5678');
  assert.equal(roomSession.reconnectToken, '');
});

test('JOIN_ACK adopts the authoritative self profile and pause state', () => {
  const session = new RoomSession();
  session.myPlayer = { id: 'self', name: 'Stale', team: 'cat', score: 2 };
  session.applyJoinAck({ members: [
    { id: 'self', name: 'Original', team: 'mouse', score: 24 },
    { id: 'other', name: 'Other', team: 'cat', score: 0 }
  ], paused: true });
  assert.equal(session.myPlayer.name, 'Original');
  assert.equal(session.myPlayer.team, 'mouse');
  assert.equal(session.myPlayer.score, 24);
  assert.equal(session.paused, true);
});

test('Protocol rejects nonobject packets and payloads rather than passing malformed data to consumers', async () => {
  const { Protocol } = await import('../js/utils/network/protocol.js');
  for (const packet of [null, [], 7, { type: 'JOIN_ACK', payload: null },
    { type: 'JOIN_ACK', payload: [] }, { type: 'JOIN_ACK', payload: 'x' }, { type: [], payload: {} }]) {
    assert.equal(Protocol.decode(JSON.stringify(packet)), null);
  }
});

test('Protocol ignores nonstring transport input without invoking object coercion', async () => {
  const { Protocol } = await import('../js/utils/network/protocol.js');
  let coerced = false;
  assert.equal(Protocol.decode({ toString() { coerced = true; return '{"type":"JOIN_ACK","payload":{}}'; } }), null);
  assert.equal(coerced, false);
});

test('automatic reconnect uses room configuration accepted by JOIN_ACK', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const nm = new NM();
  const player = { id: 'guest', name: 'Guest', team: 'mouse' };
  const gameArea = { type: 'polygon', points: [{ latitude: 3, longitude: 4 }] };
  try {
    await nm.connectServer('wss://example.test', player, '4321', null, 600);
    FakeWebSocket.instances[0].onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: {
      success: true, reconnectToken: 'own-private-token', gameArea, gameDurationSeconds: 1200, catchMode: 'instant'
    } }) });
    nm.triggerAutoReconnect();
    await sleep(1100);
    const join = JSON.parse(FakeWebSocket.instances.at(-1).sent[0]);
    assert.deepEqual(join.payload.gameArea, gameArea);
    assert.equal(join.payload.gameDurationSeconds, 1200);
    assert.equal(join.payload.catchMode, 'instant');
    assert.equal(join.payload.reconnectToken, 'own-private-token');
  } finally { nm.disconnect(); }
});


test('page reload restores only the exact relay room and player private token', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const player = { id: 'stable-player', name: 'A', team: 'cat' };
  const first = new NM();
  await first.connectServer('wss://example.test/ws', player, '4321');
  FakeWebSocket.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: {
    success: true, reconnectToken: 'reload-private-token', members: [player]
  } }) });
  // Browser unload tears down transport and JS memory without an intentional leave.
  first.stopHeartbeat();
  first.wsAdapter.disconnect();
  Object.assign(roomSession, new RoomSession());
  const reloaded = new NM();
  try {
    await reloaded.connectServer('wss://example.test/ws', player, '4321');
    assert.equal(JSON.parse(FakeWebSocket.instances.at(-1).sent[0]).payload.reconnectToken, 'reload-private-token');
    assert.ok(roomSession.members.every(member => !('reconnectToken' in member)));
    await reloaded.connectServer('wss://example.test/ws', { ...player, id: 'different' }, '4321');
    assert.equal(JSON.parse(FakeWebSocket.instances.at(-1).sent[0]).payload.reconnectToken, undefined);
  } finally { reloaded.disconnect(); }
});

test('intentional disconnect clears persisted reconnect authority', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const player = { id: 'stable-player', name: 'A', team: 'cat' };
  const first = new NM();
  await first.connectServer('wss://example.test/ws', player, '4321');
  FakeWebSocket.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: {
    success: true, reconnectToken: 'leave-private-token'
  } }) });
  first.disconnect();
  assert.equal(roomSession.reconnectToken, '');
  Object.assign(roomSession, new RoomSession());
  const next = new NM();
  try {
    await next.connectServer('wss://example.test/ws', player, '4321');
    assert.equal(JSON.parse(FakeWebSocket.instances.at(-1).sent[0]).payload.reconnectToken, undefined);
  } finally { next.disconnect(); }
});

test('replaced and kicked close codes terminate pending retries and private authority', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  for (const code of [4001, 4003]) {
    const nm = new NM();
    try {
      await nm.connectServer('wss://example.test/ws', { id: 'a', name: 'A', team: 'cat' }, '4321');
      FakeWebSocket.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: {
        success: true, reconnectToken: 'terminal-private-token'
      } }) });
      nm.triggerAutoReconnect();
      FakeWebSocket.instances.at(-1).onclose({ code });
      assert.equal(nm.state, 'DISCONNECTED');
      assert.equal(nm.mode, 'OFFLINE');
      assert.equal(nm.reconnectTimer, null);
      assert.equal(roomSession.reconnectToken, '');
    } finally { nm.disconnect(); }
  }
});

test('explicit leave clears private reconnect authority before a new page joins', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const nm = new NM();
  try {
    await nm.connectServer('wss://example.test/ws', { id: 'a', name: 'A', team: 'cat' }, '4321');
    FakeWebSocket.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: {
      success: true, reconnectToken: 'leaving-private-token'
    } }) });
    assert.equal(nm.send('LEAVE_ROOM'), true);
    assert.equal(roomSession.reconnectToken, '');
    assert.equal(sessionStorage.getItem('campusCatch.privateReconnect'), null);
  } finally { nm.disconnect(); }
});

test('RoomSession reset and fresh room creation remove the persisted scope', () => {
  const scope = JSON.stringify(['wss://example.test/ws', '4321', 'a']);
  for (const action of ['reset', 'create']) {
    roomSession.restoreReconnectToken(scope);
    roomSession.applyJoinAck({ reconnectToken: 'private-own-token' });
    assert.ok(sessionStorage.getItem('campusCatch.privateReconnect'));
    if (action === 'reset') roomSession.reset();
    else roomSession.createRoom({ id: 'a' }, '4321');
    assert.equal(sessionStorage.getItem('campusCatch.privateReconnect'), null);
    assert.equal(new RoomSession().restoreReconnectToken(scope), '');
  }
});

test('unavailable sessionStorage leaves in-memory reconnect usable', async () => {
  const { default: NM } = await import('../js/utils/network/network-manager.js');
  const storage = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  const nm = new NM();
  try {
    const player = { id: 'a', name: 'A', team: 'cat' };
    await nm.connectServer('wss://example.test/ws', player, '4321');
    FakeWebSocket.instances.at(-1).onmessage({ data: JSON.stringify({ type: 'JOIN_ACK', payload: {
      success: true, reconnectToken: 'memory-private-token'
    } }) });
    await nm.connectServer('wss://example.test/ws', player, '4321');
    assert.equal(JSON.parse(FakeWebSocket.instances.at(-1).sent[0]).payload.reconnectToken, 'memory-private-token');
    assert.doesNotThrow(() => nm.disconnect());
  } finally {
    nm.disconnect();
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: storage });
  }
});
