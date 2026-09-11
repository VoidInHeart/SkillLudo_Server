import assert from 'node:assert/strict';
import test from 'node:test';
import { GameEngine } from '../src/game/GameEngine.js';
import { RoomManager } from '../src/room/RoomManager.js';
import { advanceLifecycle, beginWinnerVote, requestPause, synchronizeActivity, voteContinue, votePause } from '../src/game/MatchLifecycle.js';
import { SkillAnnouncements } from '../src/game/SkillAnnouncements.js';
import { faction } from '../src/game/SkillState.js';
import type { PlayerColor } from '../src/protocol.js';

function setup(humans = 4, spectators = 0) {
  const rooms = new RoomManager(), engine = new GameEngine();
  const player = (id: string) => ({ id, sessionId: id, nickname: id, connected: true, lastHeartbeatAt: Date.now() });
  const room = rooms.createRoom(player('p1'));
  for (let i = 2; i <= humans; i++) rooms.joinRoom(room.roomId, player(`p${i}`));
  room.players.forEach((p, i) => { p.ready = true; p.preferredColor = (['RED', 'YELLOW', 'BLUE', 'GREEN'] as PlayerColor[])[i]; });
  engine.startGame(room);
  for (let i = 1; i <= spectators; i++) rooms.joinRoom(room.roomId, player(`s${i}`));
  return { rooms, room, engine, game: room.game! };
}

test('T01: only the required actor times out at 30 seconds; polling/chat do not renew the clock', () => {
  const { room, game } = setup(); synchronizeActivity(room, 1000);
  assert.equal(game.lifecycle!.activity!.deadline, 31000);
  synchronizeActivity(room, 21000); assert.equal(game.lifecycle!.activity!.deadline, 31000);
  assert.deepEqual(advanceLifecycle(room, 30999).takeoverIds, []);
  assert.deepEqual(advanceLifecycle(room, 31000).takeoverIds, ['p1']);
  assert.equal(room.players[0].aiControlled, true); assert.ok(room.players.slice(1).every((p) => !p.aiControlled));
  assert.deepEqual(advanceLifecycle(room, 31001).takeoverIds, []);
});

test('T02: actions renew the current deadline and successful rolls start a fresh selection deadline', () => {
  const { room, game, engine } = setup(); synchronizeActivity(room, 1000);
  synchronizeActivity(room, 20000, 'p2'); assert.equal(game.lifecycle!.activity!.deadline, 31000);
  synchronizeActivity(room, 20000, 'p1'); assert.equal(game.lifecycle!.activity!.deadline, 50000);
  engine.rollDice(room, 'p1', 5); synchronizeActivity(room, 40000);
  assert.equal(game.lifecycle!.activity!.deadline, 70000);
});

test('T03: technical pause requires all other eligible humans; spectators and bots cannot vote', () => {
  const { room, game } = setup(2, 2); requestPause(room, 'p1', 1000);
  const vote = game.lifecycle!.pauseVote!;
  assert.deepEqual(vote.voterIds, ['p1', 'p2']); assert.equal(vote.required, 2);
  const before = structuredClone(vote);
  assert.throws(() => votePause(room, 's1', vote.id, true, 1100)); assert.deepEqual(vote, before);
  assert.throws(() => votePause(room, 'p1', vote.id, true, 1100));
  votePause(room, 'p2', vote.id, true, 1200);
  assert.deepEqual(game.lifecycle!.pause, { startedAt: 1200, endsAt: 121200 });
  assert.throws(() => requestPause(room, 'p1', 2000));
});

test('T04: rejected/expired pause votes do not freeze the game; stale responses are harmless', () => {
  const { room, game } = setup(2); requestPause(room, 'p1', 1000);
  const id = game.lifecycle!.pauseVote!.id; votePause(room, 'p2', id, false, 1100);
  assert.ok(!game.lifecycle!.pause); assert.equal(game.lifecycle!.pauseVote, undefined);
  requestPause(room, 'p1', 2000); assert.throws(() => votePause(room, 'p2', id, true, 2100));
  advanceLifecycle(room, 32000); assert.equal(game.lifecycle!.pauseVote, undefined); assert.ok(!game.lifecycle!.pause);
});

test('T05: pause freezes activity and reaction deadlines and blocks all engine actions', () => {
  const { room, game, engine } = setup(2); synchronizeActivity(room, 1000);
  game.reaction = { id: 88, playerId: 'p2', pieceIds: [], capacity: 1, expiresAt: 15000, actorPlayerId: 'p1', victimIds: [], previousPhase: 'WAIT_ROLL' };
  requestPause(room, 'p1', 11000); votePause(room, 'p2', game.lifecycle!.pauseVote!.id, true, 11000);
  assert.throws(() => engine.rollDice(room, 'p1', 6));
  const frozen = structuredClone(game);
  assert.equal(advanceLifecycle(room, 130999).changed, false); assert.deepEqual(game, frozen);
  advanceLifecycle(room, 131000);
  assert.equal(game.lifecycle!.activity!.deadline, 151000); assert.equal(game.reaction.expiresAt, 135000);
  assert.equal(room.players[0].aiControlled, undefined);
});

test('T06: paused disconnects remain in the game and get a fresh reconnection grace on resume', () => {
  const { rooms, room, game } = setup(2); requestPause(room, 'p1', 1000); votePause(room, 'p2', game.lifecycle!.pauseVote!.id, true, 1000);
  rooms.leaveRoom(room.roomId, 'p1'); assert.ok(!room.players[0].aiControlled);
  room.players[1].connected = false;
  advanceLifecycle(room, 120999); assert.equal(room.status, 'PLAYING');
  room.players[0].connected = true;
  advanceLifecycle(room, 121000); assert.ok(!room.players[0].aiControlled);
  assert.equal(room.players[1].aiControlled, true); assert.equal(room.players[1].disconnectedAt, 121000);
});

test('T07: six human members require five approvals and permit only one continuation', () => {
  const { room, game } = setup(4, 2); game.rankings = ['p1']; beginWinnerVote(room, 1000);
  const vote = game.lifecycle!.continueVote!; assert.equal(vote.required, 5);
  ['p1', 'p2', 'p3', 's1'].forEach((id) => voteContinue(room, id, vote.id, true, 1100));
  assert.equal(game.phase, 'WINNER_VOTE');
  voteContinue(room, 's2', vote.id, true, 1200);
  assert.equal(game.phase, 'WAIT_ROLL'); assert.equal(game.currentPlayerIndex, 1); assert.equal(game.lifecycle!.continuationUsed, true);
  game.rankings.push('p2'); beginWinnerVote(room, 1300);
  assert.equal(room.status, 'FINISHED'); assert.equal(game.phase, 'GAME_OVER'); assert.equal(game.lifecycle!.continueVote, undefined);
});

test('T08: failed or timed-out continuation preserves the champion and ends the match', () => {
  for (const timeout of [false, true]) {
    const { room, game } = setup(2); game.rankings = ['p1']; beginWinnerVote(room, 1000);
    if (timeout) advanceLifecycle(room, 31000); else voteContinue(room, 'p2', game.lifecycle!.continueVote!.id, false, 1100);
    assert.equal(room.status, 'FINISHED'); assert.deepEqual(game.rankings, ['p1']);
  }
});

test('T09: skill condition announcements are emitted once, and snapshot refresh never repeats them', () => {
  const { room, game, engine } = setup(); const notices = new SkillAnnouncements();
  assert.deepEqual(notices.collect(room), []);
  engine.rollDice(room, 'p1', 6); game.diceChoices = [6, 6];
  assert.deepEqual(notices.collect(room), [{ playerId: 'p1', skillIds: ['uk-sun'] }]);
  assert.deepEqual(notices.collect(room), []);
  faction(room, 'p3').awakened = true;
  assert.deepEqual(notices.collect(room), [{ playerId: 'p3', skillIds: ['cn-roar'] }]);
  assert.deepEqual(notices.collect(room), []);
  game.phase = 'WAIT_ROLL'; notices.collect(room); game.phase = 'WAIT_SELECT_DIE';
  assert.deepEqual(notices.collect(room), [], 'same roll restored on reconnect');
});
