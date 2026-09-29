const OPEN = 1;
const VOICE_CHANNELS = new Set(['global', 'cat', 'mouse']);
const GAME_PACKET_TYPES = new Set([
  'SYNC_ROOM_STATE',
  'PLAYER_MOVE',
  'USE_SKILL',
  'CATCH_EVENT',
  'CHAT_MESSAGE',
  'GAME_PAUSE',
  'GAME_EXTEND',
  'PLAYER_KICK',
  'RECONNECT',
  'RECONNECT_ACK',
  'MAP_ITEM_PICKUP'
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringId = value => (typeof value === 'string' || typeof value === 'number') && String(value).trim().length > 0
  ? String(value).trim().slice(0, 128)
  : '';

export class RoomRegistry {
  constructor({ maxVoiceMembers = 8, now = Date.now } = {}) {
    this.maxVoiceMembers = Math.max(1, Math.floor(Number(maxVoiceMembers) || 8));
    this.now = now;
    this.rooms = new Map();
    this.connections = new WeakMap();
  }

  onConnection(ws) {
    const state = {
      ws,
      room: null,
      player: null,
      voiceChannel: null,
      chatTimes: [],
      removed: false
    };
    this.connections.set(ws, state);
    return state;
  }

  handlePacket(ws, packet) {
    let state = this.connections.get(ws);
    if (!state) state = this.onConnection(ws);
    if (state.removed || !isObject(packet) || typeof packet.type !== 'string' || !isObject(packet.payload ?? {})) return;

    const payload = packet.payload ?? {};
    switch (packet.type) {
      case 'PING':
        this.send(state, 'PONG', { time: this.now() });
        return;
      case 'JOIN_ROOM':
        this.joinRoom(state, payload);
        return;
      case 'LEAVE_ROOM':
        this.removeConnection(ws);
        return;
      case 'CHAT_MESSAGE':
        this.handleChat(state, payload);
        return;
      case 'VOICE_JOIN':
        this.joinVoice(state, payload.channel);
        return;
      case 'VOICE_LEAVE':
        this.leaveVoice(state);
        return;
      case 'VOICE_SIGNAL':
        this.routeVoiceSignal(state, payload);
        return;
      default:
        if (GAME_PACKET_TYPES.has(packet.type) && state.room) {
          const forwarded = {
            type: packet.type,
            senderId: state.player.id,
            timestamp: Number.isFinite(packet.timestamp) ? packet.timestamp : this.now(),
            payload
          };
          this.broadcast(state.room, forwarded, ws);
        }
    }
  }

  joinRoom(state, payload) {
    const passcode = typeof payload.passcode === 'string' || typeof payload.passcode === 'number'
      ? String(payload.passcode).trim().slice(0, 64)
      : '';
    const playerId = stringId(payload.player?.id);
    const playerName = typeof payload.player?.name === 'string' ? payload.player.name.trim().slice(0, 64) : '';
    const team = payload.player?.team;
    if (!passcode || !playerId || !playerName || !['cat', 'mouse'].includes(team)) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '房间或玩家信息无效' });
      return;
    }

    if (state.room) this.removeConnection(state.ws);
    state.removed = false;
    this.connections.set(state.ws, state);

    let room = this.rooms.get(passcode);
    if (!room) {
      const gameArea = isObject(payload.gameArea) ? payload.gameArea : null;
      const seconds = Number(payload.gameDurationSeconds);
      room = {
        passcode,
        roomId: `ROOM_${passcode}`,
        members: new Map(),
        gameArea,
        gameDurationSeconds: Math.max(60, Math.min(7200, Number.isFinite(seconds) && seconds ? seconds : 600))
      };
      this.rooms.set(passcode, room);
    } else if (!room.gameArea && isObject(payload.gameArea)) {
      room.gameArea = payload.gameArea;
    }

    const player = {
      ...payload.player,
      id: playerId,
      name: playerName,
      team
    };
    const previous = room.members.get(playerId);
    if (previous && previous !== state) this.removeConnection(previous.ws);
    state.room = room;
    state.player = player;
    state.voiceChannel = null;
    state.chatTimes = [];
    state.removed = false;
    room.members.set(playerId, state);

    const members = this.members(room);
    this.send(state, 'JOIN_ACK', {
      success: true,
      roomId: room.roomId,
      members,
      gameArea: room.gameArea,
      gameDurationSeconds: room.gameDurationSeconds
    });
    this.broadcast(room, this.packet('PLAYER_JOINED', { player }, playerId), state.ws);
  }

  handleChat(state, payload) {
    if (!state.room || typeof payload.text !== 'string') return;
    const text = payload.text.trim();
    if (!text || [...text].length > 50) return;

    const now = this.now();
    state.chatTimes = state.chatTimes.filter(timestamp => now - timestamp < 1000);
    if (state.chatTimes.length >= 4) return;
    state.chatTimes.push(now);

    this.broadcast(state.room, this.packet('CHAT_MESSAGE', {
      sender: state.player.name,
      text
    }, state.player.id), state.ws);
  }

  joinVoice(state, channel) {
    if (!state.room || !state.player) {
      this.sendVoiceError(state, channel, 'NOT_IN_ROOM', '请先加入游戏房间');
      return;
    }
    if (!VOICE_CHANNELS.has(channel)) {
      this.sendVoiceError(state, channel, 'INVALID_CHANNEL', '语音频道无效');
      return;
    }
    if ((channel === 'cat' || channel === 'mouse') && state.player.team !== channel) {
      this.sendVoiceError(state, channel, 'TEAM_MISMATCH', '只能加入自己队伍的语音频道');
      return;
    }

    const members = this.channelMembers(state.room, channel);
    const isAlreadyMember = state.voiceChannel === channel;
    if (!isAlreadyMember && members.length >= this.maxVoiceMembers) {
      this.sendVoiceError(state, channel, 'CHANNEL_FULL', '语音频道已满');
      return;
    }

    if (state.voiceChannel) this.leaveVoice(state);
    state.voiceChannel = channel;
    const roster = this.channelMembers(state.room, channel);
    this.send(state, 'VOICE_ROSTER', { channel, members: roster.map(member => member.player) });
    this.broadcast(state.room, this.packet('VOICE_PEER_JOINED', {
      channel,
      member: state.player
    }, state.player.id), state.ws);
  }

  leaveVoice(state) {
    if (!state.room || !state.player || !state.voiceChannel) return;
    const channel = state.voiceChannel;
    state.voiceChannel = null;
    this.broadcast(state.room, this.packet('VOICE_PEER_LEFT', {
      channel,
      playerId: state.player.id
    }, state.player.id), state.ws);
  }

  routeVoiceSignal(state, payload) {
    if (!state.room || !state.player || !state.voiceChannel || payload.channel !== state.voiceChannel) return;
    const targetId = stringId(payload.targetId);
    const target = targetId && state.room.members.get(targetId);
    if (!target || target === state || target.voiceChannel !== state.voiceChannel || !isObject(payload.signal)) return;

    this.send(target, 'VOICE_SIGNAL', {
      targetId: target.player.id,
      fromId: state.player.id,
      channel: state.voiceChannel,
      signal: payload.signal
    }, state.player.id);
  }

  sendVoiceError(state, channel, code, message) {
    this.send(state, 'VOICE_ERROR', { channel, code, message });
  }

  removeConnection(ws) {
    const state = this.connections.get(ws);
    if (!state || state.removed) return;
    if (state.voiceChannel) this.leaveVoice(state);
    const room = state.room;
    if (room && state.player && room.members.get(state.player.id) === state) {
      room.members.delete(state.player.id);
      if (room.members.size > 0) {
        this.broadcast(room, this.packet('PLAYER_LEFT', { playerId: state.player.id }, state.player.id));
      } else {
        this.rooms.delete(room.passcode);
      }
    }
    state.room = null;
    state.player = null;
    state.removed = true;
    this.connections.delete(ws);
  }

  members(room) {
    return [...room.members.values()].map(state => state.player);
  }

  channelMembers(room, channel) {
    return [...room.members.values()].filter(state => state.voiceChannel === channel && state.ws.readyState === OPEN);
  }

  packet(type, payload, senderId = 'server') {
    return { type, senderId, timestamp: this.now(), payload };
  }

  send(state, type, payload, senderId = 'server') {
    if (state?.ws?.readyState !== OPEN) return false;
    try {
      state.ws.send(JSON.stringify(this.packet(type, payload, senderId)));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(room, packet, excludeWs = null) {
    const raw = JSON.stringify(packet);
    for (const state of room.members.values()) {
      if (state.ws !== excludeWs && state.ws.readyState === OPEN) {
        try { state.ws.send(raw); } catch { /* A later close event removes the stale member. */ }
      }
    }
  }
}

export default RoomRegistry;
