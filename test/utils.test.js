import { test } from 'node:test';
import assert from 'node:assert/strict';
import GameArea from '../js/utils/game-area.js';
import AIPlayerController from '../js/utils/ai-player.js';
import SkillSystem from '../js/utils/skill-system.js';
import { MapItemsManager, ITEM_TYPES } from '../js/utils/map-items.js';
import { getStablePlayerId } from '../js/utils/player-identity.js';
import { setStorageBackend } from '../js/platform/storage.js';
import { MSG_TYPES, Protocol } from '../js/utils/network/protocol.js';
import RoomSession from '../js/utils/network/room-session.js';

const mem = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};

// ---- game-area ----
test('distanceMeters: 1 degree latitude ≈ 111km', () => {
  const d = GameArea.distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
  assert.ok(Math.abs(d - 111195) < 300, `got ${d}`);
});
test('distanceMeters: same point = 0', () => {
  assert.equal(GameArea.distanceMeters({ latitude: 1, longitude: 1 }, { latitude: 1, longitude: 1 }), 0);
});
test('contains: square point-in-polygon', () => {
  const area = {
    type: 'polygon',
    points: [
      { latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 },
      { latitude: 1, longitude: 1 }, { latitude: 1, longitude: 0 }]
  };
  assert.equal(GameArea.contains(area, { latitude: 0.5, longitude: 0.5 }), true);
  assert.equal(GameArea.contains(area, { latitude: 2, longitude: 0.5 }), false);
});
test('isValidArea rejects < 3 points and non-polygon', () => {
  assert.equal(GameArea.isValidArea(null), false);
  assert.equal(GameArea.isValidArea({ type: 'polygon', points: [{ latitude: 0, longitude: 0 }] }), false);
});
test('center = average of points', () => {
  const area = {
    type: 'polygon',
    points: [
      { latitude: 0, longitude: 0 }, { latitude: 2, longitude: 0 }]
  };
  assert.equal(GameArea.isValidArea(area), false); // 2 点无效
  const area3 = {
    type: 'polygon',
    points: [
      { latitude: 0, longitude: 0 }, { latitude: 2, longitude: 0 }, { latitude: 2, longitude: 2 }]
  };
  const c = GameArea.center(area3);
  assert.ok(Math.abs(c.latitude - 4 / 3) < 1e-9 && Math.abs(c.longitude - 2 / 3) < 1e-9);
});
test('orderBoundaryPoints: shuffled rectangle becomes non-crossing cycle', () => {
  const shuffled = [
    { latitude: 1, longitude: 1 }, { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 }, { latitude: 1, longitude: 0 }];
  const ordered = GameArea.orderBoundaryPoints(shuffled);
  // 每条边只跨越一条轴 → 无交叉：相邻两点应恰好一维相同（矩形）
  for (let i = 0; i < 4; i++) {
    const a = ordered[i], b = ordered[(i + 1) % 4];
    assert.ok(Math.abs(a.latitude - b.latitude) < 1e-9 || Math.abs(a.longitude - b.longitude) < 1e-9,
      `edge ${i} crosses: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
});

// ---- ai-player ----
test('cat AI moves toward nearby mouse', () => {
  const ai = { id: 1, name: 'c', team: 'cat', latitude: 0, longitude: 0, score: 0 };
  const mouse = { id: 2, name: 'm', team: 'mouse', latitude: 0.0005, longitude: 0, score: 0 };
  const r = AIPlayerController.updateAI(ai, [ai, mouse]);
  assert.ok(r.latitude > ai.latitude, `expected move up, got ${r.latitude}`);
});
test('mouse AI flees nearby cat', () => {
  const ai = { id: 1, name: 'm', team: 'mouse', latitude: 0, longitude: 0, score: 0 };
  const cat = { id: 2, name: 'c', team: 'cat', latitude: -0.0002, longitude: 0, score: 0 };
  const r = AIPlayerController.updateAI(ai, [ai, cat]);
  assert.ok(r.latitude > ai.latitude, `expected flee up, got ${r.latitude}`);
});
test('AI wanders when no target in range (small step)', () => {
  const ai = { id: 1, name: 'm', team: 'mouse', latitude: 0, longitude: 0, score: 0 };
  const farCat = { id: 2, name: 'c', team: 'cat', latitude: 1, longitude: 1, score: 0 };
  const r = AIPlayerController.updateAI(ai, [ai, farCat]);
  assert.ok(Math.abs(r.latitude) < 0.0001 && Math.abs(r.longitude) < 0.0001);
  assert.ok(r.chat === null || typeof r.chat === 'string');
});

// ---- skill-system ----
test('getSkillsForTeam: cat 1 skill, mouse 5 skills, usesLeft = maxUses', () => {
  const cat = SkillSystem.getSkillsForTeam('cat');
  const mouse = SkillSystem.getSkillsForTeam('mouse');
  assert.equal(cat.length, 1);
  assert.equal(cat[0].id, 'cat_radar');
  assert.equal(mouse.length, 5);
  for (const s of [...cat, ...mouse]) assert.equal(s.usesLeft, s.maxUses);
});
test('isSkillAvailable: depleted / cooldown / ok', () => {
  const s = { usesLeft: 0, isOnCooldown: false };
  assert.equal(SkillSystem.isSkillAvailable(s), false);
  s.usesLeft = 1;
  s.isOnCooldown = true;
  assert.equal(SkillSystem.isSkillAvailable(s), false);
  s.isOnCooldown = false;
  assert.equal(SkillSystem.isSkillAvailable(s), true);
});

// ---- map-items ----
test('spawnItems: count, location near center, unique numeric ids', () => {
  MapItemsManager.items = [];
  const center = { latitude: 25.2, longitude: 110.3 };
  const items = MapItemsManager.spawnItems(center, 8);
  assert.equal(items.length, 8);
  const ids = new Set(items.map(i => i.id));
  assert.equal(ids.size, 8);
  for (const i of items) {
    assert.equal(typeof i.id, 'number');
    assert.ok(Math.abs(i.latitude - center.latitude) < 0.002);
    assert.ok(Math.abs(i.longitude - center.longitude) < 0.002);
  }
});
test('checkItemPickup: mouse picks cheese at same spot, item removed', () => {
  MapItemsManager.items = [{ id: 1, type: ITEM_TYPES.CHEESE, latitude: 10, longitude: 20, icon: '🧀', name: 'x' }];
  const got = MapItemsManager.checkItemPickup({ latitude: 10.00005, longitude: 20.00005 }, false);
  assert.equal(got.type, ITEM_TYPES.CHEESE);
  assert.equal(MapItemsManager.items.length, 0);
});
test('checkItemPickup: team gating — cat cannot pick cheese, mouse cannot pick catnip', () => {
  MapItemsManager.items = [{ id: 1, type: ITEM_TYPES.CHEESE, latitude: 10, longitude: 20, icon: '🧀', name: 'x' },
                           { id: 2, type: ITEM_TYPES.CATNIP, latitude: 30, longitude: 40, icon: '🌿', name: 'y' }];
  assert.equal(MapItemsManager.checkItemPickup({ latitude: 10, longitude: 20 }, true), null);   // cat vs cheese
  assert.equal(MapItemsManager.checkItemPickup({ latitude: 30, longitude: 40 }, false), null); // mouse vs catnip
  const nip = MapItemsManager.checkItemPickup({ latitude: 30, longitude: 40 }, true);
  assert.equal(nip.type, ITEM_TYPES.CATNIP);
});

// ---- player-identity ----
test('getStablePlayerId: stable across calls, u_ prefix', () => {
  setStorageBackend(mem());
  const a = getStablePlayerId();
  const b = getStablePlayerId();
  assert.ok(a.startsWith('u_'));
  assert.equal(a, b);
});

// ---- protocol ----
test('encode/decode round-trip', () => {
  const raw = Protocol.encode(MSG_TYPES.PLAYER_MOVE, { id: 'u_1', score: 5 }, 'u_1');
  const p = Protocol.decode(raw);
  assert.equal(p.type, 'PLAYER_MOVE');
  assert.equal(p.senderId, 'u_1');
  assert.equal(p.payload.score, 5);
  assert.ok(typeof p.timestamp === 'number');
});
test('decode of garbage returns null', () => {
  assert.equal(Protocol.decode('not json'), null);
});
test('generatePasscode: 4-digit string', () => {
  const c = Protocol.generatePasscode();
  assert.match(c, /^[1-9]\d{3}$/);
});
test('formatAddress: adds default port, strips scheme', () => {
  assert.equal(Protocol.formatAddress('192.168.1.5'), '192.168.1.5:8080');
  assert.equal(Protocol.formatAddress('https://x.io/game/'), 'x.io/game:8080');
  assert.equal(Protocol.formatAddress('x.io:9000'), 'x.io:9000');
});

// ---- room-session ----
test('createRoom sets host state; validatePasscode trims; addMember dedups', () => {
  const rs = new RoomSession();
  rs.createRoom({ id: 'u_1', name: 'A', team: 'cat' }, '8888', null, 600);
  assert.equal(rs.isHost, true);
  assert.equal(rs.members.length, 1);
  assert.equal(rs.validatePasscode(' 8888 '), true);
  assert.equal(rs.validatePasscode('0000'), false);
  rs.addMember({ id: 'u_2', name: 'B', team: 'mouse' });
  rs.addMember({ id: 'u_2', name: 'B2', team: 'mouse' });
  assert.equal(rs.members.length, 2);
  assert.equal(rs.members[1].name, 'B2');
  rs.removeMember('u_2');
  assert.equal(rs.members.length, 1);
  rs.reset();
  assert.equal(rs.isHost, false);
  assert.equal(rs.members.length, 0);
});
