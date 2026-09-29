import assert from 'node:assert/strict';
import test from 'node:test';
import { MSG_TYPES } from '../js/utils/network/protocol.js';
import { VoiceManager } from '../js/utils/voice-manager.js';

class FakeTrack {
  constructor() {
    this.kind = 'audio';
    this.enabled = true;
    this.stopCount = 0;
  }
  stop() { this.stopCount++; }
}

class FakeStream {
  constructor(tracks = [new FakeTrack()]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
}

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.tracks = [];
    this.closed = false;
    this.offerCount = 0;
    this.answerCount = 0;
    this.remoteDescriptions = [];
    this.localDescriptions = [];
    this.iceCandidates = [];
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }
  addTrack(track, stream) { this.tracks.push({ track, stream }); }
  async createOffer() { this.offerCount++; return { type: 'offer', sdp: 'local-offer' }; }
  async createAnswer() { this.answerCount++; return { type: 'answer', sdp: 'local-answer' }; }
  async setLocalDescription(description) { this.localDescription = description; this.localDescriptions.push(description); }
  async setRemoteDescription(description) { this.remoteDescription = description; this.remoteDescriptions.push(description); }
  async addIceCandidate(candidate) { this.iceCandidates.push(candidate); }
  close() { this.closed = true; }
}

class FakeNetworkManager {
  constructor() {
    this.state = 'CONNECTED';
    this.mode = 'SERVER';
    this.listeners = new Map();
    this.sent = [];
  }
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
  }
  off(event, handler) { this.listeners.get(event)?.delete(handler); }
  emit(event, payload) { for (const handler of this.listeners.get(event) || []) handler(payload); }
  send(type, payload) { this.sent.push({ type, payload }); return true; }
}

const player = (id = 'player-a', team = 'cat') => ({ id, name: `Name ${id}`, team });
const iceConfig = { iceServers: [{ urls: 'stun:127.0.0.1:3478' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ currentPlayer = player(), getUserMedia, fetchIceConfig, state = 'CONNECTED', mode = 'SERVER' } = {}) {
  const networkManager = new FakeNetworkManager();
  networkManager.state = state;
  networkManager.mode = mode;
  const stream = new FakeStream();
  const peerConnections = [];
  const mediaDevices = { getUserMedia: getUserMedia || (async () => stream) };
  const manager = new VoiceManager({
    networkManager,
    player: currentPlayer,
    fetchIceConfig: fetchIceConfig || (async () => iceConfig),
    mediaDevices,
    createPeerConnection: config => {
      const pc = new FakePeerConnection(config);
      peerConnections.push(pc);
      return pc;
    }
  });
  return { manager, networkManager, stream, peerConnections, mediaDevices };
}

async function enterVoice(h, channel = 'global', members = [h.manager.player]) {
  const pending = h.manager.join(channel);
  await tick();
  assert.ok(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_JOIN));
  h.networkManager.emit(MSG_TYPES.VOICE_ROSTER, { channel, members });
  assert.deepEqual(await pending, { ok: true });
  await tick();
}

test('joinsAllowedChannelWithMicAndIceConfig', async () => {
  let resolveIce;
  let mediaRequested = false;
  const h = harness({
    getUserMedia: async () => { mediaRequested = true; return new FakeStream(); },
    fetchIceConfig: () => new Promise(resolve => { resolveIce = resolve; })
  });
  const pending = h.manager.join('global');
  await tick();
  assert.equal(mediaRequested, true);
  assert.equal(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_JOIN), false);
  resolveIce(iceConfig);
  await tick();
  assert.equal(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_JOIN), true);
  h.networkManager.emit(MSG_TYPES.VOICE_ROSTER, { channel: 'global', members: [h.manager.player] });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(h.manager.snapshot.state, 'IN_CALL');
  assert.equal(h.manager.snapshot.channel, 'global');
});

test('requestsAndPublishesVoiceChannelCounts', () => {
  const h = harness();
  const changes = [];
  h.manager.on('countsChange', counts => changes.push(counts));
  assert.equal(h.manager.refreshChannelCounts(), true);
  assert.equal(h.networkManager.sent.at(-1).type, MSG_TYPES.VOICE_COUNTS_REQUEST);

  h.networkManager.emit(MSG_TYPES.VOICE_COUNTS, {
    counts: { global: 4, cat: 2, mouse: 1, unknown: 90 }
  });
  assert.deepEqual(h.manager.channelCounts, { global: 4, cat: 2, mouse: 1 });
  assert.deepEqual(changes.at(-1), { global: 4, cat: 2, mouse: 1 });
  h.manager.destroy();
});

test('switchesVoiceChannelsByLeavingTheCurrentChannel', async () => {
  const streams = [];
  const h = harness({
    currentPlayer: player('mouse-player', 'mouse'),
    getUserMedia: async () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    }
  });
  await enterVoice(h, 'global');

  const switching = h.manager.join('mouse');
  await tick();
  assert.equal(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_LEAVE && message.payload.channel === 'global'), true);
  assert.equal(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_JOIN && message.payload.channel === 'mouse'), true);
  h.networkManager.emit(MSG_TYPES.VOICE_ROSTER, { channel: 'mouse', members: [h.manager.player] });
  assert.deepEqual(await switching, { ok: true });
  assert.equal(streams[0].getTracks()[0].stopCount, 1);
  assert.equal(streams[1].getTracks()[0].stopCount, 0);
  assert.equal(h.manager.snapshot.channel, 'mouse');
  await h.manager.leave();
});

test('reportsMediaFailureWithoutJoining', async () => {
  const h = harness({ getUserMedia: async () => { throw new Error('Permission denied'); } });
  const result = await h.manager.join('global');
  assert.equal(result.ok, false);
  assert.match(result.error, /Permission denied/);
  assert.equal(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_JOIN), false);
  assert.equal(h.manager.snapshot.state, 'IDLE');
});

test('rejectsTeamMismatch', async () => {
  let mediaCalls = 0;
  const h = harness({
    currentPlayer: player('mouse-player', 'mouse'),
    getUserMedia: async () => { mediaCalls++; return new FakeStream(); }
  });
  const result = await h.manager.join('cat');
  assert.equal(result.ok, false);
  assert.match(result.error, /队伍/);
  assert.equal(mediaCalls, 0);
  assert.equal(h.networkManager.sent.length, 0);
});

test('rejectsOfflineNetworking', async () => {
  const h = harness({ state: 'DISCONNECTED', mode: 'OFFLINE' });
  const result = await h.manager.join('global');
  assert.equal(result.ok, false);
  assert.match(result.error, /联机|连接/);
  assert.equal(h.networkManager.sent.length, 0);
});

test('reportsFullChannel', async () => {
  const h = harness();
  const pending = h.manager.join('global');
  await tick();
  h.networkManager.emit(MSG_TYPES.VOICE_ERROR, { channel: 'global', code: 'CHANNEL_FULL', message: '语音频道已满' });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, '语音频道已满');
  assert.equal(h.stream.getTracks()[0].stopCount, 1);
  assert.equal(h.manager.snapshot.state, 'IDLE');
});

test('muteTogglesLocalTracks', async () => {
  const h = harness();
  await enterVoice(h);
  assert.equal(h.manager.setMuted(true), true);
  assert.equal(h.stream.getAudioTracks()[0].enabled, false);
  assert.equal(h.manager.snapshot.muted, true);
  assert.equal(h.manager.setMuted(false), true);
  assert.equal(h.stream.getAudioTracks()[0].enabled, true);
});

test('onlyLowerPlayerIdCreatesOffer', async () => {
  const h = harness({ currentPlayer: player('z-player') });
  await enterVoice(h, 'global', [player('z-player'), player('a-player', 'mouse')]);
  assert.equal(h.peerConnections.length, 1);
  assert.equal(h.peerConnections[0].offerCount, 0);
  assert.equal(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_SIGNAL), false);
});

test('handlesIncomingOfferAnswerAndIce', async () => {
  const h = harness({ currentPlayer: player('z-player') });
  await enterVoice(h, 'global', [player('z-player'), player('a-player', 'mouse')]);
  const pc = h.peerConnections[0];
  h.networkManager.emit(MSG_TYPES.VOICE_SIGNAL, {
    channel: 'global', fromId: 'a-player', signal: { type: 'offer', sdp: 'remote-offer' }
  });
  await tick();
  assert.deepEqual(pc.remoteDescriptions.at(-1), { type: 'offer', sdp: 'remote-offer' });
  assert.deepEqual(pc.localDescriptions.at(-1), { type: 'answer', sdp: 'local-answer' });
  assert.ok(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_SIGNAL && message.payload.signal.type === 'answer'));

  h.networkManager.emit(MSG_TYPES.VOICE_SIGNAL, {
    channel: 'global', fromId: 'a-player', signal: { type: 'answer', sdp: 'remote-answer' }
  });
  h.networkManager.emit(MSG_TYPES.VOICE_SIGNAL, {
    channel: 'global', fromId: 'a-player', signal: { type: 'candidate', candidate: { candidate: 'candidate-1' } }
  });
  await tick();
  assert.deepEqual(pc.remoteDescriptions.at(-1), { type: 'answer', sdp: 'remote-answer' });
  assert.deepEqual(pc.iceCandidates, [{ candidate: 'candidate-1' }]);
});

test('peerLeftClosesConnection', async () => {
  const h = harness();
  await enterVoice(h, 'global', [player('player-a'), player('player-b', 'mouse')]);
  const pc = h.peerConnections[0];
  h.networkManager.emit(MSG_TYPES.VOICE_PEER_LEFT, { channel: 'global', playerId: 'player-b' });
  assert.equal(pc.closed, true);
  assert.equal(h.manager.snapshot.members.some(member => member.id === 'player-b'), false);
});

test('leaveCancelsPendingJoinAndStopsTracks', async () => {
  let resolveMedia;
  const stream = new FakeStream();
  const h = harness({ getUserMedia: () => new Promise(resolve => { resolveMedia = resolve; }) });
  const pending = h.manager.join('global');
  await tick();
  await h.manager.leave();
  resolveMedia(stream);
  assert.deepEqual(await pending, { ok: false, error: '语音加入已取消' });
  assert.equal(stream.getTracks()[0].stopCount, 1);
  assert.equal(h.networkManager.sent.some(message => message.type === MSG_TYPES.VOICE_JOIN), false);
});

test('networkDisconnectStopsTracksAndRequiresManualRejoin', async () => {
  const h = harness();
  await enterVoice(h, 'global', [player('player-a'), player('player-b', 'mouse')]);
  const pc = h.peerConnections[0];
  h.networkManager.state = 'RECONNECTING';
  h.networkManager.emit('stateChange', { state: 'RECONNECTING', mode: 'SERVER' });
  assert.equal(h.stream.getTracks()[0].stopCount, 1);
  assert.equal(pc.closed, true);
  assert.equal(h.manager.snapshot.state, 'IDLE');
  const joinCount = h.networkManager.sent.filter(message => message.type === MSG_TYPES.VOICE_JOIN).length;
  h.networkManager.state = 'CONNECTED';
  h.networkManager.emit('stateChange', { state: 'CONNECTED', mode: 'SERVER' });
  assert.equal(h.networkManager.sent.filter(message => message.type === MSG_TYPES.VOICE_JOIN).length, joinCount);
  const pending = h.manager.join('global');
  await tick();
  assert.equal(h.networkManager.sent.filter(message => message.type === MSG_TYPES.VOICE_JOIN).length, joinCount + 1);
  h.networkManager.emit(MSG_TYPES.VOICE_ROSTER, { channel: 'global', members: [h.manager.player] });
  assert.deepEqual(await pending, { ok: true });
});
