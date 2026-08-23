import { WebSocketServer as WsServer, type RawData, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { GameEngine, GameError } from '../game/GameEngine.js';
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
const AUTO_PLAY_DELAY_MS = 30_000;
const ROOM_IDLE_TIMEOUT_MS = 4 * 60 * 60_000;

export class GameWebSocketServer {
  private readonly wss: WsServer;
  public readonly ready: Promise<void>;
  private readonly rooms = new RoomManager();
  private readonly game = new GameEngine();
  private readonly connections = new ConnectionManager();
  private readonly maintenanceTimer: NodeJS.Timeout;

  public constructor(port: number, private readonly sessions = new SessionManager()) {
    this.wss = new WsServer({ port });
    this.ready = new Promise((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
    this.wss.on('connection', (socket, request) => this.onConnection(socket, request));
    this.wss.on('error', (error) => console.error('[WS_ERROR]', error));
    this.maintenanceTimer = setInterval(() => this.maintainRooms(), 10_000);
  }

  public address(): string { return `ws://0.0.0.0:${this.port}`; }
  public get port(): number {
    const address = this.wss.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  public async close(): Promise<void> {
    clearInterval(this.maintenanceTimer);
    await new Promise<void>((resolve, reject) => this.wss.close((error) => error ? reject(error) : resolve()));
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
    const room = session.roomId ? this.rooms.getRoom(session.roomId) : undefined;
    if (room) {
      const player = room.players.find((candidate) => candidate.id === session.playerId);
      if (player) {
        player.connected = true;
        player.lastHeartbeatAt = Date.now();
        player.disconnectedAt = undefined;
        player.nickname = session.nickname;
        this.broadcast(room, 'PLAYER_RECONNECTED', { playerId: player.id });
      }
    }
    this.send(socket, 'AUTH_OK', { playerId: session.playerId, sessionId: session.sessionId, nickname: session.nickname }, requestId);
    if (room) {
      this.send(socket, 'GAME_STATE', this.game.getSnapshot(room));
      this.sendChatHistory(socket, room);
    }
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
      case 'QUICK_MATCH': this.quickMatch(socket, session, message.requestId); break;
      case 'CHAT_SEND': this.sendChat(socket, session, roomId, message.data, message.requestId); break;
      case 'READY': this.setReady(session, roomId, true, message.requestId); break;
      case 'CANCEL_READY': this.setReady(session, roomId, false, message.requestId); break;
      case 'START_GAME': this.startGame(session, roomId, message.requestId); break;
      case 'ROLL_DICE': this.rollDice(session, roomId, message.requestId); break;
      case 'SELECT_PIECE': this.selectPiece(session, roomId, this.pieceIdFrom(message.data), message.requestId); break;
      case 'PING': this.ping(socket, session, roomId, message.requestId); break;
      case 'RECONNECT': this.reconnect(socket, session, roomId, message.requestId); break;
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

  private quickMatch(socket: WebSocket, session: Session, requestId: string): void {
    this.ensureNotInAnotherRoom(session);
    const target = this.rooms.findMatchRoom();
    if (!target) {
      const room = this.rooms.createRoom(this.asPlayer(session));
      session.roomId = room.roomId;
      this.send(socket, 'ROOM_CREATED', this.game.getSnapshot(room), requestId);
      this.broadcastSystem(room, `${session.nickname} 创建了快速匹配房间`);
      this.log('QUICK_MATCH_CREATE', room, session, requestId);
      return;
    }
    const room = this.rooms.joinRoom(target.roomId, this.asPlayer(session));
    session.roomId = room.roomId;
    this.broadcast(room, 'PLAYER_JOINED', { playerId: session.playerId });
    this.broadcastSystem(room, `${session.nickname} 通过快速匹配加入房间`);
    this.broadcastState(room, requestId);
    this.sendChatHistory(socket, room);
    this.log('QUICK_MATCH_JOIN', room, session, requestId);
  }

  private sendChat(socket: WebSocket, session: Session, roomId: string, data: unknown, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    const content = this.chatContentFrom(data);
    const recipientId = this.chatRecipientIdFrom(data);
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
    this.broadcastSystem(room, '房主已开始对局，祝各位旗开得胜！');
    this.broadcast(room, 'TURN_START', this.turnData(snapshot));
    this.log('GAME_START', room, session, requestId);
  }

  private rollDice(session: Session, roomId: string, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    const result = this.game.rollDice(room, session.playerId);
    this.broadcast(room, 'DICE_RESULT', { playerId: session.playerId, ...result }, requestId);
    this.broadcastState(room);
    const snapshot = this.game.getSnapshot(room);
    if (result.skipped) this.broadcast(room, 'TURN_START', this.turnData(snapshot));
    this.log('ROLL_DICE', room, session, requestId, `dice=${result.dice}`);
  }

  private selectPiece(session: Session, roomId: string, pieceId: string, requestId: string): void {
    this.assertSessionRoom(session, roomId);
    const room = this.rooms.requireRoom(roomId);
    const result = this.game.selectPiece(room, session.playerId, pieceId);
    this.broadcast(room, 'MOVE_RESULT', result, requestId);
    const finalSnapshot = this.game.getSnapshot(room);
    if (room.status === 'FINISHED') {
      this.broadcast(room, 'GAME_OVER', finalSnapshot);
      setTimeout(() => {
        if (room.status === 'FINISHED') {
          this.rooms.resetFinishedRoom(room);
          this.broadcastState(room);
        }
      }, 6_000);
    } else {
      this.broadcastState(room);
      if (!result.extraTurn || result.playerFinished) this.broadcast(room, 'TURN_START', this.turnData(finalSnapshot));
    }
    this.log('MOVE_PIECE', room, session, requestId, `piece=${pieceId}`);
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
    player.connected = true;
    player.lastHeartbeatAt = Date.now();
    player.disconnectedAt = undefined;
    this.connections.bind(session.playerId, socket);
    this.send(socket, 'GAME_STATE', this.game.getSnapshot(room), requestId);
    this.sendChatHistory(socket, room);
    this.broadcast(room, 'PLAYER_RECONNECTED', { playerId: player.id });
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
      this.markDisconnected(player);
      this.broadcast(room, 'PLAYER_DISCONNECTED', { playerId: player.id });
      this.broadcastState(room);
      this.log('DISCONNECT', room, session);
    }
  }

  private maintainRooms(): void {
    const now = Date.now();
    for (const room of this.rooms.getRooms()) {
      for (const player of room.players) {
        if (player.connected && now - player.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          this.markDisconnected(player);
          this.broadcast(room, 'PLAYER_DISCONNECTED', { playerId: player.id });
        }
      }
      this.autoPlayDisconnectedTurn(room, now);
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

  /** A disconnected current player is advanced by a deliberately simple server-side trustee. */
  private autoPlayDisconnectedTurn(room: Room, now: number): void {
    if (room.status !== 'PLAYING' || !room.game || room.game.phase !== 'WAIT_ROLL') return;
    const player = room.players[room.game.currentPlayerIndex];
    if (!player || player.connected || !player.disconnectedAt || now - player.disconnectedAt < AUTO_PLAY_DELAY_MS) return;
    try {
      const diceResult = this.game.rollDice(room, player.id);
      this.broadcast(room, 'DICE_RESULT', { playerId: player.id, ...diceResult, trustee: true });
      if (!diceResult.skipped && diceResult.movablePieceIds[0]) {
        const move = this.game.selectPiece(room, player.id, diceResult.movablePieceIds[0]);
        this.broadcast(room, 'MOVE_RESULT', { ...move, trustee: true });
      }
      const snapshot = this.game.getSnapshot(room);
      if (snapshot.roomStatus === 'FINISHED') {
        this.broadcast(room, 'GAME_OVER', snapshot);
        setTimeout(() => {
          if (room.status === 'FINISHED') {
            this.rooms.resetFinishedRoom(room);
            this.broadcastState(room);
          }
        }, 6_000);
      } else {
        this.broadcastState(room);
        this.broadcast(room, 'TURN_START', this.turnData(this.game.getSnapshot(room)));
      }
      console.info(`[AUTO_PLAY] room=${room.roomId} player=${player.id}`);
    } catch (error) {
      console.warn('[AUTO_PLAY_ERROR]', room.roomId, error);
    }
  }

  private markDisconnected(player: Player): void {
    player.connected = false;
    player.disconnectedAt ??= Date.now();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
