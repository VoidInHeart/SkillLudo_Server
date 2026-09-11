import { WebSocketServer as WsServer, type RawData, type WebSocket } from 'ws';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GameEngine, GameError } from '../game/GameEngine.js';
import { BoardCalibrationStore } from '../game/BoardCalibrationStore.js';
import type { AuthData, ChatEntry, ClientMessage, GameSnapshot, ServerMessage } from '../protocol.js';
import { ErrorCode } from '../protocol.js';
import { AuthError } from '../auth/UserRepository.js';
import { SessionManager, type Session } from '../auth/SessionManager.js';
import { RoomManager, RoomError } from '../room/RoomManager.js';
import type { Player, Room } from '../room/Room.js';
import { ConnectionManager } from './ConnectionManager.js';

interface ConnectionContext {
  session?: Session;
  requestsInWindow: number;
  windowStartedAt: number;
}

const HEARTBEAT_TIMEOUT_MS = 45_000;
const AI_THINK_DELAY_MS = 700;
const ABANDONED_ROOM_GRACE_MS = 45_000;
const ROOM_IDLE_TIMEOUT_MS = 4 * 60 * 60_000;

export class GameWebSocketServer {
  private readonly wss: WsServer;
  private readonly http: Server;
  private closePromise?: Promise<void>;
  public readonly ready: Promise<void>;
  private readonly rooms = new RoomManager();
  private readonly game = new GameEngine();
  private readonly calibration = new BoardCalibrationStore();
  private readonly connections = new ConnectionManager();
  private readonly maintenanceTimer: NodeJS.Timeout;
  private readonly aiTimers = new Map<string, NodeJS.Timeout>();
  private closing = false;
  // The client-side code merely exposes this local tooling. The server remains
  // authoritative and refuses forced rolls in a production deployment.
  private readonly allowDebugDice = process.env.NODE_ENV !== 'production' && process.env.SKILLLUDO_ALLOW_DEBUG_DICE !== 'false';

  public constructor(port: number, private readonly sessions = new SessionManager(), readiness: () => Promise<void> = async () => {}) {
    this.http = createServer((request, response) => { void this.health(request, response, readiness); });
    this.http.requestTimeout = 10_000;
    this.http.headersTimeout = 10_000;
    this.wss = new WsServer({ server: this.http, maxPayload: 16 * 1024, perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => {
      this.http.once('listening', resolve);
      this.http.once('error', reject);
    });
    this.wss.on('connection', (socket, request) => this.onConnection(socket, request));
    this.wss.on('error', (error) => console.error('[WS_ERROR]', error));
    this.maintenanceTimer = setInterval(() => this.maintainRooms(), 10_000);
    this.http.listen(port);
  }

  public address(): string { return `ws://0.0.0.0:${this.port}`; }
  public get port(): number {
    const address = this.wss.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  public close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    clearInterval(this.maintenanceTimer);
    this.aiTimers.forEach((timer) => clearTimeout(timer));
    this.aiTimers.clear();
    const deadline = setTimeout(() => {
      this.wss.clients.forEach((socket) => socket.terminate());
      this.http.closeAllConnections();
    }, 5_000);
    try {
      const closed = new Promise<void>((resolve, reject) => this.wss.close((error) => error ? reject(error) : resolve()));
      this.wss.clients.forEach((socket) => socket.close(1012, 'Server restarting'));
      await Promise.all([closed, new Promise<void>((resolve, reject) => this.http.close((error) => error ? reject(error) : resolve()))]);
    } finally { clearTimeout(deadline); }
  }

  private async health(request: IncomingMessage, response: ServerResponse, readiness: () => Promise<void>): Promise<void> {
    const path = request.url?.split('?')[0];
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || !['/healthz', '/readyz'].includes(path ?? '')) {
      response.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    let ready = !this.closing;
    if (ready && path === '/readyz') {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([readiness(), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Readiness timeout')), 2_000); })]);
      } catch { ready = false; }
      finally { clearTimeout(deadline); }
    }
    response.writeHead(ready ? 200 : 503).end(JSON.stringify({ status: ready ? 'ok' : 'unavailable', revision: process.env.GIT_SHA ?? 'local' }));
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const context: ConnectionContext = { requestsInWindow: 0, windowStartedAt: Date.now() };
    console.info('[CONNECTION_OPEN]', request.socket.remoteAddress ?? 'unknown');
    socket.on('message', (raw) => { void this.onMessage(socket, context, raw); });
    socket.on('close', () => this.onClose(socket, context));
    socket.on('error', (error) => console.warn('[CONNECTION_ERROR]', error.message));
  }

  private async onMessage(socket: WebSocket, context: ConnectionContext, raw: RawData): Promise<void> {
    try {
      this.assertRateLimit(context);
      const message = this.parseMessage(raw);
      if (message.type === 'AUTH') {
        await this.authenticate(socket, context, message as ClientMessage<AuthData>);
        return;
      }
      if (message.type === 'REGISTER') {
        await this.register(socket, context, message as ClientMessage<AuthData>);
        return;
      }
      if (message.type === 'LOGIN') {
        await this.login(socket, context, message as ClientMessage<AuthData>);
        return;
      }
      if (!context.session) throw new GameError('UNAUTHORIZED');
      this.handleAuthenticated(socket, context.session, message);
    } catch (error) {
      this.sendError(socket, error);
    }
  }

  private async authenticate(socket: WebSocket, context: ConnectionContext, message: ClientMessage<AuthData>): Promise<void> {
    let session: Session;
    try {
      session = await this.sessions.authenticate(message.data);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'INVALID_SESSION' || !message.data.sessionId) throw error;
      const restored = await this.sessions.restorePersistentSession(message.data.sessionId, message.data.nickname);
      if (!restored) throw error;
      session = restored;
    }
    this.completeAuthentication(socket, context, session, message.requestId);
  }

  private async register(socket: WebSocket, context: ConnectionContext, message: ClientMessage<AuthData>): Promise<void> {
    const session = await this.sessions.register(message.data);
    this.completeAuthentication(socket, context, session, message.requestId);
  }

  private async login(socket: WebSocket, context: ConnectionContext, message: ClientMessage<AuthData>): Promise<void> {
    const session = await this.sessions.login(message.data);
    this.completeAuthentication(socket, context, session, message.requestId);
  }

  private completeAuthentication(socket: WebSocket, context: ConnectionContext, session: Session, requestId: string): void {
    context.session = session;
    this.connections.bind(session.playerId, socket);
    const room = (session.roomId ? this.rooms.getRoom(session.roomId) : undefined) ?? this.rooms.findActiveRoomByPlayer(session.playerId);
    session.roomId = room?.roomId;
    this.send(socket, 'AUTH_OK', {
      playerId: session.playerId,
      sessionId: session.sessionId,
      nickname: session.nickname,
      isAdmin: session.isAdmin,
      activeGames: this.activeGamesFor(session.playerId)
    }, requestId);
    this.send(socket, 'BOARD_CALIBRATION_DATA', this.calibration.getData());
  }

  private handleAuthenticated(socket: WebSocket, session: Session, message: ClientMessage): void {
    if (session.processedRequestIds.has(message.requestId)) {
      const room = session.roomId ? this.rooms.getRoom(session.roomId) : undefined;
      if (room) this.send(socket, 'GAME_STATE', this.game.getSnapshot(room), message.requestId);
      else this.sendError(socket, new GameError('DUPLICATE_REQUEST'));
      return;
    }
    session.processedRequestIds.add(message.requestId);
    // Bound memory while keeping enough recent IDs to suppress retransmits.
    if (session.processedRequestIds.size > 500) session.processedRequestIds.clear();

    const roomId = this.roomIdFrom(message.data);
    switch (message.type) {
      case 'CREATE_ROOM': this.createRoom(socket, session, message.requestId); break;
      case 'JOIN_ROOM': this.joinRoom(socket, session, roomId, message.requestId); break;
      case 'LEAVE_ROOM': this.leaveRoom(session, roomId); break;
      case 'QUICK_MATCH': throw new GameError('MATCHMAKING_DISABLED', '快速匹配暂未开放，请创建或加入好友房间');
      case 'CHAT_SEND': this.sendChat(socket, session, roomId, message.data, message.requestId); break;
      case 'READY': this.setReady(session, roomId, true, message.requestId); break;
      case 'CANCEL_READY': this.setReady(session, roomId, false, message.requestId); break;
      case 'SET_COLOR_PREFERENCE': {
        this.assertSessionRoom(session, roomId);
        const room = this.rooms.setColorPreference(roomId, session.playerId, isRecord(message.data) ? message.data.color : undefined);
        this.broadcastState(room, message.requestId);
        break;
      }
      case 'START_GAME': this.startGame(session, roomId, message.requestId); break;
      case 'ROLL_DICE': this.rollDice(session, roomId, message.data, message.requestId); break;
      case 'SELECT_DIE': this.selectDie(session, roomId, message.data, message.requestId); break;
      case 'COMMIT_MOVE': this.commitMove(session, roomId, message.data, message.requestId); break;
      case 'USE_SKILL': throw new GameError('SKILL_UNAVAILABLE', '本局尚未启用阵营技能');
      case 'SELECT_PIECE': {
        this.assertSessionRoom(session, roomId);
        const room = this.rooms.requireRoom(roomId);
        if (!isRecord(message.data) || message.data.rollId !== room.game?.rollId) throw new GameError('INVALID_DIE', '移动操作已过期');
        this.selectPiece(session, roomId, this.pieceIdFrom(message.data), message.requestId);
        break;
      }
      case 'PING': this.ping(socket, session, roomId, message.requestId); break;
      case 'RECONNECT': this.reconnect(socket, session, roomId, message.requestId); break;
      case 'CALIBRATION_OPEN': this.openCalibration(socket, session, message.data, message.requestId); break;
      case 'CALIBRATION_SAVE': this.saveCalibration(socket, session, message.data, message.requestId); break;
      case 'SET_AI_TAKEOVER': this.setAiTakeover(session, roomId, message.data, message.requestId); break;
      case 'EXIT_GAME': this.exitGame(socket, session, roomId, message.requestId); break;
      case 'REJOIN_GAME': this.reconnect(socket, session, roomId, message.requestId); break;
      default: throw new GameError('INVALID_MESSAGE');
    }
  }

  private createRoom(socket: WebSocket, session: Session, requestId: string): void {
    this.ensureNotInAnotherRoom(session);
    const room = this.rooms.createRoom(this.asPlayer(session));
    session.roomId = room.roomId;
    this.send(socket, 'ROOM_CREATED', this.game.getSnapshot(room), requestId);
    this.send(socket, 'ROOM_STATE', this.game.getSnapshot(room));
    this.broadcastSystem(room, `${session.nickname} 创建了房间`);
    this.log('ROOM_CREATE', room, session, requestId);
  }

  private joinRoom(socket: WebSocket, session: Session, roomId: string, requestId: string): void {
    if (session.roomId && session.roomId !== roomId) throw new GameError('NOT_IN_ROOM', '请先离开当前房间');
    const room = this.rooms.joinRoom(roomId, this.asPlayer(session));
    session.roomId = room.roomId;
    this.broadcast(room, 'PLAYER_JOINED', { playerId: session.playerId });
    this.broadcastSystem(room, `${session.nickname} 加入了房间`);
    this.broadcastState(room, requestId);
    this.sendChatHistory(socket, room);
    this.log('ROOM_JOIN', room, session, requestId);
  }

  private leaveRoom(session: Session, roomId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.leaveRoom(roomId, session.playerId);
    session.roomId = undefined;
    if (room) {
      this.broadcast(room, 'PLAYER_LEFT', { playerId: session.playerId });
      this.broadcastSystem(room, `${session.nickname} 离开了房间`);
      this.broadcastState(room);
      this.log('ROOM_LEAVE', room, session);
    }
  }

  private sendChat(socket: WebSocket, session: Session, roomId: string, data: unknown, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    const content = this.chatContentFrom(data);
    const recipientId = this.chatRecipientIdFrom(data);
    const adjustCommand = /^adjust\s+(.+)$/i.exec(content);
    if (adjustCommand) {
      if (recipientId) throw new GameError('INVALID_MESSAGE', '校准命令不能通过私信执行');
      this.assertAdmin(session);
      this.send(socket, 'BOARD_CALIBRATION_OPEN', this.calibration.describe(this.calibration.resolveKey(adjustCommand[1]), true), requestId);
      return;
    }
    const entry: ChatEntry = { kind: recipientId ? 'PRIVATE' : 'PUBLIC', content, timestamp: Date.now(), senderId: session.playerId, senderNickname: session.nickname };
    if (recipientId) {
      const recipient = room.players.find((player) => player.id === recipientId);
      if (!recipient) throw new GameError('NOT_IN_ROOM', '私信目标不在房间内');
      entry.recipientId = recipient.id;
      entry.recipientNickname = recipient.nickname;
      const message = this.message('CHAT_MESSAGE', entry, requestId);
      this.connections.send(session.playerId, message);
      if (recipient.id !== session.playerId) this.connections.send(recipient.id, message);
    } else {
      this.rooms.addChatEntry(room, entry);
      this.broadcast(room, 'CHAT_MESSAGE', entry, requestId);
    }
  }

  private setReady(session: Session, roomId: string, ready: boolean, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.setReady(roomId, session.playerId, ready);
    this.broadcast(room, 'PLAYER_READY_CHANGED', { playerId: session.playerId, ready }, requestId);
    this.broadcastSystem(room, `${session.nickname}${ready ? ' 已准备' : ' 取消准备'}`);
    this.broadcastState(room);
  }

  private startGame(session: Session, roomId: string, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    if (room.ownerId !== session.playerId) throw new GameError('NOT_ROOM_OWNER');
    this.game.startGame(room);
    const snapshot = this.game.getSnapshot(room);
    this.broadcast(room, 'GAME_START', snapshot, requestId);
    const aiNames = room.players.filter((player) => player.isBot).map((player) => player.nickname);
    if (aiNames.length) this.broadcastSystem(room, `${aiNames.join('、')} 已加入本局对战`);
    this.broadcastSystem(room, '房主已开始对局，祝各位旗开得胜！');
    this.broadcast(room, 'TURN_START', this.turnData(snapshot));
    this.scheduleAiTurn(room);
    this.log('GAME_START', room, session, requestId);
  }

  private rollDice(session: Session, roomId: string, data: unknown, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    this.assertManualControl(room, session.playerId);
    const debugDice = this.debugDiceFrom(data);
    if (debugDice !== undefined && !this.allowDebugDice) throw new GameError('INVALID_MESSAGE', '当前服务未开启调试点数');
    const result = this.game.rollDice(room, session.playerId, debugDice);
    this.broadcast(room, 'DICE_RESULT', result, requestId);
    this.broadcastState(room);
    this.scheduleAiTurn(room);
    this.log('ROLL_DICE', room, session, requestId, `dice=${result.diceChoices.join(',')}${debugDice ? ' debug' : ''}`);
  }

  private selectDie(session: Session, roomId: string, data: unknown, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    this.assertManualControl(room, session.playerId);
    if (!isRecord(data) || typeof data.dieIndex !== 'number' || typeof data.rollId !== 'number') throw new GameError('INVALID_DIE');
    const result = this.game.selectDie(room, session.playerId, data.dieIndex, data.rollId);
    this.broadcast(room, 'DIE_SELECTED', result, requestId);
    this.broadcastState(room);
    if (result.skipped) this.broadcast(room, 'TURN_START', this.turnData(this.game.getSnapshot(room)));
    this.scheduleAiTurn(room);
    this.log('SELECT_DIE', room, session, requestId, `index=${data.dieIndex} dice=${result.dice}`);
  }

  private selectPiece(session: Session, roomId: string, pieceId: string, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    this.assertManualControl(room, session.playerId);
    const result = this.game.selectPiece(room, session.playerId, pieceId);
    this.publishMove(room, result, requestId);
    this.log('MOVE_PIECE', room, session, requestId, `piece=${pieceId}`);
  }

  private commitMove(session: Session, roomId: string, data: unknown, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    this.assertManualControl(room, session.playerId);
    if (!isRecord(data) || typeof data.rollId !== 'number' || typeof data.optionId !== 'string'
      || (data.pieceId !== undefined && typeof data.pieceId !== 'string')) throw new GameError('INVALID_MESSAGE');
    const result = this.game.commitMove(room, session.playerId, { roomId, rollId: data.rollId, optionId: data.optionId, pieceId: data.pieceId as string | undefined });
    this.broadcast(room, 'DIE_SELECTED', result.selection, requestId);
    if (result.move) this.publishMove(room, result.move, requestId);
    else { this.broadcastState(room, requestId); this.scheduleAiTurn(room); }
  }

  private publishMove(room: Room, result: import('../protocol.js').MoveResult, requestId?: string): void {
    this.broadcast(room, 'MOVE_RESULT', result, requestId);
    const finalSnapshot = this.game.getSnapshot(room);
    if (room.status === 'FINISHED') {
      this.broadcast(room, 'GAME_OVER', finalSnapshot);
      setTimeout(() => {
        if (room.status === 'FINISHED') this.resetFinishedRoom(room);
      }, 6_000);
    } else {
      this.broadcastState(room);
      if (!result.extraTurn || result.playerFinished) this.broadcast(room, 'TURN_START', this.turnData(finalSnapshot));
      this.scheduleAiTurn(room);
    }
  }

  private ping(socket: WebSocket, session: Session, roomId: string, requestId: string): void {
    const room = roomId ? this.rooms.getRoom(roomId) : undefined;
    const player = room?.players.find((candidate) => candidate.id === session.playerId);
    if (player) {
      player.lastHeartbeatAt = Date.now();
      player.connected = true;
      player.disconnectedAt = undefined;
    }
    this.send(socket, 'PONG', { now: Date.now() }, requestId);
  }

  private reconnect(socket: WebSocket, session: Session, roomId: string, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    const player = room.players.find((candidate) => candidate.id === session.playerId);
    if (!player) throw new GameError('NOT_IN_ROOM');
    const wasControlled = player.aiControlled === true;
    player.connected = true;
    player.aiControlled = false;
    player.lastHeartbeatAt = Date.now();
    player.disconnectedAt = undefined;
    player.exitedAt = undefined;
    player.nickname = session.nickname;
    this.connections.bind(session.playerId, socket);
    this.send(socket, 'GAME_STATE', this.game.getSnapshot(room), requestId);
    this.sendChatHistory(socket, room);
    this.broadcast(room, 'PLAYER_RECONNECTED', { playerId: player.id });
    if (wasControlled) this.broadcastSystem(room, `${player.nickname} 已重连入局，AI托管结束`);
    this.broadcastState(room);
    this.send(socket, 'ACTIVE_GAMES', { games: this.activeGamesFor(session.playerId) });
  }

  private setAiTakeover(session: Session, roomId: string, data: unknown, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    if (room.status !== 'PLAYING') throw new GameError('INVALID_PHASE', '仅对局中可使用AI托管');
    const player = room.players.find((candidate) => candidate.id === session.playerId && !candidate.isBot);
    if (!player) throw new GameError('NOT_IN_ROOM');
    const enabled = isRecord(data) && data.enabled === true;
    if (player.aiControlled === enabled) return;
    player.aiControlled = enabled;
    this.broadcast(room, 'AI_TAKEOVER_CHANGED', { playerId: player.id, enabled }, requestId);
    this.broadcastSystem(room, `${player.nickname}${enabled ? ' 已开启AI托管' : ' 已取消AI托管'}`);
    this.broadcastState(room);
    if (enabled) this.scheduleAiTurn(room);
  }

  private exitGame(socket: WebSocket, session: Session, roomId: string, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    if (room.status !== 'PLAYING') throw new GameError('INVALID_PHASE', '当前没有进行中的对局');
    const player = room.players.find((candidate) => candidate.id === session.playerId && !candidate.isBot);
    if (!player) throw new GameError('NOT_IN_ROOM');
    player.connected = false;
    player.aiControlled = true;
    player.disconnectedAt = Date.now();
    player.exitedAt = Date.now();
    this.broadcastSystem(room, `${player.nickname} 已退出对局，由AI托管`);
    this.broadcastState(room);
    this.send(socket, 'GAME_EXITED', { roomId }, requestId);
    this.send(socket, 'ACTIVE_GAMES', { games: this.activeGamesFor(session.playerId) });
    this.scheduleAiTurn(room);
    this.finishIfNoHumans(room, true);
  }

  private openCalibration(socket: WebSocket, session: Session, data: unknown, requestId: string): void {
    this.assertAdmin(session);
    const key = isRecord(data) && typeof data.key === 'string' ? data.key : undefined;
    try {
      this.send(socket, 'BOARD_CALIBRATION_OPEN', this.calibration.describe(this.calibration.resolveKey(key), !!key), requestId);
    } catch {
      throw new GameError('INVALID_MESSAGE', '未知的棋盘校准编号');
    }
  }

  private saveCalibration(socket: WebSocket, session: Session, data: unknown, requestId: string): void {
    this.assertAdmin(session);
    if (!isRecord(data) || typeof data.key !== 'string' || typeof data.x !== 'number' || typeof data.y !== 'number') {
      throw new GameError('INVALID_MESSAGE', '校准坐标无效');
    }
    try {
      const saved = this.calibration.save(data.key, { x: data.x, y: data.y });
      // Everyone already in a match immediately adopts the corrected coordinate table.
      this.wss.clients.forEach((client) => this.send(client, 'BOARD_CALIBRATION_DATA', saved));
      const nextKey = data.single === true ? undefined : this.calibration.nextAfter(data.key);
      this.send(socket, 'BOARD_CALIBRATION_SAVED', {
        key: this.calibration.resolveKey(data.key),
        next: nextKey ? this.calibration.describe(nextKey, false) : undefined,
        complete: !nextKey
      }, requestId);
    } catch (error) {
      if (error instanceof GameError) throw error;
      throw new GameError('INVALID_MESSAGE', '校准坐标或编号无效');
    }
  }

  private onClose(socket: WebSocket, context: ConnectionContext): void {
    const session = context.session;
    if (!session) return;
    // A new socket may already have replaced this one during reconnect.
    if (!this.connections.isBoundTo(session.playerId, socket)) return;
    this.connections.unbind(session.playerId, socket);
    const room = session.roomId ? this.rooms.getRoom(session.roomId) : undefined;
    const player = room?.players.find((candidate) => candidate.id === session.playerId);
    if (room && player) {
      const newlyControlled = this.markDisconnected(player);
      this.broadcast(room, 'PLAYER_DISCONNECTED', { playerId: player.id });
      if (newlyControlled) this.broadcastSystem(room, `${player.nickname} 已断线，由AI托管`);
      this.broadcastState(room);
      this.scheduleAiTurn(room);
      this.log('DISCONNECT', room, session);
    }
  }

  private maintainRooms(): void {
    const now = Date.now();
    for (const room of this.rooms.getRooms()) {
      for (const player of room.players) {
        if (player.isBot) continue;
        if (player.connected && now - player.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          const newlyControlled = this.markDisconnected(player);
          this.broadcast(room, 'PLAYER_DISCONNECTED', { playerId: player.id });
          if (newlyControlled) this.broadcastSystem(room, `${player.nickname} 已断线，由AI托管`);
          this.scheduleAiTurn(room);
        }
      }
      this.finishIfNoHumans(room, false, now);
      if (room.status !== 'PLAYING' && now - room.lastActiveAt > ROOM_IDLE_TIMEOUT_MS) {
        this.rooms.destroyRoom(room.roomId);
        console.info('[ROOM_DESTROY]', room.roomId, 'idle');
      }
    }
  }

  private parseMessage(raw: RawData): ClientMessage {
    const text = raw.toString();
    if (text.length > 8_192) throw new GameError('INVALID_MESSAGE', '消息过大');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new GameError('INVALID_MESSAGE', '消息不是 JSON'); }
    if (!isRecord(parsed) || typeof parsed.type !== 'string' || typeof parsed.requestId !== 'string' || !isRecord(parsed.data)) {
      throw new GameError('INVALID_MESSAGE');
    }
    return parsed as unknown as ClientMessage;
  }

  private assertRateLimit(context: ConnectionContext): void {
    const now = Date.now();
    if (now - context.windowStartedAt > 1_000) {
      context.windowStartedAt = now;
      context.requestsInWindow = 0;
    }
    context.requestsInWindow += 1;
    if (context.requestsInWindow > 20) throw new GameError('INVALID_MESSAGE', '请求过于频繁');
  }

  private asPlayer(session: Session): Omit<Player, 'color' | 'ready'> {
    return { id: session.playerId, sessionId: session.sessionId, nickname: session.nickname, connected: true, lastHeartbeatAt: Date.now() };
  }
  private ensureNotInAnotherRoom(session: Session): void { if (session.roomId) throw new GameError('NOT_IN_ROOM', '请先离开当前房间'); }
  private assertSessionRoom(session: Session, roomId: string): void { if (!roomId || session.roomId !== roomId) throw new GameError('NOT_IN_ROOM'); }
  private assertAdmin(session: Session): void { if (!session.isAdmin) throw new GameError('UNAUTHORIZED', '仅 admin 账号可使用棋盘校准'); }
  private assertManualControl(room: Room, playerId: string): void {
    if (room.players.find((player) => player.id === playerId)?.aiControlled) throw new GameError('INVALID_PHASE', '当前由AI托管，请先取消托管');
  }
  private roomIdFrom(data: unknown): string { return isRecord(data) && typeof data.roomId === 'string' ? data.roomId.trim() : ''; }
  private pieceIdFrom(data: unknown): string { return isRecord(data) && typeof data.pieceId === 'string' ? data.pieceId : ''; }
  private chatContentFrom(data: unknown): string {
    const content = isRecord(data) && typeof data.content === 'string' ? data.content.replace(/[\u0000-\u001f]/g, ' ').trim() : '';
    if (!content || content.length > 200) throw new GameError('INVALID_MESSAGE', '聊天内容须为 1–200 个字符');
    return content;
  }
  private chatRecipientIdFrom(data: unknown): string | undefined {
    if (!isRecord(data) || typeof data.recipientId !== 'string') return undefined;
    const recipientId = data.recipientId.trim();
    return recipientId || undefined;
  }
  private debugDiceFrom(data: unknown): number | undefined {
    if (!isRecord(data) || !Object.prototype.hasOwnProperty.call(data, 'debugDice')) return undefined;
    const value = data.debugDice;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 6) {
      throw new GameError('INVALID_MESSAGE', '调试点数必须为 1–6');
    }
    return value;
  }
  private turnData(snapshot: GameSnapshot): object { return { currentPlayerId: snapshot.currentPlayerId, turnNumber: snapshot.turnNumber, phase: snapshot.phase }; }
  private send(socket: WebSocket, type: ServerMessage['type'], data: unknown, requestId?: string): void { this.connections.sendSocket(socket, this.message(type, data, requestId)); }
  private broadcast(room: Room, type: ServerMessage['type'], data: unknown, requestId?: string): void { this.connections.broadcast(room.players.map((player) => player.id), this.message(type, data, requestId)); }
  private broadcastState(room: Room, requestId?: string): void { this.broadcast(room, 'GAME_STATE', this.game.getSnapshot(room), requestId); }
  private broadcastSystem(room: Room, content: string): void {
    const entry: ChatEntry = { kind: 'SYSTEM', content, timestamp: Date.now() };
    this.rooms.addChatEntry(room, entry);
    this.broadcast(room, 'SYSTEM_MESSAGE', entry);
  }
  private sendChatHistory(socket: WebSocket, room: Room): void { this.send(socket, 'CHAT_HISTORY', { entries: room.chatHistory }); }
  private message(type: ServerMessage['type'], data: unknown, requestId?: string): ServerMessage { return { type, requestId, data, serverTime: Date.now() }; }
  private sendError(socket: WebSocket, error: unknown): void {
    const code = error instanceof GameError || error instanceof RoomError || error instanceof AuthError ? error.code : error instanceof Error && error.message === 'INVALID_SESSION' ? 'INVALID_SESSION' : 'INTERNAL_ERROR';
    const knownCode = Object.values(ErrorCode).includes(code as ErrorCode) ? code : 'INTERNAL_ERROR';
    const message = error instanceof Error ? error.message : '服务器异常';
    console.warn('[COMMAND_ERROR]', knownCode, message);
    this.send(socket, 'ERROR', { code: knownCode, message });
  }
  private log(event: string, room: Room, session: Session, requestId?: string, detail?: string): void {
    console.info(`[${event}] room=${room.roomId} player=${session.playerId} turn=${room.game?.turnNumber ?? 0} request=${requestId ?? '-'} ${detail ?? ''}`);
  }

  /** AI seats and human trustee seats share one authoritative turn runner. */
  private scheduleAiTurn(room: Room): void {
    if (this.closing) return;
    const game = room.game;
    const player = game ? room.players[game.currentPlayerIndex] : undefined;
    if (room.status !== 'PLAYING' || !game || !['WAIT_ROLL', 'WAIT_SELECT_DIE', 'WAIT_SELECT_PIECE'].includes(game.phase)
      || !player || (!player.isBot && !player.aiControlled) || this.aiTimers.has(room.roomId)) return;
    const timer = setTimeout(() => {
      this.aiTimers.delete(room.roomId);
      this.playAiTurn(room);
    }, AI_THINK_DELAY_MS);
    this.aiTimers.set(room.roomId, timer);
  }

  private playAiTurn(room: Room): void {
    if (this.closing) return;
    const game = room.game;
    const player = game ? room.players[game.currentPlayerIndex] : undefined;
    if (room.status !== 'PLAYING' || !game || !player || (!player.isBot && !player.aiControlled)
      || !['WAIT_ROLL', 'WAIT_SELECT_DIE', 'WAIT_SELECT_PIECE'].includes(game.phase)) return;
    try {
      let rolledDice: number | undefined;
      if (game.phase === 'WAIT_ROLL') {
        const diceResult = this.game.rollDice(room, player.id);
        this.broadcast(room, 'DICE_RESULT', { ...diceResult, ai: true, trustee: !player.isBot });
      } else if (game.phase === 'WAIT_SELECT_DIE') {
        const choice = this.game.selectDie(room, player.id, this.game.chooseAiDie(room, player.id), game.rollId);
        rolledDice = choice.dice;
        this.broadcast(room, 'DIE_SELECTED', choice);
      } else if (game.phase === 'WAIT_SELECT_PIECE') {
        const pieceId = this.game.chooseAiPiece(room, player.id);
        if (pieceId) {
          const move = this.game.selectPiece(room, player.id, pieceId);
          this.broadcast(room, 'MOVE_RESULT', { ...move, ai: true, trustee: !player.isBot });
        }
      }

      const snapshot = this.game.getSnapshot(room);
      if (this.isFinishedRoom(room)) {
        this.broadcast(room, 'GAME_OVER', snapshot);
        setTimeout(() => {
          if (room.status === 'FINISHED') this.resetFinishedRoom(room);
        }, 6_000);
        return;
      }
      this.broadcastState(room);
      this.broadcast(room, 'TURN_START', this.turnData(snapshot));
      this.scheduleAiTurn(room);
      console.info(`[AI_PLAY] room=${room.roomId} player=${player.id} dice=${rolledDice ?? game.dice ?? '-'}`);
    } catch (error) {
      console.warn('[AI_PLAY_ERROR]', room.roomId, error);
    }
  }

  private markDisconnected(player: Player): boolean {
    const newlyControlled = player.aiControlled !== true;
    player.connected = false;
    player.aiControlled = true;
    player.disconnectedAt ??= Date.now();
    return newlyControlled;
  }

  private activeGamesFor(playerId: string): object[] {
    const room = this.rooms.findActiveRoomByPlayer(playerId);
    if (!room) return [];
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) return [];
    return [{ roomId: room.roomId, color: player.color, turnNumber: room.game?.turnNumber ?? 0, playerCount: room.players.length, status: room.status }];
  }

  private finishIfNoHumans(room: Room, immediate: boolean, now = Date.now()): void {
    if (room.status !== 'PLAYING') return;
    const humans = room.players.filter((player) => !player.isBot);
    if (humans.some((player) => player.connected)) return;
    if (!immediate && humans.some((player) => !player.disconnectedAt || now - player.disconnectedAt < ABANDONED_ROOM_GRACE_MS)) return;
    const timer = this.aiTimers.get(room.roomId);
    if (timer) clearTimeout(timer);
    this.aiTimers.delete(room.roomId);
    if (room.game) {
      room.game.phase = 'GAME_OVER';
      room.game.dice = null;
      room.game.movablePieceIds = [];
    }
    room.status = 'FINISHED';
    this.broadcastSystem(room, '房间中已无真人玩家，本场对局自动结束');
    this.broadcast(room, 'GAME_OVER', this.game.getSnapshot(room));
    this.sessions.clearRoomForPlayers(humans.map((player) => player.id), room.roomId);
    humans.forEach((player) => this.connections.send(player.id, this.message('ACTIVE_GAMES', { games: [] })));
    const cleanup = setTimeout(() => this.rooms.destroyRoom(room.roomId), 2_000);
    cleanup.unref();
  }

  private resetFinishedRoom(room: Room): void {
    const previousHumanIds = room.players.filter((player) => !player.isBot).map((player) => player.id);
    this.rooms.resetFinishedRoom(room);
    const retainedIds = new Set(room.players.map((player) => player.id));
    this.sessions.clearRoomForPlayers(previousHumanIds.filter((id) => !retainedIds.has(id)), room.roomId);
    if (room.players.length === 0) this.rooms.destroyRoom(room.roomId);
    else this.broadcastState(room);
  }

  /** Keeps the status check out of a narrowed AI-turn branch after a move. */
  private isFinishedRoom(room: Room): boolean { return room.status === 'FINISHED'; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
