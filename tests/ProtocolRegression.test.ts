import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import WebSocket from 'ws';
import { GameWebSocketServer } from '../src/network/WebSocketServer.js';
import type { DiceResult, DieSelected, GameSnapshot, MoveResult } from '../src/protocol.js';

interface WireMessage { type: string; requestId?: string; data: unknown; }
class Peer {
  public readonly socket: WebSocket;
  public readonly history: WireMessage[] = [];
  private sequence = 0;
  public constructor(url: string, private readonly name: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw) => this.history.push(JSON.parse(String(raw)) as WireMessage));
  }
  public async request<T>(type: string, data: object, expected: string, requestId = `${this.name}-${++this.sequence}`): Promise<T> {
    // Arm the reply listener before sending. Correlation excludes incidental
    // broadcast snapshots, so this test never relies on sleeps or packet timing.
    const reply = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`${type}/${requestId}: missing ${expected}`)); }, 5000);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(String(raw)) as WireMessage;
        if (message.type !== expected || message.requestId !== requestId) return;
        cleanup(); resolve(message.data as T);
      };
      const onClose = () => { cleanup(); reject(new Error(`${type}: socket closed before reply`)); };
      const cleanup = () => { clearTimeout(timeout); this.socket.off('message', onMessage); this.socket.off('close', onClose); };
      this.socket.on('message', onMessage); this.socket.on('close', onClose);
    });
    this.socket.send(JSON.stringify({ type, requestId, data }));
    return reply;
  }
  public async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close'); this.socket.terminate(); await closed;
  }
}

async function setup(context: TestContext) {
  const server = new GameWebSocketServer(0), peers: Peer[] = [];
  context.after(async () => { await Promise.all(peers.map((peer) => peer.close())); await server.close(); });
  await server.ready;
  const connect = async (name: string) => {
    const peer = new Peer(`ws://127.0.0.1:${server.port}`, name); peers.push(peer);
    await once(peer.socket, 'open'); return peer;
  };
  const a = await connect('a'), b = await connect('b');
  const auth = await a.request<{ playerId: string; sessionId: string }>('AUTH', { guestId: 'regression-a' }, 'AUTH_OK');
  await b.request('AUTH', { guestId: 'regression-b' }, 'AUTH_OK');
  const { roomId } = await a.request<GameSnapshot>('CREATE_ROOM', {}, 'ROOM_CREATED');
  await b.request('JOIN_ROOM', { roomId }, 'GAME_STATE');
  await a.request('SET_COLOR_PREFERENCE', { roomId, color: 'GREEN' }, 'GAME_STATE');
  await b.request('SET_COLOR_PREFERENCE', { roomId, color: 'BLUE' }, 'GAME_STATE');
  await a.request('READY', { roomId }, 'PLAYER_READY_CHANGED');
  await b.request('READY', { roomId }, 'PLAYER_READY_CHANGED');
  await a.request('START_GAME', { roomId }, 'GAME_START');
  return { a, b, auth, roomId, connect };
}

test('P01: duplicate roll, selection and move requests execute once and return the current snapshot', { timeout: 10000 }, async (context) => {
  const { a, roomId } = await setup(context);
  const rollData = { roomId, debugDice: 6 };
  const roll = await a.request<DiceResult>('ROLL_DICE', rollData, 'DICE_RESULT', 'original-roll');
  const repeatedRoll = await a.request<GameSnapshot>('ROLL_DICE', rollData, 'GAME_STATE', 'original-roll');
  assert.deepEqual(repeatedRoll.diceChoices, roll.diceChoices);
  assert.equal(repeatedRoll.rollId, roll.rollId);
  assert.equal(repeatedRoll.phase, 'WAIT_SELECT_DIE');
  const dieData = { roomId, dieIndex: 0, rollId: roll.rollId };
  const chosen = await a.request<DieSelected>('SELECT_DIE', dieData, 'DIE_SELECTED', 'original-selection');
  const repeatedSelection = await a.request<GameSnapshot>('SELECT_DIE', { ...dieData, dieIndex: 1 }, 'GAME_STATE', 'original-selection');
  assert.equal(repeatedSelection.selectedDieIndex, 0);
  assert.equal(repeatedSelection.dice, 6);
  assert.equal(repeatedSelection.phase, 'WAIT_SELECT_PIECE');
  const moveData = { roomId, pieceId: chosen.movablePieceIds[0], rollId: roll.rollId };
  await a.request<MoveResult>('SELECT_PIECE', moveData, 'MOVE_RESULT', 'original-move');
  const repeatedMove = await a.request<GameSnapshot>('SELECT_PIECE', moveData, 'GAME_STATE', 'original-move');
  assert.equal(repeatedMove.pieces.find((p) => p.id === moveData.pieceId)!.progress, 0);
  assert.equal(repeatedMove.phase, 'WAIT_ROLL');
  assert.equal(repeatedMove.turnNumber, 1);
  const next = await a.request<DiceResult>('ROLL_DICE', rollData, 'DICE_RESULT');
  const delayedMove = await a.request<GameSnapshot>('SELECT_PIECE', moveData, 'GAME_STATE', 'original-move');
  assert.equal(delayedMove.rollId, next.rollId);
  assert.equal(delayedMove.phase, 'WAIT_SELECT_DIE');
  assert.deepEqual(delayedMove.pieces, repeatedMove.pieces);
  assert.equal(a.history.filter((m) => m.type === 'DICE_RESULT' && m.requestId === 'original-roll').length, 1);
  assert.equal(a.history.filter((m) => m.type === 'DIE_SELECTED').length, 1);
  assert.equal(a.history.filter((m) => m.type === 'MOVE_RESULT').length, 1);
});

for (const [caseId, phase] of [['P02', 'WAIT_SELECT_DIE'], ['P03', 'WAIT_SELECT_PIECE']] as const) {
  test(`${caseId}: replacing the socket in ${phase} preserves colour, dice and manual control`, { timeout: 10000 }, async (context) => {
    const { a, b, auth, roomId, connect } = await setup(context);
    const roll = await a.request<DiceResult>('ROLL_DICE', { roomId, debugDice: 6 }, 'DICE_RESULT');
    if (phase === 'WAIT_SELECT_PIECE') await a.request('SELECT_DIE', { roomId, dieIndex: 0, rollId: roll.rollId }, 'DIE_SELECTED');
    const before = await a.request<GameSnapshot>('RECONNECT', { roomId }, 'GAME_STATE');
    const replaced = once(a.socket, 'close');
    const fresh = await connect('replacement');
    const identity = await fresh.request<{ playerId: string }>('AUTH', { sessionId: auth.sessionId }, 'AUTH_OK');
    assert.equal(identity.playerId, auth.playerId);
    assert.equal((await replaced)[0], 4001);
    // Observe via the other player first. Reconnecting the replaced player
    // itself would clear aiControlled and could hide a stale-close regression.
    const observed = await b.request<GameSnapshot>('RECONNECT', { roomId }, 'GAME_STATE');
    const observedLocal = observed.players.find((p) => p.id === auth.playerId)!;
    assert.equal(observedLocal.connected, true);
    assert.notEqual(observedLocal.aiControlled, true);
    assert.equal(b.history.some((m) => m.type === 'PLAYER_DISCONNECTED' && (m.data as { playerId: string }).playerId === auth.playerId), false);
    // Read after the old close has arrived: it must not mark the new connection
    // disconnected or hand control to AI, even if the close event is late.
    const restored = await fresh.request<GameSnapshot>('RECONNECT', { roomId }, 'GAME_STATE');
    assert.equal(restored.phase, phase);
    assert.equal(restored.rollId, before.rollId);
    assert.deepEqual(restored.diceChoices, before.diceChoices);
    assert.equal(restored.selectedDieIndex, before.selectedDieIndex);
    assert.deepEqual(restored.pieces, before.pieces);
    assert.deepEqual(restored.players.map((p) => [p.id, p.color]), before.players.map((p) => [p.id, p.color]));
    const local = restored.players.find((p) => p.id === auth.playerId)!;
    assert.equal(local.connected, true); assert.equal(local.aiControlled, false);
    if (phase === 'WAIT_SELECT_DIE') await fresh.request('SELECT_DIE', { roomId, dieIndex: 0, rollId: roll.rollId }, 'DIE_SELECTED');
    const result = await fresh.request<MoveResult>('SELECT_PIECE', { roomId, pieceId: 'green-1', rollId: roll.rollId }, 'MOVE_RESULT');
    assert.equal(result.fromProgress, -1); assert.equal(result.toProgress, 0);
  });
}
