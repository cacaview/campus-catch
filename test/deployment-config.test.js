import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const readDeploymentFile = path => readFile(fileURLToPath(new URL(`../deploy/${path}`, import.meta.url)), 'utf8');

test('limits the public ICE credential endpoint by source IP', async () => {
  const nginx = await readDeploymentFile('nginx/game-web.conf');

  assert.match(nginx, /limit_req_zone\s+\$binary_remote_addr\s+zone=ice_config:/);
  assert.match(nginx, /location\s+=\s+\/api\/ice-config\s*\{[^}]*limit_req\s+zone=ice_config\s+burst=30\s+nodelay;/s);
  assert.match(nginx, /limit_req_status\s+429;/);
});

test('bounds Coturn allocations and per-allocation bandwidth', async () => {
  const turn = await readDeploymentFile('turnserver.conf.example');

  assert.match(turn, /^user-quota=8$/m);
  assert.match(turn, /^total-quota=64$/m);
  assert.match(turn, /^max-bps=64000$/m);
});

test('nftables deployment only replaces its own table', async () => {
  const nftables = await readDeploymentFile('nftables.conf');

  assert.doesNotMatch(nftables, /^flush ruleset$/m);
  assert.match(nftables, /^destroy table inet game_web$/m);
  assert.match(nftables, /^table inet game_web \{$/m);
  assert.doesNotMatch(nftables, /hook\s+(?:forward|output)/);
});
