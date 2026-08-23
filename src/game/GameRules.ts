import type { GameState, MoveResult, Piece } from '../protocol.js';
import {
  FINAL_PATH_START, FINISH_PROGRESS, FLIGHT_STEPS, MAIN_PATH_LENGTH,
  SAME_COLOR_JUMP_STEPS, getBoardCell, isFlightTrigger, isSameColorMainCell
} from './PathData.js';

/** Pure game-rule calculations. State mutations are deliberately performed by GameEngine only. */
export class GameRules {
  public canTakeOff(piece: Piece, dice: number): boolean {
    return piece.state === 'AIRPORT' && dice === 6;
  }

  public canMove(piece: Piece, dice: number): boolean {
    if (this.canTakeOff(piece, dice)) return true;
    return piece.state !== 'AIRPORT' && piece.state !== 'FINISHED' && piece.progress + dice <= FINISH_PROGRESS;
  }

  public getMovablePieces(game: GameState, playerId: string, dice: number): Piece[] {
    return game.pieces.filter((piece) => piece.playerId === playerId && this.canMove(piece, dice));
  }

  public calculateMove(game: GameState, playerId: string, pieceId: string, dice: number): MoveResult {
    const piece = game.pieces.find((candidate) => candidate.id === pieceId && candidate.playerId === playerId);
    if (!piece || !this.canMove(piece, dice)) throw new Error('PIECE_NOT_MOVABLE');

    const fromProgress = piece.progress;
    const path: number[] = [];
    let progress: number;
    let tookOff = false;
    if (piece.state === 'AIRPORT') {
      progress = 0;
      path.push(progress);
      tookOff = true;
    } else {
      progress = piece.progress;
      for (let step = 0; step < dice; step += 1) path.push(++progress);
    }

    let jumped = false;
    let usedFlightPath = false;
    if (progress < MAIN_PATH_LENGTH && isSameColorMainCell(piece.color, progress)) {
      const target = progress + SAME_COLOR_JUMP_STEPS;
      if (target <= FINISH_PROGRESS) {
        for (let next = progress + 1; next <= target; next += 1) path.push(next);
        progress = target;
        jumped = true;
      }
    }
    if (progress < MAIN_PATH_LENGTH && isFlightTrigger(piece.color, progress)) {
      const target = progress + FLIGHT_STEPS;
      if (target < MAIN_PATH_LENGTH) {
        for (let next = progress + 1; next <= target; next += 1) path.push(next);
        progress = target;
        usedFlightPath = true;
      }
    }

    const reachedFinish = progress === FINISH_PROGRESS;
    const killedPieceIds = this.findCollisions(game, piece, progress);
    return {
      pieceId,
      fromProgress,
      toProgress: progress,
      path,
      tookOff,
      jumped,
      usedFlightPath,
      killedPieceIds,
      reachedFinish,
      playerFinished: false,
      extraTurn: dice === 6
    };
  }

  private findCollisions(game: GameState, movingPiece: Piece, destinationProgress: number): string[] {
    if (destinationProgress >= FINAL_PATH_START) return [];
    const destination = getBoardCell(movingPiece.color, destinationProgress);
    return game.pieces
      .filter((piece) => piece.playerId !== movingPiece.playerId && piece.state === 'MAIN_PATH')
      .filter((piece) => getBoardCell(piece.color, piece.progress) === destination)
      .map((piece) => piece.id);
  }
}
