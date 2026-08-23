import type { ChatEntry, GameState, PlayerColor, RoomStatus } from '../protocol.js';

export interface Player {
  id: string;
  sessionId: string;
  nickname: string;
  avatarUrl?: string;
  color: PlayerColor;
  ready: boolean;
  connected: boolean;
  lastHeartbeatAt: number;
  disconnectedAt?: number;
}

export interface Room {
  roomId: string;
  ownerId: string;
  status: RoomStatus;
  players: Player[];
  game?: GameState;
  createdAt: number;
  lastActiveAt: number;
  chatHistory: ChatEntry[];
}
