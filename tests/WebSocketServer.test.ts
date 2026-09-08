import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';

interface ReceivedMessage { type: string; data: Record<string, unknown>; }

const waitForMessage = (socket: WebSocket, type: string): Promise<ReceivedMessage> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.off('message', onMessage);
    reject(new Error(`timed out waiting for ${type}`));
  }, 2_000);
  const onMessage = (raw: WebSocket.RawData): void => {
    const message = JSON.parse(raw.toString()) as ReceivedMessage;
    if (message.type !== type) return;
    clearTimeout(timeout);
    socket.off('message', onMessage);
    resolve(message);
  };
  socket.on('message', onMessage);
});

const send = (socket: WebSocket, type: string, data: Record<string, unknown>, requestId = `${type}-${Date.now()}`): void => {
  socket.send(JSON.stringify({ type, requestId, data }));
};

test('dual dice, preferences, reconnect and stale move rejection work over real sockets', async () => {
  const server = new GameWebSocketServer(0);
  await server.ready;
  const a = new WebSocket(`ws://127.0.0.1:${server.port}`), b = new WebSocket(`ws://127.0.0.1:${server.port}`);
  let request = 0;
  const command = async (socket: WebSocket, type: string, data: Record<string, unknown>, expected: string) => {
    const promise = waitForMessage(socket, expected);
    send(socket, type, data, `dual-${++request}`);
    return (await promise).data;
  };
  try {
    await Promise.all([once(a, 'open'), once(b, 'open')]);
    await command(a, 'AUTH', { guestId: 'dual-a' }, 'AUTH_OK');
    await command(b, 'AUTH', { guestId: 'dual-b' }, 'AUTH_OK');
    const { roomId } = await command(a, 'CREATE_ROOM', {}, 'ROOM_CREATED');
    await command(b, 'JOIN_ROOM', { roomId }, 'GAME_STATE');
    await command(a, 'SET_COLOR_PREFERENCE', { roomId, color: 'GREEN' }, 'GAME_STATE');
    await command(b, 'SET_COLOR_PREFERENCE', { roomId, color: 'BLUE' }, 'GAME_STATE');
    await command(a, 'READY', { roomId }, 'GAME_STATE');
    await command(b, 'READY', { roomId }, 'GAME_STATE');
    const started = await command(a, 'START_GAME', { roomId }, 'GAME_START');
    assert.deepEqual((started.players as Array<{color: string}>).slice(0, 2).map((p) => p.color), ['GREEN', 'BLUE']);
    assert.equal((await command(b, 'ROLL_DICE', { roomId }, 'ERROR')).code, 'NOT_YOUR_TURN');
    const peerState = waitForMessage(b, 'GAME_STATE');
    const rolled = await command(a, 'ROLL_DICE', { roomId, debugDice: 5 }, 'DICE_RESULT');
    const synced = (await peerState).data;
    assert.deepEqual(synced.diceChoices, rolled.diceChoices);
    assert.equal(synced.phase, 'WAIT_SELECT_DIE');
    const restored = await command(a, 'REJOIN_GAME', { roomId }, 'GAME_STATE');
    assert.deepEqual(restored.diceChoices, rolled.diceChoices);
    assert.equal(restored.rollId, rolled.rollId);
    assert.equal((await command(a, 'SELECT_DIE', { roomId, dieIndex: 9, rollId: rolled.rollId }, 'ERROR')).code, 'INVALID_DIE');
    const selectionState = waitForMessage(a, 'GAME_STATE');
    const chosen = await command(a, 'SELECT_DIE', { roomId, dieIndex: 0, rollId: rolled.rollId }, 'DIE_SELECTED');
    assert.equal(chosen.dice, 5);
    const selected = (await selectionState).data;
    assert.equal(selected.phase, 'WAIT_SELECT_PIECE');
    const pieceId = (selected.movablePieceIds as string[])[0];
    assert.ok((selected.movePreviews as Record<string, unknown>)[pieceId]);
    assert.equal((await command(a, 'SELECT_PIECE', { roomId, pieceId, rollId: 0 }, 'ERROR')).code, 'INVALID_DIE');
    const finalState = waitForMessage(b, 'GAME_STATE');
    const move = await command(a, 'SELECT_PIECE', { roomId, pieceId, rollId: rolled.rollId }, 'MOVE_RESULT');
    assert.equal(move.toProgress, 0);
    assert.equal((await finalState).data.phase, 'WAIT_ROLL');
  } finally {
    a.close(); b.close();
    await Promise.all([once(a, 'close'), once(b, 'close')]);
    await server.close();
  }
});

test('two authenticated players can create, join, ready and start a room', async () => {
  const server = new GameWebSocketServer(0);
  await server.ready;
  const url = `ws://127.0.0.1:${server.port}`;
  const a = new WebSocket(url);
  const b = new WebSocket(url);
  try {
    await Promise.all([once(a, 'open'), once(b, 'open')]);
    let expected = waitForMessage(a, 'AUTH_OK');
    send(a, 'AUTH', { guestId: 'test-a', nickname: '甲' });
    const authA = await expected;
    assert.ok(authA.data.sessionId);

    expected = waitForMessage(b, 'AUTH_OK');
    send(b, 'AUTH', { guestId: 'test-b', nickname: '乙' });
    await expected;

    expected = waitForMessage(a, 'ROOM_CREATED');
    send(a, 'CREATE_ROOM', {});
    const created = await expected;
    const roomId = created.data.roomId as string;
    assert.match(roomId, /^\d{6}$/);

    expected = waitForMessage(b, 'GAME_STATE');
    send(b, 'JOIN_ROOM', { roomId });
    const joined = await expected;
    assert.equal((joined.data.players as unknown[]).length, 2);

    expected = waitForMessage(b, 'ERROR');
    send(b, 'START_GAME', { roomId });
    const denied = await expected;
    assert.equal(denied.data.code, 'NOT_ROOM_OWNER');

    expected = waitForMessage(a, 'GAME_STATE');
    send(a, 'READY', { roomId });
    await expected;
    expected = waitForMessage(a, 'GAME_STATE');
    send(b, 'READY', { roomId });
    await expected;

    expected = waitForMessage(a, 'GAME_START');
    send(a, 'START_GAME', { roomId });
    const started = await expected;
    assert.equal(started.data.roomStatus, 'PLAYING');
    assert.equal((started.data.pieces as unknown[]).length, 16);
    const startedPlayers = started.data.players as Array<{ nickname: string; isBot?: boolean }>;
    assert.equal(startedPlayers.length, 4);
    assert.equal(startedPlayers.filter((player) => player.isBot).length, 2);
    assert.equal(started.data.phase, 'WAIT_ROLL');
  } finally {
    a.close();
    b.close();
    await Promise.all([once(a, 'close'), once(b, 'close')]);
    await server.close();
  }
});

test('quick match is disabled; private rooms still broadcast room chat', async () => {
  const server = new GameWebSocketServer(0);
  await server.ready;
  const url = `ws://127.0.0.1:${server.port}`;
  const a = new WebSocket(url);
  const b = new WebSocket(url);
  try {
    await Promise.all([once(a, 'open'), once(b, 'open')]);
    let expected = waitForMessage(a, 'AUTH_OK');
    send(a, 'AUTH', { guestId: 'match-a', nickname: '甲' });
    await expected;
    expected = waitForMessage(b, 'AUTH_OK');
    send(b, 'AUTH', { guestId: 'match-b', nickname: '乙' });
    await expected;

    expected = waitForMessage(a, 'ERROR');
    send(a, 'QUICK_MATCH', {});
    assert.equal((await expected).data.code, 'MATCHMAKING_DISABLED');
    expected = waitForMessage(a, 'ROOM_CREATED');
    send(a, 'CREATE_ROOM', {});
    const created = await expected;
    const roomId = created.data.roomId as string;

    expected = waitForMessage(b, 'GAME_STATE');
    send(b, 'JOIN_ROOM', { roomId });
    const matched = await expected;
    assert.equal(matched.data.roomId, roomId);
    assert.equal((matched.data.players as unknown[]).length, 2);

    const publicForA = waitForMessage(a, 'CHAT_MESSAGE');
    const publicForB = waitForMessage(b, 'CHAT_MESSAGE');
    send(a, 'CHAT_SEND', { roomId, content: '大家好' });
    assert.equal((await publicForA).data.content, '大家好');
    assert.equal((await publicForB).data.content, '大家好');
  } finally {
    a.close();
    b.close();
    await Promise.all([once(a, 'close'), once(b, 'close')]);
    await server.close();
  }
});

test('exiting a live game enables trustee mode and the same account can rejoin', async () => {
  const server = new GameWebSocketServer(0);
  await server.ready;
  const url = `ws://127.0.0.1:${server.port}`;
  const a = new WebSocket(url);
  const b = new WebSocket(url);
  try {
    await Promise.all([once(a, 'open'), once(b, 'open')]);
    let expected = waitForMessage(a, 'AUTH_OK');
    send(a, 'AUTH', { guestId: 'resume-a', nickname: '甲' }, 'resume-auth-a');
    const authA = await expected;
    const playerA = authA.data.playerId as string;
    expected = waitForMessage(b, 'AUTH_OK');
    send(b, 'AUTH', { guestId: 'resume-b', nickname: '乙' }, 'resume-auth-b');
    await expected;

    expected = waitForMessage(a, 'ROOM_CREATED');
    send(a, 'CREATE_ROOM', {}, 'resume-create');
    const roomId = (await expected).data.roomId as string;
    expected = waitForMessage(b, 'GAME_STATE');
    send(b, 'JOIN_ROOM', { roomId }, 'resume-join');
    await expected;
    expected = waitForMessage(a, 'GAME_STATE');
    send(a, 'READY', { roomId }, 'resume-ready-a');
    await expected;
    expected = waitForMessage(a, 'GAME_STATE');
    send(b, 'READY', { roomId }, 'resume-ready-b');
    await expected;
    expected = waitForMessage(a, 'GAME_START');
    send(a, 'START_GAME', { roomId }, 'resume-start');
    await expected;

    const exitedMessage = waitForMessage(a, 'GAME_EXITED');
    const activeMessage = waitForMessage(a, 'ACTIVE_GAMES');
    send(a, 'EXIT_GAME', { roomId }, 'resume-exit');
    assert.equal((await exitedMessage).data.roomId, roomId);
    const activeGames = (await activeMessage).data.games as Array<{ roomId: string }>;
    assert.equal(activeGames[0]?.roomId, roomId);

    expected = waitForMessage(a, 'GAME_STATE');
    send(a, 'REJOIN_GAME', { roomId }, 'resume-rejoin');
    const resumed = await expected;
    const player = (resumed.data.players as Array<{ id: string; connected: boolean; aiControlled?: boolean }>).find((candidate) => candidate.id === playerA);
    assert.equal(player?.connected, true);
    assert.equal(player?.aiControlled, false);

    expected = waitForMessage(a, 'GAME_EXITED');
    send(a, 'EXIT_GAME', { roomId }, 'resume-exit-again');
    await expected;
    const gameOver = waitForMessage(a, 'GAME_OVER');
    expected = waitForMessage(b, 'GAME_EXITED');
    send(b, 'EXIT_GAME', { roomId }, 'resume-exit-b');
    await expected;
    assert.equal((await gameOver).data.roomStatus, 'FINISHED');
  } finally {
    a.close();
    b.close();
    await Promise.all([once(a, 'close'), once(b, 'close')]);
    await server.close();
  }
});
