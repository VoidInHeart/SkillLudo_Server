import { randomInt } from 'node:crypto';
import { PROTOCOL_VERSION, type DiceResult, type DieSelected, type GameSnapshot, type GameState, type MoveResult, type Piece, type PlayerColor } from '../protocol.js';
import type { Room } from '../room/Room.js';
import { GameRules } from './GameRules.js';
import { FINAL_PATH_START, MAIN_PATH_LENGTH, getBoardCell } from './PathData.js';
import { assignColors } from '../room/ColorAssignment.js';

const GAME_COLORS: PlayerColor[] = ['RED', 'YELLOW', 'BLUE', 'GREEN'];

export class GameError extends Error {
  public constructor(public readonly code: string, message = code) { super(message); }
}

export class GameEngine {
  public constructor(private readonly rules = new GameRules(), private readonly random = () => randomInt(0, 0x100000000) / 0x100000000) {}

  public startGame(room: Room): void {
    if (room.status !== 'WAITING') throw new GameError('INVALID_PHASE');
    const humanPlayers = room.players.filter((player) => !player.isBot);
    if (humanPlayers.length < 2) throw new GameError('NOT_READY', '至少需要两名玩家');
    if (!humanPlayers.every((player) => player.ready)) throw new GameError('NOT_READY', '所有玩家必须准备');
    this.fillAiSeats(room);
    // Colours are finalized only as the game begins, so every participant sees
    // one unambiguous colour assignment in the GAME_START snapshot.
    const assigned = assignColors(room.players, this.random, room.mode);
    room.players.forEach((player) => { player.color = assigned.get(player.id)!; });
    room.status = 'PLAYING';
    room.game = {
      currentPlayerIndex: 0,
      phase: 'WAIT_ROLL',
      dice: null,
      diceChoices: null,
      selectedDieIndex: null,
      rollId: 0,
      pieces: room.players.flatMap((player) => this.createPieces(player.id, player.color)),
      movablePieceIds: [],
      rankings: [],
      turnNumber: 1
    };
  }

  public rollDice(room: Room, playerId: string, forcedDice?: number): DiceResult {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_ROLL') throw new GameError('INVALID_PHASE');
    if (forcedDice !== undefined && (!Number.isInteger(forcedDice) || forcedDice < 1 || forcedDice > 6)) {
      throw new GameError('INVALID_PHASE', '点数必须为 1–6');
    }
    game.diceChoices = [forcedDice ?? Math.floor(this.random() * 6) + 1, Math.floor(this.random() * 6) + 1];
    game.dice = null;
    game.selectedDieIndex = null;
    game.movablePieceIds = [];
    game.rollId += 1;
    game.phase = 'WAIT_SELECT_DIE';
    return { playerId, diceChoices: [...game.diceChoices], rollId: game.rollId };
  }

  public selectDie(room: Room, playerId: string, dieIndex: number, rollId: number): DieSelected {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_DIE' || !game.diceChoices) throw new GameError('INVALID_PHASE');
    if ((dieIndex !== 0 && dieIndex !== 1) || rollId !== game.rollId) throw new GameError('INVALID_DIE', '骰子选择已失效，请选择本次投出的骰子');
    const dice = game.diceChoices[dieIndex];
    const movable = this.rules.getMovablePieces(game, playerId, dice);
    game.dice = dice;
    game.selectedDieIndex = dieIndex;
    game.movablePieceIds = movable.map((piece) => piece.id);
    if (movable.length === 0) {
      game.dice = null;
      game.phase = 'WAIT_ROLL';
      game.movablePieceIds = [];
      // A six earns another roll even when there is no legal plane to move.
      const extraTurn = dice === 6;
      if (!extraTurn) this.nextTurn(room);
      return { playerId, dieIndex, dice, rollId, movablePieceIds: [], skipped: true, extraTurn };
    }
    game.phase = 'WAIT_SELECT_PIECE';
    return { playerId, dieIndex, dice, rollId, movablePieceIds: [...game.movablePieceIds], skipped: false, extraTurn: dice === 6 };
  }

  public chooseAiDie(room: Room, playerId: string): number {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_DIE' || !game.diceChoices) throw new GameError('INVALID_PHASE');
    const scores = game.diceChoices.map((dice) => {
      const moves = this.rules.getMovablePieces(game, playerId, dice).map((piece) => this.rules.calculateMove(game, playerId, piece.id, dice));
      return moves.length ? Math.max(...moves.map((move) => (move.reachedFinish ? 100 : 0) + move.killedPieceIds.length * 30 + (move.tookOff ? 20 : 0) + (move.extraTurn ? 15 : 0) + move.toProgress - move.fromProgress)) : -1;
    });
    return scores[1] > scores[0] ? 1 : 0;
  }

  /** Chooses a server-side AI move without changing the game state. */
  public chooseAiPiece(room: Room, playerId: string): string | null {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_PIECE') return null;
    const movable = game.pieces.filter((piece) => piece.playerId === playerId && game.movablePieceIds.includes(piece.id));
    if (movable.length === 0) return null;

    // Launching a new aircraft always comes first when a 5/6 permits it.
    const takeoff = movable
      .filter((piece) => piece.state === 'AIRPORT')
      .sort((left, right) => pieceSequence(left.id) - pieceSequence(right.id) || left.id.localeCompare(right.id))[0];
    if (takeoff) return takeoff.id;

    // Until every plane has entered its final runway, keep advancing aircraft
    // still on the shared main route. Within that group, protect threatened
    // aircraft; the requested tie-breaker prefers the farthest enemy behind.
    const mainRoute = movable.filter((piece) => piece.state === 'MAIN_PATH' && piece.progress < FINAL_PATH_START);
    const candidates = mainRoute.length > 0 ? mainRoute : movable;
    const threatened = candidates
      .map((piece) => ({ piece, distance: this.threatDistance(game, piece) }))
      .filter((candidate): candidate is { piece: Piece; distance: number } => candidate.distance !== null);
    if (threatened.length > 0) {
      threatened.sort((left, right) => right.distance - left.distance || right.piece.progress - left.piece.progress || left.piece.id.localeCompare(right.piece.id));
      return threatened[0].piece.id;
    }
    return candidates.sort((left, right) => right.progress - left.progress || left.id.localeCompare(right.id))[0]?.id ?? null;
  }

  public selectPiece(room: Room, playerId: string, pieceId: string): MoveResult {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_PIECE' || game.dice === null) throw new GameError('INVALID_PHASE');
    if (!game.movablePieceIds.includes(pieceId)) throw new GameError('PIECE_NOT_MOVABLE');

    const result = this.rules.calculateMove(game, playerId, pieceId, game.dice);
    const piece = game.pieces.find((candidate) => candidate.id === pieceId);
    if (!piece) throw new GameError('INVALID_PIECE');
    game.phase = 'RESOLVING_MOVE';
    piece.progress = result.toProgress;
    piece.state = result.reachedFinish ? 'FINISHED' : result.toProgress >= FINAL_PATH_START ? 'FINAL_PATH' : 'MAIN_PATH';
    for (const killedId of result.killedPieceIds) {
      const killed = game.pieces.find((candidate) => candidate.id === killedId);
      if (killed) {
        killed.progress = -1;
        killed.state = 'AIRPORT';
      }
    }

    result.playerFinished = this.isPlayerFinished(game, playerId);
    if (result.playerFinished && !game.rankings.includes(playerId)) game.rankings.push(playerId);
    game.dice = null;
    game.movablePieceIds = [];

    // A complete squad wins immediately. The finished planes are rendered back
    // in their own airport with a distinct completion icon on the client.
    if (result.playerFinished) {
      game.phase = 'GAME_OVER';
      room.status = 'FINISHED';
      return result;
    }

    if (result.extraTurn && !result.playerFinished) {
      game.phase = 'WAIT_ROLL';
    } else {
      game.phase = 'WAIT_ROLL';
      this.nextTurn(room);
    }
    return result;
  }

  public getSnapshot(room: Room): GameSnapshot {
    const game = room.game;
    return {
      protocolVersion: PROTOCOL_VERSION,
      roomId: room.roomId,
      roomStatus: room.status,
      roomMode: room.mode ?? 'PRIVATE',
      ownerId: room.ownerId,
      players: room.players.map(({ id, nickname, avatarUrl, color, preferredColor, isBot, aiControlled, ready, connected }) => ({ id, nickname, avatarUrl, color, preferredColor: preferredColor ?? null, isBot, aiControlled, ready, connected })),
      currentPlayerId: game ? room.players[game.currentPlayerIndex]?.id ?? null : null,
      phase: game?.phase ?? null,
      dice: game?.dice ?? null,
      diceChoices: game?.diceChoices ? [...game.diceChoices] : null,
      selectedDieIndex: game?.selectedDieIndex ?? null,
      rollId: game?.rollId ?? 0,
      pieces: game?.pieces.map((piece) => ({ ...piece })) ?? [],
      movablePieceIds: [...(game?.movablePieceIds ?? [])],
      rankings: [...(game?.rankings ?? [])],
      turnNumber: game?.turnNumber ?? 0,
      movePreviews: game?.phase === 'WAIT_SELECT_PIECE' && game.dice !== null ? Object.fromEntries(game.movablePieceIds.map((id) => [id, this.rules.calculateMove(game, room.players[game.currentPlayerIndex].id, id, game.dice!)])) : {},
      skills: []
    };
  }

  private createPieces(playerId: string, color: PlayerColor): Piece[] {
    return Array.from({ length: 4 }, (_, index) => ({
      id: `${color.toLowerCase()}-${index + 1}`,
      playerId,
      color,
      state: 'AIRPORT' as const,
      progress: -1
    }));
  }

  private fillAiSeats(room: Room): void {
    for (let seat = room.players.length; seat < GAME_COLORS.length; seat += 1) {
      room.players.push({
        id: `ai_${room.roomId}_${seat + 1}`,
        sessionId: `ai_session_${room.roomId}_${seat + 1}`,
        nickname: `AI棋手 ${seat + 1}`,
        color: GAME_COLORS[seat],
        isBot: true,
        ready: true,
        connected: true,
        lastHeartbeatAt: Date.now()
      });
    }
  }

  /** Returns the forward main-track distance to a hostile aircraft that can roll onto this piece. */
  private threatDistance(game: GameState, target: Piece): number | null {
    if (target.state !== 'MAIN_PATH' || target.progress < 1 || target.progress >= FINAL_PATH_START) return null;
    const targetCell = getBoardCell(target.color, target.progress);
    if (!targetCell?.startsWith('M')) return null;
    const targetIndex = Number(targetCell.slice(1));
    const distances = game.pieces
      .filter((piece) => piece.playerId !== target.playerId && piece.state === 'MAIN_PATH' && piece.progress >= 1 && piece.progress < FINAL_PATH_START)
      .map((piece) => getBoardCell(piece.color, piece.progress))
      .filter((cell): cell is string => !!cell && cell.startsWith('M'))
      .map((cell) => (targetIndex - Number(cell.slice(1)) + MAIN_PATH_LENGTH) % MAIN_PATH_LENGTH)
      .filter((distance) => distance >= 1 && distance <= 6);
    return distances.length > 0 ? Math.max(...distances) : null;
  }

  private nextTurn(room: Room): void {
    const game = this.requireGame(room);
    for (let attempts = 0; attempts < room.players.length; attempts += 1) {
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % room.players.length;
      if (!game.rankings.includes(room.players[game.currentPlayerIndex].id)) break;
    }
    game.turnNumber += 1;
  }

  private isPlayerFinished(game: GameState, playerId: string): boolean {
    return game.pieces.filter((piece) => piece.playerId === playerId).every((piece) => piece.state === 'FINISHED');
  }

  private requireGame(room: Room): GameState {
    if (!room.game || room.status !== 'PLAYING') throw new GameError('INVALID_PHASE', '游戏尚未开始');
    return room.game;
  }

  private assertCurrentPlayer(room: Room, playerId: string): void {
    const game = this.requireGame(room);
    if (room.players[game.currentPlayerIndex]?.id !== playerId) throw new GameError('NOT_YOUR_TURN');
  }
}

function pieceSequence(id: string): number {
  const matched = /-(\d+)$/.exec(id);
  return matched ? Number.parseInt(matched[1], 10) : Number.MAX_SAFE_INTEGER;
}
