import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import GameArea from '../js/utils/game-area.js';

const read = name => readFileSync(new URL(`../js/views/${name}.js`, import.meta.url), 'utf8');
const payload = '<img src=x onerror=alert(1)>';
function harness(name, extra = {}) {
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', hidden: false, value: '', style: {}, classList: { toggle() {}, contains() { return false; } }, addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; }, replaceChildren() {}, appendChild() {}, append() {}, getContext() { return null; } });
  const root = element();
  root.querySelector = key => { if (key === '#result-share-canvas') return null; if (!elements.has(key)) elements.set(key, element()); return elements.get(key); };
  const listeners = new Map(), intervals = new Map(), locations = [], sent = [], storage = new Map();
  let timer = 0, watches = 0;
  const currentPlayer = { id: 'me', name: 'Me', team: 'cat' };
  const state = { currentPlayer, netMode: 'SERVER', gameDurationSeconds: 600, gameArea: { points: [] } };
  const roomSession = { phase: 'STARTED', startAt: 0, myPlayer: currentPlayer, members: [currentPlayer, { id: 'other', name: 'Canonical', team: 'mouse' }], isHost: false, paused: false, pickedMapItemIds: [] };
  let markers = [];
  const map = { setPolygon() {}, fitBounds() {}, setMarkers(next) { markers = next; }, destroy() {}, setPolylines() {} };
  const context = vm.createContext({ console: { log() {}, warn() {} }, Date, Math, Set, Map, WeakSet, Number, String, URL, location: { origin: 'https://example.test', pathname: '/', href: 'https://example.test/' },
    document: { getElementById: id => root.querySelector('#' + id), createElement: element },
    navigate() {}, DEFAULT_CENTER: { latitude: 1, longitude: 2 }, showToast() {}, showModal: () => Promise.resolve({}), showActionSheet: () => Promise.resolve({}),
    getStorage: key => storage.get(key), setStorage: (key, value) => storage.set(key, value),
    setTimeout: () => ++timer, clearTimeout() {}, setInterval: callback => { const id = ++timer; intervals.set(id, callback); return id; }, clearInterval: id => intervals.delete(id),
    getLocation: callbacks => locations.push(callbacks), startLocationUpdate: () => { watches++; return true; }, stopLocationUpdate() {},
    createMap: () => map, roomSession,
    networkManager: { state: 'CONNECTED', on: (type, handler) => listeners.set(type, handler), off: type => listeners.delete(type), send: (type, body) => { sent.push({ type, body }); return true; }, disconnect() {} },
    MSG_TYPES: new Proxy({}, { get: (_, key) => key }), VoiceManager: class { snapshot = { state: 'IDLE', channel: null, muted: false, members: [] }; channelCounts = {}; on() {} off() {} refreshChannelCounts() {} destroy() {} },
    GameArea: { isValidArea: () => true, contains: () => true, center: () => ({ latitude: 1, longitude: 2 }) },
    SkillSystem: { getSkillsForTeam: () => [], isSkillAvailable: () => true },
    ITEM_TYPES: {}, MapItemsManager: { spawnItems() {}, getMapMarkers: () => [], removeItemById() {}, findItemPickup() {} },
    soundVibration: { playSound() {}, vibrateShort() {} }, achievementManager: { getEquippedTitleObj: () => ({ icon: '', name: '' }), updateProgress() {}, recordCatch() {} }, shopManager: { getOwned: () => 0 },
    ...extra
  });
  let source = read(name).replace(/^import .*;\n/gm, '').replace('export function create', 'function create');
  if (name === 'game') source = source.replace('return { onShow, onHide };', 'return { onShow, onHide, s, renderFeed, renderRankModal, renderMarkers, onShowRank, startGame, startLocationWatch, startSimulatedMovement, resumeGame, setPaused, gameTick, ai: () => aiPlayers };');
  if (name === 'result') source = source.replace('return { onShow, onHide };', 'return { onShow, onHide, s, playerItemHtml, saveToHistory };');
  vm.runInContext(source + '\nglobalThis.makeView = create;', context);
  const view = context.makeView(root, state);
  return { view, state, roomSession, elements, listeners, intervals, locations, sent, storage, watches: () => watches, markers: () => markers };
}

test('feed and live rank render participant markup as literal text', () => {
  const h = harness('game');
  h.view.s.battleFeed = [{ text: payload }];
  h.view.renderFeed();
  assert.doesNotMatch(h.elements.get('#game-feed').innerHTML, /<img/);
  assert.match(h.elements.get('#game-feed').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  h.view.s.showRankModal = true;
  h.view.s.liveRank = [{ name: payload, score: payload }];
  h.view.renderRankModal();
  assert.doesNotMatch(h.elements.get('#game-rank-list').innerHTML, /<img/);
  assert.match(h.elements.get('#game-rank-list').innerHTML, /&lt;img/);
});

test('result scores and persisted history reject executable score strings', () => {
  const h = harness('result');
  assert.doesNotMatch(h.view.playerItemHtml({ name: 'Name', score: payload }), /<img/);
  h.view.saveToHistory({ players: [{ id: 'other', name: 'Name', team: 'mouse', score: payload }] });
  assert.equal(h.storage.get('gameHistory')[0].players[0].score, 0);
});

test('history scores normalize malicious legacy values and clamp finite numbers', () => {
  const h = harness('rank');
  h.storage.set('gameHistory', [{ players: [
    { id: 'u_a', name: 'A', team: 'mouse', score: payload },
    { id: 'u_b', name: 'B', team: 'cat', score: 2e6 }
  ] }]);
  h.view.onShow();
  const html = h.elements.get('#rank-list').innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /1000000/);
});

test('remote movement uses roster identities and resets stale players on entry', () => {
  const h = harness('game');
  h.view.onShow();
  h.listeners.get('PLAYER_MOVE')({ id: 'other', name: payload, team: 'cat', score: payload, latitude: 1, longitude: 2 });
  assert.equal(h.view.ai()[0].name, 'Canonical');
  assert.equal(h.view.ai()[0].team, 'mouse');
  assert.equal(h.view.ai()[0].score, 0);
  h.listeners.get('PLAYER_MOVE')({ id: 'unknown', score: 2, latitude: 1, longitude: 2 });
  assert.equal(h.view.ai().length, 1);
  h.view.onHide();
  h.roomSession.members = [h.state.currentPlayer];
  h.view.onShow();
  assert.equal(h.view.ai().length, 0);
});

test('roster departure and reconnect refresh remote players and request timer sync', () => {
  const h = harness('game'); h.view.onShow();
  h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 4, latitude: 1, longitude: 2 });
  h.roomSession.members = [h.state.currentPlayer];
  h.listeners.get('PLAYER_LEFT')?.({ playerId: 'other' });
  assert.equal(h.view.ai().length, 0);
  const before = h.sent.length;
  h.listeners.get('joinSuccess')();
  assert.ok(h.sent.slice(before).some(p => p.type === 'RECONNECT'));
});

test('reconnect adopts the server roster profile before scoring and rendering', () => {
  const h = harness('game');
  h.roomSession.myPlayer = { id: 'me', name: 'Original Mouse', team: 'mouse', score: 18 };
  h.roomSession.members = [h.roomSession.myPlayer, h.roomSession.members[1]];
  h.view.onShow();
  h.listeners.get('joinSuccess')();
  assert.equal(h.state.currentPlayer.team, 'mouse');
  assert.equal(h.state.currentPlayer.name, 'Original Mouse');
  assert.equal(h.view.s.myTeam, 'mouse');
  assert.equal(h.view.s.myName, 'Original Mouse');
  assert.equal(h.view.s.myScore, 18);
});

test('reconnecting into a paused room freezes countdown and resumes from host sync', () => {
  const h = harness('game');
  h.roomSession.paused = true;
  h.view.onShow();
  assert.equal(h.view.s.gamePhase, 'PAUSED');
  assert.equal(h.view.s.isPaused, true);
  assert.equal(h.elements.get('#game-pause').hidden, false);
  assert.equal(h.elements.get('#game-countdown').hidden, true);

  h.listeners.get('SYNC_ROOM_STATE')({ remainingTime: 90, paused: false });
  assert.equal(h.view.s.gamePhase, 'PLAYING');
  assert.equal(h.view.s.isPaused, false);
  assert.equal(h.view.s.remainingTime, 90);
  assert.ok(h.locations.length > 0, 'resume must initialize location before normal play');
});

test('join acknowledgement applies pause state before the host sync arrives', () => {
  const h = harness('game'); h.view.onShow();
  h.roomSession.paused = true;
  h.listeners.get('joinSuccess')();
  assert.equal(h.view.s.gamePhase, 'PAUSED');
  assert.equal(h.view.s.isPaused, true);
  assert.equal(h.elements.get('#game-pause').hidden, false);
  assert.equal(h.intervals.size, 0, 'the countdown must stop while the room is paused');
});

test('host resuming a freshly restored paused round notifies the relay', () => {
  const h = harness('game');
  h.roomSession.isHost = true;
  h.roomSession.paused = true;
  h.view.onShow();
  h.sent.length = 0;
  h.view.resumeGame();
  assert.ok(h.sent.some(packet => packet.type === 'GAME_PAUSE' && packet.body.paused === false));
});

test('automatic reconnect preserves consumed skills and active round resources', () => {
  const h = harness('game'); h.view.onShow();
  h.view.s.gamePhase = 'PLAYING';
  h.view.s.skills = [{ id: 'stealth', usesLeft: 0 }];
  h.view.s.isStealthActive = true;
  h.roomSession.myPlayer = { id: 'me', name: 'Me', team: 'cat', score: 4 };
  h.listeners.get('joinSuccess')();
  assert.deepEqual(h.view.s.skills.map(skill => skill.usesLeft), [0]);
  assert.equal(h.view.s.isStealthActive, true);
});

test('online passive ticks never increase remote participant scores', () => {
  const h = harness('game'); h.view.onShow();
  h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 4, latitude: 1, longitude: 2 });
  h.view.s.gamePhase = 'PLAYING';
  for (let i = 0; i < 20; i++) h.view.gameTick();
  assert.equal(h.view.ai()[0].score, 4);
});

test('a completed result is saved once across repeated visits', () => {
  const h = harness('result');
  h.state.lastGameResult = { players: [{ id: 'me', name: 'Me', team: 'cat', score: 4 }], winner: 'cat', duration: 60 };
  h.view.onShow(); h.view.onHide(); h.view.onShow();
  assert.equal(h.storage.get('gameHistory').length, 1);
});

test('late geolocation callbacks cannot restart a hidden view', () => {
  const h = harness('game'); h.view.onShow(); h.view.startGame();
  const pending = h.locations[0];
  h.view.onHide(); pending.success({ latitude: 1, longitude: 2 });
  assert.equal(h.watches(), 0);
  assert.equal(h.intervals.size, 0);
});

test('simulated movement has one timer and pauses distance while paused', () => {
  const h = harness('game'); h.view.onShow();
  h.view.startSimulatedMovement(); h.view.startSimulatedMovement();
  const simTimers = [...h.intervals.values()];
  // onShow also owns one countdown timer.
  assert.equal(simTimers.length, 2);
  h.view.s.gamePhase = 'PAUSED'; h.view.s.isPaused = true;
  const before = h.view.s.distance;
  for (const callback of simTimers.slice(1)) callback();
  assert.equal(h.view.s.distance, before);
});

test('online item pickup publishes fresh position before requesting the item', () => {
  const h = harness('game', { MapItemsManager: { spawnItems() {}, getMapMarkers: () => [], removeItemById() {}, findItemPickup: () => ({ id: 2001 }) } });
  h.view.onShow(); h.sent.length = 0; h.view.s.gamePhase = 'PLAYING';
  h.view.gameTick();
  assert.deepEqual(h.sent.map(packet => packet.type), ['PLAYER_MOVE', 'MAP_ITEM_PICKUP']);
});

test('offline catch uses geographic longitude distance at high latitude', () => {
  const h = harness('game', {
    GameArea: { isValidArea: () => true, contains: () => true, center: () => ({ latitude: 60, longitude: 0 }), distanceMeters: GameArea.distanceMeters },
    MapItemsManager: { spawnItems() {}, getMapMarkers: () => [], removeItemById() {}, checkItemPickup() {} },
    AIPlayerController: { updateAI: player => player }
  });
  h.state.netMode = 'OFFLINE'; h.state.aiFillCount = 0;
  h.view.onShow(); h.view.s.gamePhase = 'PLAYING'; h.view.s.catchMode = 'instant';
  h.view.ai().push({ id: 101, name: 'Mouse', team: 'mouse', latitude: 60, longitude: 0.0001, score: 0 });
  h.view.gameTick();
  assert.equal(h.view.s.myScore, 10);
});

test('duplicate watch requests produce one real location subscription', () => {
  const h = harness('game'); h.view.onShow(); h.view.startGame();
  h.locations[0].success({ latitude: 1, longitude: 2 });
  h.view.startLocationWatch(); h.view.startLocationWatch();
  assert.equal(h.watches(), 1);
});

test('paused simulation cannot move position or grant distance achievements', () => {
  let progress = 0;
  const h = harness('game', { Math: Object.assign(Object.create(Math), { random: () => 0.9 }), achievementManager: { getEquippedTitleObj: () => ({}), updateProgress: () => progress++ } });
  h.view.onShow(); h.view.startSimulatedMovement(); h.view.s.gamePhase = 'PAUSED'; h.view.s.isPaused = true;
  const lat = h.view.s.latitude;
  [...h.intervals.values()].at(-1)();
  assert.equal(h.view.s.latitude, lat);
  assert.equal(h.view.s.distance, 0);
  assert.equal(progress, 0);
});

test('host promotion updates gameplay authority immediately', () => {
  const h = harness('game'); h.view.onShow();
  h.roomSession.isHost = true;
  h.listeners.get('ROOM_HOST_CHANGED')();
  assert.equal(h.view.s.isHost, true);
});


test('score rendering accepts only finite bounded numeric values', () => {
  const h = harness('result');
  for (const [value, expected] of [[-3, 0], [0, 0], [12.5, 12.5], [2e6, 1e6], [Infinity, 0], [NaN, 0], ['7', 0], [null, 0], [{ toString: {} }, 0]]) {
    const html = h.view.playerItemHtml({ name: 'N', score: value });
    assert.ok(html.includes(`<span class="p-score">${expected} 分</span>`));
  }
});


test('enemy stealth hides its marker until scan highlights it, while ally remains visible', () => {
  const h = harness('game'); h.view.onShow();
  h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 0, latitude: 1, longitude: 2, stealthActive: true });
  assert.equal(h.markers().some(marker => marker.id === 'player_other'), false);
  h.view.s.scanUntil = Date.now() + 10000; h.view.renderMarkers();
  assert.equal(h.markers().find(marker => marker.id === 'player_other').highlight, true);
  h.view.s.scanUntil = 0; h.roomSession.members[1].team = 'cat';
  h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 0, latitude: 1, longitude: 2, stealthActive: true });
  assert.equal(h.markers().find(marker => marker.id === 'player_other').icon, '🐱');
});

test('enemy disguise changes displayed icon and supplied decoy produces a separate marker', () => {
  const h = harness('game'); h.view.onShow();
  h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 0, latitude: 1, longitude: 2, disguiseActive: true, decoyPosition: { latitude: 1.001, longitude: 2.001 } });
  assert.equal(h.markers().find(marker => marker.id === 'player_other').icon, '🐱');
  const decoy = h.markers().find(marker => marker.id === 'player_decoy_other');
  assert.equal(decoy.latitude, 1.001); assert.equal(decoy.longitude, 2.001);
  assert.equal(decoy.label, 'Canonical');
  h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 0, latitude: 1, longitude: 2, disguiseActive: false, decoyPosition: null });
  assert.equal(h.markers().find(marker => marker.id === 'player_other').icon, '🐭');
  assert.equal(h.markers().some(marker => marker.id === 'player_decoy_other'), false);
});

test('allies retain their true team icon when disguised', () => {
  const h = harness('game'); h.state.currentPlayer.team = 'mouse'; h.view.onShow();
  h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 0, latitude: 1, longitude: 2, disguiseActive: true });
  assert.equal(h.markers().find(marker => marker.id === 'player_other').icon, '🐭');
});

test('remote effect flags require booleans and decoys require finite geographic coordinates', () => {
  const h = harness('game'); h.view.onShow();
  for (const decoyPosition of [{ latitude: '1', longitude: 2 }, { latitude: 91, longitude: 2 }, { latitude: 1, longitude: Infinity }, { latitude: 1, longitude: 181 }, []]) {
    h.listeners.get('PLAYER_MOVE')({ id: 'other', score: 0, latitude: 1, longitude: 2, stealthActive: 'true', disguiseActive: 1, decoyPosition });
    const remote = h.view.ai()[0];
    assert.equal(remote.stealthActive, false); assert.equal(remote.disguiseActive, false); assert.equal(remote.decoyPosition, null);
    assert.equal(h.markers().find(marker => marker.id === 'player_other').icon, '🐭');
    assert.equal(h.markers().some(marker => marker.id === 'player_decoy_other'), false);
  }
});

test('skill supply consumes at most ten bonus packs and leaves remaining stock', () => {
  let stock = 50;
  const h = harness('game', {
    shopManager: { getOwned: id => id === 'extra_skill' ? stock : 0, consume: id => { if (id === 'extra_skill') stock--; } },
    SkillSystem: { getSkillsForTeam: () => [{ id: 'cat_radar', name: 'Radar', maxUses: 2, usesLeft: 2 }], isSkillAvailable: () => true }
  });
  h.view.onShow();
  assert.equal(stock, 40);
  assert.equal(h.view.s.skills[0].usesLeft, 12);
  assert.equal(h.view.s.skills[0].maxUses, 2);
});
