import type { ActionOption, FactionRuntime, GameState, Piece, PlayerSkillState } from '../protocol.js';
import type { Room } from '../room/Room.js';
import { SKILL_CATALOG } from './SkillCatalog.js';

export function initializeFactions(room: Room): Record<string, FactionRuntime> {
  return Object.fromEntries(room.players.map((player, index) => [player.id, {
    normalTurns: index === 0 ? 1 : 0, rolledThisTurn: false, awakened: false, limitedUsed: false,
    energy: 0, level: 0, readyAtTurn: 0, forcedDelta: 0, pendingDelta: 0
  }]));
}
export function faction(room: Room, playerId: string): FactionRuntime {
  const game = room.game!;
  game.factions ??= initializeFactions(room);
  return game.factions[playerId];
}
export function refreshAwakening(room: Room): void {
  const game = room.game!;
  for (const player of room.players) {
    const state = faction(room, player.id);
    if (player.color === 'RED' && game.pieces.filter((p) => p.playerId === player.id && ['FINAL_PATH', 'FINISHED'].includes(p.state)).length >= 2) state.awakened = true;
    if (player.color === 'BLUE' && (game.rolledTotal ?? 0) > 100) state.awakened = true;
  }
}
export function beginNormalTurn(room: Room, playerId: string): void {
  const state = faction(room, playerId);
  state.normalTurns += 1; state.rolledThisTurn = false;
  state.forcedDelta = state.pendingDelta; state.pendingDelta = 0;
  refreshStoredCharge(state);
}
export function refreshStoredCharge(state: FactionRuntime): void {
  if (state.awakened && state.level >= 2 && state.normalTurns - (state.lastScaleTurn ?? 1) >= 3) state.storedCharge = true;
}
export type ActionSpec = Omit<ActionOption, 'movablePieceIds' | 'movePreviews'>;
export function actionSpecs(room: Room): ActionSpec[] {
  const game = room.game!, player = room.players[game.currentPlayerIndex], state = faction(room, player.id);
  if (!game.diceChoices) return [];
  const ai = player.isBot || player.aiControlled;
  const specs: ActionSpec[] = [];
  game.diceChoices.forEach((raw, dieIndex) => {
    const add = (id: string, dice: number, kind: ActionSpec['kind'], label: string, delta?: number, mandatory = false, usesStoredCharge = false) => {
      if (dice >= 0 && dice <= 12) specs.push({ id, dieIndex, dice, kind, label, delta, mandatory, usesStoredCharge,
        extraTurn: kind === 'STANDARD' && raw === 6 });
    };
    if (game.rescue) { add(`rescue-${dieIndex}`, raw - 1, 'FR_RESCUE', `${raw} − 1 = ${raw - 1}`); return; }
    if (player.color === 'BLUE' && state.forcedDelta) {
      add(`forced-${dieIndex}`, raw + state.forcedDelta, 'CN_SHIFT', `${raw} ${signed(state.forcedDelta)}（强制）`, state.forcedDelta, true); return;
    }
    add(`die-${dieIndex}`, raw, 'STANDARD', String(raw));
    if (ai) return;
    if (player.color === 'RED' && state.awakened) add(`uk-plus-${dieIndex}`, raw + 1, 'UK_PLUS', `${raw} + 1 = ${raw + 1}`);
    if (player.color === 'BLUE' && state.awakened && state.scaleUsedTurn !== state.normalTurns) {
      const range = state.level >= 3 ? [-2, -1, 1, 2] : [-1, 1];
      if (state.readyAtTurn <= state.normalTurns) range.forEach((delta) => add(`cn-${dieIndex}-${delta}`, raw + delta, 'CN_SHIFT', `${raw} ${signed(delta)} = ${raw + delta}`, delta));
      if (state.storedCharge) range.forEach((delta) => add(`cn-stored-${dieIndex}-${delta}`, raw + delta, 'CN_SHIFT', `${raw} ${signed(delta)} = ${raw + delta}（储备）`, delta, false, true));
    }
  });
  if (!ai && !game.rescue && player.color === 'RED' && state.awakened && game.diceChoices[0] === game.diceChoices[1]) {
    const dice = game.diceChoices[0] * 2;
    specs.push({ id: 'uk-sum', dieIndex: 0, dice, kind: 'UK_SUM', label: `双骰合计 ${dice}（不连投）`, extraTurn: false });
  }
  return specs;
}
export function consumeAction(room: Room, option: ActionOption): void {
  const playerId = room.players[room.game!.currentPlayerIndex].id, state = faction(room, playerId);
  if (option.kind !== 'CN_SHIFT') return;
  state.lastScaleTurn = state.normalTurns; state.scaleUsedTurn = state.normalTurns;
  if (option.mandatory) state.forcedDelta = 0;
  else {
    if (option.usesStoredCharge) state.storedCharge = false;
    else state.readyAtTurn = state.normalTurns + 3;
    if (state.level === 0) state.pendingDelta = -(option.delta ?? 0);
  }
}
export function publicSkills(room: Room): PlayerSkillState[] {
  const game = room.game;
  if (!game) return [];
  return room.players.flatMap((player) => {
    const state = faction(room, player.id), mine = room.players[game.currentPlayerIndex].id === player.id;
    const manual = mine && !player.isBot && !player.aiControlled;
    const ordinaryWindow = ['WAIT_ROLL', 'WAIT_SELECT_DIE'].includes(game.phase) && !game.rescue;
    const locked = game.pieces.filter((p) => p.playerId === player.id && p.locked).length;
    return SKILL_CATALOG.filter((skill) => skill.color === player.color).map((skill) => {
      const available = manual && (skill.id === 'uk-sun' ? game.phase === 'WAIT_SELECT_DIE' && !state.limitedUsed && !game.rescue && (game.diceChoices?.reduce((a, b) => a + b, 0) ?? 0) >= 10
        : skill.id === 'fr-paris' ? game.phase === 'WAIT_ROLL' && !state.rolledThisTurn && !game.rescue && !state.limitedUsed && locked > 0
        : skill.id === 'cn-scale' ? game.phase === 'WAIT_SELECT_DIE' && state.awakened && (state.readyAtTurn <= state.normalTurns || !!state.storedCharge) && state.scaleUsedTurn !== state.normalTurns && !state.forcedDelta
        : skill.id === 'cn-grit' ? ordinaryWindow && state.awakened && state.energy >= 3 && state.level < 3
        : skill.id === 'uk-industry' ? game.phase === 'WAIT_SELECT_DIE' && state.awakened
        : skill.id === 'us-bomb' ? ordinaryWindow && !state.limitedUsed : false);
      return { playerId: player.id, skillId: skill.id, charges: skill.kind === 'LIMITED' ? (state.limitedUsed ? 0 : 1) : -1,
        cooldownTurns: skill.id === 'cn-scale' ? Math.max(0, state.readyAtTurn - state.normalTurns) : 0,
        available, awakened: state.awakened, energy: state.energy, level: state.level, forcedDelta: state.forcedDelta,
        storedCharge: !!state.storedCharge, usedThisTurn: state.scaleUsedTurn === state.normalTurns,
        progress: skill.id === 'uk-apple' ? game.pieces.filter((p) => p.playerId === player.id && ['FINAL_PATH', 'FINISHED'].includes(p.state)).length
          : skill.id === 'cn-roar' ? game.rolledTotal ?? 0 : skill.id === 'fr-tradition' ? locked : undefined };
    });
  });
}
export function activeAtCell(game: GameState, piece: Piece, cell: (piece: Piece) => string | null): boolean {
  const at = cell(piece);
  return game.pieces.some((other) => other.id !== piece.id && !other.locked && other.state === 'MAIN_PATH' && cell(other) === at);
}
function signed(delta: number): string { return delta > 0 ? `+ ${delta}` : `− ${Math.abs(delta)}`; }
