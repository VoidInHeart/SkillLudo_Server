import type { ChatEntry, GameState, PlayerColor, RoomMode, RoomStatus } from '../protocol.js';

export interface Player {
  id: string;
  sessionId: string;
  nickname: string;
  avatarUrl?: string;
  color: PlayerColor;
  preferredColor?: PlayerColor | null;
  isBot?: boolean;
  aiControlled?: boolean;
  ready: boolean;
  connected: boolean;
  lastHeartbeatAt: number;
  disconnectedAt?: number;
  exitedAt?: number;
  spectating?: boolean;
}

export interface Room {
  roomId: string;
  ownerId: string;
  status: RoomStatus;
  mode?: RoomMode;
  players: Player[];
  spectators?: Player[];
  game?: GameState;
  createdAt: number;
  lastActiveAt: number;
  chatHistory: ChatEntry[];
}

/** Only players participate in turn order; membership also includes two spectator seats. */
export function roomMembers(room: Room): Player[] { return room.players.concat(room.spectators ?? []); }
