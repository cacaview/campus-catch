import { randomBytes } from 'node:crypto';
import GameArea from '../../shared/game-area.js';
import { MapItems, roomItemSeed, DEFAULT_ITEM_CENTER } from '../../shared/map-items.js';

const OPEN = 1;
const HOST_PACKET_TYPES = new Set(['SYNC_ROOM_STATE', 'GAME_PAUSE', 'GAME_EXTEND', 'PLAYER_KICK', 'RECONNECT_ACK']);
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);
const scoreValue = value => finiteNumber(value) ? Math.max(0, Math.min(1_000_000, value)) : 0;
const SKILL_LIMITS = { stealth: 3, xray: 2, decoy_signal: 2, disguise: 1, golden_shield: 1, cat_radar: 2 };
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
  constructor({ maxVoiceMembers = 8, maxRooms = 256, maxMembers = 64, maxRoomSessions = 128, startedRoomReconnectGraceMs = 300_000, now = Date.now } = {}) {
    this.maxVoiceMembers = Math.max(1, Math.floor(Number(maxVoiceMembers) || 8));
    this.startedRoomReconnectGraceMs = Math.max(0, Number(startedRoomReconnectGraceMs) || 300_000);
    this.now = now;
    this.maxRooms = maxRooms;
    this.maxMembers = maxMembers;
    this.maxRoomSessions = maxRoomSessions;
    this.rooms = new Map();
    this.connections = new WeakMap();
    this.blockedSockets = new WeakSet();
  }

  onConnection(ws) {
    if (this.blockedSockets.has(ws)) return null;
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
    if (this.blockedSockets.has(ws)) return;
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
          state.room.phase = 'ENDED';
          state.room.catchWindows.clear();
          this.broadcast(state.room, this.packet('GAME_END', {}, state.player.id), ws);
        }
        return;
      case 'MAP_ITEM_PICKUP':
        this.handleMapItemPickup(state, payload);
        return;
      default:
        if (GAME_PACKET_TYPES.has(packet.type) && state.room) {
          const room = state.room;
          if (room.phase !== 'STARTED') return;
          if (HOST_PACKET_TYPES.has(packet.type) && state.player.id !== room.hostId) return;
          let canonical = payload;
          if (packet.type === 'PLAYER_MOVE') {
            canonical = this.handlePlayerMove(state, payload);
            if (!canonical) return;
          }
          if (packet.type === 'USE_SKILL') {
            if (!this.isPlaying(room) || typeof payload.skillId !== 'string') return;
            if (!this.trackSkillEffect(state, payload)) return;
            canonical = { skillId: payload.skillId, playerId: state.player.id, playerName: state.player.name };
            this.broadcastPlayerEffect(state);
          }
          if (packet.type === 'GAME_PAUSE') {
            if (typeof payload.paused !== 'boolean') return;
            room.paused = payload.paused;
            room.catchWindows.clear();
            room.playerPositions.clear();
            canonical = { paused: room.paused };
          }
          if (packet.type === 'GAME_EXTEND') {
            if (!finiteNumber(payload.seconds) || payload.seconds <= 0 || payload.seconds > 300) return;
            canonical = { seconds: Math.floor(payload.seconds) };
          }
          if (packet.type === 'SYNC_ROOM_STATE') {
            if (!finiteNumber(payload.remainingTime) || payload.remainingTime < 0 || payload.remainingTime > 7200) return;
            canonical = { remainingTime: Math.round(payload.remainingTime), paused: room.paused };
          }
          if (packet.type === 'PLAYER_KICK') {
            this.kickPlayer(state, payload.playerId);
            return;
          }
          const forwarded = {
            type: packet.type,
            senderId: state.player.id,
            timestamp: Number.isFinite(packet.timestamp) ? packet.timestamp : this.now(),
            payload: canonical
          };
          this.broadcast(state.room, forwarded, ws);
        }
    }
  }

  isPlaying(room) {
    return room.phase === 'STARTED' && !room.paused && this.now() >= room.startAt;
  }

  kickPlayer(state, playerId) {
    const room = state.room;
    const id = stringId(playerId);
    const target = room.members.get(id);
    if (!target || id === room.hostId) return;
    this.broadcast(room, this.packet('PLAYER_KICK', { playerId: id, name: target.player.name }, state.player.id), state.ws);
    room.knownPlayerIds.delete(id);
    room.playerSessions.delete(id);
    room.kickedPlayerIds.add(id);
    this.blockedSockets.add(target.ws);
    this.removeConnection(target.ws);
    try { target.ws.close?.(4003, 'Removed from room'); } catch { /* Already closed. */ }
  }

  handlePlayerMove(state, payload) {
    const room = state.room;
    if (!room || !state.player || !this.isPlaying(room)) return null;
    const latitude = payload.latitude;
    const longitude = payload.longitude;
    if (!finiteNumber(latitude) || !finiteNumber(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    if (room.gameArea && !GameArea.contains(room.gameArea, { latitude, longitude })) {
      room.playerPositions.delete(state.player.id);
      this.forgetPlayerPairEntries(room.catchWindows, state.player.id);
      return null;
    }
    // 本局积分只增不减；迟到的抓捕前位置包不能抹掉已发出的抓捕奖励。
    state.player.score = Math.max(state.player.score, scoreValue(payload.score));
    room.playerPositions.set(state.player.id, { latitude, longitude, at: this.now() });
    this.evaluateProximityCatches(room);
    if (state.removed) return null;
    return this.movementPayload(state, { latitude, longitude });
  }

  movementPayload(state, position) {
    const effects = state.room.skillEffects.get(state.player.id) || {};
    const now = this.now();
    return { id: state.player.id, name: state.player.name, team: state.player.team,
      latitude: position.latitude, longitude: position.longitude, score: state.player.score,
      stealthActive: (effects.stealthUntil || 0) > now,
      disguiseActive: (effects.disguiseUntil || 0) > now,
      decoyPosition: (effects.decoyUntil || 0) > now ? effects.decoyPosition : null };
  }

  broadcastPlayerEffect(state) {
    const position = state.room.playerPositions.get(state.player.id);
    if (position && this.now() - position.at <= CATCH_POSITION_STALE_MS) {
      this.broadcast(state.room, this.packet('PLAYER_MOVE', this.movementPayload(state, position), state.player.id), state.ws);
    }
  }

  trackSkillEffect(state, payload) {
    const room = state.room;
    if (!room || !state.player || !this.isPlaying(room)) return false;
    const skillId = typeof payload.skillId === 'string' ? payload.skillId : '';
    if (!Object.hasOwn(SKILL_LIMITS, skillId) ||
        ((skillId === 'cat_radar') !== (state.player.team === 'cat'))) return false;
    const session = room.playerSessions.get(state.player.id);
    const uses = room.skillUses.get(state.player.id) || {};
    if ((uses[skillId] || 0) >= SKILL_LIMITS[skillId] + (session?.skillBonus || 0)) return false;
    uses[skillId] = (uses[skillId] || 0) + 1;
    room.skillUses.set(state.player.id, uses);
    const effects = room.skillEffects.get(state.player.id) || {};
    const now = this.now();
    if (skillId === 'cat_radar' && state.player.team === 'cat') {
      effects.radarUntil = now + CATCH_RADAR_DURATION_MS;
      room.skillEffects.set(state.player.id, effects);
    } else if (skillId === 'golden_shield') {
      effects.shieldUntil = now + CATCH_SHIELD_DURATION_MS;
      room.skillEffects.set(state.player.id, effects);
    } else if (skillId === 'stealth') {
      effects.stealthUntil = now + 15000;
    } else if (skillId === 'disguise') {
      effects.disguiseUntil = now + 15000;
    } else if (skillId === 'decoy_signal') {
      effects.decoyUntil = now + 10000;
      const position = room.playerPositions.get(state.player.id);
      if (position) effects.decoyPosition = { latitude: position.latitude + 0.0003, longitude: position.longitude - 0.0003 };
    }
    room.skillEffects.set(state.player.id, effects);
    return true;
  }

  distanceMeters(a, b) {
    return GameArea.distanceMeters(a, b);
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
    if (!this.isPlaying(room)) return;
    const now = this.now();
    const members = [...room.members.values()].filter(state => state.ws.readyState === OPEN);
    const cats = members.filter(state => state.player.team === 'cat');
    const mice = members.filter(state => state.player.team === 'mouse');
    for (const cat of cats) {
      for (const mouse of mice) {
        if (mouse.removed) continue;
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
    if (room.caughtPlayerIds.has(mouse.player.id)) return;
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
    const mouseId = mouse.player.id;
    room.caughtPlayerIds.add(mouseId);
    cat.player.score = scoreValue(cat.player.score + 10);
    this.broadcast(room, this.packet('CATCH_EVENT', {
      success: true,
      catScore: cat.player.score,
      mouseScore: mouse.player.score,
      catId: cat.player.id,
      catName: cat.player.name,
      mouseId: mouse.player.id,
      mouseName: mouse.player.name
    }, 'server'));
    // 先发送抓捕结果，再退房；客户端可保留本局快照，淘汰身份不能重连继续。
    room.playerSessions.delete(mouseId);
    this.blockedSockets.add(mouse.ws);
    this.removeConnection(mouse.ws, { transferHost: true });
    try { mouse.ws.close?.(4004, 'Caught and eliminated'); } catch { /* Already closed. */ }
  }

  handleMapItemPickup(state, payload) {
    const room = state.room;
    const itemId = payload.itemId;
    if (!room || !state.player || !this.isPlaying(room) || room.pickedMapItemIds.size >= 8 ||
        !Number.isSafeInteger(itemId) || itemId < 2001) return;
    if (room.pickedMapItemIds.has(itemId)) return;
    const item = room.mapItems.items.find(value => value.id === itemId);
    const position = room.playerPositions.get(state.player.id);
    if (!item || !position || this.now() - position.at > CATCH_POSITION_STALE_MS ||
        this.distanceMeters(position, item) > 20) return;
    if ((item.type === 'CHEESE' && state.player.team !== 'mouse') ||
        (item.type === 'CATNIP' && state.player.team !== 'cat')) return;

    room.pickedMapItemIds.add(itemId);
    if (item.type === 'BUSH') {
      const effects = room.skillEffects.get(state.player.id) || {};
      effects.stealthUntil = Math.max(effects.stealthUntil || 0, this.now() + 5000);
      room.skillEffects.set(state.player.id, effects);
      this.broadcastPlayerEffect(state);
    }
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
    if (room?.phase === 'ENDED' || room?.kickedPlayerIds.has(playerId) || room?.caughtPlayerIds.has(playerId)) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '活动已结束或你已被淘汰、移出房间' });
      return;
    }
    const previousSession = room?.playerSessions.get(playerId);
    if (previousSession && state !== room.members.get(playerId) &&
        (typeof payload.reconnectToken !== 'string' || payload.reconnectToken !== previousSession.token)) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '玩家重连凭据无效，请使用原设备重新连接' });
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

    if (state.room && state.room !== room) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '请先离开当前房间' });
      return;
    }
    if ((!room && this.rooms.size >= this.maxRooms) ||
        (room && !room.members.has(playerId) && room.members.size >= this.maxMembers) ||
        (room && !room.playerSessions.has(playerId) && room.playerSessions.size >= this.maxRoomSessions)) {
      this.send(state, 'JOIN_ACK', { success: false, reason: '房间或服务人数已达上限，请稍后重试' });
      return;
    }
    state.removed = false;
    this.connections.set(state.ws, state);

    if (!room) {
      const gameArea = GameArea.isValidArea(payload.gameArea) ? payload.gameArea : null;
      const seconds = payload.gameDurationSeconds;
      room = {
        passcode,
        roomId: `ROOM_${passcode}`,
        members: new Map(),
        knownPlayerIds: new Set(),
        playerSessions: new Map(),
        kickedPlayerIds: new Set(),
        caughtPlayerIds: new Set(),
        paused: false,
        mapItems: new MapItems(),
        pickedMapItemIds: new Set(),
        playerPositions: new Map(),
        catchWindows: new Map(),
        pairCooldowns: new Map(),
        skillEffects: new Map(),
        skillUses: new Map(),
        catchMode: CATCH_MODES.includes(payload.catchMode) ? payload.catchMode : CATCH_MODE_SUSTAINED,
        hostId: playerId,
        phase: 'WAITING',
        startAt: null,
        expiresAt: null,
        gameArea,
        gameDurationSeconds: Math.max(60, Math.min(7200, Number.isFinite(seconds) && seconds ? seconds : 600))
      };
      this.rooms.set(passcode, room);
    }

    const player = previousSession?.player || {
      id: playerId,
      name: playerName,
      team,
      score: scoreValue(payload.player?.score)
    };
    const previous = room.members.get(playerId);
    if (previous && previous !== state) {
      this.blockedSockets.add(previous.ws);
      this.removeConnection(previous.ws, { preserveHost: true });
      if (this.rooms.get(passcode) !== room) this.rooms.set(passcode, room);
      try { previous.ws.close?.(4001, 'Player reconnected'); } catch { /* Ignore an already-closed socket. */ }
    }
    state.room = room;
    state.player = player;
    state.removed = false;
    room.knownPlayerIds.add(playerId);
    room.members.set(playerId, state);
    const session = previousSession || { token: randomBytes(32).toString('hex'), player,
      skillBonus: finiteNumber(payload.player?.skillBonus) ? Math.max(0, Math.min(10, Math.floor(payload.player.skillBonus))) : 0,
      startShield: payload.player?.startShield === true };
    room.playerSessions.set(playerId, session);
    room.expiresAt = null;

    const members = this.members(room);
    this.send(state, 'JOIN_ACK', {
      success: true,
      reconnectToken: session.token,
      roomId: room.roomId,
      members,
      hostId: room.hostId,
      isHost: playerId === room.hostId,
      phase: room.phase,
      paused: room.paused,
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
    if (room.phase !== 'WAITING') {
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
    room.skillUses.clear();
    for (const [id, session] of room.playerSessions) {
      if (session.startShield) room.skillEffects.set(id, { shieldUntil: room.startAt + CATCH_SHIELD_DURATION_MS });
    }
    const itemArea = room.gameArea || DEFAULT_ITEM_CENTER;
    room.mapItems.spawnItems(itemArea, 8, roomItemSeed(room.roomId, itemArea));
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

  removeConnection(ws, { preserveHost = false, transferHost = false } = {}) {
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
        if (!preserveHost && (room.phase === 'WAITING' || transferHost) && state.player.id === room.hostId) {
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
    this.blockedSockets.add(ws);
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
    if ((state.ws.bufferedAmount || 0) > 1_048_576) {
      state.ws.close?.(1013, 'Slow receiver');
      return false;
    }
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
        if ((state.ws.bufferedAmount || 0) > 1_048_576) {
          state.ws.close?.(1013, 'Slow receiver');
          continue;
        }
        try { state.ws.send(raw); } catch { /* A later close event removes the stale member. */ }
      }
    }
  }
}

export default RoomRegistry;
