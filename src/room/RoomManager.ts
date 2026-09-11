import { randomInt } from 'node:crypto';
import type { ChatEntry, PlayerColor } from '../protocol.js';
import type { Player, Room } from './Room.js';
import { roomMembers } from './Room.js';

const colors: PlayerColor[] = ['RED', 'YELLOW', 'BLUE', 'GREEN'];

export class RoomError extends Error {
  public constructor(public readonly code: string, message = code) { super(message); }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  public createRoom(player: Omit<Player, 'color' | 'ready'>): Room {
    const roomId = this.generateRoomId();
    const owner = { ...player, color: colors[0], ready: false };
    const room: Room = { roomId, ownerId: owner.id, status: 'WAITING', mode: 'PRIVATE', players: [owner], createdAt: Date.now(), lastActiveAt: Date.now(), chatHistory: [] };
    this.rooms.set(roomId, room);
    return room;
  }

  public joinRoom(roomId: string, player: Omit<Player, 'color' | 'ready'>): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', '房间不存在');
    if (room.status === 'FINISHED') throw new RoomError('ROOM_ALREADY_STARTED', '请等待房间返回大厅');
    const existing = roomMembers(room).find((candidate) => candidate.id === player.id);
    if (existing) {
      existing.connected = true;
      existing.lastHeartbeatAt = Date.now();
      return room;
    }
    if (room.status === 'PLAYING' || room.players.length >= 4) {
      if ((room.spectators?.length ?? 0) >= 2) throw new RoomError('ROOM_FULL', '4 个对局席和 2 个观战席已满');
      (room.spectators ??= []).push({ ...player, color: 'RED', ready: false, spectating: true });
    } else {
      const availableColor = colors.find((color) => !room.players.some((seat) => seat.color === color))!;
      room.players.push({ ...player, color: availableColor, ready: false, spectating: false });
    }
    this.touch(room);
    return room;
  }

  public leaveRoom(roomId: string, playerId: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const spectator = room.spectators?.some((player) => player.id === playerId);
    if (spectator) room.spectators = room.spectators!.filter((player) => player.id !== playerId);
    if (room.status === 'PLAYING') {
      const player = room.players.find((candidate) => candidate.id === playerId);
      if (player) { player.connected = false; if (!room.game?.lifecycle?.pause) player.aiControlled = true; player.disconnectedAt ??= Date.now(); }
      this.touch(room);
      return room;
    }
    room.players = room.players.filter((player) => player.id !== playerId);
    if (room.ownerId === playerId && roomMembers(room)[0]) room.ownerId = roomMembers(room)[0].id;
    if (roomMembers(room).length === 0) this.rooms.delete(roomId);
    else this.touch(room);
    return room;
  }

  public setReady(roomId: string, playerId: string, ready: boolean): Room {
    const room = this.requireRoom(roomId);
    if (room.status !== 'WAITING') throw new RoomError('ROOM_ALREADY_STARTED');
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new RoomError('NOT_IN_ROOM');
    player.ready = ready;
    this.touch(room);
    return room;
  }

  public setColorPreference(roomId: string, playerId: string, preference: unknown): Room {
    const room = this.requireRoom(roomId);
    if (room.status !== 'WAITING') throw new RoomError('ROOM_ALREADY_STARTED');
    if (room.mode === 'MATCHMAKING') throw new RoomError('INVALID_PHASE');
    if (preference !== null && preference !== 'SPECTATOR' && !colors.includes(preference as PlayerColor)) throw new RoomError('INVALID_MESSAGE', '请选择有效阵营、不限或观战');
    const player = roomMembers(room).find((candidate) => candidate.id === playerId);
    if (!player) throw new RoomError('NOT_IN_ROOM');
    if (preference === 'SPECTATOR') {
      if (!player.spectating) {
        if ((room.spectators?.length ?? 0) >= 2) throw new RoomError('ROOM_FULL', '观战席已满（2 人）');
        room.players = room.players.filter((candidate) => candidate.id !== playerId);
        (room.spectators ??= []).push(player); player.spectating = true;
      }
      player.preferredColor = null; player.ready = false; this.touch(room); return room;
    }
    if (player.spectating) {
      if (room.players.length >= 4) throw new RoomError('ROOM_FULL', '对局席已满（4 人）');
      room.spectators = room.spectators!.filter((candidate) => candidate.id !== playerId);
      player.color = colors.find((color) => !room.players.some((seat) => seat.color === color))!;
      player.spectating = false; room.players.push(player);
    }
    player.preferredColor = preference as PlayerColor | null;
    player.ready = false;
    this.touch(room);
    return room;
  }

  public resetFinishedRoom(room: Room): void {
    room.status = 'WAITING';
    room.game = undefined;
    // AI seats belong to a single match. The next lobby should show only the
    // real players who can ready up, then refill empty seats at game start.
    room.players = room.players.filter((player) => !player.isBot && player.connected);
    room.spectators = room.spectators?.filter((player) => player.connected);
    room.players.forEach((player) => { player.ready = false; player.aiControlled = false; });
    if (!roomMembers(room).some((player) => player.id === room.ownerId) && roomMembers(room)[0]) room.ownerId = roomMembers(room)[0].id;
    this.touch(room);
  }

  public findMatchRoom(): Room | undefined {
    return [...this.rooms.values()]
      .filter((room) => room.mode === 'MATCHMAKING' && room.status === 'WAITING' && room.players.length < 4)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
  }

  public addChatEntry(room: Room, entry: ChatEntry): void {
    room.chatHistory.push(entry);
    if (room.chatHistory.length > 80) room.chatHistory.splice(0, room.chatHistory.length - 80);
    this.touch(room);
  }

  public getRoom(roomId: string): Room | undefined { return this.rooms.get(roomId); }
  public findActiveRoomByPlayer(playerId: string): Room | undefined {
    return [...this.rooms.values()].find((room) => room.status === 'PLAYING' && roomMembers(room).some((player) => player.id === playerId && !player.isBot));
  }
  public getRooms(): Iterable<Room> { return this.rooms.values(); }
  public destroyRoom(roomId: string): void { this.rooms.delete(roomId); }
  public requireRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND');
    return room;
  }

  private touch(room: Room): void { room.lastActiveAt = Date.now(); }
  private generateRoomId(): string {
    for (let tries = 0; tries < 100; tries += 1) {
      const id = randomInt(100000, 1000000).toString();
      if (!this.rooms.has(id)) return id;
    }
    throw new RoomError('INTERNAL_ERROR', '暂时无法分配房间号');
  }
}
