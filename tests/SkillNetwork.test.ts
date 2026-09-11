import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';
import type { GameEngine } from '../src/game/GameEngine.js';
import type { RoomManager } from '../src/room/RoomManager.js';
import type { Room } from '../src/room/Room.js';
import type { GameSnapshot, MoveResult, PlayerColor } from '../src/protocol.js';

type Message = { type: string; data: any };
function message(socket: WebSocket, type: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', read); reject(new Error(`waiting for ${type}`)); }, 2000);
    const read = (raw: WebSocket.RawData) => { const parsed = JSON.parse(String(raw)); if (parsed.type === type) { clearTimeout(timer); socket.off('message', read); resolve(parsed); } };
    socket.on('message', read);
  });
}
async function setup() {
  const server = new GameWebSocketServer(0); await server.ready;
  // Fixtures remain inside the test process; no production fixture endpoint exists.
  const internals = server as unknown as { rooms: RoomManager; game: GameEngine; scheduleReaction(room: Room): void };
  const colors: PlayerColor[] = ['GREEN', 'YELLOW', 'BLUE', 'RED'];
  const sockets = colors.map(() => new WebSocket(`ws://127.0.0.1:${server.port}`));
  let sequence = 0;
  const send = (index: number, type: string, data: object) => sockets[index].send(JSON.stringify({ type, data, requestId: `skill-wire-${++sequence}` }));
  const command = async (index: number, type: string, data: object, expect = 'GAME_STATE') => { const pending = message(sockets[index], expect); send(index, type, data); return (await pending).data; };
  await Promise.all(sockets.map((socket) => once(socket, 'open')));
  for (const [index, color] of colors.entries()) await command(index, 'AUTH', { guestId: `skill-wire-${color}` }, 'AUTH_OK');
  const { roomId } = await command(0, 'CREATE_ROOM', {}, 'ROOM_CREATED');
  for (let i = 1; i < 4; i++) await command(i, 'JOIN_ROOM', { roomId });
  for (let i = 0; i < 4; i++) { await command(i, 'SET_COLOR_PREFERENCE', { roomId, color: colors[i] }); await command(i, 'READY', { roomId }); }
  await command(0, 'START_GAME', { roomId }, 'GAME_START');
  const room = internals.rooms.requireRoom(roomId);
  const piece = (id: string) => room.game!.pieces.find((p) => p.id === id)!;
  const at = (id: string, progress: number) => Object.assign(piece(id), { progress, state: 'MAIN_PATH' });
  const capture = async () => {
    at('green-1', 1); at('yellow-1', 45); at('yellow-2', 45);
    await command(0, 'ROLL_DICE', { roomId, debugDice: 1 }, 'DICE_RESULT');
    return await command(0, 'COMMIT_MOVE', { roomId, rollId: room.game!.rollId, optionId: 'die-0', pieceId: 'green-1' }) as GameSnapshot;
  };
  const close = async () => { for (const socket of sockets) socket.terminate(); await server.close(); };
  return { server, internals, room, roomId, sockets, command, send, piece, capture, close };
}

test('N01: atomic move and defensive choice survive reconnect, reject stale/foreign input and settle once', async () => {
  const s = await setup();
  try {
    const pending = await s.capture();
    assert.equal(pending.phase, 'WAIT_REACTION');
    assert.equal(s.piece('green-1').progress, 1);
    assert.ok(!('move' in pending.reaction!), 'pending authority move must not leak into reaction payload');
    const restored = await s.command(1, 'REJOIN_GAME', { roomId: s.roomId }) as GameSnapshot;
    assert.deepEqual(restored.reaction, pending.reaction);
    const choice = { roomId: s.roomId, rollId: pending.rollId, skillId: 'fr-lock', reactionId: pending.reaction!.id, targetPieceIds: ['yellow-1'] };
    const before = structuredClone(s.room.game);
    assert.equal((await s.command(2, 'USE_SKILL', choice, 'ERROR')).code, 'SKILL_UNAVAILABLE');
    assert.equal((await s.command(1, 'USE_SKILL', { ...choice, reactionId: -1 }, 'ERROR')).code, 'SKILL_UNAVAILABLE');
    assert.equal((await s.command(0, 'COMMIT_MOVE', { roomId: s.roomId, rollId: pending.rollId, optionId: 'die-0', pieceId: 'green-1' }, 'ERROR')).code, 'INVALID_PHASE');
    assert.deepEqual(s.room.game, before);
    const move = await s.command(1, 'USE_SKILL', choice, 'MOVE_RESULT') as MoveResult;
    assert.deepEqual(move.captureOutcomes!.map((o) => o.outcome), ['LOCKED', 'AIRPORT']);
    assert.equal(s.piece('yellow-1').locked, true);
    assert.equal(s.room.game!.extraRolls, 1, 'two captured enemies yield two bonus rolls, first already active');
    const after = structuredClone(s.room.game);
    assert.equal((await s.command(1, 'USE_SKILL', choice, 'ERROR')).code, 'SKILL_UNAVAILABLE');
    assert.deepEqual(s.room.game, after);
  } finally { await s.close(); }
});

for (const mode of ['timeout', 'trustee', 'exit'] as const) test(`N02-${mode}: pending French capture defaults to no locks without stalling`, async () => {
  const s = await setup();
  try {
    await s.capture();
    const moved = message(s.sockets[0], 'MOVE_RESULT');
    if (mode === 'timeout') { s.room.game!.reaction!.expiresAt = Date.now() + 25; s.internals.scheduleReaction(s.room); }
    else if (mode === 'trustee') s.send(1, 'SET_AI_TAKEOVER', { roomId: s.roomId, enabled: true });
    else s.send(1, 'EXIT_GAME', { roomId: s.roomId });
    const move = (await moved).data as MoveResult;
    assert.ok(move.captureOutcomes!.every((o) => o.outcome === 'AIRPORT'));
    assert.equal(s.room.game!.phase, 'WAIT_ROLL');
    assert.equal(s.room.game!.reaction, undefined);
  } finally { await s.close(); }
});

test('N03: skill target and trustee guards are enforced at the socket boundary', async () => {
  const s = await setup();
  try {
    const base = { roomId: s.roomId, rollId: 0, skillId: 'us-bomb' };
    const before = structuredClone(s.room.game);
    assert.equal((await s.command(0, 'USE_SKILL', { ...base, targetCell: 'F-RED-1' }, 'ERROR')).code, 'INVALID_PIECE');
    assert.equal((await s.command(0, 'USE_SKILL', { ...base, targetPieceIds: [123] }, 'ERROR')).code, 'INVALID_MESSAGE');
    assert.deepEqual(s.room.game, before);
    await s.command(0, 'SET_AI_TAKEOVER', { roomId: s.roomId, enabled: true });
    assert.ok((await s.command(0, 'USE_SKILL', { ...base, targetCell: 'M0' }, 'ERROR')).code);
    assert.equal(s.room.game!.factions![s.room.players[0].id].limitedUsed, false);
    assert.ok(s.internals.game.getSnapshot(s.room).skills.filter((skill) => skill.playerId === s.room.players[0].id).every((skill) => !skill.available));
  } finally { await s.close(); }
});
