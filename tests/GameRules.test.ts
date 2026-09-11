import assert from 'node:assert/strict';
import test from 'node:test';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameRules } from '../src/game/GameRules.js';
import { getBoardCell } from '../src/game/PathData.js';
import type { GameState, Piece } from '../src/protocol.js';
import type { Room } from '../src/room/Room.js';
import { voteContinue } from '../src/game/MatchLifecycle.js';

const airportPiece = (overrides: Partial<Piece> = {}): Piece => ({
  id: 'red-1', playerId: 'p1', color: 'RED', state: 'AIRPORT', progress: -1, ...overrides
});
const gameWith = (...pieces: Piece[]): GameState => ({
  currentPlayerIndex: 0, phase: 'WAIT_SELECT_PIECE', dice: 6, diceChoices: [6, 1], selectedDieIndex: 0, rollId: 1,
  pieces, movablePieceIds: [], rankings: [], turnNumber: 1
});

test('all colours traverse the shared ring clockwise and turn at their own runway arrow', () => {
  assert.equal(getBoardCell('YELLOW', 0), 'T-YELLOW');
  assert.equal(getBoardCell('YELLOW', 1), 'M0');
  assert.equal(getBoardCell('BLUE', 1), 'M13');
  assert.equal(getBoardCell('RED', 1), 'M26');
  assert.equal(getBoardCell('GREEN', 1), 'M39');
  assert.equal(getBoardCell('YELLOW', 50), 'M49');
  assert.equal(getBoardCell('YELLOW', 51), 'F-YELLOW-0');
});

test('a five or six can take an airport piece off onto its start arrow', () => {
  const rules = new GameRules();
  assert.equal(rules.canMove(airportPiece(), 5), true);
  assert.equal(rules.canMove(airportPiece(), 6), true);
  assert.equal(rules.canMove(airportPiece(), 4), false);
  const move = rules.calculateMove(gameWith(airportPiece()), 'p1', 'red-1', 5);
  assert.equal(move.toProgress, 0);
  assert.deepEqual(move.path, [0]);
  assert.equal(move.tookOff, true);
});

test('a piece bounces back from the final square when the dice overshoots', () => {
  const rules = new GameRules();
  const piece = airportPiece({ state: 'FINAL_PATH', progress: 55 });
  assert.equal(rules.canMove(piece, 2), true);
  assert.equal(rules.canMove(piece, 1), true);
  assert.equal(rules.calculateMove(gameWith(piece), 'p1', 'red-1', 1).reachedFinish, true);
  const bounced = rules.calculateMove(gameWith(piece), 'p1', 'red-1', 2);
  assert.equal(bounced.toProgress, 55);
  assert.equal(bounced.reachedFinish, false);
  assert.deepEqual(bounced.path, [56, 55]);
});

test('a moved piece sends opponents on its shared cell back to the airport', () => {
  const rules = new GameRules();
  const moving = airportPiece({ state: 'MAIN_PATH', progress: 0 });
  // Yellow progress 27 resolves to the same clockwise shared cell as red progress 1.
  const victim = airportPiece({ id: 'yellow-1', playerId: 'p2', color: 'YELLOW', state: 'MAIN_PATH', progress: 27 });
  const move = rules.calculateMove(gameWith(moving, victim), 'p1', 'red-1', 1);
  assert.deepEqual(move.killedPieceIds, ['yellow-1']);
});

test('direct wormhole entry jumps once after exit and never captures the ordinary cells beneath it', () => {
  const rules = new GameRules();
  const moving = airportPiece({ state: 'MAIN_PATH', progress: 17 });
  // Red progress 27 lies under the flight arc and is never a collision point.
  const victim = airportPiece({ id: 'yellow-1', playerId: 'p2', color: 'YELLOW', state: 'MAIN_PATH', progress: 1 });
  const move = rules.calculateMove(gameWith(moving, victim), 'p1', 'red-1', 1);
  assert.equal(move.jumped, true);
  assert.equal(move.usedFlightPath, true);
  assert.equal(move.toProgress, 34);
  assert.deepEqual(move.killedPieceIds, []);
});

test('the first player with four completed planes wins the game immediately', () => {
  const engine = new GameEngine();
  const room = {
    roomId: '123456', ownerId: 'p1', status: 'PLAYING', createdAt: Date.now(), lastActiveAt: Date.now(), chatHistory: [],
    players: [
      { id: 'p1', nickname: 'red', color: 'RED', ready: true, connected: true, lastHeartbeatAt: Date.now() },
      { id: 'p2', nickname: 'yellow', color: 'YELLOW', ready: true, connected: true, lastHeartbeatAt: Date.now() }
    ],
    game: gameWith(
      airportPiece({ id: 'red-1', state: 'FINISHED', progress: 56 }),
      airportPiece({ id: 'red-2', state: 'FINISHED', progress: 56 }),
      airportPiece({ id: 'red-3', state: 'FINISHED', progress: 56 }),
      airportPiece({ id: 'red-4', state: 'FINAL_PATH', progress: 55 }),
      airportPiece({ id: 'yellow-1', playerId: 'p2', color: 'YELLOW', state: 'AIRPORT' })
    )
  } as unknown as Room;
  room.game!.movablePieceIds = ['red-4'];
  room.game!.dice = 1;
  const result = engine.selectPiece(room, 'p1', 'red-4');
  assert.equal(result.playerFinished, true);
  assert.equal(room.status, 'PLAYING');
  assert.equal(room.game!.phase, 'WINNER_VOTE');
  assert.deepEqual(room.game!.rankings, ['p1']);
  voteContinue(room, 'p1', room.game!.lifecycle!.continueVote!.id, false);
  assert.equal(room.status, 'FINISHED');
  assert.equal(room.game!.phase, 'GAME_OVER');
});

test('starting with two people fills AI seats and a forced six retains the current turn', () => {
  const engine = new GameEngine(new GameRules(), () => 0.9999);
  const room = {
    roomId: '246810', ownerId: 'p1', status: 'WAITING', createdAt: Date.now(), lastActiveAt: Date.now(), chatHistory: [],
    players: [
      { id: 'p1', nickname: 'red', color: 'RED', ready: true, connected: true, lastHeartbeatAt: Date.now() },
      { id: 'p2', nickname: 'yellow', color: 'YELLOW', ready: true, connected: true, lastHeartbeatAt: Date.now() }
    ]
  } as unknown as Room;
  engine.startGame(room);
  assert.equal(room.players.length, 4);
  assert.equal(room.players.filter((player) => player.isBot).length, 2);
  assert.equal(room.game!.pieces.length, 16);

  const rolled = engine.rollDice(room, 'p1', 6);
  const dice = engine.selectDie(room, 'p1', 0, rolled.rollId);
  assert.equal(dice.dice, 6);
  assert.equal(dice.extraTurn, true);
  const move = engine.selectPiece(room, 'p1', dice.movablePieceIds[0]);
  assert.equal(move.extraTurn, true);
  assert.equal(room.game!.currentPlayerIndex, 0);
  assert.equal(room.game!.phase, 'WAIT_ROLL');
});

test('AI always launches the lowest-numbered airport plane first', () => {
  const engine = new GameEngine();
  const room = {
    roomId: '135790', ownerId: 'p1', status: 'PLAYING', createdAt: Date.now(), lastActiveAt: Date.now(), chatHistory: [],
    players: [{ id: 'p1', nickname: 'AI', color: 'RED', ready: true, connected: true, isBot: true, lastHeartbeatAt: Date.now() }],
    game: gameWith(
      airportPiece({ id: 'red-4' }),
      airportPiece({ id: 'red-2' }),
      airportPiece({ id: 'red-1' }),
      airportPiece({ id: 'red-3' })
    )
  } as unknown as Room;
  room.game!.movablePieceIds = ['red-4', 'red-2', 'red-1', 'red-3'];
  assert.equal(engine.chooseAiPiece(room, 'p1'), 'red-1');
});
