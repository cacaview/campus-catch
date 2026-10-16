import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRelayServer } from '../relay.js';

async function client(url) {
  const ws = new WebSocket(url); const inbox = [];
  ws.on('message', raw => inbox.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, inbox, send(type, payload = {}) { ws.send(JSON.stringify({ type, payload })); },
    async take(type) {
      for (let i = 0; i < 100; i++) {
        const index = inbox.findIndex(p => p.type === type);
        if (index >= 0) return inbox.splice(index, 1)[0].payload;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${type}`);
    }
  };
}

test('real sockets support create/start/catch/private reconnect/pause/end', async t => {
  let now = 1000;
  const relay = createRelayServer({ port: 0, now: () => now });
  await relay.listen(); t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.httpServer.address().port}/ws`;
  const host = await client(url), mouse = await client(url);
  const hostPlayer = { id: 'host', name: '猫', team: 'cat' }, mousePlayer = { id: 'mouse', name: '鼠', team: 'mouse' };
  host.send('JOIN_ROOM', { passcode: '1234', player: hostPlayer, createIfMissingRoom: true, catchMode: 'instant' });
  const hostAck = await host.take('JOIN_ACK');
  mouse.send('JOIN_ROOM', { passcode: '1234', player: mousePlayer });
  const mouseAck = await mouse.take('JOIN_ACK');
  assert.ok(hostAck.reconnectToken && mouseAck.reconnectToken);
  assert.ok(!JSON.stringify(mouseAck).includes(hostAck.reconnectToken));
  host.send('ROOM_START_REQUEST'); await host.take('ROOM_STARTED'); await mouse.take('ROOM_STARTED');
  now = 4000;
  mouse.send('PLAYER_MOVE', { id: 'fake', name: '<img>', latitude: 23.15985, longitude: 108.19124, score: '<img>' });
  const movement = await host.take('PLAYER_MOVE');
  assert.equal(movement.id, 'mouse'); assert.equal(movement.name, '鼠'); assert.equal(movement.score, 0);
  host.send('PLAYER_MOVE', { latitude: 23.15985, longitude: 108.19124, score: 0 });
  const caught = await host.take('CATCH_EVENT');
  assert.equal(caught.catId, 'host'); assert.equal(caught.mouseId, 'mouse');
  await mouse.take('CATCH_EVENT');
  mouse.send('GAME_PAUSE', { paused: true }); mouse.send('PING'); await mouse.take('PONG');
  assert.equal(host.inbox.filter(p => p.type === 'GAME_PAUSE').length, 0);
  host.send('GAME_PAUSE', { paused: true }); assert.equal((await mouse.take('GAME_PAUSE')).paused, true);
  const impostor = await client(url); impostor.send('JOIN_ROOM', { passcode: '1234', player: hostPlayer });
  assert.equal((await impostor.take('JOIN_ACK')).success, false); impostor.ws.close();
  const resumed = await client(url);
  resumed.send('JOIN_ROOM', { passcode: '1234', player: hostPlayer, reconnectToken: hostAck.reconnectToken });
  const resumedAck = await resumed.take('JOIN_ACK');
  assert.equal(resumedAck.isHost, true);
  assert.equal(resumedAck.paused, true);
  resumed.send('GAME_PAUSE', { paused: false }); assert.equal((await mouse.take('GAME_PAUSE')).paused, false);
  resumed.send('GAME_END'); await mouse.take('GAME_END');
  resumed.send('PING'); await resumed.take('PONG');
  resumed.ws.close(); mouse.ws.close();
});
