import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';
import { SessionManager } from '../src/auth/SessionManager.js';
import type { RoomManager } from '../src/room/RoomManager.js';
import type { GameSnapshot, ServerMessage } from '../src/protocol.js';

test('T10: six real sockets vote, freeze, reconnect, time out to AI, then continue once for second place', async () => {
  const server = new GameWebSocketServer(0, new SessionManager()); await server.ready;
  const harness = server as unknown as { rooms: RoomManager; tickLifecycles(): void };
  const sockets = Array.from({ length: 6 }, () => new WebSocket(`ws://127.0.0.1:${server.port}`));
  let serial = 0;
  const auth: Array<{ playerId: string; sessionId: string }> = [];
  const inbox: ServerMessage[] = [];
  sockets[0].on('message', (raw) => inbox.push(JSON.parse(String(raw))));
  function request(index: number, type: string, data: object, expect: string): Promise<any> {
    const socket = sockets[index], requestId = `lifecycle-${++serial}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.off('message', read); reject(new Error(`${type} -> ${expect} timed out`)); }, 2500);
      const read = (raw: WebSocket.RawData) => {
        const value = JSON.parse(String(raw));
        if (value.type !== expect || (expect !== 'ERROR' && value.requestId !== requestId)) return;
        clearTimeout(timeout); socket.off('message', read); resolve(value.data);
      };
      socket.on('message', read); socket.send(JSON.stringify({ type, data, requestId }));
    });
  }
  try {
    await Promise.all(sockets.map((s) => once(s, 'open')));
    for (let i = 0; i < 6; i++) auth.push(await request(i, 'AUTH', { guestId: `lifecycle-${i}` }, 'AUTH_OK'));
    const { roomId } = await request(0, 'CREATE_ROOM', {}, 'ROOM_CREATED');
    for (let i = 1; i < 6; i++) await request(i, 'JOIN_ROOM', { roomId }, 'GAME_STATE');
    for (let i = 0; i < 4; i++) await request(i, 'READY', { roomId }, 'PLAYER_READY_CHANGED');
    await request(0, 'START_GAME', { roomId }, 'GAME_START');
    const room = harness.rooms.requireRoom(roomId), game = room.game!;
    const deadline = game.lifecycle!.activity!.deadline;
    await request(0, 'CHAT_SEND', { roomId, content: '聊天不会重置行动倒计时' }, 'CHAT_MESSAGE');
    await request(0, 'PING', { roomId }, 'PONG');
    assert.equal(game.lifecycle!.activity!.deadline, deadline);
    const voting: GameSnapshot = await request(0, 'REQUEST_PAUSE', { roomId }, 'GAME_STATE');
    const voteId = voting.lifecycle!.pauseVote!.id;
    assert.equal((await request(4, 'VOTE_PAUSE', { roomId, voteId, agree: true }, 'ERROR')).code, 'INVALID_PHASE');
    for (let i = 1; i < 4; i++) await request(i, 'VOTE_PAUSE', { roomId, voteId, agree: true }, 'GAME_STATE');
    assert.ok(game.lifecycle!.pause); const frozen = structuredClone(game.pieces);
    assert.equal((await request(0, 'ROLL_DICE', { roomId }, 'ERROR')).code, 'INVALID_PHASE');
    sockets[1].close(); await once(sockets[1], 'close');
    sockets[1] = new WebSocket(`ws://127.0.0.1:${server.port}`); await once(sockets[1], 'open');
    await request(1, 'AUTH', { sessionId: auth[1].sessionId }, 'AUTH_OK');
    const restored: GameSnapshot = await request(1, 'RECONNECT', { roomId }, 'GAME_STATE');
    assert.ok(restored.lifecycle!.pause); assert.deepEqual(restored.pieces, frozen); assert.equal(restored.players[1].aiControlled, false);
    await request(4, 'CHAT_SEND', { roomId, content: '暂停期间观战仍可聊天' }, 'CHAT_MESSAGE');
    game.lifecycle!.pause!.endsAt = Date.now() - 1;
    harness.tickLifecycles(); assert.equal(game.lifecycle!.pause, undefined);
    game.lifecycle!.activity!.deadline = Date.now() - 1;
    harness.tickLifecycles(); assert.equal(room.players[0].aiControlled, true);
    assert.equal((await request(0, 'ROLL_DICE', { roomId }, 'ERROR')).code, 'INVALID_PHASE');
    await request(0, 'SET_AI_TAKEOVER', { roomId, enabled: false }, 'AI_TAKEOVER_CHANGED');
    assert.equal(room.players[0].aiControlled, false);
    assert.ok(game.lifecycle!.activity!.deadline > Date.now());
    // Arrange a reachable final move; all voting and both wins still use real commands.
    const prepareFinish = (index: number) => {
      game.currentPlayerIndex = index; game.phase = 'WAIT_SELECT_DIE'; game.diceChoices = [1, 1]; game.rollId++;
      const pieces = game.pieces.filter((p) => p.playerId === room.players[index].id);
      pieces.forEach((p, n) => { p.state = n ? 'FINISHED' : 'FINAL_PATH'; p.progress = n ? 56 : 55; });
      return pieces[0].id;
    };
    const first = prepareFinish(0);
    await request(0, 'COMMIT_MOVE', { roomId, rollId: game.rollId, optionId: 'die-0', pieceId: first }, 'DIE_SELECTED');
    let snapshot: GameSnapshot = await request(4, 'RECONNECT', { roomId }, 'GAME_STATE');
    assert.equal(snapshot.phase, 'WINNER_VOTE'); assert.equal(snapshot.lifecycle!.continueVote!.required, 5);
    const continueId = snapshot.lifecycle!.continueVote!.id;
    assert.equal((await request(1, 'ROLL_DICE', { roomId }, 'ERROR')).code, 'NOT_YOUR_TURN');
    for (const i of [0, 1, 2, 4, 5]) await request(i, 'VOTE_CONTINUE', { roomId, voteId: continueId, agree: true }, 'GAME_STATE');
    assert.equal(game.phase, 'WAIT_ROLL'); assert.equal(game.currentPlayerIndex, 1); assert.equal(game.lifecycle!.continuationUsed, true);
    const second = prepareFinish(1);
    await request(1, 'COMMIT_MOVE', { roomId, rollId: game.rollId, optionId: 'die-0', pieceId: second }, 'DIE_SELECTED');
    snapshot = await request(4, 'RECONNECT', { roomId }, 'GAME_STATE');
    assert.equal(snapshot.roomStatus, 'FINISHED'); assert.deepEqual(snapshot.rankings, [auth[0].playerId, auth[1].playerId]);
    assert.equal(snapshot.lifecycle?.continueVote, undefined);
    assert.ok(inbox.some((m) => m.type === 'SYSTEM_MESSAGE' && String((m.data as { content: string }).content).includes('30 秒未操作')));
  } finally { sockets.forEach((s) => s.terminate()); await server.close(); }
});
