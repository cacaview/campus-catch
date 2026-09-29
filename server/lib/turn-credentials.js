import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export function createIceConfig({ publicIp, sharedSecret, nowMs = Date.now(), ttlSeconds = 3600 } = {}) {
  if (typeof sharedSecret !== 'string' || sharedSecret.length === 0) {
    throw new Error('TURN secret is required');
  }
  if (typeof publicIp !== 'string' || !isIP(publicIp)) {
    throw new Error('A valid public IP is required');
  }
  const ttl = Math.floor(Number(ttlSeconds));
  if (!Number.isFinite(ttl) || ttl < 1) throw new Error('TURN credential lifetime must be positive');

  const expiresAt = Math.floor(Number(nowMs) / 1000) + ttl;
  const username = `${expiresAt}:campus-catch`;
  const credential = createHmac('sha1', sharedSecret).update(username).digest('base64');

  return {
    iceServers: [
      { urls: `stun:${publicIp}:3478` },
      {
        urls: [
          `turn:${publicIp}:3478?transport=udp`,
          `turn:${publicIp}:3478?transport=tcp`
        ],
        username,
        credential
      }
    ],
    expiresAt
  };
}

export default createIceConfig;
