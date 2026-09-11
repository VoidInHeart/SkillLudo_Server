import type { GameState, MoveResult, MoveSegment, Piece } from '../protocol.js';
import {
  FINAL_PATH_START, FINISH_PROGRESS, FLIGHT_STEPS,
  SAME_COLOR_JUMP_STEPS, getBoardCell, getPieceCell, isFlightTrigger, isSameColorMainCell
} from './PathData.js';

/** Pure game-rule calculations. State mutations are deliberately performed by GameEngine only. */
export class GameRules {
  public canTakeOff(piece: Piece, dice: number): boolean {
    return piece.state === 'AIRPORT' && (dice === 5 || dice === 6);
  }

  public canMove(piece: Piece, dice: number): boolean {
    if (!Number.isInteger(dice) || dice < 0 || dice > 12 || piece.locked) return false;
    if (this.canTakeOff(piece, dice)) return true;
    // A move that would pass the final square is legal: the plane advances to
    // the end and uses the remaining pips to move back along its own runway.
    return piece.state !== 'AIRPORT' && piece.state !== 'FINISHED';
  }

  public getMovablePieces(game: GameState, playerId: string, dice: number): Piece[] {
    return game.pieces.filter((piece) => piece.playerId === playerId && this.canMove(piece, dice));
  }

  public calculateMove(game: GameState, playerId: string, pieceId: string, dice: number, options: { noCapture?: boolean } = {}): MoveResult {
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
      let direction = 1;
      for (let step = 0; step < dice; step += 1) {
        if (progress === FINISH_PROGRESS) direction = -1;
        progress += direction;
        path.push(progress);
      }
    }

    const segments: MoveSegment[] = [{ kind: tookOff ? 'TAKEOFF' : 'WALK', fromProgress, toProgress: progress, path: [...path] }];
    let jumped = false;
    let usedFlightPath = false;
    // Taking off only places a plane on its coloured arrow. It does not also
    // consume a same-colour jump in the same action.
    if (dice > 0 && !tookOff && !isFlightTrigger(piece.color, progress) && isSameColorMainCell(piece.color, progress)) {
      const target = progress + SAME_COLOR_JUMP_STEPS;
      // The home turn arrow is a same-colour square but must enter the runway.
      if (target < FINAL_PATH_START) {
        segments.push({ kind: 'JUMP', fromProgress: progress, toProgress: target, path: [target] });
        path.push(target);
        progress = target;
        jumped = true;
      }
    }
    if (dice > 0 && isFlightTrigger(piece.color, progress)) {
      const target = progress + FLIGHT_STEPS;
      if (target < FINAL_PATH_START) {
        segments.push({ kind: 'FLIGHT', fromProgress: progress, toProgress: target, path: [target] });
        path.push(target);
        progress = target;
        usedFlightPath = true;
      }
    }
    // A turn may use one same-colour jump. A direct wormhole entry saves that
    // jump for the exit; jumping onto the entrance already spends it.
    if (usedFlightPath && !jumped && isSameColorMainCell(piece.color, progress) && progress + SAME_COLOR_JUMP_STEPS < FINAL_PATH_START) {
      const target = progress + SAME_COLOR_JUMP_STEPS;
      segments.push({ kind: 'JUMP', fromProgress: progress, toProgress: target, path: [target] });
      path.push(target); progress = target; jumped = true;
    }

    const reachedFinish = progress === FINISH_PROGRESS;
    // The wormhole only touches its two endpoints. Ordinary cells under the
    // flight arc never collide. A remaining jump can also capture at its landing.
    const flight = segments.find((segment) => segment.kind === 'FLIGHT');
    const collisionProgresses = options.noCapture || dice === 0 ? [] : Array.from(new Set(flight ? [flight.fromProgress, flight.toProgress, progress] : [progress]));
    const captures = collisionProgresses.flatMap((atProgress) => this.findCollisions(game, piece, [atProgress]).map((pieceId) => ({ pieceId, atProgress })));
    const killedPieceIds = [...new Set(captures.map((capture) => capture.pieceId))];
    return {
      pieceId,
      fromProgress,
      toProgress: progress,
      path,
      segments,
      captures,
      tookOff,
      jumped,
      usedFlightPath,
      killedPieceIds,
      reachedFinish,
      playerFinished: false,
      extraTurn: dice === 6,
      ...(piece.detour ? { fromDetour: true, toDetour: progress <= 0 } : {})
    };
  }

  private findCollisions(game: GameState, movingPiece: Piece, destinationProgresses: number[]): string[] {
    const destinations = new Set(destinationProgresses
      .filter((progress) => (progress >= 0 || movingPiece.detour) && progress < FINAL_PATH_START)
      .map((progress) => getBoardCell(movingPiece.color, progress, movingPiece.detour))
      .filter((cell): cell is string => !!cell));
    if (destinations.size === 0) return [];
    return game.pieces
      .filter((piece) => piece.playerId !== movingPiece.playerId && piece.state === 'MAIN_PATH' && !piece.locked)
      .filter((piece) => destinations.has(getPieceCell(piece) ?? ''))
      .map((piece) => piece.id);
  }
}
