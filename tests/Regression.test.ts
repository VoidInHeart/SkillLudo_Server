import assert from 'node:assert/strict';
import test from 'node:test';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameRules } from '../src/game/GameRules.js';
import { RoomManager } from '../src/room/RoomManager.js';

const player = (id: string) => ({ id, sessionId: id, nickname: id, connected: true, lastHeartbeatAt: 1 });
function setup(secondDie = 1) {
  const rooms = new RoomManager(), room = rooms.createRoom(player('a'));
  rooms.joinRoom(room.roomId, player('b'));
  rooms.setColorPreference(room.roomId, 'a', 'GREEN');
  rooms.setColorPreference(room.roomId, 'b', 'BLUE');
  rooms.setReady(room.roomId, 'a', true); rooms.setReady(room.roomId, 'b', true);
  const engine = new GameEngine(new GameRules(), () => (secondDie - 0.5) / 6);
  engine.startGame(room);
  return { rooms, room, engine };
}

test('S01: the selected second die alone determines takeoff and an extra turn', () => {
  for (const [discarded, chosen] of [[6, 5], [1, 6]]) {
    const { room, engine } = setup(chosen);
    const roll = engine.rollDice(room, 'a', discarded);
    assert.deepEqual(roll.diceChoices, [discarded, chosen]);
    const selected = engine.selectDie(room, 'a', 1, roll.rollId);
    const move = engine.selectPiece(room, 'a', selected.movablePieceIds[0]);
    assert.equal(move.toProgress, 0);
    assert.equal(move.extraTurn, chosen === 6);
    assert.equal(room.game!.currentPlayerIndex, chosen === 6 ? 0 : 1);
    assert.equal(room.game!.turnNumber, chosen === 6 ? 1 : 2);
  }
});

test('S02: a previous extra-turn roll cannot select a die in the next roll or mutate state', () => {
  const { room, engine } = setup(5);
  const old = engine.rollDice(room, 'a', 6);
  const choice = engine.selectDie(room, 'a', 0, old.rollId);
  engine.selectPiece(room, 'a', choice.movablePieceIds[0]);
  const current = engine.rollDice(room, 'a', 1);
  const before = structuredClone(room.game);
  assert.ok(current.rollId > old.rollId);
  assert.throws(() => engine.selectDie(room, 'a', 0, old.rollId), { code: 'INVALID_DIE' });
  assert.deepEqual(room.game, before);
  assert.equal(engine.selectDie(room, 'a', 1, current.rollId).dice, 5);
});

test('S03: mutating snapshots, roll results and move previews cannot change authority state', () => {
  const { room, engine } = setup(2);
  const roll = engine.rollDice(room, 'a', 6);
  roll.diceChoices[0] = 1;
  assert.equal(room.game!.diceChoices![0], 6);
  const selected = engine.selectDie(room, 'a', 0, roll.rollId);
  selected.movablePieceIds.length = 0;
  const original = engine.getSnapshot(room), snapshot = engine.getSnapshot(room);
  snapshot.players[0].color = 'RED'; snapshot.players[0].nickname = 'tampered';
  snapshot.pieces[0].progress = 55; snapshot.diceChoices![0] = 1;
  snapshot.movablePieceIds.length = 0; snapshot.rankings.push('a');
  const preview = Object.values(snapshot.movePreviews)[0];
  preview.path.push(999); preview.segments[0].path.push(999);
  preview.captures.push({ pieceId: 'fake', atProgress: 999 });
  preview.killedPieceIds.push('fake');
  assert.deepEqual(engine.getSnapshot(room), original);
});

test('S04: wormhole preview is pure and execution captures only the declared opponents', () => {
  const { room, engine } = setup(), game = room.game!;
  const at = (id: string, progress: number) => {
    const piece = game.pieces.find((p) => p.id === id)!;
    piece.state = 'MAIN_PATH'; piece.progress = progress; return piece;
  };
  at('green-1', 17); at('green-2', 30);
  at('blue-1', 1); at('blue-2', 4); at('blue-3', 2);
  const roll = engine.rollDice(room, 'a', 1);
  engine.selectDie(room, 'a', 0, roll.rollId);
  const before = structuredClone(game);
  const preview = engine.getSnapshot(room).movePreviews['green-1'];
  assert.deepEqual(game, before);
  assert.deepEqual(preview.segments.map((s) => s.kind), ['WALK', 'FLIGHT']);
  assert.deepEqual(preview.captures, [{ pieceId: 'blue-2', atProgress: 30 }, { pieceId: 'blue-1', atProgress: 27 }]);
  const result = engine.selectPiece(room, 'a', 'green-1');
  assert.deepEqual(result, preview);
  for (const id of ['blue-1', 'blue-2']) {
    assert.equal(game.pieces.find((p) => p.id === id)!.state, 'AIRPORT');
    assert.equal(game.pieces.find((p) => p.id === id)!.progress, -1);
  }
  for (const id of ['green-2', 'blue-3']) assert.deepEqual(game.pieces.find((p) => p.id === id), before.pieces.find((p) => p.id === id));
});

test('S05: takeoff and private runways do not capture opponents with the same relative progress', () => {
  for (const progress of [-1, 50]) {
    const { room, engine } = setup(), game = room.game!;
    const mover = game.pieces.find((p) => p.id === 'green-1')!, other = game.pieces.find((p) => p.id === 'blue-1')!;
    mover.progress = progress; mover.state = progress < 0 ? 'AIRPORT' : 'MAIN_PATH';
    other.progress = progress < 0 ? 0 : 51; other.state = progress < 0 ? 'MAIN_PATH' : 'FINAL_PATH';
    const before = structuredClone(other);
    const roll = engine.rollDice(room, 'a', progress < 0 ? 5 : 1);
    engine.selectDie(room, 'a', 0, roll.rollId);
    const result = engine.selectPiece(room, 'a', mover.id);
    assert.deepEqual(result.killedPieceIds, []); assert.deepEqual(other, before);
  }
});

test('S06: rejected preferences and unready starts do not partially change a room', () => {
  const rooms = new RoomManager(), room = rooms.createRoom(player('a'));
  rooms.joinRoom(room.roomId, player('b'));
  rooms.setReady(room.roomId, 'a', true); rooms.setReady(room.roomId, 'b', true);
  const before = structuredClone(room);
  for (const invalid of [undefined, 'PURPLE', '', 'red', 1, {}, ['RED']]) {
    assert.throws(() => rooms.setColorPreference(room.roomId, 'a', invalid), { code: 'INVALID_MESSAGE' });
    assert.deepEqual(room, before);
  }
  assert.throws(() => rooms.setColorPreference(room.roomId, 'stranger', 'RED'), { code: 'NOT_IN_ROOM' });
  assert.deepEqual(room, before);
  rooms.setColorPreference(room.roomId, 'a', null);
  assert.equal(room.players[0].ready, false); assert.equal(room.players[1].ready, true);
  const unready = structuredClone(room), engine = new GameEngine();
  assert.throws(() => engine.startGame(room), { code: 'NOT_READY' });
  assert.deepEqual(room, unready);
  rooms.setReady(room.roomId, 'a', true); engine.startGame(room);
  const started = structuredClone(room);
  assert.throws(() => rooms.setColorPreference(room.roomId, 'a', 'RED'), { code: 'ROOM_ALREADY_STARTED' });
  assert.deepEqual(room, started);
});

test('S07: leaving a middle seat and replaying a match never duplicate colours, bots or pieces', () => {
  const rooms = new RoomManager(), room = rooms.createRoom(player('a'));
  rooms.joinRoom(room.roomId, player('b')); rooms.joinRoom(room.roomId, player('c'));
  rooms.leaveRoom(room.roomId, 'b'); rooms.joinRoom(room.roomId, player('d'));
  assert.equal(new Set(room.players.map((p) => p.color)).size, 3);
  rooms.setColorPreference(room.roomId, 'a', 'GREEN');
  room.players.forEach((p) => rooms.setReady(room.roomId, p.id, true));
  const engine = new GameEngine(new GameRules(), () => 0.5);
  engine.startGame(room);
  room.status = 'FINISHED'; rooms.resetFinishedRoom(room);
  assert.equal(room.game, undefined);
  assert.deepEqual(room.players.map((p) => p.id), ['a', 'c', 'd']);
  assert.ok(room.players.every((p) => !p.isBot && !p.ready));
  assert.equal(room.players[0].preferredColor, 'GREEN');
  room.players.forEach((p) => rooms.setReady(room.roomId, p.id, true)); engine.startGame(room);
  assert.equal(room.players.filter((p) => p.isBot).length, 1);
  assert.equal(new Set(room.players.map((p) => p.color)).size, 4);
  assert.equal(new Set(room.game!.pieces.map((p) => p.id)).size, 16);
  assert.ok(room.game!.pieces.every((p) => p.state === 'AIRPORT' && p.progress === -1));
});

test('S08: future matching selects only the oldest available matchmaking room', () => {
  const rooms = new RoomManager();
  rooms.createRoom(player('private'));
  assert.equal(rooms.findMatchRoom(), undefined);
  const first = rooms.createRoom(player('first')), second = rooms.createRoom(player('second'));
  first.mode = second.mode = 'MATCHMAKING'; first.createdAt = 10; second.createdAt = 20;
  assert.equal(rooms.findMatchRoom(), first);
  for (const id of ['x', 'y', 'z']) rooms.joinRoom(first.roomId, player(id));
  assert.equal(rooms.findMatchRoom(), second);
  second.status = 'PLAYING';
  assert.equal(rooms.findMatchRoom(), undefined);
});
