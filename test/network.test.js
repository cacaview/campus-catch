import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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
