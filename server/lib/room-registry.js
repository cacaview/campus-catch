const OPEN = 1;
const VOICE_CHANNELS = new Set(['global', 'cat', 'mouse']);
const GAME_PACKET_TYPES = new Set([
  'SYNC_ROOM_STATE',
  'PLAYER_MOVE',
  'USE_SKILL',
  'CHAT_MESSAGE',
  'GAME_PAUSE',
  'GAME_EXTEND',
  'PLAYER_KICK',
  'RECONNECT',
  'RECONNECT_ACK',
  'MAP_ITEM_PICKUP'
]);

// 服务器权威近距离抓捕参数：10 米范围内开始判定，猫雷达（火眼金睛）扩大到 25 米
const CATCH_BASE_RADIUS_METERS = 10;
const CATCH_RADAR_RADIUS_METERS = 25;
// 抓捕判定方式：instant = 入范围立即判定（源逻辑）；sustained = 连续保持范围 3 秒自动抓捕（默认）
const CATCH_MODE_INSTANT = 'instant';
const CATCH_MODE_SUSTAINED = 'sustained';
const CATCH_MODES = [CATCH_MODE_INSTANT, CATCH_MODE_SUSTAINED];
const CATCH_PROXIMITY_MS = 3000;
const CATCH_PAIR_COOLDOWN_MS = 10_000;
const CATCH_POSITION_STALE_MS = 5000;
const CATCH_RADAR_DURATION_MS = 10_000;
const CATCH_SHIELD_DURATION_MS = 10_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringId = value => (typeof value === 'string' || typeof value === 'number') && String(value).trim().length > 0
  ? String(value).trim().slice(0, 128)
  : '';

export class RoomRegistry {
  constructor({ maxVoiceMembers = 8, startedRoomReconnectGraceMs = 300_000, now = Date.now } = {}) {
    this.maxVoiceMembers = Math.max(1, Math.floor(Number(maxVoiceMembers) || 8));
    this.startedRoomReconnectGraceMs = Math.max(0, Number(startedRoomReconnectGraceMs) || 300_000);
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
      case 'VOICE_COUNTS_REQUEST':
        if (state.room) this.send(state, 'VOICE_COUNTS', { counts: this.voiceCounts(state.room) });
        return;
      case 'ROOM_START_REQUEST':
        this.startRoom(state);
        return;
      case 'GAME_END':
        if (state.room?.phase === 'STARTED' && state.player?.id === state.room.hostId) {
          this.broadcast(state.room, this.packet('GAME_END', {}, state.player.id), ws);
        }
        return;
      case 'MAP_ITEM_PICKUP':
        this.handleMapItemPickup(state, payload);
        return;
      default:
        if (GAME_PACKET_TYPES.has(packet.type) && state.room) {
          if (packet.type === 'PLAYER_MOVE') this.handlePlayerMove(state, payload);
          if (packet.type === 'USE_SKILL') this.trackSkillEffect(state, payload);
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

  handlePlayerMove(state, payload) {
    const room = state.room;
    if (!room || !state.player || room.phase !== 'STARTED') return;
    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
    room.playerPositions.set(state.player.id, { latitude, longitude, at: this.now() });
    this.evaluateProximityCatches(room);
  }

  trackSkillEffect(state, payload) {
    const room = state.room;
    if (!room || !state.player) return;
    const skillId = typeof payload.skillId === 'string' ? payload.skillId : '';
    const effects = room.skillEffects.get(state.player.id) || {};
    const now = this.now();
    if (skillId === 'cat_radar' && state.player.team === 'cat') {
      effects.radarUntil = now + CATCH_RADAR_DURATION_MS;
      room.skillEffects.set(state.player.id, effects);
    } else if (skillId === 'golden_shield') {
      effects.shieldUntil = now + CATCH_SHIELD_DURATION_MS;
      room.skillEffects.set(state.player.id, effects);
    }
  }

  distanceMeters(a, b) {
    const dLat = Math.abs(a.latitude - b.latitude);
    const dLng = Math.abs(a.longitude - b.longitude);
    return Math.sqrt(dLat * dLat + dLng * dLng) * 111320;
  }

  forgetPlayerPairEntries(entries, playerId) {
    for (const key of [...entries.keys()]) {
      const index = key.indexOf(':');
      if (index < 0) continue;
      if (key.slice(0, index) === playerId || key.slice(index + 1) === playerId) entries.delete(key);
    }
  }

  catchRadiusFor(room, catId, now) {
    const radarUntil = room.skillEffects.get(catId)?.radarUntil || 0;
    return radarUntil > now ? CATCH_RADAR_RADIUS_METERS : CATCH_BASE_RADIUS_METERS;
  }

  evaluateProximityCatches(room) {
    const now = this.now();
    const members = [...room.members.values()].filter(state => state.ws.readyState === OPEN);
    const cats = members.filter(state => state.player.team === 'cat');
    const mice = members.filter(state => state.player.team === 'mouse');
    for (const cat of cats) {
      for (const mouse of mice) {
        const key = `${cat.player.id}:${mouse.player.id}`;
        const catPos = room.playerPositions.get(cat.player.id);
        const mousePos = room.playerPositions.get(mouse.player.id);
        if (!catPos || !mousePos ||
            now - catPos.at > CATCH_POSITION_STALE_MS || now - mousePos.at > CATCH_POSITION_STALE_MS) {
          room.catchWindows.delete(key);
          continue;
        }
        // 窗口起点取双方位置都有效的时刻，重新进入范围则清零重计
        const windowStart = Math.min(
          room.catchWindows.get(key) ?? now,
          Math.max(catPos.at, mousePos.at)
        );
        if (this.distanceMeters(catPos, mousePos) <= this.catchRadiusFor(room, cat.player.id, now)) {
          if (room.catchMode === CATCH_MODE_INSTANT) {
            // 即时判定：猫一进入范围立即结算（冷却 / 金钟罩规则仍然生效）
            this.resolveProximityCatch(room, cat, mouse, key, now);
            continue;
          }
          // 3 秒持续判定：仅在持续处于范围内时累计
          room.catchWindows.set(key, windowStart);
          if (now - windowStart >= CATCH_PROXIMITY_MS) {
            this.resolveProximityCatch(room, cat, mouse, key, now);
          }
        } else {
          room.catchWindows.delete(key);
        }
      }
    }
  }

  resolveProximityCatch(room, cat, mouse, key, now) {
    if ((room.pairCooldowns.get(key) || 0) > now) {
      room.catchWindows.delete(key);
      return;
    }
    room.catchWindows.delete(key);
    room.pairCooldowns.set(key, now + CATCH_PAIR_COOLDOWN_MS);
    const effects = room.skillEffects.get(mouse.player.id);
    if (effects && effects.shieldUntil > now) {
      effects.shieldUntil = 0;
      this.broadcast(room, this.packet('CATCH_EVENT', {
        blocked: true,
        catId: cat.player.id,
        catName: cat.player.name,
        mouseId: mouse.player.id,
        mouseName: mouse.player.name
      }, 'server'));
      return;
    }
    this.broadcast(room, this.packet('CATCH_EVENT', {
      success: true,
      catId: cat.player.id,
      catName: cat.player.name,
      mouseId: mouse.player.id,
      mouseName: mouse.player.name
    }, 'server'));
  }

  handleMapItemPickup(state, payload) {
    const room = state.room;
    const itemId = Number(payload.itemId);
    if (!room || !state.player || room.phase !== 'STARTED' || room.pickedMapItemIds.size >= 8 ||
        !Number.isSafeInteger(itemId) || itemId < 2001) return;
    if (room.pickedMapItemIds.has(itemId)) return;

    room.pickedMapItemIds.add(itemId);
    this.broadcast(room, this.packet('MAP_ITEM_PICKUP', {
      itemId,
      playerId: state.player.id
    }, state.player.id));
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
    if (state.player && state.player.id !== playerId) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '当前连接已绑定其他玩家' });
      return;
    }

    this.pruneExpiredRooms(passcode);
    let room = this.rooms.get(passcode);
    if (room?.phase === 'STARTED' && room.members.size === 0 && Number.isFinite(room.expiresAt) && this.now() >= room.expiresAt) {
      this.rooms.delete(passcode);
      this.send(state, 'JOIN_ACK', { success: false, reason: '活动已结束，请房主创建新房间' });
      return;
    }
    if (room && payload.createIfMissingRoom === true) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '房间码已被使用，请重新创建' });
      return;
    }
    if (room?.phase === 'STARTED' && !room.knownPlayerIds.has(playerId)) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '活动已开始，暂不接受加入' });
      return;
    }
    if (!room && payload.createIfMissingRoom !== true) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '房间不存在或已结束，请检查邀请链接' });
      return;
    }

    if (state.room && state.room !== room) this.removeConnection(state.ws);
    state.removed = false;
    this.connections.set(state.ws, state);

    if (!room) {
      const gameArea = isObject(payload.gameArea) ? payload.gameArea : null;
      const seconds = Number(payload.gameDurationSeconds);
      room = {
        passcode,
        roomId: `ROOM_${passcode}`,
        members: new Map(),
        knownPlayerIds: new Set(),
        pickedMapItemIds: new Set(),
        playerPositions: new Map(),
        catchWindows: new Map(),
        pairCooldowns: new Map(),
        skillEffects: new Map(),
        catchMode: CATCH_MODES.includes(payload.catchMode) ? payload.catchMode : CATCH_MODE_SUSTAINED,
        hostId: playerId,
        phase: 'WAITING',
        startAt: null,
        expiresAt: null,
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
    if (previous && previous !== state) {
      this.removeConnection(previous.ws, { preserveHost: true });
      if (this.rooms.get(passcode) !== room) this.rooms.set(passcode, room);
      try { previous.ws.close?.(4001, 'Player reconnected'); } catch { /* Ignore an already-closed socket. */ }
    }
    state.room = room;
    state.player = player;
    state.voiceChannel = null;
    state.chatTimes = [];
    state.removed = false;
    room.knownPlayerIds.add(playerId);
    room.members.set(playerId, state);
    room.expiresAt = null;

    const members = this.members(room);
    this.send(state, 'JOIN_ACK', {
      success: true,
      roomId: room.roomId,
      members,
      hostId: room.hostId,
      isHost: playerId === room.hostId,
      phase: room.phase,
      startAt: room.startAt,
      catchMode: room.catchMode,
      gameArea: room.gameArea,
      gameDurationSeconds: room.gameDurationSeconds,
      pickedMapItemIds: [...room.pickedMapItemIds]
    });
    this.broadcast(room, this.packet('PLAYER_JOINED', { player }, playerId), state.ws);
  }

  startRoom(state) {
    if (!state.room || !state.player) {
      this.send(state, 'ROOM_START_ERROR', { code: 'NOT_IN_ROOM', message: '请先加入房间' });
      return;
    }
    const room = state.room;
    if (room.phase === 'STARTED') {
      this.send(state, 'ROOM_START_ERROR', { code: 'ALREADY_STARTED', message: '活动已经开始' });
      return;
    }
    if (state.player.id !== room.hostId) {
      this.send(state, 'ROOM_START_ERROR', { code: 'NOT_HOST', message: '只有房主可以开始活动' });
      return;
    }
    const connectedMembers = [...room.members.values()].filter(member => member.ws.readyState === OPEN);
    if (connectedMembers.length < 2) {
      this.send(state, 'ROOM_START_ERROR', { code: 'WAITING_FOR_PLAYERS', message: '至少需要一名队员加入后才能开始' });
      return;
    }

    room.phase = 'STARTED';
    room.startAt = this.now() + 3000;
    room.playerPositions.clear();
    room.catchWindows.clear();
    room.pairCooldowns.clear();
    room.skillEffects.clear();
    this.broadcast(room, this.packet('ROOM_STARTED', {
      phase: room.phase,
      hostId: room.hostId,
      startAt: room.startAt
    }));
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
    this.broadcastVoiceCounts(state.room);
  }

  leaveVoice(state) {
    if (!state.room || !state.player || !state.voiceChannel) return;
    const channel = state.voiceChannel;
    state.voiceChannel = null;
    this.broadcast(state.room, this.packet('VOICE_PEER_LEFT', {
      channel,
      playerId: state.player.id
    }, state.player.id), state.ws);
    this.broadcastVoiceCounts(state.room);
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

  removeConnection(ws, { preserveHost = false } = {}) {
    const state = this.connections.get(ws);
    if (!state || state.removed) return;
    if (state.voiceChannel) this.leaveVoice(state);
    const room = state.room;
    if (room && state.player && room.members.get(state.player.id) === state) {
      room.members.delete(state.player.id);
      room.playerPositions.delete(state.player.id);
      room.skillEffects.delete(state.player.id);
      this.forgetPlayerPairEntries(room.catchWindows, state.player.id);
      this.forgetPlayerPairEntries(room.pairCooldowns, state.player.id);
      if (room.members.size > 0) {
        this.broadcast(room, this.packet('PLAYER_LEFT', { playerId: state.player.id }, state.player.id));
        if (!preserveHost && room.phase === 'WAITING' && state.player.id === room.hostId) {
          const nextHost = [...room.members.values()].find(member => member.ws.readyState === OPEN);
          if (nextHost) {
            room.hostId = nextHost.player.id;
            this.broadcast(room, this.packet('ROOM_HOST_CHANGED', {
              hostId: room.hostId,
              members: this.members(room)
            }));
          }
        }
      } else {
        if (room.phase === 'STARTED') {
          const graceEnd = this.now() + this.startedRoomReconnectGraceMs;
          const plannedEnd = room.startAt + room.gameDurationSeconds * 1000 + this.startedRoomReconnectGraceMs;
          room.expiresAt = Math.max(graceEnd, plannedEnd);
        } else {
          this.rooms.delete(room.passcode);
        }
      }
    }
    state.room = null;
    state.player = null;
    state.removed = true;
    this.connections.delete(ws);
  }

  pruneExpiredRooms(exceptPasscode) {
    const now = this.now();
    for (const [passcode, room] of this.rooms) {
      if (passcode !== exceptPasscode && room.phase === 'STARTED' && room.members.size === 0 &&
          Number.isFinite(room.expiresAt) && now >= room.expiresAt) {
        this.rooms.delete(passcode);
      }
    }
  }

  members(room) {
    return [...room.members.values()].map(state => ({
      ...state.player,
      isHost: state.player.id === room.hostId
    }));
  }

  channelMembers(room, channel) {
    return [...room.members.values()].filter(state => state.voiceChannel === channel && state.ws.readyState === OPEN);
  }

  voiceCounts(room) {
    return Object.fromEntries([...VOICE_CHANNELS].map(channel => [channel, this.channelMembers(room, channel).length]));
  }

  broadcastVoiceCounts(room) {
    this.broadcast(room, this.packet('VOICE_COUNTS', { counts: this.voiceCounts(room) }));
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
