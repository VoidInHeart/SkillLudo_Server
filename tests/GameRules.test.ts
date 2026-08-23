import assert from 'node:assert/strict';
import test from 'node:test';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameRules } from '../src/game/GameRules.js';
import type { GameState, Piece } from '../src/protocol.js';
import type { Room } from '../src/room/Room.js';

const airportPiece = (overrides: Partial<Piece> = {}): Piece => ({
  id: 'red-1', playerId: 'p1', color: 'RED', state: 'AIRPORT', progress: -1, ...overrides
});
const gameWith = (...pieces: Piece[]): GameState => ({
  currentPlayerIndex: 0, phase: 'WAIT_SELECT_PIECE', dice: 6,
  pieces, movablePieceIds: [], rankings: [], turnNumber: 1
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
  const piece = airportPiece({ state: 'FINAL_PATH', progress: 56 });
  assert.equal(rules.canMove(piece, 2), true);
  assert.equal(rules.canMove(piece, 1), true);
  assert.equal(rules.calculateMove(gameWith(piece), 'p1', 'red-1', 1).reachedFinish, true);
  const bounced = rules.calculateMove(gameWith(piece), 'p1', 'red-1', 2);
  assert.equal(bounced.toProgress, 56);
  assert.equal(bounced.reachedFinish, false);
  assert.deepEqual(bounced.path, [57, 56]);
});

test('a moved piece sends opponents on its shared cell back to the airport', () => {
  const rules = new GameRules();
  const moving = airportPiece({ state: 'MAIN_PATH', progress: 0 });
  // Yellow progress 39 resolves to the same physical M1 cell as red progress 1.
  const victim = airportPiece({ id: 'yellow-1', playerId: 'p2', color: 'YELLOW', state: 'MAIN_PATH', progress: 40 });
  const move = rules.calculateMove(gameWith(moving, victim), 'p1', 'red-1', 1);
  assert.deepEqual(move.killedPieceIds, ['yellow-1']);
});

test('a wormhole does not jump, but can capture on its third square before exit', () => {
  const rules = new GameRules();
  const moving = airportPiece({ state: 'MAIN_PATH', progress: 17 });
  // Red progress 27 is the third cell before the wormhole exit at progress 30.
  // Yellow progress 14 resolves to the same shared board cell.
  const victim = airportPiece({ id: 'yellow-1', playerId: 'p2', color: 'YELLOW', state: 'MAIN_PATH', progress: 14 });
  const move = rules.calculateMove(gameWith(moving, victim), 'p1', 'red-1', 1);
  assert.equal(move.jumped, false);
  assert.equal(move.usedFlightPath, true);
  assert.equal(move.toProgress, 30);
  assert.deepEqual(move.killedPieceIds, ['yellow-1']);
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
      airportPiece({ id: 'red-1', state: 'FINISHED', progress: 57 }),
      airportPiece({ id: 'red-2', state: 'FINISHED', progress: 57 }),
      airportPiece({ id: 'red-3', state: 'FINISHED', progress: 57 }),
      airportPiece({ id: 'red-4', state: 'FINAL_PATH', progress: 56 }),
      airportPiece({ id: 'yellow-1', playerId: 'p2', color: 'YELLOW', state: 'AIRPORT' })
    )
  } as unknown as Room;
  room.game!.movablePieceIds = ['red-4'];
  room.game!.dice = 1;
  const result = engine.selectPiece(room, 'p1', 'red-4');
  assert.equal(result.playerFinished, true);
  assert.equal(room.status, 'FINISHED');
  assert.equal(room.game!.phase, 'GAME_OVER');
  assert.deepEqual(room.game!.rankings, ['p1']);
});
