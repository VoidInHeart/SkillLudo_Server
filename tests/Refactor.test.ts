import assert from 'node:assert/strict';
import test from 'node:test';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameRules } from '../src/game/GameRules.js';
import { assignColors, FACTION_COLORS } from '../src/room/ColorAssignment.js';
import { RoomManager } from '../src/room/RoomManager.js';
import { FINAL_PATH_START, FINISH_PROGRESS, getBoardCell, isSameColorMainCell } from '../src/game/PathData.js';
import type { PlayerColor } from '../src/protocol.js';

const player = (id: string) => ({ id, sessionId: id, nickname: id, connected: true, lastHeartbeatAt: Date.now() });
function setup(random = () => 0.5) {
  const rooms = new RoomManager();
  const room = rooms.createRoom(player('a'));
  rooms.joinRoom(room.roomId, player('b'));
  room.players.forEach((p) => { p.ready = true; });
  const engine = new GameEngine(new GameRules(), random);
  engine.startGame(room);
  return { room, engine, rooms };
}

test('both dice require an authorized, current roll selection before moving', () => {
  const { room, engine } = setup();
  const roll = engine.rollDice(room, 'a', 6);
  assert.deepEqual(roll.diceChoices, [6, 4]);
  assert.equal(room.game!.phase, 'WAIT_SELECT_DIE');
  assert.equal(room.game!.dice, null);
  assert.throws(() => engine.rollDice(room, 'a'), /INVALID_PHASE/);
  assert.throws(() => engine.selectPiece(room, 'a', room.game!.pieces[0].id), /INVALID_PHASE/);
  assert.throws(() => engine.selectDie(room, 'b', 0, roll.rollId), /NOT_YOUR_TURN/);
  for (const index of [-1, 2, NaN, 0.5]) assert.throws(() => engine.selectDie(room, 'a', index, roll.rollId));
  assert.throws(() => engine.selectDie(room, 'a', 0, roll.rollId - 1));
  const selected = engine.selectDie(room, 'a', 0, roll.rollId);
  assert.equal(selected.dice, 6);
  assert.equal(room.game!.phase, 'WAIT_SELECT_PIECE');
  assert.throws(() => engine.selectDie(room, 'a', 1, roll.rollId), /INVALID_PHASE/);
  const snapshot = engine.getSnapshot(room);
  assert.equal(Object.keys(snapshot.movePreviews).length, 4);
  assert.equal(snapshot.movePreviews[selected.movablePieceIds[0]].toProgress, 0);
  engine.selectPiece(room, 'a', selected.movablePieceIds[0]);
  assert.equal(room.game!.currentPlayerIndex, 0);
  assert.equal(room.game!.phase, 'WAIT_ROLL');
  // A saved reconnect snapshot is detached from subsequent authority mutations.
  assert.equal(snapshot.pieces[0].progress, -1);
  assert.equal(engine.rollDice(room, 'a').rollId, 2);
});

test('unmovable chosen number skips once; doubles do not sum or grant an extra turn', () => {
  const { room, engine } = setup(() => 0);
  const rolled = engine.rollDice(room, 'a');
  assert.deepEqual(rolled.diceChoices, [1, 1]);
  const result = engine.selectDie(room, 'a', 1, rolled.rollId);
  assert.equal(result.skipped, true);
  assert.equal(result.extraTurn, false);
  assert.equal(room.game!.currentPlayerIndex, 1);
  assert.equal(room.game!.turnNumber, 2);
});

test('AI chooses a launchable die, and can resume directly from the selection phase', () => {
  const { room, engine } = setup(() => 0);
  engine.rollDice(room, 'a', 5);
  assert.equal(engine.getSnapshot(room).phase, 'WAIT_SELECT_DIE');
  const choice = engine.chooseAiDie(room, 'a');
  assert.equal(choice, 0);
  engine.selectDie(room, 'a', choice, room.game!.rollId);
  assert.ok(engine.chooseAiPiece(room, 'a'));
});

test('colour lottery maximizes fulfilled preferences for every combination of four choices', () => {
  const choices: Array<PlayerColor | null> = [null, ...FACTION_COLORS];
  for (const a of choices) for (const b of choices) for (const c of choices) for (const d of choices) {
    const players = [a, b, c, d].map((preferredColor, i) => ({ id: String(i), preferredColor }));
    const allocation = assignColors(players, () => 0.37);
    assert.equal(new Set(allocation.values()).size, 4);
    const expected = new Set([a, b, c, d].filter(Boolean)).size;
    assert.equal(players.filter((p) => p.preferredColor === allocation.get(p.id)).length, expected);
  }
});

test('every conflicting claimant can win; matching ignores preferences; room edits cancel readiness', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => ({ id, preferredColor: 'RED' as const }));
  for (let index = 0; index < 4; index += 1) assert.equal(assignColors(players, () => (index + 0.1) / 4).get(players[index].id), 'RED');
  assert.deepEqual(assignColors(players, () => 0.5, 'MATCHMAKING'), assignColors(players.map(({ id }) => ({ id })), () => 0.5, 'MATCHMAKING'));
  const rooms = new RoomManager();
  const room = rooms.createRoom(player('a'));
  rooms.setReady(room.roomId, 'a', true);
  rooms.setColorPreference(room.roomId, 'a', 'GREEN');
  assert.equal(room.players[0].ready, false);
  assert.equal(room.players[0].preferredColor, 'GREEN');
  assert.throws(() => rooms.setColorPreference(room.roomId, 'a', 'PURPLE'));
});

test('same-colour jumps, flight entrances, runway turns and bounce agree for all four colours', () => {
  for (const color of FACTION_COLORS) {
    const { room } = setup();
    const game = room.game!;
    const piece = game.pieces[0];
    piece.color = color;
    piece.state = 'MAIN_PATH';
    const rules = new GameRules();
    assert.equal(isSameColorMainCell(color, 2), true);
    assert.equal(isSameColorMainCell(color, 4), false);
    piece.progress = 1;
    assert.equal(rules.calculateMove(game, 'a', piece.id, 1).toProgress, 6);
    piece.progress = 13;
    const throughJump = rules.calculateMove(game, 'a', piece.id, 1);
    assert.deepEqual(throughJump.segments.map((s) => s.kind), ['WALK', 'JUMP', 'FLIGHT']);
    assert.equal(throughJump.toProgress, 30);
    piece.progress = 17;
    assert.deepEqual(rules.calculateMove(game, 'a', piece.id, 1).segments.map((s) => s.kind), ['WALK', 'FLIGHT']);
    piece.progress = 50;
    assert.equal(rules.calculateMove(game, 'a', piece.id, 1).toProgress, FINAL_PATH_START);
    assert.equal(getBoardCell(color, FINAL_PATH_START), `F-${color}-0`);
    piece.progress = FINISH_PROGRESS - 1;
    const bounce = rules.calculateMove(game, 'a', piece.id, 3);
    assert.deepEqual(bounce.path, [FINISH_PROGRESS, FINISH_PROGRESS - 1, FINISH_PROGRESS - 2]);
  }
});

test('fifty seeded four-seat games finish with unique colours and valid piece progress', () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    let state = seed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const { room, engine } = setup(random);
    room.players.forEach((player) => { player.aiControlled = true; });
    let actions = 0;
    while (room.status === 'PLAYING' && actions++ < 15000) {
      const current = room.players[room.game!.currentPlayerIndex];
      if (room.game!.phase === 'WAIT_ROLL') engine.rollDice(room, current.id);
      else if (room.game!.phase === 'WAIT_SELECT_DIE') engine.selectDie(room, current.id, engine.chooseAiDie(room, current.id), room.game!.rollId);
      else engine.selectPiece(room, current.id, engine.chooseAiPiece(room, current.id)!);
    }
    assert.equal(room.status, 'FINISHED', `seed ${seed}`);
    assert.equal(new Set(room.players.map((p) => p.color)).size, 4);
    assert.ok(room.game!.pieces.every((p) => p.progress >= -1 && p.progress <= FINISH_PROGRESS));
  }
});
