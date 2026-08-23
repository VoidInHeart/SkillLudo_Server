import type { PlayerColor } from '../protocol.js';

/** Board constants are logical only—no screen coordinates appear in server code. */
export const MAIN_PATH_LENGTH = 52;
export const FINAL_PATH_LENGTH = 6;
export const FINAL_PATH_START = MAIN_PATH_LENGTH;
export const FINISH_PROGRESS = MAIN_PATH_LENGTH + FINAL_PATH_LENGTH - 1;
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
export function getBoardCell(color: PlayerColor, progress: number): string | null {
  if (progress < 0) return null;
  if (progress < MAIN_PATH_LENGTH) {
    // Progress 0 is the colour-private takeoff arrow. Progress 1 enters the
    // numbered outer ring and then increases clockwise.
    if (progress === 0) return `T-${color}`;
    return `M${(clockwiseNodeOffset[color] + progress - 1) % MAIN_PATH_LENGTH}`;
  }
  if (progress <= FINISH_PROGRESS) return `F-${color}-${progress - FINAL_PATH_START}`;
  return null;
}

/**
 * A symmetric landing strip on every colour's route. Landing here performs the
 * long flight after the normal same-colour jump. The value is route-relative,
 * keeping the board rule independent of any artwork.
 */
export function isFlightTrigger(color: PlayerColor, progress: number): boolean {
  return getBoardCell(color, progress) === getBoardCell(color, 18);
}

export function isSameColorMainCell(color: PlayerColor, progress: number): boolean {
  // On this board, colour cells recur every four clockwise route steps.
  // Progress is route-relative, so this stays correct for all four colours.
  return progress > 0 && progress < MAIN_PATH_LENGTH && progress % 4 === 0;
}
