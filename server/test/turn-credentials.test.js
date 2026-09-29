import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createIceConfig } from '../lib/turn-credentials.js';

const publicIp = '106.53.199.187';

test('credentialsExpireAfterConfiguredLifetime', () => {
  const config = createIceConfig({ publicIp, sharedSecret: 'test-secret', nowMs: 1_700_000_000_000, ttlSeconds: 3600 });
  assert.equal(config.expiresAt, 1_700_003_600);
  assert.equal(config.iceServers[1].username, `${config.expiresAt}:campus-catch`);
});

test('iceConfigContainsPublicStunAndTurnUrls', () => {
  const { iceServers } = createIceConfig({ publicIp, sharedSecret: 'test-secret', nowMs: 1_700_000_000_000 });
  assert.deepEqual(iceServers[0], { urls: `stun:${publicIp}:3478` });
  assert.deepEqual(iceServers[1].urls, [
    `turn:${publicIp}:3478?transport=udp`,
    `turn:${publicIp}:3478?transport=tcp`
  ]);
  assert.equal(typeof iceServers[1].username, 'string');
  assert.equal(typeof iceServers[1].credential, 'string');
});

test('generatesCoturnHmacSha1CredentialDeterministically', () => {
  const sharedSecret = 'known-secret';
  const config = createIceConfig({ publicIp, sharedSecret, nowMs: 1_700_000_000_000, ttlSeconds: 600 });
  const turnServer = config.iceServers[1];
  const expected = createHmac('sha1', sharedSecret).update(turnServer.username).digest('base64');
  assert.equal(turnServer.credential, expected);
});

test('requiresTurnSecretAndValidPublicIp', () => {
  assert.throws(() => createIceConfig({ publicIp, sharedSecret: '', nowMs: 1_700_000_000_000 }), /TURN secret/);
  assert.throws(() => createIceConfig({ publicIp: 'not-an-ip', sharedSecret: 'test-secret' }), /public IP/);
});
