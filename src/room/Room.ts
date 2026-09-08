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
}

export interface Room {
  roomId: string;
  ownerId: string;
  status: RoomStatus;
  mode?: RoomMode;
  players: Player[];
  game?: GameState;
  createdAt: number;
  lastActiveAt: number;
  chatHistory: ChatEntry[];
}
