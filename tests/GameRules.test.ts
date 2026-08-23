import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRules } from '../src/game/GameRules.js';
import type { GameState, Piece } from '../src/protocol.js';

const airportPiece = (overrides: Partial<Piece> = {}): Piece => ({
  id: 'red-1', playerId: 'p1', color: 'RED', state: 'AIRPORT', progress: -1, ...overrides
});
const gameWith = (...pieces: Piece[]): GameState => ({
  currentPlayerIndex: 0, phase: 'WAIT_SELECT_PIECE', dice: 6,
  pieces, movablePieceIds: [], rankings: [], turnNumber: 1
});

test('only a six can take an airport piece off', () => {
  const rules = new GameRules();
  assert.equal(rules.canMove(airportPiece(), 5), false);
  assert.equal(rules.canMove(airportPiece(), 6), true);
  const move = rules.calculateMove(gameWith(airportPiece()), 'p1', 'red-1', 6);
  // The start cell is a same-colour jump cell, so a legal launch lands at progress 4.
  assert.equal(move.toProgress, 4);
  assert.deepEqual(move.path, [0, 1, 2, 3, 4]);
  assert.equal(move.tookOff, true);
});

test('a piece cannot overshoot the final square', () => {
  const rules = new GameRules();
  const piece = airportPiece({ state: 'FINAL_PATH', progress: 56 });
  assert.equal(rules.canMove(piece, 2), false);
  assert.equal(rules.canMove(piece, 1), true);
  assert.equal(rules.calculateMove(gameWith(piece), 'p1', 'red-1', 1).reachedFinish, true);
});

test('a moved piece sends opponents on its shared cell back to the airport', () => {
  const rules = new GameRules();
  const moving = airportPiece({ state: 'MAIN_PATH', progress: 0 });
  // Yellow progress 39 resolves to the same physical M1 cell as red progress 1.
  const victim = airportPiece({ id: 'yellow-1', playerId: 'p2', color: 'YELLOW', state: 'MAIN_PATH', progress: 40 });
  const move = rules.calculateMove(gameWith(moving, victim), 'p1', 'red-1', 1);
  assert.deepEqual(move.killedPieceIds, ['yellow-1']);
});
