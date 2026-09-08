/** Wire types. Keep this file dependency-free so it can be mirrored by a Cocos client. */
export type PlayerColor = 'RED' | 'YELLOW' | 'BLUE' | 'GREEN';
export type PieceState = 'AIRPORT' | 'MAIN_PATH' | 'FINAL_PATH' | 'FINISHED';
export type RoomStatus = 'WAITING' | 'PLAYING' | 'FINISHED';
export const PROTOCOL_VERSION = 2;
export type GamePhase = 'WAIT_ROLL' | 'WAIT_SELECT_DIE' | 'WAIT_SELECT_PIECE' | 'RESOLVING_MOVE' | 'GAME_OVER';
export type DicePair = [number, number];
export type RoomMode = 'PRIVATE' | 'MATCHMAKING';

export interface ClientMessage<T = unknown> {
  type: ClientMessageType;
  requestId: string;
  data: T;
}

export type ClientMessageType =
  | 'AUTH' | 'REGISTER' | 'LOGIN' | 'CREATE_ROOM' | 'JOIN_ROOM' | 'LEAVE_ROOM'
  | 'QUICK_MATCH' | 'CHAT_SEND'
  | 'READY' | 'CANCEL_READY' | 'START_GAME' | 'SET_COLOR_PREFERENCE'
  | 'ROLL_DICE' | 'SELECT_DIE' | 'SELECT_PIECE' | 'USE_SKILL' | 'PING' | 'RECONNECT'
  | 'CALIBRATION_OPEN' | 'CALIBRATION_SAVE'
  | 'SET_AI_TAKEOVER' | 'EXIT_GAME' | 'REJOIN_GAME';

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
  | 'GAME_START' | 'TURN_START' | 'DICE_RESULT' | 'DIE_SELECTED' | 'MOVABLE_PIECES'
  | 'MOVE_RESULT' | 'GAME_STATE' | 'PLAYER_DISCONNECTED'
  | 'PLAYER_RECONNECTED' | 'GAME_OVER' | 'ERROR' | 'PONG'
  | 'BOARD_CALIBRATION_DATA' | 'BOARD_CALIBRATION_OPEN' | 'BOARD_CALIBRATION_SAVED'
  | 'AI_TAKEOVER_CHANGED' | 'GAME_EXITED' | 'ACTIVE_GAMES';

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
  INVALID_DIE = 'INVALID_DIE',
  MATCHMAKING_DISABLED = 'MATCHMAKING_DISABLED',
  SKILL_UNAVAILABLE = 'SKILL_UNAVAILABLE',
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

export interface BoardCalibrationOpen {
  key: string;
  index: number;
  total: number;
  position?: BoardPosition;
  single: boolean;
}

export interface ErrorPayload { code: string; message: string; }

export interface PlayerPublicState {
  id: string;
  nickname: string;
  avatarUrl?: string;
  color: PlayerColor;
  preferredColor?: PlayerColor | null;
  isBot?: boolean;
  aiControlled?: boolean;
  ready: boolean;
  connected: boolean;
}

export interface ActiveGameSummary {
  roomId: string;
  color: PlayerColor;
  turnNumber: number;
  playerCount: number;
  status: RoomStatus;
}

export interface Piece {
  id: string;
  playerId: string;
  color: PlayerColor;
  state: PieceState;
  /** -1 at airport, 0 takeoff, 1–50 shared ring, 51–56 private runway. */
  progress: number;
}

export interface GameState {
  currentPlayerIndex: number;
  phase: GamePhase;
  dice: number | null;
  diceChoices: DicePair | null;
  selectedDieIndex: number | null;
  rollId: number;
  pieces: Piece[];
  movablePieceIds: string[];
  rankings: string[];
  turnNumber: number;
}

export interface GameSnapshot {
  protocolVersion: number;
  roomId: string;
  roomStatus: RoomStatus;
  roomMode: RoomMode;
  ownerId: string;
  players: PlayerPublicState[];
  currentPlayerId: string | null;
  phase: GamePhase | null;
  dice: number | null;
  diceChoices: DicePair | null;
  selectedDieIndex: number | null;
  rollId: number;
  pieces: Piece[];
  movablePieceIds: string[];
  rankings: string[];
  turnNumber: number;
  movePreviews: Record<string, MoveResult>;
  skills: PlayerSkillState[];
}

export interface DiceResult { playerId: string; diceChoices: DicePair; rollId: number; }
export interface DieSelected {
  playerId: string;
  dieIndex: number;
  dice: number;
  rollId: number;
  movablePieceIds: string[];
  skipped: boolean;
  extraTurn: boolean;
}

export type SkillWindow = 'TURN_START' | 'DIE_SELECTED' | 'BEFORE_MOVE' | 'AFTER_MOVE';
export interface SkillCommand { roomId: string; skillId: string; targetPieceId?: string; rollId: number; }
export interface PlayerSkillState { playerId: string; skillId: string; charges: number; cooldownTurns: number; }

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
  segments: MoveSegment[];
  captures: Array<{ pieceId: string; atProgress: number }>;
  tookOff: boolean;
  jumped: boolean;
  usedFlightPath: boolean;
  killedPieceIds: string[];
  reachedFinish: boolean;
  playerFinished: boolean;
  extraTurn: boolean;
}

export interface MoveSegment {
  kind: 'WALK' | 'TAKEOFF' | 'JUMP' | 'FLIGHT';
  fromProgress: number;
  toProgress: number;
  path: number[];
}

export interface AuthData {
  sessionId?: string;
  guestId?: string;
  username?: string;
  password?: string;
  nickname?: string;
}
