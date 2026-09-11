import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { RoomManager } from '../src/room/RoomManager.js';
import { roomMembers } from '../src/room/Room.js';
import { GameEngine } from '../src/game/GameEngine.js';
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';

const player = (id: string) => ({ id, sessionId: id, nickname: id, connected: true, lastHeartbeatAt: Date.now() });
test('O01: four playing seats plus two spectator seats enforce capacity and atomic seat changes', () => {
  const rooms = new RoomManager(), room = rooms.createRoom(player('a'));
  for (const id of ['b', 'c', 'd', 'e', 'f']) rooms.joinRoom(room.roomId, player(id));
  assert.equal(room.players.length, 4); assert.equal(room.spectators!.length, 2);
  assert.equal(roomMembers(room).length, 6);
  const before = structuredClone(room);
  assert.throws(() => rooms.joinRoom(room.roomId, player('g')));
  assert.throws(() => rooms.setColorPreference(room.roomId, 'a', 'SPECTATOR'));
  assert.throws(() => rooms.setColorPreference(room.roomId, 'e', null));
  assert.deepEqual(room, before);
  rooms.leaveRoom(room.roomId, 'd'); rooms.setColorPreference(room.roomId, 'e', 'BLUE');
  assert.equal(room.players.find((p) => p.id === 'e')!.preferredColor, 'BLUE');
  assert.equal(room.players.find((p) => p.id === 'e')!.spectating, false);
  assert.equal(room.spectators!.length, 1);
  rooms.setColorPreference(room.roomId, 'a', 'SPECTATOR');
  assert.equal(room.ownerId, 'a', 'spectator owner can still administer the room');
  assert.equal(new Set(roomMembers(room).map((p) => p.id)).size, 5);
});

test('O02: spectators never ready, receive pieces or enter turn order; matches retain 4+2 seats with bots', () => {
  const rooms = new RoomManager(), room = rooms.createRoom(player('a'));
  for (const id of ['b', 'c', 'd']) rooms.joinRoom(room.roomId, player(id));
  rooms.setColorPreference(room.roomId, 'a', 'SPECTATOR'); rooms.setColorPreference(room.roomId, 'd', 'SPECTATOR');
  assert.throws(() => rooms.setReady(room.roomId, 'a', true));
  room.players.forEach((p) => { p.ready = true; });
  const engine = new GameEngine(); engine.startGame(room);
  assert.equal(room.players.length, 4); assert.equal(roomMembers(room).length, 6);
  assert.equal(room.game!.pieces.length, 16);
  assert.ok(room.game!.pieces.every((p) => !['a', 'd'].includes(p.playerId)));
  assert.deepEqual(engine.getSnapshot(room).spectators!.map((p) => p.id), ['a', 'd']);
  assert.ok(engine.getSnapshot(room).spectators!.every((p) => !('color' in p)));
  assert.equal(rooms.findActiveRoomByPlayer('a'), room);
  assert.throws(() => engine.commitMove(room, 'a', { roomId: room.roomId, rollId: 0, optionId: 'die-0', pieceId: room.game!.pieces[0].id }));
});

test('O03: joining a running game uses a spectator seat, and leaving frees it without changing the board', () => {
  const rooms = new RoomManager(), room = rooms.createRoom(player('a'));
  rooms.joinRoom(room.roomId, player('b')); room.players.forEach((p) => { p.ready = true; });
  new GameEngine().startGame(room); const before = structuredClone(room.game);
  rooms.joinRoom(room.roomId, player('c')); assert.equal(room.spectators![0].id, 'c');
  rooms.leaveRoom(room.roomId, 'c'); assert.equal(room.spectators!.length, 0);
  assert.deepEqual(room.game, before);
});

test('O04: real spectator sockets receive dice and chat, reconnect, and cannot roll, move or cast', async () => {
  const server = new GameWebSocketServer(0); await server.ready;
  const sockets = Array.from({ length: 6 }, () => new WebSocket(`ws://127.0.0.1:${server.port}`));
  let sequence = 0;
  function request(index: number, type: string, data: object, expect: string): Promise<any> {
    const requestId = `spectator-${++sequence}`, socket = sockets[index];
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.off('message', read); reject(new Error(`${type} timed out`)); }, 2000);
      const read = (raw: WebSocket.RawData) => {
        const value = JSON.parse(String(raw));
        if (value.type !== expect || (expect !== 'ERROR' && value.requestId !== requestId)) return;
        clearTimeout(timeout); socket.off('message', read); resolve(value.data);
      };
      socket.on('message', read); socket.send(JSON.stringify({ type, data, requestId }));
    });
  }
  try {
    await Promise.all(sockets.map((socket) => once(socket, 'open')));
    for (let i = 0; i < sockets.length; i++) await request(i, 'AUTH', { guestId: `observer-${i}` }, 'AUTH_OK');
    const { roomId } = await request(0, 'CREATE_ROOM', {}, 'ROOM_CREATED');
    for (let i = 1; i < 6; i++) await request(i, 'JOIN_ROOM', { roomId }, 'GAME_STATE');
    for (let i = 0; i < 4; i++) await request(i, 'READY', { roomId }, 'PLAYER_READY_CHANGED');
    await request(0, 'START_GAME', { roomId }, 'GAME_START');
    await request(5, 'CHAT_SEND', { roomId, content: '观战者也能聊天' }, 'CHAT_MESSAGE');
    await request(0, 'ROLL_DICE', { roomId, debugDice: 5 }, 'DICE_RESULT');
    const snapshot = await request(5, 'RECONNECT', { roomId }, 'GAME_STATE');
    assert.equal(snapshot.players.length, 4); assert.equal(snapshot.spectators.length, 2); assert.equal(snapshot.diceChoices[0], 5);
    for (const [type, data] of [
      ['ROLL_DICE', {}], ['COMMIT_MOVE', { rollId: snapshot.rollId, optionId: 'die-0', pieceId: snapshot.pieces[0].id }],
      ['USE_SKILL', { skillId: 'us-bomb', rollId: snapshot.rollId, targetCell: 'M0' }]
    ] as const) assert.equal((await request(5, type, { roomId, ...data }, 'ERROR')).code, 'INVALID_PHASE');
    const restored = await request(5, 'REJOIN_GAME', { roomId }, 'GAME_STATE');
    assert.deepEqual(restored.pieces, snapshot.pieces); assert.equal(restored.phase, 'WAIT_SELECT_DIE');
    const played = await request(0, 'COMMIT_MOVE', { roomId, rollId: snapshot.rollId, optionId: 'die-0', pieceId: snapshot.pieces[0].id }, 'DIE_SELECTED');
    assert.equal(played.dice, 5);
    const observed = await request(5, 'RECONNECT', { roomId }, 'GAME_STATE');
    assert.equal(observed.pieces[0].progress, 0);
  } finally { sockets.forEach((socket) => socket.terminate()); await server.close(); }
});
