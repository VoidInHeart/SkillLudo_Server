import test from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameRules } from '../src/game/GameRules.js';
import { RoomManager } from '../src/room/RoomManager.js';

function setup() {
  const rooms = new RoomManager();
  const player = (id: string) => ({ id, sessionId: id, nickname: id, connected: true, lastHeartbeatAt: 0 });
  const room = rooms.createRoom(player('a')); rooms.joinRoom(room.roomId, player('b'));
  room.players.forEach((p) => { p.ready = true; });
  const engine = new GameEngine(new GameRules(), () => 0);
  engine.startGame(room); engine.rollDice(room, 'a', 6);
  return { engine, room };
}

test('A01: previewing both dice is detached and does not lock a choice', () => {
  const { engine, room } = setup();
  const before = structuredClone(room.game);
  const options = engine.getSnapshot(room).actionOptions!;
  assert.equal(options[0].movablePieceIds.length, 4);
  assert.equal(options[1].movablePieceIds.length, 0);
  options[0].movePreviews[options[0].movablePieceIds[0]].path.push(99);
  options[0].movablePieceIds.pop();
  assert.deepEqual(room.game, before);
});

test('A02: invalid or stale composite commands never consume the die', () => {
  const { engine, room } = setup();
  const before = structuredClone(room.game);
  for (const intent of [{ rollId: 0, optionId: 'die-0' }, { rollId: 1, optionId: 'forged' }, { rollId: 1, optionId: 'die-0', pieceId: room.game!.pieces[4].id }, { rollId: 1, optionId: 'die-0' }]) {
    assert.throws(() => engine.commitMove(room, 'a', { roomId: room.roomId, ...intent }));
    assert.deepEqual(room.game, before);
  }
  assert.throws(() => engine.commitMove(room, 'b', { roomId: room.roomId, rollId: 1, optionId: 'die-1' }));
  assert.deepEqual(room.game, before);
});

test('A03: clicking a highlighted plane commits both choices, while no-move pass is explicit', () => {
  const { engine, room } = setup();
  const command = { roomId: room.roomId, rollId: 1, optionId: 'die-0', pieceId: room.game!.pieces[0].id };
  const result = engine.commitMove(room, 'a', command);
  assert.equal(result.selection.dice, 6);
  assert.equal(result.move!.toProgress, 0);
  assert.throws(() => engine.commitMove(room, 'a', command));
  const other = setup();
  const pass = other.engine.commitMove(other.room, 'a', { roomId: other.room.roomId, rollId: 1, optionId: 'die-1' });
  assert.equal(pass.selection.skipped, true);
  assert.equal(other.room.game!.currentPlayerIndex, 1);
});
