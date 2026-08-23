import type { PlayerColor } from '../protocol.js';

/** Board constants are logical only—no screen coordinates appear in server code. */
export const MAIN_PATH_LENGTH = 52;
export const FINAL_PATH_LENGTH = 6;
export const FINAL_PATH_START = MAIN_PATH_LENGTH;
export const FINISH_PROGRESS = MAIN_PATH_LENGTH + FINAL_PATH_LENGTH - 1;
export const SAME_COLOR_JUMP_STEPS = 4;
export const FLIGHT_STEPS = 12;

const startOffset: Record<PlayerColor, number> = {
  RED: 0,
  YELLOW: 13,
  BLUE: 26,
  GREEN: 39
};

/** A colour-specific route maps progress to one shared main-path cell or private final cell. */
export function getBoardCell(color: PlayerColor, progress: number): string | null {
  if (progress < 0) return null;
  if (progress < MAIN_PATH_LENGTH) {
    return `M${(startOffset[color] + progress) % MAIN_PATH_LENGTH}`;
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
  if (progress < 0 || progress >= MAIN_PATH_LENGTH) return false;
  const cell = getBoardCell(color, progress);
  return cell === `M${startOffset[color]}` ||
    cell === `M${(startOffset[color] + 4) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 8) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 12) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 16) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 20) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 24) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 28) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 32) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 36) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 40) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 44) % MAIN_PATH_LENGTH}` ||
    cell === `M${(startOffset[color] + 48) % MAIN_PATH_LENGTH}`;
}
