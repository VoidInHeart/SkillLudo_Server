import type { Piece, PlayerColor } from '../protocol.js';

/** Board constants are logical only—no screen coordinates appear in server code. */
export const MAIN_PATH_LENGTH = 52;
export const FINAL_PATH_LENGTH = 6;
// Takeoff is private progress 0; the home turn arrow is progress 50.
export const FINAL_PATH_START = 51;
export const FINISH_PROGRESS = FINAL_PATH_START + FINAL_PATH_LENGTH - 1;
export const SAME_COLOR_JUMP_STEPS = 4;
export const FLIGHT_STEPS = 12;

/** Node 01 is the first outer circle after yellow's takeoff arrow. */
const clockwiseNodeOffset: Record<PlayerColor, number> = {
  YELLOW: 0,
  BLUE: 13,
  RED: 26,
  GREEN: 39
};

/** A colour-specific route maps progress to one shared main-path cell or private final cell. */
export function getBoardCell(color: PlayerColor, progress: number, detour = false): string | null {
  if (detour && progress <= 0) return `M${(clockwiseNodeOffset[color] + progress - 1 + MAIN_PATH_LENGTH) % MAIN_PATH_LENGTH}`;
  if (progress < 0) return null;
  if (progress < FINAL_PATH_START) {
    // Progress 0 is the colour-private takeoff arrow. Progress 1 enters the
    // numbered outer ring and then increases clockwise.
    if (progress === 0) return `T-${color}`;
    return `M${(clockwiseNodeOffset[color] + progress - 1) % MAIN_PATH_LENGTH}`;
  }
  if (progress <= FINISH_PROGRESS) return `F-${color}-${progress - FINAL_PATH_START}`;
  return null;
}

export function getPieceCell(piece: Piece): string | null {
  if (piece.state === 'AIRPORT' || piece.state === 'FINISHED') return null;
  return getBoardCell(piece.color, piece.progress, piece.detour);
}
export function positionOnRing(color: PlayerColor, cell: string): { progress: number; detour: boolean } {
  const relative = (Number(cell.slice(1)) - clockwiseNodeOffset[color] + MAIN_PATH_LENGTH) % MAIN_PATH_LENGTH + 1;
  return { progress: relative > 50 ? relative - MAIN_PATH_LENGTH : relative, detour: relative > 50 };
}

/**
 * A symmetric landing strip on every colour's route. Landing here performs the
 * long flight after the normal same-colour jump. The value is route-relative,
 * keeping the board rule independent of any artwork.
 */
export function isFlightTrigger(color: PlayerColor, progress: number): boolean {
  return progress === 18;
}

export function isSameColorMainCell(color: PlayerColor, progress: number): boolean {
  // On this board, colour cells recur every four clockwise route steps.
  // Progress is route-relative, so this stays correct for all four colours.
  return progress > 0 && progress < FINAL_PATH_START && progress % 4 === 2;
}
