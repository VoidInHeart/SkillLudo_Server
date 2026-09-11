import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const url = process.env.SMOKE_URL ?? 'ws://127.0.0.1:3000';
const http = url.replace(/^ws/, 'http').replace(/\/$/, '');
const ready = await fetch(`${http}/readyz`, { signal: AbortSignal.timeout(5000) });
assert.equal(ready.status, 200);
const status = await ready.json();
if (process.env.EXPECTED_REVISION) assert.equal(status.revision, process.env.EXPECTED_REVISION);
const peers = [];
let sequence = 0;
async function connect() {
  const socket = new WebSocket(url);
  peers.push(socket);
  await Promise.race([once(socket, 'open'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Connect timeout')), 5000); timer.unref(); })]);
  return socket;
}
function request(socket, type, data, expected) {
  return new Promise((resolve, reject) => {
    const requestId = `smoke-${++sequence}`;
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`${type}: timeout`)); }, 5000);
    const cleanup = () => { clearTimeout(timeout); socket.off('message', receive); };
    const receive = (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'ERROR') { cleanup(); reject(new Error(`${type}: ${message.data.code}`)); }
      else if (message.type === expected && message.requestId === requestId) { cleanup(); resolve(message.data); }
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({ type, requestId, data }));
  });
}
try {
  const a = await connect(), b = await connect();
  await request(a, 'AUTH', { guestId: `smoke-a-${randomUUID()}` }, 'AUTH_OK');
  await request(b, 'AUTH', { guestId: `smoke-b-${randomUUID()}` }, 'AUTH_OK');
  await request(a, 'PING', {}, 'PONG');
  const { roomId } = await request(a, 'CREATE_ROOM', {}, 'ROOM_CREATED');
  await request(b, 'JOIN_ROOM', { roomId }, 'GAME_STATE');
  await request(a, 'SET_COLOR_PREFERENCE', { roomId, color: 'GREEN' }, 'GAME_STATE');
  await request(b, 'SET_COLOR_PREFERENCE', { roomId, color: 'BLUE' }, 'GAME_STATE');
  await request(a, 'READY', { roomId }, 'PLAYER_READY_CHANGED');
  await request(b, 'READY', { roomId }, 'PLAYER_READY_CHANGED');
  const start = await request(a, 'START_GAME', { roomId }, 'GAME_START');
  assert.equal(start.players[0].color, 'GREEN');
  const roll = await request(a, 'ROLL_DICE', { roomId }, 'DICE_RESULT');
  assert.equal(roll.diceChoices.length, 2);
  const dieIndex = roll.diceChoices[1] > roll.diceChoices[0] ? 1 : 0;
  const preview = await request(a, 'RECONNECT', { roomId }, 'GAME_STATE');
  assert.equal(preview.protocolVersion, 4);
  assert.equal(preview.phase, 'WAIT_SELECT_DIE');
  const option = preview.actionOptions.find((candidate) => candidate.dieIndex === dieIndex && candidate.kind === 'STANDARD');
  const pieceId = option.movablePieceIds[0];
  const choice = await request(a, 'COMMIT_MOVE', { roomId, optionId: option.id, rollId: roll.rollId, ...(pieceId ? { pieceId } : {}) }, 'DIE_SELECTED');
  assert.equal(choice.dice, roll.diceChoices[dieIndex]);
  const after = await request(a, 'RECONNECT', { roomId }, 'GAME_STATE');
  assert.equal(after.phase, 'WAIT_ROLL');
  if (pieceId) assert.equal(after.pieces.find((piece) => piece.id === pieceId).progress, 0);
  // Leave explicitly, then wait for a subsequent heartbeat to ensure both commands were processed.
  for (const socket of peers) {
    socket.send(JSON.stringify({ type: 'LEAVE_ROOM', requestId: `smoke-leave-${++sequence}`, data: { roomId } }));
    await request(socket, 'PING', {}, 'PONG');
  }
  console.log(JSON.stringify({ result: 'passed', revision: status.revision, checks: ['readiness', 'auth', 'heartbeat', 'room', 'preferences', 'dual-dice', 'v3 atomic selection/move or pass', 'cleanup'] }));
} finally { peers.forEach((socket) => socket.close()); }
