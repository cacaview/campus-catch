import { MSG_TYPES } from './network/protocol.js';

const VOICE_CHANNELS = new Set(['global', 'cat', 'mouse']);
const CANCELLED = '语音加入已取消';
const JOIN_TIMEOUT_MS = 15000;

function normalizeMember(member) {
  if (!member || (typeof member.id !== 'string' && typeof member.id !== 'number')) return null;
  const id = String(member.id).trim();
  if (!id) return null;
  return {
    id,
    name: typeof member.name === 'string' ? member.name.slice(0, 64) : id,
    team: member.team === 'cat' ? 'cat' : member.team === 'mouse' ? 'mouse' : ''
  };
}

function errorMessage(error, fallback) {
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message;
  return fallback;
}

export class VoiceManager {
  constructor({ networkManager, player, fetchIceConfig, mediaDevices, createPeerConnection } = {}) {
    if (!networkManager || typeof networkManager.on !== 'function' || typeof networkManager.send !== 'function') {
      throw new TypeError('VoiceManager requires a NetworkManager');
    }
    this.networkManager = networkManager;
    const normalizedPlayer = normalizeMember(player);
    if (!normalizedPlayer) throw new TypeError('VoiceManager requires a player id');
    this.player = Object.freeze(normalizedPlayer);
    this.fetchIceConfig = fetchIceConfig || (async () => {
      const response = await fetch('/api/ice-config', { cache: 'no-store' });
      if (!response.ok) throw new Error('语音服务器配置暂不可用');
      return response.json();
    });
    this.mediaDevices = mediaDevices || globalThis.navigator?.mediaDevices;
    this.createPeerConnection = createPeerConnection || (config => new RTCPeerConnection(config));

    this._state = 'IDLE';
    this.channel = null;
    this.muted = false;
    this.members = [];
    this.stream = null;
    this.iceConfig = null;
    this.peerConnections = new Map();
    this.remoteAudio = new Map();
    this.pendingCandidates = new Map();
    this.channelCounts = { global: 0, cat: 0, mouse: 0 };
    this.listeners = new Map();
    this.joinGeneration = 0;
    this.joinWaiter = null;
    this.joinTimeout = null;
    this.destroyed = false;

    this.networkHandlers = {
      stateChange: state => this._onNetworkState(state),
      roster: packet => this._onRoster(packet),
      peerJoined: packet => this._onPeerJoined(packet),
      peerLeft: packet => this._onPeerLeft(packet),
      signal: packet => this._onSignal(packet),
      error: packet => this._onServerError(packet),
      counts: packet => this._onChannelCounts(packet)
    };
    networkManager.on('stateChange', this.networkHandlers.stateChange);
    networkManager.on(MSG_TYPES.VOICE_ROSTER, this.networkHandlers.roster);
    networkManager.on(MSG_TYPES.VOICE_PEER_JOINED, this.networkHandlers.peerJoined);
    networkManager.on(MSG_TYPES.VOICE_PEER_LEFT, this.networkHandlers.peerLeft);
    networkManager.on(MSG_TYPES.VOICE_SIGNAL, this.networkHandlers.signal);
    networkManager.on(MSG_TYPES.VOICE_ERROR, this.networkHandlers.error);
    networkManager.on(MSG_TYPES.VOICE_COUNTS, this.networkHandlers.counts);
  }

  get state() { return this._state; }

  get snapshot() {
    return {
      state: this._state,
      channel: this.channel,
      muted: this.muted,
      members: this.members.map(member => ({ ...member }))
    };
  }

  getSnapshot() { return this.snapshot; }

  refreshChannelCounts() {
    if (!this._isNetworkConnected()) return false;
    return this.networkManager.send(MSG_TYPES.VOICE_COUNTS_REQUEST, {});
  }

  on(event, handler) {
    if (typeof handler !== 'function') return;
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  _emit(event, value) {
    for (const handler of this.listeners.get(event) || []) {
      try { handler(value); } catch (error) { console.error('[VoiceManager] listener failed:', error); }
    }
  }

  _emitState() { this._emit('stateChange', this.snapshot); }
  _emitMembers() { this._emit('membersChange', this.snapshot.members); }
  _emitError(message) { this._emit('error', { message }); }

  _isNetworkConnected() {
    return this.networkManager.mode === 'SERVER' && this.networkManager.state === 'CONNECTED';
  }

  async join(channel) {
    if (this.destroyed) return { ok: false, error: '语音功能已关闭' };
    if (!VOICE_CHANNELS.has(channel)) return { ok: false, error: '语音频道无效' };
    if ((channel === 'cat' || channel === 'mouse') && this.player.team !== channel) {
      return { ok: false, error: '只能加入自己队伍的语音频道' };
    }
    if (!this._isNetworkConnected()) return { ok: false, error: '请先连接联机房间' };
    if (this._state === 'IN_CALL' && this.channel === channel) return { ok: true };
    if (this._state === 'JOINING') return { ok: false, error: '正在加入语音，请稍候' };
    if (this._state === 'IN_CALL') await this.leave();

    const generation = ++this.joinGeneration;
    this.channel = channel;
    this.muted = false;
    this._state = 'JOINING';
    this._emitState();

    let stream;
    try {
      if (!this.mediaDevices || typeof this.mediaDevices.getUserMedia !== 'function') {
        throw new Error('当前浏览器不支持麦克风');
      }
      stream = await this.mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== this.joinGeneration) {
        this._stopStream(stream);
        return { ok: false, error: CANCELLED };
      }
      if (!stream || typeof stream.getAudioTracks !== 'function' || stream.getAudioTracks().length === 0) {
        throw new Error('未找到可用麦克风');
      }

      const iceConfig = await this.fetchIceConfig();
      if (generation !== this.joinGeneration) {
        this._stopStream(stream);
        return { ok: false, error: CANCELLED };
      }
      if (!iceConfig || !Array.isArray(iceConfig.iceServers) || iceConfig.iceServers.length === 0) {
        throw new Error('语音服务器配置无效');
      }
      if (!this._isNetworkConnected()) throw new Error('联机已断开，请重新连接后加入语音');

      this.stream = stream;
      this.iceConfig = iceConfig;
      const result = new Promise(resolve => {
        this.joinWaiter = { generation, channel, resolve, requestSent: true };
      });
      this.joinTimeout = setTimeout(() => {
        if (this.joinWaiter?.generation === generation) this._failJoin(generation, '语音连接超时，请重试');
      }, JOIN_TIMEOUT_MS);
      const sent = this.networkManager.send(MSG_TYPES.VOICE_JOIN, { channel });
      if (!sent) {
        if (this.joinWaiter?.generation === generation) this.joinWaiter.requestSent = false;
        this._failJoin(generation, '联机已断开，请重新加入语音');
      }
      return result;
    } catch (error) {
      if (generation !== this.joinGeneration) {
        this._stopStream(stream);
        return { ok: false, error: CANCELLED };
      }
      this._stopStream(stream);
      this.stream = null;
      this.channel = null;
      this.muted = false;
      this._state = 'IDLE';
      const message = errorMessage(error, '无法加入语音，请检查麦克风权限和网络');
      this._emitError(message);
      this._emitState();
      return { ok: false, error: message };
    }
  }

  async leave() {
    this._endSession({ sendLeave: true, error: null });
  }

  setMuted(muted) {
    if (!this.stream) return false;
    this.muted = Boolean(muted);
    for (const track of this.stream.getAudioTracks()) track.enabled = !this.muted;
    this._emitState();
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this._endSession({ sendLeave: true, error: null });
    this.destroyed = true;
    this.networkManager.off?.('stateChange', this.networkHandlers.stateChange);
    this.networkManager.off?.(MSG_TYPES.VOICE_ROSTER, this.networkHandlers.roster);
    this.networkManager.off?.(MSG_TYPES.VOICE_PEER_JOINED, this.networkHandlers.peerJoined);
    this.networkManager.off?.(MSG_TYPES.VOICE_PEER_LEFT, this.networkHandlers.peerLeft);
    this.networkManager.off?.(MSG_TYPES.VOICE_SIGNAL, this.networkHandlers.signal);
    this.networkManager.off?.(MSG_TYPES.VOICE_ERROR, this.networkHandlers.error);
    this.networkManager.off?.(MSG_TYPES.VOICE_COUNTS, this.networkHandlers.counts);
  }

  _endSession({ sendLeave, error }) {
    const channel = this.channel;
    const wasActive = this._state !== 'IDLE' || this.stream || this.peerConnections.size > 0;
    this.joinGeneration++;
    this._clearJoinTimeout();
    const waiter = this.joinWaiter;
    this.joinWaiter = null;
    waiter?.resolve({ ok: false, error: error || CANCELLED });

    const pendingJoinWasSent = waiter?.requestSent && waiter.channel === channel;
    if (sendLeave && channel && (this._state === 'IN_CALL' || pendingJoinWasSent) && this._isNetworkConnected()) {
      this.networkManager.send(MSG_TYPES.VOICE_LEAVE, { channel });
    }
    this._releaseMedia();
    this.channel = null;
    this.members = [];
    this.muted = false;
    this._state = 'IDLE';
    if (wasActive) {
      this._emitMembers();
      if (error) this._emitError(error);
      this._emitState();
    }
  }

  _failJoin(generation, message) {
    if (generation !== this.joinGeneration) return;
    this._clearJoinTimeout();
    const waiter = this.joinWaiter;
    this.joinWaiter = null;
    waiter?.resolve({ ok: false, error: message });
    if (waiter?.requestSent && this._isNetworkConnected()) {
      this.networkManager.send(MSG_TYPES.VOICE_LEAVE, { channel: waiter.channel });
    }
    this._releaseMedia();
    this.channel = null;
    this.members = [];
    this.muted = false;
    this._state = 'IDLE';
    this._emitMembers();
    this._emitError(message);
    this._emitState();
  }

  _clearJoinTimeout() {
    if (this.joinTimeout) clearTimeout(this.joinTimeout);
    this.joinTimeout = null;
  }

  _stopStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    for (const track of stream.getTracks()) {
      try {
        track.enabled = false;
        track.stop();
      } catch { /* A stopped or browser-managed track can throw during teardown. */ }
    }
  }

  _releaseMedia() {
    for (const [peerId, connection] of this.peerConnections) {
      try { connection.close(); } catch { /* Ignore already-closed peer connections. */ }
      this._removeRemoteAudio(peerId);
    }
    this.peerConnections.clear();
    this.pendingCandidates.clear();
    this._stopStream(this.stream);
    this.stream = null;
    this.iceConfig = null;
  }

  _onNetworkState({ state } = {}) {
    if (state === 'CONNECTED') return; // Reconnection never auto-opens the microphone.
    if (this._state === 'IDLE' && !this.stream && this.peerConnections.size === 0) return;
    this._endSession({ sendLeave: false, error: '网络中断，语音已断开；网络恢复后请手动重新加入' });
  }

  _onRoster(packet = {}) {
    if (!packet || packet.channel !== this.channel || !['JOINING', 'IN_CALL'].includes(this._state)) return;
    this.members = this._normalizeRoster(packet.members);
    if (this._state === 'JOINING') {
      this._clearJoinTimeout();
      this._state = 'IN_CALL';
      const waiter = this.joinWaiter;
      this.joinWaiter = null;
      waiter?.resolve({ ok: true });
    }
    this._emitMembers();
    this._emitState();
    this._syncPeerConnections();
  }

  _normalizeRoster(members) {
    if (!Array.isArray(members)) return [];
    const seen = new Set();
    return members.map(normalizeMember).filter(member => {
      if (!member || seen.has(member.id)) return false;
      seen.add(member.id);
      return true;
    });
  }

  _onPeerJoined(packet = {}) {
    if (!packet || packet.channel !== this.channel || this._state !== 'IN_CALL') return;
    const member = normalizeMember(packet.member);
    if (!member || member.id === this.player.id) return;
    if (!this.members.some(existing => existing.id === member.id)) {
      this.members = [...this.members, member];
      this._emitMembers();
      this._emitState();
    }
    this._ensurePeerConnection(member);
  }

  _onPeerLeft(packet = {}) {
    if (!packet || packet.channel !== this.channel || this._state !== 'IN_CALL') return;
    const peerId = String(packet.playerId ?? '');
    if (!peerId || peerId === this.player.id) return;
    this.members = this.members.filter(member => member.id !== peerId);
    const connection = this.peerConnections.get(peerId);
    if (connection) {
      try { connection.close(); } catch { /* Ignore already-closed connections. */ }
      this.peerConnections.delete(peerId);
    }
    this.pendingCandidates.delete(peerId);
    this._removeRemoteAudio(peerId);
    this._emitMembers();
    this._emitState();
  }

  _syncPeerConnections() {
    for (const member of this.members) {
      if (member.id !== this.player.id) this._ensurePeerConnection(member);
    }
    const peerIds = new Set(this.members.filter(member => member.id !== this.player.id).map(member => member.id));
    for (const [peerId, connection] of this.peerConnections) {
      if (!peerIds.has(peerId)) {
        try { connection.close(); } catch { /* Ignore already-closed connections. */ }
        this.peerConnections.delete(peerId);
        this.pendingCandidates.delete(peerId);
        this._removeRemoteAudio(peerId);
      }
    }
  }

  _ensurePeerConnection(member) {
    if (!this.stream || !this.iceConfig || this.peerConnections.has(member.id)) return this.peerConnections.get(member.id);
    let connection;
    try {
      connection = this.createPeerConnection(this.iceConfig);
      if (!connection) throw new Error('无法创建语音连接');
      this.peerConnections.set(member.id, connection);
      for (const track of this.stream.getAudioTracks()) connection.addTrack(track, this.stream);
      connection.onicecandidate = event => {
        if (!event?.candidate || this.channel === null || !this._isNetworkConnected()) return;
        this.networkManager.send(MSG_TYPES.VOICE_SIGNAL, {
          targetId: member.id,
          channel: this.channel,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      };
      connection.ontrack = event => this._attachRemoteAudio(member, event);
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'failed') this._emitError(`与 ${member.name} 的语音连接失败`);
      };
    } catch (error) {
      if (connection) {
        try { connection.close(); } catch { /* Ignore partial setup cleanup errors. */ }
        this.peerConnections.delete(member.id);
      }
      this._emitError(errorMessage(error, '语音连接初始化失败'));
      return null;
    }

    if (this._shouldCreateOffer(member.id)) {
      this._createOffer(member.id, connection).catch(error => {
        this._emitError(errorMessage(error, '无法发起语音连接'));
      });
    }
    return connection;
  }

  _shouldCreateOffer(peerId) {
    return this.player.id.localeCompare(peerId) < 0;
  }

  async _createOffer(peerId, connection) {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (this.peerConnections.get(peerId) !== connection || !this._isNetworkConnected()) return;
    this.networkManager.send(MSG_TYPES.VOICE_SIGNAL, {
      targetId: peerId,
      channel: this.channel,
      signal: connection.localDescription || offer
    });
  }

  _onSignal(packet = {}) {
    if (!packet || packet.channel !== this.channel || this._state !== 'IN_CALL') return;
    const peerId = String(packet.fromId ?? '');
    const member = this.members.find(item => item.id === peerId);
    if (!member || !packet.signal || typeof packet.signal !== 'object') return;
    const connection = this._ensurePeerConnection(member);
    if (!connection) return;
    this._applySignal(peerId, connection, packet.signal).catch(error => {
      this._emitError(errorMessage(error, '语音信令处理失败'));
    });
  }

  async _applySignal(peerId, connection, signal) {
    if (signal.type === 'offer') {
      await connection.setRemoteDescription(signal);
      await this._flushCandidates(peerId, connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      if (this.peerConnections.get(peerId) === connection && this._isNetworkConnected()) {
        this.networkManager.send(MSG_TYPES.VOICE_SIGNAL, {
          targetId: peerId,
          channel: this.channel,
          signal: connection.localDescription || answer
        });
      }
    } else if (signal.type === 'answer') {
      await connection.setRemoteDescription(signal);
      await this._flushCandidates(peerId, connection);
    } else if (signal.type === 'candidate' && signal.candidate) {
      if (!connection.remoteDescription) {
        if (!this.pendingCandidates.has(peerId)) this.pendingCandidates.set(peerId, []);
        this.pendingCandidates.get(peerId).push(signal.candidate);
      } else {
        await connection.addIceCandidate(signal.candidate);
      }
    }
  }

  async _flushCandidates(peerId, connection) {
    const candidates = this.pendingCandidates.get(peerId) || [];
    this.pendingCandidates.delete(peerId);
    for (const candidate of candidates) await connection.addIceCandidate(candidate);
  }

  _attachRemoteAudio(member, event) {
    const stream = event?.streams?.[0] || (event?.track && typeof MediaStream === 'function' ? new MediaStream([event.track]) : null);
    if (!stream || typeof document === 'undefined') {
      this._emitError('收到对方语音，但当前浏览器无法播放');
      return;
    }
    let audio = this.remoteAudio.get(member.id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.setAttribute('aria-label', `${member.name} 的语音`);
      this.remoteAudio.set(member.id, audio);
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    if (typeof audio.play === 'function') {
      Promise.resolve(audio.play()).catch(() => this._emitError('浏览器阻止了语音播放，请点击页面后重试'));
    }
  }

  _removeRemoteAudio(peerId) {
    const audio = this.remoteAudio.get(peerId);
    if (!audio) return;
    audio.srcObject = null;
    audio.remove?.();
    this.remoteAudio.delete(peerId);
  }

  _onServerError(packet = {}) {
    if (!packet || packet.channel !== this.channel) return;
    const message = typeof packet.message === 'string' && packet.message ? packet.message : '语音操作失败，请重试';
    if (this._state === 'JOINING') this._failJoin(this.joinGeneration, message);
    else this._emitError(message);
  }

  _onChannelCounts(packet = {}) {
    const counts = packet?.counts;
    if (!counts || typeof counts !== 'object') return;
    this.channelCounts = Object.fromEntries([...VOICE_CHANNELS].map(channel => {
      const count = Number(counts[channel]);
      return [channel, Number.isFinite(count) ? Math.max(0, Math.min(8, Math.floor(count))) : 0];
    }));
    this._emit('countsChange', { ...this.channelCounts });
  }
}

export default VoiceManager;
