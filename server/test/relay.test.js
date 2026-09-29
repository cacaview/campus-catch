import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createRelayServer } from '../relay.js';

async function startRelay(options = {}) {
  const relay = createRelayServer({ host: '127.0.0.1', port: 0, publicIp: '203.0.113.5', ...options });
  await relay.listen();
  const port = relay.httpServer.address().port;
  return { ...relay, baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

test('healthEndpointReportsOk', async t => {
  const relay = await startRelay();
  t.after(() => relay.close());

  const response = await fetch(`${relay.baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('iceConfigRequiresTurnSecret', async t => {
  const relay = await startRelay({ turnSecret: '' });
  t.after(() => relay.close());

  const response = await fetch(`${relay.baseUrl}/api/ice-config`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'TURN configuration unavailable' });
});

test('rejectsMalformedAndOversizedPackets', async t => {
  const relay = await startRelay({ maxPayloadBytes: 64 });
  t.after(() => relay.close());

  const malformed = new WebSocket(relay.wsUrl);
  await new Promise((resolve, reject) => {
    malformed.once('open', resolve);
    malformed.once('error', reject);
  });
  const malformedClose = new Promise(resolve => malformed.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  malformed.send('{');
  assert.equal((await malformedClose).code, 1007);

  const oversized = new WebSocket(relay.wsUrl);
  await new Promise((resolve, reject) => {
    oversized.once('open', resolve);
    oversized.once('error', reject);
  });
  const oversizedClose = new Promise(resolve => oversized.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  oversized.send('x'.repeat(128));
  assert.equal((await oversizedClose).code, 1009);
});
