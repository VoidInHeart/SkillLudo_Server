import type { GameSnapshot, GameState, MoveResult, Piece, PlayerColor } from '../protocol.js';
import type { Room } from '../room/Room.js';
import { GameRules } from './GameRules.js';

export class GameError extends Error {
  public constructor(public readonly code: string, message = code) { super(message); }
}

export class GameEngine {
  public constructor(private readonly rules = new GameRules(), private readonly random = Math.random) {}

  public startGame(room: Room): void {
    if (room.players.length < 2) throw new GameError('NOT_READY', '至少需要两名玩家');
    if (!room.players.every((player) => player.ready)) throw new GameError('NOT_READY', '所有玩家必须准备');
    room.status = 'PLAYING';
    room.game = {
      currentPlayerIndex: 0,
      phase: 'WAIT_ROLL',
      dice: null,
      pieces: room.players.flatMap((player) => this.createPieces(player.id, player.color)),
      movablePieceIds: [],
      rankings: [],
      turnNumber: 1
    };
  }

  public rollDice(room: Room, playerId: string): { dice: number; movablePieceIds: string[]; skipped: boolean } {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_ROLL') throw new GameError('INVALID_PHASE');
    const dice = Math.floor(this.random() * 6) + 1;
    const movable = this.rules.getMovablePieces(game, playerId, dice);
    game.dice = dice;
    game.movablePieceIds = movable.map((piece) => piece.id);
    if (movable.length === 0) {
      game.dice = null;
      game.phase = 'WAIT_ROLL';
      game.movablePieceIds = [];
      this.nextTurn(room);
      return { dice, movablePieceIds: [], skipped: true };
    }
    game.phase = 'WAIT_SELECT_PIECE';
    return { dice, movablePieceIds: game.movablePieceIds, skipped: false };
  }

  public selectPiece(room: Room, playerId: string, pieceId: string): MoveResult {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_PIECE' || game.dice === null) throw new GameError('INVALID_PHASE');
    if (!game.movablePieceIds.includes(pieceId)) throw new GameError('PIECE_NOT_MOVABLE');

    game.phase = 'RESOLVING_MOVE';
    const result = this.rules.calculateMove(game, playerId, pieceId, game.dice);
    const piece = game.pieces.find((candidate) => candidate.id === pieceId);
    if (!piece) throw new GameError('INVALID_PIECE');
    piece.progress = result.toProgress;
    piece.state = result.reachedFinish ? 'FINISHED' : result.toProgress >= 52 ? 'FINAL_PATH' : 'MAIN_PATH';
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
      roomId: room.roomId,
      roomStatus: room.status,
      ownerId: room.ownerId,
      players: room.players.map(({ id, nickname, avatarUrl, color, ready, connected }) => ({ id, nickname, avatarUrl, color, ready, connected })),
      currentPlayerId: game ? room.players[game.currentPlayerIndex]?.id ?? null : null,
      phase: game?.phase ?? null,
      dice: game?.dice ?? null,
      pieces: game?.pieces ?? [],
      movablePieceIds: game?.movablePieceIds ?? [],
      rankings: game?.rankings ?? [],
      turnNumber: game?.turnNumber ?? 0
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
