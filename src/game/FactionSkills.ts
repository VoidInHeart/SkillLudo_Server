import type { GameSnapshot, MoveResult, PlayerColor, PlayerSkillState, SkillCommand, SkillWindow } from '../protocol.js';

/** Future skills calculate intents on the authority side. Client rendering never
 * grants a skill or changes a roll. Empty loadouts keep classic rules unchanged. */
export interface SkillContext {
  window: SkillWindow;
  playerId: string;
  snapshot: Readonly<GameSnapshot>;
  move?: Readonly<MoveResult>;
}
export interface FactionSkillDefinition {
  id: string;
  color: PlayerColor;
  windows: readonly SkillWindow[];
  initialCharges: number;
  cooldownTurns: number;
  canActivate(context: SkillContext, command: SkillCommand, state: Readonly<PlayerSkillState>): boolean;
}
export const FACTION_SKILLS: Readonly<Record<PlayerColor, readonly FactionSkillDefinition[]>> = {
  RED: [], YELLOW: [], BLUE: [], GREEN: []
};
