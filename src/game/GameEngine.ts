import { randomInt } from 'node:crypto';
import { PROTOCOL_VERSION, type ActionOption, type CaptureOutcome, type CommitMoveCommand, type DiceResult, type DieSelected, type GameSnapshot, type GameState, type MoveResult, type Piece, type PlayerColor, type SkillCommand, type SkillEffect, type SkillResolution } from '../protocol.js';
import type { Room } from '../room/Room.js';
import { GameRules } from './GameRules.js';
import { FINAL_PATH_START, MAIN_PATH_LENGTH, getBoardCell, getPieceCell, positionOnRing } from './PathData.js';
import { assignColors } from '../room/ColorAssignment.js';
import { actionSpecs, activeAtCell, beginNormalTurn, consumeAction, faction, initializeFactions, publicSkills, refreshAwakening, refreshStoredCharge } from './SkillState.js';

const GAME_COLORS: PlayerColor[] = ['RED', 'YELLOW', 'BLUE', 'GREEN'];

export class GameError extends Error {
  public constructor(public readonly code: string, message = code) { super(message); }
}

export class GameEngine {
  public constructor(private readonly rules = new GameRules(), private readonly random = () => randomInt(0, 0x100000000) / 0x100000000) {}

  public startGame(room: Room): void {
    if (room.status !== 'WAITING') throw new GameError('INVALID_PHASE');
    const humanPlayers = room.players.filter((player) => !player.isBot);
    if (humanPlayers.length < 2) throw new GameError('NOT_READY', '至少需要两名玩家');
    if (!humanPlayers.every((player) => player.ready)) throw new GameError('NOT_READY', '所有玩家必须准备');
    this.fillAiSeats(room);
    // Colours are finalized only as the game begins, so every participant sees
    // one unambiguous colour assignment in the GAME_START snapshot.
    const assigned = assignColors(room.players, this.random, room.mode);
    room.players.forEach((player) => { player.color = assigned.get(player.id)!; });
    room.status = 'PLAYING';
    room.game = {
      currentPlayerIndex: 0,
      phase: 'WAIT_ROLL',
      dice: null,
      diceChoices: null,
      selectedDieIndex: null,
      rollId: 0,
      pieces: room.players.flatMap((player) => this.createPieces(player.id, player.color)),
      movablePieceIds: [],
      rankings: [],
      turnNumber: 1,
      factions: initializeFactions(room), rolledTotal: 0, extraRolls: 0, effectSequence: 0
    };
  }

  public rollDice(room: Room, playerId: string, forcedDice?: number): DiceResult {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_ROLL') throw new GameError('INVALID_PHASE');
    if (forcedDice !== undefined && (!Number.isInteger(forcedDice) || forcedDice < 1 || forcedDice > 6)) {
      throw new GameError('INVALID_PHASE', '点数必须为 1–6');
    }
    game.diceChoices = [forcedDice ?? Math.floor(this.random() * 6) + 1, Math.floor(this.random() * 6) + 1];
    game.dice = null;
    game.selectedDieIndex = null;
    game.selectedAction = undefined;
    game.movablePieceIds = [];
    game.rollId += 1;
    game.phase = 'WAIT_SELECT_DIE';
    game.rolledTotal = (game.rolledTotal ?? 0) + game.diceChoices[0] + game.diceChoices[1];
    if (!game.rescue) faction(room, playerId).rolledThisTurn = true;
    refreshAwakening(room);
    return { playerId, diceChoices: [...game.diceChoices], rollId: game.rollId };
  }

  public selectDie(room: Room, playerId: string, dieIndex: number, rollId: number): DieSelected {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_DIE' || !game.diceChoices) throw new GameError('INVALID_PHASE');
    if ((dieIndex !== 0 && dieIndex !== 1) || rollId !== game.rollId) throw new GameError('INVALID_DIE', '骰子选择已失效，请选择本次投出的骰子');
    const option = this.getActionOptions(room).find((option) => option.dieIndex === dieIndex && (option.kind === 'STANDARD' || option.kind === 'FR_RESCUE' || option.mandatory));
    if (!option) throw new GameError('INVALID_DIE');
    return this.selectAction(room, playerId, option, rollId);
  }

  private selectAction(room: Room, playerId: string, option: ActionOption, rollId: number): DieSelected {
    const game = this.requireGame(room), { dice, dieIndex } = option;
    consumeAction(room, option);
    game.selectedAction = option;
    game.dice = dice;
    game.selectedDieIndex = dieIndex;
    game.movablePieceIds = [...option.movablePieceIds];
    if (option.movablePieceIds.length === 0) {
      game.dice = null;
      game.phase = 'WAIT_ROLL';
      game.movablePieceIds = [];
      // A six earns another roll even when there is no legal plane to move.
      const extraTurn = this.finishAction(room, option.extraTurn);
      return { playerId, dieIndex, dice, rollId, movablePieceIds: [], skipped: true, extraTurn };
    }
    game.phase = 'WAIT_SELECT_PIECE';
    return { playerId, dieIndex, dice, rollId, movablePieceIds: [...game.movablePieceIds], skipped: false, extraTurn: option.extraTurn };
  }

  public chooseAiDie(room: Room, playerId: string): number {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_DIE' || !game.diceChoices) throw new GameError('INVALID_PHASE');
    const options = this.getActionOptions(room).filter((option) => option.kind === 'STANDARD' || option.kind === 'FR_RESCUE' || option.mandatory);
    const score = (option: ActionOption) => option.movablePieceIds.length ? Math.max(...Object.values(option.movePreviews).map((move) =>
      (move.reachedFinish ? 100 : 0) + move.killedPieceIds.length * 30 + (move.tookOff ? 20 : 0) + (move.extraTurn ? 15 : 0) + move.toProgress - move.fromProgress)) : -1;
    return [...options].sort((a, b) => score(b) - score(a))[0]?.dieIndex ?? 0;
  }

  public getActionOptions(room: Room): ActionOption[] {
    const game = room.game;
    if (!game || game.phase !== 'WAIT_SELECT_DIE' || !game.diceChoices) return [];
    const playerId = room.players[game.currentPlayerIndex].id;
    return actionSpecs(room).map((spec) => {
      const ids = game.pieces.filter((piece) => {
        if (piece.playerId !== playerId || (game.rescue && !game.rescue.pieceIds.includes(piece.id))) return false;
        if (piece.locked && (!(spec.dice === 3 || spec.dice === 4) || activeAtCell(game, piece, getPieceCell))) return false;
        return this.rules.canMove({ ...piece, locked: false }, spec.dice);
      }).map((piece) => piece.id);
      return { ...spec, movablePieceIds: ids, movePreviews: Object.fromEntries(ids.map((id) => [id, this.previewAction(room, id, spec)])) };
    });
  }

  /** Validate the entire intent before committing either the die or the aircraft. */
  public commitMove(room: Room, playerId: string, command: CommitMoveCommand): { selection: DieSelected; move?: MoveResult } {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_DIE') throw new GameError('INVALID_PHASE');
    if (command.rollId !== game.rollId) throw new GameError('INVALID_DIE', '投掷已更新，请重新选择');
    const option = this.getActionOptions(room).find((candidate) => candidate.id === command.optionId);
    if (!option) throw new GameError('INVALID_DIE');
    if (command.pieceId ? !option.movablePieceIds.includes(command.pieceId) : option.movablePieceIds.length > 0) {
      throw new GameError('PIECE_NOT_MOVABLE', '请选择当前点数高亮的飞机');
    }
    const selection = this.selectAction(room, playerId, option, command.rollId);
    return { selection, ...(command.pieceId ? { move: this.selectPiece(room, playerId, command.pieceId) } : {}) };
  }

  /** Chooses a server-side AI move without changing the game state. */
  public chooseAiPiece(room: Room, playerId: string): string | null {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_PIECE') return null;
    const movable = game.pieces.filter((piece) => piece.playerId === playerId && game.movablePieceIds.includes(piece.id));
    if (movable.length === 0) return null;

    // Launching a new aircraft always comes first when a 5/6 permits it.
    const takeoff = movable
      .filter((piece) => piece.state === 'AIRPORT')
      .sort((left, right) => pieceSequence(left.id) - pieceSequence(right.id) || left.id.localeCompare(right.id))[0];
    if (takeoff) return takeoff.id;

    // Until every plane has entered its final runway, keep advancing aircraft
    // still on the shared main route. Within that group, protect threatened
    // aircraft; the requested tie-breaker prefers the farthest enemy behind.
    const mainRoute = movable.filter((piece) => piece.state === 'MAIN_PATH' && piece.progress < FINAL_PATH_START);
    const candidates = mainRoute.length > 0 ? mainRoute : movable;
    const threatened = candidates
      .map((piece) => ({ piece, distance: this.threatDistance(game, piece) }))
      .filter((candidate): candidate is { piece: Piece; distance: number } => candidate.distance !== null);
    if (threatened.length > 0) {
      threatened.sort((left, right) => right.distance - left.distance || right.piece.progress - left.piece.progress || left.piece.id.localeCompare(right.piece.id));
      return threatened[0].piece.id;
    }
    return candidates.sort((left, right) => right.progress - left.progress || left.id.localeCompare(right.id))[0]?.id ?? null;
  }

  public selectPiece(room: Room, playerId: string, pieceId: string): MoveResult {
    const game = this.requireGame(room);
    this.assertCurrentPlayer(room, playerId);
    if (game.phase !== 'WAIT_SELECT_PIECE' || game.dice === null) throw new GameError('INVALID_PHASE');
    if (!game.movablePieceIds.includes(pieceId)) throw new GameError('PIECE_NOT_MOVABLE');

    const result = this.previewAction(room, pieceId, game.selectedAction ?? { dice: game.dice, kind: 'STANDARD', extraTurn: game.dice === 6 });
    if (this.beginReaction(room, playerId, result.killedPieceIds, result)) return { ...result, pendingReaction: true };
    return this.finalizeMove(room, result, []);
  }

  private previewAction(room: Room, pieceId: string, option: Pick<ActionOption, 'dice' | 'kind' | 'extraTurn'>): MoveResult {
    const game = room.game!, playerId = room.players[game.currentPlayerIndex].id;
    const previewGame = { ...game, pieces: game.pieces.map((p) => p.id === pieceId ? { ...p, locked: false } : p) };
    const result = this.rules.calculateMove(previewGame, playerId, pieceId, option.dice, { noCapture: option.kind === 'FR_RESCUE' });
    result.extraTurn = option.extraTurn;
    return result;
  }

  private finalizeMove(room: Room, result: MoveResult, lockedIds: string[]): MoveResult {
    const game = this.requireGame(room), playerId = room.players[game.currentPlayerIndex].id, pieceId = result.pieceId;
    const piece = game.pieces.find((candidate) => candidate.id === pieceId);
    if (!piece) throw new GameError('INVALID_PIECE');
    game.phase = 'RESOLVING_MOVE';
    piece.progress = result.toProgress;
    piece.state = result.reachedFinish ? 'FINISHED' : result.toProgress >= FINAL_PATH_START ? 'FINAL_PATH' : 'MAIN_PATH';
    piece.locked = false; piece.detour = result.toDetour === true;
    result.captureOutcomes = this.applyCaptures(room, playerId, result.killedPieceIds, lockedIds);
    refreshAwakening(room);

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

    result.extraTurn = this.finishAction(room, result.extraTurn, pieceId);
    return result;
  }

  private finishAction(room: Room, rolledExtra: boolean, pieceId?: string): boolean {
    const game = room.game!;
    game.phase = 'WAIT_ROLL'; game.dice = null; game.movablePieceIds = []; game.selectedAction = undefined;
    if (game.rescue) {
      game.rescue.pieceIds = game.rescue.pieceIds.filter((id) => id !== pieceId);
      if (!game.rescue.pieceIds.length) game.rescue = undefined;
      return true;
    }
    game.extraRolls = (game.extraRolls ?? 0) + (rolledExtra ? 1 : 0);
    if (game.extraRolls > 0) { game.extraRolls -= 1; return true; }
    this.nextTurn(room);
    return false;
  }

  public useSkill(room: Room, playerId: string, command: SkillCommand): SkillResolution {
    const game = this.requireGame(room), player = room.players.find((p) => p.id === playerId);
    if (!player || player.isBot || player.aiControlled) throw new GameError('SKILL_UNAVAILABLE', 'AI 托管不会主动发动技能');
    if (command.rollId !== game.rollId) throw new GameError('INVALID_DIE', '技能操作已过期');
    if (command.skillId === 'fr-lock') {
      const reaction = game.reaction;
      if (!reaction || reaction.playerId !== playerId || reaction.id !== command.reactionId || Date.now() >= reaction.expiresAt) throw new GameError('SKILL_UNAVAILABLE', '受击选择已结束');
      return this.resolveReaction(room, command.targetPieceIds ?? [], reaction.id);
    }
    this.assertCurrentPlayer(room, playerId);
    const publicId = command.skillId === 'cn-upgrade' ? 'cn-grit' : command.skillId;
    if (!publicSkills(room).some((skill) => skill.playerId === playerId && skill.skillId === publicId && skill.available)) throw new GameError('SKILL_UNAVAILABLE', '当前条件不满足技能要求');
    const state = faction(room, playerId);
    if (command.skillId === 'uk-sun') {
      const ids = command.targetPieceIds;
      if (!ids || ids.length !== 2 || ids[0] === ids[1]) throw new GameError('INVALID_PIECE', '请选择两架不同的飞机');
      const pieces = ids.map((id) => game.pieces.find((p) => p.id === id));
      if (pieces.some((p) => !p || p.locked || !getPieceCell(p)?.startsWith('M'))) throw new GameError('INVALID_PIECE', '仅可交换公共航线上未锁定的飞机');
      const [a, b] = pieces as [Piece, Piece], before = [{ ...a }, { ...b }];
      const aCell = getPieceCell(a)!, bCell = getPieceCell(b)!;
      Object.assign(a, positionOnRing(a.color, bCell)); Object.assign(b, positionOnRing(b.color, aCell));
      state.limitedUsed = true;
      return { effect: { skillId: command.skillId, playerId, message: '日不落帝国：两架飞机交换位置', movedPieces: [{ before: before[0], after: { ...a } }, { before: before[1], after: { ...b } }] } };
    }
    if (command.skillId === 'fr-paris') {
      const pieces = game.pieces.filter((p) => p.playerId === playerId && p.locked);
      const movedPieces = pieces.map((p) => ({ before: { ...p }, after: { ...p, locked: false } }));
      pieces.forEach((p) => { p.locked = false; });
      game.rescue = { playerId, pieceIds: pieces.map((p) => p.id) }; state.limitedUsed = true;
      return { effect: { skillId: command.skillId, playerId, message: `解锁 ${pieces.length} 架飞机，逐架进行救援投掷`, movedPieces } };
    }
    if (command.skillId === 'cn-upgrade') {
      state.energy -= 3; state.level += 1;
      if (state.level === 1) { state.forcedDelta = 0; state.pendingDelta = 0; }
      refreshStoredCharge(state);
      return { effect: { skillId: command.skillId, playerId, message: `尺有所长强化至第 ${state.level} 重` } };
    }
    if (command.skillId === 'us-bomb') {
      if (!command.targetCell || !/^M([0-9]|[1-4][0-9]|5[01])$/.test(command.targetCell)) throw new GameError('INVALID_PIECE', '请选择公共航线格子');
      const center = Number(command.targetCell.slice(1));
      const targetCells = [-2, -1, 0, 1, 2].map((delta) => `M${(center + delta + MAIN_PATH_LENGTH) % MAIN_PATH_LENGTH}`);
      const victimIds = game.pieces.filter((p) => targetCells.includes(getPieceCell(p) ?? '')).map((p) => p.id);
      const effect: SkillEffect = { skillId: command.skillId, playerId, message: '核弹轰炸覆盖五格，敌我飞机均受影响', targetCells };
      state.limitedUsed = true;
      if (this.beginReaction(room, playerId, victimIds, undefined, effect)) return { pending: true };
      effect.captures = this.applyCaptures(room, playerId, victimIds, []);
      refreshAwakening(room);
      return { effect };
    }
    throw new GameError('SKILL_UNAVAILABLE', '该技能通过预选点数或被动结算生效');
  }

  private beginReaction(room: Room, actorPlayerId: string, victimIds: string[], move?: MoveResult, effect?: SkillEffect): boolean {
    const game = room.game!;
    const defender = room.players.find((p) => p.color === 'YELLOW');
    if (!defender || defender.isBot || defender.aiControlled || !defender.connected) return false;
    const capacity = 2 - game.pieces.filter((p) => p.playerId === defender.id && p.locked && !victimIds.includes(p.id)).length;
    const pieceIds = victimIds.filter((id) => game.pieces.some((p) => p.id === id && p.playerId === defender.id && !p.locked));
    if (capacity <= 0 || !pieceIds.length) return false;
    game.effectSequence = (game.effectSequence ?? 0) + 1;
    game.reaction = { id: game.effectSequence, playerId: defender.id, pieceIds, capacity, expiresAt: Date.now() + 15_000,
      actorPlayerId, victimIds: [...victimIds], move, effect, previousPhase: game.phase };
    game.phase = 'WAIT_REACTION';
    return true;
  }

  public resolveReaction(room: Room, lockedIds: string[], reactionId: number): SkillResolution {
    const game = this.requireGame(room), pending = game.reaction;
    if (game.phase !== 'WAIT_REACTION' || !pending || pending.id !== reactionId) throw new GameError('SKILL_UNAVAILABLE');
    if (lockedIds.length > pending.capacity || new Set(lockedIds).size !== lockedIds.length || lockedIds.some((id) => !pending.pieceIds.includes(id))) {
      throw new GameError('INVALID_PIECE', '锁定飞机选择无效或超过两架上限');
    }
    game.reaction = undefined;
    game.phase = pending.previousPhase;
    if (pending.move) return { move: this.finalizeMove(room, pending.move, lockedIds) };
    const effect = pending.effect!;
    effect.captures = this.applyCaptures(room, pending.actorPlayerId, pending.victimIds, lockedIds);
    refreshAwakening(room);
    return { effect };
  }

  private applyCaptures(room: Room, actorPlayerId: string, victimIds: string[], lockedIds: string[]): CaptureOutcome[] {
    const game = room.game!, actor = room.players.find((p) => p.id === actorPlayerId);
    return [...new Set(victimIds)].map((id) => {
      const piece = game.pieces.find((p) => p.id === id)!, before = { ...piece };
      let outcome: CaptureOutcome['outcome'];
      if (lockedIds.includes(id)) { piece.locked = true; outcome = 'LOCKED'; }
      else {
        piece.locked = false; piece.detour = false;
        if (piece.color === 'BLUE') {
          piece.progress = 0; piece.state = 'MAIN_PATH'; outcome = 'TAKEOFF';
          const state = faction(room, piece.playerId); state.energy = Math.min(3, state.energy + 1);
        } else { piece.progress = -1; piece.state = 'AIRPORT'; outcome = 'AIRPORT'; }
      }
      if (actor?.color === 'GREEN' && piece.playerId !== actorPlayerId) game.extraRolls = (game.extraRolls ?? 0) + 1;
      return { pieceId: id, outcome, before, after: { ...piece } };
    });
  }

  public getSnapshot(room: Room): GameSnapshot {
    const game = room.game;
    return {
      protocolVersion: PROTOCOL_VERSION,
      roomId: room.roomId,
      roomStatus: room.status,
      roomMode: room.mode ?? 'PRIVATE',
      ownerId: room.ownerId,
      players: room.players.map(({ id, nickname, avatarUrl, color, preferredColor, isBot, aiControlled, ready, connected }) => ({ id, nickname, avatarUrl, color, preferredColor: preferredColor ?? null, isBot, aiControlled, ready, connected })),
      spectators: room.spectators?.map(({ id, nickname, avatarUrl, connected }) => ({ id, nickname, avatarUrl, connected, spectating: true })),
      currentPlayerId: game ? room.players[game.currentPlayerIndex]?.id ?? null : null,
      phase: game?.phase ?? null,
      dice: game?.dice ?? null,
      diceChoices: game?.diceChoices ? [...game.diceChoices] : null,
      selectedDieIndex: game?.selectedDieIndex ?? null,
      rollId: game?.rollId ?? 0,
      pieces: game?.pieces.map((piece) => ({ ...piece })) ?? [],
      movablePieceIds: [...(game?.movablePieceIds ?? [])],
      rankings: [...(game?.rankings ?? [])],
      turnNumber: game?.turnNumber ?? 0,
      movePreviews: game?.phase === 'WAIT_SELECT_PIECE' && game.dice !== null ? Object.fromEntries(game.movablePieceIds.map((id) => [id, this.previewAction(room, id, game.selectedAction ?? { dice: game.dice!, kind: 'STANDARD', extraTurn: game.dice === 6 })])) : {},
      skills: publicSkills(room),
      actionOptions: this.getActionOptions(room),
      reaction: game?.reaction ? { id: game.reaction.id, playerId: game.reaction.playerId, pieceIds: [...game.reaction.pieceIds], capacity: game.reaction.capacity, expiresAt: game.reaction.expiresAt } : undefined,
      rescuePieceIds: [...(game?.rescue?.pieceIds ?? [])], rolledTotal: game?.rolledTotal ?? 0, extraRolls: game?.extraRolls ?? 0
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

  private fillAiSeats(room: Room): void {
    for (let seat = room.players.length; seat < GAME_COLORS.length; seat += 1) {
      room.players.push({
        id: `ai_${room.roomId}_${seat + 1}`,
        sessionId: `ai_session_${room.roomId}_${seat + 1}`,
        nickname: `AI棋手 ${seat + 1}`,
        color: GAME_COLORS[seat],
        isBot: true,
        ready: true,
        connected: true,
        lastHeartbeatAt: Date.now()
      });
    }
  }

  /** Returns the forward main-track distance to a hostile aircraft that can roll onto this piece. */
  private threatDistance(game: GameState, target: Piece): number | null {
    if (target.state !== 'MAIN_PATH' || target.progress < 1 || target.progress >= FINAL_PATH_START) return null;
    const targetCell = getBoardCell(target.color, target.progress);
    if (!targetCell?.startsWith('M')) return null;
    const targetIndex = Number(targetCell.slice(1));
    const distances = game.pieces
      .filter((piece) => piece.playerId !== target.playerId && piece.state === 'MAIN_PATH' && piece.progress >= 1 && piece.progress < FINAL_PATH_START)
      .map((piece) => getBoardCell(piece.color, piece.progress))
      .filter((cell): cell is string => !!cell && cell.startsWith('M'))
      .map((cell) => (targetIndex - Number(cell.slice(1)) + MAIN_PATH_LENGTH) % MAIN_PATH_LENGTH)
      .filter((distance) => distance >= 1 && distance <= 6);
    return distances.length > 0 ? Math.max(...distances) : null;
  }

  private nextTurn(room: Room): void {
    const game = this.requireGame(room);
    for (let attempts = 0; attempts < room.players.length; attempts += 1) {
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % room.players.length;
      if (!game.rankings.includes(room.players[game.currentPlayerIndex].id)) break;
    }
    game.turnNumber += 1;
    beginNormalTurn(room, room.players[game.currentPlayerIndex].id);
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

function pieceSequence(id: string): number {
  const matched = /-(\d+)$/.exec(id);
  return matched ? Number.parseInt(matched[1], 10) : Number.MAX_SAFE_INTEGER;
}
