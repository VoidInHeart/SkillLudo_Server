/** Wire types. Keep this file dependency-free so it can be mirrored by a Cocos client. */
export type PlayerColor = 'RED' | 'YELLOW' | 'BLUE' | 'GREEN';
export type PieceState = 'AIRPORT' | 'MAIN_PATH' | 'FINAL_PATH' | 'FINISHED';
export type RoomStatus = 'WAITING' | 'PLAYING' | 'FINISHED';
export type GamePhase = 'WAIT_ROLL' | 'WAIT_SELECT_PIECE' | 'RESOLVING_MOVE' | 'GAME_OVER';

export interface ClientMessage<T = unknown> {
  type: ClientMessageType;
  requestId: string;
  data: T;
}

export type ClientMessageType =
  | 'AUTH' | 'REGISTER' | 'LOGIN' | 'CREATE_ROOM' | 'JOIN_ROOM' | 'LEAVE_ROOM'
  | 'QUICK_MATCH' | 'CHAT_SEND'
  | 'READY' | 'CANCEL_READY' | 'START_GAME'
  | 'ROLL_DICE' | 'SELECT_PIECE' | 'PING' | 'RECONNECT'
  | 'CALIBRATION_OPEN' | 'CALIBRATION_SAVE';

export interface ServerMessage<T = unknown> {
  type: ServerMessageType;
  requestId?: string;
  data: T;
  serverTime: number;
}

export type ServerMessageType =
  | 'AUTH_OK' | 'ROOM_CREATED' | 'ROOM_STATE'
  | 'PLAYER_JOINED' | 'PLAYER_LEFT' | 'PLAYER_READY_CHANGED'
  | 'CHAT_MESSAGE' | 'CHAT_HISTORY' | 'SYSTEM_MESSAGE'
  | 'GAME_START' | 'TURN_START' | 'DICE_RESULT' | 'MOVABLE_PIECES'
  | 'MOVE_RESULT' | 'GAME_STATE' | 'PLAYER_DISCONNECTED'
  | 'PLAYER_RECONNECTED' | 'GAME_OVER' | 'ERROR' | 'PONG'
  | 'BOARD_CALIBRATION_DATA' | 'BOARD_CALIBRATION_OPEN' | 'BOARD_CALIBRATION_SAVED';

export enum ErrorCode {
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  ROOM_NOT_FOUND = 'ROOM_NOT_FOUND',
  ROOM_FULL = 'ROOM_FULL',
  ROOM_ALREADY_STARTED = 'ROOM_ALREADY_STARTED',
  NOT_IN_ROOM = 'NOT_IN_ROOM',
  NOT_ROOM_OWNER = 'NOT_ROOM_OWNER',
  NOT_READY = 'NOT_READY',
  NOT_YOUR_TURN = 'NOT_YOUR_TURN',
  INVALID_PHASE = 'INVALID_PHASE',
  INVALID_PIECE = 'INVALID_PIECE',
  PIECE_NOT_MOVABLE = 'PIECE_NOT_MOVABLE',
  INVALID_SESSION = 'INVALID_SESSION',
  USERNAME_TAKEN = 'USERNAME_TAKEN',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE',
  DUPLICATE_REQUEST = 'DUPLICATE_REQUEST',
  INTERNAL_ERROR = 'INTERNAL_ERROR'
}

export interface BoardPosition { x: number; y: number; }
export interface BoardCalibrationData {
  version: number;
  positions: Record<string, BoardPosition>;
  completed: string[];
  sequence: string[];
}

export interface PlayerPublicState {
  id: string;
  nickname: string;
  avatarUrl?: string;
  color: PlayerColor;
  isBot?: boolean;
  ready: boolean;
  connected: boolean;
}

export interface Piece {
  id: string;
  playerId: string;
  color: PlayerColor;
  state: PieceState;
  /** -1 at the airport; otherwise 0–57 along the owner-specific route. */
  progress: number;
}

export interface GameState {
  currentPlayerIndex: number;
  phase: GamePhase;
  dice: number | null;
  pieces: Piece[];
  movablePieceIds: string[];
  rankings: string[];
  turnNumber: number;
}

export interface GameSnapshot {
  roomId: string;
  roomStatus: RoomStatus;
  ownerId: string;
  players: PlayerPublicState[];
  currentPlayerId: string | null;
  phase: GamePhase | null;
  dice: number | null;
  pieces: Piece[];
  movablePieceIds: string[];
  rankings: string[];
  turnNumber: number;
}

export type ChatKind = 'PUBLIC' | 'PRIVATE' | 'SYSTEM';
export interface ChatEntry {
  kind: ChatKind;
  content: string;
  timestamp: number;
  senderId?: string;
  senderNickname?: string;
  recipientId?: string;
  recipientNickname?: string;
}

export interface MoveResult {
  pieceId: string;
  fromProgress: number;
  toProgress: number;
  /** Progress points after each visual step, including jump/flight steps. */
  path: number[];
  tookOff: boolean;
  jumped: boolean;
  usedFlightPath: boolean;
  killedPieceIds: string[];
  reachedFinish: boolean;
  playerFinished: boolean;
  extraTurn: boolean;
}

export interface AuthData {
  sessionId?: string;
  guestId?: string;
  username?: string;
  password?: string;
  nickname?: string;
}
