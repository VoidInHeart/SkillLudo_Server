import type { PlayerColor, RoomMode } from '../protocol.js';

export const FACTION_COLORS: readonly PlayerColor[] = ['YELLOW', 'BLUE', 'RED', 'GREEN'];

/** Fisher–Yates: every remaining seat/colour permutation has equal probability. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** A player has one preference, so satisfying one claimant for each requested
 * colour maximizes the total number of satisfied preferences. No seat gets priority. */
export function assignColors(
  players: readonly { id: string; preferredColor?: PlayerColor | null }[],
  random: () => number,
  mode: RoomMode = 'PRIVATE'
): Map<string, PlayerColor> {
  if (players.length > 4 || new Set(players.map((p) => p.id)).size !== players.length) throw new Error('INVALID_PLAYERS');
  const assignments = new Map<string, PlayerColor>();
  if (mode === 'PRIVATE') {
    for (const color of FACTION_COLORS) {
      const claimants = players.filter((player) => player.preferredColor === color);
      if (claimants.length) assignments.set(claimants[Math.floor(random() * claimants.length)].id, color);
    }
  }
  const used = new Set(assignments.values());
  const remainingColors = shuffled(FACTION_COLORS.filter((color) => !used.has(color)), random);
  const remainingPlayers = shuffled(players.filter((player) => !assignments.has(player.id)), random);
  remainingPlayers.forEach((player, index) => assignments.set(player.id, remainingColors[index]));
  return assignments;
}
