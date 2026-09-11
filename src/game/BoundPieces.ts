import type { GameState, MoveResult, Piece } from '../protocol.js';
import { FINAL_PATH_START, getBoardCell, getPieceCell, positionOnRing } from './PathData.js';

/** A bound passenger is struck only through its carrier. Its faction cannot strike that carrier. */
export function protectedFromCollision(game: GameState, mover: Piece, target: Piece): boolean {
  return !!target.boundTo || game.pieces.some((p) => p.boundTo === target.id && p.playerId === mover.playerId);
}

export function captureGroup(game: GameState, ids: string[]): string[] {
  const result = new Set(ids);
  for (const piece of game.pieces) if (piece.boundTo && result.has(piece.boundTo)) result.add(piece.id);
  return Array.from(result);
}

/** Follow the carrier's clockwise route, including checkpoint crossings during jumps/flights.
 * A newly bound passenger starts at the collision endpoint, not at the carrier's old cell. */
export function carryPassengers(game: GameState, move: MoveResult, newlyBound: string[] = []): NonNullable<MoveResult['carriedPieces']> {
  const carrier = game.pieces.find((p) => p.id === move.pieceId)!;
  return game.pieces.filter((p) => p.boundTo === carrier.id).map((passenger) => {
    const before = { ...passenger };
    const start = newlyBound.includes(passenger.id)
      ? move.captures.find((c) => c.pieceId === passenger.id)!.atProgress : move.fromProgress;
    let lastCell = getBoardCell(carrier.color, start, move.fromDetour);
    let lastProgress = start;
    const checkpoint = getBoardCell(passenger.color, FINAL_PATH_START - 1);
    let drop = lastCell === checkpoint;
    for (let progress = start + 1; progress <= move.toProgress && !drop; progress += 1) {
      const cell = getBoardCell(carrier.color, progress, move.fromDetour);
      if (!cell?.startsWith('M')) { drop = true; break; }
      lastCell = cell;
      lastProgress = progress;
      if (cell === checkpoint) drop = true;
    }
    if (lastCell?.startsWith('M')) Object.assign(passenger, positionOnRing(passenger.color, lastCell), { state: 'MAIN_PATH' });
    if (drop) passenger.boundTo = undefined;
    return { before, after: { ...passenger }, fromCarrierProgress: start, toCarrierProgress: lastProgress };
  });
}

/** Swapping a carrier transports its passenger without a travelled checkpoint. */
export function relocatePassengers(game: GameState, carriers: Piece[]): Array<{ before: Piece; after: Piece }> {
  return game.pieces.filter((p) => carriers.some((c) => c.id === p.boundTo)).map((p) => {
    const before = { ...p }, carrier = carriers.find((c) => c.id === p.boundTo)!;
    Object.assign(p, positionOnRing(p.color, getPieceCell(carrier)!), { state: 'MAIN_PATH' });
    if (p.progress === FINAL_PATH_START - 1) p.boundTo = undefined;
    return { before, after: { ...p } };
  });
}
