import type { MatchVote } from '../protocol.js';
import { roomMembers, type Room } from '../room/Room.js';
import { beginNormalTurn } from './SkillState.js';

export const INACTIVITY_MS = 30_000;
export const PAUSE_MS = 120_000;
export const VOTE_MS = 30_000;
export class LifecycleError extends Error { public readonly code = 'INVALID_PHASE'; }

function state(room: Room) { return room.game!.lifecycle ??= {}; }
function requirePlaying(room: Room): void {
  if (room.status !== 'PLAYING' || !room.game) throw new LifecycleError('对局尚未开始或已经结束');
}
function newVote(room: Room, ids: string[], required: number, now: number): MatchVote {
  const game = room.game!; game.effectSequence = (game.effectSequence ?? 0) + 1;
  return { id: game.effectSequence, voterIds: ids, votes: {}, required, expiresAt: now + VOTE_MS };
}

/** Snapshot refresh, chat and local dice previews must not renew this deadline. */
export function synchronizeActivity(room: Room, now = Date.now(), actedPlayerId?: string): void {
  if (!room.game) return;
  const game = room.game, timing = state(room), player = room.players[game.currentPlayerIndex];
  if (timing.pause) return;
  if (room.status !== 'PLAYING' || !['WAIT_ROLL', 'WAIT_SELECT_DIE', 'WAIT_SELECT_PIECE'].includes(game.phase)
    || !player || player.isBot || player.aiControlled) { timing.activity = undefined; return; }
  const key = `${game.turnNumber}:${game.rollId}:${game.phase}:${player.id}`;
  if (timing.activity?.key !== key || actedPlayerId === player.id) timing.activity = { playerId: player.id, key, deadline: now + INACTIVITY_MS };
}

export function requestPause(room: Room, playerId: string, now = Date.now()): void {
  requirePlaying(room);
  const timing = state(room), voters = room.players.filter((p) => !p.isBot && !p.aiControlled);
  if (timing.pause || timing.pauseVote || room.game!.phase === 'WINNER_VOTE' || !voters.some((p) => p.id === playerId)) {
    throw new LifecycleError('当前无法发起技术暂停；仅参赛且未托管的真人可发起');
  }
  timing.pauseVote = newVote(room, voters.map((p) => p.id), voters.length, now);
  timing.pauseVote.initiatorId = playerId; timing.pauseVote.votes[playerId] = true;
  settlePause(room, now);
}

function acceptVote(vote: MatchVote | undefined, playerId: string, id: number, agree: boolean, now: number): MatchVote {
  if (!vote || vote.id !== id || now >= vote.expiresAt || !vote.voterIds.includes(playerId) || typeof agree !== 'boolean'
    || Object.prototype.hasOwnProperty.call(vote.votes, playerId)) throw new LifecycleError('投票已结束、已提交或你不在本次投票名单中');
  vote.votes[playerId] = agree;
  return vote;
}
export function votePause(room: Room, playerId: string, id: number, agree: boolean, now = Date.now()): void {
  requirePlaying(room); acceptVote(state(room).pauseVote, playerId, id, agree, now); settlePause(room, now);
}
function settlePause(room: Room, now: number): void {
  const timing = state(room), vote = timing.pauseVote;
  if (!vote) return;
  if (Object.values(vote.votes).filter(Boolean).length >= vote.required) {
    timing.pauseVote = undefined; timing.pause = { startedAt: now, endsAt: now + PAUSE_MS };
  } else if (Object.values(vote.votes).some((v) => !v) || now >= vote.expiresAt) timing.pauseVote = undefined;
}

/** First-place celebration freezes actions while the fixed human membership votes once. */
export function beginWinnerVote(room: Room, now = Date.now()): void {
  const timing = state(room), game = room.game!;
  timing.pauseVote = undefined; timing.activity = undefined;
  if (timing.continuationUsed || game.rankings.length >= 2) { finishMatch(room); return; }
  const ids = roomMembers(room).filter((p) => !p.isBot).map((p) => p.id);
  if (!ids.length) { finishMatch(room); return; }
  game.phase = 'WINNER_VOTE';
  timing.continueVote = newVote(room, ids, Math.ceil(ids.length * .75), now);
}
export function voteContinue(room: Room, playerId: string, id: number, agree: boolean, now = Date.now()): void {
  requirePlaying(room); acceptVote(state(room).continueVote, playerId, id, agree, now); settleContinue(room, now);
}
function settleContinue(room: Room, now: number): void {
  const timing = state(room), vote = timing.continueVote;
  if (!vote) return;
  const yes = Object.values(vote.votes).filter(Boolean).length;
  if (yes >= vote.required) {
    timing.continueVote = undefined; timing.continuationUsed = true;
    const game = room.game!;
    game.phase = 'WAIT_ROLL'; game.dice = null; game.diceChoices = null; game.selectedDieIndex = null;
    game.selectedAction = undefined; game.extraRolls = 0; game.rescue = undefined; game.movablePieceIds = [];
    do { game.currentPlayerIndex = (game.currentPlayerIndex + 1) % room.players.length; }
    while (game.rankings.includes(room.players[game.currentPlayerIndex].id));
    game.turnNumber += 1; beginNormalTurn(room, room.players[game.currentPlayerIndex].id);
    synchronizeActivity(room, now);
  } else if (now >= vote.expiresAt || vote.voterIds.length - Object.keys(vote.votes).length + yes < vote.required) finishMatch(room);
}
function finishMatch(room: Room): void {
  room.status = 'FINISHED'; room.game!.phase = 'GAME_OVER';
  const timing = state(room); timing.continueVote = undefined; timing.activity = undefined;
}

export interface LifecycleTick { changed: boolean; notices: string[]; takeoverIds: string[]; }
/** All clocks use server time and are testable without waiting real minutes. */
export function advanceLifecycle(room: Room, now = Date.now()): LifecycleTick {
  const result: LifecycleTick = { changed: false, notices: [], takeoverIds: [] };
  if (!room.game || room.status !== 'PLAYING') return result;
  const timing = state(room), previousVote = timing.pauseVote, previousContinue = timing.continueVote;
  if (timing.pause) {
    if (now < timing.pause.endsAt) return result;
    const duration = timing.pause.endsAt - timing.pause.startedAt;
    if (timing.activity) timing.activity.deadline += duration;
    if (room.game.reaction) room.game.reaction.expiresAt += duration;
    timing.pause = undefined;
    room.players.filter((p) => !p.isBot && !p.connected).forEach((p) => {
      p.disconnectedAt = now; p.aiControlled = true;
    });
    (room.spectators ?? []).filter((p) => !p.connected).forEach((p) => { p.disconnectedAt = now; });
    result.changed = true; result.notices.push('技术暂停结束，对局继续');
  }
  settlePause(room, now); settleContinue(room, now);
  if (previousVote && !timing.pauseVote) { result.changed = true; result.notices.push('技术暂停投票未获全票通过'); }
  if (previousContinue && !timing.continueVote) { result.changed = true; result.notices.push(room.game.phase === 'GAME_OVER' ? '继续投票未达到人数要求，本局结束' : '继续投票通过，开始角逐第二名'); }
  synchronizeActivity(room, now);
  if (timing.activity && now >= timing.activity.deadline) {
    const player = room.players.find((p) => p.id === timing.activity!.playerId)!;
    player.aiControlled = true; timing.activity = undefined;
    result.changed = true; result.takeoverIds.push(player.id); result.notices.push(`${player.nickname} 已有 30 秒未操作，进入 AI 托管`);
  }
  return result;
}
